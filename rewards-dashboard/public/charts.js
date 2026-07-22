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
const HEAT_LEVELS = [0, 75, 150, 225, 300];

export function buildHeatmapHtml(days) {
  if (!days.length) return "";

  const byDay = new Map(days.map((d) => [d.dayKey, d]));
  days = [...days].sort((a, b) => a.dayKey.localeCompare(b.dayKey));

  const today = new Date();
  
  // Safely format today as YYYY-MM-DD in local time
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  // 1. Anchor to the beginning (Left Justified)
  // We append T12:00:00 to avoid UTC timezone drift making the day shift to 'yesterday'
  let start = new Date(days[0].dayKey + "T12:00:00");
  start.setHours(12, 0, 0, 0);

  // Align to Monday so weeks stay vertical
  while (start.getDay() !== 1) {
    start.setDate(start.getDate() - 1);
  }

  // 2. Calculate how many weeks have passed since the start
  const msPerDay = 86400000;
  const elapsedWeeks = Math.ceil((today.getTime() - start.getTime()) / msPerDay / 7);
  
  // 3. Force at least 53 weeks (a full year) so the remaining empty squares project to the right.
  const totalWeeks = Math.max(53, elapsedWeeks + 1);

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

      let level = 0;

      if (entry) {
        if (entry.gained >= HEAT_LEVELS[4]) level = 4;
        else if (entry.gained >= HEAT_LEVELS[3]) level = 3;
        else if (entry.gained >= HEAT_LEVELS[2]) level = 2;
        else if (entry.gained >= HEAT_LEVELS[1]) level = 1;
      }

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