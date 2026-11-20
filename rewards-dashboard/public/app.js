import { themes } from "./themes/index.js";
import {
  applyTheme,
  getStoredThemeId,
  setStoredThemeId,
  getStoredMode,
  setStoredMode,
  systemPrefersDark,
} from "./themeManager.js";

import { api, invalidate, selectedServer, selectServer } from "./api.js";
import { setServerPresentation } from "./serverViews.js";
import * as U from "./util.js";

import overview from "./views/overview.js";
import accounts from "./views/accounts.js";
import logs from "./views/logs.js";
import runs from "./views/runs.js";
import schedule from "./views/schedule.js";
import configView from "./views/config.js";
import diagnostics from "./views/diagnostics.js";
import connections from "./views/connections.js";

function initVersion() {
  const version = window.APP_VERSION || "Development";

  if (els.footerVersion) {
    els.footerVersion.textContent = `Microsoft Rewards Dashboard:${version}`;
  }
}

const VIEWS = [
  overview,
  accounts,
  logs,
  runs,
  schedule,
  configView,
  diagnostics,
  connections,
];
const TARGETED_VIEWS = new Set(["schedule", "config", "diagnostics"]);

const els = {
  statusBadge: U.$("#statusBadge"),
  statusText: U.$("#statusText"),
  modeToggle: U.$("#modeToggle"),
  modeIcon: U.$("#modeIcon"),
  themeSelect: U.$("#themeSelect"),
  tabBar: U.$("#tabBar"),
  tabPanels: U.$("#tabPanels"),
  ctlPill: U.$("#ctlPill"),
  serverSelect: U.$("#serverSelect"),
  ctlDetail: U.$("#ctlDetail"),
  btnStart: U.$("#btnStart"),
  btnStop: U.$("#btnStop"),
  btnRestart: U.$("#btnRestart"),
  btnMore: U.$("#btnMore"),
  ctlMenu: U.$("#ctlMenu"),
  btnForceStop: U.$("#btnForceStop"),
  btnShutdown: U.$("#btnShutdown"),
  loginCodesSection: U.$("#loginCodesSection"),
  loginCodesList: U.$("#loginCodesList"),
  loginCodesAnnounce: U.$("#loginCodesAnnounce"),
  footerStatus: U.$("#footerStatus"),
  footerScriptVersion: U.$("#footerScriptVersion"),
  footerVersion: U.$("#footerVersion"),
};

const state = {
  status: null,
  statuses: new Map(),
  serverCodes: new Map(),
  serverNames: new Map(),
  servers: [],
  configuredCount: 0,
  codes: [],
  activeTab: null,
  streamOpen: false,
};

const mounted = new Set();
let refreshTimer = null;
let sleepWasShown = false;
let knownCodeKeys = new Set();

const ctx = {
  api,
  invalidate,
  toast: U.toast,
  get status() {
    return state.status;
  },
  statusFor: (id) => state.statuses.get(id),
  refresh: () => refreshActive(true),
};

// theme

let currentThemeId = null;
let currentMode = "light";

const findTheme = (id) => themes.find((t) => t.id === id) || themes[0] || null;

function setMode(mode, persist) {
  currentMode = mode;
  els.modeIcon.textContent = mode === "dark" ? "\u2600" : "\u263D";
  const label =
    mode === "dark" ? "Switch to light mode" : "Switch to dark mode";
  els.modeToggle.setAttribute("aria-label", label);
  els.modeToggle.title = label;
  if (persist) setStoredMode(mode);
  const theme = findTheme(currentThemeId);
  if (theme) applyTheme(theme, currentMode);
  redrawActive();
}

function setTheme(id, persist) {
  const theme = findTheme(id);
  if (!theme) return;
  currentThemeId = theme.id;
  els.themeSelect.value = theme.id;
  if (persist) setStoredThemeId(theme.id);
  applyTheme(theme, currentMode);
}

