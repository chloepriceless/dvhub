const { apiFetch } = window.DVhubCommon || {};

function fmtTs(ts) { return ts ? new Date(ts).toLocaleString('de-DE') : '-'; }
function fmtHm(ts) { return new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }); }
function fmtDmHm(ts) { return new Date(ts).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
function fmtEuroFromCt(ct) {
  const eur = Number(ct) / 100;
  return `${eur.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} \u20ac`;
}
function setText(id, text, cls) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  if (cls !== undefined) {
    el.classList.remove('ok', 'off');
    if (cls) el.classList.add(cls);
  }
}

function setControlMsg(text, isErr = false) {
  const el = document.getElementById('controlMsg');
  if (!el) return;
  el.textContent = text;
  el.classList.remove('ok', 'off');
  el.classList.add(isErr ? 'off' : 'ok');
}

function clsByDir(dir) {
  if (!dir || dir.mode === 'neutral') return '';
  return dir.mode === 'feed_in' ? 'ok' : 'off';
}

function setFlow(dir) {
  const arrow = document.getElementById('flowArrow');
  const label = document.getElementById('flowLabel');
  if (!arrow || !label) return;
  if (!dir || dir.mode === 'neutral') {
    arrow.textContent = '-';
    arrow.className = 'arrow';
    label.textContent = '';
    return;
  }
  if (dir.mode === 'feed_in') {
    arrow.textContent = '<';
    arrow.className = 'arrow ok';
    label.textContent = '';
  } else {
    arrow.textContent = '>';
    arrow.className = 'arrow off';
    label.textContent = '';
  }
}

function cssVar(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function roundCt(value) {
  return Number(Number(value || 0).toFixed(2));
}

function formatChartEuroValue(value) {
  if (!Number.isFinite(Number(value))) return '-';
  return `${Number(value).toLocaleString('de-DE', { minimumFractionDigits: 4, maximumFractionDigits: 4 })} \u20ac`;
}

function getChartHighlightSets(values, { highCount = 4, lowCount = 8 } = {}) {
  const ranked = (Array.isArray(values) ? values : [])
    .map((value, index) => ({ value: Number(value), index }))
    .filter((entry) => Number.isFinite(entry.value));

  const high = new Set(
    ranked
      .slice()
      .sort((left, right) => right.value - left.value)
      .slice(0, highCount)
      .map((entry) => entry.index)
  );
  const low = new Set(
    ranked
      .slice()
      .filter((entry) => entry.value < 0)
      .sort((left, right) => left.value - right.value)
      .slice(0, lowCount)
      .map((entry) => entry.index)
  );
  return { high, low };
}

function createPriceChartScale({
  min,
  max,
  top,
  bottom,
  enableFocusBand = true,
  focusBandCeiling = 0.01,
  focusBandFloor = -0.01,
  focusBandHeightRatio
} = {}) {
  const chartTop = Number(top);
  const chartBottom = Number(bottom);
  const minValue = Number(min);
  const maxValue = Number(max);
  const chartHeight = chartBottom - chartTop;

  const linearY = (value) => {
    if (maxValue === minValue) return chartTop + (chartHeight / 2);
    return chartTop + ((maxValue - value) * chartHeight) / (maxValue - minValue);
  };

  if (!Number.isFinite(minValue) || !Number.isFinite(maxValue) || !Number.isFinite(chartHeight) || chartHeight <= 0) {
    return { y: () => chartTop };
  }
  if (maxValue <= minValue) return { y: linearY };

  const hasFocusBand =
    enableFocusBand &&
    maxValue > focusBandFloor &&
    minValue < focusBandCeiling &&
    focusBandCeiling > focusBandFloor;
  if (!hasFocusBand) return { y: linearY };

  const ceiling = Math.min(Math.max(focusBandCeiling, minValue), maxValue);
  const floor = Math.max(Math.min(focusBandFloor, maxValue), minValue);
  if (ceiling <= floor) return { y: linearY };

  const upperSpan = Math.max(maxValue - ceiling, 0);
  const focusSpan = Math.max(ceiling - floor, 0);
  const lowerSpan = Math.max(floor - minValue, 0);
  if (focusSpan <= 0) return { y: linearY };

  const bothOuterBands = upperSpan > 0 && lowerSpan > 0;
  const singleOuterBand = (upperSpan > 0) !== (lowerSpan > 0);
  const focusRatio = Number.isFinite(focusBandHeightRatio)
    ? Math.max(0, Math.min(Number(focusBandHeightRatio), 1))
    : (bothOuterBands ? 0.18 : (singleOuterBand ? 0.24 : 1));
  const focusHeight = chartHeight * focusRatio;
  const remainingHeight = Math.max(chartHeight - focusHeight, 0);
  const outerSpan = upperSpan + lowerSpan;
  const upperHeight = outerSpan > 0 ? remainingHeight * (upperSpan / outerSpan) : 0;
  const lowerHeight = outerSpan > 0 ? remainingHeight * (lowerSpan / outerSpan) : 0;
  const focusTop = chartTop + upperHeight;
  const focusBottom = chartBottom - lowerHeight;

  const mapSegment = (value, fromValue, toValue, fromY, toY) => {
    if (fromValue === toValue) return (fromY + toY) / 2;
    return fromY + ((value - fromValue) * (toY - fromY)) / (toValue - fromValue);
  };

  return {
    y(value) {
      const numericValue = Number(value);
      if (!Number.isFinite(numericValue)) return chartBottom;
      if (numericValue >= ceiling) {
        return upperSpan > 0
          ? mapSegment(Math.min(numericValue, maxValue), maxValue, ceiling, chartTop, focusTop)
          : focusTop;
      }
      if (numericValue <= floor) {
        return lowerSpan > 0
          ? mapSegment(Math.max(numericValue, minValue), floor, minValue, focusBottom, chartBottom)
          : focusBottom;
      }
      return mapSegment(numericValue, ceiling, floor, focusTop, focusBottom);
    }
  };
}

function hhmmToMinutes(value) {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) return null;
  const [hours, minutes] = value.split(':').map((part) => Number(part));
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  return hours * 60 + minutes;
}

