"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "dashboard.sqlite");


const MAX_ACTIVITY_ROWS = 5000;

// How long after a run's start a duplicate RUN-START line (the bot logs one
// per cluster worker for the SAME run, "a second or so" after the primary's -
// see the run-start case in apply() below) can still be treated as an echo
// of that run rather than a brand new one. Generous relative to "a second or
// so", but far below any real run's duration - this only needs to bridge the
// worker-forking window, not distinguish it from a legitimately short run.
const RUN_START_ECHO_WINDOW_MS = 2 * 60 * 1000;

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
    last_error TEXT,
    streak_protection_enabled INTEGER,
    streak_protection_remaining_days INTEGER,
    streak_counter INTEGER,
    streak_protection_updated_at TEXT
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
    runtime_min REAL,
    exit_code INTEGER,
    exit_signal TEXT
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
`;

class Store {
  constructor() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    this.db = new DatabaseSync(DB_FILE);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec(SCHEMA);
    this._migrate();
    this._prepare();
    this._lastTs = this._readMeta("lastTs");
  }

  _migrate() {
    const runCols = new Set(
      this.db
        .prepare("PRAGMA table_info(runs)")
        .all()
        .map((c) => c.name),
    );
    if (!runCols.has("exit_code"))
      this.db.exec("ALTER TABLE runs ADD COLUMN exit_code INTEGER");
    if (!runCols.has("exit_signal"))
      this.db.exec("ALTER TABLE runs ADD COLUMN exit_signal TEXT");

    const accountCols = new Set(
      this.db
        .prepare("PRAGMA table_info(accounts)")
        .all()
        .map((c) => c.name),
    );
    const accountMigrations = [
      ["streak_protection_enabled", "INTEGER"],
      ["streak_protection_remaining_days", "INTEGER"],
      ["streak_counter", "INTEGER"],
      ["streak_protection_updated_at", "TEXT"],
    ];
    for (const [name, type] of accountMigrations) {
      if (!accountCols.has(name))
        this.db.exec(`ALTER TABLE accounts ADD COLUMN ${name} ${type}`);
    }
  }

  _prepare() {
    this.stmts = {
      getMeta: this.db.prepare("SELECT value FROM meta WHERE key = ?"),
      setMeta: this.db.prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
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
      upsertStreakProtection: this.db.prepare(`
                INSERT INTO accounts (
                    email, user_name, status, streak_protection_enabled,
                    streak_protection_remaining_days, streak_counter,
                    streak_protection_updated_at
                )
                VALUES (?, ?, 'idle', ?, ?, ?, ?)
                ON CONFLICT(email) DO UPDATE SET
                    user_name = excluded.user_name,
                    streak_protection_enabled = excluded.streak_protection_enabled,
                    streak_protection_remaining_days = excluded.streak_protection_remaining_days,
                    streak_counter = excluded.streak_counter,
                    streak_protection_updated_at = excluded.streak_protection_updated_at
            `),
      insertHistory: this.db.prepare(
        "INSERT INTO account_history (email, ts, points, gained, duration_sec) VALUES (?, ?, ?, ?, ?)",
      ),
      historyForEmail: this.db.prepare(
        "SELECT ts, points, gained, duration_sec as durationSec FROM account_history WHERE email = ? ORDER BY ts ASC",
      ),
      allAccounts: this.db.prepare(`
                SELECT email, user_name as userName, geo_locale as geoLocale, status,
                       last_start_at as lastStartAt, last_end_at as lastEndAt,
                       last_gained as lastGained, last_points as lastPoints,
                       last_duration_sec as lastDurationSec, last_error as lastError,
                       streak_protection_enabled as streakProtectionEnabled,
                       streak_protection_remaining_days as streakProtectionRemainingDays,
                       streak_counter as streakCounter,
                       streak_protection_updated_at as streakProtectionUpdatedAt
                FROM accounts
                ORDER BY COALESCE(last_end_at, last_start_at) DESC
            `),

      insertRunStart: this.db.prepare(`
                INSERT INTO runs (id, status, start_ts, version, total_accounts, clusters)
                VALUES (?, 'running', ?, ?, ?, ?)
                ON CONFLICT(id) DO NOTHING
            `),
      findRunningRun: this.db.prepare(
        `SELECT id, start_ts as startTs FROM runs WHERE status = 'running' ORDER BY start_ts DESC LIMIT 1`,
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
                       old_total as oldTotal, new_total as newTotal, runtime_min as runtimeMin,
                       exit_code as exitCode, exit_signal as exitSignal
                FROM runs ORDER BY COALESCE(start_ts, end_ts) DESC LIMIT ?
            `),
      closeRunOnExit: this.db.prepare(`
                UPDATE runs SET status = ?, end_ts = ?, exit_code = ?, exit_signal = ?
                WHERE id = ?
            `),
      allHistories: this.db.prepare(`
                SELECT email, ts, points, gained, duration_sec as durationSec
                FROM account_history
                ORDER BY email ASC, ts ASC
            `),
      allHistoriesSince: this.db.prepare(`
                SELECT email, ts, points, gained, duration_sec as durationSec
                FROM account_history
                WHERE ts >= ?
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
      countActivity: this.db.prepare("SELECT COUNT(*) as n FROM activity"),
      pruneActivity: this.db.prepare(`
                DELETE FROM activity WHERE id IN (
                    SELECT id FROM activity ORDER BY id ASC LIMIT ?
                )
            `),
    };
  }

  _readMeta(key) {
    const row = this.stmts.getMeta.get(key);
    return row ? row.value : null;
  }

  _writeMeta(key, value) {
    this.stmts.setMeta.run(key, value);
  }

  get lastTs() {
    return this._lastTs;
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
      event.raw || null,
    );
    const { n } = this.stmts.countActivity.get();
    if (n > MAX_ACTIVITY_ROWS) {
      this.stmts.pruneActivity.run(n - MAX_ACTIVITY_ROWS);
    }
  }

  apply(event) {
    if (!event || !event.ts) return false;

    if (this._lastTs && event.ts <= this._lastTs) {
      return false;
    }
    this._lastTs = event.ts;
    this._writeMeta("lastTs", event.ts);

    let changed = true;

    switch (event.kind) {
      case "account-start": {
        this.stmts.upsertAccountStart.run(
          event.email,
          event.userName || null,
          event.geoLocale || null,
          event.ts,
        );
        this._pushActivity(event);
        break;
      }
      case "account-end": {
        this.stmts.upsertAccountEnd.run(
          event.email,
          event.userName || null,
          event.ts,
          event.gained,
          event.newPoints,
          event.durationSec,
        );
        this.stmts.insertHistory.run(
          event.email,
          event.ts,
          event.newPoints,
          event.gained,
          event.durationSec,
        );
        this._pushActivity(event);
        break;
      }
      case "account-error": {
        if (event.email) {
          this.stmts.upsertAccountError.run(event.email, event.ts, event.error);
        }
        this._pushActivity(event);
        break;
      }
      case "streak-protection": {
        this.stmts.upsertStreakProtection.run(
          event.email,
          event.userName || null,
          event.enabled ? 1 : 0,
          event.remainingDays,
          event.streakCounter,
          event.ts,
        );
        break;
      }
      case "run-start": {
        // With clustering on, the bot logs one RUN-START line per worker
        // spawned for the SAME run, not once per run - e.g. Clusters: 3
        // produces 3-4 near-identical RUN-START lines a second or so apart.
        // Only the first one (nothing currently 'running') starts a new
        // row; later ones for the same run are redundant echoes and must
        // be ignored, not treated as evidence the previous row crashed.
        //
        // A 'running' row can also be a stale leftover from a run whose
        // RUN-END (and process-exit signal) never reached the store at all -
        // e.g. a container restart/upgrade killed it mid-run, or a cluster
        // worker's exit was missed. Left unchecked that permanently wedges
        // every future run: this event is dropped forever (never even
        // reaching the activity feed, since we return before _pushActivity)
        // and any later RUN-END gets misattributed to that ancient row
        // instead of getting a fresh one of its own. Tell the two cases
        // apart by age: a real duplicate echo fires within seconds of the
        // row it belongs to; anything older is stale and gets closed out.
        const alreadyRunning = this.stmts.findRunningRun.get();
        if (alreadyRunning) {
          const ageMs = Date.parse(event.ts) - Date.parse(alreadyRunning.startTs);
          const isEcho = Number.isFinite(ageMs) && ageMs >= 0 && ageMs < RUN_START_ECHO_WINDOW_MS;
          if (isEcho) {
            changed = false;
            break;
          }
          this.stmts.closeRunOnExit.run(
            "crashed",
            event.ts,
            null,
            null,
            alreadyRunning.id,
          );
        }
        this.stmts.insertRunStart.run(
          event.ts,
          event.ts,
          event.version,
          event.totalAccounts,
          event.clusters,
        );
        this._pushActivity(event);
        break;
      }
      case "wrapper-lock-acquired": {
        this._pushActivity({
          ...event,
          message: `Cron run starting (lock acquired, PID ${event.pid})`,
        });
        break;
      }
      case "wrapper-lock-released": {
        // Fires via run_daily.sh's bash EXIT trap - the parser treats both
        // "Lock released" and "Script finished" as this same signal, and
        // per its own comment it's designed to still fire even if the app
        // crashed outright and skipped its own RUN-END line entirely. If a
        // run is still marked 'running' by the time this shows up, that's
        // proof nothing else is coming for it - close it out here rather
        // than leaving a permanent ghost. This only covers wrapper-invoked
        // runs (cron/RUN_ON_START); a run started directly via the
        // dashboard/API still relies on closeRunOnExit for that case.
        const stillRunning = this.stmts.findRunningRun.get();
        if (stillRunning) {
          this.stmts.closeRunOnExit.run(
            "crashed",
            event.ts,
            null,
            null,
            stillRunning.id,
          );
        }
        if (event.pid) {
          this._pushActivity({
            ...event,
            message: `Cron run finished (lock released, PID ${event.pid})`,
          });
        }
        break;
      }
      case "run-end": {
        const running = this.stmts.findRunningRun.get();
        if (running) {
          this.stmts.closeRun.run(
            event.ts,
            event.accountsProcessed,
            event.totalGained,
            event.oldTotal,
            event.newTotal,
            event.runtimeMin,
            running.id,
          );
        } else {
          this.stmts.insertOrphanRunEnd.run(
            event.ts,
            event.ts,
            event.accountsProcessed,
            event.totalGained,
            event.oldTotal,
            event.newTotal,
            event.runtimeMin,
          );
        }
        this._pushActivity(event);
        break;
      }
      case "login-number": {
        this._pushActivity({
          ...event,
          level: "warn",
          message: `Login approval needed for ${event.userName}: select number ${event.number}`,
        });
        break;
      }
      case "generic": {
        if (event.level === "warn" || event.level === "error") {
          this._pushActivity(event);
        } else {
          changed = false;
        }
        break;
      }
      default:
        changed = false;
    }

    return changed;
  }

  closeRunOnExit(exit) {
    const running = this.stmts.findRunningRun.get();
    if (!running) return false;
    const code = exit?.code ?? null;
    const signal = exit?.signal ?? null;

    // A clean exit (code 0, no signal) almost always means the app already
    // logged its own RUN-END line, which the "run-end" event handler above
    // closes with the real accounts/points data. Racing ahead here would
    // stamp this row 'done' with everything NULL, then force run-end into
    // creating a second, orphaned row once it can't find this one anymore -
    // exactly the empty "Done -/N" duplicates this was producing. Only step
    // in for crashes/kills, where no RUN-END line is ever coming.
    if (!signal && code === 0) return false;

    const status = signal ? "stopped" : "crashed";
    this.stmts.closeRunOnExit.run(
      status,
      exit?.at || new Date().toISOString(),
      code,
      signal,
      running.id,
    );
    return true;
  }

  // schedule
  getSchedule() {
    const raw = this._readMeta("schedule");
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  setSchedule(config) {
    this._writeMeta("schedule", JSON.stringify(config));
    return config;
  }

  snapshotAccounts() {
    return this.stmts.allAccounts.all();
  }

  snapshotRuns(limit = 30) {
    return this.stmts.recentRuns.all(limit);
  }

  allAccountHistories({ since = null } = {}) {
    const rows = since
      ? this.stmts.allHistoriesSince.all(since)
      : this.stmts.allHistories.all();
    const byEmail = {};
    for (const row of rows) {
      if (!byEmail[row.email]) byEmail[row.email] = [];
      byEmail[row.email].push({
        ts: row.ts,
        points: row.points,
        gained: row.gained,
        durationSec: row.durationSec,
      });
    }
    return byEmail;
  }

  snapshotActivity(limit = 100) {
    return this.stmts.recentActivity.all(limit);
  }

  accountHistory(email) {
    return this.stmts.historyForEmail.all(email);
  }

  saveNow() {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  }

  close() {
    this.saveNow();
    this.db.close();
  }
}

module.exports = { Store };