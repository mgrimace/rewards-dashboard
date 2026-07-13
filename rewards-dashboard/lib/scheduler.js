"use strict";

const { isValidCron, nextRun } = require("./cron");

const MISFIRE_POLICIES = new Set(["skip", "run-on-startup", "grace-period"]);
const DEFAULT = {
  enabled: false,
  cron: "0 9 * * *",
  skipIfRunning: true,
  misfirePolicy: "skip",
  misfireGraceMinutes: 60,
  excludedAccountIndexes: [],
};

class Scheduler {
  /**
   * @param client   ControlApiClient - used only to POST /start
   * @param store    Store            - persists the schedule across restarts
   * @param isBusy   () => boolean    - is a run already in progress?
   * @param onChange ()               - called when state changes, so the UI repaints
   * @param log      (level, msg)
   */
  constructor({
    client,
    store,
    isBusy = () => false,
    onChange = () => { },
    log = () => { },
  }) {
    this.client = client;
    this.store = store;
    this.isBusy = isBusy;
    this.onChange = onChange;
    this.log = log;

    this.config = { ...DEFAULT };
    this.timer = null;
    this.nextRunAt = null;
    this.lastTriggeredAt = null;
    this.lastResult = null;
    this.lastHandledScheduledAt = null;
    this.firing = false;
  }

  init() {
    const saved = this.store.getSchedule();
    const missedScheduledAt = saved?.nextRunAt || null;
    if (saved && typeof saved === "object") {
      this.config = {
        enabled: Boolean(saved.enabled),
        cron: typeof saved.cron === "string" ? saved.cron : DEFAULT.cron,
        skipIfRunning: saved.skipIfRunning !== false,
        misfirePolicy: MISFIRE_POLICIES.has(saved.misfirePolicy)
          ? saved.misfirePolicy
          : DEFAULT.misfirePolicy,
        misfireGraceMinutes: Number.isFinite(Number(saved.misfireGraceMinutes))
          ? Math.max(
            1,
            Math.min(1440, Math.round(Number(saved.misfireGraceMinutes))),
          )
          : DEFAULT.misfireGraceMinutes,
        excludedAccountIndexes: this._normalizeExcluded(
          saved.excludedAccountIndexes || [],
        ),
      };
      this.lastTriggeredAt = saved.lastTriggeredAt || null;
      this.lastResult = saved.lastResult || null;
      this.lastHandledScheduledAt = saved.lastHandledScheduledAt || null;
    }
    this._arm();
    this._recoverMissedRun(missedScheduledAt);
    this.log(
      "info",
      this.config.enabled
        ? `Schedule enabled (${this.config.cron}) — next run ${this.nextRunAt ? this.nextRunAt.toISOString() : "never"}.`
        : "Schedule disabled.",
    );
    return this.get();
  }

  get() {
    const valid = isValidCron(this.config.cron);
    return {
      enabled: this.config.enabled,
      cron: this.config.cron,
      skipIfRunning: this.config.skipIfRunning,
      misfirePolicy: this.config.misfirePolicy,
      misfireGraceMinutes: this.config.misfireGraceMinutes,
      excludedAccountIndexes: [...this.config.excludedAccountIndexes],
      valid,
      error: valid ? null : "Invalid cron expression (needs 5 fields).",
      nextRunAt: this.nextRunAt ? this.nextRunAt.toISOString() : null,
      lastTriggeredAt: this.lastTriggeredAt,
      lastResult: this.lastResult,
      timezoneOffsetMinutes: -new Date().getTimezoneOffset(),
    };
  }

  set(patch = {}) {
    const next = { ...this.config };

    if ("cron" in patch) {
      if (typeof patch.cron !== "string" || !isValidCron(patch.cron)) {
        const err = new Error(
          'Invalid cron expression (5 fields, e.g. "0 9 * * *").',
        );
        err.code = "BAD_REQUEST";
        throw err;
      }
      next.cron = patch.cron.trim();
    }
    if ("enabled" in patch) next.enabled = Boolean(patch.enabled);
    if ("skipIfRunning" in patch)
      next.skipIfRunning = Boolean(patch.skipIfRunning);
    if ("misfirePolicy" in patch) {
      if (!MISFIRE_POLICIES.has(patch.misfirePolicy)) {
        const err = new Error("Invalid missed-run policy.");
        err.code = "BAD_REQUEST";
        throw err;
      }
      next.misfirePolicy = patch.misfirePolicy;
    }
    if ("misfireGraceMinutes" in patch) {
      const minutes = Number(patch.misfireGraceMinutes);
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
        const err = new Error(
          "Missed-run grace must be between 1 and 1440 minutes.",
        );
        err.code = "BAD_REQUEST";
        throw err;
      }
      next.misfireGraceMinutes = Math.round(minutes);
    }
    if ("excludedAccountIndexes" in patch) {
      next.excludedAccountIndexes = this._normalizeExcluded(
        patch.excludedAccountIndexes,
      );
    }

