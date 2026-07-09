'use strict'

import { themes } from './themes/index.js'
import { applyTheme, getStoredThemeId, setStoredThemeId, getStoredMode, setStoredMode, systemPrefersDark } from './themeManager.js'

const REFRESH_MS = 20000
const LOGIN_CODES_POLL_MS = 3000 // faster than the main refresh - a 60s window needs it

const els = {
    statusBadge: document.getElementById('statusBadge'),
    statusText: document.getElementById('statusText'),
    statAccounts: document.getElementById('statAccounts'),
    statLastGained: document.getElementById('statLastGained'),
    statLastRun: document.getElementById('statLastRun'),
    statErrors: document.getElementById('statErrors'),
    statSchedule: document.getElementById('statSchedule'),
    statTimezone: document.getElementById('statTimezone'),
    activityFeed: document.getElementById('activityFeed'),
    accountChartSection: document.getElementById('accountChartSection'),
    accountChartName: document.getElementById('accountChartName'),
    modeToggle: document.getElementById('modeToggle'),
    modeIcon: document.getElementById('modeIcon'),
    anonToggle: document.getElementById('anonToggle'),
    anonIcon: document.getElementById('anonIcon'),
    themeSelect: document.getElementById('themeSelect'),
    loginCodesSection: document.getElementById('loginCodesSection'),
    loginCodesList: document.getElementById('loginCodesList'),
    loginCodesAnnounce: document.getElementById('loginCodesAnnounce')
}

let activeLoginCodes = []
let scriptTimeZone = null
let knownLoginCodeKeys = new Set()

let accountChart = null
let selectedEmail = null

let currentThemeId = null
let currentMode = 'light'

// Persistent toggle choice for screenshots stored directly in browser cache
let isAnonymized = localStorage.getItem('dashboard_anonymized') === 'true'
window.__obfuscatedEmailMap = {}

function findTheme(id) {
    return themes.find(t => t.id === id) || themes[0] || null
}

function setMode(mode, persist) {
    currentMode = mode
    els.modeIcon.textContent = mode === 'dark' ? '\u2600' : '\u263D'
    els.modeToggle.setAttribute('aria-label', mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode')
    els.modeToggle.title = els.modeToggle.getAttribute('aria-label')
    if (persist) setStoredMode(mode)
    const theme = findTheme(currentThemeId)
    if (theme) applyTheme(theme, currentMode)
}

function setTheme(id, persist) {
    const theme = findTheme(id)
    if (!theme) return
    currentThemeId = theme.id
    els.themeSelect.value = theme.id
    if (persist) setStoredThemeId(theme.id)
    applyTheme(theme, currentMode)
}

function updateAnonButtonState() {
    if (isAnonymized) {
        els.anonToggle.classList.add('anon-active')
        els.anonIcon.textContent = '\u{1F576}' // 🕶 (Privacy Sunglasses)
        els.anonToggle.setAttribute('aria-label', 'Show real account identities')
        els.anonToggle.title = 'Show real account identities'
    } else {
        els.anonToggle.classList.remove('anon-active')
        els.anonIcon.textContent = '\u{1F441}' // 👁 (Open Eye)
        els.anonToggle.setAttribute('aria-label', 'Obfuscate names for screenshots')
        els.anonToggle.title = 'Obfuscate names for screenshots'
    }
}

function initTheme() {
    if (!themes.length) return

    els.themeSelect.innerHTML = themes
        .map(t => `<option value="${escapeAttr(t.id)}">${escapeHtml(t.name)}</option>`)
        .join('')

    const storedThemeId = getStoredThemeId()
    const storedMode = getStoredMode()

    currentMode = storedMode || (systemPrefersDark() ? 'dark' : 'light')
    setTheme(storedThemeId && findTheme(storedThemeId) ? storedThemeId : themes[0].id, false)
    setMode(currentMode, false)

    els.themeSelect.addEventListener('change', () => setTheme(els.themeSelect.value, true))
    els.modeToggle.addEventListener('click', () => setMode(currentMode === 'dark' ? 'light' : 'dark', true))
    
    // Wire up interaction triggers for the eye icon button
    updateAnonButtonState()
    els.anonToggle.addEventListener('click', () => {
        isAnonymized = !isAnonymized
        localStorage.setItem('dashboard_anonymized', isAnonymized)
        updateAnonButtonState()
        refresh('localRepaint')
    })
}

function fmtDateTime(iso) {
    if (!iso) return '\u2013'
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return '\u2013'
    return d.toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    })
}

