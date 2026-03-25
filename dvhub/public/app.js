const { apiFetch } = window.DVhubCommon || {};
const SMALL_MARKET_AUTOMATION_SOURCE = 'small_market_automation';
const SMALL_MARKET_AUTOMATION_LABEL = 'kleine Börsenautomatik';
const SMA_ID_PREFIX = 'sma-';
function isSmallMarketAutomationRule(rule) {
  if (!rule || typeof rule !== 'object') return false;
  return rule.source === SMALL_MARKET_AUTOMATION_SOURCE
    || (typeof rule.id === 'string' && rule.id.startsWith(SMA_ID_PREFIX));
}

function fmtTs(ts) { return ts ? new Date(ts).toLocaleString('de-DE') : '-'; }
function fmtHm(ts) { return new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }); }
function fmtDmHm(ts) { return new Date(ts).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
function fmtCentValue(value, maximumFractionDigits = 2) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return '-';
  return `${numericValue.toLocaleString('de-DE', { minimumFractionDigits: 0, maximumFractionDigits })} Cent`;
}

function fmtCentFromCt(ct) {
  return fmtCentValue(ct);
}

function fmtCentFromTenthCt(value) {
  return fmtCentValue(Number(value) / 10);
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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

function updateFlowDiagram(status) {
  const gridTotal = Number(status?.meter?.grid_total_w || 0);
  const batPower = Number(status?.victron?.batteryPowerW || 0);
  const pvPower = Number(status?.victron?.pvTotalW || status?.victron?.pvPowerW || 0);
  const loadW = Number(status?.victron?.selfConsumptionW || 0);
  const soc = Number(status?.victron?.soc || 0);

  // Grid flow direction & node — use victron gridExportW/gridImportW for reliable direction
  const gridLine = document.getElementById('flowLineGrid');
  const gridNode = document.getElementById('flowNodeGridValue');
  const gridLabel = document.getElementById('flowNodeGridLabel');
  const gridExportW = Number(status?.victron?.gridExportW || 0);
  const gridImportW = Number(status?.victron?.gridImportW || 0);
  const isExport = gridExportW > gridImportW;
  const gridAbsW = isExport ? gridExportW : gridImportW;
  if (gridLine) {
    gridLine.setAttribute('stroke', isExport ? cssVar('--node-grid-export', '#3fb950') : cssVar('--node-grid-import', '#ff7b72'));
    gridLine.setAttribute('opacity', String(Math.min(gridAbsW / 5000, 1) * 0.6 + 0.2));
  }
  if (gridNode) {
    gridNode.textContent = `${gridAbsW} W`;
    gridNode.style.color = isExport ? 'var(--node-grid-export)' : 'var(--node-grid-import)';
  }
  if (gridLabel) gridLabel.textContent = isExport ? 'Export' : 'Import';

  // Battery flow
  const batLine = document.getElementById('flowLineBat');
  const batNode = document.getElementById('flowNodeBatValue');
  const batPowerNode = document.getElementById('flowNodeBatPower');
  if (batLine) {
    batLine.setAttribute('stroke', batPower < 0 ? cssVar('--node-bat', '#3fb950') : cssVar('--node-house', '#58a6ff'));
    batLine.setAttribute('opacity', String(Math.min(Math.abs(batPower) / 3000, 1) * 0.6 + 0.2));
  }
  if (batNode) batNode.textContent = `${soc} %`;
  if (batPowerNode) batPowerNode.textContent = `${batPower} W`;

  // PV flow
  const pvLine = document.getElementById('flowLinePV');
  const pvNode = document.getElementById('flowNodePvValue');
  if (pvLine) pvLine.setAttribute('opacity', String(Math.min(pvPower / 5000, 1) * 0.6 + 0.2));
  if (pvNode) pvNode.textContent = `${pvPower} W`;

  // House flow
  const houseLine = document.getElementById('flowLineHouse');
  const houseNode = document.getElementById('flowNodeHouseValue');
  if (houseLine) houseLine.setAttribute('opacity', String(Math.min(loadW / 5000, 1) * 0.6 + 0.2));
  if (houseNode) houseNode.textContent = loadW > 0 ? `${loadW} W` : 'Haus';

  // Center ring
  const centerNet = document.getElementById('flowCenterNet');
  const centerDir = document.getElementById('flowCenterDir');
  const c = status?.costs || {};
  if (centerNet) centerNet.textContent = c.netEur != null ? `${c.netEur.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €` : '-';
  if (centerDir) {
    centerDir.textContent = isExport ? 'Export' : 'Import';
    centerDir.style.color = isExport ? 'var(--ok)' : 'var(--danger)';
  }

  // SOC progress bar
  const socBar = document.getElementById('socBar');
  if (socBar) socBar.style.width = `${Math.max(0, Math.min(100, soc))}%`;
}

function initFlowDiagram() {
  const svg = document.getElementById('flowDiagram');
  if (!svg) return;

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const lines = [
    { id: 'flowLinePV', d: 'M 250,40 C 250,75 250,110 250,150', color: cssVar('--node-pv', '#e3b341') },
    { id: 'flowLineBat', d: 'M 70,200 C 120,200 160,200 195,200', color: cssVar('--node-bat', '#3fb950') },
    { id: 'flowLineHouse', d: 'M 305,200 C 340,200 380,200 430,200', color: cssVar('--node-house', '#58a6ff') },
    { id: 'flowLineGrid', d: 'M 250,250 C 250,290 250,330 250,380', color: cssVar('--ok', '#3fb950') }
  ];

  for (const { id, d, color } of lines) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('id', id);
    path.setAttribute('d', d);
    path.setAttribute('stroke', color);
    path.setAttribute('stroke-width', '2');
    path.setAttribute('fill', 'none');
    path.setAttribute('opacity', '0.3');
    svg.appendChild(path);

    if (prefersReducedMotion) continue;

    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('r', '4');
    circle.setAttribute('fill', color);
    circle.setAttribute('opacity', '0.6');
    const animate = document.createElementNS('http://www.w3.org/2000/svg', 'animateMotion');
    animate.setAttribute('dur', '3s');
    animate.setAttribute('repeatCount', 'indefinite');
    const mpath = document.createElementNS('http://www.w3.org/2000/svg', 'mpath');
    mpath.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', `#${id}`);
    animate.appendChild(mpath);
    circle.appendChild(animate);
    svg.appendChild(circle);
  }
}

