"use strict";

// These are the tables owned by Store and ActivityStore. The integer IDs on
// history/activity stay globally unique; all other existing keys are scoped.
const TABLES = {
  meta: ["key"],
  accounts: ["email"],
  account_activities: ["email", "activity", "title"],
  account_history: null,
  runs: ["id"],
  activity: null,
  run_account_snapshots: ["run_id", "email"],
  punchcard_progress: ["email", "offer_id", "day"],
};

const REQUIRED_TABLES = [
  "meta", "accounts", "account_activities", "account_history", "runs", "activity",
];

const INDEXES = [
  ["account_history", "idx_server_history_email_ts", "server_id, email, ts"],
  ["runs", "idx_server_runs_start", "server_id, start_ts"],
  ["activity", "idx_server_activity_ts", "server_id, ts"],
  ["run_account_snapshots", "idx_server_ras_email_ended", "server_id, email, ended_at"],
];
const NO_LEGACY_SERVER = "__no_legacy_server__";

function quote(identifier) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${quote(table)})`).all();
}

function scopedDefinition(sql, table, key) {
  let definition = sql;
  let inlineKey = false;
  if (key) {
    const keys = key.map((name) => `"?${name}"?`).join("\\s*,\\s*");
    const constraint = new RegExp(`\\bPRIMARY\\s+KEY\\s*\\(\\s*(${keys})\\s*\\)`, "i");
    if (constraint.test(definition)) {
      definition = definition.replace(constraint, "PRIMARY KEY (server_id, $1)");
    } else if (key.length === 1) {
      const inline = new RegExp(`("\\b${key[0]}\\b"|\\b${key[0]}\\b)(\\s+\\w+\\s+)PRIMARY\\s+KEY\\b`, "i");
      if (!inline.test(definition))
        throw new Error(`Unsupported primary key definition in ${table}.`);
      definition = definition.replace(inline, "$1$2NOT NULL");
      inlineKey = true;
    } else {
      throw new Error(`Unsupported primary key definition in ${table}.`);
    }
  }
  const end = definition.lastIndexOf(")");
  const start = definition.indexOf("(");
  if (start < 0 || end <= start) throw new Error(`Unsupported table definition for ${table}.`);
  const extraKey = inlineKey ? `, PRIMARY KEY (server_id, ${quote(key[0])})` : "";
  return `${definition.slice(0, start + 1)} server_id TEXT NOT NULL,${definition.slice(start + 1, end)}${extraKey}${definition.slice(end)}`;
}

/**
 * Scope the existing dashboard tables to the imported connection in one
 * transaction. Call only after the registry contains that connection.
 * The application must supply a server ID to every Store and ActivityStore
 * using this database after migration.
 */
function migrateServerData(db, serverId) {
  if (typeof serverId !== "string" || !serverId)
    throw new Error("A legacy server ID is required.");
  db.exec("SAVEPOINT server_data_migration");
  try {
    const connection = db.prepare(
      "SELECT id FROM dashboard_connections WHERE id = ?",
    ).get(serverId);
    if (!connection && serverId !== NO_LEGACY_SERVER)
      throw new Error("The legacy server connection does not exist.");

    const marker = db.prepare(
      "SELECT value FROM dashboard_connection_meta WHERE key = 'historical_server_id'",
    ).get();
    if (marker && marker.value !== serverId)
      throw new Error("Historical data has already been assigned to another server.");

    const present = Object.keys(TABLES).map((table) => ({
      table,
      schema: db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get(table),
    })).filter((item) => item.schema);
    if (REQUIRED_TABLES.some((table) => !present.some((item) => item.table === table)))
      throw new Error("Historical database is missing required tables.");

    const scoped = present.filter(({ table }) => columns(db, table).some((col) => col.name === "server_id"));
    if (scoped.length && scoped.length !== present.length)
      throw new Error("Historical tables have inconsistent server scoping.");
    if (scoped.length) {
      if (!marker) throw new Error("Server-scoped tables have no migration marker.");
      db.exec("RELEASE server_data_migration");
      return;
    }
    if (marker) throw new Error("Historical migration marker does not match the database schema.");
    if (serverId === NO_LEGACY_SERVER && present.some(({ table }) =>
      db.prepare(`SELECT 1 FROM ${quote(table)} LIMIT 1`).get()))
      throw new Error("Cannot migrate historical data without a server identity.");

    if (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('trigger', 'view') LIMIT 1").get())
      throw new Error("Cannot migrate a database containing views or triggers.");
    for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
      if (db.prepare(`PRAGMA foreign_key_list(${quote(row.name)})`).all().length)
        throw new Error("Cannot migrate a database containing foreign keys.");
    }

    for (const { table, schema } of present) {
      const info = columns(db, table);
      const primary = info.filter((col) => col.pk).sort((a, b) => a.pk - b.pk).map((col) => col.name);
      const expected = TABLES[table] || ["id"];
      if (JSON.stringify(primary) !== JSON.stringify(expected))
        throw new Error(`Unexpected primary key in ${table}.`);
      const indexes = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL",
      ).all(table);
      const hasSequence = Boolean(db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'",
      ).get());
      const sequence = hasSequence
        ? db.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(table)
        : null;
      const legacyName = `__legacy_${table}`;
      const definition = scopedDefinition(schema.sql, table, TABLES[table]);
      const names = info.map((col) => quote(col.name)).join(", ");
      db.exec(`ALTER TABLE ${quote(table)} RENAME TO ${quote(legacyName)}`);
      db.exec(definition);
      db.prepare(
        `INSERT INTO ${quote(table)} (${names}, server_id) SELECT ${names}, ? FROM ${quote(legacyName)}`,
      ).run(serverId);
      db.exec(`DROP TABLE ${quote(legacyName)}`);
      for (const index of indexes) db.exec(index.sql);
      if (sequence) {
        const current = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(table);
        if (current) {
          db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = ?").run(
            Math.max(sequence.seq, current.seq), table,
          );
        } else {
          db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)").run(table, sequence.seq);
        }
      }
    }
    for (const [table, index, fields] of INDEXES) {
      if (present.some((item) => item.table === table))
        db.exec(`CREATE INDEX IF NOT EXISTS ${quote(index)} ON ${quote(table)} (${fields})`);
    }
    db.prepare(
      "INSERT INTO dashboard_connection_meta (key, value) VALUES ('historical_server_id', ?)",
    ).run(serverId);
    db.exec("RELEASE server_data_migration");
  } catch (error) {
    db.exec("ROLLBACK TO server_data_migration; RELEASE server_data_migration");
    throw error;
  }
}

module.exports = { migrateServerData, NO_LEGACY_SERVER };
