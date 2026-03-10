import test from 'node:test';
import assert from 'node:assert/strict';

import { createHistoryApiHandlers, createHistoryRuntime } from '../history-runtime.js';

const FIXED_CURRENT_DATE = '2027-04-02';

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
    getPricingConfig: () => pricingConfig,
    getCurrentDate: () => FIXED_CURRENT_DATE
  });

  const summary = runtime.getSummary({
    view: 'week',
    date: '2026-03-09'
  });

  assert.equal(summary.kpis.importKwh, 3);
  assert.equal(summary.kpis.exportKwh, 0.5);
  assert.equal(summary.kpis.loadKwh, 3.3);
  assert.equal(summary.kpis.pvKwh, 0.7);
  assert.equal(summary.kpis.batteryChargeKwh, 0.1);
  assert.equal(summary.kpis.batteryDischargeKwh, 0);
  assert.equal(summary.kpis.selfConsumptionKwh, 3.3);
  assert.equal(summary.kpis.gridShareKwh, 3);
  assert.equal(summary.kpis.pvShareKwh, 0.3);
  assert.equal(summary.kpis.batteryShareKwh, 0);
  assert.equal(summary.kpis.importCostEur, 0.3);
  assert.equal(summary.kpis.exportRevenueEur, 0.04);
  assert.equal(summary.kpis.pvCostEur, 0.02);
  assert.equal(summary.kpis.selfConsumptionCostEur, 0.32);
  assert.equal(summary.kpis.opportunityCostEur, 0.01);
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
  assert.equal(summary.rows[0].loadKwh, 1.2);
  assert.equal(summary.rows[0].pvKwh, 0.6);
  assert.equal(summary.rows[0].batteryChargeKwh, 0.1);
  assert.equal(summary.rows[0].batteryDischargeKwh, 0);
  assert.equal(summary.rows[0].selfConsumptionKwh, 1.2);
  assert.equal(summary.rows[0].gridShareKwh, 1);
  assert.equal(summary.rows[0].pvShareKwh, 0.2);
  assert.equal(summary.rows[0].batteryShareKwh, 0);
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
    getPricingConfig: () => pricingConfig,
    getCurrentDate: () => FIXED_CURRENT_DATE
  });

  const summary = runtime.getSummary({
    view: 'day',
    date: '2026-03-09'
  });

  assert.equal(summary.kpis.gridCostEur, 0.12);
  assert.equal(summary.kpis.pvCostEur, 0.03);
  assert.equal(summary.kpis.batteryCostEur, 0.02);
  assert.equal(summary.kpis.selfConsumptionCostEur, 0.17);
  assert.equal(summary.kpis.selfConsumptionKwh, 1);
  assert.equal(summary.kpis.opportunityCostEur, 0.03);
  assert.equal(summary.kpis.netEur, -0.17);
  assert.equal(summary.meta.unresolved.estimatedSlots, 1);
  assert.deepEqual(summary.series.financial[0], {
    ts: '2026-03-09T11:00:00.000Z',
    gridCostEur: 0.12,
    pvCostEur: 0.03,
    batteryCostEur: 0.02,
    avoidedImportGrossEur: 0.18,
    avoidedImportPvGrossEur: 0.12,
    avoidedImportBatteryGrossEur: 0.06,
    selfConsumptionCostEur: 0.17,
    opportunityCostEur: 0.03,
    importCostEur: 0.12,
    exportRevenueEur: 0,
    netEur: -0.17
  });
});

