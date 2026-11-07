import * as U from "../util.js";

/**
 * Renders one account's activity accounting for one Rewards day:
 *   - a points table (one row per activity group, expandable to its items)
 *   - a reconciliation footer (collected vs attributed vs unattributed)
 *   - a streak board and streak/level facts
 *
 * Input comes from GET /api/activity-days (see lib/activityModel.js). Every
 * function here is pure: state (selected day, expanded rows) is owned by the
 * caller and passed in.
 */

const STATES = {
  done: { label: "Done", icon: "ph-check-circle", cls: "done" },
  // v4 reports points per source but never says an activity was completed.
  reported: { label: "Reported", icon: "ph-receipt", cls: "reported" },
  partial: { label: "Partial", icon: "ph-circle-half", cls: "partial" },
  unverified: { label: "Unverified", icon: "ph-question", cls: "unverified" },
  unavailable: { label: "Not offered", icon: "ph-prohibit", cls: "unavailable" },
  attention: { label: "Attention", icon: "ph-warning-circle", cls: "attention" },
  pending: { label: "Pending", icon: "ph-clock", cls: "pending" },
  "n/a": { label: "N/A", icon: "ph-minus-circle", cls: "na" },
};

// Plain-language text for the cause codes produced by classifyDetail() and the
// script's own reason codes. Unknown codes fall back to the script's message.
const CAUSE_TEXT = {
  confirmed: "Confirmed",
  "not-offered": "Not offered on this account",
  "likely-not-offered": "Probably not offered (no streak for this account)",
  "listed-without-card": "Listed by Microsoft, but there is no card for it on the page",
  "not-applicable": "Not applicable",
  "quota-unavailable": "Quota couldn\u2019t be read",
  "activation-data-unavailable": "Offer data couldn\u2019t be read",
  "offer-not-confirmed": "Completion not confirmed",
  "claim-not-confirmed": "Claim not confirmed",
  "claimable-bonus-unknown": "Claimable bonus unknown",
  "offer-progress-unchanged": "No progress detected",
  "switch-unavailable": "Couldn\u2019t confirm",
  "desktop-token-unavailable": "Couldn\u2019t confirm",
  "ambiguous-target": "Script couldn\u2019t pick the right button",
  "activation-control-missing": "Control not found on the page",
  "search-attempt-limit-reached": "Search attempt limit reached",
  "earn-pass-incomplete": "Earn page pass didn\u2019t finish",
  "step-incomplete": "Step not completed yet",
  failed: "Failed",
};

const humanize = (code) =>
  String(code || "")
    .replace(/[-_]+/g, " ")
    .replace(/^./, (c) => c.toUpperCase());

