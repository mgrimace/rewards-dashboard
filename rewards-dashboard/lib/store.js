'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')

const DATA_DIR = process.env.DATA_DIR || '/data'
const DB_FILE = path.join(DATA_DIR, 'dashboard.sqlite')

// Activity log is a firehose of warn/error + lifecycle lines; keep it bounded
// so the db doesn't grow forever. Point history (the actual data users care
// about for graphs) is never pruned.
const MAX_ACTIVITY_ROWS = 5000

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS accounts (
    email TEXT PRIMARY KEY,
    user_name TEXT,
    geo_locale TEXT,
    status TEXT NOT NULL DEFAULT 'idle',
    last_start_at TEXT,
    last_end_at TEXT,
    last_gained INTEGER,
    last_points INTEGER,
    last_duration_sec REAL,
    last_error TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS account_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    ts TEXT NOT NULL,
    points INTEGER NOT NULL,
    gained INTEGER NOT NULL,
    duration_sec REAL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_history_email_ts ON account_history(email, ts);

CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    start_ts TEXT,
    end_ts TEXT,
    version TEXT,
    total_accounts INTEGER,
    clusters INTEGER,
    accounts_processed INTEGER,
    total_gained INTEGER,
    old_total INTEGER,
    new_total INTEGER,
    runtime_min REAL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_runs_start ON runs(start_ts);

CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    level TEXT,
    title TEXT,
    kind TEXT,
    user_name TEXT,
    platform TEXT,
    email TEXT,
    message TEXT,
    raw TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity(ts);
`

class Store {
    constructor() {
        fs.mkdirSync(DATA_DIR, { recursive: true })
        this.db = new DatabaseSync(DB_FILE)
        this.db.exec('PRAGMA journal_mode = WAL;')
        this.db.exec('PRAGMA synchronous = NORMAL;')
        this.db.exec(SCHEMA)
        this._prepare()
        this._lastTs = this._readMeta('lastTs')
    }

    _prepare() {
        this.stmts = {
            getMeta: this.db.prepare('SELECT value FROM meta WHERE key = ?'),
            setMeta: this.db.prepare(
                'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
            ),

            upsertAccountStart: this.db.prepare(`
                INSERT INTO accounts (email, user_name, geo_locale, status, last_start_at)
                VALUES (?, ?, ?, 'running', ?)
                ON CONFLICT(email) DO UPDATE SET
                    user_name = excluded.user_name,
                    geo_locale = excluded.geo_locale,
                    status = 'running',
                    last_start_at = excluded.last_start_at
            `),
            upsertAccountEnd: this.db.prepare(`
                INSERT INTO accounts (email, user_name, status, last_end_at, last_gained, last_points, last_duration_sec, last_error)
                VALUES (?, ?, 'success', ?, ?, ?, ?, NULL)
                ON CONFLICT(email) DO UPDATE SET
                    status = 'success',
                    last_end_at = excluded.last_end_at,
                    last_gained = excluded.last_gained,
                    last_points = excluded.last_points,
                    last_duration_sec = excluded.last_duration_sec,
                    last_error = NULL
            `),
            upsertAccountError: this.db.prepare(`
                INSERT INTO accounts (email, status, last_end_at, last_error)
                VALUES (?, 'error', ?, ?)
                ON CONFLICT(email) DO UPDATE SET
                    status = 'error',
                    last_end_at = excluded.last_end_at,
                    last_error = excluded.last_error
            `),
            insertHistory: this.db.prepare(
                'INSERT INTO account_history (email, ts, points, gained, duration_sec) VALUES (?, ?, ?, ?, ?)'
            ),
            historyForEmail: this.db.prepare(
                'SELECT ts, points, gained, duration_sec as durationSec FROM account_history WHERE email = ? ORDER BY ts ASC'
            ),
            allAccounts: this.db.prepare(`
                SELECT email, user_name as userName, geo_locale as geoLocale, status,
                       last_start_at as lastStartAt, last_end_at as lastEndAt,
                       last_gained as lastGained, last_points as lastPoints,
                       last_duration_sec as lastDurationSec, last_error as lastError
                FROM accounts
                ORDER BY COALESCE(last_end_at, last_start_at) DESC
            `),

            insertRunStart: this.db.prepare(`
                INSERT INTO runs (id, status, start_ts, version, total_accounts, clusters)
                VALUES (?, 'running', ?, ?, ?, ?)
                ON CONFLICT(id) DO NOTHING
            `),
            findRunningRun: this.db.prepare(
                `SELECT id FROM runs WHERE status = 'running' ORDER BY start_ts DESC LIMIT 1`
            ),
            closeRun: this.db.prepare(`
                UPDATE runs SET status = 'done', end_ts = ?, accounts_processed = ?,
                    total_gained = ?, old_total = ?, new_total = ?, runtime_min = ?
                WHERE id = ?
            `),
            insertOrphanRunEnd: this.db.prepare(`
                INSERT INTO runs (id, status, end_ts, accounts_processed, total_gained, old_total, new_total, runtime_min)
                VALUES (?, 'done', ?, ?, ?, ?, ?, ?)
            `),
            recentRuns: this.db.prepare(`
                SELECT id, status, start_ts as startTs, end_ts as endTs, version,
                       total_accounts as totalAccounts, clusters,
                       accounts_processed as accountsProcessed, total_gained as totalGained,
                       old_total as oldTotal, new_total as newTotal, runtime_min as runtimeMin
                FROM runs ORDER BY COALESCE(start_ts, end_ts) DESC LIMIT ?
            `),
            allHistories: this.db.prepare(`
                SELECT email, ts, points, gained, duration_sec as durationSec
                FROM account_history
                ORDER BY email ASC, ts ASC
            `),

            insertActivity: this.db.prepare(`
                INSERT INTO activity (ts, level, title, kind, user_name, platform, email, message, raw)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `),
            recentActivity: this.db.prepare(`
                SELECT ts, level, title, kind, user_name as userName, platform, email, message, raw
                FROM activity ORDER BY id DESC LIMIT ?
            `),
            countActivity: this.db.prepare('SELECT COUNT(*) as n FROM activity'),
            pruneActivity: this.db.prepare(`
                DELETE FROM activity WHERE id IN (
                    SELECT id FROM activity ORDER BY id ASC LIMIT ?
                )
            `)
        }
    }

    _readMeta(key) {
        const row = this.stmts.getMeta.get(key)
        return row ? row.value : null
    }

    _writeMeta(key, value) {
        this.stmts.setMeta.run(key, value)
    }

    get lastTs() {
        return this._lastTs
    }

    _pushActivity(event) {
        this.stmts.insertActivity.run(
            event.ts,
            event.level || null,
            event.title || null,
            event.kind || null,
            event.userName || null,
            event.platform || null,
            event.email || null,
            event.message || null,
            event.raw || null
        )
        const { n } = this.stmts.countActivity.get()
        if (n > MAX_ACTIVITY_ROWS) {
            this.stmts.pruneActivity.run(n - MAX_ACTIVITY_ROWS)
        }
    }

    /**
     * Applies one parsed log event to the database. Returns true if it
     * changed something (i.e. wasn't a dedupe/no-op).
     */
    apply(event) {
        if (!event || !event.ts) return false

        // Ordering / dedupe guard: ignore anything not newer than what we've
        // already processed (can happen on stream reconnect overlap).
        if (this._lastTs && event.ts <= this._lastTs) {
            return false
        }
        this._lastTs = event.ts
        this._writeMeta('lastTs', event.ts)

        let changed = true

        switch (event.kind) {
            case 'account-start': {
                this.stmts.upsertAccountStart.run(event.email, event.userName || null, event.geoLocale || null, event.ts)
                this._pushActivity(event)
                break
            }
            case 'account-end': {
                this.stmts.upsertAccountEnd.run(
                    event.email,
                    event.userName || null,
                    event.ts,
                    event.gained,
                    event.newPoints,
                    event.durationSec
                )
                this.stmts.insertHistory.run(event.email, event.ts, event.newPoints, event.gained, event.durationSec)
                this._pushActivity(event)
                break
            }
            case 'account-error': {
                if (event.email) {
                    this.stmts.upsertAccountError.run(event.email, event.ts, event.error)
                }
                this._pushActivity(event)
                break
            }
            case 'run-start': {
                this.stmts.insertRunStart.run(event.ts, event.ts, event.version, event.totalAccounts, event.clusters)
                this._pushActivity(event)
                break
            }
            case 'wrapper-lock-acquired': {
                this._pushActivity({ ...event, message: `Cron run starting (lock acquired, PID ${event.pid})` })
                break
            }
            case 'wrapper-lock-released': {
                // "Script finished" (no PID) is a redundant backstop for the
                // real "Lock released" line - both normally arrive together,
                // so only surface the PID-bearing one to avoid a
                // duplicate-looking feed entry.
                if (event.pid) {
                    this._pushActivity({ ...event, message: `Cron run finished (lock released, PID ${event.pid})` })
                }
                break
            }
            case 'run-end': {
                const running = this.stmts.findRunningRun.get()
                if (running) {
                    this.stmts.closeRun.run(
                        event.ts,
                        event.accountsProcessed,
                        event.totalGained,
                        event.oldTotal,
                        event.newTotal,
                        event.runtimeMin,
                        running.id
                    )
                } else {
                    this.stmts.insertOrphanRunEnd.run(
                        event.ts,
                        event.ts,
                        event.accountsProcessed,
                        event.totalGained,
                        event.oldTotal,
                        event.newTotal,
                        event.runtimeMin
                    )
                }
                this._pushActivity(event)
                break
            }
            case 'login-number': {
                this._pushActivity({
                    ...event,
                    level: 'warn',
                    message: `Login approval needed for ${event.userName}: select number ${event.number}`
                })
                break
            }
            case 'generic': {
                if (event.level === 'warn' || event.level === 'error') {
                    this._pushActivity(event)
                } else {
                    changed = false
                }
                break
            }
            default:
                changed = false
        }

        return changed
    }

    snapshotAccounts() {
        return this.stmts.allAccounts.all()
    }

    snapshotRuns(limit = 30) {
        return this.stmts.recentRuns.all(limit)
    }

    /**
     * All accounts' point history in one query, grouped by email - powers
     * the per-account accumulation bars without N separate requests.
     */
    allAccountHistories() {
        const rows = this.stmts.allHistories.all()
        const byEmail = {}
        for (const row of rows) {
            if (!byEmail[row.email]) byEmail[row.email] = []
            byEmail[row.email].push({ ts: row.ts, points: row.points, gained: row.gained, durationSec: row.durationSec })
        }
        return byEmail
    }

    snapshotActivity(limit = 100) {
        return this.stmts.recentActivity.all(limit)
    }

    accountHistory(email) {
        return this.stmts.historyForEmail.all(email)
    }

    // Kept for API parity with the caller. SQLite commits per-statement
    // (WAL mode), so there's nothing to flush on a timer - this just
    // checkpoints the WAL back into the main db file on shutdown.
    saveNow() {
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    }

    close() {
        this.saveNow()
        this.db.close()
    }
}

module.exports = { Store }
