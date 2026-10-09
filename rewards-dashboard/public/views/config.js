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
    title: "核心基础设置",
    fields: {
      headless: {
        label: "无头模式 (后台运行)",
        desc: "Run browser invisibly",
      },
      errorDiagnostics: {
        label: "Error diagnostics",
        desc: "Save error and unknown-login page diagnostics under diagnostics/",
      },
      ensureStreakProtection: {
        label: "开启连击保护",
        desc: "Ensure streak protection is enabled",
      },
      autoClaimPunchcardRewards: {
        label: "自动领取打卡奖励",
        desc: "Auto-claim completed punchcard rewards",
      },
      skipNonPointTasks: {
        label: "跳过无积分任务",
        desc: "Skip tasks that award no points",
      },
      searchOnBingLocalQueries: {
        label: "Bing探索活动使用本地词库",
        desc: "Use the local query list for ExploreOnBing",
      },
    },
  },
  {
    title: "任务执行项 (Workers)",
    fields: {
      "workers.doDailySet": {
        label: "每日集任务",
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
        label: "打卡活动",
        desc: "Complete punchcards",
      },
      "workers.doAppPromotions": {
        label: "App promotions",
        desc: "Complete app promotions",
      },
      "workers.doDesktopSearch": {
        label: "桌面端搜索",
        desc: "Perform desktop searches",
      },
      "workers.doMobileSearch": {
        label: "移动端搜索",
        desc: "Perform mobile searches",
      },
      "workers.doBonusSearches": {
        label: "加成搜索",
        desc: "Farm bonus searches beyond the cap",
      },
      "workers.doDailyCheckIn": {
        label: "每日签到",
        desc: "Complete daily check-in",
      },
      "workers.doReadToEarn": {
        label: "阅读赚取积分",
        desc: "Complete Read-to-Earn",
      },
      "workers.doActivateSearchPerk": {
        label: "激活搜索加成",
        desc: 'Activate the "search Nx more" perk when present (runs after the daily set)',
      },
      "workers.doVisualSearch": {
        label: "视觉搜索",
        desc: "Activate the visual-search streak and perform visual searches",
      },
    },
  },
  {
    title: "活动与奖励项",
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
    title: "搜索参数设置",
    fields: {
      "searchSettings.scrollRandomResults": {
        label: "模拟随机滚动结果页",
        desc: "Scroll randomly on results",
      },
      "searchSettings.clickRandomResults": {
        label: "模拟随机点击结果项",
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
    title: "实验性功能",
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
        label: "拦截媒体资源",
        desc: "Block browser image and media requests to reduce traffic",
      },
      "experimental.edgeBrowsing": {
        label: "Edge 连击模拟",
        desc: "Report the 30-minute Edge browsing activity as a background HTTP task",
      },
    },
  },
  {
    title: "日志记录与过滤",
    fields: {
      debugLogs: {
        label: "调试日志",
        desc: "Enable debug logging",
      },
      "consoleLogFilter.enabled": {
        label: "控制台日志过滤",
        desc: "Enable console log filtering",
      },
    },
  },
  {
    title: "网络代理",
    fields: {
      "proxy.queryEngine": {
        label: "词库引擎代理",
        desc: "Proxy query engine requests",
      },
      "proxy.ignoreCertificateErrors": {
        label: "忽略证书错误",
        desc: "Disable browser TLS certificate verification for intercept proxies",
      },
    },
  },
  {
    title: "Webhook 微信与通知推送",
    fields: {
      "webhook.discord.enabled": {
        label: "Discord 推送",
        desc: "Enable Discord webhook",
      },
      "webhook.telegram.enabled": {
        label: "Telegram 推送",
        desc: "Enable Telegram webhook",
      },
      "webhook.ntfy.enabled": {
        label: "ntfy 推送",
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
    title: "核心基础设置",
    fields: {
      sessionPath: {
        kind: "text",
        label: "会话存储目录",
        desc: "Directory to store browser sessions",
        placeholder: "sessions",
      },
      clusters: {
        kind: "number",
        label: "并发集群数",
        desc: "Number of concurrent account clusters",
        min: 0,
        step: 1,
        placeholder: "1",
      },
      globalTimeout: {
        kind: "text",
        label: "全局超时时间",
        desc: "Timeout for all actions",
        placeholder: "30sec",
      },
      accountDelay: {
        kind: "delay",
        label: "切换下一账号前延迟",
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
    title: "搜索参数设置",
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
        label: "搜索结果停留时间",
        desc: "Time to spend on each search result",
        placeholder: "10sec",
      },
      "searchSettings.searchDelay": {
        kind: "delay",
        label: "每次搜索之间延迟",
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
        label: "阅读文章之间延迟",
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
        label: "搜索词库源",
        desc: "Sources used to build the search query pool",
        placeholder: "e.g. google, rss.bbc",
        hint: "Valid: google, wikipedia, wikirandom, hackernews, reddit, local, or rss.<source> (e.g. rss.bbc, rss.googleNews).",
      },
    },
  },
  {
    title: "日志记录与过滤",
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
    title: "Webhook 微信与通知推送",
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

// Looked up by group title when rendering the combined toggles+fields
// section, so each group's card can render its fields (if any) right under
// its toggles (if any) - see renderSettings().
const FIELD_GROUPS_BY_TITLE = new Map(
  FIELD_GROUPS.map((g) => [g.title, g.fields]),
);

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

// Folds a successful save's patch into `loaded` and refreshes the combined
// toggles+fields section plus the raw JSON editor. Used by every control in
// that section (toggle switches, text/select/tag fields, the recommended-
// filter tip) - a single rebuild keeps all of it consistent, e.g. flipping
// "Webhook log filter" on via the tip button correctly checks that same
// toggle switch too, since they're now rendered from the same pass.
function afterSave(patch) {
  loaded = localMerge(loaded, patch);
  renderSettings();
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

function renderSettings() {
  const host = U.$("#cfgSettings", rootEl);
  if (!host) return;

  // Group booleans in TOGGLE_GROUP_ORDER order; anything unrecognized falls
  // into a trailing "Other settings" group rather than being dropped.
  const bools = booleanPaths(loaded);
  const togglesByGroup = new Map();
  for (const b of bools) {
    const groupTitle = TOGGLE_META[b.path]?.group || OTHER_GROUP_TITLE;
    if (!togglesByGroup.has(groupTitle)) togglesByGroup.set(groupTitle, []);
    togglesByGroup.get(groupTitle).push(b);
  }

  // TOGGLE_GROUP_ORDER already lists every group that can have detail
  // fields too (Core/Search settings/Logging/Webhooks are a subset of it),
  // so it's the single source of truth for section order - toggles for a
  // group render first, its detail fields render underneath, in the same
  // card, so e.g. "Webhook log filter" (the enable toggle) sits directly
  // above the filter's mode/levels/keywords fields it controls.
  host.innerHTML = TOGGLE_GROUP_ORDER.filter(
    (title) => togglesByGroup.has(title) || FIELD_GROUPS_BY_TITLE.has(title),
  )
    .map((title) => {
      const toggles = togglesByGroup.get(title) || [];
      const fields = FIELD_GROUPS_BY_TITLE.get(title);
      return `
        <div class="acc-detail-group">
            <h3 class="acc-detail-group-title">${U.escapeHtml(title)}</h3>
            ${toggles.length ? `<div class="switch-grid">${toggles.map(switchHtml).join("")}</div>` : ""}
            ${title === "Webhooks" ? webhookFilterTipHtml() : ""}
            ${fields
          ? `<div class="field-grid">${Object.entries(fields)
            .map(([path, def]) => fieldHtml(path, def))
            .join("")}</div>`
          : ""
        }
        </div>`;
    })
    .join("");

  bindToggleEvents(host);
  bindFieldEvents(host);
}

function bindToggleEvents(host) {
  host.querySelectorAll('input[type="checkbox"][data-path]').forEach((input) =>
    input.addEventListener("change", async () => {
      const path = input.dataset.path;
      const value = input.checked;
      input.disabled = true;
      try {
        await save(nest(path, value), `${path} \u2192 ${value}`);
        afterSave(nest(path, value)); // rebuilds the whole section from the new state
      } catch {
        input.checked = !value; // roll the switch back; save() already explained why
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
                placeholder="${U.escapeAttr(locked ? "敏感信息已隐藏 — 勾选下方的“显示敏感配置”以编辑" : def.placeholder || "")}"
                ${locked ? "disabled" : ""}
                ${def.min != null ? `min="${def.min}"` : ""}
                ${def.step != null ? `step="${def.step}"` : ""}>
            ${locked ? '<span class="field-locked">🔒 敏感信息已隐藏（点击下方“显示敏感配置”查看）</span>' : ""}
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
                        <button type="button" class="tag-chip-remove" data-tag-remove="${i}" aria-label="移除 ${U.escapeAttr(String(item))}">&times;</button>
                    </span>`,
      )
      .join("")}
                ${!items.length ? '<span class="empty-note tag-empty">未设置</span>' : ""}
            </div>
            <div class="tag-add">
                <input class="input tag-add-input" type="text" placeholder="${U.escapeAttr(def.placeholder || "添加值\u2026")}" ${dlId ? `list="${dlId}"` : ""}>
                <button type="button" class="btn btn-small tag-add-btn">添加</button>
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
            在启用 ntfy 等推送通知 Webhook 之前，请先将 <strong>Webhook 日志过滤项</strong> 设置为 <em>开启</em>，否则每条日志（包括调试杂讯）都会触发通知。
            开启后，仅账号启动、双重验证码以及账号完成总结会被推送。
            您可以使用白名单模式并在下方的“Webhook 过滤关键词”字段中自定义所需推送的内容。
            <span class="notice-actions">
                <button type="button" id="cfgWebhookFilterTipBtn" class="btn btn-primary btn-small">应用推荐过滤规则</button>
                <span class="notice-sub">白名单模式 &middot; 账号启动、选择数字、积分收集</span>
            </span>
        </p>`;
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
        U.toast("请输入有效的数字。", "error");
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
        U.toast("该项已在列表中。", "info");
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
    tipBtn.textContent = "正在应用\u2026";
    try {
      await save(RECOMMENDED_WEBHOOK_FILTER, "推荐 Webhook 过滤项");
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
        "控制 API 已禁用配置写入。请在脚本容器的环境变量中设置 <code>API_ALLOW_CONFIG_WRITE=true</code> 并重启。",
    };
  }
  if (e.status === 422) {
    const errors = (e.body && e.body.errors) || [];
    return {
      kind: "error",
      message: `<strong>脚本拒绝了此配置：</strong><ul>${errors.map((x) => `<li>${U.escapeHtml(x)}</li>`).join("")}</ul>`,
    };
  }
  return { kind: "error", message: U.escapeHtml(e.message) };
}

async function save(patch, description) {
  try {
    const res = await api.patchConfig(patch);
    showNotice("cfgNotice", "");
    U.toast(`已保存：${description}。将在下次运行时生效。`, "success");
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
    <strong>发现配置更新</strong> &mdash; ${n} field${n === 1 ? "" : "s"} added in a recent script update:
    <ul>${drift.addedKeys.map((k) => `<li><code>${U.escapeHtml(k)}</code></li>`).join("")}</ul>
    <div class="notice-actions">
      <button type="button" id="cfgSyncBtn" class="btn btn-primary btn-small">立即同步</button>
      <span class="notice-sub">以默认值自动补全缺失的新配置项，现有的自定义设置不受影响。</span>
    </div>`;
  U.$("#cfgSyncBtn", rootEl).addEventListener("click", doSync);
}

async function doSync() {
  const btn = U.$("#cfgSyncBtn", rootEl);
  btn.disabled = true;
  btn.textContent = "正在同步\u2026";
  try {
    const result = await api.syncConfig();
    showNotice("cfgNotice", "");
    U.toast(
      result.patched
        ? `Synced ${result.addedKeys.length} field${result.addedKeys.length === 1 ? "" : "s"}. Applies on the next run.`
        : "配置已是最新状态。",
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
  renderSettings();
  showNotice("cfgNotice", "");
}

export default {
  id: "config",
  label: "参数配置",
  interval: 0, // never poll: it would stomp on whatever is in the editor

  mount(root, ctx) {
    rootEl = root;
    root.innerHTML = `
            <p class="notice notice--warn" id="cfgNotice" hidden></p>
            <div id="cfgDrift" hidden></div>

            <section class="panel" aria-labelledby="cfg-settings-heading">
                <div class="panel-head">
                    <h2 id="cfg-settings-heading">运行规则与参数设置</h2>
                    <span class="panel-sub">自动保存每项修改，将在下次运行时生效。</span>
                </div>
                <div class="cfg-toggle-groups" id="cfgSettings"></div>
            </section>

            <section class="panel" aria-labelledby="cfg-raw-heading">
                <div class="panel-head">
                    <h2 id="cfg-raw-heading">原始 config.json 配置</h2>
                    <span class="panel-sub">仅提交您实际修改过的字段</span>
                    <label class="check">
                        <input type="checkbox" id="cfgReveal">
                        <span>显示敏感配置</span>
                    </label>
                </div>

                <p class="notice notice--info" id="cfgRedacted" hidden>
                    Webhook URLs and tokens are shown as <code>${REDACTED}</code>. Saving never overwrites them &mdash;
                    only the fields you edit are sent. To see and edit them, set <code>API_ALLOW_CONFIG_REVEAL=true</code>
                    on the control API and tick &ldquo;Reveal secrets&rdquo;.
                </p>

                <textarea id="cfgEditor" class="editor" spellcheck="false" autocomplete="off" aria-label="config.json"></textarea>

                <div class="form-actions">
                    <button type="button" id="cfgSave" class="btn btn-primary">保存修改</button>
                    <button type="button" id="cfgReload" class="btn" title="放弃未保存的修改并重新从脚本获取 config.json。">从 API 重新加载</button>
                </div>
            </section>`;

    U.$("#cfgReload", root).addEventListener("click", () => this.refresh(ctx));

    U.$("#cfgReveal", root).addEventListener("change", async (e) => {
      try {
        const res = await loadConfig(e.target.checked);
        if (e.target.checked && res.redacted) {
          showNotice(
            "cfgNotice",
            "控制 API 拒绝显示敏感配置。请在脚本环境中启用 <code>API_ALLOW_CONFIG_REVEAL=true</code> 并配置 <code>API_TOKEN</code>。",
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
        U.toast("配置未发生改变。", "info");
        return;
      }

      if (JSON.stringify(patch).includes(REDACTED)) {
        showNotice(
          "cfgNotice",
          "该项修改将把 <code>" +
          REDACTED +
          "</code> 覆盖真实的密钥。请先在控制 API 开启 <code>API_ALLOW_CONFIG_REVEAL=true</code> 并勾选“显示敏感配置”。",
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
        renderSettings();
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
