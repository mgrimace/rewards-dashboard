async function call(method, path, body) {
  const opts = { method, headers: { Accept: "application/json" } };
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
  summary: () => call("GET", "/api/summary"),
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

  schedule: () => call("GET", "/api/schedule"),
  saveSchedule: (patch) => call("PUT", "/api/schedule", patch),
  describeCron: (expr) =>
    call("GET", `/api/cron?expr=${encodeURIComponent(expr)}`),

  config: (reveal = false) =>
    call("GET", `/api/config${reveal ? "?reveal=1" : ""}`),
  replaceConfig: (cfg) => call("PUT", "/api/config", cfg),
  patchConfig: (patch) => call("PATCH", "/api/config", patch),

  diagnostics: () => call("GET", "/api/diagnostics"),
  diagnosticFile: (name, file) =>
    `/api/diagnostics/${encodeURIComponent(name)}/${encodeURIComponent(file)}`,

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
