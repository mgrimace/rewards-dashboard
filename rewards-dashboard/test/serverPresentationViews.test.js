"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const publicDir = path.join(__dirname, "../public");
const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;

function fakeRoot() {
  const nodes = new Map();
  return {
    innerHTML: "",
    querySelector(selector) {
      if (!nodes.has(selector)) {
        const classes = new Set(["multi-server-only"]);
        nodes.set(selector, {
          innerHTML: "", textContent: "", value: "", hidden: false,
          scrollHeight: 0, scrollTop: 0, clientHeight: 0,
          classList: {
            toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
            contains(name) { return classes.has(name); },
          },
          addEventListener() {},
          querySelector: () => null,
          querySelectorAll: () => [],
        });
      }
      return nodes.get(selector);
    },
    querySelectorAll: () => [],
  };
}

async function loadView(name) {
  const util = moduleUrl(fs.readFileSync(path.join(publicDir, "util.js"), "utf8"));
  const helpers = moduleUrl(fs.readFileSync(path.join(publicDir, "serverViews.js"), "utf8"));
  const charts = moduleUrl("export const barChart = () => {};");
  const source = fs.readFileSync(path.join(publicDir, `views/${name}.js`), "utf8")
    .replace('"../util.js"', JSON.stringify(util))
    .replace('"../serverViews.js"', JSON.stringify(helpers))
    .replace('"../charts.js"', JSON.stringify(charts));
  return (await import(moduleUrl(source))).default;
}

test("configured count controls presentation across connection state changes", async () => {
  const { setServerPresentation } = await import(moduleUrl(fs.readFileSync(path.join(publicDir, "serverViews.js"), "utf8")));
  const root = {
    multi: null,
    toggleAttribute(name, visible) {
      assert.equal(name, "data-multi-server");
      this.multi = visible;
    },
  };
  const alpha = { id: "a", enabled: true, status: "connected" };
  const beta = { id: "b", enabled: true, status: "connected" };
  for (const [servers, expected] of [
    [[], false],
    [[alpha], false],
    [[alpha, beta], true],
    [[alpha, { ...beta, enabled: false }], true],
    [[alpha, { ...beta, status: "unreachable" }], true],
    [[{ ...alpha, enabled: false }, { ...beta, enabled: false }], true],
    [[alpha, { ...beta, deletedAt: "date" }], false],
    [[alpha], false],
    [[alpha, beta], true],
  ]) {
    setServerPresentation(servers, root);
    assert.equal(root.multi, expected);
  }
});

test("logs restore server attribution and filtering when removed history is present", async () => {
  const savedDocument = global.document;
  global.document = { documentElement: { hasAttribute: () => false } };
  const root = fakeRoot();
  let servers = [{ id: "a", name: "Alpha", enabled: true }];
  const ctx = { api: {
    connections: async () => ({ connections: servers }),
    forServer: (id) => ({ logs: async () => ({
      logs: [{ id: 1, level: "info", message: id === "a" ? "current log" : "old log" }],
      historical: id !== "a",
    }) }),
  } };
  try {
    const view = await loadView("logs");
    view.mount(root, ctx);
    await view.refresh(ctx);
    assert.ok(root.querySelector("#logServerField").classList.contains("multi-server-only"));
    assert.match(root.querySelector("#logBox").innerHTML, /class="log-server multi-server-only">Alpha/);
    servers = [...servers, { id: "b", name: "Former", enabled: false, deletedAt: "date" }];
    await view.refresh(ctx);
    assert.equal(root.querySelector("#logServerField").classList.contains("multi-server-only"), false);
    assert.match(root.querySelector("#logBox").innerHTML, /class="log-server">Former/);
    assert.match(root.querySelector("#logBox").innerHTML, /old log/);
  } finally {
    global.document = savedDocument;
  }
});

test("run history restores server column and filtering for removed history", async () => {
  const savedDocument = global.document;
  global.document = { documentElement: { hasAttribute: () => false } };
  const root = fakeRoot();
  let servers = [{ id: "a", name: "Alpha", enabled: true }];
  const ctx = { api: {
    connections: async () => ({ connections: servers }),
    forServer: (id) => ({
      runs: async () => ({ runs: [{ id, status: "done", accountsProcessed: 1 }], exits: [] }),
      accounts: async () => ({ accounts: [], histories: {} }),
    }),
  } };
  try {
    const view = await loadView("runs");
    view.mount(root, ctx);
    await view.refresh(ctx);
    assert.ok(root.querySelector("#runsServerField").classList.contains("multi-server-only"));
    assert.match(root.querySelector("#runsBody").innerHTML, /<td class="multi-server-only">Alpha<\/td>/);
    servers = [...servers, { id: "b", name: "Former", enabled: false, deletedAt: "date" }];
    await view.refresh(ctx);
    assert.equal(root.querySelector("#runsServerField").classList.contains("multi-server-only"), false);
    assert.equal(root.querySelector("#runsServerHeading").classList.contains("multi-server-only"), false);
    assert.match(root.querySelector("#runsBody").innerHTML, /<td>Former \(removed\)<\/td>/);
  } finally {
    global.document = savedDocument;
  }
});
