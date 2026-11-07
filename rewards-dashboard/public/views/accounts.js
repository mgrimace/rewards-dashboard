import * as U from "../util.js";
import { cached } from "../api.js";
import {
  renderActivity,
  summaryChips,
  migrationChip,
  renderMigration,
  renderLoading,
  renderLoadError,
  pickDay,
} from "./activityTable.js";

let accountsPayload = null;
let rootEl = null;
let mounted = false;
let context = null;

const launching = new Set();
const selectedForBatch = new Set();
const expandedAccounts = new Set();
const expandedFeatures = new Set();
const expandedActivity = new Set(); // "email|day|group" rows opened in the points table
const selectedActivityDay = new Map(); // lower-cased email -> chosen Rewards day
let activityPayload = null; // GET /api/activity-days
let activityError = null; // last failure fetching it, if any
let batchRunning = false;

// Two-step delete: a key must be "armed" by a first click before a second
// click on the confirm button actually deletes anything, so there's no way
// to remove an account's dashboard data with a single accidental click.
const deleteArmed = new Set();
const deleting = new Set();

function controlState() {
  const status = context?.status;
  const usable = Boolean(status?.reachable && status?.authOk !== false);
  const running = Boolean(status?.botRunning);
  return { usable, running };
}

function selectableAccounts() {
  return (accountsPayload?.accounts || []).filter(
    (account) => account.configured && Number.isInteger(account.index),
  );
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

async function deleteAccount(account) {
  if (!context) return;

  deleteArmed.delete(account.key);
  expandedFeatures.delete(account.key);
  deleting.add(account.key);
  render(rootEl);
  try {
    await context.api.deleteDashboardAccount(account.email);
    context.toast(`Removed ${account.email} from the dashboard.`, "success");
    context.invalidate();
    await context.refresh();
  } catch (error) {
    context.toast(error.message, error.status === 409 ? "warn" : "error");
  } finally {
    deleting.delete(account.key);
    render(rootEl);
  }
}

async function runSelectedAccounts() {
  if (!context) return;
  const configured = selectableAccounts();
  const selectedIndexes = configured
    .filter((a) => selectedForBatch.has(a.index))
    .map((a) => a.index);
  if (!selectedIndexes.length) return;

  // The control API only accepts an exclusion list, so a "run these x of y"
  // request is expressed as "exclude everyone else".
  const excludedAccountIndexes = configured
    .filter((a) => !selectedForBatch.has(a.index))
    .map((a) => a.index);
  const startBody = excludedAccountIndexes.length ? { excludedAccountIndexes } : {};

  batchRunning = true;
  render(rootEl);
  try {
    await context.api.control("start", startBody);
    context.toast(
      `Started ${selectedIndexes.length}/${configured.length} selected accounts.`,
      "success",
    );
    context.invalidate();
    await context.refresh();
  } catch (error) {
    context.toast(error.message, error.status === 409 ? "warn" : "error");
  } finally {
    batchRunning = false;
    render(rootEl);
  }
}

function renderBatchToolbar(root) {
  const configured = selectableAccounts();
  const configuredIndexes = new Set(configured.map((a) => a.index));
  // Drop selections for accounts that disappeared (e.g. .env edited).
  for (const index of [...selectedForBatch]) {
    if (!configuredIndexes.has(index)) selectedForBatch.delete(index);
  }

  const { usable, running } = controlState();
  const count = selectedForBatch.size;
  const total = configured.length;

  U.$("#accountsSelectedCountValue", root).textContent = `${count}/${total}`;

  const allBtn = U.$("#accountsSelectAll", root);
  allBtn.checked = total > 0 && count === total;
  allBtn.indeterminate = count > 0 && count < total;
  allBtn.disabled = total === 0;

  const runBtn = U.$("#accountsRunSelected", root);
  runBtn.disabled = !usable || running || batchRunning || count === 0;
  U.$(".accounts-run-selected-label", runBtn).textContent = batchRunning ? "Starting\u2026" : "Run selected";
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

function kv(items) {
  return `<dl class="kv">${items
    .map(
      ([k, v]) =>
        `<div><dt>${U.escapeHtml(k)}</dt><dd>${U.escapeHtml(String(v))}</dd></div>`,
    )
    .join("")}</dl>`;
}

function detailGroups(a, protection) {
  const groups = [];

  groups.push([
    "Configuration",
    [
      ["Configured in .env", a.configured ? "Yes" : "No \u2014 seen in logs only"],
      ...(a.geoLocale ? [["Geo locale", a.geoLocale]] : []),
      ...(a.langCode ? [["Language", a.langCode]] : []),
      ...(a.hasTotp != null ? [["TOTP secret", a.hasTotp ? "Set" : "Not set"]] : []),
      ...(a.hasRecoveryEmail != null
        ? [["Recovery email", a.hasRecoveryEmail ? "Set" : "Not set"]]
        : []),
      [
        "Proxy",
        a.proxy
          ? `${a.proxy.url}${a.proxy.port ? `:${a.proxy.port}` : ""}${a.proxy.hasCredentials ? " (authenticated)" : ""}`
          : "None",
      ],
    ],
  ]);

  groups.push([
    "Run history",
    [
      ["Success streak", `${a.successStreak} run${a.successStreak === 1 ? "" : "s"}`],
      ["Runs recorded by the API", U.fmtNumber(a.apiRuns)],
      ["Points collected (API history)", U.fmtSigned(a.apiTotalCollected)],
      ["Last duration", U.fmtDuration(a.lastDurationSec)],
      ["History points loaded", U.fmtNumber(a.historyCount)],
    ],
  ]);

  return `<div class="acc-detail-groups">${groups
    .map(
      ([title, items]) => `
        <div class="acc-detail-group">
            <h3 class="acc-detail-group-title">${title}</h3>
            ${kv(items)}
        </div>`,
    )
    .join("")}</div>`;
}

function renderAccountPanel(a, live) {
  const protection = protectionPresentation(a);
  const { usable, running } = controlState();
  const displayStatus = U.accountDisplayStatus(
    a,
    live,
    Boolean(context?.status?.botRunning),
  );

  // Accounts now start one at a time (accountDelay), so mid-run there can be
  // several accounts that already finished this run while another is still
  // going - `live` just means "has a record in this run", true for both.
  // The stored account status remains the outcome source. A pending account
  // in the active Control API run can override only the watchdog's synthetic
  // stalled error for display, so finished account outcomes stay intact.
  // Mirrors overview.js: while waiting between accounts, the one named by
  // pendingDelay.nextEmail is up next, so it reads as "pending" rather than
  // whatever its last-observed status happened to be.
  const nextAccountEmail = context?.status?.pendingDelay?.nextEmail || null;
  const statusKey = launching.has(a.index)
    ? "starting"
    : U.sleepRemainingSec(context?.status) != null && a.configured
      ? "sleeping"
      : displayStatus !== "running" && nextAccountEmail && a.email === nextAccountEmail
      ? "pending"
      : displayStatus;

  const runButton =
    a.configured && Number.isInteger(a.index)
      ? `<button type="button" class="btn btn-primary btn-small acc-run-button" data-run-account="${a.index}" aria-label="Run only ACCOUNT_${a.index}" ${!usable || running || launching.has(a.index) ? "disabled" : ""
      } title="Run only ACCOUNT_${a.index}"><i class="ph ph-play acc-run-icon" aria-hidden="true"></i><span class="acc-run-label">${launching.has(a.index) ? "Starting\u2026" : "Run only"}</span></button>`
      : "";

  const selectCheckbox =
    a.configured && Number.isInteger(a.index)
      ? `<label class="check acc-batch-select" title="Include ACCOUNT_${a.index} in a batch run">
          <input type="checkbox" data-select-account="${a.index}" aria-label="Select ACCOUNT_${a.index} for a batch run" ${selectedForBatch.has(a.index) ? "checked" : ""}>
          <span>Select</span>
        </label>`
      : "";

  const isExpanded = expandedAccounts.has(a.key);
  const detailsId = `acc-details-${U.escapeAttr(a.key)}`;

  const isDeleting = deleting.has(a.key);
  const deleteBlocked = displayStatus === "running" || launching.has(a.index);
  const deleteButton = deleteArmed.has(a.key)
    ? `<span class="acc-delete-confirm">
        <button type="button" class="btn btn-icon btn-small" data-cancel-delete="${U.escapeAttr(a.key)}" aria-label="Cancel delete" ${isDeleting ? "disabled" : ""} title="Cancel delete"><i class="ph ph-x" aria-hidden="true"></i></button>
        <button type="button" class="btn btn-danger btn-icon btn-small" data-confirm-delete="${U.escapeAttr(a.key)}" aria-label="Confirm delete account" ${isDeleting ? "disabled" : ""} title="Permanently remove this account and its history from the dashboard">
          <i class="ph ph-trash" aria-hidden="true"></i>
        </button>
      </span>`
    : `<button type="button" class="btn btn-danger btn-icon btn-small" data-arm-delete="${U.escapeAttr(a.key)}" aria-label="Delete account" ${deleteBlocked ? "disabled" : ""} title="${deleteBlocked ? "The account must be idle to delete it" : "Remove this account and its history from the dashboard"}"><i class="ph ph-trash" aria-hidden="true"></i></button>`;

  const protectionChip = protection
    ? `<span class="account-rail-icon ${protection.pillClass}" role="img" aria-label="Streak protection ${protection.state.toLowerCase()}" title="Streak protection is ${protection.state.toLowerCase()}; ${U.escapeAttr(protection.days)}"><i class="ph ${a.streakProtectionEnabled ? "ph-shield-check" : "ph-shield"}" aria-hidden="true"></i></span>`
    : "";
  const status = U.pillParts(statusKey);
  const statusIcons = {
    full: "ph-check-circle",
    success: "ph-check-circle",
    partial: "ph-warning-circle",
    skipped: "ph-skip-forward-circle",
    done: "ph-check-circle",
    error: "ph-x-circle",
    crashed: "ph-x-circle",
    interrupted: "ph-pause-circle",
    stopped: "ph-pause-circle",
    running: "ph-circle-notch",
    starting: "ph-circle-notch",
    stopping: "ph-stop-circle",
    pending: "ph-clock",
    sleeping: "ph-moon",
    stalled: "ph-pause-circle",
    idle: "ph-minus-circle",
  };
  const statusRail = `
    <aside class="account-status-rail" aria-label="Account status">
      <span class="account-rail-icon ${status.cls}" role="img" aria-label="${U.escapeAttr(status.label)}" title="${U.escapeAttr(status.label)}"><i class="ph ${statusIcons[statusKey] || statusIcons.idle}" aria-hidden="true"></i></span>
    </aside>`;
  const featuresOpen = expandedFeatures.has(a.key);
  // Per-activity accounting from the stored run history. An account with no
  // data yet (a script upgraded from before v5) shows a migration notice until
  // its first full v5 run; an account the script skipped (for example for a
  // high bot score) shows that instead of an empty table.
  const emailKey = a.email.trim().toLowerCase();
  const actDays = activityPayload?.accounts?.[emailKey] || null;
  let activityBody;
  let activitySummary = "";
  if (actDays?.length) {
    activityBody = renderActivity(actDays, {
      email: emailKey,
      selectedDay: selectedActivityDay.get(emailKey),
      expanded: expandedActivity,
    });
    activitySummary = summaryChips(pickDay(actDays, selectedActivityDay.get(emailKey)));
  } else if (activityPayload?.synced) {
    activityBody = renderMigration(activityPayload.scriptMajor);
    activitySummary = migrationChip(activityPayload.scriptMajor);
  } else if (activityPayload?.syncError || activityError) {
    activityBody = renderLoadError(activityPayload?.syncError || activityError);
  } else {
    activityBody = renderLoading(activityPayload ? "Syncing run history\u2026" : undefined);
  }
  const featureDetails = `<details class="account-feature-details" data-feature-details="${U.escapeAttr(a.key)}" ${featuresOpen ? "open" : ""}>
      <summary><span class="acc-detail-toggle account-feature-caret" aria-hidden="true"><i class="ph ph-caret-right"></i></span><span>Activity Status</span>${activitySummary ? `<span class="act-summary-verdict">${activitySummary}</span>` : ""}</summary>
      ${activityBody}
    </details>`;

  return `
    <div class="panel account-detail-panel">
      <div class="account-primary-row">
        ${statusRail}
        <div class="account-card-main">
          <div class="panel-head">
            <h2>
                <button type="button" class="acc-detail-toggle" data-toggle-details="${U.escapeAttr(a.key)}" aria-expanded="${isExpanded}" aria-controls="${detailsId}" title="${isExpanded ? "Collapse details" : "Expand details"}"><i class="ph ph-caret-right" aria-hidden="true"></i></button>
              ${U.escapeHtml(a.email)}
            </h2>
            ${a.index != null ? `<span class="tag-mini acc-tag-account-id">ACCOUNT_${a.index}</span>` : ""}
            ${a.configured ? "" : '<span class="tag-mini">unconfigured</span>'}
          </div>
        </div>
        <span class="acc-detail-actions">${selectCheckbox}${runButton}</span>
      </div>
      <div class="panel-body account-detail-body" id="${detailsId}" ${isExpanded ? "" : "hidden"}>
        ${detailGroups(a, protection)}
      </div>
      <div class="account-secondary-row">
        <aside class="account-protection-rail" aria-label="Streak protection">${protectionChip}</aside>
        ${featureDetails}
        <div class="acc-feature-actions">${deleteButton}</div>
      </div>
    </div>`;
}

function render(root) {
  const container = U.$("#accountsContainer", root);
  const accounts = accountsPayload?.accounts || [];

  const liveByEmail = U.runAccountMap(context?.status);
  const errEl = U.$("#accountsError", root);
  if (errEl) {
    errEl.hidden = !accountsPayload?.apiError;
    if (accountsPayload?.apiError) errEl.textContent = accountsPayload.apiError;
  }

  if (!accounts.length) {
    container.innerHTML = '<p class="empty-note" style="padding:1.25rem">No accounts configured or observed yet.</p>';
    renderBatchToolbar(root);
    return;
  }

  container.innerHTML = accounts.map(a => {
    const live = liveByEmail.get(a.email.trim().toLowerCase()) || null;
    return renderAccountPanel(a, live);
  }).join("");

  container.querySelectorAll("button[data-run-account]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const index = Number(btn.dataset.runAccount);
      const account = accounts.find((a) => a.index === index);
      if (account) runAccount(account);
    }),
  );

  container.querySelectorAll("input[data-select-account]").forEach((input) =>
    input.addEventListener("change", () => {
      const index = Number(input.dataset.selectAccount);
      if (input.checked) selectedForBatch.add(index);
      else selectedForBatch.delete(index);
      renderBatchToolbar(root);
    }),
  );

  container.querySelectorAll("details[data-feature-details]").forEach((details) =>
    details.addEventListener("toggle", () => {
      const key = details.dataset.featureDetails;
      if (details.open) expandedFeatures.add(key);
      else expandedFeatures.delete(key);
    }),
  );

  container.querySelectorAll("select[data-act-day-select]").forEach((sel) =>
    sel.addEventListener("change", () => {
      const email = sel.dataset.actDaySelect;
      selectedActivityDay.set(email, sel.value);
      render(root);
      container
        .querySelector(`select[data-act-day-select="${CSS.escape(email)}"]`)
        ?.focus();
    }),
  );

  container.querySelectorAll("button[data-act-toggle]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const key = btn.dataset.actToggle;
      if (expandedActivity.has(key)) expandedActivity.delete(key);
      else expandedActivity.add(key);
      render(root);
      container
        .querySelector(`button[data-act-toggle="${CSS.escape(key)}"]`)
        ?.focus();
    }),
  );

  container.querySelectorAll("button[data-toggle-details]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const key = btn.dataset.toggleDetails;
      if (expandedAccounts.has(key)) expandedAccounts.delete(key);
      else expandedAccounts.add(key);
      render(root);
    }),
  );

  container.querySelectorAll("button[data-arm-delete]").forEach((btn) =>
    btn.addEventListener("click", () => {
      deleteArmed.add(btn.dataset.armDelete);
      render(root);
    }),
  );

  container.querySelectorAll("button[data-cancel-delete]").forEach((btn) =>
    btn.addEventListener("click", () => {
      deleteArmed.delete(btn.dataset.cancelDelete);
      render(root);
    }),
  );

  container.querySelectorAll("button[data-confirm-delete]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const key = btn.dataset.confirmDelete;
      const account = accounts.find((a) => a.key === key);
      if (account) deleteAccount(account);
    }),
  );

  renderBatchToolbar(root);
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
      <div class="panel batch-select-box" id="accountsBatchToolbar">
          <div class="batch-select-header">
              <h2 class="batch-select-title">Batch run</h2>
              <div class="batch-select-controls">
                  <label class="check">
                      <input type="checkbox" id="accountsSelectAll">
                      <span>Select all</span>
                  </label>
                  <span class="hint" id="accountsSelectedCount"><span id="accountsSelectedCountValue">0/0</span><span class="accounts-selected-label"> selected</span></span>
                  <button type="button" class="btn btn-primary btn-small accounts-run-selected" id="accountsRunSelected" aria-label="Run selected accounts" title="Run selected accounts" disabled><i class="ph ph-play accounts-run-selected-icon" aria-hidden="true"></i><span class="accounts-run-selected-label">Run selected</span></button>
              </div>
          </div>
      </div>
      <div id="accountsContainer">
          <p class="empty-note" style="padding:1.25rem">Loading accounts configuration details&hellip;</p>
      </div>
      <p class="hint" style="margin-top: 1.5rem;">Accounts are configured in the bot&rsquo;s <code>.env</code> (<code>ACCOUNT_N_*</code>).
      The control API exposes full local email addresses but never sends passwords, recovery addresses, TOTP secrets, or proxy credentials.</p>
    `;
    mounted = true;

    U.$("#accountsSelectAll", root).addEventListener("change", (e) => {
      const configured = selectableAccounts();
      if (e.target.checked) configured.forEach((a) => selectedForBatch.add(a.index));
      else selectedForBatch.clear();
      render(root);
    });

    U.$("#accountsRunSelected", root).addEventListener("click", () => {
      runSelectedAccounts();
    });
  },

  async refresh(ctx) {
    context = ctx;
    // Don't rebuild the DOM underneath an open day picker.
    if (document.activeElement?.matches?.("select[data-act-day-select]")) return;
    const [accounts, activity] = await Promise.all([
      cached("accounts", ctx.api.accounts, 5000),
      cached("activityDays", () => ctx.api.activityDays(), 5000).catch((e) => {
        activityError = e?.message || "request failed";
        return null;
      }),
    ]);
    accountsPayload = accounts;
    if (activity) {
      activityPayload = activity;
      activityError = null;
    }
    this.redraw(ctx);
  },

  redraw(ctx) {
    context = ctx || context;
    if (!mounted || !accountsPayload) return;
    render(rootEl);
  }
};