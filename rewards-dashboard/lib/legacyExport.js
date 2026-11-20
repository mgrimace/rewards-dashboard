"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { Store } = require("./store");
const { ActivityStore } = require("./activityStore");

const TABLES = [
  "meta", "accounts", "account_activities", "account_history", "runs",
  "activity", "run_account_snapshots", "punchcard_progress",
];

function reserveFile(dir, prefix) {
  const filename = `${prefix}-${Date.now()}-${randomUUID()}.sqlite`;
  const file = path.join(dir, `${filename}.tmp`);
  const fd = fs.openSync(file, "wx", 0o600);
  fs.closeSync(fd);
  return { file, filename, final: path.join(dir, filename) };
}

function publishFile(file, final) {
  fs.linkSync(file, final);
  fs.unlinkSync(file);
}

function removeFile(file) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(file + suffix); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function checkIntegrity(db) {
  const result = db.prepare("PRAGMA integrity_check").all();
  if (result.length !== 1 || result[0].integrity_check !== "ok")
    throw new Error("Database integrity check failed.");
}

function backupBeforeMigration(db, dataDir) {
  const { file, filename, final } = reserveFile(dataDir, "dashboard-before-multiserver");
  try {
    db.prepare("VACUUM INTO ?").run(file);
    const snapshot = new DatabaseSync(file, { readOnly: true });
    try { checkIntegrity(snapshot); } finally { snapshot.close(); }
    publishFile(file, final);
    return filename;
  } catch (error) {
    removeFile(file);
    throw error;
  }
}

function quote(name) {
  return `"${name.replace(/"/g, '""')}"`;
}

function exportLegacyDatabase(db, dataDir, serverId) {
  const { file, filename, final } = reserveFile(dataDir, "dashboard-single-server");
  let destination;
  let store;
  let sourceTransaction = false;
  try {
    destination = new DatabaseSync(file);
    store = new Store({ db: destination, readOnly: true });
    new ActivityStore(destination);
    db.exec("BEGIN");
    sourceTransaction = true;
    destination.exec("BEGIN");
    for (const table of TABLES) {
      const sourceColumns = db.prepare(`PRAGMA table_info(${quote(table)})`).all();
      const destinationColumns = destination.prepare(`PRAGMA table_info(${quote(table)})`).all();
      const names = sourceColumns.filter((column) => column.name !== "server_id").map((column) => column.name);
      if (!sourceColumns.some((column) => column.name === "server_id") ||
          names.some((name) => !destinationColumns.some((column) => column.name === name))) {
        throw new Error("The database contains unsupported historical columns.");
      }
      const fields = names.map(quote).join(", ");
      const source = db.prepare(`SELECT ${fields} FROM ${quote(table)} WHERE server_id = ?`);
      const insert = destination.prepare(`INSERT INTO ${quote(table)} (${fields}) VALUES (${names.map(() => "?").join(", ")})`);
      for (const row of source.iterate(serverId)) insert.run(...names.map((name) => row[name]));
    }
    for (const { name, seq } of db.prepare("SELECT name, seq FROM sqlite_sequence").all()) {
      if (!TABLES.includes(name)) continue;
      destination.prepare("DELETE FROM sqlite_sequence WHERE name = ?").run(name);
      destination.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)").run(name, seq);
    }
    destination.exec("COMMIT");
    db.exec("COMMIT");
    sourceTransaction = false;
    checkIntegrity(destination);
    store.close();
    store = null;
    destination.close();
    destination = null;
    publishFile(file, final);
    return filename;
  } catch (error) {
    if (sourceTransaction) db.exec("ROLLBACK");
    if (store) store.close();
    if (destination) destination.close();
    removeFile(file);
    throw error;
  }
}

module.exports = { backupBeforeMigration, exportLegacyDatabase };
