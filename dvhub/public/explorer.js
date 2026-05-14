const { apiFetch } = window.DVhubCommon || {};

// --- Series definitions ---
const SERIES_DEFS = [
  { id: 'pvKw',       label: 'PV Erzeugung',    color: '#f5c451', unit: 'kW',    axis: 'kw',  key: 'pvKwh',       toKw: true },
  { id: 'loadKw',     label: 'Verbrauch',        color: '#bfc7d2', unit: 'kW',    axis: 'kw',  key: 'loadKwh',     toKw: true },
  { id: 'gridKw',     label: 'Netz (Imp-Exp)',   color: '#ff6b6b', unit: 'kW',    axis: 'kw',  key: '_gridNet',    toKw: true },
  { id: 'batteryKw',  label: 'Batterie',         color: '#67a5ff', unit: 'kW',    axis: 'kw',  key: 'batteryKwh',  toKw: true },
  { id: 'exportKw',   label: 'Einspeisung',      color: '#39E06F', unit: 'kW',    axis: 'kw',  key: 'exportKwh',   toKw: true },
  { id: 'importKw',   label: 'Netzbezug',        color: '#ff6b6b', unit: 'kW',    axis: 'kw',  key: 'importKwh',   toKw: true, hidden: true },
  { id: 'soc',        label: 'Batterie SOC',        color: '#67a5ff', unit: '%',     axis: 'pct', key: '_soc',         toKw: false, dash: [4, 2] },
  { id: 'autarkie',   label: 'Autarkie',           color: '#A8F000', unit: '%',     axis: 'pct', key: '_autarkie',    toKw: false },
  { id: 'pvFc',       label: 'PV Forecast',       color: '#f59e0b', unit: 'kW',    axis: 'kw',  key: '_pvFc',       toKw: false, dash: [6, 3] },
  { id: 'consFc',     label: 'Lastvorhersage',    color: '#bfc7d2', unit: 'kW',    axis: 'kw',  key: '_consFc',     toKw: false, dash: [4, 3], hidden: true },
  { id: 'marketCt',   label: 'Börsenpreis',      color: '#0077ff', unit: 'ct/kWh', axis: 'ct', key: '_marketCt',   toKw: false },
  { id: 'importCt',   label: 'Bezugspreis',       color: '#22c55e', unit: 'ct/kWh', axis: 'ct', key: '_importCt',   toKw: false, dash: [6, 4], hidden: true },
  { id: 'selfConsKw', label: 'Eigenverbrauch',    color: '#A8F000', unit: 'kW',    axis: 'kw',  key: 'selfConsumptionKwh', toKw: true, hidden: true },
];

let explorerChart = null;
let explorerData = { labels: [], datasets: [], rawSlots: [], rawFc: null, rawEpex: null };
const activeSeriesIds = new Set(SERIES_DEFS.filter(s => !s.hidden).map(s => s.id));

// --- Phase 09.2 D-21: Source-Chips ---
// Server-side filter (sources= param) backed by series_metadata.source taxonomy
// from migration 019. Default: all 5 sources active. Chip dot color is
// class-driven via .source-chip .dot.dot-<id> in explorer.css — NEVER
// style="..." in innerHTML (CSP-blocked, D-28).
const SOURCE_DEFS = [
  { id: 'victron',   label: 'Victron', dotClass: 'dot-victron' },
  { id: 'mid',       label: 'MID',     dotClass: 'dot-mid' },
  { id: 'luox',      label: 'LUOX',    dotClass: 'dot-luox' },
  { id: 'epex',      label: 'EPEX',    dotClass: 'dot-epex' },
  { id: 'optimizer', label: 'Optim.',  dotClass: 'dot-optimizer' }
];
const activeSourceChips = new Set(SOURCE_DEFS.map(d => d.id)); // all on by default

// --- Phase 09.2 D-23: Saved Views localStorage key ---
// Single-writer policy (AURORA-02 D-27): explorer.js writes ONLY to
// `dvhub.explorer.savedViews`. theme.js retains sole writer of `dvhub.theme`
// — DO NOT call localStorage.setItem on that key from this file.
const SAVED_VIEWS_KEY = 'dvhub.explorer.savedViews';

// --- Phase 09.2 D-22: Crosshair afterDraw plugin ---
// Chart.js native interaction.mode='index' (already set in renderChart()) provides
// the hit-detection; this plugin draws the vertical guide. No new NPM dep.
// afterDraw runs after the dataset is painted, so the line layers on top.
// Defensive early-returns guard against tt._active being empty during chart
// resize / before first hover (T-09.2-CHART-CRASH).
const verticalLinePlugin = {
  id: 'dvhub-crosshair',
  afterDraw(chart) {
    const tt = chart && chart.tooltip;
    if (!tt || !tt._active || !tt._active.length) return;
    const x = tt._active[0]?.element?.x;
    if (!Number.isFinite(x)) return;
    const c = chart.ctx;
    c.save();
    c.beginPath();
    c.moveTo(x, chart.chartArea.top);
    c.lineTo(x, chart.chartArea.bottom);
    c.lineWidth = 1;
    c.strokeStyle = 'rgba(255,212,33,0.5)'; // yellow accent (mockup line 172)
    c.setLineDash([2, 3]);
    c.stroke();
    c.restore();
  }
};

