import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
      vrmPortalId: 'abc123',
      backfillRunning: false
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

test('vrm imports materialize slot rows without deleting existing local live slots', () => {
  const store = createStore();
  try {
    store.writeSamples([
      {
        seriesKey: 'grid_import_w',
        ts: '2026-01-01T00:00:00.000Z',
        value: 1000,
        unit: 'W',
        resolutionSeconds: 900,
        scope: 'live',
        source: 'local_poll',
        quality: 'raw'
      }
    ]);

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
      provider: 'vrm',
      requestedFrom: '2026-01-01T00:00:00.000Z',
      requestedTo: '2026-01-01T00:15:00.000Z',
      rows: [
        {
          seriesKey: 'grid_import_w',
          ts: '2026-01-01T00:00:00.000Z',
          value: 1600,
          unit: 'W',
          resolutionSeconds: 900,
          scope: 'history'
        }
      ]
    });

    assert.equal(result.ok, true);

    const db = new DatabaseSync(store.dbPath);
    try {
      const rows = db.prepare(`
        SELECT slot_start_utc, series_key, source_kind, quality, value_num, unit
        FROM energy_slots_15m
        WHERE slot_start_utc = '2026-01-01T00:00:00.000Z'
          AND series_key = 'grid_import_w'
        ORDER BY source_kind ASC
      `).all().map((row) => ({ ...row }));

      assert.deepEqual(rows, [
        {
          slot_start_utc: '2026-01-01T00:00:00.000Z',
          series_key: 'grid_import_w',
          source_kind: 'local_live',
          quality: 'raw_derived',
          value_num: 0.25,
          unit: 'kWh'
        },
        {
          slot_start_utc: '2026-01-01T00:00:00.000Z',
          series_key: 'grid_import_w',
          source_kind: 'vrm_import',
          quality: 'backfilled',
          value_num: 0.4,
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
    assert.equal(calls.length, 4);
    assert.equal(calls.some((url) => url.includes('api.energy-charts.info/price')), true);
    assert.equal(store.countRows('timeseries_samples', "source = 'vrm_import'"), 17);
    assert.equal(store.countRows('timeseries_samples', "series_key = 'pv_dc_w'"), 1);
    assert.equal(store.countRows('import_jobs', "job_type = 'vrm_history_import'"), 1);
  } finally {
    store.close();
  }
});

test('configured VRM import writes canonical history series from VRM stats payloads', async () => {
  const store = createStore();
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    const type = parsed.searchParams.get('type');
    const payloads = {
      venus: {
        records: {
          Pdc: [[Date.UTC(2026, 0, 1, 0, 0, 0), 1200]]
        }
      },
      consumption: {
        records: {
          Pc: [[Date.UTC(2026, 0, 1, 0, 0, 0), 0.4]],
          Gc: [[Date.UTC(2026, 0, 1, 0, 0, 0), 0.1]],
          Gs: [[Date.UTC(2026, 0, 1, 0, 0, 0), 0.05]]
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
    assert.equal(store.countRows('timeseries_samples', "series_key = 'grid_import_w'"), 1);
    assert.equal(store.countRows('timeseries_samples', "series_key = 'grid_export_w'"), 1);
    assert.equal(store.countRows('timeseries_samples', "series_key = 'pv_total_w'"), 1);
    assert.equal(store.countRows('timeseries_samples', "series_key = 'battery_power_w'"), 1);
    assert.equal(store.countRows('timeseries_samples', "series_key = 'battery_discharge_w'"), 1);
    assert.equal(store.countRows('timeseries_samples', "series_key = 'load_power_w'"), 1);
    assert.equal(
      store.countRows(
        'timeseries_samples',
        `series_key = 'pv_total_w'
         AND meta_json LIKE '%"provenance":"mapped_from_vrm"%'
         AND meta_json LIKE '%"vrmType":"venus"%'
         AND meta_json LIKE '%"vrmCode":"Pdc"%'`
      ),
      1
    );
    assert.equal(store.countRows('timeseries_samples', "series_key LIKE 'vrm_%'"), 5);
  } finally {
    store.close();
  }
});

test('configured VRM import preserves hourly interval and stores extended flow mappings across quarter-hour slots', async () => {
  const store = createStore();
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const parsed = new URL(url);
    const type = parsed.searchParams.get('type');
    const payloads = {
      venus: {
        records: {
          Pdc: [[Date.UTC(2026, 2, 8, 11, 0, 0), 2800]]
        }
      },
      consumption: {
        records: {
          Pc: [[Date.UTC(2026, 2, 8, 11, 0, 0), 0.7]],
          Pb: [[Date.UTC(2026, 2, 8, 11, 0, 0), 0.3]],
          Gc: [[Date.UTC(2026, 2, 8, 11, 0, 0), 0.2]],
          Gb: [[Date.UTC(2026, 2, 8, 11, 0, 0), 0.1]],
          Bc: [[Date.UTC(2026, 2, 8, 11, 0, 0), 0.15]],
          Bg: [[Date.UTC(2026, 2, 8, 11, 0, 0), 0.05]],
          Gs: [[Date.UTC(2026, 2, 8, 11, 0, 0), 0.4]]
        }
      },
      kwh: {
        records: {}
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
      start: '2026-03-08T11:00:00.000Z',
      end: '2026-03-08T12:00:00.000Z',
      interval: 'hours'
    });

    assert.equal(result.ok, true);
    assert.match(calls[0], /interval=hours/);
    assert.equal(store.countRows('timeseries_samples', "series_key = 'solar_direct_use_w'"), 4);
    assert.equal(store.countRows('timeseries_samples', "series_key = 'solar_to_battery_w'"), 4);
    assert.equal(store.countRows('timeseries_samples', "series_key = 'solar_to_grid_w'"), 4);
    assert.equal(store.countRows('timeseries_samples', "series_key = 'grid_direct_use_w'"), 4);
    assert.equal(store.countRows('timeseries_samples', "series_key = 'grid_to_battery_w'"), 4);
    assert.equal(store.countRows('timeseries_samples', "series_key = 'battery_direct_use_w'"), 4);
    assert.equal(store.countRows('timeseries_samples', "series_key = 'battery_to_grid_w'"), 4);
    assert.equal(store.countRows('timeseries_samples', "series_key = 'load_power_w'"), 4);
    assert.equal(store.countRows('timeseries_samples', "series_key = 'grid_import_w'"), 4);
    assert.equal(store.countRows('timeseries_samples', "series_key = 'grid_export_w'"), 4);
    assert.equal(store.countRows('timeseries_samples', "series_key = 'battery_charge_w'"), 4);
    assert.equal(store.countRows('timeseries_samples', "series_key = 'battery_discharge_w'"), 4);
  } finally {
    store.close();
  }
});

test('configured VRM import aligns request ranges to interval boundaries before fetching VRM data', async () => {
  const store = createStore();
  const captured = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    captured.push({
      interval: parsed.searchParams.get('interval'),
      start: new Date(Number(parsed.searchParams.get('start')) * 1000).toISOString(),
      end: new Date(Number(parsed.searchParams.get('end')) * 1000).toISOString(),
      type: parsed.searchParams.get('type')
    });
    return {
      ok: true,
      async json() {
        return {
          records: parsed.searchParams.get('type') === 'venus'
            ? { Pdc: [[Date.parse('2026-03-08T23:00:00.000Z'), 1200]] }
            : {}
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

    const cases = [
      {
        interval: '15mins',
        start: '2026-03-08T23:07:00.000Z',
        end: '2026-03-09T00:02:00.000Z',
        expectedStart: '2026-03-08T23:00:00.000Z',
        expectedEnd: '2026-03-09T00:15:00.000Z'
      },
      {
        interval: 'hours',
        start: '2026-03-08T23:07:00.000Z',
        end: '2026-03-09T00:02:00.000Z',
        expectedStart: '2026-03-08T23:00:00.000Z',
        expectedEnd: '2026-03-09T01:00:00.000Z'
      },
      {
        interval: 'days',
        start: '2026-03-08T11:07:00.000Z',
        end: '2026-03-08T12:02:00.000Z',
        expectedStart: '2026-03-08T00:00:00.000Z',
        expectedEnd: '2026-03-09T00:00:00.000Z'
      }
    ];

    for (const testCase of cases) {
      captured.length = 0;
      const result = await manager.importFromConfiguredSource({
        start: testCase.start,
        end: testCase.end,
        interval: testCase.interval
      });
      assert.equal(result.ok, true);
      assert.deepEqual(
        captured.map((entry) => ({
          interval: entry.interval,
          start: entry.start,
          end: entry.end
        })),
        [
          { interval: testCase.interval, start: testCase.expectedStart, end: testCase.expectedEnd },
          { interval: testCase.interval, start: testCase.expectedStart, end: testCase.expectedEnd },
          { interval: testCase.interval, start: testCase.expectedStart, end: testCase.expectedEnd }
        ]
      );
    }
  } finally {
    store.close();
  }
});

test('configured VRM import derives pv totals for AC coupled PV from Pc Pb and Pg flows', async () => {
  const store = createStore();
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    const type = parsed.searchParams.get('type');
    const payloads = {
      venus: { records: {} },
      consumption: {
        records: {
          Pc: [[Date.UTC(2026, 2, 8, 11, 0, 0), 0.7]],
          Pb: [[Date.UTC(2026, 2, 8, 11, 0, 0), 0.3]],
          Pg: [[Date.UTC(2026, 2, 8, 11, 0, 0), 0.4]]
        }
      },
      kwh: { records: {} }
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
      start: '2026-03-08T11:00:00.000Z',
      end: '2026-03-08T12:00:00.000Z',
      interval: '15mins'
    });
    const [slot] = store.listAggregatedEnergySlots({
      start: '2026-03-08T11:00:00.000Z',
      end: '2026-03-08T11:15:00.000Z',
      bucketSeconds: 900,
      scopes: ['history']
    });

    assert.equal(result.ok, true);
    assert.equal(store.countRows('timeseries_samples', "series_key = 'solar_to_grid_w'"), 1);
    assert.equal(store.countRows('timeseries_samples', "series_key = 'grid_export_w'"), 1);
    assert.equal(store.countRows('timeseries_samples', "series_key = 'pv_total_w'"), 1);
    assert.equal(slot.solarToGridKwh, 0.4);
    assert.equal(slot.exportKwh, 0.4);
    assert.equal(slot.pvKwh, 1.4);
  } finally {
    store.close();
  }
});

test('configured VRM import adds AC coupled PV power from venus Pac to pv totals', async () => {
  const store = createStore();
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    const type = parsed.searchParams.get('type');
    const payloads = {
      venus: {
        records: {
          Pdc: [[Date.UTC(2026, 2, 8, 11, 0, 0), 1200]],
          Pac: [[Date.UTC(2026, 2, 8, 11, 0, 0), 800]]
        }
      },
      consumption: { records: {} },
      kwh: { records: {} }
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
      start: '2026-03-08T11:00:00.000Z',
      end: '2026-03-08T12:00:00.000Z',
      interval: '15mins'
    });
    const [slot] = store.listAggregatedEnergySlots({
      start: '2026-03-08T11:00:00.000Z',
      end: '2026-03-08T11:15:00.000Z',
      bucketSeconds: 900,
      scopes: ['history']
    });

    assert.equal(result.ok, true);
    assert.equal(store.countRows('timeseries_samples', "series_key = 'pv_ac_w'"), 1);
    assert.equal(store.countRows('timeseries_samples', "series_key = 'pv_dc_w'"), 1);
    assert.equal(store.countRows('timeseries_samples', "series_key = 'pv_total_w'"), 1);
    assert.equal(slot.pvKwh, 0.5);
  } finally {
    store.close();
  }
});

test('history import reconstructs missing load and keeps incomplete slots visible', async () => {
  const store = createStore();
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    const type = parsed.searchParams.get('type');
    const payloads = {
      venus: {
        records: {
          Pdc: [
            [Date.UTC(2026, 0, 1, 0, 0, 0), 1200]
          ]
        }
      },
      consumption: {
        records: {
          Gc: [
            [Date.UTC(2026, 0, 1, 0, 0, 0), 0.1],
            [Date.UTC(2026, 0, 1, 0, 15, 0), 0.08]
          ],
          Gs: [
            [Date.UTC(2026, 0, 1, 0, 0, 0), 0.02]
          ]
        }
      },
      kwh: {
        records: {
          Pb: [
            [Date.UTC(2026, 0, 1, 0, 0, 0), -0.04]
          ]
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
      end: '2026-01-01T00:30:00.000Z',
      interval: '15mins'
    });

    const slots = store.listAggregatedEnergySlots({
      start: '2026-01-01T00:00:00.000Z',
      end: '2026-01-01T00:30:00.000Z',
      bucketSeconds: 900
    });

    assert.equal(result.ok, true);
    assert.equal(
      store.countRows(
        'timeseries_samples',
        `series_key = 'load_power_w'
         AND meta_json LIKE '%"provenance":"estimated"%'
         AND meta_json LIKE '%"pv_total_w"%'
         AND meta_json LIKE '%"battery_discharge_w"%'
         AND meta_json LIKE '%"grid_import_w"%'
         AND meta_json LIKE '%"grid_export_w"%'
         AND meta_json LIKE '%"battery_charge_w"%'`
      ),
      1
    );
    assert.equal(slots.length, 2);
    assert.equal(slots[0].loadKwh, 0.34);
    assert.equal(slots[0].estimated, true);
    assert.equal(slots[0].incomplete, false);
    assert.equal(slots[1].importKwh, 0.08);
    assert.equal(slots[1].estimated, false);
    assert.equal(slots[1].incomplete, true);
  } finally {
    store.close();
  }
});

test('configured VRM import stores VRM reference blocks and normalizes slot flows to VRM anchors', async () => {
  const store = createStore();
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    const type = parsed.searchParams.get('type');
    const payloads = {
      venus: {
        records: {
          solar_yield: [[Date.UTC(2026, 2, 8, 11, 0, 0), 2000]],
          consumption: [[Date.UTC(2026, 2, 8, 11, 0, 0), 2400]],
          from_to_grid: [[Date.UTC(2026, 2, 8, 11, 0, 0), 400]]
        }
      },
      consumption: {
        records: {}
      },
      kwh: {
        records: {
          Pc: [[Date.UTC(2026, 2, 8, 11, 0, 0), 0.2]],
          Gc: [[Date.UTC(2026, 2, 8, 11, 0, 0), 0.1]],
          Bc: [[Date.UTC(2026, 2, 8, 11, 0, 0), 0.3]]
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
      start: '2026-03-08T11:00:00.000Z',
      end: '2026-03-08T11:15:00.000Z',
      interval: '15mins'
    });
    const [slot] = store.listAggregatedEnergySlots({
      start: '2026-03-08T11:00:00.000Z',
      end: '2026-03-08T11:15:00.000Z',
      bucketSeconds: 900,
      scopes: ['history']
    });

    assert.equal(result.ok, true);
    assert.equal(store.countRows('timeseries_samples', "series_key = 'vrm_solar_yield_w'"), 1);
    assert.equal(store.countRows('timeseries_samples', "series_key = 'vrm_site_consumption_w'"), 1);
    assert.equal(store.countRows('timeseries_samples', "series_key = 'vrm_grid_import_ref_w'"), 1);
    assert.equal(slot.pvKwh, 0.5);
    assert.equal(slot.loadKwh, 0.6);
    assert.equal(slot.importKwh, 0.1);
    assert.equal(slot.exportKwh, 0);
    assert.equal(slot.solarDirectUseKwh, 0.5);
    assert.equal(slot.gridDirectUseKwh, 0.1);
    assert.equal(slot.batteryDirectUseKwh, 0);
    assert.equal(slot.batteryDischargeKwh, 0);
  } finally {
    store.close();
  }
});

test('configured VRM import uses VRM export anchor to normalize solar-to-grid flow blocks', async () => {
  const store = createStore();
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    const type = parsed.searchParams.get('type');
    const payloads = {
      venus: {
        records: {
          solar_yield: [[Date.UTC(2026, 2, 8, 12, 0, 0), 3200]],
          consumption: [[Date.UTC(2026, 2, 8, 12, 0, 0), 800]],
          from_to_grid: [[Date.UTC(2026, 2, 8, 12, 0, 0), -2400]]
        }
      },
      consumption: {
        records: {}
      },
      kwh: {
        records: {
          Pc: [[Date.UTC(2026, 2, 8, 12, 0, 0), 0.1]],
          Pg: [[Date.UTC(2026, 2, 8, 12, 0, 0), 0.1]]
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
      start: '2026-03-08T12:00:00.000Z',
      end: '2026-03-08T12:15:00.000Z',
      interval: '15mins'
    });
    const [slot] = store.listAggregatedEnergySlots({
      start: '2026-03-08T12:00:00.000Z',
      end: '2026-03-08T12:15:00.000Z',
      bucketSeconds: 900,
      scopes: ['history']
    });

    assert.equal(result.ok, true);
    assert.equal(store.countRows('timeseries_samples', "series_key = 'vrm_grid_export_ref_w'"), 1);
    assert.equal(slot.pvKwh, 0.8);
    assert.equal(slot.loadKwh, 0.2);
    assert.equal(slot.importKwh, 0);
    assert.equal(slot.exportKwh, 0.6);
    assert.equal(slot.solarDirectUseKwh, 0.2);
    assert.equal(slot.solarToGridKwh, 0.6);
    assert.equal(slot.batteryToGridKwh, 0);
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

test('price backfill batches contiguous missing days into one Energy Charts request', async () => {
  const store = createStore();
  const calls = [];

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
    }
  ]);

  const fetchImpl = async (url) => {
    calls.push(url);
    return {
      ok: true,
      async json() {
        return {
          unix_seconds: [
            Math.floor(Date.UTC(2026, 0, 1, 12, 0, 0) / 1000),
            Math.floor(Date.UTC(2026, 0, 2, 12, 0, 0) / 1000)
          ],
          price: [40, 44]
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

    const result = await manager.backfillMissingPriceHistory({
      bzn: 'DE-LU',
      start: '2026-01-01T00:00:00.000Z',
      end: '2026-01-03T00:00:00.000Z'
    });

    assert.equal(calls.length, 1);
    assert.match(calls[0], /start=2026-01-01/);
    assert.match(calls[0], /end=2026-01-03/);
    assert.equal(result.ok, true);
    assert.equal(result.requestedDays, 2);
    assert.equal(result.matchedBuckets, 2);
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

test('price backfill returns a structured error when an Energy Charts day request fails', async () => {
  const store = createStore();

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
    ok: false,
    status: 500,
    async json() {
      return {};
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

    const result = await manager.backfillMissingPriceHistory({
      bzn: 'DE-LU',
      start: '2026-01-02T00:00:00.000Z',
      end: '2026-01-03T00:00:00.000Z'
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /2026-01-02/);
    assert.match(result.error, /HTTP 500/);
  } finally {
    store.close();
  }
});

test('price backfill retries a day after HTTP 429 and still imports the requested buckets', async () => {
  const store = createStore();
  let calls = 0;

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

  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        ok: false,
        status: 429,
        async json() {
          return {};
        }
      };
    }
    return {
      ok: true,
      async json() {
        return {
          unix_seconds: [Math.floor(Date.UTC(2026, 0, 2, 12, 0, 0) / 1000)],
          price: [44]
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

    const result = await manager.backfillMissingPriceHistory({
      bzn: 'DE-LU',
      start: '2026-01-02T00:00:00.000Z',
      end: '2026-01-03T00:00:00.000Z'
    });

    assert.equal(calls, 2);
    assert.equal(result.ok, true);
    assert.equal(result.partial, false);
    assert.equal(result.requestedDays, 1);
    assert.equal(result.matchedBuckets, 1);
    assert.deepEqual(result.openDays, []);
    assert.equal(store.countRows('timeseries_samples', "source = 'price_backfill'"), 2);
  } finally {
    store.close();
  }
});

test('price backfill reports partial success when one day fails but previous days were imported', async () => {
  const store = createStore();
  const calls = [];

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
      ts: '2026-01-10T12:00:00.000Z',
      value: 1200,
      scope: 'live',
      source: 'local_poll',
      quality: 'raw',
      resolutionSeconds: 900,
      unit: 'W'
    }
  ]);

  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('start=2026-01-10')) {
      return {
        ok: false,
        status: 429,
        async json() {
          return {};
        }
      };
    }
    return {
      ok: true,
      async json() {
          return {
            unix_seconds: [Math.floor(Date.UTC(2026, 0, 1, 12, 0, 0) / 1000)],
            price: [40]
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

      const result = await manager.backfillMissingPriceHistory({
        bzn: 'DE-LU',
        start: '2026-01-01T00:00:00.000Z',
        end: '2026-01-11T00:00:00.000Z'
      });

      assert.equal(calls.length, 4);
      assert.equal(result.ok, true);
      assert.equal(result.partial, true);
      assert.equal(result.requestedDays, 2);
      assert.equal(result.matchedBuckets, 1);
      assert.equal(result.importedRows, 2);
      assert.deepEqual(result.openDays, ['2026-01-10']);
      assert.match(result.error, /2026-01-10/);
      assert.equal(store.countRows('timeseries_samples', "source = 'price_backfill'"), 2);
  } finally {
    store.close();
  }
});

test('configured VRM import backfills missing prices for the imported range', async () => {
  const store = createStore();
  const jan2Noon = Date.UTC(2026, 0, 2, 12, 0, 0);
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const parsed = new URL(url);
    if (parsed.hostname === 'api.energy-charts.info') {
      return {
        ok: true,
        async json() {
          return {
            unix_seconds: [Math.floor(jan2Noon / 1000)],
            price: [44]
          };
        }
      };
    }
    const type = parsed.searchParams.get('type');
    const payloads = {
      venus: {
        records: {
          Pdc: [[jan2Noon, 800]]
        }
      },
      consumption: {
        records: {
          Pg: [[jan2Noon, 0.25]]
        }
      },
      kwh: {
        records: {}
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
      start: '2026-01-02T12:00:00.000Z',
      end: '2026-01-02T12:15:00.000Z',
      interval: '15mins'
    });

    assert.equal(result.ok, true);
    assert.equal(store.countRows('timeseries_samples', "source = 'price_backfill'"), 2);
    assert.equal(store.countRows('import_jobs', "job_type = 'price_backfill'"), 1);
    assert.equal(calls.some((url) => url.includes('api.energy-charts.info/price')), true);
  } finally {
    store.close();
  }
});

test('configured VRM import collapses off-quarter VRM samples into one final 15-minute slot', async () => {
  const store = createStore();
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    const type = parsed.searchParams.get('type');
    const payloads = {
      venus: {
        records: {
          Pdc: [
            [Date.UTC(2026, 2, 9, 0, 0, 0), 1200],
            [Date.UTC(2026, 2, 9, 0, 3, 0), 1200],
            [Date.UTC(2026, 2, 9, 0, 9, 0), 1200]
          ]
        }
      },
      consumption: { records: {} },
      kwh: { records: {} }
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
      start: '2026-03-09T00:00:00.000Z',
      end: '2026-03-09T00:15:00.000Z',
      interval: '15mins'
    });
    const slots = store.listAggregatedEnergySlots({
      start: '2026-03-09T00:00:00.000Z',
      end: '2026-03-09T00:15:00.000Z',
      bucketSeconds: 900,
      scopes: ['history']
    });

    assert.equal(result.ok, true);
    assert.equal(store.countRows('timeseries_samples', "series_key = 'pv_total_w'"), 1);
    assert.equal(slots.length, 1);
    assert.equal(slots[0].ts, '2026-03-09T00:00:00.000Z');
    assert.equal(slots[0].pvKwh, 0.3);
  } finally {
    store.close();
  }
});

test('VRM backfill job walks chunked windows until repeated empty history and waits between windows', async () => {
  const store = createStore();
  const waits = [];
  const requests = [];
  const windowsWithData = new Set([
    '2026-03-03T00:00:00.000Z|2026-03-04T00:00:00.000Z',
    '2026-03-02T00:00:00.000Z|2026-03-03T00:00:00.000Z'
  ]);
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    const type = parsed.searchParams.get('type');
    const start = new Date(Number(parsed.searchParams.get('start')) * 1000).toISOString();
    const end = new Date(Number(parsed.searchParams.get('end')) * 1000).toISOString();
    const key = `${start}|${end}`;
    requests.push(`${type}:${key}`);
    const hasData = windowsWithData.has(key);
    return {
      ok: true,
      async json() {
        return hasData && type === 'venus'
          ? {
            records: {
              Pdc: [[Date.parse(start), 1000]]
            }
          }
          : { records: {} };
      }
    };
  };

  try {
    const manager = createHistoryImportManager({
      store,
      fetchImpl,
      waitImpl: async (ms) => {
        waits.push(ms);
      },
      telemetryConfig: {
        historyImport: {
          enabled: true,
          provider: 'vrm',
          vrmPortalId: '12345',
          vrmToken: 'token123'
        }
      }
    });

    const result = await manager.backfillHistoryFromConfiguredSource({
      mode: 'full',
      now: '2026-03-05T00:00:00.000Z',
      chunkDays: 1,
      delayMs: 50,
      maxEmptyWindows: 2
    });

    assert.equal(result.ok, true);
    assert.equal(result.partial, false);
    assert.equal(result.windowsVisited, 5);
    assert.equal(result.importedWindows, 2);
    assert.equal(result.emptyWindows, 3);
    assert.equal(result.importedRows > 0, true);
    assert.equal(store.countRows('timeseries_samples', "series_key = 'pv_total_w'"), 2);
    assert.equal(store.countRows('import_jobs', "job_type = 'vrm_history_full_backfill'"), 1);
    assert.deepEqual(waits, [50, 50, 50]);
    assert.equal(requests.length, 15);
  } finally {
    store.close();
  }
});

test('VRM full backfill continues past initial empty windows and can still find older VRM data', async () => {
  const store = createStore();
  const waits = [];
  const windowsWithData = new Set([
    '2026-03-02T00:00:00.000Z|2026-03-03T00:00:00.000Z'
  ]);
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    const type = parsed.searchParams.get('type');
    const start = new Date(Number(parsed.searchParams.get('start')) * 1000).toISOString();
    const end = new Date(Number(parsed.searchParams.get('end')) * 1000).toISOString();
    const key = `${start}|${end}`;
    const hasData = windowsWithData.has(key);
    return {
      ok: true,
      async json() {
        return hasData && type === 'venus'
          ? {
            records: {
              Pdc: [[Date.parse(start), 1000]]
            }
          }
          : { records: {} };
      }
    };
  };

  try {
    const manager = createHistoryImportManager({
      store,
      fetchImpl,
      waitImpl: async (ms) => {
        waits.push(ms);
      },
      telemetryConfig: {
        historyImport: {
          enabled: true,
          provider: 'vrm',
          vrmPortalId: '12345',
          vrmToken: 'token123'
        }
      }
    });

    const result = await manager.backfillHistoryFromConfiguredSource({
      mode: 'full',
      now: '2026-03-05T00:00:00.000Z',
      chunkDays: 1,
      delayMs: 50,
      maxEmptyWindows: 2,
      maxLookbackDays: 10
    });

    assert.equal(result.ok, true);
    assert.equal(result.importedWindows, 1);
    assert.equal(result.importedRows > 0, true);
    assert.equal(result.windowsVisited, 5);
    assert.equal(result.emptyWindows, 4);
    assert.deepEqual(waits, [50, 50]);
  } finally {
    store.close();
  }
});

test('VRM full backfill falls back to days interval when 15mins returns no rows', async () => {
  const store = createStore();
  const seenIntervals = [];
  const windowsWithData = new Set([
    '2026-03-02T00:00:00.000Z|2026-03-03T00:00:00.000Z'
  ]);

  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    const type = parsed.searchParams.get('type');
    const interval = parsed.searchParams.get('interval');
    const start = new Date(Number(parsed.searchParams.get('start')) * 1000).toISOString();
    const end = new Date(Number(parsed.searchParams.get('end')) * 1000).toISOString();
    const key = `${start}|${end}`;
    seenIntervals.push(interval);

    const hasData = interval === 'days' && windowsWithData.has(key);
    return {
      ok: true,
      async json() {
        return hasData && type === 'venus'
          ? {
            records: {
              Pdc: [[Date.parse(start), 1000]]
            }
          }
          : { records: {} };
      }
    };
  };

  try {
    const manager = createHistoryImportManager({
      store,
      fetchImpl,
      waitImpl: async () => {},
      telemetryConfig: {
        historyImport: {
          enabled: true,
          provider: 'vrm',
          vrmPortalId: '12345',
          vrmToken: 'token123'
        }
      }
    });

    const result = await manager.backfillHistoryFromConfiguredSource({
      mode: 'full',
      now: '2026-03-05T00:00:00.000Z',
      chunkDays: 1,
      maxEmptyWindows: 2,
      maxLookbackDays: 10,
      interval: '15mins'
    });

    assert.equal(result.ok, true);
    assert.equal(result.importedWindows, 1);
    assert.equal(result.importedRows > 0, true);
    assert.equal(seenIntervals.includes('15mins'), true);
    assert.equal(seenIntervals.includes('days'), true);
  } finally {
    store.close();
  }
});

