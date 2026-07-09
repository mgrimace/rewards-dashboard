'use strict'

const http = require('node:http')

const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock'

// If DOCKER_HOST is set (e.g. "docker-socket-proxy:2375"), talk to that TCP
// endpoint instead of mounting the raw unix socket into this container. This
// is the recommended setup: a docker-socket-proxy sidecar holds the actual
// socket mount, scoped to read-only /containers endpoints, and this service
// only ever talks to the proxy over the Docker network.
const DOCKER_HOST = process.env.DOCKER_HOST || null

function connectionOptions() {
    if (DOCKER_HOST) {
        const [host, portStr] = DOCKER_HOST.split(':')
        return { host, port: Number(portStr) || 2375 }
    }
    return { socketPath: DOCKER_SOCKET }
}

/**
 * Minimal request helper against the Docker Engine API (unix socket or, if
 * DOCKER_HOST is set, a docker-socket-proxy over TCP).
 * Returns a parsed JSON body for normal (non-streaming) calls.
 */
function dockerRequest(path) {
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                ...connectionOptions(),
                path,
                method: 'GET',
                headers: { Host: 'localhost' }
            },
            res => {
                const chunks = []
                res.on('data', c => chunks.push(c))
                res.on('end', () => {
                    const body = Buffer.concat(chunks).toString('utf8')
                    if (res.statusCode && res.statusCode >= 400) {
                        const err = new Error(`Docker API ${path} -> ${res.statusCode}: ${body}`)
                        err.statusCode = res.statusCode
                        return reject(err)
                    }
                    try {
                        resolve(body ? JSON.parse(body) : null)
                    } catch (e) {
                        reject(e)
                    }
                })
            }
        )
        req.on('error', reject)
        req.end()
    })
}

/**
 * Looks up a container by name (or id) and returns { id, name, status, running }.
 */
async function inspectContainer(nameOrId) {
    const info = await dockerRequest(`/containers/${encodeURIComponent(nameOrId)}/json`)
    const env = {}
    for (const entry of info?.Config?.Env || []) {
        const idx = entry.indexOf('=')
        if (idx === -1) continue
        env[entry.slice(0, idx)] = entry.slice(idx + 1)
    }
    return {
        id: info.Id,
        name: (info.Name || '').replace(/^\//, ''),
        status: info?.State?.Status || 'unknown',
        running: Boolean(info?.State?.Running),
        env
    }
}

/**
 * Opens a raw (streaming) GET request against the Docker API and returns the
 * underlying http.IncomingMessage. Caller is responsible for consuming it.
 */
function openStream(path) {
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                ...connectionOptions(),
                path,
                method: 'GET',
                headers: { Host: 'localhost' }
            },
            res => {
                if (res.statusCode && res.statusCode >= 400) {
                    const chunks = []
                    res.on('data', c => chunks.push(c))
                    res.on('end', () => {
                        reject(new Error(`Docker API ${path} -> ${res.statusCode}: ${Buffer.concat(chunks)}`))
                    })
                    return
                }
                resolve(res)
            }
        )
        req.on('error', reject)
        req.end()
    })
}

/**
 * Streams logs for a container, demuxing Docker's 8-byte-header frame format
 * (used whenever the container was started without an allocated TTY, which is
 * the default for this project's compose service). Emits complete text lines
 * via onLine(line). Resolves when the stream ends (container stopped, socket
 * closed, or the connection is proactively recycled - see below); rejects on
 * transport errors.
 *
 * Node's http client has no built-in timeout, so if the underlying
 * connection to the socket/proxy ever silently stalls (proxy restart, a
 * dropped connection that never sends a clean FIN/RST, etc.) neither 'error'
 * nor 'end' would ever fire, and this would hang forever with no further
 * lines ever processed. Since this bot's cron schedule means long stretches
 * of genuine silence are completely normal (nothing wrong, just nothing new
 * to log), inferring a hang from inactivity would misfire constantly. So
 * instead this proactively tears down and reopens the stream on a fixed
 * interval regardless of activity - cheap (resumes exactly where it left
 * off via `since`), and guarantees a stall can never freeze ingestion for
 * longer than that interval.
 *
 * @param {string} containerId
 * @param {string|number} since - unix seconds, or RFC3339 timestamp, to resume from
 * @param {(line: string) => void} onLine
 * @param {{recycleAfterMs?: number}} [options]
 */
async function streamLogs(containerId, since, onLine, options = {}) {
    const recycleAfterMs = options.recycleAfterMs ?? 60 * 60 * 1000 // 1 hour
    const qs = new URLSearchParams({
        stdout: '1',
        stderr: '1',
        timestamps: '1',
        follow: '1',
        since: String(since)
    })
    const res = await openStream(`/containers/${encodeURIComponent(containerId)}/logs?${qs.toString()}`)

    let frameBuf = Buffer.alloc(0)
    let lineBuf = ''

    return new Promise((resolve, reject) => {
        let settled = false
        const recycleTimer = setTimeout(() => {
            res.destroy() // triggers 'close' below; ingestLoop will reconnect fresh
        }, recycleAfterMs)
        if (recycleTimer.unref) recycleTimer.unref()

        const settleOnce = fn => {
            if (settled) return
            settled = true
            clearTimeout(recycleTimer)
            fn()
        }

        res.on('data', chunk => {
            frameBuf = Buffer.concat([frameBuf, chunk])

            // Docker multiplexed stream framing: 1 byte stream type, 3 bytes
            // reserved, 4 bytes big-endian payload length, then payload.
            while (frameBuf.length >= 8) {
                const size = frameBuf.readUInt32BE(4)
                if (frameBuf.length < 8 + size) break
                const payload = frameBuf.subarray(8, 8 + size)
                frameBuf = frameBuf.subarray(8 + size)

                lineBuf += payload.toString('utf8')
                let idx
                while ((idx = lineBuf.indexOf('\n')) !== -1) {
                    const line = lineBuf.slice(0, idx)
                    lineBuf = lineBuf.slice(idx + 1)
                    if (line.length) onLine(line)
                }
            }
        })
        res.on('end', () => {
            settleOnce(() => {
                if (lineBuf.trim().length) onLine(lineBuf)
                resolve()
            })
        })
        res.on('error', err => settleOnce(() => reject(err)))
        res.on('close', () => settleOnce(resolve))
    })
}

module.exports = { inspectContainer, streamLogs, DOCKER_SOCKET, DOCKER_HOST }
