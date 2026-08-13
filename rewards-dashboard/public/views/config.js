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

// Non-boolean settings a human would actually want a real control for
// (text/number/select/tag-list), grouped the same way as TOGGLE_GROUPS.
// Unlike the toggles, this list is NOT auto-discovered from config.json -
// each field needs a specific input type (a duration string isn't the same
// UI as a webhook URL isn't the same UI as a keyword list), so it's
// hand-maintained same as the toggle descriptions. Descriptions are again
// verbatim from the README's "Configuration Options" tables.
const FIELD_GROUPS = [
  {
    title: "Core",
    fields: {
      sessionPath: {
        kind: "text",
        label: "Session path",
        desc: "Directory to store browser sessions",
        placeholder: "sessions",
      },
      clusters: {
        kind: "number",
        label: "Clusters",
        desc: "Number of concurrent account clusters",
        min: 0,
        step: 1,
        placeholder: "1",
      },
      globalTimeout: {
        kind: "text",
        label: "Global timeout",
        desc: "Timeout for all actions",
        placeholder: "30sec",
      },
      accountDelay: {
        kind: "delay",
        label: "Delay before next account",
        min: {
          path: "accountDelay.min",
          desc: "Minimum delay before starting the next configured account",
          placeholder: "1min",
        },
        max: {
          path: "accountDelay.max",
          desc: "Maximum delay before starting the next configured account",
          placeholder: "3min",
        },
      },
    },
  },
  {
    title: "Search settings",
    fields: {
      "searchSettings.maxBonusSearches": {
        kind: "number",
        label: "Max bonus searches",
        desc: "Max bonus searches per run (when Bonus searches is on)",
        min: 0,
        step: 1,
        placeholder: "110",
      },
      "searchSettings.searchResultVisitTime": {
        kind: "text",
        label: "Search result visit time",
        desc: "Time to spend on each search result",
        placeholder: "10sec",
      },
      "searchSettings.searchDelay": {
        kind: "delay",
        label: "Delay between searches",
        min: {
          path: "searchSettings.searchDelay.min",
          desc: "Minimum delay between searches",
          placeholder: "30sec",
        },
        max: {
          path: "searchSettings.searchDelay.max",
          desc: "Maximum delay between searches",
          placeholder: "1min",
        },
      },
      "searchSettings.readDelay": {
        kind: "delay",
        label: "Delay for reading",
        min: {
          path: "searchSettings.readDelay.min",
          desc: "Minimum delay for reading",
          placeholder: "30sec",
        },
        max: {
          path: "searchSettings.readDelay.max",
          desc: "Maximum delay for reading",
          placeholder: "1min",
        },
      },
      "searchSettings.queryEngines": {
        kind: "tags",
        label: "Query sources",
        desc: "Sources used to build the search query pool",
        placeholder: "e.g. google, rss.bbc",
        hint: "Valid: google, wikipedia, wikirandom, hackernews, reddit, local, or rss.<source> (e.g. rss.bbc, rss.googleNews).",
      },
    },
  },
  {
    title: "Logging",
    fields: {
      "consoleLogFilter.mode": {
        kind: "select",
        label: "Console filter mode",
        desc: "Filter mode (whitelist/blacklist)",
        options: [
          { value: "whitelist", label: "Whitelist" },
          { value: "blacklist", label: "Blacklist" },
        ],
      },
      "consoleLogFilter.levels": {
        kind: "tags",
        label: "Console filter levels",
        desc: "Log levels to filter",
        placeholder: "e.g. error, warn",
        suggestions: ["error", "warn", "info", "debug"],
      },
      "consoleLogFilter.keywords": {
        kind: "tags",
        label: "Console filter keywords",
        desc: "Keywords to filter",
        placeholder: "e.g. starting account",
      },
      "consoleLogFilter.regexPatterns": {
        kind: "tags",
        label: "Console filter regex patterns",
        desc: "Regex patterns for filtering",
        placeholder: "e.g. ^Error:",
        mono: true,
      },
    },
  },
  {
    title: "Webhooks",
    fields: {
      "webhook.discord.url": {
        kind: "text",
        label: "Discord webhook URL",
        desc: "Discord webhook URL",
        placeholder: "https://discord.com/api/webhooks/...",
      },
      "webhook.telegram.botToken": {
        kind: "text",
        label: "Telegram bot token",
        desc: "Telegram bot token",
      },
      "webhook.telegram.chatId": {
        kind: "text",
        label: "Telegram chat ID",
        desc: "Telegram chat id",
      },
      "webhook.ntfy.url": {
        kind: "text",
        label: "ntfy server URL",
        desc: "ntfy server URL",
        placeholder: "https://ntfy.sh",
      },
      "webhook.ntfy.topic": {
        kind: "text",
        label: "ntfy topic",
        desc: "ntfy topic",
      },
      "webhook.ntfy.token": {
        kind: "text",
        label: "ntfy auth token",
        desc: "ntfy authentication token",
      },
      "webhook.ntfy.title": {
        kind: "text",
        label: "ntfy notification title",
        desc: "Notification title",
        placeholder: "Microsoft-Rewards-Script",
      },
      "webhook.ntfy.tags": {
        kind: "tags",
        label: "ntfy tags",
        desc: "Notification tags",
        placeholder: "e.g. bot, notify",
      },
      "webhook.ntfy.priority": {
        kind: "select",
        label: "ntfy priority",
        desc: "Notification priority (1-5)",
        numeric: true,
        options: [
          { value: "1", label: "1 \u2013 Min" },
          { value: "2", label: "2 \u2013 Low" },
          { value: "3", label: "3 \u2013 Default" },
          { value: "4", label: "4 \u2013 High" },
          { value: "5", label: "5 \u2013 Max" },
        ],
      },
      "webhook.webhookLogFilter.mode": {
        kind: "select",
        label: "Webhook filter mode",
        desc: "Filter mode (whitelist/blacklist)",
        options: [
          { value: "whitelist", label: "Whitelist" },
          { value: "blacklist", label: "Blacklist" },
        ],
      },
      "webhook.webhookLogFilter.levels": {
        kind: "tags",
        label: "Webhook filter levels",
        desc: "Log levels to send",
        placeholder: "e.g. error, warn",
        suggestions: ["error", "warn", "info", "debug"],
      },
      "webhook.webhookLogFilter.keywords": {
        kind: "tags",
        label: "Webhook filter keywords",
        desc: "Keywords to filter",
        placeholder: "e.g. starting account",
      },
      "webhook.webhookLogFilter.regexPatterns": {
        kind: "tags",
        label: "Webhook filter regex patterns",
        desc: "Regex patterns for filtering",
        placeholder: "e.g. ^Error:",
        mono: true,
      },
    },
  },
];