test('history runtime computes avoided import gross values for slots, rows, and kpis', () => {
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
          }
        ];
      }
    },
    getPricingConfig: () => pricingConfig,
    getCurrentDate: () => FIXED_CURRENT_DATE
  });

  const summary = runtime.getSummary({
    view: 'day',
    date: '2026-03-09'
  });

  assert.equal(summary.kpis.avoidedImportGrossEur, 0.18);
  assert.equal(summary.kpis.avoidedImportPvGrossEur, 0.12);
  assert.equal(summary.kpis.avoidedImportBatteryGrossEur, 0.06);
  assert.equal(summary.rows[0].avoidedImportGrossEur, 0.18);
  assert.equal(summary.rows[0].avoidedImportPvGrossEur, 0.12);
  assert.equal(summary.rows[0].avoidedImportBatteryGrossEur, 0.06);
  assert.equal(summary.slots[0].avoidedImportGrossEur, 0.18);
  assert.equal(summary.slots[0].avoidedImportPvGrossEur, 0.12);
  assert.equal(summary.slots[0].avoidedImportBatteryGrossEur, 0.06);
});

test('history runtime matches export revenue per slot even when price timestamps only align by bucket', () => {
  const runtime = createHistoryRuntime({
    store: {
      listAggregatedEnergySlots() {
        return [
          {
            ts: '2026-03-09T10:00:05.000Z',
            importKwh: 0,
            exportKwh: 0.5,
            gridKwh: 0,
            pvKwh: 0.5,
            batteryKwh: 0,
            batteryChargeKwh: 0,
            batteryDischargeKwh: 0,
            loadKwh: 0,
            estimated: false,
            incomplete: false
          },
          {
            ts: '2026-03-09T10:15:05.000Z',
            importKwh: 0,
            exportKwh: 1.5,
            gridKwh: 0,
            pvKwh: 1.5,
            batteryKwh: 0,
            batteryChargeKwh: 0,
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
            ts: '2026-03-09T10:00:00.000Z',
            priceCtKwh: 10,
            priceEurMwh: 100
          },
          {
            ts: '2026-03-09T10:15:00.000Z',
            priceCtKwh: 12,
            priceEurMwh: 120
          }
        ];
      }
    },
    getPricingConfig: () => pricingConfig,
    getCurrentDate: () => FIXED_CURRENT_DATE
  });

  const summary = runtime.getSummary({
    view: 'week',
    date: '2026-03-09'
  });

  assert.equal(summary.slots[0].exportRevenueEur, 0.05);
  assert.equal(summary.slots[1].exportRevenueEur, 0.18);
  assert.equal(summary.kpis.exportRevenueEur, 0.23);
  assert.equal(summary.rows[0].exportRevenueEur, 0.23);
});

test('history runtime prices all imported energy with the import tariff even when part of the slot is not direct load share', () => {
  const runtime = createHistoryRuntime({
    store: {
      listAggregatedEnergySlots() {
        return [
          {
            ts: '2026-03-09T11:00:00.000Z',
            importKwh: 1,
            exportKwh: 0.5,
            gridKwh: 1,
            pvKwh: 2,
            batteryKwh: -1.5,
            batteryChargeKwh: 1.5,
            batteryDischargeKwh: 0,
            loadKwh: 1,
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
          }
        ];
      }
    },
    getPricingConfig: () => pricingConfig,
    getCurrentDate: () => FIXED_CURRENT_DATE
  });

  const summary = runtime.getSummary({
    view: 'day',
    date: '2026-03-09'
  });

  assert.equal(summary.kpis.importKwh, 1);
  assert.equal(summary.kpis.gridShareKwh, 0.33);
  assert.equal(summary.kpis.importCostEur, 0.3);
  assert.equal(summary.kpis.gridCostEur, 0.3);
});

