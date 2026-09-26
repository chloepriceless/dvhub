// Wechselrichter-Wirkungsgrad als Tagesaggregat (Christin 2026-09-27).
//
// Kern der Aufgabe: Monat und Jahr entstehen aus Tageszeilen. Das stimmt nur,
// wenn η energiegewichtet summiert wird (Σ AC / Σ DC) — ein Mittel der
// Tageswerte würde einen kurzen Tag genauso stark zählen wie eine ganze Nacht.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EFFICIENCY_SERIES_KEYS,
  MIN_SECONDS_FOR_VALUE,
  UPSERT_EFFICIENCY_SQL,
  bucketBoundsW,
  createInverterEfficiencyDaily,
  localDateString,
  nominalInverterPowerW,
  summarizeEfficiencyRows,
} from '../services/inverter-efficiency/daily.js';

test('Perioden-η ist energiegewichtet, kein Mittel der Tageswerte', () => {
  const rows = [
    // lange Nacht: 10 kWh AC aus 10,8 kWh DC (92,6 %)
    { bucket: 'base', ac_wh: 10000, dc_wh: 10800, seconds: 30000 },
    // kurzer Tag: 0,5 kWh AC aus 0,7 kWh DC (71,4 %)
    { bucket: 'base', ac_wh: 500, dc_wh: 700, seconds: 1200 },
  ];
  const s = summarizeEfficiencyRows(rows);
  // 10500 / 11500 = 91,3 % — das Tagesmittel wäre (92,6 + 71,4) / 2 = 82,0 %.
  assert.equal(s.base.etaPct, 91.3);
  assert.equal(s.base.acKwh, 10.5);
  assert.equal(s.base.hours, 8.7);
  assert.equal(s.base.enough, true);
  assert.equal(s.base.measurable, true);
});

test('zu wenig Datenbasis → kein Wert', () => {
  const s = summarizeEfficiencyRows([
    { bucket: 'full', ac_wh: 890, dc_wh: 1000, seconds: MIN_SECONDS_FOR_VALUE - 1 },
  ]);
  assert.equal(s.full.enough, false);
  assert.equal(s.full.etaPct, null);
  assert.equal(s.full.measurable, null);
  // Bereich ohne jede Zeile
  assert.equal(s.base.enough, false);
  assert.equal(s.base.hours, 0);
});

test('η ≈ 100 % heißt: Last aus dem Akku-DC abgeleitet → nicht messbar', () => {
  const s = summarizeEfficiencyRows([
    { bucket: 'base', ac_wh: 9990, dc_wh: 10000, seconds: 20000 },
  ]);
  assert.equal(s.base.measurable, false);
});

test('Lastbereiche folgen der Nennleistung', () => {
  assert.equal(nominalInverterPowerW({}), 24000);
  assert.equal(nominalInverterPowerW({ optimizer: { inverterMaxPowerW: 10000 } }), 10000);
  assert.deepEqual(bucketBoundsW({ optimizer: { inverterMaxPowerW: 24000 } }), {
    base: { fromW: 480, toW: 3000 },
    full: { fromW: 18000, toW: null },
  });
});

test('Kalendertag in Anlagen-Zeitzone', () => {
  // 23:30 UTC am 26.09. ist in Berlin schon der 27.09.
  assert.equal(localDateString(new Date('2026-09-26T23:30:00Z'), 'Europe/Berlin'), '2026-09-27');
  assert.equal(localDateString(new Date('2026-09-26T21:30:00Z'), 'Europe/Berlin'), '2026-09-26');
});

function fakeDb({ dayRows = {}, firstDay = null, missing = [] } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('FROM timeseries_samples') && sql.includes('WITH p AS')) {
        return { rows: dayRows[params[0]] || [] };
      }
      if (sql.includes('min(ts_utc)')) return { rows: [{ first_day: firstDay }] };
      if (sql.includes('generate_series')) return { rows: missing.map((day) => ({ day })) };
      return { rows: [] };
    },
  };
}

const upserts = (db) => db.calls.filter((c) => c.sql === UPSERT_EFFICIENCY_SQL).map((c) => c.params);

test('computeDay schreibt immer beide Bereiche — 0-Zeile markiert den Tag als berechnet', async () => {
  const db = fakeDb({
    dayRows: { '2026-09-26': [{ bucket: 'full', ac_wh: 58088, dc_wh: 65413, seconds: 9828, samples: 1907 }] },
  });
  const job = createInverterEfficiencyDaily({
    getDb: () => db,
    getCfg: () => ({ timeZone: 'Europe/Berlin', optimizer: { inverterMaxPowerW: 24000 } }),
  });
  await job.computeDay(db, '2026-09-26');
  const day = db.calls[0];
  assert.deepEqual(day.params, ['2026-09-26', 'Europe/Berlin', EFFICIENCY_SERIES_KEYS, 24000, 0.02, 0.125, 0.75]);
  assert.deepEqual(upserts(db), [
    ['2026-09-26', 'base', 0, 0, 0, 0, 24000],
    ['2026-09-26', 'full', 58088, 65413, 9828, 1907, 24000],
  ]);
});

test('runOnce: heute + Vortag, dann fehlende Tage; Vortag nur einmal pro Tag', async () => {
  const db = fakeDb({ firstDay: '2026-09-01', missing: ['2026-09-24', '2026-09-23'] });
  const job = createInverterEfficiencyDaily({ getDb: () => db, getCfg: () => ({}), maxBackfillDays: 2 });
  const now = new Date('2026-09-26T10:00:00Z');
  const first = await job.runOnce({ now });
  assert.deepEqual(first.computed, ['2026-09-26', '2026-09-25', '2026-09-24', '2026-09-23']);
  const missingQuery = db.calls.find((c) => c.sql.includes('generate_series'));
  assert.deepEqual(missingQuery.params, ['2026-09-01', '2026-09-25', 2]);

  const db2Calls = db.calls.length;
  const second = await job.runOnce({ now: new Date('2026-09-26T11:00:00Z') });
  // Vortag ist schon final — nur heute und (wieder) die Nachholliste.
  assert.equal(second.computed[0], '2026-09-26');
  assert.ok(!second.computed.slice(0, 1).includes('2026-09-25'));
  assert.ok(db.calls.length > db2Calls);
});

test('runOnce ohne Datenbank tut nichts', async () => {
  const job = createInverterEfficiencyDaily({ getDb: () => null, getCfg: () => ({}) });
  assert.deepEqual(await job.runOnce(), { skipped: 'no database' });
});

test('Fehler in der DB bricht den Lauf sauber ab und meldet ihn', async () => {
  const logs = [];
  const job = createInverterEfficiencyDaily({
    getDb: () => ({ async query() { throw new Error('boom'); } }),
    getCfg: () => ({}),
    pushLog: (event, data) => logs.push({ event, data }),
  });
  const res = await job.runOnce({ now: new Date('2026-09-26T10:00:00Z') });
  assert.equal(res.error, 'boom');
  assert.equal(logs[0].event, 'inverter_efficiency_daily_error');
  // Nach dem Fehler ist der Job nicht dauerhaft gesperrt.
  const again = await job.runOnce({ now: new Date('2026-09-26T11:00:00Z') });
  assert.equal(again.error, 'boom');
});