function computeDynamicGrossImportCtKwh({ marketCtKwh = 0, components = {} } = {}) {
  const base =
    Number(marketCtKwh || 0)
    + Number(components.energyMarkupCtKwh || 0)
    + Number(components.gridChargesCtKwh || 0)
    + Number(components.leviesAndFeesCtKwh || 0);
  const vatFactor = 1 + (Number(components.vatPct || 0) / 100);
  return roundCt(base * vatFactor);
}

function isScheduleWindowExpired(windowLike, nowTs = Date.now()) {
  const startMin = hhmmToMinutes(windowLike?.start);
  const endMin = hhmmToMinutes(windowLike?.end);
  if (startMin == null || endMin == null) return false;

  const now = new Date(nowTs);
  const nowMin = now.getHours() * 60 + now.getMinutes();

  if (startMin <= endMin) return nowMin >= endMin;
  return nowMin >= endMin && nowMin < startMin;
}

function createRefreshCoordinator({ refreshTask }) {
  let inFlight = null;
  let queued = false;

  async function runLoop() {
    do {
      queued = false;
      await refreshTask();
    } while (queued);
  }

  return {
    async run() {
      if (inFlight) {
        queued = true;
        return inFlight;
      }
      inFlight = runLoop().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    isRunning() {
      return Boolean(inFlight);
    }
  };
}

const CHART_DEFAULT_SLOT_MS = 60 * 60 * 1000;
const chartSelectionState = {
  data: [],
  barElements: [],
  selectedTimestamps: new Set(),
  hoveredIndex: null,
  pointerDown: false,
  anchorIndex: null,
  didDrag: false
};
const dashboardState = {
  lastMinSocReadback: null,
  minSocEditorOpen: false,
  pendingMinSocWrite: null
};

function normalizeChartSelectionIndices(data, indices) {
  if (!Array.isArray(data) || !Array.isArray(indices)) return [];
  return Array.from(new Set(indices))
    .filter((index) => Number.isInteger(index) && index >= 0 && index < data.length)
    .sort((left, right) => left - right);
}

function inferChartSlotMs(data) {
  if (!Array.isArray(data) || data.length < 2) return CHART_DEFAULT_SLOT_MS;
  const durations = [];
  for (let index = 1; index < data.length; index++) {
    const previousTs = Number(data[index - 1]?.ts);
    const currentTs = Number(data[index]?.ts);
    const diff = currentTs - previousTs;
    if (Number.isFinite(diff) && diff > 0) durations.push(diff);
  }
  return durations.length ? Math.min(...durations) : CHART_DEFAULT_SLOT_MS;
}

function getChartSlotEndTimestamp(data, index, slotMs = inferChartSlotMs(data)) {
  const currentTs = Number(data[index]?.ts);
  const nextTs = Number(data[index + 1]?.ts);
  if (Number.isFinite(nextTs) && nextTs > currentTs && (nextTs - currentTs) <= slotMs * 1.5) {
    return nextTs;
  }
  return currentTs + slotMs;
}

function buildScheduleWindowsFromSelection(data, indices) {
  const normalized = normalizeChartSelectionIndices(data, indices);
  if (!normalized.length) return [];

  const slotMs = inferChartSlotMs(data);
  const windows = [];
  let groupStart = normalized[0];
  let previousIndex = normalized[0];

  for (const currentIndex of normalized.slice(1)) {
    const previousTs = Number(data[previousIndex]?.ts);
    const currentTs = Number(data[currentIndex]?.ts);
    const isContinuous =
      currentIndex === previousIndex + 1 &&
      Number.isFinite(previousTs) &&
      Number.isFinite(currentTs) &&
      (currentTs - previousTs) <= slotMs * 1.5;

    if (!isContinuous) {
      windows.push({
        start: fmtHm(data[groupStart].ts),
        end: fmtHm(getChartSlotEndTimestamp(data, previousIndex, slotMs))
      });
      groupStart = currentIndex;
    }

    previousIndex = currentIndex;
  }

  windows.push({
    start: fmtHm(data[groupStart].ts),
    end: fmtHm(getChartSlotEndTimestamp(data, previousIndex, slotMs))
  });

  return windows;
}

function getSelectedChartIndices(data = chartSelectionState.data) {
  return normalizeChartSelectionIndices(
    data,
    data.map((row, index) => (chartSelectionState.selectedTimestamps.has(Number(row.ts)) ? index : -1))
  );
}

function updateChartBarStates() {
  const selectedIndices = new Set(getSelectedChartIndices());
  chartSelectionState.barElements.forEach((bar, index) => {
    if (!bar?.classList) return;
    bar.classList.toggle('is-hovered', index === chartSelectionState.hoveredIndex);
    bar.classList.toggle('is-selected', selectedIndices.has(index));
  });
}

function updateChartSelectionCallout() {
  if (typeof document === 'undefined') return;

  const callout = document.getElementById('chartScheduleCallout');
  const summary = document.getElementById('chartSelectionSummary');
  const detail = document.getElementById('chartSelectionDetail');
  const button = document.getElementById('createSelectionScheduleBtn');
  if (!callout || !summary || !detail || !button) return;

  const selectedIndices = getSelectedChartIndices();
  const windows = buildScheduleWindowsFromSelection(chartSelectionState.data, selectedIndices);
  const isVisible = selectedIndices.length > 1;

  callout.hidden = !isVisible;
  callout.classList.toggle('is-visible', isVisible);
  button.disabled = !selectedIndices.length;

  if (!isVisible) {
    summary.textContent = 'Keine Auswahl aktiv';
    detail.textContent = 'Markiere mehrere Balken im Chart, um Schedule-Zeilen vorzubereiten.';
    return;
  }

  summary.textContent = `${selectedIndices.length} Balken markiert`;
  detail.textContent = windows.map((window) => `${window.start} - ${window.end}`).join(' | ');
}

function setChartSelection(data, indices) {
  const normalized = normalizeChartSelectionIndices(data, indices);
  chartSelectionState.data = Array.isArray(data) ? data : [];
  chartSelectionState.selectedTimestamps = new Set(normalized.map((index) => Number(data[index].ts)));
  updateChartBarStates();
  updateChartSelectionCallout();
  return normalized;
}

function clearChartSelection() {
  chartSelectionState.selectedTimestamps.clear();
  chartSelectionState.anchorIndex = null;
  chartSelectionState.didDrag = false;
  updateChartBarStates();
  updateChartSelectionCallout();
}

function buildChartSelectionRange(startIndex, endIndex) {
  const low = Math.min(startIndex, endIndex);
  const high = Math.max(startIndex, endIndex);
  const range = [];
  for (let index = low; index <= high; index++) range.push(index);
  return range;
}

function fmtCt(value, digits = 2) {
  if (!Number.isFinite(Number(value))) return '-';
  return `${Number(value).toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits })} ct/kWh`;
}

function fmtSignedCt(value, digits = 2) {
  if (!Number.isFinite(Number(value))) return '-';
  const prefix = Number(value) > 0 ? '+' : '';
  return `${prefix}${fmtCt(value, digits)}`;
}

function updateChartComparisonSummary(pricing) {
  const summary = document.getElementById('chartComparisonSummary');
  const detail = document.getElementById('chartComparisonDetail');
  if (!summary || !detail) return;

  if (!pricing?.configured) {
    summary.textContent = 'Eigener Strompreis noch nicht konfiguriert';
    detail.textContent = 'Lege in den Einstellungen deinen Bruttopreis, Preisbestandteile und interne Kosten an, damit DVhub jeden Börsenslot gegen Netzbezug, PV und Akku bewerten kann.';
    return;
  }

  if (!pricing.current) {
    summary.textContent = 'Eigener Strompreis ist konfiguriert';
    detail.textContent = 'Sobald aktuelle EPEX-Slots vorliegen, zeigt DVhub hier den Vergleich zwischen Börse, Netzbezug, PV und Akku für den aktiven Zeitslot.';
    return;
  }

  const current = pricing.current;
  summary.textContent = `Jetzt: Börse ${fmtCt(current.exportPriceCtKwh)} | Bezug ${fmtCt(current.importPriceCtKwh)}`;
  detail.textContent = [
    `Spread ${fmtSignedCt(current.spreadToImportCtKwh)}`,
    `PV ${fmtSignedCt(current.pvMarginCtKwh)}`,
    `Akku ${fmtSignedCt(current.batteryMarginCtKwh)}`,
    `Gemischt ${fmtSignedCt(current.mixedMarginCtKwh)}`,
    current.bestSource ? `Beste Quelle: ${current.bestSource}` : ''
  ].filter(Boolean).join(' | ');
}

function showChartTooltip(tooltip, row, event, comparison) {
  if (!tooltip || !row || !event) return;
  tooltip.style.display = 'block';
  const parts = [`${fmtDmHm(row.ts)} | Börse ${fmtCt(row.ct_kwh, 4)}`];
  if (comparison) {
    parts.push(`Bezug ${fmtCt(comparison.importPriceCtKwh, 4)}`);
    parts.push(`PV ${fmtSignedCt(comparison.pvMarginCtKwh, 4)}`);
    parts.push(`Akku ${fmtSignedCt(comparison.batteryMarginCtKwh, 4)}`);
    parts.push(`Gemischt ${fmtSignedCt(comparison.mixedMarginCtKwh, 4)}`);
  }
  tooltip.textContent = parts.join(' | ');
  tooltip.style.left = `${event.clientX + 12}px`;
  tooltip.style.top = `${event.clientY + 12}px`;
}

function hideChartTooltip() {
  if (typeof document === 'undefined') return;
  const tooltip = document.getElementById('tooltip');
  if (tooltip) tooltip.style.display = 'none';
}

function appendScheduleRowsFromChartSelection(data, indices) {
  const windows = buildScheduleWindowsFromSelection(data, indices);
  windows.forEach(({ start, end }) => addScheduleRow({ start, end }));
  return windows;
}

function createScheduleRowsFromChartSelection(indices = getSelectedChartIndices()) {
  const windows = appendScheduleRowsFromChartSelection(chartSelectionState.data, indices);
  if (!windows.length) return [];

  const message =
    windows.length === 1
      ? `Schedule aus Chart ergänzt: ${windows[0].start} - ${windows[0].end}`
      : `${windows.length} Schedule-Fenster aus der Chartauswahl ergänzt`;
  setControlMsg(message);
  clearChartSelection();
  return windows;
}

function drawPriceChart(data, nowTs, comparisons = []) {
  const svg = document.getElementById('priceChart');
  const tooltip = document.getElementById('tooltip');
  if (!svg) return;

  svg.innerHTML = '';
  chartSelectionState.data = Array.isArray(data) ? data : [];
  chartSelectionState.barElements = [];
  chartSelectionState.hoveredIndex = null;
  chartSelectionState.pointerDown = false;
  chartSelectionState.anchorIndex = null;
  chartSelectionState.didDrag = false;
  updateChartSelectionCallout();
  if (!Array.isArray(data) || data.length === 0) return;

  const W = 1000;
  const H = 300;
  const padL = 56;
  const padR = 20;
  const padT = 16;
  const padB = 40;
  const chartGrid = cssVar('--chart-grid', '#e5e7eb');
  const chartAxis = cssVar('--chart-axis', '#9ca3af');
  const chartLabel = cssVar('--chart-label', '#6b7280');
  const chartPositive = cssVar('--chart-positive', '#1d4ed8');
  const chartNegative = cssVar('--chart-negative', '#ef4444');
  const chartPositiveHighlight = cssVar('--chart-positive-highlight', '#a8f000');
  const chartNegativeHighlight = cssVar('--chart-negative-highlight', '#ff7a59');
  const chartNow = cssVar('--chart-now', '#facc15');
  const chartImport = cssVar('--chart-import', '#22c55e');

  const comparisonByTs = new Map((comparisons || []).filter(Boolean).map((row) => [Number(row.ts), row]));
  const vals = data.map((d) => Number(d.ct_kwh) / 100);
  const importVals = data
    .map((d) => Number(comparisonByTs.get(Number(d.ts))?.importPriceCtKwh) / 100)
    .filter((value) => Number.isFinite(value));
  const allVals = vals.concat(importVals);
  let min = Math.min(...allVals);
  let max = Math.max(...allVals);
  if (min === max) {
    min -= 1;
    max += 1;
  }

  const barW = (W - padL - padR) / data.length;
  const x = (i) => padL + i * barW;
  const y = createPriceChartScale({
    min,
    max,
    top: padT,
    bottom: H - padB,
    enableFocusBand: vals.some((value) => Number.isFinite(value) && value >= -0.01 && value <= 0.01),
    focusBandCeiling: 0.01,
    focusBandFloor: -0.01
  }).y;
  const { high: highHighlights, low: lowHighlights } = getChartHighlightSets(vals);

  for (let i = 0; i <= 6; i++) {
    const vv = min + ((max - min) * i) / 6;
    const yy = y(vv);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', padL);
    line.setAttribute('x2', W - padR);
    line.setAttribute('y1', yy);
    line.setAttribute('y2', yy);
    line.setAttribute('stroke', chartGrid);
    svg.appendChild(line);

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', 4);
    label.setAttribute('y', yy + 4);
    label.setAttribute('font-size', '11');
    label.setAttribute('fill', chartLabel);
    label.textContent = formatChartEuroValue(vv);
    svg.appendChild(label);
  }

  const tickCount = Math.min(10, data.length);
  for (let i = 0; i < tickCount; i++) {
    const idx = Math.round((i * (data.length - 1)) / Math.max(1, tickCount - 1));
    const xx = x(idx) + barW / 2;
    const tm = fmtDmHm(data[idx].ts);

    const tick = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    tick.setAttribute('x1', xx);
    tick.setAttribute('x2', xx);
    tick.setAttribute('y1', H - padB);
    tick.setAttribute('y2', H - padB + 4);
    tick.setAttribute('stroke', chartAxis);
    svg.appendChild(tick);

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', xx - 16);
    label.setAttribute('y', H - 10);
    label.setAttribute('font-size', '10');
    label.setAttribute('fill', chartLabel);
    label.textContent = tm;
    svg.appendChild(label);
  }

  const idxNow = data.findIndex((d, i) => d.ts <= nowTs && (i === data.length - 1 || data[i + 1].ts > nowTs));
  if (idxNow >= 0) {
    const xv = x(idxNow) + barW / 2;
    const vline = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    vline.setAttribute('x1', xv);
    vline.setAttribute('x2', xv);
    vline.setAttribute('y1', padT);
    vline.setAttribute('y2', H - padB);
    vline.setAttribute('stroke', chartNow);
    vline.setAttribute('stroke-dasharray', '4 3');
    svg.appendChild(vline);
  }

  const zeroY = y(0);
  const baseY = zeroY >= padT && zeroY <= H - padB ? zeroY : H - padB;
  data.forEach((row, index) => {
    const comparison = comparisonByTs.get(Number(row.ts)) || null;
    const val = Number(row.ct_kwh) / 100;
    const bx = x(index);
    const by = y(val);
    const bh = Math.abs(by - baseY);
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', bx + 1);
    rect.setAttribute('y', Math.min(by, baseY));
    rect.setAttribute('width', Math.max(barW - 2, 1));
    rect.setAttribute('height', bh || 1);
    rect.setAttribute(
      'fill',
      lowHighlights.has(index)
        ? chartNegativeHighlight
        : highHighlights.has(index)
          ? chartPositiveHighlight
          : (val < 0 ? chartNegative : chartPositive)
    );
    rect.classList.add('price-bar');
    rect.classList.add(val < 0 ? 'is-negative' : 'is-positive');
    if (highHighlights.has(index)) rect.classList.add('is-highlight-positive');
    if (lowHighlights.has(index)) rect.classList.add('is-highlight-negative');
    rect.addEventListener('mousedown', (event) => {
      event.preventDefault();
      chartSelectionState.pointerDown = true;
      chartSelectionState.anchorIndex = index;
      chartSelectionState.didDrag = false;
      chartSelectionState.hoveredIndex = index;
      setChartSelection(data, [index]);
      showChartTooltip(tooltip, row, event, comparison);
    });
    rect.addEventListener('mouseenter', (event) => {
      chartSelectionState.hoveredIndex = index;
      if (chartSelectionState.pointerDown && chartSelectionState.anchorIndex != null) {
        chartSelectionState.didDrag = chartSelectionState.didDrag || index !== chartSelectionState.anchorIndex;
        setChartSelection(data, buildChartSelectionRange(chartSelectionState.anchorIndex, index));
      } else {
        updateChartBarStates();
      }
      showChartTooltip(tooltip, row, event, comparison);
    });
    rect.addEventListener('mousemove', (event) => {
      chartSelectionState.hoveredIndex = index;
      if (chartSelectionState.pointerDown && chartSelectionState.anchorIndex != null) {
        chartSelectionState.didDrag = chartSelectionState.didDrag || index !== chartSelectionState.anchorIndex;
        setChartSelection(data, buildChartSelectionRange(chartSelectionState.anchorIndex, index));
      } else {
        updateChartBarStates();
      }
      showChartTooltip(tooltip, row, event, comparison);
    });
    svg.appendChild(rect);
    chartSelectionState.barElements.push(rect);
  });

  const importPoints = data
    .map((row, index) => {
      const comparison = comparisonByTs.get(Number(row.ts));
      const importCtKwh = Number(comparison?.importPriceCtKwh);
      if (!Number.isFinite(importCtKwh)) return null;
      return `${x(index) + (barW / 2)},${y(importCtKwh / 100)}`;
    })
    .filter(Boolean);
  if (importPoints.length >= 2) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', chartImport);
    line.setAttribute('stroke-width', '2.5');
    line.setAttribute('stroke-linejoin', 'round');
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('points', importPoints.join(' '));
    svg.appendChild(line);
  }

  if (zeroY >= padT && zeroY <= H - padB) {
    const zero = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    zero.setAttribute('x1', padL);
    zero.setAttribute('x2', W - padR);
    zero.setAttribute('y1', zeroY);
    zero.setAttribute('y2', zeroY);
    zero.setAttribute('stroke', chartNegative);
    zero.setAttribute('stroke-width', '1.5');
    svg.appendChild(zero);
  }

  svg.onmouseleave = () => {
    chartSelectionState.hoveredIndex = null;
    updateChartBarStates();
    hideChartTooltip();
  };
  updateChartBarStates();
}

