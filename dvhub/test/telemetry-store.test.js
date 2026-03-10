import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTelemetryStore } from '../telemetry-store.js';

function createTempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-telemetry-'));
  return path.join(dir, 'telemetry.sqlite');
}

test('telemetry store initializes schema and persists records', () => {
  const store = createTelemetryStore({
    dbPath: createTempDbPath(),
    rawRetentionDays: 30,
    rollupIntervals: [300, 900, 3600]
  });

  try {
    const tables = store.listTables();
    assert.ok(tables.includes('timeseries_samples'));
    assert.ok(tables.includes('control_events'));
    assert.ok(tables.includes('optimizer_runs'));

    store.writeSamples([
      {
        seriesKey: 'grid_total_w',
        ts: '2026-03-09T12:00:00.000Z',
        value: 1200,
        scope: 'live',
        source: 'local_poll',
        quality: 'raw',
        resolutionSeconds: 2,
        unit: 'W'
      },
      {
        seriesKey: 'battery_soc_pct',
        ts: '2026-03-09T12:00:00.000Z',
        value: 63.5,
        scope: 'live',
        source: 'local_poll',
        quality: 'raw',
        resolutionSeconds: 2,
        unit: '%'
      }
    ]);

    store.writeControlEvent({
      eventType: 'control_write',
      target: 'gridSetpointW',
      valueNum: -40,
      reason: 'eos_optimization',
      source: 'eos'
    });

    const runId = store.writeOptimizerRun({
      optimizer: 'eos',
      status: 'applied',
      source: 'api',
      inputJson: { snapshot: true },
      resultJson: { gridSetpointW: -40 },
      series: [
        {
          seriesKey: 'grid_setpoint_w',
          scope: 'output',
          ts: '2026-03-09T12:00:00.000Z',
          resolutionSeconds: 3600,
          value: -40,
          unit: 'W'
        }
      ]
    });

    assert.ok(Number.isInteger(runId));
    assert.equal(store.countRows('timeseries_samples'), 2);
    assert.equal(store.countRows('control_events'), 1);
    assert.equal(store.countRows('optimizer_runs'), 1);
    assert.equal(store.countRows('optimizer_run_series'), 1);
  } finally {
    store.close();
  }
});

test('telemetry store creates rollups and keeps status metadata', () => {
  const store = createTelemetryStore({
    dbPath: createTempDbPath(),
    rawRetentionDays: 30,
    rollupIntervals: [300]
  });

  try {
    for (let index = 0; index < 3; index += 1) {
      store.writeSamples([
        {
          seriesKey: 'grid_import_w',
          ts: new Date(Date.UTC(2026, 2, 9, 12, index, 0)).toISOString(),
          value: 1000 + index * 100,
          scope: 'live',
          source: 'local_poll',
          quality: 'raw',
          resolutionSeconds: 60,
          unit: 'W'
        }
      ]);
    }

    const created = store.buildRollups({ now: '2026-03-09T12:05:00.000Z' });
    const status = store.getStatus();

    assert.ok(created.inserted >= 1);
    assert.ok(status.lastWriteAt);
    assert.ok(status.dbPath.endsWith('telemetry.sqlite'));
    assert.equal(store.countRows('timeseries_samples', "scope = 'rollup'"), 1);
  } finally {
    store.close();
  }
});

test('telemetry store finds earliest and latest non-price telemetry timestamps', () => {
  const store = createTelemetryStore({
    dbPath: createTempDbPath(),
    rawRetentionDays: 30,
    rollupIntervals: [900]
  });

  try {
    store.writeSamples([
      {
        seriesKey: 'price_ct_kwh',
        ts: '2026-03-09T11:45:00.000Z',
        value: 4.9,
        scope: 'history',
        source: 'price_backfill',
        quality: 'backfilled',
        resolutionSeconds: 900,
        unit: 'ct/kWh'
      },
      {
        seriesKey: 'grid_import_w',
        ts: '2026-03-09T12:00:00.000Z',
        value: 1000,
        scope: 'live',
        source: 'local_poll',
        quality: 'raw',
        resolutionSeconds: 900,
        unit: 'W'
      },
      {
        seriesKey: 'grid_export_w',
        ts: '2026-03-09T12:15:00.000Z',
        value: 400,
        scope: 'live',
        source: 'local_poll',
        quality: 'raw',
        resolutionSeconds: 900,
        unit: 'W'
      }
    ]);

    assert.deepEqual(store.getTelemetryBounds(), {
      earliest: '2026-03-09T12:00:00.000Z',
      latest: '2026-03-09T12:15:00.000Z'
    });
  } finally {
    store.close();
  }
});

