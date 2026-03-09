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
