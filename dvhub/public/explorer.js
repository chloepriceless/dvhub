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

const MAX_RAW_TABLE_ROWS = 500; // cap to avoid 5760-row DOM render hit; status footer reports total

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

// --- Granular telemetry mode (1min / 5min) ---
//
// In granular mode we bypass /api/history/summary (which delivers 15min energy
// slots in kWh) and fetch directly from /api/telemetry/series at the raw 5s
// telemetry table — but capped at the user-picked maxResolution (60s or 300s).
// Only 5 series map to telemetry keys (PV/Load/Battery/SOC/Grid power); the
// other 8 SERIES_DEFS entries (forecasts, prices, autarkie, energy-derived)
// have no granular source and stay empty in this mode.
//
// Server enforces MAX_TELEMETRY_SCAN_SLOTS=50,000. At 1min × 5keys we max out
// at ~24h range; 5min × 5keys allows ~7 days. Larger ranges will return
// scan_too_large which we surface to the user.
const GRANULAR_SERIES_MAP = {
  // SERIES_DEFS.id  →  { telemetry key,  W→kW conversion (1/1000 for power; 1 for SOC) }
  pvKw:      { tKey: 'pv_power_w',      scale: 1 / 1000 },
  loadKw:    { tKey: 'load_power_w',    scale: 1 / 1000 },
  batteryKw: { tKey: 'battery_power_w', scale: 1 / 1000 },
  gridKw:    { tKey: 'grid_power_w',    scale: 1 / 1000 },
  soc:       { tKey: 'battery_soc_pct', scale: 1 }
};
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
  const keys = Object.values(GRANULAR_SERIES_MAP).map(m => m.tKey).join(',');

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

  // Build seriesData: only the 5 granular-available SERIES_DEFS are populated.
  const seriesData = {};
  for (const def of SERIES_DEFS) {
    const map = GRANULAR_SERIES_MAP[def.id];
    if (!map) { seriesData[def.id] = sorted.map(() => null); continue; }
    seriesData[def.id] = sorted.map(s => {
      const v = s[map.tKey];
      return v != null && Number.isFinite(Number(v)) ? Number(v) * map.scale : null;
    });
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

  // Route: granular path for 1min / 5min, legacy slot path for 15min / 1h / day
  if (agg === '1min' || agg === '5min') {
    try {
      const rows = await fetchGranularData(startDate, endDate, agg);
      explorerData.rawSlots = []; // raw-table reads granularRows instead in this mode
      explorerData.rawFc = null;
      explorerData.rawEpex = [];
      explorerData.rawSoc = [];
      buildGranularChartData(rows, agg);
      renderChart();
      renderRawTable();
      setStatus(`${rows.length} Telemetry-Punkte geladen (${agg}, ${startDate} bis ${endDate}). Granular-Modus — nur PV/Last/Batterie/SOC/Netz.`);
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
    renderRawTable();
    setStatus(`${allSlots.length} Slots geladen (${startDate} bis ${endDate}).`);
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

// --- Raw data table — renders last MAX_RAW_TABLE_ROWS from rawSlots OR
//     granularRows depending on mode. In granular mode the values come
//     out of seriesData (already scaled to display units), so the same
//     active-series filter applies. ---
function renderRawTable() {
  const head = document.getElementById('explorerRawHead');
  const body = document.getElementById('explorerRawBody');
  const foot = document.getElementById('explorerRawFoot');
  if (!head || !body) return;

  // --- Granular mode path (1min / 5min / 30s / 15s / 10s / 5s) ---
  if (explorerData.granularMode && Array.isArray(explorerData.granularRows)) {
    const rows = explorerData.granularRows;
    if (!rows.length) {
      head.innerHTML = '<th>Zeitpunkt</th>';
      body.innerHTML = '';
      if (foot) foot.textContent = 'Keine Telemetry-Daten im gewählten Zeitraum.';
      return;
    }
    // Only the 5 granular-available series have meaningful data
    const cols = SERIES_DEFS.filter(d => activeSeriesIds.has(d.id) && GRANULAR_SERIES_MAP[d.id]);
    let headerHtml = '<th>Zeitpunkt</th>';
    for (const c of cols) {
      headerHtml += `<th class="num" title="${c.label}">${c.id}<br><small>${c.unit}</small></th>`;
    }
    head.innerHTML = headerHtml;

    const labels = explorerData.labels || [];
    const seriesData = explorerData.seriesData || {};
    // Newest-first: render rows from end backward, paired with labels
    const total = rows.length;
    const start = Math.max(0, total - MAX_RAW_TABLE_ROWS);
    const indexes = [];
    for (let i = total - 1; i >= start; i--) indexes.push(i);
    const rowsHtml = indexes.map(i => {
      const tsLabel = labels[i] || rows[i].ts;
      let row = `<td class="mono">${tsLabel}</td>`;
      for (const c of cols) {
        const v = seriesData[c.id]?.[i];
        if (v == null || !Number.isFinite(Number(v))) {
          row += `<td class="num">&mdash;</td>`;
        } else {
          row += `<td class="num">${Number(v).toFixed(2)}</td>`;
        }
      }
      return `<tr>${row}</tr>`;
    }).join('');
    body.innerHTML = rowsHtml;
    if (foot) {
      const aggLabel = explorerData.granularAgg || '?';
      if (total > MAX_RAW_TABLE_ROWS) {
        foot.textContent = `Zeige ${MAX_RAW_TABLE_ROWS} von ${total} Telemetry-Punkten · ${aggLabel} · neueste zuerst.`;
      } else {
        foot.textContent = `${total} Telemetry-Punkte · ${aggLabel} · neueste zuerst.`;
      }
    }
    return;
  }

  // --- Legacy slot-aggregation path (15min / 1h / day) ---
  const slots = explorerData.rawSlots || [];
  if (!slots.length) {
    head.innerHTML = '<th>Zeitpunkt</th>';
    body.innerHTML = '';
    if (foot) foot.textContent = 'Keine Daten geladen.';
    return;
  }

  // Determine which active series have a corresponding slot key
  const cols = SERIES_DEFS.filter(d => activeSeriesIds.has(d.id) && !d.key.startsWith('_'));
  let headerHtml = '<th>Zeitpunkt</th>';
  for (const c of cols) {
    headerHtml += `<th class="num" title="${c.label}">${c.id}<br><small>${c.unit}</small></th>`;
  }
  head.innerHTML = headerHtml;

  // Render last N rows (newest first)
  const visible = slots.slice(-MAX_RAW_TABLE_ROWS).reverse();
  const rowsHtml = visible.map(s => {
    const d = new Date(s.ts);
    const tsLabel = d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    let row = `<td class="mono">${tsLabel}</td>`;
    for (const c of cols) {
      const raw = Number(s[c.key]);
      if (!Number.isFinite(raw)) {
        row += `<td class="num">&mdash;</td>`;
      } else {
        const display = c.toKw ? (raw * (60 / (15))) : raw; // 15min slot → kW assumption matches build path
        row += `<td class="num">${display.toFixed(2)}</td>`;
      }
    }
    return `<tr>${row}</tr>`;
  }).join('');
  body.innerHTML = rowsHtml;

  if (foot) {
    if (slots.length > MAX_RAW_TABLE_ROWS) {
      foot.textContent = `Zeige ${MAX_RAW_TABLE_ROWS} von ${slots.length} Zeilen (neueste zuerst).`;
    } else {
      foot.textContent = `${slots.length} Zeilen (neueste zuerst).`;
    }
  }
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

// --- CSV Export (unchanged from Wave-5 Task 1) ---
function exportCsv() {
  if (!explorerData.labels.length) return;
  const activeDefs = SERIES_DEFS.filter(d => activeSeriesIds.has(d.id) && explorerData.seriesData?.[d.id]);
  const header = ['Zeitpunkt', ...activeDefs.map(d => `${d.label} (${d.unit})`)];
  const rows = explorerData.labels.map((label, i) => {
    return [label, ...activeDefs.map(d => {
      const v = explorerData.seriesData[d.id][i];
      return v != null ? Number(v).toFixed(3).replace('.', ',') : '';
    })].join(';');
  });
  const csv = [header.join(';'), ...rows].join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `dvhub-explorer-${getDateRange().join('_')}.csv`;
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
      if (explorerData.labels.length) {
        renderChart();
        renderRawTable();
      }
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
  renderRawTable(); // empty initial state

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