function resolveDvControlIndicators(status) {
  const dcReadback = status.victron?.feedExcessDcPv;
  const acReadback = status.victron?.dontFeedExcessAcPv;
  if (dcReadback != null || acReadback != null) {
    return {
      dc: {
        text: dcReadback == null ? '-' : (Number(dcReadback) === 1 ? 'EIN' : 'AUS'),
        tone: dcReadback == null ? undefined : (Number(dcReadback) === 1 ? 'ok' : 'off')
      },
      ac: {
        text: acReadback == null ? '-' : (Number(acReadback) === 1 ? 'Ja' : 'Nein'),
        tone: acReadback == null ? undefined : (Number(acReadback) === 1 ? 'off' : 'ok')
      }
    };
  }

  const dvc = status.ctrl?.dvControl;
  if (!dvc) return { dc: { text: '-', tone: undefined }, ac: { text: '-', tone: undefined } };

  const dcOk = dvc.feedExcessDcPv?.ok;
  const acOk = dvc.dontFeedExcessAcPv?.ok;
  return {
    dc: {
      text: dcOk != null ? (dvc.feedIn ? 'EIN' : 'AUS') : '-',
      tone: dcOk != null ? (dvc.feedIn ? 'ok' : 'off') : undefined
    },
    ac: {
      text: acOk != null ? (dvc.feedIn ? 'Nein' : 'Ja') : '-',
      tone: acOk != null ? (dvc.feedIn ? 'ok' : 'off') : undefined
    }
  };
}

