import * as U from "../util.js";
import { accountTotals, combineAccounts, loadServers } from "../serverViews.js";
// Import BOTH chart builders
import { buildAccumBarHtml, buildHeatmapHtml, lineChart } from "../charts.js";

let data = null;
let accountsPayload = null;
let rootEl = null;
let mounted = false;
let context = null;
let groups = [];
let refreshSequence = 0;

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
    {
      success: "ok",
      stopped: "stopped",
      error: "error",
      running: "running",
      skipped: "skipped",
      idle: "idle",
    }[status] ?? "idle"
  );
}

// pendingDelay is only ever forward-looking (cleared the moment the next
// account actually starts), so a stale/expired one just yields null here.
function pendingDelayLabel(pendingDelay) {
  if (!pendingDelay) return null;
  const elapsedSec = (Date.now() - Date.parse(pendingDelay.sinceTs)) / 1000;
  const remaining = Math.round(pendingDelay.seconds - elapsedSec);
  if (remaining <= 0) return null;
  const who = pendingDelay.nextEmail
    ? ` (${pendingDelay.nextEmail.split("@")[0]})`
    : "";
  return `next account in ~${remaining}s${who}`;
}

function statusFor(serverId) {
  return context?.statusFor(serverId) || groups.find((g) => g.server.id === serverId)?.summary?.status;
}

function controlState(serverId) {
  const status = statusFor(serverId);
  const usable = Boolean(status?.reachable && status?.authOk !== false);
  const running = Boolean(status?.botRunning);
  return { usable, running };
}

async function runAccount(account) {
  if (!context || !account.configured || !Number.isInteger(account.index)) return;

  launching.add(account.key);
  renderAccountRows(rootEl);
  try {
    await context.api.forServer(account.serverId).control("start", { accountIndex: account.index });
    context.toast(
      `Started ACCOUNT_${account.index} only (${account.email}).`,
      "success",
    );
    context.invalidate();
    await context.refresh();
  } catch (error) {
    context.toast(error.message, error.status === 409 ? "warn" : "error");
  } finally {
    launching.delete(account.key);
    renderAccountRows(rootEl);
  }
}

