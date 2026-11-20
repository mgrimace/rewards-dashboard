"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

function moduleUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

test("overview places each server's live status in its account heading, including empty servers", async () => {
  const savedWindow = global.window;
  const savedStorage = global.localStorage;
  global.window = { matchMedia: () => ({ matches: false }) };
  global.localStorage = { getItem: () => null };
  const nodes = new Map();
  const root = {
    innerHTML: "",
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, {
        innerHTML: "", textContent: "", hidden: false, style: {},
        classList: { add() {}, remove() {}, toggle() {} },
        parentElement: { setAttribute() {} },
        querySelectorAll: () => [],
      });
      return nodes.get(selector);
    },
    querySelectorAll: () => [],
  };
  const servers = [
    { id: "b", name: "Beta", enabled: true },
    { id: "a", name: "Alpha", enabled: true },
    { id: "c", name: "Offline", enabled: true },
  ];
  const statuses = new Map([
    ["b", { reachable: true, botOutcome: "success", bot: { run: { accountsSeen: 3, accountsTotal: 3 } } }],
    ["a", { reachable: true, botRunning: true, bot: { run: { accountsSeen: 1, accountsTotal: 2 } } }],
    ["c", { reachable: false }],
  ]);
  const ctx = {
    api: {
      connections: async () => ({ connections: servers }),
      forServer: (id) => ({
        summary: async () => ({ status: statuses.get(id), runs: [] }),
        accounts: async () => ({
          accounts: id === "c" ? [] : [{ key: "same", index: 1, email: `${id}@example.test` }],
          histories: {},
        }),
      }),
    },
    statusFor: (id) => statuses.get(id),
    status: statuses.get("b"),
  };
  try {
    const publicDir = path.join(__dirname, "../public");
    const utilSource = fs.readFileSync(path.join(publicDir, "util.js"), "utf8")
      .replace("export function renderTicker(", "function originalRenderTicker(");
    const util = moduleUrl(`${utilSource}\nexport const renderTicker = (node, text) => { node.textContent = text; };`);
    const helpers = moduleUrl(fs.readFileSync(path.join(publicDir, "serverViews.js"), "utf8"));
    const charts = moduleUrl("export const buildAccumBarHtml = () => '', buildHeatmapHtml = () => '', lineChart = () => {};");
    const source = fs.readFileSync(path.join(publicDir, "views/overview.js"), "utf8")
      .replace('"../util.js"', JSON.stringify(util))
      .replace('"../serverViews.js"', JSON.stringify(helpers))
      .replace('"../charts.js"', JSON.stringify(charts));
    const { default: overview } = await import(moduleUrl(source));
    overview.mount(root, ctx);
    await overview.refresh(ctx);
    assert.doesNotMatch(root.innerHTML, /serverRunStatus/);
    const rows = root.querySelector("#overviewHeroRows");
    assert.match(rows.innerHTML, /class="server-group-heading multi-server-only">Beta <span class="server-group-status">· success · 3\/3 accounts<\/span>/);
    assert.match(rows.innerHTML, /Alpha <span class="server-group-status">· Running · 1\/2 accounts<\/span>/);
    assert.match(rows.innerHTML, /Offline <span class="server-group-status">· Unavailable<\/span>/);
    assert.ok(rows.innerHTML.indexOf("Beta") < rows.innerHTML.indexOf("Alpha"));
    assert.ok(rows.innerHTML.indexOf("Alpha") < rows.innerHTML.indexOf("Offline"));
    assert.match(rows.innerHTML, /b@example\.test/);
    assert.match(rows.innerHTML, /a@example\.test/);
    statuses.set("a", { reachable: true, botOutcome: "success", bot: { run: { accountsSeen: 2, accountsTotal: 2 } } });
    overview.onState(statuses.get("a"), ctx);
    assert.match(rows.innerHTML, /Alpha <span class="server-group-status">· success · 2\/2 accounts<\/span>/);
  } finally {
    global.window = savedWindow;
    global.localStorage = savedStorage;
  }
});