test('telemetry store lists telemetry-backed buckets missing market prices', () => {
  const store = createTelemetryStore({
    dbPath: createTempDbPath(),
    rawRetentionDays: 30,
    rollupIntervals: [900]
  });

  try {
    store.writeSamples([
      {
        seriesKey: 'grid_import_w',
        ts: '2026-03-09T12:00:00.000Z',
        value: 1000,
        scope: 'live',
        source: 'local_poll',
        quality: 'raw',
        resolutionSeconds: 900,
        unit: 'W'
      },
      {
        seriesKey: 'grid_import_w',
        ts: '2026-03-09T12:15:00.000Z',
        value: 800,
        scope: 'live',
        source: 'local_poll',
        quality: 'raw',
        resolutionSeconds: 900,
        unit: 'W'
      },
      {
        seriesKey: 'pv_total_w',
        ts: '2026-03-09T12:30:00.000Z',
        value: 1600,
        scope: 'live',
        source: 'local_poll',
        quality: 'raw',
        resolutionSeconds: 900,
        unit: 'W'
      },
      {
        seriesKey: 'price_ct_kwh',
        ts: '2026-03-09T12:00:00.000Z',
        value: 5.2,
        scope: 'history',
        source: 'price_backfill',
        quality: 'backfilled',
        resolutionSeconds: 900,
        unit: 'ct/kWh'
      }
    ]);

    assert.deepEqual(
      store.listMissingPriceBuckets({
        start: '2026-03-09T12:00:00.000Z',
        end: '2026-03-09T12:45:00.000Z'
      }),
      ['2026-03-09T12:15:00.000Z', '2026-03-09T12:30:00.000Z']
    );
  } finally {
    store.close();
  }
});

test('telemetry store returns aggregated slot rows and joined price slots', () => {
  const store = createTelemetryStore({
    dbPath: createTempDbPath(),
    rawRetentionDays: 30,
    rollupIntervals: [900]
  });

  try {
    store.writeSamples([
      {
        seriesKey: 'grid_import_w',
        ts: '2026-03-09T12:00:00.000Z',
        value: 1000,
        scope: 'live',
        source: 'local_poll',
        quality: 'raw',
        resolutionSeconds: 900,
        unit: 'W'
      },
      {
        seriesKey: 'grid_export_w',
        ts: '2026-03-09T12:15:00.000Z',
        value: 400,
        scope: 'live',
        source: 'local_poll',
        quality: 'raw',
        resolutionSeconds: 900,
        unit: 'W'
      },
      {
        seriesKey: 'pv_total_w',
        ts: '2026-03-09T12:00:00.000Z',
        value: 1600,
        scope: 'live',
        source: 'local_poll',
        quality: 'raw',
        resolutionSeconds: 900,
        unit: 'W'
      },
      {
        seriesKey: 'pv_ac_w',
        ts: '2026-03-09T12:00:00.000Z',
        value: 600,
        scope: 'history',
        source: 'vrm_import',
        quality: 'backfilled',
        resolutionSeconds: 900,
        unit: 'W'
      },
      {
        seriesKey: 'battery_power_w',
        ts: '2026-03-09T12:15:00.000Z',
        value: -300,
        scope: 'live',
        source: 'local_poll',
        quality: 'raw',
        resolutionSeconds: 900,
        unit: 'W'
      },
      {
        seriesKey: 'price_ct_kwh',
        ts: '2026-03-09T12:00:00.000Z',
        value: 5.0,
        scope: 'history',
        source: 'price_backfill',
        quality: 'backfilled',
        resolutionSeconds: 900,
        unit: 'ct/kWh'
      },
      {
        seriesKey: 'price_eur_mwh',
        ts: '2026-03-09T12:00:00.000Z',
        value: 50,
        scope: 'history',
        source: 'price_backfill',
        quality: 'backfilled',
        resolutionSeconds: 900,
        unit: 'EUR/MWh'
      }
    ]);

    const slots = store.listAggregatedEnergySlots({
      start: '2026-03-09T12:00:00.000Z',
      end: '2026-03-09T12:30:00.000Z',
      bucketSeconds: 900
    });

    assert.equal(slots.length, 2);
    assert.equal(slots[0].ts, '2026-03-09T12:00:00.000Z');
    assert.equal(slots[0].importKwh, 0.25);
    assert.equal(slots[0].pvKwh, 0.4);
    assert.equal(slots[0].pvAcKwh, 0.15);
    assert.equal(slots[0].batteryKwh, 0);
    assert.equal(slots[1].ts, '2026-03-09T12:15:00.000Z');
    assert.equal(slots[1].exportKwh, 0.1);
    assert.equal(slots[1].batteryKwh, -0.08);
    assert.deepEqual(store.listPriceSlots({
      start: '2026-03-09T12:00:00.000Z',
      end: '2026-03-09T12:30:00.000Z'
    }), [
      {
        ts: '2026-03-09T12:00:00.000Z',
        priceCtKwh: 5,
        priceEurMwh: 50
      }
    ]);
  } finally {
    store.close();
  }
});

