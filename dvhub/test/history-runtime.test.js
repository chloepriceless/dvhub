import test from 'node:test';
import assert from 'node:assert/strict';

import { createHistoryApiHandlers, createHistoryRuntime } from '../history-runtime.js';

function createStoreFixture() {
  return {
    listAggregatedEnergySlots({ start, end, bucketSeconds }) {
      assert.ok(start);
      assert.ok(end);
      assert.equal(bucketSeconds, 900);
      return [
        {
          ts: '2026-03-09T11:00:00.000Z',
          importKwh: 1,
          exportKwh: 0,
          gridKwh: 1,
          pvKwh: 0.2,
          batteryKwh: 0,
          batteryChargeKwh: 0,
          batteryDischargeKwh: 0,
          loadKwh: 1.2,
          estimated: false,
          incomplete: false
        },
        {
          ts: '2026-03-09T11:15:00.000Z',
          importKwh: 0,
          exportKwh: 0.5,
          gridKwh: 0,
          pvKwh: 0.4,
          batteryKwh: -0.1,
          batteryChargeKwh: 0.1,
          batteryDischargeKwh: 0,
          loadKwh: 0,
          estimated: false,
          incomplete: false
        },
        {
          ts: '2026-03-10T11:00:00.000Z',
          importKwh: 2,
          exportKwh: 0,
          gridKwh: 2,
          pvKwh: 0.1,
          batteryKwh: 0,
          batteryChargeKwh: 0,
          batteryDischargeKwh: 0,
          loadKwh: 2.1,
          estimated: true,
          incomplete: true
        },
        {
          ts: '2026-04-01T10:00:00.000Z',
          importKwh: 0,
          exportKwh: 1,
          gridKwh: 0,
          pvKwh: 1.2,
          batteryKwh: -0.3,
          batteryChargeKwh: 0.3,
          batteryDischargeKwh: 0,
          loadKwh: 0,
          estimated: false,
          incomplete: false
        }
      ];
    },
    listPriceSlots() {
      return [
        {
          ts: '2026-03-09T11:00:00.000Z',
          priceCtKwh: 5,
          priceEurMwh: 50
        },
        {
          ts: '2026-03-09T11:15:00.000Z',
          priceCtKwh: 8,
          priceEurMwh: 80
        },
        {
          ts: '2026-04-01T10:00:00.000Z',
          priceCtKwh: 6,
          priceEurMwh: 60
        }
      ];
    }
  };
}

const pricingConfig = {
  mode: 'fixed',
  fixedGrossImportCtKwh: null,
  costs: {
    pvCtKwh: 6.38,
    batteryBaseCtKwh: 2,
    batteryLossMarkupPct: 20
  },
  periods: [
    {
      id: 'march-fixed',
      startDate: '2026-03-01',
      endDate: '2026-03-09',
      mode: 'fixed',
      fixedGrossImportCtKwh: 30
    }
  ]
};

test('history runtime computes slot-level import cost, export revenue, and unresolved counters', () => {
  const runtime = createHistoryRuntime({
    store: createStoreFixture(),
    getPricingConfig: () => pricingConfig
  });

  const summary = runtime.getSummary({
    view: 'week',
    date: '2026-03-09'
  });

  assert.equal(summary.kpis.importKwh, 3);
  assert.equal(summary.kpis.exportKwh, 0.5);
  assert.equal(summary.kpis.importCostEur, 0.3);
  assert.equal(summary.kpis.exportRevenueEur, 0.04);
  assert.equal(summary.kpis.pvCostEur, 0.02);
  assert.equal(summary.kpis.selfConsumptionCostEur, 0.32);
  assert.equal(summary.kpis.netEur, -0.28);
  assert.deepEqual(summary.meta.unresolved, {
    missingImportPriceSlots: 1,
    missingMarketPriceSlots: 0,
    incompleteSlots: 1,
    estimatedSlots: 1,
    slotCount: 3
  });
  assert.equal(summary.series.financial.length, 3);
  assert.equal(summary.series.prices[0].userImportPriceCtKwh, 30);
  assert.equal(summary.rows[0].gridCostEur, 0.3);
  assert.equal(summary.rows[0].pvCostEur, 0.01);
});

