import * as U from "../util.js";

const MAX_LINES = 3000;
const LEVEL_RANK = { debug: 0, info: 1, warn: 2, error: 3 };

let rootEl = null;
let entries = []; // sorted by id
let seen = new Set();
let paused = false;
let pendingWhilePaused = 0;
let filterLevel = "all";
let filterText = "";
let autoscroll = true;

const matches = (e) => {
  if (
    filterLevel !== "all" &&
    (LEVEL_RANK[e.level] ?? 1) < LEVEL_RANK[filterLevel]
  )
    return false;
  if (!filterText) return true;
  const hay =
    `${e.title || ""} ${e.platform || ""} ${e.user || ""} ${e.message || ""}`.toLowerCase();
  return hay.includes(filterText);
};

function lineHtml(e) {
  const time = e.ts || (e.receivedAt ? U.fmtTime(e.receivedAt) : "");
  const tag = e.title || e.level;
  return `<div class="log-line log-line--${U.escapeAttr(e.level)}">
        <span class="log-time">${U.escapeHtml(time)}</span>
        <span class="log-level log-level--${U.escapeAttr(e.level)}">${U.escapeHtml(e.level)}</span>
        <span class="log-tag">${U.escapeHtml(tag || "")}</span>
        <span class="log-msg">${U.escapeHtml(e.message || e.raw || "")}</span>
    </div>`;
}

function atBottom(box) {
  return box.scrollHeight - box.scrollTop - box.clientHeight < 60;
}

function renderAll() {
  const box = U.$("#logBox", rootEl);
  const visible = entries.filter(matches);
  box.innerHTML = visible.length
    ? visible.slice(-MAX_LINES).map(lineHtml).join("")
    : '<p class="empty-note">No log lines match the current filter.</p>';
  if (autoscroll) box.scrollTop = box.scrollHeight;
  updateMeta();
}

function updateMeta() {
  U.$("#logCount", rootEl).textContent =
    `${entries.length.toLocaleString()} line${entries.length === 1 ? "" : "s"} buffered`;
  const btn = U.$("#logPause", rootEl);
  btn.textContent = paused
    ? pendingWhilePaused
      ? `Resume (${pendingWhilePaused} new)`
      : "Resume"
    : "Pause";
  btn.classList.toggle("btn-primary", paused);
}

function addEntry(entry, live) {
  if (!entry || entry.id == null || seen.has(entry.id)) return false;
  seen.add(entry.id);

  const inOrder = !entries.length || entry.id > entries[entries.length - 1].id;
  if (inOrder) entries.push(entry);
  else {
    entries.push(entry);
    entries.sort((a, b) => a.id - b.id);
  }

  if (entries.length > MAX_LINES * 2) {
    const dropped = entries.splice(0, entries.length - MAX_LINES);
    for (const d of dropped) seen.delete(d.id);
  }

  if (!live) return true;

  if (paused) {
    pendingWhilePaused++;
    updateMeta();
    return true;
  }

  if (!inOrder) {
    renderAll();
    return true;
  }

  if (matches(entry)) {
    const box = U.$("#logBox", rootEl);
    const wasAtBottom = atBottom(box);
    if (box.querySelector(".empty-note")) box.innerHTML = "";
    box.insertAdjacentHTML("beforeend", lineHtml(entry));
    while (box.childElementCount > MAX_LINES) box.firstElementChild.remove();
    if (autoscroll && wasAtBottom) box.scrollTop = box.scrollHeight;
  }
  updateMeta();
  return true;
}

function download() {
  const text = entries.map((e) => e.raw || e.message || "").join("\n");
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `rewards-log-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

export default {
  id: "logs",
  label: "Logs",
  interval: 0, // live — nothing to poll

  mount(root, ctx) {
    rootEl = root;
    root.innerHTML = `
            <section class="panel" aria-labelledby="logs-heading">
                <div class="panel-head">
                    <h2 id="logs-heading">Live logs</h2>
                    <span class="panel-sub" id="logCount">0 lines buffered</span>
                </div>

                <div class="toolbar">
                    <label class="field field--inline">
                        <span>Level</span>
                        <select id="logLevel" class="input">
                            <option value="all">All</option>
                            <option value="info">Info and up</option>
                            <option value="warn">Warnings and up</option>
                            <option value="error">Errors only</option>
                        </select>
                    </label>
                    <label class="field field--grow">
                        <span class="visually-hidden">Search</span>
                        <input id="logSearch" class="input" type="search" placeholder="Filter lines\u2026" autocomplete="off">
                    </label>
                    <label class="check">
                        <input type="checkbox" id="logAutoscroll" checked>
                        <span>Autoscroll</span>
                    </label>
                    <button type="button" id="logPause" class="btn">Pause</button>
                    <button type="button" id="logMore" class="btn">Load 2000</button>
                    <button type="button" id="logDownload" class="btn">Download</button>
                    <button type="button" id="logClear" class="btn">Clear</button>
                </div>

                <div class="log-box" id="logBox" tabindex="0" aria-live="off">
                    <p class="empty-note">Waiting for log lines\u2026</p>
                </div>
            </section>`;

    U.$("#logLevel", root).addEventListener("change", (e) => {
      filterLevel = e.target.value;
      renderAll();
    });
    U.$("#logSearch", root).addEventListener(
      "input",
      U.debounce((e) => {
        filterText = e.target.value.trim().toLowerCase();
        renderAll();
      }, 200),
    );
    U.$("#logAutoscroll", root).addEventListener("change", (e) => {
      autoscroll = e.target.checked;
      if (autoscroll) {
        const box = U.$("#logBox", rootEl);
        box.scrollTop = box.scrollHeight;
      }
    });
    U.$("#logPause", root).addEventListener("click", () => {
      paused = !paused;
      if (!paused) {
        pendingWhilePaused = 0;
        renderAll();
      }
      updateMeta();
    });
    U.$("#logClear", root).addEventListener("click", () => {
      entries = [];
      seen = new Set();
      pendingWhilePaused = 0;
      renderAll();
    });
    U.$("#logDownload", root).addEventListener("click", download);
    U.$("#logMore", root).addEventListener("click", async () => {
      try {
        const res = await ctx.api.logs(2000);
        for (const e of res.logs || []) addEntry(e, false);
        renderAll();
        U.toast(
          `Buffer filled to ${entries.length.toLocaleString()} lines.`,
          "success",
        );
      } catch (e) {
        U.toast(e.message, "error");
      }
    });
  },

  async refresh(ctx) {
    if (entries.length) return;
    try {
      const res = await ctx.api.logs(500);
      for (const e of res.logs || []) addEntry(e, false);
    } catch {
    }
    renderAll();
  },

  onLog(entry) {
    if (!rootEl) return;
    addEntry(entry, true);
  },

  onReset() {
    entries = [];
    seen = new Set();
    pendingWhilePaused = 0;
    if (rootEl) renderAll();
  },

  redraw() {
    if (rootEl) renderAll();
  },
};
