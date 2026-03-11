import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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

test('telemetry store persists monthly and annual solar market values by key', () => {
  const dbPath = createTempDbPath();
  const store = createTelemetryStore({
    dbPath,
    rawRetentionDays: 30,
    rollupIntervals: [300, 900, 3600]
  });

  try {
    store.upsertSolarMarketValue({
      scope: 'monthly',
      key: '2026-03',
      ctKwh: 5.1,
      source: 'energy_charts'
    });
    store.upsertSolarMarketValue({
      scope: 'annual',
      key: '2025',
      ctKwh: 4.508,
      source: 'energy_charts'
    });

    assert.equal(store.getSolarMarketValue({ scope: 'monthly', key: '2026-03' }).ctKwh, 5.1);
    assert.equal(store.getSolarMarketValue({ scope: 'annual', key: '2025' }).ctKwh, 4.508);
  } finally {
    store.close();
  }
});

test('telemetry store persists solar market value attempt cooldowns by year', () => {
  const store = createTelemetryStore({
    dbPath: createTempDbPath(),
    rawRetentionDays: 30,
    rollupIntervals: [300, 900, 3600]
  });

  try {
    store.markSolarMarketValueAttempt({
      year: 2026,
      attemptedAt: '2026-03-11T06:00:00.000Z',
      status: 'error',
      error: 'HTTP 429',
      cooldownUntil: '2026-03-11T12:00:00.000Z'
    });

    assert.deepEqual(store.getSolarMarketValueAttempt({ year: 2026 }), {
      year: 2026,
      lastAttemptAt: '2026-03-11T06:00:00.000Z',
      cooldownUntil: '2026-03-11T12:00:00.000Z',
      status: 'error',
      error: 'HTTP 429'
    });
  } finally {
    store.close();
  }
});

test('telemetry store detects complete historical solar market value years', () => {
  const store = createTelemetryStore({
    dbPath: createTempDbPath(),
    rawRetentionDays: 30,
    rollupIntervals: [300, 900, 3600]
  });

  try {
    for (let month = 1; month <= 12; month += 1) {
      store.upsertSolarMarketValue({
        scope: 'monthly',
        key: `2025-${String(month).padStart(2, '0')}`,
        ctKwh: month,
        source: 'energy_charts'
      });
    }
    store.upsertSolarMarketValue({
      scope: 'annual',
      key: '2025',
      ctKwh: 4.508,
      source: 'energy_charts'
    });
    store.upsertSolarMarketValue({
      scope: 'monthly',
      key: '2026-01',
      ctKwh: 11.5,
      source: 'energy_charts'
    });

    assert.equal(store.hasCompleteSolarMarketValueYear({ year: 2025 }), true);
    assert.equal(store.hasCompleteSolarMarketValueYear({ year: 2026 }), false);
  } finally {
    store.close();
  }
});

