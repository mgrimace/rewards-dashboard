const SERVER_KEY = "rewards_dashboard_server";

export function selectedServer() {
  return sessionStorage.getItem(SERVER_KEY) || "";
}

export function selectServer(id) {
  if (id) sessionStorage.setItem(SERVER_KEY, id);
  else sessionStorage.removeItem(SERVER_KEY);
}

async function call(method, path, body, global = false, serverId = selectedServer()) {
  const opts = { method, headers: { Accept: "application/json" } };
  if (!global && serverId) opts.headers["X-Server-ID"] = serverId;
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new Error("Dashboard server unreachable");
  }

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const err = new Error(
      (data && (data.error || data.message)) ||
      `Request failed (${res.status})`,
    );
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data ?? {};
}

export const api = {
  connections: (includeDeleted = false) => call("GET", `/api/connections${includeDeleted ? "?includeDeleted=1" : ""}`, undefined, true),
  forServer: (id, historical = false) => {
    const get = (path) => call("GET", `${path}${historical ? `${path.includes("?") ? "&" : "?"}history=1` : ""}`, undefined, false, id);
    return {
      summary: () => get("/api/summary"),
      accounts: (days = 365) => get(`/api/accounts?historyDays=${days}`),
      activityDays: (days = 14) => get(`/api/activity-days?days=${days}`),
      runs: (limit = 100, offset = 0) => get(`/api/runs?limit=${limit}&offset=${offset}`),
      logs: (limit = 500) => get(`/api/logs?limit=${limit}`),
      control: (action, body = {}) => call("POST", `/api/control/${action}`, body, false, id),
      deleteDashboardAccount: (email) =>
        call("DELETE", `/api/dashboard-accounts/${encodeURIComponent(email)}`, undefined, false, id),
    };
  },
  addConnection: (body) => call("POST", "/api/connections", body, true),
  updateConnection: (id, body) =>
    call("PATCH", `/api/connections/${encodeURIComponent(id)}`, body, true),
  removeConnection: (id) =>
    call("DELETE", `/api/connections/${encodeURIComponent(id)}`, undefined, true),
  reorderConnections: (ids) => call("PUT", "/api/connections/order", { ids }, true),
  testConnection: (body) => call("POST", "/api/connections/test", body, true),
  summary: () => call("GET", "/api/summary"),
  // Per-account, per-Rewards-day activity tables (server: lib/activityModel.js).
  activityDays: (days = 14) => call("GET", `/api/activity-days?days=${days}`),
  accounts: (historyDays = 365) =>
    call("GET", `/api/accounts?historyDays=${historyDays}`),
  runs: (limit = 50) => call("GET", `/api/runs?limit=${limit}`),
  logs: (limit = 500, level = null) =>
    call(
      "GET",
      `/api/logs?limit=${limit}${level ? `&level=${encodeURIComponent(level)}` : ""}`,
    ),
  errors: (limit = 100) => call("GET", `/api/errors?limit=${limit}`),
  loginCodes: () => call("GET", "/api/login-codes"),

  // schedule() returns { local, remote, remoteSupported }. saveSchedule's
  // `target` selects which scheduler the patch applies to: "local" (this
  // dashboard's own cron, default) or "remote" (the bot container's cron,
  // via its Control API's /schedule endpoint).
  schedule: () => call("GET", "/api/schedule"),
  saveSchedule: (patch, target = "local") =>
    call("PUT", "/api/schedule", { ...patch, target }),
  describeCron: (expr) =>
    call("GET", `/api/cron?expr=${encodeURIComponent(expr)}`),

  config: (reveal = false) =>
    call("GET", `/api/config${reveal ? "?reveal=1" : ""}`),
  replaceConfig: (cfg) => call("PUT", "/api/config", cfg),
  patchConfig: (patch) => call("PATCH", "/api/config", patch),
  configDiff: () => call("GET", "/api/config/diff"),
  syncConfig: () => call("POST", "/api/config/sync"),

  diagnostics: () => call("GET", "/api/diagnostics"),
  diagnosticFile: (name, file) =>
    `/api/diagnostics/${encodeURIComponent(name)}/${encodeURIComponent(file)}?serverId=${encodeURIComponent(selectedServer())}`,

  sessions: () => call("GET", "/api/sessions"),
  clearSession: (email) =>
    call("DELETE", `/api/sessions/${encodeURIComponent(email)}`),
  deleteDashboardAccount: (email) =>
    call("DELETE", `/api/dashboard-accounts/${encodeURIComponent(email)}`),

  control: (action, body = {}) => call("POST", `/api/control/${action}`, body),
};

const cache = new Map();

export async function cached(key, fetcher, ttlMs = 4000) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await fetcher();
  cache.set(key, { at: Date.now(), value });
  return value;
}

export function invalidate(key) {
  if (key) cache.delete(key);
  else cache.clear();
}