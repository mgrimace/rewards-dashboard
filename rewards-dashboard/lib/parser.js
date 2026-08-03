"use strict";

// Docker prepends an RFC3339Nano timestamp (because we request timestamps=1),
// e.g: "2026-07-01T12:03:12.123456789Z <rest of line>"
const DOCKER_TS_RE = /^(\S+)\s([\s\S]*)$/;

// App log format (src/logging/Logger.ts):
// [localTime] [userName] [LEVEL] PLATFORM [TITLE] message
const APP_LINE_RE =
  /^\[([^\]]+)\]\s\[([^\]]+)\]\s\[([^\]]+)\]\s(\S+)\s\[([^\]]+)\]\s([\s\S]*)$/;

const ACCOUNT_START_RE = /^Starting account:\s(\S+)\s\|\sgeoLocale:\s(.*)$/;
const ACCOUNT_END_RE =
  /^Completed account:\s(\S+)\s\|\spointsGained=(-?\d+)\s\|\spreviousBalance=(\d+)\s\|\scurrentBalance=(\d+)\s\|\sdurationSeconds=([\d.]+)$/;
const ACCOUNT_ERR_RE = /^(\S+@\S+):\s([\s\S]*)$/;
const RUN_START_RE =
  /^Starting Microsoft Rewards Script\s\|\sv([\w.\-]+)\s\|\sAccounts:\s(\d+)\s\|\sClusters:\s(\d+)$/;
const RUN_END_RE =
  /^Completed all accounts\s\|\saccountsProcessed=(\d+)\s\|\spointsGained=(-?\d+)\s\|\spreviousBalance=(\d+)\s\|\scurrentBalance=(\d+)\s\|\sruntimeMinutes=([\d.]+)$/;
// src/index.ts's waitBeforeNextAccount() - with accountDelay, accounts start
// one at a time now rather than together, so this wait can be a large
// fraction of the run's total time.
const ACCOUNT_DELAY_RE =
  /^Waiting\s([\d.]+)\sseconds before starting the next account$/;
const STREAK_PROTECTION_RE =
  /^Snapshot complete\s\|\soffers=(\d+)\s\|\sreportable=(\d+)\s\|\sstreaks=(\d+)\s\|\sstreakProtectionEnabled=(true|false)\s\|\sstreakProtectionRemainingDays=(\d+|null)\s\|\sstreakCounter=(\d+|null)\s\|\slevel=([^|]+)\s\|\saccount=(\S+@\S+)$/;

// src/browser/auth/methods/PasswordlessLogin.ts - the only login flow that
// logs an actual value a human needs to act on before the bot can proceed
// (TOTP-with-secret is auto-filled and deliberately never logged; manual
// TOTP/email code entry waits on a raw stdin prompt with no code the bot
// itself knows, so there's nothing to surface for those).
const LOGIN_NUMBER_RE = /^Please approve login and select number:\s*(\d+)$/;
const LOGIN_NUMBER_RESOLVED_RE =
  /^(Approval detected|Login approved successfully|Login approval failed or timed out|Approval timeout after \d+ seconds!)$/;

// scripts/docker/run_daily.sh wraps the actual `npm start` in a flock-style
// lockfile and echoes its own lifecycle lines directly to stdout (not
// through Logger.ts), format: "[<bash date>] [run_daily.sh] <message>".
// `release_lock` runs via `trap ... EXIT INT TERM`, so "Lock released" fires
// even if npm start crashes outright - making this a much more reliable
// "is a run currently in progress" signal than the app's own RUN-START/
// RUN-END, which a hard crash could skip entirely.
const WRAPPER_LINE_RE = /^\[[^\]]*\]\s\[run_daily\.sh\]\s([\s\S]*)$/;
const WRAPPER_LOCK_ACQUIRED_RE =
  /^Lock acquired successfully\s\(PID:\s*(\d+)\)$/;
const WRAPPER_LOCK_RELEASED_RE = /^Lock released\s\(PID:\s*(\d+)\)$/;
// "Script finished" is printed unconditionally right before the wrapper's
// natural exit (which is what triggers the EXIT trap that logs "Lock
// released"). Treating both as valid completion signals means a run still
// gets marked done even if the trap-triggered line is ever delayed, missing
// from the captured log stream, or the release_lock() body no-ops because
// the lock's PID didn't match (see run_daily.sh's release_lock()).
const WRAPPER_SCRIPT_FINISHED_RE = /^Script finished$/;
const WRAPPER_SCRIPT_FAILED_RE = /^ERROR: Script failed!$/;

/**
 * Strips the leading Docker timestamp, returns { dockerTs, rest }.
 */