// --- Helpers ---
function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
// datetime-local input value format (local time, no seconds).
function fmtDateTimeLocal(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtRangeLabel(startISO, endISO) {
  const opts = { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' };
  return `${new Date(startISO).toLocaleString('de-DE', opts)} – ${new Date(endISO).toLocaleString('de-DE', opts)}`;
}
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }

// Returns [startISO, endISO] where endISO is EXCLUSIVE (suitable for
// /api/telemetry/series start≤ts<end). Preset ranges snap to local-midnight
// boundaries. Custom range honours the user-picked datetime-local values
// down to the minute.
function getDateRange() {
  const sel = document.getElementById('explorerRange').value;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const tomorrow = addDays(today, 1);
  switch (sel) {
    case 'today':     return [today.toISOString(),                 tomorrow.toISOString()];
    case 'yesterday': return [addDays(today, -1).toISOString(),    today.toISOString()];
    case '24h':       return [addDays(today, -1).toISOString(),    tomorrow.toISOString()];
    case '7d':        return [addDays(today, -6).toISOString(),    tomorrow.toISOString()];
    case '30d':       return [addDays(today, -29).toISOString(),   tomorrow.toISOString()];
    case 'custom': {
      const s = document.getElementById('explorerStart').value;
      const e = document.getElementById('explorerEnd').value;
      if (!s || !e) return [null, null];
      // datetime-local parses as local time → toISOString() converts to UTC.
      const startD = new Date(s);
      const endD = new Date(e);
      if (isNaN(startD) || isNaN(endD) || endD <= startD) return [null, null];
      return [startD.toISOString(), endD.toISOString()];
    }
  }
  return [today.toISOString(), tomorrow.toISOString()];
}

function setStatus(msg) {
  const el = document.getElementById('explorerStatus');
  if (el) el.textContent = msg;
}

function setChartSeriesCount(n) {
  const el = document.getElementById('explorerChartSeriesCount');
  if (el) el.textContent = String(n);
}

// --- Granular telemetry mode (5s / 10s / 15s / 30s / 1min / 5min) ---
//
// In granular mode we bypass /api/history/summary (which delivers 15min energy
// slots in kWh) and fetch directly from /api/telemetry/series at the raw 5s
// telemetry table — but capped at the user-picked maxResolution.
//
// 9 SERIES_DEFS map to one-or-more telemetry keys; the rest (forecasts,
// market price, EPEX overlay) have no per-second source and stay empty.
// gridKw uses imp − exp so its sign matches the slot-mode "Netz (Imp-Exp)"
// convention (positive = Bezug, negative = Einspeisung) regardless of which
// meter semantics (feed_in vs grid_import positive) the raw grid_total_w
// uses on this install.
//
// Server scan-cap MAX_TELEMETRY_SCAN_SLOTS=1,500,000. Larger ranges fall
// back to chunked day-by-day fetches in the CSV-export path. The autarkie
// derivation guards against division-by-zero by requiring load > 1 W.
const GRANULAR_SERIES_MAP = {
  // SERIES_DEFS.id  →  { tKeys: [series_key, ...], compute: (values) => number | null }
  pvKw:       { tKeys: ['pv_total_w'],
                compute: v => Number.isFinite(Number(v.pv_total_w)) ? Number(v.pv_total_w) / 1000 : null },
  loadKw:     { tKeys: ['load_power_w'],
                compute: v => Number.isFinite(Number(v.load_power_w)) ? Number(v.load_power_w) / 1000 : null },
  batteryKw:  { tKeys: ['battery_power_w'],
                compute: v => Number.isFinite(Number(v.battery_power_w)) ? Number(v.battery_power_w) / 1000 : null },
  gridKw:     { tKeys: ['grid_import_w', 'grid_export_w'],
                compute: v => {
                  const i = Number(v.grid_import_w), e = Number(v.grid_export_w);
                  if (!Number.isFinite(i) && !Number.isFinite(e)) return null;
                  return ((Number.isFinite(i) ? i : 0) - (Number.isFinite(e) ? e : 0)) / 1000;
                } },
  importKw:   { tKeys: ['grid_import_w'],
                compute: v => Number.isFinite(Number(v.grid_import_w)) ? Number(v.grid_import_w) / 1000 : null },
  exportKw:   { tKeys: ['grid_export_w'],
                compute: v => Number.isFinite(Number(v.grid_export_w)) ? Number(v.grid_export_w) / 1000 : null },
  selfConsKw: { tKeys: ['self_consumption_w'],
                compute: v => Number.isFinite(Number(v.self_consumption_w)) ? Number(v.self_consumption_w) / 1000 : null },
  autarkie:   { tKeys: ['self_consumption_w', 'load_power_w'],
                compute: v => {
                  const sc = Number(v.self_consumption_w), l = Number(v.load_power_w);
                  if (!Number.isFinite(sc) || !Number.isFinite(l) || l <= 1) return null;
                  return Math.min(100, (sc / l) * 100);
                } },
  soc:        { tKeys: ['battery_soc_pct'],
                compute: v => Number.isFinite(Number(v.battery_soc_pct)) ? Number(v.battery_soc_pct) : null }
};
// Flat union of every telemetry key we need across all granular series — used
// for the /api/telemetry/series ?keys= argument (deduplicated).
const GRANULAR_ALL_TELEMETRY_KEYS = [
  ...new Set(Object.values(GRANULAR_SERIES_MAP).flatMap(m => m.tKeys))
];
// Granularity → maxResolution in seconds. Storage backend (TimescaleDB) holds
// raw samples at ~5s; anything smaller than that returns the same data.
// Server scan-cap MAX_TELEMETRY_SCAN_SLOTS=50,000 limits range × keys × (1/res):
//   - 5s:  max ~12h (5 keys × 8640 = 43,200 slots/day)
//   - 10s: max ~24h
//   - 15s: max ~36h
//   - 30s: max ~3d
//   - 1min: max ~7d (just under cap)
//   - 5min: max ~30d
// scan_too_large errors bubble up to the user-facing status as a hint to
// shorten range or pick coarser resolution.
const GRANULAR_AGG_TO_SECONDS = {
  '5s':  5,
  '10s': 10,
  '15s': 15,
  '30s': 30,
  '1min': 60,
  '5min': 300
};

async function fetchGranularData(startISO, endISO, agg) {
  const maxRes = GRANULAR_AGG_TO_SECONDS[agg];
  if (!maxRes) throw new Error(`unsupported granular agg: ${agg}`);

  const keys = GRANULAR_ALL_TELEMETRY_KEYS.join(',');
  const url = `/api/telemetry/series?keys=${encodeURIComponent(keys)}&start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}&maxResolution=${maxRes}`;
  const res = await apiFetch(url);
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) {
    if (body?.error === 'scan_too_large') {
      throw new Error(`Zu viele Punkte (${body.requested?.toLocaleString?.('de-DE') || body.requested}) — Server-Limit ${body.limit?.toLocaleString?.('de-DE') || body.limit}. Kürzeren Zeitraum wählen oder höhere Aggregation.`);
    }
    throw new Error(body?.error || `HTTP ${res.status}`);
  }
  return body.data || [];
}