test('VRM full backfill aligns windows to UTC day boundaries even from a mid-day now', async () => {
  const store = createStore();
  const venusRequests = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    const type = parsed.searchParams.get('type');
    const start = new Date(Number(parsed.searchParams.get('start')) * 1000).toISOString();
    const end = new Date(Number(parsed.searchParams.get('end')) * 1000).toISOString();
    if (type === 'venus') venusRequests.push(`${start}|${end}`);
    return {
      ok: true,
      async json() {
        return { records: {} };
      }
    };
  };

  try {
    const manager = createHistoryImportManager({
      store,
      fetchImpl,
      waitImpl: async () => {},
      telemetryConfig: {
        historyImport: {
          enabled: true,
          provider: 'vrm',
          vrmPortalId: '12345',
          vrmToken: 'token123'
        }
      }
    });

    const result = await manager.backfillHistoryFromConfiguredSource({
      mode: 'full',
      now: '2026-03-05T11:55:30.047Z',
      chunkDays: 1,
      maxEmptyWindows: 2,
      maxLookbackDays: 2,
      allowIntervalFallback: false
    });

    assert.equal(result.ok, true);
    assert.deepEqual(venusRequests, [
      '2026-03-04T00:00:00.000Z|2026-03-05T00:00:00.000Z',
      '2026-03-03T00:00:00.000Z|2026-03-04T00:00:00.000Z'
    ]);
    assert.equal(result.requestedTo, '2026-03-05T00:00:00.000Z');
  } finally {
    store.close();
  }
});