// The exact filter the bot's own maintainer uses for push-notification
// webhooks (ntfy, and equally relevant to Discord/Telegram): without it,
// every log line - including debug noise - goes out as a notification.
const RECOMMENDED_WEBHOOK_FILTER = {
  webhook: {
    webhookLogFilter: {
      enabled: true,
      mode: "whitelist",
      levels: [],
      keywords: ["starting account", "select number", "collected"],
      regexPatterns: [],
    },
  },
};

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

function getDeep(obj, path) {
  let node = obj;
  for (const key of path.split(".")) {
    if (node == null) return undefined;
    node = node[key];
  }
  return node;
}

// Same shape as configEditor.js's server-side deepMerge (objects merge key
// by key, arrays/scalars replace wholesale) - used to fold a just-saved
// patch into the in-memory `loaded` config without a full re-fetch. No
// __proto__ guard here since these patches are always ones we built
// ourselves from known field paths, never parsed from outside input.
function localMerge(base, patch) {
  if (!isPlainObject(patch)) return patch;
  const out = { ...(isPlainObject(base) ? base : {}) };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) ? localMerge(out[k], v) : v;
  }
  return out;
}

// Folds a successful save's patch into `loaded` and refreshes every view
// that reads from it. Used by the Detailed settings controls (text/select/
// tag fields, the recommended-filter tip) rather than the toggle switches,
// which update `loaded` + the editor directly to avoid rebuilding the whole
// switch grid (and losing keyboard focus) on every single click.
function afterSave(patch) {
  loaded = localMerge(loaded, patch);
  renderToggles();
  renderFields();
  U.$("#cfgEditor", rootEl).value = JSON.stringify(loaded, null, 2);
}

