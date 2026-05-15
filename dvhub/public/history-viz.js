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

  async function buildSankey(view, date)            { console.warn('history-viz: buildSankey not implemented'); }
  async function buildHeatmap(view, date)           { console.warn('history-viz: buildHeatmap not implemented'); }
  async function buildLedger(view, date)            { console.warn('history-viz: buildLedger not implemented'); }
  async function buildDayProfile(view, date)        { console.warn('history-viz: buildDayProfile not implemented'); }
  async function buildStack(view, date)             { console.warn('history-viz: buildStack not implemented'); }
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
