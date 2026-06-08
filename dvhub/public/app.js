const { apiFetch, safeRender } = window.DVhubCommon || {};

// Plan 08-07 Task 3: per-widget error boundary. A throw inside one wrapped
// widget's refresh path is caught here, logged to the server via /api/log,
// and visualised by adding a `.widget-error` class to any matching DOM
// element marked with data-widget="<name>". Other widgets keep refreshing.
function withWidgetBoundary(widgetName, fn) {
  return async function widgetBoundaryWrapped(...args) {
    try {
      return await fn(...args);
    } catch (err) {
      console.error(`[widget:${widgetName}]`, err);
      const el = document.querySelector(`[data-widget="${widgetName}"]`);
      if (el) {
        el.classList.add('widget-error');
        el.setAttribute('title', `Widget-Fehler: ${err && err.message ? err.message : String(err)}`);
      }
      try {
        if (typeof apiFetch === 'function') {
          await apiFetch('/api/log', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              level: 'error',
              source: 'widget',
              widget: widgetName,
              message: err && err.message ? err.message : String(err),
              stack: err && err.stack ? String(err.stack).slice(0, 4000) : null,
              page: window.location.pathname
            }),
            keepalive: true
          });
        }
      } catch { /* never loop on log post failure */ }
    }
  };
}
const SMALL_MARKET_AUTOMATION_SOURCE = 'small_market_automation';
const SMALL_MARKET_AUTOMATION_LABEL = 'kleine Börsenautomatik';
const SMA_ID_PREFIX = 'sma-';
const FORECAST_OPTIMIZER_SOURCE = 'forecast_optimizer';
const FORECAST_OPTIMIZER_LABEL = 'Optimizer';
const OPT_ID_PREFIX = 'opt-';
function isSmallMarketAutomationRule(rule) {
  if (!rule || typeof rule !== 'object') return false;
  return rule.source === SMALL_MARKET_AUTOMATION_SOURCE
    || (typeof rule.id === 'string' && rule.id.startsWith(SMA_ID_PREFIX));
}
// Optimizer/EOS rules — same detection the rule-table badge uses (source
// 'forecast_optimizer' or id prefix 'opt-'). These carry an exact slotTs so
// the Börsenchart can highlight the precise 15-min slot in the Optimizer tone.
function isOptimizerRule(rule) {
  if (!rule || typeof rule !== 'object') return false;
  return rule.source === FORECAST_OPTIMIZER_SOURCE
    || (typeof rule.id === 'string' && rule.id.startsWith(OPT_ID_PREFIX));
}

function fmtTs(ts) { return ts ? new Date(ts).toLocaleString('de-DE') : '-'; }
function fmtHm(ts) { return new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }); }
function fmtDmHm(ts) { return new Date(ts).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
function fmtCentValue(value, maximumFractionDigits = 2) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return '-';
  // Show 4 decimals for small values near zero so -0,008 doesn't display as "-0,00"
  const digits = (maximumFractionDigits <= 2 && Math.abs(numericValue) > 0 && Math.abs(numericValue) < 1)
    ? 4 : maximumFractionDigits;
  return `${numericValue.toLocaleString('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: digits })} Cent`;
}

function fmtCentFromCt(ct) {
  return fmtCentValue(ct);
}

function fmtCentFromTenthCt(value) {
  return fmtCentValue(Number(value) / 10);
}

function escapeAttr(value) {
  // Sweep package 6: the single-quote escape was missing — an attribute value
  // broken out of a single-quoted context could inject markup. Now matches the
  // canonical common.js escapeHtml set (& " < > ').
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&#39;');
}
const escapeHtml = (window.DVhubCommon || {}).escapeHtml || escapeAttr;

