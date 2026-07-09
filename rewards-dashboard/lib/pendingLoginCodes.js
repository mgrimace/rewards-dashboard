'use strict'

// A pending login number is only meaningful for ~60 seconds (matches
// PasswordlessLogin.ts's own approval-wait window) and has no value once
// expired or resolved, so this is kept purely in memory - never written to
// the SQLite store. A page reload or dashboard restart simply shows nothing
// pending, which is correct: if it mattered, the bot's own 60s window would
// have already timed it out anyway.
const TTL_MS = 60 * 1000

class PendingLoginCodes {
    constructor() {
        this.entries = new Map() // userName -> { userName, number, issuedAt }
    }

    add(userName, number, issuedAtIso) {
        this.entries.set(userName, { userName, number, issuedAt: issuedAtIso })
    }

    resolve(userName) {
        this.entries.delete(userName)
    }

    /**
     * Returns still-active entries, pruning anything past its 60s window as
     * a side effect - this is the sole source of truth for expiry, so even
     * if a resolution log line is ever missed, a stale entry can't linger
     * past its real expiry.
     */
    list() {
        const now = Date.now()
        const active = []
        for (const [userName, entry] of this.entries) {
            const issuedMs = Date.parse(entry.issuedAt)
            const expiresAt = issuedMs + TTL_MS
            if (Number.isNaN(issuedMs) || expiresAt <= now) {
                this.entries.delete(userName)
                continue
            }
            active.push({ userName: entry.userName, number: entry.number, issuedAt: entry.issuedAt, expiresAt: new Date(expiresAt).toISOString() })
        }
        return active
    }
}

module.exports = { PendingLoginCodes, TTL_MS }