test('telemetry store exposes estimated and incomplete history slot markers', () => {
  const store = createTelemetryStore({
    dbPath: createTempDbPath(),
    rawRetentionDays: 30,
    rollupIntervals: [900]
  });

  try {
    store.writeSamples([
      {
        seriesKey: 'grid_import_w',
        ts: '2026-03-09T12:00:00.000Z',
        value: 1000,
        scope: 'history',
        source: 'vrm_import',
        quality: 'backfilled',
        resolutionSeconds: 900,
        unit: 'W',
        meta: { provenance: 'mapped_from_vrm', vrmCode: 'Gc', incomplete: true }
      },
      {
        seriesKey: 'load_power_w',
        ts: '2026-03-09T12:00:00.000Z',
        value: 1200,
        scope: 'history',
        source: 'vrm_import',
        quality: 'backfilled',
        resolutionSeconds: 900,
        unit: 'W',
        meta: { provenance: 'estimated', derivedFrom: ['grid_import_w'] }
      }
    ]);

    const [slot] = store.listAggregatedEnergySlots({
      start: '2026-03-09T12:00:00.000Z',
      end: '2026-03-09T12:15:00.000Z',
      bucketSeconds: 900
    });

    assert.equal(slot.importKwh, 0.25);
    assert.equal(slot.loadKwh, 0.3);
    assert.equal(slot.estimated, true);
    assert.equal(slot.incomplete, true);
    assert.equal(slot.estimatedSeriesCount, 1);
    assert.equal(slot.incompleteSeriesCount, 1);
  } finally {
    store.close();
  }
});

test('telemetry store can aggregate energy slots for a selected scope only', () => {
  const store = createTelemetryStore({
    dbPath: createTempDbPath(),
    rawRetentionDays: 30,
    rollupIntervals: [900]
  });

  try {
    store.writeSamples([
      {
        seriesKey: 'grid_import_w',
        ts: '2026-03-09T12:00:00.000Z',
        value: 1000,
        scope: 'history',
        source: 'vrm_import',
        quality: 'backfilled',
        resolutionSeconds: 900,
        unit: 'W'
      },
      {
        seriesKey: 'grid_import_w',
        ts: '2026-03-09T12:00:00.000Z',
        value: 2000,
        scope: 'live',
        source: 'local_poll',
        quality: 'raw',
        resolutionSeconds: 900,
        unit: 'W'
      }
    ]);

    const [historySlot] = store.listAggregatedEnergySlots({
      start: '2026-03-09T12:00:00.000Z',
      end: '2026-03-09T12:15:00.000Z',
      bucketSeconds: 900,
      scopes: ['history']
    });
    const [liveSlot] = store.listAggregatedEnergySlots({
      start: '2026-03-09T12:00:00.000Z',
      end: '2026-03-09T12:15:00.000Z',
      bucketSeconds: 900,
      scopes: ['live']
    });

    assert.equal(historySlot.importKwh, 0.25);
    assert.equal(liveSlot.importKwh, 0.5);
  } finally {
    store.close();
  }
});