function initTheme() {
  if (!themes.length) return;
  els.themeSelect.innerHTML = themes
    .map(
      (t) =>
        `<option value="${U.escapeAttr(t.id)}">${U.escapeHtml(t.name)}</option>`,
    )
    .join("");

  const storedThemeId = getStoredThemeId();
  currentMode = getStoredMode() || (systemPrefersDark() ? "dark" : "light");
  setTheme(
    storedThemeId && findTheme(storedThemeId) ? storedThemeId : themes[0].id,
    false,
  );
  setMode(currentMode, false);

  els.themeSelect.addEventListener("change", () =>
    setTheme(els.themeSelect.value, true),
  );
  els.modeToggle.addEventListener("click", () =>
    setMode(currentMode === "dark" ? "light" : "dark", true),
  );
}

// tabs

function initTabs() {
  els.tabBar.innerHTML = VIEWS.map(
    (v) => `<button type="button" role="tab" class="tab" id="tab-btn-${v.id}"
                 aria-controls="tab-panel-${v.id}" aria-selected="false" data-tab="${v.id}">${U.escapeHtml(v.label)}</button>`,
  ).join("");

  els.tabPanels.innerHTML = VIEWS.map(
    (v) =>
      `<div class="tab-panel" id="tab-panel-${v.id}" role="tabpanel" aria-labelledby="tab-btn-${v.id}" hidden></div>`,
  ).join("");

  els.tabBar.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-tab]");
    if (btn) location.hash = btn.dataset.tab;
  });

  els.tabBar.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const i = VIEWS.findIndex((v) => v.id === state.activeTab);
    const next =
      VIEWS[
      (i + (e.key === "ArrowRight" ? 1 : VIEWS.length - 1)) % VIEWS.length
      ];
    location.hash = next.id;
    U.$(`#tab-btn-${next.id}`)?.focus();
    e.preventDefault();
  });

  window.addEventListener("hashchange", () => activate(location.hash.slice(1)));
  activate(location.hash.slice(1));
}

function activate(id) {
  const view = VIEWS.find((v) => v.id === id) || VIEWS[0];
  if (state.activeTab === view.id) return;
  state.activeTab = view.id;

  for (const v of VIEWS) {
    const on = v.id === view.id;
    U.$(`#tab-btn-${v.id}`).setAttribute("aria-selected", String(on));
    U.$(`#tab-btn-${v.id}`).classList.toggle("tab--active", on);
    U.$(`#tab-panel-${v.id}`).hidden = !on;
  }

  const panel = U.$(`#tab-panel-${view.id}`);
  if (!mounted.has(view.id)) {
    view.mount(panel, ctx);
    if (TARGETED_VIEWS.has(view.id)) mountTargetContent(panel);
    mounted.add(view.id);
  }

  renderServerTarget();
  refreshActive(true);

  clearInterval(refreshTimer);
  if (view.interval)
    refreshTimer = setInterval(() => refreshActive(false), view.interval);
}

function currentView() {
  return VIEWS.find((v) => v.id === state.activeTab);
}

async function refreshActive(force) {
  const view = currentView();
  if (!view || !view.refresh) return;
  if (TARGETED_VIEWS.has(view.id) && !selectedServer()) return;
  if (force) invalidate();
  try {
    await view.refresh(ctx);
    renderFooter();
  } catch (e) {
    console.error(`[${view.id}] refresh failed`, e);
  }
}

function redrawActive() {
  const view = currentView();
  if (view?.redraw) view.redraw(ctx);
}

// live