function createMinSocPendingState({ currentReadback, submittedValue, submittedAt = Date.now() }) {
  return {
    previousReadback: currentReadback,
    targetValue: submittedValue,
    submittedAt
  };
}

function resolveMinSocPendingState({ pendingState, readbackValue }) {
  if (!pendingState) return null;
  if (readbackValue == null) return pendingState;
  if (readbackValue === pendingState.targetValue) return null;
  if (readbackValue !== pendingState.previousReadback) return null;
  return pendingState;
}

function computeMinSocRenderState({ readbackValue, pendingState }) {
  const nextPendingState = resolveMinSocPendingState({ pendingState, readbackValue });
  return {
    pendingState: nextPendingState,
    shouldBlink: Boolean(nextPendingState)
  };
}

function syncMinSocEditorPreview(value) {
  const numericValue = Number(value);
  const preview = document.getElementById('minSocEditorValue');
  if (!preview) return;
  preview.textContent = Number.isFinite(numericValue) ? `${Math.round(numericValue)} %` : '-';
}

function syncMinSocEditorFromReadback(value) {
  const slider = document.getElementById('minSocSlider');
  if (!slider) return;
  const fallbackValue = Number(slider.value);
  const normalizedValue = Number.isFinite(Number(value))
    ? Math.round(Number(value))
    : (Number.isFinite(fallbackValue) ? fallbackValue : 20);
  slider.value = String(normalizedValue);
  syncMinSocEditorPreview(normalizedValue);
}