test('history runtime exposes aggregated net-analysis payloads with real export costs separated from avoided import', () => {
  const pricing = {
    mode: 'fixed',
    fixedGrossImportCtKwh: 30,
    costs: {
      pvCtKwh: 6.38,
      batteryBaseCtKwh: 2,
      batteryLossMarkupPct: 20
    },
    periods: []
  };
  const runtime = createHistoryRuntime({
    store: {
      listAggregatedEnergySlots() {
        return [
          {
            ts: '2026-03-09T10:00:00.000Z',
            importKwh: 0,
            exportKwh: 1,
            gridKwh: 0,
            pvKwh: 0.6,
            batteryKwh: 0.4,
            batteryChargeKwh: 0,
            batteryDischargeKwh: 0.4,
            batteryToGridKwh: 0.4,
            solarToGridKwh: 0.6,
            loadKwh: 0,
            estimated: false,
            incomplete: false
          },
          {
            ts: '2026-03-10T10:00:00.000Z',
            importKwh: 2,
            exportKwh: 0,
            gridKwh: 2,
            pvKwh: 0.5,
            batteryKwh: 0,
            batteryChargeKwh: 0,
            batteryDischargeKwh: 0,
            solarDirectUseKwh: 0.5,
            loadKwh: 2.5,
            estimated: false,
            incomplete: false
          }
        ];
      },
      listPriceSlots() {
        return [
          {
            ts: '2026-03-09T10:00:00.000Z',
            priceCtKwh: 12,
            priceEurMwh: 120
          },
          {
            ts: '2026-03-10T10:00:00.000Z',
            priceCtKwh: 5,
            priceEurMwh: 50
          }
        ];
      }
    },
    getPricingConfig: () => pricing,
    getCurrentDate: () => FIXED_CURRENT_DATE
  });

  const week = runtime.getSummary({
    view: 'week',
    date: '2026-03-09'
  });
  const month = runtime.getSummary({
    view: 'month',
    date: '2026-03-09'
  });
  const year = runtime.getSummary({
    view: 'year',
    date: '2026-03-09'
  });

  assert.deepEqual(week.charts.periodCombinedBars[0], {
    label: '2026-03-09',
    importKwh: 0,
    exportKwh: 1,
    loadKwh: 0,
    pvKwh: 0.6,
    pvAcKwh: 0,
    solarDirectUseKwh: 0,
    solarToBatteryKwh: 0,
    solarToGridKwh: 0.6,
    gridDirectUseKwh: 0,
    gridToBatteryKwh: 0,
    batteryDirectUseKwh: 0,
    batteryToGridKwh: 0.4,
    batteryChargeKwh: 0,
    batteryDischargeKwh: 0.4,
    selfConsumptionKwh: 0,
    gridShareKwh: 0,
    pvShareKwh: 0,
    batteryShareKwh: 0,
    exportRevenueEur: 0.12,
    gridCostEur: 0,
    pvCostEur: 0.04,
    batteryCostEur: 0.04,
    avoidedImportGrossEur: 0,
    avoidedImportPvGrossEur: 0,
    avoidedImportBatteryGrossEur: 0,
    opportunityCostEur: 0,
    selfConsumptionCostEur: 0.08,
    netEur: 0.04,
    estimatedSlots: 0,
    incompleteSlots: 0
  });
  assert.equal(week.charts.periodCombinedBars[1].gridCostEur, 0.6);
  assert.equal(week.charts.periodCombinedBars[1].pvCostEur, 0.03);
  assert.equal(week.charts.periodCombinedBars[1].batteryCostEur, 0);
  assert.equal(week.charts.periodCombinedBars[1].avoidedImportGrossEur, 0.15);
  assert.equal(week.charts.periodCombinedBars[1].netEur, -0.63);
  assert.equal(week.kpis.exportRevenueEur, 0.12);
  assert.equal(week.kpis.gridCostEur, 0.6);
  assert.equal(week.kpis.pvCostEur, 0.07);
  assert.equal(week.kpis.batteryCostEur, 0.04);
  assert.equal(week.kpis.avoidedImportGrossEur, 0.15);
  assert.equal(week.kpis.netEur, -0.59);
  assert.equal(month.charts.periodCombinedBars[0].pvCostEur, 0.04);
  assert.equal(month.charts.periodCombinedBars[1].netEur, -0.63);
  assert.equal(year.charts.periodCombinedBars[0].exportRevenueEur, 0.12);
  assert.equal(year.charts.periodCombinedBars[0].pvCostEur, 0.07);
  assert.equal(year.charts.periodCombinedBars[0].batteryCostEur, 0.04);
  assert.equal(year.charts.periodCombinedBars[0].avoidedImportGrossEur, 0.15);
  assert.equal(year.charts.periodCombinedBars[0].netEur, -0.59);
});

