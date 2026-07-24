import { escapeAttr, escapeHtml, fmtNumber, localDateLabel } from "./util.js";

const PAD = { left: 46, right: 14, top: 14, bottom: 26 };

function niceMax(value) {
  if (value <= 0) return 10;
  const mag = Math.pow(10, Math.floor(Math.log10(value)));
  const norm = value / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * mag;
}

function ticks(max, count = 4) {
  const out = [];
  for (let i = 0; i <= count; i++) out.push(Math.round((max / count) * i));
  return [...new Set(out)];
}

function frame(width, height, max, { zeroFloor = 0 } = {}) {
  const innerW = width - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const yOf = (v) =>
    PAD.top + innerH - ((v - zeroFloor) / (max - zeroFloor || 1)) * innerH;

  let grid = "";
  for (const t of ticks(max)) {
    const y = yOf(t);
    grid += `<line class="chart-grid" x1="${PAD.left}" y1="${y}" x2="${width - PAD.right}" y2="${y}" />`;
    grid += `<text class="chart-axis" x="${PAD.left - 8}" y="${y + 4}" text-anchor="end">${escapeHtml(fmtNumber(t))}</text>`;
  }
  return { innerW, innerH, yOf, grid };
}

function emptyState(container, message) {
  container.innerHTML = `<p class="empty-note chart-empty">${escapeHtml(message)}</p>`;
}

/**
 * Line chart of absolute values over time (an account's point total).
 * @param points [{ key: 'YYYY-MM-DD', value: number, label?: string }]
 */
export function lineChart(
  container,
  points,
  { emptyMessage = "No data yet." } = {},
) {
  if (!points || points.length === 0)
    return emptyState(container, emptyMessage);

  const width = Math.max(320, container.clientWidth || 640);
  const height = Math.max(200, Math.min(320, Math.round(width * 0.34)));

  const values = points.map((p) => p.value);
  const rawMax = Math.max(...values);
  const rawMin = Math.min(...values);
  const span = rawMax - rawMin;
  const floor =
    span === 0 ? Math.max(0, rawMax - 10) : Math.max(0, rawMin - span * 0.15);
  const max = span === 0 ? rawMax + 10 : rawMax + span * 0.15;

  const { innerW, yOf, grid } = frame(width, height, max, { zeroFloor: floor });
  const xOf = (i) =>
    PAD.left +
    (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);

  const coords = points.map((p, i) => [xOf(i), yOf(p.value)]);
  const line = coords
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  const area = `${line} L${coords[coords.length - 1][0].toFixed(1)},${(height - PAD.bottom).toFixed(1)} L${coords[0][0].toFixed(1)},${(height - PAD.bottom).toFixed(1)} Z`;

  const dots = points
    .map((p, i) => {
      const [x, y] = coords[i];
      const title = `${p.label || p.key}: ${fmtNumber(p.value)} points`;
      return `<circle class="chart-dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3"><title>${escapeAttr(title)}</title></circle>`;
    })
    .join("");

  const every = Math.max(1, Math.ceil(points.length / 6));
  const labels = points
    .map((p, i) => {
      if (i % every !== 0 && i !== points.length - 1) return "";
      const x = Math.min(width - PAD.right, Math.max(PAD.left, xOf(i)));
      const text =
        p.key.length === 10
          ? localDateLabel(p.key, { month: "short", day: "numeric" })
          : p.key;
      return `<text class="chart-axis" x="${x.toFixed(1)}" y="${height - 8}" text-anchor="middle">${escapeHtml(text)}</text>`;
    })
    .join("");

  container.innerHTML = `
        <svg class="chart" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img"
             aria-label="Point total over time">
            ${grid}
            <path class="chart-area" d="${area}" />
            <path class="chart-line" d="${line}" />
            ${dots}
            ${labels}
        </svg>`;
}

/**
 * Bar chart of per-day totals (points collected each day).
 * @param bars [{ key: 'YYYY-MM-DD', value: number, sub?: string }]
 */