function fmtRelative(iso) {
    if (!iso) return '\u2013'
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return '\u2013'
    const diffMs = Date.now() - d.getTime()
    const mins = Math.round(diffMs / 60000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins}m ago`
    const hours = Math.round(mins / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.round(hours / 24)
    return `${days}d ago`
}

function fmtDuration(sec) {
    if (sec == null) return '\u2013'
    if (sec < 60) return `${Math.round(sec)}s`
    const m = Math.round(sec / 60)
    return `${m}m`
}

function fmtNumber(n) {
    if (n == null) return '\u2013'
    return n.toLocaleString()
}

function fmtSigned(n) {
    if (n == null) return '\u2013'
    return (n > 0 ? '+' : '') + n.toLocaleString()
}

function setStatus(status) {
    const badge = els.statusBadge
    badge.classList.remove('status-live', 'status-warn', 'status-down', 'status-unknown')

    scriptTimeZone = status.timezone || null

    if (!status.found) {
        badge.classList.add('status-down')
        els.statusText.textContent = `Container "${status.container}" not found`
    } else if (!status.connected || !status.running) {
        badge.classList.add('status-warn')
        els.statusText.textContent = `Container ${status.status}${status.connected ? '' : ' \u2013 reconnecting'}`
    } else {
        badge.classList.add('status-live')
        els.statusText.textContent = 'Live'
    }

    els.statSchedule.textContent = status.scheduleDescription || status.cronSchedule || '\u2013'
    els.statSchedule.title = status.cronSchedule || ''
    els.statTimezone.textContent = status.timezone || ''
}

function statusPill(status) {
    const map = {
        success: ['pill-success', 'Success'],
        error: ['pill-error', 'Error'],
        running: ['pill-running', 'Running'],
        idle: ['pill-idle', 'Idle']
    }
    const [cls, label] = map[status] || map.idle
    return `<span class="pill ${cls}">${label}</span>`
}

function loginCodeKey(c) {
    return `${c.userName}:${c.number}:${c.issuedAt}`
}

function renderLoginCodes() {
    activeLoginCodes = activeLoginCodes.filter(c => Date.parse(c.expiresAt) > Date.now())

    els.loginCodesSection.hidden = activeLoginCodes.length === 0
    if (!activeLoginCodes.length) return

    els.loginCodesList.innerHTML = activeLoginCodes
        .map(c => {
            const secsLeft = Math.max(0, Math.round((Date.parse(c.expiresAt) - Date.now()) / 1000))
            const urgent = secsLeft <= 15
            
            const displayUser = (isAnonymized && window.__obfuscatedEmailMap[c.userName]) 
                ? window.__obfuscatedEmailMap[c.userName] 
                : c.userName

            return `
                <div class="login-code-card">
                    <div class="login-code-number">${escapeHtml(c.number)}</div>
                    <div class="login-code-info">
                        <span class="login-code-name">${escapeHtml(displayUser)}</span>
                        <span class="login-code-countdown ${urgent ? 'urgent' : ''}">Expires in ${secsLeft}s</span>
                    </div>
                </div>
            `
        })
        .join('')
}

async function refreshLoginCodes() {
    try {
        const res = await fetch('/api/login-codes')
        if (!res.ok) return
        const data = await res.json()
        activeLoginCodes = data.codes || []

        const currentKeys = new Set(activeLoginCodes.map(loginCodeKey))
        const newOnes = activeLoginCodes.filter(c => !knownLoginCodeKeys.has(loginCodeKey(c)))
        if (newOnes.length) {
            els.loginCodesAnnounce.textContent = newOnes
                .map(c => {
                    const displayUser = (isAnonymized && window.__obfuscatedEmailMap[c.userName])
                        ? window.__obfuscatedEmailMap[c.userName]
                        : c.userName
                    return `Login approval needed for ${displayUser}: select number ${c.number}. Expires in 60 seconds.`
                })
                .join(' ')
        }
        knownLoginCodeKeys = currentKeys

        renderLoginCodes()
    } catch {
        // Fail quietly
    }
}

function renderStats(accounts, runs) {
    els.statAccounts.textContent = fmtNumber(accounts.length)

    const lastRun = runs.find(r => r.status === 'done') || runs[0]
    els.statLastGained.textContent = lastRun ? fmtSigned(lastRun.totalGained) : '\u2013'
    els.statLastRun.textContent = lastRun ? fmtRelative(lastRun.endTs || lastRun.startTs) : '\u2013'

    const errorCount = accounts.filter(a => a.status === 'error').length
    els.statErrors.textContent = fmtNumber(errorCount)

    // Dynamically toggle warning vs success indicators on the errors card
    const errorIconEl = document.getElementById('statErrorsAlertIcon')
    if (errorIconEl) {
        if (errorCount > 0) {
            errorIconEl.textContent = '!'
            errorIconEl.className = 'stat-icon-alert'
        } else {
            errorIconEl.textContent = '✓'
            errorIconEl.className = 'stat-icon-check'
        }
    }
    // Toggle last-run icon between running (amber) and done (green)
    const lastRunIconEl = document.getElementById('statLastRunIcon')
    if (lastRunIconEl) {
        const anyRunning = accounts.some(a => a.status === 'running')
        if (anyRunning) {
            lastRunIconEl.textContent = '\u25CF'
            lastRunIconEl.className = 'stat-icon-running'
        } else {
            lastRunIconEl.textContent = '\u2713'
            lastRunIconEl.className = 'stat-icon-check'
        }
    }
}

function renderAccountsHero(accounts, historiesByEmail) {
    const rowsContainer = document.getElementById('heroRows')

    if (!accounts.length) {
        rowsContainer.innerHTML = '<p class="empty-note" style="padding:1.25rem">No account activity observed yet.</p>'
        return
    }

    const withHistory = accounts
        .filter(a => historiesByEmail[a.email]?.length)
        .map(a => ({ email: a.email, days: bucketByDay(historiesByEmail[a.email]) }))

    const historyMap = Object.fromEntries(withHistory.map(h => [h.email, h.days]))

    const globalMaxGained = withHistory.length
        ? Math.max(1, ...withHistory.flatMap(w => w.days.map(d => d.gained)))
        : 1
    const todayKey = tzDayKey(new Date())
    const isMobile = window.matchMedia('(max-width: 768px)').matches

    rowsContainer.innerHTML = accounts.map(a => {
        const label = a.userName || a.email
        const pressed = selectedEmail === a.email ? 'true' : 'false'
        const days = historyMap[a.email] || null

        // Left: bar chart cell (no label — account name is in the right card)
        const barCellHtml = days
            ? `<div class="accum-track"><div class="accum-bar">${buildAccumBarHtml(days, globalMaxGained, isMobile ? 7 : null)}</div></div>`
            : `<p class="empty-note" style="font-size:0.78rem;margin:0">No history yet</p>`

        // Right: account data card
        const todayBucket = days?.find(d => d.dayKey === todayKey) ?? null
        const todayGained = todayBucket?.gained ?? null

        const checkVariant = { success: 'ok', error: 'error', running: 'running', idle: 'idle' }[a.status] ?? 'idle'
        const checkContent = { ok: '\u2713', error: '!', running: '\u25CF', idle: '\u2013' }[checkVariant]
        const checkTitle = { ok: 'Last run: successful', error: 'Last run: error', running: 'Currently running', idle: 'Idle \u2013 not yet run' }[checkVariant] ?? ''
        const todayText = todayGained != null
            ? `+${todayGained.toLocaleString()}\u202fpts today`
            : (a.status === 'running' ? 'Running\u2026' : 'No run today')

        const relTime = fmtRelative(a.lastEndAt || a.lastStartAt)
        const durStr = a.lastDurationSec != null ? fmtDuration(a.lastDurationSec) : null
        const subHtml = a.status === 'running'
            ? `<span class="hero-sub-running">Running\u2026 ${escapeHtml(fmtRelative(a.lastStartAt))}</span>`
            : durStr
                ? `Last: ${escapeHtml(relTime)} \u00b7 <span title="Last run duration">${escapeHtml(durStr)}</span>`
                : `Last: ${escapeHtml(relTime)}`

        return `<div class="hero-row">
            <div class="hero-bar-cell">
                ${barCellHtml}
            </div>
            <div class="hero-acc-card">
                <div class="hero-acc-pts">
                    <span class="hero-pts-num">${a.lastPoints != null ? fmtNumber(a.lastPoints) : '\u2013'}</span>
                    <span class="hero-pts-unit">Points</span>
                </div>
                <div class="hero-acc-info">
                    <div class="hero-acc-name">${escapeHtml(label)}</div>
                    <div class="hero-acc-meta">
                        <span class="hero-acc-today"><span class="hero-acc-check hero-acc-check--${checkVariant}" title="${escapeAttr(checkTitle)}" aria-hidden="true">${checkContent}</span><span>${escapeHtml(todayText)}</span></span>
                    </div>
                    <div class="hero-acc-sub">${subHtml}</div>
                    ${a.status === 'error' && a.lastError ? `<div class="hero-acc-error">${escapeHtml(a.lastError)}</div>` : ''}
                </div>
                <div class="hero-acc-actions">
                    <button class="link-btn" data-email="${escapeAttr(a.email)}" data-name="${escapeAttr(label)}" aria-pressed="${pressed}">Trend</button>
                </div>
            </div>
        </div>`
    }).join('')

    rowsContainer.querySelectorAll('button[data-email]').forEach(btn => {
        btn.addEventListener('click', () => selectAccount(btn.dataset.email, btn.dataset.name))
    })

    // Scroll each bar track to the right so the most recent days are always visible
    rowsContainer.querySelectorAll('.accum-track').forEach(track => {
        track.scrollLeft = track.scrollWidth
    })
}

function levelTag(level) {
    const map = { error: 'tag-error', warn: 'tag-warn', info: 'tag-info' }
    return map[level] || 'tag-info'
}

function activityLabel(item) {
    switch (item.kind) {
        case 'account-start': return `${item.email || item.userName} \u2013 run started`
        case 'account-end': return `${item.email} \u2013 completed`
        case 'account-error': return `${item.email || 'account'} \u2013 ${item.error || item.message}`
        case 'run-start': return `Run started \u2013 ${item.message.split('|')[1]?.trim() || ''}`
        case 'run-end': return `Run finished \u2013 ${item.message}`
        default: return item.message || item.raw
    }
}

function renderActivity(activity) {
    if (!activity.length) {
        els.activityFeed.innerHTML = '<li class="empty-note">No activity observed yet.</li>'
        return
    }
    els.activityFeed.innerHTML = activity.map(item => `
        <li class="activity-item">
            <span class="activity-time">${fmtDateTime(item.ts)}</span>
            <span class="activity-tag ${levelTag(item.level)}">${escapeHtml(item.title || item.level || '')}</span>
            <span class="activity-msg">${escapeHtml(activityLabel(item))}</span>
        </li>
    `).join('')
}

function tzDateParts(instant) {
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: scriptTimeZone || 'UTC',
        year: 'numeric', month: '2-digit', day: '2-digit'
    })
    const parts = fmt.formatToParts(new Date(instant))
    const get = type => Number(parts.find(p => p.type === type).value)
    return { year: get('year'), month: get('month'), day: get('day') }
}

function tzDayKey(instant) {
    const { year, month, day } = tzDateParts(instant)
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function isoWeekStartKey(year, month, day) {
    const date = new Date(Date.UTC(year, month - 1, day))
    const dow = (date.getUTCDay() + 6) % 7 // Mon=0..Sun=6
    date.setUTCDate(date.getUTCDate() - dow)
    return date.toISOString().slice(0, 10)
}

async function selectAccount(email, name) {
    // Toggle: clicking the active account again dismisses the chart
    if (selectedEmail === email && !els.accountChartSection.hidden) {
        selectedEmail = null
        els.accountChartSection.hidden = true
        document.querySelectorAll('button[data-email]').forEach(b => b.setAttribute('aria-pressed', 'false'))
        return
    }

    selectedEmail = email
    document.querySelectorAll('button[data-email]').forEach(b => {
        b.setAttribute('aria-pressed', b.dataset.email === email ? 'true' : 'false')
    })

    els.accountChartSection.hidden = false
    els.accountChartName.textContent = name || email
    els.accountChartSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' })

    // In anonymized mode the email is a display alias — resolve the real email for the API call
    const apiEmail = (isAnonymized && window.__obfuscatedEmailMap)
        ? (Object.keys(window.__obfuscatedEmailMap).find(k => window.__obfuscatedEmailMap[k] === email) ?? email)
        : email

    try {
        const res = await fetch(`/api/accounts/${encodeURIComponent(apiEmail)}/history`)
        const data = await res.json()
        renderAccountChart(data.history || [])
    } catch (e) {
        console.error('Failed to load account history', e)
    }
}

function renderAccountChart(history) {
    const labels = history.map(h => fmtDateTime(h.ts))
    const points = history.map(h => h.points)

    const ctx = document.getElementById('accountChart')
    const cssAccent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()

    if (accountChart) accountChart.destroy()
    accountChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label: 'Total points',
                data: points,
                borderColor: cssAccent || '#2f6fed',
                backgroundColor: 'transparent',
                tension: 0.25,
                pointRadius: 3
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: { y: { ticks: { precision: 0 } } }
        }
    })
}

function bucketByDay(history) {
    const days = new Map()
    for (const h of history) {
        const { year, month, day } = tzDateParts(h.ts)
        const dayKey = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
        if (!days.has(dayKey)) {
            days.set(dayKey, { dayKey, weekKey: isoWeekStartKey(year, month, day), gained: 0, lastTotal: h.points })
        }
        const bucket = days.get(dayKey)
        bucket.gained += h.gained ?? 0
        bucket.lastTotal = h.points
    }
    return [...days.values()].sort((a, b) => a.dayKey.localeCompare(b.dayKey))
}

const ACCUM_WINDOW_DAYS = 84 // ~12 weeks

function localDateLabel(key, options) {
    const [y, m, d] = key.split('-').map(Number)
    return new Date(y, m - 1, d).toLocaleDateString(undefined, options)
}

const ACCUM_MAX_HEIGHT_PCT = 100
const ACCUM_MIN_HEIGHT_PCT = 20

function buildAccumBarHtml(days, globalMaxGained, maxDays = null) {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - ACCUM_WINDOW_DAYS)
    const cutoffKey = cutoff.toISOString().slice(0, 10)
    let windowed = days.filter(d => d.dayKey >= cutoffKey)
    if (maxDays != null) windowed = windowed.slice(-maxDays)
    if (!windowed.length) return ''

    let html = ''
    let prevWeekKey = null
    let weekGained = 0
    let altToggle = false

    const flushWeekMarker = () => {
        if (prevWeekKey === null) return
        const label = localDateLabel(prevWeekKey, { month: 'short', day: 'numeric' })
        html += `<div class="accum-week-marker" title="Week of ${escapeAttr(label)}: +${weekGained.toLocaleString()} pts">
            <span class="accum-week-label">+${weekGained.toLocaleString()}</span>
        </div>`
        weekGained = 0
    }

    const len = windowed.length
    for (let i = 0; i < len; i++) {
        const day = windowed[i]
        if (prevWeekKey !== null && day.weekKey !== prevWeekKey) {
            flushWeekMarker()
        }
        prevWeekKey = day.weekKey
        weekGained += day.gained

        const dateLabel = localDateLabel(day.dayKey, { weekday: 'short', month: 'short', day: 'numeric' })
        altToggle = !altToggle
        
        if (i > 0) {
            const prev = windowed[i - 1]
            const gd = Math.max(0, Math.round((new Date(day.dayKey) - new Date(prev.dayKey)) / 86400000) - 1)
            
            if (gd >= 1) {
                const gapWidth = gd * 16
                const gapClass = gd === 1 ? ' accum-gap--warn' : ' accum-gap--bad'
                const gapTitle = `Gap: ${gd} missed day${gd > 1 ? 's' : ''}`
                
                html += `<div class="accum-gap${gapClass}" style="width:${gapWidth}px" title="${gapTitle}"></div>`
            }
        }

        const heightPct = Math.max(ACCUM_MIN_HEIGHT_PCT, Math.round((day.gained / globalMaxGained) * ACCUM_MAX_HEIGHT_PCT))
        const op = (0.35 + 0.65 * (i / (len - 1 || 1))).toFixed(2)
        
        html += `<div class="accum-day ${altToggle ? 'accum-day--a' : 'accum-day--b'}" style="height:${heightPct}%;opacity:${op}" title="${escapeAttr(dateLabel)}: +${day.gained.toLocaleString()} pts (total: ${day.lastTotal.toLocaleString()})"></div>`
    }
    // No trailing flushWeekMarker — markers are separators, not end-caps

    return html
}

function escapeHtml(str) {
    if (str == null) return ''
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
}
function escapeAttr(str) {
    return escapeHtml(str).replace(/"/g, '&quot;')
}

// In-memory data payload store used to toggle layouts cleanly without making network calls
let rawDataCache = null
let rawHistoriesCache = {}

async function refresh() {
    try {
        if (arguments[0] !== 'localRepaint' || !rawDataCache) {
            const [summaryRes, historiesRes] = await Promise.all([
                fetch('/api/summary'),
                fetch('/api/accounts-history')
            ])
            if (!summaryRes.ok) throw new Error(`HTTP ${summaryRes.status}`)
            rawDataCache = await summaryRes.json()
            rawHistoriesCache = historiesRes.ok ? (await historiesRes.json()).histories || {} : {}
        }

        let data = JSON.parse(JSON.stringify(rawDataCache))
        let historiesByEmail = JSON.parse(JSON.stringify(rawHistoriesCache))

        if (data.accounts && data.accounts.length > 0) {
            const emailMap = {}
            
            data.accounts.forEach((acc, index) => {
                const realKey = acc.email || acc.userName;
                emailMap[realKey] = `Account ${index + 1}`
            });
            window.__obfuscatedEmailMap = emailMap;

            if (isAnonymized) {
                data.accounts = data.accounts.map(acc => ({
                    ...acc,
                    email: emailMap[acc.email || acc.userName],
                    userName: emailMap[acc.email || acc.userName]
                }));

                const anonymizedHistories = {}
                Object.keys(historiesByEmail).forEach(email => {
                    if (emailMap[email]) {
                        anonymizedHistories[emailMap[email]] = historiesByEmail[email]
                    }
                });
                historiesByEmail = anonymizedHistories

                if (data.activity && data.activity.length > 0) {
                    data.activity = data.activity.map(item => {
                        let cleanedMsg = item.message || '';
                        let cleanedEmail = item.email;
                        let cleanedUser = item.userName;
                        let cleanedError = item.error;
                        
                        Object.keys(emailMap).forEach(realEmail => {
                            cleanedMsg = cleanedMsg.split(realEmail).join(emailMap[realEmail]);
                            if (cleanedEmail === realEmail) cleanedEmail = emailMap[realEmail];
                            if (cleanedUser === realEmail) cleanedUser = emailMap[realEmail];
                            if (cleanedError) cleanedError = cleanedError.split(realEmail).join(emailMap[realEmail]);
                        });

                        return { ...item, message: cleanedMsg, email: cleanedEmail, userName: cleanedUser, error: cleanedError };
                    });
                }
                
                if (selectedEmail && emailMap[selectedEmail]) {
                    els.accountChartName.textContent = emailMap[selectedEmail]
                }
            } else if (selectedEmail) {
                const activeAcc = data.accounts.find(a => a.email === selectedEmail)
                if (activeAcc) els.accountChartName.textContent = activeAcc.userName || activeAcc.email
            }
        }

        setStatus(data.status)
        renderStats(data.accounts, data.runs)
        renderAccountsHero(data.accounts, historiesByEmail)
        renderActivity(data.activity)
    } catch (e) {
        console.error('Refresh failed', e)
        els.statusBadge.classList.remove('status-live', 'status-warn', 'status-unknown')
        els.statusBadge.classList.add('status-down')
        els.statusText.textContent = 'Dashboard service unreachable'
    }
}

initTheme()
refresh()
setInterval(refresh, REFRESH_MS)

// Re-render from cache instantly when crossing the mobile breakpoint
window.matchMedia('(max-width: 768px)').addEventListener('change', () => refresh('localRepaint'))

refreshLoginCodes()
setInterval(refreshLoginCodes, LOGIN_CODES_POLL_MS)
setInterval(renderLoginCodes, 1000)

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js')
            .then(reg => {
                console.log('Service worker registered:', reg.scope)
            })
            .catch(err => {
                console.warn('Service worker registration failed:', err)
            })
    })
}