test('history runtime groups day, week, month, and year views with correct totals', () => {
  const runtime = createHistoryRuntime({
    store: createStoreFixture(),
    getPricingConfig: () => pricingConfig,
    getCurrentDate: () => FIXED_CURRENT_DATE
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
    getPricingConfig: () => pricingConfig,
    getCurrentDate: () => FIXED_CURRENT_DATE
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
  assert.equal(day.charts.dayFinancialLines[0].opportunityCostEur, 0.01);
  assert.equal(Array.isArray(week.charts?.periodFinancialBars), true);
  assert.equal(week.charts.periodFinancialBars[0].label, '2026-03-09');
  assert.equal(week.charts.periodFinancialBars[0].gridCostEur, 0.3);
  assert.equal(week.charts.periodFinancialBars[0].pvCostEur, 0.01);
  assert.equal(week.charts.periodFinancialBars[0].batteryCostEur, 0);
  assert.equal(Array.isArray(week.charts?.periodCombinedBars), true);
  assert.equal(week.charts.periodCombinedBars[0].loadKwh, 1.2);
  assert.equal(week.charts.periodCombinedBars[0].importKwh, 1);
  assert.equal(week.charts.periodCombinedBars[0].selfConsumptionKwh, 1.2);
  assert.equal(week.charts.periodFinancialBars[1].estimatedSlots, 1);
  assert.deepEqual(week.meta.unresolved, {
    missingImportPriceSlots: 1,
    missingMarketPriceSlots: 0,
    incompleteSlots: 1,
    estimatedSlots: 1,
    slotCount: 3
  });
});

test('history runtime carries extended vrm flow values into rows and kpis', () => {
  const slots = [
    {
      ts: '2026-03-08T11:00:00.000Z',
      importKwh: 0.3,
      exportKwh: 0.45,
      gridKwh: 0,
      pvKwh: 1.4,
      pvAcKwh: 0.5,
      batteryKwh: 0.2,
      batteryChargeKwh: 0.4,
      batteryDischargeKwh: 0.2,
      loadKwh: 1.05,
      solarDirectUseKwh: 0.7,
      solarToBatteryKwh: 0.3,
      solarToGridKwh: 0.4,
      gridDirectUseKwh: 0.2,
      gridToBatteryKwh: 0.1,
      batteryDirectUseKwh: 0.15,
      batteryToGridKwh: 0.05,
      estimated: false,
      incomplete: false
    }
  ];
  const runtime = createHistoryRuntime({
    store: {
      listAggregatedEnergySlots: () => slots,
      listPriceSlots: () => []
    },
    getPricingConfig: () => ({}),
    getCurrentDate: () => FIXED_CURRENT_DATE
  });

  const summary = runtime.getSummary({ view: 'day', date: '2026-03-08' });

  assert.equal(summary.kpis.solarDirectUseKwh, 0.7);
  assert.equal(summary.kpis.pvAcKwh, 0.5);
  assert.equal(summary.kpis.gridToBatteryKwh, 0.1);
  assert.equal(summary.kpis.batteryToGridKwh, 0.05);
  assert.equal(summary.rows[0].pvAcKwh, 0.5);
  assert.equal(summary.rows[0].solarToGridKwh, 0.4);
  assert.equal(summary.rows[0].batteryDirectUseKwh, 0.15);
  assert.equal(summary.charts.dayEnergyLines[0].pvAcKwh, 0.5);
  assert.equal(summary.charts.dayEnergyLines[0].solarDirectUseKwh, 0.7);
});

test('history runtime reads past days from history scope and the current day from live scope', () => {
  const calls = [];
  const runtime = createHistoryRuntime({
    store: {
      listAggregatedEnergySlots(input) {
        calls.push(input);
        return [];
      },
      listPriceSlots() {
        return [];
      }
    },
    getPricingConfig: () => ({}),
    getCurrentDate: () => '2026-03-10'
  });

  runtime.getSummary({ view: 'day', date: '2026-03-09' });
  runtime.getSummary({ view: 'day', date: '2026-03-10' });

  assert.deepEqual(calls[0].scopes, ['history']);
  assert.deepEqual(calls[1].scopes, ['live']);
});

test('history runtime splits ranges that span today into history and live queries', () => {
  const calls = [];
  const runtime = createHistoryRuntime({
    store: {
      listAggregatedEnergySlots(input) {
        calls.push(input);
        return [];
      },
      listPriceSlots() {
        return [];
      }
    },
    getPricingConfig: () => ({}),
    getCurrentDate: () => '2026-03-10'
  });

  runtime.getSummary({ view: 'week', date: '2026-03-10' });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].scopes, ['history']);
  assert.equal(calls[0].start, '2026-03-08T23:00:00.000Z');
  assert.equal(calls[0].end, '2026-03-09T23:00:00.000Z');
  assert.deepEqual(calls[1].scopes, ['live']);
  assert.equal(calls[1].start, '2026-03-09T23:00:00.000Z');
  assert.equal(calls[1].end, '2026-03-15T23:00:00.000Z');
});

