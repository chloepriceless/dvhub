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

function createElement() {
  return {
    textContent: '',
    innerHTML: '',
    className: '',
    value: '',
    disabled: false,
    hidden: false,
    listeners: new Map(),
    addEventListener(type, handler) {
      this.listeners.set(type, handler);
    }
  };
}

function loadHistoryPageHelpers() {
  const source = readPublic('history.js');
  const ids = [
    'historyBanner',
    'historyMeta',
    'historyKpiCost',
    'historyKpiRevenue',
    'historyKpiNet',
    'historyKpiImport',
    'historyKpiExport',
    'historyFinancialChart',
    'historyEnergyChart',
    'historyPriceChart',
    'historyRows',
    'historyBackfillBtn',
    'historyView',
    'historyDate',
    'historyPrevBtn',
    'historyNextBtn',
    'historyOpportunityBlend',
    'historyOpportunityLabel'
  ];
  const elements = new Map(ids.map((id) => [id, createElement()]));
  elements.get('historyView').value = 'day';
  elements.get('historyDate').value = '2026-03-09';
  const sandbox = {
    console,
    URL,
    globalThis: {},
    window: {
      __DVHUB_HISTORY_TEST__: true,
      DVhubCommon: {}
    },
    document: {
      getElementById(id) {
        return elements.get(id) || null;
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
  for (const fileName of ['index.html', 'settings.html', 'tools.html', 'history.html']) {
    const html = readPublic(fileName);
    assert.match(html, />Historie</);
  }
});

test('history page exposes view switcher, date navigation, KPI blocks, chart containers, and grouped rows mount', () => {
  const html = readPublic('history.html');

  assert.match(html, /id="historyView"/);
  assert.match(html, /id="historyDate"/);
  assert.match(html, /id="historyPrevBtn"/);
  assert.match(html, /id="historyNextBtn"/);
  assert.match(html, /id="historyOpportunityBlend"/);
  assert.match(html, /id="historyBackfillBtn"/);
  assert.match(html, /id="historyKpiGrid"/);
  assert.match(html, /id="historyFinancialChart"/);
  assert.match(html, /id="historyEnergyChart"/);
  assert.match(html, /id="historyPriceChart"/);
  assert.match(html, /id="historyRows"/);
});

test('history shell styles define dedicated layout classes', () => {
  const css = readPublic('styles.css');

  assert.match(css, /\.history-layout\s*\{/);
  assert.match(css, /\.history-kpi-grid\s*\{/);
  assert.match(css, /\.history-chart-grid\s*\{/);
  assert.match(css, /\.history-rows\s*\{/);
});

test('history page renders KPI values, grouped rows, and unresolved warnings from the summary payload', () => {
  const { helpers, elements } = loadHistoryPageHelpers();

  helpers.renderSummary({
    view: 'day',
    date: '2026-03-09',
    kpis: {
      importCostEur: 1.23,
      gridCostEur: 1.23,
      pvCostEur: 0.32,
      batteryCostEur: 0.11,
      selfConsumptionKwh: 8.2,
      exportRevenueEur: 0.45,
      netEur: -0.78,
      importKwh: 4.5,
      exportKwh: 1.25
    },
    rows: [
      {
        label: '2026-03-09',
        importKwh: 4.5,
        loadKwh: 8.2,
        pvKwh: 5.3,
        pvAcKwh: 1.9,
        solarDirectUseKwh: 2.4,
        solarToBatteryKwh: 1.1,
        solarToGridKwh: 1.8,
        gridDirectUseKwh: 3.4,
        gridToBatteryKwh: 1.1,
        batteryDirectUseKwh: 0.9,
        batteryToGridKwh: 0.2,
        batteryChargeKwh: 1.1,
        batteryDischargeKwh: 0.9,
        selfConsumptionKwh: 8.2,
        gridShareKwh: 4.5,
        pvShareKwh: 2.8,
        batteryShareKwh: 0.9,
        exportKwh: 1.25,
        importCostEur: 1.23,
        gridCostEur: 1.23,
        pvCostEur: 0.32,
        batteryCostEur: 0.11,
        exportRevenueEur: 0.45,
        netEur: -0.78,
        incompleteSlots: 2
      }
    ],
    app: {
      versionLabel: 'v0.2.5+ea104c9'
    },
    meta: {
      unresolved: {
        incompleteSlots: 2
      }
    }
  });

  assert.match(elements.get('historyKpiCost').textContent, /1,66/);
  assert.match(elements.get('historyKpiImport').textContent, /4,50/);
  assert.match(elements.get('historyRows').innerHTML, /2026-03-09/);
  assert.match(elements.get('historyRows').innerHTML, /Verbrauch/);
  assert.match(elements.get('historyRows').innerHTML, /PV erzeugt/);
  assert.match(elements.get('historyRows').innerHTML, /PV AC/);
  assert.match(elements.get('historyRows').innerHTML, /PV direkt/);
  assert.match(elements.get('historyRows').innerHTML, /Netz → Akku/);
  assert.match(elements.get('historyRows').innerHTML, /Akku → Netz/);
  assert.match(elements.get('historyRows').innerHTML, /Akku geladen/);
  assert.match(elements.get('historyRows').innerHTML, /Eigenverbrauch PV/);
  assert.match(elements.get('historyRows').innerHTML, /2 offen/);
  assert.match(elements.get('historyBanner').textContent, /unvollständig/i);
  assert.match(elements.get('historyMeta').textContent, /v0\.2\.5\+ea104c9/);
});

test('history page renders daily line charts and estimated markers from chart payloads', () => {
  const { helpers, elements } = loadHistoryPageHelpers();

  helpers.renderSummary({
    view: 'day',
    date: '2026-03-09',
    kpis: {
      importCostEur: 0.3,
      exportRevenueEur: 0.04,
      netEur: -0.26,
      importKwh: 1,
      exportKwh: 0.5
    },
    rows: [],
    charts: {
      dayEnergyLines: [
        { label: '11:00', importKwh: 1, exportKwh: 0, loadKwh: 1.2, pvKwh: 0.3, pvAcKwh: 0.1, batteryKwh: 0.1, solarDirectUseKwh: 0.2, gridToBatteryKwh: 0.1, estimated: false, incomplete: false },
        { label: '11:15', importKwh: 0, exportKwh: 0.5, loadKwh: 0, pvKwh: 0.6, pvAcKwh: 0.4, batteryKwh: 0, solarDirectUseKwh: 0.3, gridToBatteryKwh: 0, estimated: true, incomplete: true }
      ],
      dayFinancialLines: [
        { label: '11:00', gridCostEur: 0.3, pvCostEur: 0.01, batteryCostEur: 0, opportunityCostEur: 0.02, selfConsumptionCostEur: 0.31, exportRevenueEur: 0, netEur: -0.31, estimated: false, incomplete: false },
        { label: '11:15', gridCostEur: 0, pvCostEur: 0, batteryCostEur: 0, opportunityCostEur: 0, selfConsumptionCostEur: 0, exportRevenueEur: 0.04, netEur: 0.04, estimated: true, incomplete: true }
      ],
      dayPriceLines: [
        { label: '11:00', marketPriceCtKwh: 5, userImportPriceCtKwh: 30, estimated: false, incomplete: false },
        { label: '11:15', marketPriceCtKwh: 8, userImportPriceCtKwh: 30, estimated: true, incomplete: true }
      ]
    },
    meta: {
      unresolved: {
        incompleteSlots: 1,
        estimatedSlots: 1
      }
    }
  });

  assert.match(elements.get('historyFinancialChart').innerHTML, /history-line-chart/);
  assert.match(elements.get('historyFinancialChart').innerHTML, /history-axis-y/);
  assert.match(elements.get('historyFinancialChart').innerHTML, /history-axis-x/);
  assert.match(elements.get('historyFinancialChart').innerHTML, /history-x-axis-label/);
  assert.match(elements.get('historyEnergyChart').innerHTML, /PV/);
  assert.match(elements.get('historyEnergyChart').innerHTML, /history-chart-hover-surface/);
  assert.doesNotMatch(elements.get('historyEnergyChart').innerHTML, /history-chart-cursor/);
  assert.match(elements.get('historyEnergyChart').innerHTML, /kWh/);
  assert.match(elements.get('historyEnergyChart').innerHTML, /PV AC/);
  assert.match(elements.get('historyEnergyChart').innerHTML, /PV direkt/);
  assert.match(elements.get('historyPriceChart').innerHTML, /Marktpreis/);
  assert.match(elements.get('historyEnergyChart').innerHTML, /geschätzt/);
});

test('history page renders weekly revenue bars and a table instead of time block cards', () => {
  const { helpers, elements } = loadHistoryPageHelpers();

  helpers.renderSummary({
    view: 'week',
    date: '2026-03-09',
    kpis: {
      importCostEur: 0.3,
      exportRevenueEur: 0.04,
      netEur: -0.26,
      importKwh: 3,
      exportKwh: 0.5
    },
    rows: [
      {
        label: '2026-03-09',
        importKwh: 1,
        exportKwh: 0.5,
        gridCostEur: 0.3,
        pvCostEur: 0.01,
        batteryCostEur: 0,
        selfConsumptionCostEur: 0.31,
        exportRevenueEur: 0.04,
        netEur: -0.27,
        incompleteSlots: 0,
        estimatedSlots: 0
      },
      {
        label: '2026-03-10',
        importKwh: 2,
        exportKwh: 0,
        gridCostEur: 0,
        pvCostEur: 0.01,
        batteryCostEur: 0,
        selfConsumptionCostEur: 0.01,
        exportRevenueEur: 0,
        netEur: -0.01,
        incompleteSlots: 1,
        estimatedSlots: 1
      }
    ],
    charts: {
      periodCombinedBars: [
        {
          label: '2026-03-09',
          importKwh: 1,
          loadKwh: 1.4,
          pvKwh: 0.8,
          batteryChargeKwh: 0.1,
          batteryDischargeKwh: 0.2,
          selfConsumptionKwh: 1.4,
          gridShareKwh: 1,
          pvShareKwh: 0.3,
          batteryShareKwh: 0.1,
          exportRevenueEur: 0.04,
          gridCostEur: 0.3,
          pvCostEur: 0.01,
          batteryCostEur: 0,
          estimatedSlots: 0,
          incompleteSlots: 0
        },
        {
          label: '2026-03-10',
          importKwh: 2,
          loadKwh: 2.3,
          pvKwh: 0.4,
          batteryChargeKwh: 0,
          batteryDischargeKwh: 0.2,
          selfConsumptionKwh: 2.3,
          gridShareKwh: 2,
          pvShareKwh: 0.2,
          batteryShareKwh: 0.1,
          exportRevenueEur: 0,
          gridCostEur: 0,
          pvCostEur: 0.01,
          batteryCostEur: 0,
          estimatedSlots: 1,
          incompleteSlots: 1
        }
      ]
    },
    meta: {
      unresolved: {
        incompleteSlots: 1,
        estimatedSlots: 1
      }
    }
  });

  assert.match(elements.get('historyFinancialChart').innerHTML, /history-stack-chart/);
  assert.match(elements.get('historyFinancialChart').innerHTML, /history-bars-compressed/);
  assert.match(elements.get('historyFinancialChart').innerHTML, /history-axis-y/);
  assert.match(elements.get('historyFinancialChart').innerHTML, /history-axis-x/);
  assert.match(elements.get('historyFinancialChart').innerHTML, /history-chart-hover-surface/);
  assert.match(elements.get('historyFinancialChart').innerHTML, /Erlös/);
  assert.match(elements.get('historyFinancialChart').innerHTML, /Kosten/);
  assert.match(elements.get('historyFinancialChart').innerHTML, /Import/);
  assert.match(elements.get('historyFinancialChart').innerHTML, /Eigenverbrauch PV/);
  assert.match(elements.get('historyRows').innerHTML, /history-data-table/);
  assert.match(elements.get('historyRows').innerHTML, /2026-03-10/);
  assert.doesNotMatch(elements.get('historyRows').innerHTML, /history-row-card/);
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
