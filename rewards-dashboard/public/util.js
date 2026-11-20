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
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone || undefined,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).formatToParts(d);
  const get = (type) => parts.find((part) => part.type === type)?.value || "";
  const date = `${get("month")} ${get("day")}, ${get("year")}`;
  const clock = `${get("hour")}:${get("minute")}:${get("second")} ${get("dayPeriod").toLowerCase()}`;
  return `${date} ${clock}`;
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

// Like fmtRelative, but keeps the smaller unit so long-running items read
// "2h 15m ago" instead of rounding to "2h ago". Floors (never rounds up) so
// 1h 40m can't show as "2h". Used only where the extra precision matters.
export function fmtRelativeDetailed(iso) {
  if (!iso) return DASH;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return DASH;
  const mins = Math.max(0, Math.floor((Date.now() - d.getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins ? `${hours}h ${remMins}m ago` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `${days}d ${remHours}h ago` : `${days}d ago`;
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

// Whole seconds left in the wrapper's pre-run sleep, or null when not
// sleeping (no sleep reported, already elapsed, or the bot is running).
export function sleepRemainingSec(status) {
  const sleep = status?.pendingSleep;
  if (!sleep || status?.botRunning) return null;
  const remaining = Math.ceil(
    sleep.seconds - (Date.now() - Date.parse(sleep.sinceTs)) / 1000,
  );
  return Number.isFinite(remaining) && remaining > 0 ? remaining : null;
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

// Buckets history rows by day, using the TRUE point movement detected
// between consecutive check-ins (points[i] - points[i-1]) rather than
// summing each row's own self-reported `gained` value. A run only reports
// what IT did (e.g. searches/activities), but the account's visible balance
// can also move between runs from other sources (delayed credit posting,
// Xbox/GamePass rewards, manual redemption reversals, etc.) - summing
// self-reported gained silently drops that movement from "today" and the
// heatmap. A detected change is attributed to the day it was OBSERVED
// (the later row's day), not any day it may have actually been earned on,
// since that's the only thing the dashboard can ever know for certain.
export function bucketByDay(history) {
  const days = new Map();
  let prevPoints = null;
  for (const h of history) {
    const trueGained = prevPoints == null ? (h.gained ?? 0) : h.points - prevPoints;
    prevPoints = h.points;

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
    bucket.gained += trueGained;
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

// ticker

// Renders `text` into `container` as plain content by default. On mobile
// (or always, if mobileOnly is false), if the content actually overflows
// the element's width, it's promoted to a scrolling ticker instead of
// being clipped or wrapped - otherwise it stays a normal static line.
// Shared by any component that needs this (run-progress meta, the
// control-strip detail line, etc.) rather than each one reimplementing it.
//
// Callers may invoke this very frequently (once per SSE state push, easily
// several times a second during an active run), so this updates text in
// place and only touches the ticker/animation state when the overflow
// status actually changes - rebuilding the DOM (and restarting the CSS
// animation) on every call would mean a multi-second scroll animation
// never gets the uninterrupted time it needs to complete a single loop.
// Activating vs deactivating also uses different thresholds (hysteresis):
// a line sitting right at the fits/doesn't-fit boundary would otherwise
// flip in and out of ticker mode on consecutive renders, resetting the
// animation each time and looking like it never moves at all.
//
// The track is duplicated (each copy carrying a trailing `separator` once
// ticking, so the loop doesn't run text directly into itself) and the pair
// (the wrap) animated from 0 to -50% of its own combined width - i.e.
// exactly one copy's width - so the loop hands off seamlessly: no blank
// lead-in, no snap-back partway through.
export function renderTicker(
  container,
  text,
  { mobileOnly = true, separator = "\u00a0\u00a0\u2022\u00a0\u00a0" } = {},
) {
  text = text ?? "";

  let wrap = container.querySelector(":scope > .ticker-track-wrap");
  let track;
  let clone;

  if (wrap) {
    track = wrap.querySelector(".ticker-track:not([aria-hidden])");
    clone = wrap.querySelector(".ticker-track[aria-hidden]");
  } else {
    container.classList.add("ticker");
    container.innerHTML = "";
    wrap = el("span", { class: "ticker-track-wrap" });
    track = el("span", { class: "ticker-track" });
    wrap.appendChild(track);
    container.appendChild(wrap);
  }

  const wasTicker = container.classList.contains("is-ticker");
  const displayText = wasTicker ? text + separator : text;
  if (track.textContent !== displayText) {
    track.textContent = displayText;
    if (clone) clone.textContent = displayText;
  }

  const isMobile = !mobileOnly || window.matchMedia("(max-width: 768px)").matches;

  if (!text || !isMobile) {
    if (wasTicker) {
      container.classList.remove("is-ticker");
      container.style.removeProperty("--ticker-duration");
      clone?.remove();
      track.textContent = text;
    }
    return;
  }

  // Needs the mobile CSS's overflow:hidden/white-space:nowrap already in
  // effect on `container` to measure correctly.
  const overflowing = track.scrollWidth > container.clientWidth + 1;
  const clearlyFits = track.scrollWidth <= container.clientWidth - 6;

  if (overflowing && !wasTicker) {
    container.classList.add("is-ticker");
    track.textContent = text + separator;
    clone = track.cloneNode(true);
    clone.setAttribute("aria-hidden", "true");
    wrap.appendChild(clone);
    // ~40px/sec, clamped so very short overflow doesn't whip by and very
    // long lines don't take forever to loop.
    const seconds = Math.min(30, Math.max(8, Math.round(track.scrollWidth / 40)));
    container.style.setProperty("--ticker-duration", `${seconds}s`);
  } else if (clearlyFits && wasTicker) {
    container.classList.remove("is-ticker");
    container.style.removeProperty("--ticker-duration");
    clone?.remove();
    track.textContent = text;
  }
  // Otherwise the overflow status is unchanged - leave the animation
  // running uninterrupted even though the text may have just been updated.
}

// two-step confirm

// A confirm button renders where the button that armed it just was, so the
// second click of a double-click would land on it. Ignore confirm clicks for a
// moment after arming; a deliberate second click comes well after this.
const CONFIRM_GUARD_MS = 600;

export function confirmReady(armedAt) {
  return armedAt == null || performance.now() - armedAt >= CONFIRM_GUARD_MS;
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
  full: ["pill-success", "Complete"],
  success: ["pill-success", "Success"],
  partial: ["pill-warn", "Partial"],
  skipped: ["pill-idle", "Skipped"],
  done: ["pill-success", "Done"],
  error: ["pill-error", "Error"],
  crashed: ["pill-error", "Crashed"],
  interrupted: ["pill-warn", "Interrupted"],
  stopped: ["pill-warn", "Stopped"],
  stalled: ["pill-warn", "Stalled"],
  running: ["pill-running", "Running"],
  starting: ["pill-running", "Starting"],
  stopping: ["pill-warn", "Stopping"],
  pending: ["pill-pending", "Pending"],
  sleeping: ["pill-pending", "Sleeping"],
  idle: ["pill-idle", "Idle"],
};

const STATUS_ALIASES = {
  full: "success",
  done: "success",
  completed: "success",
  partial: "success",
  crashed: "error",
  failed: "error",
  cancelled: "stopped",
};

export function runAccountMap(status) {
  return new Map(
    (status?.bot?.run?.accounts || [])
      .filter((account) => account?.email)
      .map((account) => [account.email.trim().toLowerCase(), account]),
  );
}

export function accountDisplayStatus(account, runAccount, runActive = false) {
  const watchdogStall =
    account.status === "error" &&
    account.lastError === "Run stalled before this account finished";
  if (watchdogStall && runActive && runAccount && runAccount.success == null)
    return "running";
  return account.status;
}

export function pillParts(status) {
  const normalized = STATUS_ALIASES[status] || status;
  const [cls, label] = PILLS[normalized] || PILLS.idle;
  return { cls, label };
}

export function statusPill(status, title = "") {
  const { cls, label } = pillParts(status);
  const attr = title ? ` title="${escapeAttr(title)}"` : "";
  return `<span class="pill ${cls}"${attr}>${label}</span>`;
}
