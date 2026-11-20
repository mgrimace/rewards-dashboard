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
let filterServer = "all";
let servers = [];
let loaded = new Set();
let autoscroll = true;
let hasRemovedHistory = false;

const matches = (e) => {
  if (filterServer !== "all" && e.serverId !== filterServer) return false;
  if (
    filterLevel !== "all" &&
    (LEVEL_RANK[e.level] ?? 1) < LEVEL_RANK[filterLevel]
  )
    return false;
  if (!filterText) return true;
  const hay =
    `${e.serverName || ""} ${e.title || ""} ${e.platform || ""} ${e.accountName || e.user || e.email || e.userName || ""} ${e.message || ""}`.toLowerCase();
  return hay.includes(filterText);
};

function lineHtml(e) {
  const timestamp = e.ts || e.receivedAt;
  const time = timestamp ? U.fmtTime(timestamp) : "";
  const tag = e.title || e.level;
  const accountName = e.accountName || e.user || e.email || e.userName || "";
  const account = accountName
    ? `<span class="log-account">${U.escapeHtml(accountName)}</span>`
    : "";
  return `<div class="log-line log-line--${U.escapeAttr(e.level)}">
        <span class="log-time">${U.escapeHtml(time)}</span>
        <span class="log-server${hasRemovedHistory ? "" : " multi-server-only"}">${U.escapeHtml(e.serverName || e.serverId)}</span>
        <span class="log-level log-level--${U.escapeAttr(e.level)}">${U.escapeHtml(e.level)}</span>
        <span class="log-tag">${U.escapeHtml(tag || "")}</span>
        ${account}
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

function entryKey(entry) {
  return JSON.stringify([entry.serverId, entry.historical ? "history" : "live", entry.id]);
}

function addEntry(entry, live) {
  if (!entry || entry.id == null || !entry.serverId || seen.has(entryKey(entry))) return false;
  seen.add(entryKey(entry));

  const timestamp = (e) => String(e.ts || e.receivedAt || "");
  const inOrder = !entries.length || timestamp(entry) >= timestamp(entries[entries.length - 1]);
  if (inOrder) entries.push(entry);
  else {
    entries.push(entry);
    entries.sort((a, b) => timestamp(a).localeCompare(timestamp(b)));
  }

  if (entries.length > MAX_LINES * 2) {
    const dropped = entries.splice(0, entries.length - MAX_LINES);
    for (const d of dropped) seen.delete(entryKey(d));
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
  const text = entries.filter(matches).map((e) => `[${e.serverName || e.serverId}] ${e.raw || e.message || ""}`).join("\n");
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
                    <label class="field field--inline multi-server-only" id="logServerField"><span>Server</span><select id="logServer" class="input"><option value="all">All servers</option></select></label>
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
                    <button type="button" id="logMore" class="btn">Load 5000</button>
                    <button type="button" id="logDownload" class="btn">Download</button>
                    <button type="button" id="logClear" class="btn">Clear</button>
                </div>
                <p class="notice notice--warn" id="logErrors" hidden></p>
                <p class="hint multi-server-only" id="logHistoryHint">Removed and disabled servers show retained dashboard activity, not full upstream logs.</p>

                <div class="log-box" id="logBox" tabindex="0" aria-live="off">
                    <p class="empty-note">Waiting for log lines\u2026</p>
                </div>
            </section>`;

    U.$("#logServer", root).addEventListener("change", (e) => {
      filterServer = e.target.value;
      renderAll();
    });
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
        await load(ctx, 5000, true);
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
    await load(ctx, 500, false);
    renderAll();
  },

  onLog(entry) {
    if (!rootEl) return;
    const server = servers.find((item) => item.id === entry.serverId);
    addEntry({ ...entry, serverName: server?.name || entry.serverId }, true);
  },

  onConnections(list, ctx) {
    for (const previous of servers) {
      if (previous.enabled && !list.some((item) => item.id === previous.id)) loaded.delete(previous.id);
    }
    for (const server of list) {
      const previous = servers.find((item) => item.id === server.id);
      if (previous && previous.enabled !== server.enabled) loaded.delete(server.id);
      for (const entry of entries) {
        if (entry.serverId === server.id) entry.serverName = server.name;
      }
    }
    void load(ctx, 500, false).then(renderAll).catch((error) => U.toast(error.message, "error"));
  },

  onReset(serverId) {
    entries = entries.filter((entry) => entry.serverId !== serverId || entry.historical);
    seen = new Set(entries.map(entryKey));
    loaded.delete(serverId);
    pendingWhilePaused = 0;
    if (rootEl) renderAll();
  },

  redraw() {
    if (rootEl) renderAll();
  },
};

async function load(ctx, limit, force) {
  servers = (await ctx.api.connections(true)).connections;
  const select = U.$("#logServer", rootEl);
  if (filterServer !== "all" && !servers.some((server) => server.id === filterServer)) filterServer = "all";
  select.innerHTML = '<option value="all">All servers</option>' + servers.map((server) =>
    `<option value="${U.escapeAttr(server.id)}">${U.escapeHtml(server.name)}${server.deletedAt ? " (removed)" : !server.enabled ? " (disabled)" : ""}</option>`).join("");
  select.value = filterServer;
  const pending = servers.filter((server) => force || !loaded.has(server.id));
  const results = await Promise.allSettled(pending.map((server) =>
    ctx.api.forServer(server.id, !server.enabled || Boolean(server.deletedAt)).logs(limit)));
  const errors = [];
  results.forEach((result, index) => {
    const server = pending[index];
    if (result.status === "rejected") {
      errors.push(`${server.name}: ${result.reason.message}`);
      return;
    }
    loaded.add(server.id);
    for (const entry of result.value.logs || [])
      addEntry({ ...entry, serverId: server.id, serverName: server.name, historical: Boolean(result.value.historical) }, false);
  });
  const error = U.$("#logErrors", rootEl);
  error.hidden = !errors.length;
  error.textContent = errors.join(" · ");
  const removedIds = new Set(servers.filter((server) => server.deletedAt).map((server) => server.id));
  hasRemovedHistory = entries.some((entry) => removedIds.has(entry.serverId));
  U.$("#logServerField", rootEl).classList.toggle("multi-server-only", !hasRemovedHistory);
  U.$("#logHistoryHint", rootEl).classList.toggle("multi-server-only", !hasRemovedHistory);
  if (!hasRemovedHistory && !document.documentElement.hasAttribute("data-multi-server")) {
    filterServer = "all";
    select.value = filterServer;
  }
}
