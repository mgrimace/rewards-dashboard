'use strict'

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const { inspectContainer, streamLogs, DOCKER_HOST, DOCKER_SOCKET } = require('./lib/docker')
const { parseLine } = require('./lib/parser')
const { Store } = require('./lib/store')
const { describeCron } = require('./lib/cron')
const { transformThemeModule } = require('./lib/tsLite')
const { generateIndexModule, THEMES_DIR } = require('./lib/themeLoader')
const { PendingLoginCodes } = require('./lib/pendingLoginCodes')

const PORT = Number(process.env.PORT || 8890)
const CONTAINER_NAME = process.env.TARGET_CONTAINER || 'microsoft-rewards-script'
const PUBLIC_DIR = path.join(__dirname, 'public')

const store = new Store()
const pendingLoginCodes = new PendingLoginCodes()

const containerStatus = {
    found: false,
    running: false,
    status: 'unknown',
    connected: false,
    lastError: null,
    checkedAt: null,
    cronSchedule: null,
    timezone: null,
    scheduleDescription: null
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function isoToUnixSecondsFloor(iso) {
    const t = Date.parse(iso)
    if (Number.isNaN(t)) return 0
    return Math.max(0, Math.floor(t / 1000) - 2)
}

// How far back to read on the very first run (no persisted bookmark yet).
// Docker's default json-file log driver has no built-in size cap, so an
// unbounded backfill on a long-running bot could mean parsing a lot of log.
// Default: 30 days. Set BACKFILL_HOURS=0 to read the full available history,
// or any other number of hours to change the window.
function initialBackfillSince() {
    const raw = process.env.BACKFILL_HOURS
    if (raw === undefined || raw === '') {
        return Math.max(0, Math.floor(Date.now() / 1000) - 30 * 24 * 3600)
    }
    const hours = Number(raw)
    if (!Number.isFinite(hours) || hours <= 0) return 0 // 0 or invalid => full history
    return Math.max(0, Math.floor(Date.now() / 1000) - hours * 3600)
}

async function ingestLoop() {
    for (;;) {
        try {
            const info = await inspectContainer(CONTAINER_NAME)
            containerStatus.found = true
            containerStatus.running = info.running
            containerStatus.status = info.status
            containerStatus.lastError = null
            containerStatus.checkedAt = new Date().toISOString()
            containerStatus.cronSchedule = info.env.CRON_SCHEDULE || null
            containerStatus.timezone = info.env.TZ || null
            containerStatus.scheduleDescription = containerStatus.cronSchedule
                ? describeCron(containerStatus.cronSchedule)
                : null

            const since = store.lastTs ? isoToUnixSecondsFloor(store.lastTs) : initialBackfillSince()
            containerStatus.connected = true

            console.log(`[ingest] Connected to "${info.name}" (${info.id.slice(0, 12)}), since=${since}`)

            await streamLogs(info.id, since, line => {
                const event = parseLine(line)
                if (!event) return
                store.apply(event)
                if (event.kind === 'login-number') {
                    pendingLoginCodes.add(event.userName, event.number, event.ts)
                } else if (event.kind === 'login-number-resolved') {
                    pendingLoginCodes.resolve(event.userName)
                }
            })

            containerStatus.connected = false
            console.log('[ingest] Log stream ended, will retry')
        } catch (e) {
            containerStatus.found = false
            containerStatus.connected = false
            containerStatus.lastError = e.message
            containerStatus.checkedAt = new Date().toISOString()
            console.error('[ingest] Error:', e.message)
        }
        await sleep(5000)
    }
}

// ---- HTTP server ---------------------------------------------------------

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml'
}

function sendJson(res, status, body) {
    const data = JSON.stringify(body)
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(data),
        'Cache-Control': 'no-store'
    })
    res.end(data)
}

function serveStatic(req, res, pathname) {
    let rel = pathname === '/' ? '/index.html' : pathname
    const filePath = path.join(PUBLIC_DIR, rel)

    // Prevent directory traversal outside PUBLIC_DIR
    if (!filePath.startsWith(PUBLIC_DIR)) {
        res.writeHead(403)
        return res.end('Forbidden')
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' })
            return res.end('Not found')
        }
        const ext = path.extname(filePath)
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
        res.end(data)
    })
}

/**
 * Serves the theme registry - synthesized fresh on every request by
 * scanning public/themes/ for *Theme.ts files. Nothing to maintain by hand:
 * drop a theme file in, it shows up; remove one, it disappears. No-store so
 * a page reload always reflects whatever's currently in the folder.
 */
function serveThemeIndex(res) {
    const body = generateIndexModule()
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(body)
}

/**
 * Serves an individual theme file, transpiled from TS to plain JS on the
 * fly (see lib/tsLite.js) so files copied in from another project run
 * completely unmodified.
 */
function serveThemeFile(res, filename) {
    const filePath = path.join(THEMES_DIR, filename)
    if (!filePath.startsWith(THEMES_DIR)) {
        res.writeHead(403)
        return res.end('Forbidden')
    }
    fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' })
            return res.end('Not found')
        }
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(transformThemeModule(data))
    })
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const pathname = url.pathname

    if (pathname === '/themes/index.js') {
        return serveThemeIndex(res)
    }

    if (pathname.startsWith('/themes/') && pathname.endsWith('.ts')) {
        return serveThemeFile(res, pathname.slice('/themes/'.length))
    }

    if (pathname === '/api/summary') {
        const runs = store.snapshotRuns(30)

        return sendJson(res, 200, {
            status: { ...containerStatus, container: CONTAINER_NAME, lastEventAt: store.lastTs },
            accounts: store.snapshotAccounts(),
            runs,
            activity: store.snapshotActivity(100)
        })
    }

    if (pathname === '/api/accounts-history') {
        return sendJson(res, 200, { histories: store.allAccountHistories() })
    }

    if (pathname === '/api/login-codes') {
        return sendJson(res, 200, { codes: pendingLoginCodes.list() })
    }

    if (pathname.startsWith('/api/accounts/') && pathname.endsWith('/history')) {
        const email = decodeURIComponent(pathname.slice('/api/accounts/'.length, -'/history'.length))
        return sendJson(res, 200, { email, history: store.accountHistory(email) })
    }

    if (pathname === '/api/health') {
        return sendJson(res, 200, { ok: true })
    }

    if (pathname.startsWith('/api/')) {
        return sendJson(res, 404, { error: 'not found' })
    }

    return serveStatic(req, res, pathname)
})

server.listen(PORT, () => {
    console.log(`[server] Rewards dashboard listening on :${PORT}`)
    console.log(`[server] Watching container: ${CONTAINER_NAME}`)
    console.log(`[server] Docker connection: ${DOCKER_HOST ? `proxy at ${DOCKER_HOST}` : `socket at ${DOCKER_SOCKET}`}`)
})

function shutdown() {
    console.log('[server] Shutting down, closing database...')
    store.close()
    process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

ingestLoop()