function buildGranularChartData(rows, agg) {
  // Group telemetry rows by timestamp → { ts, pv_power_w, load_power_w, ... }
  const byTs = new Map();
  for (const r of rows) {
    if (!byTs.has(r.ts)) byTs.set(r.ts, { ts: r.ts });
    byTs.get(r.ts)[r.key] = r.value;
  }
  const sorted = [...byTs.values()].sort((a, b) => a.ts.localeCompare(b.ts));

  // Time labels — granular mode shows HH:MM:SS precision
  const labels = sorted.map(s => {
    const d = new Date(s.ts);
    const sameDay = sorted.length > 0 && new Date(sorted[0].ts).toDateString() === new Date(sorted[sorted.length - 1].ts).toDateString();
    if (sameDay) {
      return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
    return d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  });

  // Build seriesData via each map entry's compute() — handles 1:1 telemetry
  // keys (pvKw, batteryKw, soc), W-scaled wrappers (load/import/export),
  // and derived series (gridKw = imp − exp; autarkie = selfCons / load * 100).
  const seriesData = {};
  for (const def of SERIES_DEFS) {
    const map = GRANULAR_SERIES_MAP[def.id];
    if (!map) { seriesData[def.id] = sorted.map(() => null); continue; }
    seriesData[def.id] = sorted.map(s => map.compute(s));
  }

  explorerData.labels = labels;
  explorerData.seriesData = seriesData;
  explorerData.granularMode = true;
  explorerData.granularRows = sorted;
  explorerData.granularAgg = agg;
}

// Returns the list of YYYY-MM-DD strings that the given ISO range touches —
// inclusive on both ends, in chronological order. Used for slot-mode's
// per-day /api/history/summary fetches and for CSV chunk iteration.
function daysCovered(startISO, endISO) {
  const startD = new Date(startISO);
  const lastD = new Date(new Date(endISO).getTime() - 1); // exclusive end → last ms still in range
  const dayStart = new Date(startD.getFullYear(), startD.getMonth(), startD.getDate());
  const dayLast = new Date(lastD.getFullYear(), lastD.getMonth(), lastD.getDate());
  const out = [];
  for (let d = new Date(dayStart); d <= dayLast; d = addDays(d, 1)) out.push(fmtDate(d));
  return out;
}

// --- Data fetching ---
async function fetchExplorerData() {
  const [startISO, endISO] = getDateRange();
  if (!startISO || !endISO) { setStatus('Bitte gültigen Zeitbereich wählen.'); return; }

  setStatus('Lade Daten...');
  const agg = document.getElementById('explorerAgg').value;
  const rangeLabel = fmtRangeLabel(startISO, endISO);

  // Route: granular path for any agg present in GRANULAR_AGG_TO_SECONDS
  // (5s/10s/15s/30s/1min/5min); legacy slot path for 15min / 1h / day.
  if (GRANULAR_AGG_TO_SECONDS[agg]) {
    try {
      const rows = await fetchGranularData(startISO, endISO, agg);
      explorerData.rawSlots = [];
      explorerData.rawFc = null;
      explorerData.rawEpex = [];
      explorerData.rawSoc = [];
      buildGranularChartData(rows, agg);
      renderChart();
      setStatus(`${rows.length.toLocaleString('de-DE')} Telemetry-Punkte geladen (${agg} · ${rangeLabel}).`);
    } catch (e) {
      setStatus(`Fehler: ${e.message}`);
    }
    return;
  }

  // Legacy slot-aggregation path (15min / 1h / day)
  explorerData.granularMode = false;
  explorerData.granularRows = null;
  try {
    const allSlots = [];
    const dayPromises = daysCovered(startISO, endISO).map(dateStr =>
      apiFetch(`/api/history/summary?view=day&date=${dateStr}`)
        .then(r => r.json())
        .then(data => ({ date: dateStr, slots: data.slots || [] }))
        .catch(() => ({ date: dateStr, slots: [] }))
    );

    const dayResults = await Promise.all(dayPromises);
    dayResults.sort((a, b) => a.date.localeCompare(b.date));
    for (const dr of dayResults) allSlots.push(...dr.slots);

    const [fcData, statusData, socData] = await Promise.all([
      apiFetch('/api/forecast').then(r => r.json()).catch(() => null),
      apiFetch('/api/status').then(r => r.json()).catch(() => null),
      apiFetch(`/api/telemetry/series?keys=battery_soc_pct&start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}`).then(r => r.json()).catch(() => null)
    ]);

    explorerData.rawSlots = allSlots;
    explorerData.rawFc = fcData;
    explorerData.rawEpex = statusData?.epex?.data || [];
    explorerData.rawSoc = socData?.data || [];

    const slots = aggregateSlots(allSlots, agg);
    buildChartData(slots, fcData, statusData?.epex?.data || [], agg, explorerData.rawSoc);
    renderChart();
    setStatus(`${allSlots.length.toLocaleString('de-DE')} Slots geladen (${rangeLabel}).`);
  } catch (e) {
    setStatus(`Fehler: ${e.message}`);
  }
}

function aggregateSlots(slots, agg) {
  if (agg === '15min') return slots;
  const buckets = new Map();
  for (const slot of slots) {
    const d = new Date(slot.ts);
    let key;
    if (agg === '1h') { d.setMinutes(0, 0, 0); key = d.toISOString(); }
    else { key = d.toISOString().slice(0, 10); }
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(slot);
  }
  const result = [];
  for (const [key, group] of buckets) {
    const bucket = { ts: key };
    const numKeys = ['pvKwh', 'loadKwh', 'importKwh', 'exportKwh', 'batteryKwh', 'batteryChargeKwh', 'batteryDischargeKwh', 'selfConsumptionKwh'];
    for (const k of numKeys) {
      bucket[k] = group.reduce((sum, s) => sum + (Number(s[k]) || 0), 0);
    }
    const lastWithSoc = [...group].reverse().find(s => s.soc != null);
    if (lastWithSoc) bucket.soc = lastWithSoc.soc;
    const prices = group.map(s => Number(s.marketPriceCtKwh)).filter(v => Number.isFinite(v));
    if (prices.length) bucket.marketPriceCtKwh = prices.reduce((a, b) => a + b, 0) / prices.length;
    const uPrices = group.map(s => Number(s.userImportPriceCtKwh)).filter(v => Number.isFinite(v));
    if (uPrices.length) bucket.userImportPriceCtKwh = uPrices.reduce((a, b) => a + b, 0) / uPrices.length;
    result.push(bucket);
  }
  return result;
}

function buildChartData(slots, fcData, epexData, agg, socSamples = []) {
  const slotMinutes = agg === '15min' ? 15 : agg === '1h' ? 60 : 1440;
  const kwFactor = 60 / slotMinutes;

  const labels = slots.map(s => {
    const d = new Date(s.ts);
    if (agg === 'day') return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
    return d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  });

  const fcSolarArr = (fcData?.solar || []).map(p => ({ ts: new Date(p.ts).getTime(), v: p.w / 1000 })).sort((a, b) => a.ts - b.ts);
  const fcConsArr = (fcData?.consumption || []).map(p => ({ ts: new Date(p.ts).getTime(), v: p.w / 1000 })).sort((a, b) => a.ts - b.ts);
  const socArr = (socSamples || []).map(p => ({ ts: new Date(p.ts).getTime(), v: Number(p.value) })).filter(p => Number.isFinite(p.v)).sort((a, b) => a.ts - b.ts);
  const epexMap = new Map();
  if (epexData) epexData.forEach(p => epexMap.set(Number(p.ts), Number(p.ct_kwh)));

  function interpol(arr, ts) {
    if (!arr.length) return null;
    if (ts <= arr[0].ts) return arr[0].v;
    if (ts >= arr[arr.length - 1].ts) return arr[arr.length - 1].v;
    for (let j = 0; j < arr.length - 1; j++) {
      if (ts >= arr[j].ts && ts <= arr[j + 1].ts) {
        const r = (ts - arr[j].ts) / (arr[j + 1].ts - arr[j].ts);
        return arr[j].v + r * (arr[j + 1].v - arr[j].v);
      }
    }
    return null;
  }
  function findEpex(ts) {
    const direct = epexMap.get(ts);
    if (direct != null) return direct;
    const rounded = Math.round(ts / 900000) * 900000;
    return epexMap.get(rounded) ?? null;
  }

  const seriesData = {};
  for (const def of SERIES_DEFS) {
    seriesData[def.id] = slots.map(s => {
      const ts = new Date(s.ts).getTime();
      if (def.key === '_gridNet') {
        const imp = Number(s.importKwh || 0);
        const exp = Number(s.exportKwh || 0);
        return (imp - exp) * kwFactor;
      }
      if (def.key === '_soc') return interpol(socArr, ts);
      if (def.key === '_pvFc') return interpol(fcSolarArr, ts);
      if (def.key === '_consFc') return interpol(fcConsArr, ts);
      if (def.key === '_marketCt') {
        const slotPrice = Number(s.marketPriceCtKwh);
        return Number.isFinite(slotPrice) ? slotPrice : findEpex(ts);
      }
      if (def.key === '_importCt') {
        const v = Number(s.userImportPriceCtKwh);
        return Number.isFinite(v) ? v : null;
      }
      if (def.key === '_autarkie') {
        const load = Number(s.loadKwh || 0);
        const selfCons = Number(s.selfConsumptionKwh || 0);
        return load > 0.001 ? Math.min(100, (selfCons / load) * 100) : null;
      }
      const val = Number(s[def.key]);
      return Number.isFinite(val) ? (def.toKw ? val * kwFactor : val) : null;
    });
  }

  explorerData.labels = labels;
  explorerData.seriesData = seriesData;
}

function buildDatasets() {
  const datasets = [];
  for (const def of SERIES_DEFS) {
    if (!activeSeriesIds.has(def.id)) continue;
    const data = explorerData.seriesData?.[def.id];
    if (!data || !data.some(v => v != null)) continue;
    datasets.push({
      label: def.label,
      data: data,
      borderColor: def.color,
      backgroundColor: def.color + '18',
      borderWidth: 2,
      borderDash: def.dash || [],
      pointRadius: 0,
      pointHoverRadius: 3,
      fill: false,
      spanGaps: true,
      yAxisID: def.axis,
      tension: 0.3
    });
  }
  return datasets;
}

function renderChart() {
  const canvas = document.getElementById('explorerCanvas');
  if (!canvas || typeof Chart === 'undefined') return;

  if (explorerChart) { explorerChart.destroy(); explorerChart = null; }

  const datasets = buildDatasets();
  setChartSeriesCount(datasets.length);
  if (!datasets.length) { setStatus('Keine Daten für die ausgewählten Serien.'); return; }

  const usedAxes = new Set(datasets.map(d => d.yAxisID));
  const scales = {
    x: {
      ticks: { color: '#9ca3af', font: { size: 9 }, maxRotation: 45, autoSkip: true, maxTicksLimit: 20 },
      grid: { color: '#e5e7eb20' }
    }
  };
  if (usedAxes.has('kw')) {
    scales.kw = {
      position: 'left',
      title: { display: true, text: 'kW', color: '#f5c451', font: { size: 11 } },
      ticks: { color: '#f5c451', font: { size: 9 } },
      grid: { color: '#e5e7eb15' },
      beginAtZero: false
    };
  }
  if (usedAxes.has('ct')) {
    scales.ct = {
      position: usedAxes.has('kw') ? 'right' : 'left',
      title: { display: true, text: 'ct/kWh', color: '#0077ff', font: { size: 11 } },
      ticks: { color: '#0077ff', font: { size: 9 } },
      grid: { display: false },
      beginAtZero: false
    };
  }
  if (usedAxes.has('pct')) {
    scales.pct = {
      position: 'right',
      title: { display: true, text: '%', color: '#67a5ff', font: { size: 11 } },
      ticks: { color: '#67a5ff', font: { size: 9 } },
      grid: { display: false },
      min: 0, max: 100
    };
  }

  explorerChart = new Chart(canvas, {
    type: 'line',
    data: { labels: explorerData.labels, datasets },
    // Phase 09.2 D-22: register the crosshair afterDraw plugin alongside the
    // chart so it ships per-instance (no global Chart.register side-effect).
    plugins: [verticalLinePlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: true,
          position: 'nearest',
          // Aurora-token tooltip styling (mockup lines 180-188): dark glass
          // background + JetBrains Mono for crisp digit alignment.
          backgroundColor: 'rgba(8, 14, 28, 0.94)',
          titleColor: 'rgba(255,255,255,0.6)',
          bodyColor: 'rgba(255,255,255,0.85)',
          titleFont: { family: "'JetBrains Mono', monospace", size: 11 },
          bodyFont:  { family: "'JetBrains Mono', monospace", size: 11 },
          borderColor: 'rgba(180,210,255,0.18)',
          borderWidth: 1,
          padding: 10,
          displayColors: true,
          callbacks: {
            label: (ctx) => {
              const v = ctx.raw;
              if (v == null) return null;
              return `${ctx.dataset.label}: ${Number(v).toFixed(2)} ${SERIES_DEFS.find(d => d.label === ctx.dataset.label)?.unit || ''}`;
            }
          }
        },
        zoom: {
          // Plain drag = brush-to-drilldown (refetch finer); Shift+drag = pan.
          // Wheel + pinch also fire onZoomComplete and trigger the same
          // refetch (debounced 400ms so rapid wheel ticks coalesce).
          pan: { enabled: true, mode: 'x', modifierKey: 'shift' },
          zoom: {
            wheel: { enabled: true },
            pinch: { enabled: true },
            drag: {
              enabled: true,
              backgroundColor: 'rgba(103, 165, 255, 0.18)',
              borderColor: 'rgba(103, 165, 255, 0.55)',
              borderWidth: 1,
              threshold: 8
            },
            mode: 'x',
            onZoomComplete: onChartZoomComplete
          },
          limits: { x: { minRange: 4 } }
        }
      },
      scales
    }
  });
}

