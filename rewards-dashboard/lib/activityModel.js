"use strict";

/**
 * activityModel.js — turns the Control API's structured run data into a
 * per-account, per-Rewards-day activity table.
 *
 * Input shapes accepted (both are the same data, differently trimmed):
 *   - GET /history record:      { runId, startedAt, endedAt, accounts: [...] }
 *   - config/run-history.json:  { runId, startedAt, endedAt, run: { accounts: [...] } }
 * Optional extras (earnable, searchSummary, browserPhases) exist only on
 * GET /status -> run.accounts[], so attachExtras() merges them in by email.
 *
 * Nothing here touches the DB, the network, or the DOM.
 */

// ---------------------------------------------------------------------------
// Catalog: script activity id -> table group. Unknown ids fall into "other"
// (and are reported in day.unmapped) so a new script release can't silently
// disappear from the table.
// ---------------------------------------------------------------------------
const GROUPS = {
  search: { label: "Searches", order: 10 },
  "mobile-search": { label: "Mobile search quota", order: 11 },
  "account-run": { label: "Account run", order: 1 },
  "daily-set": { label: "Daily Set", order: 20 },
  promotions: { label: "Promotions", order: 25 }, // v4: Daily Set + More Promos are not separable
  "more-promotions": { label: "More Promos", order: 30 },
  punchcards: { label: "Punch Cards", order: 40 },
  "read-to-earn": { label: "Read to Earn", order: 50 },
  "earn-page": { label: "Earn Page", order: 55 },
  "daily-check-in": { label: "Daily Check-in", order: 60 },
  "bonus-claim": { label: "Bonus Claim", order: 70 },
  "visual-search": { label: "Visual Search", order: 80 },
  "streak-protection": { label: "Streak Protection", order: 90 },
  "edge-browsing": { label: "Edge Browsing", order: 100 },
  "app-rewards": { label: "App Rewards", order: 85 },
  "search-perk": { label: "Search Perk", order: 110 },
  other: { label: "Other", order: 900 },
};

const ACTIVITY_GROUP = {
  search: "search",
  "browser-search-api-report": "search", // informational, hidden below
  "mobile-search-quota": "mobile-search",
  "daily-set": "daily-set",
  "more-promotions": "more-promotions",
  "punchcard-child": "punchcards",
  punchcard: "punchcards", // the parent punch card pass (beta6)
  "v4-account": "account-run", // v4 (script < 5) adapter ids, see v4RunToEntries()
  "v4-bonus-search": "search",
  "v4-search-on-bing": "promotions",
  "v4-url-reward": "promotions",
  "v4-claim-reward": "bonus-claim",
  "v4-app-reward": "app-rewards",
  "browser-earn": "earn-page", // the /earn page pass (beta6)
  "read-to-earn": "read-to-earn",
  "daily-check-in": "daily-check-in",
  doClaimBonusPoints: "bonus-claim",
  "visual-search": "visual-search",
  doEnsureStreakProtection: "streak-protection",
  "edge-browsing": "edge-browsing",
  doActivateSearchPerk: "search-perk",
};

// Activities that carry no user-visible outcome of their own.
const HIDDEN_ACTIVITIES = new Set(["browser-search-api-report"]);

// ---------------------------------------------------------------------------
// Classification. The script already sorts every result into one of
// completed / incomplete / unavailable / notApplicable. We keep that and only
// split "incomplete" by reason code, because that bucket mixes "the script
// couldn't read the state" with "something needs attention".
// ---------------------------------------------------------------------------
const UNVERIFIED_REASONS = new Set([
  "quota-unavailable",
  "activation-data-unavailable",
  "offer-not-confirmed",
  "claim-not-confirmed",
  "claimable-bonus-unknown",
  "offer-progress-unchanged",
  "switch-unavailable",
  "desktop-token-unavailable",
]);
const ATTENTION_REASONS = new Set([
  "ambiguous-target",
  "activation-control-missing",
  "search-attempt-limit-reached",
]);
// Not a failure: the step simply isn't done yet. Excluded from the verdict.
const INFORMATIONAL_PENDING = new Set(["step-incomplete"]);