function cssVar(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function roundCt(value) {
  return Number(Number(value || 0).toFixed(2));
}

function formatChartCentValue(value) {
  if (!Number.isFinite(Number(value))) return '-';
  return fmtCentValue(Number(value) * 100, 0);
}

function getChartHighlightSets(values, { highCount = 4, lowCount = 8, timestamps = [] } = {}) {
  const ranked = (Array.isArray(values) ? values : [])
    .map((value, index) => ({ value: Number(value), index }))
    .filter((entry) => Number.isFinite(entry.value));

  // Group entries by calendar day (00:00-24:00) when timestamps are available
  const hasTimestamps = Array.isArray(timestamps) && timestamps.length === (Array.isArray(values) ? values : []).length;
  const dayGroups = new Map();
  if (hasTimestamps) {
    for (const entry of ranked) {
      const ts = Number(timestamps[entry.index]);
      if (!Number.isFinite(ts)) continue;
      const dateKey = new Date(ts).toLocaleDateString('en-CA'); // YYYY-MM-DD
      if (!dayGroups.has(dateKey)) dayGroups.set(dateKey, []);
      dayGroups.get(dateKey).push(entry);
    }
  }

  const high = new Set();
  const low = new Set();

  if (dayGroups.size > 0) {
    // Per-day highlights
    for (const [, group] of dayGroups) {
      group
        .slice()
        .sort((left, right) => right.value - left.value)
        .slice(0, highCount)
        .forEach((entry) => high.add(entry.index));
      group
        .slice()
        .filter((entry) => entry.value < 0)
        .sort((left, right) => left.value - right.value)
        .slice(0, lowCount)
        .forEach((entry) => low.add(entry.index));
    }
  } else {
    // Fallback: global highlights (no timestamps)
    ranked
      .slice()
      .sort((left, right) => right.value - left.value)
      .slice(0, highCount)
      .forEach((entry) => high.add(entry.index));
    ranked
      .slice()
      .filter((entry) => entry.value < 0)
      .sort((left, right) => left.value - right.value)
      .slice(0, lowCount)
      .forEach((entry) => low.add(entry.index));
  }

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
  // Trigger redraw so the selectionHighlight plugin paints the overlay
  if (priceChartInstance) {
    cancelAnimationFrame(updateChartBarStates._raf);
    updateChartBarStates._raf = requestAnimationFrame(() => {
      if (priceChartInstance) priceChartInstance.draw();
    });
  }
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
  return `${Number(value).toLocaleString('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: digits })} ct/kWh`;
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

// (tooltip functions removed - using external Chart.js tooltip)

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

let priceChartInstance = null;

function drawPriceChart(data, nowTs, comparisons = [], automationSlotTimestamps = [], forecast = null, historySlots = []) {
  const canvas = document.getElementById('priceChartCanvas');
  const container = document.getElementById('priceChartContainer');
  const tooltip = document.getElementById('tooltip');
  if (!canvas || typeof Chart === 'undefined') return;

  chartSelectionState.data = Array.isArray(data) ? data : [];
  chartSelectionState.barElements = [];
  chartSelectionState.hoveredIndex = null;
  chartSelectionState.pointerDown = false;
  chartSelectionState.anchorIndex = null;
  chartSelectionState.didDrag = false;
  updateChartSelectionCallout();
  if (!Array.isArray(data) || data.length === 0) { canvas.style.display = 'none'; return; }
  canvas.style.display = '';

  // Destroy previous chart
  if (priceChartInstance) { priceChartInstance.destroy(); priceChartInstance = null; }

  // --- Colors ---
  const chartPositive = cssVar('--chart-positive', '#0077ff');
  const chartNegative = cssVar('--chart-negative', '#ef4444');
  const chartAutomation = cssVar('--schedule-automation-yellow', '#eab308');
  const chartPositiveHighlight = cssVar('--chart-positive-highlight', '#a8f000');
  const chartNegativeHighlight = cssVar('--chart-negative-highlight', '#ff7a59');
  const chartImport = cssVar('--chart-import', '#22c55e');
  const fcColor = '#f59e0b';

  // --- Data prep ---
  const comparisonByTs = new Map((comparisons || []).filter(Boolean).map((row) => [Number(row.ts), row]));
  const automationSlots = new Set((automationSlotTimestamps || []).map(Number));
  const vals = data.map((d) => Number(d.ct_kwh) / 100);
  const { high: highHighlights, low: lowHighlights } = getChartHighlightSets(vals, { timestamps: data.map((d) => d.ts) });

  const labels = data.map(d => new Date(d.ts));
  const prices = data.map(d => Number(d.ct_kwh));
  const importPrices = data.map(d => {
    const c = comparisonByTs.get(Number(d.ts));
    const v = Number(c?.importPriceCtKwh);
    return Number.isFinite(v) ? v : null;
  });

  // Build forecast series (interpolation from hourly to 15-min)
  let solarFc = data.map(() => null);
  if (forecast && Array.isArray(forecast.solar) && forecast.solar.length > 1) {
    const rawPoints = forecast.solar
      .map(p => ({ ts: new Date(p.ts).getTime(), kw: p.w / 1000 }))
      .sort((a, b) => a.ts - b.ts);
    let firstNonZero = rawPoints.findIndex(p => p.kw > 0);
    let lastNonZero = rawPoints.length - 1;
    while (lastNonZero > 0 && rawPoints[lastNonZero].kw <= 0) lastNonZero--;
    const fcPoints = firstNonZero >= 0 ? rawPoints.slice(firstNonZero, lastNonZero + 1) : [];
    solarFc = data.map(d => {
      const ts = Number(d.ts);
      if (fcPoints.length < 2) return null;
      if (ts < fcPoints[0].ts || ts > fcPoints[fcPoints.length - 1].ts) return null;
      for (let j = 0; j < fcPoints.length - 1; j++) {
        if (ts >= fcPoints[j].ts && ts <= fcPoints[j + 1].ts) {
          const ratio = (ts - fcPoints[j].ts) / (fcPoints[j + 1].ts - fcPoints[j].ts);
          const val = fcPoints[j].kw + ratio * (fcPoints[j + 1].kw - fcPoints[j].kw);
          return val > 0 ? val : null;
        }
      }
      if (ts === fcPoints[fcPoints.length - 1].ts) {
        const v = fcPoints[fcPoints.length - 1].kw;
        return v > 0 ? v : null;
      }
      return null;
    });
  }

  // --- Per-bar colors & alpha ---
  chartSelectionState.baseBarColors = null; // will be set after barColors built
  const barColors = data.map((d, i) => {
    const val = Number(d.ct_kwh);
    const ts = Number(d.ts);
    const isPast = ts < nowTs;
    const isAutomation = automationSlots.has(ts);
    const isHighPos = highHighlights.has(i);
    const isHighNeg = lowHighlights.has(i);
    let color = isAutomation ? chartAutomation
      : isHighNeg ? chartNegativeHighlight
      : isHighPos ? chartPositiveHighlight
      : (val < 0 ? chartNegative : chartPositive);
    // Apply alpha for past bars
    if (isPast) {
      // Convert hex to rgba with 0.30 alpha for past bars
      const r = parseInt(color.slice(1,3), 16);
      const g = parseInt(color.slice(3,5), 16);
      const b = parseInt(color.slice(5,7), 16);
      color = `rgba(${r},${g},${b},0.30)`;
    }
    return color;
  });

  chartSelectionState.baseBarColors = [...barColors];

  const hasForecast = solarFc.some(v => v != null && v > 0);
  const hasImport = importPrices.some(v => v != null);

  // --- Datasets ---
  const datasets = [
    {
      label: 'Börsenpreis',
      type: 'bar',
      data: prices,
      backgroundColor: barColors,
      borderColor: barColors,
      borderWidth: 0,
      barPercentage: 0.78,
      categoryPercentage: 0.88,
      yAxisID: 'y',
      order: 2
    }
  ];

  if (hasImport) {
    datasets.push({
      label: 'Bezugspreis',
      type: 'line',
      data: importPrices,
      borderColor: chartImport + '90',
      borderWidth: 1.5,
      borderDash: [6, 4],
      pointRadius: 0,
      pointHoverRadius: 3,
      fill: false,
      spanGaps: true,
      yAxisID: 'y',
      order: 1
    });
  }

  if (hasForecast) {
    datasets.push({
      label: '☀ PV Forecast',
      type: 'line',
      data: solarFc,
      borderColor: fcColor,
      backgroundColor: fcColor + '18',
      borderWidth: 2,
      borderDash: [6, 3],
      pointRadius: 0,
      pointHoverRadius: 3,
      fill: true,
      spanGaps: false,
      yAxisID: 'kw',
      order: 0
    });
  }

  // --- Consumption forecast (Lastvorhersage) ---
  if (forecast && Array.isArray(forecast.consumption) && forecast.consumption.length > 1) {
    const consFcRaw = forecast.consumption
      .map(p => ({ ts: new Date(p.ts).getTime(), kw: p.w / 1000 }))
      .sort((a, b) => a.ts - b.ts);
    const consFc = data.map(d => {
      const ts = Number(d.ts);
      if (consFcRaw.length < 2) return null;
      for (let j = 0; j < consFcRaw.length - 1; j++) {
        if (ts >= consFcRaw[j].ts && ts <= consFcRaw[j + 1].ts) {
          const ratio = (ts - consFcRaw[j].ts) / (consFcRaw[j + 1].ts - consFcRaw[j].ts);
          return consFcRaw[j].kw + ratio * (consFcRaw[j + 1].kw - consFcRaw[j].kw);
        }
      }
      return null;
    });
    if (consFc.some(v => v != null)) {
      datasets.push({
        label: '⚡ Lastvorhersage',
        type: 'line',
        data: consFc,
        borderColor: 'rgba(191,199,210,0.7)',
        borderWidth: 1.5,
        borderDash: [4, 3],
        pointRadius: 0,
        pointHoverRadius: 3,
        fill: false,
        spanGaps: true,
        yAxisID: 'kw',
        order: 0
      });
    }
  }

  // --- Actual PV production + Grid power from history slots ---
  if (Array.isArray(historySlots) && historySlots.length > 0) {
    const slotMap = new Map(historySlots.map(s => [new Date(s.ts).getTime(), s]));
    const pvActual = data.map(d => {
      const slot = slotMap.get(Number(d.ts));
      return slot ? (slot.pvKwh * 4) : null; // kWh per 15min → kW average
    });
    const gridActual = data.map(d => {
      const slot = slotMap.get(Number(d.ts));
      if (!slot) return null;
      const imp = Number(slot.importKwh || 0);
      const exp = Number(slot.exportKwh || 0);
      return (imp - exp) * 4; // kW (positive = import, negative = export)
    });
    const loadActual = data.map(d => {
      const slot = slotMap.get(Number(d.ts));
      return slot ? (slot.loadKwh * 4) : null;
    });

    if (pvActual.some(v => v != null && v > 0)) {
      datasets.push({
        label: '☀ PV Ist',
        type: 'line',
        data: pvActual,
        borderColor: '#f5c451',
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 3,
        fill: false,
        spanGaps: true,
        yAxisID: 'kw',
        order: 0
      });
    }
    if (loadActual.some(v => v != null && v > 0)) {
      datasets.push({
        label: '🏠 Verbrauch',
        type: 'line',
        data: loadActual,
        borderColor: 'rgba(191,199,210,0.9)',
        borderWidth: 1.5,
        pointRadius: 0,
        pointHoverRadius: 3,
        fill: false,
        spanGaps: true,
        yAxisID: 'kw',
        order: 0
      });
    }
    if (gridActual.some(v => v != null)) {
      datasets.push({
        label: '🔌 Netz',
        type: 'line',
        data: gridActual,
        borderColor: '#ff6b6b90',
        borderWidth: 1.5,
        pointRadius: 0,
        pointHoverRadius: 3,
        fill: false,
        spanGaps: true,
        yAxisID: 'kw',
        order: 0
      });
    }
  }

  // --- "Jetzt" annotation line ---
  const nowDate = new Date(nowTs);
  // Find closest data index for the now line
  let nowIdx = 0;
  for (let i = 0; i < data.length; i++) {
    if (Number(data[i].ts) <= nowTs) nowIdx = i;
  }

  // --- Chart.js config ---
  const config = {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      layout: { padding: { top: 24, right: 8, bottom: 0, left: 0 } },
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        legend: {
          display: true,
          position: 'bottom',
          labels: {
            color: '#9ca3af',
            font: { size: 11 },
            usePointStyle: true,
            padding: 16
          }
        },
        tooltip: {
          enabled: false,
          external: (context) => {
            const tt = document.getElementById('tooltip');
            if (!tt) return;
            const { tooltip: tip } = context;
            if (tip.opacity === 0) { tt.style.display = 'none'; return; }
            const idx = tip.dataPoints?.[0]?.dataIndex;
            if (idx == null) { tt.style.display = 'none'; return; }
            const row = data[idx];
            if (!row) { tt.style.display = 'none'; return; }
            const parts = [fmtDmHm(row.ts)];
            parts.push(`Börse: ${fmtCt(row.ct_kwh, 2)}`);
            const comp = comparisonByTs.get(Number(row.ts));
            if (comp) {
              if (comp.importPriceCtKwh != null) parts.push(`Bezug: ${fmtCt(comp.importPriceCtKwh, 2)}`);
              if (comp.pvMarginCtKwh != null) parts.push(`PV Marge: ${fmtSignedCt(comp.pvMarginCtKwh)}`);
              if (comp.batteryMarginCtKwh != null) parts.push(`Akku: ${fmtSignedCt(comp.batteryMarginCtKwh)}`);
            }
            for (const dp of (tip.dataPoints || [])) {
              if (dp.dataset?.label?.includes('Forecast') && dp.raw != null) {
                parts.push(`PV Fc: ${Number(dp.raw).toFixed(1)} kW`);
              }
            }
            tt.innerHTML = parts.join(' <span style="opacity:0.4">|</span> ');
            tt.style.display = 'block';
            const rect = context.chart.canvas.getBoundingClientRect();
            const x = rect.left + tip.caretX + 14;
            const y = rect.top + tip.caretY - 10;
            tt.style.left = Math.min(x, window.innerWidth - tt.offsetWidth - 8) + 'px';
            tt.style.top = Math.max(4, y) + 'px';
          }
        },
        annotation: {
          annotations: {
            nowLine: {
              type: 'line',
              xMin: nowIdx,
              xMax: nowIdx,
              borderColor: '#facc15',
              borderWidth: 2.5,
              borderDash: [],
              label: {
                display: true,
                content: 'Jetzt',
                position: 'end',
                backgroundColor: '#1a1a2eee',
                color: '#facc15',
                font: { weight: 'bold', size: 11 },
                padding: { top: 2, bottom: 2, left: 4, right: 4 }
              }
            }
          }
        },
        zoom: {
          pan: {
            enabled: true,
            mode: 'x',
            modifierKey: 'shift'
          },
          zoom: {
            wheel: { enabled: true, modifierKey: null },
            pinch: { enabled: true },
            drag: { enabled: false },
            mode: 'x'
          },
          limits: {
            x: { minRange: 4 }
          }
        }
      },
      scales: {
        x: {
          type: 'category',
          ticks: {
            color: '#9ca3af',
            font: { size: 10 },
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 24,
            callback: function(value, index) {
              const d = data[index];
              if (!d) return '';
              const date = new Date(d.ts);
              const m = date.getMinutes();
              if (m === 0) return date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', hour12: false });
              return '';
            }
          },
          grid: { color: '#e5e7eb20', lineWidth: 1 }
        },
        y: {
          position: 'left',
          title: { display: true, text: 'ct/kWh', color: '#9ca3af', font: { size: 11 } },
          ticks: { color: '#9ca3af', font: { size: 10 } },
          grid: { color: '#e5e7eb20', lineWidth: 1 },
          beginAtZero: true
        },
        kw: {
          position: 'right',
          display: hasForecast,
          title: { display: true, text: 'kW', color: fcColor, font: { size: 11 } },
          ticks: { color: fcColor + '90', font: { size: 10 } },
          grid: { display: false },
          beginAtZero: true,
          min: 0,
          suggestedMax: Math.max(...datasets.filter(d => d.yAxisID === 'kw').flatMap(d => d.data).filter(v => v != null && Number.isFinite(v)), 1) * 1.15
        }
      }
    }
  };

  // Set canvas container height
  container.style.height = '380px';

  // Negative zone plugin - highlights negative-price time slots with a full-height
  // red tint and draws a dashed zero line when negative values are visible.
  const negativeZonePlugin = {
    id: 'negativeZone',
    beforeDatasetsDraw(chart) {
      const yScale = chart.scales.y;
      const ctx = chart.ctx;
      const { top, bottom, left, right } = chart.chartArea;

      // Full-height red tint behind each negative bar
      const ds = chart.data.datasets.findIndex(d => d.label === 'Börsenpreis');
      if (ds >= 0) {
        const meta = chart.getDatasetMeta(ds);
        ctx.save();
        ctx.fillStyle = 'rgba(239, 68, 68, 0.10)';
        meta.data.forEach((bar, i) => {
          const val = Number(data[i]?.ct_kwh);
          if (val < 0) {
            ctx.fillRect(bar.x - bar.width / 2, top, bar.width, bottom - top);
          }
        });
        ctx.restore();
      }

      // Dashed zero line when negative values exist
      if (yScale && yScale.min < 0) {
        const zeroPixel = yScale.getPixelForValue(0);
        if (zeroPixel < bottom) {
          ctx.save();
          ctx.strokeStyle = 'rgba(239, 68, 68, 0.40)';
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(left, zeroPixel);
          ctx.lineTo(right, zeroPixel);
          ctx.stroke();
          ctx.restore();
        }
      }
    }
  };

  // Selection overlay plugin - draws highlight over selected bars
  const selectionHighlightPlugin = {
    id: 'selectionHighlight',
    afterDatasetsDraw(chart) {
      const selected = new Set(getSelectedChartIndices());
      if (!selected.size) return;
      const ds = chart.data.datasets.findIndex(d => d.label === "Börsenpreis");
      if (ds < 0) return;
      const meta = chart.getDatasetMeta(ds);
      const ctx = chart.ctx;
      // Dim all non-selected bars
      meta.data.forEach((bar, i) => {
        if (!selected.has(i)) {
          ctx.save();
          ctx.fillStyle = 'rgba(10, 20, 40, 0.6)';
          ctx.fillRect(bar.x - bar.width / 2, chart.chartArea.top, bar.width, chart.chartArea.bottom - chart.chartArea.top);
          ctx.restore();
        }
      });
      // Highlight selected bars with bright border
      meta.data.forEach((bar, i) => {
        if (selected.has(i)) {
          ctx.save();
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 2;
          ctx.strokeRect(bar.x - bar.width / 2, bar.y, bar.width, bar.base - bar.y);
          ctx.restore();
        }
      });
    }
  };
  config.plugins = [negativeZonePlugin, selectionHighlightPlugin, ...(config.plugins || [])];

  priceChartInstance = new Chart(canvas, config);

  // --- Click selection for schedule creation ---
  canvas.addEventListener('mouseleave', () => {
    const tt = document.getElementById('tooltip');
    if (tt) tt.style.display = 'none';
  });
  canvas.addEventListener('mousedown', (e) => {
    if (e.shiftKey) return; // Shift+drag = pan (let zoom plugin handle it)
    const elements = priceChartInstance.getElementsAtEventForMode(e, 'index', { intersect: false }, false);
    if (!elements.length) return;
    const idx = elements[0].index;
    if (idx < 0 || idx >= data.length) return;
    e.preventDefault();
    e.stopPropagation();
    chartSelectionState.pointerDown = true;
    chartSelectionState.anchorIndex = idx;
    chartSelectionState.didDrag = false;
    chartSelectionState.hoveredIndex = idx;
    setChartSelection(data, [idx]);
  });
  canvas.addEventListener('mousemove', (e) => {
    if (e.shiftKey) return; // Shift+drag = pan
    const elements = priceChartInstance.getElementsAtEventForMode(e, 'index', { intersect: false }, false);
    if (!elements.length) return;
    const idx = elements[0].index;
    if (idx < 0 || idx >= data.length) return;
    chartSelectionState.hoveredIndex = idx;
    if (chartSelectionState.pointerDown && chartSelectionState.anchorIndex != null) {
      e.preventDefault();
      chartSelectionState.didDrag = chartSelectionState.didDrag || idx !== chartSelectionState.anchorIndex;
      setChartSelection(data, buildChartSelectionRange(chartSelectionState.anchorIndex, idx));
    }
  });
  canvas.addEventListener('mouseup', () => {
    chartSelectionState.pointerDown = false;
  });
  canvas.addEventListener('mouseleave', () => {
    chartSelectionState.pointerDown = false;
    chartSelectionState.hoveredIndex = null;
  });
  // Double-click to reset zoom
  canvas.addEventListener('dblclick', () => {
    if (priceChartInstance) priceChartInstance.resetZoom();
  });
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
    ? Math.round(Number(value) / 5) * 5
    : (Number.isFinite(fallbackValue) ? Math.round(fallbackValue / 5) * 5 : 20);
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
  setText('priceNow', s?.current ? fmtCentFromCt(s.current.ct_kwh) : '-', s?.current && Number(s.current.ct_kwh) < 0 ? 'off' : 'ok');
  setText('priceNext', s?.next ? `${fmtDmHm(s.next.ts)} (${fmtCentFromCt(s.next.ct_kwh)})` : '-');
  setText('negLater', s ? (s.hasFutureNegative ? 'Ja' : 'Nein') : '-');
  setText('negTomorrow', s ? (s.tomorrowNegative ? 'Ja' : 'Nein') : '-');
  setText(
    'todayMinMax',
    s && s.todayMin != null && s.todayMax != null
      ? `${fmtCentFromTenthCt(Number(s.todayMin))} / ${fmtCentFromTenthCt(Number(s.todayMax))}`
      : '-'
  );
  const negActive = status.ctrl?.negativePriceActive;
  setText('negPriceProtection', negActive ? 'AKTIV (Abregelung)' : 'Inaktiv', negActive ? 'off' : 'ok');
  setText(
    'tomorrowMinMax',
    s && s.tomorrowMin != null && s.tomorrowMax != null
      ? `${fmtCentFromTenthCt(Number(s.tomorrowMin))} / ${fmtCentFromTenthCt(Number(s.tomorrowMax))}`
      : '-'
  );

  setText('l1', `${status.meter?.grid_l1_w ?? '-'} W`);
  setText('l2', `${status.meter?.grid_l2_w ?? '-'} W`);
  setText('l3', `${status.meter?.grid_l3_w ?? '-'} W`);
  setText('total', `${status.meter?.grid_total_w ?? '-'} W`, status.meter?.grid_total_w < 0 ? 'ok' : (status.meter?.grid_total_w > 0 ? 'off' : ''));
  updateFlowDiagram(status);

  const vic = status.victron || {};
  setText('soc', vic.soc == null ? '-' : `${vic.soc} %`);
  setText('batP', vic.batteryPowerW == null ? '-' : `${vic.batteryPowerW} W`);
  setText('pvP', vic.pvPowerW == null ? '-' : `${vic.pvPowerW} W`);
  setText('pvAc', vic.pvAcW == null ? '-' : `${vic.pvAcW} W`);
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
  const adc = sch.active?.feedExcessDcPv;
  setText('activeDcFeed', adc?.value == null ? '-' : `${adc.value ? 'EIN' : 'AUS'} (${adc.source || '-'})`);
  const lwParts = [];
  if (lwG?.at) lwParts.push(`Grid: ${lwG.value} @ ${fmtTs(lwG.at)}`);
  if (lwC?.at) lwParts.push(`Charge: ${lwC.value} @ ${fmtTs(lwC.at)}`);
  if (lwM?.at) lwParts.push(`MinSOC: ${lwM.value} @ ${fmtTs(lwM.at)}`);
  setText('lastControlWrite', lwParts.length ? lwParts.join(' | ') : '-');
  applyScheduleRowStates(status.now);
  updateChartComparisonSummary(status.userEnergyPricing);

  // Fetch forecast + history slots for chart overlay
  const today = new Date(status.now).toISOString().slice(0, 10);
  const chartArgs = () => [status.epex?.data || [], status.now, status.userEnergyPricing?.slots || [], status?.schedule?.smallMarketAutomation?.selectedSlotTimestamps || []];
  Promise.all([
    apiFetch('/api/forecast').then(r => r.json()).catch(() => null),
    apiFetch(`/api/history/summary?view=day&date=${today}`).then(r => r.json()).catch(() => null)
  ]).then(([fc, hist]) => {
    drawPriceChart(...chartArgs(), fc?.ok ? fc : null, hist?.slots || []);
  }).catch(() => {
    drawPriceChart(...chartArgs(), null, []);
  });
  setText('chartMeta', `EPEX Update: ${fmtTs(status.epex?.updatedAt)} | Datapoints: ${(status.epex?.data || []).length}`);

  renderAutomationStatus(status.schedule);
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

function collectScheduleRulesFromRowState(rows) {
  if (!Array.isArray(rows)) return [];
  const rules = [];
  let idx = 1;

  for (const row of rows) {
    const start = row?.start;
    const end = row?.end;
    if (!start || !end) {
      idx++;
      continue;
    }

    const rowEnabled = row?.rowEnabled ?? row?.enabled ?? true;
    const gridEnabled = row?.gridEnabled ?? row?.grid != null;
    const chargeEnabled = row?.chargeEnabled ?? row?.charge != null;
    const stopSocEnabled = row?.stopSocEnabled ?? row?.stopSocPct != null;

    const gridVal = Number(row?.gridVal ?? row?.grid);
    const chargeVal = Number(row?.chargeVal ?? row?.charge);
    const stopSocVal = Number(row?.stopSocVal ?? row?.stopSocPct);

    if (gridEnabled && Number.isFinite(gridVal)) {
      const gridRule = {
        id: `grid_${idx}`,
        enabled: rowEnabled,
        target: 'gridSetpointW',
        start,
        end,
        value: gridVal
      };
      if (row?.source) gridRule.source = row.source;
      if (row?.autoManaged != null) gridRule.autoManaged = Boolean(row.autoManaged);
      if (row?.displayTone) gridRule.displayTone = row.displayTone;
      if (row?.activeDate) gridRule.activeDate = row.activeDate;
      if (stopSocEnabled && Number.isFinite(stopSocVal)) {
        gridRule.stopSocPct = stopSocVal;
      }
      rules.push(gridRule);
    }

    if (chargeEnabled && Number.isFinite(chargeVal)) {
      const chargeRule = {
        id: `charge_${idx}`,
        enabled: rowEnabled,
        target: 'chargeCurrentA',
        start,
        end,
        value: chargeVal
      };
      if (row?.source) chargeRule.source = row.source;
      if (row?.autoManaged != null) chargeRule.autoManaged = Boolean(row.autoManaged);
      if (row?.displayTone) chargeRule.displayTone = row.displayTone;
      if (row?.activeDate) chargeRule.activeDate = row.activeDate;
      rules.push(chargeRule);
    }

    // DC Export Mode rule
    if (row?.dcExportEnabled) {
      rules.push({
        id: `dcexport_${idx}`,
        enabled: rowEnabled,
        target: 'dcExportMode',
        start,
        end,
        value: 1
      });
    }

    idx++;
  }

  return rules;
}

function groupScheduleRulesForDashboard(rules) {
  if (!Array.isArray(rules)) return [];

  const timeSlots = new Map();
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue;
    const key = `${rule.start}|${rule.end}`;
    if (!timeSlots.has(key)) {
      timeSlots.set(key, {
        start: rule.start,
        end: rule.end,
        grid: null,
        charge: null,
        stopSocPct: null,
        dcExport: false,
        enabled: rule.enabled !== false
      });
    }
    const slot = timeSlots.get(key);
    if (rule.target === 'gridSetpointW') {
      slot.grid = rule.value;
      const stopSocPct = Number(rule.stopSocPct);
      slot.stopSocPct = Number.isFinite(stopSocPct) ? stopSocPct : null;
    }
    if (rule.target === 'chargeCurrentA') slot.charge = rule.value;
    if (rule.target === 'dcExportMode') slot.dcExport = true;
    if (rule.enabled === false) slot.enabled = false;
    if (!slot.ruleId && rule.id) slot.ruleId = rule.id;
    if (!slot.source && rule.source) slot.source = rule.source;
    if (!slot.displayTone && rule.displayTone) slot.displayTone = rule.displayTone;
    if (slot.autoManaged !== true && rule.autoManaged === true) slot.autoManaged = true;
    if (!slot.activeDate && rule.activeDate) slot.activeDate = rule.activeDate;
  }

  return Array.from(timeSlots.values());
}

