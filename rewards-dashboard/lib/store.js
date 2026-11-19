"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { serverSql } = require("./serverSql");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "dashboard.sqlite");

const MAX_ACTIVITY_ROWS = 5000;
// Pruning in batches avoids a COUNT(*) + DELETE on every single insert.
const ACTIVITY_PRUNE_SLACK = 250;

// How often the persisted lastTs cursor is flushed for log lines that change
// nothing (see apply()). Lines that do change state persist it immediately.
const LAST_TS_FLUSH_MS = 30 * 1000;

// Exit codes the Control API reports for a run stopped from outside
// (SIGINT/SIGKILL/SIGTERM surfaced as 128+n).
const STOP_SIGNAL_BY_CODE = { 130: "SIGINT", 137: "SIGKILL", 143: "SIGTERM" };

// Signals that mean "someone stopped it". Anything else (SIGSEGV, SIGABRT...)
// is the process crashing, not an intentional stop.
const STOP_SIGNALS = new Set(["SIGINT", "SIGTERM", "SIGKILL", "SIGHUP"]);

// The Control API's own run outcomes (CONTROLLER log line / /status
// lastExit.status). Anything else is treated as "not reported" (v4).
const RUN_OUTCOMES = new Set([
  "completed",
  "partial",
  "interrupted",
  "failed",
  "cancelled",
]);

// Account outcome (the script's status=) -> the dashboard's account status.
// "partial" means the account ran to the end with some features incomplete,
// which is still a successful run for that account; the raw outcome is kept
// in last_outcome so the distinction survives.
const ACCOUNT_STATUS_BY_OUTCOME = {
  completed: "success",
  partial: "success",
  skipped: "skipped",
  cancelled: "stopped",
  failed: "error",
};

// Last-resort cutoff for a 'running' row whose account roster never filled
// (see the run-start case in apply() below) - e.g. the process died after
// only 1 of N accounts ever started, so nothing will ever complete that
// roster to trigger the normal check. Deliberately very long: a user can
// configure any number of accounts, the first run of the day can take hours
// to work through all of them, and any single account can sit blocked far
// longer still waiting on a manual login-approval prompt - so this only
// exists to bound a truly abandoned run, not to police normal durations.
const RUN_STALE_BACKSTOP_MS = 20 * 60 * 60 * 1000;

// Extra time a pre-run sleep stays shown past its nominal end.
const SLEEP_EXPIRY_SLACK_MS = 2 * 60 * 1000;

// How long to wait after the last ACCOUNT-END/ACCOUNT-ERROR before assuming
// the bot's own RUN-END is never coming and closing the run ourselves. The
// bot normally logs RUN-END within ~1s of the last account finishing; this
// only kicks in for a known bot-side clustering bug where worker-exit
// tracking undercounts and the run's own master process waits forever for
// exits that already happened, so RUN-END never fires despite every account
// having actually completed.
const AUTO_CLOSE_GRACE_MS = 15 * 1000;

// No legitimate run takes more than a couple minutes to log its very first
// ACCOUNT-START - the app logs it within ~1s of RUN-START in every observed
// case. accountDelay/manual-login waits only explain a SUBSEQUENT account
// being slow to start, never the first one. So "zero accounts started" this
// long after RUN-START is a much stronger and much faster signal of a dead
// process than RUN_STALE_BACKSTOP_MS's 20-hour window (which exists for a
// different problem: a run that died partway through a roster that DID
// start filling). Kept deliberately short.
const ZERO_START_STALE_MS = 5 * 60 * 1000;

// General safety net for a run that hangs PARTWAY through - e.g. the
// process deadlocks on a local resource (observed in production: a
// "database is locked" error from the bot's own local cache DB) without
// crashing, exiting any worker, or logging anything else ever again. Unlike
// ZERO_START_STALE_MS this can't be just a few minutes, since a run
// legitimately produces bursty gaps (accountDelay waits, slow searches) -
// but a run that's produced ABSOLUTELY NOTHING for this long, across every
// account, is well beyond any gap seen in normal operation.
const RUN_NO_ACTIVITY_STALE_MS = 90 * 60 * 1000;

// How often the zero-start watchdog checks, independent of incoming events -
// needed because a run stuck in the zero-start state produces no further
// log lines at all to trigger a check from apply().
const ZERO_START_WATCHDOG_INTERVAL_MS = 60 * 1000;

// Rewards reset on the local calendar day (the container's TZ).
function startOfLocalDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

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
    last_outcome TEXT,
    streak_protection_enabled INTEGER,
    streak_protection_remaining_days INTEGER,
    streak_counter INTEGER,
    streak_protection_updated_at TEXT,
    last_activity_counts TEXT,
    last_earnable TEXT
) STRICT;

