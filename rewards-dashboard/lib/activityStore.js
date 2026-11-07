"use strict";

/**
 * activityStore.js — persistence + ingestion for the structured activity data.
 *
 * Why snapshots instead of normalised rows: the model (activityModel.js) is
 * recomputed on read, so changing a catalog entry or cause mapping re-labels
 * every stored day without a migration. Each snapshot is a trimmed copy of one
 * account's slice of one run (~5-10 KB), keyed by (run_id, email).
 *
 * Data sources:
 *   GET /history     -> the durable record (completion, bySource, streaks...)
 *   GET /status.run  -> extras that /history omits (earnable, searchSummary,
 *                       browserPhases, appQuotaState). Only the latest finished
 *                       run is there, so it must be captured at run end.
 * When the upstream script adds those fields to /history, attachExtras()
 * simply becomes a no-op: the keys are already present on the snapshot.
 */

const zlib = require("node:zlib");
const {
  normalizeRun,
  buildDaysFromEntries,
  compactDay,
  rewardsDayOf,
  classifyDeferral,
  hasStructuredData,
  v4RunToEntries,
  v4SkipError,
  scriptMajorOf,
  PUNCHCARD_KEYS,
} = require("./activityModel");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS run_account_snapshots (
  run_id   TEXT NOT NULL,
  email    TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  PRIMARY KEY (run_id, email)
);
CREATE INDEX IF NOT EXISTS idx_ras_email_ended
  ON run_account_snapshots (email, ended_at);