test('history runtime reads materialized slots first and falls back to aggregated raw slots only when needed', () => {
  let materializedCalls = 0;
  let rawCalls = 0;
  const runtime = createHistoryRuntime({
    store: {
      listMaterializedEnergySlots() {
        materializedCalls += 1;
        return [];
      },
      listAggregatedEnergySlots() {
        rawCalls += 1;
        return [
          {
            ts: '2026-03-09T11:00:00.000Z',
            importKwh: 1,
            exportKwh: 0,
            gridKwh: 1,
            pvKwh: 0,
            batteryKwh: 0,
            batteryChargeKwh: 0,
            batteryDischargeKwh: 0,
            loadKwh: 1,
            estimated: false,
            incomplete: false
          }
        ];
      },
      listPriceSlots() {
        return [];
      }
    },
    getPricingConfig: () => ({}),
    getCurrentDate: () => '2026-03-10'
  });

  const summary = runtime.getSummary({ view: 'day', date: '2026-03-09' });

  assert.equal(materializedCalls, 1);
  assert.equal(rawCalls, 1);
  assert.equal(summary.rows.length, 1);
});

test('history runtime derives current-year solar market value from monthly values weighted by exported energy', () => {
  const runtime = createHistoryRuntime({
    store: createStoreFixture(),
    getPricingConfig: () => pricingConfig,
    getCurrentDate: () => FIXED_CURRENT_DATE,
    getSolarMarketValueSummary: () => ({
      monthlyCtKwhByMonth: {
        '2026-03': 5,
        '2026-04': 7
      },
      annualCtKwhByYear: {}
    })
  });

  const year = runtime.getSummary({ view: 'year', date: '2026-03-09' });

  assert.equal(year.rows[0].solarMarketValueCtKwh, 5);
  assert.equal(year.rows[0].solarCompensationEur, 0.03);
  assert.equal(year.rows[1].solarMarketValueCtKwh, 7);
  assert.equal(year.rows[1].solarCompensationEur, 0.07);
  assert.deepEqual(year.meta.solarMarketValue, {
    year: 2026,
    annualCtKwh: 6.33,
    source: 'derived_monthly_weighted',
    availableMonths: 2
  });
  assert.equal(year.kpis.solarCompensationEur, 0.1);
});

