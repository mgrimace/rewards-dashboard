export function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, "&quot;");
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) =>
  Array.from(root.querySelectorAll(sel));

export function el(tag, attrs = {}, html = "") {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  if (html) node.innerHTML = html;
  return node;
}

// fomrat

const DASH = "\u2013";

export function fmtNumber(n) {
  if (n == null || Number.isNaN(n)) return DASH;
  return Number(n).toLocaleString();
}

export function fmtSigned(n) {
  if (n == null || Number.isNaN(n)) return DASH;
  return (n > 0 ? "+" : "") + Number(n).toLocaleString();
}

export function fmtDateTime(iso) {
  if (!iso) return DASH;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return DASH;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function fmtTime(iso) {
  if (!iso) return DASH;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return DASH;
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function fmtRelative(iso) {
  if (!iso) return DASH;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return DASH;
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function fmtDuration(sec) {
  if (sec == null || Number.isNaN(sec)) return DASH;
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function fmtUptime(sec) {
  if (sec == null) return DASH;
  if (sec < 60) return `${Math.round(sec)}s`;
  return fmtDuration(sec);
}

// day bucket

let timeZone = null;
export function setTimeZone(tz) {
  timeZone = tz || null;
}

export function tzDateParts(instant) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(new Date(instant));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

export function tzDayKey(instant) {
  const { year, month, day } = tzDateParts(instant);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function isoWeekStartKey(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  const dow = (date.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  date.setUTCDate(date.getUTCDate() - dow);
  return date.toISOString().slice(0, 10);
}

export function localDateLabel(key, options) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, options);
}

export function bucketByDay(history) {
  const days = new Map();
  for (const h of history) {
    const { year, month, day } = tzDateParts(h.ts);
    const dayKey = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (!days.has(dayKey)) {
      days.set(dayKey, {
        dayKey,
        weekKey: isoWeekStartKey(year, month, day),
        gained: 0,
        lastTotal: h.points,
      });
    }
    const bucket = days.get(dayKey);
    bucket.gained += h.gained ?? 0;
    bucket.lastTotal = h.points;
  }
  return [...days.values()].sort((a, b) => a.dayKey.localeCompare(b.dayKey));
}

// toooooooooooooooast

let toastHost = null;

export function toast(message, kind = "info", ms = 4000) {
  if (!toastHost) {
    toastHost = el("div", {
      class: "toast-host",
      role: "status",
      "aria-live": "polite",
    });
    document.body.appendChild(toastHost);
  }
  const node = el(
    "div",
    { class: `toast toast--${kind}` },
    escapeHtml(message),
  );
  toastHost.appendChild(node);
  setTimeout(() => {
    node.classList.add("toast--out");
    setTimeout(() => node.remove(), 200);
  }, ms);
}

// other

export function debounce(fn, ms = 250) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

const PILLS = {
  success: ["pill-success", "Success"],
  done: ["pill-success", "Done"],
  error: ["pill-error", "Error"],
  crashed: ["pill-error", "Crashed"],
  stopped: ["pill-warn", "Stopped"],
  running: ["pill-running", "Running"],
  starting: ["pill-running", "Starting"],
  stopping: ["pill-warn", "Stopping"],
  idle: ["pill-idle", "Idle"],
};

export function pillParts(status) {
  const [cls, label] = PILLS[status] || PILLS.idle;
  return { cls, label };
}

export function statusPill(status) {
  const { cls, label } = pillParts(status);
  return `<span class="pill ${cls}">${label}</span>`;
}
