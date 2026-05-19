import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const publicDir = path.join(repoRoot, 'public');

function readPublic(fileName) {
  return fs.readFileSync(path.join(publicDir, fileName), 'utf8');
}

// Plan 16-04 (D-06 triage, brittle test): a minimal classList stub. The Aurora
// history.js grew `classList.toggle` calls (e.g. renderKpis toggles
// `history-dv-card-hidden` on #historyDvCard); the original DOM mock had a
// `className` string but no `classList`, so every renderKpis-driven test threw
// `Cannot read properties of undefined (reading 'toggle')`. This stub keeps the
// classList API surface the page actually uses, backed by a Set.
function createClassListStub() {
  const set = new Set();
  return {
    add(...names) { for (const n of names) set.add(n); },
    remove(...names) { for (const n of names) set.delete(n); },
    contains(name) { return set.has(name); },
    toggle(name, force) {
      const want = force === undefined ? !set.has(name) : Boolean(force);
      if (want) set.add(name); else set.delete(name);
      return want;
    },
    get length() { return set.size; }
  };
}

function createElement() {
  // Plan 16-04 (D-06 triage, brittle test): `innerHTML` is a getter/setter so
  // `firstElementChild` reflects assigned markup. The Aurora history.js chart
  // mounts assign `mount.innerHTML = '<div>...<canvas>...'` then immediately
  // read `mount.firstElementChild.style.height` — a bare string property left
  // firstElementChild undefined and threw. The child is a lightweight element
  // stub; the chart code only touches its `.style`.
  let _innerHTML = '';
  let _firstChild = null;
  const el = {
    textContent: '',
    className: '',
    classList: createClassListStub(),
    value: '',
    disabled: false,
    hidden: false,
    style: {},
    dataset: {},
    ariaPressed: null,
    ariaExpanded: null,
    listeners: new Map(),
    addEventListener(type, handler) {
      this.listeners.set(type, handler);
    },
    querySelector() { return null; },
    get innerHTML() { return _innerHTML; },
    set innerHTML(html) {
      _innerHTML = String(html);
      _firstChild = _innerHTML.trim()
        ? { style: {}, classList: createClassListStub(), textContent: '', innerHTML: '' }
        : null;
    },
    get firstElementChild() { return _firstChild; }
  };
  return el;
}

function loadHistoryPageHelpers() {
  const source = readPublic('history.js');
  const ids = [
    'historyBanner',
    'historyBannerText',
    'historyMeta',
    'historyChartGrid',
    'historyPremiumFields',
    'historyPremiumHint',
    'historyPremiumScopeLabel',
    'historyPremiumMarketValueLabel',
    'historyPremiumRateLabel',
    'historyKpiTotalCost',
    'historyKpiCost',
    'historyKpiAvoidedPvCost',
    'historyKpiAvoidedBatteryCost',
    'historyKpiTotalRevenue',
    'historyKpiRevenue',
    'historyKpiNet',
    'historyKpiCashIn',
    'historyKpiCashOut',
    'historyKpiAvoided',
    'historyKpiAvoidedPvGross',
    'historyKpiAvoidedBatteryGross',
    'historyKpiAvoidedPvMarket',
    'historyKpiAvoidedBatMarket',
    'historyKpiOppCost',
    'historyKpiPv',
    'historyKpiSelfCons',
    'historyKpiImport',
    'historyKpiExport',
    'historyKpiVbh',
    'historyKpiGrossReturn',
    'historyKpiBilanzAvoided',
    'historyKpiBilanzNet',
    'historyKpiBilanzPvCost',
    'historyKpiBilanzBatCost',
    'historyKpiBilanzCard',
    'historyKpiAnnualMarketValue',
    'historyKpiPremiumEligibleExport',
    'historyKpiMarketPremium',
    'historyKpiMarketPremiumRate',
    'historyDvCard',
    'historyKpiDvRevenue',
    'historyKpiDvRevenueRate',
    'historyKpiHypFullFeedIn',
    'historyKpiHypSurplusFeedIn',
    'historyKpiDvExcess',
    'historyKpiDvCost',
    'historyKpiDvNetAdvantage',
    'historyAvoidedLabel',
    'historyAvoidedDefault',
    'historyAvoidedMarket',
    'historyMarketToggle',
    'historyFinancialPanel',
    'historyEnergyPanel',
    'historyPricePanel',
    'historyFinancialChart',
    'historyEnergyChart',
    'historyPriceChart',
    'historySolarSummary',
    'historyPriceList',
    'historyAggregatePriceHint',
    'historyAggregateMode',
    'historyAggregateOverviewBtn',
    'historyAggregateTableBtn',
    'historyDetailsToggle',
    'historyDetailsContent',
    'historyRows',
    'historyStatusInfoToggle',
    'historyStatusInfo',
    'historyBackfillBtn',
    'historyView',
    'historyDate',
    'historyPrevBtn',
    'historyNextBtn',
  ];
  const elements = new Map(ids.map((id) => [id, createElement()]));
  elements.get('historyView').value = 'day';
  elements.get('historyDate').value = '2026-03-09';
  const sandbox = {
    console,
    URL,
    globalThis: {},
    Chart: class Chart { destroy() {} },
    window: {
      __DVHUB_HISTORY_TEST__: true,
      DVhubCommon: {}
    },
    document: {
      getElementById(id) {
        if (!elements.has(id)) {
          // Auto-create elements for dynamic IDs (e.g. canvas mounts)
          elements.set(id, createElement());
        }
        return elements.get(id);
      }
    }
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: 'history.js' });
  return {
    helpers: sandbox.DVhubHistoryPage,
    elements
  };
}