function setMinSocEditorOpen(isOpen) {
  dashboardState.minSocEditorOpen = Boolean(isOpen);
  const row = document.getElementById('minSocRow');
  const editor = document.getElementById('minSocEditor');
  if (row) row.setAttribute('aria-expanded', dashboardState.minSocEditorOpen ? 'true' : 'false');
  if (editor) editor.hidden = !dashboardState.minSocEditorOpen;
}

function openMinSocEditor() {
  syncMinSocEditorFromReadback(dashboardState.lastMinSocReadback);
  setMinSocEditorOpen(true);
}

function closeMinSocEditor() {
  setMinSocEditorOpen(false);
}

function toggleMinSocEditor() {
  if (dashboardState.minSocEditorOpen) {
    closeMinSocEditor();
    return;
  }
  openMinSocEditor();
}

function handleMinSocRowKeydown(event) {
  if (!event) return;
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  toggleMinSocEditor();
}

function applyMinSocPendingVisualState(shouldBlink) {
  document.getElementById('minSoc')?.classList.toggle('min-soc-pending', Boolean(shouldBlink));
}

async function submitMinSocUpdate({ sliderValue, currentReadback, apiFetchImpl = apiFetch }) {
  const value = Number(sliderValue);
  if (!Number.isFinite(value)) {
    return { ok: false, error: 'Min SOC: Ungültiger Wert' };
  }
  const request = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: 'minSocPct', value })
  };
  const response = await apiFetchImpl('/api/control/write', request);
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    return { ok: false, error: `MinSOC Write Fehler: ${payload.error || response.status}` };
  }
  return {
    ok: true,
    closeEditor: true,
    pendingState: createMinSocPendingState({ currentReadback, submittedValue: value }),
    request
  };
}

async function handleMinSocSubmit() {
  const slider = document.getElementById('minSocSlider');
  const outcome = await submitMinSocUpdate({
    sliderValue: slider?.value,
    currentReadback: dashboardState.lastMinSocReadback
  });
  if (!outcome.ok) {
    setControlMsg(outcome.error, true);
    return;
  }
  dashboardState.pendingMinSocWrite = outcome.pendingState;
  closeMinSocEditor();
  setControlMsg(`Min SOC geschrieben: ${outcome.pendingState.targetValue} %`);
  await requestDashboardRefresh();
}

