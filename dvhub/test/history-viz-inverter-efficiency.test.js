// History-Karte „Wechselrichter-Wirkungsgrad" (Christin 2026-09-27): liest nur
// das Tagesaggregat und fasst es für Tag/Woche/Monat/Jahr/Alle zusammen.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createHistoryVizAggregator } from '../services/history-viz/aggregator.js';

const ROWS = [
  { day: '2026-08-30', bucket: 'base', ac_wh: 10000, dc_wh: 10800, seconds: 30000 },
  { day: '2026-08-30', bucket: 'full', ac_wh: 0, dc_wh: 0, seconds: 0 },
  { day: '2026-09-16', bucket: 'base', ac_wh: 13544, dc_wh: 14498, seconds: 34848 },
  { day: '2026-09-16', bucket: 'full', ac_wh: 33161, dc_wh: 37329, seconds: 5400 },
  { day: '2026-09-17', bucket: 'base', ac_wh: 12000, dc_wh: 12900, seconds: 33000 },
  { day: '2026-09-17', bucket: 'full', ac_wh: 58088, dc_wh: 65413, seconds: 9828 },
];

function aggregator(db, cfg = { optimizer: { inverterMaxPowerW: 24000 } }) {
  return createHistoryVizAggregator({ getCfg: () => cfg, pushLog() {}, db, telemetryStore: null });
}

function dbFor(rows) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      const [from, to] = params;
      return { rows: rows.filter((r) => r.day >= from && r.day < to) };
    },
  };
}

test('Monat: energiegewichtete Summen, Verlauf je Tag, Datumsgrenzen', async () => {
  const db = dbFor(ROWS);
  const res = await aggregator(db).getInverterEfficiency({ view: 'month', date: '2026-09-20' });
  assert.equal(res.status, 200);
  assert.deepEqual(db.calls[0].params, ['2026-09-01', '2026-10-01']);
  assert.match(db.calls[0].sql, /FROM inverter_efficiency_daily/);
  // Grundlast: (13544 + 12000) / (14498 + 12900) = 93,2 %
  assert.equal(res.body.totals.base.etaPct, 93.2);
  // Volllast: (33161 + 58088) / (37329 + 65413) = 88,8 %
  assert.equal(res.body.totals.full.etaPct, 88.8);
  assert.deepEqual(res.body.series.map((s) => s.period), ['2026-09-16', '2026-09-17']);
  assert.deepEqual(res.body.buckets, { base: { fromW: 480, toW: 3000 }, full: { fromW: 18000, toW: null } });
  assert.equal(res.body.card, 'inverter-efficiency');
});

test('Jahr gruppiert den Verlauf je Monat', async () => {
  const res = await aggregator(dbFor(ROWS)).getInverterEfficiency({ view: 'year', date: '2026-05-01' });
  assert.deepEqual(res.body.series.map((s) => s.period), ['2026-08', '2026-09']);
  // August hat keine Volllast-Daten → null statt 0 %
  assert.equal(res.body.series[0].full, null);
  assert.equal(res.body.series[0].base, 92.6);
});

test('Tag: nur Kennzahlen, kein Verlauf', async () => {
  const res = await aggregator(dbFor(ROWS)).getInverterEfficiency({ view: 'day', date: '2026-09-17' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.series, []);
  assert.equal(res.body.totals.full.etaPct, 88.8);
});

test('ohne Datenbank → 503, ungültige Ansicht → 400', async () => {
  const noDb = await aggregator(null).getInverterEfficiency({ view: 'month', date: '2026-09-01' });
  assert.equal(noDb.status, 503);
  const bad = await aggregator(dbFor(ROWS)).getInverterEfficiency({ view: 'decade', date: '2026-09-01' });
  assert.equal(bad.status, 400);
});

test('zweiter Aufruf kommt aus dem Cache', async () => {
  const db = dbFor(ROWS);
  const agg = aggregator(db);
  await agg.getInverterEfficiency({ view: 'month', date: '2026-08-15' });
  const res = await agg.getInverterEfficiency({ view: 'month', date: '2026-08-15' });
  assert.equal(res.cached, true);
  assert.equal(db.calls.length, 1);
});
