import * as U from "../util.js";
import { api } from "../api.js";

const REDACTED = "***REDACTED***";

let rootEl = null;
let loaded = null; // the config exactly as the API returned it
let meta = null; // { path, redacted }

const isPlainObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function deepDiff(base, next) {
  const out = {};
  for (const [k, v] of Object.entries(next)) {
    const b = isPlainObject(base) ? base[k] : undefined;
    if (isPlainObject(v) && isPlainObject(b)) {
      const sub = deepDiff(b, v);
      if (Object.keys(sub).length) out[k] = sub;
    } else if (JSON.stringify(v) !== JSON.stringify(b)) {
      out[k] = v;
    }
  }
  return out;
}

function booleanPaths(obj, prefix = "") {
  let out = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "boolean") out.push({ path, value: v });
    else if (isPlainObject(v)) out = out.concat(booleanPaths(v, path));
  }
  return out;
}

function nest(path, value) {
  const parts = path.split(".");
  const root = {};
  let node = root;
  for (let i = 0; i < parts.length - 1; i++) {
    node[parts[i]] = {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;
  return root;
}

function setDeep(obj, path, value) {
  const parts = path.split(".");
  let node = obj;
  for (let i = 0; i < parts.length - 1; i++) node = node[parts[i]];
  node[parts[parts.length - 1]] = value;
}

function showNotice(id, message, kind = "warn") {
  const el = U.$(`#${id}`, rootEl);
  el.hidden = !message;
  el.className = `notice notice--${kind}`;
  el.innerHTML = message || "";
}

function renderToggles() {
  const host = U.$("#cfgToggles", rootEl);
  const bools = booleanPaths(loaded);
  if (!bools.length) {
    host.innerHTML =
      '<p class="empty-note">No boolean settings in this config.</p>';
    return;
  }
  host.innerHTML = bools
    .map(
      (b) => `
        <label class="switch">
            <input type="checkbox" data-path="${U.escapeAttr(b.path)}" ${b.value ? "checked" : ""}>
            <span class="switch-label"><code>${U.escapeHtml(b.path)}</code></span>
        </label>`,
    )
    .join("");

  host.querySelectorAll("input[data-path]").forEach((input) =>
    input.addEventListener("change", async () => {
      const path = input.dataset.path;
      const value = input.checked;
      input.disabled = true;
      try {
        await save(nest(path, value), `${path} \u2192 ${value}`);
        setDeep(loaded, path, value);
        U.$("#cfgEditor", rootEl).value = JSON.stringify(loaded, null, 2);
      } catch {
        input.checked = !value; // roll the switch back; save() already explained why
      } finally {
        input.disabled = false;
      }
    }),
  );
}

async function save(patch, description) {
  try {
    const res = await api.patchConfig(patch);
    showNotice("cfgNotice", "");
    U.toast(`Saved: ${description}. Applies on the next run.`, "success");
    return res;
  } catch (e) {
    if (e.status === 403) {
      showNotice(
        "cfgNotice",
        "Config writes are disabled on the control API. Set <code>API_ALLOW_CONFIG_WRITE=true</code> in the bot&rsquo;s environment and restart it.",
      );
    } else if (e.status === 422) {
      const errors = (e.body && e.body.errors) || [];
      showNotice(
        "cfgNotice",
        `<strong>The bot rejected this config:</strong><ul>${errors.map((x) => `<li>${U.escapeHtml(x)}</li>`).join("")}</ul>`,
        "error",
      );
    } else {
      showNotice("cfgNotice", U.escapeHtml(e.message), "error");
    }
    U.toast(e.message, "error");
    throw e;
  }
}

function paint() {
  U.$("#cfgPath", rootEl).textContent = meta.path || "\u2013";
  U.$("#cfgRedacted", rootEl).hidden = !meta.redacted;
  U.$("#cfgEditor", rootEl).value = JSON.stringify(loaded, null, 2);
  renderToggles();
  showNotice("cfgNotice", "");
}

export default {
  id: "config",
  label: "Config",
  interval: 0, // never poll: it would stomp on whatever is in the editor

  mount(root, ctx) {
    rootEl = root;
    root.innerHTML = `
            <p class="notice notice--warn" id="cfgNotice" hidden></p>

            <section class="panel" aria-labelledby="cfg-toggle-heading">
                <div class="panel-head">
                    <h2 id="cfg-toggle-heading">Quick toggles</h2>
                    <span class="panel-sub">Every boolean in <code id="cfgPath">config.json</code>. Changes apply on the next run.</span>
                </div>
                <div class="switch-grid" id="cfgToggles"></div>
            </section>

            <section class="panel" aria-labelledby="cfg-raw-heading">
                <div class="panel-head">
                    <h2 id="cfg-raw-heading">Raw config</h2>
                    <span class="panel-sub">Only the fields you actually change are sent</span>
                    <label class="check">
                        <input type="checkbox" id="cfgReveal">
                        <span>Reveal secrets</span>
                    </label>
                </div>

                <p class="notice notice--info" id="cfgRedacted" hidden>
                    Webhook URLs and tokens are shown as <code>${REDACTED}</code>. Saving never overwrites them &mdash;
                    only the fields you edit are sent. To see and edit them, set <code>API_ALLOW_CONFIG_REVEAL=true</code>
                    on the control API and tick &ldquo;Reveal secrets&rdquo;.
                </p>

                <textarea id="cfgEditor" class="editor" spellcheck="false" autocomplete="off" aria-label="config.json"></textarea>

                <div class="form-actions">
                    <button type="button" id="cfgSave" class="btn btn-primary">Save changes</button>
                    <button type="button" id="cfgReload" class="btn">Reload from API</button>
                </div>
            </section>`;

    U.$("#cfgReload", root).addEventListener("click", () => this.refresh(ctx));

    U.$("#cfgReveal", root).addEventListener("change", async (e) => {
      try {
        const res = await ctx.api.config(e.target.checked);
        loaded = res.config;
        meta = { path: res.path, redacted: res.redacted };
        paint();
        if (e.target.checked && res.redacted) {
          showNotice(
            "cfgNotice",
            "The control API refused to reveal secrets. Set <code>API_ALLOW_CONFIG_REVEAL=true</code> (and an <code>API_TOKEN</code>) on it to enable this.",
          );
        }
      } catch (err) {
        U.toast(err.message, "error");
      }
    });

    U.$("#cfgSave", root).addEventListener("click", async () => {
      let edited;
      try {
        edited = JSON.parse(U.$("#cfgEditor", root).value);
      } catch (err) {
        showNotice(
          "cfgNotice",
          `Not valid JSON: ${U.escapeHtml(err.message)}`,
          "error",
        );
        return;
      }

      const patch = deepDiff(loaded, edited);
      if (!Object.keys(patch).length) {
        U.toast("Nothing changed.", "info");
        return;
      }

      if (JSON.stringify(patch).includes(REDACTED)) {
        showNotice(
          "cfgNotice",
          "That change would write <code>" +
          REDACTED +
          "</code> over a real secret. Enable <code>API_ALLOW_CONFIG_REVEAL=true</code> on the control API and tick &ldquo;Reveal secrets&rdquo; first.",
          "error",
        );
        return;
      }

      try {
        await save(
          patch,
          `${Object.keys(patch).length} field${Object.keys(patch).length === 1 ? "" : "s"}`,
        );
        loaded = edited;
        renderToggles();
      } catch {
      }
    });
  },

  async refresh(ctx) {
    try {
      const reveal = U.$("#cfgReveal", rootEl)?.checked || false;
      const res = await ctx.api.config(reveal);
      loaded = res.config;
      meta = { path: res.path, redacted: res.redacted };
      paint();
    } catch (e) {
      showNotice("cfgNotice", U.escapeHtml(e.message), "error");
    }
  },
};