// ---------------------------------------------------------------------------
// Accounts the script did not (fully) run. The script "defers" an account by
// aborting it (core/AccountState.ts defer()); the run then records the account
// as status "skipped" (nothing ran) or "partial" (cut short) with the reason in
// `error`. The reasons below are the ones the script produces.
// ---------------------------------------------------------------------------
const DEFERRALS = [
  { kind: "bot-score", re: /bot-score warning/i, label: "high bot score" },
  { kind: "rate-limit", re: /service rate limit/i, label: "service rate limit" },
  { kind: "access-rejected", re: /service rejected account access/i, label: "access rejected" },
];

/** @returns {{kind:string,label:string,reason:string,cutShort:boolean}|null} */
function classifyDeferral(account) {
  const { status, error } = account || {};
  if (!error || (status !== "skipped" && status !== "partial")) return null;
  const hit = DEFERRALS.find((d) => d.re.test(error));
  if (hit) return { kind: hit.kind, label: hit.label, reason: String(error), cutShort: status === "partial" };
  // "skipped" only ever comes from a deferral, even one this list doesn't know.
  return status === "skipped"
    ? { kind: "skipped", label: "skipped", reason: String(error), cutShort: false }
    : null;
}

/** Runs from before v5 carry no per-activity completion data at all. */
function hasStructuredData(account) {
  if (account && account.schema === "v4") return true; // built from the v4 run summary
  const c = (account && account.completion) || {};
  return Boolean(c.counts) || DETAIL_LISTS.some((k) => (c[k] || []).length > 0);
}

// Promotions the script lists (and tries to complete) but that have no card on
// the account's Rewards page, so its click step fails with "ambiguous-target"
// ("multiple visible controls match... no control was clicked"). Seen on every
// account, every day since 10-22, and the script's author confirms the card is
// not there for them either. Matched by title so that the same error on any
// OTHER promo still counts as a real problem.
const NO_CARD_PROMOS = new Set(["claim your points from daily streaks"]);
const isNoCardPromo = (d) =>
  d.reason === "ambiguous-target" &&
  NO_CARD_PROMOS.has(String(d.title || "").trim().toLowerCase());

/**
 * @returns {{state:string, cause:string, informational?:boolean}}
 * state: done | pending | unverified | attention | unavailable | n/a
 */
function classifyDetail(d, ctx = {}) {
  // v4 only reports points per source; it never says whether an activity was
  // completed, so these are "reported", not "done".
  if (d.status === "reported") return { state: "reported", cause: "reported" };
  switch (d.category) {
    case "completed":
      return { state: "done", cause: "confirmed" };
    case "unavailable":
      return { state: "unavailable", cause: "not-offered" };
    case "notApplicable":
      return { state: "n/a", cause: "not-applicable" };
    default:
  }
  // category === "incomplete"
  if (
    d.activity === "visual-search" &&
    d.reason === "activation-control-missing" &&
    ctx.hasVisualSearchStreak === false
  ) {
    // Accounts that never receive a Visual Search streak always hit this.
    return { state: "unavailable", cause: "likely-not-offered" };
  }
  if (isNoCardPromo(d)) return { state: "unavailable", cause: "listed-without-card" };
  if (d.status === "failed") return { state: "attention", cause: "failed" };
  if (INFORMATIONAL_PENDING.has(d.reason))
    return { state: "pending", cause: d.reason, informational: true };
  if (ATTENTION_REASONS.has(d.reason))
    return { state: "attention", cause: d.reason };
  if (UNVERIFIED_REASONS.has(d.reason))
    return { state: "unverified", cause: d.reason };
  return { state: "unverified", cause: d.reason || "unknown-reason" };
}

// ---------------------------------------------------------------------------
// Rewards day. The day does NOT roll at local midnight: the script reports the
// next reset (08:00Z in the sample data). Preference order:
//   1. account.resetAt            (script >= beta6; resetAtSource "service" or
//                                  "estimated" local midnight)
//   2. streaks[].resetAt          (older records)
//   3. a fixed UTC hour           (runs with neither)
// The day is named after the UTC date of its midpoint (reset - 12h), which is
// the calendar date the reset window belongs to for any timezone within
// roughly +/-12h of UTC.
// ---------------------------------------------------------------------------
const DEFAULT_RESET_HOUR_UTC = 8;
const HOUR = 3600 * 1000;

