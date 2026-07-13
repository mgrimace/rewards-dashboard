"use strict";

const http = require("node:http");
const https = require("node:https");
const { URL } = require("node:url");

const DEFAULT_TIMEOUT_MS = 10000;

class ApiError extends Error {
  constructor(message, { statusCode = null, body = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.body = body; // parsed JSON error body from the API, when it sent one
  }
}

class ControlApiClient {
  constructor({ baseUrl, token }) {
    this.baseUrl = String(baseUrl || "").replace(/\/+$/, "");
    this.token = token || null;
  }

  _target(pathAndQuery) {
    return new URL(this.baseUrl + pathAndQuery);
  }

  _headers(extra) {
    const headers = { Accept: "application/json", ...extra };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }

  request(
    method,
    pathAndQuery,
    { body = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
  ) {
    return new Promise((resolve, reject) => {
      let target;
      try {
        target = this._target(pathAndQuery);
      } catch (e) {
        return reject(new ApiError(`Bad Control API URL: ${e.message}`));
      }

      const payload =
        body == null ? null : Buffer.from(JSON.stringify(body), "utf8");
      const headers = this._headers(
        payload
          ? {
            "Content-Type": "application/json",
            "Content-Length": payload.length,
          }
          : {},
      );
      const lib = target.protocol === "https:" ? https : http;

      const req = lib.request(
        target,
        { method, headers, timeout: timeoutMs },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed = null;
            if (text) {
              try {
                parsed = JSON.parse(text);
              } catch {
                parsed = null;
              }
            }
            const status = res.statusCode || 0;
            if (status >= 400) {
              const message =
                (parsed && (parsed.error || parsed.message)) ||
                `Control API ${target.pathname} -> ${status}`;
              return reject(
                new ApiError(message, { statusCode: status, body: parsed }),
              );
            }
            resolve(parsed ?? {});
          });
        },
      );

      req.on("timeout", () =>
        req.destroy(new ApiError("Control API request timed out")),
      );
      req.on("error", (err) =>
        reject(err instanceof ApiError ? err : new ApiError(err.message)),
      );
      if (payload) req.write(payload);
      req.end();
    });
  }

  get(p) {
    return this.request("GET", p);
  }
  post(p, body) {
    return this.request("POST", p, { body: body ?? {} });
  }
  put(p, body) {
    return this.request("PUT", p, { body });
  }
  patch(p, body) {
    return this.request("PATCH", p, { body });
  }

  stream(pathAndQuery, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
      let target;
      try {
        target = this._target(pathAndQuery);
      } catch (e) {
        return reject(new ApiError(`Bad Control API URL: ${e.message}`));
      }
      const lib = target.protocol === "https:" ? https : http;
      const req = lib.request(
        target,
        {
          method: "GET",
          headers: this._headers({ Accept: "*/*" }),
          timeout: timeoutMs,
        },
        (res) => {
          if ((res.statusCode || 0) >= 400) {
            res.resume();
            return reject(
              new ApiError(
                `Control API ${target.pathname} -> ${res.statusCode}`,
                { statusCode: res.statusCode },
              ),
            );
          }
          resolve(res);
        },
      );
      req.on("timeout", () =>
        req.destroy(new ApiError("Control API request timed out")),
      );
      req.on("error", (err) =>
        reject(err instanceof ApiError ? err : new ApiError(err.message)),
      );
      req.end();
    });
  }

  sse({ replay = 200, lastEventId = null } = {}) {
    return new Promise((resolve, reject) => {
      const q = new URLSearchParams({ replay: String(replay) });
      let target;
      try {
        target = this._target(`/events?${q.toString()}`);
      } catch (e) {
        return reject(new ApiError(`Bad Control API URL: ${e.message}`));
      }

      const headers = this._headers({
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
      });
      if (lastEventId != null) headers["Last-Event-ID"] = String(lastEventId);

      const lib = target.protocol === "https:" ? https : http;
      const req = lib.request(target, { method: "GET", headers }, (res) => {
        if ((res.statusCode || 0) !== 200) {
          res.resume();
          return reject(
            new ApiError(`Control API /events -> ${res.statusCode}`, {
              statusCode: res.statusCode,
            }),
          );
        }
        res.setEncoding("utf8");
        resolve({ req, res });
      });
      req.on("error", (err) =>
        reject(err instanceof ApiError ? err : new ApiError(err.message)),
      );
      req.end();
    });
  }
}

function entryToDockerLine(entry) {
  if (!entry) return null;
  const line = entry.raw != null ? entry.raw : reconstructAppLine(entry);
  if (line == null) return null;
  return `${syntheticTs(entry)} ${line}`;
}

function syntheticTs(entry) {
  const base = entry.receivedAt || new Date().toISOString();
  if (entry.id == null) return base;
  const stem = base.endsWith("Z") ? base.slice(0, -1) : base;
  return `${stem}${String(entry.id).padStart(9, "0")}Z`;
}

function reconstructAppLine(entry) {
  if (!entry.parsed || !entry.title) return null;
  const appTime = entry.ts || "";
  const user = entry.user || "main";
  const level = (entry.level || "info").toUpperCase();
  const platform = entry.platform || "MAIN";
  return `[${appTime}] [${user}] [${level}] ${platform} [${entry.title}] ${entry.message || ""}`;
}

module.exports = { ControlApiClient, ApiError, entryToDockerLine };
