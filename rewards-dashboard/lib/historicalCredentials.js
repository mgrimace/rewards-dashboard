"use strict";

const { credentialRedactor } = require("./redact");

const TABLES = {
  accounts: { text: ["last_error"], json: ["last_earnable", "last_activity_counts"] },
  account_activities: { text: ["reason", "flow"] },
  account_history: {},
  runs: {},
  activity: { text: ["message", "raw", "title", "user_name", "platform"] },
  run_account_snapshots: { json: ["snapshot"] },
  punchcard_progress: {},
  meta: {},
};
const LEGACY_ID = "__legacy__";
const PROTECTED_JSON_KEY = /^(?:email|runId|id|schema|status|ts|day|date|offerId|.*(?:At|Timestamp|Date))$/i;

class CleanupInputError extends Error {}

function quote(name) {
  return `"${name.replace(/"/g, '""')}"`;
}

function cleanJson(value, redact) {
  try {
    JSON.parse(value);
  } catch {
    return { value, protectedMatch: redact(value) !== value, invalid: true };
  }
  let key = "";
  let protectedMatch = false;
  const result = value.replace(/"(?:\\.|[^"\\])*"/g, (raw, offset) => {
    const decoded = JSON.parse(raw);
    if (/^\s*:/.test(value.slice(offset + raw.length))) {
      key = decoded;
      if (redact(decoded) !== decoded) protectedMatch = true;
      return raw;
    }
    const cleaned = redact(decoded);
    if (cleaned === decoded) return raw;
    if (PROTECTED_JSON_KEY.test(key)) {
      protectedMatch = true;
      return raw;
    }
    return JSON.stringify(cleaned);
  });
  if (redact(result) !== result) protectedMatch = true;
  return { value: result, protectedMatch, invalid: false };
}

function scanHistoricalCredentials(db, { supplied, apply }) {
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied))
    throw new CleanupInputError("Credentials must be a mapping of server IDs to token arrays.");
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' LIMIT 1").get())
    throw new CleanupInputError("Historical cleanup does not support databases containing triggers.");
  const present = new Set(tables.map((row) => row.name));
  const known = Object.keys(TABLES).filter((table) => present.has(table));
  if (!known.includes("activity") || !known.includes("accounts"))
    throw new CleanupInputError("The database is missing required historical tables.");
  const info = Object.fromEntries(known.map((table) => [
    table, db.prepare(`PRAGMA table_info(${quote(table)})`).all(),
  ]));
  const scoped = known.map((table) => info[table].some((column) => column.name === "server_id"));
  if (scoped.some(Boolean) && !scoped.every(Boolean))
    throw new CleanupInputError("Historical tables have inconsistent server scoping.");
  const isScoped = scoped[0];
  if (isScoped && !present.has("dashboard_connections"))
    throw new CleanupInputError("The connection registry is missing.");

  const credentials = new Map();
  if (isScoped) {
    for (const row of db.prepare("SELECT id, api_token FROM dashboard_connections").all())
      credentials.set(row.id, row.api_token ? [row.api_token] : []);
    for (const table of known) {
      for (const row of db.prepare(`SELECT DISTINCT server_id FROM ${quote(table)}`).all()) {
        if (typeof row.server_id === "string" && !credentials.has(row.server_id))
          credentials.set(row.server_id, []);
      }
    }
  } else {
    credentials.set(LEGACY_ID, []);
  }
  for (const [id, tokens] of Object.entries(supplied)) {
    if (!credentials.has(id)) throw new CleanupInputError("A supplied server ID is not in this database.");
    if (!Array.isArray(tokens) || tokens.some((token) =>
      typeof token !== "string" || !token || token.length > 4096))
      throw new CleanupInputError("Each server must have an array of non-empty token strings.");
    credentials.get(id).push(...tokens);
  }
  if (![...credentials.values()].some((tokens) => tokens.length))
    throw new CleanupInputError("No known credentials are available for historical cleanup.");

  const result = { servers: 0, changedRows: 0, changedCells: 0, protectedCells: 0, invalidJsonCells: 0 };
  for (const [id, tokens] of credentials) {
    if (!tokens.length) continue;
    result.servers++;
    const redactors = [...new Set(tokens)].sort((a, b) => b.length - a.length).map(credentialRedactor);
    const redact = (value) => redactors.reduce((text, fn) => fn(text), value);
    for (const table of known) {
      const tableInfo = info[table];
      const columns = tableInfo.filter((column) => /TEXT/i.test(column.type)).map((column) => column.name);
      const targets = TABLES[table];
      const text = new Set((targets.text || []).filter((name) => columns.includes(name)));
      const json = new Set((targets.json || []).filter((name) => columns.includes(name)));
      const selected = columns.filter((name) => name !== "server_id");
      if (!selected.length) continue;
      const where = isScoped ? " WHERE server_id = ?" : "";
      const rows = db.prepare(`SELECT rowid AS __cleanup_rowid, ${selected.map(quote).join(", ")} FROM ${quote(table)}${where}`);
      const updates = new Map();
      const iterator = isScoped ? rows.iterate(id) : rows.iterate();
      for (const row of iterator) {
        const changed = [];
        for (const column of selected) {
          const value = row[column];
          if (typeof value !== "string") continue;
          if (json.has(column)) {
            const clean = cleanJson(value, redact);
            if (clean.protectedMatch) result.protectedCells++;
            if (clean.invalid) result.invalidJsonCells++;
            if (clean.value !== value) changed.push([column, clean.value]);
          } else if (text.has(column)) {
            const clean = redact(value);
            if (clean !== value) {
              if (redact(clean) !== clean) result.protectedCells++;
              changed.push([column, clean]);
            }
          } else if (redact(value) !== value) {
            result.protectedCells++;
          }
        }
        if (!changed.length) continue;
        result.changedRows++;
        result.changedCells += changed.length;
        if (apply) {
          const names = changed.map(([column]) => column);
          const key = names.join("\0");
          let statement = updates.get(key);
          if (!statement) {
            statement = db.prepare(`UPDATE ${quote(table)} SET ${names.map((column) => `${quote(column)} = ?`).join(", ")} WHERE rowid = ?${isScoped ? " AND server_id = ?" : ""}`);
            updates.set(key, statement);
          }
          statement.run(...changed.map(([, value]) => value), row.__cleanup_rowid, ...(isScoped ? [id] : []));
        }
      }
    }
  }
  return result;
}

function cleanHistoricalCredentials(db, { supplied = {}, apply = false } = {}) {
  db.exec(apply ? "BEGIN IMMEDIATE" : "BEGIN");
  try {
    const result = scanHistoricalCredentials(db, { supplied, apply });
    db.exec(apply ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

module.exports = { cleanHistoricalCredentials, CleanupInputError, LEGACY_ID };