function renderDashboardStatus(status) {
  const dvOn = Number(status.dvControlValue) === 1;
  setText('dvStatus', dvOn ? 'EIN (Freigabe)' : 'AUS (Sperre)', dvOn ? 'ok' : 'off');
  setText('nowTime', fmtTs(status.now));
  setText('dvValue', String(status.dvControlValue));
  setText('offUntil', status.ctrl?.offUntil ? fmtTs(status.ctrl.offUntil) : '-');
  setText('kaModbus', status.keepalive?.modbusLastQuery?.ts ? fmtTs(status.keepalive.modbusLastQuery.ts) : '-');

  const dvIndicators = resolveDvControlIndicators(status);
  setText('dvDcPv', dvIndicators.dc.text, dvIndicators.dc.tone);
  setText('dvAcPv', dvIndicators.ac.text, dvIndicators.ac.tone);

  const s = status.epex?.summary;
  setText('priceNow', s?.current ? `${fmtEuroFromCt(s.current.ct_kwh)}/kWh` : '-', s?.current && Number(s.current.ct_kwh) < 0 ? 'off' : 'ok');
  setText('priceNext', s?.next ? `${fmtDmHm(s.next.ts)} (${fmtEuroFromCt(s.next.ct_kwh)}/kWh)` : '-');
  setText('negLater', s ? (s.hasFutureNegative ? 'Ja' : 'Nein') : '-');
  setText('negTomorrow', s ? (s.tomorrowNegative ? 'Ja' : 'Nein') : '-');
  setText(
    'todayMinMax',
    s && s.todayMin != null && s.todayMax != null
      ? `${fmtEuroFromCt(Number(s.todayMin) / 10)} / ${fmtEuroFromCt(Number(s.todayMax) / 10)}`
      : '-'
  );
  const negActive = status.ctrl?.negativePriceActive;
  setText('negPriceProtection', negActive ? 'AKTIV (Abregelung)' : 'Inaktiv', negActive ? 'off' : 'ok');
  setText(
    'tomorrowMinMax',
    s && s.tomorrowMin != null && s.tomorrowMax != null
      ? `${fmtEuroFromCt(Number(s.tomorrowMin) / 10)} / ${fmtEuroFromCt(Number(s.tomorrowMax) / 10)}`
      : '-'
  );

  setText('l1', `${status.meter?.grid_l1_w ?? '-'} W`);
  setText('l2', `${status.meter?.grid_l2_w ?? '-'} W`);
  setText('l3', `${status.meter?.grid_l3_w ?? '-'} W`);
  setText('total', `${status.meter?.grid_total_w ?? '-'} W`, clsByDir(status.meter?.totalDir));
  setFlow(status.meter?.totalDir);

  const vic = status.victron || {};
  setText('soc', vic.soc == null ? '-' : `${vic.soc} %`);
  setText('batP', vic.batteryPowerW == null ? '-' : `${vic.batteryPowerW} W`);
  setText('pvP', vic.pvPowerW == null ? '-' : `${vic.pvPowerW} W`);
  setText('pvTotal', vic.pvTotalW == null ? '-' : `${vic.pvTotalW} W`);
  setText('gridSetpoint', vic.gridSetpointW == null ? '-' : `${vic.gridSetpointW} W`);
  const minSocRenderState = computeMinSocRenderState({
    readbackValue: vic.minSocPct,
    pendingState: dashboardState.pendingMinSocWrite
  });
  dashboardState.pendingMinSocWrite = minSocRenderState.pendingState;
  dashboardState.lastMinSocReadback = vic.minSocPct;
  setText('minSoc', vic.minSocPct == null ? '-' : `${vic.minSocPct} %`);
  applyMinSocPendingVisualState(minSocRenderState.shouldBlink);
  if (!dashboardState.minSocEditorOpen) syncMinSocEditorFromReadback(vic.minSocPct);

  const c = status.costs || {};
  setText('costImport', c.importKwh == null ? '-' : `${c.importKwh} kWh`);
  setText('costExport', c.exportKwh == null ? '-' : `${c.exportKwh} kWh`);
  setText('costCost', c.costEur == null ? '-' : `${c.costEur.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} \u20ac`);
  setText('costRevenue', c.revenueEur == null ? '-' : `${c.revenueEur.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} \u20ac`);
  setText('costNet', c.netEur == null ? '-' : `${c.netEur.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} \u20ac`, c.netEur >= 0 ? 'ok' : 'off');

  const sch = status.schedule || {};
  const ag = sch.active?.gridSetpointW;
  const ac = sch.active?.chargeCurrentA;
  const am = sch.active?.minSocPct;
  const lwG = sch.lastWrite?.gridSetpointW;
  const lwC = sch.lastWrite?.chargeCurrentA;
  const lwM = sch.lastWrite?.minSocPct;
  setText('activeGridSetpoint', ag?.value == null ? '-' : `${ag.value} W (${ag.source || '-'})`);
  setText('activeChargeCurrent', ac?.value == null ? '-' : `${ac.value} A (${ac.source || '-'})`);
  setText('activeMinSoc', am?.value == null ? '-' : `${am.value} % (${am.source || '-'})`);
  const lwParts = [];
  if (lwG?.at) lwParts.push(`Grid: ${lwG.value} @ ${fmtTs(lwG.at)}`);
  if (lwC?.at) lwParts.push(`Charge: ${lwC.value} @ ${fmtTs(lwC.at)}`);
  if (lwM?.at) lwParts.push(`MinSOC: ${lwM.value} @ ${fmtTs(lwM.at)}`);
  setText('lastControlWrite', lwParts.length ? lwParts.join(' | ') : '-');
  applyScheduleRowStates(status.now);
  updateChartComparisonSummary(status.userEnergyPricing);

  drawPriceChart(status.epex?.data || [], status.now, status.userEnergyPricing?.slots || []);
  setText('chartMeta', `EPEX Update: ${fmtTs(status.epex?.updatedAt)} | Datapoints: ${(status.epex?.data || []).length}`);
}

function renderDashboardLog(logs) {
  const rows = (logs.rows || []).slice(-20).reverse();
  document.getElementById('logBox').textContent = rows.map((r) => JSON.stringify(r)).join('\n') || '-';
}

function getDashboardLogUrl(limit = 20) {
  const normalizedLimit = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 20;
  return `/api/log?limit=${normalizedLimit}`;
}

function createDashboardRefreshTask({
  fetchStatus,
  fetchLog,
  applyStatus,
  applyLog
}) {
  return async function runDashboardRefresh() {
    const logTask = Promise.resolve()
      .then(() => fetchLog())
      .then((result) => (result && typeof result.json === 'function' ? result.json() : result))
      .then((payload) => applyLog(payload));

    const statusPayload = await Promise.resolve()
      .then(() => fetchStatus())
      .then((result) => (result && typeof result.json === 'function' ? result.json() : result));

    await applyStatus(statusPayload);
    await logTask;
  };
}

const refreshDashboardTask = createDashboardRefreshTask({
  fetchStatus: () => apiFetch('/api/status'),
  fetchLog: () => apiFetch(getDashboardLogUrl()),
  applyStatus: async (status) => renderDashboardStatus(status),
  applyLog: async (logs) => renderDashboardLog(logs)
});