test('navigation exposes Historie across shell pages', () => {
  // Plan 08-10: tools.html is a meta-refresh stub — Historie nav lives on the
  // remaining shell pages (index/settings/history).
  for (const fileName of ['index.html', 'settings.html', 'history.html']) {
    const html = readPublic(fileName);
    assert.match(html, />Historie</);
  }
});

// "tools page exposes separate gap and full VRM backfill controls" was removed
// in Plan 08-10. The backfill helpers (`buildHistoryGapBackfillRequest`,
// `buildHistoryFullBackfillRequest`, etc.) are still exercised by
// `tools-history-backfill.test.js` against the underlying tools.js module,
// which settings.html (System tab) loads.

test('history page exposes view switcher, unified summary card, chart containers, and grouped rows mount', () => {
  const html = readPublic('history.html');

  assert.match(html, /id="historyView"/);
  assert.match(html, /id="historyDate"/);
  assert.match(html, /id="historyPrevBtn"/);
  assert.match(html, /id="historyNextBtn"/);
  assert.doesNotMatch(html, /id="historyOpportunityBlend"/);
  assert.doesNotMatch(html, /id="historyOpportunityLabel"/);
  assert.match(html, /id="historyBackfillBtn"/);
  assert.doesNotMatch(html, /id="historyKpiGrid"/);
  assert.match(html, /id="historyChartGrid"/);
  assert.match(html, /id="historyFinancialPanel"/);
  assert.match(html, /id="historyEnergyPanel"/);
  assert.match(html, /id="historyPricePanel"/);
  assert.match(html, /Energiekosten/);
  assert.match(html, /Gesamtbilanz/);
  assert.match(html, /id="historyKpiPv"/);
  assert.match(html, /id="historyKpiVbh"/);
  assert.match(html, /Vermiedene Kosten/);
  assert.match(html, /id="historyKpiAvoided"/);
  assert.match(html, /id="historyKpiAvoidedPvGross"/);
  assert.match(html, /id="historyKpiAvoidedBatteryGross"/);
  assert.match(html, /id="historyKpiAvoidedPvCost"/);
  assert.match(html, /id="historyKpiAvoidedBatteryCost"/);
  assert.match(html, /id="historyKpiGrossReturn"/);
  // Plan 16-04 (D-06 triage, UI-drift): the standalone #historyPremiumFields
  // sub-card was merged into #historyDvCard as the leftmost column
  // (#historyDvPremiumSection) — see the history.html comment at ~L303.
  assert.match(html, /id="historyDvPremiumSection"/);
  assert.match(html, /id="historyPremiumHint"/);
  assert.match(html, /id="historyPremiumRateLabel"/);
  assert.match(html, /id="historyKpiMarketPremiumRate"/);
  assert.match(html, /id="historyFinancialChart"/);
  assert.match(html, /id="historyEnergyChart"/);
  assert.match(html, /id="historyPriceChart"/);
  assert.match(html, /id="historySolarSummary"/);
  assert.match(html, /id="historyPriceList"/);
  assert.match(html, /id="historyAggregatePriceHint"/);
  assert.match(html, /id="historyAggregateMode"/);
  assert.match(html, /id="historyAggregateOverviewBtn"/);
  assert.match(html, /id="historyAggregateTableBtn"/);
  // Plan 16-04 (D-06 triage, UI-drift): the pre-Aurora #historyDetailsToggle /
  // #historyDetailsContent disclosure was removed by the Phase-09.3 redesign —
  // the surviving disclosure is the status-info toggle below.
  assert.match(html, /id="historyStatusInfoToggle"/);
  assert.match(html, /id="historyStatusInfo"/);
  // Plan 16-04 (D-06 triage, UI-drift): the Phase-09.3 Aurora history page
  // replaced the standalone #historyRows grouped-rows table with the viz-card
  // sections (data-viz-card) + the aggregate table mode. Assert a viz card and
  // the aggregate-table affordance instead of the removed #historyRows mount.
  assert.match(html, /data-viz-card="sankey"/);
  assert.match(html, /id="historyAggregateTableBtn"/);
});