test('history runtime uses official annual solar market value for completed years', () => {
  const runtime = createHistoryRuntime({
    store: {
      listAggregatedEnergySlots() {
        return [
          {
            ts: '2025-02-01T10:00:00.000Z',
            importKwh: 0,
            exportKwh: 2,
            gridKwh: 0,
            pvKwh: 2,
            batteryKwh: 0,
            batteryChargeKwh: 0,
            batteryDischargeKwh: 0,
            loadKwh: 0,
            estimated: false,
            incomplete: false
          }
        ];
      },
      listPriceSlots() {
        return [];
      }
    },
    getPricingConfig: () => pricingConfig,
    getSolarMarketValueSummary: () => ({
      monthlyCtKwhByMonth: {},
      annualCtKwhByYear: {
        2025: 4.5
      }
    })
  });

  const year = runtime.getSummary({ view: 'year', date: '2025-06-01' });

  assert.deepEqual(year.meta.solarMarketValue, {
    year: 2025,
    annualCtKwh: 4.5,
    source: 'official_annual',
    availableMonths: 0
  });
  assert.equal(year.kpis.solarCompensationEur, 0.09);
});

test('history runtime computes weighted applicable value and premium-eligible export for annual premium input', () => {
  const runtime = createHistoryRuntime({
    store: {
      listAggregatedEnergySlots() {
        return [
          {
            ts: '2026-01-10T10:00:00.000Z',
            importKwh: 0,
            exportKwh: 1,
            gridKwh: 0,
            pvKwh: 1,
            batteryKwh: 0,
            batteryChargeKwh: 0,
            batteryDischargeKwh: 0,
            loadKwh: 0,
            estimated: false,
            incomplete: false
          },
          {
            ts: '2026-01-10T10:15:00.000Z',
            importKwh: 0,
            exportKwh: 0.5,
            gridKwh: 0,
            pvKwh: 0.5,
            batteryKwh: 0,
            batteryChargeKwh: 0,
            batteryDischargeKwh: 0,
            loadKwh: 0,
            estimated: false,
            incomplete: false
          },
          {
            ts: '2026-01-10T10:30:00.000Z',
            importKwh: 0,
            exportKwh: 0.25,
            gridKwh: 0,
            pvKwh: 0.25,
            batteryKwh: 0,
            batteryChargeKwh: 0,
            batteryDischargeKwh: 0,
            loadKwh: 0,
            estimated: false,
            incomplete: false
          }
        ];
      },
      listPriceSlots() {
        return [
          { ts: '2026-01-10T10:00:00.000Z', priceCtKwh: 6, priceEurMwh: 60 },
          { ts: '2026-01-10T10:15:00.000Z', priceCtKwh: -1, priceEurMwh: -10 },
          { ts: '2026-01-10T10:30:00.000Z', priceCtKwh: 0, priceEurMwh: 0 }
        ];
      }
    },
    getPricingConfig: () => ({
      ...pricingConfig,
      pvPlants: [
        { kwp: 10, commissionedAt: '2021-04-15' },
        { kwp: 5, commissionedAt: '2023-09-01' }
      ]
    }),
    getCurrentDate: () => FIXED_CURRENT_DATE,
    getApplicableValueSummary: () => ({
      applicableValueCtKwhByMonth: {
        '2021-04': 8.2,
        '2023-09': 7.5
      }
    })
  });

  const year = runtime.getSummary({ view: 'year', date: '2026-06-01' });

  assert.equal(year.kpis.weightedApplicableValueCtKwh, 7.97);
  assert.equal(year.kpis.premiumEligibleExportKwh, 1.25);
});