function connectStream() {
  const es = new EventSource(`/api/events?serverId=${encodeURIComponent(selectedServer())}`);

  es.addEventListener("open", () => {
    state.streamOpen = true;
    renderStatusBadge();
  });

  es.addEventListener("state", (e) => {
    state.streamOpen = true;
    const next = JSON.parse(e.data);
    if (next.serverId) {
      state.statuses.set(next.serverId, next);
      setCodes(next.serverId, next.codes || []);
    }
    if (!next.serverId || next.serverId === selectedServer()) applyState(next);
    else currentView()?.onState?.(next, ctx);
  });

  es.addEventListener("log", (e) => {
    const entry = JSON.parse(e.data);
    currentView()?.onLog?.(entry, ctx);
  });

  es.addEventListener("codes", (e) => {
    const payload = JSON.parse(e.data);
    if (payload.serverId) setCodes(payload.serverId, payload.codes || []);
  });

  es.addEventListener("reset", (e) => {
    const { serverId } = JSON.parse(e.data);
    for (const v of VIEWS) v.onReset?.(serverId, ctx);
    if (serverId === selectedServer()) U.toast("Control API restarted — reconnected.", "warn");
  });

  es.addEventListener("connections", (e) => {
    const list = JSON.parse(e.data).connections || [];
    if (selectedServer() && !list.some((item) => item.id === selectedServer() && item.enabled)) {
      selectServer("");
      location.reload();
      return;
    }
    if (!selectedServer() && list.length === 1 && list[0].enabled) {
      selectServer(list[0].id);
      location.reload();
      return;
    }
    renderServerSelect(list);
    if (state.activeTab === "connections") refreshActive(true);
    currentView()?.onConnections?.(list, ctx);
    if (["overview", "accounts", "runs"].includes(state.activeTab)) refreshActive(true);
  });

  es.onerror = () => {
    state.streamOpen = false;
    renderStatusBadge();
  };
}

function applyState(next) {
  state.status = next;
  U.setTimeZone(next.timezone);
  renderStatusBadge();
  renderControlStrip();
  renderFooter();
  currentView()?.onState?.(next, ctx);
}

// status
function renderStatusBadge() {
  const s = state.status;
  const badge = els.statusBadge;
  badge.classList.remove(
    "status-live",
    "status-warn",
    "status-down",
    "status-unknown",
  );

  if (!selectedServer() && state.streamOpen) {
    badge.classList.add("status-unknown");
    els.statusText.textContent = state.configuredCount === 0
      ? "Add a server in Connections"
      : state.configuredCount === 1 && state.servers.length === 0
        ? "Enable the server in Connections"
        : "Select a server for controls";
  } else if (!state.streamOpen && !s) {
    badge.classList.add("status-down");
    els.statusText.textContent = "Dashboard server unreachable";
  } else if (!s) {
    badge.classList.add("status-unknown");
    els.statusText.textContent = "Connecting\u2026";
  } else if (!s.reachable) {
    badge.classList.add("status-down");
    els.statusText.textContent = "Bot backend offline";
  } else if (s.authOk === false) {
    badge.classList.add("status-warn");
    els.statusText.textContent = "Control API token rejected";
  } else {
    badge.classList.add("status-live");
    els.statusText.textContent = "Connected";
  }
  badge.title = s?.lastError || "";
}

function renderFooter() {
    // Use the els object instead of querying the DOM every time
    const { footerStatus, footerScriptVersion } = els;

    if (!footerStatus) return;

    const s = state.status;
    const outcome = s?.botOutcome;

    footerStatus.textContent = !s
        ? "Connecting…"
        : !s.reachable
          ? "Disconnected"
          : outcome === "error"
            ? "Error"
            : outcome === "interrupted"
              ? "Interrupted"
            : outcome === "stopped"
              ? "Stopped"
            : outcome === "success"
              ? "Success"
              : s.botRunning
                ? "Running"
                : "Connected";

    footerScriptVersion.textContent =
        `Microsoft Rewards Script:${s?.version || "\u2013"}`;
}