function splitDockerTimestamp(rawLine) {
  const m = DOCKER_TS_RE.exec(rawLine);
  if (!m) return { dockerTs: null, rest: rawLine };
  return { dockerTs: m[1], rest: m[2] };
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/**
 * Parses one raw docker-log line into a structured event, or null if it
 * doesn't match the app's log format at all (defensive - unrelated stdout).
 */
function parseLine(rawLine) {
  const { dockerTs, rest } = splitDockerTimestamp(rawLine);
  if (!dockerTs) return null;

  const clean = rest.replace(ANSI_RE, "");
  const m = APP_LINE_RE.exec(clean);
  if (!m) {
    return parseWrapperLine(dockerTs, clean);
  }

  const [, appTime, userName, level, platform, title, message] = m;

  const base = {
    ts: dockerTs,
    appTime,
    userName,
    level: level.toLowerCase(),
    platform,
    title,
    message,
    raw: clean,
  };

  switch (title) {
    case "ACCOUNT-START": {
      const am = ACCOUNT_START_RE.exec(message);
      if (am)
        return {
          ...base,
          kind: "account-start",
          email: am[1],
          geoLocale: am[2],
        };
      break;
    }
    case "ACCOUNT-END": {
      const am = ACCOUNT_END_RE.exec(message);
      if (am) {
        return {
          ...base,
          kind: "account-end",
          email: am[1],
          gained: Number(am[2]),
          oldPoints: Number(am[3]),
          newPoints: Number(am[4]),
          durationSec: Number(am[5]),
        };
      }
      break;
    }
    case "ACCOUNT-ERROR": {
      const am = ACCOUNT_ERR_RE.exec(message);
      if (am)
        return { ...base, kind: "account-error", email: am[1], error: am[2] };
      return { ...base, kind: "account-error", email: null, error: message };
    }
    case "RUN-START": {
      const am = RUN_START_RE.exec(message);
      if (am) {
        return {
          ...base,
          kind: "run-start",
          version: am[1],
          totalAccounts: Number(am[2]),
          clusters: Number(am[3]),
        };
      }
      break;
    }
    case "RUN-END": {
      const am = RUN_END_RE.exec(message);
      if (am) {
        return {
          ...base,
          kind: "run-end",
          accountsProcessed: Number(am[1]),
          totalGained: Number(am[2]),
          oldTotal: Number(am[3]),
          newTotal: Number(am[4]),
          runtimeMin: Number(am[5]),
        };
      }
      break;
    }
    case "ACCOUNT-DELAY": {
      const am = ACCOUNT_DELAY_RE.exec(message);
      if (am) return { ...base, kind: "account-delay", seconds: Number(am[1]) };
      break;
    }
    case "REACT-PARSE": {
      const protection = STREAK_PROTECTION_RE.exec(message);
      if (protection) {
        return {
          ...base,
          kind: "streak-protection",
          email: protection[8],
          enabled: protection[4] === "true",
          remainingDays:
            protection[5] === "null" ? null : Number(protection[5]),
          streakCounter:
            protection[6] === "null" ? null : Number(protection[6]),
        };
      }
      break;
    }
    case "LOGIN-PASSWORDLESS": {
      const numMatch = LOGIN_NUMBER_RE.exec(message);
      if (numMatch)
        return { ...base, kind: "login-number", number: numMatch[1] };
      if (LOGIN_NUMBER_RESOLVED_RE.test(message)) {
        return { ...base, kind: "login-number-resolved" };
      }
      break;
    }
    default:
      break;
  }

  // Fall through: no specific structured match, but still a valid app log
  // line. Kept as a generic event so warnings/errors show up in the feed.
  return { ...base, kind: "generic" };
}

/**
 * Parses a run_daily.sh wrapper line (not part of Logger.ts's format).
 * Returns null for lines that don't match at all, or a 'generic' event for
 * wrapper lines that aren't one of the specific lifecycle events we track.
 */
function parseWrapperLine(dockerTs, clean) {
  const wm = WRAPPER_LINE_RE.exec(clean);
  if (!wm) return null;
  const message = wm[1];

  const base = {
    ts: dockerTs,
    userName: "run_daily.sh",
    level: "info",
    platform: "MAIN",
    title: "WRAPPER",
    message,
    raw: clean,
  };

  const acquired = WRAPPER_LOCK_ACQUIRED_RE.exec(message);
  if (acquired)
    return { ...base, kind: "wrapper-lock-acquired", pid: acquired[1] };

  const released = WRAPPER_LOCK_RELEASED_RE.exec(message);
  if (released)
    return { ...base, kind: "wrapper-lock-released", pid: released[1] };

  if (WRAPPER_SCRIPT_FINISHED_RE.test(message)) {
    return { ...base, kind: "wrapper-lock-released", pid: null };
  }

  if (WRAPPER_SCRIPT_FAILED_RE.test(message)) {
    return { ...base, level: "error", kind: "generic" };
  }

  // Other wrapper lines (self-heal messages, "Starting script...", etc.)
  // aren't needed for run-tracking; ignore rather than adding feed noise.
  return null;
}

module.exports = { parseLine };
