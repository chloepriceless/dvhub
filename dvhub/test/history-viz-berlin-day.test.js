// test/history-viz-berlin-day.test.js -- Jahr/Alle buendeln die 15-min-Energie
// nach BERLINER Kalendertagen (Review 25.10.2026). Vorher time_bucket('1 day')
// in UTC: die ersten 1–2 Stunden eines Berliner Tages (22:00/23:00 UTC des
// Vortags) landeten am Monatsersten im Vormonat, am 1. Januar ausserhalb des
// Jahres und Silvester 23:00 UTC (schon Neujahr) im Dezember.
//
// Teil 1 simuliert die Datenbank: die Abfrage wird nach ihrer Tagesgrenze
// ausgewertet (UTC-Tag bei time_bucket('1 day'), Berliner Tag bei
// AT TIME ZONE 'Europe/Berlin'). Teil 2 laeuft dieselbe Abfrage gegen echtes
// PostgreSQL (nur mit DVHUB_TEST_PG_URL/DATABASE_URL, z. B. CI pg-integration).
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { createHistoryVizAggregator } from '../services/history-viz/aggregator.js';

const slots = (iso, count, kwh, series = ['pv_total_w', 'load_power_w']) => {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const ts = new Date(Date.parse(iso) + i * 900_000).toISOString();
    for (const s of series) out.push({ slot_start_utc: ts, series_key: s, kwh });
  }
  return out;
};

// kWh je 15-min-Slot, PV = Last (dann ist pvDirect = Last).
const FIXTURE = [
  ...slots('2025-06-01T10:00:00.000Z', 1, 1),  // 2025
  ...slots('2025-12-31T23:00:00.000Z', 4, 1),  // Berlin 01.01.2026 00:00–01:00 (MEZ)
  ...slots('2026-06-15T10:00:00.000Z', 1, 2),  // Juni
  ...slots('2026-09-30T22:00:00.000Z', 8, 1),  // Berlin 01.10.2026 00:00–02:00 (MESZ)
  ...slots('2026-12-31T23:00:00.000Z', 4, 1),  // Berlin 01.01.2027 — gehoert nicht zu 2026
  ...slots('2026-09-30T22:00:00.000Z', 8, 1, ['battery_discharge_w']) // Do 01.10. (UTC noch Mi)
];

const utcDayLabel = (ms) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
const BERLIN_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' });
const berlinDayLabel = (ms) => Date.parse(`${BERLIN_DATE.format(new Date(ms))}T00:00:00Z`);

function simulatedDb() {
  return {
    async query(sql, params) {
      if (!/energy_slots_15m/.test(sql) || !/WITH dedup AS/.test(sql)) return { rows: [] };
      const [seriesKeys, start, end] = params;
      const startMs = Date.parse(start);
      const endMs = Date.parse(end);
      const berlin = /AT TIME ZONE 'Europe\/Berlin'/.test(sql);
      assert.ok(berlin || /time_bucket\('1 day'/.test(sql), 'Tagesbuendelung erwartet');
      const sums = new Map();
      for (const r of FIXTURE) {
        const ms = Date.parse(r.slot_start_utc);
        if (!seriesKeys.includes(r.series_key) || ms < startMs || ms >= endMs) continue;
        const day = berlin ? berlinDayLabel(ms) : utcDayLabel(ms);
        const k = `${r.series_key}|${day}`;
        sums.set(k, { key: r.series_key, bucket_ts: new Date(day), kwh: (sums.get(k)?.kwh || 0) + r.kwh });
      }
      return { rows: [...sums.values()] };
    }
  };
}

const api = (db) => createHistoryVizAggregator({ db, getCfg: () => ({ optimizer: { batteryCapacityWh: 10000 } }), pushLog: () => {}, telemetryStore: null });

test('Jahr: Monatserster und Neujahr nach Berliner Tag', async () => {
  const res = await api(simulatedDb()).getStack({ view: 'year', date: '2026-06-01' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const load = res.body.loadKwh;
  assert.equal(load[0], 4, 'Januar: Neujahr 00:00–01:00 Berlin gehoert dazu');
  assert.equal(load[5], 2, 'Juni');
  assert.equal(load[8], 0, 'September: 01.10. 00:00–02:00 Berlin nicht mehr hier');
  assert.equal(load[9], 8, 'Oktober');
  assert.equal(load[11], 0, 'Dezember: 01.01.2027 Berlin nicht dabei');
  assert.equal(load.reduce((a, b) => a + b, 0), 14);
});

test('Alle: Jahresgrenze nach Berliner Tag', async () => {
  const res = await api(simulatedDb()).getStack({ view: 'all', date: '2026-06-01' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.bucketLabels, ['2025', '2026']);
  assert.deepEqual(res.body.loadKwh, [1, 14]);
});

test('Zyklen (Jahr): Wochentag des Berliner Tages', async () => {
  const res = await api(simulatedDb()).getCycles({ view: 'year', date: '2026-06-01' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const byDow = Object.fromEntries(res.body.perDow.map((d) => [d.label, d.dischargedKwh]));
  assert.equal(byDow.Do, 8, '01.10.2026 ist ein Donnerstag');
  assert.equal(byDow.Mi, 0);
});

const URL = process.env.DVHUB_TEST_PG_URL || process.env.DATABASE_URL;
const skip = URL ? false : 'DVHUB_TEST_PG_URL/DATABASE_URL nicht gesetzt';

test('Jahr gegen echtes PostgreSQL: Monatserster und Neujahr nach Berliner Tag', { skip }, async () => {
  const client = new pg.Client({ connectionString: URL });
  await client.connect();
  try {
    await client.query(`CREATE TEMP TABLE energy_slots_15m (slot_start_utc timestamptz, series_key text, source_kind text, unit text, value_num double precision)`);
    for (const r of FIXTURE) {
      await client.query(`INSERT INTO energy_slots_15m VALUES ($1, $2, 'local_live', 'kWh', $3)`, [r.slot_start_utc, r.series_key, r.kwh]);
    }
    const db = { query: (text, params) => client.query(text, params) };
    const year = await api(db).getStack({ view: 'year', date: '2026-06-01' });
    assert.equal(year.status, 200, JSON.stringify(year.body));
    assert.deepEqual(year.body.loadKwh, [4, 0, 0, 0, 0, 2, 0, 0, 0, 8, 0, 0]);
    const all = await api(db).getStack({ view: 'all', date: '2026-06-01' });
    assert.deepEqual(all.body.loadKwh, [1, 14]);
  } finally {
    await client.end();
  }
});
