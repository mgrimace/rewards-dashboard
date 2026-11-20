import * as U from "../util.js";
import { loadServers } from "../serverViews.js";
import { barChart } from "../charts.js";

let rootEl = null;
let runsPayload = null;
let days = 30;
let openExit = null;
let groups = [];
let serverFilter = "all";
let showAllRuns = false;
let loadingMore = false;
let refreshSequence = 0;

function hasRemovedHistory() {
  return groups.some((group) => group.server.deletedAt &&
    ((group.runs?.runs || []).length || (group.runs?.exits || []).length ||
      Object.values(group.accounts?.histories || {}).some((history) => history.length)));
}

function dailyBars() {
  const totals = new Map();

  for (const group of groups.filter((item) => serverFilter === "all" || item.server.id === serverFilter)) {
    for (const history of Object.values(group.accounts?.histories || {})) {
      for (const day of U.bucketByDay(history)) {
        totals.set(day.dayKey, (totals.get(day.dayKey) || 0) + day.gained);
      }
    }
  }

  const out = [];
  const cursor = new Date();
  cursor.setHours(12, 0, 0, 0);
  cursor.setDate(cursor.getDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    const key = U.tzDayKey(cursor);
    out.push({ key, value: totals.get(key) || 0 });
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

function renderChart() {
  const bars = dailyBars();
  const total = bars.reduce((sum, b) => sum + b.value, 0);
  const active = bars.filter((b) => b.value > 0).length;

  U.$("#runsChartMeta", rootEl).textContent =
    `${U.fmtSigned(total)} points over ${days} days \u00b7 ${active} day${active === 1 ? "" : "s"} with a run`;
  barChart(U.$("#runsChart", rootEl), bars, {
    emptyMessage: "No point history recorded yet.",
  });
}

// A single actual bot execution currently produces up to 4 rows in the
// underlying run history (a wrapper-level lock-acquire/release pair with no
// point data, alongside the app's own RUN-START/RUN-END pair that has the
// real numbers) - filter down to what's actually informative: rows with
// real data, plus anything that isn't a plain success (errors/crashes are
// worth seeing even without full data).
function hasData(r) {
  return r.accountsProcessed != null || r.totalGained != null || r.newTotal != null;
}
function isInformative(r) {
  if (r.status === "running" || r.status === "done") return hasData(r);
  return true;
}

function renderRuns() {
  const runs = (runsPayload?.runs || []).filter((run) => (serverFilter === "all" || run.serverId === serverFilter) && (showAllRuns || isInformative(run)));
  const body = U.$("#runsBody", rootEl);
  const serverClass = hasRemovedHistory() ? "" : ' class="multi-server-only"';

  if (!runs.length) {
    body.innerHTML =
      `<tr><td colspan="${!serverClass || document.documentElement.hasAttribute("data-multi-server") ? 8 : 7}" class="empty-note">No runs recorded yet.</td></tr>`;
    return;
  }

  body.innerHTML = runs
    .map((r) => {
      const duration =
        r.runtimeMin != null
          ? U.fmtDuration(r.runtimeMin * 60)
          : r.startTs && r.endTs
            ? U.fmtDuration(
              (Date.parse(r.endTs) - Date.parse(r.startTs)) / 1000,
            )
            : "\u2013";
      return `<tr>
                <td${serverClass}>${U.escapeHtml(r.serverName)}</td>
                <td>${U.statusPill(r.status, r.outcome ? `Script reported: ${r.outcome}` : "")}</td>
                <td>${U.escapeHtml(U.fmtDateTime(r.startTs || r.endTs))}</td>
                <td>${U.escapeHtml(duration)}</td>
                <td class="num">${r.accountsProcessed != null ? U.fmtNumber(r.accountsProcessed) : "\u2013"}${r.totalAccounts ? ` / ${U.fmtNumber(r.totalAccounts)}` : ""}</td>
                <td class="num strong">${r.totalGained != null ? U.fmtSigned(r.totalGained) : "\u2013"}</td>
                <td class="num">${r.newTotal != null ? U.fmtNumber(r.newTotal) : "\u2013"}</td>
                <td>${r.version ? `v${U.escapeHtml(r.version)}` : "\u2013"}</td>
            </tr>`;
    })
    .join("");
}

function exitPill(run) {
  const exit = run?.exit;
  if (run?.status === "interrupted") return U.statusPill("interrupted");
  if (run?.status === "stopped" || run?.status === "cancelled" || exit?.signal || [130, 137, 143].includes(exit?.code))
    return U.statusPill("stopped");
  if (["done", "success", "partial", "full", "completed"].includes(run?.status) || exit?.code === 0)
    return U.statusPill("success");
  if (["error", "failed", "crashed"].includes(run?.status) || exit?.error || exit?.code != null)
    return U.statusPill("error");
  return U.statusPill("idle");
}

function renderExits() {
  const exits = (runsPayload?.exits || []).filter((run) => serverFilter === "all" || run.serverId === serverFilter);
  const list = U.$("#exitList", rootEl);

  U.$("#exitsError", rootEl).hidden = !runsPayload?.apiError;
  if (runsPayload?.apiError)
    U.$("#exitsError", rootEl).textContent = runsPayload.apiError;

  if (!exits.length) {
    list.innerHTML =
      '<li class="empty-note">The control API hasn\u2019t recorded any runs yet. Runs it launches itself (manually or on a schedule) show up here.</li>';
    return;
  }

  list.innerHTML = exits
    .map((run, i) => {
      const failed = (run.accounts || []).filter(
        (account) =>
          account.success === false &&
          !/run cancelled|stopped/i.test(account.error || ""),
      ).length;
      const stopped = (run.accounts || []).filter(
        (account) =>
          account.success === false &&
          /run cancelled|stopped/i.test(account.error || ""),
      ).length;
      const ok = (run.accounts || []).filter((a) => a.success === true).length;
      const isOpen = openExit === i;
      const detail = isOpen
        ? `<ul class="runacc-list">${(run.accounts || [])
          .map(
            (a) => `<li class="runacc">
                            ${U.statusPill(a.success === true ? "success" : /run cancelled|stopped/i.test(a.error || "") ? "stopped" : "error")}
                            <span class="runacc-email">${U.escapeHtml(a.email)}</span>
                            <span class="runacc-detail">${U.escapeHtml(a.error ? a.error : `${U.fmtSigned(a.collected)} pts`)}</span>
                          </li>`,
          )
          .join("")}</ul>`
        : "";

      return `<li class="exit-item">
                <button type="button" class="exit-head" data-exit="${i}" aria-expanded="${isOpen}">
                    ${exitPill(run)}
                    <span${hasRemovedHistory() ? "" : ' class="multi-server-only"'}>${U.escapeHtml(run.serverName)}</span>
                    <span class="exit-when">${U.escapeHtml(U.fmtDateTime(run.endedAt || run.startedAt))}</span>
                    <span class="exit-meta">${U.fmtSigned(run.collected || 0)} pts \u00b7 ${ok} ok${stopped ? ` \u00b7 ${stopped} stopped` : ""}${failed ? ` \u00b7 ${failed} failed` : ""}</span>
                    <span class="exit-chevron" aria-hidden="true">${isOpen ? "\u25BE" : "\u25B8"}</span>
                </button>
                ${detail}
            </li>`;
    })
    .join("");

  list.querySelectorAll("button[data-exit]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const i = Number(btn.dataset.exit);
      openExit = openExit === i ? null : i;
      renderExits();
    }),
  );
}