const VALUE_TINTS = ['ok', 'off', 'warn', 'danger', 'cyan', 'violet', 'dim', 'amber', 'pink'];
function setText(id, text, cls) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  if (cls !== undefined) {
    VALUE_TINTS.forEach((c) => el.classList.remove(c));
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

// DVhub Powerflow Constellation — handle to the mounted component.
let powerflowInstance = null;

function updateFlowDiagram(status) {
  const batPower = Number(status?.victron?.batteryPowerW || 0);
  const pvPower = Number(status?.victron?.pvTotalW || status?.victron?.pvPowerW || 0);
  const loadW = Number(status?.victron?.selfConsumptionW || 0);
  const soc = Number(status?.victron?.soc || 0);
  const gridExportW = Number(status?.victron?.gridExportW || 0);
  const gridImportW = Number(status?.victron?.gridImportW || 0);

  // Component contract: pv ≥ 0 kW, house ≥ 0 kW,
  // bat: + = entlädt, − = lädt, grid: + = Bezug, − = Export.
  // DVhub reports batteryPowerW with the OPPOSITE convention (positive = laden,
  // i.e. power flowing into the battery), so flip the sign for the component.
  // Day's net Euro balance — positive = earned, negative = paid. Pulled from
  // /api/status .costs.netEur so the powerflow center can show it instead of
  // duplicating the grid direction (which already lives in the bottom Netz node).
  const netEur = (status && status.costs && Number.isFinite(Number(status.costs.netEur)))
    ? Number(status.costs.netEur)
    : null;

  if (powerflowInstance) {
    powerflowInstance.update({
      pv:    pvPower / 1000,
      bat:   -batPower / 1000,
      house: loadW / 1000,
      grid:  (gridImportW - gridExportW) / 1000,
      costEur: netEur
    });
  }

  // SOC progress bar (left rail) still updated independently. Strip
  // progress-fill-init once we have a real value so any stale cached
  // CSS rule with !important cannot pin the bar at 0% while the text
  // readout shows e.g. 18 %.
  const socPct = Math.max(0, Math.min(100, soc));
  const socBar = document.getElementById('socBar');
  if (socBar) {
    socBar.classList.remove('progress-fill-init');
    socBar.style.width = `${socPct}%`;
  }
  const socMid = document.getElementById('socMid');
  if (socMid) socMid.textContent = `SOC ${socPct.toFixed(0)}%`;

  // Battery mode chip (CHARGE / DISCHARGE / IDLE) — mockup parity
  const chip = document.getElementById('batModeChip');
  const modeEl = document.getElementById('batMode');
  if (chip && modeEl) {
    const w = Number(status?.victron?.batteryPowerW || 0);
    let label = 'IDLE';
    let tone = '';
    if (w > 50) { label = 'CHARGE'; tone = 'info'; }
    else if (w < -50) { label = 'DISCHARGE'; tone = 'ok'; }
    else { label = 'IDLE'; tone = ''; }
    modeEl.textContent = label;
    chip.classList.remove('info', 'ok', 'warn');
    if (tone) chip.classList.add(tone);
    chip.hidden = false;
  }
}

function initFlowDiagram() {
  if (typeof window.DVhubPowerflow === 'undefined') return;
  const mountEl = document.getElementById('leitstandPowerflow');
  if (!mountEl) return;
  if (powerflowInstance) powerflowInstance.destroy();
  powerflowInstance = window.DVhubPowerflow.mount(mountEl);
}

function cssVar(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

// Plan 09.1-04: Aurora chart-color reader with alpha — converts a hex token
// (#rgb / #rrggbb) read from CSS variables into an rgba() string so Chart.js
// dataset / annotation configs can carry transparency without baking the
// alpha into the design token. Mirrors DVhubCommon.aurChartColorAlpha but
// stays in-file so the chart builder doesn't need to await common.js loading.
function cssVarAlpha(name, alpha, fallback) {
  const v = cssVar(name, fallback);
  if (typeof v !== 'string') return fallback || v;
  let hex = v.replace('#', '');
  if (/^[0-9a-fA-F]{3}$/.test(hex)) hex = hex.split('').map((c) => c + c).join('');
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    return 'rgba(' +
      parseInt(hex.slice(0, 2), 16) + ',' +
      parseInt(hex.slice(2, 4), 16) + ',' +
      parseInt(hex.slice(4, 6), 16) + ',' +
      alpha + ')';
  }
  return v;
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
  didDrag: false,
  anchorWasSelected: false,
  anchorPriorSelectionSize: 0,
  activePointerId: null
};
const dashboardState = {
  lastMinSocReadback: null,
  minSocEditorOpen: false,
  pendingMinSocWrite: null,
  // T-0118: live readback + inline editor for the Cerbo AC discharge cap (reg 2704).
  lastMaxDischargeReadback: null,
  maxDischargeEditorOpen: false
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
  const isVisible = selectedIndices.length >= 1;

  callout.hidden = !isVisible;
  callout.classList.toggle('is-visible', isVisible);
  button.disabled = !selectedIndices.length;

  if (!isVisible) {
    summary.textContent = 'Keine Auswahl aktiv';
    detail.textContent = 'Klicke einen Slot im Chart, um einen Zeitplan-Eintrag vorzubereiten.';
    return;
  }

  if (selectedIndices.length === 1) {
    summary.textContent = '1 Slot markiert';
  } else {
    summary.textContent = `${selectedIndices.length} Balken markiert`;
  }
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
  const v = Number(value);
  if (!Number.isFinite(v)) return '-';
  // Show 4 decimals for small values near zero for better readability
  const d = (digits <= 2 && Math.abs(v) > 0 && Math.abs(v) < 1) ? 4 : digits;
  return `${v.toLocaleString('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: d })} ct/kWh`;
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

function drawPriceChart(data, nowTs, comparisons = [], automationSlotTimestamps = [], forecast = null, historySlots = [], userSlotTimestamps = [], sunTimes = null, optimizerSlotTimestamps = []) {
  const canvas = document.getElementById('priceChartCanvas');
  const container = document.getElementById('priceChartContainer');
  const tooltip = document.getElementById('tooltip');
  if (!canvas || typeof Chart === 'undefined') return;

  // Operator complaint 2026-05-22: the EPEX price chart spans whatever EPEX
  // publishes (today + tomorrow once 14:00 cutoff passes — often a 48h window
  // starting at today's midnight) while the forecast comparison chart below
  // it shows a (now − 12h, now + 24h) window. Same Leitstand section, two
  // different X-axis start points. Clip the price-chart data to the same
  // (now − 12h, now + 24h) window so both timelines start and end at the
  // same instant. The slot-selection / automation-overlay code below still
  // operates on this same clipped array, so highlights line up correctly.
  if (Array.isArray(data) && Number.isFinite(nowTs)) {
    const _winFrom = nowTs - 12 * 3600000;
    const _winTo = nowTs + 24 * 3600000;
    data = data.filter((d) => {
      const ts = Number(d?.ts);
      return Number.isFinite(ts) && ts >= _winFrom && ts < _winTo;
    });
  }
  chartSelectionState.data = Array.isArray(data) ? data : [];
  chartSelectionState.barElements = [];
  chartSelectionState.hoveredIndex = null;
  chartSelectionState.pointerDown = false;
  chartSelectionState.anchorIndex = null;
  chartSelectionState.didDrag = false;
  updateChartSelectionCallout();
  if (!Array.isArray(data) || data.length === 0) { canvas.style.display = 'none'; return; }
  canvas.style.display = '';

  // Preserve legend hidden state across redraws so user toggles survive the 3s refresh
  const prevHiddenDatasets = new Set();
  if (priceChartInstance) {
    priceChartInstance.data.datasets.forEach((ds, i) => {
      if (priceChartInstance.getDatasetMeta(i).hidden) prevHiddenDatasets.add(ds.label);
    });
    priceChartInstance.destroy();
    priceChartInstance = null;
  }

  // --- Colors ---
  const chartPositive = cssVar('--chart-positive', '#0077ff');
  const chartNegative = cssVar('--chart-negative', '#ef4444');
  const chartAutomation = cssVar('--schedule-automation-yellow', '#eab308');
  const chartUserSlot = cssVar('--schedule-user-cyan', '#56d4e0');
  // Optimizer/EOS rule highlight — same Aurora --violet token the
  // "Optimizer" rule-table badge uses, so chart and badge stay in lockstep
  // across light/dark themes.
  const chartOptimizer = cssVar('--violet', '#a78bff');
  const chartPositiveHighlight = cssVar('--chart-positive-highlight', '#a8f000');
  const chartNegativeHighlight = cssVar('--chart-negative-highlight', '#ff7a59');
  const chartImport = cssVar('--chart-import', '#22c55e');
  // Plan 09.1-04: PV-forecast accent (☀ PV Forecast line + kW axis) now from
  // Aurora --orange token; falls back to amber-500 if not present.
  const fcColor = cssVar('--orange', '#f59e0b');
  // Aurora chart-axis / chart-grid / chart-label hues — shared across all
  // axes, ticks, gridlines, and tooltip surfaces in this chart so theme
  // switches repaint the whole frame, not just the bars.
  const chartAxis = cssVar('--chart-axis', '#9ca3af');
  const chartLabel = cssVar('--chart-label', '#9ca3af');
  const chartGrid = cssVar('--chart-grid', '#e5e7eb20');
  const chartNow = cssVar('--chart-now', '#facc15');
  const chartNowBg = cssVarAlpha('--bg-elev', 0.93, '#1a1a2eee');
  const chartTipBg = cssVarAlpha('--bg-elev', 0.8, '#1a1a2ecc');
  // VRM/Sunset/Sunrise overlay accents (annotation lines) — mapped to Aurora
  // semantic colour tokens. Each falls back to the pre-Aurora literal so a
  // failure to find the var still paints something sensible.
  const chartVrmCyan = cssVar('--cyan', '#22d3ee');
  const chartPvIstYellow = cssVar('--yellow', '#f5c451');
  const chartLoadDim = cssVarAlpha('--chart-axis', 0.7, 'rgba(191,199,210,0.7)');
  const chartLoadActual = cssVarAlpha('--chart-axis', 0.9, 'rgba(191,199,210,0.9)');
  const chartGridLine = cssVar('--chart-negative-highlight', '#ff6b6b90');
  const chartSunset = cssVarAlpha('--orange', 0.7, 'rgba(251,146,60,0.7)');
  const chartSunsetLabel = cssVarAlpha('--orange', 0.9, 'rgba(251,146,60,0.9)');
  const chartSunrise = cssVarAlpha('--yellow', 0.6, 'rgba(250,204,21,0.6)');
  const chartSunriseLabel = cssVarAlpha('--yellow', 0.85, 'rgba(250,204,21,0.85)');
  const chartNegativeTint = cssVarAlpha('--chart-negative', 0.1, 'rgba(239, 68, 68, 0.10)');
  const chartNegativeRule = cssVarAlpha('--chart-negative', 0.4, 'rgba(239, 68, 68, 0.40)');
  const chartSelectionDim = cssVarAlpha('--bg-0', 0.6, 'rgba(10, 20, 40, 0.6)');
  const chartSelectionStroke = cssVar('--text', '#ffffff');

  // --- Data prep ---
  const comparisonByTs = new Map((comparisons || []).filter(Boolean).map((row) => [Number(row.ts), row]));
  const automationSlots = new Set((automationSlotTimestamps || []).map(Number));
  const userSlots = new Set((userSlotTimestamps || []).map(Number));
  const optimizerSlots = new Set((optimizerSlotTimestamps || []).map(Number));
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
    const isOptimizer = optimizerSlots.has(ts);
    const isAutomation = automationSlots.has(ts);
    const isUserSlot = userSlots.has(ts);
    const isHighPos = highHighlights.has(i);
    const isHighNeg = lowHighlights.has(i);
    let color = isOptimizer ? chartOptimizer
      : isAutomation ? chartAutomation
      : isUserSlot ? chartUserSlot
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

  const hasSolarFc = solarFc.some(v => v != null && v > 0);
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
      // Aurora mockup spacing: 0.4 px gap per 6.25 px slot ≈ 6 % gap, with
      // tiny corner rounding to match rx="0.6" in the SVG mockup.
      barPercentage: 0.94,
      categoryPercentage: 1.0,
      borderRadius: 1,
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

  if (hasSolarFc) {
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

  // VRM-Prognose overlay (independent of active model — lets users see Victron's
  // PV forecast even when the active source is solcast/pvlib/ML).
  let vrmFc = data.map(() => null);
  if (forecast && Array.isArray(forecast.vrmSolar) && forecast.vrmSolar.length > 1) {
    const vrmPoints = forecast.vrmSolar
      .map(p => ({ ts: Number(p.ts), kw: Number(p.w || 0) / 1000 }))
      .filter(p => Number.isFinite(p.ts))
      .sort((a, b) => a.ts - b.ts);
    if (vrmPoints.length >= 2) {
      vrmFc = data.map(d => {
        const ts = Number(d.ts);
        if (ts < vrmPoints[0].ts || ts > vrmPoints[vrmPoints.length - 1].ts) return null;
        for (let j = 0; j < vrmPoints.length - 1; j++) {
          if (ts >= vrmPoints[j].ts && ts <= vrmPoints[j + 1].ts) {
            const dt = vrmPoints[j + 1].ts - vrmPoints[j].ts || 1;
            const ratio = (ts - vrmPoints[j].ts) / dt;
            const v = vrmPoints[j].kw + ratio * (vrmPoints[j + 1].kw - vrmPoints[j].kw);
            return v > 0 ? v : null;
          }
        }
        return null;
      });
    }
  }
  // Show VRM-Prognose whenever any value is present (even 0 at night) so the
  // line is in the legend ready to receive daylight values without a page
  // reload.
  if (vrmFc.some(v => v != null)) {
    datasets.push({
      label: '☀ VRM-Prognose',
      type: 'line',
      data: vrmFc,
      borderColor: chartVrmCyan,
      backgroundColor: 'transparent',
      borderWidth: 1.5,
      borderDash: [3, 3],
      pointRadius: 0,
      pointHoverRadius: 3,
      fill: false,
      spanGaps: true,
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
        borderColor: chartLoadDim,
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

    // Render Ist-lines whenever any slot has data (not just > 0) — at night PV
    // is legitimately 0 W and the line still belongs on the chart so it's
    // visible in the legend and connects smoothly when the sun rises.
    if (pvActual.some(v => v != null)) {
      datasets.push({
        label: '☀ PV Ist',
        type: 'line',
        data: pvActual,
        borderColor: chartPvIstYellow,
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 3,
        fill: false,
        spanGaps: true,
        yAxisID: 'kw',
        order: 0
      });
    }
    if (loadActual.some(v => v != null)) {
      datasets.push({
        label: '🏠 Verbrauch',
        type: 'line',
        data: loadActual,
        borderColor: chartLoadActual,
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
        borderColor: chartGridLine,
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

  // --- Sunset / sunrise annotation lines (dynamic SOC-floor boundary) ---
  function findClosestDataIdx(tsMs) {
    if (tsMs == null || !Number.isFinite(tsMs)) return null;
    let best = null;
    let bestDiff = Infinity;
    for (let i = 0; i < data.length; i++) {
      const diff = Math.abs(Number(data[i].ts) - tsMs);
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    }
    // Only use the index if the slot is within ±2h of the given timestamp
    return best !== null && bestDiff <= 2 * 3600000 ? best : null;
  }
  const sunsetIdx = sunTimes?.sunsetTs ? findClosestDataIdx(Date.parse(sunTimes.sunsetTs)) : null;
  const sunriseIdx = sunTimes?.sunriseTs ? findClosestDataIdx(Date.parse(sunTimes.sunriseTs)) : null;

  // --- Day-boundary annotation: vertical divider where slot day changes ---
  const dayBoundaryAnnotations = {};
  {
    const dayBoundaryColor = cssVarAlpha('--cyan', 0.55, 'rgba(52,219,255,0.55)');
    const dayBoundaryBg = cssVarAlpha('--cyan', 0.18, 'rgba(52,219,255,0.18)');
    for (let i = 1; i < data.length; i++) {
      const prev = data[i - 1]?.day;
      const cur = data[i]?.day;
      if (!prev || !cur || prev === cur) continue;
      const dayLabel = new Date(data[i].ts).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
      dayBoundaryAnnotations[`dayBoundary_${i}`] = {
        type: 'line',
        xMin: i - 0.5,
        xMax: i - 0.5,
        borderColor: dayBoundaryColor,
        borderWidth: 1.5,
        borderDash: [4, 3],
        drawTime: 'beforeDatasetsDraw',
        label: {
          display: true,
          content: `→ ${dayLabel}`,
          position: 'start',
          backgroundColor: dayBoundaryBg,
          color: cssVar('--cyan', '#34dbff'),
          font: { size: 10, weight: 'bold' },
          padding: { top: 2, bottom: 2, left: 6, right: 6 },
          borderRadius: 4
        }
      };
    }
  }

  // --- Negative-price window annotations (box per contiguous segment) ---
  const negWindowFill = cssVarAlpha('--chart-negative', 0.12, 'rgba(239,68,68,0.12)');
  const negWindowBorder = cssVarAlpha('--chart-negative', 0.5, 'rgba(239,68,68,0.5)');
  const negWindowLabelBg = cssVarAlpha('--chart-negative', 0.78, 'rgba(239,68,68,0.78)');
  const negWindowAnnotations = {};
  {
    let segStart = null;
    const flush = (start, end) => {
      const startTs = Number(data[start].ts);
      const endTs = Number(data[end].ts) + 15 * 60 * 1000;
      const key = `negWindow_${start}`;
      negWindowAnnotations[key] = {
        type: 'box',
        xMin: start - 0.5,
        xMax: end + 0.5,
        backgroundColor: negWindowFill,
        borderColor: negWindowBorder,
        borderWidth: 1,
        drawTime: 'beforeDatasetsDraw',
        label: {
          display: true,
          content: `${fmtHm(startTs)}–${fmtHm(endTs)}`,
          position: { x: 'center', y: 'start' },
          backgroundColor: negWindowLabelBg,
          color: '#fff',
          font: { size: 10, weight: 'bold' },
          padding: { top: 2, bottom: 2, left: 6, right: 6 },
          borderRadius: 4
        }
      };
    };
    for (let i = 0; i < data.length; i++) {
      const ct = Number(data[i].ct_kwh);
      if (ct < 0) {
        if (segStart == null) segStart = i;
      } else if (segStart != null) {
        flush(segStart, i - 1);
        segStart = null;
      }
    }
    if (segStart != null) flush(segStart, data.length - 1);
  }

  // --- Chart.js config ---
  const config = {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      layout: { padding: { top: 32, right: 8, bottom: 0, left: 0 } },
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        legend: {
          display: true,
          position: 'bottom',
          labels: {
            color: chartLabel,
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
            tt.innerHTML = parts.map(p => escapeHtml(p)).join(' <span class="tooltip-separator">|</span> ');
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
            ...dayBoundaryAnnotations,
            ...negWindowAnnotations,
            nowLine: {
              type: 'line',
              xMin: nowIdx,
              xMax: nowIdx,
              borderColor: chartNow,
              borderWidth: 2.5,
              borderDash: [],
              label: {
                display: true,
                content: 'JETZT',
                position: 'start',
                yAdjust: -2,
                backgroundColor: chartNow,
                color: '#0a0f1e',
                font: { weight: 'bold', size: 12, family: 'JetBrains Mono, monospace' },
                padding: { top: 4, bottom: 4, left: 8, right: 8 },
                borderRadius: 4
              }
            },
            ...(sunsetIdx != null ? {
              sunsetLine: {
                type: 'line',
                xMin: sunsetIdx,
                xMax: sunsetIdx,
                borderColor: chartSunset,
                borderWidth: 2,
                borderDash: [5, 4],
                label: {
                  display: true,
                  content: '🌇 Sonnenuntergang',
                  position: 'end',
                  yAdjust: -2,
                  backgroundColor: cssVar('--orange', '#f59e0b'),
                  color: '#0a0f1e',
                  font: { size: 11, weight: 'bold', family: 'JetBrains Mono, monospace' },
                  padding: { top: 3, bottom: 3, left: 7, right: 7 },
                  borderRadius: 4
                }
              }
            } : {}),
            ...(sunriseIdx != null ? {
              sunriseLine: {
                type: 'line',
                xMin: sunriseIdx,
                xMax: sunriseIdx,
                borderColor: chartSunrise,
                borderWidth: 2,
                borderDash: [5, 4],
                label: {
                  display: true,
                  content: '🌅 Sonnenaufgang',
                  position: 'end',
                  yAdjust: -2,
                  backgroundColor: cssVar('--yellow', '#facc15'),
                  color: '#0a0f1e',
                  font: { size: 11, weight: 'bold', family: 'JetBrains Mono, monospace' },
                  padding: { top: 3, bottom: 3, left: 7, right: 7 },
                  borderRadius: 4
                }
              }
            } : {})
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
            color: chartAxis,
            font: { size: 10 },
            maxRotation: 0,
            autoSkip: false,
            callback: function(value) {
              const d = data[value];
              if (!d) return null;
              const date = new Date(d.ts);
              if (date.getMinutes() !== 0) return null;
              const h = date.getHours();
              if (data.length > 100 && h % 2 !== 0) return null;
              return date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', hour12: false });
            }
          },
          grid: { color: chartGrid, lineWidth: 1 }
        },
        y: {
          position: 'left',
          title: { display: true, text: 'ct/kWh', color: chartAxis, font: { size: 11 } },
          ticks: { color: chartAxis, font: { size: 10 } },
          grid: { color: chartGrid, lineWidth: 1 },
          beginAtZero: true
        },
        kw: {
          position: 'right',
          display: datasets.some(d => d.yAxisID === 'kw'),
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
        ctx.fillStyle = chartNegativeTint;
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
          ctx.strokeStyle = chartNegativeRule;
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
          ctx.fillStyle = chartSelectionDim;
          ctx.fillRect(bar.x - bar.width / 2, chart.chartArea.top, bar.width, chart.chartArea.bottom - chart.chartArea.top);
          ctx.restore();
        }
      });
      // Highlight selected bars with bright border
      meta.data.forEach((bar, i) => {
        if (selected.has(i)) {
          ctx.save();
          ctx.strokeStyle = chartSelectionStroke;
          ctx.lineWidth = 2;
          ctx.strokeRect(bar.x - bar.width / 2, bar.y, bar.width, bar.base - bar.y);
          ctx.restore();
        }
      });
    }
  };
  config.plugins = [negativeZonePlugin, selectionHighlightPlugin, ...(config.plugins || [])];

  priceChartInstance = new Chart(canvas, config);

  // Restore legend hidden state from previous chart instance
  if (prevHiddenDatasets.size) {
    priceChartInstance.data.datasets.forEach((ds, i) => {
      if (prevHiddenDatasets.has(ds.label)) {
        priceChartInstance.getDatasetMeta(i).hidden = true;
      }
    });
    priceChartInstance.update('none');
  }

  // --- Pointer-based slot selection (works on touch + mouse) ---
  // touch-action:none lets us own all pointer gestures inside the chart;
  // otherwise the browser intercepts taps as scroll/zoom on mobile.
  canvas.style.touchAction = 'none';

  canvas.addEventListener('pointerleave', () => {
    const tt = document.getElementById('tooltip');
    if (tt) tt.style.display = 'none';
  });

  canvas.addEventListener('pointerdown', (e) => {
    if (e.shiftKey) return; // shift+drag = pan (let zoom plugin handle it)
    const elements = priceChartInstance.getElementsAtEventForMode(e, 'index', { intersect: false }, false);
    if (!elements.length) return;
    const idx = elements[0].index;
    if (idx < 0 || idx >= data.length) return;
    // Capture so we keep getting pointermove/up even if finger leaves canvas
    try { canvas.setPointerCapture(e.pointerId); } catch { /* unsupported */ }
    e.preventDefault();
    e.stopPropagation();
    chartSelectionState.pointerDown = true;
    chartSelectionState.activePointerId = e.pointerId;
    chartSelectionState.anchorIndex = idx;
    chartSelectionState.didDrag = false;
    chartSelectionState.hoveredIndex = idx;
    // Remember pre-click state for tap-to-toggle behaviour
    const ts = Number(data[idx]?.ts);
    chartSelectionState.anchorWasSelected = chartSelectionState.selectedTimestamps?.has(ts) || false;
    chartSelectionState.anchorPriorSelectionSize = chartSelectionState.selectedTimestamps?.size || 0;
    setChartSelection(data, [idx]);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (e.shiftKey) return;
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

  const endPointer = (e) => {
    if (!chartSelectionState.pointerDown) return;
    // Tap-to-toggle: a click/tap (no drag) on the sole selected slot deselects it.
    if (
      !chartSelectionState.didDrag &&
      chartSelectionState.anchorWasSelected &&
      chartSelectionState.anchorPriorSelectionSize === 1
    ) {
      clearChartSelection();
    }
    chartSelectionState.pointerDown = false;
    chartSelectionState.anchorWasSelected = false;
    chartSelectionState.anchorPriorSelectionSize = 0;
    if (e && e.pointerId != null) {
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    }
    chartSelectionState.activePointerId = null;
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  // Double-tap to reset zoom (Hammer.js dblclick works on touch via chartjs-plugin-zoom)
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

// === T-0118: Max-Discharge (reg 2704) live readback + inline editor ===========
// Mirrors the Min-SOC row pattern. The value is the AC discharge cap (Akku->Haus):
// -1 = unbegrenzt, 0 = Hold (no discharge), positive = cap in W. Caps how much the
// battery may contribute to house load — too low forces grid import during PV dips.
function formatMaxDischarge(value) {
  if (value == null) return '-';
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  if (n < 0) return 'unbegrenzt';
  if (n === 0) return 'Hold (0 W)';
  if (n >= 1000) return `${(n / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 })} kW`;
  return `${n} W`;
}

function setMaxDischargeEditorOpen(isOpen) {
  dashboardState.maxDischargeEditorOpen = Boolean(isOpen);
  const row = document.getElementById('maxDischargeRow');
  const editor = document.getElementById('maxDischargeEditor');
  if (row) row.setAttribute('aria-expanded', dashboardState.maxDischargeEditorOpen ? 'true' : 'false');
  if (editor) editor.hidden = !dashboardState.maxDischargeEditorOpen;
}

function openMaxDischargeEditor() {
  const input = document.getElementById('maxDischargeInput');
  const rb = dashboardState.lastMaxDischargeReadback;
  if (input && rb != null && Number.isFinite(Number(rb))) input.value = String(Number(rb));
  setMaxDischargeEditorOpen(true);
}

function closeMaxDischargeEditor() {
  setMaxDischargeEditorOpen(false);
}

function toggleMaxDischargeEditor() {
  if (dashboardState.maxDischargeEditorOpen) {
    closeMaxDischargeEditor();
    return;
  }
  openMaxDischargeEditor();
}

function handleMaxDischargeRowKeydown(event) {
  if (!event) return;
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  toggleMaxDischargeEditor();
}

async function submitMaxDischargeUpdate({ rawValue, apiFetchImpl = apiFetch }) {
  const value = Number(rawValue);
  if (!Number.isFinite(value)) {
    return { ok: false, error: 'Max Entladung: Ungültiger Wert' };
  }
  // Operator sanity check — mirrors manualWriteMaxDischarge: typos above the
  // inverter's typical rating get a confirm. -1 / 0 / normal caps pass silently.
  if (value > 15000 && typeof window !== 'undefined' && typeof window.confirm === 'function') {
    const proceed = window.confirm(`Max Entladung auf ${value} W setzen? Wert liegt über typischer Wechselrichter-Größe — Tippfehler?`);
    if (!proceed) return { ok: false, error: null, cancelled: true };
  }
  const request = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: 'maxDischargeW', value })
  };
  const response = await apiFetchImpl('/api/control/write', request);
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    return { ok: false, error: `Max-Entladung Write Fehler: ${payload.error || response.status}` };
  }
  return { ok: true, value };
}

async function handleMaxDischargeSubmit() {
  const input = document.getElementById('maxDischargeInput');
  const outcome = await submitMaxDischargeUpdate({ rawValue: input?.value });
  if (!outcome.ok) {
    if (outcome.error) setControlMsg(outcome.error, true);
    return;
  }
  closeMaxDischargeEditor();
  setControlMsg(`Max Entladung geschrieben: ${formatMaxDischarge(outcome.value)}`);
  await requestDashboardRefresh();
}

function renderDashboardStatus(status) {
  // Plan 09-04: each top-level dashboard card update is wrapped in
  // DVhubCommon.safeRender(...) so a throw in ONE card does NOT abort the
  // sibling card updates inside the same refresh tick. The OUTER
  // withWidgetBoundary('dashboard', refresh) wrapper from Plan 08-07 stays
  // (see line ~1589) and remains the catch-all for anything safeRender
  // misses (e.g., throws in the refresh control flow itself).
  // safeRender returns a Promise but a synchronous throw inside fn() is
  // caught synchronously, so the fire-and-forget pattern below is safe.

  safeRender('dashboard.dv-status', () => {
    const dvOn = Number(status.dvControlValue) === 1;
    setText('dvStatus', dvOn ? 'EIN (Freigabe)' : 'AUS (Sperre)', dvOn ? 'ok' : 'off');
    setText('nowTime', fmtTs(status.now));
    setText('dvValue', String(status.dvControlValue));
    setText('offUntil', status.ctrl?.offUntil ? fmtTs(status.ctrl.offUntil) : '-');
    setText('kaModbus', status.keepalive?.modbusLastQuery?.ts ? fmtTs(status.keepalive.modbusLastQuery.ts) : '-');
  });

  safeRender('dashboard.vpn', () => {
    // VPN Rail-Card
    renderVpnCard(status.vpn);

    // VPN status in DV card
    const dvVpnRow = document.getElementById('dvVpnRow');
    if (dvVpnRow) {
      const vpn = status.vpn;
      if (vpn && vpn.enabled) {
        dvVpnRow.style.display = '';
        const labels = { connected: 'Verbunden', connecting: 'Verbinde...', disconnected: 'Getrennt', error: 'Fehler' };
        const text = labels[vpn.status] || vpn.status || '-';
        const extra = vpn.tunIp ? ` (${vpn.tunIp})` : '';
        setText('dvVpnStatus', text + extra, vpn.status === 'connected' ? 'ok' : (vpn.status === 'error' ? 'off' : ''));
      } else {
        dvVpnRow.style.display = 'none';
      }
    }
  });

  safeRender('dashboard.dv-indicators', () => {
    const dvIndicators = resolveDvControlIndicators(status);
    setText('dvDcPv', dvIndicators.dc.text, dvIndicators.dc.tone);
    setText('dvAcPv', dvIndicators.ac.text, dvIndicators.ac.tone);
  });

  safeRender('dashboard.market', () => {
    const s = status.epex?.summary;
    const rows = Array.isArray(status.epex?.data) ? status.epex.data : [];
    const todayDate = s?.today || status.epex?.date;
    const todayRows = todayDate ? rows.filter((r) => r.day === todayDate) : rows;

    // Current spot — tint by sign
    const currentCt = s?.current ? Number(s.current.ct_kwh) : null;
    setText('priceNow', s?.current ? fmtCentFromCt(s.current.ct_kwh) : '-',
      currentCt == null ? '' : (currentCt < 0 ? 'off' : (currentCt > 12 ? 'warn' : 'ok')));

    // Min / Max with times — derived from today's slots
    let minRow = null;
    let maxRow = null;
    let sum = 0;
    let count = 0;
    for (const r of todayRows) {
      const ct = Number(r.ct_kwh);
      if (!Number.isFinite(ct)) continue;
      sum += ct; count += 1;
      if (!minRow || ct < Number(minRow.ct_kwh)) minRow = r;
      if (!maxRow || ct > Number(maxRow.ct_kwh)) maxRow = r;
    }
    setText('priceMinTime', minRow ? fmtHm(minRow.ts) : '--:--');
    setText('priceMin', minRow ? fmtCentFromCt(minRow.ct_kwh) : '-',
      minRow && Number(minRow.ct_kwh) < 0 ? 'ok' : 'cyan');
    setText('priceMaxTime', maxRow ? fmtHm(maxRow.ts) : '--:--');
    setText('priceMax', maxRow ? fmtCentFromCt(maxRow.ct_kwh) : '-',
      maxRow && Number(maxRow.ct_kwh) > 12 ? 'warn' : '');
    const avgCt = count ? sum / count : null;
    setText('priceAvg', avgCt != null ? fmtCentFromCt(avgCt) : '-', 'cyan');

    // Negativ-Fenster: earliest negative slot start → latest negative slot end (+15min)
    const negSlots = todayRows.filter((r) => Number(r.ct_kwh) < 0);
    if (negSlots.length) {
      const startTs = Math.min(...negSlots.map((r) => Number(r.ts)));
      const endTs = Math.max(...negSlots.map((r) => Number(r.ts))) + 15 * 60 * 1000;
      setText('negWindow', `${fmtHm(startTs)}–${fmtHm(endTs)}`, 'ok');
    } else {
      setText('negWindow', 'keine', 'dim');
    }

    // Next slot — split time and value
    setText('priceNextTime', s?.next ? fmtHm(s.next.ts) : '--:--');
    setText('priceNext', s?.next ? fmtCentFromCt(s.next.ct_kwh) : '-',
      s?.next && Number(s.next.ct_kwh) < 0 ? 'ok' : '');

    // Eigenbezug (user import price for current slot)
    const eigenCt = Number(status.userEnergyPricing?.current?.importPriceCtKwh);
    setText('priceEigenbezug',
      Number.isFinite(eigenCt) && eigenCt > 0 ? fmtCentFromCt(eigenCt) : '-',
      'violet');

    // Avg delta chip — show vs current spot
    const chip = document.getElementById('priceAvgChip');
    if (chip) {
      if (avgCt != null && currentCt != null && Math.abs(avgCt) > 0.01) {
        const deltaPct = ((currentCt - avgCt) / Math.abs(avgCt)) * 100;
        const sign = deltaPct >= 0 ? '+' : '';
        setText('priceAvgDelta', `${sign}${deltaPct.toFixed(0)}% Ø`);
        chip.hidden = false;
        chip.classList.remove('ok', 'warn');
        chip.classList.add(deltaPct < 0 ? 'ok' : 'warn');
      } else {
        chip.hidden = true;
      }
    }

    // Negativpreis-Schutz status
    const negActive = status.ctrl?.negativePriceActive;
    setText('negPriceProtection', negActive ? 'AKTIV (Abregelung)' : 'Inaktiv', negActive ? 'off' : 'ok');

    // Tomorrow min/max (kept; less prominent)
    setText(
      'tomorrowMinMax',
      s && s.tomorrowMin != null && s.tomorrowMax != null
        ? `${fmtCentFromTenthCt(Number(s.tomorrowMin))} / ${fmtCentFromTenthCt(Number(s.tomorrowMax))}`
        : '-'
    );

    // Hidden bookkeeping spans (kept for backward compat with binding-contract)
    setText('todayMinMax',
      s && s.todayMin != null && s.todayMax != null
        ? `${fmtCentFromTenthCt(Number(s.todayMin))} / ${fmtCentFromTenthCt(Number(s.todayMax))}`
        : '-');
    setText('negLater', s ? (s.hasFutureNegative ? 'Ja' : 'Nein') : '-');
    setText('negTomorrow', s ? (s.tomorrowNegative ? 'Ja' : 'Nein') : '-');
  });

  safeRender('dashboard.dv-luox', () => {
    // DV-Signale · LUOX is merged into the DV-Status card on the left rail.
    // Existing rows (Control Value, Lease bis, Letzte Modbus-Abfrage,
    // VPN-Tunnel) already act as liveness/heartbeat indicators. We only
    // additionally populate Curtailment (negativ-price window) and
    // Replan-Trigger (last SMA plan computed time).
    const negActive = status.ctrl?.negativePriceActive;
    const negStart = status.ctrl?.negativePriceWindow?.start || status.ctrl?.negativePriceStart;
    const negEnd = status.ctrl?.negativePriceWindow?.end || status.ctrl?.negativePriceEnd;
    if (negActive && negStart && negEnd) {
      setText('dvCurtailment', `${fmtHm(negStart)}–${fmtHm(negEnd)}`, 'warn');
    } else if (negActive) {
      setText('dvCurtailment', 'aktiv', 'warn');
    } else {
      setText('dvCurtailment', 'keine', 'dim');
    }

    const planTs = Number(status?.schedule?.smallMarketAutomation?.plan?.computedAt
      || status?.schedule?.smallMarketAutomation?.lastPlanComputedAt || 0);
    if (planTs) {
      setText('dvReplanTrigger', `${fmtHm(planTs)} · auto`);
    } else {
      setText('dvReplanTrigger', '-', 'dim');
    }
  });

  safeRender('dashboard.meter-flow', () => {
    setText('l1', `${status.meter?.grid_l1_w ?? '-'} W`);
    setText('l2', `${status.meter?.grid_l2_w ?? '-'} W`);
    setText('l3', `${status.meter?.grid_l3_w ?? '-'} W`);
    setText('total', `${status.meter?.grid_total_w ?? '-'} W`, status.meter?.grid_total_w < 0 ? 'ok' : (status.meter?.grid_total_w > 0 ? 'off' : ''));
    updateFlowDiagram(status);
  });

  safeRender('dashboard.victron-battery', () => {
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
    // T-0118: live readback of the Cerbo AC discharge cap (reg 2704).
    dashboardState.lastMaxDischargeReadback = vic.maxDischargeW == null ? null : Number(vic.maxDischargeW);
    setText('maxDischargeReadback', formatMaxDischarge(vic.maxDischargeW), Number(vic.maxDischargeW) === 0 ? 'off' : null);
  });

  safeRender('dashboard.costs', () => {
    const c = status.costs || {};
    setText('costImport', c.importKwh == null ? '-' : `${c.importKwh} kWh`);
    setText('costExport', c.exportKwh == null ? '-' : `${c.exportKwh} kWh`);
    setText('costCost', c.costEur == null ? '-' : `${c.costEur.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} \u20ac`);
    setText('costRevenue', c.revenueEur == null ? '-' : `${c.revenueEur.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} \u20ac`);
    setText('costNet', c.netEur == null ? '-' : `${c.netEur.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} \u20ac`, c.netEur >= 0 ? 'ok' : 'off');
  });

  safeRender('dashboard.schedule', () => {
    const sch = status.schedule || {};
    const ag = sch.active?.gridSetpointW;
    const ac = sch.active?.chargeCurrentA;
    const am = sch.active?.minSocPct;
    const amd = sch.active?.maxDischargeW;
    const lwG = sch.lastWrite?.gridSetpointW;
    const lwC = sch.lastWrite?.chargeCurrentA;
    const lwM = sch.lastWrite?.minSocPct;
    const lwMD = sch.lastWrite?.maxDischargeW;
    setText('activeGridSetpoint', ag?.value == null ? '-' : `${ag.value} W (${ag.source || '-'})`);
    setText('activeChargeCurrent', ac?.value == null ? '-' : `${ac.value} A (${ac.source || '-'})`);
    setText('activeMinSoc', am?.value == null ? '-' : `${am.value} % (${am.source || '-'})`);
    // Max Discharge: prominent so the operator sees the cap before manually changing it.
    // 0 = Hold (no discharge), -1 = unlimited (default), positive = AC cap in W.
    let mdLabel = '-';
    let mdClass = null;
    if (amd?.value != null) {
      if (Number(amd.value) === 0) { mdLabel = `HOLD (${amd.source || '-'})`; mdClass = 'off'; }
      else if (Number(amd.value) === -1) { mdLabel = `unbegrenzt (${amd.source || '-'})`; }
      else { mdLabel = `${amd.value} W (${amd.source || '-'})`; mdClass = 'ok'; }
    }
    setText('activeMaxDischarge', mdLabel, mdClass);
    const adc = sch.active?.feedExcessDcPv;
    setText('activeDcFeed', adc?.value == null ? '-' : `${adc.value ? 'EIN' : 'AUS'} (${adc.source || '-'})`);
    const lwParts = [];
    if (lwG?.at) lwParts.push(`Grid: ${lwG.value} @ ${fmtTs(lwG.at)}`);
    if (lwC?.at) lwParts.push(`Charge: ${lwC.value} @ ${fmtTs(lwC.at)}`);
    if (lwM?.at) lwParts.push(`MinSOC: ${lwM.value} @ ${fmtTs(lwM.at)}`);
    if (lwMD?.at) lwParts.push(`MaxDis: ${lwMD.value} @ ${fmtTs(lwMD.at)}`);
    setText('lastControlWrite', lwParts.length ? lwParts.join(' | ') : '-');
    applyScheduleRowStates(status.now);
    updateChartComparisonSummary(status.userEnergyPricing);
  });

  safeRender('dashboard.price-chart', () => {
    // Fetch forecast + history slots for chart overlay
    const today = new Date(status.now).toISOString().slice(0, 10);
    const activeRules = (status.schedule?.rules || []).filter(r => r.enabled !== false);
    // Optimizer/EOS rules carry an exact 15-min slotTs → highlight the precise
    // slot (no time-of-day cross-day false matches). Manual user rules have no
    // slotTs, so they keep the HH:MM-vs-epex matching below.
    const optimizerSlotTimestamps = activeRules
      .filter(isOptimizerRule)
      .map(r => Number(r.slotTs))
      .filter(Number.isFinite);
    const userSlotTimestamps = activeRules
      .filter(r => !isSmallMarketAutomationRule(r) && !isOptimizerRule(r))
      .flatMap(r => {
        const epexData = status.epex?.data || [];
        return epexData.filter(s => {
          const slotTime = new Date(s.ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', hour12: false });
          return slotTime >= (r.start || '') && slotTime < (r.end || '');
        }).map(s => Number(s.ts));
      });
    const baseChartArgs = [status.epex?.data || [], status.now, status.userEnergyPricing?.slots || [], status?.schedule?.smallMarketAutomation?.selectedSlotTimestamps || []];
    const smaPlan = status.schedule?.smallMarketAutomation?.plan;
    const sunTimes = (smaPlan?.sunsetTs || smaPlan?.sunriseTs)
      ? { sunsetTs: smaPlan.sunsetTs ?? null, sunriseTs: smaPlan.sunriseTs ?? null }
      : null;
    Promise.all([
      apiFetch('/api/forecast').then(r => r.json()).catch(() => null),
      apiFetch(`/api/history/summary?view=day&date=${today}`).then(r => r.json()).catch(() => null)
    ]).then(([fc, hist]) => {
      drawPriceChart(...baseChartArgs, fc?.ok ? fc : null, hist?.slots || [], userSlotTimestamps, sunTimes, optimizerSlotTimestamps);
    }).catch(() => {
      drawPriceChart(...baseChartArgs, null, [], userSlotTimestamps, sunTimes, optimizerSlotTimestamps);
    });
    {
      const epd = status.epex?.data || [];
      const distinctDays = Array.from(new Set(epd.map((r) => r.day).filter(Boolean))).sort();
      const daysLabel = distinctDays.length
        ? distinctDays.map((d) => d.slice(5)).join(' + ')
        : '—';
      const tomorrowHint = (distinctDays.length < 2 && status.epex?.nextDate)
        ? ` · Morgen (${status.epex.nextDate.slice(5)}) wird nach EPEX-Clearing ~13:00 verfügbar`
        : '';
      setText('chartMeta', `EPEX Update: ${fmtTs(status.epex?.updatedAt)} | ${epd.length} Slots · ${daysLabel}${tomorrowHint}`);
    }
  }, { placeholderTarget: document.getElementById('priceChartContainer') });

  safeRender('dashboard.automation', () => {
    renderAutomationStatus(status.schedule);
  });
}

// Plan 09-06 (D-09): UI log level filter state. Persisted in-memory only —
// reverts to 'all' on page reload. The level dropdown is injected lazily by
// renderDashboardLog so existing pages without a dedicated container still work.
const dashboardLogState = { rows: [], filter: 'all' };

function ensureLogLevelFilterUi() {
  const logBox = document.getElementById('logBox');
  if (!logBox) return null;
  let select = document.getElementById('log-level-filter');
  if (select) return select;
  // Inject the dropdown right above the logBox. Container/styling stays
  // minimal — the existing .bottom-card layout absorbs it inline.
  select = document.createElement('select');
  select.id = 'log-level-filter';
  select.className = 'level-filter';
  // CSP-safe: individual property setters (cssText blocked by style-src).
  select.style.marginBottom = '6px';
  select.style.padding = '2px 8px';
  select.style.fontSize = '0.85em';
  const levels = [
    ['all', 'Alle Level'],
    ['debug', 'DEBUG'],
    ['info', 'INFO'],
    ['warn', 'WARN'],
    ['error', 'ERROR']
  ];
  for (const [value, label] of levels) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    if (value === dashboardLogState.filter) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => {
    dashboardLogState.filter = select.value;
    rerenderDashboardLog();
  });
  // Insert dropdown right before the <pre id="logBox">.
  logBox.parentNode.insertBefore(select, logBox);
  return select;
}

// Plan 09-06 (D-09): supported badge classes. Listed as static class names
// alongside the dynamic template literal so a CSS/JS audit grep
// (e.g., grep -E 'log-level-(debug|info|warn|error)') finds them. The
// constant is also used as the level allowlist when sanitising row.level.
const LOG_LEVEL_BADGE_CLASSES = ['log-level-debug', 'log-level-info', 'log-level-warn', 'log-level-error'];

function rerenderDashboardLog() {
  const logBox = document.getElementById('logBox');
  if (!logBox) return;
  const filter = dashboardLogState.filter || 'all';
  const all = dashboardLogState.rows;
  // Plan 09-06 (D-09): default missing level to 'info' so rows that predate
  // this plan stay visible under the INFO filter (backward compat).
  const visibleRows = (filter === 'all')
    ? all
    : all.filter((r) => (r.level || 'info') === filter);
  if (visibleRows.length === 0) {
    logBox.innerHTML = '-';
    return;
  }
  // Render with level badges. The <pre>-style monospaced log block is
  // preserved — each row is a single line so existing operator muscle memory
  // (scroll-back, copy-paste) survives.
  logBox.innerHTML = visibleRows.map((r) => {
    const level = (r.level || 'info').toLowerCase();
    const safeLevel = ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info';
    const badge = `<span class="log-level-badge log-level-${escapeHtml(safeLevel)}">${escapeHtml(safeLevel.toUpperCase())}</span>`;
    const { level: _omit, ...rest } = r;
    void _omit; // suppress unused-destructure lint
    return `${badge} ${escapeHtml(JSON.stringify(rest))}`;
  }).join('\n');
}

function renderDashboardLog(logs) {
  // Plan 09-06 (D-09): cache rows so the level dropdown can re-filter without
  // re-fetching, and ensure the dropdown UI is present.
  dashboardLogState.rows = (logs.rows || []).slice(-20).reverse();
  ensureLogLevelFilterUi();
  rerenderDashboardLog();
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

const refresh = withWidgetBoundary('dashboard', async function refresh() {
  await refreshDashboardTask();
});

const dashboardRefreshCoordinator = createRefreshCoordinator({
  refreshTask: refresh
});

function requestDashboardRefresh() {
  return dashboardRefreshCoordinator.run();
}

const refreshEpex = withWidgetBoundary('epex', async function refreshEpex() {
  await apiFetch('/api/epex/refresh', { method: 'POST' });
  await requestDashboardRefresh();
});

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

async function manualWriteMaxDischarge() {
  const value = Number(document.getElementById('manualMaxDischargeValue')?.value);
  if (!Number.isFinite(value)) return setControlMsg('Max Discharge: Ungültiger Wert', true);
  // Operator sanity check — prevents accidentally typing 24000 when the inverter
  // is rated 18 kW. Only triggers above 15 kW; -1 / 0 / typical caps pass silently.
  if (value > 15000) {
    const proceed = window.confirm(`Max Discharge auf ${value} W setzen? Wert liegt über typischer Wechselrichter-Größe — Tippfehler?`);
    if (!proceed) return;
  }
  const res = await apiFetch('/api/control/write', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: 'maxDischargeW', value })
  });
  const out = await res.json();
  if (!res.ok || !out.ok) return setControlMsg(`Max Discharge Write Fehler: ${out.error || res.status}`, true);
  const label = value === 0 ? 'HOLD' : value === -1 ? 'unbegrenzt' : `${value} W`;
  setControlMsg(`Max Discharge geschrieben: ${label}`);
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

function formatSlotDate(slotTs) {
  if (!slotTs) return '';
  const d = new Date(Number(slotTs));
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const slotDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((slotDay - today) / 86400000);
  if (diffDays === 0) return 'Heute';
  if (diffDays === 1) return 'Morgen';
  if (diffDays === 2) return '\u00dcberm.';
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
}

function groupScheduleRulesForDashboard(rules) {
  if (!Array.isArray(rules)) return [];

  const timeSlots = new Map();
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue;
    // Date-aware grouping: automation rules with slotTs include the date
    // so same time on different days stays separate
    const datePrefix = rule.slotTs ? new Date(Number(rule.slotTs)).toISOString().slice(0, 10) : '';
    const key = `${datePrefix}|${rule.start}|${rule.end}`;
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
    // Compute activeDate from slotTs (Heute/Morgen/Überm.) or use existing
    if (!slot.activeDate) {
      slot.activeDate = rule.activeDate || formatSlotDate(rule.slotTs) || '';
    }
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
    || tr.dataset.ruleSource === FORECAST_OPTIMIZER_SOURCE
    || tr.dataset.displayTone === 'yellow'
    || tr.dataset.displayTone === 'blue'
    || (tr.dataset.ruleId || '').startsWith(SMA_ID_PREFIX)
    || (tr.dataset.ruleId || '').startsWith(OPT_ID_PREFIX);

  tr.classList.toggle('sched-row-expired', expired);
  tr.classList.toggle('sched-row-automation', isAutomationRule);
  tr.classList.toggle('sched-row-user', !isAutomationRule);
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
  const isSma = source === SMALL_MARKET_AUTOMATION_SOURCE
    || (typeof ruleId === 'string' && ruleId.startsWith(SMA_ID_PREFIX));
  const isOptimizer = source === FORECAST_OPTIMIZER_SOURCE
    || (typeof ruleId === 'string' && ruleId.startsWith(OPT_ID_PREFIX));
  const isAutomation = isSma || isOptimizer;
  if (isSma) {
    tr.title = `${SMALL_MARKET_AUTOMATION_LABEL}${activeDate ? ` (${activeDate})` : ''} — automatisch verwaltet`;
  } else if (isOptimizer) {
    tr.title = `${FORECAST_OPTIMIZER_LABEL} — automatisch verwaltet`;
  }

  const disabled = isAutomation ? 'disabled' : '';
  tr.innerHTML = `
    <td><input type="checkbox" class="sched-row-enabled" ${rowEnabled ? 'checked' : ''} ${disabled} title="${escapeAttr(isAutomation ? 'Automatisch verwaltet' : 'Aktiv')}" /></td>
    <td><input type="time" class="sched-start" value="${escapeAttr(start)}" ${disabled} /></td>
    <td><input type="time" class="sched-end" value="${escapeAttr(end)}" ${disabled} /></td>
    <td><label><input type="checkbox" class="sched-grid-en" ${gridEnabled ? 'checked' : ''} ${disabled} /> <input type="number" class="sched-grid-val" value="${escapeAttr(gridVal)}" ${disabled} /></label></td>
    <td><label><input type="checkbox" class="sched-charge-en" ${chargeEnabled ? 'checked' : ''} ${disabled} /> <input type="number" class="sched-charge-val" value="${escapeAttr(chargeVal)}" ${disabled} /></label></td>
    <td><label><input type="checkbox" class="sched-stop-soc-en" ${stopSocEnabled ? 'checked' : ''} ${disabled} /> <input type="number" class="sched-stop-soc-val" value="${escapeAttr(stopSocVal)}" min="0" max="100" step="5" ${disabled} /></label></td>
    <td><input type="checkbox" class="sched-dc-export" ${dcExportEnabled ? 'checked' : ''} ${disabled} title="100% Einspeisung — Grid-Setpoint folgt der aktuellen PV-Leistung (AC+DC, minus Puffer), Akku-Nettostrom bleibt ~0 A. OvervoltageFeedIn wird NICHT angefasst (das macht nur die DV-Vermarktung)." /></td>
    <td>${isAutomation ? (isOptimizer
      ? '<span class="sched-auto-badge sched-badge-optimizer" title="Vom Optimizer verwaltet">Optimizer' + (activeDate ? ' · ' + escapeHtml(activeDate) : '') + '</span>'
      : '<span class="sched-auto-badge" title="Von der kleinen Börsenautomatik verwaltet">Auto' + (activeDate ? ' · ' + escapeHtml(activeDate) : '') + '</span>')
      : '<button class="icon-btn sched-remove" title="Zeile entfernen">-</button>'}</td>
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

  // Update Optimizer Schedule rule-count chip
  const chip = document.getElementById('schedRuleCountChip');
  if (chip) {
    if (rules.length > 0) {
      setText('schedRuleCount', String(rules.length));
      chip.hidden = false;
    } else {
      chip.hidden = true;
    }
  }

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
          <input type="number" data-stage-field="dischargeW" value="${escapeAttr(stage.dischargeW)}" />
        </label>
        <label class="settings-field">
          <span>Entlade-Slots (je 15 Min.)</span>
          <input type="number" min="0" data-stage-field="dischargeSlots" value="${escapeAttr(stage.dischargeSlots)}" />
        </label>
        <label class="settings-field">
          <span>Cooldown-Leistung (W, negativ = Einspeisung)</span>
          <input type="number" data-stage-field="cooldownW" value="${escapeAttr(stage.cooldownW)}" />
        </label>
        <label class="settings-field">
          <span>Cooldown-Slots (je 15 Min.)</span>
          <input type="number" min="0" data-stage-field="cooldownSlots" value="${escapeAttr(stage.cooldownSlots)}" />
        </label>
      </div>
      <button class="btn-small btn-danger remove-stage-btn" data-remove-stage="${escapeAttr(stage.id)}">Stufe entfernen</button>
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

async function replanAutomation() {
  const btn = document.getElementById('replanAutomationBtn');
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    const r = await apiFetch('/api/schedule/automation/replan', { method: 'POST' });
    const out = await r.json();
    if (!r.ok || !out.ok) {
      setControlMsg(`Replan fehlgeschlagen: ${out.error || r.status}`, true);
      return;
    }
    const kwhInfo = out.availableEnergyKwh != null ? ` (${out.availableEnergyKwh} kWh)` : '';
    setControlMsg(`Neu geplant: ${out.generatedRuleCount} Regeln${kwhInfo}`);
    await requestDashboardRefresh();
  } catch (e) {
    setControlMsg(`Replan-Fehler: ${e.message}`, true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Neu planen'; }
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
    if (sma.availableEnergyKwh != null) {
      const plan = sma.plan;
      const dynInfo = plan?.dynamicSocFloor
        ? ` (Min-SOC ${plan.effectiveMinSocPct}% statt ${plan.minSocPct}%)`
        : '';
      const pvInfo = plan?.pvFeedInW > 0 ? ` + ${plan.pvFeedInW} W PV` : '';
      energyEl.textContent = `${sma.availableEnergyKwh} kWh verfügbar${pvInfo}${dynInfo}`;
    } else {
      energyEl.textContent = '';
    }
  }

  // Render plan summary
  const planContainer = document.getElementById('automationPlanSummary');
  const plan = sma.plan;
  if (!planContainer) return;

  // The container ships with `class="u-hidden"` (rule `display: none !important`).
  // Toggling `style.display` alone cannot override !important — must add/remove
  // the class. Regression from 08-11 (style="display:none" → class="u-hidden").
  if (!plan || !plan.selectedSlots?.length) {
    planContainer.classList.add('u-hidden');
    return;
  }

  planContainer.classList.remove('u-hidden');
  const computedEl = document.getElementById('planComputedAt');
  const budgetEl = document.getElementById('planEnergyBudget');
  const revenueEl = document.getElementById('planEstimatedRevenue');

  if (computedEl) {
    const d = new Date(plan.computedAt);
    computedEl.textContent = `Berechnet: ${d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`;
  }
  if (budgetEl) {
    const parts = [];
    if (plan.availableEnergyKwh != null) parts.push(`${plan.availableEnergyKwh} kWh Batterie`);
    if (plan.pvFeedInW > 0) parts.push(`${plan.pvFeedInW} W PV`);
    if (plan.currentSocPct != null) {
      const effectiveMin = plan.effectiveMinSocPct ?? plan.minSocPct ?? 0;
      const configuredMin = plan.minSocPct ?? 0;
      let socText = `SOC ${plan.currentSocPct}% \u2192 ${effectiveMin}%`;
      if (plan.dynamicSocFloor) {
        socText += ` (statt ${configuredMin}%, Sonnenaufgang)`;
      }
      parts.push(socText);
    }
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

function renderVpnCard(vpn) {
  const card = document.getElementById('vpnCard');
  if (!card) return;
  if (!vpn || !vpn.enabled) { card.style.display = 'none'; return; }
  card.style.display = '';

  const statusLabels = {
    connected: 'Verbunden',
    connecting: 'Verbinde...',
    disconnected: 'Getrennt',
    error: 'Fehler'
  };
  const statusTone = vpn.status === 'connected' ? 'ok' : (vpn.status === 'error' ? 'off' : '');
  setText('vpnStatus', statusLabels[vpn.status] || vpn.status || '-', statusTone);
  setText('vpnTunIp', vpn.tunIp || '-');

  if (vpn.uptimeSeconds != null && vpn.uptimeSeconds > 0) {
    const h = Math.floor(vpn.uptimeSeconds / 3600);
    const m = Math.floor((vpn.uptimeSeconds % 3600) / 60);
    setText('vpnUptime', h > 0 ? `${h}h ${m}m` : `${m}m`);
  } else {
    setText('vpnUptime', '-');
  }

  setText('vpnReconnects', String(vpn.reconnectAttempts || 0));

  const certWarn = document.getElementById('vpnCertWarn');
  if (certWarn) {
    if (vpn.certDaysRemaining != null && vpn.certDaysRemaining <= 30) {
      certWarn.style.display = '';
      setText('vpnCertDays', `${vpn.certDaysRemaining} Tage`);
    } else {
      certWarn.style.display = 'none';
    }
  }
}

function wireNavToggle() {
  const toggle = document.getElementById('navToggle');
  const nav = document.getElementById('topbarNav');
  if (!toggle || !nav) return;
  // Plan 09.1-05: common.js now also wires this on every page that ships
  // the Aurora topbar. Honour its dataset guard so we don't double-bind
  // on index.html (would produce a no-op + class flicker on each click).
  if (toggle.dataset.navToggleWired === '1') return;
  toggle.dataset.navToggleWired = '1';
  toggle.addEventListener('click', () => {
    const isOpen = nav.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  });
  nav.querySelectorAll('a').forEach((a) => {
    a.addEventListener('click', () => {
      nav.classList.remove('is-open');
      toggle.setAttribute('aria-expanded', 'false');
    });
  });
}

function initDashboard() {
  initFlowDiagram();
  wireNavToggle();
  document.getElementById('vpnReconnectBtn')?.addEventListener('click', async () => {
    try {
      await apiFetch('/api/vpn/restart', { method: 'POST' });
    } catch { /* ignore */ }
  });
  document.getElementById('refreshEpex')?.addEventListener('click', refreshEpex);
  document.getElementById('loadScheduleBtn')?.addEventListener('click', loadScheduleDash);
  document.getElementById('saveScheduleBtn')?.addEventListener('click', saveScheduleDash);
  document.getElementById('addScheduleRowBtn')?.addEventListener('click', () => addScheduleRow());
  document.getElementById('manualGridBtn')?.addEventListener('click', manualWriteGrid);
  document.getElementById('manualChargeBtn')?.addEventListener('click', manualWriteCharge);
  document.getElementById('manualMaxDischargeBtn')?.addEventListener('click', manualWriteMaxDischarge);
  // T-0118: Max-Discharge readback row -> inline editor (mirrors Min-SOC row).
  document.getElementById('maxDischargeRow')?.addEventListener('click', toggleMaxDischargeEditor);
  document.getElementById('maxDischargeRow')?.addEventListener('keydown', handleMaxDischargeRowKeydown);
  document.getElementById('maxDischargeSubmitBtn')?.addEventListener('click', handleMaxDischargeSubmit);
  document.querySelectorAll('#maxDischargeEditor [data-md]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = document.getElementById('maxDischargeInput');
      if (input) input.value = btn.getAttribute('data-md');
    });
  });
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

  // SMA <details> summary contains the Aktiv toggle — stop the click from
  // bubbling so toggling 'Aktiv' doesn't also collapse/expand the panel.
  document.getElementById('automationEnabledLabel')?.addEventListener('click', (e) => {
    e.stopPropagation();
  });
  document.getElementById('replanAutomationBtn')?.addEventListener('click', replanAutomation);

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
