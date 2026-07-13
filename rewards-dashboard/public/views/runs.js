import * as U from "../util.js";
import { cached } from "../api.js";
import { barChart } from "../charts.js";

let rootEl = null;
let runsPayload = null;
let accountsPayload = null;
let days = 30;
let openExit = null;

function dailyBars() {
  const histories = accountsPayload?.histories || {};
  const totals = new Map();

  for (const history of Object.values(histories)) {
    for (const day of U.bucketByDay(history)) {
      totals.set(day.dayKey, (totals.get(day.dayKey) || 0) + day.gained);
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

function renderRuns() {
  const runs = runsPayload?.runs || [];
  const body = U.$("#runsBody", rootEl);

  if (!runs.length) {
    body.innerHTML =
      '<tr><td colspan="7" class="empty-note">No runs recorded yet.</td></tr>';
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
                <td>${U.statusPill(r.status)}</td>
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

function exitPill(exit) {
  if (!exit) return U.statusPill("idle");
  if (exit.code === 0) return '<span class="pill pill-success">Exit 0</span>';
  if (exit.signal)
    return `<span class="pill pill-warn">${U.escapeHtml(exit.signal)}</span>`;
  return `<span class="pill pill-error">Exit ${U.escapeHtml(String(exit.code ?? "n/a"))}</span>`;
}

function renderExits() {
  const exits = runsPayload?.exits || [];
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
        (a) => a.success === false,
      ).length;
      const ok = (run.accounts || []).filter((a) => a.success === true).length;
      const isOpen = openExit === i;
      const detail = isOpen
        ? `<ul class="runacc-list">${(run.accounts || [])
          .map(
            (a) => `<li class="runacc">
                            ${U.statusPill(a.success === false ? "error" : "success")}
                            <span class="runacc-email">${U.escapeHtml(a.email)}</span>
                            <span class="runacc-detail">${U.escapeHtml(a.error ? a.error : `${U.fmtSigned(a.collected)} pts`)}</span>
                          </li>`,
          )
          .join("")}</ul>`
        : "";

      return `<li class="exit-item">
                <button type="button" class="exit-head" data-exit="${i}" aria-expanded="${isOpen}">
                    ${exitPill(run.exit)}
                    <span class="exit-when">${U.escapeHtml(U.fmtDateTime(run.endedAt || run.startedAt))}</span>
                    <span class="exit-meta">${U.fmtSigned(run.collected || 0)} pts \u00b7 ${ok} ok${failed ? ` \u00b7 ${failed} failed` : ""}</span>
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

  mount(root) {
    rootEl = root;
    root.innerHTML = `
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
                </div>
                <div class="table-wrap">
                    <table>
                        <thead>
                            <tr>
                                <th>Status</th><th>Started</th><th>Duration</th>
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
    [runsPayload, accountsPayload] = await Promise.all([
      cached("runs", () => ctx.api.runs(100), 5000),
      cached("accounts", ctx.api.accounts, 5000),
    ]);
    this.redraw();
  },

  redraw() {
    if (!rootEl || !runsPayload) return;
    renderChart();
    renderRuns();
    renderExits();
  },
};
