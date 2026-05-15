// public/history-viz.js
//
// Plan 09.3-01 Wave 1 — Phase 09.3 Aurora History-Viz Cards (frontend foundation).
// Implements D-13 (separate module from history.js), D-14 (per-card build*),
// D-15 (view-conditional via class toggle), D-16 (lazy-build memo per
// `${card}:${view}`), D-21 (READ-only on dvhub.theme — never setItem),
// D-22 (no inline style attrs / runtime <style> blocks), D-25 (visibility
// via classList.toggle — see banned pattern below). // csp-lint:allow-display-clear
//
// All 14 builders are stubs in Wave 1 (`console.warn('not implemented')`).
// Waves 2-5 replace each builder body with the real Chart.js mount.

(function () {
  'use strict';

  const common = (typeof window !== 'undefined' && window.DVhubCommon) || {};
  // common.apiFetch handles Bearer token + base URL. Fallback to fetch when
  // common.js hasn't loaded (defensive — script ordering keeps common before
  // history-viz.js, but if a future refactor flips ordering we still degrade
  // gracefully instead of throwing on first build*).
  const apiFetch = common.apiFetch || ((u, opts) => fetch(u, opts));

  // Per-card Chart.js instances. Keyed by mount-id (matches history.js's
  // historyChartInstances pattern — but a separate registry, so D-13 holds:
  // history.js stays untouched).
  const historyVizCharts = {};
  // Lazy-build memo: `${card}:${view}` → already built. Re-cleared on every
  // view-change so a viz that hides+re-shows is rebuilt with fresh data.
  const built = new Set();
  let __historyVizBound = false;

  // --- CSS-token bridge (re-implemented in IIFE scope; the IIFE cannot reach
  // app.js's cssVar). Identical contract to app.js:168-189.

  function cssVar(name, fallback) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch (_) { return fallback; }
  }

  function cssVarAlpha(name, alpha, fallback) {
    const v = cssVar(name, fallback);
    if (typeof v !== 'string') return fallback || v;
    let hex = v.replace('#', '');
    if (/^[0-9a-fA-F]{3}$/.test(hex)) hex = hex.split('').map(c => c + c).join('');
    if (/^[0-9a-fA-F]{6}$/.test(hex)) {
      return 'rgba(' +
        parseInt(hex.slice(0, 2), 16) + ',' +
        parseInt(hex.slice(2, 4), 16) + ',' +
        parseInt(hex.slice(4, 6), 16) + ',' +
        alpha + ')';
    }
    return v;
  }

  // --- 4-stop gradient interpolation (Plan 09.3-04 Wave 4, RESEARCH §670-697).
  // mixColors parses rgba()/hex, interpolates per-channel; interpolateGradient
  // walks a [{at, color}] stop list. Used by buildPheat for the theme-aware
  // green→cyan→yellow→red price scale (stops resolve via cssVar at paint time).

  function mixColors(c1, c2, t) {
    function parse(c) {
      if (typeof c === 'string' && c.startsWith('#')) {
        let h = c.slice(1);
        if (h.length === 3) h = h.split('').map((x) => x + x).join('');
        return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
      }
      const m = typeof c === 'string' ? c.match(/rgba?\(([^)]+)\)/) : null;
      if (m) {
        const p = m[1].split(',').map(Number);
        return [p[0] || 0, p[1] || 0, p[2] || 0, p.length > 3 ? p[3] : 1];
      }
      return [0, 0, 0, 1];
    }
    const a = parse(c1);
    const b = parse(c2);
    return 'rgba(' +
      Math.round(a[0] + (b[0] - a[0]) * t) + ',' +
      Math.round(a[1] + (b[1] - a[1]) * t) + ',' +
      Math.round(a[2] + (b[2] - a[2]) * t) + ',' +
      (a[3] + (b[3] - a[3]) * t) + ')';
  }

  function interpolateGradient(stops, t) {
    if (!Array.isArray(stops) || stops.length === 0) return '#000';
    if (t <= stops[0].at) return stops[0].color;
    if (t >= stops[stops.length - 1].at) return stops[stops.length - 1].color;
    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i].at) {
        const span = stops[i].at - stops[i - 1].at;
        const local = span > 0 ? (t - stops[i - 1].at) / span : 0;
        return mixColors(stops[i - 1].color, stops[i].color, local);
      }
    }
    return stops[stops.length - 1].color;
  }

  // --- Aggregator-fetch helper. Each builder calls fetchCardData(slug, view, date).

  async function fetchCardData(slug, view, date) {
    const url = `/api/history/viz/${slug}?view=${encodeURIComponent(view || '')}&date=${encodeURIComponent(date || '')}`;
    const r = await apiFetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${slug}`);
    return r.json();
  }

  // --- Card builders. Waves 2-5 replace each body with the actual Chart.js
  // mount. The signature is fixed so the dispatcher can remain stable.
  // (The Spot-Ledger card was removed by design — 13 builders remain.)

  // -------------------------------------------------------------------------
  // Plan 09.3-02 Wave 2 — 5 LIVE frontend builders.
  //
  // Pattern (per RESEARCH §Pattern 1 + 3, history.js:859 canvas-swap idiom):
  //   1. Resolve mount element; bail if missing OR if Chart.js not loaded.
  //   2. Fetch payload via fetchCardData(slug, view, date).
  //   3. Destroy any prior Chart.js instance from historyVizCharts[card].
  //   4. Replace mount innerHTML with a fresh <canvas> (no style="" attrs;
  //      D-22 keeps all geometry in CSS via .viz-chart-shell).
  //   5. Construct new Chart(canvas.getContext('2d'), {...}); store in registry.
  //   6. setTimeout(() => chart.resize(), 0) for first-paint correction
  //      (RESEARCH §Pitfall 3 chartArea-may-be-empty defensive guard).
  //   7. On error: mount.textContent = friendly DE error; never innerHTML
  //      (D-22 + T-09.3-10 XSS guard for ledger user-supplied strings).
  // -------------------------------------------------------------------------

  function mountCanvas(mount, canvasId) {
    // D-22 — replace mount contents WITHOUT inline style attrs. Geometry
    // belongs to .viz-chart-shell + per-card CSS rules.
    mount.replaceChildren();
    const canvas = document.createElement('canvas');
    canvas.id = canvasId;
    mount.appendChild(canvas);
    return canvas;
  }

  function showFriendlyError(mount, label) {
    // T-09.3-10 — never use innerHTML with potentially-untrusted text.
    if (!mount) return;
    mount.replaceChildren();
    const msg = document.createElement('div');
    msg.className = 'viz-error-msg';
    msg.textContent = `${label}: Daten aktuell nicht verfügbar`;
    mount.appendChild(msg);
  }

  // RC-F / design — empty-data placeholder. Cards whose backing tables are
  // still empty on prod (duration, pheat, top10) render a friendly centered
  // message inside the .viz-chart-shell instead of a blank/all-uniform chart.
  // Same DOM-build idiom as the scatter card's no-weather-data path
  // (textContent only — D-22 / T-09.3-10, never innerHTML).
  function showEmptyData(mount) {
    if (!mount) return;
    mount.replaceChildren();
    const msg = document.createElement('div');
    msg.className = 'viz-empty-msg';
    msg.textContent = 'Daten werden noch gesammelt';
    mount.appendChild(msg);
  }

  // RC-4 — shared Chart.js interaction defaults so tooltips fire on point-less
  // lines and surface every series at a datapoint. 'index' for cartesian
  // charts; 'nearest' for scatter / doughnut where an index has no meaning.
  const INTERACTION_INDEX = { mode: 'index', intersect: false };
  const INTERACTION_NEAREST = { mode: 'nearest', intersect: false };

  async function buildSankey(view, date) {
    const mount = document.getElementById('sankeySvg');
    if (!mount) return;
    if (typeof Chart === 'undefined') return;
    try {
      const data = await fetchCardData('sankey', view, date);
      if (historyVizCharts.sankey) {
        try { historyVizCharts.sankey.destroy(); } catch (_) { /* dead */ }
        delete historyVizCharts.sankey;
      }
      const canvas = mountCanvas(mount, 'sankeyCanvas');
      historyVizCharts.sankey = new Chart(canvas.getContext('2d'), {
        type: 'sankey',
        data: { datasets: [{
          data: (data.flows || []).map((f) => ({ from: f.from, to: f.to, flow: f.flow })),
          colorFrom: cssVar('--cyan', '#34dbff'),
          colorTo:   cssVar('--green', '#3ee0a0'),
          colorMode: 'gradient',
          // RC-E — node labels otherwise paint in Chart.defaults dark grey and
          // vanish on the dark Aurora theme. Force a light token + readable font.
          color: cssVar('--text-soft', '#cbd5e1'),
          font: { size: 12, weight: '600' },
        }] },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          interaction: INTERACTION_NEAREST,
        },
      });
      setTimeout(() => {
        try { historyVizCharts.sankey && historyVizCharts.sankey.resize && historyVizCharts.sankey.resize(); }
        catch (_) { /* dead chart */ }
      }, 0);
    } catch (e) {
      console.error('history-viz: buildSankey failed', e);
      showFriendlyError(mount, 'Sankey');
    }
  }

  async function buildDayProfile(view, date) {
    const mount = document.getElementById('dayProfileMount');
    if (!mount) return;
    if (typeof Chart === 'undefined') return;
    try {
      const data = await fetchCardData('day-profile', view, date);
      if (historyVizCharts.dayProfile) {
        try { historyVizCharts.dayProfile.destroy(); } catch (_) { /* dead */ }
        delete historyVizCharts.dayProfile;
      }
      const canvas = mountCanvas(mount, 'dayProfileCanvas');
      const labels = (data.pv || []).map((p) => String(p.h).padStart(2, '0'));
      const pvData = (data.pv || []).map((p) => p.w);
      const loadData = (data.load || []).map((p) => p.w);
      historyVizCharts.dayProfile = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              label: 'PV-Erzeugung',
              data: pvData,
              borderColor: cssVar('--yellow', '#ffd421'),
              backgroundColor: cssVarAlpha('--yellow', 0.25, '#ffd421'),
              fill: true,
              tension: 0.3,
              borderWidth: 2,
              pointRadius: 0,
            },
            {
              label: 'Hauslast',
              data: loadData,
              borderColor: cssVar('--cyan', '#34dbff'),
              backgroundColor: cssVarAlpha('--cyan', 0.18, '#34dbff'),
              fill: true,
              tension: 0.3,
              borderWidth: 2,
              pointRadius: 0,
            },
          ],
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          interaction: INTERACTION_INDEX,
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { display: false }, ticks: { autoSkip: true, maxRotation: 0 } },
            y: { beginAtZero: true, grid: { color: 'rgba(141,180,221,0.1)' } },
          },
        },
      });
      setTimeout(() => {
        try { historyVizCharts.dayProfile && historyVizCharts.dayProfile.resize && historyVizCharts.dayProfile.resize(); }
        catch (_) { /* dead chart */ }
      }, 0);
    } catch (e) {
      console.error('history-viz: buildDayProfile failed', e);
      showFriendlyError(mount, 'Stunden-Profil');
    }
  }

  async function buildStack(view, date) {
    const mount = document.getElementById('vStack');
    if (!mount) return;
    if (typeof Chart === 'undefined') return;
    try {
      const data = await fetchCardData('stack', view, date);
      if (historyVizCharts.stack) {
        try { historyVizCharts.stack.destroy(); } catch (_) { /* dead */ }
        delete historyVizCharts.stack;
      }
      const canvas = mountCanvas(mount, 'vStackCanvas');
      historyVizCharts.stack = new Chart(canvas.getContext('2d'), {
        type: 'bar',
        data: {
          labels: data.bucketLabels || [],
          datasets: [
            {
              label: 'PV direkt', type: 'bar',
              data: data.pvDirectKwh || [],
              backgroundColor: cssVarAlpha('--yellow', 0.85, '#ffd421'),
              stack: 'energy',
            },
            {
              label: 'Akku-Entladung', type: 'bar',
              data: data.batteryDischargeKwh || [],
              backgroundColor: cssVarAlpha('--green', 0.85, '#3ee0a0'),
              stack: 'energy',
            },
            {
              label: 'Netzbezug', type: 'bar',
              data: data.gridImportKwh || [],
              backgroundColor: cssVarAlpha('--pink', 0.85, '#ff7eb6'),
              stack: 'energy',
            },
            {
              label: 'Hauslast', type: 'line',
              data: data.loadKwh || [],
              borderColor: cssVar('--cyan', '#34dbff'),
              backgroundColor: 'transparent',
              borderWidth: 2,
              pointRadius: 0,
              tension: 0.25,
              fill: false,
            },
          ],
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          interaction: INTERACTION_INDEX,
          plugins: { legend: { display: false } },
          scales: {
            x: { stacked: true, grid: { display: false } },
            y: { stacked: true, beginAtZero: true, grid: { color: 'rgba(141,180,221,0.1)' } },
          },
        },
      });
      setTimeout(() => {
        try { historyVizCharts.stack && historyVizCharts.stack.resize && historyVizCharts.stack.resize(); }
        catch (_) { /* dead chart */ }
      }, 0);
    } catch (e) {
      console.error('history-viz: buildStack failed', e);
      showFriendlyError(mount, 'Stundenprofil-Stack');
    }
  }

  async function buildHeatmap(view, date) {
    const mount = document.getElementById('hm');
    if (!mount) return;
    if (typeof Chart === 'undefined') return;
    try {
      const data = await fetchCardData('heatmap', view, date);
      if (historyVizCharts.heatmap) {
        try { historyVizCharts.heatmap.destroy(); } catch (_) { /* dead */ }
        delete historyVizCharts.heatmap;
      }
      const canvas = mountCanvas(mount, 'hmCanvas');
      const xLabels = data.xLabels || [];
      const yLabels = data.yLabels || [];
      const matrix = data.matrix || [];
      const maxV = (data.domain && Number.isFinite(data.domain.max)) ? data.domain.max : 1;
      historyVizCharts.heatmap = new Chart(canvas.getContext('2d'), {
        type: 'matrix',
        data: { datasets: [{
          label: 'PV-Erzeugung kWh',
          data: matrix,
          backgroundColor(c) {
            const cell = c.dataset.data[c.dataIndex];
            const v = cell && Number.isFinite(cell.v) ? cell.v : 0;
            const alpha = maxV > 0 ? Math.min(1, v / maxV) : 0;
            return cssVarAlpha('--yellow', alpha, '#ffd421');
          },
          borderWidth: 0,
          // RESEARCH §Pitfall 3 — chartArea may be undefined on first layout pass.
          width(c) {
            const w = (c.chart && c.chart.chartArea && c.chart.chartArea.width) || 0;
            return Math.max(1, (w / Math.max(1, xLabels.length)) - 1);
          },
          height(c) {
            const h = (c.chart && c.chart.chartArea && c.chart.chartArea.height) || 0;
            return Math.max(1, (h / Math.max(1, yLabels.length)) - 1);
          },
        }] },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          interaction: INTERACTION_NEAREST,
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: {
              title() { return ''; },
              label(c) {
                // RC-2 — backend emits cell x/y as the exact category label
                // STRING; pass d.x/d.y straight through (no number coercion).
                const d = c.dataset.data[c.dataIndex];
                if (!d) return '';
                const v = Number(d.v) || 0;
                return `${d.x} · ${d.y}: ${v.toFixed(2)} kWh`;
              },
            } },
          },
          scales: {
            x: { type: 'category', labels: xLabels, ticks: { autoSkip: true, maxRotation: 0 }, grid: { display: false } },
            y: { type: 'category', labels: yLabels, offset: true, reverse: true, grid: { display: false } },
          },
        },
      });
      setTimeout(() => {
        try { historyVizCharts.heatmap && historyVizCharts.heatmap.resize && historyVizCharts.heatmap.resize(); }
        catch (_) { /* dead chart */ }
      }, 0);
    } catch (e) {
      console.error('history-viz: buildHeatmap failed', e);
      showFriendlyError(mount, 'PV-Heatmap');
    }
  }

  // -------------------------------------------------------------------------
  // Plan 09.3-03 Wave 3 — 3 LIVE frontend builders.
  // Autarky-Calendar (Chart.js matrix, green-alpha cells), 24h-Ring (Chart.js
  // doughnut), Preis-Duration-Curve (Chart.js line, sorted DESC, 2 threshold
  // lines via flat-line datasets). Same canvas-swap pattern as Wave 2.
  // -------------------------------------------------------------------------

  async function buildAutarkyCalendar(view, date) {
    const mount = document.getElementById('autarkCal');
    if (!mount) return;
    if (typeof Chart === 'undefined') return;
    try {
      const data = await fetchCardData('autarky-calendar', view, date);
      if (historyVizCharts.autarkyCalendar) {
        try { historyVizCharts.autarkyCalendar.destroy(); } catch (_) { /* dead */ }
        delete historyVizCharts.autarkyCalendar;
      }
      const canvas = mountCanvas(mount, 'autarkCalCanvas');
      const xLabels = data.xLabels || [];
      const yLabels = data.yLabels || [];
      const matrix = data.matrix || [];
      historyVizCharts.autarkyCalendar = new Chart(canvas.getContext('2d'), {
        type: 'matrix',
        data: { datasets: [{
          label: 'Autarkie %',
          data: matrix,
          backgroundColor(c) {
            const cell = c.dataset.data[c.dataIndex];
            const v = cell && Number.isFinite(cell.v) ? cell.v : 0;
            // Single-hue green alpha scale 0..100% → 0.05..1.0 (RESEARCH §651).
            return cssVarAlpha('--green', Math.max(0.05, Math.min(1, v / 100)), '#3ee0a0');
          },
          borderWidth: 0,
          // RESEARCH §Pitfall 3 — chartArea may be undefined on first layout.
          width(c) {
            const w = (c.chart && c.chart.chartArea && c.chart.chartArea.width) || 0;
            return Math.max(1, (w / Math.max(1, xLabels.length)) - 1);
          },
          height(c) {
            const h = (c.chart && c.chart.chartArea && c.chart.chartArea.height) || 0;
            return Math.max(1, (h / Math.max(1, yLabels.length)) - 1);
          },
        }] },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          interaction: INTERACTION_NEAREST,
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: {
              title() { return ''; },
              label(c) {
                // RC-2 — d.y is the German DOW label STRING; use it directly.
                const d = c.dataset.data[c.dataIndex];
                if (!d) return '';
                return `${d.x} (${d.y}): ${d.v}%`;
              },
            } },
          },
          scales: {
            x: { type: 'category', labels: xLabels, ticks: { autoSkip: true, maxRotation: 0 }, grid: { display: false } },
            y: { type: 'category', labels: yLabels, offset: true, reverse: true, grid: { display: false } },
          },
        },
      });
      setTimeout(() => {
        try { historyVizCharts.autarkyCalendar && historyVizCharts.autarkyCalendar.resize && historyVizCharts.autarkyCalendar.resize(); }
        catch (_) { /* dead chart */ }
      }, 0);
    } catch (e) {
      console.error('history-viz: buildAutarkyCalendar failed', e);
      showFriendlyError(mount, 'Autarkie-Kalender');
    }
  }

  async function buildRing(view, date) {
    const mount = document.getElementById('ringSvg');
    if (!mount) return;
    if (typeof Chart === 'undefined') return;
    try {
      const data = await fetchCardData('ring', view, date);
      if (historyVizCharts.ring) {
        try { historyVizCharts.ring.destroy(); } catch (_) { /* dead */ }
        delete historyVizCharts.ring;
      }
      const canvas = mountCanvas(mount, 'ringCanvas');
      const hourly = Array.isArray(data.hourly) ? data.hourly : [];
      const hourLabels = hourly.map((h) => String(h.h).padStart(2, '0'));
      // 3 nested doughnut datasets — Chart.js renders multiple datasets as
      // concentric rings. Outer = PV, middle = Hauslast, inner = Spotpreis-Band.
      // Each ring is 24 segments (one per hour). Alpha varies by magnitude so
      // the "Rundlauf" reads as a 24h clock.
      const maxPv = Math.max(0.001, ...hourly.map((h) => h.pvKwh || 0));
      const maxLoad = Math.max(0.001, ...hourly.map((h) => h.loadKwh || 0));
      const maxSpot = Math.max(0.001, ...hourly.map((h) => Math.abs(h.spotCt || 0)));
      const pvColors = hourly.map((h) => cssVarAlpha('--yellow', Math.max(0.12, Math.min(1, (h.pvKwh || 0) / maxPv)), '#ffd421'));
      const loadColors = hourly.map((h) => cssVarAlpha('--cyan', Math.max(0.12, Math.min(1, (h.loadKwh || 0) / maxLoad)), '#34dbff'));
      const spotColors = hourly.map((h) => cssVarAlpha('--violet', Math.max(0.12, Math.min(1, Math.abs(h.spotCt || 0) / maxSpot)), '#a78bfa'));
      const ones = new Array(hourly.length || 24).fill(1);
      historyVizCharts.ring = new Chart(canvas.getContext('2d'), {
        type: 'doughnut',
        data: {
          labels: hourLabels,
          datasets: [
            { label: 'PV-Erzeugung', data: ones.slice(), backgroundColor: pvColors, borderWidth: 0, weight: 1 },
            { label: 'Hauslast', data: ones.slice(), backgroundColor: loadColors, borderWidth: 0, weight: 1 },
            { label: 'Spotpreis-Band', data: ones.slice(), backgroundColor: spotColors, borderWidth: 0, weight: 1 },
          ],
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          cutout: '42%',
          interaction: INTERACTION_NEAREST,
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: {
              label(c) {
                const hr = hourly[c.dataIndex];
                if (!hr) return '';
                if (c.datasetIndex === 0) return `${hourLabels[c.dataIndex]} Uhr · PV ${(hr.pvKwh || 0).toFixed(2)} kWh`;
                if (c.datasetIndex === 1) return `${hourLabels[c.dataIndex]} Uhr · Last ${(hr.loadKwh || 0).toFixed(2)} kWh`;
                return `${hourLabels[c.dataIndex]} Uhr · Spot ${(hr.spotCt || 0).toFixed(1)} ct`;
              },
            } },
          },
        },
      });
      // Center-label DOM update — textContent only (T-09.3-16 XSS guard).
      const totals = data.totals || {};
      const pctEl = document.getElementById('ringPctValue');
      if (pctEl) pctEl.textContent = `${Number(totals.autarkyPct || 0)} %`;
      const totEl = document.getElementById('ringTotalsLabel');
      if (totEl) {
        totEl.textContent = `${Number(totals.pvKwh || 0).toFixed(1)} kWh PV · ${Number(totals.loadKwh || 0).toFixed(1)} kWh Last`;
      }
      setTimeout(() => {
        try { historyVizCharts.ring && historyVizCharts.ring.resize && historyVizCharts.ring.resize(); }
        catch (_) { /* dead chart */ }
      }, 0);
    } catch (e) {
      console.error('history-viz: buildRing failed', e);
      showFriendlyError(mount, '24h-Ring');
    }
  }

  async function buildDuration(view, date) {
    const mount = document.getElementById('vDuration');
    if (!mount) return;
    if (typeof Chart === 'undefined') return;
    try {
      const data = await fetchCardData('duration', view, date);
      if (historyVizCharts.duration) {
        try { historyVizCharts.duration.destroy(); } catch (_) { /* dead */ }
        delete historyVizCharts.duration;
      }
      const slots = Array.isArray(data.slots) ? data.slots : [];
      // Empty-data path — the market-price table is still empty on prod.
      // Render the friendly placeholder instead of a flat 1-point line.
      if (slots.length === 0) {
        showEmptyData(mount);
        const statsEmpty = document.getElementById('vDurationStats');
        if (statsEmpty) statsEmpty.textContent = '';
        return;
      }
      const canvas = mountCanvas(mount, 'vDurationCanvas');
      const thresholds = data.thresholds || { chargeBelowCt: 5, sellAboveCt: 12 };
      const curve = slots.map((s) => ({ x: s.rank, y: s.priceCt }));
      const n = slots.length || 1;
      // 2 horizontal threshold lines as flat 2-point datasets. The
      // chartjs-plugin-annotation asset is self-hosted but NOT script-tagged
      // into history.html — the flat-dataset fallback avoids a new asset load.
      const chargeLine = [{ x: 1, y: thresholds.chargeBelowCt }, { x: n, y: thresholds.chargeBelowCt }];
      const sellLine = [{ x: 1, y: thresholds.sellAboveCt }, { x: n, y: thresholds.sellAboveCt }];
      historyVizCharts.duration = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
          datasets: [
            {
              label: 'Spot ct/kWh',
              data: curve,
              borderColor: cssVar('--cyan', '#34dbff'),
              backgroundColor: cssVarAlpha('--cyan', 0.16, '#34dbff'),
              fill: true,
              tension: 0,
              borderWidth: 2,
              pointRadius: 0,
            },
            {
              label: 'Lade-Schwelle',
              data: chargeLine,
              borderColor: cssVar('--green', '#3ee0a0'),
              backgroundColor: 'transparent',
              borderWidth: 1.5,
              borderDash: [6, 4],
              pointRadius: 0,
              fill: false,
            },
            {
              label: 'Verkaufs-Schwelle',
              data: sellLine,
              borderColor: cssVar('--yellow', '#ffd421'),
              backgroundColor: 'transparent',
              borderWidth: 1.5,
              borderDash: [6, 4],
              pointRadius: 0,
              fill: false,
            },
          ],
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          parsing: false,
          interaction: INTERACTION_INDEX,
          plugins: { legend: { display: false } },
          scales: {
            x: {
              type: 'linear',
              title: { display: true, text: 'Rang (teuer → billig)' },
              grid: { display: false },
              ticks: { autoSkip: true, maxRotation: 0 },
            },
            y: { title: { display: true, text: 'ct/kWh' }, grid: { color: 'rgba(141,180,221,0.1)' } },
          },
        },
      });
      // Stats footer — textContent only (T-09.3-16 XSS guard).
      const stats = data.stats || {};
      const statsEl = document.getElementById('vDurationStats');
      if (statsEl) {
        const mean = Number(stats.meanCt || 0).toFixed(1);
        statsEl.textContent =
          `Ø ${mean} ct · ${Number(stats.hoursBelowChargeThreshold || 0)} h < ${Number(thresholds.chargeBelowCt)} ct · `
          + `${Number(stats.hoursAboveSellThreshold || 0)} h > ${Number(thresholds.sellAboveCt)} ct`;
      }
      setTimeout(() => {
        try { historyVizCharts.duration && historyVizCharts.duration.resize && historyVizCharts.duration.resize(); }
        catch (_) { /* dead chart */ }
      }, 0);
    } catch (e) {
      console.error('history-viz: buildDuration failed', e);
      showFriendlyError(mount, 'Preis-Duration');
    }
  }

  // -------------------------------------------------------------------------
  // Plan 09.3-04 Wave 4 — 3 LIVE frontend builders.
  // Preis-Heatmap (Chart.js matrix, 4-stop interpolated price scale),
  // SOC-Spaghetti (Chart.js line × up-to-30 day-curves, "Heute" highlighted),
  // Zyklen-Histogramm (Chart.js mixed bar+line, stacked kWh + cycles line on a
  // 2nd y-axis). Same canvas-swap pattern as Waves 2-3.
  // -------------------------------------------------------------------------

  async function buildPheat(view, date) {
    const mount = document.getElementById('vPHeat');
    if (!mount) return;
    if (typeof Chart === 'undefined') return;
    try {
      const data = await fetchCardData('pheat', view, date);
      if (historyVizCharts.pheat) {
        try { historyVizCharts.pheat.destroy(); } catch (_) { /* dead */ }
        delete historyVizCharts.pheat;
      }
      const xLabels = data.xLabels || [];
      const yLabels = data.yLabels || [];
      const matrix = data.matrix || [];
      const domainMax = (data.domain && Number.isFinite(data.domain.max)) ? data.domain.max : 0;
      // Empty-data path — the matrix is always 168 cells but all-zero when the
      // market-price table is empty on prod. Render the friendly placeholder
      // instead of a uniform single-color grid.
      if (domainMax <= 0 || matrix.length === 0) {
        showEmptyData(mount);
        return;
      }
      const canvas = mountCanvas(mount, 'vPHeatCanvas');
      historyVizCharts.pheat = new Chart(canvas.getContext('2d'), {
        type: 'matrix',
        data: { datasets: [{
          label: 'Ø Spot ct/kWh',
          data: matrix,
          backgroundColor(c) {
            const cell = c.dataset.data[c.dataIndex];
            const v = cell && Number.isFinite(cell.v) ? cell.v : 0;
            const t = domainMax > 0 ? Math.min(1, Math.max(0, v / domainMax)) : 0;
            // 4-stop gradient; stops resolve via cssVar at paint time so the
            // scale is theme-aware (RESEARCH §Pitfall 7).
            return interpolateGradient([
              { at: 0,    color: cssVar('--green',  '#3ee0a0') },
              { at: 0.33, color: cssVar('--cyan',   '#34dbff') },
              { at: 0.67, color: cssVar('--yellow', '#ffd421') },
              { at: 1,    color: cssVar('--red',    '#ff5d5d') },
            ], t);
          },
          borderWidth: 0,
          // RESEARCH §Pitfall 3 — chartArea may be undefined on first layout.
          width(c) {
            const w = (c.chart && c.chart.chartArea && c.chart.chartArea.width) || 0;
            return Math.max(1, (w / Math.max(1, xLabels.length)) - 1);
          },
          height(c) {
            const h = (c.chart && c.chart.chartArea && c.chart.chartArea.height) || 0;
            return Math.max(1, (h / Math.max(1, yLabels.length)) - 1);
          },
        }] },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          interaction: INTERACTION_NEAREST,
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: {
              title() { return ''; },
              label(c) {
                // RC-2 — d.x / d.y are the exact category label STRINGS
                // ("00".."23" hour, "Mo".."So" DOW); use them directly.
                const d = c.dataset.data[c.dataIndex];
                if (!d) return '';
                const v = Number(d.v) || 0;
                return `${d.y} ${d.x}h: ${v.toFixed(1)} ct/kWh`;
              },
            } },
          },
          scales: {
            x: { type: 'category', labels: xLabels, ticks: { autoSkip: true, maxRotation: 0 }, grid: { display: false } },
            y: { type: 'category', labels: yLabels, offset: true, reverse: true, grid: { display: false } },
          },
        },
      });
      setTimeout(() => {
        try { historyVizCharts.pheat && historyVizCharts.pheat.resize && historyVizCharts.pheat.resize(); }
        catch (_) { /* dead chart */ }
      }, 0);
    } catch (e) {
      console.error('history-viz: buildPheat failed', e);
      showFriendlyError(mount, 'Preis-Heatmap');
    }
  }

  async function buildSpaghetti(view, date) {
    const mount = document.getElementById('vSpag');
    if (!mount) return;
    if (typeof Chart === 'undefined') return;
    try {
      const data = await fetchCardData('spaghetti', view, date);
      if (historyVizCharts.spaghetti) {
        try { historyVizCharts.spaghetti.destroy(); } catch (_) { /* dead */ }
        delete historyVizCharts.spaghetti;
      }
      const canvas = mountCanvas(mount, 'vSpagCanvas');
      const seriesIn = Array.isArray(data.series) ? data.series : [];
      // One line dataset per day. All days green-alpha; the "Heute" day
      // overrides to white + thicker border and is drawn on top (order 0).
      const datasets = seriesIn.map((s) => ({
        label: s.date,
        data: (s.points || []).map((p) => ({ x: p.h, y: p.soc })),
        borderColor: s.isToday ? '#ffffff' : cssVarAlpha('--green', 0.5, '#3ee0a0'),
        borderWidth: s.isToday ? 2 : 1,
        pointRadius: 0,
        tension: 0.2,
        fill: false,
        order: s.isToday ? 0 : 1,
      }));
      historyVizCharts.spaghetti = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: { datasets },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          parsing: false,
          interaction: INTERACTION_NEAREST,
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: {
              title(items) { return items && items[0] ? `${items[0].raw.x}:00 Uhr` : ''; },
              label(c) { return `${c.dataset.label}: ${Number(c.raw.y).toFixed(0)} %`; },
            } },
          },
          scales: {
            x: {
              type: 'linear', min: 0, max: 23,
              title: { display: true, text: 'Stunde' },
              grid: { display: false },
              ticks: { stepSize: 3, autoSkip: true, maxRotation: 0 },
            },
            y: {
              min: 0, max: 100,
              title: { display: true, text: 'SOC %' },
              grid: { color: 'rgba(141,180,221,0.1)' },
            },
          },
        },
      });
      setTimeout(() => {
        try { historyVizCharts.spaghetti && historyVizCharts.spaghetti.resize && historyVizCharts.spaghetti.resize(); }
        catch (_) { /* dead chart */ }
      }, 0);
    } catch (e) {
      console.error('history-viz: buildSpaghetti failed', e);
      showFriendlyError(mount, 'SOC-Spaghetti');
    }
  }

  async function buildCycles(view, date) {
    const mount = document.getElementById('vCycles');
    if (!mount) return;
    if (typeof Chart === 'undefined') return;
    try {
      const data = await fetchCardData('cycles', view, date);
      if (historyVizCharts.cycles) {
        try { historyVizCharts.cycles.destroy(); } catch (_) { /* dead */ }
        delete historyVizCharts.cycles;
      }
      const canvas = mountCanvas(mount, 'vCyclesCanvas');
      const perDow = Array.isArray(data.perDow) ? data.perDow : [];
      historyVizCharts.cycles = new Chart(canvas.getContext('2d'), {
        type: 'bar',
        data: {
          labels: perDow.map((d) => d.label),
          datasets: [
            {
              label: 'Geladen kWh',
              data: perDow.map((d) => d.chargedKwh),
              backgroundColor: cssVar('--green', '#3ee0a0'),
              stack: 'kwh', yAxisID: 'y',
              // RC-E — higher order draws first/underneath; the line (order:0)
              // must paint on top of the bars (order:1) or it stays hidden.
              order: 1,
            },
            {
              label: 'Entladen kWh',
              data: perDow.map((d) => -d.dischargedKwh),
              backgroundColor: '#ff7eb6',
              stack: 'kwh', yAxisID: 'y',
              order: 1,
            },
            {
              label: 'Zyklen', type: 'line',
              data: perDow.map((d) => d.cycles),
              borderColor: cssVar('--violet', '#a78bfa'),
              backgroundColor: 'transparent',
              borderWidth: 2,
              pointRadius: 0,
              tension: 0.3,
              yAxisID: 'y1',
              order: 0,
            },
          ],
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          interaction: INTERACTION_INDEX,
          plugins: { legend: { display: false } },
          scales: {
            x: { stacked: true, grid: { display: false } },
            y: {
              stacked: true, position: 'left',
              title: { display: true, text: 'kWh' },
              grid: { color: 'rgba(141,180,221,0.1)' },
            },
            y1: {
              position: 'right',
              title: { display: true, text: 'Zyklen' },
              grid: { drawOnChartArea: false },
            },
          },
        },
      });
      setTimeout(() => {
        try { historyVizCharts.cycles && historyVizCharts.cycles.resize && historyVizCharts.cycles.resize(); }
        catch (_) { /* dead chart */ }
      }, 0);
    } catch (e) {
      console.error('history-viz: buildCycles failed', e);
      showFriendlyError(mount, 'Akku-Zyklen');
    }
  }

  // -------------------------------------------------------------------------
  // Plan 09.3-05 Wave 5 — 3 LIVE frontend builders (the FINAL 3 of 14).
  // Top-10-Slots (Chart.js horizontal bar, indexAxis 'y'), Cal-Heatmap-12-
  // Monat (Chart.js matrix, DIVERGING red→faded→green palette keyed on signed
  // net-€), Wetter×Erlös-Scatter (Chart.js scatter, point colour = autarky %).
  // Same canvas-swap pattern as Waves 2-4. CONTEXT discretion item 4: Cal-Year
  // uses a diverging palette because daily net-€ is SIGNED — normalisation is
  // (v - domain.min)/(domain.max - domain.min), NOT |v|/max, so the midpoint
  // (0 €) lands on the faded stop.
  // -------------------------------------------------------------------------

  async function buildTop10(view, date) {
    const mount = document.getElementById('vTop10');
    if (!mount) return;
    if (typeof Chart === 'undefined') return;
    try {
      const data = await fetchCardData('top10', view, date);
      if (historyVizCharts.top10) {
        try { historyVizCharts.top10.destroy(); } catch (_) { /* dead */ }
        delete historyVizCharts.top10;
      }
      const slots = Array.isArray(data.slots) ? data.slots : [];
      // Empty-data path — no priced dispatch slots on prod yet. Render the
      // friendly placeholder instead of an empty horizontal-bar chart.
      if (slots.length === 0) {
        showEmptyData(mount);
        return;
      }
      const canvas = mountCanvas(mount, 'vTop10Canvas');
      const labels = slots.map((s) => {
        const d = new Date(s.ts);
        if (Number.isNaN(d.getTime())) return String(s.ts || '');
        return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })
          + ' ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
      });
      historyVizCharts.top10 = new Chart(canvas.getContext('2d'), {
        type: 'bar',
        data: { labels, datasets: [{
          label: 'Erlös €',
          data: slots.map((s) => s.revenueEur),
          backgroundColor: cssVar('--green', '#3ee0a0'),
          borderWidth: 0,
        }] },
        options: {
          indexAxis: 'y',
          responsive: true, maintainAspectRatio: false, animation: false,
          interaction: INTERACTION_INDEX,
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: {
              label(c) {
                const s = slots[c.dataIndex];
                if (!s) return '';
                return `${Number(s.kwh).toFixed(2)} kWh @ ${Number(s.priceCt).toFixed(2)} ct = € ${Number(s.revenueEur).toFixed(2)}`;
              },
            } },
          },
          scales: {
            x: { title: { display: true, text: '€' }, beginAtZero: true, grid: { color: 'rgba(141,180,221,0.1)' } },
            y: { grid: { display: false } },
          },
        },
      });
      setTimeout(() => {
        try { historyVizCharts.top10 && historyVizCharts.top10.resize && historyVizCharts.top10.resize(); }
        catch (_) { /* dead chart */ }
      }, 0);
    } catch (e) {
      console.error('history-viz: buildTop10 failed', e);
      showFriendlyError(mount, 'Top-10-Slots');
    }
  }

  async function buildCalYear(view, date) {
    const mount = document.getElementById('vCalYear');
    if (!mount) return;
    if (typeof Chart === 'undefined') return;
    try {
      const data = await fetchCardData('cal-year', view, date);
      if (historyVizCharts.calYear) {
        try { historyVizCharts.calYear.destroy(); } catch (_) { /* dead */ }
        delete historyVizCharts.calYear;
      }
      const canvas = mountCanvas(mount, 'vCalYearCanvas');
      const xLabels = data.xLabels || [];
      const yLabels = data.yLabels || [];
      const matrix = data.matrix || [];
      const domain = data.domain || { min: 0, max: 0 };
      const range = domain.max - domain.min;
      historyVizCharts.calYear = new Chart(canvas.getContext('2d'), {
        type: 'matrix',
        data: { datasets: [{
          label: 'Netto €/Tag',
          data: matrix,
          backgroundColor(c) {
            const cell = c.dataset.data[c.dataIndex];
            const v = cell && Number.isFinite(cell.v) ? cell.v : 0;
            // DIVERGING palette — normalise across the full signed range so
            // 0 € lands on the faded midpoint stop (NOT |v|/max).
            const t = range > 0 ? (v - domain.min) / range : 0.5;
            return interpolateGradient([
              { at: 0,   color: '#ff5d5d' },
              { at: 0.5, color: 'rgba(120,180,255,0.10)' },
              { at: 1,   color: '#3ee0a0' },
            ], Math.max(0, Math.min(1, t)));
          },
          borderWidth: 0,
          // RESEARCH §Pitfall 3 — chartArea may be undefined on first layout.
          width(c) {
            const w = (c.chart && c.chart.chartArea && c.chart.chartArea.width) || 0;
            return Math.max(1, (w / Math.max(1, xLabels.length)) - 1);
          },
          height(c) {
            const h = (c.chart && c.chart.chartArea && c.chart.chartArea.height) || 0;
            return Math.max(1, (h / Math.max(1, yLabels.length)) - 1);
          },
        }] },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          interaction: INTERACTION_NEAREST,
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: {
              title() { return ''; },
              label(c) {
                // RC-2 — d.x is the month label, d.y is the day-of-month
                // label STRING ("1".."31"); use both directly.
                const d = c.dataset.data[c.dataIndex];
                if (!d) return '';
                return `${d.x} ${d.y}: € ${Number(d.v).toFixed(2)}`;
              },
            } },
          },
          scales: {
            x: { type: 'category', labels: xLabels, ticks: { autoSkip: true, maxRotation: 0 }, grid: { display: false } },
            y: { type: 'category', labels: yLabels, offset: true, reverse: true, grid: { display: false } },
          },
        },
      });
      setTimeout(() => {
        try { historyVizCharts.calYear && historyVizCharts.calYear.resize && historyVizCharts.calYear.resize(); }
        catch (_) { /* dead chart */ }
      }, 0);
    } catch (e) {
      console.error('history-viz: buildCalYear failed', e);
      showFriendlyError(mount, 'Netto-Kalender');
    }
  }

  async function buildScatter(view, date) {
    const mount = document.getElementById('vScatter');
    if (!mount) return;
    if (typeof Chart === 'undefined') return;
    try {
      const data = await fetchCardData('scatter', view, date);
      // Empty / no-weather-data path — render a placeholder instead of an
      // empty chart. textContent only (D-22 / T-09.3-10 — never innerHTML).
      if (!data.weatherDataAvailable || !Array.isArray(data.points) || data.points.length === 0) {
        mount.replaceChildren();
        const msg = document.createElement('div');
        msg.className = 'viz-error-msg';
        msg.textContent = 'Wetterdaten werden gesammelt (mind. 7 Tage erforderlich für Korrelation).';
        mount.appendChild(msg);
        const statsEmpty = document.getElementById('vScatterStats');
        if (statsEmpty) statsEmpty.textContent = '';
        return;
      }
      if (historyVizCharts.scatter) {
        try { historyVizCharts.scatter.destroy(); } catch (_) { /* dead */ }
        delete historyVizCharts.scatter;
      }
      const canvas = mountCanvas(mount, 'vScatterCanvas');
      const points = data.points;
      historyVizCharts.scatter = new Chart(canvas.getContext('2d'), {
        type: 'scatter',
        data: { datasets: [{
          label: 'Tag',
          data: points.map((p) => ({ x: p.ghi, y: p.netEur, _autarky: p.autarkyPct })),
          pointBackgroundColor(c) {
            const cell = c.dataset.data[c.dataIndex];
            const a = cell && Number.isFinite(cell._autarky) ? cell._autarky / 100 : 0;
            // 3-stop autarky scale: red 0 % → yellow 50 % → green 100 %.
            return interpolateGradient([
              { at: 0,   color: '#ff5d5d' },
              { at: 0.5, color: '#ffd421' },
              { at: 1,   color: '#3ee0a0' },
            ], Math.max(0, Math.min(1, a)));
          },
          pointBorderColor: 'transparent',
          pointRadius: 5,
          pointHoverRadius: 7,
        }] },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          interaction: INTERACTION_NEAREST,
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: {
              label(c) {
                const p = points[c.dataIndex];
                if (!p) return '';
                return `${p.date}: GHI ${Number(p.ghi).toFixed(0)} W/m² · € ${Number(p.netEur).toFixed(2)} · ${p.autarkyPct} %`;
              },
            } },
          },
          scales: {
            x: { title: { display: true, text: 'GHI W/m²' }, grid: { color: 'rgba(141,180,221,0.1)' } },
            y: { title: { display: true, text: 'Netto €/Tag' }, grid: { color: 'rgba(141,180,221,0.1)' } },
          },
        },
      });
      // Correlation footer — textContent only (T-09.3-16 XSS guard).
      const stats = document.getElementById('vScatterStats');
      if (stats) {
        const corr = data.correlation || { r: 0, n: points.length };
        stats.textContent = `${points.length} Tage · r = ${Number(corr.r || 0).toFixed(2)}`;
      }
      setTimeout(() => {
        try { historyVizCharts.scatter && historyVizCharts.scatter.resize && historyVizCharts.scatter.resize(); }
        catch (_) { /* dead chart */ }
      }, 0);
    } catch (e) {
      console.error('history-viz: buildScatter failed', e);
      showFriendlyError(mount, 'Wetter×Erlös');
    }
  }

  // Slug → builder map. Keys MUST match the backend slugs (aggregator.js
  // getXxx methods) and the kebab-case suffix of /api/history/viz/{slug}.
  // The `ledger` slug is intentionally absent — the Spot-Ledger card was
  // removed by design, so its endpoint is never fetched (backend getLedger
  // stays in aggregator.js, harmless).
  const buildDispatch = {
    sankey: buildSankey,
    heatmap: buildHeatmap,
    'day-profile': buildDayProfile,
    stack: buildStack,
    'autarky-calendar': buildAutarkyCalendar,
    ring: buildRing,
    duration: buildDuration,
    pheat: buildPheat,
    spaghetti: buildSpaghetti,
    cycles: buildCycles,
    top10: buildTop10,
    'cal-year': buildCalYear,
    scatter: buildScatter,
  };

  // --- View-state machine.
  //
  // Reads #historyView (Tag/Woche/Monat/Jahr) and #historyDate, then for each
  // [data-show-view] section toggles `.viz-hidden-by-view` based on whether
  // the current view is whitelisted on that section.
  //
  // D-25: visibility via classList.toggle (the JS visibility-clear
  //       anti-pattern is enforced-banned by tests/csp-lint.mjs scoped to
  //       this file — see the lint rule for details).
  // D-16: lazy-build memo prevents re-rendering an already-built card. Plan
  //       09.3-06 Wave 6 widens the memo key from `card:view` to the 3-segment
  //       `card:view:date` (RESEARCH §Pitfall 6) — so a date change while the
  //       view stays equal busts the memo and triggers a rebuild. The memo
  //       entry is added in the build's `.then()` SUCCESS branch only, so a
  //       failed build (network error) re-attempts on the next applyView
  //       (T-09.3-27 build-retry).
  // RESEARCH §Pitfall 4: stagger build*() calls via a setTimeout chain with
  //       1ms increments so a 9-card view='year' burst serialises across the
  //       next ~9 frames instead of slamming the rate-limiter (T-09.3-26).
  //
  // Wave-6 note on first render: if #historyDate is empty on initial load the
  // date falls back to today's date in YYYY-MM-DD via
  // `new Date().toISOString().slice(0,10)` — keeping the memo key well-formed
  // and matching the date history.js's loadHistorySummary defaults to.

  let currentView = 'day';

  function applyView(view, date) {
    const viewSel = document.getElementById('historyView');
    const dateInp = document.getElementById('historyDate');
    currentView = view || (viewSel ? viewSel.value : null) || 'day';
    const d = date || (dateInp ? dateInp.value : '') || new Date().toISOString().slice(0, 10);
    const buildQueue = [];
    document.querySelectorAll('[data-show-view]').forEach((section) => {
      const showViews = (section.dataset.showView || '').split(/\s+/).filter(Boolean);
      const visible = showViews.includes(currentView);
      // D-25 — class toggle (no inline visibility writes)
      section.classList.toggle('viz-hidden-by-view', !visible);
      if (!visible) return;
      const card = section.dataset.vizCard;
      // Defensive — a section may be a non-viz card (the original DV-card) or
      // carry an unknown card name; skip silently, never throw (T-09.3-28).
      if (!card || !buildDispatch[card]) return;
      // 3-segment memo key — date is part of the identity so a date-change
      // rebuild fires even when the view is unchanged (RESEARCH §Pitfall 6).
      const memoKey = `${card}:${currentView}:${d}`;
      if (built.has(memoKey)) return;
      buildQueue.push({ card, memoKey });
    });
    // RESEARCH §Pitfall 4 — stagger via a setTimeout chain so a 9-card burst
    // serialises across frames instead of slamming the rate-limiter. 1ms
    // increments spread 9 cards over ~9ms — well below the user-perceptible
    // threshold yet enough to break the single-microtask fetch burst.
    let delay = 0;
    for (const { card, memoKey } of buildQueue) {
      setTimeout(() => {
        // Re-check visibility at execution time — the user may have toggled
        // the view again mid-stagger; don't build a now-hidden card.
        const stillRelevant = (document.querySelector(`[data-viz-card="${card}"]`)
          ?.dataset.showView || '').split(/\s+/).includes(currentView);
        if (!stillRelevant) return;
        Promise.resolve()
          .then(() => buildDispatch[card](currentView, d))
          .then(() => { built.add(memoKey); })   // memo on SUCCESS only — T-09.3-27 retry
          .catch((e) => console.error('history-viz build failed', card, e));
      }, delay);
      delay += 1;
    }
  }

  function destroyAll() {
    for (const k of Object.keys(historyVizCharts)) {
      try { historyVizCharts[k] && historyVizCharts[k].destroy && historyVizCharts[k].destroy(); }
      catch (_) { /* dead instance */ }
      delete historyVizCharts[k];
    }
    built.clear();
  }

  function init() {
    if (__historyVizBound) return;
    __historyVizBound = true;
    const viewSel = document.getElementById('historyView');
    const dateInp = document.getElementById('historyDate');
    // Wave-6 — destroyAll() runs on BOTH view-change AND date-change. A
    // date-change keeps the view equal but the 3-segment memo key
    // (card:view:date) busts, so a full destroy + rebuild keeps the chart
    // registry clean and avoids stale instances from a prior date.
    if (viewSel) {
      viewSel.addEventListener('change', () => {
        destroyAll();
        applyView(viewSel.value, dateInp ? dateInp.value : '');
      });
    }
    if (dateInp) {
      dateInp.addEventListener('change', () => {
        destroyAll();
        applyView(viewSel ? viewSel.value : 'day', dateInp.value);
      });
    }
    // First-render dispatch — co-listens to the same #historyView / #historyDate
    // DOM as history.js's loadHistorySummary (D-13: history.js stays untouched).
    // If #historyDate is empty on initial load, fall back to today's date in
    // YYYY-MM-DD so the memo key is well-formed (applyView itself also coalesces).
    applyView(
      viewSel ? viewSel.value : 'day',
      (dateInp && dateInp.value) || new Date().toISOString().slice(0, 10)
    );

    // --- Resize hook (RESEARCH §Pitfall 1): Chart.js 4 ResizeObserver throttles
    // around 60ms; an explicit debounced resize prevents stale aspect-ratio
    // bugs when the viewport slides between mobile/desktop breakpoints.
    let resizeDebounce = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeDebounce);
      resizeDebounce = setTimeout(() => {
        for (const c of Object.values(historyVizCharts)) {
          try { c && c.resize && c.resize(); } catch (_) { /* dead chart */ }
        }
      }, 60);
    });
    window.addEventListener('orientationchange', () => {
      setTimeout(() => {
        for (const c of Object.values(historyVizCharts)) {
          try { c && c.resize && c.resize(); } catch (_) { /* dead chart */ }
        }
      }, 200);
    });

    // --- Theme-toggle hook (RESEARCH §Pitfall 7) — D-21 READ-only.
    // theme.js writes <html data-theme="…"> on cycle; we observe the attribute
    // change and trigger a no-animation Chart.js repaint so colors picked from
    // CSS vars refresh WITHOUT a destroy + re-create (the cheap repaint path).
    try {
      const themeObs = new MutationObserver(() => {
        for (const c of Object.values(historyVizCharts)) {
          try { c && c.update && c.update('none'); } catch (_) { /* dead chart */ }
        }
      });
      themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (_) { /* MutationObserver missing on ancient browsers; non-critical */ }
  }

  // Public namespace. `applyView` + `charts` are the documented surface;
  // `_internals` exists for tests + leak guard only — DO NOT consume from
  // production callers.
  if (typeof window !== 'undefined') {
    window.historyViz = {
      applyView,
      charts: historyVizCharts,
      _internals: { cssVar, cssVarAlpha, fetchCardData, buildDispatch, built },
    };
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }
})();
