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
  { id: 'marketCt',   label: 'Boersenpreis',      color: '#0077ff', unit: 'ct/kWh', axis: 'ct', key: '_marketCt',   toKw: false },
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
    case '7d': return [fmtDate(addDays(today, -6)), fmtDate(today)];
    case '30d': return [fmtDate(addDays(today, -29)), fmtDate(today)];
    case 'custom': return [document.getElementById('explorerStart').value, document.getElementById('explorerEnd').value];
  }
  return [fmtDate(today), fmtDate(today)];
}

function viewForRange(start, end) {
  const days = (new Date(end) - new Date(start)) / 86400000;
  if (days <= 1) return 'day';
  if (days <= 31) return 'week';
  return 'month';
}

function setStatus(msg) {
  const el = document.getElementById('explorerStatus');
  if (el) el.textContent = msg;
}

// --- Data fetching ---
async function fetchExplorerData() {
  const [startDate, endDate] = getDateRange();
  if (!startDate || !endDate) { setStatus('Bitte Zeitbereich waehlen.'); return; }

  setStatus('Lade Daten...');
  const agg = document.getElementById('explorerAgg').value;

  try {
    // Fetch day-by-day summaries for the range
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

    // Fetch forecast + EPEX prices + SOC telemetry
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

    // Aggregate if needed
    const slots = aggregateSlots(allSlots, agg);

    // Build chart data
    buildChartData(slots, fcData, statusData?.epex?.data || [], agg, explorerData.rawSoc);
    renderChart();
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
    if (agg === '1h') {
      d.setMinutes(0, 0, 0);
      key = d.toISOString();
    } else { // day
      key = d.toISOString().slice(0, 10);
    }
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
    // SOC: take last value
    const lastWithSoc = [...group].reverse().find(s => s.soc != null);
    if (lastWithSoc) bucket.soc = lastWithSoc.soc;
    // Market price: average
    const prices = group.map(s => Number(s.marketPriceCtKwh)).filter(v => Number.isFinite(v));
    if (prices.length) bucket.marketPriceCtKwh = prices.reduce((a, b) => a + b, 0) / prices.length;
    // User import price: average
    const uPrices = group.map(s => Number(s.userImportPriceCtKwh)).filter(v => Number.isFinite(v));
    if (uPrices.length) bucket.userImportPriceCtKwh = uPrices.reduce((a, b) => a + b, 0) / uPrices.length;
    result.push(bucket);
  }
  return result;
}

function buildChartData(slots, fcData, epexData, agg, socSamples = []) {
  const slotMinutes = agg === '15min' ? 15 : agg === '1h' ? 60 : 1440;
  const kwFactor = 60 / slotMinutes; // kWh → kW conversion

  // Labels
  const labels = slots.map(s => {
    const d = new Date(s.ts);
    if (agg === 'day') return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
    return d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  });

  // Build sorted arrays for forecast + EPEX + SOC for interpolation
  const fcSolarArr = (fcData?.solar || []).map(p => ({ ts: new Date(p.ts).getTime(), v: p.w / 1000 })).sort((a, b) => a.ts - b.ts);
  const fcConsArr = (fcData?.consumption || []).map(p => ({ ts: new Date(p.ts).getTime(), v: p.w / 1000 })).sort((a, b) => a.ts - b.ts);
  const socArr = (socSamples || []).map(p => ({ ts: new Date(p.ts).getTime(), v: Number(p.value) })).filter(p => Number.isFinite(p.v)).sort((a, b) => a.ts - b.ts);
  const epexMap = new Map();
  if (epexData) epexData.forEach(p => epexMap.set(Number(p.ts), Number(p.ct_kwh)));

  // Interpolate value from sorted array of {ts, v}
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

  // Find nearest EPEX price within 15 min tolerance
  function findEpex(ts) {
    const direct = epexMap.get(ts);
    if (direct != null) return direct;
    // Round to nearest 15min and try
    const rounded = Math.round(ts / 900000) * 900000;
    return epexMap.get(rounded) ?? null;
  }

  // Build dataset values
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
        // Prefer slot data, fallback to EPEX overlay
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

// --- Chart rendering ---
function renderChart() {
  const canvas = document.getElementById('explorerCanvas');
  if (!canvas || typeof Chart === 'undefined') return;

  if (explorerChart) { explorerChart.destroy(); explorerChart = null; }

  const datasets = buildDatasets();
  if (!datasets.length) { setStatus('Keine Daten fuer die ausgewaehlten Serien.'); return; }

  // Determine which axes are needed
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
        legend: {
          display: false // we use custom chips
        },
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

// --- Series chips UI ---
function renderSeriesChips() {
  const container = document.getElementById('explorerSeriesChips');
  if (!container) return;
  container.innerHTML = SERIES_DEFS.map(def => `
    <div class="explorer-series-chip ${activeSeriesIds.has(def.id) ? 'is-active' : ''}" data-series="${def.id}" style="${activeSeriesIds.has(def.id) ? `color:${def.color};border-color:${def.color}` : ''}">
      <span class="chip-dot" style="background:${def.color}"></span>
      ${def.label} <small style="opacity:0.6">(${def.unit})</small>
    </div>
  `).join('');

  container.querySelectorAll('.explorer-series-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const id = chip.dataset.series;
      if (activeSeriesIds.has(id)) activeSeriesIds.delete(id);
      else activeSeriesIds.add(id);
      renderSeriesChips();
      if (explorerData.labels.length) renderChart();
    });
  });
}

// --- CSV Export ---
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
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
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

  rangeSelect.addEventListener('change', () => {
    const isCustom = rangeSelect.value === 'custom';
    customStart.style.display = isCustom ? '' : 'none';
    customEnd.style.display = isCustom ? '' : 'none';
  });

  document.getElementById('explorerLoadBtn').addEventListener('click', fetchExplorerData);
  document.getElementById('explorerResetZoomBtn').addEventListener('click', () => {
    if (explorerChart) explorerChart.resetZoom();
  });
  document.getElementById('explorerCsvBtn').addEventListener('click', exportCsv);

  renderSeriesChips();

  // Auto-load today
  document.getElementById('explorerRange').value = 'today';
  fetchExplorerData();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initExplorer);
} else {
  initExplorer();
}