function updateScheduleRowVisualState(tr, nowTs = Date.now()) {
  if (!tr) return false;
  const enabled = tr.querySelector('.sched-row-enabled')?.checked ?? true;
  const expired = isScheduleWindowExpired({
    start: tr.dataset.start || tr.querySelector('.sched-start')?.value,
    end: tr.dataset.end || tr.querySelector('.sched-end')?.value
  }, nowTs);
  const isAutomationRule =
    tr.dataset.ruleSource === SMALL_MARKET_AUTOMATION_SOURCE
    || tr.dataset.displayTone === 'yellow'
    || (tr.dataset.ruleId || '').startsWith(SMA_ID_PREFIX);

  tr.classList.toggle('sched-row-expired', expired);
  tr.classList.toggle('sched-row-automation', isAutomationRule);
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
    gridVal = -40, chargeVal = '', stopSocVal = '',
    gridEnabled = true, chargeEnabled = false, stopSocEnabled = false,
    dcExportEnabled = false,
    rowEnabled = true,
    ruleId = '',
    source = '',
    displayTone = '',
    autoManaged = false,
    activeDate = ''
  } = opts;
  const tbody = document.getElementById('scheduleRowsDash');
  if (!tbody) return;
  const tr = document.createElement('tr');
  tr.dataset.ruleId = ruleId || '';
  tr.dataset.ruleSource = source || '';
  tr.dataset.displayTone = displayTone || '';
  tr.dataset.autoManaged = autoManaged ? 'true' : 'false';
  tr.dataset.activeDate = activeDate || '';
  const isAutomation = source === SMALL_MARKET_AUTOMATION_SOURCE
    || (typeof ruleId === 'string' && ruleId.startsWith(SMA_ID_PREFIX));
  if (isAutomation) {
    tr.title = `${SMALL_MARKET_AUTOMATION_LABEL}${activeDate ? ` (${activeDate})` : ''} — automatisch verwaltet`;
  }

  const disabled = isAutomation ? 'disabled' : '';
  tr.innerHTML = `
    <td><input type="checkbox" class="sched-row-enabled" ${rowEnabled ? 'checked' : ''} ${disabled} title="${escapeAttr(isAutomation ? 'Automatisch verwaltet' : 'Aktiv')}" /></td>
    <td><input type="time" class="sched-start" value="${escapeAttr(start)}" ${disabled} /></td>
    <td><input type="time" class="sched-end" value="${escapeAttr(end)}" ${disabled} /></td>
    <td><label><input type="checkbox" class="sched-grid-en" ${gridEnabled ? 'checked' : ''} ${disabled} /> <input type="number" class="sched-grid-val" value="${escapeAttr(gridVal)}" ${disabled} /></label></td>
    <td><label><input type="checkbox" class="sched-charge-en" ${chargeEnabled ? 'checked' : ''} ${disabled} /> <input type="number" class="sched-charge-val" value="${escapeAttr(chargeVal)}" ${disabled} /></label></td>
    <td><label><input type="checkbox" class="sched-stop-soc-en" ${stopSocEnabled ? 'checked' : ''} ${disabled} /> <input type="number" class="sched-stop-soc-val" value="${escapeAttr(stopSocVal)}" min="0" max="100" step="5" ${disabled} /></label></td>
    <td><input type="checkbox" class="sched-dc-export" ${dcExportEnabled ? 'checked' : ''} ${disabled} title="DC-PV einspeisen statt laden" /></td>
    <td>${isAutomation ? '<span class="sched-auto-badge" title="Von der kleinen Börsenautomatik verwaltet">Auto</span>' : '<button class="icon-btn sched-remove" title="Zeile entfernen">-</button>'}</td>
  `;
  if (!isAutomation) {
    tr.querySelector('.sched-remove')?.addEventListener('click', () => tr.remove());
  }

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
  const rowState = [];
  for (const tr of tbody.querySelectorAll('tr')) {
    // Skip automation-managed rows — they are handled server-side
    if (tr.dataset.ruleSource === SMALL_MARKET_AUTOMATION_SOURCE
      || (tr.dataset.ruleId || '').startsWith(SMA_ID_PREFIX)) continue;
    const start = tr.querySelector('.sched-start')?.value;
    const end = tr.querySelector('.sched-end')?.value;
    if (!start || !end) continue;

    rowState.push({
      start,
      end,
      rowEnabled: tr.querySelector('.sched-row-enabled')?.checked ?? true,
      gridEnabled: tr.querySelector('.sched-grid-en')?.checked,
      gridVal: tr.querySelector('.sched-grid-val')?.value,
      chargeEnabled: tr.querySelector('.sched-charge-en')?.checked,
      chargeVal: tr.querySelector('.sched-charge-val')?.value,
      stopSocEnabled: tr.querySelector('.sched-stop-soc-en')?.checked,
      stopSocVal: tr.querySelector('.sched-stop-soc-val')?.value,
      dcExportEnabled: tr.querySelector('.sched-dc-export')?.checked ?? false,
      source: tr.dataset.ruleSource || '',
      displayTone: tr.dataset.displayTone || '',
      autoManaged: tr.dataset.autoManaged === 'true',
      activeDate: tr.dataset.activeDate || ''
    });
  }
  return collectScheduleRulesFromRowState(rowState);
}

