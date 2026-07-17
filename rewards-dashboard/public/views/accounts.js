import * as U from "../util.js";
import { cached } from "../api.js";
import { buildAccumBarHtml, lineChart } from "../charts.js";

let rootEl = null;
let payload = null;
let selected = null;
let expanded = new Set();
let context = null;
const launching = new Set();

function checkVariant(status) {
  return (
    { success: "ok", error: "error", running: "running", idle: "idle" }[
    status
    ] ?? "idle"
  );
}

function protectionPresentation(account) {
  if (account.streakProtectionEnabled == null) return null;

  const remaining = account.streakProtectionRemainingDays;
  const days =
    remaining == null
      ? "days unavailable"
      : `${remaining} protection day${remaining === 1 ? "" : "s"} left`;
  const state = account.streakProtectionEnabled ? "On" : "Off";
  const streak =
    account.streakCounter == null
      ? "streak unavailable"
      : `${U.fmtNumber(account.streakCounter)} day${account.streakCounter === 1 ? "" : "s"} current streak`;

  return {
    state,
    days,
    streak,
    pillClass:
      account.streakProtectionEnabled && remaining !== 0
        ? "pill-success"
        : remaining === 0
          ? "pill-warn"
          : "pill-idle",
  };
}

function detailsGrid(a) {
  const items = [];
  const protection = protectionPresentation(a);
  if (a.index != null) items.push(["Slot", `ACCOUNT_${a.index}`]);
  items.push([
    "Configured in .env",
    a.configured ? "Yes" : "No \u2014 seen in logs only",
  ]);
  if (a.geoLocale) items.push(["Geo locale", a.geoLocale]);
  if (a.langCode) items.push(["Language", a.langCode]);
  if (a.hasTotp != null)
    items.push(["TOTP secret", a.hasTotp ? "Set" : "Not set"]);
  if (a.hasRecoveryEmail != null)
    items.push(["Recovery email", a.hasRecoveryEmail ? "Set" : "Not set"]);
  items.push([
    "Proxy",
    a.proxy
      ? `${a.proxy.url}${a.proxy.port ? `:${a.proxy.port}` : ""}${a.proxy.hasCredentials ? " (authenticated)" : ""}`
      : "None",
  ]);
  items.push([
    "Success streak",
    `${a.successStreak} run${a.successStreak === 1 ? "" : "s"}`,
  ]);
  if (protection) {
    items.push(["Current streak", protection.streak]);
    items.push([
      "Streak protection",
      protection.state === "On" ? "Enabled" : "Disabled",
    ]);
    items.push(["Protection days remaining", protection.days]);
    if (a.streakProtectionUpdatedAt) {
      items.push([
        "Protection status checked",
        U.fmtRelative(a.streakProtectionUpdatedAt),
      ]);
    }
  }
  items.push(["Runs recorded by the API", U.fmtNumber(a.apiRuns)]);
  items.push([
    "Points collected (API history)",
    U.fmtSigned(a.apiTotalCollected),
  ]);
  items.push(["Last duration", U.fmtDuration(a.lastDurationSec)]);
  items.push(["History points loaded", U.fmtNumber(a.historyCount)]);

  return `<dl class="kv">${items
    .map(
      ([k, v]) =>
        `<div><dt>${U.escapeHtml(k)}</dt><dd>${U.escapeHtml(String(v))}</dd></div>`,
    )
    .join("")}</dl>`;
}

function controlState() {
  const status = context?.status;
  const usable = Boolean(status?.reachable && status?.authOk !== false);
  const running = Boolean(status?.botRunning);
  return { usable, running };
}

async function runAccount(account) {
  if (!context || !account.configured || !Number.isInteger(account.index))
    return;

  launching.add(account.index);
  render();
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
    render();
  }
}