test('history runtime splits self-consumption cost across grid pv and battery shares', () => {
  const runtime = createHistoryRuntime({
    store: {
      listAggregatedEnergySlots() {
        return [
          {
            ts: '2026-03-09T11:00:00.000Z',
            importKwh: 0.4,
            exportKwh: 0,
            gridKwh: 0.4,
            pvKwh: 0.4,
            batteryKwh: 0.2,
            batteryChargeKwh: 0,
            batteryDischargeKwh: 0.2,
            loadKwh: 1,
            estimated: true,
            incomplete: false
          }
        ];
      },
      listPriceSlots() {
        return [
          {
            ts: '2026-03-09T11:00:00.000Z',
            priceCtKwh: 5,
            priceEurMwh: 50
          }
        ];
      }
    },
    getPricingConfig: () => pricingConfig
  });

  const summary = runtime.getSummary({
    view: 'day',
    date: '2026-03-09'
  });

  assert.equal(summary.kpis.gridCostEur, 0.12);
  assert.equal(summary.kpis.pvCostEur, 0.03);
  assert.equal(summary.kpis.batteryCostEur, 0.02);
  assert.equal(summary.kpis.selfConsumptionCostEur, 0.17);
  assert.equal(summary.kpis.netEur, -0.17);
  assert.equal(summary.meta.unresolved.estimatedSlots, 1);
  assert.deepEqual(summary.series.financial[0], {
    ts: '2026-03-09T11:00:00.000Z',
    gridCostEur: 0.12,
    pvCostEur: 0.03,
    batteryCostEur: 0.02,
    selfConsumptionCostEur: 0.17,
    importCostEur: 0.12,
    exportRevenueEur: 0,
    netEur: -0.17
  });
});

test('history runtime groups day, week, month, and year views with correct totals', () => {
  const runtime = createHistoryRuntime({
    store: createStoreFixture(),
    getPricingConfig: () => pricingConfig
  });

  const day = runtime.getSummary({ view: 'day', date: '2026-03-09' });
  const week = runtime.getSummary({ view: 'week', date: '2026-03-09' });
  const month = runtime.getSummary({ view: 'month', date: '2026-03-09' });
  const year = runtime.getSummary({ view: 'year', date: '2026-03-09' });

  assert.equal(day.rows.length, 2);
  assert.equal(week.rows.length, 2);
  assert.equal(week.rows[0].label, '2026-03-09');
  assert.equal(month.rows.length, 2);
  assert.equal(year.rows.length, 2);
  assert.equal(year.rows[0].label, '2026-03');
  assert.equal(year.rows[1].label, '2026-04');
});

test('history runtime exposes chart-ready series with split costs and estimation metadata', () => {
  const runtime = createHistoryRuntime({
    store: createStoreFixture(),
    getPricingConfig: () => pricingConfig
  });

  const day = runtime.getSummary({ view: 'day', date: '2026-03-09' });
  const week = runtime.getSummary({ view: 'week', date: '2026-03-09' });

  assert.equal(Array.isArray(day.charts?.dayEnergyLines), true);
  assert.equal(day.charts.dayEnergyLines[0].label, '12:00');
  assert.equal(day.charts.dayEnergyLines[0].loadKwh, 1.2);
  assert.equal(day.charts.dayEnergyLines[1].estimated, false);
  assert.equal(Array.isArray(day.charts?.dayPriceLines), true);
  assert.equal(day.charts.dayPriceLines[0].marketPriceCtKwh, 5);
  assert.equal(Array.isArray(day.charts?.dayFinancialLines), true);
  assert.equal(day.charts.dayFinancialLines[0].gridCostEur, 0.3);
  assert.equal(Array.isArray(week.charts?.periodFinancialBars), true);
  assert.equal(week.charts.periodFinancialBars[0].label, '2026-03-09');
  assert.equal(week.charts.periodFinancialBars[0].gridCostEur, 0.3);
  assert.equal(week.charts.periodFinancialBars[0].pvCostEur, 0.01);
  assert.equal(week.charts.periodFinancialBars[0].batteryCostEur, 0);
  assert.equal(week.charts.periodFinancialBars[1].estimatedSlots, 1);
  assert.deepEqual(week.meta.unresolved, {
    missingImportPriceSlots: 1,
    missingMarketPriceSlots: 0,
    incompleteSlots: 1,
    estimatedSlots: 1,
    slotCount: 3
  });
});

test('history summary API validates views and delegates to the runtime', async () => {
  let called = 0;
  const handlers = createHistoryApiHandlers({
    historyRuntime: {
      getSummary(input) {
        called += 1;
        return { ok: true, echo: input };
      }
    },
    historyImportManager: {
      async backfillMissingPriceHistory() {
        return { ok: true, requestedDays: 1 };
      }
    },
    telemetryEnabled: true,
    defaultBzn: 'DE-LU'
  });

  const invalid = await handlers.getSummary({ view: 'quarter', date: '2026-03-09' });
  const valid = await handlers.getSummary({ view: 'month', date: '2026-03-09' });
  const backfill = await handlers.postPriceBackfill({});

  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /view/i);
  assert.equal(valid.status, 200);
  assert.deepEqual(valid.body.echo, { view: 'month', date: '2026-03-09' });
  assert.equal(backfill.status, 200);
  assert.equal(backfill.body.requestedDays, 1);
  assert.equal(called, 1);
});