async function refresh() {
  await refreshDashboardTask();
}

const dashboardRefreshCoordinator = createRefreshCoordinator({
  refreshTask: refresh
});

function requestDashboardRefresh() {
  return dashboardRefreshCoordinator.run();
}

async function refreshEpex() {
  await apiFetch('/api/epex/refresh', { method: 'POST' });
  await requestDashboardRefresh();
}

/* --- Manual Write (separate buttons) --- */

async function manualWriteGrid() {
  const value = Number(document.getElementById('manualGridValue')?.value);
  if (!Number.isFinite(value)) return setControlMsg('Grid Setpoint: Ungültiger Wert', true);
  const res = await apiFetch('/api/control/write', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: 'gridSetpointW', value })
  });
  const out = await res.json();
  if (!res.ok || !out.ok) return setControlMsg(`Grid Write Fehler: ${out.error || res.status}`, true);
  setControlMsg(`Grid Setpoint geschrieben: ${value} W`);
  await requestDashboardRefresh();
}

async function manualWriteCharge() {
  const value = Number(document.getElementById('manualChargeValue')?.value);
  if (!Number.isFinite(value)) return setControlMsg('Charge Current: Ungültiger Wert', true);
  const res = await apiFetch('/api/control/write', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: 'chargeCurrentA', value })
  });
  const out = await res.json();
  if (!res.ok || !out.ok) return setControlMsg(`Charge Write Fehler: ${out.error || res.status}`, true);
  setControlMsg(`Charge Current geschrieben: ${value} A`);
  await requestDashboardRefresh();
}

/* --- Schedule --- */

let scheduleCache = { rules: [], config: {} };

function updateScheduleRowVisualState(tr, nowTs = Date.now()) {
  if (!tr) return false;
  const enabled = tr.querySelector('.sched-row-enabled')?.checked ?? true;
  const expired = isScheduleWindowExpired({
    start: tr.dataset.start || tr.querySelector('.sched-start')?.value,
    end: tr.dataset.end || tr.querySelector('.sched-end')?.value
  }, nowTs);

  tr.classList.toggle('sched-row-expired', expired);
  tr.style.opacity = enabled ? (expired ? '0.55' : '1') : '0.4';
  return expired;
}

function applyScheduleRowStates(nowTs = Date.now()) {
  const tbody = document.getElementById('scheduleRowsDash');
  if (!tbody) return;
  for (const tr of tbody.querySelectorAll('tr')) {
    tr.dataset.start = tr.querySelector('.sched-start')?.value || '';
    tr.dataset.end = tr.querySelector('.sched-end')?.value || '';
    updateScheduleRowVisualState(tr, nowTs);
  }
}

function addScheduleRow(opts = {}) {
  const {
    start = '06:45', end = '07:15',
    gridVal = -40, chargeVal = '',
    gridEnabled = true, chargeEnabled = false,
    rowEnabled = true
  } = opts;
  const tbody = document.getElementById('scheduleRowsDash');
  if (!tbody) return;
  const tr = document.createElement('tr');

  tr.innerHTML = `
    <td><input type="checkbox" class="sched-row-enabled" ${rowEnabled ? 'checked' : ''} title="Aktiv" /></td>
    <td><input type="time" class="sched-start" value="${start}" /></td>
    <td><input type="time" class="sched-end" value="${end}" /></td>
    <td><label><input type="checkbox" class="sched-grid-en" ${gridEnabled ? 'checked' : ''} /> <input type="number" class="sched-grid-val" value="${gridVal}" /></label></td>
    <td><label><input type="checkbox" class="sched-charge-en" ${chargeEnabled ? 'checked' : ''} /> <input type="number" class="sched-charge-val" value="${chargeVal}" /></label></td>
    <td><button class="icon-btn sched-remove" title="Zeile entfernen">-</button></td>
  `;
  tr.querySelector('.sched-remove')?.addEventListener('click', () => tr.remove());

  const enableCb = tr.querySelector('.sched-row-enabled');
  const syncRowState = () => {
    tr.dataset.start = tr.querySelector('.sched-start')?.value || '';
    tr.dataset.end = tr.querySelector('.sched-end')?.value || '';
    updateScheduleRowVisualState(tr);
  };
  enableCb.addEventListener('change', syncRowState);
  tr.querySelector('.sched-start')?.addEventListener('change', syncRowState);
  tr.querySelector('.sched-end')?.addEventListener('change', syncRowState);
  syncRowState();

  tbody.appendChild(tr);
}

function clearScheduleRows() {
  const tbody = document.getElementById('scheduleRowsDash');
  if (tbody) tbody.innerHTML = '';
}

function collectScheduleRows() {
  const tbody = document.getElementById('scheduleRowsDash');
  if (!tbody) return [];
  const rules = [];
  let idx = 1;
  for (const tr of tbody.querySelectorAll('tr')) {
    const start = tr.querySelector('.sched-start')?.value;
    const end = tr.querySelector('.sched-end')?.value;
    if (!start || !end) continue;

    const rowEnabled = tr.querySelector('.sched-row-enabled')?.checked ?? true;

    const gridEn = tr.querySelector('.sched-grid-en')?.checked;
    const gridVal = Number(tr.querySelector('.sched-grid-val')?.value);
    const chargeEn = tr.querySelector('.sched-charge-en')?.checked;
    const chargeVal = Number(tr.querySelector('.sched-charge-val')?.value);

    if (gridEn && Number.isFinite(gridVal)) {
      rules.push({
        id: `grid_${idx}`,
        enabled: rowEnabled,
        target: 'gridSetpointW',
        start,
        end,
        value: gridVal
      });
    }
    if (chargeEn && Number.isFinite(chargeVal)) {
      rules.push({
        id: `charge_${idx}`,
        enabled: rowEnabled,
        target: 'chargeCurrentA',
        start,
        end,
        value: chargeVal
      });
    }
    idx++;
  }
  return rules;
}

