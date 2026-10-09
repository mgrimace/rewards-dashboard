import * as U from "../util.js";

const PRESETS = [
  ["Daily at 09:00", "0 9 * * *"],
  ["Twice daily (09:00, 21:00)", "0 9,21 * * *"],
  ["每 6 小时", "0 */6 * * *"],
  ["Every 12 hours", "0 */12 * * *"],
  ["Weekdays at 08:00", "0 8 * * 1-5"],
];

const TARGET_LABEL = {
  local: "This dashboard",
  remote: "Bot container (Docker cron)",
};

let rootEl = null;
let data = { local: null, remote: null, remoteSupported: false };
let target = "local";
let initialTargetChosen = false;
let current = null;
let dirty = false;
let accountOptions = [];

function syncCurrent() {
  current = data ? data[target] : null;
}

function fields() {
  const base = {
    enabled: U.$("#schedEnabled", rootEl).checked,
    cron: U.$("#schedCron", rootEl).value.trim(),
    skipIfRunning: U.$("#schedSkip", rootEl).checked,
    excludedAccountIndexes: U.$$(
      "input[data-exclude-account]:checked",
      rootEl,
    ).map((input) => Number(input.dataset.excludeAccount)),
  };
  if (target === "local") {
    base.misfirePolicy = U.$("#schedMisfire", rootEl).value;
    base.misfireGraceMinutes = Number(U.$("#schedGrace", rootEl).value);
  }
  return base;
}

function markDirty() {
  dirty = true;
  U.$("#schedSave", rootEl).disabled = false;
}

function paintTargetToggle() {
  const remoteBtn = U.$("#schedTargetRemote", rootEl);
  const localBtn = U.$("#schedTargetLocal", rootEl);
  if (!remoteBtn || !localBtn) return;

  remoteBtn.hidden = !data.remoteSupported;
  if (target === "remote" && !data.remoteSupported) target = "local";

  localBtn.setAttribute("aria-pressed", String(target === "local"));
  localBtn.classList.toggle("seg-btn--active", target === "local");
  remoteBtn.setAttribute("aria-pressed", String(target === "remote"));
  remoteBtn.classList.toggle("seg-btn--active", target === "remote");

  const bothActive = Boolean(
    data.local?.enabled && data.remote?.enabled && data.remoteSupported,
  );
  const warning = U.$("#schedDualWarning", rootEl);
  if (warning) warning.hidden = !bothActive;

  const note = U.$("#schedTargetNote", rootEl);
  if (note) {
    note.textContent =
      target === "remote"
        ? "Cron runs inside the bot container itself — it fires even if this dashboard is offline, and simply doesn't fire while the container is stopped (so there's no missed-run policy to configure)."
        : "This scheduler runs inside the dashboard's own process — it needs the dashboard container to be up to fire, but can recover a missed run according to the policy below.";
  }
}

