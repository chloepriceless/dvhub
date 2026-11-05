// test/telemetry-store-pg-source-rule.test.js — Historie „eigene Messwerte zuerst,
// VRM füllt auf“ (Christin 05.11.2026, Entscheidung B) im PostgreSQL-Speicher.
//
// Teil 1 mit nachgebildeter Datenbank (läuft immer), Teil 2 gegen echtes
// PostgreSQL (DVHUB_TEST_PG_URL/DATABASE_URL, sonst übersprungen): Schreiben
// der Abdeckung über mehrere Pakete, Wahl in listMaterializedEnergySlots (SQL)
// und im Ausweichpfad.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildMaterializedEnergySlotWrites, createTelemetryStorePg, ensurePgSchema } from '../telemetry-store-pg.js';

const T0 = Date.parse('2026-10-21T10:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
function liveSamples(slotStartMs, fromSecond, toSecond, watts, seriesKey = 'grid_import_w') {
  const rows = [];
  for (let s = fromSecond; s < toSecond; s += 5) {
    rows.push({ seriesKey, ts: iso(slotStartMs + s * 1000), value: watts, scope: 'live', source: 'local_poll', quality: 'raw', resolutionSeconds: 5, unit: 'W' });
  }
  return rows;
}
const vrmSample = (slotStartMs, kwh, meta = null, seriesKey = 'grid_import_w') => ({
  seriesKey, ts: iso(slotStartMs), value: kwh * 4000, scope: 'history', source: 'vrm_import', quality: 'backfilled', resolutionSeconds: 900, unit: 'W', meta
});
const rawRow = (scope, res, value, at = iso(T0), seriesKey = 'grid_import_w', meta = null) => ({
  series_key: seriesKey, scope, ts_utc: at, resolution_seconds: res, value_num: value, meta_json: meta
});

function poolReturning(rowsFor) {
  const calls = [];
  return {
    calls,
    connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
    query: async (text, params) => {
      calls.push({ text: String(text), params });
      return { rows: rowsFor(String(text), params) };
    }
  };
}

describe('PG-Store: eigene Messwerte zuerst (nachgebildet)', () => {
  test('Schreiben: eigene Werte tragen Abdeckung und Probenzahl, VRM nicht', () => {
    const writes = buildMaterializedEnergySlotWrites([...liveSamples(T0, 0, 15, 2000), vrmSample(T0, 0.6)]);
    const local = writes.find((w) => w.sourceKind === 'local_live');
    const vrm = writes.find((w) => w.sourceKind === 'vrm_import');
    assert.deepEqual(local.meta, { coverageS: 15, samples: 3 });
    assert.equal(vrm.meta, null);
  });

  test('Schreiben: Abdeckung wird in der Datenbank aufaddiert, nicht ersetzt', async () => {
    const sql = [];
    // INSERT ... RETURNING meldet jede Rohprobe als neu (sonst zaehlt sie nicht).
    const client = {
      query: async (text, params) => {
        sql.push(String(text));
        if (!/INSERT INTO timeseries_samples/.test(String(text))) return { rows: [] };
        return { rows: params[0].map((k, i) => ({ series_key: k, scope: params[1][i], source: params[2][i], quality: params[3][i], ts_utc: params[4][i], resolution_seconds: params[5][i], inserted: true })) };
      },
      release: () => {}
    };
    const pool = { connect: async () => client, query: client.query };
    await createTelemetryStorePg(pool).writeSamples(liveSamples(T0, 0, 15, 2000));
    const accumulate = sql.find((t) => /INSERT INTO energy_slots_15m/.test(t) && /energy_slots_15m\.value_num, 0\) \+/.test(t));
    assert.ok(accumulate, 'Aufaddier-Abfrage');
    assert.match(accumulate, /'coverageS'/);
    assert.match(accumulate, /'samples'/);
  });

  test('listMaterializedEnergySlots: vollstaendige eigene Werte vor der Quellenreihenfolge', async () => {
    const pool = poolReturning(() => []);
    await createTelemetryStorePg(pool).listMaterializedEnergySlots({ start: '2026-10-21T00:00:00Z', end: '2026-10-22T00:00:00Z' });
    const call = pool.calls.find((c) => /GROUP BY slot_start_utc/.test(c.text));
    assert.match(call.text, /ORDER BY CASE WHEN source_kind = 'local_live' AND COALESCE\(.*coverageS/s);
  });

  test('JS-Pivot: lokal vollstaendig → lokal; lokal halb → VRM; lokal fehlt → VRM; alt ohne Abdeckung → VRM', async () => {
    const at = new Date(T0);
    const row = (series, kind, value, meta) => ({ slot_start_utc: at, series_key: series, source_kind: kind, value_num: value, meta_json: meta });
    const pool = poolReturning((text) => (/FROM energy_slots_15m/.test(text)
      ? [
        row('grid_import_w', 'vrm_import', 0.6, '{"incomplete":true}'),
        row('grid_import_w', 'local_live', 0.5, '{"coverageS":900,"samples":180}'),
        row('grid_export_w', 'vrm_import', 0.6, null),
        row('grid_export_w', 'local_live', 0.25, '{"coverageS":450,"samples":90}'),
        row('pv_total_w', 'vrm_import', 0.6, null),
        row('load_power_w', 'vrm_import', 0.6, null),
        row('load_power_w', 'local_live', 0.5, null)
      ]
      : []));
    const [slot] = await createTelemetryStorePg(pool).listMaterializedEnergySlotsJsPivot({ start: '2026-10-21T00:00:00Z', end: '2026-10-22T00:00:00Z' });
    assert.equal(slot.importKwh, 0.5, 'lokal vollstaendig');
    assert.equal(slot.exportKwh, 0.6, 'lokal halb → VRM');
    assert.equal(slot.pvKwh, 0.6, 'lokal fehlt → VRM');
    assert.equal(slot.loadKwh, 0.6, 'alter Slot ohne Abdeckung → bisherige Reihenfolge');
    assert.equal(slot.incomplete, false, 'Kennzeichen des verworfenen VRM-Werts zaehlen nicht');
    assert.equal(slot.sourceKind, 'mixed');
  });

  // Altbefund 21.10.2026 (d257b5b1): der Ausweichpfad mittelte VRM und lokal
  // (0,5 und 0,3 kWh → 0,4). Jetzt EINE Quelle je Reihe, eigene Werte zuerst.
  test('listAggregatedEnergySlots: lokal vollstaendig → lokal, lokal halb → VRM, nie gemittelt', async () => {
    const full = Array.from({ length: 180 }, (_, i) => rawRow('live', 5, 1200, iso(T0 + i * 5000), 'battery_discharge_w'));
    const half = Array.from({ length: 90 }, (_, i) => rawRow('live', 5, 400, iso(T0 + 450000 + i * 5000), 'grid_import_w', '{"incomplete":true}'));
    const pool = poolReturning((text) => (/FROM timeseries_samples/.test(text)
      ? [
        rawRow('history', 900, 2000, iso(T0), 'battery_discharge_w'),
        ...full,
        rawRow('history', 900, 2400, iso(T0), 'grid_import_w'),
        ...half,
        rawRow('live', 900, 1000, iso(T0), 'grid_export_w')
      ]
      : []));
    const [slot] = await createTelemetryStorePg(pool).listAggregatedEnergySlots({ start: '2026-10-21T00:00:00Z', end: '2026-10-22T00:00:00Z' });
    assert.equal(slot.batteryDischargeKwh, 0.3, 'lokal vollstaendig, nicht (0,5 + 0,3) / 2');
    assert.equal(slot.importKwh, 0.6, 'lokal halb → VRM');
    assert.equal(slot.exportKwh, 0.25, 'Reihe nur lokal: lokale Werte');
    assert.equal(slot.incomplete, false, 'Kennzeichen der verworfenen lokalen Werte zaehlen nicht');
  });
});

const URL = process.env.DVHUB_TEST_PG_URL || process.env.DATABASE_URL;
const skip = URL ? false : 'DVHUB_TEST_PG_URL/DATABASE_URL nicht gesetzt';

describe('PG-Store: eigene Messwerte zuerst (echtes PostgreSQL)', { skip }, () => {
  let pool;
  let store;
  before(async () => {
    const pg = await import('pg');
    const setup = new pg.default.Client({ connectionString: URL });
    await setup.connect();
    await setup.query('DROP SCHEMA IF EXISTS source_rule_test CASCADE; CREATE SCHEMA source_rule_test');
    await setup.end();
    pool = new pg.default.Pool({ connectionString: URL, max: 2, options: '-c search_path=source_rule_test' });
    await ensurePgSchema(pool);
    // series_metadata kommt sonst aus Migration 019; writeSamples braucht sie.
    await pool.query('CREATE TABLE IF NOT EXISTS series_metadata (series_key TEXT PRIMARY KEY, source TEXT NOT NULL)');
    store = createTelemetryStorePg(pool);
    const local = [...liveSamples(T0, 0, 900, 2000), ...liveSamples(T0 + 900000, 450, 900, 2000)];
    for (let i = 0; i < local.length; i += 12) await store.writeSamples(local.slice(i, i + 12));
    await store.writeSamples([
      vrmSample(T0, 0.6, { provenance: 'mapped_from_vrm', incomplete: true }),
      vrmSample(T0 + 900000, 0.6),
      vrmSample(T0 + 1800000, 0.6),
      vrmSample(T0 + 2700000, 0.6)
    ]);
    // Slot von vor 1.0.10: eigener Wert ohne Abdeckungsangabe.
    await pool.query(`INSERT INTO energy_slots_15m (slot_start_utc, series_key, source_kind, quality, value_num, unit, meta_json)
      VALUES ($1, 'grid_import_w', 'local_live', 'raw_derived', 0.5, 'kWh', NULL)`, [iso(T0 + 2700000)]);
  });
  after(async () => {
    if (pool) {
      await pool.query('DROP SCHEMA IF EXISTS source_rule_test CASCADE');
      await pool.end();
    }
  });

  test('Abdeckung ueber mehrere Schreibpakete aufaddiert', async () => {
    const { rows } = await pool.query(`SELECT meta_json FROM energy_slots_15m WHERE source_kind = 'local_live' AND meta_json IS NOT NULL ORDER BY slot_start_utc`);
    assert.deepEqual(rows.map((r) => JSON.parse(r.meta_json)), [{ coverageS: 900, samples: 180 }, { coverageS: 450, samples: 90 }]);
  });

  test('listMaterializedEnergySlots: vollstaendig lokal, halb → VRM, fehlt → VRM, alt → VRM', async () => {
    const slots = await store.listMaterializedEnergySlots({ start: iso(T0), end: iso(T0 + 3600000) });
    assert.deepEqual(slots.map((s) => Math.round(s.importKwh * 1000) / 1000), [0.5, 0.6, 0.6, 0.6]);
    assert.deepEqual(slots.map((s) => s.sourceKind), ['local_live', 'vrm_import', 'vrm_import', 'vrm_import']);
    assert.equal(slots[0].incomplete, false);
  });

  test('JS-Pivot waehlt wie die SQL-Abfrage', async () => {
    const sqlSlots = await store.listMaterializedEnergySlots({ start: iso(T0), end: iso(T0 + 3600000) });
    const jsSlots = await store.listMaterializedEnergySlotsJsPivot({ start: iso(T0), end: iso(T0 + 3600000) });
    assert.deepEqual(jsSlots.map((s) => s.importKwh), sqlSlots.map((s) => s.importKwh));
  });

  test('Ausweichpfad aus den Rohdaten waehlt genauso', async () => {
    const slots = await store.listAggregatedEnergySlots({ start: iso(T0), end: iso(T0 + 3600000) });
    assert.deepEqual(slots.map((s) => s.importKwh), [0.5, 0.6, 0.6, 0.6]);
  });
});
