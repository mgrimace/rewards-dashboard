import { themes } from "./themes/index.js";
import {
  applyTheme,
  getStoredThemeId,
  setStoredThemeId,
  getStoredMode,
  setStoredMode,
  systemPrefersDark,
} from "./themeManager.js";

import { api, invalidate } from "./api.js";
import * as U from "./util.js";

import overview from "./views/overview.js";
import accounts from "./views/accounts.js";
import logs from "./views/logs.js";
import runs from "./views/runs.js";
import schedule from "./views/schedule.js";
import configView from "./views/config.js";
import diagnostics from "./views/diagnostics.js";

const VIEWS = [
  overview,
  accounts,
  logs,
  runs,
  schedule,
  configView,
  diagnostics,
];

const els = {
  statusBadge: U.$("#statusBadge"),
  statusText: U.$("#statusText"),
  modeToggle: U.$("#modeToggle"),
  modeIcon: U.$("#modeIcon"),
  themeSelect: U.$("#themeSelect"),
  tabBar: U.$("#tabBar"),
  tabPanels: U.$("#tabPanels"),
  ctlPill: U.$("#ctlPill"),
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
  footerRefresh: U.$("#footerRefresh"),
  footerUpdated: U.$("#footerUpdated"),
};

const state = {
  status: null,
  codes: [],
  activeTab: null,
  streamOpen: false,
};

const mounted = new Set();
let refreshTimer = null;
let knownCodeKeys = new Set();

const ctx = {
  api,
  invalidate,
  toast: U.toast,
  get status() {
    return state.status;
  },
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
    mounted.add(view.id);
  }

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
  const es = new EventSource("/api/events");

  es.addEventListener("open", () => {
    state.streamOpen = true;
  });

  es.addEventListener("state", (e) => {
    state.streamOpen = true;
    applyState(JSON.parse(e.data));
  });

  es.addEventListener("log", (e) => {
    const entry = JSON.parse(e.data);
    currentView()?.onLog?.(entry, ctx);
  });

  es.addEventListener("codes", (e) => {
    setCodes(JSON.parse(e.data).codes || []);
  });

  es.addEventListener("reset", () => {
    for (const v of VIEWS) v.onReset?.(ctx);
    U.toast("Control API restarted — reconnected.", "warn");
  });

  es.onerror = () => {
    state.streamOpen = false;
    renderStatusBadge();
  };
}

function applyState(next) {
  state.status = next;
  U.setTimeZone(next.timezone);
  setCodes(next.codes || []);
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

  if (!state.streamOpen && !s) {
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
  } else if (s.botRunning) {
    badge.classList.add("status-live");
    els.statusText.textContent = "Running now";
  } else {
    badge.classList.add("status-live");
    els.statusText.textContent = "Connected";
  }
  badge.title = s?.lastError || "";
}

function renderFooter() {
    // Use the els object instead of querying the DOM every time
    const { footerStatus, footerRefresh, footerUpdated } = els;

    if (!footerStatus) return;

    const s = state.status;

    footerStatus.textContent =
        !s
            ? "Connecting…"
            : !s.reachable
                ? "Disconnected"
                : s.botRunning
                    ? "Running"
                    : "Connected";

    footerRefresh.textContent =
        `Auto-refresh ${(currentView()?.interval ?? 0) / 1000}s`;

    footerUpdated.textContent =
        `Updated ${new Date().toLocaleTimeString()}`;
}

function renderControlStrip() {
  const s = state.status;
  const botState = s?.botState || "unknown";
  const usable = Boolean(s?.reachable && s?.authOk !== false);
  const running = botState !== "idle" && botState !== "unknown";

  const { cls, label } = U.pillParts(
    botState === "unknown" ? "idle" : botState,
  );
  els.ctlPill.className = `pill ${cls}`;
  els.ctlPill.textContent = label;

  const bot = s?.bot;
  const bits = [];
  if (running && bot?.pid) bits.push(`pid ${bot.pid}`);
  if (running && bot?.startedAt)
    bits.push(`started ${U.fmtRelative(bot.startedAt)}`);
  if (bot?.run?.accountsTotal)
    bits.push(`${bot.run.accountsSeen || 0}/${bot.run.accountsTotal} accounts`);
  if (running && bot?.run?.collected != null)
    bits.push(`${U.fmtSigned(bot.run.collected)} pts`);
  if (!running && s?.schedule?.enabled && s.schedule.nextRunAt) {
    bits.push(`next run ${U.fmtDateTime(s.schedule.nextRunAt)}`);
  }
  if (!running && !bits.length && bot?.lastExit) {
    bits.push(
      `last exit: code ${bot.lastExit.code ?? "n/a"}${bot.lastExit.signal ? ` / ${bot.lastExit.signal}` : ""}`,
    );
  }
  els.ctlDetail.textContent =
    bits.join(" \u00b7 ") || (usable ? "Ready" : "Control API unavailable");

  els.btnStart.disabled = !usable || running;
  els.btnStop.disabled = !usable || !running;
  els.btnRestart.disabled = !usable;
  els.btnForceStop.disabled = !usable || !running;
  els.btnShutdown.disabled = !usable;
}

async function control(action, body, { confirm: confirmMsg, success } = {}) {
  if (confirmMsg && !window.confirm(confirmMsg)) return;
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

const codeKey = (c) => `${c.userName}:${c.number}:${c.issuedAt}`;

function setCodes(codes) {
  state.codes = codes;
  const fresh = codes.filter((c) => !knownCodeKeys.has(codeKey(c)));
  if (fresh.length) {
    els.loginCodesAnnounce.textContent = fresh
      .map(
        (c) =>
          `Login approval needed for ${c.userName}: select number ${c.number}. Expires in 60 seconds.`,
      )
      .join(" ");
  }
  knownCodeKeys = new Set(codes.map(codeKey));
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
                        <span class="login-code-countdown ${secsLeft <= 15 ? "urgent" : ""}">Expires in ${secsLeft}s</span>
                    </div>
                </div>`;
    })
    .join("");
}

// init

initTheme();
initControls();
initTabs();
connectStream();

setInterval(renderCodes, 1000);
window.addEventListener("focus", () => refreshActive(true));
window.addEventListener(
  "resize",
  U.debounce(() => redrawActive(), 200),
);