test('history runtime resolves plant-specific applicable values via lookup function for equal commissioning months', () => {
  const runtime = createHistoryRuntime({
    store: {
      listAggregatedEnergySlots() {
        return [
          {
            ts: '2026-01-10T10:00:00.000Z',
            importKwh: 0,
            exportKwh: 1,
            gridKwh: 0,
            pvKwh: 1,
            batteryKwh: 0,
            batteryChargeKwh: 0,
            batteryDischargeKwh: 0,
            loadKwh: 0,
            estimated: false,
            incomplete: false
          }
        ];
      },
      listPriceSlots() {
        return [
          { ts: '2026-01-10T10:00:00.000Z', priceCtKwh: 6, priceEurMwh: 60 }
        ];
      }
    },
    getPricingConfig: () => ({
      ...pricingConfig,
      pvPlants: [
        { kwp: 5, commissionedAt: '2023-09-01' },
        { kwp: 50, commissionedAt: '2023-09-20' }
      ]
    }),
    getCurrentDate: () => FIXED_CURRENT_DATE,
    getApplicableValueSummary: () => ({
      getApplicableValueCtKwh({ commissionedAt, kwp }) {
        assert.match(commissionedAt, /^2023-09-/);
        return kwp <= 10 ? 8.2 : 6.8;
      }
    })
  });

  const year = runtime.getSummary({ view: 'year', date: '2026-06-01' });

  assert.equal(year.kpis.weightedApplicableValueCtKwh, 6.93);
  assert.equal(year.meta.marketPremium.configuredPlantCount, 2);
  assert.equal(year.meta.marketPremium.resolvedPlantCount, 2);
});

test('history runtime computes annual market premium from official annual market value and weighted applicable value', () => {
  const runtime = createHistoryRuntime({
    store: {
      listAggregatedEnergySlots() {
        return [
          {
            ts: '2026-01-10T10:00:00.000Z',
            importKwh: 0,
            exportKwh: 1,
            gridKwh: 0,
            pvKwh: 1,
            batteryKwh: 0,
            batteryChargeKwh: 0,
            batteryDischargeKwh: 0,
            loadKwh: 0,
            estimated: false,
            incomplete: false
          },
          {
            ts: '2026-01-10T10:15:00.000Z',
            importKwh: 0,
            exportKwh: 0.5,
            gridKwh: 0,
            pvKwh: 0.5,
            batteryKwh: 0,
            batteryChargeKwh: 0,
            batteryDischargeKwh: 0,
            loadKwh: 0,
            estimated: false,
            incomplete: false
          },
          {
            ts: '2026-01-10T10:30:00.000Z',
            importKwh: 0,
            exportKwh: 0.25,
            gridKwh: 0,
            pvKwh: 0.25,
            batteryKwh: 0,
            batteryChargeKwh: 0,
            batteryDischargeKwh: 0,
            loadKwh: 0,
            estimated: false,
            incomplete: false
          }
        ];
      },
      listPriceSlots() {
        return [
          { ts: '2026-01-10T10:00:00.000Z', priceCtKwh: 6, priceEurMwh: 60 },
          { ts: '2026-01-10T10:15:00.000Z', priceCtKwh: -1, priceEurMwh: -10 },
          { ts: '2026-01-10T10:30:00.000Z', priceCtKwh: 0, priceEurMwh: 0 }
        ];
      }
    },
    getPricingConfig: () => ({
      ...pricingConfig,
      pvPlants: [
        { kwp: 10, commissionedAt: '2021-04-15' },
        { kwp: 5, commissionedAt: '2023-09-01' }
      ]
    }),
    getSolarMarketValueSummary: () => ({
      monthlyCtKwhByMonth: {},
      annualCtKwhByYear: {
        2026: 5.5
      }
    }),
    getCurrentDate: () => FIXED_CURRENT_DATE,
    getApplicableValueSummary: () => ({
      applicableValueCtKwhByMonth: {
        '2021-04': 8.2,
        '2023-09': 7.5
      }
    })
  });

  const year = runtime.getSummary({ view: 'year', date: '2026-06-01' });

  assert.equal(year.kpis.annualMarketValueCtKwh, 5.5);
  assert.equal(year.kpis.weightedApplicableValueCtKwh, 7.97);
  assert.equal(year.kpis.premiumEligibleExportKwh, 1.25);
  assert.equal(year.kpis.marketPremiumEur, 0.03);
});

