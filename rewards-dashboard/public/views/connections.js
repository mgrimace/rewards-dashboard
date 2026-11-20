import * as U from "../util.js";

let rootEl;
let context;
let connections = [];
let editing = null;
let busy = false;
let dragging = null;
let armedRemove = null; // two-step remove, same pattern as the accounts page
let armedAt = null;
let refreshSequence = 0;

function formTemplate(edited) {
  const nameHidden = Boolean(edited?.nameRedacted);
  const urlHidden = Boolean(edited?.apiUrlRedacted);
  const hasToken = Boolean(edited?.hasToken);
  return `
    <form id="connection-form" class="connection-form form" aria-labelledby="connection-form-heading">
      <h3 id="connection-form-heading" class="connection-form-title">${edited ? `Edit ${U.escapeHtml(edited.name)}` : "Add server"}</h3>
      <div class="field-grid">
        <label class="field field-item">
          <span>Name</span>
          <input class="input" name="name" ${nameHidden ? "" : "required"} maxlength="120" autocomplete="off"
            placeholder="${nameHidden ? "Hidden; leave blank to keep" : "alpha"}"
            value="${U.escapeAttr(nameHidden ? "" : edited?.name || "")}">
        </label>
        <label class="field field-item">
          <span>Control API URL</span>
          <input class="input" name="apiUrl" type="url" inputmode="url" ${urlHidden ? "" : "required"} maxlength="2048"
            autocomplete="off" autocapitalize="off" spellcheck="false"
            placeholder="${urlHidden ? "Hidden; leave blank to keep" : "http://server:3010"}"
            value="${U.escapeAttr(urlHidden ? "" : edited?.apiUrl || "")}">
        </label>
        <div class="field field-item field-wide">
          <label for="connection-token">Control API token <span class="field-hint">(optional)</span></label>
          <div class="input-group">
            <input class="input input--mono" id="connection-token" name="apiToken" type="password" maxlength="4096"
              autocomplete="new-password" autocapitalize="off" spellcheck="false" aria-describedby="connection-token-hint"
              placeholder="${hasToken ? "Stored token (leave blank to keep)" : "Paste token"}">
            <button type="button" class="btn" data-action="toggle-token" aria-controls="connection-token" aria-pressed="false">Show</button>
          </div>
          <span id="connection-token-hint" class="field-hint">${hasToken
            ? "A token is stored. If you change the URL, enter the token again or clear it."
            : "Stored on the dashboard and never displayed again."}</span>
        </div>
      </div>
      ${nameHidden || urlHidden ? '<p class="hint">Fields containing the stored token are hidden. Leave them blank to keep their existing values.</p>' : ""}
      ${hasToken ? '<label class="check check--row"><input type="checkbox" name="clearToken"><span>Clear the stored token</span></label>' : ""}
      <div id="connection-message" class="notice" role="status" hidden></div>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">${edited ? "Save changes" : "Add server"}</button>
        <button type="button" class="btn" data-action="test-form">Test connection</button>
        <button type="button" class="btn" data-action="cancel">Cancel</button>
      </div>
    </form>`;
}

function render() {
  const edited = connections.find((connection) => connection.id === editing);
  const formOpen = editing !== null;
  rootEl.innerHTML = `
    <section class="panel" aria-labelledby="connections-heading">
      <div class="panel-head">
        <h2 id="connections-heading">Connections</h2>
        <button type="button" class="btn btn-primary" data-action="add" ${formOpen ? "disabled" : ""}>Add server</button>
      </div>
      <div class="connections-intro">
        <p class="hint">Each server has its own accounts, history, schedule and controls.</p>
        ${connections.length > 1 ? '<p class="hint" id="connection-reorder-help">Drag the handle to reorder servers, or focus it and use the arrow keys.</p>' : ""}
      </div>
      ${formOpen ? formTemplate(edited) : '<div id="connection-message" class="notice" role="status" hidden></div>'}
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
              <button type="button" class="btn btn-small" data-action="export" data-id="${U.escapeAttr(connection.id)}" ${formOpen ? "disabled" : ""} title="Export this server's data for an older dashboard">Export</button>
              ${armedRemove === connection.id
                ? `<span class="acc-delete-confirm">
                    <button type="button" class="btn btn-icon btn-small" data-action="cancel-remove" data-id="${U.escapeAttr(connection.id)}" aria-label="Cancel remove" title="Cancel remove"><i class="ph ph-x" aria-hidden="true"></i></button>
                    <button type="button" class="btn btn-danger btn-icon btn-small" data-action="remove" data-id="${U.escapeAttr(connection.id)}" aria-label="Confirm remove ${U.escapeAttr(connection.name)}" title="Remove this server. Its historical data will be retained."><i class="ph ph-trash" aria-hidden="true"></i></button>
                  </span>`
                : `<button type="button" class="btn btn-danger btn-small btn-collapse" data-action="arm-remove" data-id="${U.escapeAttr(connection.id)}" aria-label="Remove ${U.escapeAttr(connection.name)}" title="${formOpen ? "Finish editing before removing a server" : "Remove this server"}" ${formOpen ? "disabled" : ""}><i class="ph ph-trash btn-collapse-icon" aria-hidden="true"></i><span class="btn-collapse-label">Remove</span></button>`}
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
      if (event.key === "Escape" && editing !== null && !busy && event.target.closest("#connection-form")) {
        event.preventDefault();
        U.$('#connection-form [data-action="cancel"]', rootEl).click();
        return;
      }
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
      if (editing !== null && ["arm-remove", "cancel-remove", "remove", "export"].includes(action)) return;
      if (action === "remove" && !U.confirmReady(armedAt)) return;
      const connection = connections.find((item) => item.id === id);
      if (action === "toggle-token") {
        const input = U.$("#connection-token", rootEl);
        const show = input.type === "password";
        input.type = show ? "text" : "password";
        button.textContent = show ? "Hide" : "Show";
        button.setAttribute("aria-pressed", String(show));
        return;
      }
      if (action === "arm-remove" || action === "cancel-remove") {
        armedRemove = action === "arm-remove" ? id : null;
        armedAt = armedRemove ? performance.now() : null;
        render();
        const next = action === "arm-remove" ? "cancel-remove" : "arm-remove";
        [...rootEl.querySelectorAll(`[data-action="${next}"]`)].find((b) => b.dataset.id === id)?.focus();
        return;
      }
      if (action === "add" || action === "edit" || action === "cancel") {
        armedRemove = null;
        armedAt = null;
        const previous = editing;
        editing = action === "add" ? "new" : action === "edit" ? id : null;
        render();
        if (editing !== null) U.$("#connection-form input:not([type=hidden])", rootEl)?.focus();
        else if (previous === "new") U.$('[data-action="add"]', rootEl)?.focus();
        else [...rootEl.querySelectorAll('[data-action="edit"]')].find((b) => b.dataset.id === previous)?.focus();
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
        } else if (action === "export" && connection) {
          const result = await context.api.exportConnection(id);
          message(`Export saved in the data directory as ${result.filename}. Automatic run settings are preserved.`, true);
        } else if (action === "remove" && connection) {
          armedRemove = null;
          armedAt = null;
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