test('VRM full backfill forwards requested interval to VRM fetches', async () => {
  const store = createStore();
  const seenIntervals = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    seenIntervals.push(parsed.searchParams.get('interval'));
    return {
      ok: true,
      async json() {
        return { records: {} };
      }
    };
  };

  try {
    const manager = createHistoryImportManager({
      store,
      fetchImpl,
      waitImpl: async () => {},
      telemetryConfig: {
        historyImport: {
          enabled: true,
          provider: 'vrm',
          vrmPortalId: '12345',
          vrmToken: 'token123'
        }
      }
    });

    for (const interval of ['days', 'hours', '15mins']) {
      seenIntervals.length = 0;
      const result = await manager.backfillHistoryFromConfiguredSource({
        mode: 'full',
        now: '2026-03-05T00:00:00.000Z',
        chunkDays: 1,
        maxEmptyWindows: 1,
        maxLookbackDays: 1,
        interval,
        allowIntervalFallback: false
      });
      assert.equal(result.ok, true);
      assert.deepEqual(seenIntervals, [interval, interval, interval]);
    }
  } finally {
    store.close();
  }
});

test('VRM full backfill backfills missing prices for the imported range', async () => {
  const store = createStore();
  const priceDay = Date.UTC(2026, 2, 4, 12, 0, 0);
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const parsed = new URL(url);
    if (parsed.hostname === 'api.energy-charts.info') {
      return {
        ok: true,
        async json() {
          return {
            unix_seconds: [Math.floor(priceDay / 1000)],
            price: [41]
          };
        }
      };
    }
    const type = parsed.searchParams.get('type');
    const start = new Date(Number(parsed.searchParams.get('start')) * 1000).toISOString();
    return {
      ok: true,
      async json() {
        if (type === 'venus' && start === '2026-03-04T00:00:00.000Z') {
          return {
            records: {
              Pdc: [[priceDay, 1200]]
            }
          };
        }
        if (type === 'consumption' && start === '2026-03-04T00:00:00.000Z') {
          return {
            records: {
              Pg: [[priceDay, 0.2]]
            }
          };
        }
        return { records: {} };
      }
    };
  };

  try {
    const manager = createHistoryImportManager({
      store,
      fetchImpl,
      waitImpl: async () => {},
      telemetryConfig: {
        historyImport: {
          enabled: true,
          provider: 'vrm',
          vrmPortalId: '12345',
          vrmToken: 'token123'
        }
      }
    });

    const result = await manager.backfillHistoryFromConfiguredSource({
      mode: 'full',
      now: '2026-03-05T00:00:00.000Z',
      chunkDays: 1,
      maxEmptyWindows: 1,
      interval: '15mins'
    });

    assert.equal(result.ok, true);
    assert.equal(store.countRows('timeseries_samples', "source = 'price_backfill'"), 2);
    assert.equal(store.countRows('import_jobs', "job_type = 'price_backfill'"), 1);
    assert.equal(calls.some((url) => url.includes('api.energy-charts.info/price')), true);
  } finally {
    store.close();
  }
});