export function barChart(
  container,
  bars,
  { emptyMessage = "No runs recorded yet." } = {},
) {
  if (!bars || bars.length === 0) return emptyState(container, emptyMessage);

  const width = Math.max(320, container.clientWidth || 640);
  const height = Math.max(200, Math.min(300, Math.round(width * 0.32)));

  const max = niceMax(Math.max(1, ...bars.map((b) => b.value)));
  const { innerW, yOf, grid } = frame(width, height, max);

  const slot = innerW / bars.length;
  const barW = Math.max(3, Math.min(28, slot * 0.68));
  const baseY = height - PAD.bottom;

  const rects = bars
    .map((b, i) => {
      const cx = PAD.left + slot * i + slot / 2;
      const y = yOf(b.value);
      const h = Math.max(b.value > 0 ? 2 : 0, baseY - y);
      const title = `${localDateLabel(b.key, { weekday: "short", month: "short", day: "numeric" })}: +${fmtNumber(b.value)} points${b.sub ? ` (${b.sub})` : ""}`;
      return `<rect class="chart-bar" x="${(cx - barW / 2).toFixed(1)}" y="${(baseY - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="2"><title>${escapeAttr(title)}</title></rect>`;
    })
    .join("");

  const every = Math.max(1, Math.ceil(bars.length / 7));
  const labels = bars
    .map((b, i) => {
      if (i % every !== 0 && i !== bars.length - 1) return "";
      const cx = PAD.left + slot * i + slot / 2;
      return `<text class="chart-axis" x="${cx.toFixed(1)}" y="${height - 8}" text-anchor="middle">${escapeHtml(localDateLabel(b.key, { month: "short", day: "numeric" }))}</text>`;
    })
    .join("");

  container.innerHTML = `
        <svg class="chart" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img"
             aria-label="Points collected per day">
            ${grid}
            <line class="chart-grid chart-baseline" x1="${PAD.left}" y1="${baseY}" x2="${width - PAD.right}" y2="${baseY}" />
            ${rects}
            ${labels}
        </svg>`;
}

// Chart Constants
const ACCUM_WINDOW_DAYS = 84; // ~12 weeks
const ACCUM_MAX_HEIGHT_PCT = 100;
const ACCUM_MIN_HEIGHT_PCT = 20;
const HEATMAP_MIN_WEEKS = 53; // a full year of columns, minimum
const HEATMAP_FUTURE_BUFFER_WEEKS = 8; // ~2 months of "coming up" room, always
// Colour intensity is scaled relative to this account's own typical
// (average) day rather than a fixed point threshold or its single best day
// - self-calibrates regardless of how many points a given account usually
// earns, and one big catch-up day doesn't wash every ordinary day out into
// looking inactive. Ratios are the upper edge of levels 1/2/3 (anything at
// or above the last one is level 4).
const HEATMAP_LEVEL_RATIOS = [0.6, 1.1, 1.75];

function heatmapLevel(gained, avg) {
  if (gained <= 0) return 0;
  const ratio = gained / avg;
  if (ratio < HEATMAP_LEVEL_RATIOS[0]) return 1;
  if (ratio < HEATMAP_LEVEL_RATIOS[1]) return 2;
  if (ratio < HEATMAP_LEVEL_RATIOS[2]) return 3;
  return 4;
}

export function buildHeatmapHtml(days) {
  if (!days.length) return "";

  const byDay = new Map(days.map((d) => [d.dayKey, d]));
  days = [...days].sort((a, b) => a.dayKey.localeCompare(b.dayKey));

  const activeGains = days.map((d) => d.gained).filter((g) => g > 0);
  const avgGained = activeGains.length
    ? activeGains.reduce((sum, g) => sum + g, 0) / activeGains.length
    : 1;

  const today = new Date();
  
  // Safely format today as YYYY-MM-DD in local time
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  // 1. Anchor to the beginning (Left Justified)
  // We append T12:00:00 to avoid UTC timezone drift making the day shift to 'yesterday'
  let start = new Date(days[0].dayKey + "T12:00:00");
  start.setHours(12, 0, 0, 0);

  // Never let the window stretch back further than needed to still leave
  // HEATMAP_FUTURE_BUFFER_WEEKS of "coming up" room ahead of today - without
  // this, a long-tenured account's window grows a week wider forever, and
  // once it passes a year old it stops leaving any future runway at all
  // (right back to the original "today pinned at the far edge" problem,
  // just deferred).
  const earliestAllowed = new Date(today);
  earliestAllowed.setDate(
    earliestAllowed.getDate() -
    (HEATMAP_MIN_WEEKS - HEATMAP_FUTURE_BUFFER_WEEKS) * 7,
  );
  if (start < earliestAllowed) start = earliestAllowed;

  // Align to Monday so weeks stay vertical
  while (start.getDay() !== 1) {
    start.setDate(start.getDate() - 1);
  }

  // The clamp above guarantees the window is always bounded, so the grid is
  // always exactly HEATMAP_MIN_WEEKS wide - constant size regardless of how
  // long the account has been running.
  const totalWeeks = HEATMAP_MIN_WEEKS;

  // Collect Month Labels accurately calculating width mapping to `.heatmap-cell` (8px + 2px gap)
  let monthWidths = [];
  let currentMonthSpan = 0;
  let lastMonth = -1;
  let currentMonthName = "";
  
  let gridHtml = '<div class="heatmap">';

  for (let week = 0; week < totalWeeks; week++) {
    gridHtml += '<div class="heatmap-week">';
    
    // Evaluate month mappings natively to flex rows above the cell block wrapper
    const weekStartDay = new Date(start);
    weekStartDay.setDate(start.getDate() + week * 7);
    const weekMonth = weekStartDay.getMonth();
    const weekKey = `${weekStartDay.getFullYear()}-${String(weekMonth + 1).padStart(2, '0')}-01`;

    if (lastMonth === -1) {
        lastMonth = weekMonth;
        currentMonthName = localDateLabel(weekKey, { month: "short" });
        currentMonthSpan = 1;
    } else if (weekMonth !== lastMonth) {
        // Drop the first month label for tidiness if it started mid-month (spans 2 weeks or less)
        if (monthWidths.length === 0 && currentMonthSpan <= 2) {
            currentMonthName = "";
        }
        monthWidths.push({ name: currentMonthName, span: currentMonthSpan });
        
        currentMonthSpan = 1;
        lastMonth = weekMonth;
        currentMonthName = localDateLabel(weekKey, { month: "short" });
    } else {
        currentMonthSpan++;
    }

    for (let day = 0; day < 7; day++) {
      const d = new Date(start);
      d.setDate(start.getDate() + week * 7 + day);

      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const entry = byDay.get(key);
      const level = entry ? heatmapLevel(entry.gained, avgGained) : 0;

      // Any day after today is considered a future/unfilled square
      const future = key > todayStr;

      const cls = [
        "heatmap-cell",
        `heatmap-level-${level}`,
        future ? "heatmap-future" : "",
        key === todayStr ? "heatmap-today" : ""
      ].filter(Boolean).join(" ");

      const title = entry
        ? `${localDateLabel(key, { weekday: "long", month: "short", day: "numeric" })}\n+${entry.gained.toLocaleString()} pts\nTotal ${entry.lastTotal.toLocaleString()}`
        : localDateLabel(key, { weekday: "long", month: "short", day: "numeric" });

      gridHtml += `<div class="${cls}" title="${escapeAttr(title)}"></div>`;
    }

    gridHtml += "</div>";
  }

  gridHtml += "</div>";
  
  if (currentMonthSpan > 0) {
      monthWidths.push({ name: currentMonthName, span: currentMonthSpan });
  }

  // Multiply length by week span (8px cell + 2px gap = 10px per mapped column)
  let monthsHtml = '<div class="heatmap-months" style="display: flex; font-size: 0.65rem; color: var(--text-muted); margin-bottom: 4px; line-height: 1;">';
  for (const m of monthWidths) {
      monthsHtml += `<div style="width: ${m.span * 10}px; flex-shrink: 0;">${escapeHtml(m.name)}</div>`;
  }
  monthsHtml += '</div>';

  return `<div class="heatmap-container" style="display: flex; flex-direction: column; width: max-content;">${monthsHtml}${gridHtml}</div>`;
}

