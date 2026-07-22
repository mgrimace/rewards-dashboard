import * as U from "../util.js";
import { cached } from "../api.js";
// Import BOTH chart builders
import { buildAccumBarHtml, buildHeatmapHtml, lineChart } from "../charts.js";

let data = null;
let accountsPayload = null;
let rootEl = null;
let mounted = false;
let context = null;

let selected = null;

// Persistent view mode storage helpers
const VIEW_STORAGE_KEY = "rewards_dashboard_view_mode";
let viewMode = localStorage.getItem(VIEW_STORAGE_KEY) || "accum"; // Load stored view or default to 'accum'

const launching = new Set();

const NUMERIC = /^[+\-\u2013]?[\d,.]*$/;

function statCard(id, value, unit, label, iconClass = "stat-icon-check", icon = "\u2713") {
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

function activeSchedule(status) {
  const local = status?.schedule || null;
  const remote = status?.remoteScheduleSupported ? status?.remoteSchedule : null;
  const localOn = Boolean(local?.enabled);
  const remoteOn = Boolean(remote?.enabled);

  if (localOn && remoteOn) {
    return {
      description: `${local.description} + ${remote.description}`,
      enabled: true,
      both: true,
      timezone: status?.timezone || "UTC",
    };
  }
  if (remoteOn) {
    return {
      description: remote.description,
      enabled: true,
      timezone: remote.timezone || status?.timezone || "UTC",
    };
  }
  if (localOn) {
    return {
      description: local.description,
      enabled: true,
      timezone: status?.timezone || "UTC",
    };
  }
  return {
    description: local?.description || remote?.description || "Not scheduled",
    enabled: false,
    timezone: status?.timezone || "UTC",
  };
}

function checkVariant(status) {
  return (
    { success: "ok", error: "error", running: "running", idle: "idle" }[status] ?? "idle"
  );
}

function controlState() {
  const status = context?.status;
  const usable = Boolean(status?.reachable && status?.authOk !== false);
  const running = Boolean(status?.botRunning);
  return { usable, running };
}

async function runAccount(account) {
  if (!context || !account.configured || !Number.isInteger(account.index)) return;

  launching.add(account.index);
  renderAccountRows(rootEl);
  try {
    await context.api.control("start", { accountIndex: account.index });
    context.toast(
      `Started ACCOUNT_${account.index} only (${account.email}).`,
      "success",
    );
    context.invalidate();
    await context.refresh();
  } catch (error) {
    context.toast(error.message, error.status === 409 ? "warn" : "error");
  } finally {
    launching.delete(account.index);
    renderAccountRows(rootEl);
  }
}

function renderStats(root, status) {
  const accounts = data?.accounts || [];
  const runs = data?.runs || [];
  const lastRun = runs.find((r) => r.status === "done") || runs[0] || null;

  const errorCount = accounts.filter((a) => a.status === "error").length;
  const anyRunning = accounts.some((a) => a.status === "running");
  const combined = accounts.reduce((sum, a) => sum + (a.lastPoints || 0), 0);
  const sched = activeSchedule(status);

  U.$("#statGrid", root).innerHTML = [
    statCard("statAccounts", U.fmtNumber(accounts.length), "profiles", "Accounts tracked"),
    statCard("statCombined", U.fmtNumber(combined), "points", "Combined balance"),
    statCard("statLastGained", lastRun ? U.fmtSigned(lastRun.totalGained) : "\u2013", "points", "Points earned last run"),
    statCard(
      "statLastRun",
      anyRunning ? "Running now" : lastRun ? U.fmtRelative(lastRun.endTs || lastRun.startTs) : "\u2013",
      anyRunning ? "" : "timestamp",
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
      U.escapeHtml(sched.description || "\u2013"),
      sched.timezone || "UTC",
      sched.both ? "Schedule (2 active)" : "Schedule",
      sched.both ? "stat-icon-alert icon-alert-active" : sched.enabled ? "stat-icon-check" : "stat-icon-idle",
      sched.both ? "!" : sched.enabled ? "\u2713" : "\u2013",
    ),
  ].join("");
}

function renderAccountRows(root) {
  const container = U.$("#overviewHeroRows", root);
  const accounts = accountsPayload?.accounts || [];
  const histories = accountsPayload?.histories || {};
  const { usable, running } = controlState();

  const errEl = U.$("#ovwAccountsError", root);
  if (errEl) {
    errEl.hidden = !accountsPayload?.apiError;
    if (accountsPayload?.apiError) errEl.textContent = accountsPayload.apiError;
  }

  if (!accounts.length) {
    container.innerHTML = '<p class="empty-note" style="padding:1.25rem">No accounts configured or observed yet.</p>';
    return;
  }

  const bucketed = accounts
    .map((a) => ({ key: a.key, days: U.bucketByDay(histories[a.key] || []) }))
    .filter((x) => x.days.length);

  // Require global max for the original accumulation bar view
  const globalMax = bucketed.length
    ? Math.max(1, ...bucketed.flatMap((b) => b.days.map((d) => d.gained)))
    : 1;

  const daysByKey = Object.fromEntries(bucketed.map((b) => [b.key, b.days]));
  const todayKey = U.tzDayKey(new Date());
  const isMobile = window.matchMedia("(max-width: 768px)").matches;

  container.innerHTML = accounts
    .map((a) => {
      const days = daysByKey[a.key] || null;
      let barCell = '<p class="empty-note" style="font-size:0.78rem;margin:0">No history yet</p>';
      
      if (days) {
        // Toggle view logic
        if (viewMode === "heatmap") {
            barCell = `<div class="heatmap-wrap">${buildHeatmapHtml(days)}</div>`;
        } else {
            barCell = `<div class="accum-track"><div class="accum-bar">${buildAccumBarHtml(days, globalMax, isMobile ? 7 : null)}</div></div>`;
        }
      }

      const todayGained = days?.find((d) => d.dayKey === todayKey)?.gained ?? null;
      const variant = checkVariant(a.status);
      const badgeStatus = { ok: "success", error: "error", running: "running", idle: "idle" }[variant];

      const todayText =
        todayGained != null
          ? `+${todayGained.toLocaleString()}\u202fpts today`
          : a.status === "running"
            ? "Running\u2026"
            : "No run today";

      const accountHistory = histories[a.key] || [];
      let lastGain = null;
      if (accountHistory.length >= 2) {
        const latest = accountHistory[accountHistory.length - 1];
        const previous = accountHistory[accountHistory.length - 2];
        lastGain = latest.points - previous.points;
      }

      const dur = a.lastDurationSec != null ? U.fmtDuration(a.lastDurationSec) : null;

      const sub =
        a.status === "running"
          ? `<span class="hero-sub-running">Running\u2026 ${U.escapeHtml(U.fmtRelative(a.lastStartAt))}</span>`
          : `Last Run: ${U.escapeHtml(U.fmtRelative(a.lastEndAt || a.lastStartAt))}${
              dur ? ` \u00b7 <span title="Last run duration">⏱ ${U.escapeHtml(dur)}</span>` : ""
            }${lastGain != null ? ` \u00b7 <span class="gain-val">${U.fmtSigned(lastGain)} points</span>` : ""}`;

      // hide email for screenshots by toggling mask = true      
      const MASK_EMAILS = true;
      return `<div class="hero-row">
            <div class="hero-bar-cell">${barCell}</div>
            <div class="hero-acc-card">
                <div class="hero-acc-pts">
                    <span class="hero-pts-num">${a.lastPoints != null ? U.fmtNumber(a.lastPoints) : "\u2013"}</span>
                    <span class="hero-pts-unit">Points</span>
                </div>
                <div class="hero-acc-info">
                    <div class="hero-acc-name">
                        ${MASK_EMAILS ? `ACCOUNT_${a.index}` : U.escapeHtml(a.email)}
                        ${a.configured ? "" : ' <span class="tag-mini">unconfigured</span>'}
                    </div>
                    <div class="hero-acc-meta">
                        <span class="hero-acc-today">
                            ${U.statusPill(badgeStatus)}
                            <span>${U.escapeHtml(todayText)}</span>
                            ${a.streakCounter != null ? `<span> \u00b7 🔥\u202f${U.fmtNumber(a.streakCounter)}</span>` : ""}
                        </span>
                    </div>
                    <div class="hero-acc-sub">${sub}</div>
                    ${a.lastError ? `<div class="hero-acc-error">${U.escapeHtml(a.lastError)}</div>` : ""}
                </div>
                <div class="hero-acc-actions">
                    ${a.configured && Number.isInteger(a.index)
                      ? `<button type="button" class="link-btn" data-run-account="${a.index}" ${!usable || running || launching.has(a.index) ? "disabled" : ""} title="Run only ACCOUNT_${a.index}">${launching.has(a.index) ? "Starting…" : "Run only"}</button>`
                      : ""
                    }
                    <button type="button" class="link-btn" data-trend="${U.escapeAttr(a.key)}" aria-pressed="${selected === a.key}">Trend</button>
                </div>
            </div>
        </div>`;
    })
    .join("");

  // Ensure the timeline and heatmap grids both align right if overflowed
  container.querySelectorAll(".accum-track").forEach((track) => {
    track.scrollLeft = track.scrollWidth;
  });
  
  if (viewMode === "heatmap") {
    container.querySelectorAll(".hero-bar-cell").forEach((cell) => {
      cell.scrollLeft = cell.scrollWidth;
    });
  }

  container.querySelectorAll("button[data-run-account]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const index = Number(btn.dataset.runAccount);
      const account = accounts.find((a) => a.index === index);
      if (account) runAccount(account);
    }),
  );

  container.querySelectorAll("button[data-trend]").forEach((btn) =>
    btn.addEventListener("click", () => {
      selected = selected === btn.dataset.trend ? null : btn.dataset.trend;
      renderAccountRows(root);
      if (selected) {
        U.$("#ovwTrendSection", root).scrollIntoView({
          behavior: "smooth",
          block: "nearest",
        });
      }
    }),
  );

  renderTrend();
}