const shorten = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}\u2026` : text);

// A failure's own error text is the useful part ("net::ERR_HTTP2_PROTOCOL_ERROR"),
// so show it instead of a bare "Failed".
const causeText = (item) =>
  item.cause === "failed" && item.message
    ? `Failed: ${shorten(item.message, 140)}`
    : CAUSE_TEXT[item.cause] || item.message || humanize(item.cause || item.reason);

export function stateChip(state, labelOverride, iconOverride) {
  const s = STATES[state] || STATES["n/a"];
  return `<span class="act-state act-state--${s.cls}"><i class="ph ${iconOverride || s.icon}" aria-hidden="true"></i>${U.escapeHtml(labelOverride || s.label)}</span>`;
}

const ESTIMATE_HINT =
  "Estimated from the balance change around this activity. Not verified by the script and not counted in any total.";

function pointsCell(points, known, estimated = 0) {
  if (points > 0)
    return `<span class="act-pts">${U.fmtSigned(points)}${known ? "" : `<sup class="act-pts-unknown" title="${U.escapeAttr(estimated > 0 ? `Some points were not reported (about ${estimated} more estimated from balance changes)` : "Some points in this group were not reported by the script")}">?</sup>`}</span>`;
  if (!known && estimated > 0)
    return `<span class="act-pts act-pts--est" title="${U.escapeAttr(ESTIMATE_HINT)}">~${U.fmtSigned(estimated)}</span>`;
  if (!known)
    return '<span class="act-pts act-pts--unknown" title="The script did not report points for this activity">?</span>';
  return '<span class="act-pts act-pts--zero">\u2013</span>';
}

/** "Oct week 4: 6/8 · 2 locked (as of Oct 28)" for each known punch card. */
export function punchcardText(cards) {
  return (cards || [])
    .map((c) => {
      const bits = [`${c.done}/${c.total}`];
      if (c.done >= c.total) bits[0] += " complete";
      if (c.locked) bits.push(`${c.locked} locked`);
      if (c.points != null)
        bits.push(`${U.fmtSigned(c.points)}${c.pointsAvailable != null ? ` of ${U.fmtNumber(c.pointsAvailable)}` : ""} pts`);
      let text = `${c.title ? `${c.title}: ` : ""}${bits.join(" \u00b7 ")}`;
      if (c.asOf) text += ` (as of ${U.localDateLabel(c.asOf, { month: "short", day: "numeric" })})`;
      return text;
    })
    .join("; ");
}

function groupDetail(g, day) {
  const parts = [];
  if (g.id === "promotions" && day.schema === "v4") parts.push("Daily Set and More Promos are reported together");
  let sameCause = false;
  const active = g.items.length - g.counts.unavailable - g.counts["n/a"];

  if (g.id === "punchcards" && day.punchcards && day.punchcards.length) {
    parts.push(punchcardText(day.punchcards));
  }
  if (g.id === "search" && day.searchSummary) {
    const s = day.searchSummary;
    parts.push(`PC ${U.fmtNumber(s.desktop)} \u00b7 Mobile ${U.fmtNumber(s.mobile)}${s.bonus ? ` \u00b7 Bonus ${U.fmtNumber(s.bonus)}` : ""}`);
  } else if (g.items.length > 1 && active > 0) {
    // Desktop and mobile flows often report the same problem twice; say it once.
    const live = g.items.filter((it) => it.state !== "unavailable" && it.state !== "n/a");
    sameCause = !g.counts.done && live.every((it) => it.cause === live[0].cause);
    parts.push(sameCause ? causeText(live[0]) : `${g.counts.done} of ${active} done`);
  } else if (g.id === "edge-browsing" && day.schema === "v4" && g.items.length === 1 && g.items[0].message) {
    parts.push(g.items[0].message); // e.g. "6/6 reports"
  } else if (g.items.length === 1 && g.state !== "done" && g.state !== "reported") {
    parts.push(causeText(g.items[0]));
  }
  if (g.items.length > 1 && !sameCause) {
    if (g.counts.attention) parts.push(`${g.counts.attention} need${g.counts.attention === 1 ? "s" : ""} attention`);
    if (g.counts.unverified) parts.push(`${g.counts.unverified} unverified`);
  }
  if (!g.pointsKnown && g.counts.done && !(g.id === "edge-browsing" && day.schema === "v4"))
    parts.push(
      g.estimatedPoints > 0
        ? `~${U.fmtNumber(g.estimatedPoints)} pts estimated from balance`
        : "points not reported",
    );
  return parts.join(" \u00b7 ");
}

// In narrow cards the Detail column is hidden (CSS) and this line shows under the name instead.
const inlineDetail = (text) =>
  text ? `<span class="act-detail-inline">${U.escapeHtml(text)}</span>` : "";

function itemRows(g, keyBase, hidden) {
  return g.items
    .map((it) => {
      const name = it.title || it.label || it.activity;
      const detail = [it.platform ? humanize(it.platform) : "", causeText(it)]
        .filter(Boolean)
        .join(" \u00b7 ");
      return `<tr class="act-item-row" data-act-items="${U.escapeAttr(keyBase)}" ${hidden ? "hidden" : ""}>
        <td class="act-name"><span class="act-item-name">${U.escapeHtml(name)}</span>${inlineDetail(detail)}</td>
        <td>${stateChip(it.state)}</td>
        <td class="act-num">${pointsCell(it.points, it.pointsKnown || it.state !== "done", it.pointsKnown ? 0 : it.estimatedPoints)}</td>
        <td class="act-detail">${U.escapeHtml(detail)}</td>
      </tr>`;
    })
    .join("");
}

function groupRow(g, day, email, expanded) {
  const key = `${email}|${day.day}|${g.id}`;
  const open = expanded.has(key);
  const detail = groupDetail(g, day);
  const count = g.items.length > 1 ? `<span class="act-count">${g.items.length}</span>` : "";
  return `<tr class="act-row act-row--${(STATES[g.state] || STATES["n/a"]).cls}">
      <td class="act-name"><button type="button" class="act-toggle" data-act-toggle="${U.escapeAttr(key)}" aria-expanded="${open}" title="${open ? "Hide" : "Show"} items"><i class="ph ph-caret-right" aria-hidden="true"></i><span>${U.escapeHtml(g.label)}</span>${count}</button>${inlineDetail(detail)}</td>
      <td>${stateChip(g.state)}</td>
      <td class="act-num">${pointsCell(g.points, g.pointsKnown, g.estimatedPoints)}</td>
      <td class="act-detail">${U.escapeHtml(detail)}</td>
    </tr>${itemRows(g, key, !open)}`;
}

const QUIET_STATES = new Set(["unavailable", "n/a"]);

/** What a v4 day cannot show, tagged the way the config view tags v5-only options. */
function v5OnlyRow() {
  return `<tr class="act-row act-row--quiet">
      <td colspan="4"><span class="cfg-version-tag">v5 only</span>
        <span class="act-quiet-list">Daily Set / More Promos split \u00b7 per-activity status \u00b7 mobile search quota \u00b7 search perk \u00b7 balance estimates</span></td>
    </tr>`;
}

function quietRow(groups) {
  if (!groups.length) return "";
  return `<tr class="act-row act-row--quiet">
      <td colspan="4"><span class="act-state act-state--unavailable">Not offered / N/A</span>
        <span class="act-quiet-list">${U.escapeHtml(groups.map((g) => g.label).join(" \u00b7 "))}</span></td>
    </tr>`;
}

function syntheticRows(day) {
  const rows = [];
  if (day.punchcards && day.punchcards.length && !day.groups.some((g) => g.id === "punchcards")) {
    const complete = day.punchcards.every((c) => c.done >= c.total);
    const text = punchcardText(day.punchcards);
    const pts = day.punchcards.reduce((s, c) => s + (c.points || 0), 0);
    rows.push(`<tr class="act-row act-row--${complete ? "done" : "pending"}">
      <td class="act-name"><span class="act-static">Punch Cards</span>${inlineDetail(text)}</td>
      <td>${stateChip(complete ? "done" : "pending", complete ? "Complete" : "In progress")}</td>
      <td class="act-num">${pts > 0 ? pointsCell(pts, true) : '<span class="act-pts act-pts--zero">\u2013</span>'}</td>
      <td class="act-detail">${U.escapeHtml(text)}</td>
    </tr>`);
  }
  if (day.schema === "v4" && day.earnable) {
    const e = day.earnable;
    const bits = [["PC searches", e.browser], ["Mobile searches", e.mobile], ["App", e.app]]
      .filter(([, v]) => Number.isFinite(v))
      .map(([k, v]) => `${k} ${U.fmtNumber(v)}`);
    if (bits.length) {
      const text = bits.join(" \u00b7 ");
      rows.push(`<tr class="act-row">
      <td class="act-name"><span class="act-static">Available at start of run</span>${inlineDetail(text)}</td>
      <td><span class="act-state act-state--na">\u2014</span></td>
      <td class="act-num"><span class="act-pts act-pts--zero">\u2013</span></td>
      <td class="act-detail">${U.escapeHtml(text)}</td>
    </tr>`);
    }
  }
  const app = day.schema === "v4" ? 0 : Number(day.earnable && day.earnable.app);
  if (app > 0) {
    rows.push(`<tr class="act-row act-row--pending">
      <td class="act-name"><span class="act-static">App Promotions</span>${inlineDetail(`${U.fmtNumber(app)} pts available in the mobile app`)}</td>
      <td>${stateChip("pending", "Not collected")}</td>
      <td class="act-num"><span class="act-pts act-pts--zero">\u2013</span></td>
      <td class="act-detail">${U.fmtNumber(app)} pts available in the mobile app</td>
    </tr>`);
  }
  if (day.points.unattributed) {
    const est = day.points.estimatedUnattributed || 0;
    const why = `Gained, but the script did not tie these to an activity${est > 0 ? `; about ${U.fmtNumber(est)} lines up with the unreported activities above (balance change)` : " (for example punch card steps)"}`;
    rows.push(`<tr class="act-row act-row--unattributed">
      <td class="act-name"><span class="act-static">Unattributed</span>${inlineDetail(why)}</td>
      <td><span class="act-state act-state--na">\u2014</span></td>
      <td class="act-num"><span class="act-pts">${U.fmtSigned(day.points.unattributed)}</span></td>
      <td class="act-detail">${U.escapeHtml(why)}</td>
    </tr>`);
  }
  return rows.join("");
}

function totals(day) {
  const p = day.points;
  const delta =
    p.balanceStart != null && p.balanceEnd != null ? p.balanceEnd - p.balanceStart : null;
  const diff = p.gained - p.attributed - p.unattributed;
  const cell = (label, value, cls = "") =>
    `<div class="act-total ${cls}"><dt>${label}</dt><dd>${value}</dd></div>`;
  return `<dl class="act-totals">
      ${cell("Bot collected", U.fmtSigned(p.gained))}
      ${cell("Attributed", U.fmtSigned(p.attributed))}
      ${cell("Unattributed", U.fmtSigned(p.unattributed))}
      ${cell("Balance", p.balanceEnd != null ? `${U.fmtNumber(p.balanceEnd)}${delta != null ? ` <span class="act-total-sub">(${U.fmtSigned(delta)})</span>` : ""}` : "\u2013")}
    </dl>${p.reconciled ? "" : `<p class="act-warn"><i class="ph ph-warning" aria-hidden="true"></i> Collected differs from attributed + unattributed by ${U.fmtSigned(diff)}.</p>`}`;
}

function streakBoard(day, now, isLatest) {
  if (day.schema === "v4")
    return '<p class="act-empty">Streak board <span class="cfg-version-tag">v5 only</span></p>';
  if (!day.streaks.length)
    return '<p class="act-empty">No streak data was captured for this day.</p>';
  const own = Date.parse(day.resetAt);
  const resetAt = Number.isFinite(own)
    ? own
    : day.streaks.map((s) => Date.parse(s.resetAt)).find(Number.isFinite);
  const resetLine =
    isLatest && resetAt && resetAt > now
      ? `<p class="act-reset">Resets in ${U.fmtDuration((resetAt - now) / 1000)}${day.resetAtSource === "estimated" ? " (estimated)" : ""}</p>`
      : "";
  return `<div class="act-streaks">${day.streaks
    .map((s) => {
      const total = s.totalDays || 7;
      const dots = Array.from({ length: total }, (_, i) => {
        const n = i + 1;
        const done = n <= s.completedDays;
        const today = done && n === s.completedDays && s.completedToday;
        // Today's step, not yet completed. The script's currentDay is a 0-based
        // index (it equals completedDays - 1 once today's step is done).
        const next =
          !done && !s.completedToday && s.isEnabled !== false &&
          Number.isInteger(s.currentDay) && n === s.currentDay + 1;
        const reward = Array.isArray(s.dailyPoints) ? s.dailyPoints[i] : null;
        return `<li class="act-dot${done ? " act-dot--done" : ""}${today ? " act-dot--today" : ""}${next ? " act-dot--next" : ""}" title="Day ${n}${reward != null ? ` \u00b7 ${reward} pts` : ""}${next ? " \u00b7 today\u2019s step" : ""}">${reward != null ? U.escapeHtml(String(reward)) : ""}</li>`;
      }).join("");
      return `<div class="act-streak">
        <div class="act-streak-head"><span>${U.escapeHtml(String(s.label || s.partner).replace(/ Streak$/, ""))}</span><span class="act-streak-count">${s.isEnabled === false ? "Not active" : `${s.completedDays}/${total}`}</span></div>
        <ol class="act-dots" aria-label="${U.escapeAttr(`${s.label}: day ${s.completedDays} of ${total}`)}">${dots}</ol>
      </div>`;
    })
    .join("")}</div>${resetLine}`;
}

function facts(day) {
  const p = day.streakProtection;
  const items = [];
  if (p && p.streakCounter != null)
    items.push(["Daily streak", `${U.fmtNumber(p.streakCounter)} day${p.streakCounter === 1 ? "" : "s"}`]);
  if (p)
    items.push([
      "Streak protection",
      p.enabled ? `On \u00b7 ${p.remainingDays ?? "?"} day${p.remainingDays === 1 ? "" : "s"} left` : "Off",
    ]);
  if (p && p.updatedAt) items.push(["Protection checked", U.fmtRelative(p.updatedAt)]);
  if (day.level != null) items.push(["Level", `Level ${day.level}`]);
  if (!items.length) return "";
  return `<dl class="act-facts">${items
    .map(([k, v]) => `<div><dt>${U.escapeHtml(k)}</dt><dd>${U.escapeHtml(v)}</dd></div>`)
    .join("")}</dl>`;
}

export function verdictText(day) {
  const v = day.verdict;
  switch (v.state) {
    case "complete": return "Complete";
    case "complete-unverified": return `Complete \u00b7 ${v.unverified} unverifiable`;
    case "attention": return `Needs attention \u00b7 ${v.attention}`;
    case "pending": return `${v.pending} pending`;
    case "not-run": return `Not run \u00b7 ${day.deferral ? day.deferral.label : "skipped"}`;
    case "basic": return "Basic view \u00b7 v4";
    default: return "";
  }
}

const VERDICT_CLASS = {
  complete: "done",
  "complete-unverified": "unverified",
  attention: "attention",
  pending: "pending",
  "not-run": "attention",
  basic: "reported",
};

export function verdictChip(day) {
  const cls = VERDICT_CLASS[day.verdict.state] || "na";
  return `<span class="act-state act-state--${cls}">${U.escapeHtml(verdictText(day))}</span>`;
}

/** Amber chip for an account that has no v5 activity data yet. */
export function migrationChip(major) {
  return major === 4
    ? stateChip("pending", "Appears after the next run", "ph-hourglass-medium")
    : stateChip("partial", "Migration completes on the first full v5 run", "ph-hourglass-medium");
}

/** Red chip when the latest run did not (fully) run the account. */
function deferralChip(day) {
  const d = day.deferral;
  if (!d) return "";
  return stateChip("attention", `${d.cutShort ? "Run stopped early" : "Latest run skipped"} \u00b7 ${d.label}`, "ph-prohibit");
}

/** What the collapsed "Activity Status" line shows: the verdict, plus any deferral. */
export function summaryChips(day) {
  return verdictChip(day) + (day.deferral && day.verdict.state !== "not-run" ? deferralChip(day) : "");
}

const notice = (kind, icon, title, text) =>
  `<div class="act-notice act-notice--${kind}" role="status"><i class="ph ${icon}" aria-hidden="true"></i><div><strong>${U.escapeHtml(title)}</strong>${text ? `<p>${U.escapeHtml(text)}</p>` : ""}</div></div>`;

export function renderMigration(major) {
  if (major === 4)
    return notice(
      "info",
      "ph-info",
      "The basic view appears after this account\u2019s next run.",
      "On v4 it shows points per source, the search split and points available. v5 adds per-activity status, streaks and more.",
    );
  return notice(
    "warn",
    "ph-hourglass-medium",
    "Activity details will appear after this account\u2019s first full v5 run.",
    "Runs from before v5 don\u2019t include the data this table uses, so there is nothing to show yet.",
  );
}

export const renderLoading = (text = "Loading activity\u2026") => `<p class="act-empty">${U.escapeHtml(text)}</p>`;

export function renderLoadError(message) {
  return notice("error", "ph-warning-circle", "Couldn\u2019t read run history from the script.", `Reason: ${message}. Retrying automatically.`);
}

function notRunNotice(day) {
  const d = day.deferral || { kind: "skipped", label: "skipped", reason: "" };
  const when = day.lastEndedAt ? ` Last attempt ${U.fmtRelative(day.lastEndedAt)}.` : "";
  if (d.kind === "bot-score")
    return notice("error", "ph-prohibit", "Account not run: high bot score",
      `Microsoft showed a bot-score warning on this account, so the script skipped it and attempted no activities.${when}`);
  return notice("error", "ph-prohibit", `Account not run: ${d.label}`, `The script reported: ${d.reason}.${when}`);
}

export function pickDay(days, selected) {
  return days.find((d) => d.day === selected) || days[0];
}

function dayLabel(d, index) {
  const label = U.localDateLabel(d.day, { weekday: "short", month: "short", day: "numeric" });
  return `${label}${index === 0 ? " (latest)" : ""} \u00b7 ${U.fmtSigned(d.points.gained)}`;
}

/**
 * @param {object[]} days      one account's days, newest first
 * @param {{email:string, selectedDay?:string, expanded:Set<string>, now?:number}} opts
 */
export function renderActivity(days, { email, selectedDay, expanded, now = Date.now() }) {
  const day = pickDay(days, selectedDay);
  const isLatest = day === days[0];
  const options = days
    .map(
      (d, i) =>
        `<option value="${U.escapeAttr(d.day)}" ${d === day ? "selected" : ""}>${U.escapeHtml(dayLabel(d, i))}</option>`,
    )
    .join("");
  const rows =
    day.groups
      .filter((g) => !QUIET_STATES.has(g.state))
      .map((g) => groupRow(g, day, email, expanded))
      .join("") +
    syntheticRows(day) +
    quietRow(day.groups.filter((g) => QUIET_STATES.has(g.state))) +
    (day.schema === "v4" ? v5OnlyRow() : "");

  const grid = `<div class="act-grid">
      <section class="act-card" aria-label="Points breakdown">
        <h3 class="act-card-title">Points breakdown</h3>
        <div class="act-table-wrap">
          <table class="act-table">
            <thead><tr><th scope="col">Activity</th><th scope="col">Status</th><th scope="col" class="act-num">Points</th><th scope="col">Detail</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        ${totals(day)}
      </section>
      <section class="act-card" aria-label="Streaks and progress">
        <h3 class="act-card-title">Streaks &amp; progress</h3>
        ${streakBoard(day, now, isLatest)}
        ${facts(day)}
      </section>
    </div>`;

  return `<div class="act-panel">
    <div class="act-head">
      <span class="act-head-chips">${day.verdict.state === "not-run" ? "" : deferralChip(day)}</span>
      <label class="act-day"><span class="act-day-label">Day</span>
        <select class="act-day-select" data-act-day-select="${U.escapeAttr(email)}" aria-label="Rewards day">${options}</select>
      </label>
    </div>
    ${day.verdict.state === "not-run" ? notRunNotice(day) : grid}
  </div>`;
}
