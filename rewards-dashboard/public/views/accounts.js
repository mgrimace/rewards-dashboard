import * as U from "../util.js";
import { combineAccounts, loadServers } from "../serverViews.js";
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
let groups = [];
let includeHistory = false;
let refreshSequence = 0;
let batchRunning = false;

// Two-step delete: a key must be "armed" by a first click before a second
// click on the confirm button actually deletes anything, so there's no way
// to remove an account's dashboard data with a single accidental click.
const deleteArmed = new Set();
const deleteArmedAt = new Map(); // key -> when armed; see U.confirmReady
const deleting = new Set();

function statusFor(serverId) {
  const group = groups.find((item) => item.server.id === serverId);
  return group?.archived ? group.summary?.status : context?.statusFor(serverId) || group?.summary?.status;
}

function controlState(serverId) {
  const status = statusFor(serverId);
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

  launching.add(account.key);
  render(rootEl);
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
    render(rootEl);
  }
}

async function deleteAccount(account) {
  if (!context) return;

  deleteArmed.delete(account.key);
  deleteArmedAt.delete(account.key);
  expandedFeatures.delete(account.key);
  deleting.add(account.key);
  render(rootEl);
  try {
    await context.api.forServer(account.serverId).deleteDashboardAccount(account.email);
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
  const targets = groups.filter((group) => configured.some((a) =>
    a.serverId === group.server.id && selectedForBatch.has(a.key)));
  if (!targets.length) return;
  if (targets.length > 1 && !window.confirm(`Start selected accounts on these servers?\n\n${targets.map((g) => g.server.name).join("\n")}`)) return;

  batchRunning = true;
  render(rootEl);
  try {
    const results = await Promise.allSettled(targets.map((group) => {
      const serverAccounts = configured.filter((a) => a.serverId === group.server.id);
      const excludedAccountIndexes = serverAccounts.filter((a) => !selectedForBatch.has(a.key)).map((a) => a.index);
      return context.api.forServer(group.server.id).control("start", excludedAccountIndexes.length ? { excludedAccountIndexes } : {});
    }));
    const failures = results.flatMap((result, index) => result.status === "rejected" ? [`${targets[index].server.name}: ${result.reason.message}`] : []);
    context.toast(failures.length ? `Some runs failed: ${failures.join(" · ")}` : `Started selected accounts on ${targets.length} server(s).`, failures.length ? "error" : "success");
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
  const configuredIndexes = new Set(configured.map((a) => a.key));
  // Drop selections for accounts that disappeared (e.g. .env edited).
  for (const index of [...selectedForBatch]) {
    if (!configuredIndexes.has(index)) selectedForBatch.delete(index);
  }

  const count = selectedForBatch.size;
  const total = configured.length;

  U.$("#accountsSelectedCountValue", root).textContent = `${count}/${total}`;

  const allBtn = U.$("#accountsSelectAll", root);
  allBtn.checked = total > 0 && count === total;
  allBtn.indeterminate = count > 0 && count < total;
  allBtn.disabled = total === 0;

  const runBtn = U.$("#accountsRunSelected", root);
  runBtn.disabled = batchRunning || count === 0 || configured.some((account) => {
    const { usable, running } = controlState(account.serverId);
    return selectedForBatch.has(account.key) && (!usable || running);
  });
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
  const status = statusFor(a.serverId);
  const { usable, running } = controlState(a.serverId);
  const displayStatus = U.accountDisplayStatus(
    a,
    live,
    Boolean(status?.botRunning),
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
  const nextAccountEmail = status?.pendingDelay?.nextEmail || null;
  const statusKey = launching.has(a.key)
    ? "starting"
    : U.sleepRemainingSec(status) != null && a.configured
      ? "sleeping"
      : displayStatus !== "running" && nextAccountEmail && a.email === nextAccountEmail
      ? "pending"
      : displayStatus;

  const runButton =
    a.configured && Number.isInteger(a.index)
      ? `<button type="button" class="btn btn-primary btn-small acc-run-button" data-run-account="${U.escapeAttr(a.key)}" aria-label="Run only ACCOUNT_${a.index}" ${!usable || running || launching.has(a.key) ? "disabled" : ""
      } title="Run only ACCOUNT_${a.index}"><i class="ph ph-play acc-run-icon" aria-hidden="true"></i><span class="acc-run-label">${launching.has(a.key) ? "Starting\u2026" : "Run only"}</span></button>`
      : "";

  const selectCheckbox =
    a.configured && Number.isInteger(a.index)
      ? `<label class="check acc-batch-select" title="Include ACCOUNT_${a.index} in a batch run">
          <input type="checkbox" data-select-account="${U.escapeAttr(a.key)}" aria-label="Select ACCOUNT_${a.index} for a batch run" ${selectedForBatch.has(a.key) ? "checked" : ""}>
          <span>Select</span>
        </label>`
      : "";

  const isExpanded = expandedAccounts.has(a.key);
  const detailsId = `acc-details-${U.escapeAttr(a.key)}`;

  const isDeleting = deleting.has(a.key);
  const deleteBlocked = displayStatus === "running" || launching.has(a.key);
  const deleteButton = a.archived ? "" : deleteArmed.has(a.key)
    ? `<span class="acc-delete-confirm">
        <button type="button" class="btn btn-icon btn-small" data-cancel-delete="${U.escapeAttr(a.key)}" aria-label="Cancel remove" ${isDeleting ? "disabled" : ""} title="Cancel remove"><i class="ph ph-x" aria-hidden="true"></i></button>
        <button type="button" class="btn btn-danger btn-icon btn-small" data-confirm-delete="${U.escapeAttr(a.key)}" aria-label="Confirm remove account" ${isDeleting ? "disabled" : ""} title="Permanently remove this account and its history from the dashboard">
          <i class="ph ph-trash" aria-hidden="true"></i>
        </button>
      </span>`
    : `<button type="button" class="btn btn-danger btn-small btn-collapse" data-arm-delete="${U.escapeAttr(a.key)}" aria-label="Remove account" ${deleteBlocked ? "disabled" : ""} title="${deleteBlocked ? "The account must be idle to delete it" : "Remove this account and its history from the dashboard"}"><i class="ph ph-trash btn-collapse-icon" aria-hidden="true"></i><span class="btn-collapse-label">Remove</span></button>`;

  const protectionChip = protection
    ? `<span class="account-rail-icon ${protection.pillClass}" role="img" aria-label="Streak protection ${protection.state.toLowerCase()}" title="Streak protection is ${protection.state.toLowerCase()}; ${U.escapeAttr(protection.days)}"><i class="ph ${a.streakProtectionEnabled ? "ph-shield-check" : "ph-shield"}" aria-hidden="true"></i></span>`
    : "";
  const statusPill = U.pillParts(statusKey);
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
      <span class="account-rail-icon ${statusPill.cls}" role="img" aria-label="${U.escapeAttr(statusPill.label)}" title="${U.escapeAttr(statusPill.label)}"><i class="ph ${statusIcons[statusKey] || statusIcons.idle}" aria-hidden="true"></i></span>
    </aside>`;
  const featuresOpen = expandedFeatures.has(a.key);
  // Per-activity accounting from the stored run history. An account with no
  // data yet (a script upgraded from before v5) shows a migration notice until
  // its first full v5 run; an account the script skipped (for example for a
  // high bot score) shows that instead of an empty table.
  const emailKey = a.email.trim().toLowerCase();
  const group = groups.find((item) => item.server.id === a.serverId);
  const activityPayload = group?.activityDays;
  const activityError = group?.errors.find((error) => error.startsWith("activityDays:"));
  const actDays = activityPayload?.accounts?.[emailKey] || null;
  let activityBody;
  let activitySummary = "";
  if (actDays?.length) {
    activityBody = renderActivity(actDays, {
      email: a.key,
      selectedDay: selectedActivityDay.get(a.key),
      expanded: expandedActivity,
    });
    activitySummary = summaryChips(pickDay(actDays, selectedActivityDay.get(a.key)));
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

  const hasRemovedHistory = accounts.some((account) =>
    groups.some((group) => group.server.id === account.serverId && group.server.deletedAt));
  container.innerHTML = accounts.map((a, index) => {
    const live = U.runAccountMap(statusFor(a.serverId)).get(a.email.trim().toLowerCase()) || null;
    const header = index === 0 || accounts[index - 1].serverId !== a.serverId
      ? `<h2 class="account-server-heading${hasRemovedHistory ? "" : " multi-server-only"}">${U.escapeHtml(a.serverName)}</h2>` : "";
    return header + renderAccountPanel(a, live);
  }).join("");

  container.querySelectorAll("button[data-run-account]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const account = accounts.find((a) => a.key === btn.dataset.runAccount);
      if (account) runAccount(account);
    }),
  );

  container.querySelectorAll("input[data-select-account]").forEach((input) =>
    input.addEventListener("change", () => {
      const key = input.dataset.selectAccount;
      if (input.checked) selectedForBatch.add(key);
      else selectedForBatch.delete(key);
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
      deleteArmedAt.set(btn.dataset.armDelete, performance.now());
      render(root);
    }),
  );

  container.querySelectorAll("button[data-cancel-delete]").forEach((btn) =>
    btn.addEventListener("click", () => {
      deleteArmed.delete(btn.dataset.cancelDelete);
      deleteArmedAt.delete(btn.dataset.cancelDelete);
      render(root);
    }),
  );

  container.querySelectorAll("button[data-confirm-delete]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const key = btn.dataset.confirmDelete;
      if (!U.confirmReady(deleteArmedAt.get(key))) return;
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
      <section class="panel toggle-banner" aria-labelledby="accounts-history-heading">
        <div class="toggle-banner-copy">
          <h2 class="toggle-banner-title" id="accounts-history-heading">Include removed and disabled servers</h2>
          <p class="toggle-banner-help">Show retained accounts as read-only.</p>
        </div>
        <label class="toggle-banner-toggle">
          <input type="checkbox" id="accountsIncludeHistory" role="switch" aria-label="Include removed and disabled servers" ${includeHistory ? "checked" : ""}>
          <span class="toggle-banner-track" aria-hidden="true"></span>
        </label>
      </section>
      <p class="hint" style="margin-top: 1.5rem;">Accounts are configured in the bot&rsquo;s <code>.env</code> (<code>ACCOUNT_N_*</code>).
      The control API exposes full local email addresses but never sends passwords, recovery addresses, TOTP secrets, or proxy credentials.</p>
    `;
    mounted = true;

    U.$("#accountsIncludeHistory", root).addEventListener("change", (event) => {
      includeHistory = event.target.checked;
      void this.refresh(context).catch((error) => context.toast(error.message, "error"));
    });
    U.$("#accountsSelectAll", root).addEventListener("change", (e) => {
      const configured = selectableAccounts();
      if (e.target.checked) configured.forEach((a) => selectedForBatch.add(a.key));
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
    const sequence = ++refreshSequence;
    const nextGroups = await loadServers(ctx.api, ["summary", "accounts", "activityDays"], { historical: includeHistory });
    if (sequence !== refreshSequence) return;
    groups = nextGroups;
    accountsPayload = {
      ...combineAccounts(groups),
      apiError: groups.flatMap((group) => [...group.errors, group.accounts?.apiError].filter(Boolean).map((error) => `${group.server.name}: ${error}`)).join(" · "),
    };
    this.redraw(ctx);
  },

  onState(status, ctx) {
    if (rootEl?.contains(document.activeElement)) return;
    this.redraw(ctx);
  },
  redraw(ctx) {
    context = ctx || context;
    if (!mounted || !accountsPayload) return;
    render(rootEl);
  }
};