    this.config = next;
    this._persist();
    this._arm();
    this.log(
      "info",
      next.enabled ? `Schedule updated: ${next.cron}` : "Schedule disabled.",
    );
    this.onChange();
    return this.get();
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  _persist() {
    this.store.setSchedule({
      ...this.config,
      lastTriggeredAt: this.lastTriggeredAt,
      lastResult: this.lastResult,
      lastHandledScheduledAt: this.lastHandledScheduledAt,
      nextRunAt: this.nextRunAt ? this.nextRunAt.toISOString() : null,
    });
  }

  _arm() {
    clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = null;

    if (!this.config.enabled) {
      this._persist();
      return;
    }

    const next = nextRun(this.config.cron, new Date());
    if (!next) return;
    this.nextRunAt = next;

    // setTimeout caps out around 24.8 days; for anything further away, wake
    // up early and re-arm rather than silently never firing.
    const MAX_DELAY = 2 ** 31 - 1;
    const delay = Math.max(0, next.getTime() - Date.now());
    if (delay > MAX_DELAY) {
      this.timer = setTimeout(() => this._arm(), MAX_DELAY);
    } else {
      const scheduledAt = next.toISOString();
      this.timer = setTimeout(() => this._fire({ scheduledAt }), delay);
    }
    if (this.timer.unref) this.timer.unref();
    this._persist();
  }

  async _fire({
    scheduledAt = new Date().toISOString(),
    recovered = false,
  } = {}) {
    if (this.firing) return;
    this.firing = true;
    this.lastTriggeredAt = new Date().toISOString();
    this.lastHandledScheduledAt = scheduledAt;

    try {
      if (this.config.skipIfRunning && this.isBusy()) {
        this.lastResult = "skipped (a run was already in progress)";
        this.log(
          "warn",
          "Scheduled run skipped — a run is already in progress.",
        );
      } else {
        try {
          const body = this.config.excludedAccountIndexes.length
            ? { excludedAccountIndexes: this.config.excludedAccountIndexes }
            : {};
          await this.client.post("/start", body);
          this.lastResult = recovered
            ? "started after dashboard restart"
            : "started";
          this.log(
            "info",
            recovered
              ? "Missed scheduled run started after dashboard restart."
              : "Scheduled run started.",
          );
        } catch (e) {
          this.lastResult =
            e.statusCode === 409
              ? "skipped (the API already had a run active)"
              : `failed: ${e.message}`;
          this.log("warn", `Scheduled run could not start: ${e.message}`);
        }
      }
    } finally {
      this._persist();
      this._arm(); // queue the following occurrence
      this.onChange();
      this.firing = false;
    }
  }

  _normalizeExcluded(value) {
    if (!Array.isArray(value)) {
      const err = new Error(
        "Excluded accounts must be an array of account indexes.",
      );
      err.code = "BAD_REQUEST";
      throw err;
    }
    const indexes = [...new Set(value.map(Number))];
    if (indexes.some((index) => !Number.isSafeInteger(index) || index < 1)) {
      const err = new Error(
        "Excluded accounts must contain only positive account indexes.",
      );
      err.code = "BAD_REQUEST";
      throw err;
    }
    return indexes.sort((a, b) => a - b);
  }

  _recoverMissedRun(scheduledAt) {
    if (
      !this.config.enabled ||
      !scheduledAt ||
      scheduledAt === this.lastHandledScheduledAt
    )
      return;
    const due = new Date(scheduledAt);
    if (Number.isNaN(due.getTime()) || due.getTime() > Date.now()) return;

    const ageMinutes = Math.max(0, (Date.now() - due.getTime()) / 60000);
    const shouldRun =
      this.config.misfirePolicy === "run-on-startup" ||
      (this.config.misfirePolicy === "grace-period" &&
        ageMinutes <= this.config.misfireGraceMinutes);

    if (shouldRun) {
      setTimeout(() => void this._fire({ scheduledAt, recovered: true }), 0);
      return;
    }

    this.lastHandledScheduledAt = scheduledAt;
    this.lastResult =
      this.config.misfirePolicy === "grace-period"
        ? `missed run skipped (outside ${this.config.misfireGraceMinutes}-minute grace period)`
        : "missed run skipped after dashboard restart";
    this.log(
      "warn",
      `Scheduled run at ${scheduledAt} was missed while the dashboard was offline.`,
    );
    this._persist();
    this.onChange();
  }
}

module.exports = { Scheduler };
