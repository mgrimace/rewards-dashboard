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
    title: "核心设置",
    fields: {
      headless: {
        label: "无头模式 (后台运行)",
        desc: "在后台无界面静默运行浏览器",
      },
      errorDiagnostics: {
        label: "错误诊断快照",
        desc: "在 diagnostics/ 目录下保存错误和未知登录页面的诊断数据",
      },
      ensureStreakProtection: {
        label: "连续签到保护",
        desc: "确保启用连续打卡/连击保护功能",
      },
      autoClaimPunchcardRewards: {
        label: "自动领取打卡奖励",
        desc: "打卡卡片完成后自动领取奖励",
      },
      skipNonPointTasks: {
        label: "跳过无积分任务",
        desc: "跳过不奖励积分的任务",
      },
      searchOnBingLocalQueries: {
        label: "ExploreOnBing 本地词库",
        desc: "ExploreOnBing 搜索使用本地热搜词库",
      },
    },
  },
  {
    title: "工作组件 (Workers)",
    fields: {
      "workers.doDailySet": {
        label: "每日任务集 (Daily Set)",
        desc: "自动完成每日任务集",
      },
      "workers.doClaimBonusPoints": {
        label: "领取额外积分",
        desc: "自动领取奖励/额外积分",
      },
      "workers.doMorePromotions": {
        label: "更多活动 (More Activities)",
        desc: '完成“更多活动”推广任务',
      },
      "workers.doPunchCards": {
        label: "打卡卡片 (Punch Cards)",
        desc: "自动完成打卡任务卡片",
      },
      "workers.doAppPromotions": {
        label: "App 推广活动",
        desc: "完成移动端 App 推广活动",
      },
      "workers.doDesktopSearch": {
        label: "桌面端搜索",
        desc: "执行 PC 桌面端 Bing 搜索赚取积分",
      },
      "workers.doMobileSearch": {
        label: "移动端搜索",
        desc: "执行手机移动端 Bing 搜索赚取积分",
      },
      "workers.doBonusSearches": {
        label: "额外奖励搜索",
        desc: "在达到上限后继续刷额外搜索奖励",
      },
      "workers.doDailyCheckIn": {
        label: "每日签到",
        desc: "完成每日打卡签到任务",
      },
      "workers.doReadToEarn": {
        label: "资讯阅读 (Read to Earn)",
        desc: "完成 MSN 资讯阅读赚积分任务",
      },
      "workers.doActivateSearchPerk": {
        label: "激活搜索特权",
        desc: '出现“额外搜索 Nx 次”特权时自动激活（在每日任务集后运行）',
      },
      "workers.doVisualSearch": {
        label: "视觉/图像搜索",
        desc: "激活视觉搜索连击并执行图像搜索",
      },
    },
  },
  {
    title: "活动任务设置",
    fields: {
      "activities.urlReward": {
        label: "URL 链接奖励",
        desc: "完成点击 URL 链接赚积分活动",
      },
      "activities.searchOnBing": {
        label: "ExploreOnBing 探索搜索",
        desc: "完成 ExploreOnBing 必应探索任务",
      },
    },
  },
  {
    title: "搜索行为设置",
    fields: {
      "searchSettings.scrollRandomResults": {
        label: "随机滚动结果页",
        desc: "搜索结果页面随机上下滚动以模拟真人",
      },
      "searchSettings.clickRandomResults": {
        label: "随机点击搜索结果",
        desc: "随机点击搜索结果链接模拟真人浏览",
      },
      "searchSettings.runOnZeroPoints": {
        label: "零积分仍执行搜索",
        desc: "即使剩余搜索积分为 0 仍继续执行搜索",
      },
      "searchSettings.parallelSearching": {
        label: "并发并行搜索",
        desc: "多任务并行并发执行搜索提高速度",
      },
      "searchSettings.clusterSearch": {
        label: "关联联想搜索",
        desc: "结合 Bing 搜索建议对主关键词进行聚类联想搜索",
      },
    },
  },
  {
    title: "实验性功能",
    fields: {
      "experimental.apiSearch": {
        label: "API 快速搜索",
        desc: "通过 HTTP 接口执行 Bing 搜索而非驱动真实浏览器",
      },
      "experimental.apiSearchOnBing": {
        label: "API ExploreOnBing",
        desc: "通过 HTTP 接口完成 ExploreOnBing 任务而非浏览器",
      },
      "experimental.blockMedia": {
        label: "拦截图片与多媒体",
        desc: "拦截浏览器图片、视频等多媒体资源以减少流量消耗并加速",
      },
      "experimental.edgeBrowsing": {
        label: "Edge 模拟浏览",
        desc: "在后台通过 HTTP 报告 30 分钟 Edge 浏览时长奖励",
      },
    },
  },
  {
    title: "日志与过滤",
    fields: {
      debugLogs: {
        label: "调试日志 (Debug)",
        desc: "启用详细的 Debug 调试日志输出",
      },
      "consoleLogFilter.enabled": {
        label: "控制台日志过滤",
        desc: "启用控制台日志过滤",
      },
    },
  },
  {
    title: "代理设置",
    fields: {
      "proxy.queryEngine": {
        label: "热搜词源请求代理",
        desc: "通过代理请求搜索词源引擎",
      },
      "proxy.ignoreCertificateErrors": {
        label: "忽略证书错误",
        desc: "针对抓包拦截代理禁用浏览器 TLS 证书验证",
      },
    },
  },
  {
    title: "Webhook 推送通知",
    fields: {
      "webhook.discord.enabled": {
        label: "Discord Webhook",
        desc: "启用 Discord 消息通知",
      },
      "webhook.telegram.enabled": {
        label: "Telegram Webhook",
        desc: "启用 Telegram 消息通知",
      },
      "webhook.ntfy.enabled": {
        label: "ntfy Webhook",
        desc: "启用 ntfy 消息通知",
      },
      "webhook.webhookLogFilter.enabled": {
        label: "Webhook 日志过滤",
        desc: "启用 Webhook 消息通知日志过滤",
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
const OTHER_GROUP_TITLE = "其他设置";
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
    title: "核心设置",
    fields: {
      sessionPath: {
        kind: "text",
        label: "会话存储路径",
        desc: "存储浏览器登录状态和会话的目录",
        placeholder: "sessions",
      },
      clusters: {
        kind: "number",
        label: "并发集群数 (Clusters)",
        desc: "并发运行的账号集群数量",
        min: 0,
        step: 1,
        placeholder: "1",
      },
      globalTimeout: {
        kind: "text",
        label: "全局超时时间",
        desc: "所有操作的超时时间",
        placeholder: "30sec",
      },
      accountDelay: {
        kind: "delay",
        label: "账号切换延迟",
        min: {
          path: "accountDelay.min",
          desc: "启动下一个配置账号前的最小延迟",
          placeholder: "1min",
        },
        max: {
          path: "accountDelay.max",
          desc: "启动下一个配置账号前的最大延迟",
          placeholder: "3min",
        },
      },
    },
  },
  {
    title: "搜索行为设置",
    fields: {
      "searchSettings.maxBonusSearches": {
        kind: "number",
        label: "最大额外搜索次数",
        desc: "每次运行的最大额外搜索次数（开启额外奖励搜索时生效）",
        min: 0,
        step: 1,
        placeholder: "110",
      },
      "searchSettings.searchResultVisitTime": {
        kind: "text",
        label: "搜索结果停留时间",
        desc: "在每个搜索结果页面的停留浏览时间",
        placeholder: "10sec",
      },
      "searchSettings.searchDelay": {
        kind: "delay",
        label: "搜索间隔延迟",
        min: {
          path: "searchSettings.searchDelay.min",
          desc: "每次搜索之间的最小延迟",
          placeholder: "30sec",
        },
        max: {
          path: "searchSettings.searchDelay.max",
          desc: "每次搜索之间的最大延迟",
          placeholder: "1min",
        },
      },
      "searchSettings.readDelay": {
        kind: "delay",
        label: "阅读间隔延迟",
        min: {
          path: "searchSettings.readDelay.min",
          desc: "每次资讯阅读之间的最小延迟",
          placeholder: "30sec",
        },
        max: {
          path: "searchSettings.readDelay.max",
          desc: "每次资讯阅读之间的最大延迟",
          placeholder: "1min",
        },
      },
      "searchSettings.queryEngines": {
        kind: "tags",
        label: "搜索热搜词源",
        desc: "用于构建搜索关键词池的数据来源",
        placeholder: "例如: china, google, local",
        hint: "可选: china (国内热搜), local, google, wikipedia, wikirandom, hackernews, reddit 或 rss.<源>。",
      },
    },
  },
  {
    title: "日志与过滤",
    fields: {
      "consoleLogFilter.mode": {
        kind: "select",
        label: "控制台过滤模式",
        desc: "过滤模式 (白名单 / 黑名单)",
        options: [
          { value: "whitelist", label: "白名单 (Whitelist)" },
          { value: "blacklist", label: "黑名单 (Blacklist)" },
        ],
      },
      "consoleLogFilter.levels": {
        kind: "tags",
        label: "控制台过滤级别",
        desc: "要过滤的日志级别",
        placeholder: "例如: error, warn",
        suggestions: ["error", "warn", "info", "debug"],
      },
      "consoleLogFilter.keywords": {
        kind: "tags",
        label: "控制台过滤关键词",
        desc: "要过滤的关键词",
        placeholder: "例如: starting account",
      },
      "consoleLogFilter.regexPatterns": {
        kind: "tags",
        label: "控制台过滤正则表达式",
        desc: "用于过滤的正则表达式",
        placeholder: "例如: ^Error:",
        mono: true,
      },
    },
  },
  {
    title: "Webhook 推送通知",
    fields: {
      "webhook.discord.url": {
        kind: "text",
        label: "Discord Webhook 地址",
        desc: "Discord Webhook 完整 URL",
        placeholder: "https://discord.com/api/webhooks/...",
      },
      "webhook.telegram.botToken": {
        kind: "text",
        label: "Telegram Bot Token",
        desc: "Telegram 机器人的 API Token",
      },
      "webhook.telegram.chatId": {
        kind: "text",
        label: "Telegram Chat ID",
        desc: "Telegram 接收通知的 Chat ID",
      },
      "webhook.ntfy.url": {
        kind: "text",
        label: "ntfy 服务器地址",
        desc: "ntfy 服务器 URL",
      },
      "webhook.ntfy.topic": {
        kind: "text",
        label: "ntfy 订阅主题 (Topic)",
        desc: "ntfy 通知主题",
      },
      "webhook.ntfy.token": {
        kind: "text",
        label: "ntfy 认证令牌 (Token)",
        desc: "ntfy 鉴权 Token",
      },
      "webhook.ntfy.title": {
        kind: "text",
        label: "ntfy 通知标题",
        desc: "通知消息标题",
        placeholder: "Microsoft-Rewards-Script",
      },
      "webhook.ntfy.tags": {
        kind: "tags",
        label: "ntfy 标签 (Tags)",
        desc: "通知消息标签",
        placeholder: "例如: bot, notify",
      },
      "webhook.ntfy.priority": {
        kind: "select",
        label: "ntfy 通知优先级",
        desc: "通知优先级 (1-5)",
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
        label: "Webhook 过滤模式",
        desc: "过滤模式 (白名单 / 黑名单)",
        options: [
          { value: "whitelist", label: "白名单 (Whitelist)" },
          { value: "blacklist", label: "黑名单 (Blacklist)" },
        ],
      },
      "webhook.webhookLogFilter.levels": {
        kind: "tags",
        label: "Webhook 过滤级别",
        desc: "要推送的日志级别",
        placeholder: "例如: error, warn",
        suggestions: ["error", "warn", "info", "debug"],
      },
      "webhook.webhookLogFilter.keywords": {
        kind: "tags",
        label: "Webhook 过滤关键词",
        desc: "用于过滤通知的关键词",
        placeholder: "例如: starting account",
      },
      "webhook.webhookLogFilter.regexPatterns": {
        kind: "tags",
        label: "Webhook 过滤正则表达式",
        desc: "用于过滤通知的正则表达式",
        placeholder: "例如: ^Error:",
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
                <input class="input tag-add-input" type="text" placeholder="${U.escapeAttr(def.placeholder || "添加新项…")}" ${dlId ? `list="${dlId}"` : ""}>
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
            Set <strong>Webhook log filter</strong> to <em>on</em> before enabling a push-notification
            webhook like ntfy, or you&rsquo;ll get a notification for every log line, including debug noise.
            With it enabled, only account start, 2FA codes, and account completion summaries are delivered.
            Use whitelist mode and the &ldquo;Webhook filter keywords&rdquo; field below to customize exactly
            which notifications you receive.
            <span class="notice-actions">
                <button type="button" id="cfgWebhookFilterTipBtn" class="btn btn-primary btn-small">应用推荐过滤规则</button>
                <span class="notice-sub">whitelist &middot; starting account, select number, collected</span>
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
    tipBtn.textContent = "正在应用…";
    try {
      await save(RECOMMENDED_WEBHOOK_FILTER, "recommended webhook filter");
      afterSave(RECOMMENDED_WEBHOOK_FILTER);
    } catch {
      // save() already explained why
    } finally {
      tipBtn.disabled = false;
      tipBtn.textContent = "应用推荐过滤规则";
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
    U.toast(`已保存: ${description}。将在下次任务运行时生效。`, "success");
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
      <button type="button" id="cfgSyncBtn" class="btn btn-primary btn-small">立即同步</button>
      <span class="notice-sub">Adds the missing fields with their defaults. Your existing values are never changed.</span>
    </div>`;
  U.$("#cfgSyncBtn", rootEl).addEventListener("click", doSync);
}

async function doSync() {
  const btn = U.$("#cfgSyncBtn", rootEl);
  btn.disabled = true;
  btn.textContent = "正在同步…";
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
    btn.textContent = "立即同步";
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
  label: "配置",
  interval: 0, // never poll: it would stomp on whatever is in the editor

  mount(root, ctx) {
    rootEl = root;
    root.innerHTML = `
            <p class="notice notice--warn" id="cfgNotice" hidden></p>
            <div id="cfgDrift" hidden></div>

            <section class="panel" aria-labelledby="cfg-settings-heading">
                <div class="panel-head">
                    <h2 id="cfg-settings-heading">配置项设置</h2>
                    <span class="panel-sub">修改将自动保存，并在下次任务运行时生效。</span>
                </div>
                <div class="cfg-toggle-groups" id="cfgSettings"></div>
            </section>

            <section class="panel" aria-labelledby="cfg-raw-heading">
                <div class="panel-head">
                    <h2 id="cfg-raw-heading">原始配置 (JSON)</h2>
                    <span class="panel-sub">Only the fields you actually change are sent</span>
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
                    <button type="button" id="cfgReload" class="btn" title="放弃未保存的修改并重新从脚本后端拉取 config.json">从后端重新加载</button>
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
        U.toast("配置未发生变动。", "info");
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
