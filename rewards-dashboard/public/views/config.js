import * as U from "../util.js";
import { api } from "../api.js";

const REDACTED = "***REDACTED***";

let rootEl = null;
let loaded = null; // the config exactly as the API returned it
let meta = null; // { path, redacted }
let drift = null; // { addedKeys, upToDate } from GET /api/config/diff, or null if unknown

const isPlainObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);

// Human-readable name + description for every known boolean config path,
// grouped for display. Descriptions are copied verbatim from the README's
// "Configuration Options" tables (same wording, so the two stay in sync).
// Labels are ours (the README doesn't provide separate display names) - a
// few README descriptions just restate the setting name (e.g. "Claim bonus
// points" / "Proxy query engine requests"), so label and description read
// the same for those; that's expected, not a bug. Anything present in
// config.json but not listed here at all (e.g. a brand-new option from an
// update the dashboard hasn't caught up with yet) still renders - just with
// a name derived from its path and no description - under a trailing
// "Other settings" group, so the toggle grid never silently drops a real
// setting.
const TOGGLE_GROUPS = [
  {
    title: "Core",
    fields: {
      headless: {
        label: "Headless browser",
        desc: "Run browser invisibly",
      },
      errorDiagnostics: {
        label: "Error diagnostics",
        desc: "Save error and unknown-login page diagnostics under diagnostics/",
      },
      ensureStreakProtection: {
        label: "Ensure streak protection",
        desc: "Ensure streak protection is enabled",
      },
      autoClaimPunchcardRewards: {
        label: "Auto-claim punchcard rewards",
        desc: "Auto-claim completed punchcard rewards",
      },
      skipNonPointTasks: {
        label: "Skip non-point tasks",
        desc: "Skip tasks that award no points",
      },
      searchOnBingLocalQueries: {
        label: "Local queries for ExploreOnBing",
        desc: "Use the local query list for ExploreOnBing",
      },
    },
  },
  {
    title: "Workers",
    fields: {
      "workers.doDailySet": {
        label: "Daily set",
        desc: "Complete daily set",
      },
      "workers.doClaimBonusPoints": {
        label: "Claim bonus points",
        desc: "Claim bonus points",
      },
      "workers.doMorePromotions": {
        label: "More activities",
        desc: 'Complete "more activities"',
      },
      "workers.doPunchCards": {
        label: "Punch cards",
        desc: "Complete punchcards",
      },
      "workers.doAppPromotions": {
        label: "App promotions",
        desc: "Complete app promotions",
      },
      "workers.doDesktopSearch": {
        label: "Desktop search",
        desc: "Perform desktop searches",
      },
      "workers.doMobileSearch": {
        label: "Mobile search",
        desc: "Perform mobile searches",
      },
      "workers.doBonusSearches": {
        label: "Bonus searches",
        desc: "Farm bonus searches beyond the cap",
      },
      "workers.doDailyCheckIn": {
        label: "Daily check-in",
        desc: "Complete daily check-in",
      },
      "workers.doReadToEarn": {
        label: "Read to earn",
        desc: "Complete Read-to-Earn",
      },
      "workers.doActivateSearchPerk": {
        label: "Activate search perk",
        desc: 'Activate the "search Nx more" perk when present (runs after the daily set)',
      },
      "workers.doVisualSearch": {
        label: "Visual search",
        desc: "Activate the visual-search streak and perform visual searches",
      },
    },
  },
  {
    title: "Activities",
    fields: {
      "activities.urlReward": {
        label: "URL reward",
        desc: "Complete URL reward activities",
      },
      "activities.searchOnBing": {
        label: "ExploreOnBing",
        desc: "Complete ExploreOnBing offers",
      },
    },
  },
  {
    title: "Search settings",
    fields: {
      "searchSettings.scrollRandomResults": {
        label: "Scroll random results",
        desc: "Scroll randomly on results",
      },
      "searchSettings.clickRandomResults": {
        label: "Click random results",
        desc: "Click random links",
      },
      "searchSettings.runOnZeroPoints": {
        label: "Run on zero points",
        desc: "Run searches even when no search points remain",
      },
      "searchSettings.parallelSearching": {
        label: "Parallel searching",
        desc: "Run searches in parallel",
      },
      "searchSettings.clusterSearch": {
        label: "Cluster search",
        desc: "Cluster each main topic with Bing suggestions",
      },
    },
  },
  {
    title: "Experimental",
    fields: {
      "experimental.apiSearch": {
        label: "API search",
        desc: "Perform Bing searches over HTTP instead of driving a browser page",
      },
      "experimental.apiSearchOnBing": {
        label: "API ExploreOnBing",
        desc: "Complete ExploreOnBing offers over HTTP instead of the browser",
      },
      "experimental.blockMedia": {
        label: "Block media",
        desc: "Block browser image and media requests to reduce traffic",
      },
      "experimental.edgeBrowsing": {
        label: "Edge browsing",
        desc: "Report the 30-minute Edge browsing activity as a background HTTP task",
      },
    },
  },
  {
    title: "Logging",
    fields: {
      debugLogs: {
        label: "Debug logs",
        desc: "Enable debug logging",
      },
      "consoleLogFilter.enabled": {
        label: "Console log filter",
        desc: "Enable console log filtering",
      },
    },
  },
  {
    title: "Proxy",
    fields: {
      "proxy.queryEngine": {
        label: "Proxy query engine requests",
        desc: "Proxy query engine requests",
      },
      "proxy.ignoreCertificateErrors": {
        label: "Ignore certificate errors",
        desc: "Disable browser TLS certificate verification for intercept proxies",
      },
    },
  },
  {
    title: "Webhooks",
    fields: {
      "webhook.discord.enabled": {
        label: "Discord webhook",
        desc: "Enable Discord webhook",
      },
      "webhook.telegram.enabled": {
        label: "Telegram webhook",
        desc: "Enable Telegram webhook",
      },
      "webhook.ntfy.enabled": {
        label: "ntfy webhook",
        desc: "Enable ntfy notifications",
      },
      "webhook.webhookLogFilter.enabled": {
        label: "Webhook log filter",
        desc: "Enable webhook log filtering",
      },
    },
  },
];