test('history runtime does not produce market premium when the official annual market value is missing', () => {
  const runtime = createHistoryRuntime({
    store: {
      listAggregatedEnergySlots() {
        return [
          {
            ts: '2026-01-10T10:00:00.000Z',
            importKwh: 0,
            exportKwh: 1,
            gridKwh: 0,
            pvKwh: 1,
            batteryKwh: 0,
            batteryChargeKwh: 0,
            batteryDischargeKwh: 0,
            loadKwh: 0,
            estimated: false,
            incomplete: false
          }
        ];
      },
      listPriceSlots() {
        return [
          { ts: '2026-01-10T10:00:00.000Z', priceCtKwh: 6, priceEurMwh: 60 }
        ];
      }
    },
    getPricingConfig: () => ({
      ...pricingConfig,
      pvPlants: [
        { kwp: 10, commissionedAt: '2021-04-15' }
      ]
    }),
    getSolarMarketValueSummary: () => ({
      monthlyCtKwhByMonth: {
        '2026-01': 5.5
      },
      annualCtKwhByYear: {}
    }),
    getCurrentDate: () => FIXED_CURRENT_DATE,
    getApplicableValueSummary: () => ({
      applicableValueCtKwhByMonth: {
        '2021-04': 8.2
      }
    })
  });

  const year = runtime.getSummary({ view: 'year', date: '2026-06-01' });

  assert.equal(year.kpis.annualMarketValueCtKwh, null);
  assert.equal(year.kpis.weightedApplicableValueCtKwh, 8.2);
  assert.equal(year.kpis.premiumEligibleExportKwh, 1);
  assert.equal(year.kpis.marketPremiumEur, null);
});

test('history summary API validates views and delegates to the runtime', async () => {
  let called = 0;
  let backfillInput = null;
  const handlers = createHistoryApiHandlers({
    historyRuntime: {
      getSummary(input) {
        called += 1;
        return { ok: true, echo: input };
      }
    },
    historyImportManager: {
      async backfillMissingPriceHistory(input) {
        backfillInput = input;
        return { ok: true, requestedDays: 1 };
      }
    },
    telemetryEnabled: true,
    defaultBzn: 'DE-LU',
    appVersion: {
      name: 'dvhub',
      version: '0.2.5',
      revision: 'ea104c9',
      versionLabel: 'v0.2.5+ea104c9'
    }
  });

  const invalid = await handlers.getSummary({ view: 'quarter', date: '2026-03-09' });
  const valid = await handlers.getSummary({ view: 'month', date: '2026-03-09' });
  const backfill = await handlers.postPriceBackfill({ view: 'week', date: '2026-03-09' });

  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /view/i);
  assert.equal(valid.status, 200);
  assert.deepEqual(valid.body.echo, { view: 'month', date: '2026-03-09', solarMarketValues: null });
  assert.equal(valid.body.app.versionLabel, 'v0.2.5+ea104c9');
  assert.equal(backfill.status, 200);
  assert.equal(backfill.body.requestedDays, 1);
  assert.deepEqual(backfillInput, {
    bzn: 'DE-LU',
    start: '2026-03-08T23:00:00.000Z',
    end: '2026-03-15T23:00:00.000Z'
  });
  assert.equal(called, 1);
});

test('history price backfill API without a range delegates bounds selection to the import manager', async () => {
  let backfillInput = null;
  const handlers = createHistoryApiHandlers({
    historyRuntime: {
      getSummary() {
        return { ok: true };
      }
    },
    historyImportManager: {
      async backfillMissingPriceHistory(input) {
        backfillInput = input;
        return { ok: true, requestedDays: 3 };
      }
    },
    telemetryEnabled: true,
    defaultBzn: 'DE-LU'
  });

  const backfill = await handlers.postPriceBackfill({});

  assert.equal(backfill.status, 200);
  assert.equal(backfill.body.requestedDays, 3);
  assert.deepEqual(backfillInput, {
    bzn: 'DE-LU',
    start: null,
    end: null
  });
});
