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
  interrupted: ["pill-warn", "Interrupted"],
  stopped: ["pill-warn", "Stopped"],
  running: ["pill-running", "Running"],
  starting: ["pill-running", "Starting"],
  stopping: ["pill-warn", "Stopping"],
  pending: ["pill-pending", "Pending"],
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
