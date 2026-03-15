/**
 * Pure function: compute bar layout for EPEX price chart.
 * Extracted for Node.js testability without Preact import map.
 *
 * @param {Array<{ time: string|Date, price: number }>} pricesArray
 * @param {number} width  - SVG viewBox width
 * @param {number} height - SVG viewBox height
 * @returns {Array<{ x: number, y: number, w: number, h: number, color: string, label: string }>}
 */
export function computeBarLayout(pricesArray, width, height) {
  if (!pricesArray || pricesArray.length === 0) return [];

  const midY = height / 2;
  const gap = 1;
  const barW = (width / pricesArray.length) - gap;
  const maxAbs = Math.max(...pricesArray.map(p => Math.abs(p.price)), 0.01);

  return pricesArray.map((entry, i) => {
    const price = entry.price || 0;
    const barH = (Math.abs(price) / maxAbs) * midY;
    const positive = price >= 0;
    return {
      x: i * (barW + gap),
      y: positive ? midY - barH : midY,
      w: Math.max(0, barW),
      h: barH,
      color: positive ? 'var(--chart-positive)' : 'var(--chart-negative)',
      label: `${formatSlotTime(entry.time)}: ${price.toFixed(2)} ct/kWh`,
      _ts: new Date(entry.time).getTime(),
    };
  });
}

function formatSlotTime(time) {
  if (!time) return '--:--';
  const d = time instanceof Date ? time : new Date(time);
  if (isNaN(d.getTime())) return '--:--';
  return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

// --- Selection helpers (ported from app.js) ---

export function normalizeSelectionIndices(dataLength, indices) {
  if (dataLength <= 0 || !Array.isArray(indices) || indices.length === 0) return [];
  const s = new Set();
  for (const idx of indices) {
    const clamped = Math.max(0, Math.min(dataLength - 1, Math.trunc(idx)));
    s.add(clamped);
  }
  return [...s].sort((a, b) => a - b);
}

export function inferSlotMs(data) {
  if (!data || data.length < 2) return 900000;
  const t0 = typeof data[0].ts === 'number' ? data[0].ts : new Date(data[0].time || data[0].ts).getTime();
  const t1 = typeof data[1].ts === 'number' ? data[1].ts : new Date(data[1].time || data[1].ts).getTime();
  const diff = Math.abs(t1 - t0);
  return diff > 0 ? diff : 900000;
}

export function getSlotEndTimestamp(slotTs, slotMs) {
  return slotTs + slotMs;
}

export function buildSelectionRange(startIndex, endIndex) {
  const lo = Math.min(startIndex, endIndex);
  const hi = Math.max(startIndex, endIndex);
  const result = [];
  for (let i = lo; i <= hi; i++) result.push(i);
  return result;
}

export function buildScheduleWindows(data, indices) {
  if (!data || !indices || indices.length === 0) return [];
  const sorted = [...indices].sort((a, b) => a - b);
  const slotMs = inferSlotMs(data);
  const windows = [];
  let windowStart = sorted[0];
  let windowEnd = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === windowEnd + 1) {
      windowEnd = sorted[i];
    } else {
      windows.push(makeWindow(data, windowStart, windowEnd, slotMs));
      windowStart = sorted[i];
      windowEnd = sorted[i];
    }
  }
  windows.push(makeWindow(data, windowStart, windowEnd, slotMs));
  return windows;
}

function makeWindow(data, startIdx, endIdx, slotMs) {
  const startTs = typeof data[startIdx].ts === 'number'
    ? data[startIdx].ts
    : new Date(data[startIdx].time || data[startIdx].ts).getTime();
  const endTs = typeof data[endIdx].ts === 'number'
    ? data[endIdx].ts
    : new Date(data[endIdx].time || data[endIdx].ts).getTime();
  const endFinal = endTs + slotMs;
  return {
    start: fmtHHMM(startTs),
    end: fmtHHMM(endFinal)
  };
}

function fmtHHMM(tsMs) {
  const d = new Date(tsMs);
  return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', hour12: false });
}

// --- Overlay helpers ---

export function computeImportOverlayPoints(bars, comparisonByTs, yScale) {
  if (!bars || !comparisonByTs || bars.length === 0) return [];
  const points = [];
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (!bar) continue;
    const comp = comparisonByTs.get(bar._ts);
    if (!comp || !Number.isFinite(comp.importPriceCtKwh)) continue;
    points.push({
      x: bar.x + bar.w / 2,
      y: yScale(comp.importPriceCtKwh)
    });
  }
  return points;
}

export function resolveComparisonForSlot(ts, comparisonByTs) {
  if (!comparisonByTs || ts == null) return null;
  return comparisonByTs.get(Number(ts)) || null;
}

// --- Rule building ---

export function buildRulesFromWindows(windows, defaults) {
  if (!Array.isArray(windows)) return [];
  return windows.map(w => ({
    start: w.start,
    end: w.end,
    target: 'gridSetpointW',
    value: defaults?.defaultGridSetpointW ?? 0,
    enabled: true
  }));
}
