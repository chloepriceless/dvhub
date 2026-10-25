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

const BERLIN_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' });
const berlinDayLabel = (ms) => Date.parse(`${BERLIN_DATE.format(new Date(ms))}T00:00:00Z`);

const BUCKET_MS = { '15 minutes': 900_000, '1 hour': 3_600_000, '1 day': 86_400_000 };

function simulatedDb(fixture = FIXTURE) {
  return {
    async query(sql, params) {
      if (!/energy_slots_15m/.test(sql) || !/WITH dedup AS/.test(sql)) return { rows: [] };
      const [seriesKeys, start, end] = params;
      const startMs = Date.parse(start);
      const endMs = Date.parse(end);
      const berlin = /AT TIME ZONE 'Europe\/Berlin'/.test(sql);
      const width = BUCKET_MS[(sql.match(/time_bucket\('([^']+)'/) || [])[1]];
      assert.ok(berlin || width, 'Buendelung erkannt');
      const sums = new Map();
      for (const r of fixture) {
        const ms = Date.parse(r.slot_start_utc);
        if (!seriesKeys.includes(r.series_key) || ms < startMs || ms >= endMs) continue;
        const bucket = berlin ? berlinDayLabel(ms) : Math.floor(ms / width) * width;
        const k = `${r.series_key}|${bucket}`;
        sums.set(k, { key: r.series_key, bucket_ts: new Date(bucket), kwh: (sums.get(k)?.kwh || 0) + r.kwh });
      }
      return { rows: [...sums.values()] };
    }
  };
}

// Preise wie queryBucketedSeries (time_bucket in UTC): je Stunde ein Wert.
function simulatedPriceStore(hourly) {
  return {
    async queryBucketedSeries({ seriesKeys, start, end, bucketInterval }) {
      const width = BUCKET_MS[bucketInterval];
      const groups = new Map();
      for (const [iso, ct] of hourly) {
        const ms = Date.parse(iso);
        if (!seriesKeys.includes('price_ct_kwh') || ms < Date.parse(start) || ms >= Date.parse(end)) continue;
        const b = Math.floor(ms / width) * width;
        const g = groups.get(b) || [];
        g.push(ct);
        groups.set(b, g);
      }
      return [...groups.entries()].map(([b, list]) => {
        const avg = list.reduce((a, c) => a + c, 0) / list.length;
        return { key: 'price_ct_kwh', ts: new Date(b).toISOString(), value: avg, value_avg: avg, resolution: width / 1000 };
      });
    }
  };
}

const api = (db, telemetryStore = null) => createHistoryVizAggregator({ db, getCfg: () => ({ optimizer: { batteryCapacityWh: 10000 } }), pushLog: () => {}, telemetryStore });

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

// Gegenpruefung aa6a1602: alle Karten einer Jahres-/Alle-Ansicht im selben
// Berliner Zeitraum, auch die mit Stunden-Buckets (Sankey, Autarkie).
test('Jahr: Sankey zaehlt Neujahr 00:00–01:00 Berlin mit (wie der Stack)', async () => {
  const fixture = slots('2025-12-31T23:00:00.000Z', 4, 1);
  const res = await api(simulatedDb(fixture)).getSankey({ view: 'year', date: '2026-06-01' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.totals.pvKwh, 4);
  const prev = await api(simulatedDb(fixture)).getSankey({ view: 'year', date: '2025-06-01' });
  assert.equal(prev.body.totals.pvKwh, 0, 'nicht zusaetzlich im Vorjahr');
});

test('Jahr: Autarkie-Kalender ordnet Stunden dem Berliner Tag zu', async () => {
  const fixture = [...slots('2025-12-31T23:00:00.000Z', 4, 1), ...slots('2026-09-30T22:00:00.000Z', 8, 1)];
  const res = await api(simulatedDb(fixture)).getAutarkyCalendar({ view: 'year', date: '2026-06-01' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.matrix.map((cell) => [cell.d, cell.y]), [['2026-01-01', 'Do'], ['2026-10-01', 'Do']]);
});

test('Jahres-Heatmap: Preis-Mittel je Berliner Tag wie die PV', async () => {
  // 30.09. UTC: 00–21 Uhr +1 ct, 22–23 Uhr (= 01.10. 00–02 Berlin) −20 ct;
  // 29.09. 22–23 Uhr und 01.10. 00–23 Uhr UTC +1 ct.
  const hourly = [];
  const hour = (iso, ct) => hourly.push([iso, ct]);
  for (let h = 22; h < 24; h += 1) hour(`2026-09-29T${String(h).padStart(2, '0')}:00:00.000Z`, 1);
  for (let h = 0; h < 24; h += 1) hour(`2026-09-30T${String(h).padStart(2, '0')}:00:00.000Z`, h >= 22 ? -20 : 1);
  for (let h = 0; h < 24; h += 1) hour(`2026-10-01T${String(h).padStart(2, '0')}:00:00.000Z`, 1);
  const res = await api(simulatedDb([]), simulatedPriceStore(hourly)).getHeatmap({ view: 'year', date: '2026-06-01' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const cell = (x, y) => res.body.matrix.find((c) => c.x === x && c.y === y);
  assert.equal(cell('Sep', '30').neg, false, '30.09. Berlin: Mittel +1 ct');
  assert.equal(cell('Okt', '01').neg, true, '01.10. Berlin: (−40 + 22) / 24 < 0');
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