function paint() {
  syncCurrent();
  paintTargetToggle();

  const misfireGroup = U.$("#schedMisfireGroup", rootEl);
  if (misfireGroup) misfireGroup.hidden = target === "remote";

  if (!current) {
    U.$("#schedFormBody", rootEl).hidden = true;
    U.$("#schedUnavailable", rootEl).hidden = false;
    U.$("#schedSave", rootEl).disabled = true;
    return;
  }
  U.$("#schedFormBody", rootEl).hidden = false;
  U.$("#schedUnavailable", rootEl).hidden = true;

  U.$("#schedEnabled", rootEl).checked = Boolean(current.enabled);
  U.$("#schedCron", rootEl).value = current.cron || "";
  U.$("#schedSkip", rootEl).checked = current.skipIfRunning !== false;
  if (target === "local") {
    U.$("#schedMisfire", rootEl).value = current.misfirePolicy || "skip";
    U.$("#schedGrace", rootEl).value = current.misfireGraceMinutes || 60;
    U.$("#schedGraceField", rootEl).hidden =
      U.$("#schedMisfire", rootEl).value !== "grace-period";
  }
  renderAccountExclusions();

  U.$("#schedNext", rootEl).textContent = current.enabled
    ? current.nextRunAt
      ? `${U.fmtDateTime(current.nextRunAt)} (${U.fmtRelative(current.nextRunAt)})`
      : "未计划"
    : "已禁用";

  if (target === "local") {
    U.$("#schedLast", rootEl).textContent = current.lastTriggeredAt
      ? U.fmtDateTime(current.lastTriggeredAt)
      : "\u2013";
    U.$("#schedResult", rootEl).textContent = current.lastResult || "\u2013";
  } else {
    U.$("#schedLast", rootEl).textContent = "\u2013";
    U.$("#schedResult", rootEl).textContent =
      "此处不记录 — 请查看“运行记录”标签页。";
  }

  const excluded = current.excludedAccountIndexes || [];
  U.$("#schedExcluded", rootEl).textContent = excluded.length
    ? excluded.map((index) => `ACCOUNT_${index}`).join(", ")
    : "无";

  const tzLabel = U.$("#schedTz", rootEl);
  if (target === "local") {
    const offset = current.timezoneOffsetMinutes;
    const sign = offset >= 0 ? "+" : "-";
    const abs = Math.abs(offset || 0);
    tzLabel.textContent =
      offset == null
        ? "\u2013"
        : `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  } else {
    tzLabel.textContent = current.timezone || "\u2013";
  }

  dirty = false;
  U.$("#schedSave", rootEl).disabled = true;
  describe(current.cron || "");
}

function renderAccountExclusions() {
  const host = U.$("#schedAccounts", rootEl);
  if (!host) return;
  if (!accountOptions.length) {
    host.innerHTML =
      '<p class="empty-note">暂无可用的配置账号。</p>';
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
    out.textContent = "请输入标准的 5 字段 Cron 表达式。";
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
  label: "计划",
  interval: 30000,

  mount(root, ctx) {
    rootEl = root;
    root.innerHTML = `
            <section class="panel" aria-labelledby="sched-heading">
                <div class="panel-head">
                    <h2 id="sched-heading">定时自动运行</h2>
                    <span class="panel-sub">Two schedulers are available &mdash; pick the one that fits your setup</span>
                </div>

                <div class="seg" id="schedTargetToggle" role="radiogroup" aria-label="定时调度器位置">
                    <button type="button" class="seg-btn seg-btn--active" id="schedTargetLocal" data-target="local" aria-pressed="true">${U.escapeHtml(TARGET_LABEL.local)}</button>
                    <button type="button" class="seg-btn" id="schedTargetRemote" data-target="remote" aria-pressed="false" hidden>${U.escapeHtml(TARGET_LABEL.remote)}</button>
                </div>
                <p class="hint" id="schedTargetNote"></p>
                <p class="empty-note chart-empty" id="schedDualWarning" hidden>
                    &#9888; 两个调度器当前均已启用 &mdash; 任务可能会重复触发。请在下方禁用其中一个调度器。
                </p>

                <div class="form" id="schedFormBody">
                    <label class="check check--row">
                        <input type="checkbox" id="schedEnabled">
                        <span><strong>启用</strong> &mdash; 按照下方计划定时触发运行</span>
                    </label>

                    <div id="schedMisfireGroup">
                        <label class="field">
                            <span>当控制台离线期间错失了计划运行时</span>
                            <select id="schedMisfire" class="input">
                                <option value="skip">直接跳过</option>
                                <option value="run-on-startup">开机/启动后立即补跑一次</option>
                                <option value="grace-period">仅在容限期内补跑</option>
                            </select>
                        </label>

                        <label class="field" id="schedGraceField" hidden>
                            <span>容限时间 (分钟)</span>
                            <input id="schedGrace" class="input" type="number" min="1" max="1440" value="60">
                        </label>
                    </div>

                    <fieldset class="field">
                        <legend>排除账号</legend>
                        <div id="schedAccounts" class="schedule-account-list">
                            <p class="empty-note">正在加载已配置的账号&hellip;</p>
                        </div>
                    </fieldset>

                    <label class="field">
                        <span>Cron 表达式</span>
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
                        <span><strong>若已在运行则跳过</strong> &mdash; 不在已有任务执行中重复启动新任务</span>
                    </label>

                    <div class="form-actions">
                        <button type="button" id="schedSave" class="btn btn-primary" disabled>保存计划</button>
                        <button type="button" id="schedReset" class="btn">放弃修改</button>
                    </div>
                </div>
                <p class="empty-note" id="schedUnavailable" hidden>
                    无法读取此调度器的当前状态。面板将自动重试刷新 &mdash; 若此问题持续出现，请检查脚本机器人的控制 API 是否可达，如需在此编辑请确认已配置 API_ALLOW_SCHEDULE_WRITE。
                </p>
            </section>

            <section class="panel" aria-labelledby="sched-state-heading">
                <div class="panel-head"><h2 id="sched-state-heading">当前状态</h2></div>
                <dl class="kv">
                    <div><dt>下次运行</dt><dd id="schedNext">\u2013</dd></div>
                    <div><dt>上次触发</dt><dd id="schedLast">\u2013</dd></div>
                    <div><dt>上次结果</dt><dd id="schedResult">\u2013</dd></div>
                    <div><dt>排除账号</dt><dd id="schedExcluded">\u2013</dd></div>
                    <div><dt>调度时区</dt><dd id="schedTz">\u2013</dd></div>
                </dl>
                <p class="hint">时间按调度器自身的环境时区计算（控制台面板: 环境变量 <code>TZ</code>; 脚本容器: 容器自身 <code>TZ</code>）。如果调度器宿主机此前处于离线状态，本地调度器将在启动时应用错失执行策略 &mdash; 容器调度器则直接忽略错过的执行。</p>
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

    U.$("#schedTargetToggle", root).addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-target]");
      if (!btn || btn.hidden) return;
      const next = btn.dataset.target;
      if (next === target) return;
      if (
        dirty &&
        !window.confirm("放弃未保存的修改并切换调度器？")
      ) {
        return;
      }
      target = next;
      paint();
    });

    U.$("#schedReset", root).addEventListener("click", () => paint());

    U.$("#schedSave", root).addEventListener("click", async () => {
      const patch = fields();
      const btn = U.$("#schedSave", root);
      if (
        accountOptions.length &&
        patch.excludedAccountIndexes.length >= accountOptions.length
      ) {
        U.toast("计划任务必须至少包含一个账号。", "error");
        return;
      }
      btn.disabled = true;
      try {
        data = await ctx.api.saveSchedule(patch, target);
        paint();
        U.toast(
          patch.enabled
            ? `Schedule armed (${TARGET_LABEL[target]}).`
            : `Schedule disabled (${TARGET_LABEL[target]}).`,
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
    const [scheduleResp, accountsPayload] = await Promise.all([
      ctx.api.schedule(),
      ctx.api.accounts(0),
    ]);
    data = scheduleResp;

    // Land on whichever scheduler is actually doing something, the first
    // time we have real data to look at. Only ever runs once — after that,
    // whatever the person clicked wins, including on later refreshes.
    if (!initialTargetChosen) {
      initialTargetChosen = true;
      target =
        data.remoteSupported && data.remote?.enabled && !data.local?.enabled
          ? "remote"
          : "local";
    }

    accountOptions = (accountsPayload.accounts || []).filter(
      (account) => account.configured && Number.isInteger(account.index),
    );
    paint();
  },
};