function showNotice(id, message, kind = "warn") {
  const el = U.$(`#${id}`, rootEl);
  el.hidden = !message;
  el.className = `notice notice--${kind}`;
  el.innerHTML = message || "";
}

// Combines a field's description with its raw config path into one native
// tooltip string (description on the first line, path on the second) so
// hovering still surfaces both pieces of info now that neither is shown
// as visible on-page text.
function fieldTooltip(path, desc) {
  return desc ? `${desc}\n${path}` : path;
}

function switchHtml(b) {
  const meta = TOGGLE_META[b.path];
  const label = meta?.label || fallbackLabel(b.path);
  const desc = meta?.desc || "";
  return `
        <label class="switch" title="${U.escapeAttr(fieldTooltip(b.path, desc))}">
            <input type="checkbox" data-path="${U.escapeAttr(b.path)}" ${b.value ? "checked" : ""}>
            <span class="switch-label hint-text">${U.escapeHtml(label)}</span>
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
        renderFields(); // in case the changed toggle affects a Detailed settings field
      } catch {
        input.checked = !value; // roll the switch back; save() already explained why
      } finally {
        input.disabled = false;
      }
    }),
  );
}

function listId(path) {
  return `dl-${path.replace(/[^a-zA-Z0-9]/g, "-")}`;
}

function textFieldHtml(path, def) {
  const type = def.kind === "number" ? "number" : "text";
  const raw = getDeep(loaded, path);
  const locked = typeof raw === "string" && raw === REDACTED;
  const value = locked ? "" : (raw ?? "");
  return `
        <label class="field field-item" title="${U.escapeAttr(fieldTooltip(path, def.desc))}">
            <span class="hint-text">${U.escapeHtml(def.label)}</span>
            <input class="input" type="${type}" data-path="${U.escapeAttr(path)}"
                value="${U.escapeAttr(String(value))}"
                placeholder="${U.escapeAttr(locked ? "Hidden \u2014 tick \u201cReveal secrets\u201d below to edit" : def.placeholder || "")}"
                ${locked ? "disabled" : ""}
                ${def.min != null ? `min="${def.min}"` : ""}
                ${def.step != null ? `step="${def.step}"` : ""}>
            ${locked ? '<span class="field-locked">\uD83D\uDD12 Hidden until secrets are revealed</span>' : ""}
        </label>`;
}

function selectFieldHtml(path, def) {
  const raw = getDeep(loaded, path);
  const current = raw == null ? "" : String(raw);
  return `
        <label class="field field-item" title="${U.escapeAttr(fieldTooltip(path, def.desc))}">
            <span class="hint-text">${U.escapeHtml(def.label)}</span>
            <select class="input" data-path="${U.escapeAttr(path)}" ${def.numeric ? 'data-numeric="1"' : ""}>
                ${def.options
      .map(
        (o) =>
          `<option value="${U.escapeAttr(o.value)}" ${String(o.value) === current ? "selected" : ""}>${U.escapeHtml(o.label)}</option>`,
      )
      .join("")}
            </select>
        </label>`;
}

function tagsFieldHtml(path, def) {
  const raw = getDeep(loaded, path);
  const items = Array.isArray(raw) ? raw : [];
  const dlId = def.suggestions ? listId(path) : null;
  return `
        <div class="field field-item field-tags" title="${U.escapeAttr(fieldTooltip(path, def.desc))}" data-tags-path="${U.escapeAttr(path)}">
            <span class="hint-text">${U.escapeHtml(def.label)}</span>
            <div class="tag-chips">
                ${items
      .map(
        (item, i) => `
                    <span class="tag-chip${def.mono ? " tag-chip--mono" : ""}">
                        <span class="tag-chip-text">${U.escapeHtml(String(item))}</span>
                        <button type="button" class="tag-chip-remove" data-tag-remove="${i}" aria-label="Remove ${U.escapeAttr(String(item))}">&times;</button>
                    </span>`,
      )
      .join("")}
                ${!items.length ? '<span class="empty-note tag-empty">None set</span>' : ""}
            </div>
            <div class="tag-add">
                <input class="input tag-add-input" type="text" placeholder="${U.escapeAttr(def.placeholder || "Add value\u2026")}" ${dlId ? `list="${dlId}"` : ""}>
                <button type="button" class="btn btn-small tag-add-btn">Add</button>
            </div>
            ${dlId ? `<datalist id="${dlId}">${def.suggestions.map((s) => `<option value="${U.escapeAttr(s)}">`).join("")}</datalist>` : ""}
            ${def.hint ? `<span class="field-hint">${U.escapeHtml(def.hint)}</span>` : ""}
        </div>`;
}

function delaySubFieldHtml(groupLabel, subLabel, sub) {
  const value = getDeep(loaded, sub.path);
  return `
        <label class="field field-item" title="${U.escapeAttr(fieldTooltip(sub.path, sub.desc))}">
            <span class="hint-text">${U.escapeHtml(groupLabel)} \u2014 ${subLabel}</span>
            <input class="input" type="text" data-path="${U.escapeAttr(sub.path)}"
                value="${U.escapeAttr(value ?? "")}" placeholder="${U.escapeAttr(sub.placeholder || "")}">
        </label>`;
}

function fieldHtml(path, def) {
  switch (def.kind) {
    case "text":
    case "number":
      return textFieldHtml(path, def);
    case "select":
      return selectFieldHtml(path, def);
    case "tags":
      return tagsFieldHtml(path, def);
    case "delay":
      return (
        delaySubFieldHtml(def.label, "min", def.min) +
        delaySubFieldHtml(def.label, "max", def.max)
      );
    default:
      return "";
  }
}

function webhookFilterTipHtml() {
  return `
        <p class="notice notice--info cfg-tip">
            Set <strong>Webhook log filter</strong> to <em>on</em> before enabling a push-notification
            webhook like ntfy, or you&rsquo;ll get a notification for every log line, including debug noise.
            With it enabled, only account start, 2FA codes, and account completion summaries are delivered.
            Use whitelist mode and the &ldquo;Webhook filter keywords&rdquo; field below to customize exactly
            which notifications you receive.
            <span class="notice-actions">
                <button type="button" id="cfgWebhookFilterTipBtn" class="btn btn-primary btn-small">Apply recommended filter</button>
                <span class="notice-sub">whitelist &middot; starting account, select number, collected</span>
            </span>
        </p>`;
}

function renderFields() {
  const host = U.$("#cfgFields", rootEl);
  if (!host) return;

  host.innerHTML = FIELD_GROUPS.map(
    (group) => `
        <div class="acc-detail-group">
            <h3 class="acc-detail-group-title">${U.escapeHtml(group.title)}</h3>
            ${group.title === "Webhooks" ? webhookFilterTipHtml() : ""}
            <div class="field-grid">
                ${Object.entries(group.fields)
        .map(([path, def]) => fieldHtml(path, def))
        .join("")}
            </div>
        </div>`,
  ).join("");

  bindFieldEvents(host);
}

function bindFieldEvents(host) {
  host.querySelectorAll("input.input[data-path]").forEach((input) => {
    if (input.disabled) return; // locked/redacted - nothing to bind
    const path = input.dataset.path;
    const isNumber = input.type === "number";
    const original = input.value;

    const commit = async () => {
      const next = input.value.trim();
      if (next === original.trim()) return;
      if (next === "") {
        input.value = original;
        return;
      }
      const value = isNumber ? Number(next) : next;
      if (isNumber && Number.isNaN(value)) {
        U.toast("Enter a valid number.", "error");
        input.value = original;
        return;
      }
      input.disabled = true;
      try {
        await save(nest(path, value), `${path} \u2192 ${value}`);
        afterSave(nest(path, value));
      } catch {
        input.value = original; // save() already explained why
      } finally {
        input.disabled = false;
      }
    };

    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") input.blur();
    });
  });

  host.querySelectorAll("select.input[data-path]").forEach((select) => {
    const path = select.dataset.path;
    const numeric = select.dataset.numeric === "1";
    select.addEventListener("change", async () => {
      const raw = select.value;
      const value = numeric ? Number(raw) : raw;
      select.disabled = true;
      try {
        await save(nest(path, value), `${path} \u2192 ${value}`);
        afterSave(nest(path, value));
      } catch {
        const prev = getDeep(loaded, path);
        select.value = prev == null ? "" : String(prev); // save() already explained why
      } finally {
        select.disabled = false;
      }
    });
  });

  host.querySelectorAll("[data-tags-path]").forEach((wrap) => {
    const path = wrap.dataset.tagsPath;
    const controls = () => wrap.querySelectorAll("input,button");

    const commitTags = async (nextItems) => {
      controls().forEach((el) => (el.disabled = true));
      try {
        await save(
          nest(path, nextItems),
          `${path} \u2192 ${nextItems.length} item${nextItems.length === 1 ? "" : "s"}`,
        );
        afterSave(nest(path, nextItems)); // re-renders this field with the new list
      } catch {
        controls().forEach((el) => (el.disabled = false)); // save() already explained why
      }
    };

    wrap.querySelectorAll("[data-tag-remove]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.tagRemove);
        const items = Array.isArray(getDeep(loaded, path))
          ? [...getDeep(loaded, path)]
          : [];
        items.splice(idx, 1);
        commitTags(items);
      });
    });

    const input = wrap.querySelector(".tag-add-input");
    const addBtn = wrap.querySelector(".tag-add-btn");
    const addFromInput = () => {
      const value = input.value.trim();
      if (!value) return;
      const items = Array.isArray(getDeep(loaded, path))
        ? [...getDeep(loaded, path)]
        : [];
      if (items.includes(value)) {
        U.toast("Already in the list.", "info");
        input.value = "";
        return;
      }
      items.push(value);
      commitTags(items);
    };
    addBtn?.addEventListener("click", addFromInput);
    input?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        addFromInput();
      }
    });
  });

  const tipBtn = U.$("#cfgWebhookFilterTipBtn", host);
  tipBtn?.addEventListener("click", async () => {
    tipBtn.disabled = true;
    tipBtn.textContent = "Applying\u2026";
    try {
      await save(RECOMMENDED_WEBHOOK_FILTER, "recommended webhook filter");
      afterSave(RECOMMENDED_WEBHOOK_FILTER);
    } catch {
      // save() already explained why
    } finally {
      tipBtn.disabled = false;
      tipBtn.textContent = "Apply recommended filter";
    }
  });
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
  renderFields();
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

            <section class="panel" aria-labelledby="cfg-fields-heading">
                <div class="panel-head">
                    <h2 id="cfg-fields-heading">Detailed settings</h2>
                    <span class="panel-sub">Text, numbers, and lists. Saves as you fill in each field.</span>
                </div>
                <div class="cfg-toggle-groups" id="cfgFields"></div>
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
        renderFields();
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
