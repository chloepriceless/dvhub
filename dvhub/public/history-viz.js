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

  // --- Aggregator-fetch helper. Each builder calls fetchCardData(slug, view, date).

  async function fetchCardData(slug, view, date) {
    const url = `/api/history/viz/${slug}?view=${encodeURIComponent(view || '')}&date=${encodeURIComponent(date || '')}`;
    const r = await apiFetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${slug}`);
    return r.json();
  }

  // --- 14 stub builders. Waves 2-5 replace each body with the actual Chart.js
  // mount. The signature is fixed so the dispatcher can remain stable.

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
        }] },
        options: { responsive: true, maintainAspectRatio: false, animation: false },
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
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: {
              title() { return ''; },
              label(c) {
                const d = c.dataset.data[c.dataIndex];
                if (!d) return '';
                const yLabel = (typeof d.y === 'number') ? String(d.y).padStart(2, '0') : String(d.y);
                const v = Number(d.v) || 0;
                return `${d.x} · ${yLabel}: ${v.toFixed(2)} kWh`;
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

  async function buildLedger(view, date) {
    const tbody = document.getElementById('ledgerBody');
    if (!tbody) return;
    try {
      const data = await fetchCardData('ledger', view, date);
      // T-09.3-10 — DOM-build via createElement+textContent ONLY. Server values
      // (action label, formatted numbers) are never injected as HTML.
      tbody.replaceChildren();
      const slots = Array.isArray(data.slots) ? data.slots : [];
      // Mark the registry so window.historyViz.charts shows the ledger built
      // (the leak guard counts charts; the ledger has no Chart.js but it still
      // owns a slot in the per-view memo and we want presence in the registry).
      historyVizCharts.ledger = { _kind: 'table', destroy() { /* no chart, noop */ }, resize() { /* noop */ } };
      for (const slot of slots) {
        const tr = document.createElement('tr');
        const ts = slot.ts ? new Date(slot.ts) : null;
        const tsText = (ts && !Number.isNaN(ts.getTime()))
          ? ts.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
          : String(slot.ts || '');
        const kwh = Number(slot.kwh);
        const priceCt = Number(slot.priceCt);
        const revenueEur = Number(slot.revenueEur);
        const cells = [
          tsText,
          String(slot.action || 'hold'),
          Number.isFinite(kwh) ? kwh.toFixed(2) : '0,00',
          Number.isFinite(priceCt) ? priceCt.toFixed(2) : '0,00',
          Number.isFinite(revenueEur)
            ? (revenueEur >= 0 ? `+${revenueEur.toFixed(2)}` : revenueEur.toFixed(2))
            : '0,00',
        ];
        for (let i = 0; i < cells.length; i++) {
          const td = document.createElement('td');
          if (i >= 2) td.className = 'num';
          td.textContent = cells[i];
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
    } catch (e) {
      console.error('history-viz: buildLedger failed', e);
      tbody.replaceChildren();
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.className = 'ledger-error';
      td.textContent = 'Ledger: Daten aktuell nicht verfügbar';
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
  }

  async function buildAutarkyCalendar(view, date)   { console.warn('history-viz: buildAutarkyCalendar not implemented'); }
  async function buildRing(view, date)              { console.warn('history-viz: buildRing not implemented'); }
  async function buildDuration(view, date)          { console.warn('history-viz: buildDuration not implemented'); }
  async function buildPheat(view, date)             { console.warn('history-viz: buildPheat not implemented'); }
  async function buildSpaghetti(view, date)         { console.warn('history-viz: buildSpaghetti not implemented'); }
  async function buildCycles(view, date)            { console.warn('history-viz: buildCycles not implemented'); }
  async function buildTop10(view, date)             { console.warn('history-viz: buildTop10 not implemented'); }
  async function buildCalYear(view, date)           { console.warn('history-viz: buildCalYear not implemented'); }
  async function buildScatter(view, date)           { console.warn('history-viz: buildScatter not implemented'); }

  // Slug → builder map. Keys MUST match the 14 backend slugs (aggregator.js
  // makeStub('…')) and the kebab-case suffix of /api/history/viz/{slug}.
  const buildDispatch = {
    sankey: buildSankey,
    heatmap: buildHeatmap,
    ledger: buildLedger,
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
  // D-16: lazy-build memo prevents re-rendering an already-built card when
  // the same (card, view) pair is shown again within the same page session.
  // RESEARCH §Pitfall 4: stagger build*() calls via setTimeout(0) so a 9-card
  // burst doesn't slam the rate-limiter.

  function applyView(view, date) {
    const viewSel = document.getElementById('historyView');
    const dateInp = document.getElementById('historyDate');
    const v = view || (viewSel ? viewSel.value : null) || 'day';
    const d = date || (dateInp ? dateInp.value : '') || '';
    const sections = document.querySelectorAll('[data-show-view]');
    sections.forEach((section) => {
      const showViews = (section.dataset.showView || '').split(/\s+/).filter(Boolean);
      const visible = showViews.includes(v);
      // D-25 — class toggle (no inline visibility writes)
      section.classList.toggle('viz-hidden-by-view', !visible);
      if (!visible) return;
      const card = section.dataset.vizCard;
      if (!card || !buildDispatch[card]) return;
      const memoKey = `${card}:${v}`;
      if (built.has(memoKey)) return;
      built.add(memoKey);
      // RESEARCH §Pitfall 4 — stagger via setTimeout(0) so a 9-card burst
      // serialises across frames instead of slamming the rate-limiter.
      setTimeout(() => {
        Promise.resolve()
          .then(() => buildDispatch[card](v, d))
          .catch((e) => console.error('history-viz build failed', card, e));
      }, 0);
    });
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
    // Initial dispatch — at this point Wave 1 has no [data-show-view] sections,
    // so the loop is a no-op. Waves 2-5 add sections; once a section ships,
    // applyView() will lazy-build it on first render.
    applyView(viewSel ? viewSel.value : 'day', dateInp ? dateInp.value : '');

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
    // change and call chart.update('none') so colors picked from CSS vars
    // refresh without a full re-render.
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
