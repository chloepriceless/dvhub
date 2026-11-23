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

// 21.10.2026: .calc-row-line setzt display:flex und schlug damit das
// hidden-Attribut — „Förderverlängerung (§51a)“ stand auf Prod sichtbar mit „-“,
// obwohl history.js sie versteckt. Jede Zeile mit hidden muss verschwinden.
test('history.css: versteckte Rechenzeilen (.calc-row-line[hidden]) bleiben unsichtbar', () => {
  const css = readPublic('history.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /\.calc-row-line\[hidden\]\s*\{[^}]*display\s*:\s*none/);
  const html = readPublic('history.html');
  assert.match(html, /class="calc-row-line" id="historyKpiEegExtensionRow" hidden/);
});

// Zweite GX-Anlage am selben Anschluss (Chrissi 21.10.2026: „kannst die Akkus
// dort getrennt aufzeigen“). Akku 2 erscheint als eigene Zeile, eigenes
// Segment, eigener Sankey-Knoten und eigene Tabellenspalten — aber nur, wenn
// es Werte gibt. Ohne zweite Anlage bleibt die Seite wie sie war.
const SECOND_KPIS = {
  pvKwh: 10, loadKwh: 8, exportKwh: 3,
  pvShareKwh: 3, batteryShareKwh: 2, secondBatteryShareKwh: 1.5, gridShareKwh: 1.5,
  solarToGridKwh: 1.5, batteryToGridKwh: 1, secondBatteryToGridKwh: 0.5
};

test('Energiebilanz: Akku 2 als eigene davon-Zeile, Akku-Summen enthalten ihn', () => {
  const { helpers, elements } = loadHistoryPageHelpers();
  helpers.renderSummary({ view: 'day', date: '2026-03-09', kpis: SECOND_KPIS, rows: [], meta: {} });
  assert.match(elements.get('historyKpiConsBattery').textContent, /3,50/);
  assert.match(elements.get('historyKpiConsBattery2').textContent, /1,50/);
  assert.equal(elements.get('historyKpiConsBattery2Row').hidden, false);
  assert.match(elements.get('historyKpiExportBattery').textContent, /1,50/);
  assert.match(elements.get('historyKpiExportBattery2').textContent, /0,50/);
  assert.equal(elements.get('historyKpiExportBattery2Row').hidden, false);
});

test('Energiebilanz ohne zweite Anlage: Akku-2-Zeilen versteckt, Werte wie bisher', () => {
  const { helpers, elements } = loadHistoryPageHelpers();
  const kpis = { ...SECOND_KPIS, secondBatteryShareKwh: 0, secondBatteryToGridKwh: 0 };
  helpers.renderSummary({ view: 'day', date: '2026-03-09', kpis, rows: [], meta: {} });
  assert.match(elements.get('historyKpiConsBattery').textContent, /2,00/);
  assert.match(elements.get('historyKpiExportBattery').textContent, /1,00/);
  assert.equal(elements.get('historyKpiConsBattery2Row').hidden, true);
  assert.equal(elements.get('historyKpiExportBattery2Row').hidden, true);
});

test('Tagesfluesse und Sankey: Akku 2 nur mit Werten', () => {
  const { helpers } = loadHistoryPageHelpers();
  const items = [
    { solarDirectUseKwh: 1, solarToBatteryKwh: 0.5, solarToGridKwh: 0.2, batteryDirectUseKwh: 0.3, gridDirectUseKwh: 0.1,
      secondSolarToBatteryKwh: 0.4, secondBatteryDirectUseKwh: 0.2, secondBatteryToGridKwh: 0.1, secondGridToBatteryKwh: 0.05 }
  ];
  const labels = helpers.dayFlowDatasets(items).map((ds) => ds.label);
  for (const l of ['Solar zu Akku 2', 'Akku 2 ins Netz', 'Akku 2 zum Verbrauch', 'Netz zu Akku 2']) assert.ok(labels.includes(l), `${l} fehlt`);
  const plain = items.map((i) => ({ ...i, secondSolarToBatteryKwh: 0, secondBatteryDirectUseKwh: 0, secondBatteryToGridKwh: 0, secondGridToBatteryKwh: 0 }));
  assert.equal(helpers.dayFlowDatasets(plain).length, 7, 'ohne Akku 2: die bisherigen 7 Segmente');
  assert.ok(!helpers.dayFlowDatasets(plain).some((ds) => /Akku 2/.test(ds.label)));

  const edges = helpers.energyFlowSankeyEdges(items);
  assert.ok(edges.some((e) => e.from === 'PV' && e.to === 'Akku2'));
  assert.ok(edges.some((e) => e.from === 'Akku2' && e.to === 'Verbrauch'));
  assert.ok(edges.some((e) => e.from === 'Akku2' && e.to === 'Netz'));
  assert.ok(!helpers.energyFlowSankeyEdges(plain).some((e) => e.from === 'Akku2' || e.to === 'Akku2'));
});

test('Tabelle: Akku-2-Spalten nur, wenn eine Zeile Werte hat', () => {
  const { helpers, elements } = loadHistoryPageHelpers();
  helpers.renderRows({ view: 'week', rows: [
    { label: '2026-03-09', importKwh: 1, loadKwh: 2, secondBatteryDirectUseKwh: 0.4, secondBatteryToGridKwh: 1, secondSolarToBatteryKwh: 0.5 }
  ] });
  assert.match(elements.get('historyRows').innerHTML, /Akku 2 direkt/);
  assert.match(elements.get('historyRows').innerHTML, /Akku 2 → Netz/);
  helpers.renderRows({ view: 'week', rows: [{ label: '2026-03-09', importKwh: 1, loadKwh: 2 }] });
  assert.doesNotMatch(elements.get('historyRows').innerHTML, /Akku 2/);
});

test('Gesamtverlust zieht auch die Ladestandsaenderung von Akku 2 ab (Codex Runde 4)', () => {
  const { helpers, elements } = loadHistoryPageHelpers();
  const kpis = { pvKwh: 20, importKwh: 0, loadKwh: 5, exportKwh: 4, batteryChargeKwh: 0, batteryDischargeKwh: 0,
    batteryStoredDeltaKwh: 0, secondBatteryStoredDeltaKwh: 10 };
  helpers.renderSummary({ view: 'day', date: '2026-03-09', kpis, rows: [], meta: {} });
  // 20 − (5 + 4) − 10 gespeichert in Akku 2 = 1 kWh Verlust
  assert.match(elements.get('historyKpiTotalLoss').textContent, /^1,00/);
});

test('Sankey: Akku→Akku-Verschiebung als Netto-Kante (Codex Runde 4), kein Kreis', () => {
  const { helpers } = loadHistoryPageHelpers();
  const only = helpers.energyFlowSankeyEdges([{ batteryToSecondBatteryKwh: 1 }]);
  assert.equal(JSON.stringify(only.map((e) => [e.from, e.to, e.flow])), JSON.stringify([['Akku', 'Akku2', 1]]));
  const both = helpers.energyFlowSankeyEdges([{ batteryToSecondBatteryKwh: 1 }, { secondBatteryToBatteryKwh: 1.5 }]);
  assert.equal(JSON.stringify(both.map((e) => [e.from, e.to, e.flow])), JSON.stringify([['Akku2', 'Akku', 0.5]]));
});

// Gesamtprüfung 1.0.9 (Hauptbefund 13): Das Protokoll-CSV war ein schlichtes
// <a href download> — ohne Authorization-Kopf. Außerhalb des Heimnetzes oder
// unter lanTrust „restricted“ speicherte der Browser die 401-Antwort als CSV.
// Jetzt lädt die Seite die Datei mit dem Token (apiFetch) und meldet Fehler.
test('Protokoll-CSV „Netzstrom im Akku“ wird mit Token geladen, nicht per schlichtem Link', () => {
  const html = readPublic('history.html');
  const link = /<[^>]*id="historyGridShareCsv"[^>]*>/.exec(html)?.[0] || '';
  assert.ok(link, 'Knopf vorhanden');
  assert.doesNotMatch(link, /\sdownload(\s|>|=)/, 'kein Browser-Download am Token vorbei');
  assert.doesNotMatch(link, /href=/, 'kein direkter Link auf die API');
  const js = readPublic('history.js');
  const fn = js.slice(js.indexOf('async function downloadGridShareProtocol'));
  assert.ok(js.includes('async function downloadGridShareProtocol'), 'Download-Funktion vorhanden');
  assert.match(fn.slice(0, 1500), /apiFetch\('\/api\/battery\/grid-share\/protocol\.csv'\)/);
  assert.match(fn.slice(0, 1500), /response\.ok/);
  assert.match(js, /byId\('historyGridShareCsv'\)[\s\S]{0,200}addEventListener\('click'/);
});

// Christin 23.11.2026: In Woche/Monat/Jahr war die Karte „Netzstrom im Akku“
// mit 31 Protokollzeilen und Erklärtext riesig. Das Protokoll ist jetzt
// ausklappbar: in Woche/Monat/Jahr zu (nur der Verlauf sichtbar), am Tag offen.
test('Netzstrom im Akku: Protokoll ausklappbar, in Woche/Monat/Jahr zu, am Tag offen', () => {
  const html = readPublic('history.html');
  const card = html.slice(html.indexOf('id="historyGridShareCard"'), html.indexOf('id="historyDvCard"'));
  const detailsAt = card.indexOf('id="historyGridShareDetails"');
  assert.ok(detailsAt > 0, 'details vorhanden');
  assert.ok(card.indexOf('id="historyGridShareChart"') < detailsAt, 'Verlauf steht außerhalb, bleibt sichtbar');
  assert.ok(card.indexOf('id="historyGridShareBody"') > detailsAt, 'Protokoll steht im ausklappbaren Teil');
  assert.match(card.slice(detailsAt, card.indexOf('id="historyGridShareBody"')), /<summary/);

  const { helpers, elements } = loadHistoryPageHelpers();
  helpers.applyGridShareDetailsDefault('month');
  const el = elements.get('historyGridShareDetails');
  assert.equal(el.open, false, 'Monat: zu');
  el.open = true; // selbst aufgeklappt
  helpers.applyGridShareDetailsDefault('month'); // Blättern im Monat
  assert.equal(el.open, true, 'eigene Wahl bleibt in derselben Ansicht');
  helpers.applyGridShareDetailsDefault('day');
  assert.equal(el.open, true, 'Tag: offen');
  helpers.applyGridShareDetailsDefault('week');
  assert.equal(el.open, false, 'Woche: zu');
  helpers.applyGridShareDetailsDefault('year');
  assert.equal(el.open, false, 'Jahr: zu');
});

// ── Arbeitspreis-Karte (13.11.2026, Ziel 1.0.11) ──────────────────────────
// Ø Arbeitspreis und Festpreis-Vergleich; die Zahlen rechnet das Backend je
// Slot (history-runtime.js), die Karte zeigt sie nur an.
function tariffKpis(extra = {}) {
  return {
    importKwh: 120, gridCostEur: 33.5, importCostEur: 33.5,
    userImportPriceWeightedCtKwh: 28, userImportPriceWeightKwh: 120, importPricedCostEur: 33.6,
    variableTariffSlotCount: 1628, variableImportKwh: 80, variableImportCtKwh: 26.5,
    variablePriceAvgCtKwh: 29.25, variablePriceSlotCount: 1628,
    fixedCompareSlotCount: 1628, fixedCompareImportKwh: 80,
    fixedCompareActualEur: 21.2, fixedCompareFixedEur: 24, fixedCompareSavingsEur: 2.8, fixedCompareCtKwh: 30,
    fixedCompareSources: [{ ctKwh: 30, source: 'period', periodId: 'alt', label: 'Stadtwerke Fest', importKwh: 80 }],
    ...extra
  };
}

test('Arbeitspreis-Karte: Monat mit Tarifwechsel zeigt Ø, Lastverschiebung und Ersparnis mit Quelle', () => {
  const { helpers, elements } = loadHistoryPageHelpers();
  helpers.renderSummary({ view: 'month', date: '2026-03-10', kpis: tariffKpis(), rows: [], meta: {} });
  assert.equal(elements.get('historyTariffCard').hidden, false);
  assert.match(elements.get('historyTariffAvg').textContent, /28,00 ct\/kWh/);
  assert.match(elements.get('historyTariffImportKwh').textContent, /120,00 kWh/);
  assert.match(elements.get('historyTariffImportCost').textContent, /33,60 €/);
  assert.match(elements.get('historyTariffDynAvg').textContent, /26,50 ct\/kWh/);
  assert.match(elements.get('historyTariffDynTimeAvg').textContent, /29,25 ct\/kWh/);
  assert.match(elements.get('historyTariffShift').textContent, /2,75 ct\/kWh günstiger/);
  assert.match(elements.get('historyTariffSavings').textContent, /2,80 € gespart/);
  assert.match(elements.get('historyTariffCompareText').textContent,
    /Mit Festpreis 30,00 ct\/kWh hätte der Netzbezug \(80,00 kWh\) 24,00 € gekostet → 2,80 € gespart\./);
  assert.match(elements.get('historyTariffSource').textContent, /Festpreis 30,00 ct\/kWh aus Zeitraum ‚Stadtwerke Fest‘/);
  assert.equal(elements.get('historyTariffSource').hidden, false);
  assert.equal(elements.get('historyTariffTableWrap').hidden, true, 'Monatsansicht ohne Monatstabelle');
});

test('Arbeitspreis-Karte: Mehrkosten, eigener Vergleichspreis', () => {
  const { helpers, elements } = loadHistoryPageHelpers();
  helpers.renderSummary({
    view: 'week', date: '2026-03-10',
    kpis: tariffKpis({ fixedCompareSavingsEur: -1.5, fixedCompareFixedEur: 19.7,
      fixedCompareSources: [{ ctKwh: 24.63, source: 'configured', periodId: null, label: null, importKwh: 80 }] }),
    rows: [], meta: {}
  });
  assert.match(elements.get('historyTariffSavings').textContent, /1,50 € mehr bezahlt/);
  assert.match(elements.get('historyTariffCompareText').textContent, /→ 1,50 € mehr bezahlt\./);
  assert.match(elements.get('historyTariffSource').textContent, /eigener Wert aus den Einstellungen/);
});

test('Arbeitspreis-Karte: nur Festtarif → kein Vergleich; Tag → Karte aus', () => {
  const { helpers, elements } = loadHistoryPageHelpers();
  helpers.renderSummary({
    view: 'month', date: '2026-02-10',
    kpis: tariffKpis({ variableTariffSlotCount: 0, variableImportKwh: 0, variableImportCtKwh: null, variablePriceAvgCtKwh: null,
      fixedCompareSlotCount: 0, fixedCompareImportKwh: 0, fixedCompareActualEur: null, fixedCompareFixedEur: null,
      fixedCompareSavingsEur: null, fixedCompareCtKwh: null, fixedCompareSources: [] }),
    rows: [], meta: {}
  });
  assert.equal(elements.get('historyTariffCard').hidden, false);
  assert.equal(elements.get('historyTariffSavings').textContent, 'Festtarif');
  assert.equal(elements.get('historyTariffDynAvg').textContent, 'Festtarif');
  assert.match(elements.get('historyTariffCompareText').textContent, /nur ein Festtarif/);
  assert.equal(elements.get('historyTariffSource').hidden, true);

  helpers.renderSummary({ view: 'day', date: '2026-02-10', kpis: tariffKpis(), rows: [], meta: {} });
  assert.equal(elements.get('historyTariffCard').hidden, true);
});

test('Arbeitspreis-Karte: variabler Tarif ohne Vergleichspreis sagt, wo er einzutragen ist', () => {
  const { helpers, elements } = loadHistoryPageHelpers();
  helpers.renderSummary({
    view: 'month', date: '2026-03-10',
    kpis: tariffKpis({ fixedCompareSlotCount: 0, fixedCompareImportKwh: 0, fixedCompareActualEur: null,
      fixedCompareFixedEur: null, fixedCompareSavingsEur: null, fixedCompareCtKwh: null, fixedCompareSources: [] }),
    rows: [], meta: {}
  });
  assert.equal(elements.get('historyTariffSavings').textContent, '-');
  assert.match(elements.get('historyTariffCompareText').textContent, /Einstellungen/);
});

test('Arbeitspreis-Karte: Jahresansicht mit Monatstabelle und Jahreszeile', () => {
  const { helpers, elements } = loadHistoryPageHelpers();
  const fixedMonth = { key: '2026-02', label: '2026-02', importKwh: 50, userImportPriceWeightedCtKwh: 30,
    variableTariffSlotCount: 0, variablePriceAvgCtKwh: null, fixedCompareSavingsEur: null, fixedCompareFixedEur: null };
  const dynMonth = { key: '2026-03', label: '2026-03', importKwh: 70, userImportPriceWeightedCtKwh: 27.2,
    variableTariffSlotCount: 1628, variablePriceAvgCtKwh: 29.25, fixedCompareSavingsEur: 2.8, fixedCompareFixedEur: 24 };
  const lossMonth = { key: '2026-04', label: '2026-04', importKwh: 0, userImportPriceWeightedCtKwh: null,
    variableTariffSlotCount: 2880, variablePriceAvgCtKwh: 27, fixedCompareSavingsEur: -0.4, fixedCompareFixedEur: 0 };
  helpers.renderSummary({ view: 'year', date: '2026-03-10', kpis: tariffKpis(), rows: [fixedMonth, dynMonth, lossMonth], meta: {} });
  assert.equal(elements.get('historyTariffTableWrap').hidden, false);
  const html = elements.get('historyTariffTable').innerHTML;
  assert.match(html, /<td>Feb<\/td>/);
  assert.match(html, /<td>Mär<\/td>/);
  assert.match(html, /Festtarif/, 'Monat im Festtarif ohne Ersparnis');
  assert.match(html, /2,80 €/);
  assert.match(html, /tariff-loss[^>]*>-0,40 €/);
  assert.match(html, /<tfoot>[\s\S]*Jahr[\s\S]*28,00 ct\/kWh[\s\S]*2,80 €/);
  assert.match(elements.get('historyTariffTableLabel').textContent, /Monate/);
});

test('Arbeitspreis-Karte: fehlende Börsenpreise werden als solche benannt (Codex ec0c105c)', () => {
  const { helpers, elements } = loadHistoryPageHelpers();
  helpers.renderSummary({
    view: 'month', date: '2026-05-10',
    kpis: tariffKpis({ variableTariffSlotCount: 2976, variablePriceSlotCount: 0, variableImportKwh: 0, variableImportCtKwh: null,
      variablePriceAvgCtKwh: null, userImportPriceWeightKwh: 0, userImportPriceWeightedCtKwh: null, importPricedCostEur: 0,
      fixedCompareSlotCount: 0, fixedCompareImportKwh: 0, fixedCompareActualEur: null, fixedCompareFixedEur: null,
      fixedCompareSavingsEur: null, fixedCompareCtKwh: null, fixedCompareSources: [] }),
    rows: [], meta: { unresolved: { slotCount: 2976 } }
  });
  const text = elements.get('historyTariffCompareText').textContent;
  assert.match(text, /Börsenpreise fehlen/);
  assert.doesNotMatch(text, /Vergleichs-Festpreis eintragen/);
  assert.equal(elements.get('historyTariffDynHint').hidden, false);
  assert.doesNotMatch(elements.get('historyTariffDynHint').textContent, /Festtarif/, 'kein Tarifwechsel im Zeitraum');
  assert.match(elements.get('historyTariffDynHint').textContent, /2\.976 Viertelstunden ohne Preis/);
  assert.match(elements.get('historyTariffImportKwh').textContent, /davon 0,00 kWh mit Preis/);
});

test('Arbeitspreis-Karte: Tarifwechsel-Hinweis hängt an den Viertelstunden, Bezugskosten am Ø (Codex ec0c105c)', () => {
  const { helpers, elements } = loadHistoryPageHelpers();
  helpers.renderSummary({ view: 'month', date: '2026-03-10', kpis: tariffKpis(), rows: [], meta: { unresolved: { slotCount: 2972 } } });
  assert.match(elements.get('historyTariffDynHint').textContent, /auch ein Festtarif/);
  assert.match(elements.get('historyTariffImportCost').textContent, /33,60 €/, 'Zähler des Ø, nicht die je Slot gerundete Summe');
  assert.equal(elements.get('historyTariffImportKwh').textContent, '120,00 kWh', 'alles bepreist: keine Zusatzangabe');
  // Ganz dynamisch, alle Viertelstunden bepreist, aber weniger Bezug-kWh im dyn. Teil: kein Festtarif-Hinweis.
  helpers.renderSummary({ view: 'month', date: '2026-05-10', kpis: tariffKpis({ variableTariffSlotCount: 2976, variablePriceSlotCount: 2976 }),
    rows: [], meta: { unresolved: { slotCount: 2976 } } });
  assert.equal(elements.get('historyTariffDynHint').hidden, true);
});

// ── Dynamischer Tarif (Christin 23.11.2026) ─────────────────────────────────
// Werte wie aus history-tariff.js (kpis.tariff); die Seite zeigt sie nur an.
function dynTariff(extra = {}) {
  return {
    excludeEstimated: false, variableSlots: 1628, unpricedSlots: 0, pricedSlots: 1628,
    estimatedSlots: 96, estimatedImportKwh: 8, estimatedSharePct: 10,
    importKwh: 80, importCostEur: 20.4, avgImportCtKwh: 25.5, avgSlotCtKwh: 29.25,
    avgSpotWeightedCtKwh: 6.1, avgMarkupCtKwh: 19.4,
    house: { importKwh: 60, avgCtKwh: 27 }, battery: { importKwh: 20, avgCtKwh: 21 },
    fixedCompare: { slots: 1628, importKwh: 80, ctKwh: 30, actualEur: 20.4, fixedEur: 24, savingsEur: 3.6 },
    baseFee: { eur: 21.52, days: 31, missingDays: 0, variableEur: 17, variableDays: 17, variableMissingDays: 0 },
    variableCostWithFeeEur: 37.4, allImportKwh: 120, allImportCostEur: 32.4, allCostWithFeeEur: 53.92,
    fixedCompareWithFee: { days: 17, feeFixedEur: 5.48, feeActualEur: 17, fixedEur: 29.48, actualEur: 37.4, savingsEur: -7.92 },
    compareFeeMissingDays: 0,
    validFrom: { date: '2026-03-15', source: 'fixed_period' },
    fits: [{
      key: 'base|std', tariffKey: 'base', tariffLabel: 'Standard-Tarif', mode: 'dynamic', windowId: null, windowLabel: null,
      vatPct: 19, n: 1600, importKwh: 78, avgMarkupCtKwh: 15.4, markupMinCtKwh: 14.28, markupMaxCtKwh: 19.98,
      fit: { gross: { interceptCtKwh: 14.28, slope: 1.19 }, net: { interceptCtKwh: 12, slope: 1 }, markupPctGross: 19, markupPctNet: 0, r2: 1 },
      atP10: { spotCtKwh: 1, markupCtKwh: 14.47 }, atP90: { spotCtKwh: 29, markupCtKwh: 19.79 },
      negative: { n: 28, importKwh: 2, avgMarkupCtKwh: 13.1, markupMinCtKwh: 12, markupMaxCtKwh: 14, fit: null }
    }],
    overallFit: null, spotP10CtKwh: 1, spotP90CtKwh: 29,
    selfUse: {
      exportValueBasis: 'spot', slots: 2976, skippedNoPriceSlots: 0, skippedNoFlowSlots: 4,
      loadKwh: 300, loadCostAtPriceEur: 81, loadAvgCtKwh: 27, gridImportKwh: 120, gridCostEur: 32.4,
      pvDirectKwh: 150, pvDirectGainEur: 30, pvDirectGainCtKwh: 20,
      battery: { chargedPvKwh: 40, chargedGridKwh: 20, dischargedHouseKwh: 50, dischargedGridKwh: 4, chargeCostEur: 6.2,
        dischargeValueEur: 14.1, inCtKwh: 11.48, outCtKwh: 26.11, etaPct: 90, storedDeltaKwh: 0, socCorrectionEur: 0, resultEur: 7.9 },
      exportKwh: 30, exportValueEur: 1.8, advantageEur: 37.9, peffCtKwh: 14.37, peffWithoutOpportunityCtKwh: 10.8
    },
    ...extra
  };
}

test('Dynamischer Tarif: Börse, Aufschlag, Grundgebühr, Vergleich mit Gebühr, geschätzte Preise, Formel', () => {
  const { helpers, elements } = loadHistoryPageHelpers();
  helpers.renderSummary({ view: 'month', date: '2026-03-10', kpis: tariffKpis({ tariff: dynTariff(), marketPremiumEur: 4.2 }), rows: [], meta: {} });
  assert.equal(elements.get('historyTariffExtras').hidden, false);
  // kpis.tariff hat Vorrang vor den Feldern aus feat/arbeitspreis-vergleich (Schalter T3).
  assert.match(elements.get('historyTariffDynAvg').textContent, /25,50 ct\/kWh/);
  assert.match(elements.get('historyTariffSavings').textContent, /3,60 € gespart/);
  assert.match(elements.get('historyTariffSpotAvg').textContent, /6,10 ct\/kWh/);
  assert.match(elements.get('historyTariffMarkup').textContent, /19,40 ct\/kWh/);
  assert.match(elements.get('historyTariffHouseBatt').textContent, /Haus 27,00 ct\/kWh · Akku 21,00 ct\/kWh/);
  assert.match(elements.get('historyTariffFee').textContent, /21,52 € \(31 Tage\)/);
  assert.match(elements.get('historyTariffCostWithFee').textContent, /53,92 €/);
  assert.match(elements.get('historyTariffDynCostWithFee').textContent, /37,40 €/);
  assert.match(elements.get('historyTariffCompareFee').textContent, /7,92 € mehr bezahlt \(Festpreis 29,48 € gegen 37,40 €\)/);
  assert.equal(elements.get('historyTariffEstimatedRow').hidden, false);
  assert.match(elements.get('historyTariffEstimated').textContent, /96 Viertelstunden mit geschätztem Anbieterpreis \(8,00 kWh, 10,0 % des Bezugs\) – mitgezählt/);
  assert.equal(elements.get('historyTariffEstimatedToggle').checked, true);
  assert.match(elements.get('historyTariffValidFrom').textContent, /zählt ab 15\.03\.2026: Tag nach dem letzten Festpreis-Zeitraum/);
  const formula = elements.get('historyTariffFormula').innerHTML;
  assert.match(formula, /Endpreis ≈ 14,28 ct\/kWh \+ 1,190 × Börse/);
  assert.match(formula, /\+19,0 % auf die Börse \(ohne MwSt \+0,0 %\)/);
  assert.match(formula, /bei Börse 1,00 ct\/kWh: \+14,47 ct\/kWh · bei 29,00 ct\/kWh: \+19,79 ct\/kWh/);
  assert.match(formula, /Negative Börse: 28 Viertelstunden/);
  assert.equal(elements.get('historyTariffFormulaWrap').hidden, false);
  assert.equal(elements.get('historyTariffMonthWrap').hidden, true, 'Monat ohne Monatsvergleich');
});

test('Dynamischer Tarif: ohne geschätzte gezählt, fehlende Vergleichs-Grundgebühr wird benannt', () => {
  const { helpers, elements } = loadHistoryPageHelpers();
  helpers.renderSummary({
    view: 'month', date: '2026-03-10',
    kpis: tariffKpis({ tariff: dynTariff({ excludeEstimated: true, fixedCompareWithFee: null, compareFeeMissingDays: 17 }) }),
    rows: [], meta: {}
  });
  assert.match(elements.get('historyTariffEstimated').textContent, /– nicht mitgezählt/);
  assert.equal(elements.get('historyTariffEstimatedToggle').checked, false);
  assert.match(elements.get('historyTariffCompareFee').textContent, /Grundgebühr des Festpreis-Tarifs fehlt/);
});

test('Dynamischer Tarif: „gilt ab“-Hinweis je Quelle', () => {
  const { helpers } = loadHistoryPageHelpers();
  assert.match(helpers.tariffValidFromText({ date: '2026-11-01', source: 'provider_data' }), /ab 01\.11\.2026: erster gespeicherter Anbieterpreis/);
  assert.match(helpers.tariffValidFromText({ date: '2026-03-20', source: 'configured' }), /ab 20\.03\.2026 \(Einstellung „gilt ab“\)/);
  assert.match(helpers.tariffValidFromText({ date: null, source: 'none' }), /ganze Historie/);
  assert.equal(helpers.tariffValidFromText({ date: null, source: null }), '');
});

test('Eigenverbrauch bewertet: zusätzlich zum Schalter „Marktwert“, Marktprämie getrennt', () => {
  const { helpers, elements } = loadHistoryPageHelpers();
  helpers.renderSummary({ view: 'month', date: '2026-03-10', kpis: tariffKpis({ tariff: dynTariff(), marketPremiumEur: 4.2 }), rows: [], meta: {} });
  assert.equal(elements.get('historySelfUseCard').hidden, false);
  assert.match(elements.get('historySelfUsePeff').textContent, /14,37 ct\/kWh/);
  assert.match(elements.get('historySelfUsePeffNoOpp').textContent, /10,80 ct\/kWh/);
  assert.match(elements.get('historySelfUsePvGain').textContent, /30,00 €/);
  assert.match(elements.get('historySelfUseBattResult').textContent, /7,90 €/);
  assert.match(elements.get('historySelfUseBattPrices').textContent, /11,48 ct\/kWh → 26,11 ct\/kWh/);
  assert.match(elements.get('historySelfUseBattEta').textContent, /90,0 %/);
  assert.match(elements.get('historySelfUsePremium').textContent, /4,20 €/);
  assert.match(elements.get('historySelfUseSkipped').textContent, /4 Viertelstunden ohne Flussdaten/);
  // T7: der Schalter „Marktwert“ bleibt.
  assert.match(readPublic('history.html'), /id="historyMarketToggle"/);
  // Tag: Karte aus.
  helpers.renderSummary({ view: 'day', date: '2026-03-10', kpis: tariffKpis({ tariff: dynTariff() }), rows: [], meta: {} });
  assert.equal(elements.get('historySelfUseCard').hidden, true);
});

test('T12: Akku-Wirkungsgrad (DC) benannt, Systemwirkungsgrad (AC) mit Verlusten in kWh und €', () => {
  const { helpers, elements } = loadHistoryPageHelpers();
  assert.match(readPublic('history.html'), /Akku-Wirkungsgrad \(DC\)/);
  const t = dynTariff();
  t.selfUse = { ...t.selfUse, battery: { ...t.selfUse.battery, system: {
    measurable: true, verified: true, label: 'Victron', note: null, reason: null, status: 'ok',
    basis: { days: 23, firstDay: '2026-11-01', lastDay: '2026-11-23', hours: 548.2 },
    dcEtaPct: 93.43, chargeEtaPct: 98.1, dischargeEtaPct: 90.6, chargerEtaPct: 92.4, systemEtaPct: 83.04,
    losses: { dcKwh: 28.7, dcEur: 6.24, chargeKwh: 8.3, chargeEur: 2.4, dischargeKwh: 38.3, dischargeEur: 8.33, totalKwh: 75.3, totalEur: 16.97 },
    energy: { inputKwh: 440.59, chargedKwh: 423.21, dischargedKwh: 420.5, acOutKwh: 366.82, storedDeltaKwh: -6.52 },
    prices: { storedCtKwh: 21.76, chargeCtKwh: 28.9, chargeBasis: 'grid' }, converterLossKwh: 76.2 } } };
  helpers.renderSummary({ view: 'month', date: '2026-11-23', kpis: tariffKpis({ tariff: t }), rows: [], meta: {} });
  assert.equal(elements.get('historySelfUseSystem').hidden, false);
  assert.equal(elements.get('historySelfUseSysUnavailable').hidden, true);
  assert.match(elements.get('historySelfUseSysEta').textContent, /83,0 %/);
  assert.match(elements.get('historySelfUseSysCharge').textContent, /98,1 % \(Lader 92,4 %\)/);
  assert.match(elements.get('historySelfUseSysDc').textContent, /93,4 %/);
  assert.match(elements.get('historySelfUseSysDischarge').textContent, /90,6 %/);
  assert.match(elements.get('historySelfUseSysLossTotal').textContent, /75,30 kWh · 16,97 €/);
  assert.match(elements.get('historySelfUseSysLossCharge').textContent, /8,30 kWh · 2,40 €/);
  assert.match(elements.get('historySelfUseSysPrices').textContent, /Ø Preis der Netzladung \(28,90 ct\/kWh\).*Einstandspreis je geladener kWh \(21,76 ct\/kWh\)/);
  assert.match(elements.get('historySelfUseSysBasis').textContent, /23 Tage \(01\.11\.2026 bis 23\.11\.2026\)/);
  assert.match(elements.get('historySelfUseSysBasis').textContent, /Eingesetzt 440,59 kWh, AC aus dem Akku 366,82 kWh, Ladestand -6,52 kWh/);
  assert.match(elements.get('historySelfUseSysConverter').textContent, /76,20 kWh/);
  assert.equal(elements.get('historySelfUseSysNote').hidden, true, 'Victron geprüft → kein Hinweis');
  assert.equal(elements.get('historySelfUseValuation').hidden, true, 'ohne valuation = ac kein Hinweis');
  assert.doesNotMatch(elements.get('historySelfUseSysLossTotal').textContent, /unvollständig/);
  // Codex 3be47b54: Ladestand fehlte zeitweise → Summe unvollständig benannt.
  t.selfUse.battery.system.losses = { ...t.selfUse.battery.system.losses, complete: false, dcCoveragePct: 62.5 };
  helpers.renderSummary({ view: 'month', date: '2026-11-23', kpis: tariffKpis({ tariff: t }), rows: [], meta: {} });
  assert.match(elements.get('historySelfUseSysLossTotal').textContent, /16,97 € \(unvollständig\)/);
  assert.match(elements.get('historySelfUseSysPrices').textContent, /Akku \(DC\) nur über 62,5 % der Messzeit/);
  // Nicht messbar: Grund statt Zahl.
  t.selfUse.battery.system = { measurable: false, status: 'not_measurable', reason: 'nicht messbar bei Fronius: PV ist AC' };
  helpers.renderSummary({ view: 'month', date: '2026-11-23', kpis: tariffKpis({ tariff: t }), rows: [], meta: {} });
  assert.equal(elements.get('historySelfUseSystem').hidden, true);
  assert.equal(elements.get('historySelfUseSysUnavailable').hidden, false);
  assert.match(elements.get('historySelfUseSysUnavailable').textContent, /Systemwirkungsgrad \(AC\): nicht messbar bei Fronius/);
  // Ohne Tagesjob (kein system-Feld): gar nichts.
  helpers.renderSummary({ view: 'month', date: '2026-11-23', kpis: tariffKpis({ tariff: dynTariff() }), rows: [], meta: {} });
  assert.equal(elements.get('historySelfUseSystem').hidden, true);
  assert.equal(elements.get('historySelfUseSysUnavailable').hidden, true);
});

test('T13 B: Karte nennt die Bewertung mit Wandlung und den Vergleich ohne', () => {
  const { helpers, elements } = loadHistoryPageHelpers();
  const t = dynTariff();
  t.selfUse = { ...t.selfUse, valuation: 'ac',
    battery: { ...t.selfUse.battery, acBasis: { dischargeEtaPct: 87.38, chargerEtaPct: 91.4 } },
    flowsValuation: { loadKwh: 1045.68, advantageEur: 148.55, batteryResultEur: 92.05, peffCtKwh: 29.38, peffWithoutOpportunityCtKwh: 18.43 } };
  helpers.renderSummary({ view: 'month', date: '2026-11-23', kpis: tariffKpis({ tariff: t }), rows: [], meta: {} });
  assert.equal(elements.get('historySelfUseValuation').hidden, false);
  assert.match(elements.get('historySelfUseValuation').textContent,
    /Mit Wandlung bewertet: Entladung × 87,4 %, Netzladung ÷ 91,4 %, Hausverbrauch gemessen\. Ohne Wandlung \(aus den Flüssen\) wären es Akku-Ergebnis 92,05 €, Vorteil 148,55 €, effektiver Preis 29,38 ct\/kWh bei 1\.045,68 kWh\./);
  t.selfUse.valuation = 'flows';
  helpers.renderSummary({ view: 'month', date: '2026-11-23', kpis: tariffKpis({ tariff: t }), rows: [], meta: {} });
  assert.equal(elements.get('historySelfUseValuation').hidden, true);
});

test('Monate im Vergleich: Jahr mit Monatszeilen zeigt den Chart, Festtarif-Monate grau', () => {
  const { helpers, elements } = loadHistoryPageHelpers();
  const fixedMonth = { key: '2026-02', variableSlots: 0, allImportKwh: 50, allImportCostEur: 15, importKwh: 0 };
  const dynMonth = { key: '2026-03', ...dynTariff() };
  helpers.renderSummary({ view: 'year', date: '2026-03-10', kpis: tariffKpis({ tariff: dynTariff() }), rows: [], tariffMonthRows: [fixedMonth, dynMonth], meta: {} });
  assert.equal(elements.get('historyTariffMonthWrap').hidden, false);
  assert.match(elements.get('historyTariffMonthChart').innerHTML, /historyTariffMonthChartCanvas/);
  assert.equal(helpers.historyState.tariffMonthMode, 'qty');
});

test('Streudiagramm: Punkte (Woche/Monat) oder Klassen mit Spanne (Jahr/Alle), Formel-Linie und y = x', () => {
  const { helpers } = loadHistoryPageHelpers();
  const fits = [{ tariffLabel: 'Standard-Tarif', windowLabel: null, fit: { gross: { interceptCtKwh: 14.28, slope: 1.19 } } }];
  const withPoints = helpers.tariffScatterDatasets({ points: [[0, 14.28, 1, 0], [10, 26.18, 0.1, 0], [-5, 8.33, 0.5, 0], [3, 20, 0.2, 1]], fits });
  const labels = withPoints.map((d) => d.label);
  assert.deepEqual(plain(labels), ['Viertelstunden', 'Börse negativ', 'geschätzt', 'Formel Standard-Tarif', 'ohne Aufschlag (Endpreis = Börse)']);
  // Formel-Linie nur über Börse ≥ 0: von 0 bis zum größten x (10).
  assert.deepEqual(plain(withPoints[3].data.map((p) => p.x)), [0, 10]);
  close(withPoints[3].data[1].y, 26.18);
  const withBins = helpers.tariffScatterDatasets({ points: null, bins: [
    { avgSpotCt: 3.5, avgCt: 22, minCt: 20, maxCt: 24, n: 2, importKwh: 4 },
    { avgSpotCt: 12.2, avgCt: 30, minCt: 30, maxCt: 30, n: 1, importKwh: 1 }
  ], fits: [] });
  assert.deepEqual(plain(withBins.map((d) => d.label)), ['Ø je 1 ct Börse', 'Spanne je Klasse', 'ohne Aufschlag (Endpreis = Börse)']);
  // Strich nur bei echter Spanne: (3,5 | 20) bis (3,5 | 24), dann Lücke.
  assert.deepEqual(plain(withBins[1].data), [{ x: 3.5, y: 20 }, { x: 3.5, y: 24 }, { x: null, y: null }]);
  assert.deepEqual(plain(helpers.tariffScatterDatasets({ points: [], bins: [] })), []);
});

// Werte aus dem vm-Kontext haben eigene Prototypen.
function plain(value) { return JSON.parse(JSON.stringify(value)); }

function close(actual, expected, eps = 0.001) {
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} statt ${expected}`);
}

// ── Codex 6c0f6c64 ─────────────────────────────────────────────────────────
test('Codex 6c0f6c64: unbekannte Preise im Eigenverbrauch als „-“, nicht 0 ct', () => {
  const { helpers, elements } = loadHistoryPageHelpers();
  const t = dynTariff();
  t.selfUse = { ...t.selfUse, pvDirectGainCtKwh: null, peffCtKwh: null,
    battery: { ...t.selfUse.battery, inCtKwh: null, outCtKwh: null, etaPct: null, dischargedHouseKwh: 0, dischargedGridKwh: 0 } };
  helpers.renderSummary({ view: 'month', date: '2026-03-10', kpis: tariffKpis({ tariff: t }), rows: [], meta: {} });
  assert.equal(elements.get('historySelfUseBattPrices').textContent, '- → -');
  assert.equal(elements.get('historySelfUsePvRate').textContent, '-');
  assert.equal(elements.get('historySelfUsePeff').textContent, '-');
});

test('Codex 6c0f6c64: negative Börse auch ohne Formel über Börse ≥ 0', () => {
  const { helpers } = loadHistoryPageHelpers();
  const html = helpers.tariffFitHtml({ tariffLabel: 'Standard-Tarif', n: 0, fit: null, avgMarkupCtKwh: null,
    negative: { n: 20, avgMarkupCtKwh: 12.5, fit: null } });
  assert.match(html, /Negative Börse: 20 Viertelstunden, Ø Aufschlag 12,50 ct\/kWh/);
  assert.doesNotMatch(html, /Ø Aufschlag 0,00/);
});

test('Codex 6c0f6c64: fehlende Grundgebühr des dynamischen Tarifs wird als solche benannt', () => {
  const { helpers, elements } = loadHistoryPageHelpers();
  const t = dynTariff({ fixedCompareWithFee: null, compareFeeMissingDays: 3,
    baseFee: { eur: 14, days: 31, missingDays: 3, variableEur: 14, variableDays: 17, variableMissingDays: 3 } });
  helpers.renderSummary({ view: 'month', date: '2026-03-10', kpis: tariffKpis({ tariff: t }), rows: [], meta: {} });
  assert.match(elements.get('historyTariffCompareFee').textContent, /Grundgebühr des dynamischen Tarifs fehlt/);
});

test('Codex 6c0f6c64: Monatskosten mit Grundgebühr auch im Festtarif, unvollständige Gebühr nicht als 0', () => {
  const { helpers } = loadHistoryPageHelpers();
  const rows = [
    { key: '2026-01', variableSlots: 0, allImportCostEur: 20, baseFee: { eur: 15, days: 31, missingDays: 0, variableEur: 0, variableDays: 0, variableMissingDays: 0 } },
    { key: '2026-02', variableSlots: 2688, importCostEur: 20, baseFee: { eur: 15, days: 28, missingDays: 0, variableEur: 15, variableDays: 28, variableMissingDays: 0 } },
    { key: '2026-03', variableSlots: 2976, importCostEur: 22, baseFee: { eur: 5, days: 31, missingDays: 20, variableEur: 5, variableDays: 31, variableMissingDays: 20 } }
  ];
  const sets = JSON.parse(JSON.stringify(helpers.tariffMonthCostDatasets(rows)));
  const byLabel = Object.fromEntries(sets.map((d) => [d.label, d.data]));
  assert.deepEqual(byLabel['Grundgebühr'], [15, 15, null]);
  assert.deepEqual(byLabel['Arbeitspreis'], [null, 20, 22]);
  assert.deepEqual(byLabel['Festtarif'], [20, null, null]);
});

test('Codex 6c0f6c64: Streudiagramm wird bei gleicher Abfrage nicht neu geholt', async () => {
  const { helpers } = loadHistoryPageHelpers();
  const calls = [];
  helpers.setScatterFetch(async (url) => { calls.push(url); return { ok: true, json: async () => ({ points: [], bins: [], fits: [] }) }; });
  const summary = { view: 'month', date: '2026-03-10', kpis: tariffKpis({ tariff: dynTariff() }), rows: [], meta: {} };
  await helpers.loadTariffScatter(summary);
  await helpers.loadTariffScatter(summary);
  assert.equal(calls.length, 1);
  await helpers.loadTariffScatter({ ...summary, date: '2026-04-10' });
  assert.equal(calls.length, 2);
});

// ── Codex 63d6a96f ─────────────────────────────────────────────────────────
function deferredFetch() {
  const calls = [];
  const fetchFn = (url) => new Promise((resolve) => {
    calls.push({ url, resolve: (data) => resolve({ ok: true, json: async () => data }) });
  });
  return { calls, fetchFn };
}

test('Codex 63d6a96f: neu geladene Zusammenfassung holt die Streudaten neu (z. B. nach „Preise nachladen“)', async () => {
  const { helpers } = loadHistoryPageHelpers();
  const calls = [];
  helpers.setScatterFetch(async (url) => { calls.push(url); return { ok: true, json: async () => ({ points: [], bins: [], fits: [] }) }; });
  const summary = { view: 'month', date: '2026-03-10', kpis: tariffKpis({ tariff: dynTariff() }), rows: [], meta: {} };
  await helpers.loadTariffScatter(summary);
  helpers.invalidateTariffScatter();
  await helpers.loadTariffScatter(summary);
  assert.equal(calls.length, 2);
});

test('Codex 63d6a96f: Monat → Tag → Monat während die Anfrage läuft zeigt die Antwort', async () => {
  const { helpers, elements } = loadHistoryPageHelpers();
  const { calls, fetchFn } = deferredFetch();
  helpers.setScatterFetch(fetchFn);
  const month = { view: 'month', date: '2026-03-10', kpis: tariffKpis({ tariff: dynTariff() }), rows: [], meta: {} };
  const first = helpers.loadTariffScatter(month);
  await helpers.loadTariffScatter({ ...month, view: 'day' });
  const again = helpers.loadTariffScatter(month);
  assert.equal(calls.length, 1, 'läuft schon – keine zweite Anfrage');
  calls[0].resolve({ points: [[1, 15, 1, 0], [2, 16, 1, 0]], bins: [], fits: [] });
  await first; await again;
  assert.match(elements.get('historyTariffScatterChart').innerHTML, /historyTariffScatterChartCanvas/);
});

test('Codex 63d6a96f: späte Antwort einer verlassenen Abfrage überschreibt die neue nicht', async () => {
  const { helpers, elements } = loadHistoryPageHelpers();
  const { calls, fetchFn } = deferredFetch();
  helpers.setScatterFetch(fetchFn);
  const march = { view: 'month', date: '2026-03-10', kpis: tariffKpis({ tariff: dynTariff() }), rows: [], meta: {} };
  const a = helpers.loadTariffScatter(march);
  const b = helpers.loadTariffScatter({ ...march, date: '2026-04-10' });
  calls[1].resolve({ points: [], bins: [], fits: [] });
  await b;
  calls[0].resolve({ points: [[1, 15, 1, 0]], bins: [], fits: [] });
  await a;
  assert.match(elements.get('historyTariffScatterChart').innerHTML, /Keine Viertelstunden/);
});

// ── T11: §14a im Festpreis-Vergleich ─────────────────────────────────────────
test('T11: Vergleich nennt §14a-Fenster und was man ohne §14a bezahlt hätte', () => {
  const { helpers, elements } = loadHistoryPageHelpers();
  const t = dynTariff({
    fixedCompare: { slots: 1628, importKwh: 80, ctKwh: 30, ctKwhWithP14a: 26.5, actualEur: 20.4, fixedEur: 21.2, savingsEur: 0.8,
      withoutP14a: { actualEur: 23.2, fixedEur: 24, savingsEur: 0.8 } },
    p14a: { slots: 400, importKwh: 31.46, unknownSlots: 0, savedDynamicEur: 2.8, savedFixedEur: 2.8, avgImportCtKwhWithout: 29 }
  });
  helpers.renderSummary({ view: 'month', date: '2026-03-10', kpis: tariffKpis({ tariff: t }), rows: [], meta: {} });
  assert.equal(elements.get('historyTariffP14aRow').hidden, false);
  assert.match(elements.get('historyTariffP14aSaved').textContent, /dynamisch 2,80 € · Festpreis 2,80 € \(31,46 kWh im Fenster\)/);
  assert.match(elements.get('historyTariffP14aWithout').textContent, /dynamisch 23,20 € · Festpreis 24,00 € → 0,80 € gespart \(nur Arbeitspreis\)/);
  // Steht der Vergleich mit Grundgebühr, dann auch „ohne §14a“ mit Grundgebühr (Codex 3cbbdef3).
  const withFee = dynTariff({ ...t, fixedCompareWithFee: { ...t.fixedCompareWithFee, withoutP14a: { actualEur: 40.2, fixedEur: 29.48, savingsEur: -10.72 } } });
  helpers.renderSummary({ view: 'month', date: '2026-03-10', kpis: tariffKpis({ tariff: withFee }), rows: [], meta: {} });
  assert.match(elements.get('historyTariffP14aWithout').textContent, /dynamisch 40,20 € · Festpreis 29,48 € → 10,72 € mehr bezahlt \(inkl. Grundgebühr\)/);
  assert.match(elements.get('historyTariffP14aHint').textContent, /Festpreis mit denselben §14a-Fenstern: Ø 26,50 ct\/kWh statt 30,00 ct\/kWh/);
});

test('T11: ohne §14a im Zeitraum keine §14a-Zeilen', () => {
  const { helpers, elements } = loadHistoryPageHelpers();
  helpers.renderSummary({ view: 'month', date: '2026-03-10', kpis: tariffKpis({ tariff: dynTariff({ p14a: null }) }), rows: [], meta: {} });
  assert.equal(elements.get('historyTariffP14aRow').hidden, true);
  assert.equal(elements.get('historyTariffP14aWithoutRow').hidden, true);
  assert.equal(elements.get('historyTariffP14aHint').hidden, true);
});