test('VRM gap backfill imports only uncovered windows inside the lookback horizon', async () => {
  const store = createStore();
  const waits = [];
  const requests = [];

  store.writeImportJob({
    jobType: 'vrm_history_gap_backfill',
    status: 'completed',
    requestedFrom: '2026-03-04T00:00:00.000Z',
    requestedTo: '2026-03-06T00:00:00.000Z',
    importedRows: 42,
    sourceAccount: '12345'
  });

  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    const type = parsed.searchParams.get('type');
    const start = new Date(Number(parsed.searchParams.get('start')) * 1000).toISOString();
    const end = new Date(Number(parsed.searchParams.get('end')) * 1000).toISOString();
    requests.push(`${type}:${start}|${end}`);
    return {
      ok: true,
      async json() {
        return type === 'venus'
          ? { records: { Pdc: [[Date.parse(start), 1000]] } }
          : { records: {} };
      }
    };
  };

  try {
    const manager = createHistoryImportManager({
      store,
      fetchImpl,
      waitImpl: async (ms) => {
        waits.push(ms);
      },
      telemetryConfig: {
        historyImport: {
          enabled: true,
          provider: 'vrm',
          vrmPortalId: '12345',
          vrmToken: 'token123'
        }
      }
    });

    const result = await manager.backfillHistoryFromConfiguredSource({
      mode: 'gap',
      now: '2026-03-07T00:00:00.000Z',
      lookbackDays: 4,
      chunkDays: 1,
      delayMs: 25
    });

    assert.equal(result.ok, true);
    assert.equal(result.mode, 'gap');
    assert.equal(result.importedWindows, 2);
    assert.equal(store.countRows('import_jobs', "job_type = 'vrm_history_gap_backfill'"), 2);
    assert.deepEqual(waits, [25]);
    assert.deepEqual(
      requests.filter((entry) => entry.startsWith('venus:')),
      [
        'venus:2026-03-03T00:00:00.000Z|2026-03-04T00:00:00.000Z',
        'venus:2026-03-06T00:00:00.000Z|2026-03-07T00:00:00.000Z'
      ]
    );
  } finally {
    store.close();
  }
});