test('history shell styles define dedicated layout classes', () => {
  // Plan 16-04 (D-06 triage, UI-drift): the Phase-09.3 Aurora redesign split
  // the monolithic styles.css into the per-page history.css and reworked the
  // summary chrome. Rebuilt as targeted assertions on the layout primitives
  // that actually ship in history.css today (chart grid, aggregate mode, the
  // summary/data tables, the rows container).
  const css = readPublic('history.css');

  assert.match(css, /\.history-chart-grid\s*\{/);
  assert.match(css, /\.history-aggregate-mode\s*\{/);
  assert.match(css, /\.history-aggregate-mode-btn\s*\{/);
  assert.match(css, /\.history-summary-table[^{]*\{/);
  assert.match(css, /\.history-aggregate-trend\s*\{/);
  assert.match(css, /\.history-aggregate-breakdown-table\s*\{/);
  assert.match(css, /\.history-rows\s*\{/);
  assert.match(css, /\.history-data-table[^{]*\{/);
});

// Plan 16-04 (D-06 triage, brittle test): the 12 history-page rendering tests
// (originally lines 252-954) were full-render snapshot tests coupled to the
// PRE-AURORA history.js element-id contract. The Phase-09.3 Aurora redesign
// rebuilt the history page wholesale: KPIs were consolidated (e.g. the standalone
// `historyKpiImport` is gone — import cost folds into `historyKpiCost`), the
// `#historyPremiumFields` sub-card merged into `#historyDvCard`, the
// `#historyRows` grouped-rows table was replaced by viz cards + the aggregate
// table, and `renderSummary` became `renderKpis`+`renderLayout`+`renderCharts`.
//
// Per D-05: the brittle full-render snapshots are pruned and REBUILT into
// targeted assertions on the behaviour that actually survived — renderSummary
// populates the surviving Aurora KPI elements from the summary payload, drives
// the chart canvases, renders the aggregate table, and never throws. These
// assertions are pinned to `services/optimizer`-independent, view-stable
// element ids that exist in the shipped Aurora history.html.

test('history renderSummary populates the core finance KPIs from a day payload', () => {
  const { helpers, elements } = loadHistoryPageHelpers();

  helpers.renderSummary({
    view: 'day',
    date: '2026-03-09',
    kpis: {
      importCostEur: 1.23,
      gridCostEur: 1.23,
      pvCostEur: 0.32,
      batteryCostEur: 0.11,
      avoidedImportGrossEur: 2.91,
      avoidedImportPvGrossEur: 1.95,
      avoidedImportBatteryGrossEur: 0.96,
      exportRevenueEur: 0.45,
      netEur: -0.78,
      pvKwh: 5.3,
      loadKwh: 8.2,
      exportKwh: 1.25,
      pvFullLoadHours: 0.18
    },
    rows: [],
    app: { versionLabel: 'v0.3.0+ea104c9' },
    meta: {}
  });

  // Finance core card — the surviving Aurora KPI ids.
  assert.match(elements.get('historyKpiCost').textContent, /1,23/);
  assert.match(elements.get('historyKpiRevenue').textContent, /0,45/);
  assert.match(elements.get('historyKpiNet').textContent, /0,78/);
  assert.match(elements.get('historyKpiCashIn').textContent, /0,45/);
  assert.match(elements.get('historyKpiCashOut').textContent, /1,23/);
  // Avoided-cost breakdown.
  assert.match(elements.get('historyKpiAvoided').textContent, /2,91/);
  assert.match(elements.get('historyKpiAvoidedPvGross').textContent, /1,95/);
  assert.match(elements.get('historyKpiAvoidedBatteryGross').textContent, /0,96/);
  assert.match(elements.get('historyKpiAvoidedPvCost').textContent, /0,32/);
  assert.match(elements.get('historyKpiAvoidedBatteryCost').textContent, /0,11/);
  // Energy KPIs.
  assert.match(elements.get('historyKpiPv').textContent, /5,30/);
  assert.match(elements.get('historyKpiConsumption').textContent, /8,20/);
  assert.match(elements.get('historyKpiExport').textContent, /1,25/);
  assert.match(elements.get('historyKpiVbh').textContent, /0,18/);
  // The version label is surfaced in the meta line.
  assert.match(elements.get('historyMeta').textContent, /v0\.3\.0\+ea104c9/);
});

test('history renderSummary tolerates an empty payload without throwing', () => {
  const { helpers, elements } = loadHistoryPageHelpers();

  assert.doesNotThrow(() => helpers.renderSummary({
    view: 'day',
    date: '2026-03-09',
    kpis: {},
    rows: [],
    meta: {}
  }), 'renderSummary must not throw on an empty kpis payload');

  // Missing values degrade to the placeholder dash, not undefined / NaN.
  const cost = elements.get('historyKpiCost').textContent;
  assert.ok(typeof cost === 'string' && !/NaN|undefined/.test(cost),
    `historyKpiCost must be a clean string, got: ${cost}`);
});

test('history renderSummary mounts the chart canvases from chart payloads', () => {
  const { helpers, elements } = loadHistoryPageHelpers();

  helpers.renderSummary({
    view: 'day',
    date: '2026-03-09',
    kpis: { importCostEur: 0.3, exportRevenueEur: 0.04, netEur: -0.26, pvKwh: 0.9, loadKwh: 1.2, exportKwh: 0.5 },
    rows: [],
    charts: {
      dayEnergyLines: [
        { label: '11:00', importKwh: 1, exportKwh: 0, loadKwh: 1.2, pvKwh: 0.3, estimated: false, incomplete: false },
        { label: '11:15', importKwh: 0, exportKwh: 0.5, loadKwh: 0, pvKwh: 0.6, estimated: true, incomplete: true }
      ],
      dayFinancialLines: [
        { label: '11:00', gridCostEur: 0.3, pvCostEur: 0.01, netEur: -0.31, estimated: false, incomplete: false },
        { label: '11:15', gridCostEur: 0, pvCostEur: 0, netEur: 0.04, estimated: true, incomplete: true }
      ],
      dayPriceLines: [
        { label: '11:00', marketPriceCtKwh: 5, userImportPriceCtKwh: 30, estimated: false, incomplete: false },
        { label: '11:15', marketPriceCtKwh: 8, userImportPriceCtKwh: 30, estimated: true, incomplete: true }
      ]
    },
    meta: { unresolved: { incompleteSlots: 1, estimatedSlots: 1 } }
  });

  // Each day chart panel mounts a <canvas> for the Chart.js instance.
  assert.match(elements.get('historyFinancialChart').innerHTML, /canvas/);
  assert.match(elements.get('historyEnergyChart').innerHTML, /canvas/);
  assert.match(elements.get('historyPriceChart').innerHTML, /canvas/);
});

test('history renderSummary renders the aggregate table for a year view', () => {
  const { helpers, elements } = loadHistoryPageHelpers();
  elements.get('historyView').value = 'year';

  assert.doesNotThrow(() => helpers.renderSummary({
    view: 'year',
    date: '2026',
    kpis: { importCostEur: 120, exportRevenueEur: 60, netEur: -60, pvKwh: 5300, loadKwh: 8200, exportKwh: 1250 },
    rows: [
      { label: 'Januar', importKwh: 450, loadKwh: 800, pvKwh: 300, exportKwh: 120, netEur: -8 },
      { label: 'Februar', importKwh: 410, loadKwh: 760, pvKwh: 360, exportKwh: 140, netEur: -6 }
    ],
    meta: {}
  }), 'renderSummary must not throw on a year aggregate payload');

  // The yearly aggregate table renders the month rows from summary.rows.
  helpers.renderRows({ view: 'year', rows: [
    { label: 'Januar', importKwh: 450, loadKwh: 800, pvKwh: 300, exportKwh: 120, netEur: -8 }
  ] });
  const rowsHtml = elements.get('historyRows').innerHTML;
  assert.match(rowsHtml, /history-data-table/);
  assert.match(rowsHtml, /Januar/);
});

test('history page toggles the backfill button label and disabled state while loading', () => {
  const { helpers, elements } = loadHistoryPageHelpers();

  helpers.historyState.backfillBusy = true;
  helpers.renderBackfillButtonState();
  assert.equal(elements.get('historyBackfillBtn').disabled, true);
  assert.match(elements.get('historyBackfillBtn').textContent, /geladen/i);

  helpers.historyState.backfillBusy = false;
  helpers.renderBackfillButtonState();
  assert.equal(elements.get('historyBackfillBtn').disabled, false);
  assert.match(elements.get('historyBackfillBtn').textContent, /nachladen/i);
});
