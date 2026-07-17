import * as U from "../util.js";
import { cached } from "../api.js";

let accountsPayload = null;
let rootEl = null;
let mounted = false;
let context = null;

const launching = new Set();

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

function controlState() {
  const status = context?.status;
  const usable = Boolean(status?.reachable && status?.authOk !== false);
  const running = Boolean(status?.botRunning);
  return { usable, running };
}

async function runAccount(account) {
  if (!context || !account.configured || !Number.isInteger(account.index)) return;

  launching.add(account.index);
  render(rootEl);
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
    render(rootEl);
  }
}

function earnableBadge(account) {
  const earnable = account.earnable || account.live?.earnable;
  const total = earnable
    ? Object.values(earnable).reduce((sum, points) => sum + (Number(points) || 0), 0)
    : 0;
  const cls = total > 0 ? "point-source point-source--target" : "point-source";
  return `<span class="${cls}"><strong>Earnable</strong> ${U.escapeHtml(U.fmtNumber(total))}</span>`;
}

function sourceBreakdown(account) {
  const bySource = account.live?.bySource || {};
  
  const chips = Object.entries(SOURCE_LABELS).map(([source, label]) => {
    const points = Number(bySource[source]) || 0;
    return `<span class="point-source"><strong>${U.escapeHtml(label)}</strong> ${U.escapeHtml(U.fmtSigned(points))}</span>`;
  });
  
  return chips.join("");
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

function renderAccountPanel(a, live) {
  const items = [];
  const protection = protectionPresentation(a);
  const { usable, running } = controlState();
  
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

  // Reuses overview state string conventions mapping directly to plain text
  let statusText = '';
  if (launching.has(a.index)) {
    statusText = 'Status: Starting...';
  } else if (live && running) {
    statusText = 'Status: Running...';
  } else {
    statusText = 'Status: Idle';
  }

  return `
    <div class="panel account-detail-panel">
        <div class="panel-head">
            <h2>${U.escapeHtml(a.email)}</h2>
        </div>
        <div class="panel-body">
            <dl class="kv">
                ${items.map(([k, v]) => `
                    <div>
                        <dt>${U.escapeHtml(k)}</dt>
                        <dd>${U.escapeHtml(String(v))}</dd>
                    </div>
                `).join("")}
            </dl>
        </div>
        <div class="account-today-row">
            <span class="account-today-label">Today:</span>
            
            <div class="account-today-chips">
                ${protection
                  ? `<span class="pill ${protection.pillClass}" title="${U.escapeAttr(protection.streak)}; streak protection is ${protection.state.toLowerCase()}; ${U.escapeAttr(protection.days)}">Protection ${protection.state} \u00b7 ${a.streakProtectionRemainingDays == null ? "days unavailable" : `${a.streakProtectionRemainingDays} day${a.streakProtectionRemainingDays === 1 ? "" : "s"} left`}</span>`
                  : ""
                }
                ${earnableBadge(live || {})}
                ${sourceBreakdown(live || {})}
            </div>
            
            <div class="account-today-actions">
                ${a.configured && Number.isInteger(a.index)
                  ? `<button type="button" class="btn btn-primary" data-run-account="${a.index}" ${!usable || running || launching.has(a.index) ? "disabled" : ""} title="Run only ACCOUNT_${a.index}">${launching.has(a.index) ? "Starting…" : "Run only"}</button>`
                  : ""
                }
                <span class="account-status-text">${statusText}</span>
            </div>
        </div>
    </div>`;
}

function render(root) {
  const container = U.$("#accountsContainer", root);
  const accounts = accountsPayload?.accounts || [];

  const liveByEmail = new Map(
    (context?.status?.bot?.run?.accounts || []).map((la) => [la.email, la]),
  );

  const errEl = U.$("#accountsError", root);
  if (errEl) {
    errEl.hidden = !accountsPayload?.apiError;
    if (accountsPayload?.apiError) errEl.textContent = accountsPayload.apiError;
  }

  if (!accounts.length) {
    container.innerHTML = '<p class="empty-note" style="padding:1.25rem">No accounts configured or observed yet.</p>';
    return;
  }

  container.innerHTML = accounts.map(a => {
    const live = liveByEmail.get(a.email) || null;
    return renderAccountPanel(a, live);
  }).join("");

  container.querySelectorAll("button[data-run-account]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const index = Number(btn.dataset.runAccount);
      const account = accounts.find((a) => a.index === index);
      if (account) runAccount(account);
    }),
  );
}

export default {
  id: "accounts",
  label: "Accounts",
  interval: 10000,

  mount(root, ctx) {
    rootEl = root;
    context = ctx;
    root.innerHTML = `
      <p class="notice notice--warn" id="accountsError" hidden></p>
      <div id="accountsContainer">
          <p class="empty-note" style="padding:1.25rem">Loading accounts configuration details&hellip;</p>
      </div>
      <p class="hint" style="margin-top: 1.5rem;">Accounts are configured in the bot&rsquo;s <code>.env</code> (<code>ACCOUNT_N_*</code>).
      The control API exposes full local email addresses but never sends passwords, recovery addresses, TOTP secrets, or proxy credentials.</p>
    `;
    mounted = true;
  },

  async refresh(ctx) {
    context = ctx;
    accountsPayload = await cached("accounts", ctx.api.accounts, 5000);
    this.redraw(ctx);
  },

  redraw(ctx) {
    context = ctx || context;
    if (!mounted || !accountsPayload) return;
    render(rootEl);
  }
};