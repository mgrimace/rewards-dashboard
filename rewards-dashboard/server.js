"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const { ControlApiClient, entryToDockerLine } = require("./lib/apiClient");
const { MultiEventHub } = require("./lib/multiEventHub");
const { parseLine } = require("./lib/parser");
const { Store } = require("./lib/store");
const { completedBotOutcome } = require("./lib/outcome");
const { describeCron, isValidCron, nextRun } = require("./lib/cron");
const { Scheduler } = require("./lib/scheduler");
const { transformThemeModule } = require("./lib/tsLite");
const { generateIndexModule, THEMES_DIR } = require("./lib/themeLoader");
const { PendingLoginCodes } = require("./lib/pendingLoginCodes");
const { mergeAccounts } = require("./lib/accounts");
const { ActivityStore } = require("./lib/activityStore");
const { Connections, testConnection } = require("./lib/connections");
const { credentialRedactor } = require("./lib/redact");
const { migrateServerData, NO_LEGACY_SERVER } = require("./lib/serverDataMigration");
const { backupBeforeMigration, exportLegacyDatabase } = require("./lib/legacyExport");

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

const log = (level, msg) => {
  const line = `[server] ${msg}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const publicRealDir = fs.realpathSync(PUBLIC_DIR);
const relativeDataDir = path.relative(publicRealDir, fs.realpathSync(dataDir));
if (!relativeDataDir || (!relativeDataDir.startsWith(`..${path.sep}`) && relativeDataDir !== ".." && !path.isAbsolute(relativeDataDir)))
  throw new Error("The data directory must not be inside the public static directory.");
const dbFile = path.join(dataDir, "dashboard.sqlite");
const existingDatabase = fs.existsSync(dbFile) && fs.statSync(dbFile).size > 0;
for (const suffix of ["", "-wal", "-shm"]) {
  const file = dbFile + suffix;
  if (suffix) {
    try { fs.lstatSync(file); }
    catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
  }
  const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error("Dashboard database files must be regular files.");
    fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
}
const db = new DatabaseSync(dbFile);
db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA secure_delete = ON;");
const hasScopedAccounts = db.prepare("PRAGMA table_info(accounts)").all().some((col) => col.name === "server_id");
if (existingDatabase && !hasScopedAccounts) {
  try {
    const backup = backupBeforeMigration(db, dataDir);
    log("info", `Pre-migration database backup created: ${backup}`);
  } catch {
    db.close();
    throw new Error("Could not create the pre-migration database backup; migration was not started.");
  }
}
let legacyStore = null;
let connections;
db.exec("BEGIN IMMEDIATE");
try {
  if (!hasScopedAccounts) {
    legacyStore = new Store({ db });
    new ActivityStore(db);
  }
  connections = new Connections(db, {
    legacy: existingDatabase || process.env.CONTROL_API_URL || process.env.CONTROL_API_TOKEN
      ? { apiUrl: CONTROL_API_URL, apiToken: CONTROL_API_TOKEN }
      : null,
  });
  const marker = db.prepare(
    "SELECT value FROM dashboard_connection_meta WHERE key = 'historical_server_id'",
  ).get();
  const legacyId = marker?.value || connections.list()[0]?.id || NO_LEGACY_SERVER;
  migrateServerData(db, legacyId);
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  if (legacyStore) legacyStore.close();
  db.close();
  throw error;
}
if (legacyStore) legacyStore.close();

const multiHub = new MultiEventHub({ replay: LOG_REPLAY, log });
const runtimes = new Map();
const runtimeErrors = new Map();
const AUTH_HINT = "Control API authentication was rejected. Check the connection token.";

function createRuntime(server) {
const config = connections.getClientConfig(server.id);
const client = new ControlApiClient(config);
const scrub = client.redact;
const scrubError = scrub;
const runtimeLog = (level, message) => log(level, scrubError(message));
const activityClient = client;
const store = new Store({ db, serverId: server.id });
const pendingLoginCodes = new PendingLoginCodes();
const hub = multiHub.addServer(server.id, client, { sanitize: scrub });
// Structured per-activity data from the Control API (/history + /status extras).
let activity;
try {
  activity = new ActivityStore(store.db, {
    log: runtimeLog,
    serverId: server.id,
    resetHourUtc: process.env.ACTIVITY_RESET_HOUR_UTC ? Number(process.env.ACTIVITY_RESET_HOUR_UTC) : null,
  });
} catch (error) {
  multiHub.removeServer(server.id);
  store.close();
  throw error;
}

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
  log: runtimeLog,
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
let lastHealthyCheckedAt = null;
let stopped = false;
let pollTimer = null;

function currentState() {
  const botOutcome = completedBotOutcome(backend.bot);
  return {
    reachable: backend.reachable,
    serverId: server.id,
    serverName: server.name,
    authRequired: backend.authRequired,
    authOk: backend.authOk,
    lastError: backend.lastError,
    checkedAt: backend.checkedAt,
    displayName: DISPLAY_NAME,
    timezone: TIMEZONE,
    controlApiUrl: server.apiUrl,
    name: backend.name,
    version: backend.version,
    uptimeSec: backend.uptimeSec,
    bot: backend.bot,
    botState: backend.bot ? backend.bot.state : "unknown",
    botOutcome,
    botRunning: Boolean(
      backend.bot &&
      backend.bot.state !== "idle" &&
      botOutcome === null,
    ),
    schedule: backend.schedule,
    remoteSchedule: describeRemoteSchedule(backend.remoteSchedule),
    remoteScheduleSupported: backend.remoteScheduleSupported === true,
    stream: hub.stats,
    lastEventAt: store.lastTs,
    pendingDelay: store.pendingDelay,
    pendingSleep: store.pendingSleep,
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
      // Card progress only exists in this log line; idempotent, so replays are harmless.
      if (event.kind === "punchcard-progress") activity.recordPunchcard(event);
      if (event.kind === "account-skip-v4") activity.recordSkip(event);
      store.apply(event);
      hub.broadcast("state", currentState());
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
    runtimeLog("warn", `Could not ingest a log line: ${e.message}`);
  }
});

hub.on("status", (status) => {
  const wasRunning = Boolean(backend.bot && backend.bot.state !== "idle");
  backend.bot = status;

  if (status.reason === "exit" && wasRunning && status.lastExit) {
    try {
      // The Control API processes the log itself, so run.totals (set only by
      // RUN-END) tells us the script finished even if this dashboard missed
      // the line.
      store.closeRunOnExit(status.lastExit, {
        summarySeen: Boolean(status.run?.totals),
      });
    } catch (e) {
      runtimeLog("warn", `Could not record the run exit: ${e.message}`);
    }
    // Capture /status extras (earnable, searchSummary...) before the next run
    // replaces them, and pull the finished run from /history.
    activity.syncSoon(activityClient, status);
  }

  hub.broadcast("state", currentState());
});

// poll
async function pollOnce() {
  let health;
  try {
    health = await client.get("/health");
    if (stopped) return;
  } catch (error) {
    if (stopped) return;
    if (error.statusCode !== 401 && error.statusCode !== 403) throw error;
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
  // Snapshot before overwriting: this is our cutoff for "definitely started
  // before the restart we're about to react to", not this poll's own time.
  const priorHealthyCheckedAt = lastHealthyCheckedAt;
  backend.checkedAt = new Date().toISOString();
  backend.lastError = null;

  if (typeof health.uptimeSec === "number") {
    if (lastHealthUptime != null && health.uptimeSec < lastHealthUptime) {
      runtimeLog("warn", "Control API restarted - resetting the log cursor.");
      lastLogId = null;
      // The container (bot + Control API together) can be torn down mid-run
      // for all sorts of ordinary reasons (image update, manual restart,
      // host reboot) - nothing will ever close that run's row on its own
      // since the process that would have logged RUN-END is gone. Close it
      // out now instead of leaving it stuck 'running' until the roster/echo
      // backstop in apply() eventually notices, possibly hours later.
      //
      // The SSE stream can independently notice the same disconnect (its own
      // upstream connection drops) and reconnect faster than our next poll,
      // already tracking a brand new run by the time we get here. Passing
      // notStartedAfter tells the store to only touch a run that was already
      // 'running' as of our last known-good check - never one that could be
      // that legitimate new run.
      try {
        if (
          store.markInterruptedByBackendRestart(new Date().toISOString(), {
            notStartedAfter: priorHealthyCheckedAt,
          })
        ) {
          runtimeLog("warn", "Closed a run stuck 'running' - the backend restarted mid-run.");
        }
      } catch (e) {
        runtimeLog("warn", `Could not close the interrupted run: ${e.message}`);
      }
      hub.markUpstreamRestarted();
    }
    lastHealthUptime = health.uptimeSec;
  }
  lastHealthyCheckedAt = backend.checkedAt;

  if (backend.authRequired && !config.token) {
    backend.authOk = false;
    backend.lastError =
      "Control API requires a token. Update the connection token.";
    backend.bot = { state: health.state || "unknown" };
    return;
  }

  let authFailed = false;

  try {
    backend.bot = await client.get("/status");
    if (stopped) return;
  } catch (e) {
    if (stopped) return;
    // Do not keep reporting a previous "running" snapshot when the status
    // endpoint is unavailable (for example while the Control API restarts).
    backend.bot = null;
    if (e.statusCode === 401 || e.statusCode === 403) authFailed = true;
    backend.lastError =
      authFailed ? AUTH_HINT : `Status unavailable (${scrubError(e.message)})`;
  }

  // The bot's own /schedule endpoint is optional - older bot images (or ones
  // running without API_ALLOW_SCHEDULE_WRITE) won't have it. A 404 means
  // "not supported, hide the remote scheduler option"; any other error is
  // treated as a transient blip so the UI doesn't flicker the option away.
  try {
    backend.remoteSchedule = await client.get("/schedule");
    if (stopped) return;
    backend.remoteScheduleSupported = true;
  } catch (e) {
    if (stopped) return;
    backend.remoteSchedule = null;
    if (e.statusCode === 404) backend.remoteScheduleSupported = false;
  }

  backend.schedule = describeSchedule(scheduler.get());

  backend.authOk = !authFailed;
}

async function pollLoop() {
  while (!stopped) {
    try {
      await pollOnce();
      if (stopped) return;
      // Boot backfill, and a safety net if an exit event was missed.
      if (backend.reachable && backend.authOk && activity.needsSync(backend.bot))
        activity.syncSoon(activityClient, backend.bot);
    } catch (e) {
      if (stopped) return;
      backend.reachable = false;
      backend.bot = null;
      backend.lastError = scrubError(e.message);
      backend.checkedAt = new Date().toISOString();
    }
    hub.broadcast("state", currentState());
    await new Promise((r) => { pollTimer = setTimeout(r, POLL_MS); });
  }
}

function start() {
  scheduler.init();
  backend.schedule = describeSchedule(scheduler.get());
  hub.start();
  void pollLoop();
}

async function stop() {
  stopped = true;
  clearTimeout(pollTimer);
  scheduler.stop();
  multiHub.removeServer(server.id);
  if (activity._inFlight) {
    try { await activity._inFlight; }
    catch (error) { runtimeLog("warn", `Activity sync failed while stopping: ${error.message}`); }
  }
  store.close();
}

return { server, client, store, activity, scheduler, pendingLoginCodes, hub, backend, currentState, describeSchedule, describeRemoteSchedule, scrub, scrubError, start, stop, isActive: () => !stopped };
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

async function waitForCompletedBotToIdle(runtime) {
  const { backend, client, hub, currentState } = runtime;
  if (!runtime.isActive() || !completedBotOutcome(backend.bot)) return false;

  const deadline = Date.now() + 10000;
  while (runtime.isActive() && Date.now() < deadline) {
    let status;
    try {
      status = await client.get("/status");
    } catch {
      return false;
    }
    if (!runtime.isActive()) return false;
    backend.bot = status;
    hub.broadcast("state", currentState());
    if (status.state === "idle") return true;
    if (!completedBotOutcome(status)) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function forwardRequest(runtime, res, method, apiPath, body, retryCompletedStart = true) {
  const { client } = runtime;
  try {
    const data = await client.request(method, apiPath, { body });
    return sendJson(res, 200, data ?? {});
  } catch (e) {
    const status = e.statusCode || 502;
    if (
      retryCompletedStart &&
      method === "POST" &&
      apiPath === "/start" &&
      status === 409 &&
      await waitForCompletedBotToIdle(runtime) &&
      runtime.isActive()
    ) {
      return forwardRequest(runtime, res, method, apiPath, body, false);
    }
    const payload = runtime.scrubError(
      e.body && typeof e.body === "object"
        ? e.body
        : { error: e.message || "Control API unreachable" },
    );
    if (status === 401) payload.hint = AUTH_HINT;
    return sendJson(res, status, payload);
  }
}

function serveStatic(res, pathname) {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(PUBLIC_DIR, rel);
  const relative = path.relative(PUBLIC_DIR, filePath);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.realpath(filePath, (err, realPath) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found");
    }
    const realRelative = path.relative(publicRealDir, realPath);
    if (realRelative.startsWith(`..${path.sep}`) || realRelative === ".." || path.isAbsolute(realRelative)) {
      res.writeHead(403);
      return res.end("Forbidden");
    }
    fs.readFile(realPath, (readError, data) => {
      if (readError) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end("Not found");
      }
      res.writeHead(200, {
        "Content-Type":
          MIME[path.extname(filePath)] || "application/octet-stream",
      });
      res.end(data);
    });
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

function connectionList() {
  return connections.list().map((connection) => {
    const runtime = runtimes.get(connection.id);
    return {
      ...connection,
      status: !connection.enabled ? "disabled"
        : !runtime ? "unavailable"
          : runtime.backend.authOk === false ? "authentication"
            : runtime.backend.reachable ? "connected"
              : runtime.backend.checkedAt ? "unreachable" : "connecting",
      checkedAt: runtime?.backend.checkedAt || null,
      lastError: runtime?.backend.lastError || runtimeErrors.get(connection.id) || null,
    };
  });
}

function announceConnections() {
  multiHub.broadcast("connections", { connections: connectionList() });
}

async function replaceRuntime(id) {
  const previous = runtimes.get(id);
  runtimes.delete(id);
  if (previous) await previous.stop();
  const connection = connections.get(id);
  if (connection?.enabled) {
    await startRuntime(connection);
  } else {
    runtimeErrors.delete(id);
  }
  announceConnections();
}

async function startRuntime(connection) {
  let runtime;
  try {
    runtime = createRuntime(connection);
    runtimes.set(connection.id, runtime);
    runtime.start();
    runtimeErrors.delete(connection.id);
  } catch (error) {
    runtimes.delete(connection.id);
    if (runtime) await runtime.stop();
    else multiHub.removeServer(connection.id);
    const token = connections.getClientConfig(connection.id)?.token;
    const message = credentialRedactor(token)(error.message);
    runtimeErrors.set(connection.id, message);
    announceConnections();
    throw new Error(message);
  }
}

let connectionOperations = Promise.resolve();
function changeConnections(operation) {
  const result = connectionOperations.then(operation);
  connectionOperations = result.then(() => {}, () => {});
  return result;
}

async function handleApi(req, res, url) {
  const { pathname, searchParams } = url;
  const method = req.method || "GET";

  if (pathname === "/api/health" && method === "GET") {
    const active = [...runtimes.values()];
    return sendJson(res, 200, {
      ok: true,
      controlApi: active.some((runtime) => runtime.backend.reachable),
      controlApiAuthOk: active.some((runtime) => runtime.backend.authOk),
      streamConnected: active.some((runtime) => runtime.hub.connected),
    });
  }

  if (pathname === "/api/connections" && method === "GET") {
    const active = connectionList();
    const deleted = searchParams.get("includeDeleted") === "1"
      ? connections.list({ includeDeleted: true }).filter((item) => item.deletedAt)
      : [];
    return sendJson(res, 200, { connections: [...active, ...deleted] });
  }

  if (pathname === "/api/connections" && method === "POST") {
    const body = await readJsonBody(req);
    const connection = await changeConnections(async () => {
      const created = connections.add(body);
      await replaceRuntime(created.id);
      return created;
    });
    return sendJson(res, 201, connection);
  }

  if (pathname === "/api/connections/order" && method === "PUT") {
    const body = await readJsonBody(req);
    const result = await changeConnections(async () => {
      const ordered = connections.reorder(body.ids);
      announceConnections();
      return ordered;
    });
    return sendJson(res, 200, { connections: result });
  }

  if (pathname === "/api/connections/test" && method === "POST") {
    const body = await readJsonBody(req);
    const saved = body.id ? connections.getClientConfig(body.id) : null;
    if (body.id && !saved) return sendJson(res, 404, { error: "Connection not found." });
    if (saved && body.apiUrl && !Object.hasOwn(body, "apiToken")) {
      let candidate;
      try { candidate = new URL(body.apiUrl).href.replace(/\/+$/, ""); } catch {}
      if (candidate !== saved.baseUrl)
        return sendJson(res, 400, { error: "Enter the token again to test a different URL." });
    }
    const result = await testConnection({
      apiUrl: body.apiUrl ?? saved?.baseUrl,
      apiToken: Object.hasOwn(body, "apiToken") ? body.apiToken : saved?.token ?? "",
    });
    return sendJson(res, 200, result);
  }

  if (pathname.startsWith("/api/connections/") && pathname.endsWith("/export") && method === "POST") {
    const id = decodeURIComponent(pathname.slice("/api/connections/".length, -"/export".length));
    if (!id || id.includes("/") || !connections.get(id))
      return sendJson(res, 404, { error: "Connection not found." });
    try {
      const filename = exportLegacyDatabase(db, dataDir, id);
      return sendJson(res, 201, { filename });
    } catch (error) {
      log("error", "Could not export the single-server database.");
      return sendJson(res, 500, { error: error.message === "The database contains unsupported historical columns."
        ? error.message : "Could not export the single-server database. Check the data directory and database." });
    }
  }

  if (pathname.startsWith("/api/connections/")) {
    const id = decodeURIComponent(pathname.slice("/api/connections/".length));
    if (!id || id.includes("/")) return sendJson(res, 404, { error: "Connection not found." });
    if (method === "PATCH") {
      const body = await readJsonBody(req);
      const result = await changeConnections(async () => {
        const updated = connections.update(id, body);
        if (updated) {
          if ("apiUrl" in body || "apiToken" in body || "enabled" in body) {
            await replaceRuntime(id);
          } else {
            const active = runtimes.get(id);
            if (active) {
              active.server.name = updated.name;
              active.hub.broadcast("state", active.currentState());
            }
            announceConnections();
          }
        }
        return updated;
      });
      return result ? sendJson(res, 200, result) : sendJson(res, 404, { error: "Connection not found." });
    }
    if (method === "DELETE") {
      const removed = await changeConnections(async () => {
        if (!connections.remove(id)) return false;
        await replaceRuntime(id);
        return true;
      });
      return removed ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: "Connection not found." });
    }
  }

  const serverId = req.headers["x-server-id"] || searchParams.get("serverId");
  const runtime = serverId ? runtimes.get(serverId) : null;

  // live
  if (pathname === "/api/events" && method === "GET") {
    const snapshot = runtime ? runtime.currentState() : {
      reachable: false, authOk: false, timezone: TIMEZONE, codes: [],
    };
    return multiHub.addClient(req, res, snapshot, connectionList());
  }

  if (!serverId) return sendJson(res, 400, { error: "Select a server first." });
  if (!runtime && method === "GET" && searchParams.get("history") === "1") {
    const archived = connections.list({ includeDeleted: true }).find((item) => item.id === serverId);
    if (!archived) return sendJson(res, 404, { error: "Server not found." });
    const historicalStore = new Store({ db, serverId, readOnly: true });
    try {
      if (pathname === "/api/summary") {
        return sendJson(res, 200, {
          status: { serverId, serverName: archived.name, reachable: false, botRunning: false },
          accounts: historicalStore.snapshotAccounts(),
          runs: historicalStore.snapshotRuns(30),
          activity: historicalStore.snapshotActivity(120),
        });
      }
      if (pathname === "/api/accounts") {
        const historyDays = Math.min(3650, Math.max(0, Number(searchParams.get("historyDays")) || 0));
        const days = searchParams.get("historyDays") === "all" ? null : searchParams.has("historyDays") ? historyDays : 365;
        const since = days ? new Date(Date.now() - days * 86400000).toISOString() : null;
        const histories = days !== 0 ? historicalStore.allAccountHistories({ since }) : {};
        return sendJson(res, 200, {
          accounts: mergeAccounts([], historicalStore.snapshotAccounts(), histories, historicalStore.accountActivities()),
          histories, historyDays: days, apiError: null,
        });
      }
      if (pathname === "/api/runs") {
        const limit = Math.min(500, Math.max(1, Number(searchParams.get("limit")) || 50));
        const offset = Math.max(0, Math.floor(Number(searchParams.get("offset")) || 0));
        return sendJson(res, 200, { runs: historicalStore.snapshotRuns(limit, offset), exits: [], apiError: null });
      }
      if (pathname === "/api/logs") {
        const limit = Math.min(5000, Math.max(1, Number(searchParams.get("limit")) || 500));
        return sendJson(res, 200, { logs: historicalStore.snapshotActivity(limit), historical: true });
      }
      if (pathname === "/api/activity-days") {
        const days = searchParams.get("days") === "all" ? null : Math.min(60, Math.max(1, Number(searchParams.get("days")) || 14));
        const history = new ActivityStore(db, { serverId });
        history.booted = true;
        return sendJson(res, 200, JSON.parse(history.payload({ days }).json.toString("utf8")));
      }
      return sendJson(res, 404, { error: "Historical endpoint not found." });
    } finally {
      historicalStore.close();
    }
  }
  if (!runtime) return sendJson(res, 404, { error: "Server is disabled or not found." });
  const { client, store, activity, scheduler, pendingLoginCodes, hub, backend, currentState, describeSchedule, describeRemoteSchedule } = runtime;
  const forward = (response, verb, apiPath, body) => forwardRequest(runtime, response, verb, apiPath, body);

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
      apiError = e.statusCode === 401 ? AUTH_HINT : runtime.scrubError(e.message);
    }
    const historyDays = Math.min(
      3650,
      Math.max(0, Number(searchParams.get("historyDays")) || 0),
    );
    const effectiveHistoryDays = searchParams.get("historyDays") === "all" ? null : searchParams.has("historyDays")
      ? historyDays
      : 365;
    const since =
      effectiveHistoryDays > 0
        ? new Date(
          Date.now() - effectiveHistoryDays * 24 * 60 * 60 * 1000,
        ).toISOString()
        : null;
    const histories =
      effectiveHistoryDays !== 0 ? store.allAccountHistories({ since }) : {};
    return sendJson(res, 200, {
      accounts: mergeAccounts(
        apiAccounts,
        store.snapshotAccounts(),
        histories,
        store.accountActivities(),
      ),
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
    const offset = Math.max(0, Math.floor(Number(searchParams.get("offset")) || 0));
    let exits = [];
    let apiError = null;
    try {
      const data = await client.get(`/history?limit=${limit}`);
      exits = data.runs || [];
    } catch (e) {
      apiError = e.statusCode === 401 ? AUTH_HINT : runtime.scrubError(e.message);
    }
    return sendJson(res, 200, {
      runs: store.snapshotRuns(limit, offset),
      exits,
      apiError,
    });
  }

  // Per-account, per-Rewards-day activity tables (see lib/activityModel.js).
  if (pathname === "/api/activity-days" && method === "GET") {
    const days = Math.min(
      60,
      Math.max(1, Number(searchParams.get("days")) || 14),
    );
    const p = activity.payload({ days });
    const headers = {
      "Cache-Control": "no-cache", // always revalidate; unchanged data is a 304
      ETag: p.etag,
      Vary: "Accept-Encoding, X-Server-ID",
    };
    if (req.headers["if-none-match"] === p.etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    const gz = /\bgzip\b/.test(req.headers["accept-encoding"] || "");
    const body = gz ? p.gzip : p.json;
    res.writeHead(200, {
      ...headers,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": body.length,
      ...(gz ? { "Content-Encoding": "gzip" } : {}),
    });
    return res.end(body);
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
          const payload = runtime.scrubError(
            e.body && typeof e.body === "object"
              ? e.body
              : { error: e.message || "Control API unreachable" },
          );
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
          error: runtime.scrubError(e.message),
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

  if (pathname === "/api/config/diff" && method === "GET") {
    return forward(res, "GET", "/config/diff");
  }

  if (pathname === "/api/config/sync" && method === "POST") {
    return forward(res, "POST", "/config/sync", {});
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
      const chunks = [];
      let size = 0;
      for await (const chunk of upstream) {
        size += chunk.length;
        if (size > 10_000_000) {
          upstream.destroy();
          return sendJson(res, 502, { error: "Diagnostic file exceeds the size limit." });
        }
        chunks.push(chunk);
      }
      const content = Buffer.concat(chunks);
      if (file === "screenshot.png") {
        if (runtime.scrub.containsBytes(content))
          return sendJson(res, 502, { error: "Diagnostic screenshot contains a credential and cannot be displayed." });
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
        return res.end(content);
      }
      let text;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(content);
      } catch {
        return sendJson(res, 502, { error: "Diagnostic file is not valid UTF-8." });
      }
      const sanitized = runtime.scrub(text);
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      return res.end(sanitized);
    } catch (e) {
      return sendJson(res, e.statusCode || 502, { error: runtime.scrubError(e.message) });
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

  // dashboard-local account data (separate from the bot's own accounts/
  // sessions, which live on the Control API and are untouched by this)
  if (pathname.startsWith("/api/dashboard-accounts/") && method === "DELETE") {
    const email = decodeURIComponent(
      pathname.slice("/api/dashboard-accounts/".length),
    );
    if (!email) return sendJson(res, 400, { error: "Missing account email" });
    // Refuse while the account is part of an active run: the dashboard UI
    // disables Remove in that case, but a run can start between render and
    // click. The accounts view shows a 409 as a warning toast.
    const target = email.trim().toLowerCase();
    const same = (value) => typeof value === "string" && value.trim().toLowerCase() === target;
    const state = currentState();
    if (
      state.botRunning &&
      (store.snapshotAccounts().some((a) => same(a.email) && a.status === "running") ||
        (state.bot?.run?.accounts || []).some((a) => same(a?.email) && a.success == null))
    ) {
      return sendJson(res, 409, {
        error: "This account is part of a run in progress. Wait for it to finish or stop the run, then remove it.",
      });
    }
    try {
      store.deleteAccount(email);
      hub.broadcast("state", currentState());
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, 500, { error: runtime.scrubError(e.message) });
    }
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
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin && (() => {
        try { return new URL(origin).host !== req.headers.host; } catch { return true; }
      })()) return sendJson(res, 403, { error: "Cross-origin requests are not allowed." });
      if (["POST", "PUT", "PATCH"].includes(req.method) &&
          !/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || ""))
        return sendJson(res, 415, { error: "Content-Type must be application/json." });
    }
    return handleApi(req, res, url).catch((e) => {
      if (e.code === "BAD_REQUEST") {
        if (!res.headersSent) sendJson(res, 400, { error: e.message });
      } else {
        log("error", "Request failed.");
        if (!res.headersSent) sendJson(res, 500, { error: "Request failed." });
      }
      if (res.headersSent && !res.writableEnded) res.destroy();
    });
  }

  return serveStatic(res, pathname);
});

server.listen(PORT, () => {
  log("info", `Rewards dashboard listening on :${server.address().port}`);
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
  for (const connection of connections.list()) {
    if (!connection.enabled) continue;
    void startRuntime(connection).catch(() =>
      log("error", "Could not start connection."),
    );
  }
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", "Shutting down…");
  server.close();
  await Promise.all([...runtimes.values()].map((runtime) => runtime.stop()));
  multiHub.stop();
  db.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());