// --- Signal list (rail) — replaces legacy .explorer-series-chip strip ---
function renderSignalList() {
  const container = document.getElementById('explorerSeriesChips');
  if (!container) return;
  const searchVal = (document.getElementById('explorerSignalSearch')?.value || '').toLowerCase();
  const filtered = SERIES_DEFS.filter(def => {
    if (!searchVal) return true;
    return def.id.toLowerCase().includes(searchVal) ||
           def.label.toLowerCase().includes(searchVal);
  });
  const rows = filtered.map(def => {
    const active = activeSeriesIds.has(def.id);
    return `<label class="sig-row${active ? ' is-active' : ''}" data-series="${def.id}">
      <input type="checkbox" data-series-cb="${def.id}"${active ? ' checked' : ''} aria-label="${def.label}">
      <span class="sig-sw" data-sig-color="${def.color}"></span>
      <span class="sig-name">${def.label}</span>
      <span class="sig-unit">${def.unit}</span>
    </label>`;
  }).join('');
  container.innerHTML = rows;
  // CSP-safe: apply per-series swatch background after innerHTML
  // (style="background:..." in innerHTML is blocked by style-src
  // without 'unsafe-inline'; data-attr + property setter is allowed).
  container.querySelectorAll('[data-sig-color]').forEach((el) => { el.style.background = el.dataset.sigColor; });

  const countEl = document.getElementById('explorerSignalCount');
  if (countEl) countEl.textContent = `${activeSeriesIds.size} / ${SERIES_DEFS.length}`;
}

// --- Pill button → hidden <select> sync ---
function wirePillGroup(groupEl) {
  const targetId = groupEl.getAttribute('data-pill-target');
  const target = document.getElementById(targetId);
  if (!target) return;
  groupEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-pill-value]');
    if (!btn) return;
    const val = btn.getAttribute('data-pill-value');
    target.value = val;
    // Activate clicked, deactivate siblings
    const siblings = groupEl.querySelectorAll('button[data-pill-value]');
    siblings.forEach(s => s.classList.toggle('is-active', s === btn));
    // Fire change so existing handlers (range custom-toggle) react
    target.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