const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * The Rewards day a timestamp falls in, for a daily reset at resetHourUtc:Z.
 * Named after the UTC date of the window's midpoint, the same rule
 * rewardsDayKey() applies to a known reset time.
 */
function rewardsDayOf(ts, resetHourUtc = DEFAULT_RESET_HOUR_UTC) {
  const d = new Date(ts);
  const boundary = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), resetHourUtc);
  const start = ts >= boundary ? boundary : boundary - 24 * HOUR;
  return isoDate(start + 12 * HOUR);
}

function rewardsDayKey(entry, resetHourUtc = DEFAULT_RESET_HOUR_UTC) {
  const own = Date.parse(entry.account.resetAt);
  const resetAt = Number.isFinite(own)
    ? own
    : (entry.account.streaks || []).map((s) => Date.parse(s.resetAt)).find(Number.isFinite);
  if (resetAt) return isoDate(resetAt - 12 * HOUR);
  const ts = Date.parse(entry.endedAt || entry.startedAt);
  return rewardsDayOf(ts, resetHourUtc);
}

// ---------------------------------------------------------------------------
// Punch cards. Today the script only reports a card's overall progress in a
// log line (see parser.js), but a structured field has been requested. This
// adapter reads that field if it appears, so the dashboard switches over by
// itself. The key and field names below are a GUESS at what the script will
// use: once the real shape is known, this is the only function to adjust.
// ---------------------------------------------------------------------------
const PUNCHCARD_KEYS = ["punchCards", "punchcards", "punchCardProgress"];

function normalizePunchcards(raw) {
  if (!Array.isArray(raw)) return [];
  const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  return raw
    .map((c) => {
      if (!c || typeof c !== "object") return null;
      const pick = (...keys) => keys.map((k) => c[k]).find((v) => v != null);
      let done = num(pick("completedSteps", "done", "completed"));
      let total = num(pick("totalSteps", "total", "steps", "max"));
      const progress = pick("progress"); // number, or "6/8"
      if (typeof progress === "string") {
        const m = /^(\d+)\s*\/\s*(\d+)$/.exec(progress.trim());
        if (m) [done, total] = [Number(m[1]), Number(m[2])];
      } else if (done == null) done = num(progress);
      if (done == null || total == null || total <= 0) return null;
      return {
        offerId: String(pick("offerId", "id") ?? ""),
        title: pick("title", "name") ?? null,
        done,
        total,
        locked: num(pick("lockedSteps", "locked", "lockedOrDisabled")),
        points: num(pick("pointsGained", "points", "earnedPoints")),
        pointsAvailable: num(pick("pointsAvailable", "maxPoints", "pointsTotal", "rewardPoints")),
        source: "script",
      };
    })
    .filter(Boolean);
}