export default {
  id: "runs",
  label: "Runs",
  interval: 20000,

  mount(root, ctx) {
    rootEl = root;
    root.innerHTML = `
            <label class="field field--inline multi-server-only" id="runsServerField"><span>Server</span><select id="runsServer" class="input"><option value="all">All servers</option></select></label>
            <section class="panel" aria-labelledby="runs-chart-heading">
                <div class="panel-head">
                    <h2 id="runs-chart-heading">Points per day</h2>
                    <span class="panel-sub" id="runsChartMeta"></span>
                    <div class="seg" role="group" aria-label="Date range">
                        <button type="button" class="seg-btn" data-days="14">14d</button>
                        <button type="button" class="seg-btn seg-btn--active" data-days="30">30d</button>
                        <button type="button" class="seg-btn" data-days="90">90d</button>
                    </div>
                </div>
                <div id="runsChart" class="chart-wrap"></div>
            </section>

            <section class="panel" aria-labelledby="runs-table-heading">
                <div class="panel-head">
                    <h2 id="runs-table-heading">Run history</h2>
                    <span class="panel-sub">Parsed from the bot&rsquo;s own log output</span>
                    <label class="check"><input type="checkbox" id="runsShowAll"><span>Show all recorded runs</span></label>
                    <button type="button" class="btn" id="runsLoadMore">Load older runs</button>
                </div>
                <div class="table-wrap">
                    <table>
                        <thead>
                            <tr>
                                <th id="runsServerHeading" class="multi-server-only">Server</th><th>Status</th><th>Started</th><th>Duration</th>
                                <th>Accounts</th><th>Gained</th><th>New total</th><th>Version</th>
                            </tr>
                        </thead>
                        <tbody id="runsBody"></tbody>
                    </table>
                </div>
            </section>

            <section class="panel" aria-labelledby="exits-heading">
                <div class="panel-head">
                    <h2 id="exits-heading">Process exits</h2>
                    <span class="panel-sub">How each run the control API launched actually ended</span>
                </div>
                <p class="notice notice--warn" id="exitsError" hidden></p>
                <ul class="exit-list" id="exitList"></ul>
            </section>`;

    U.$("#runsServer", root).addEventListener("change", (event) => {
      serverFilter = event.target.value;
      openExit = null;
      this.redraw();
    });
    U.$("#runsShowAll", root).addEventListener("change", (event) => {
      showAllRuns = event.target.checked;
      renderRuns();
    });
    U.$("#runsLoadMore", root).addEventListener("click", async () => {
      if (loadingMore) return;
      loadingMore = true;
      const button = U.$("#runsLoadMore", root);
      button.disabled = true;
      const targets = groups.filter((group) => group.runs && (serverFilter === "all" || group.server.id === serverFilter));
      const results = await Promise.allSettled(targets.map((group) =>
        ctx.api.forServer(group.server.id, group.archived).runs(100, group.runs.runs.length)));
      const errors = [];
      results.forEach((result, index) => {
        const group = groups.find((item) => item.server.id === targets[index].server.id);
        if (!group?.runs) return;
        if (result.status === "rejected") {
          errors.push(`${group.server.name}: ${result.reason.message}`);
          return;
        }
        const existing = new Set(group.runs.runs.map((run) => run.id));
        group.runs.runs.push(...result.value.runs.filter((run) => !existing.has(run.id)));
      });
      if (errors.length) U.toast(errors.join(" · "), "error");
      this.updatePayload();
      this.redraw();
      loadingMore = false;
      button.disabled = false;
    });
    root.querySelectorAll("button[data-days]").forEach((btn) =>
      btn.addEventListener("click", () => {
        days = Number(btn.dataset.days);
        root
          .querySelectorAll("button[data-days]")
          .forEach((b) => b.classList.toggle("seg-btn--active", b === btn));
        renderChart();
      }),
    );
  },

  async refresh(ctx) {
    const previous = groups;
    const sequence = ++refreshSequence;
    const nextGroups = await loadServers(ctx.api, ["runs", "accounts"], { historical: true });
    if (sequence !== refreshSequence) return;
    groups = nextGroups;
    for (const group of groups) {
      const older = previous.find((item) => item.server.id === group.server.id)?.runs?.runs || [];
      if (!group.runs) continue;
      const current = new Set(group.runs.runs.map((run) => run.id));
      group.runs.runs.push(...older.filter((run) => !current.has(run.id)));
    }
    const hasRemoved = hasRemovedHistory();
    U.$("#runsServerField", rootEl).classList.toggle("multi-server-only", !hasRemoved);
    U.$("#runsServerHeading", rootEl).classList.toggle("multi-server-only", !hasRemoved);
    const select = U.$("#runsServer", rootEl);
    if (serverFilter !== "all" && !groups.some((group) => group.server.id === serverFilter)) serverFilter = "all";
    if (!hasRemoved && !document.documentElement.hasAttribute("data-multi-server")) serverFilter = "all";
    select.innerHTML = '<option value="all">All servers</option>' + groups.map(({ server }) =>
      `<option value="${U.escapeAttr(server.id)}">${U.escapeHtml(server.name)}${server.deletedAt ? " (removed)" : !server.enabled ? " (disabled)" : ""}</option>`).join("");
    select.value = serverFilter;
    this.updatePayload();
    this.redraw();
  },

  updatePayload() {
    const collect = (field) => groups.flatMap((group) => (group.runs?.[field] || []).map((run) => ({
      ...run, serverId: group.server.id, serverName: `${group.server.name}${group.server.deletedAt ? " (removed)" : ""}`,
    }))).sort((a, b) =>
      (Date.parse(b.startTs || b.startedAt || b.endTs || b.endedAt) || 0) -
      (Date.parse(a.startTs || a.startedAt || a.endTs || a.endedAt) || 0));
    runsPayload = {
      runs: collect("runs"), exits: collect("exits"),
      apiError: groups.flatMap((group) => [...group.errors, group.runs?.apiError, group.accounts?.apiError].filter(Boolean).map((error) => `${group.server.name}: ${error}`)).join(" · "),
    };
  },

  redraw() {
    if (!rootEl || !runsPayload) return;
    renderChart();
    renderRuns();
    renderExits();
  },
};
