import * as U from "../util.js";
import { cached } from "../api.js";

let rootEl = null;
let context = null;
let payload = null;
let open = null;

let accountsPayload = null;
let sessionsPayload = null;
let clearing = new Set();

function render() {
  if (!rootEl || !payload) return;

  U.$("#diagMeta", rootEl).textContent = payload.dir
    ? `${payload.count} capture${payload.count === 1 ? "" : "s"} in ${payload.dir}`
    : "";

  const list = U.$("#diagList", rootEl);
  const entries = payload.entries || [];

  if (!entries.length) {
    list.innerHTML =
      '<li class="empty-note">No error captures \u2014 nothing has gone wrong badly enough to be worth a screenshot. Captures need <code>errorDiagnostics</code> enabled in the bot\u2019s config.</li>';
    return;
  }

  list.innerHTML = entries
    .map((entry) => {
      const isOpen = open === entry.name;
      const badges = [
        entry.hasScreenshot ? '<span class="tag-mini">screenshot</span>' : "",
        entry.hasError ? '<span class="tag-mini">error.txt</span>' : "",
        entry.hasHtml ? '<span class="tag-mini">dump.html</span>' : "",
      ].join("");

      const firstLine =
        (entry.error || "").split("\n").find((l) => l.trim()) ||
        "No error text captured.";

      const body = isOpen
        ? `<div class="diag-body">
                    ${entry.hasError
          ? `<pre class="diag-pre">${U.escapeHtml(entry.error || "")}</pre>`
          : '<p class="empty-note">No error.txt in this capture.</p>'
        }
                    ${entry.hasScreenshot
          ? `<a class="diag-shot" href="${U.escapeAttr(diagUrl(entry.name, "screenshot.png"))}" target="_blank" rel="noopener">
                                 <img src="${U.escapeAttr(diagUrl(entry.name, "screenshot.png"))}" alt="Screenshot captured when ${U.escapeAttr(entry.name)} failed" loading="lazy">
                               </a>`
          : ""
        }
                    ${entry.hasHtml
          ? `<p><a class="btn btn-small" href="${U.escapeAttr(diagUrl(entry.name, "dump.html"))}" download>Download dump.html</a></p>`
          : ""
        }
                   </div>`
        : "";

      return `<li class="diag-item">
                <button type="button" class="diag-head" data-diag="${U.escapeAttr(entry.name)}" aria-expanded="${isOpen}">
                    <span class="diag-when">${U.escapeHtml(U.fmtDateTime(entry.createdAt))}</span>
                    <span class="diag-name">${U.escapeHtml(entry.name)}</span>
                    <span class="diag-badges">${badges}</span>
                    <span class="exit-chevron" aria-hidden="true">${isOpen ? "\u25BE" : "\u25B8"}</span>
                </button>
                ${isOpen ? body : `<p class="diag-preview">${U.escapeHtml(String(firstLine || "").slice(0, 180))}</p>`}
            </li>`;
    })
    .join("");

  list.querySelectorAll("button[data-diag]").forEach((btn) =>
    btn.addEventListener("click", () => {
      open = open === btn.dataset.diag ? null : btn.dataset.diag;
      render();
    }),
  );
}

function diagUrl(name, file) {
  return `/api/diagnostics/${encodeURIComponent(name)}/${encodeURIComponent(file)}`;
}

// sessions

async function clearSession(email) {
  if (!context) return;
  const confirmed = window.confirm(
    `Clear stored sessions for ${email}?\n\nThis logs the account out immediately \u2014 it will need to sign back in (and re-approve 2FA if used) on its next run.`,
  );
  if (!confirmed) return;

  clearing.add(email);
  renderSessions();
  try {
    await context.api.clearSession(email);
    context.toast(`Sessions cleared for ${email}.`, "success");
    context.invalidate();
    await context.refresh();
  } catch (e) {
    context.toast(e.message, e.status === 409 ? "warn" : "error");
  } finally {
    clearing.delete(email);
    renderSessions();
  }
}