-- Punch card progress read from the log line; one row per account, card, day.
CREATE TABLE IF NOT EXISTS punchcard_progress (
  email    TEXT NOT NULL,
  offer_id TEXT NOT NULL,
  day      TEXT NOT NULL,
  done     INTEGER NOT NULL,
  total    INTEGER NOT NULL,
  locked   INTEGER,
  seen_at  TEXT NOT NULL,
  PRIMARY KEY (email, offer_id, day)
);
`;

const EXTRA_KEYS = ["earnable", "searchSummary", "browserPhases", "appQuotaState"];
const DETAIL_LISTS = ["completed", "incomplete", "unavailable", "notApplicable"];
const DAY_MS = 24 * 3600 * 1000;
const RETRY_BACKOFF_MS = 60 * 1000;

function trimDetail(d) {
  const out = {};
  for (const k of [
    "activity", "label", "platform", "status", "reason", "category",
    "pointsGained", "pointsKnown", "title", "offerId", "message",
    "balanceBefore", "balanceAfter",
  ])
    if (d[k] !== undefined && d[k] !== null) out[k] = d[k];
  return out;
}

function trimAccount(a) {
  const completion = a.completion || {};
  const out = {
    schema: a.schema ?? null,
    level: a.level ?? null,
    pointsProgress: a.pointsProgress ?? null,
    pointsRemaining: a.pointsRemaining ?? null,
    lifetimeEarn: a.lifetimeEarn ?? null,
    status: a.status ?? null,
    success: a.success ?? null,
    error: a.error ?? null,
    durationSeconds: a.durationSeconds ?? null,
    resetAt: a.resetAt ?? null,
    resetAtSource: a.resetAtSource ?? null,
    initialPoints: a.initialPoints ?? null,
    currentBalance: a.currentBalance ?? null,
    collected: a.collected ?? 0,
    pointsKnown: a.pointsKnown ?? null,
    bySource: a.bySource || {},
    unattributed: a.unattributed ?? 0,
    streaks: a.streaks || [],
    streakProtection: a.streakProtection ?? null,
    edgeBrowsing: a.edgeBrowsing ?? null,
    completion: {
      counts: completion.counts || null,
      omitted: completion.omitted || 0,
    },
  };
  for (const list of DETAIL_LISTS)
    out.completion[list] = (completion[list] || []).map(trimDetail);
  for (const k of EXTRA_KEYS) if (a[k] !== undefined) out[k] = a[k];
  // Structured punch cards, if the script provides them (see activityModel.js).
  for (const k of PUNCHCARD_KEYS) if (a[k] !== undefined) out[k] = a[k];
  return out;
}

class ActivityStore {
  /**
   * @param {import("node:sqlite").DatabaseSync} db  the dashboard's existing DB
   * @param {{retentionDays?: number, log?: Function}} [opts]
   */
  constructor(db, { retentionDays = 120, log = () => {}, resetHourUtc = null } = {}) {
    this.db = db;
    this.retentionDays = retentionDays;
    this.log = log;
    db.exec(SCHEMA);
    this.stmts = {
      insert: db.prepare(
        `INSERT OR IGNORE INTO run_account_snapshots (run_id, email, ended_at, snapshot)
         VALUES (?, ?, ?, ?)`,
      ),
      byRun: db.prepare(
        "SELECT email, snapshot FROM run_account_snapshots WHERE run_id = ?",
      ),
      update: db.prepare(
        "UPDATE run_account_snapshots SET snapshot = ? WHERE run_id = ? AND email = ?",
      ),
      since: db.prepare(
        `SELECT snapshot FROM run_account_snapshots
         WHERE ended_at >= ? ORDER BY ended_at ASC`,
      ),
      prune: db.prepare("DELETE FROM run_account_snapshots WHERE ended_at < ?"),
      count: db.prepare("SELECT COUNT(*) AS n FROM run_account_snapshots"),
      latestSnapshot: db.prepare(
        "SELECT snapshot FROM run_account_snapshots ORDER BY ended_at DESC LIMIT 1",
      ),
      pcGet: db.prepare(
        "SELECT done, total, locked FROM punchcard_progress WHERE email = ? AND offer_id = ? AND day = ?",
      ),
      pcUpsert: db.prepare(
        `INSERT INTO punchcard_progress (email, offer_id, day, done, total, locked, seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (email, offer_id, day) DO UPDATE SET
           done = excluded.done, total = excluded.total,
           locked = excluded.locked, seen_at = excluded.seen_at`,
      ),
      pcForAccount: db.prepare(
        `SELECT offer_id, day, done, total, locked FROM punchcard_progress
         WHERE email = ? AND day <= ? AND day >= ? ORDER BY day DESC, seen_at DESC`,
      ),
      pcPrune: db.prepare("DELETE FROM punchcard_progress WHERE day < ?"),
      latestForEmail: db.prepare(
        "SELECT run_id, snapshot FROM run_account_snapshots WHERE email = ? ORDER BY ended_at DESC LIMIT 1",
      ),
    };
    // The hour (UTC) the Rewards day rolls over, learned from stored runs.
    // v5 reports its own reset time; for v4 (and runs without one) use this hour,
    // which can be set with ACTIVITY_RESET_HOUR_UTC if the 08:00Z default is wrong.
    this._configuredResetHour = Number.isInteger(resetHourUtc) && resetHourUtc >= 0 && resetHourUtc < 24 ? resetHourUtc : null;
    this._resetHour = this._learnResetHour();
    this._seenRuns = new Set(); // run ids already ingested, even if empty
    this._pendingExtras = new Map(); // runId -> status accounts, if history lags
    this._inFlight = null;
    this._retryAt = 0;
    this.booted = false;
    this.syncError = null; // message of the last failed sync, until one succeeds
    this.scriptMajor = null; // 4 or 5, from /status .version
    this._skips = new Map(); // v4: email -> {reason, ts} from ACCOUNT-SKIP lines, until the run is stored
    // Bumped whenever stored data changes; drives the cached payload + ETag.
    // The epoch keeps ETags unique across restarts.
    this.version = 0;
    this._epoch = Date.now().toString(36);
    this._payloads = new Map();
  }

  _learnResetHour() {
    try {
      const row = this.stmts.latestSnapshot.get();
      const at = row && Date.parse(JSON.parse(row.snapshot).account.resetAt);
      if (Number.isFinite(at)) return new Date(at).getUTCHours();
    } catch { /* fall back to the default */ }
    return this._configuredResetHour ?? 8;
  }

  _noteResetAt(resetAt) {
    const at = Date.parse(resetAt);
    if (Number.isFinite(at)) this._resetHour = new Date(at).getUTCHours();
  }

  // -- punch cards (log-derived) -------------------------------------------

  /**
   * Record a "punchcard-progress" event from parser.js. Idempotent: the same
   * line seen twice (desktop + mobile, or a log replay) changes nothing.
   * @returns {boolean} whether anything changed
   */
  recordPunchcard(ev) {
    const at = Date.parse(ev && ev.ts);
    if (!ev || !ev.email || !ev.offerId || !Number.isFinite(at)) return false;
    if (!(ev.total > 0) || !(ev.done >= 0) || ev.done > ev.total) return false;
    const day = rewardsDayOf(at, this._resetHour);
    const cur = this.stmts.pcGet.get(ev.email, ev.offerId, day);
    const locked = ev.locked ?? null;
    if (cur && cur.done === ev.done && cur.total === ev.total && cur.locked === locked) return false;
    this.stmts.pcUpsert.run(ev.email, ev.offerId, day, ev.done, ev.total, locked, ev.ts);
    this.version++;
    return true;
  }

  /**
   * Log-derived cards for one account-day. Cards recorded that day win; with
   * none, the most recent card from the previous 7 days is carried forward and
   * marked with the day it was last seen (asOf), unless it is already complete.
   */
  punchcardsFor(email, day) {
    const from = new Date(Date.parse(day) - 7 * 86400000).toISOString().slice(0, 10);
    const rows = this.stmts.pcForAccount.all(email, day, from);
    const label = (offerId) => {
      const m = /_([A-Z][a-z]{2})w(\d)_/.exec(offerId);
      return m ? `${m[1]} week ${m[2]}` : null;
    };
    const shape = (r, asOf) => ({
      offerId: r.offer_id,
      title: label(r.offer_id),
      done: r.done,
      total: r.total,
      locked: r.locked,
      asOf: asOf || null,
      source: "log",
    });
    const today = rows.filter((r) => r.day === day);
    if (today.length) return today.map((r) => shape(r));
    // Rows are newest first: judge the card by its latest state, so a card
    // finished since its last incomplete sighting is not shown as stale.
    const latest = rows[0];
    return latest && latest.done < latest.total ? [shape(latest, latest.day)] : [];
  }

  /** Insert one (run, account) snapshot; returns 1 if it was new. */
  _store(runId, entry) {
    const stored = {
      runId,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      email: entry.email,
      account: trimAccount(entry.account),
    };
    const res = this.stmts.insert.run(
      runId,
      entry.email,
      entry.endedAt || entry.startedAt || new Date().toISOString(),
      JSON.stringify(stored),
    );
    return Number(res.changes);
  }

  // -- v4 (script < 5) -----------------------------------------------------

  /** v4 logs "Skipped account: ... | reason=..." and its Control API ignores it. */
  recordSkip(ev) {
    if (!ev || !ev.email) return false;
    const at = Date.parse(ev.ts);
    const ts = Number.isFinite(at) ? at : Date.now();
    for (const [k, v] of this._skips) if (Date.now() - v.ts > 36 * 3600e3) this._skips.delete(k);
    // The run may already be stored (after a dashboard restart the replayed log
    // line can arrive after the first sync): correct that snapshot instead.
    const row = this.stmts.latestForEmail.get(ev.email);
    if (row) {
      const stored = JSON.parse(row.snapshot);
      const a = stored.account;
      if (a.schema === "v4" && a.status === "unknown" && Date.parse(stored.endedAt) >= ts - 1000) {
        a.status = "skipped";
        a.error = v4SkipError(ev.reason);
        this.stmts.update.run(JSON.stringify(stored), row.run_id, ev.email);
        this.version++;
        return true;
      }
    }
    this._skips.set(ev.email, { reason: ev.reason, ts });
    return true;
  }

  /**
   * Store the finished run from /status. v4's /history keeps only per-account
   * totals, while its /status run summary still holds the per-source points,
   * earnable and search split, so the dashboard has to capture it itself.
   * Idempotent: the run is keyed by when it ended.
   */
  ingestV4Run(status) {
    const run = status && status.run;
    const endedAt = status && status.lastExit && status.lastExit.at;
    if (!run || !endedAt || !(run.accounts || []).length) return 0;
    if (!run.finished && status.state !== "idle") return 0; // still running
    const runId = `v4:${endedAt}`;
    if (this._seenRuns.has(runId)) return 0;
    this._seenRuns.add(runId);
    const entries = v4RunToEntries({ run, endedAt, runId, skips: this._skips });
    let added = 0;
    for (const e of entries) {
      added += this._store(runId, e);
      this._skips.delete(e.email);
    }
    if (added) this.version++;
    return added;
  }

  get size() {
    return this.stmts.count.get().n;
  }

  /** Ingest GET /history records (either shape). Returns snapshots added. */
  ingestRecords(records) {
    let added = 0;
    for (const rec of records || []) {
      if (!rec) continue;
      const runId = rec.runId || (rec.exit && rec.exit.runId) || null;
      if (runId) this._seenRuns.add(runId);
      for (const entry of normalizeRun(rec)) {
        // Pre-v5 runs have no per-activity data; storing them would create empty
        // days that read as "complete". Skipped/deferred accounts are kept: they
        // are real outcomes ("not run: high bot score").
        if (!hasStructuredData(entry.account) && !classifyDeferral(entry.account)) continue;
        const id = runId || `${rec.startedAt}`;
        this._noteResetAt(entry.account.resetAt);
        added += this._store(id, entry);
      }
      if (added) this.version++;
      if (runId && this._pendingExtras.has(runId)) {
        this.attachExtras(runId, this._pendingExtras.get(runId));
        this._pendingExtras.delete(runId);
      }
    }
    return added;
  }

  /** Merge /status run extras into the stored snapshots of one run. */
  attachExtras(runId, statusAccounts) {
    if (!runId || !Array.isArray(statusAccounts)) return 0;
    const rows = this.stmts.byRun.all(runId);
    if (!rows.length) {
      // History hasn't produced this run yet; keep the extras for ingest.
      this._pendingExtras.set(runId, statusAccounts);
      if (this._pendingExtras.size > 5)
        this._pendingExtras.delete(this._pendingExtras.keys().next().value);
      return 0;
    }
    const byEmail = new Map(
      statusAccounts
        .filter((a) => a && a.email)
        .map((a) => [String(a.email).trim().toLowerCase(), a]),
    );
    let updated = 0;
    for (const row of rows) {
      const src = byEmail.get(row.email);
      if (!src) continue;
      const stored = JSON.parse(row.snapshot);
      let changed = false;
      for (const k of EXTRA_KEYS)
        if (src[k] !== undefined && stored.account[k] === undefined) {
          stored.account[k] = src[k];
          changed = true;
        }
      if (changed) {
        this.stmts.update.run(JSON.stringify(stored), runId, row.email);
        updated++;
      }
    }
    if (updated) this.version++;
    return updated;
  }

  prune(now = Date.now()) {
    const cutoff = new Date(now - this.retentionDays * DAY_MS).toISOString();
    this.stmts.pcPrune.run(cutoff.slice(0, 10));
    const removed = Number(this.stmts.prune.run(cutoff).changes);
    if (removed) this.version++;
    return removed;
  }

  /**
   * Serialised, gzipped API payload for GET /api/activity-days, rebuilt only
   * when the data changes (or the hour rolls over, since the window moves).
   * @returns {{etag:string, json:Buffer, gzip:Buffer}}
   */
  payload({ days = 14, now = Date.now() } = {}) {
    const hour = Math.floor(now / 3600000);
    const hit = this._payloads.get(days);
    if (hit && hit.version === this.version && hit.hour === hour) return hit;
    const full = this.daysAll({ days, now });
    const accounts = {};
    for (const [email, list] of Object.entries(full.accounts))
      accounts[email] = list.map(compactDay);
    // synced/syncError let the page tell "no data yet" apart from "not synced".
    const json = Buffer.from(JSON.stringify({ accounts, synced: this.booted, syncError: this.syncError, scriptMajor: this.scriptMajor }));
    const built = {
      version: this.version,
      hour,
      etag: `W/"${this._epoch}-${this.version}-${hour}-${days}"`,
      json,
      gzip: zlib.gzipSync(json),
    };
    this._payloads.set(days, built);
    return built;
  }

  /**
   * Day tables for every account.
   * @returns {{ accounts: Record<string, object[]> }}  newest day first
   */
  daysAll({ days = 14, now = Date.now() } = {}) {
    const cutoff = new Date(now - (days + 2) * DAY_MS).toISOString();
    const entries = this.stmts
      .since.all(cutoff)
      .map((r) => JSON.parse(r.snapshot));
    const built = buildDaysFromEntries(entries, { resetHourUtc: this._resetHour });
    const accounts = {};
    for (const [email, byDay] of built) {
      for (const d of byDay.values())
        if (!d.punchcards.length) d.punchcards = this.punchcardsFor(email, d.day);
      accounts[email] = [...byDay.values()]
        .sort((a, b) => b.day.localeCompare(a.day))
        .slice(0, days);
    }
    return { accounts };
  }

  // -- sync from the Control API -------------------------------------------

  needsSync(status) {
    if (Date.now() < this._retryAt) return false; // back off after a failure
    if (!this.booted) return true;
    const major = scriptMajorOf(status);
    if (major && major < 5) {
      const at = status.lastExit && status.lastExit.at;
      return Boolean(status.state === "idle" && at && !this._seenRuns.has(`v4:${at}`));
    }
    const id = status && status.lastExit && status.lastExit.runId;
    return Boolean(id && !this._seenRuns.has(id));
  }

  /**
   * Pull /history (and, for the run that just ended, /status extras).
   * Safe to call often: concurrent calls share one in-flight request.
   */
  sync(client, status, { limit = 20 } = {}) {
    if (this._inFlight) return this._inFlight;
    const work = (async () => {
      try {
        const major = scriptMajorOf(status);
        if (major && major !== this.scriptMajor) {
          this.scriptMajor = major;
          this.version++;
        }
        if (major && major < 5) {
          const added = this.ingestV4Run(status);
          if (!this.booted || this.syncError) this.version++;
          this.booted = true;
          this.syncError = null;
          this._retryAt = 0;
          return { added };
        }
        const data = await client.get(`/history?limit=${limit}`);
        const added = this.ingestRecords(data.runs || []);
        const run = status && status.run;
        // Script >= beta6 stamps the run's own id on /status.run.
        const runId =
          (run && run.finished && run.runId) ||
          (status && status.lastExit && status.lastExit.runId);
        if (runId && run && run.finished && Array.isArray(run.accounts))
          this.attachExtras(runId, run.accounts);
        if (!this.booted || this.syncError) this.version++; // the payload's synced state changed
        this.booted = true;
        this.syncError = null;
        if (added) this.prune();
        this._retryAt = 0;
        return { added };
      } catch (e) {
        this._retryAt = Date.now() + RETRY_BACKOFF_MS;
        if (this.syncError !== e.message) {
          this.syncError = e.message;
          this.version++;
        }
        throw e;
      }
    })();
    // Clear in a callback, not inside the async function: a path with nothing
    // to await (v4) would otherwise finish, and clear this, before it is assigned.
    this._inFlight = work.finally(() => {
      this._inFlight = null;
    });
    return this._inFlight;
  }

  /** Fire-and-forget wrapper for event handlers. */
  syncSoon(client, status) {
    this.sync(client, status).catch((e) =>
      this.log("warn", `Activity sync failed: ${e.message}`),
    );
  }
}

module.exports = { ActivityStore, trimAccount, SCHEMA };