test('telemetry store creates materialized 15 minute slot table with uniqueness by slot series and source', () => {
  const dbPath = createTempDbPath();
  const store = createTelemetryStore({
    dbPath,
    rawRetentionDays: 30,
    rollupIntervals: [300, 900, 3600]
  });

  try {
    assert.ok(store.listTables().includes('energy_slots_15m'));

    const db = new DatabaseSync(dbPath);
    try {
      const columns = db.prepare(`PRAGMA table_info('energy_slots_15m')`).all();
      assert.deepEqual(
        columns.map((column) => column.name),
        [
          'id',
          'slot_start_utc',
          'series_key',
          'source_kind',
          'quality',
          'value_num',
          'unit',
          'meta_json',
          'created_at',
          'updated_at'
        ]
      );

      const uniqueIndexes = db.prepare(`PRAGMA index_list('energy_slots_15m')`).all()
        .filter((index) => Number(index.unique) === 1);
      assert.ok(uniqueIndexes.length >= 1);

      const uniqueColumns = uniqueIndexes.flatMap((index) => db.prepare(`PRAGMA index_info('${index.name}')`).all());
      assert.deepEqual(
        uniqueColumns.map((column) => column.name),
        ['slot_start_utc', 'series_key', 'source_kind']
      );
    } finally {
      db.close();
    }
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

test('telemetry store materializes live samples into the open 15 minute slot', () => {
  const dbPath = createTempDbPath();
  const store = createTelemetryStore({
    dbPath,
    rawRetentionDays: 30,
    rollupIntervals: [900]
  });

  try {
    store.writeSamples([
      {
        seriesKey: 'grid_import_w',
        ts: '2026-03-09T12:02:00.000Z',
        value: 1200,
        scope: 'live',
        source: 'local_poll',
        quality: 'raw',
        resolutionSeconds: 300,
        unit: 'W'
      },
      {
        seriesKey: 'grid_import_w',
        ts: '2026-03-09T12:07:00.000Z',
        value: 1800,
        scope: 'live',
        source: 'local_poll',
        quality: 'raw',
        resolutionSeconds: 300,
        unit: 'W'
      },
      {
        seriesKey: 'grid_export_w',
        ts: '2026-03-09T12:02:00.000Z',
        value: 1200,
        scope: 'live',
        source: 'local_poll',
        quality: 'raw',
        resolutionSeconds: 300,
        unit: 'W'
      },
      {
        seriesKey: 'pv_total_w',
        ts: '2026-03-09T12:02:00.000Z',
        value: 2400,
        scope: 'live',
        source: 'local_poll',
        quality: 'raw',
        resolutionSeconds: 300,
        unit: 'W'
      },
      {
        seriesKey: 'battery_discharge_w',
        ts: '2026-03-09T12:02:00.000Z',
        value: 1200,
        scope: 'live',
        source: 'local_poll',
        quality: 'raw',
        resolutionSeconds: 300,
        unit: 'W'
      },
      {
        seriesKey: 'load_power_w',
        ts: '2026-03-09T12:02:00.000Z',
        value: 3600,
        scope: 'live',
        source: 'local_poll',
        quality: 'raw',
        resolutionSeconds: 300,
        unit: 'W'
      }
    ]);

    const db = new DatabaseSync(dbPath);
    try {
      const rows = db.prepare(`
        SELECT slot_start_utc, series_key, source_kind, quality, value_num, unit
        FROM energy_slots_15m
        WHERE slot_start_utc = '2026-03-09T12:00:00.000Z'
        ORDER BY series_key ASC
      `).all().map((row) => ({ ...row }));

      assert.deepEqual(rows, [
        {
          slot_start_utc: '2026-03-09T12:00:00.000Z',
          series_key: 'battery_discharge_w',
          source_kind: 'local_live',
          quality: 'raw_derived',
          value_num: 0.1,
          unit: 'kWh'
        },
        {
          slot_start_utc: '2026-03-09T12:00:00.000Z',
          series_key: 'grid_export_w',
          source_kind: 'local_live',
          quality: 'raw_derived',
          value_num: 0.1,
          unit: 'kWh'
        },
        {
          slot_start_utc: '2026-03-09T12:00:00.000Z',
          series_key: 'grid_import_w',
          source_kind: 'local_live',
          quality: 'raw_derived',
          value_num: 0.25,
          unit: 'kWh'
        },
        {
          slot_start_utc: '2026-03-09T12:00:00.000Z',
          series_key: 'load_power_w',
          source_kind: 'local_live',
          quality: 'raw_derived',
          value_num: 0.3,
          unit: 'kWh'
        },
        {
          slot_start_utc: '2026-03-09T12:00:00.000Z',
          series_key: 'pv_total_w',
          source_kind: 'local_live',
          quality: 'raw_derived',
          value_num: 0.2,
          unit: 'kWh'
        }
      ]);
    } finally {
      db.close();
    }
  } finally {
    store.close();
  }
});

test('telemetry store prefers vrm materialized slots over local live slots for the same bucket', () => {
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
        ts: '2026-03-09T12:00:00.000Z',
        value: 1600,
        scope: 'history',
        source: 'vrm_import',
        quality: 'backfilled',
        resolutionSeconds: 900,
        unit: 'W'
      }
    ]);

    const [slot] = store.listMaterializedEnergySlots({
      start: '2026-03-09T12:00:00.000Z',
      end: '2026-03-09T12:15:00.000Z'
    });

    assert.equal(slot.importKwh, 0.4);
    assert.equal(slot.sourceKind, 'vrm_import');
    assert.deepEqual(slot.sourceKinds, ['local_live', 'vrm_import']);
  } finally {
    store.close();
  }
});

test('telemetry store falls back to local live materialized slots when vrm data is absent', () => {
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
      }
    ]);

    const [slot] = store.listMaterializedEnergySlots({
      start: '2026-03-09T12:00:00.000Z',
      end: '2026-03-09T12:15:00.000Z'
    });

    assert.equal(slot.importKwh, 0.25);
    assert.equal(slot.sourceKind, 'local_live');
    assert.deepEqual(slot.sourceKinds, ['local_live']);
  } finally {
    store.close();
  }
});
