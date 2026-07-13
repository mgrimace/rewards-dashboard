import * as U from "../util.js";
import { cached } from "../api.js";

let data = null;

const NUMERIC = /^[+\-\u2013]?[\d,.]*$/;

function statCard(
  id,
  value,
  unit,
  label,
  iconClass = "stat-icon-check",
  icon = "\u2713",
) {
  const small = NUMERIC.test(String(value).trim()) ? "" : " stat-value-sm";
  return `
        <div class="stat-card">
            <div class="stat-block-chip${small ? " chip-sm-wrap" : ""}">
                <span class="stat-num-val${small}" id="${id}">${value}</span>
                <span class="stat-block-unit">${U.escapeHtml(unit)}</span>
            </div>
            <div class="stat-title-row">
                <span class="${iconClass}" aria-hidden="true">${icon}</span>
                <span class="stat-label">${U.escapeHtml(label)}</span>
            </div>
        </div>`;
}

function activityLabel(item) {
  switch (item.kind) {
    case "account-start":
      return `${item.email || item.userName} \u2013 run started`;
    case "account-end":
      return `${item.email} \u2013 completed`;
    case "account-error":
      return `${item.email || "account"} \u2013 ${item.error || item.message}`;
    case "run-start":
      return `Run started \u2013 ${item.message.split("|")[1]?.trim() || ""}`;
    case "run-end":
      return `Run finished \u2013 ${item.message}`;
    default:
      return item.message || item.raw;
  }
}

const levelTag = (level) =>
  ({ error: "tag-error", warn: "tag-warn", info: "tag-info" })[level] ||
  "tag-info";

const SOURCE_LABELS = {
  search: "Search",
  bonus: "Bonus search",
  read: "Read",
  checkIn: "Check-in",
  claimReward: "Claim reward",
  claimBonus: "Claim bonus",
  urlReward: "URL reward",
  visualSearch: "Visual search",
  appReward: "App reward",
  punchcard: "Punchcard",
  searchOnBing: "Search activity",
};

function sourceBreakdown(account) {
  const sources = Object.entries(account.live?.bySource || {}).filter(
    ([, points]) => Number(points) > 0,
  );
  const earnable = account.earnable || null;
  const chips = sources.map(
    ([source, points]) =>
      `<span class="point-source"><strong>${U.escapeHtml(SOURCE_LABELS[source] || source)}</strong> ${U.escapeHtml(U.fmtSigned(points))}</span>`,
  );
  if (earnable) {
    const total = Object.values(earnable).reduce(
      (sum, points) => sum + (Number(points) || 0),
      0,
    );
    chips.push(
      `<span class="point-source point-source--target"><strong>Earnable today</strong> ${U.escapeHtml(U.fmtNumber(total))}</span>`,
    );
  }
  return chips.length
    ? `<span class="runacc-sources">${chips.join("")}</span>`
    : "";
}

function renderStats(root, status) {
  const accounts = data?.accounts || [];
  const runs = data?.runs || [];
  const lastRun = runs.find((r) => r.status === "done") || runs[0] || null;

  const errorCount = accounts.filter((a) => a.status === "error").length;
  const anyRunning = accounts.some((a) => a.status === "running");
  const combined = accounts.reduce((sum, a) => sum + (a.lastPoints || 0), 0);

  U.$("#statGrid", root).innerHTML = [
    statCard(
      "statAccounts",
      U.fmtNumber(accounts.length),
      "profiles",
      "Accounts tracked",
    ),
    statCard(
      "statCombined",
      U.fmtNumber(combined),
      "points",
      "Combined balance",
    ),
    statCard(
      "statLastGained",
      lastRun ? U.fmtSigned(lastRun.totalGained) : "\u2013",
      "points",
      "Points earned last run",
    ),
    statCard(
      "statLastRun",
      lastRun ? U.fmtRelative(lastRun.endTs || lastRun.startTs) : "\u2013",
      "timestamp",
      "Last run",
      anyRunning ? "stat-icon-running" : "stat-icon-check",
      anyRunning ? "\u25CF" : "\u2713",
    ),
    statCard(
      "statErrors",
      U.fmtNumber(errorCount),
      "errors",
      "Accounts in error",
      errorCount > 0 ? "stat-icon-alert icon-alert-active" : "stat-icon-check",
      errorCount > 0 ? "!" : "\u2713",
    ),
    statCard(
      "statSchedule",
      U.escapeHtml(status?.schedule?.description || "\u2013"),
      status?.timezone || "UTC",
      "Schedule",
      status?.schedule?.enabled ? "stat-icon-check" : "stat-icon-idle",
      status?.schedule?.enabled ? "\u2713" : "\u2013",
    ),
  ].join("");
}

