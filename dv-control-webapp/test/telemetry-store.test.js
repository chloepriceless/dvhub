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
