import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createHistoryImportManager } from '../history-import.js';
import { createTelemetryStore } from '../telemetry-store.js';

function createStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-history-import-'));
  return createTelemetryStore({
    dbPath: path.join(dir, 'telemetry.sqlite')
  });
}

test('history import status reports provider readiness', () => {
  const store = createStore();
  try {
    const manager = createHistoryImportManager({
      store,
      telemetryConfig: {
        historyImport: {
          enabled: true,
          provider: 'vrm',
          vrmPortalId: 'abc123',
          vrmToken: 'secret'
        }
      }
    });

    assert.deepEqual(manager.getStatus(), {
      enabled: true,
      provider: 'vrm',
      ready: true,
      mode: 'vrm_only',
      vrmPortalId: 'abc123'
    });
  } finally {
    store.close();
  }
});

test('manual history import writes backfilled samples and import job metadata', () => {
  const store = createStore();
  try {
    const manager = createHistoryImportManager({
      store,
      telemetryConfig: {
        historyImport: {
          enabled: true,
          provider: 'vrm',
          vrmPortalId: 'abc123',
          vrmToken: 'secret'
        }
      }
    });

    const result = manager.importSamples({
      provider: 'manual',
      requestedFrom: '2026-01-01T00:00:00.000Z',
      requestedTo: '2026-01-02T00:00:00.000Z',
      rows: [
        {
          seriesKey: 'grid_total_w',
          ts: '2026-01-01T00:00:00.000Z',
          value: 400,
          unit: 'W',
          resolutionSeconds: 3600
        }
      ]
    });

    assert.equal(result.ok, true);
    assert.equal(result.importedRows, 1);
    assert.equal(store.countRows('timeseries_samples', "quality = 'backfilled'"), 1);
    assert.equal(store.countRows('import_jobs'), 1);
  } finally {
    store.close();
  }
});

test('configured VRM import fetches official stats endpoints and normalizes rows', async () => {
  const store = createStore();
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const parsed = new URL(url);
    const type = parsed.searchParams.get('type');
    const payloads = {
      venus: {
        records: {
          Pdc: [[Date.UTC(2026, 0, 1, 0, 0, 0), 1200]],
          tsT: [[Date.UTC(2026, 0, 1, 0, 0, 0), 18.5, 17.9, 19.1]]
        }
      },
      consumption: {
        records: {
          Pc: [[Date.UTC(2026, 0, 1, 0, 0, 0), 0.4]],
          Gc: [[Date.UTC(2026, 0, 1, 0, 0, 0), 0.1]]
        }
      },
      kwh: {
        records: {
          Pb: [[Date.UTC(2026, 0, 1, 0, 0, 0), 0.2]]
        }
      }
    };
    return {
      ok: true,
      async json() {
        return payloads[type];
      }
    };
  };

  try {
    const manager = createHistoryImportManager({
      store,
      fetchImpl,
      telemetryConfig: {
        historyImport: {
          enabled: true,
          provider: 'vrm',
          vrmPortalId: '12345',
          vrmToken: 'token123'
        }
      }
    });

    const result = await manager.importFromConfiguredSource({
      start: '2026-01-01T00:00:00.000Z',
      end: '2026-01-01T01:00:00.000Z',
      interval: '15mins'
    });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 3);
    assert.equal(store.countRows('timeseries_samples', "source = 'vrm_import'"), 7);
    assert.equal(store.countRows('timeseries_samples', "series_key = 'pv_dc_w'"), 1);
    assert.equal(store.countRows('import_jobs', "job_type = 'vrm_history_import'"), 1);
  } finally {
    store.close();
  }
});

test('price backfill imports only days with telemetry-backed missing buckets', async () => {
  const store = createStore();
  const calls = [];
  const jan2Noon = Date.UTC(2026, 0, 2, 12, 0, 0);

  store.writeSamples([
    {
      seriesKey: 'grid_import_w',
      ts: '2026-01-01T12:00:00.000Z',
      value: 900,
      scope: 'live',
      source: 'local_poll',
      quality: 'raw',
      resolutionSeconds: 900,
      unit: 'W'
    },
    {
      seriesKey: 'grid_import_w',
      ts: '2026-01-02T12:00:00.000Z',
      value: 1200,
      scope: 'live',
      source: 'local_poll',
      quality: 'raw',
      resolutionSeconds: 900,
      unit: 'W'
    },
    {
      seriesKey: 'price_ct_kwh',
      ts: '2026-01-01T12:00:00.000Z',
      value: 5.1,
      scope: 'history',
      source: 'price_backfill',
      quality: 'backfilled',
      resolutionSeconds: 900,
      unit: 'ct/kWh'
    }
  ]);

  const fetchImpl = async (url) => {
    calls.push(url);
    return {
      ok: true,
      async json() {
        return {
          unix_seconds: [Math.floor(jan2Noon / 1000), Math.floor(Date.UTC(2026, 0, 2, 12, 15, 0) / 1000)],
          price: [44, 47]
        };
      }
    };
  };

  try {
    const manager = createHistoryImportManager({
      store,
      fetchImpl,
      telemetryConfig: {
        historyImport: {
          enabled: true,
          provider: 'vrm',
          vrmPortalId: '12345',
          vrmToken: 'token123'
        }
      }
    });

    const result = await manager.backfillMissingPriceHistory({ bzn: 'DE-LU' });

    assert.equal(calls.length, 1);
    assert.match(calls[0], /start=2026-01-02/);
    assert.match(calls[0], /end=2026-01-03/);
    assert.equal(result.ok, true);
    assert.equal(result.requestedDays, 1);
    assert.equal(result.matchedBuckets, 1);
    assert.equal(store.countRows('timeseries_samples', "source = 'price_backfill'"), 3);
    assert.equal(store.countRows('import_jobs', "job_type = 'price_backfill'"), 1);
  } finally {
    store.close();
  }
});

test('price backfill is idempotent when the same bucket is imported twice', async () => {
  const store = createStore();
  const noon = Date.UTC(2026, 0, 2, 12, 0, 0);

  store.writeSamples([
    {
      seriesKey: 'grid_import_w',
      ts: '2026-01-02T12:00:00.000Z',
      value: 1200,
      scope: 'live',
      source: 'local_poll',
      quality: 'raw',
      resolutionSeconds: 900,
      unit: 'W'
    }
  ]);

  const fetchImpl = async () => ({
    ok: true,
    async json() {
      return {
        unix_seconds: [Math.floor(noon / 1000)],
        price: [44]
      };
    }
  });

  try {
    const manager = createHistoryImportManager({
      store,
      fetchImpl,
      telemetryConfig: {
        historyImport: {
          enabled: true,
          provider: 'vrm',
          vrmPortalId: '12345',
          vrmToken: 'token123'
        }
      }
    });

    const first = await manager.backfillMissingPriceHistory({ bzn: 'DE-LU' });
    const second = await manager.backfillMissingPriceHistory({ bzn: 'DE-LU' });

    assert.equal(first.matchedBuckets, 1);
    assert.equal(second.matchedBuckets, 0);
    assert.equal(store.countRows('timeseries_samples', "source = 'price_backfill'"), 2);
  } finally {
    store.close();
  }
});