function renderControlStrip() {
  const s = state.status;
  const botState = s?.botState || "unknown";
  const outcome = s?.botOutcome;
  const usable = Boolean(s?.reachable && s?.authOk !== false);
  const running = Boolean(s?.botRunning);

  const sleepSec = U.sleepRemainingSec(s);
  const wasSleeping = sleepWasShown;
  sleepWasShown = sleepSec != null;
  if (wasSleeping && !sleepWasShown) redrawActive();
  const { cls, label } = U.pillParts(
    sleepSec != null
      ? "sleeping"
      : outcome || (botState === "unknown" ? "idle" : botState),
  );
  els.ctlPill.className = `pill ${cls}`;
  els.ctlPill.textContent = label;

  const bot = s?.bot;
  const run = bot?.run;
  const bits = [];
  if (sleepSec != null) {
    bits.push(`run starts in ${U.fmtDuration(sleepSec)}`);
  } else if (running) {
    if (bot?.pid) bits.push(`pid ${bot.pid}`);
    if (bot?.startedAt) bits.push(`started ${U.fmtRelativeDetailed(bot.startedAt)}`);
    if (run?.accountsTotal)
      bits.push(`${run.accountsSeen || 0}/${run.accountsTotal} accounts`);
    if (run?.collected != null) bits.push(`${U.fmtSigned(run.collected)} pts`);
  } else if (outcome) {
    const processed = run?.accountsSeen || run?.totals?.accountsProcessed || run?.accountsTotal;
    if (processed) bits.push(`${processed} accounts processed`);
    if (run?.collected != null && run.collected !== 0)
      bits.push(`${U.fmtSigned(run.collected)} pts earned`);
  }
  if (!running && s?.schedule?.enabled && s.schedule.nextRunAt) {
    bits.push(`next run ${U.fmtDateTime(s.schedule.nextRunAt)}`);
  }
  if (!running && !bits.length && bot?.lastExit) {
    bits.push(
      `last exit: code ${bot.lastExit.code ?? "n/a"}${bot.lastExit.signal ? ` / ${bot.lastExit.signal}` : ""}`,
    );
  }
  U.renderTicker(
    els.ctlDetail,
    bits.join(" \u00b7 ") || (usable ? "Ready" : "Control API unavailable"),
  );

  els.btnStart.disabled = !usable || running;
  els.btnStop.disabled = !usable || !running;
  els.btnRestart.disabled = !usable;
  els.btnForceStop.disabled = !usable || !running;
  els.btnShutdown.disabled = !usable;
}

async function control(action, body, { confirm: confirmMsg, success } = {}) {
  const name = els.serverSelect.selectedOptions[0]?.textContent || "";
  if (!selectedServer()) {
    U.toast("Select a server first.", "warn");
    return;
  }
  if (confirmMsg && !window.confirm(`${confirmMsg}\n\nServer: ${name}`)) return;
  try {
    await api.control(action, body || {});
    U.toast(success || `${action} sent.`, "success");
  } catch (e) {
    U.toast(e.message, e.status === 409 ? "warn" : "error");
  }
}

function initControls() {
  els.btnStart.addEventListener("click", () =>
    control("start", {}, { success: "Run started." }),
  );
  els.btnStop.addEventListener("click", () =>
    control("stop", { force: false }, { success: "Stop signal sent." }),
  );
  els.btnRestart.addEventListener("click", () =>
    control(
      "restart",
      {},
      {
        confirm: "Restart the bot? A run in progress will be stopped first.",
        success: "Restarting\u2026",
      },
    ),
  );
  els.btnForceStop.addEventListener("click", () => {
    closeMenu();
    control(
      "stop",
      { force: true },
      {
        confirm: "Force-kill the run (SIGKILL)? It gets no chance to clean up.",
        success: "Force stop sent.",
      },
    );
  });
  els.btnShutdown.addEventListener("click", () => {
    closeMenu();
    control(
      "shutdown",
      {},
      {
        confirm:
          "Shut the control API down? The dashboard will go offline until you start it again on the bot host.",
        success: "Shutdown sent.",
      },
    );
  });

  els.btnMore.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = els.ctlMenu.hidden;
    els.ctlMenu.hidden = !open;
    els.btnMore.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("click", closeMenu);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenu();
  });
}

function closeMenu() {
  els.ctlMenu.hidden = true;
  els.btnMore.setAttribute("aria-expanded", "false");
}

// login code

const codeKey = (c) => `${c.serverId}:${c.userName}:${c.number}:${c.issuedAt}`;

function setCodes(serverId, codes) {
  state.serverCodes.set(serverId, codes);
  state.codes = [...state.serverCodes].flatMap(([id, list]) =>
    list.map((code) => ({ ...code, serverId: id, serverName: state.serverNames.get(id) || id })));
  const fresh = state.codes.filter((c) => !knownCodeKeys.has(codeKey(c)));
  if (fresh.length) {
    els.loginCodesAnnounce.textContent = fresh
      .map(
        (c) =>
          `Login approval needed on ${c.serverName} for ${c.userName}: select number ${c.number}. Expires in 60 seconds.`,
      )
      .join(" ");
  }
  knownCodeKeys = new Set(state.codes.map(codeKey));
  renderCodes();
}

