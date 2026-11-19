import * as U from "../util.js";

let rootEl;
let context;
let connections = [];
let editing = null;
let busy = false;
let dragging = null;
let refreshSequence = 0;

function render() {
  const edited = connections.find((connection) => connection.id === editing);
  const formOpen = editing !== null;
  rootEl.innerHTML = `
    <section class="panel" aria-labelledby="connections-heading">
      <div class="panel-head">
        <h2 id="connections-heading">Connections</h2>
        <button type="button" class="btn btn-primary" data-action="add">Add server</button>
      </div>
      <p class="hint">Each server has its own accounts, history, schedule and controls.</p>
      ${connections.length > 1 ? '<p class="hint" id="connection-reorder-help">Drag the handle to reorder servers, or focus it and use the arrow keys.</p>' : ""}
      <div id="connection-message" class="notice" role="status" hidden></div>
      ${formOpen ? `
        <form id="connection-form" class="panel">
          <h3>${edited ? "Edit connection" : "Add connection"}</h3>
          <label class="field"><span>Name</span>
            <input class="input" name="name" ${edited?.nameRedacted ? "" : "required"} maxlength="120" value="${U.escapeAttr(edited?.nameRedacted ? "" : edited?.name || "")}" ${edited?.nameRedacted ? 'placeholder="Hidden; leave blank to keep"' : ""}></label>
          <label class="field"><span>Control API URL</span>
            <input class="input" name="apiUrl" type="url" ${edited?.apiUrlRedacted ? "" : "required"} maxlength="2048" placeholder="${edited?.apiUrlRedacted ? "Hidden; leave blank to keep" : "http://server:3010"}" value="${U.escapeAttr(edited?.apiUrlRedacted ? "" : edited?.apiUrl || "")}"></label>
          ${edited?.nameRedacted || edited?.apiUrlRedacted ? '<p class="hint">Fields containing the stored token are hidden. Leave them blank to keep their existing values.</p>' : ""}
          <label class="field"><span>Control API token</span>
            <input class="input" name="apiToken" type="password" maxlength="4096" autocomplete="new-password" placeholder="${edited?.hasToken ? "Stored token (leave blank to keep)" : "Optional token"}"></label>
          ${edited?.hasToken ? '<p class="hint">If you change the URL, enter the token again or clear it.</p>' : ""}
          ${edited?.hasToken ? `<label class="check"><input type="checkbox" name="clearToken"><span>Clear the stored token</span></label>` : ""}
          <div class="toolbar">
            <button type="submit" class="btn btn-primary">Save</button>
            <button type="button" class="btn" data-action="test-form">Test connection</button>
            <button type="button" class="btn" data-action="cancel">Cancel</button>
          </div>
        </form>` : ""}
      <div class="connection-list">
        ${connections.length ? connections.map((connection) => `
          <article class="connection-row" data-connection-id="${U.escapeAttr(connection.id)}">
            <button type="button" class="connection-grab" data-grab="${U.escapeAttr(connection.id)}"
              aria-label="Reorder ${U.escapeAttr(connection.name)}" ${connections.length > 1 ? 'aria-describedby="connection-reorder-help"' : ""}
              title="Drag or use arrow keys to reorder" ${connections.length < 2 || formOpen ? "disabled" : ""}>
              <i class="ph ph-dots-nine" aria-hidden="true"></i>
            </button>
            <div class="connection-info">
              <div class="connection-title">
                <h3>${U.escapeHtml(connection.name)}</h3>
                <span class="pill ${connection.status === "connected" ? "pill-success" : connection.status === "disabled" ? "pill-idle" : "pill-warn"}">${U.escapeHtml(connection.status)}</span>
              </div>
              <span class="connection-meta">${U.escapeHtml(connection.apiUrl)} · ${connection.checkedAt ? `Checked ${U.escapeHtml(U.fmtDateTime(connection.checkedAt))}` : "Not checked yet"}${connection.lastError ? ` · ${U.escapeHtml(connection.lastError)}` : ""}</span>
            </div>
            <div class="connection-actions">
              <button type="button" class="btn btn-small" data-action="edit" data-id="${U.escapeAttr(connection.id)}">Edit</button>
              <button type="button" class="btn btn-small" data-action="test" data-id="${U.escapeAttr(connection.id)}">Test</button>
              <button type="button" class="btn btn-small" data-action="toggle" data-id="${U.escapeAttr(connection.id)}">${connection.enabled ? "Disable" : "Enable"}</button>
              <button type="button" class="btn btn-small btn-danger" data-action="remove" data-id="${U.escapeAttr(connection.id)}">Remove</button>
            </div>
          </article>`).join("") : '<p class="empty-note">No servers configured. Add a connection to get started.</p>'}
      </div>
    </section>`;
}

function message(text, ok) {
  const el = U.$("#connection-message", rootEl);
  el.hidden = false;
  el.className = `notice ${ok ? "notice--success" : "notice--warn"}`;
  el.textContent = text;
}

function formValues() {
  const form = U.$("#connection-form", rootEl);
  if (!form.reportValidity()) return null;
  const data = new FormData(form);
  const edited = connections.find((connection) => connection.id === editing);
  const body = {};
  if (!edited?.nameRedacted || data.get("name")) body.name = data.get("name");
  if (!edited?.apiUrlRedacted || data.get("apiUrl")) body.apiUrl = data.get("apiUrl");
  const token = data.get("apiToken");
  if (token || data.has("clearToken") || editing === "new") body.apiToken = data.has("clearToken") ? "" : token;
  return body;
}

