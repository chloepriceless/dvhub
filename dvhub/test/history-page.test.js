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
    'historyDate'
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

test('history page exposes view switcher, KPI blocks, chart containers, and grouped rows mount', () => {
  const html = readPublic('history.html');

  assert.match(html, /id="historyView"/);
  assert.match(html, /id="historyDate"/);
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
      exportRevenueEur: 0.45,
      netEur: -0.78,
      importKwh: 4.5,
      exportKwh: 1.25
    },
    rows: [
      {
        label: '2026-03-09',
        importKwh: 4.5,
        exportKwh: 1.25,
        importCostEur: 1.23,
        exportRevenueEur: 0.45,
        netEur: -0.78,
        incompleteSlots: 2
      }
    ],
    meta: {
      unresolved: {
        incompleteSlots: 2
      }
    }
  });

  assert.match(elements.get('historyKpiCost').textContent, /1,23/);
  assert.match(elements.get('historyKpiImport').textContent, /4,50/);
  assert.match(elements.get('historyRows').innerHTML, /2026-03-09/);
  assert.match(elements.get('historyRows').innerHTML, /2 offen/);
  assert.match(elements.get('historyBanner').textContent, /unvollständig/i);
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
        { label: '11:00', importKwh: 1, exportKwh: 0, loadKwh: 1.2, estimated: false, incomplete: false },
        { label: '11:15', importKwh: 0, exportKwh: 0.5, loadKwh: 0, estimated: true, incomplete: true }
      ],
      dayFinancialLines: [
        { label: '11:00', gridCostEur: 0.3, pvCostEur: 0.01, batteryCostEur: 0, selfConsumptionCostEur: 0.31, exportRevenueEur: 0, netEur: -0.31, estimated: false, incomplete: false },
        { label: '11:15', gridCostEur: 0, pvCostEur: 0, batteryCostEur: 0, selfConsumptionCostEur: 0, exportRevenueEur: 0.04, netEur: 0.04, estimated: true, incomplete: true }
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
  assert.match(elements.get('historyFinancialChart').innerHTML, /Netto/);
  assert.match(elements.get('historyEnergyChart').innerHTML, /Last/);
  assert.match(elements.get('historyPriceChart').innerHTML, /Marktpreis/);
  assert.match(elements.get('historyFinancialChart').innerHTML, /geschätzt/);
});

test('history page renders weekly revenue bars and split cost bars from summary payload', () => {
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
      periodFinancialBars: [
        {
          label: '2026-03-09',
          exportRevenueEur: 0.04,
          gridCostEur: 0.3,
          pvCostEur: 0.01,
          batteryCostEur: 0,
          estimatedSlots: 0,
          incompleteSlots: 0
        },
        {
          label: '2026-03-10',
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
  assert.match(elements.get('historyFinancialChart').innerHTML, /Nettoerlös/);
  assert.match(elements.get('historyFinancialChart').innerHTML, /Netzkosten/);
  assert.match(elements.get('historyFinancialChart').innerHTML, /PV-Kosten/);
  assert.match(elements.get('historyRows').innerHTML, /1 geschätzt/);
  assert.match(elements.get('historyRows').innerHTML, /1 offen/);
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
