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

// --- Helpers ---
function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }

function getDateRange() {
  const sel = document.getElementById('explorerRange').value;
  const today = new Date(); today.setHours(0,0,0,0);
  switch (sel) {
    case 'today': return [fmtDate(today), fmtDate(today)];
    case 'yesterday': return [fmtDate(addDays(today, -1)), fmtDate(addDays(today, -1))];
    case '24h':
    case '7d': return [fmtDate(addDays(today, sel === '24h' ? -1 : -6)), fmtDate(today)];
    case '30d': return [fmtDate(addDays(today, -29)), fmtDate(today)];
    case 'custom': return [document.getElementById('explorerStart').value, document.getElementById('explorerEnd').value];
  }
  return [fmtDate(today), fmtDate(today)];
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

async function fetchGranularData(startDate, endDate, agg) {
  const maxRes = GRANULAR_AGG_TO_SECONDS[agg];
  if (!maxRes) throw new Error(`unsupported granular agg: ${agg}`);

  const startIso = new Date(startDate).toISOString();
  const endIso = new Date(new Date(endDate).getTime() + 86400000).toISOString();
  const keys = GRANULAR_ALL_TELEMETRY_KEYS.join(',');

  const url = `/api/telemetry/series?keys=${encodeURIComponent(keys)}&start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}&maxResolution=${maxRes}`;
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

// --- Data fetching ---
async function fetchExplorerData() {
  const [startDate, endDate] = getDateRange();
  if (!startDate || !endDate) { setStatus('Bitte Zeitbereich wählen.'); return; }

  setStatus('Lade Daten...');
  const agg = document.getElementById('explorerAgg').value;

  // Route: granular path for any agg present in GRANULAR_AGG_TO_SECONDS
  // (5s/10s/15s/30s/1min/5min); legacy slot path for 15min / 1h / day.
  if (GRANULAR_AGG_TO_SECONDS[agg]) {
    try {
      const rows = await fetchGranularData(startDate, endDate, agg);
      explorerData.rawSlots = []; // raw-table reads granularRows instead in this mode
      explorerData.rawFc = null;
      explorerData.rawEpex = [];
      explorerData.rawSoc = [];
      buildGranularChartData(rows, agg);
      renderChart();
      setStatus(`${rows.length.toLocaleString('de-DE')} Telemetry-Punkte geladen (${agg}, ${startDate}…${endDate}). Nur PV/Last/Bat/SOC/Netz im Granular-Modus.`);
    } catch (e) {
      setStatus(`Fehler: ${e.message}`);
    }
    return;
  }

  // Legacy slot-aggregation path (15min / 1h / day)
  explorerData.granularMode = false;
  explorerData.granularRows = null;
  try {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const allSlots = [];
    const dayPromises = [];

    for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
      const dateStr = fmtDate(d);
      dayPromises.push(
        apiFetch(`/api/history/summary?view=day&date=${dateStr}`)
          .then(r => r.json())
          .then(data => ({ date: dateStr, slots: data.slots || [] }))
          .catch(() => ({ date: dateStr, slots: [] }))
      );
    }

    const dayResults = await Promise.all(dayPromises);
    dayResults.sort((a, b) => a.date.localeCompare(b.date));
    for (const dr of dayResults) allSlots.push(...dr.slots);

    const startIso = new Date(startDate).toISOString();
    const endIso = new Date(new Date(endDate).getTime() + 86400000).toISOString();
    const [fcData, statusData, socData] = await Promise.all([
      apiFetch('/api/forecast').then(r => r.json()).catch(() => null),
      apiFetch('/api/status').then(r => r.json()).catch(() => null),
      apiFetch(`/api/telemetry/series?keys=battery_soc_pct&start=${startIso}&end=${endIso}`).then(r => r.json()).catch(() => null)
    ]);

    explorerData.rawSlots = allSlots;
    explorerData.rawFc = fcData;
    explorerData.rawEpex = statusData?.epex?.data || [];
    explorerData.rawSoc = socData?.data || [];

    const slots = aggregateSlots(allSlots, agg);
    buildChartData(slots, fcData, statusData?.epex?.data || [], agg, explorerData.rawSoc);
    renderChart();
    setStatus(`${allSlots.length.toLocaleString('de-DE')} Slots geladen (${startDate}…${endDate}).`);
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
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: true,
          backgroundColor: '#1a1a2eee',
          titleColor: '#e5e7eb',
          bodyColor: '#e5e7eb',
          borderColor: '#334155',
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
          pan: { enabled: true, mode: 'x' },
          zoom: {
            wheel: { enabled: true },
            pinch: { enabled: true },
            mode: 'x'
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
      <span class="sig-sw" style="background:${def.color}"></span>
      <span class="sig-name">${def.label}</span>
      <span class="sig-unit">${def.unit}</span>
    </label>`;
  }).join('');
  container.innerHTML = rows;

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
  const [startDate, endDate] = getDateRange();
  if (!startDate || !endDate) { setStatus('Bitte Zeitbereich wählen.'); return; }
  const agg = document.getElementById('explorerAgg').value;
  const granular = GRANULAR_AGG_TO_SECONDS[agg];

  const btn = document.getElementById('explorerCsvBtn');
  const prevLabel = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Exportiere…'; }

  try {
    if (granular) {
      await exportCsvGranular(startDate, endDate, agg);
    } else {
      await exportCsvSlots(startDate, endDate, agg);
    }
  } catch (e) {
    setStatus(`CSV-Export Fehler: ${e.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = prevLabel || 'CSV Export'; }
  }
}

// Granular export: day-by-day fetch from /api/telemetry/series, full
// resolution, ALL active granular series. ~86,400 rows/day at 5s × 5 keys
// is well within the per-request cap.
async function exportCsvGranular(startDate, endDate, agg) {
  const maxRes = GRANULAR_AGG_TO_SECONDS[agg];
  const activeDefs = SERIES_DEFS.filter(d => activeSeriesIds.has(d.id) && GRANULAR_SERIES_MAP[d.id]);
  if (!activeDefs.length) { setStatus('Keine Granular-Serie ausgewählt.'); return; }
  // Union of telemetry keys needed for the active series (deduplicated;
  // gridKw + importKw share grid_import_w, autarkie shares load_power_w + self_consumption_w, etc.).
  const tKeys = [...new Set(activeDefs.flatMap(d => GRANULAR_SERIES_MAP[d.id].tKeys))];

  // Iterate days [start..end] inclusive. Each iteration fetches exactly 24h.
  const start = new Date(startDate);
  const end = new Date(endDate);
  const dayCount = Math.floor((end - start) / 86400000) + 1;
  const byTs = new Map();
  let totalFetched = 0;

  for (let i = 0; i < dayCount; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    const dayStartIso = d.toISOString();
    const dayEndIso = new Date(d.getTime() + 86400000).toISOString();
    setStatus(`CSV-Export · Tag ${i + 1}/${dayCount} (${fmtDate(d)})…`);
    const url = `/api/telemetry/series?keys=${encodeURIComponent(tKeys.join(','))}&start=${encodeURIComponent(dayStartIso)}&end=${encodeURIComponent(dayEndIso)}&maxResolution=${maxRes}`;
    const res = await apiFetch(url);
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.ok) {
      throw new Error(body?.error === 'scan_too_large'
        ? `Tag ${fmtDate(d)}: zu groß für eine Range — wähle gröbere Auflösung.`
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
  downloadCsv(`dvhub-explorer-${agg}-${startDate}_${endDate}.csv`, [header.join(';'), ...rows].join('\n'));
  setStatus(`CSV mit ${sorted.length.toLocaleString('de-DE')} Zeilen exportiert (${totalFetched.toLocaleString('de-DE')} Telemetry-Punkte aus ${dayCount} Tag(en)).`);
}

// Slot export (15min / 1h / day) — use what's in memory, which already
// covers the full range from fetchExplorerData's existing day-by-day loop.
async function exportCsvSlots(startDate, endDate, agg) {
  if (!explorerData.labels.length) { setStatus('Erst Daten laden, dann exportieren.'); return; }
  const activeDefs = SERIES_DEFS.filter(d => activeSeriesIds.has(d.id) && explorerData.seriesData?.[d.id]);
  const header = ['Zeitpunkt', ...activeDefs.map(d => `${d.label} (${d.unit})`)];
  const rows = explorerData.labels.map((label, i) => {
    return [label, ...activeDefs.map(d => {
      const v = explorerData.seriesData[d.id][i];
      return v != null ? Number(v).toFixed(3).replace('.', ',') : '';
    })].join(';');
  });
  downloadCsv(`dvhub-explorer-${agg}-${startDate}_${endDate}.csv`, [header.join(';'), ...rows].join('\n'));
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

// --- Init ---
function initExplorer() {
  const rangeSelect = document.getElementById('explorerRange');
  const customStart = document.getElementById('customStartWrap');
  const customEnd = document.getElementById('customEndWrap');
  const today = fmtDate(new Date());

  document.getElementById('explorerStart').value = fmtDate(addDays(new Date(), -7));
  document.getElementById('explorerEnd').value = today;

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
  document.getElementById('explorerCsvBtn').addEventListener('click', exportCsv);

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