test('automatic VRM backfill stays idle when the lookback horizon is already covered', async () => {
  const store = createStore();
  const requests = [];

  store.writeImportJob({
    jobType: 'vrm_history_gap_backfill',
    status: 'completed',
    requestedFrom: '2026-03-03T00:00:00.000Z',
    requestedTo: '2026-03-10T00:00:00.000Z',
    importedRows: 128,
    sourceAccount: '12345'
  });

  try {
    const manager = createHistoryImportManager({
      store,
      fetchImpl: async (url) => {
        requests.push(url);
        return { ok: true, async json() { return { records: {} }; } };
      },
      telemetryConfig: {
        historyImport: {
          enabled: true,
          provider: 'vrm',
          vrmPortalId: '12345',
          vrmToken: 'token123'
        }
      }
    });

    const result = manager.startAutomaticBackfill({
      now: '2026-03-10T00:00:00.000Z',
      lookbackDays: 7
    });

    assert.deepEqual(result, {
      ok: true,
      started: false
    });
    assert.equal(requests.length, 0);
  } finally {
    store.close();
  }
});

test('automatic VRM backfill ignores a tiny uncovered tail inside the current utc day', async () => {
  const store = createStore();
  const requests = [];

  store.writeImportJob({
    jobType: 'vrm_history_gap_backfill',
    status: 'completed',
    requestedFrom: '2026-03-03T00:00:00.000Z',
    requestedTo: '2026-03-10T00:00:00.000Z',
    importedRows: 64,
    sourceAccount: '12345'
  });

  try {
    const manager = createHistoryImportManager({
      store,
      fetchImpl: async (url) => {
        requests.push(url);
        return { ok: true, async json() { return { records: {} }; } };
      },
      telemetryConfig: {
        historyImport: {
          enabled: true,
          provider: 'vrm',
          vrmPortalId: '12345',
          vrmToken: 'token123'
        }
      }
    });

    const result = manager.startAutomaticBackfill({
      now: '2026-03-10T04:15:00.000Z',
      lookbackDays: 7
    });

    assert.deepEqual(result, {
      ok: true,
      started: false
    });
    assert.equal(requests.length, 0);
  } finally {
    store.close();
  }
});