function renderCodes() {
  state.codes = state.codes.filter((c) => Date.parse(c.expiresAt) > Date.now());
  els.loginCodesSection.hidden = state.codes.length === 0;
  if (!state.codes.length) return;

  els.loginCodesList.innerHTML = state.codes
    .map((c) => {
      const secsLeft = Math.max(
        0,
        Math.round((Date.parse(c.expiresAt) - Date.now()) / 1000),
      );
      return `
                <div class="login-code-card">
                    <div class="login-code-number">${U.escapeHtml(c.number)}</div>
                    <div class="login-code-info">
                        <span class="login-code-name">${U.escapeHtml(c.userName)}</span>
                        <span class="login-code-name multi-server-only">${U.escapeHtml(c.serverName)}</span>
                        <span class="login-code-countdown ${secsLeft <= 15 ? "urgent" : ""}">Expires in ${secsLeft}s</span>
                    </div>
                </div>`;
    })
    .join("");
}

// init

function renderServerSelect(list) {
  setServerPresentation(list, document.documentElement);
  state.configuredCount = list.length;
  const enabled = list.filter((item) => item.enabled);
  state.servers = enabled;
  state.serverNames = new Map(enabled.map((item) => [item.id, item.name]));
  for (const id of state.serverCodes.keys()) {
    if (!state.serverNames.has(id)) state.serverCodes.delete(id);
  }
  for (const id of state.statuses.keys()) {
    if (!state.serverNames.has(id)) state.statuses.delete(id);
  }
  state.codes = [...state.serverCodes].flatMap(([id, codes]) =>
    codes.map((code) => ({ ...code, serverId: id, serverName: state.serverNames.get(id) || id })));
  renderCodes();
  renderServerTarget();
  renderStatusBadge();
}

function renderServerTarget() {
  const options = '<option value="">Select a server</option>' +
    state.servers.map((item) => `<option value="${U.escapeAttr(item.id)}">${U.escapeHtml(item.name)}</option>`).join("");
  els.serverSelect.innerHTML = options;
  els.serverSelect.value = selectedServer();
  els.serverSelect.disabled = state.servers.length === 0;
  for (const panel of els.tabPanels.querySelectorAll("[data-target-content]")) {
    panel.hidden = !selectedServer();
    panel.previousElementSibling.hidden = Boolean(selectedServer());
  }
}

function changeTarget(select) {
  const previous = selectedServer();
  if (select.value === previous) return;
  if (currentView()?.canChangeServer?.() === false) {
    select.value = previous;
    return;
  }
  selectServer(select.value);
  location.reload();
}

function mountTargetContent(panel) {
  const content = document.createElement("div");
  content.dataset.targetContent = "";
  while (panel.firstChild) content.appendChild(panel.firstChild);
  panel.innerHTML = `<p class="empty-note">Select an enabled server in the control bar, or enable one in Connections, to use this tab.</p>`;
  panel.appendChild(content);
}

async function init() {
  initVersion();
  initTheme();
  try {
    const list = (await api.connections()).connections || [];
    const enabled = list.filter((item) => item.enabled);
    if (!enabled.some((item) => item.id === selectedServer())) selectServer("");
    if (!selectedServer() && enabled.length === 1) selectServer(enabled[0].id);
    renderServerSelect(list);
  } catch (error) {
    renderServerSelect([]);
    U.toast(error.message, "error");
  }
  els.serverSelect.addEventListener("change", () => changeTarget(els.serverSelect));
  initControls();
  initTabs();
  connectStream();
}

void init();

setInterval(renderCodes, 1000);
setInterval(() => {
  if (U.sleepRemainingSec(state.status) != null || sleepWasShown) {
    renderControlStrip();
    currentView()?.onTick?.(ctx);
  }
}, 1000);
// While a run is active, the "started Xh Ym ago" text in the control strip
// only changes with the clock, not with SSE pushes, so repaint it on a timer.
setInterval(() => {
  if (state.status?.botRunning) renderControlStrip();
}, 15000);
window.addEventListener("focus", () => refreshActive(true));
window.addEventListener(
  "resize",
  U.debounce(() => {
    redrawActive();
    renderControlStrip();
  }, 200),
);