function renderTrend() {
  const section = U.$("#ovwTrendSection", rootEl);
  section.hidden = !selected;
  if (!selected) return;

  const history = (accountsPayload?.histories || {})[selected] || [];
  U.$("#ovwTrendName", rootEl).textContent = selected;

  lineChart(
    U.$("#ovwTrendChart", rootEl),
    history.map((h) => ({
      key: h.ts.slice(0, 10),
      value: h.points,
      label: U.fmtDateTime(h.ts),
    })),
    { emptyMessage: "No point history recorded for this account yet." },
  );
}

function renderRunHeader(root, status) {
  const bot = status?.bot;
  const run = bot?.run;

  const active =
    bot &&
    bot.state !== "idle" &&
    bot.state !== "unknown";

  const progressBox = U.$("#runProgressBox", root);
  const titleEl = U.$("#run-progress-heading", root);
  const metaEl = U.$("#currentRunMeta", root);
  const bar = U.$("#currentRunBar", root);

  if (!bar) return;

  progressBox.hidden = false;

  const progressWrap = bar.parentElement;
  const total = Number(run?.accountsTotal) || 0;
  let done = Number(run?.accountsSeen);

  if (!Number.isFinite(done)) {
    done = (run?.accounts || []).filter(a => a.success != null).length;
  }

  done = Math.min(done, total);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  titleEl.textContent = active ? "Run in progress" : "Last run";

  metaEl.textContent = [
    run?.version ? `v${run.version}` : null,
    total ? `${done}/${total} accounts done` : `${done} accounts seen`,
    run?.clusters != null ? `${run.clusters} cluster${run.clusters === 1 ? "" : "s"}` : null,
    run?.collected != null ? `${U.fmtSigned(run.collected)} points` : null,
  ]
    .filter(Boolean)
    .join(" \u00b7 ");

  bar.style.width = `${pct}%`;
  progressWrap.setAttribute("aria-valuenow", String(pct));
    
  if (!active) {
    progressBox.classList.add("idle");
  } else {
    progressBox.classList.remove("idle");
  }
}