async function loadScheduleDash() {
  const res = await apiFetch('/api/schedule');
  const data = await res.json();
  scheduleCache = data || { rules: [], config: {} };
  clearScheduleRows();
  const rules = Array.isArray(data.rules) ? data.rules : [];

  const timeSlots = new Map();
  for (const r of rules) {
    const key = `${r.start}|${r.end}`;
    if (!timeSlots.has(key)) {
      timeSlots.set(key, {
        start: r.start,
        end: r.end,
        grid: null,
        charge: null,
        enabled: r.enabled !== false
      });
    }
    const slot = timeSlots.get(key);
    if (r.target === 'gridSetpointW') slot.grid = r.value;
    if (r.target === 'chargeCurrentA') slot.charge = r.value;
    if (r.enabled === false) slot.enabled = false;
  }

  if (!timeSlots.size) {
    addScheduleRow();
  } else {
    for (const slot of timeSlots.values()) {
      addScheduleRow({
        start: slot.start || '06:45',
        end: slot.end || '07:15',
        gridVal: slot.grid ?? -40,
        chargeVal: slot.charge ?? '',
        gridEnabled: slot.grid != null,
        chargeEnabled: slot.charge != null,
        rowEnabled: slot.enabled
      });
    }
  }

  const defGrid = data?.config?.defaultGridSetpointW;
  if (defGrid != null) {
    const inp = document.getElementById('defaultGridSetpointInput');
    if (inp) inp.value = defGrid;
  }
  const defCharge = data?.config?.defaultChargeCurrentA;
  if (defCharge != null) {
    const inp = document.getElementById('defaultChargeCurrentInput');
    if (inp) inp.value = defCharge;
  }

  setControlMsg(`Schedule geladen (${fmtTs(Date.now())})`);
  applyScheduleRowStates();
}

async function saveScheduleDash() {
  const rules = collectScheduleRows();

  const r1 = await apiFetch('/api/schedule/rules', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rules })
  });
  const out1 = await r1.json();
  if (!r1.ok || !out1.ok) return setControlMsg(`Fehler Rules: ${out1.error || r1.status}`, true);

  const configBody = {};
  const defGridVal = Number(document.getElementById('defaultGridSetpointInput')?.value);
  if (Number.isFinite(defGridVal)) configBody.defaultGridSetpointW = defGridVal;
  const defChargeVal = Number(document.getElementById('defaultChargeCurrentInput')?.value);
  if (Number.isFinite(defChargeVal)) configBody.defaultChargeCurrentA = defChargeVal;

  if (Object.keys(configBody).length) {
    const r2 = await apiFetch('/api/schedule/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(configBody)
    });
    const out2 = await r2.json();
    if (!r2.ok || !out2.ok) return setControlMsg(`Fehler Defaults: ${out2.error || r2.status}`, true);
  }

  const gridCount = rules.filter((r) => r.target === 'gridSetpointW').length;
  const chargeCount = rules.filter((r) => r.target === 'chargeCurrentA').length;
  setControlMsg(`Gespeichert: ${gridCount} Grid + ${chargeCount} Charge Regeln`);
  await loadScheduleDash();
}

function handleGlobalChartMouseUp() {
  if (!chartSelectionState.pointerDown) return;

  chartSelectionState.pointerDown = false;
  const selectedIndices = getSelectedChartIndices();
  const shouldCreateSingleSlot = selectedIndices.length === 1 && !chartSelectionState.didDrag;
  chartSelectionState.anchorIndex = null;
  chartSelectionState.didDrag = false;

  if (shouldCreateSingleSlot) {
    createScheduleRowsFromChartSelection(selectedIndices);
    hideChartTooltip();
    return;
  }

  updateChartSelectionCallout();
}

function initDashboard() {
  document.getElementById('refreshEpex')?.addEventListener('click', refreshEpex);
  document.getElementById('loadScheduleBtn')?.addEventListener('click', loadScheduleDash);
  document.getElementById('saveScheduleBtn')?.addEventListener('click', saveScheduleDash);
  document.getElementById('addScheduleRowBtn')?.addEventListener('click', () => addScheduleRow());
  document.getElementById('manualGridBtn')?.addEventListener('click', manualWriteGrid);
  document.getElementById('manualChargeBtn')?.addEventListener('click', manualWriteCharge);
  document.getElementById('minSocRow')?.addEventListener('click', toggleMinSocEditor);
  document.getElementById('minSocRow')?.addEventListener('keydown', handleMinSocRowKeydown);
  document.getElementById('minSocSlider')?.addEventListener('input', (event) => {
    syncMinSocEditorPreview(event?.target?.value);
  });
  document.getElementById('minSocSubmitBtn')?.addEventListener('click', handleMinSocSubmit);
  document.getElementById('createSelectionScheduleBtn')?.addEventListener('click', () => {
    createScheduleRowsFromChartSelection();
  });

  window.addEventListener('mouseup', handleGlobalChartMouseUp);
  window.addEventListener('dvhub:unauthorized', () => {
    setControlMsg('API-Zugriff verweigert. Falls ein API-Token gesetzt ist, Seite mit ?token=DEIN_TOKEN öffnen.', true);
  });

  updateChartSelectionCallout();
  syncMinSocEditorPreview(document.getElementById('minSocSlider')?.value);
  loadScheduleDash().catch(() => {});
  requestDashboardRefresh().catch(() => {});
  setInterval(() => {
    requestDashboardRefresh().catch(() => {});
  }, 3000);
}

const dashboardApi = {
  buildScheduleWindowsFromSelection,
  computeMinSocRenderState,
  computeDynamicGrossImportCtKwh,
  createPriceChartScale,
  createMinSocPendingState,
  createDashboardRefreshTask,
  createRefreshCoordinator,
  formatChartEuroValue,
  getDashboardLogUrl,
  getChartHighlightSets,
  inferChartSlotMs,
  isScheduleWindowExpired,
  normalizeChartSelectionIndices,
  resolveMinSocPendingState,
  resolveDvControlIndicators,
  submitMinSocUpdate
};

if (typeof window !== 'undefined') {
  window.DVhubDashboard = dashboardApi;
}
if (typeof globalThis !== 'undefined') {
  globalThis.DVhubDashboard = dashboardApi;
}
if (typeof document !== 'undefined' && typeof document.getElementById === 'function') {
  initDashboard();
}
