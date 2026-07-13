"use strict";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const FIELDS = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 7 }, // day of week (7 == Sunday)
];

function validateField(expr, { min, max }) {
  if (expr === "*") return true;
  for (const part of expr.split(",")) {
    const stepSplit = part.split("/");
    if (stepSplit.length > 2) return false;

    const step = stepSplit.length === 2 ? Number(stepSplit[1]) : 1;
    if (!Number.isInteger(step) || step < 1) return false;

    const range = stepSplit[0];
    let lo;
    let hi;
    if (range === "*") {
      lo = min;
      hi = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(range);
      hi = Number(range);
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) return false;
    if (lo < min || hi > max || lo > hi) return false;
  }
  return true;
}

function isValidCron(expr) {
  if (typeof expr !== "string") return false;
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((part, i) => validateField(part, FIELDS[i]));
}

function expandField(expr, { min, max }, { sundayIsSeven = false } = {}) {
  if (expr === "*") return null;
  const values = new Set();
  for (const part of expr.split(",")) {
    const [range, stepRaw] = part.split("/");
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    let lo;
    let hi;
    if (range === "*") {
      lo = min;
      hi = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(range);
      hi = Number(range);
    }
    for (let v = lo; v <= hi; v += step) {
      values.add(sundayIsSeven && v === 7 ? 0 : v);
    }
  }
  return values;
}

function compile(expr) {
  const p = expr.trim().split(/\s+/);
  return {
    minute: expandField(p[0], FIELDS[0]),
    hour: expandField(p[1], FIELDS[1]),
    dom: expandField(p[2], FIELDS[2]),
    month: expandField(p[3], FIELDS[3]),
    dow: expandField(p[4], FIELDS[4], { sundayIsSeven: true }),
  };
}

function matches(date, c) {
  const inSet = (set, v) => set === null || set.has(v);
  if (!inSet(c.minute, date.getMinutes())) return false;
  if (!inSet(c.hour, date.getHours())) return false;
  if (!inSet(c.month, date.getMonth() + 1)) return false;

  const domRestricted = c.dom !== null;
  const dowRestricted = c.dow !== null;
  const domOk = inSet(c.dom, date.getDate());
  const dowOk = inSet(c.dow, date.getDay());

  if (domRestricted && dowRestricted) return domOk || dowOk;
  return domOk && dowOk;
}

function nextRun(expr, from = new Date()) {
  if (!isValidCron(expr)) return null;
  const c = compile(expr);

  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);

  const limit = 400 * 24 * 60;
  for (let i = 0; i < limit; i++) {
    if (matches(d, c)) return new Date(d.getTime());
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

function to12h(hour, minute) {
  const h = ((hour % 12) + 12) % 12 || 12;
  const period = hour < 12 ? "AM" : "PM";
  const mm = String(minute).padStart(2, "0");
  return `${h}:${mm} ${period}`;
}

function parseField(field) {
  if (field === "*") return { any: true };
  const stepMatch = /^\*\/(\d+)$/.exec(field);
  if (stepMatch) return { every: Number(stepMatch[1]) };
  const values = field
    .split(",")
    .flatMap((part) => {
      const rangeMatch = /^(\d+)-(\d+)$/.exec(part);
      if (rangeMatch) {
        const [, a, b] = rangeMatch;
        const out = [];
        for (let i = Number(a); i <= Number(b); i++) out.push(i);
        return out;
      }
      return [Number(part)];
    })
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b);
  return { values };
}

function describeWeekdays(field) {
  if (field.any) return null;
  if (field.every) return `every ${field.every} day(s) of the week`;
  const names = field.values.map((d) => DAY_NAMES[d % 7]);
  const isWeekdays =
    field.values.length === 5 &&
    [1, 2, 3, 4, 5].every((d) => field.values.includes(d));
  const isWeekend =
    field.values.length === 2 && [0, 6].every((d) => field.values.includes(d));
  if (isWeekdays) return "weekdays";
  if (isWeekend) return "weekends";
  return names.join(", ");
}

function describeCron(expr) {
  if (!expr || typeof expr !== "string") return null;
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;

  const [minuteRaw, hourRaw, domRaw, monthRaw, dowRaw] = parts;
  const minute = parseField(minuteRaw);
  const hour = parseField(hourRaw);
  const dow = parseField(dowRaw);

  const dayRestricted = domRaw !== "*" || monthRaw !== "*";
  if (dayRestricted) return expr; // month/day-of-month schedules: show raw

  // Every N minutes, e.g. "*/15 * * * *"
  if (minute.every && hour.any) {
    return `Every ${minute.every} minute${minute.every === 1 ? "" : "s"}`;
  }

  // Every N hours, e.g. "0 */6 * * *"
  if (hour.every && minute.values?.length === 1 && minute.values[0] === 0) {
    return `Every ${hour.every} hour${hour.every === 1 ? "" : "s"}`;
  }

  // Fixed minute, one or more fixed hours — the common case.
  if (minute.values?.length === 1 && hour.values && !hour.every) {
    const times = hour.values.map((h) => to12h(h, minute.values[0]));
    const dayPart = describeWeekdays(dow);
    const timesText = times.length === 1 ? times[0] : joinWithAnd(times);
    return dayPart
      ? `${capitalize(dayPart)} at ${timesText}`
      : `Daily at ${timesText}`;
  }

  return expr; // anything else: don't guess, show the raw expression
}

function joinWithAnd(items) {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

module.exports = { describeCron, isValidCron, nextRun };