export default {
  id: "overview",
  label: "Overview",
  interval: 10000,

  mount(root, ctx) {
    rootEl = root;
    context = ctx;
    root.innerHTML = `
            <p class="notice notice--warn" id="ovwAccountsError" hidden></p>

            <section aria-labelledby="stats-heading" class="stats">
                <h2 id="stats-heading" class="visually-hidden">Summary</h2>
                <div class="stat-grid" id="statGrid"></div>
            </section>

            <section class="panel run-progress-box" id="runProgressBox" aria-labelledby="run-progress-heading">
                <div class="run-progress-header">
                    <h2 class="run-progress-title" id="run-progress-heading">Run in progress</h2>
                    <span id="currentRunMeta" class="run-progress-meta"></span>
                </div>
                <div class="progress" id="currentRunProgressWrap" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
                    <div class="progress-bar" id="currentRunBar"></div>
                </div>
            </section>

            <section class="panel hero-panel" id="currentRun" aria-labelledby="current-run-heading">
                <div class="hero-panel-header" style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.75rem;">
                    <div>
                        <h2 id="current-run-heading" style="margin:0;">Accounts Overview</h2>
                    </div>
                    <div class="seg" id="ovwViewToggle">
                        <button type="button" class="seg-btn ${viewMode === 'accum' ? 'seg-btn--active' : ''}" data-view="accum">Timeline</button>
                        <button type="button" class="seg-btn ${viewMode === 'heatmap' ? 'seg-btn--active' : ''}" data-view="heatmap">Heatmap</button>
                    </div>
                </div>
                <div class="hero-layout" id="overviewHeroRows">
                    <p class="empty-note" style="padding:1.25rem">Loading&hellip;</p>
                </div>
            </section>

            <section class="panel" id="ovwTrendSection" hidden aria-labelledby="ovw-trend-heading">
                <div class="panel-head">
                    <h2 id="ovw-trend-heading">Point total &mdash; <span id="ovwTrendName"></span></h2>
                    <span class="panel-sub">Every recorded balance, oldest to newest</span>
                </div>
                <div id="ovwTrendChart" class="chart-wrap"></div>
            </section>`;
    mounted = true;

    // Attach event listeners for the toggle and save selection to localStorage
    const toggleBtns = root.querySelectorAll("#ovwViewToggle .seg-btn");
    toggleBtns.forEach((btn) => {
        btn.addEventListener("click", (e) => {
            toggleBtns.forEach((b) => b.classList.remove("seg-btn--active"));
            e.target.classList.add("seg-btn--active");
            viewMode = e.target.dataset.view;
            localStorage.setItem(VIEW_STORAGE_KEY, viewMode);
            renderAccountRows(rootEl);
        });
    });
  },
  
  async refresh(ctx) {
    context = ctx;
    [data, accountsPayload] = await Promise.all([
      cached("summary", ctx.api.summary, 3000),
      cached("accounts", ctx.api.accounts, 5000),
    ]);
    this.redraw(ctx);
  },

  redraw(ctx) {
    context = ctx || context;
    if (!mounted || !data) return;
    renderStats(rootEl, context.status);
    renderRunHeader(rootEl, context.status);
    renderAccountRows(rootEl);
  },

  onState(status, ctx) {
    context = ctx || context;
    if (!mounted || !data) return;
    renderRunHeader(rootEl, status);
    renderStats(rootEl, status);
  },
};