function renderCurrentRun(root, status) {
  const section = U.$("#currentRun", root);
  const bot = status?.bot;
  const run = bot?.run;
  const active = bot && bot.state !== "idle" && bot.state !== "unknown";

  if (!active && !(run && run.accountsSeen)) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  const total = run?.accountsTotal || 0;
  const seen = run?.accountsSeen || 0;
  const done = (run?.accounts || []).filter((a) => a.success != null).length;
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;

  U.$("#currentRunTitle", root).textContent = active
    ? "Run in progress"
    : "Last run";
  U.$("#currentRunMeta", root).textContent = [
    run?.version ? `v${run.version}` : null,
    total ? `${done}/${total} accounts done` : `${seen} accounts seen`,
    run?.clusters != null
      ? `${run.clusters} cluster${run.clusters === 1 ? "" : "s"}`
      : null,
    run?.collected != null ? `${U.fmtSigned(run.collected)} points` : null,
  ]
    .filter(Boolean)
    .join(" \u00b7 ");

  U.$("#currentRunBar", root).style.width = `${pct}%`;
  U.$("#currentRunBar", root).parentElement.setAttribute(
    "aria-valuenow",
    String(pct),
  );

  const rows = (run?.accounts || []).map((a) => {
    const status =
      a.success === true
        ? "success"
        : a.success === false
          ? "error"
          : a.collectedPoints != null
            ? "success"
            : "running";

    const live = a.live || {};
    const liveDetail = [
      live.gained ? `${U.fmtSigned(live.gained)} pts so far` : null,
      live.balance != null ? `${U.fmtNumber(live.balance)} total` : null,
    ]
      .filter(Boolean)
      .join(" \u00b7 ");

    const detail =
      a.success === false
        ? a.error || "Failed"
        : a.collectedPoints != null
          ? `${U.fmtSigned(a.collectedPoints)} pts \u00b7 ${U.fmtNumber(a.finalPoints)} total${a.durationSeconds ? ` \u00b7 ${U.fmtDuration(a.durationSeconds)}` : ""}`
          : liveDetail || "Working\u2026";
    return `
            <li class="runacc">
                ${U.statusPill(status)}
                <span class="runacc-email">${U.escapeHtml(a.email)}</span>
                <span class="runacc-detail">${U.escapeHtml(detail)}</span>
                ${sourceBreakdown(a)}
            </li>`;
  });

  U.$("#currentRunAccounts", root).innerHTML = rows.length
    ? rows.join("")
    : '<li class="empty-note">Waiting for the first account\u2026</li>';
}

function renderActivity(root) {
  const activity = data?.activity || [];
  const feed = U.$("#activityFeed", root);
  if (!activity.length) {
    feed.innerHTML = '<li class="empty-note">No activity observed yet.</li>';
    return;
  }
  feed.innerHTML = activity
    .map(
      (item) => `
        <li class="activity-item">
            <span class="activity-time">${U.fmtDateTime(item.ts)}</span>
            <span class="activity-tag ${levelTag(item.level)}">${U.escapeHtml(item.title || item.level || "")}</span>
            <span class="activity-msg">${U.escapeHtml(activityLabel(item))}</span>
        </li>`,
    )
    .join("");
}

let rootEl = null;

export default {
  id: "overview",
  label: "Overview",
  interval: 10000,

  mount(root) {
    rootEl = root;
    root.innerHTML = `
            <section aria-labelledby="stats-heading" class="stats">
                <h2 id="stats-heading" class="visually-hidden">Summary</h2>
                <div class="stat-grid" id="statGrid"></div>
            </section>

            <section class="panel" id="currentRun" hidden aria-labelledby="current-run-heading">
                <div class="panel-head">
                    <h2 id="current-run-heading"><span id="currentRunTitle">Run in progress</span></h2>
                    <span class="panel-sub" id="currentRunMeta"></span>
                </div>
                <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
                    <div class="progress-bar" id="currentRunBar"></div>
                </div>
                <ul class="runacc-list" id="currentRunAccounts"></ul>
            </section>

            <section class="panel" aria-labelledby="activity-heading">
                <div class="panel-head">
                    <h2 id="activity-heading">Recent activity</h2>
                    <span class="panel-sub">Milestones, warnings and errors parsed from the log stream</span>
                </div>
                <ul id="activityFeed" class="activity-feed" aria-live="polite">
                    <li class="empty-note">Loading activity&hellip;</li>
                </ul>
            </section>`;
  },

  async refresh(ctx) {
    data = await cached("summary", ctx.api.summary, 3000);
    this.redraw(ctx);
  },

  redraw(ctx) {
    if (!rootEl || !data) return;
    renderStats(rootEl, ctx.status);
    renderCurrentRun(rootEl, ctx.status);
    renderActivity(rootEl);
  },

  onState(status) {
    if (!rootEl || !data) return;
    renderCurrentRun(rootEl, status);
    renderStats(rootEl, status);
  },
};