export function buildAccumBarHtml(days, globalMaxGained, maxDays = null) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - ACCUM_WINDOW_DAYS);
  const cutoffKey = cutoff.toISOString().slice(0, 10);

  let windowed = days.filter((d) => d.dayKey >= cutoffKey);
  if (maxDays != null) windowed = windowed.slice(-maxDays);
  if (!windowed.length) return "";

  let html = "";
  let prevWeekKey = null;
  let weekGained = 0;
  let altToggle = false;

  const flushWeekMarker = () => {
    if (prevWeekKey === null) return;
    const label = localDateLabel(prevWeekKey, {
      month: "short",
      day: "numeric",
    });
    html += `<div class="accum-week-marker" title="Week of ${escapeAttr(label)}: +${weekGained.toLocaleString()} pts"></div>`;
    weekGained = 0;
  };

  const len = windowed.length;
  for (let i = 0; i < len; i++) {
    const day = windowed[i];
    if (prevWeekKey !== null && day.weekKey !== prevWeekKey) flushWeekMarker();
    prevWeekKey = day.weekKey;
    weekGained += day.gained;

    if (i > 0) {
      const prev = windowed[i - 1];
      const missed = Math.max(
        0,
        Math.round((new Date(day.dayKey) - new Date(prev.dayKey)) / 86400000) -
        1,
      );
      if (missed >= 1) {
        const gapClass = missed === 1 ? " accum-gap--warn" : " accum-gap--bad";
        html += `<div class="accum-gap${gapClass}" style="width:${missed * 16}px" title="Gap: ${missed} missed day${missed > 1 ? "s" : ""}"></div>`;
      }
    }

    const dateLabel = localDateLabel(day.dayKey, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    const heightPct = Math.max(
      ACCUM_MIN_HEIGHT_PCT,
      Math.round((day.gained / globalMaxGained) * ACCUM_MAX_HEIGHT_PCT),
    );
    const opacity = (0.35 + 0.65 * (i / (len - 1 || 1))).toFixed(2);
    altToggle = !altToggle;

    html += `<div class="accum-day ${altToggle ? "accum-day--a" : "accum-day--b"}" style="height:${heightPct}%;opacity:${opacity}" title="${escapeAttr(dateLabel)}: +${day.gained.toLocaleString()} pts (total: ${day.lastTotal.toLocaleString()})"></div>`;
  }

  return html;
}