-- Today's per-activity results (from ACTIVITY-RESULT log lines); rewards reset daily.
CREATE TABLE IF NOT EXISTS account_activities (
    email TEXT NOT NULL,
    activity TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    points_gained REAL,
    reason TEXT,
    ts TEXT NOT NULL,
    run_start TEXT,
    PRIMARY KEY (email, activity, title)
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
    exit_signal TEXT,
    outcome TEXT
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
  // dbFile may be ":memory:" (tests).
  constructor({ dbFile = DB_FILE, db = null, serverId = null, readOnly = false } = {}) {
    if (serverId !== null && (typeof serverId !== "string" || !serverId))
      throw new Error("A valid server ID is required.");
    if (!db && dbFile !== ":memory:") fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    this.db = db || new DatabaseSync(dbFile);
    this._ownsDb = !db;
    this.serverId = serverId;
    if (this._ownsDb) {
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec("PRAGMA synchronous = NORMAL;");
    }
    if (serverId === null) {
      this.db.exec(SCHEMA);
      this._migrate();
    } else {
      for (const table of ["meta", "accounts", "account_activities", "account_history", "runs", "activity"]) {
        const cols = this.db.prepare(`PRAGMA table_info(${table})`).all();
        if (!cols.some((col) => col.name === "server_id"))
          throw new Error(`The ${table} table is not server-scoped.`);
      }
    }
    this._prepare();
    this._lastTs = this._readMeta("lastTs");
    this._lastTsDirty = false;
    this._activityCount = this.stmts.countActivity.get().n;
    // A run that goes quiet is only a hang if the silence happened while we
    // were watching; time before this process booted doesn't count.
    this._bootMs = Date.now();
    this._settleTimer = null;
    this._recentRunEnd = null;
    // Ephemeral (not persisted) - transient "waiting between accounts" state
    // is only meaningful while live, unlike everything else in this class.
    this._pendingDelay = null;
    this._pendingSleep = null;
    this._wrapperSkipped = false;

    // Completion evidence for the currently running process. Deliberately
    // NOT persisted - describes evidence from the live log stream only. If
    // the dashboard restarts, it should not assume an old process completed
    // successfully merely because it had partial evidence before restart.
    this._resetCompletionEvidence();

    // Watchdog for runs whose very first account never even logged
    // ACCOUNT-START (see _tryCloseZeroStartRun below for why this needs its
    // own, much shorter timeout than RUN_STALE_BACKSTOP_MS). Runs
    // independently of incoming events, since a truly dead run produces no
    // further events to trigger a check.
    this._zeroStartWatchdog = readOnly ? null : setInterval(() => {
      try {
        this._flushLastTs();
      } catch {
        /* best-effort */
      }
      try {
        this._tryCloseZeroStartRun();
      } catch {
        /* best-effort safety net */
      }
      try {
        this._tryCloseStaleNoActivityRun();
      } catch {
        /* best-effort safety net */
      }
    }, ZERO_START_WATCHDOG_INTERVAL_MS);
    if (this._zeroStartWatchdog?.unref) this._zeroStartWatchdog.unref();
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
    if (!runCols.has("outcome"))
      this.db.exec("ALTER TABLE runs ADD COLUMN outcome TEXT");

    const accountCols = new Set(
      this.db
        .prepare("PRAGMA table_info(accounts)")
        .all()
        .map((c) => c.name),
    );
    const accountMigrations = [
      ["last_outcome", "TEXT"],
      ["streak_protection_enabled", "INTEGER"],
      ["streak_protection_remaining_days", "INTEGER"],
      ["streak_counter", "INTEGER"],
      ["streak_protection_updated_at", "TEXT"],
      ["last_activity_counts", "TEXT"],
      ["last_earnable", "TEXT"],
    ];
    for (const [name, type] of accountMigrations) {
      if (!accountCols.has(name))
        this.db.exec(`ALTER TABLE accounts ADD COLUMN ${name} ${type}`);
    }

    const activityCols = new Set(
      this.db
        .prepare("PRAGMA table_info(account_activities)")
        .all()
        .map((c) => c.name),
    );
    if (!activityCols.has("run_start"))
      this.db.exec("ALTER TABLE account_activities ADD COLUMN run_start TEXT");
  }

  _prepare() {
    const { filter, serverColumn, serverValue, prepare } = serverSql(this.db, this.serverId);
    this.stmts = {
      getMeta: prepare(`SELECT value FROM meta WHERE ${filter} AND key = ?`),
      setMeta: prepare(
        `INSERT INTO meta (${serverColumn}key, value) VALUES (${serverValue}?, ?) ON CONFLICT(${serverColumn}key) DO UPDATE SET value = excluded.value`,
      ),

      upsertAccountStart: prepare(`
                INSERT INTO accounts (${serverColumn}email, user_name, geo_locale, status, last_start_at)
                VALUES (${serverValue}?, ?, ?, 'running', ?)
                ON CONFLICT(${serverColumn}email) DO UPDATE SET
                    user_name = excluded.user_name,
                    geo_locale = excluded.geo_locale,
                    status = 'running',
                    last_outcome = NULL,
                    last_activity_counts = NULL,
                    last_earnable = NULL,
                    last_start_at = excluded.last_start_at
            `),
      clearAccountActivities: prepare(
        `DELETE FROM account_activities WHERE ${filter} AND email = ?`,
      ),
      clearStaleActivities: prepare(
        `DELETE FROM account_activities WHERE ${filter} AND email = ? AND ts < ?`,
      ),
      getActivityResult: prepare(
        `SELECT status, points_gained as pointsGained, run_start as runStart FROM account_activities WHERE ${filter} AND email = ? AND activity = ? AND title = ?`,
      ),
      getAccountStart: prepare(
        `SELECT last_start_at as startAt FROM accounts WHERE ${filter} AND email = ?`,
      ),
      upsertActivityResult: prepare(`
                INSERT INTO account_activities (${serverColumn}email, activity, title, status, points_gained, reason, ts, run_start)
                VALUES (${serverValue}?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(${serverColumn}email, activity, title) DO UPDATE SET
                    status = excluded.status,
                    points_gained = excluded.points_gained,
                    reason = excluded.reason,
                    ts = excluded.ts,
                    run_start = excluded.run_start
            `),
      allActivityResults: prepare(`
                SELECT email, activity, title, status, points_gained as pointsGained, reason
                FROM account_activities WHERE ${filter} ORDER BY ts ASC
            `),
      setActivityCounts: prepare(
        `UPDATE accounts SET last_activity_counts = ? WHERE ${filter} AND email = ?`,
      ),
      getEarnable: prepare(
        `SELECT last_earnable as value FROM accounts WHERE ${filter} AND email = ?`,
      ),
      setEarnable: prepare(
        `UPDATE accounts SET last_earnable = ? WHERE ${filter} AND email = ?`,
      ),
      // last_points keeps its previous value when the new one is NULL: a
      // failed/cancelled account reports a placeholder balance (the cluster
      // master logs 0/0 for a worker that died), and a placeholder must not
      // overwrite the last balance we actually saw.
      upsertAccountEnd: prepare(`
                INSERT INTO accounts (${serverColumn}email, user_name, status, last_end_at, last_gained, last_points, last_duration_sec, last_error, last_outcome)
                VALUES (${serverValue}?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(${serverColumn}email) DO UPDATE SET
                    status = excluded.status,
                    last_end_at = excluded.last_end_at,
                    last_gained = excluded.last_gained,
                    last_points = COALESCE(excluded.last_points, last_points),
                    last_duration_sec = excluded.last_duration_sec,
                    last_error = excluded.last_error,
                    last_outcome = excluded.last_outcome
            `),
      upsertAccountError: prepare(`
                INSERT INTO accounts (${serverColumn}email, status, last_end_at, last_error, last_outcome)
                VALUES (${serverValue}?, 'error', ?, ?, 'failed')
                ON CONFLICT(${serverColumn}email) DO UPDATE SET
                    status = 'error',
                    last_end_at = excluded.last_end_at,
                    last_error = excluded.last_error,
                    last_outcome = 'failed'
            `),
      upsertStreakProtection: prepare(`
                INSERT INTO accounts (
                    ${serverColumn}email, user_name, status, streak_protection_enabled,
                    streak_protection_remaining_days, streak_counter,
                    streak_protection_updated_at
                )
                VALUES (${serverValue}?, ?, 'idle', ?, ?, ?, ?)
                ON CONFLICT(${serverColumn}email) DO UPDATE SET
                    user_name = excluded.user_name,
                    streak_protection_enabled = excluded.streak_protection_enabled,
                    streak_protection_remaining_days = excluded.streak_protection_remaining_days,
                    streak_counter = excluded.streak_counter,
                    streak_protection_updated_at = excluded.streak_protection_updated_at
            `),
      insertHistory: prepare(
        `INSERT INTO account_history (${serverColumn}email, ts, points, gained, duration_sec) VALUES (${serverValue}?, ?, ?, ?, ?)`,
      ),
      historyForEmail: prepare(
        `SELECT ts, points, gained, duration_sec as durationSec FROM account_history WHERE ${filter} AND email = ? ORDER BY ts ASC`,
      ),
      deleteAccountRow: prepare(`DELETE FROM accounts WHERE ${filter} AND email = ?`),
      deleteAccountHistory: prepare(
        `DELETE FROM account_history WHERE ${filter} AND email = ?`,
      ),
      deleteAccountActivity: prepare(
        `DELETE FROM activity WHERE ${filter} AND email = ?`,
      ),
      allAccounts: prepare(`
                SELECT email, user_name as userName, geo_locale as geoLocale, status,
                       last_start_at as lastStartAt, last_end_at as lastEndAt,
                       last_gained as lastGained, last_points as lastPoints,
                       last_duration_sec as lastDurationSec, last_error as lastError,
                       last_outcome as lastOutcome,
                       streak_protection_enabled as streakProtectionEnabled,
                       streak_protection_remaining_days as streakProtectionRemainingDays,
                       streak_counter as streakCounter,
                       streak_protection_updated_at as streakProtectionUpdatedAt,
                       last_activity_counts as lastActivityCounts,
                       last_earnable as lastEarnable
                FROM accounts WHERE ${filter}
                ORDER BY COALESCE(last_end_at, last_start_at) DESC
            `),

      insertRunStart: prepare(`
                INSERT INTO runs (${serverColumn}id, status, start_ts, version, total_accounts, clusters)
                VALUES (${serverValue}?, 'running', ?, ?, ?, ?)
                ON CONFLICT(${serverColumn}id) DO NOTHING
            `),
      findRunningRun: prepare(
        `SELECT id, start_ts as startTs, total_accounts as totalAccounts FROM runs WHERE ${filter} AND status = 'running' ORDER BY start_ts DESC LIMIT 1`,
      ),
      accountsStartedSince: prepare(`
                SELECT COUNT(DISTINCT email) as n
                FROM activity
                WHERE ${filter} AND kind = 'account-start' AND email IS NOT NULL AND ts >= ?
            `),
      accountsResolvedSince: prepare(`
                SELECT COUNT(DISTINCT email) as n, MAX(ts) as lastTs
                FROM activity
                WHERE ${filter} AND kind IN ('account-end', 'account-error') AND email IS NOT NULL AND ts >= ?
            `),
      lastLoginPromptKindSince: prepare(`
                SELECT kind FROM activity
                WHERE ${filter} AND ts >= ? AND kind IN ('login-number', 'login-number-resolved')
                ORDER BY ts DESC LIMIT 1
            `),
      sumHistorySince: prepare(`
                SELECT COALESCE(SUM(gained), 0) as gained, COALESCE(SUM(points), 0) as points
                FROM account_history WHERE ${filter} AND ts >= ?
            `),

      insertOrphanRunEnd: prepare(`
                INSERT INTO runs (${serverColumn}id, status, end_ts, accounts_processed, total_gained, old_total, new_total, runtime_min, outcome)
                VALUES (${serverValue}?, 'done', ?, ?, ?, ?, ?, ?, ?)
            `),
      recentRuns: prepare(`
                SELECT id, status, start_ts as startTs, end_ts as endTs, version,
                       total_accounts as totalAccounts, clusters,
                       accounts_processed as accountsProcessed, total_gained as totalGained,
                       old_total as oldTotal, new_total as newTotal, runtime_min as runtimeMin,
                       exit_code as exitCode, exit_signal as exitSignal, outcome
                FROM runs WHERE ${filter} ORDER BY COALESCE(start_ts, end_ts) DESC LIMIT ? OFFSET ?
            `),
      // The single terminal-state writer for a 'running' row. RUN-END passes
      // the bot's own totals; every other path (crash/stop/interrupt/
      // auto-close) derives them from account_history, see _closeRunningRun().
      // exit_code/exit_signal are NULL when the exit wasn't observed - never
      // a guessed 0.
      closeRunFull: prepare(`
                UPDATE runs SET status = ?, end_ts = ?, accounts_processed = ?,
                    total_gained = ?, old_total = ?, new_total = ?, runtime_min = ?,
                    exit_code = ?, exit_signal = ?, outcome = ?
                WHERE ${filter} AND id = ?
            `),
      markRunStopped: prepare(`
                UPDATE runs SET status = 'stopped', exit_code = ?, exit_signal = ?,
                    outcome = COALESCE(?, outcome)
                WHERE ${filter} AND id = ?
            `),
        markRunInterrupted: prepare(`
            UPDATE runs SET status = 'interrupted', exit_code = ?,
              exit_signal = ?, outcome = 'interrupted'
            WHERE ${filter} AND id = ?
          `),
      // Fills in what the process exit/controller reported for a run RUN-END
      // already closed. A NULL never erases a value we already have.
      setRunExit: prepare(`
                UPDATE runs SET outcome = COALESCE(?, outcome),
                    exit_code = COALESCE(?, exit_code),
                    exit_signal = COALESCE(?, exit_signal)
                WHERE ${filter} AND id = ?
            `),
      updateStoppedRunEnd: prepare(`
                UPDATE runs SET end_ts = ?, accounts_processed = ?, total_gained = ?,
                    old_total = ?, new_total = ?, runtime_min = ?
                WHERE ${filter} AND id = ? AND status = 'stopped'
            `),
      orphanedRunningAccounts: prepare(
        `SELECT email FROM accounts WHERE ${filter} AND status = 'running' AND last_start_at >= ?`,
      ),
      markAccountInterrupted: prepare(`
            UPDATE accounts SET status = ?, last_end_at = ?, last_error = ?, last_outcome = ?
                WHERE ${filter} AND email = ? AND status = 'running'
            `),
      // RUN-END is authoritative proof that the overall run completed.
      // An account still marked 'running' at this point did not emit its own
      // ACCOUNT-END/ACCOUNT-ERROR, but it must not remain 'running' forever.
      // Keep the diagnostic in last_error so the missing worker result is
      // visible without incorrectly classifying the completed run as an error.
      markAccountCompletedWithoutResult: prepare(`
                UPDATE accounts SET status = 'success', last_end_at = ?, last_error = ?, last_outcome = NULL
                WHERE ${filter} AND email = ? AND status = 'running'
            `),
      allHistories: prepare(`
                SELECT email, ts, points, gained, duration_sec as durationSec
                FROM account_history
                WHERE ${filter}
                ORDER BY email ASC, ts ASC
            `),
      allHistoriesSince: prepare(`
                SELECT email, ts, points, gained, duration_sec as durationSec
                FROM account_history
                WHERE ${filter} AND ts >= ?
                ORDER BY email ASC, ts ASC
            `),

      insertActivity: prepare(`
                INSERT INTO activity (${serverColumn}ts, level, title, kind, user_name, platform, email, message, raw)
                VALUES (${serverValue}?, ?, ?, ?, ?, ?, ?, ?, ?)
            `),
      recentActivity: prepare(`
                SELECT id, ts, level, title, kind, user_name as userName, platform, email, message, raw
                FROM activity WHERE ${filter} ORDER BY id DESC LIMIT ?
            `),
      countActivity: prepare(`SELECT COUNT(*) as n FROM activity WHERE ${filter}`),
      pruneActivity: prepare(`
                DELETE FROM activity WHERE ${filter} AND id IN (
                    SELECT id FROM activity WHERE ${filter} ORDER BY id ASC LIMIT ?
                )
            `),
    };
  }

  // Within a run the latest line wins. Across runs of the same day a
  // completed activity is never downgraded, and its points accumulate.
  _recordActivityResult(event) {
    const title = event.title || "";
    const runStart = this.stmts.getAccountStart.get(event.email)?.startAt ?? null;
    const prev = this.stmts.getActivityResult.get(event.email, event.activity, title);
    let status = event.activityStatus;
    let points = event.pointsGained;
    if (prev && prev.runStart !== runStart && prev.status === "completed") {
      if (status === "completed") {
        points = prev.pointsGained == null && points == null
          ? null
          : (prev.pointsGained ?? 0) + (points ?? 0);
      } else {
        status = "completed";
        points = prev.pointsGained;
      }
    }
    this.stmts.upsertActivityResult.run(
      event.email,
      event.activity,
      title,
      status,
      points,
      event.reason,
      event.ts,
      runStart,
    );
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

  // Null once no wait is in progress (never set, resolved by the next
  // ACCOUNT-START, or cleared because the run itself ended/closed).
  get pendingDelay() {
    return this._pendingDelay;
  }

  // The wrapper's optional randomized pre-run sleep. Dropped once it has
  // elapsed (with slack for log lag) so a missed "Starting script..." line
  // can't leave it showing forever.
  get pendingSleep() {
    const s = this._pendingSleep;
    if (!s) return null;
    const endMs = Date.parse(s.sinceTs) + s.seconds * 1000;
    if (Number.isFinite(endMs) && Date.now() > endMs + SLEEP_EXPIRY_SLACK_MS) {
      this._pendingSleep = null;
      return null;
    }
    return s;
  }

  _resetCompletionEvidence() {
    this._workersExitedCleanly = false;
    this._workersExitedAt = null;
    this._anyWorkerExitedUncleanly = false;

    this._successfulWrapperCompletion = false;
    this._successfulWrapperCompletionAt = null;
    this._wrapperFailureSeen = false;

    // run_daily.sh released its lock while the run was still open - see the
    // wrapper-lock-released case in apply() for why that is only recorded.
    this._lockReleasedAt = null;

    // The Control API reported (on the exit event) that it saw RUN-END.
    this._apiSawSummary = false;
    this._pendingExit = null;
  }

  // Successful completion requires BOTH:
  //   1. The final cluster worker exited with Code 0, no signal, and
  //      Active workers: 0, AND no other worker this run ever exited
  //      uncleanly (see the cluster-worker-exit case in apply()).
  //   2. The wrapper reported successful completion.
  // This is the fallback for the bot-side clustering bug where RUN-END
  // itself never gets logged even though the process really did finish
  // cleanly - it must NOT fire on its own from "Lock released"/"Script
  // finished" alone, since those also happen after crashes/kills.
  _tryCloseFromSuccessfulProcessCompletion(eventTs) {
    const running = this.stmts.findRunningRun.get();
    if (!running) return false;
    if (!this._workersExitedCleanly || !this._successfulWrapperCompletion) {
      return false;
    }

    const endTs =
      this._successfulWrapperCompletionAt ||
      this._workersExitedAt ||
      eventTs ||
      new Date().toISOString();

    // Clean worker exits + a successful wrapper are real evidence of exit
    // code 0, unlike the other derived closes where the exit is unknown.
    this._closeRunningRun(running, "done", endTs, { code: 0 });
    return true;
  }

  // Watchdog for a run whose first account never even started (see
  // ZERO_START_STALE_MS above). Left unhandled, this also wedges every
  // future run: the run-start echo check below treats "roster incomplete"
  // as "same run continuing" for up to RUN_STALE_BACKSTOP_MS (20h), and a
  // run with zero accounts started can NEVER complete its roster, so every
  // subsequent RUN-START within that window would otherwise be silently
  // swallowed as a supposed echo of this dead run instead of starting a new
  // one.
  _tryCloseZeroStartRun() {
    const running = this.stmts.findRunningRun.get();
    if (!running) return;

    const startedCount = this.stmts.accountsStartedSince.get(running.startTs).n;
    if (startedCount > 0) return;

    const ageMs = Date.now() - Date.parse(running.startTs);
    if (!Number.isFinite(ageMs) || ageMs < ZERO_START_STALE_MS) return;

    this._closeRunningRun(running, "stalled", new Date().toISOString());
  }

  // General safety net for a run that hung PARTWAY through - covers the
  // zero-start case too (no activity since start is a special case of "no
  // activity for a long time"), but is deliberately much more generous
  // (RUN_NO_ACTIVITY_STALE_MS) since a run that already has accounts in
  // flight can have legitimate bursty gaps that a brand-new run can't.
  //
  // Explicitly does NOT fire while the run is waiting on a still-open
  // manual login-approval prompt - that can legitimately take a long time
  // (this is exactly why RUN_STALE_BACKSTOP_MS is 20h instead of something
  // short), and is a real, expected reason for silence rather than a hang.
  _tryCloseStaleNoActivityRun() {
    const running = this.stmts.findRunningRun.get();
    if (!running) return;

    // _lastTs is the newest line of ANY kind we accepted (including
    // informational search progress that never reaches the activity table),
    // so it alone says when the run last did something. Silence from before
    // this process booted doesn't count against the run.
    const lastTs = Math.max(
      this._lastTs ? Date.parse(this._lastTs) : 0,
      Date.parse(running.startTs),
      this._bootMs,
    );
    const ageMs = Date.now() - lastTs;
    if (!Number.isFinite(ageMs) || ageMs < RUN_NO_ACTIVITY_STALE_MS) return;

    const pendingApproval = this.stmts.lastLoginPromptKindSince.get(running.startTs);
    if (pendingApproval && pendingApproval.kind === "login-number") return;

    this._closeRunningRun(running, "stalled", new Date().toISOString());
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
    this._activityCount += 1;
    if (this._activityCount > MAX_ACTIVITY_ROWS + ACTIVITY_PRUNE_SLACK) {
      this.stmts.pruneActivity.run(this._activityCount - MAX_ACTIVITY_ROWS);
      this._activityCount = MAX_ACTIVITY_ROWS;
    }
  }

  // The lastTs cursor is what makes SSE replay idempotent after a restart.
  // Any line that changes state persists it immediately; the ~95% of lines
  // that change nothing only mark it dirty, and the watchdog tick (or
  // close()) flushes it. Losing a few of those on a crash is harmless: they
  // are re-fed on replay and ignored again.
  _flushLastTs() {
    if (!this._lastTsDirty) return;
    this._writeMeta("lastTs", this._lastTs);
    this._lastTsDirty = false;
  }

  apply(event) {
    if (!event || !event.ts) return false;

    if (this._lastTs && event.ts <= this._lastTs) {
      return false;
    }
    this._lastTs = event.ts;

    let changed = true;

    switch (event.kind) {
      case "account-start": {
        if (!this._pendingDelay || !this._pendingDelay.nextEmail || this._pendingDelay.nextEmail === event.email) {
          this._pendingDelay = null;
        }
        this.stmts.upsertAccountStart.run(
          event.email,
          event.userName || null,
          event.geoLocale || null,
          event.ts,
        );
        this.stmts.clearStaleActivities.run(event.email, startOfLocalDay(event.ts));
        this._pushActivity(event);
        break;
      }
      case "earnable": {
        // Only fields the line actually reports are replaced (app points arrive separately).
        let current = {};
        try {
          current = JSON.parse(this.stmts.getEarnable.get(event.email)?.value || "{}");
        } catch { /* start fresh */ }
        for (const key of ["mobile", "browser", "app"]) {
          if (key in event) current[key] = event[key];
        }
        this.stmts.setEarnable.run(JSON.stringify(current), event.email);
        break;
      }
      case "activity-result": {
        this._recordActivityResult(event);
        // Unconfirmed results used to reach the feed as generic warnings.
        if (event.level === "warn" || event.level === "error") this._pushActivity(event);
        break;
      }
      case "account-end": {
        const outcome = event.accountStatus;
        const known = Object.hasOwn(ACCOUNT_STATUS_BY_OUTCOME, outcome);
        const accountStatus = known ? ACCOUNT_STATUS_BY_OUTCOME[outcome] : "success";
        // last_error carries the reason for anything that isn't a clean
        // completion. For a partial account that is the list of incomplete
        // features (not an error - status stays "success"); for failed/
        // cancelled it is the failure itself.
        const error =
          outcome === "completed"
            ? null
            : event.error ||
              (known ? null : `Account finished with unrecognised status=${outcome}`);
        // A failed account can report placeholder numbers (a dead cluster
        // worker logs balance 0 and duration 0). Treat those as unknown
        // rather than as real values.
        const placeholder = event.gained == null && event.newPoints === 0;
        this.stmts.upsertAccountEnd.run(
          event.email,
          event.accountName || null,
          accountStatus,
          event.ts,
          event.gained,
          placeholder ? null : event.newPoints,
          placeholder && event.durationSec === 0 ? null : event.durationSec,
          error,
          outcome,
        );
        if (event.activityCounts) {
          this.stmts.setActivityCounts.run(
            JSON.stringify(event.activityCounts),
            event.email,
          );
        }
        // What remained earnable at the start of the run is stale once it ends.
        this.stmts.setEarnable.run(null, event.email);
        if (event.gained != null) {
          this.stmts.insertHistory.run(
            event.email,
            event.ts,
            event.newPoints,
            event.gained,
            event.durationSec,
          );
        }
        this._pushActivity(event);
        this._scheduleSettleCheck();
        break;
      }
      case "account-error": {
        if (event.email) {
          this.stmts.upsertAccountError.run(event.email, event.ts, event.error);
        }
        this._pushActivity(event);
        this._scheduleSettleCheck();
        break;
      }
      case "account-delay": {
        this._pendingDelay = {
          seconds: event.seconds,
          sinceTs: event.ts,
          nextEmail: event.nextEmail || null,
        };
        this._pushActivity(event);
        break;
      }
      case "streak-protection": {
        this.stmts.upsertStreakProtection.run(
          event.email,
          event.userName || null,
          event.enabled == null ? null : event.enabled ? 1 : 0,
          event.remainingDays,
          event.streakCounter,
          event.ts,
        );
        break;
      }
      case "run-start": {
        // With clustering on, the bot logs one RUN-START line per worker
        // spawned for the SAME run, not once per run - e.g. Clusters: 3
        // can produce several near-identical RUN-START lines, one per
        // worker, and workers have been observed spawning minutes apart
        // rather than seconds (accountDelay-dependent) - so elapsed time
        // alone can't tell an echo apart from a genuinely new run. Only
        // the first one (nothing currently 'running') starts a new row;
        // later ones for the same run are redundant echoes and must be
        // ignored, not treated as evidence the previous row crashed.
        //
        // Use the account roster instead of a clock: while the currently
        // 'running' row hasn't yet seen ACCOUNT-START for all the accounts
        // it declared, any further RUN-START is still just another worker
        // of that same run. Once every declared account has started, the
        // roster is complete and a new RUN-START can only mean a new run -
        // this also catches a 'running' row stuck by a lost RUN-END/exit
        // signal (e.g. a container restart mid-run, or a missed cluster
        // worker exit), which otherwise permanently wedges every future run
        // (this event would be dropped forever, never even reaching the
        // activity feed, and any later RUN-END would misattribute to that
        // ancient row instead of getting a fresh one of its own).
        //
        // The one gap the roster check can't cover is a run that died
        // before its roster ever filled (e.g. crashed after account 1 of
        // 3) - nothing will ever complete that roster, so fall back to a
        // generous time backstop just for that case.
        this._recentRunEnd = null;
        this._pendingSleep = null;
        this._resetCompletionEvidence();

        const alreadyRunning = this.stmts.findRunningRun.get();
        if (alreadyRunning) {
          const startedCount = alreadyRunning.totalAccounts
            ? this.stmts.accountsStartedSince.get(alreadyRunning.startTs).n
            : 0;
          const rosterIncomplete =
            alreadyRunning.totalAccounts != null && startedCount < alreadyRunning.totalAccounts;
          const ageMs = Date.parse(event.ts) - Date.parse(alreadyRunning.startTs);
          const withinBackstop = Number.isFinite(ageMs) && ageMs >= 0 && ageMs < RUN_STALE_BACKSTOP_MS;
          // A run whose roster never even started (startedCount === 0) can
          // never complete its roster, so it would otherwise look like an
          // "echo" forever (up to the 20h backstop) and swallow every
          // subsequent RUN-START. The zero-start watchdog normally closes
          // these well before another RUN-START arrives, but this is a
          // safety net for e.g. the dashboard process itself having
          // restarted and lost that timer.
          const zeroStartStale =
            startedCount === 0 &&
            Number.isFinite(ageMs) &&
            ageMs >= ZERO_START_STALE_MS;
          const isEcho = rosterIncomplete && withinBackstop && !zeroStartStale;
          if (isEcho) {
            changed = false;
            break;
          }
          // We only know a new run started before the old one finished
          // normally - not why (could be a real crash, or just as likely an
          // intentional container recreate, e.g. pulling an updated image
          // mid-run). "interrupted" reflects that honestly instead of
          // guessing "crashed". markInterruptedByBackendRestart() below
          // handles the common container-recreate case immediately instead
          // of leaving it to this backstop.
          this._closeRunningRun(
            alreadyRunning,
            zeroStartStale ? "stalled" : "interrupted",
            event.ts,
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
      case "cluster-worker-exit": {
        // Worker PIDs are deliberately irrelevant to the decision - every
        // account can have a different PID and every run can use completely
        // different PIDs.
        //
        // IMPORTANT: an earlier worker in the same run can exit uncleanly
        // (crash/signal) before a LATER worker happens to be the one that
        // reports "Active workers: 0". Only checking the final exit line
        // would miss that earlier crash, so an unclean exit is latched for
        // the whole run and blocks treating a later clean "Active workers:
        // 0" line as proof the overall process completed cleanly.
        const exitedCleanly = event.code === 0 && event.signal == null;
        if (!exitedCleanly) {
          this._anyWorkerExitedUncleanly = true;
        }
        if (
          exitedCleanly &&
          event.activeWorkers === 0 &&
          !this._anyWorkerExitedUncleanly
        ) {
          this._workersExitedCleanly = true;
          this._workersExitedAt = event.ts;
          // May close the run immediately if wrapper completion evidence
          // already arrived.
          this._tryCloseFromSuccessfulProcessCompletion(event.ts);
        }
        this._pushActivity(event);
        break;
      }
      case "wrapper-script-completed": {
        if (this._wrapperSkipped) {
          // The skipped wrapper reports success without having run anything.
          this._pushActivity(event);
          break;
        }
        // "Script completed successfully (via API)." is an explicit,
        // unambiguous positive completion signal.
        this._successfulWrapperCompletion = true;
        this._successfulWrapperCompletionAt = event.ts;
        this._tryCloseFromSuccessfulProcessCompletion(event.ts);
        this._pushActivity(event);
        break;
      }
      case "wrapper-script-finished": {
        // Weaker evidence than "Script completed successfully": some
        // wrapper versions print this unconditionally on the way out,
        // including right after "ERROR: Script failed!". Only count it as
        // completion evidence if no failure has been seen yet this run, so
        // it can't silently resurrect a run we already know failed.
        if (!this._wrapperFailureSeen && !this._wrapperSkipped) {
          this._successfulWrapperCompletion = true;
          this._successfulWrapperCompletionAt = event.ts;
          this._tryCloseFromSuccessfulProcessCompletion(event.ts);
        }
        this._pushActivity(event);
        break;
      }
      case "wrapper-script-failed": {
        // Explicit wrapper failure is not completion evidence, and it
        // "poisons" the rest of this run so a later bare "Script finished"
        // line can't flip it back to success.
        this._wrapperFailureSeen = true;
        this._successfulWrapperCompletion = false;
        this._successfulWrapperCompletionAt = null;
        this._pushActivity(event);
        break;
      }
      case "wrapper-lock-acquired": {
        this._wrapperSkipped = false;
        this._pushActivity({
          ...event,
          message: `Cron run starting (lock acquired, PID ${event.pid})`,
        });
        break;
      }
      case "wrapper-run-skipped": {
        this._wrapperSkipped = true;
        this._pendingSleep = null;
        this._pushActivity(event);
        break;
      }
      case "wrapper-sleep": {
        this._pendingSleep = { seconds: event.seconds, sinceTs: event.ts };
        this._pushActivity({
          ...event,
          message: `Run delayed: sleeping ${event.seconds}s before starting`,
        });
        break;
      }
      case "wrapper-starting": {
        this._pendingSleep = null;
        break;
      }
      case "wrapper-lock-released": {
        this._pendingSleep = null;
        // Fires via run_daily.sh's bash EXIT trap, including after a
        // crash/kill - so by itself it's never proof of success. If worker +
        // wrapper evidence already proves a clean completion, this may be
        // the event that finally closes the run.
        //
        // It must NOT close an unfinished run on the spot, though: when the
        // container is stopped, the wrapper's trap logs this about a second
        // BEFORE the bot's own shutdown lines (account results, RUN-END, the
        // controller's "Run cancelled"). Closing here split one run into an
        // "interrupted" row plus an orphan row from the RUN-END that followed.
        // So only remember it and re-check after a grace period: if the run is
        // still open by then, nothing else is coming for it.
        const closedSuccessfully = this._tryCloseFromSuccessfulProcessCompletion(
          event.ts,
        );

        if (!closedSuccessfully && this.stmts.findRunningRun.get() && !this._wrapperSkipped) {
          this._lockReleasedAt = event.ts;
          this._scheduleSettleCheck();
        }
        this._wrapperSkipped = false;

        if (event.pid) {
          this._pushActivity({
            ...event,
            message: closedSuccessfully
              ? `Cron run finished successfully (lock released, PID ${event.pid})`
              : `Cron run finished (lock released, PID ${event.pid})`,
          });
        }
        break;
      }
      case "run-end": {
        this._pendingDelay = null;
        const recentStop = this._recentRunEnd;
        const stopGapMs = recentStop
          ? Math.abs(Date.parse(event.ts) - Date.parse(recentStop.ts))
          : Infinity;
        if (
          recentStop?.status === "stopped" &&
          Number.isFinite(stopGapMs) &&
          stopGapMs <= AUTO_CLOSE_GRACE_MS
        ) {
          this.stmts.updateStoppedRunEnd.run(
            event.ts,
            event.accountsProcessed,
            event.totalGained,
            event.oldTotal,
            event.newTotal,
            event.runtimeMin,
            recentStop.id,
          );
          recentStop.ts = event.ts;
          this._pendingDelay = null;
          this._resetCompletionEvidence();
          this._pushActivity(event);
          break;
        }
        const running = this.stmts.findRunningRun.get();
        if (running) {
          // RUN-END means the script emitted its final account summary.
          // Feature-level partial status still means the run completed, so
          // the row is "done" and the script's own word (status=partial) is
          // kept as its outcome. The process exit isn't known yet - a later
          // exit/controller event fills it in (see closeRunOnExit) - so
          // exit_code stays NULL here instead of a guessed 0.
          this.stmts.closeRunFull.run(
            "done",
            event.ts,
            event.accountsProcessed,
            event.totalGained,
            event.oldTotal,
            event.newTotal,
            event.runtimeMin,
            null,
            null,
            event.terminalStatus,
            running.id,
          );
          // RUN-END firing is proof the run is genuinely over - any account
          // still marked 'running' from it never got its own result line.
          this._finalizeOrphanAccounts(running.startTs, "done", event.ts);
          this._recentRunEnd = { id: running.id, ts: event.ts, status: "done" };
        } else {
          this.stmts.insertOrphanRunEnd.run(
            event.ts,
            event.ts,
            event.accountsProcessed,
            event.totalGained,
            event.oldTotal,
            event.newTotal,
            event.runtimeMin,
            event.terminalStatus,
          );
          this._recentRunEnd = { id: event.ts, ts: event.ts, status: "done" };
        }
        this._resetCompletionEvidence();
        this._pushActivity(event);
        break;
      }
      case "controller-outcome": {
        // The Control API's verdict on the run it launched. Same handling as
        // a /status exit event, except that being part of the ordered log
        // stream (right after RUN-END) it is final - see closeRunOnExit.
        this.closeRunOnExit(
          {
            status: event.outcome,
            code: event.code,
            signal: event.signal,
            at: event.ts,
          },
          { fromLog: true },
        );
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

    if (changed) {
      this._writeMeta("lastTs", this._lastTs);
      this._lastTsDirty = false;
    } else {
      this._lastTsDirty = true;
    }
    return changed;
  }

  // Defers "should this still-open run be closed?" rather than answering it
  // inline: the bot's RUN-END (and the controller's outcome line) normally
  // follow within ~1s of the last account result / the wrapper's lock
  // release, so deciding immediately would race them - closing the row
  // ourselves right before the real RUN-END arrives, which would then find no
  // 'running' row and create a duplicate orphan. Every account result and
  // lock release reschedules the timer, so it only fires AUTO_CLOSE_GRACE_MS
  // after the LAST of them.
  _scheduleSettleCheck() {
    if (this._settleTimer) clearTimeout(this._settleTimer);
    this._settleTimer = setTimeout(() => {
      this._settleTimer = null;
      try {
        this._settleOpenRun();
      } catch {
        /* best-effort safety net - a miss here just leaves the row as-is */
      }
    }, AUTO_CLOSE_GRACE_MS);
    if (this._settleTimer.unref) this._settleTimer.unref();
  }

  // True once every account the run declared has an ACCOUNT-END/ACCOUNT-ERROR.
  _rosterResolved(running) {
    if (!running.totalAccounts) return false;
    const resolved = this.stmts.accountsResolvedSince.get(running.startTs);
    return resolved.n >= running.totalAccounts;
  }

  // Safety net for a run whose RUN-END never arrived (e.g. the bot-side
  // clustering bug where a worker's exit is never observed, so 'activeWorkers'
  // never reaches 0 and RUN-END is never logged even though every account
  // finished; or a crash that skipped it entirely).
  //  - the Control API confirmed it saw RUN-END, or every declared account
  //    resolved -> the run did finish: close as done, deriving its totals
  //    from account_history.
  //  - otherwise, if the wrapper already released its lock a grace period ago,
  //    nothing else is coming: close as interrupted.
  _settleOpenRun() {
    const running = this.stmts.findRunningRun.get();
    if (!running) return;

    const pending = this._pendingExit;
    if (!this._apiSawSummary && pending?.died) {
      // The controller said "partial" with no RUN-END, and the API never
      // confirmed one within the grace period: the script died.
      this._closeRunningRun(running, "crashed", pending.at, {
        code: pending.code,
        signal: pending.signal,
        outcome: pending.outcome,
      });
    } else if (this._apiSawSummary || this._rosterResolved(running)) {
      // Either the Control API confirmed the script's final summary (so the
      // run finished even if neither RUN-END nor the controller line reached
      // us), or every declared account reported: it finished.
      const resolved = this.stmts.accountsResolvedSince.get(running.startTs);
      const exit = this._pendingExit;
      this._closeRunningRun(
        running,
        "done",
        exit?.at || resolved.lastTs || new Date().toISOString(),
        { code: exit?.code ?? null, outcome: exit?.outcome ?? null },
      );
    } else if (this._lockReleasedAt) {
      this._closeRunningRun(running, "interrupted", this._lockReleasedAt);
    }
  }

  // Accounts this run left marked 'running' never logged a result of their
  // own, and must not stay 'running' forever. How they're finalized depends on
  // how the run ended: a completed run didn't fail because of them (success,
  // with the diagnostic kept in last_error), a stopped run stopped them, and
  // anything else counts against them.
  _finalizeOrphanAccounts(startTs, runStatus, endTs) {
    for (const { email } of this.stmts.orphanedRunningAccounts.all(startTs)) {
      if (runStatus === "done") {
        this.stmts.markAccountCompletedWithoutResult.run(
          endTs,
          "Run completed, but this account's own result was never logged (its worker likely failed silently).",
          email,
        );
      } else {
        const stopped = runStatus === "stopped";
        this.stmts.markAccountInterrupted.run(
          stopped ? "stopped" : "error",
          endTs,
          `Run ${runStatus} before this account finished`,
          stopped ? "cancelled" : "failed",
          email,
        );
      }
    }
  }

  // The one terminal-state closer for a 'running' row ended without RUN-END's
  // own totals (auto-close/crash/stop/interrupt/derived done): derives
  // accountsProcessed/gained/totals from account_history and finalizes the
  // accounts the run left 'running'. `code`/`signal` stay NULL unless the
  // exit was actually observed.
  _closeRunningRun(
    running,
    status,
    endTs,
    { code = null, signal = null, outcome = null } = {},
  ) {
    this._pendingDelay = null;
    const totals = this.stmts.sumHistorySince.get(running.startTs);
    const resolved = this.stmts.accountsResolvedSince.get(running.startTs);
    const gained = totals.gained || 0;
    const newTotal = totals.points || 0;
    const oldTotal = newTotal - gained;
    const runtimeMin = Number(
      ((Date.parse(endTs) - Date.parse(running.startTs)) / 60000).toFixed(1),
    );

    this.stmts.closeRunFull.run(
      status,
      endTs,
      resolved.n || 0,
      gained,
      oldTotal,
      newTotal,
      runtimeMin,
      code,
      signal,
      outcome,
      running.id,
    );

    this._finalizeOrphanAccounts(running.startTs, status, endTs);
    this._resetCompletionEvidence();
  }

  /**
   * Records how a run's process ended. Fed from two sources that describe the
   * same event: the Control API's /status exit (`lastExit`, via server.js) and,
   * on v5, its CONTROLLER log line (`fromLog`).
   *
   * `exit` is { code, signal, at, status } where `status` is the Control API's
   * own verdict (completed | partial | failed | cancelled) - absent on v4,
   * where the outcome is inferred from code/signal alone.
   *
   * Both sources may arrive in either order relative to RUN-END and to each
   * other, so every branch is idempotent. Only the log line is ordered
   * relative to RUN-END (it always follows it), so only it may conclude that
   * RUN-END is never coming.
   */
  closeRunOnExit(exit, { fromLog = false, summarySeen = false } = {}) {
    // `summarySeen`: the Control API says RUN-END was logged. It reads the log
    // itself, so this holds even when this dashboard missed the line.
    if (summarySeen) this._apiSawSummary = true;
    const code = exit?.code ?? null;
    const signal = exit?.signal ?? null;
    const outcome = RUN_OUTCOMES.has(exit?.status) ? exit.status : null;
    const exitAt = exit?.at || new Date().toISOString();
    // An explicit "failed" verdict always wins; otherwise only a recognized
    // stop signal / stop exit code counts as an intentional stop.
    const stopped =
      outcome === "cancelled" ||
      (outcome !== "failed" &&
        (STOP_SIGNALS.has(signal) || Object.hasOwn(STOP_SIGNAL_BY_CODE, code)));
    const stopSignal = (STOP_SIGNALS.has(signal) ? signal : null) || STOP_SIGNAL_BY_CODE[code] || null;

    // RUN-END already closed the row: just add what the exit tells us.
    const recent = this._recentRunEnd;
    if (recent?.status === "done") {
      const gapMs = Math.abs(Date.parse(exitAt) - Date.parse(recent.ts));
      if (Number.isFinite(gapMs) && gapMs <= AUTO_CLOSE_GRACE_MS) {
        if (outcome === "interrupted") {
          this.stmts.markRunInterrupted.run(code, signal, recent.id);
          recent.status = "interrupted";
          recent.ts = exitAt;
        } else if (stopped) {
          // RUN-END reads status=partial even for a cancelled run, so the
          // exit is what turns "done" into "stopped".
          this.stmts.markRunStopped.run(code, stopSignal, outcome, recent.id);
          recent.status = "stopped";
          recent.ts = exitAt;
        } else {
          this.stmts.setRunExit.run(outcome, code, signal, recent.id);
        }
        return true;
      }
    }

    const running = this.stmts.findRunningRun.get();
    if (!running) return false;

    if (stopped) {
      this._closeRunningRun(running, "stopped", exitAt, {
        code,
        signal: stopSignal,
        outcome,
      });
      this._recentRunEnd = { id: running.id, ts: exitAt, status: "stopped" };
      return true;
    }

    if (outcome === "interrupted") {
      this._closeRunningRun(running, "interrupted", exitAt, {
        code,
        signal,
        outcome,
      });
      return true;
    }

    // A completed-with-partial-features run exits non-zero, and the exit
    // event can reach us just before the final RUN-END. Whenever the run
    // plausibly finished (every account resolved, or a clean exit) leave the
    // row for RUN-END instead of misreading a normal exit as a crash or
    // racing ahead and stamping the row 'done' with every total NULL - which
    // forces RUN-END into creating a second, empty row. Only the ordered log
    // line can say RUN-END is not coming.
    // The exception is a v5 "partial" verdict reaching us through the log
    // while the row is still open: RUN-END always precedes that line, so it
    // means the script died before its final summary (even if every account
    // had already reported) and must not be recorded as a finished run.
    // Unless the Control API says it did see RUN-END, in which case the
    // script finished and only our own copy of the line is missing.
    //
    // That verdict can't be final yet, though: the controller line is logged
    // BEFORE the /status exit event that carries the API's RUN-END evidence,
    // so when the dashboard has missed RUN-END the line arrives first. Defer
    // the decision for the grace period; the exit event (or the settle check)
    // then resolves it.
    const diedBeforeSummary =
      fromLog && outcome === "partial" && !this._apiSawSummary;
    if (diedBeforeSummary) {
      this._pendingExit = { code, signal, outcome, at: exitAt, died: true };
      this._scheduleSettleCheck();
      return false;
    }
    // The exit event, arriving after such a deferred verdict, saying the API
    // never saw RUN-END either: nothing is coming, so it is a crash now.
    const apiDenied = !fromLog && this._pendingExit?.died && !summarySeen;
    const finished =
      !apiDenied &&
      outcome !== "failed" &&
      (this._rosterResolved(running) ||
        (outcome === "partial" && this._apiSawSummary) ||
        outcome === "completed" ||
        (outcome == null && !signal && code === 0));
    if (finished) {
      if (!fromLog) {
        // Wait for RUN-END / the controller line - but if the API already
        // confirmed the summary, don't depend on either arriving: remember the
        // exit and let the settle check close the row if they never do.
        if (this._apiSawSummary) {
          this._pendingExit = { code, outcome, at: exitAt };
          this._scheduleSettleCheck();
        }
        return false;
      }
      this._closeRunningRun(running, "done", exitAt, { code, outcome });
      this._recentRunEnd = { id: running.id, ts: exitAt, status: "done" };
      return true;
    }

    // Reaching here means the process exited non-zero (or the controller said
    // "failed") before the run's accounts were all accounted for: this path
    // comes from directly observing the exit, so unlike the "interrupted"
    // paths we have real evidence it crashed.
    this._closeRunningRun(running, "crashed", exitAt, { code, signal, outcome });
    return true;
  }

  // Called when the dashboard detects the Control API/container itself
  // restarted mid-poll (health.uptimeSec went backwards) - a much faster and
  // more direct signal than waiting for a new RUN-START to eventually prove
  // the old row is stale. Covers container recreation for any reason
  // (image update, manual restart, OOM kill, host reboot), which is why the
  // result is "interrupted" rather than "crashed": we only know the backend
  // vanished, not why.
  //
  // notStartedAfter guards a race with the SSE log stream, which can notice
  // the same disconnect on its own and reconnect - possibly processing a
  // brand new RUN-START - before this poll-driven check runs. Only close a
  // row that was already 'running' as of the last known-good health check;
  // never one that could be that legitimate new run.
  markInterruptedByBackendRestart(at = new Date().toISOString(), { notStartedAfter = null } = {}) {
    const running = this.stmts.findRunningRun.get();
    if (!running) return false;
    if (notStartedAfter && running.startTs >= notStartedAfter) return false;
    this._closeRunningRun(running, "interrupted", at);
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

  // email -> today's activity results (merged across the day's runs).
  accountActivities() {
    const byEmail = {};
    for (const row of this.stmts.allActivityResults.all()) {
      (byEmail[row.email] ||= []).push({
        activity: row.activity,
        title: row.title,
        status: row.status,
        pointsGained: row.pointsGained,
        pointsKnown: row.pointsGained != null,
        reason: row.reason,
      });
    }
    return byEmail;
  }

  snapshotRuns(limit = 30, offset = 0) {
    return this.stmts.recentRuns.all(limit, offset);
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

  // Purges everything the dashboard has ever recorded for an account it no
  // longer tracks (e.g. removed from the bot's .env) - the accounts row
  // itself plus its point history and activity log entries - so it stops
  // showing up anywhere (accounts list, overview, history charts).
  deleteAccount(email) {
    this.db.exec("BEGIN");
    try {
      this.stmts.deleteAccountRow.run(email);
      this.stmts.clearAccountActivities.run(email);
      this.stmts.deleteAccountHistory.run(email);
      this.stmts.deleteAccountActivity.run(email);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  saveNow() {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  }

  close({ keepDatabase = false } = {}) {
    if (this._settleTimer) clearTimeout(this._settleTimer);
    if (this._zeroStartWatchdog) clearInterval(this._zeroStartWatchdog);
    this._flushLastTs();
    if (this._ownsDb && !keepDatabase) {
      this.saveNow();
      this.db.close();
    }
  }
}

module.exports = { Store };