function render() {
  if (!rootEl || !payload) return;
  const accounts = payload.accounts || [];
  const histories = payload.histories || {};
  const { usable, running } = controlState();

  U.$("#accountsError", rootEl).hidden = !payload.apiError;
  if (payload.apiError)
    U.$("#accountsError", rootEl).textContent = payload.apiError;

  const container = U.$("#heroRows", rootEl);
  if (!accounts.length) {
    container.innerHTML =
      '<p class="empty-note" style="padding:1.25rem">No accounts configured or observed yet.</p>';
    return;
  }

  const bucketed = accounts
    .map((a) => ({ key: a.key, days: U.bucketByDay(histories[a.key] || []) }))
    .filter((x) => x.days.length);
  const globalMax = bucketed.length
    ? Math.max(1, ...bucketed.flatMap((b) => b.days.map((d) => d.gained)))
    : 1;
  const daysByKey = Object.fromEntries(bucketed.map((b) => [b.key, b.days]));
  const todayKey = U.tzDayKey(new Date());
  const isMobile = window.matchMedia("(max-width: 768px)").matches;

  container.innerHTML = accounts
    .map((a) => {
      const label = a.email;
      const days = daysByKey[a.key] || null;

      const barCell = days
        ? `<div class="accum-track"><div class="accum-bar">${buildAccumBarHtml(days, globalMax, isMobile ? 7 : null)}</div></div>`
        : '<p class="empty-note" style="font-size:0.78rem;margin:0">No history yet</p>';

      const todayGained =
        days?.find((d) => d.dayKey === todayKey)?.gained ?? null;
      const variant = checkVariant(a.status);
      const protection = protectionPresentation(a);
      const badgeStatus = { ok: "success", error: "error", running: "running", idle: "idle" }[
        variant
      ];

      const todayText =
        todayGained != null
          ? `+${todayGained.toLocaleString()}\u202fpts today`
          : a.status === "running"
            ? "Running\u2026"
            : "No run today";

      const dur =
        a.lastDurationSec != null ? U.fmtDuration(a.lastDurationSec) : null;
      const sub =
        a.status === "running"
          ? `<span class="hero-sub-running">Running\u2026 ${U.escapeHtml(U.fmtRelative(a.lastStartAt))}</span>`
          : dur
            ? `Last: ${U.escapeHtml(U.fmtRelative(a.lastEndAt || a.lastStartAt))} \u00b7 <span title="Last run duration">${U.escapeHtml(dur)}</span>`
            : `Last: ${U.escapeHtml(U.fmtRelative(a.lastEndAt || a.lastStartAt))}`;

      const isOpen = expanded.has(a.key);

      return `<div class="hero-row">
            <div class="hero-bar-cell">${barCell}</div>
            <div class="hero-acc-card">
                <div class="hero-acc-pts">
                    <span class="hero-pts-num">${a.lastPoints != null ? U.fmtNumber(a.lastPoints) : "\u2013"}</span>
                    <span class="hero-pts-unit">Points</span>
                </div>
                <div class="hero-acc-info">
                    <div class="hero-acc-name">${U.escapeHtml(label)}${a.configured ? "" : ' <span class="tag-mini">unconfigured</span>'}</div>
                    <div class="hero-acc-meta">
                        <span class="hero-acc-today">
                            ${U.statusPill(badgeStatus)}
                            <span>${U.escapeHtml(todayText)}</span>
                        </span>
                    </div>
                    <div class="hero-acc-sub">${sub}</div>
                    ${a.lastError ? `<div class="hero-acc-error">${U.escapeHtml(a.lastError)}</div>` : ""}
                </div>
                <div class="hero-acc-actions">
                    ${a.configured && Number.isInteger(a.index)
          ? `<button type="button" class="link-btn" data-run-account="${a.index}" ${!usable || running || launching.has(a.index)
            ? "disabled"
            : ""
          } title="Run only ACCOUNT_${a.index}">${launching.has(a.index) ? "Starting…" : "Run only"}</button>`
          : ""
        }
                    <button type="button" class="link-btn" data-trend="${U.escapeAttr(a.key)}" aria-pressed="${selected === a.key}">Trend</button>
                    <button type="button" class="link-btn" data-details="${U.escapeAttr(a.key)}" aria-pressed="${isOpen}">Details</button>
                </div>
                ${protection
          ? `<div class="hero-streak-row"><span class="pill ${protection.pillClass} hero-streak-pill" title="${U.escapeAttr(protection.streak)}; streak protection is ${protection.state.toLowerCase()}; ${U.escapeAttr(protection.days)}">Streak ${a.streakCounter == null ? "–" : U.escapeHtml(U.fmtNumber(a.streakCounter))} · Protection ${protection.state} · ${U.escapeHtml(protection.days)}</span></div>`
          : ""
        }
            </div>
            ${isOpen ? `<div class="hero-details">${detailsGrid(a)}</div>` : ""}
        </div>`;
    })
    .join("");

  container.querySelectorAll(".accum-track").forEach((track) => {
    track.scrollLeft = track.scrollWidth;
  });

  container.querySelectorAll("button[data-run-account]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const index = Number(btn.dataset.runAccount);
      const account = accounts.find((a) => a.index === index);
      if (account) runAccount(account);
    }),
  );

  container.querySelectorAll("button[data-details]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const key = btn.dataset.details;
      if (expanded.has(key)) expanded.delete(key);
      else expanded.add(key);
      render();
    }),
  );

  container.querySelectorAll("button[data-trend]").forEach((btn) =>
    btn.addEventListener("click", () => {
      selected = selected === btn.dataset.trend ? null : btn.dataset.trend;
      render();
      renderTrend();
      if (selected)
        U.$("#trendSection", rootEl).scrollIntoView({
          behavior: "smooth",
          block: "nearest",
        });
    }),
  );

  renderTrend();
}

