import * as U from "../util.js";

const PRESETS = [
  ["Daily at 09:00", "0 9 * * *"],
  ["Twice daily (09:00, 21:00)", "0 9,21 * * *"],
  ["Every 6 hours", "0 */6 * * *"],
  ["Every 12 hours", "0 */12 * * *"],
  ["Weekdays at 08:00", "0 8 * * 1-5"],
];

let rootEl = null;
let current = null;
let dirty = false;
let accountOptions = [];

function fields() {
  return {
    enabled: U.$("#schedEnabled", rootEl).checked,
    cron: U.$("#schedCron", rootEl).value.trim(),
    skipIfRunning: U.$("#schedSkip", rootEl).checked,
    misfirePolicy: U.$("#schedMisfire", rootEl).value,
    misfireGraceMinutes: Number(U.$("#schedGrace", rootEl).value),
    excludedAccountIndexes: U.$$(
      "input[data-exclude-account]:checked",
      rootEl,
    ).map((input) => Number(input.dataset.excludeAccount)),
  };
}

function markDirty() {
  dirty = true;
  U.$("#schedSave", rootEl).disabled = false;
}

function paint() {
  if (!current) return;
  U.$("#schedEnabled", rootEl).checked = Boolean(current.enabled);
  U.$("#schedCron", rootEl).value = current.cron || "";
  U.$("#schedSkip", rootEl).checked = current.skipIfRunning !== false;
  U.$("#schedMisfire", rootEl).value = current.misfirePolicy || "skip";
  U.$("#schedGrace", rootEl).value = current.misfireGraceMinutes || 60;
  U.$("#schedGraceField", rootEl).hidden =
    U.$("#schedMisfire", rootEl).value !== "grace-period";
  renderAccountExclusions();

  U.$("#schedNext", rootEl).textContent = current.enabled
    ? current.nextRunAt
      ? `${U.fmtDateTime(current.nextRunAt)} (${U.fmtRelative(current.nextRunAt)})`
      : "Not scheduled"
    : "Disabled";
  U.$("#schedLast", rootEl).textContent = current.lastTriggeredAt
    ? U.fmtDateTime(current.lastTriggeredAt)
    : "\u2013";
  U.$("#schedResult", rootEl).textContent = current.lastResult || "\u2013";
  const excluded = current.excludedAccountIndexes || [];
  U.$("#schedExcluded", rootEl).textContent = excluded.length
    ? excluded.map((index) => `ACCOUNT_${index}`).join(", ")
    : "None";

  const offset = current.timezoneOffsetMinutes;
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset || 0);
  U.$("#schedTz", rootEl).textContent =
    offset == null
      ? "\u2013"
      : `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;

  dirty = false;
  U.$("#schedSave", rootEl).disabled = true;
  describe(current.cron || "");
}

function renderAccountExclusions() {
  const host = U.$("#schedAccounts", rootEl);
  if (!host) return;
  if (!accountOptions.length) {
    host.innerHTML =
      '<p class="empty-note">No configured accounts are available.</p>';
    return;
  }
  const excluded = new Set(current?.excludedAccountIndexes || []);
  host.innerHTML = accountOptions
    .map(
      (account) => `<label class="check check--row">
                <input type="checkbox" data-exclude-account="${account.index}" ${excluded.has(account.index) ? "checked" : ""}>
                <span>Exclude <strong>ACCOUNT_${account.index}</strong> \u2014 ${U.escapeHtml(account.email)}</span>
            </label>`,
    )
    .join("");
  U.$$("input[data-exclude-account]", host).forEach((input) =>
    input.addEventListener("change", markDirty),
  );
}

async function describe(expr) {
  const out = U.$("#schedDesc", rootEl);
  if (!expr) {
    out.textContent = "Enter a 5-field cron expression.";
    out.className = "sched-desc";
    return;
  }
  try {
    const res = await (
      await fetch(`/api/cron?expr=${encodeURIComponent(expr)}`)
    ).json();
    out.textContent = res.valid ? res.description : res.error;
    out.className = `sched-desc ${res.valid ? "sched-desc--ok" : "sched-desc--bad"}`;
    U.$("#schedSave", rootEl).disabled = !res.valid || !dirty;
  } catch {
    out.textContent = "";
  }
}

export default {
  id: "schedule",
  label: "Schedule",
  interval: 30000,

  mount(root, ctx) {
    rootEl = root;
    root.innerHTML = `
            <section class="panel" aria-labelledby="sched-heading">
                <div class="panel-head">
                    <h2 id="sched-heading">Automatic runs</h2>
                    <span class="panel-sub">The dashboard&rsquo;s own cron &mdash; survives restarts, no Docker cron needed</span>
                </div>

                <div class="form">
                    <label class="check check--row">
                        <input type="checkbox" id="schedEnabled">
                        <span><strong>Enabled</strong> &mdash; fire runs on the schedule below</span>
                    </label>

                    <label class="field">
                        <span>If a run was missed while the dashboard was offline</span>
                        <select id="schedMisfire" class="input">
                            <option value="skip">Skip it</option>
                            <option value="run-on-startup">Run once after startup</option>
                            <option value="grace-period">Run only within a grace period</option>
                        </select>
                    </label>

                    <label class="field" id="schedGraceField" hidden>
                        <span>Grace period in minutes</span>
                        <input id="schedGrace" class="input" type="number" min="1" max="1440" value="60">
                    </label>

                    <fieldset class="field">
                        <legend>Excluded accounts</legend>
                        <div id="schedAccounts" class="schedule-account-list">
                            <p class="empty-note">Loading configured accounts&hellip;</p>
                        </div>
                    </fieldset>

                    <label class="field">
                        <span>Cron expression</span>
                        <input id="schedCron" class="input input--mono" type="text" placeholder="0 9 * * *"
                               spellcheck="false" autocomplete="off" aria-describedby="schedDesc">
                    </label>
                    <p class="sched-desc" id="schedDesc"></p>

                    <div class="preset-row" id="schedPresets">
                        ${PRESETS.map(
      ([label, expr]) =>
        `<button type="button" class="chip-btn" data-cron="${U.escapeAttr(expr)}" title="${U.escapeAttr(expr)}">${U.escapeHtml(label)}</button>`,
    ).join("")}
                    </div>

                    <label class="check check--row">
                        <input type="checkbox" id="schedSkip">
                        <span><strong>Skip if already running</strong> &mdash; don&rsquo;t start a second run on top of one in progress</span>
                    </label>

                    <div class="form-actions">
                        <button type="button" id="schedSave" class="btn btn-primary" disabled>Save schedule</button>
                        <button type="button" id="schedReset" class="btn">Discard changes</button>
                    </div>
                </div>
            </section>

            <section class="panel" aria-labelledby="sched-state-heading">
                <div class="panel-head"><h2 id="sched-state-heading">Current state</h2></div>
                <dl class="kv">
                    <div><dt>Next run</dt><dd id="schedNext">\u2013</dd></div>
                    <div><dt>Last triggered</dt><dd id="schedLast">\u2013</dd></div>
                    <div><dt>Last result</dt><dd id="schedResult">\u2013</dd></div>
                    <div><dt>Excluded accounts</dt><dd id="schedExcluded">\u2013</dd></div>
                    <div><dt>Dashboard timezone</dt><dd id="schedTz">\u2013</dd></div>
                </dl>
                <p class="hint">Times are evaluated in the dashboard&rsquo;s timezone (set <code>TZ</code>
                here). If the dashboard was offline, the selected missed-run policy is applied at startup.</p>
            </section>`;

    const cronInput = U.$("#schedCron", root);
    cronInput.addEventListener(
      "input",
      U.debounce(() => {
        markDirty();
        describe(cronInput.value.trim());
      }, 250),
    );
    U.$("#schedEnabled", root).addEventListener("change", markDirty);
    U.$("#schedSkip", root).addEventListener("change", markDirty);
    U.$("#schedMisfire", root).addEventListener("change", (event) => {
      U.$("#schedGraceField", root).hidden =
        event.target.value !== "grace-period";
      markDirty();
    });
    U.$("#schedGrace", root).addEventListener("input", markDirty);

    U.$("#schedPresets", root).addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-cron]");
      if (!btn) return;
      cronInput.value = btn.dataset.cron;
      markDirty();
      describe(btn.dataset.cron);
    });

    U.$("#schedReset", root).addEventListener("click", () => paint());

    U.$("#schedSave", root).addEventListener("click", async () => {
      const patch = fields();
      const btn = U.$("#schedSave", root);
      if (
        accountOptions.length &&
        patch.excludedAccountIndexes.length >= accountOptions.length
      ) {
        U.toast("A scheduled run must include at least one account.", "error");
        return;
      }
      btn.disabled = true;
      try {
        current = await ctx.api.saveSchedule(patch);
        paint();
        U.toast(
          patch.enabled ? "Schedule armed." : "Schedule disabled.",
          "success",
        );
        ctx.invalidate();
      } catch (e) {
        btn.disabled = false;
        U.toast(e.message, "error");
      }
    });
  },

  async refresh(ctx) {
    if (dirty) return;
    const [schedule, accountsPayload] = await Promise.all([
      ctx.api.schedule(),
      ctx.api.accounts(0),
    ]);
    current = schedule;
    accountOptions = (accountsPayload.accounts || []).filter(
      (account) => account.configured && Number.isInteger(account.index),
    );
    paint();
  },
};