function renderStats(root) {
  const accounts = accountsPayload?.accounts || [];
  const runs = groups.flatMap((group) => (group.summary?.runs || []).map((run) => ({ ...run, serverName: group.server.name })))
    .sort((a, b) => (Date.parse(b.endTs || b.startTs) || 0) - (Date.parse(a.endTs || a.startTs) || 0));
  const lastRun = runs.find((r) => r.status === "done") || runs[0] || null;
  const accountStatus = (account) => {
    const status = statusFor(account.serverId);
    const liveByEmail = U.runAccountMap(status);
    return (
    U.accountDisplayStatus(
      account,
      liveByEmail.get(account.email.trim().toLowerCase()),
      Boolean(status?.botRunning),
    ));
  };

  const errorCount = accounts.filter((a) => accountStatus(a) === "error").length;
  const anyRunning = groups.some((group) => statusFor(group.server.id)?.botRunning);
  const totals = accountTotals(accounts);
  const schedules = groups.map((group) => activeSchedule(statusFor(group.server.id)));
  const sched = groups.length === 1 ? schedules[0] : {
    description: `${schedules.filter((s) => s.enabled).length} servers scheduled`,
    timezone: context?.status?.timezone || "UTC",
    enabled: schedules.some((s) => s.enabled),
  };

  U.$("#statGrid", root).innerHTML = [
    statCard("statAccounts", U.fmtNumber(totals.count), "profiles", "Accounts tracked"),
    statCard("statCombined", U.fmtNumber(totals.balance), "points", "Combined balance"),
    statCard("statLastGained", lastRun ? U.fmtSigned(lastRun.totalGained) : "\u2013", "points", lastRun ? `Last run · ${lastRun.serverName}` : "Points earned last run"),
    statCard(
      "statLastRun",
      anyRunning ? "Running now" : lastRun ? U.fmtRelative(lastRun.endTs || lastRun.startTs) : "\u2013",
      anyRunning ? "" : "timestamp",
      lastRun && !anyRunning ? `Last run · ${lastRun.serverName}` : "Last run",
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

  const errEl = U.$("#ovwAccountsError", root);
  if (errEl) {
    errEl.hidden = !accountsPayload?.apiError;
    if (accountsPayload?.apiError) errEl.textContent = accountsPayload.apiError;
  }

  if (!groups.length) {
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

  // While waiting between accounts, mark the account that's up next as
  // 'pending' rather than plain 'idle'/'success'/'error'. index.ts's
  // ACCOUNT-DELAY log line names the upcoming account directly, so this
  // reads that identity straight off pendingDelay rather than inferring it
  // from run.accounts (which only ever contains accounts that have already
  // started).
  // hide email for screenshots by toggling mask = true
  const MASK_EMAILS = false;

  const rowsByServer = new Map(groups.map((group) => [group.server.id, []]));
  accounts.forEach((a) => {
      const status = statusFor(a.serverId);
      const { usable, running } = controlState(a.serverId);
      const nextAccountEmail = status?.pendingDelay?.nextEmail || null;
      const sleepSec = U.sleepRemainingSec(status);
      const liveByEmail = U.runAccountMap(status);
      const displayStatus = U.accountDisplayStatus(
        a,
        liveByEmail.get(a.email.trim().toLowerCase()),
        Boolean(status?.botRunning),
      );
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
      const variant = checkVariant(displayStatus);
      let badgeStatus = {
        ok: "success",
        stopped: "stopped",
        error: "error",
        running: "running",
        skipped: "skipped",
        idle: "idle",
      }[variant];
      if (badgeStatus !== "running" && nextAccountEmail && a.email === nextAccountEmail) {
        badgeStatus = "pending";
      }
      if (sleepSec != null && a.configured) badgeStatus = "sleeping";

      const todayText =
        todayGained != null
          ? `+${todayGained.toLocaleString()}\u202fpts today`
          : displayStatus === "running"
            ? "Running\u2026"
            : "No run today";

      const accountHistory = histories[a.key] || [];
      let gainHtml = "";
      if (accountHistory.length >= 2) {
        const latest = accountHistory[accountHistory.length - 1];
        const previous = accountHistory[accountHistory.length - 2];
        const trueGain = latest.points - previous.points;
        const selfReported = latest.gained ?? 0;
        const other = trueGain - selfReported;
        const gainText =
          other !== 0
            ? `${U.fmtSigned(selfReported)}${other >= 0 ? "+" : "-"}${Math.abs(other).toLocaleString()} pts`
            : `${U.fmtSigned(trueGain)} pts`;
        gainHtml = ` \u00b7 <span class="gain-val" title="Change in points since last check-in from all sources">${gainText}</span>`;
      }

      const dur = a.lastDurationSec != null ? U.fmtDuration(a.lastDurationSec) : null;

      const sub =
        displayStatus === "running"
          ? `<span class="hero-sub-running">Running\u2026 ${U.escapeHtml(U.fmtRelativeDetailed(a.lastStartAt))}</span>`
          : `Last Run: ${U.escapeHtml(U.fmtRelative(a.lastEndAt || a.lastStartAt))}${
              dur ? ` \u00b7 <span title="Last run duration">⏱ ${U.escapeHtml(dur)}</span>` : ""
            }${gainHtml}`;

      rowsByServer.get(a.serverId).push(`<div class="hero-row">
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
                    ${displayStatus === "error" && a.lastError
                      ? `<div class="hero-acc-error">${U.escapeHtml(
                          a.lastError.length > 120
                            ? `${a.lastError.slice(0, 119)}…`
                            : a.lastError
                        )}</div>`
                      : ""}
                </div>
                <div class="hero-acc-actions">
                    ${a.configured && Number.isInteger(a.index)
                      ? `<button type="button" class="link-btn" data-run-account="${U.escapeAttr(a.key)}" ${!usable || running || launching.has(a.key) ? "disabled" : ""} title="Run only ACCOUNT_${a.index}">${launching.has(a.key) ? "Starting…" : "Run only"}</button>`
                      : ""
                    }
                    <button type="button" class="link-btn" data-trend="${U.escapeAttr(a.key)}" aria-pressed="${selected === a.key}">Trend</button>
                </div>
            </div>
        </div>`);
    });

  container.innerHTML = groups.map((group) => {
    const current = statusFor(group.server.id);
    const run = current?.bot?.run;
    const label = current?.botRunning ? "Running" : current?.reachable ? (current.botOutcome || "Idle") : "Unavailable";
    const progress = run?.accountsTotal ? ` · ${run.accountsSeen || 0}/${run.accountsTotal} accounts` : "";
    const rows = rowsByServer.get(group.server.id);
    return `<h3 class="server-group-heading">${U.escapeHtml(group.server.name)} <span class="server-group-status">· ${U.escapeHtml(label + progress)}</span></h3>${rows.length ? rows.join("") : '<p class="empty-note" style="padding:1.25rem">No accounts configured or observed yet.</p>'}`;
  }).join("");

  // The timeline view is a rolling recent-history strip, so scrolling it to
  // its end shows the most recent days by default - that's still correct.
  // The heatmap is intentionally left-anchored to where the account's data
  // starts, with empty "coming up" cells trailing off to the right, so it
  // must NOT be force-scrolled to its end - that would undo the fix and put
  // the user right back at a mostly-empty future edge instead of their data.
  container.querySelectorAll(".accum-track").forEach((track) => {
    track.scrollLeft = track.scrollWidth;
  });

  container.querySelectorAll("button[data-run-account]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const account = accounts.find((a) => a.key === btn.dataset.runAccount);
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
  const account = accountsPayload?.accounts?.find((item) => item.key === selected);
  U.$("#ovwTrendName", rootEl).textContent = account ? `${account.serverName} · ${account.email}` : selected;

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
  const active = Boolean(status?.botRunning);
  const outcome = active ? null : status?.botOutcome;

  const progressBox = U.$("#runProgressBox", root);
  const titleEl = U.$("#run-progress-heading", root);
  const metaEl = U.$("#currentRunMeta", root);
  const bar = U.$("#currentRunBar", root);

  if (!bar) return;

  progressBox.hidden = groups.length !== 1;

  const sleepSec = U.sleepRemainingSec(status);
  progressBox.classList.toggle("sleeping", sleepSec != null);
  if (sleepSec != null) {
    const sleep = status.pendingSleep;
    const pct = Math.min(
      100,
      Math.max(0, Math.round(((sleep.seconds - sleepSec) / sleep.seconds) * 100)),
    );
    titleEl.textContent = "Run sleeping";
    U.renderTicker(
      metaEl,
      `starts in ${U.fmtDuration(sleepSec)} \u00b7 ${U.fmtDuration(sleep.seconds)} delay`,
    );
    bar.style.width = `${pct}%`;
    bar.parentElement.setAttribute("aria-valuenow", String(pct));
    progressBox.classList.remove("idle");
    return;
  }
  const progressWrap = bar.parentElement;
  const total = Number(run?.accountsTotal) || 0;
  const runAccounts = Array.isArray(run?.accounts) ? run.accounts : [];

  // run.accounts only ever contains accounts that have started (see
  // logParser.js's ensureAccount) - success stays null until it finishes,
  // so this is the one reliable way to tell "finished" from "still running"
  // rather than trusting accountsSeen, which counts starts, not completions.
  const doneCount = runAccounts.filter((a) => a.success != null).length;
  const seenCount = Number.isFinite(Number(run?.accountsSeen))
    ? Number(run.accountsSeen)
    : runAccounts.length;
  const runningCount = Math.max(0, seenCount - doneCount);
  const pendingCount = Math.max(0, total - seenCount);

  const done = Math.min(doneCount, total);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  titleEl.textContent = active ? "Run in progress" : "Last run";

  U.renderTicker(
    metaEl,
    [
      run?.version ? `v${run.version}` : null,
      total ? `${done}/${total} done` : `${seenCount} accounts seen`,
      total && runningCount ? `${runningCount} running` : null,
      total && pendingCount ? `${pendingCount} pending` : null,
      outcome ? U.pillParts(outcome).label : null,
      run?.clusters != null ? `${run.clusters} cluster${run.clusters === 1 ? "" : "s"}` : null,
      run?.collected != null ? `${U.fmtSigned(run.collected)} points` : null,
      pendingDelayLabel(status?.pendingDelay),
    ]
      .filter(Boolean)
      .join(" \u00b7 "),
  );

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
    const sequence = ++refreshSequence;
    const nextGroups = await loadServers(ctx.api, ["summary", "accounts"]);
    if (sequence !== refreshSequence) return;
    groups = nextGroups;
    const { accounts, histories } = combineAccounts(groups);
    accountsPayload = {
      accounts, histories,
      apiError: groups.flatMap((group) => [...group.errors, group.accounts?.apiError].filter(Boolean).map((error) => `${group.server.name}: ${error}`)).join(" · "),
    };
    data = { accounts };
    this.redraw(ctx);
  },

  redraw(ctx) {
    context = ctx || context;
    if (!mounted || !data) return;
    renderStats(rootEl);
    renderRunHeader(rootEl, context.status);
    renderAccountRows(rootEl);
  },

  onTick(ctx) {
    context = ctx || context;
    if (!mounted || !data) return;
    renderRunHeader(rootEl, context.status);
  },

  onState(status, ctx) {
    context = ctx || context;
    if (!mounted || !data) return;
    renderRunHeader(rootEl, context.status);
    renderStats(rootEl);
    renderAccountRows(rootEl);
  },
};