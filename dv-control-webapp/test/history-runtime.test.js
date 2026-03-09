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
          gridKwh: 0,
          pvKwh: 0.2,
          batteryKwh: 0
        },
        {
          ts: '2026-03-09T11:15:00.000Z',
          importKwh: 0,
          exportKwh: 0.5,
          gridKwh: 0,
          pvKwh: 0.4,
          batteryKwh: -0.1
        },
        {
          ts: '2026-03-10T11:00:00.000Z',
          importKwh: 2,
          exportKwh: 0,
          gridKwh: 0,
          pvKwh: 0.1,
          batteryKwh: 0
        },
        {
          ts: '2026-04-01T10:00:00.000Z',
          importKwh: 0,
          exportKwh: 1,
          gridKwh: 0,
          pvKwh: 1.2,
          batteryKwh: -0.3
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
  assert.equal(summary.kpis.netEur, -0.26);
  assert.deepEqual(summary.meta.unresolved, {
    missingImportPriceSlots: 1,
    missingMarketPriceSlots: 0,
    incompleteSlots: 1,
    slotCount: 3
  });
  assert.equal(summary.series.financial.length, 3);
  assert.equal(summary.series.prices[0].userImportPriceCtKwh, 30);
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