/** Structured punch cards from the newest entry that has any. */
function structuredPunchcards(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    for (const k of PUNCHCARD_KEYS) {
      const cards = normalizePunchcards(entries[i].account[k]);
      if (cards.length) return cards;
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Run record normalisation
// ---------------------------------------------------------------------------
const normEmail = (e) => (typeof e === "string" ? e.trim().toLowerCase() : "");

/** One flat entry per (run, account), whichever record shape came in. */
function normalizeRun(record) {
  const accounts =
    (record && (record.accounts || (record.run && record.run.accounts))) || [];
  return accounts
    .filter((a) => a && a.email)
    .map((a) => {
      const live = a.live || {};
      return {
        runId: record.runId || (record.run && record.run.runId) || null,
        startedAt: record.startedAt,
        endedAt: record.endedAt || record.startedAt,
        email: normEmail(a.email),
        account: {
          ...a,
          bySource: a.bySource || live.bySource || {},
          unattributed: a.unattributed ?? live.unattributed ?? 0,
          collected: a.collected ?? a.collectedPoints ?? 0,
          currentBalance: a.currentBalance ?? a.finalPoints ?? null,
          completion: a.completion || {},
          streaks: a.streaks || [],
        },
      };
    });
}

/** Merge GET /status run extras (earnable, searchSummary, ...) into entries. */
function attachExtras(entries, statusRunAccounts) {
  const byEmail = new Map(
    (statusRunAccounts || []).map((a) => [normEmail(a.email), a]),
  );
  for (const e of entries) {
    const x = byEmail.get(e.email);
    if (!x) continue;
    for (const k of ["earnable", "searchSummary", "browserPhases", "appQuotaState"])
      if (x[k] !== undefined) e.account[k] = x[k];
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Day merge
// ---------------------------------------------------------------------------
const DETAIL_LISTS = ["completed", "incomplete", "unavailable", "notApplicable"];

const itemKey = (d) =>
  d.offerId ? `offer:${d.offerId}` : `${d.activity}:${d.platform || "-"}`;

function detailsOf(completion) {
  return DETAIL_LISTS.flatMap((cat) =>
    (completion[cat] || []).map((d) => ({ ...d, category: cat })),
  );
}

/**
 * Rough points for an activity whose credit the script could not verify
 * (pointsKnown === false), from the account balance observed before and after
 * it (script >= beta6). The script itself warns this difference "is not
 * verified activity credit", so it is only ever shown as an estimate and is
 * never added to any total.
 */
function estimateFromBalance(d) {
  if (d.pointsKnown) return 0;
  const { balanceBefore: before, balanceAfter: after } = d;
  if (!Number.isFinite(before) || !Number.isFinite(after)) return 0;
  return Math.max(0, after - before);
}

function mergeItems(entries) {
  const items = new Map();
  for (const e of entries) {
    const ctx = {
      hasVisualSearchStreak: e.account.streaks.some(
        (s) => s.partner === "visualsearch",
      ),
    };
    for (const d of detailsOf(e.account.completion)) {
      const c = classifyDetail(d, ctx);
      const pts = d.pointsGained || 0;
      const prev = items.get(itemKey(d));
      if (!prev) {
        items.set(itemKey(d), {
          key: itemKey(d),
          activity: d.activity,
          label: d.label || d.activity,
          title: d.title || null,
          offerId: d.offerId || null,
          platform: d.platform || null,
          state: c.state,
          cause: c.cause,
          informational: Boolean(c.informational),
          reason: d.reason || null,
          message: d.message || null,
          points: pts,
          pointsKnown: Boolean(d.pointsKnown),
          estimatedPoints: estimateFromBalance(d),
          runs: 1,
          lastRunId: e.runId,
        });
        continue;
      }
      prev.runs += 1;
      prev.points += pts; // each run reports only what it earned itself
      prev.estimatedPoints += estimateFromBalance(d);
      prev.pointsKnown = prev.pointsKnown || Boolean(d.pointsKnown);
      prev.lastRunId = e.runId;
      if (d.title && !prev.title) prev.title = d.title;
      // A completed item is never downgraded by a later "already done / not
      // confirmed" report (e.g. check-in: offer-progress-unchanged).
      if (prev.state !== "done") {
        Object.assign(prev, {
          state: c.state,
          cause: c.cause,
          informational: Boolean(c.informational),
          reason: d.reason || null,
          message: d.message || null,
        });
      } else if (pts > 0 && c.state === "done") {
        prev.reason = d.reason || prev.reason; // keep the run that earned
        prev.message = d.message || prev.message;
      }
    }
  }
  return [...items.values()];
}

const SEVERITY = ["attention", "pending", "unverified"];

function groupItems(items) {
  const groups = new Map();
  const unmapped = new Set();
  for (const it of items) {
    if (HIDDEN_ACTIVITIES.has(it.activity)) continue;
    let gid = ACTIVITY_GROUP[it.activity];
    if (!gid) {
      gid = "other";
      unmapped.add(it.activity);
    }
    if (!groups.has(gid))
      groups.set(gid, {
        id: gid,
        label: GROUPS[gid].label,
        order: GROUPS[gid].order,
        items: [],
      });
    groups.get(gid).items.push(it);
  }

  for (const g of groups.values()) {
    const counts = { done: 0, reported: 0, pending: 0, unverified: 0, attention: 0, unavailable: 0, "n/a": 0 };
    for (const it of g.items) counts[it.state] += 1;
    g.counts = counts;
    g.points = g.items.reduce((s, it) => s + it.points, 0);
    g.estimatedPoints = g.items.reduce((s, it) => s + (it.pointsKnown ? 0 : it.estimatedPoints), 0);
    // False when a completed item never reported its points (e.g. punchcard
    // steps), so the UI can show "?" instead of a misleading 0.
    g.pointsKnown = !g.items.some((it) => it.state === "done" && !it.pointsKnown);
    const active = g.items.filter((it) => it.state !== "unavailable" && it.state !== "n/a");
    if (!active.length) {
      g.state = counts.unavailable ? "unavailable" : "n/a";
    } else if (active.every((it) => it.state === "done")) {
      g.state = "done";
    } else if (active.every((it) => it.state === "reported")) {
      g.state = "reported";
    } else if (active.some((it) => it.state === "done" || it.state === "reported")) {
      g.state = "partial";
    } else {
      g.state = SEVERITY.find((s) => counts[s]) || "unverified";
    }
    g.actionable = g.items.some(
      (it) => (it.state === "attention" || it.state === "pending") && !it.informational,
    );
  }
  return { groups: [...groups.values()].sort((a, b) => a.order - b.order), unmapped: [...unmapped] };
}

function dayVerdict(groups) {
  let attention = 0, pending = 0, unverified = 0;
  for (const g of groups)
    for (const it of g.items) {
      if (it.state === "attention") attention++;
      else if (it.state === "pending" && !it.informational) pending++;
      else if (it.state === "unverified") unverified++;
    }
  const state = attention ? "attention" : pending ? "pending" : unverified ? "complete-unverified" : "complete";
  return { state, attention, pending, unverified };
}

function latestStreaks(entries) {
  const byPartner = new Map();
  for (const e of entries)
    for (const s of e.account.streaks) {
      const prev = byPartner.get(s.partner);
      if (!prev || Date.parse(s.updatedAt || 0) >= Date.parse(prev.updatedAt || 0))
        byPartner.set(s.partner, s);
    }
  return [...byPartner.values()];
}

function buildAccountDay(email, day, entries) {
  entries = [...entries].sort((a, b) => Date.parse(a.endedAt) - Date.parse(b.endedAt));
  const items = mergeItems(entries);
  const { groups, unmapped } = groupItems(items);

  const gained = entries.reduce((s, e) => s + (e.account.collected || 0), 0);
  const unattributed = entries.reduce((s, e) => s + (e.account.unattributed || 0), 0);
  const attributed = groups.reduce((s, g) => s + g.points, 0);
  const first = entries[0].account;
  const last = entries[entries.length - 1].account;
  const deferral = classifyDeferral(last);
  const verdict = dayVerdict(groups);
  // Nothing ran and the script says why: that is not a "complete" day.
  if (!groups.length && deferral) verdict.state = "not-run";
  const schema = last.schema === "v4" ? "v4" : "v5";
  // v4 cannot say whether activities were completed, so never claim "complete".
  if (schema === "v4" && (verdict.state === "complete" || verdict.state === "complete-unverified")) verdict.state = "basic";
  const withSearch = entries.filter((e) => e.account.searchSummary);
  const withEarnable = entries.filter((e) => e.account.earnable);

  return {
    email,
    day,
    runs: entries.map((e) => e.runId),
    schema,
    groups,
    unmapped,
    verdict,
    // Why the LATEST run of this day did not (fully) run the account, if so.
    deferral,
    lastEndedAt: entries[entries.length - 1].endedAt || null,
    resetAt: last.resetAt || null,
    resetAtSource: last.resetAtSource || null,
    // Structured (script-provided) cards; the store adds log-derived ones when
    // the script provides none.
    punchcards: structuredPunchcards(entries),
    points: {
      gained,
      attributed,
      unattributed,
      // How much of the unattributed total balance bracketing links to
      // specific activities. Informational only; never part of a total.
      estimatedUnattributed: Math.min(
        Math.max(0, unattributed),
        groups.reduce((s, g) => s + g.estimatedPoints, 0),
      ),
      // gained should equal attributed + unattributed; false means the script
      // reported a total our per-item points don't explain.
      reconciled: gained === attributed + unattributed,
      balanceStart: first.initialPoints ?? null,
      balanceEnd: last.currentBalance,
    },
    searchSummary: withSearch.length
      ? ["mobile", "desktop", "bonus", "apiReport"].reduce((o, k) => {
          o[k] = withSearch.reduce((s, e) => s + (e.account.searchSummary[k] || 0), 0);
          return o;
        }, {})
      : null,
    earnable: withEarnable.length
      ? withEarnable[withEarnable.length - 1].account.earnable
      : null,
    streaks: latestStreaks(entries),
    streakProtection: last.streakProtection || null,
    level: last.level ?? null,
    pointsProgress: last.pointsProgress ?? null,
    pointsRemaining: last.pointsRemaining ?? null,
  };
}

/**
 * The API-size view of a day: everything the UI renders, minus bookkeeping it
 * never reads (ids, keys, raw reason codes, per-item run counts). Roughly half
 * the bytes of the full object; the stored snapshots are unaffected.
 */
function compactDay(day) {
  const { runs, groups, ...rest } = day;
  return {
    ...rest,
    runCount: runs.length,
    groups: groups.map(({ items, actionable, ...g }) => ({
      ...g,
      items: items.map((it) => {
        const out = {
          title: it.title || undefined,
          label: it.label,
          platform: it.platform || undefined,
          state: it.state,
          cause: it.cause,
          points: it.points,
          pointsKnown: it.pointsKnown,
        };
        if (!it.title && !it.label) out.activity = it.activity;
        if (it.estimatedPoints) out.estimatedPoints = it.estimatedPoints;
        // The cause already says it for confirmed items; keep the script's
        // wording only where the UI may need it as a fallback.
        if (it.message && (it.state !== "done" || it.activity === "edge-browsing")) out.message = it.message;
        return out;
      }),
    })),
  };
}


// ---------------------------------------------------------------------------
// v4 (script < 5). The v4 Control API only parses log text into per-source
// point totals (scripts/api/logParser.js), so a v4 "day" is a basic view: points
// per source, the search split, points available at the start of the run, streak
// protection and Edge browsing. Daily Set and More Promos both arrive as
// "urlReward" and cannot be separated here. v4RunToEntries() converts a run
// summary into the same entries the v5 path produces, so the rest of the
// pipeline (grouping, reconciliation, UI) is shared.
// ---------------------------------------------------------------------------
const V4_SOURCES = {
  search: { activity: "search", label: "Search" },
  bonus: { activity: "v4-bonus-search", label: "Bonus search" },
  searchOnBing: { activity: "v4-search-on-bing", label: "Search on Bing" },
  urlReward: { activity: "v4-url-reward", label: "Promotions" },
  read: { activity: "read-to-earn", label: "Read to Earn" },
  checkIn: { activity: "daily-check-in", label: "Daily check-in" },
  claimBonus: { activity: "doClaimBonusPoints", label: "Bonus claim" },
  claimReward: { activity: "v4-claim-reward", label: "Reward claim" },
  visualSearch: { activity: "visual-search", label: "Visual search" },
  appReward: { activity: "v4-app-reward", label: "App reward" },
  punchcard: { activity: "punchcard-child", label: "Punch card" },
};

const V4_SKIP_REASONS = { Fraud_UserWarning_BotScore_UX: "Microsoft bot-score warning detected" };
const v4SkipError = (reason) => V4_SKIP_REASONS[reason] || `Skipped: ${reason}`;

/** v4's Edge browsing progress, expressed as one completion item. */
function v4EdgeItem(edge) {
  const progress = edge.reportsTotal != null ? `${edge.reportsCompleted ?? 0}/${edge.reportsTotal} reports` : "";
  const base = { activity: "edge-browsing", label: "Edge browsing", pointsGained: 0, pointsKnown: false, message: progress };
  switch (edge.status) {
    case "complete": return { ...base, category: "completed", status: "confirmed", reason: "offer-complete" };
    case "skipped": return { ...base, category: "unavailable", status: "skipped", reason: "offer-unavailable" };
    case "failed":
    case "cancelled": return { ...base, category: "incomplete", status: "failed", reason: "activity-error" };
    case "partial": return { ...base, category: "incomplete", status: "unconfirmed", reason: "offer-not-complete" };
    default: return { ...base, category: "incomplete", status: "unconfirmed", reason: "offer-not-confirmed" };
  }
}

/**
 * @param {{run:object, endedAt:string, runId:string, skips?:Map<string,{reason:string}>}} input
 *   run = the Control API's run summary (/status .run), endedAt = lastExit.at
 * @returns entries shaped like normalizeRun()'s, with account.schema === "v4"
 */
function v4RunToEntries({ run, endedAt, runId, skips }) {
  return ((run && run.accounts) || [])
    .filter((a) => a && a.email)
    .map((a) => {
      const email = normEmail(a.email);
      const by = (a.live && a.live.bySource) || {};
      const completed = [];
      let attributed = 0;
      for (const [src, pts] of Object.entries(by)) {
        if (!(pts > 0)) continue;
        const known = V4_SOURCES[src] || { activity: `v4-${src}`, label: src };
        completed.push({ ...known, category: "completed", status: "reported", reason: "reported", pointsGained: pts, pointsKnown: true });
        attributed += pts;
      }
      const collected = typeof a.collectedPoints === "number" ? a.collectedPoints : (a.live && a.live.gained) || 0;
      const incomplete = [], unavailable = [];

      let status = a.success === true ? "completed" : a.success === false ? "failed" : "unknown";
      let error = a.error || null;
      const skip = skips && skips.get(email);
      if (skip) {
        status = "skipped";
        error = v4SkipError(skip.reason);
      } else if (status === "failed" && error) {
        incomplete.push({ activity: "v4-account", label: "Account run", category: "incomplete", status: "failed", reason: "activity-error", message: error, pointsGained: 0, pointsKnown: false });
      }
      if (a.edgeBrowsing) {
        const item = v4EdgeItem(a.edgeBrowsing);
        (item.category === "completed" ? completed : item.category === "unavailable" ? unavailable : incomplete).push(item);
      }
      return {
        runId,
        startedAt: endedAt,
        endedAt,
        email,
        account: {
          schema: "v4",
          email,
          status,
          success: a.success ?? null,
          error,
          durationSeconds: a.durationSeconds ?? null,
          initialPoints: a.initialPoints ?? null,
          currentBalance: a.finalPoints ?? (a.live && a.live.balance) ?? null,
          collected,
          bySource: by,
          unattributed: collected - attributed,
          earnable: a.earnable ?? undefined,
          searchSummary: a.searchSummary ?? undefined,
          streakProtection: a.streakProtection ?? null,
          edgeBrowsing: a.edgeBrowsing ?? null,
          streaks: [],
          completion: {
            counts: { completed: completed.length, incomplete: incomplete.length, unavailable: unavailable.length, notApplicable: 0 },
            completed,
            incomplete,
            unavailable,
            notApplicable: [],
          },
        },
      };
    });
}

/** Major version of the script ("4.3.2" -> 4), or null when unknown. */
function scriptMajorOf(status) {
  const n = parseInt(String((status && status.version) || "").split(".")[0], 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {object[]} records  GET /history runs (or run-history.json entries)
 * @returns {Map<string, Map<string, object>>}  email -> day -> accountDay
 */
function buildDays(records, opts = {}) {
  return buildDaysFromEntries(records.flatMap(normalizeRun), opts);
}

/** Same as buildDays, but takes already-normalised (run, account) entries. */
function buildDaysFromEntries(entries, { resetHourUtc = DEFAULT_RESET_HOUR_UTC } = {}) {
  const grouped = new Map();
  for (const entry of entries) {
    const day = rewardsDayKey(entry, resetHourUtc);
    const k = `${entry.email}|${day}`;
    if (!grouped.has(k)) grouped.set(k, { email: entry.email, day, entries: [] });
    grouped.get(k).entries.push(entry);
  }
  const out = new Map();
  for (const { email, day, entries } of grouped.values()) {
    if (!out.has(email)) out.set(email, new Map());
    out.get(email).set(day, buildAccountDay(email, day, entries));
  }
  return out;
}

module.exports = {
  GROUPS,
  ACTIVITY_GROUP,
  classifyDetail,
  rewardsDayKey,
  normalizeRun,
  attachExtras,
  mergeItems,
  buildAccountDay,
  buildDays,
  buildDaysFromEntries,
  compactDay,
  NO_CARD_PROMOS,
  classifyDeferral,
  hasStructuredData,
  v4RunToEntries,
  v4SkipError,
  scriptMajorOf,
  rewardsDayOf,
  normalizePunchcards,
  PUNCHCARD_KEYS,
};