function renderTrend() {
  const section = U.$("#trendSection", rootEl);
  section.hidden = !selected;
  if (!selected) return;

  const history = (payload.histories || {})[selected] || [];
  U.$("#trendName", rootEl).textContent = selected;

  lineChart(
    U.$("#trendChart", rootEl),
    history.map((h) => ({
      key: h.ts.slice(0, 10),
      value: h.points,
      label: U.fmtDateTime(h.ts),
    })),
    { emptyMessage: "No point history recorded for this account yet." },
  );
}

export default {
  id: "accounts",
  label: "Accounts",
  interval: 15000,

  mount(root, ctx) {
    rootEl = root;
    context = ctx;
    root.innerHTML = `
            <p class="notice notice--warn" id="accountsError" hidden></p>

            <section class="panel hero-panel" aria-labelledby="accounts-heading">
                <div class="hero-panel-header">
                    <h2 id="accounts-heading">Accounts</h2>
                    <span class="hero-panel-subtitle">Daily tracker, configuration &amp; per-account results</span>
                </div>
                <div class="hero-layout" id="heroRows">
                    <p class="empty-note" style="padding:1.25rem">Loading&hellip;</p>
                </div>
            </section>

            <section class="panel" id="trendSection" hidden aria-labelledby="trend-heading">
                <div class="panel-head">
                    <h2 id="trend-heading">Point total &mdash; <span id="trendName"></span></h2>
                    <span class="panel-sub">Every recorded balance, oldest to newest</span>
                </div>
                <div id="trendChart" class="chart-wrap"></div>
            </section>

            <p class="hint">Accounts are configured in the bot&rsquo;s <code>.env</code> (<code>ACCOUNT_N_*</code>).
            The control API exposes full local email addresses but never sends passwords, recovery addresses, TOTP secrets, or proxy credentials.
            Use <strong>Run only</strong> to launch just that account slot; the main Start button and scheduler still run all accounts.</p>`;
  },

  async refresh(ctx) {
    context = ctx;
    payload = await cached("accounts", ctx.api.accounts, 5000);
    render();
  },

  redraw() {
    render();
  },

  onState(_state, ctx) {
    context = ctx;
    render();
  },
};
