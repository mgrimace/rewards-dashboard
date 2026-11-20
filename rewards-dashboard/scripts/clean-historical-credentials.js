"use strict";

const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const { cleanHistoricalCredentials, CleanupInputError } = require("../lib/historicalCredentials");

let db;
try {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const fromStdin = args.includes("--stdin");
  const paths = args.filter((arg) => !["--apply", "--stdin"].includes(arg));
  if (paths.length !== 1 || paths[0].startsWith("-"))
    throw new CleanupInputError("Usage: node scripts/clean-historical-credentials.js [--apply] [--stdin] DATABASE");
  let supplied = {};
  if (fromStdin) {
    try { supplied = JSON.parse(fs.readFileSync(0, "utf8")); }
    catch { throw new CleanupInputError("Could not read the credential mapping from standard input."); }
  }
  if (!fs.statSync(paths[0]).isFile()) throw new CleanupInputError("The database must be an existing regular file.");
  db = new DatabaseSync(paths[0], { readOnly: !apply });
  if (apply) db.exec("PRAGMA secure_delete = ON; PRAGMA busy_timeout = 5000;");
  const result = cleanHistoricalCredentials(db, { supplied, apply });
  console.log(JSON.stringify({ mode: apply ? "applied" : "dry-run", ...result }));
  if (result.protectedCells || result.invalidJsonCells) {
    console.error("Some potential matches were not changed; review the documented limitations.");
    process.exitCode = 2;
  }
} catch (error) {
  // Database or credential values can appear in exception messages.
  console.error(error instanceof CleanupInputError
    ? `Historical cleanup failed: ${error.message}`
    : "Historical cleanup failed. Check the database and file permissions.");
  process.exitCode = 1;
} finally {
  if (db) db.close();
}
