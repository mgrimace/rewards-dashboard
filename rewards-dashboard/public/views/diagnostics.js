import * as U from "../util.js";

let rootEl = null;
let payload = null;
let open = null;

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

export default {
  id: "diagnostics",
  label: "Diagnostics",
  interval: 30000,

  mount(root, ctx) {
    rootEl = root;
    root.innerHTML = `
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
    try {
      payload = await ctx.api.diagnostics();
      render();
    } catch (e) {
      U.$("#diagList", rootEl).innerHTML =
        `<li class="notice notice--warn">${U.escapeHtml(e.message)}</li>`;
    }
  },

  redraw() {
    render();
  },
};
