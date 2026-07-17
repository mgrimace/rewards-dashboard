"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { ControlApiClient, entryToDockerLine } = require("./lib/apiClient");
const { EventHub } = require("./lib/eventHub");
const { parseLine } = require("./lib/parser");
const { Store } = require("./lib/store");
const { describeCron, isValidCron, nextRun } = require("./lib/cron");
const { Scheduler } = require("./lib/scheduler");
const { transformThemeModule } = require("./lib/tsLite");
const { generateIndexModule, THEMES_DIR } = require("./lib/themeLoader");
const { PendingLoginCodes } = require("./lib/pendingLoginCodes");
const { mergeAccounts } = require("./lib/accounts");

// confg
const PORT = Number(process.env.PORT || 8890);
const CONTROL_API_URL =
  process.env.CONTROL_API_URL || "http://microsoft-rewards-script:3010";
const CONTROL_API_TOKEN = process.env.CONTROL_API_TOKEN || "";
const DASHBOARD_USERNAME = process.env.DASHBOARD_USERNAME || "";
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "";
const DASHBOARD_AUTH_ENABLED = Boolean(
  DASHBOARD_USERNAME && DASHBOARD_PASSWORD,
);
const DISPLAY_NAME = process.env.DASHBOARD_TITLE || "Microsoft Rewards";
const TIMEZONE = process.env.TZ || "UTC";
const POLL_MS = Math.max(1000, Number(process.env.POLL_MS || 5000));
const LOG_REPLAY = Number(process.env.LOG_REPLAY || 300);
const PUBLIC_DIR = path.join(__dirname, "public");

const client = new ControlApiClient({
  baseUrl: CONTROL_API_URL,
  token: CONTROL_API_TOKEN,
});
const store = new Store();
const pendingLoginCodes = new PendingLoginCodes();

