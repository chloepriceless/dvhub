// test/explorer-day-buckets-local.test.js — Tagesbündel im Explorer nach
// ÖRTLICHEM Datum (Review 25.10.2026).
//
// aggregateSlots bündelte „Tag“ nach dem UTC-Datum (toISOString().slice(0,10)):
// Berlin 00:00–02:00 (Sommerzeit) bzw. 00:00–01:00 zählte zum Vortag. Wie
// leitstand-charts.js (Tagesschlüssel aus getFullYear/getMonth/getDate) gilt
// jetzt der örtliche Tag.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

function loadExplorer() {
  const file = fileURLToPath(new URL('../public/explorer.js', import.meta.url));
  const sandbox = {
    console, Date, Math, Number, JSON, Intl, Set, Map, Promise,
    window: { DVhubCommon: { apiFetch: async () => ({ ok: false, json: async () => ({}) }) }, addEventListener() {} },
    // 'loading' → initExplorer läuft nicht.
    document: { readyState: 'loading', addEventListener() {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    localStorage: { getItem: () => null, setItem() {} },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: path.basename(file) });
  return sandbox;
}

const localDay = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function withTz(tz, fn) {
  const before = process.env.TZ;
  process.env.TZ = tz;
  try { return fn(); } finally {
    if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
  }
}

test('Tagesbündel: Berlin 00:30 (Sommerzeit, 22:30 UTC) zählt zum neuen Tag', () => withTz('Europe/Berlin', () => {
  const explorer = loadExplorer();
  const slots = [
    { ts: '2026-10-24T12:00:00Z', pvKwh: 1 },  // 24.10. 14:00
    { ts: '2026-10-24T22:30:00Z', pvKwh: 2 },  // 25.10. 00:30 (noch Sommerzeit)
    { ts: '2026-10-25T10:00:00Z', pvKwh: 4 },  // 25.10. 11:00 (Winterzeit)
  ];
  const buckets = JSON.parse(JSON.stringify(explorer.aggregateSlots(slots, 'day')));
  const byDay = Object.fromEntries(buckets.map((b) => [localDay(b.ts), b.pvKwh]));
  assert.deepEqual(byDay, { '2026-10-24': 1, '2026-10-25': 6 });
}));

test('Tagesbündel: Winterzeit, 00:15 Ortszeit (23:15 UTC) zählt zum neuen Tag', () => withTz('Europe/Berlin', () => {
  const explorer = loadExplorer();
  const slots = [
    { ts: '2026-12-01T22:45:00Z', pvKwh: 1 },  // 01.12. 23:45
    { ts: '2026-12-01T23:15:00Z', pvKwh: 2 },  // 02.12. 00:15
  ];
  const buckets = JSON.parse(JSON.stringify(explorer.aggregateSlots(slots, 'day')));
  const byDay = Object.fromEntries(buckets.map((b) => [localDay(b.ts), b.pvKwh]));
  assert.deepEqual(byDay, { '2026-12-01': 1, '2026-12-02': 2 });
}));

test('Tagesbündel: Beschriftung zeigt den örtlichen Tag, auch westlich von UTC', () => withTz('America/New_York', () => {
  const explorer = loadExplorer();
  // 25.10. 11:00 in New York. Der alte Schlüssel '2026-10-25' las sich als
  // UTC-Mitternacht = 24.10. 20:00 New York → Beschriftung „24.10.“.
  const buckets = JSON.parse(JSON.stringify(explorer.aggregateSlots([{ ts: '2026-10-25T15:00:00Z', pvKwh: 1 }], 'day')));
  assert.equal(buckets.length, 1);
  assert.equal(localDay(buckets[0].ts), '2026-10-25');
}));