async function loadScheduleDash() {
  const res = await apiFetch('/api/schedule');
  const data = await res.json();
  scheduleCache = data || { rules: [], config: {} };
  clearScheduleRows();
  const rules = Array.isArray(data.rules) ? data.rules : [];
  const timeSlots = groupScheduleRulesForDashboard(rules);

  if (!timeSlots.length) {
    addScheduleRow();
  } else {
    for (const slot of timeSlots) {
      addScheduleRow({
        start: slot.start || '06:45',
        end: slot.end || '07:15',
        gridVal: slot.grid ?? -40,
        chargeVal: slot.charge ?? '',
        stopSocVal: slot.stopSocPct ?? '',
        gridEnabled: slot.grid != null,
        chargeEnabled: slot.charge != null,
        stopSocEnabled: slot.stopSocPct != null,
        dcExportEnabled: slot.dcExport === true,
        rowEnabled: slot.enabled,
        ruleId: slot.ruleId,
        source: slot.source,
        displayTone: slot.displayTone,
        autoManaged: slot.autoManaged,
        activeDate: slot.activeDate
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
  const defDcFeed = data?.config?.defaultFeedExcessDcPv;
  if (defDcFeed != null) {
    const inp = document.getElementById('defaultFeedExcessDcPvInput');
    if (inp) inp.value = defDcFeed;
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
  const defDcFeedVal = Number(document.getElementById('defaultFeedExcessDcPvInput')?.value);
  if (defDcFeedVal === 0 || defDcFeedVal === 1) configBody.defaultFeedExcessDcPv = defDcFeedVal;

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
  const dcExportCount = rules.filter((r) => r.target === 'dcExportMode').length;
  const dcPart = dcExportCount ? ` + ${dcExportCount} DC-Export` : '';
  setControlMsg(`Gespeichert: ${gridCount} Grid + ${chargeCount} Charge${dcPart} Regeln`);
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
    const _tt = document.getElementById('tooltip'); if (_tt) _tt.style.display = 'none';
    return;
  }

  updateChartSelectionCallout();
}

// --- Kleine Börsenautomatik Dashboard Panel ---
let automationStagesDraft = [];

function createEmptyAutomationStage(index = 0) {
  return {
    id: `sma-stage-${index + 1}`,
    dischargeW: '',
    dischargeSlots: '',
    cooldownW: '',
    cooldownSlots: ''
  };
}

function addAutomationStage() {
  automationStagesDraft = [...automationStagesDraft, createEmptyAutomationStage(automationStagesDraft.length)];
  renderAutomationStages();
}

function removeAutomationStage(stageId) {
  automationStagesDraft = automationStagesDraft.filter((s) => s.id !== stageId);
  renderAutomationStages();
}

function serializeAutomationStages(stages = []) {
  return stages.map((stage) => ({
    dischargeW: stage.dischargeW === '' || stage.dischargeW == null ? null : Number(stage.dischargeW),
    dischargeSlots: stage.dischargeSlots === '' || stage.dischargeSlots == null ? null : Number(stage.dischargeSlots),
    cooldownW: stage.cooldownW === '' || stage.cooldownW == null ? null : Number(stage.cooldownW),
    cooldownSlots: stage.cooldownSlots === '' || stage.cooldownSlots == null ? null : Number(stage.cooldownSlots)
  }));
}

function renderAutomationStages() {
  const container = document.getElementById('automationStagesContainer');
  if (!container) return;
  container.innerHTML = '';

  automationStagesDraft.forEach((stage, index) => {
    const card = document.createElement('article');
    card.className = 'pricing-period-card';
    card.dataset.automationStageId = stage.id;
    card.innerHTML = `
      <div class="pricing-period-grid">
        <label class="settings-field">
          <span>Entladeleistung (W, negativ = Einspeisung)</span>
          <input type="number" data-stage-field="dischargeW" value="${stage.dischargeW}" />
        </label>
        <label class="settings-field">
          <span>Entlade-Slots (je 15 Min.)</span>
          <input type="number" min="0" data-stage-field="dischargeSlots" value="${stage.dischargeSlots}" />
        </label>
        <label class="settings-field">
          <span>Cooldown-Leistung (W, negativ = Einspeisung)</span>
          <input type="number" data-stage-field="cooldownW" value="${stage.cooldownW}" />
        </label>
        <label class="settings-field">
          <span>Cooldown-Slots (je 15 Min.)</span>
          <input type="number" min="0" data-stage-field="cooldownSlots" value="${stage.cooldownSlots}" />
        </label>
      </div>
      <button class="btn-small btn-danger remove-stage-btn" data-remove-stage="${stage.id}">Stufe entfernen</button>
    `;
    container.appendChild(card);
  });

  // Bind events
  container.querySelectorAll('.remove-stage-btn').forEach((btn) => {
    btn.addEventListener('click', () => removeAutomationStage(btn.dataset.removeStage));
  });
  container.querySelectorAll('[data-stage-field]').forEach((input) => {
    input.addEventListener('change', (e) => {
      const card = e.target.closest('[data-automation-stage-id]');
      const stageId = card?.dataset.automationStageId;
      const field = e.target.dataset.stageField;
      const stage = automationStagesDraft.find((s) => s.id === stageId);
      if (stage) { stage[field] = e.target.value; }
    });
  });
}

async function loadAutomationConfig() {
  try {
    const res = await apiFetch('/api/schedule/automation/config');
    const data = await res.json();
    if (!data.ok) return;
    const c = data.config || {};

    const el = (id) => document.getElementById(id);
    if (el('automationEnabled')) el('automationEnabled').checked = !!c.enabled;
    if (el('automationSearchStart')) el('automationSearchStart').value = c.searchWindowStart || '14:00';
    if (el('automationSearchEnd')) el('automationSearchEnd').value = c.searchWindowEnd || '09:00';
    if (el('automationBatteryCapacity')) el('automationBatteryCapacity').value = c.batteryCapacityKwh ?? '';
    if (el('automationInverterEfficiency')) el('automationInverterEfficiency').value = c.inverterEfficiencyPct ?? 85;
    if (el('automationMaxDischargeW')) el('automationMaxDischargeW').value = c.maxDischargeW ?? -12000;
    if (el('automationMinSocPct')) el('automationMinSocPct').value = c.minSocPct ?? 30;

    // Load stages
    automationStagesDraft = (c.stages || []).map((s, i) => ({
      id: `sma-stage-${i + 1}`,
      dischargeW: s.dischargeW ?? '',
      dischargeSlots: s.dischargeSlots ?? '',
      cooldownW: s.cooldownW ?? '',
      cooldownSlots: s.cooldownSlots ?? ''
    }));
    renderAutomationStages();
  } catch (e) {
    console.error('Failed to load automation config:', e);
  }
}

async function saveAutomationConfig() {
  const el = (id) => document.getElementById(id);
  const config = {
    enabled: el('automationEnabled')?.checked ?? false,
    searchWindowStart: el('automationSearchStart')?.value || '14:00',
    searchWindowEnd: el('automationSearchEnd')?.value || '09:00',
    batteryCapacityKwh: el('automationBatteryCapacity')?.value ? Number(el('automationBatteryCapacity').value) : null,
    inverterEfficiencyPct: Number(el('automationInverterEfficiency')?.value) || 85,
    maxDischargeW: Number(el('automationMaxDischargeW')?.value) || -12000,
    minSocPct: Number(el('automationMinSocPct')?.value) || 30,
    stages: serializeAutomationStages(automationStagesDraft)
  };

  try {
    const res = await apiFetch('/api/schedule/automation/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(config)
    });
    const data = await res.json();
    if (data.ok) {
      setControlMsg('Automation gespeichert \u2713 ' + new Date().toLocaleTimeString('de-DE'));
      // Reload schedule to see regenerated rules
      loadScheduleDash();
    }
  } catch (e) {
    console.error('Failed to save automation config:', e);
  }
}

function renderAutomationStatus(scheduleData) {
  const sma = scheduleData?.smallMarketAutomation;
  if (!sma) return;

  const titleEl = document.getElementById('automationStatusTitle');
  const outcomeEl = document.getElementById('automationOutcome');
  const countEl = document.getElementById('automationRuleCount');
  const energyEl = document.getElementById('automationAvailableEnergy');

  const enabledEl = document.getElementById('automationEnabled');
  const isEnabled = enabledEl?.checked;

  if (titleEl) titleEl.textContent = isEnabled ? 'Aktiv' : 'Inaktiv';

  const outcomeLabels = {
    idle: 'Warte auf Ausführung',
    disabled: 'Deaktiviert',
    generated: 'Regeln generiert',
    no_slots: 'Keine passenden Slots',
    missing_sun_times_cache: 'Sonnendaten fehlen'
  };
  if (outcomeEl) outcomeEl.textContent = outcomeLabels[sma.lastOutcome] || sma.lastOutcome || '\u2014';
  if (countEl) countEl.textContent = sma.generatedRuleCount != null ? `${sma.generatedRuleCount} Regeln aktiv` : '';
  if (energyEl) {
    energyEl.textContent = sma.availableEnergyKwh != null
      ? `${sma.availableEnergyKwh} kWh verfügbar`
      : '';
  }

  // Render plan summary
  const planContainer = document.getElementById('automationPlanSummary');
  const plan = sma.plan;
  if (!planContainer) return;

  if (!plan || !plan.selectedSlots?.length) {
    planContainer.style.display = 'none';
    return;
  }

  planContainer.style.display = '';
  const computedEl = document.getElementById('planComputedAt');
  const budgetEl = document.getElementById('planEnergyBudget');
  const revenueEl = document.getElementById('planEstimatedRevenue');

  if (computedEl) {
    const d = new Date(plan.computedAt);
    computedEl.textContent = `Berechnet: ${d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`;
  }
  if (budgetEl) {
    const parts = [];
    if (plan.availableEnergyKwh != null) parts.push(`${plan.availableEnergyKwh} kWh Energie`);
    if (plan.currentSocPct != null) parts.push(`SOC ${plan.currentSocPct}% \u2192 ${plan.minSocPct ?? 0}%`);
    budgetEl.textContent = parts.join(' \u2022 ') || '\u2014';
  }
  if (revenueEl) {
    const eur = plan.estimatedRevenueCt != null ? (Math.round(plan.estimatedRevenueCt * 100) / 100).toFixed(2) : null;
    revenueEl.textContent = eur != null ? `\u2248 ${eur} \u20ac Erl\u00f6s` : '';
  }

  const tbody = document.getElementById('planSlotRows');
  if (tbody) {
    tbody.innerHTML = '';
    for (const slot of plan.selectedSlots) {
      const tr = document.createElement('tr');
      tr.className = 'sched-row-automation';
      const powerLabel = slot.powerW != null ? `${Number(slot.powerW).toLocaleString('de-DE')} W` : '\u2014';
      tr.innerHTML = `<td>${escapeAttr(slot.time || '\u2014')}</td><td>${escapeAttr(powerLabel)}</td><td>${escapeAttr(slot.priceCtKwh != null ? (Number(slot.priceCtKwh)).toFixed(2) : '\u2014')} ct/kWh</td>`;
      tbody.appendChild(tr);
    }
  }
}

function initDashboard() {
  initFlowDiagram();
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

  // --- Dedicated "Defaults speichern" button ---
  document.getElementById('saveDefaultsBtn')?.addEventListener('click', async () => {
    const configBody = {};
    const defGridVal = Number(document.getElementById('defaultGridSetpointInput')?.value);
    if (Number.isFinite(defGridVal)) configBody.defaultGridSetpointW = defGridVal;
    const defChargeVal = Number(document.getElementById('defaultChargeCurrentInput')?.value);
    if (Number.isFinite(defChargeVal)) configBody.defaultChargeCurrentA = defChargeVal;
    if (!Object.keys(configBody).length) { setControlMsg('Keine Werte zum Speichern.'); return; }
    try {
      const r = await apiFetch('/api/schedule/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(configBody)
      });
      const out = await r.json();
      if (!r.ok || !out.ok) { setControlMsg(`Fehler: ${out.error || r.status}`, true); return; }
      setControlMsg(`Defaults gespeichert: Grid ${defGridVal}W, Charge ${defChargeVal}A`);
      await loadScheduleDash();
    } catch (e) { setControlMsg(`Fehler: ${e.message}`, true); }
  });
  document.getElementById('minSocSubmitBtn')?.addEventListener('click', handleMinSocSubmit);
  document.getElementById('createSelectionScheduleBtn')?.addEventListener('click', () => {
    createScheduleRowsFromChartSelection();
  });

  window.addEventListener('mouseup', handleGlobalChartMouseUp);
  window.addEventListener('dvhub:unauthorized', () => {
    setControlMsg('API-Zugriff verweigert. Falls ein API-Token gesetzt ist, Seite mit ?token=DEIN_TOKEN öffnen.', true);
  });

  document.getElementById('addAutomationStageBtn')?.addEventListener('click', addAutomationStage);
  document.getElementById('saveAutomationConfigBtn')?.addEventListener('click', saveAutomationConfig);

  updateChartSelectionCallout();
  syncMinSocEditorPreview(document.getElementById('minSocSlider')?.value);
  loadAutomationConfig();
  loadScheduleDash().catch(() => {});
  requestDashboardRefresh().catch(() => {});
  setInterval(() => {
    requestDashboardRefresh().catch(() => {});
  }, 3000);
}

const dashboardApi = {
  buildScheduleWindowsFromSelection,
  collectScheduleRulesFromRowState,
  computeMinSocRenderState,
  computeDynamicGrossImportCtKwh,
  createPriceChartScale,
  createMinSocPendingState,
  createDashboardRefreshTask,
  createRefreshCoordinator,
  formatChartCentValue,
  getDashboardLogUrl,
  getChartHighlightSets,
  groupScheduleRulesForDashboard,
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