const TOGGLE_META = {};
for (const group of TOGGLE_GROUPS) {
  for (const [path, meta] of Object.entries(group.fields)) {
    TOGGLE_META[path] = { ...meta, group: group.title };
  }
}
const OTHER_GROUP_TITLE = "Other settings";
const TOGGLE_GROUP_ORDER = [
  ...TOGGLE_GROUPS.map((g) => g.title),
  OTHER_GROUP_TITLE,
];

// Fallback for a boolean path with no entry above: "workers.doFooBar" ->
// "Foo bar". Keeps an unrecognized-but-real setting visible and readable
// rather than dropping it or showing the raw dotted path.
function fallbackLabel(path) {
  const last = path.split(".").pop();
  const spaced = last
    .replace(/^do/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  if (!spaced) return last;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

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

function switchHtml(b) {
  const meta = TOGGLE_META[b.path];
  const label = meta?.label || fallbackLabel(b.path);
  const desc = meta?.desc || "";
  return `
        <label class="switch" title="${U.escapeAttr(b.path)}">
            <input type="checkbox" data-path="${U.escapeAttr(b.path)}" ${b.value ? "checked" : ""}>
            <span class="switch-text">
                <span class="switch-label">${U.escapeHtml(label)}</span>
                ${desc ? `<span class="switch-desc">${U.escapeHtml(desc)}</span>` : ""}
            </span>
        </label>`;
}

function renderToggles() {
  const host = U.$("#cfgToggles", rootEl);
  const bools = booleanPaths(loaded);
  if (!bools.length) {
    host.innerHTML =
      '<p class="empty-note">No boolean settings in this config.</p>';
    return;
  }

  // Group in TOGGLE_GROUP_ORDER order; anything unrecognized falls into a
  // trailing "Other" group rather than being dropped.
  const byGroup = new Map();
  for (const b of bools) {
    const groupTitle = TOGGLE_META[b.path]?.group || OTHER_GROUP_TITLE;
    if (!byGroup.has(groupTitle)) byGroup.set(groupTitle, []);
    byGroup.get(groupTitle).push(b);
  }

  host.innerHTML = TOGGLE_GROUP_ORDER.filter((title) => byGroup.has(title))
    .map(
      (title) => `
        <div class="acc-detail-group">
            <h3 class="acc-detail-group-title">${U.escapeHtml(title)}</h3>
            <div class="switch-grid">
                ${byGroup.get(title).map(switchHtml).join("")}
            </div>
        </div>`,
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

function explainConfigError(e) {
  if (e.status === 403) {
    return {
      kind: "warn",
      message:
        "Config writes are disabled on the control API. Set <code>API_ALLOW_CONFIG_WRITE=true</code> in the bot&rsquo;s environment and restart it.",
    };
  }
  if (e.status === 422) {
    const errors = (e.body && e.body.errors) || [];
    return {
      kind: "error",
      message: `<strong>The bot rejected this config:</strong><ul>${errors.map((x) => `<li>${U.escapeHtml(x)}</li>`).join("")}</ul>`,
    };
  }
  return { kind: "error", message: U.escapeHtml(e.message) };
}

async function save(patch, description) {
  try {
    const res = await api.patchConfig(patch);
    showNotice("cfgNotice", "");
    U.toast(`Saved: ${description}. Applies on the next run.`, "success");
    return res;
  } catch (e) {
    const { kind, message } = explainConfigError(e);
    showNotice("cfgNotice", message, kind);
    U.toast(e.message, "error");
    throw e;
  }
}

async function checkDrift() {
  try {
    drift = await api.configDiff();
  } catch {
    drift = null; // best-effort; the rest of the page works fine without it
  }
  renderDrift();
}

function renderDrift() {
  const el = U.$("#cfgDrift", rootEl);
  if (!el) return;
  if (!drift || drift.upToDate || !drift.addedKeys?.length) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  const n = drift.addedKeys.length;
  el.hidden = false;
  el.className = "notice notice--warn";
  el.innerHTML = `
    <strong>Config update available</strong> &mdash; ${n} field${n === 1 ? "" : "s"} added in a recent script update:
    <ul>${drift.addedKeys.map((k) => `<li><code>${U.escapeHtml(k)}</code></li>`).join("")}</ul>
    <div class="notice-actions">
      <button type="button" id="cfgSyncBtn" class="btn btn-primary btn-small">Sync now</button>
      <span class="notice-sub">Adds the missing fields with their defaults. Your existing values are never changed.</span>
    </div>`;
  U.$("#cfgSyncBtn", rootEl).addEventListener("click", doSync);
}

async function doSync() {
  const btn = U.$("#cfgSyncBtn", rootEl);
  btn.disabled = true;
  btn.textContent = "Syncing\u2026";
  try {
    const result = await api.syncConfig();
    showNotice("cfgNotice", "");
    U.toast(
      result.patched
        ? `Synced ${result.addedKeys.length} field${result.addedKeys.length === 1 ? "" : "s"}. Applies on the next run.`
        : "Already up to date.",
      "success",
    );
    await loadConfig(U.$("#cfgReveal", rootEl)?.checked || false); // reload config.json (now includes the synced fields) and re-check drift
  } catch (e) {
    const { kind, message } = explainConfigError(e);
    showNotice("cfgNotice", message, kind);
    btn.disabled = false;
    btn.textContent = "Sync now";
  }
}

// Shared by initial load, "Reload from API", the reveal-secrets toggle, and
// post-sync reload - one place that fetches config.json + drift status together.
async function loadConfig(reveal) {
  const res = await api.config(reveal);
  loaded = res.config;
  meta = { path: res.path, redacted: res.redacted };
  paint();
  checkDrift(); // not awaited - drift banner fills in once it resolves, doesn't block the rest of the page
  return res;
}

function paint() {
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
            <div id="cfgDrift" hidden></div>

            <section class="panel" aria-labelledby="cfg-toggle-heading">
                <div class="panel-head">
                    <h2 id="cfg-toggle-heading">Quick toggles</h2>
                    <span class="panel-sub">Changes apply on the next run.</span>
                </div>
                <div class="cfg-toggle-groups" id="cfgToggles"></div>
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
                    <button type="button" id="cfgReload" class="btn" title="Discard unsaved edits and re-fetch config.json from the bot.">Reload from API</button>
                </div>
            </section>`;

    U.$("#cfgReload", root).addEventListener("click", () => this.refresh(ctx));

    U.$("#cfgReveal", root).addEventListener("change", async (e) => {
      try {
        const res = await loadConfig(e.target.checked);
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
      await loadConfig(reveal);
    } catch (e) {
      showNotice("cfgNotice", U.escapeHtml(e.message), "error");
    }
  },
};
