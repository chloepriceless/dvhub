// test/history-viz-source-rule.test.js — Historie-Diagramme: eigene Messwerte
// zuerst, VRM füllt auf (Christin 05.11.2026, Entscheidung B). Bis 1.0.9 nahmen
// die Diagramme je Viertelstunde und Reihe immer den VRM-Import.
//
// Teil 1 prüft die drei Abfragen (gemeinsamer Abruf, Jahr/Alle-Bündelung,
// Erlös-Slots), Teil 2 läuft gegen echtes PostgreSQL
// (DVHUB_TEST_PG_URL/DATABASE_URL, sonst übersprungen).
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { createHistoryVizAggregator } from '../services/history-viz/aggregator.js';

const api = (db) => createHistoryVizAggregator({
  getCfg: () => ({ optimizer: { batteryCapacityWh: 10000 } }),
  pushLog() {},
  db,
  telemetryStore: null,
});

const RANK = /CASE WHEN source_kind = 'local_live' AND COALESCE\(.*coverageS.*THEN 0 WHEN source_kind = 'vrm_import' THEN 1 WHEN source_kind = 'local_live' THEN 2/s;

test('alle Quellen-Abfragen der Diagramme ziehen vollstaendige eigene Werte vor', async () => {
  const calls = [];
  const db = { async query(sql, params) { calls.push(String(sql)); return { rows: [] }; } };
  const agg = api(db);
  await agg.getCycles({ view: 'month', date: '2026-06-15' });
  await agg.getCycles({ view: 'year', date: '2026-06-15' });
  await agg.getTop10?.({ view: 'month', date: '2026-06-15' });
  const slotQueries = calls.filter((sql) => /FROM energy_slots_15m/.test(sql) && /DISTINCT ON/.test(sql));
  assert.ok(slotQueries.length >= 2, 'gemeinsamer Abruf und Jahr-Buendelung');
  for (const sql of slotQueries) assert.match(sql, RANK);
  assert.ok(!calls.some((sql) => /CASE source_kind WHEN 'vrm_import' THEN 0/.test(sql)), 'keine VRM-zuerst-Reihenfolge mehr');
});

const URL = process.env.DVHUB_TEST_PG_URL || process.env.DATABASE_URL;
const skip = URL ? false : 'DVHUB_TEST_PG_URL/DATABASE_URL nicht gesetzt';

test('echtes PostgreSQL: lokal vollstaendig → lokal, lokal halb → VRM, alt ohne Abdeckung → VRM', { skip }, async () => {
  const client = new pg.Client({ connectionString: URL });
  await client.connect();
  try {
    await client.query(`CREATE TEMP TABLE energy_slots_15m (slot_start_utc timestamptz, series_key text, source_kind text, unit text, value_num double precision, meta_json text)`);
    const put = (ts, kind, kwh, meta) => client.query(`INSERT INTO energy_slots_15m VALUES ($1, 'battery_discharge_w', $2, 'kWh', $3, $4)`, [ts, kind, kwh, meta]);
    // 10:00 lokal vollstaendig 1 kWh, VRM 2 kWh → 1
    await put('2026-06-10T10:00:00Z', 'local_live', 1, '{"coverageS":900,"samples":180}');
    await put('2026-06-10T10:00:00Z', 'vrm_import', 2, null);
    // 10:15 lokal halb 0,5 kWh, VRM 2 kWh → 2
    await put('2026-06-10T10:15:00Z', 'local_live', 0.5, '{"coverageS":450,"samples":90}');
    await put('2026-06-10T10:15:00Z', 'vrm_import', 2, null);
    // 10:30 alter Slot ohne Abdeckung 1 kWh, VRM 2 kWh → 2 (wie bisher)
    await put('2026-06-10T10:30:00Z', 'local_live', 1, null);
    await put('2026-06-10T10:30:00Z', 'vrm_import', 2, null);
    const db = { query: (text, params) => client.query(text, params) };
    const month = await api(db).getCycles({ view: 'month', date: '2026-06-15' });
    assert.equal(month.status, 200, JSON.stringify(month.body));
    // 1 + 2 + 2 = 5 kWh Entladung bei 10 kWh → 0,5 Zyklen
    assert.equal(month.body.totals.cycles, 0.5);
  } finally {
    await client.end();
  }
});

// Codex 633d1caf (P2): Gewinnen die eigenen Hauptreihen, darf eine VRM-Referenzreihe
// (vrm_solar_yield_w, ohne lokales Gegenstueck) den Slot nicht zum VRM-Slot machen
// und Akku 2 verwerfen.
test('Akku 2 bleibt, wenn die Hauptreihen lokal gewinnen und nur eine VRM-Referenzreihe da ist', async () => {
  const at = new Date('2026-06-10T10:00:00Z');
  const rows = [
    { slot_start_utc: at, series_key: 'battery_discharge_w', value_num: 0.3, source_kind: 'local_live' },
    { slot_start_utc: at, series_key: 'second_battery_discharge_w', value_num: 0.2, source_kind: 'local_live' },
    { slot_start_utc: at, series_key: 'vrm_solar_yield_w', value_num: 1.0, source_kind: 'vrm_import' },
  ];
  const db = { async query(sql) { return { rows: /history-viz shared energy slots/.test(sql) ? rows : [] }; } };
  const stack = await api(db).getStack({ view: 'month', date: '2026-06-15' });
  const sum = (arr) => Math.round(arr.reduce((a, b) => a + (Number(b) || 0), 0) * 1000) / 1000;
  assert.equal(sum(stack.body.batteryDischargeKwh), 0.5, 'Entladung beider Akkus');
  assert.equal(sum(stack.body.secondBatteryDischargeKwh), 0.2, 'Akku 2 nicht verworfen');
});

test('Jahr-Buendelung: VRM-Slot nur ueber die Hauptreihen', async () => {
  const calls = [];
  const db = { async query(sql, params) { calls.push({ sql: String(sql), params }); return { rows: [] }; } };
  await api(db).getCycles({ view: 'year', date: '2026-06-15' });
  const call = calls.find((c) => /vrm_slots AS/.test(c.sql));
  assert.ok(call, 'Jahr-Abfrage');
  assert.match(call.sql, /vrm_slots AS \([^)]*series_key = ANY\(\$5\)/s);
  assert.ok(call.params[4].includes('battery_discharge_w') && !call.params[4].includes('vrm_solar_yield_w'));
});