function renderSessions() {
  if (!rootEl) return;
  const list = U.$("#sessionCardList", rootEl);
  if (!list) return;

  if (!accountsPayload || !sessionsPayload) {
    list.innerHTML = '<p class="empty-note" style="padding:1.25rem">Loading&hellip;</p>';
    return;
  }

  const accounts = (accountsPayload.accounts || []).filter(
    (a) => a.configured,
  );
  if (!accounts.length) {
    list.innerHTML =
      '<p class="empty-note" style="padding:1.25rem">No configured accounts found.</p>';
    return;
  }

  const byEmail = new Map();
  for (const s of sessionsPayload.sessions || []) {
    const key = s.email.toLowerCase();
    if (!byEmail.has(key)) byEmail.set(key, []);
    byEmail.get(key).push(s);
  }

  const running = Boolean(context?.status?.botRunning);

  list.innerHTML = accounts
    .map((a) => {
      const sessions = byEmail.get(a.email.toLowerCase()) || [];
      const hasSessions = sessions.length > 0;
      const latest = sessions.reduce(
        (max, s) => (!max || s.updatedAt > max ? s.updatedAt : max),
        null,
      );
      const meta = hasSessions
        ? `${sessions.map((s) => U.escapeHtml(s.platform)).join(" \u00b7 ")} \u00b7 updated ${U.escapeHtml(U.fmtRelative(latest))}`
        : "No stored sessions";

      const isClearing = clearing.has(a.email);
      const disabled = !hasSessions || running || isClearing;
      const title = running
        ? "The bot must be idle to clear a session"
        : !hasSessions
          ? "Nothing stored for this account yet"
          : "";

      return `<div class="session-card">
                <div class="session-card-info">
                    <span class="session-card-email">${U.escapeHtml(a.email)}${a.index != null ? ` <span class="tag-mini">ACCOUNT_${a.index}</span>` : ""}</span>
                    <span class="session-card-meta">${meta}</span>
                </div>
                <button type="button" class="btn btn-danger btn-small" data-clear-session="${U.escapeAttr(a.email)}"
                    ${disabled ? "disabled" : ""} ${title ? `title="${U.escapeAttr(title)}"` : ""}>
                    ${isClearing ? "Clearing\u2026" : "Clear sessions"}
                </button>
            </div>`;
    })
    .join("");

  list.querySelectorAll("button[data-clear-session]").forEach((btn) =>
    btn.addEventListener("click", () =>
      clearSession(btn.dataset.clearSession),
    ),
  );
}

export default {
  id: "diagnostics",
  label: "Diagnostics",
  interval: 30000,

  mount(root, ctx) {
    rootEl = root;
    context = ctx;
    root.innerHTML = `
            <section class="panel" aria-labelledby="sessions-heading">
                <div class="panel-head">
                    <h2 id="sessions-heading">Session management</h2>
                    <span class="panel-sub">Clearing sessions can fix most common login issues</span>
                </div>
                <p class="notice notice--warn">
                    Clearing a session logs that account out immediately. It will need to sign in again
                    &mdash; and re-approve 2FA if used &mdash; on its next run. Only clear a session if you're
                    actually seeing login problems for that account.
                </p>
                <div class="session-card-list" id="sessionCardList">
                    <p class="empty-note" style="padding:1.25rem">Loading&hellip;</p>
                </div>
            </section>

            <section class="panel" aria-labelledby="diag-heading">
                <div class="panel-head">
                    <h2 id="diag-heading">Error captures</h2>
                    <span class="panel-sub" id="diagMeta"></span>
                    <button type="button" id="diagRefresh" class="btn btn-small">Refresh</button>
                </div>
                <ul class="diag-list" id="diagList">
                    <li class="empty-note">Loading&hellip;</li>
                </ul>
            </section>`;

    U.$("#diagRefresh", root).addEventListener("click", () =>
      this.refresh(ctx),
    );
  },

  async refresh(ctx) {
    context = ctx;
    try {
      payload = await ctx.api.diagnostics();
      render();
    } catch (e) {
      U.$("#diagList", rootEl).innerHTML =
        `<li class="notice notice--warn">${U.escapeHtml(e.message)}</li>`;
    }

    try {
      [accountsPayload, sessionsPayload] = await Promise.all([
        cached("accounts", ctx.api.accounts, 5000),
        ctx.api.sessions(),
      ]);
    } catch (e) {
      U.$("#sessionCardList", rootEl).innerHTML =
        `<p class="notice notice--warn">${U.escapeHtml(e.message)}</p>`;
      return;
    }
    renderSessions();
  },

  redraw() {
    render();
    renderSessions();
  },

  onState(state, ctx) {
    context = ctx;
    renderSessions();
  },
};