async function run(action) {
  if (busy) return;
  busy = true;
  try { await action(); }
  catch (error) { message(error.message, false); }
  finally { busy = false; }
}

function reorderedIds(id, beforeId) {
  const ids = connections.map((connection) => connection.id);
  const from = ids.indexOf(id);
  if (from < 0 || (beforeId !== null && !ids.includes(beforeId))) return null;
  const to = beforeId === null ? ids.length : ids.indexOf(beforeId);
  ids.splice(from, 1);
  ids.splice(to - (from < to ? 1 : 0), 0, id);
  return ids.every((item, index) => item === connections[index].id) ? null : ids;
}

function clearDrag() {
  rootEl.querySelectorAll(".connection-row").forEach((row) =>
    row.classList.remove("connection-row--dragging", "connection-row--drop-before", "connection-row--drop-after"));
  dragging = null;
}

export default {
  id: "connections",
  label: "Connections",
  interval: 10000,
  mount(root, ctx) {
    rootEl = root;
    context = ctx;
    const persistOrder = (ids, focusId) => {
      if (!ids) return;
      refreshSequence++;
      void run(async () => {
        await context.api.reorderConnections(ids);
        await this.refresh(context, { force: true });
        message("Server order updated.", true);
        if (focusId) {
          [...root.querySelectorAll("[data-grab]")].find((handle) => handle.dataset.grab === focusId)?.focus();
        }
      });
    };
    root.addEventListener("pointerdown", (event) => {
      const handle = event.target.closest("button[data-grab]");
      if (!handle || handle.disabled || busy || editing !== null || event.button !== 0) return;
      refreshSequence++;
      dragging = { id: handle.dataset.grab, pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false, beforeId: null };
      handle.setPointerCapture(event.pointerId);
      handle.closest(".connection-row").classList.add("connection-row--dragging");
    });
    root.addEventListener("pointermove", (event) => {
      if (!dragging || dragging.pointerId !== event.pointerId) return;
      if (!dragging.moved && Math.hypot(event.clientX - dragging.x, event.clientY - dragging.y) < 6) return;
      dragging.moved = true;
      const rows = [...root.querySelectorAll(".connection-row")];
      rows.forEach((row) => row.classList.remove("connection-row--drop-before", "connection-row--drop-after"));
      const before = rows.find((row) => {
        const rect = row.getBoundingClientRect();
        return event.clientY < rect.top + rect.height / 2;
      });
      dragging.beforeId = before?.dataset.connectionId || null;
      if (before) before.classList.add("connection-row--drop-before");
      else rows.at(-1)?.classList.add("connection-row--drop-after");
      event.preventDefault();
    });
    root.addEventListener("pointerup", (event) => {
      if (!dragging || dragging.pointerId !== event.pointerId) return;
      const { id, beforeId, moved } = dragging;
      clearDrag();
      if (moved) persistOrder(reorderedIds(id, beforeId), id);
    });
    root.addEventListener("pointercancel", (event) => {
      if (dragging?.pointerId === event.pointerId) clearDrag();
    });
    root.addEventListener("keydown", (event) => {
      const handle = event.target.closest("button[data-grab]");
      if (!handle || handle.disabled || busy || dragging || editing !== null || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault();
      const index = connections.findIndex((connection) => connection.id === handle.dataset.grab);
      if (index < 0) return;
      const before = event.key === "ArrowUp" ? connections[index - 1] : connections[index + 2];
      if (event.key === "ArrowUp" && !before) return;
      if (event.key === "ArrowDown" && index === connections.length - 1) return;
      persistOrder(reorderedIds(handle.dataset.grab, before?.id || null), handle.dataset.grab);
    });
    root.addEventListener("submit", (event) => {
      if (event.target.id !== "connection-form") return;
      event.preventDefault();
      const body = formValues();
      if (!body) return;
      void run(async () => {
        if (editing === "new") await context.api.addConnection(body);
        else await context.api.updateConnection(editing, body);
        location.reload();
      });
    });
    root.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button || busy || dragging) return;
      const { action, id } = button.dataset;
      const connection = connections.find((item) => item.id === id);
      if (action === "add" || action === "edit" || action === "cancel") {
        editing = action === "add" ? "new" : action === "edit" ? id : null;
        render();
        return;
      }
      void run(async () => {
        if (action === "test-form") {
          const body = formValues();
          if (!body) return;
          if (editing !== "new") body.id = editing;
          const result = await context.api.testConnection(body);
          message(result.message, result.ok);
        } else if (action === "test" && connection) {
          const result = await context.api.testConnection({ id });
          message(`${connection.name}: ${result.message}`, result.ok);
        } else if (action === "toggle" && connection) {
          await context.api.updateConnection(id, { enabled: !connection.enabled });
          location.reload();
        } else if (action === "remove" && connection) {
          if (!window.confirm(`Remove ${connection.name}? Its historical data will be retained.`)) return;
          await context.api.removeConnection(id);
          location.reload();
        }
      });
    });
  },
  async refresh(ctx, { force = false } = {}) {
    if (editing !== null || dragging || (!force && (busy || rootEl.contains(document.activeElement)))) return;
    const sequence = ++refreshSequence;
    const next = (await ctx.api.connections()).connections || [];
    if (sequence !== refreshSequence || dragging || editing !== null || (!force && busy)) return;
    connections = next;
    render();
  },
};
