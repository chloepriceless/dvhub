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
