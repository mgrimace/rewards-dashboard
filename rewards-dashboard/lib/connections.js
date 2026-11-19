"use strict";

const { randomUUID } = require("node:crypto");
const { ApiError, ControlApiClient } = require("./apiClient");
const { credentialRedactor } = require("./redact");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dashboard_connections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  api_url TEXT,
  api_token TEXT,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_dashboard_connections_order
  ON dashboard_connections (deleted_at, position, id);
CREATE TABLE IF NOT EXISTS dashboard_connection_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
`;

function invalid(message) {
  const error = new Error(message);
  error.code = "BAD_REQUEST";
  return error;
}

function validateName(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 120)
    throw invalid("Name must contain 1 to 120 characters.");
  return value.trim();
}

function validateUrl(value) {
  if (typeof value !== "string" || value.length > 2048)
    throw invalid("Enter a valid HTTP or HTTPS Control API URL.");
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw invalid("Enter a valid HTTP or HTTPS Control API URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username || url.password || url.href.includes("?") || url.href.includes("#")
  ) {
    throw invalid("The Control API URL must not contain credentials, a query, or a fragment.");
  }
  return url.href.replace(/\/+$/, "");
}

function validateToken(value) {
  if (typeof value !== "string" || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value))
    throw invalid("Token must be at most 4096 characters and contain no control characters.");
  return value;
}

function validateEnabled(value) {
  if (typeof value !== "boolean") throw invalid("Enabled must be a boolean.");
  return value;
}

function safeName(redact, name) {
  return redact(name) || redact("Server") || redact("Connection");
}

function publicConnection(row) {
  if (!row) return null;
  const redact = credentialRedactor(row.api_token);
  const name = safeName(redact, row.name);
  const apiUrl = row.api_url === null ? null : redact(row.api_url);
  return {
    id: row.id,
    name,
    apiUrl,
    nameRedacted: name !== row.name,
    apiUrlRedacted: apiUrl !== row.api_url,
    enabled: Boolean(row.enabled),
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    hasToken: Boolean(row.api_token),
  };
}

class Connections {
  // `legacy` is supplied only when a legacy connection should be imported.
  constructor(db, { legacy = null } = {}) {
    this.db = db;
    db.exec(SCHEMA);
    this.initialize(legacy);
  }

  initialize(legacy) {
    this.db.exec("SAVEPOINT connection_init");
    try {
      const marker = this.db.prepare(
        "SELECT value FROM dashboard_connection_meta WHERE key = ?",
      ).get("initialized");
      if (!marker) {
        const count = this.db.prepare(
          "SELECT COUNT(*) AS n FROM dashboard_connections",
        ).get().n;
        if (!count && legacy) {
          this.add({
            name: "Default Server",
            apiUrl: legacy.apiUrl,
            apiToken: legacy.apiToken,
            enabled: true,
          });
        }
        this.db.prepare(
          "INSERT INTO dashboard_connection_meta (key, value) VALUES (?, ?)",
        ).run("initialized", "1");
      }
      this.db.exec("RELEASE connection_init");
    } catch (error) {
      this.db.exec("ROLLBACK TO connection_init; RELEASE connection_init");
      throw error;
    }
  }

  list({ includeDeleted = false } = {}) {
    const where = includeDeleted ? "" : "WHERE deleted_at IS NULL";
    return this.db.prepare(
      `SELECT * FROM dashboard_connections ${where} ORDER BY position, id`,
    ).all().map(publicConnection);
  }

  get(id) {
    return publicConnection(this.db.prepare(
      "SELECT * FROM dashboard_connections WHERE id = ? AND deleted_at IS NULL",
    ).get(id));
  }

  // Only runtime services should use this method; never serialize its result.
  getClientConfig(id) {
    const row = this.db.prepare(
      "SELECT api_url, api_token FROM dashboard_connections WHERE id = ? AND deleted_at IS NULL",
    ).get(id);
    return row ? { baseUrl: row.api_url, token: row.api_token } : null;
  }

  add({ name, apiUrl, apiToken = "", enabled = true }) {
    const validName = validateName(name);
    const validUrl = validateUrl(apiUrl);
    const validToken = validateToken(apiToken);
    const validEnabled = validateEnabled(enabled);
    const id = randomUUID();
    const now = new Date().toISOString();
    const position = this.db.prepare(
      "SELECT COALESCE(MAX(position), -1) + 1 AS next FROM dashboard_connections WHERE deleted_at IS NULL",
    ).get().next;
    this.db.prepare(`
      INSERT INTO dashboard_connections
        (id, name, api_url, api_token, enabled, position, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, validName, validUrl, validToken, Number(validEnabled), position, now, now);
    return this.get(id);
  }

  update(id, patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch))
      throw invalid("Connection changes must be an object.");
    const current = this.db.prepare(
      "SELECT * FROM dashboard_connections WHERE id = ? AND deleted_at IS NULL",
    ).get(id);
    if (!current) return null;
    const allowed = new Set(["name", "apiUrl", "apiToken", "enabled"]);
    if (Object.keys(patch).some((key) => !allowed.has(key)))
      throw invalid("Unknown connection field.");
    let name = "name" in patch ? validateName(patch.name) : current.name;
    const apiUrl = "apiUrl" in patch ? validateUrl(patch.apiUrl) : current.api_url;
    if (apiUrl !== current.api_url && current.api_token && !Object.hasOwn(patch, "apiToken"))
      throw invalid("Enter the token again or clear it when changing the Control API URL.");
    const apiToken = "apiToken" in patch ? validateToken(patch.apiToken) : current.api_token;
    if (current.api_token && apiToken !== current.api_token) {
      const redactPrevious = credentialRedactor(current.api_token);
      if (redactPrevious(apiUrl) !== apiUrl)
        throw invalid("Replace the Control API URL before changing a token embedded in it.");
      if ("name" in patch && redactPrevious(name) !== name)
        throw invalid("Replace the connection name before changing a token embedded in it.");
      name = safeName(redactPrevious, name);
    }
    const enabled = "enabled" in patch ? validateEnabled(patch.enabled) : Boolean(current.enabled);
    this.db.prepare(`
      UPDATE dashboard_connections
      SET name = ?, api_url = ?, api_token = ?, enabled = ?, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL
    `).run(name, apiUrl, apiToken, Number(enabled), new Date().toISOString(), id);
    return this.get(id);
  }

  reorder(ids) {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string"))
      throw invalid("Order must contain every connection ID exactly once.");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.list();
      const wanted = new Set(ids);
      if (
        wanted.size !== ids.length || ids.length !== existing.length ||
        existing.some((connection) => !wanted.has(connection.id))
      ) {
        throw invalid("Order must contain every connection ID exactly once.");
      }
      const stmt = this.db.prepare(
        "UPDATE dashboard_connections SET position = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
      );
      const now = new Date().toISOString();
      ids.forEach((id, position) => stmt.run(position, now, id));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.list();
  }

  remove(id) {
    const row = this.db.prepare(
      "SELECT name, api_token FROM dashboard_connections WHERE id = ? AND deleted_at IS NULL",
    ).get(id);
    if (!row) return false;
    const name = safeName(credentialRedactor(row.api_token), row.name);
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE dashboard_connections
      SET name = ?, api_url = NULL, api_token = NULL, enabled = 0, deleted_at = ?, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL
    `).run(name, now, now, id);
    return result.changes > 0;
  }
}

async function testConnection({ apiUrl, apiToken = "" }, { timeoutMs = 10000 } = {}) {
  const client = new ControlApiClient({
    baseUrl: validateUrl(apiUrl),
    token: validateToken(apiToken),
  });
  try {
    const health = await client.request("GET", "/health", { timeoutMs });
    const status = await client.request("GET", "/status", { timeoutMs });
    if (
      !health || typeof health !== "object" || Array.isArray(health) ||
      !status || typeof status !== "object" || Array.isArray(status) ||
      typeof status.state !== "string"
    ) {
      return { ok: false, kind: "unexpected", message: "Unexpected Control API response." };
    }
    return { ok: true, kind: "connected", message: "Connected and authenticated." };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (error.statusCode === 401 || error.statusCode === 403)
      return { ok: false, kind: "authentication", message: "Control API authentication was rejected." };
    if (error.statusCode != null)
      return { ok: false, kind: "api", message: `Control API returned HTTP ${error.statusCode}.` };
    return { ok: false, kind: "unreachable", message: "Control API is unreachable or timed out." };
  }
}

module.exports = { Connections, testConnection };