const log = (level, msg) => {
  const line = `[server] ${msg}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

const hub = new EventHub({ client, replay: LOG_REPLAY, log });

const scheduler = new Scheduler({
  client,
  store,
  isBusy: () =>
    Boolean(
      backend.bot &&
      backend.bot.state !== "idle" &&
      backend.bot.state !== "unknown",
    ),
  onChange: () => {
    backend.schedule = describeSchedule(scheduler.get());
    hub.broadcast("state", currentState());
  },
  log,
});

function describeSchedule(sched) {
  return {
    ...sched,
    description: sched.enabled
      ? describeCron(sched.cron) || sched.cron
      : "Not scheduled",
  };
}

// The bot's cron lives inside its own container and has no concept of
// "next run" bookkeeping — it's computed here client-side from the same
// cron grammar the dashboard already uses, purely for display. The actual
// firing is up to the container's OS cron, not this calculation.
function describeRemoteSchedule(sched) {
  if (!sched) return null;
  const next =
    sched.enabled && sched.cron ? nextRun(sched.cron, new Date()) : null;
  return {
    ...sched,
    description:
      sched.enabled && sched.cron
        ? describeCron(sched.cron) || sched.cron
        : "Not scheduled",
    nextRunAt: next ? next.toISOString() : null,
  };
}

const AUTH_HINT =
  "Control API rejected our token - CONTROL_API_TOKEN must match the API's API_TOKEN.";

// live
const backend = {
  reachable: false,
  authRequired: false,
  authOk: true,
  lastError: null,
  checkedAt: null,
  name: null,
  version: null,
  uptimeSec: null,
  bot: null, // last /status payload
  schedule: null,
  remoteSchedule: null, // last GET /schedule payload from the bot's Control API
  remoteScheduleSupported: null, // null = unknown yet, true/false once determined
};

let lastLogId = null;
let lastHealthUptime = null;

function currentState() {
  return {
    reachable: backend.reachable,
    authRequired: backend.authRequired,
    authOk: backend.authOk,
    lastError: backend.lastError,
    checkedAt: backend.checkedAt,
    displayName: DISPLAY_NAME,
    timezone: TIMEZONE,
    controlApiUrl: CONTROL_API_URL,
    name: backend.name,
    version: backend.version,
    uptimeSec: backend.uptimeSec,
    bot: backend.bot,
    botState: backend.bot ? backend.bot.state : "unknown",
    botRunning: Boolean(backend.bot && backend.bot.state !== "idle"),
    schedule: backend.schedule,
    remoteSchedule: describeRemoteSchedule(backend.remoteSchedule),
    remoteScheduleSupported: backend.remoteScheduleSupported === true,
    stream: hub.stats,
    lastEventAt: store.lastTs,
    codes: pendingLoginCodes.list(),
  };
}

// live logg sse
hub.on("entry", (entry) => {
  try {
    if (!entry) return;
    if (lastLogId != null && entry.id != null && entry.id <= lastLogId) return;

    const line = entryToDockerLine(entry);
    const event = line ? parseLine(line) : null;
    if (event) {
      store.apply(event);
      if (event.kind === "login-number") {
        pendingLoginCodes.add(event.userName, event.number, event.ts);
        hub.broadcast("codes", { codes: pendingLoginCodes.list() });
      } else if (event.kind === "login-number-resolved") {
        pendingLoginCodes.resolve(event.userName);
        hub.broadcast("codes", { codes: pendingLoginCodes.list() });
      }
    }
    if (entry.id != null)
      lastLogId = lastLogId == null ? entry.id : Math.max(lastLogId, entry.id);
  } catch (e) {
    log("warn", `Could not ingest a log line: ${e.message}`);
  }
});

hub.on("status", (status) => {
  const wasRunning = Boolean(backend.bot && backend.bot.state !== "idle");
  backend.bot = status;

  if (status.reason === "exit" && wasRunning && status.lastExit) {
    try {
      store.closeRunOnExit(status.lastExit);
    } catch (e) {
      log("warn", `Could not record the run exit: ${e.message}`);
    }
  }

  hub.broadcast("state", currentState());
});

// poll
async function pollOnce() {
  let health;
  try {
    health = await client.get("/health");
  } catch (error) {
    if (error.statusCode !== 401) throw error;
    backend.reachable = true;
    backend.authRequired = true;
    backend.authOk = false;
    backend.lastError = AUTH_HINT;
    backend.checkedAt = new Date().toISOString();
    backend.bot = { state: "unknown" };
    return;
  }
  backend.reachable = true;
  backend.name = health.name || null;
  backend.version = health.version || null;
  backend.uptimeSec =
    typeof health.uptimeSec === "number" ? health.uptimeSec : null;
  backend.authRequired = health.authRequired === true;
  backend.checkedAt = new Date().toISOString();
  backend.lastError = null;

  if (typeof health.uptimeSec === "number") {
    if (lastHealthUptime != null && health.uptimeSec < lastHealthUptime) {
      log("warn", "Control API restarted - resetting the log cursor.");
      lastLogId = null;
      hub.markUpstreamRestarted();
    }
    lastHealthUptime = health.uptimeSec;
  }

  if (backend.authRequired && !CONTROL_API_TOKEN) {
    backend.authOk = false;
    backend.lastError =
      "Control API requires a token - set CONTROL_API_TOKEN to the same value as its API_TOKEN.";
    backend.bot = { state: health.state || "unknown" };
    return;
  }

  let authFailed = false;

  try {
    backend.bot = await client.get("/status");
  } catch (e) {
    if (e.statusCode === 401) authFailed = true;
    backend.lastError =
      e.statusCode === 401 ? AUTH_HINT : `Status unavailable (${e.message})`;
  }

  // The bot's own /schedule endpoint is optional - older bot images (or ones
  // running without API_ALLOW_SCHEDULE_WRITE) won't have it. A 404 means
  // "not supported, hide the remote scheduler option"; any other error is
  // treated as a transient blip so the UI doesn't flicker the option away.
  try {
    backend.remoteSchedule = await client.get("/schedule");
    backend.remoteScheduleSupported = true;
  } catch (e) {
    backend.remoteSchedule = null;
    if (e.statusCode === 404) backend.remoteScheduleSupported = false;
  }

  backend.schedule = describeSchedule(scheduler.get());

  backend.authOk = !authFailed;
}

async function pollLoop() {
  for (; ;) {
    try {
      await pollOnce();
    } catch (e) {
      backend.reachable = false;
      backend.bot = null;
      backend.lastError = e.message;
      backend.checkedAt = new Date().toISOString();
    }
    hub.broadcast("state", currentState());
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

// helpers
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
  });
  res.end(data);
}

function safeEqual(value, expected) {
  const left = Buffer.from(String(value || ""));
  const right = Buffer.from(String(expected || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requestBasicCredentials(req) {
  const authorization = req.headers.authorization;
  if (typeof authorization !== "string") return null;

  const match = authorization.match(/^Basic\s+(.+)$/i);
  if (!match) return null;

  try {
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return null;

    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

function isDashboardAuthorized(req) {
  if (!DASHBOARD_AUTH_ENABLED) return true;

  const credentials = requestBasicCredentials(req);
  return (
    credentials !== null &&
    safeEqual(credentials.username, DASHBOARD_USERNAME) &&
    safeEqual(credentials.password, DASHBOARD_PASSWORD)
  );
}

function requireDashboardAuth(res) {
  res.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="Rewards Dashboard", charset="UTF-8"',
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end("Authentication required");
}

function readJsonBody(req, limitBytes = 2_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

async function forward(res, method, apiPath, body) {
  try {
    const data = await client.request(method, apiPath, { body });
    return sendJson(res, 200, data ?? {});
  } catch (e) {
    const status = e.statusCode || 502;
    const payload =
      e.body && typeof e.body === "object"
        ? e.body
        : { error: e.message || "Control API unreachable" };
    if (status === 401) payload.hint = AUTH_HINT;
    return sendJson(res, status, payload);
  }
}

function serveStatic(res, pathname) {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found");
    }
    res.writeHead(200, {
      "Content-Type":
        MIME[path.extname(filePath)] || "application/octet-stream",
    });
    res.end(data);
  });
}

function serveThemeIndex(res) {
  res.writeHead(200, {
    "Content-Type": "text/javascript; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(generateIndexModule());
}

function serveThemeFile(res, filename) {
  const filePath = path.join(THEMES_DIR, filename);
  if (!filePath.startsWith(THEMES_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, "utf8", (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found");
    }
    res.writeHead(200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(transformThemeModule(data));
  });
}

// routes
const DIAG_FILES = new Set(["screenshot.png", "error.txt", "dump.html"]);

async function handleApi(req, res, url) {
  const { pathname, searchParams } = url;
  const method = req.method || "GET";

  // live
  if (pathname === "/api/events" && method === "GET") {
    return hub.addClient(req, res, currentState());
  }

  // read
  if (pathname === "/api/summary" && method === "GET") {
    return sendJson(res, 200, {
      status: currentState(),
      accounts: store.snapshotAccounts(),
      runs: store.snapshotRuns(30),
      activity: store.snapshotActivity(120),
    });
  }

  if (pathname === "/api/accounts" && method === "GET") {
    let apiAccounts = [];
    let apiError = null;
    try {
      const data = await client.get("/accounts");
      apiAccounts = data.accounts || [];
    } catch (e) {
      apiError = e.statusCode === 401 ? AUTH_HINT : e.message;
    }
    const historyDays = Math.min(
      3650,
      Math.max(0, Number(searchParams.get("historyDays")) || 0),
    );
    const effectiveHistoryDays = searchParams.has("historyDays")
      ? historyDays
      : 365;
    const since =
      effectiveHistoryDays > 0
        ? new Date(
          Date.now() - effectiveHistoryDays * 24 * 60 * 60 * 1000,
        ).toISOString()
        : null;
    const histories =
      effectiveHistoryDays > 0 ? store.allAccountHistories({ since }) : {};
    return sendJson(res, 200, {
      accounts: mergeAccounts(apiAccounts, store.snapshotAccounts(), histories),
      histories,
      historyDays: effectiveHistoryDays,
      apiError,
    });
  }

  if (pathname === "/api/runs" && method === "GET") {
    const limit = Math.min(
      500,
      Math.max(1, Number(searchParams.get("limit")) || 50),
    );
    let exits = [];
    let apiError = null;
    try {
      const data = await client.get(`/history?limit=${limit}`);
      exits = data.runs || [];
    } catch (e) {
      apiError = e.statusCode === 401 ? AUTH_HINT : e.message;
    }
    return sendJson(res, 200, {
      runs: store.snapshotRuns(limit),
      exits,
      apiError,
    });
  }

  if (pathname === "/api/logs" && method === "GET") {
    const q = new URLSearchParams();
    q.set(
      "limit",
      String(
        Math.min(5000, Math.max(1, Number(searchParams.get("limit")) || 500)),
      ),
    );
    const level = searchParams.get("level");
    if (level) q.set("level", level);
    return forward(res, "GET", `/logs?${q.toString()}`);
  }

  if (pathname === "/api/errors" && method === "GET") {
    const q = new URLSearchParams();
    q.set(
      "limit",
      String(
        Math.min(1000, Math.max(1, Number(searchParams.get("limit")) || 100)),
      ),
    );
    if (searchParams.get("warnings") === "false") q.set("warnings", "false");
    return forward(res, "GET", `/errors?${q.toString()}`);
  }

  if (pathname === "/api/login-codes" && method === "GET") {
    return sendJson(res, 200, { codes: pendingLoginCodes.list() });
  }

  // schedule
  if (pathname === "/api/schedule") {
    if (method === "GET") {
      return sendJson(res, 200, {
        local: describeSchedule(scheduler.get()),
        remote: describeRemoteSchedule(backend.remoteSchedule),
        remoteSupported: backend.remoteScheduleSupported === true,
      });
    }
    if (method === "PUT") {
      const body = await readJsonBody(req);
      const target = body.target === "remote" ? "remote" : "local";
      const patch = { ...body };
      delete patch.target;

      if (target === "remote") {
        if (backend.remoteScheduleSupported !== true) {
          return sendJson(res, 409, {
            error:
              "The bot's Control API does not support remote scheduling. Upgrade the bot image and set API_ALLOW_SCHEDULE_WRITE=true, or use the dashboard's own scheduler instead.",
          });
        }
        try {
          const updated = await client.put("/schedule", patch);
          backend.remoteSchedule = updated;
          hub.broadcast("state", currentState());
          return sendJson(res, 200, {
            local: describeSchedule(scheduler.get()),
            remote: describeRemoteSchedule(updated),
            remoteSupported: true,
          });
        } catch (e) {
          const status = e.statusCode || 502;
          const payload =
            e.body && typeof e.body === "object"
              ? e.body
              : { error: e.message || "Control API unreachable" };
          return sendJson(res, status, payload);
        }
      }

      try {
        const updated = scheduler.set(patch);
        return sendJson(res, 200, {
          local: describeSchedule(updated),
          remote: describeRemoteSchedule(backend.remoteSchedule),
          remoteSupported: backend.remoteScheduleSupported === true,
        });
      } catch (e) {
        return sendJson(res, e.code === "BAD_REQUEST" ? 400 : 500, {
          error: e.message,
        });
      }
    }
  }

  if (pathname === "/api/cron" && method === "GET") {
    const expr = searchParams.get("expr") || "";
    const valid = isValidCron(expr);
    return sendJson(res, 200, {
      expr,
      valid,
      description: valid ? describeCron(expr) : null,
      error: valid
        ? null
        : "Needs 5 fields: minute hour day-of-month month day-of-week.",
    });
  }

  // config
  if (pathname === "/api/config") {
    if (method === "GET") {
      const reveal = searchParams.get("reveal") === "1" ? "?reveal=1" : "";
      return forward(res, "GET", `/config${reveal}`);
    }
    if (method === "PUT" || method === "PATCH") {
      const body = await readJsonBody(req);
      return forward(res, method, "/config", body);
    }
  }

  // diag
  if (pathname === "/api/diagnostics" && method === "GET") {
    return forward(res, "GET", "/diagnostics");
  }

  if (pathname.startsWith("/api/diagnostics/") && method === "GET") {
    const parts = pathname
      .slice("/api/diagnostics/".length)
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent);
    if (parts.length !== 2) return sendJson(res, 404, { error: "Not found" });
    const [name, file] = parts;
    if (!/^error-[A-Za-z0-9._:-]+$/.test(name) || !DIAG_FILES.has(file)) {
      return sendJson(res, 400, { error: "Invalid diagnostics path" });
    }
    try {
      const upstream = await client.stream(
        `/diagnostics/${encodeURIComponent(name)}/${encodeURIComponent(file)}`,
      );
      res.writeHead(200, {
        "Content-Type":
          upstream.headers["content-type"] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      return upstream.pipe(res);
    } catch (e) {
      return sendJson(res, e.statusCode || 502, { error: e.message });
    }
  }

  // sessions
  if (pathname === "/api/sessions" && method === "GET") {
    return forward(res, "GET", "/sessions");
  }

  if (pathname.startsWith("/api/sessions/") && method === "DELETE") {
    const email = pathname.slice("/api/sessions/".length);
    if (!email) return sendJson(res, 400, { error: "Missing account email" });
    return forward(res, "DELETE", `/sessions/${email}`);
  }

  // control
  if (pathname.startsWith("/api/control/") && method === "POST") {
    const action = pathname.slice("/api/control/".length);
    if (!["start", "stop", "restart", "shutdown"].includes(action)) {
      return sendJson(res, 404, { error: "Unknown control action" });
    }
    const body = await readJsonBody(req);
    return forward(res, "POST", `/${action}`, body);
  }

  // health
  if (pathname === "/api/health" && method === "GET") {
    return sendJson(res, 200, {
      ok: true,
      controlApi: backend.reachable,
      controlApiAuthOk: backend.authOk,
      streamConnected: hub.connected,
    });
  }

  return sendJson(res, 404, { error: "Not found", path: pathname });
}

const server = http.createServer((req, res) => {
  if (!isDashboardAuthorized(req)) return requireDashboardAuth(res);

  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;

  if (pathname === "/themes/index.js") return serveThemeIndex(res);
  if (pathname.startsWith("/themes/") && pathname.endsWith(".ts")) {
    return serveThemeFile(res, pathname.slice("/themes/".length));
  }

  if (pathname.startsWith("/api/")) {
    return handleApi(req, res, url).catch((e) => {
      log("error", `Request failed: ${e.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: e.message });
    });
  }

  return serveStatic(res, pathname);
});

server.listen(PORT, () => {
  log("info", `Rewards dashboard listening on :${PORT}`);
  log(
    "info",
    `Control API: ${CONTROL_API_URL}${CONTROL_API_TOKEN ? " (token set)" : " (no token)"}`,
  );
  if (!CONTROL_API_TOKEN) {
    log(
      "warn",
      "CONTROL_API_TOKEN is empty - this only works if the Control API runs without an API_TOKEN.",
    );
  }
  if (Boolean(DASHBOARD_USERNAME) !== Boolean(DASHBOARD_PASSWORD)) {
    log(
      "warn",
      "Dashboard authentication is disabled because both DASHBOARD_USERNAME and DASHBOARD_PASSWORD must be set.",
    );
  }
  log(
    "info",
    `Dashboard authentication: ${DASHBOARD_AUTH_ENABLED ? `enabled (user: ${DASHBOARD_USERNAME})` : "disabled"}`,
  );
  scheduler.init();
  backend.schedule = describeSchedule(scheduler.get());
  hub.start();
  pollLoop();
});

function shutdown() {
  log("info", "Shutting down…");
  scheduler.stop();
  hub.stop();
  store.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);