// --- CSV Export ---
//
// Independent of chart state: re-queries the full selected range at the
// currently picked resolution and ships every row. For granular pills
// (5s/10s/15s/30s/1min/5min) we chunk day-by-day so the server scan-cap
// (1.5M slots) is never hit even on 30d × 5s × 5 keys (= 2.6M slots
// total, but ≤86,400/day per key).
async function exportCsv() {
  const [startISO, endISO] = getDateRange();
  if (!startISO || !endISO) { setStatus('Bitte gültigen Zeitbereich wählen.'); return; }
  const agg = document.getElementById('explorerAgg').value;
  const granular = GRANULAR_AGG_TO_SECONDS[agg];

  const btn = document.getElementById('explorerCsvBtn');
  const prevLabel = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Exportiere…'; }

  try {
    if (granular) {
      await exportCsvGranular(startISO, endISO, agg);
    } else {
      await exportCsvSlots(startISO, endISO, agg);
    }
  } catch (e) {
    setStatus(`CSV-Export Fehler: ${e.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = prevLabel || 'CSV Export'; }
  }
}

// Granular export: walk the [startISO, endISO) range in ≤24h chunks anchored
// at the start. Each chunk fetches at the user-picked maxResolution. Server
// cap (1.5M slots) is never hit per request — at 5s × 5 keys × 86,400s/day
// = 432,000 slots, well below cap.
async function exportCsvGranular(startISO, endISO, agg) {
  const maxRes = GRANULAR_AGG_TO_SECONDS[agg];
  const activeDefs = SERIES_DEFS.filter(d => activeSeriesIds.has(d.id) && GRANULAR_SERIES_MAP[d.id]);
  if (!activeDefs.length) { setStatus('Keine Granular-Serie ausgewählt.'); return; }
  const tKeys = [...new Set(activeDefs.flatMap(d => GRANULAR_SERIES_MAP[d.id].tKeys))];

  const startMs = new Date(startISO).getTime();
  const endMs = new Date(endISO).getTime();
  const chunkMs = 86_400_000; // 24h
  const chunkCount = Math.max(1, Math.ceil((endMs - startMs) / chunkMs));
  const byTs = new Map();
  let totalFetched = 0;

  for (let i = 0; i < chunkCount; i++) {
    const chunkStart = startMs + i * chunkMs;
    const chunkEnd = Math.min(chunkStart + chunkMs, endMs);
    const chunkStartIso = new Date(chunkStart).toISOString();
    const chunkEndIso = new Date(chunkEnd).toISOString();
    const chunkLabel = fmtDate(new Date(chunkStart));
    setStatus(`CSV-Export · Chunk ${i + 1}/${chunkCount} (${chunkLabel})…`);
    const url = `/api/telemetry/series?keys=${encodeURIComponent(tKeys.join(','))}&start=${encodeURIComponent(chunkStartIso)}&end=${encodeURIComponent(chunkEndIso)}&maxResolution=${maxRes}`;
    const res = await apiFetch(url);
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.ok) {
      throw new Error(body?.error === 'scan_too_large'
        ? `Chunk ${chunkLabel}: zu groß für eine Range — wähle gröbere Auflösung.`
        : (body?.error || `HTTP ${res.status}`));
    }
    for (const r of (body.data || [])) {
      if (!byTs.has(r.ts)) byTs.set(r.ts, { ts: r.ts });
      byTs.get(r.ts)[r.key] = r.value;
    }
    totalFetched += (body.data || []).length;
  }

  const sorted = [...byTs.values()].sort((a, b) => a.ts.localeCompare(b.ts));
  const header = ['Zeitpunkt-ISO', ...activeDefs.map(d => `${d.label} (${d.unit})`)];
  const rows = sorted.map(s => {
    const cells = [s.ts];
    for (const d of activeDefs) {
      const v = GRANULAR_SERIES_MAP[d.id].compute(s);
      cells.push(v != null && Number.isFinite(v) ? Number(v).toFixed(3).replace('.', ',') : '');
    }
    return cells.join(';');
  });
  const fnameStart = fmtDate(new Date(startISO));
  const fnameEnd = fmtDate(new Date(new Date(endISO).getTime() - 1));
  downloadCsv(`dvhub-explorer-${agg}-${fnameStart}_${fnameEnd}.csv`, [header.join(';'), ...rows].join('\n'));
  setStatus(`CSV mit ${sorted.length.toLocaleString('de-DE')} Zeilen exportiert (${totalFetched.toLocaleString('de-DE')} Telemetry-Punkte aus ${chunkCount} Chunk(s)).`);
}

// Slot export (15min / 1h / day) — use what's in memory, which already
// covers the full range from fetchExplorerData's existing day-by-day loop.
async function exportCsvSlots(startISO, endISO, agg) {
  if (!explorerData.labels.length) { setStatus('Erst Daten laden, dann exportieren.'); return; }
  const activeDefs = SERIES_DEFS.filter(d => activeSeriesIds.has(d.id) && explorerData.seriesData?.[d.id]);
  const header = ['Zeitpunkt', ...activeDefs.map(d => `${d.label} (${d.unit})`)];
  const rows = explorerData.labels.map((label, i) => {
    return [label, ...activeDefs.map(d => {
      const v = explorerData.seriesData[d.id][i];
      return v != null ? Number(v).toFixed(3).replace('.', ',') : '';
    })].join(';');
  });
  const fnameStart = fmtDate(new Date(startISO));
  const fnameEnd = fmtDate(new Date(new Date(endISO).getTime() - 1));
  downloadCsv(`dvhub-explorer-${agg}-${fnameStart}_${fnameEnd}.csv`, [header.join(';'), ...rows].join('\n'));
  setStatus(`CSV mit ${rows.length.toLocaleString('de-DE')} Zeilen exportiert.`);
}

function downloadCsv(filename, csv) {
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// --- Brush-to-drilldown ---
//
// Chart.js zoom plugin fires onZoomComplete after every user-driven zoom
// (drag rectangle, wheel, pinch). We debounce by 400ms so rapid wheel
// ticks coalesce into a single refetch, then re-query at the finest
// resolution the new window can carry under the server's 1.5M cap.
// drilldownInFlight guards against feedback loops from the post-fetch
// chart re-render.
let drilldownInFlight = false;
let drilldownDebounceId = null;

function onChartZoomComplete({ chart }) {
  if (drilldownInFlight) return;
  clearTimeout(drilldownDebounceId);
  drilldownDebounceId = setTimeout(() => applyDrilldown(chart), 400);
}

async function applyDrilldown(chart) {
  if (!chart || !chart.scales || !chart.scales.x) return;
  // The X-axis is a CATEGORY scale (labels are formatted strings), so
  // scale.min/max are fractional INDICES, not timestamps. Map back to
  // the underlying ISO ts via granularRows (granular mode) or rawSlots
  // (slot mode).
  const rows = explorerData.granularMode
    ? explorerData.granularRows
    : explorerData.rawSlots;
  if (!Array.isArray(rows) || rows.length < 2) return;

  const scale = chart.scales.x;
  const minIdx = Math.max(0, Math.floor(scale.min));
  const maxIdx = Math.min(rows.length - 1, Math.ceil(scale.max));
  if (maxIdx - minIdx < 2) return; // ignore noise / tiny zooms

  const startISO = rows[minIdx]?.ts;
  const endISO = rows[maxIdx]?.ts;
  if (!startISO || !endISO) return;

  // Push the brushed range into the datetime-local inputs and the
  // hidden <select>s so the user can see + edit + re-trigger.
  const startD = new Date(startISO);
  const endD = new Date(endISO);
  document.getElementById('explorerStart').value = fmtDateTimeLocal(startD);
  document.getElementById('explorerEnd').value = fmtDateTimeLocal(endD);

  const rangeSel = document.getElementById('explorerRange');
  rangeSel.value = 'custom';
  document.getElementById('customStartWrap').classList.remove('u-hidden');
  document.getElementById('customEndWrap').classList.remove('u-hidden');
  document.querySelectorAll('.timerange-pills[data-pill-target="explorerRange"] button[data-pill-value]').forEach(b => {
    b.classList.toggle('is-active', b.getAttribute('data-pill-value') === 'custom');
  });

  // Pick the finest pill that comfortably fits under the cap.
  const windowSec = Math.max(1, (endD - startD) / 1000);
  const finerPill = pickFinerAggForWindow(windowSec);
  const aggSel = document.getElementById('explorerAgg');
  aggSel.value = finerPill;
  document.querySelectorAll('.timerange-pills[data-pill-target="explorerAgg"] button[data-pill-value]').forEach(b => {
    b.classList.toggle('is-active', b.getAttribute('data-pill-value') === finerPill);
  });

  drilldownInFlight = true;
  try {
    await fetchExplorerData();
  } finally {
    drilldownInFlight = false;
  }
}

// Pill ladder, finest first. Picks the first where the slot count stays
// under MARGIN (half the server cap), so the user has headroom for
// further client-side wheel zooms.
const DRILLDOWN_AGG_LADDER = [
  ['5s', 5], ['10s', 10], ['15s', 15], ['30s', 30],
  ['1min', 60], ['5min', 300], ['15min', 900], ['1h', 3600], ['day', 86400]
];
function pickFinerAggForWindow(windowSec) {
  const MARGIN = 750_000;
  const activeKeys = Math.max(1, GRANULAR_ALL_TELEMETRY_KEYS.length);
  for (const [name, sec] of DRILLDOWN_AGG_LADDER) {
    if ((windowSec / sec) * activeKeys < MARGIN) return name;
  }
  return 'day';
}

// --- Phase 09.2 D-21: Source-Chips render + toggle (CSP-clean) ---
// Renders the 5 source-filter chips into #explorerSourceChips. Dot color is
// driven by .source-chip .dot.dot-<id> classes — we never embed style="..."
// in the innerHTML template literal (CSP `style-src` blocks inline styles).
// Re-rendering on every toggle is cheap (5 DOM nodes) and keeps the
// `is-active` + `aria-pressed` attrs in lockstep without per-chip mutation.
function renderSourceChips() {
  const container = document.getElementById('explorerSourceChips');
  if (!container) return;
  container.innerHTML = SOURCE_DEFS.map(def => {
    const active = activeSourceChips.has(def.id);
    return `<button type="button" class="source-chip${active ? ' is-active' : ''}" data-source="${def.id}" aria-pressed="${active ? 'true' : 'false'}">
      <span class="dot ${def.dotClass}"></span>${def.label}
    </button>`;
  }).join('');
}

// --- Phase 09.2 D-23: Saved Views localStorage CRUD ---
// Single-writer policy (AURORA-02 D-27): writes ONLY to dvhub.explorer.savedViews.
// theme.js retains sole writer of dvhub.theme — never call setItem on that key.
// Stored payload: [{ name, signals, sources, timerange, aggregation, savedAt }, …]
// All read paths defend against malformed JSON / non-array root and clamp to
// 100 entries (cap against unbounded growth from a hostile script).
function loadSavedViews() {
  try {
    const raw = localStorage.getItem(SAVED_VIEWS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.slice(0, 100) : [];
  } catch { return []; }
}

function saveSavedViews(views) {
  try {
    const arr = Array.isArray(views) ? views.slice(0, 100) : [];
    localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(arr));
  } catch { /* quota / private mode — silently no-op */ }
}

function captureCurrentView(name) {
  return {
    name: String(name || '').slice(0, 64), // T-09.2-LSXSS: clamp on save
    signals: [...activeSeriesIds],
    sources: [...activeSourceChips],
    timerange: document.getElementById('explorerRange')?.value || null,
    aggregation: document.getElementById('explorerAgg')?.value || null,
    savedAt: new Date().toISOString()
  };
}

// applyView mutates module-level state (activeSeriesIds, activeSourceChips) and
// the hidden range/agg <select>s. Source IDs are validated against SOURCE_DEFS
// before being added (T-09.2-LSXSS guard against arbitrary stored values).
// Signal IDs are also validated against SERIES_DEFS for the same reason.
// The caller is responsible for invoking scheduleAutoFetch + re-rendering the
// signal-list / source-chips (the closure-scoped scheduleAutoFetch lives in
// initExplorer, so we hand the callback in instead of importing it).
function applyView(view, scheduleAutoFetchFn, renderSignalListFn) {
  if (!view || typeof view !== 'object') return;
  activeSeriesIds.clear();
  if (Array.isArray(view.signals)) {
    for (const id of view.signals) {
      if (typeof id === 'string' && SERIES_DEFS.find(d => d.id === id)) activeSeriesIds.add(id);
    }
  }
  activeSourceChips.clear();
  if (Array.isArray(view.sources)) {
    for (const s of view.sources) {
      if (typeof s === 'string' && SOURCE_DEFS.find(d => d.id === s)) activeSourceChips.add(s);
    }
  }
  const rangeEl = document.getElementById('explorerRange');
  const aggEl = document.getElementById('explorerAgg');
  if (rangeEl && typeof view.timerange === 'string') rangeEl.value = view.timerange;
  if (aggEl && typeof view.aggregation === 'string') aggEl.value = view.aggregation;
  // Sync the visible pill state to the new <select>.value (the pill click
  // delegates flip the .is-active class, but a programmatic .value change
  // does not auto-update them).
  syncPillsToSelect('explorerRange');
  syncPillsToSelect('explorerAgg');
  if (typeof renderSignalListFn === 'function') renderSignalListFn();
  renderSourceChips();
  if (typeof scheduleAutoFetchFn === 'function') scheduleAutoFetchFn();
}

function syncPillsToSelect(selectId) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const buttons = document.querySelectorAll(`.timerange-pills[data-pill-target="${selectId}"] button[data-pill-value]`);
  buttons.forEach(b => b.classList.toggle('is-active', b.getAttribute('data-pill-value') === sel.value));
}

// renderSavedViewsMenu builds the dropdown DOM at #explorerSavedViewsMenu (created
// on first call as a body-level child so it floats over the chart). All stored
// values are written into the DOM via .textContent (NEVER innerHTML) per
// T-09.2-LSXSS — even though the saved-views payload is local-origin-only,
// the textContent path is the safe canonical pattern.
function renderSavedViewsMenu() {
  let menu = document.getElementById('explorerSavedViewsMenu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'explorerSavedViewsMenu';
    menu.className = 'saved-views-menu';
    menu.setAttribute('role', 'menu');
    document.body.appendChild(menu);
  }
  const views = loadSavedViews();
  // Markup-only structure (no stored content interpolated). Names hydrated below.
  menu.innerHTML = `
    <div class="saved-views-menu-actions">
      <button type="button" class="btn sm" data-act="save">+ Aktuelle Ansicht speichern</button>
    </div>
    <div class="saved-views-menu-list">
      ${views.map((_, i) => `
        <div class="saved-view-row" data-idx="${i}">
          <span class="saved-view-name"></span>
          <span class="saved-view-actions">
            <button type="button" class="btn xs ghost" data-act="apply" data-idx="${i}" title="Anwenden">→</button>
            <button type="button" class="btn xs ghost" data-act="delete" data-idx="${i}" title="Löschen">✕</button>
          </span>
        </div>
      `).join('') || '<div class="saved-views-menu-empty">Noch keine Ansichten gespeichert.</div>'}
    </div>
  `;
  // T-09.2-LSXSS — hydrate names via textContent (never innerHTML)
  menu.querySelectorAll('.saved-view-row').forEach((row) => {
    const idx = Number(row.dataset.idx);
    const v = views[idx];
    const nameEl = row.querySelector('.saved-view-name');
    if (nameEl && v) nameEl.textContent = (typeof v.name === 'string' && v.name) ? v.name : '(unbenannt)';
  });
  return menu;
}

// --- Phase 09.2 D-12 + D-24: Server-side export trigger helpers ---
// The CSV / Parquet endpoints require Bearer auth (Plan 09.2-05 D-15:
// `/api/history/raw/export.*` is in BEARER_REQUIRED_ENDPOINTS). Bearer is
// stored in sessionStorage and only `apiFetch()` (common.js) appends it.
// `window.location` cannot send custom headers, so we use the Blob-download
// pattern instead (same shape as the existing client-side downloadCsv()
// helper at the top of this file).
//
// Server `signals=` expects raw `series_key` strings (e.g. `pv_total_w`),
// NOT chart display IDs (e.g. `pvKw`). We map active chart IDs through
// GRANULAR_SERIES_MAP[id].tKeys to get the underlying telemetry-store keys,
// dedupe across selections, and join CSV. Rule 1 fix: the planner's
// snippet `signals: [...activeSeriesIds]` would have produced zero rows.
function buildExportParams() {
  const p = new URLSearchParams();
  const [startISO, endISO] = getDateRange();
  if (startISO) p.set('from', startISO);
  if (endISO) p.set('to', endISO);
  // Map active chart series → underlying series_key strings via GRANULAR_SERIES_MAP.
  // Series with no map entry (forecasts, EPEX overlay, market price) have no
  // raw telemetry source — they're excluded from the export, which matches
  // the existing exportCsvGranular() behaviour (lines 580-628).
  const tKeys = new Set();
  for (const id of activeSeriesIds) {
    const map = GRANULAR_SERIES_MAP[id];
    if (map && Array.isArray(map.tKeys)) map.tKeys.forEach(k => tKeys.add(k));
  }
  if (tKeys.size) p.set('signals', [...tKeys].join(','));
  // Source filter — only emit if it would constrain the result (server returns
  // all sources by default when omitted). Keeps URLs short for the common
  // "all chips active" case.
  if (activeSourceChips.size && activeSourceChips.size < SOURCE_DEFS.length) {
    p.set('sources', [...activeSourceChips].join(','));
  }
  return p;
}

// Fetch the export endpoint as a Blob (carrying Bearer header via apiFetch),
// then trigger a same-shape <a download> click. Mirrors the existing
// downloadCsv() helper; reused for both CSV and Parquet paths.
async function downloadServerExport(endpoint, suggestedName) {
  if (!apiFetch) throw new Error('apiFetch unavailable (common.js not loaded)');
  const res = await apiFetch(endpoint);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  const blob = await res.blob();
  // Honour server-derived filename when present; fall back to caller's suggestion.
  let filename = suggestedName;
  const cd = res.headers.get('content-disposition') || '';
  const match = /filename="?([^";]+)"?/i.exec(cd);
  if (match && match[1]) filename = match[1];
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Defer revoke to next tick so Safari has a chance to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// --- Init ---
function initExplorer() {
  const rangeSelect = document.getElementById('explorerRange');
  const customStart = document.getElementById('customStartWrap');
  const customEnd = document.getElementById('customEndWrap');

  // datetime-local default: last 24h, minute precision in local time.
  const now = new Date();
  const yesterday = new Date(now.getTime() - 86_400_000);
  document.getElementById('explorerStart').value = fmtDateTimeLocal(yesterday);
  document.getElementById('explorerEnd').value = fmtDateTimeLocal(now);

  // initialFetchDone gate keeps the auto-fetch listeners below from firing
  // during initExplorer's own auto-load (which runs at the bottom). Once the
  // initial load completes, subsequent .value changes (from pill clicks)
  // re-fetch automatically — so picking 5s / 10s / etc. immediately re-loads
  // the chart instead of waiting for "Abfrage starten".
  let initialFetchDone = false;
  let autoFetchDebounce = null;
  function scheduleAutoFetch() {
    if (!initialFetchDone) return;
    clearTimeout(autoFetchDebounce);
    autoFetchDebounce = setTimeout(() => fetchExplorerData(), 180);
  }

  rangeSelect.addEventListener('change', () => {
    const isCustom = rangeSelect.value === 'custom';
    customStart.classList.toggle('u-hidden', !isCustom);
    customEnd.classList.toggle('u-hidden', !isCustom);
    // Custom range needs operator to fill the date pickers first; do NOT
    // auto-fetch on the 'custom' value itself. All other range values
    // (24h, 7d, 30d, today, yesterday) trigger an immediate reload.
    if (!isCustom) scheduleAutoFetch();
  });

  // Aggregation change always auto-fetches — picking 5s / 1min / etc. should
  // immediately re-query at the new resolution. Without this, the user has
  // to click "Abfrage starten" after every pill click, which is unexpected.
  document.getElementById('explorerAgg').addEventListener('change', scheduleAutoFetch);

  // Wire all pill-groups (range, aggregation). The pill click dispatches a
  // 'change' event on the hidden <select>, which the listeners above handle.
  document.querySelectorAll('.timerange-pills[data-pill-target]').forEach(wirePillGroup);

  // Wire signal-list checkboxes via event delegation (CSP-clean)
  const sigList = document.getElementById('explorerSeriesChips');
  if (sigList) {
    sigList.addEventListener('change', (e) => {
      const cb = e.target.closest('input[data-series-cb]');
      if (!cb) return;
      const id = cb.getAttribute('data-series-cb');
      if (cb.checked) activeSeriesIds.add(id);
      else activeSeriesIds.delete(id);
      renderSignalList();
      if (explorerData.labels.length) renderChart();
    });
  }

  // Signal search filter
  const search = document.getElementById('explorerSignalSearch');
  if (search) {
    search.addEventListener('input', () => renderSignalList());
  }

  document.getElementById('explorerLoadBtn').addEventListener('click', fetchExplorerData);
  document.getElementById('explorerResetZoomBtn').addEventListener('click', () => {
    if (explorerChart) explorerChart.resetZoom();
  });

  // --- Phase 09.2 D-12: CSV export → /api/history/raw/export.csv ---
  // Replaces the legacy chunked client-side exportCsv() (lines 553-629) that
  // shipped a per-day fetch loop against /api/telemetry/series. The server
  // endpoint now does the streaming directly via pg-cursor (Plan 09.2-06)
  // and ships ts_utc/series_key/value/unit rows in raw shape — caller
  // post-processes if a different layout is desired.
  document.getElementById('explorerCsvBtn').addEventListener('click', async () => {
    const btn = document.getElementById('explorerCsvBtn');
    const prev = btn ? btn.textContent : null;
    if (btn) { btn.disabled = true; btn.textContent = 'Exportiere…'; }
    try {
      const params = buildExportParams();
      const today = new Date().toISOString().slice(0, 10);
      await downloadServerExport(`/api/history/raw/export.csv?${params.toString()}`, `dvhub-export-${today}.csv`);
      setStatus('CSV-Export abgeschlossen.');
    } catch (e) {
      setStatus(`CSV-Export Fehler: ${e.message}`);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = prev || '↓ CSV'; }
    }
  });

  // --- Phase 09.2 D-13/D-24: Parquet export → /api/history/raw/export.parquet ---
  // Server-side @dsnp/parquetjs streams a binary Parquet file the user can load
  // directly into DuckDB / pandas / Polars. Same Bearer-auth path as the CSV
  // button (apiFetch + Blob — window.location cannot send the Authorization
  // header that BEARER_REQUIRED_ENDPOINTS demands). Same buildExportParams()
  // produces the URL: from, to, signals (mapped via GRANULAR_SERIES_MAP.tKeys),
  // sources (only when constraining).
  document.getElementById('explorerParquetBtn').addEventListener('click', async () => {
    const btn = document.getElementById('explorerParquetBtn');
    const prev = btn ? btn.textContent : null;
    if (btn) { btn.disabled = true; btn.textContent = 'Exportiere…'; }
    try {
      const params = buildExportParams();
      const today = new Date().toISOString().slice(0, 10);
      await downloadServerExport(`/api/history/raw/export.parquet?${params.toString()}`, `dvhub-export-${today}.parquet`);
      setStatus('Parquet-Export abgeschlossen.');
    } catch (e) {
      setStatus(`Parquet-Export Fehler: ${e.message}`);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = prev || '↓ Parquet'; }
    }
  });

  // --- Phase 09.2 D-21: Source-Chips render + click handler ---
  // Initial render + delegated click handler (chip toggle flips activeSourceChips
  // membership and triggers a debounced re-fetch via scheduleAutoFetch — Pitfall 7
  // honored). Re-render on each click to keep .is-active + aria-pressed in sync.
  renderSourceChips();
  const sourceChipsEl = document.getElementById('explorerSourceChips');
  if (sourceChipsEl) {
    sourceChipsEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.source-chip');
      if (!btn) return;
      const src = btn.dataset.source;
      if (!src || !SOURCE_DEFS.find(d => d.id === src)) return;
      if (activeSourceChips.has(src)) activeSourceChips.delete(src);
      else activeSourceChips.add(src);
      renderSourceChips();
      scheduleAutoFetch(); // Pitfall 7 — honors initialFetchDone gate
    });
  }

  // --- Phase 09.2 D-23: Saved Views dropdown ---
  // Click on the Saved-Views button toggles the dropdown menu (rendered into
  // document.body on first call). A delegated body-level click handler manages
  // save / apply / delete actions on the menu rows. Outside-click closes the
  // menu. Position is set per click via DOM property setter (CSP-clean — no
  // style="..." in innerHTML, no setAttribute('style', ...)).
  function toggleSavedViewsMenu() {
    const menuBtn = document.getElementById('explorerSavedViewsBtn');
    const menu = renderSavedViewsMenu();
    const open = menu.classList.toggle('is-open');
    if (menuBtn) menuBtn.setAttribute('aria-expanded', String(open));
    if (open && menuBtn) {
      const rect = menuBtn.getBoundingClientRect();
      // Inline numeric pixel values via DOM property setter — CSP-safe (the
      // forbidden patterns are setAttribute('style',...), .style.cssText=,
      // and innerHTML containing style="..."; per-property assignment is OK).
      menu.style.top = (rect.bottom + window.scrollY + 4) + 'px';
      menu.style.left = Math.max(8, rect.right + window.scrollX - 260) + 'px';
    }
  }

  const savedViewsBtn = document.getElementById('explorerSavedViewsBtn');
  if (savedViewsBtn) savedViewsBtn.addEventListener('click', toggleSavedViewsMenu);

  // Delegated handler for menu-row actions. Lives at document level so it
  // catches clicks on the dynamically-inserted menu DOM.
  document.addEventListener('click', (e) => {
    const actBtn = e.target.closest('#explorerSavedViewsMenu [data-act]');
    if (actBtn) {
      const act = actBtn.dataset.act;
      if (act === 'save') {
        const name = prompt('View speichern als:', new Date().toLocaleString('de-DE'));
        if (!name) return;
        const views = loadSavedViews();
        views.push(captureCurrentView(name));
        saveSavedViews(views);
        renderSavedViewsMenu();
      } else if (act === 'apply') {
        const idx = Number(actBtn.dataset.idx);
        const views = loadSavedViews();
        applyView(views[idx], scheduleAutoFetch, renderSignalList);
        document.getElementById('explorerSavedViewsMenu')?.classList.remove('is-open');
        document.getElementById('explorerSavedViewsBtn')?.setAttribute('aria-expanded', 'false');
      } else if (act === 'delete') {
        const idx = Number(actBtn.dataset.idx);
        const views = loadSavedViews();
        views.splice(idx, 1);
        saveSavedViews(views);
        renderSavedViewsMenu();
      }
      return;
    }
    // Outside-click closes the menu.
    const menu = document.getElementById('explorerSavedViewsMenu');
    if (menu && menu.classList.contains('is-open')) {
      if (!menu.contains(e.target) && e.target !== savedViewsBtn && !savedViewsBtn?.contains(e.target)) {
        menu.classList.remove('is-open');
        savedViewsBtn?.setAttribute('aria-expanded', 'false');
      }
    }
  });

  renderSignalList();

  // Auto-load 24h on page load. The initialFetchDone flag flips AFTER the
  // initial fetch settles so the change-listeners we registered above don't
  // fire a duplicate request during init (rangeSelect.value = '24h' below
  // dispatches no change event since it's a programmatic assignment, but
  // we set the flag after to be defensive).
  rangeSelect.value = '24h';
  fetchExplorerData().finally(() => { initialFetchDone = true; });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initExplorer);
} else {
  initExplorer();
}
