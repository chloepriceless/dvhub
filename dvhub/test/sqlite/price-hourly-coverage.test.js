// test/sqlite/price-hourly-coverage.test.js -- Stundenpreise gelten fuer alle
// vier Viertelstunden ihrer Stunde (Review 25.10.2026, P2). Vor dem 01.10.2025
// war der Day-Ahead-Preis stuendlich: 24 Zeilen je Tag. Der Preis-Backfill
// stempelte sie trotzdem mit 900 s, und die Slot-Suche fand nur die :00-
// Viertelstunde. Folge: 3 von 4 Slots ohne Marktpreis, Einspeiseerloes ~1/4,
// und der Backfill hielt :15/:30/:45 fuer fehlend und holte sie immer wieder.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTelemetryStore } from '../../telemetry-store.js';
import { createHistoryRuntime } from '../../history-runtime.js';

function createStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-price-hourly-'));
  return createTelemetryStore({ dbPath: path.join(dir, 'telemetry.sqlite'), rawRetentionDays: 30, rollupIntervals: [900] });
}

const price = (ts, ct, { resolutionSeconds = 900, scope = 'history', source = 'price_backfill' } = {}) => ({
  seriesKey: 'price_ct_kwh', ts, value: ct, unit: 'ct/kWh', scope, source,
  quality: scope === 'history' ? 'backfilled' : 'raw', resolutionSeconds
});

const exportSample = (ts, kwh) => ({
  seriesKey: 'grid_export_w', ts, value: kwh * 4000, unit: 'W', scope: 'live', source: 'local_poll', quality: 'raw', resolutionSeconds: 900
});

const quarters = (hourIso) => [0, 15, 30, 45].map((m) => new Date(new Date(hourIso).getTime() + m * 60000).toISOString());

test('listPriceSlots: Stundenpreis (alter 900-s-Stempel) deckt :15/:30/:45 seiner Stunde', () => {
  const store = createStore();
  try {
    store.writeSamples([
      price('2025-06-10T09:00:00.000Z', 10),
      price('2025-06-10T10:00:00.000Z', 20),
      price('2025-06-10T11:00:00.000Z', 30)
    ]);
    const slots = store.listPriceSlots({ start: '2025-06-10T09:00:00.000Z', end: '2025-06-10T12:00:00.000Z' });
    assert.equal(slots.length, 12);
    const byTs = new Map(slots.map((s) => [s.ts, s.priceCtKwh]));
    for (const ts of quarters('2025-06-10T09:00:00.000Z')) assert.equal(byTs.get(ts), 10, ts);
    for (const ts of quarters('2025-06-10T10:00:00.000Z')) assert.equal(byTs.get(ts), 20, ts);
    for (const ts of quarters('2025-06-10T11:00:00.000Z')) assert.equal(byTs.get(ts), 30, ts);

    // Bereich beginnt mitten in der Stunde: der :00-Preis davor zaehlt trotzdem.
    const mid = store.listPriceSlots({ start: '2025-06-10T10:30:00.000Z', end: '2025-06-10T11:30:00.000Z' });
    assert.deepEqual(mid.map((s) => [s.ts, s.priceCtKwh]), [
      ['2025-06-10T10:30:00.000Z', 20],
      ['2025-06-10T10:45:00.000Z', 20],
      ['2025-06-10T11:00:00.000Z', 30],
      ['2025-06-10T11:15:00.000Z', 30]
    ]);
  } finally {
    store.close();
  }
});

test('listPriceSlots: Viertelstundenpreise bleiben je Slot, auch mit falschem 3600-s-Stempel und Luecke', () => {
  const store = createStore();
  try {
    // Live-Zeilen vom 26.03.2026 bis zum epex-fetch-Fix: 15-min-Abstand, Stempel 3600 s.
    store.writeSamples([
      price('2026-03-27T10:00:00.000Z', 1, { resolutionSeconds: 3600, scope: 'forecast', source: 'price_api' }),
      price('2026-03-27T10:15:00.000Z', 2, { resolutionSeconds: 3600, scope: 'forecast', source: 'price_api' }),
      price('2026-03-27T10:30:00.000Z', 3, { resolutionSeconds: 3600, scope: 'forecast', source: 'price_api' }),
      price('2026-03-27T10:45:00.000Z', 4, { resolutionSeconds: 3600, scope: 'forecast', source: 'price_api' }),
      // 11:00-11:45 fehlen; 12:00 folgt im 15-min-Raster weiter.
      price('2026-03-27T12:00:00.000Z', 5, { resolutionSeconds: 900, scope: 'forecast', source: 'price_api' }),
      price('2026-03-27T12:15:00.000Z', 6, { resolutionSeconds: 900, scope: 'forecast', source: 'price_api' })
    ]);
    const slots = store.listPriceSlots({ start: '2026-03-27T10:00:00.000Z', end: '2026-03-27T13:00:00.000Z' });
    assert.deepEqual(slots.map((s) => [s.ts, s.priceCtKwh]), [
      ['2026-03-27T10:00:00.000Z', 1],
      ['2026-03-27T10:15:00.000Z', 2],
      ['2026-03-27T10:30:00.000Z', 3],
      ['2026-03-27T10:45:00.000Z', 4],
      ['2026-03-27T12:00:00.000Z', 5],
      ['2026-03-27T12:15:00.000Z', 6]
    ]);
  } finally {
    store.close();
  }
});

test('listMissingPriceBuckets: Viertelstunden unter einem Stundenpreis gelten als bepreist', () => {
  const store = createStore();
  try {
    store.writeSamples([
      price('2025-06-10T09:00:00.000Z', 10),
      price('2025-06-10T10:00:00.000Z', 20),
      price('2025-06-10T11:00:00.000Z', 30),
      ...quarters('2025-06-10T10:00:00.000Z').map((ts) => exportSample(ts, 0.5)),
      // 15-min-Zeit: Preis nur fuer 14:00 und 14:30 -> 14:15 fehlt wirklich.
      price('2026-03-27T14:00:00.000Z', 1, { scope: 'forecast', source: 'price_api' }),
      price('2026-03-27T14:30:00.000Z', 1, { scope: 'forecast', source: 'price_api' }),
      exportSample('2026-03-27T14:15:00.000Z', 0.1)
    ]);
    assert.deepEqual(store.listMissingPriceBuckets({ start: '2025-06-10T00:00:00.000Z', end: '2025-06-11T00:00:00.000Z' }), []);
    assert.deepEqual(store.listMissingPriceBuckets({ start: '2025-06-10T10:15:00.000Z', end: '2025-06-10T11:00:00.000Z' }), []);
    assert.deepEqual(store.listMissingPriceBuckets({ start: '2026-03-27T00:00:00.000Z', end: '2026-03-28T00:00:00.000Z' }), ['2026-03-27T14:15:00.000Z']);
  } finally {
    store.close();
  }
});

test('Historie: Einspeiseerloes einer Stunde mit Stundenpreis zaehlt alle vier Viertelstunden', async () => {
  const store = createStore();
  try {
    store.writeSamples([
      price('2025-06-10T09:00:00.000Z', 20),
      price('2025-06-10T10:00:00.000Z', 20),
      price('2025-06-10T11:00:00.000Z', 20),
      ...quarters('2025-06-10T10:00:00.000Z').map((ts) => exportSample(ts, 0.5))
    ]);
    const runtime = createHistoryRuntime({ store, getPricingConfig: () => ({}), getCurrentDate: () => '2026-10-25' });
    const { kpis } = await runtime.getSummary({ view: 'day', date: '2025-06-10' });
    // 4 x 0,5 kWh x 0,20 EUR = 0,40 EUR (vorher nur der :00-Slot: 0,10 EUR)
    assert.equal(kpis.exportKwh, 2);
    assert.equal(kpis.exportRevenueEur, 0.4);
  } finally {
    store.close();
  }
});

test('nach dem Wechsel auf 15-min-Day-Ahead (01.10.2025) wird ein einzelner :00-Preis nicht geviertelt', () => {
  // Codex-/Claude-Gegenpruefung 25.10.2026: der Backfill schreibt nur fehlende
  // Slots, nach 10/2025 kann so ein einzelner 15-min-Preis um :00 ohne Nachbarn
  // in seiner Stunde liegen. Er gilt nur fuer seine Viertelstunde.
  const store = createStore();
  try {
    store.writeSamples([
      price('2026-01-10T08:00:00.000Z', 6),
      price('2026-01-10T10:00:00.000Z', 7),
      price('2026-01-10T12:00:00.000Z', 8),
      ...quarters('2026-01-10T10:00:00.000Z').map((ts) => exportSample(ts, 0.5))
    ]);
    const slots = store.listPriceSlots({ start: '2026-01-10T08:00:00.000Z', end: '2026-01-10T13:00:00.000Z' });
    assert.deepEqual(slots.map((s) => s.ts), ['2026-01-10T08:00:00.000Z', '2026-01-10T10:00:00.000Z', '2026-01-10T12:00:00.000Z']);
    assert.deepEqual(store.listMissingPriceBuckets({ start: '2026-01-10T00:00:00.000Z', end: '2026-01-11T00:00:00.000Z' }),
      ['2026-01-10T10:15:00.000Z', '2026-01-10T10:30:00.000Z', '2026-01-10T10:45:00.000Z']);
  } finally {
    store.close();
  }
});

test('vor 10/2025 deckt auch ein einzelner Stundenpreis ohne Nachbarn (alter 900-s-Stempel) seine Stunde', () => {
  const store = createStore();
  try {
    store.writeSamples([
      price('2025-06-10T10:00:00.000Z', 5.2),
      exportSample('2025-06-10T10:30:00.000Z', 0.5)
    ]);
    assert.deepEqual(store.listMissingPriceBuckets({}), []);
    assert.deepEqual(store.listPriceSlots({ start: '2025-06-10T10:30:00.000Z', end: '2025-06-10T10:45:00.000Z' }).map((s) => s.priceCtKwh), [5.2]);
  } finally {
    store.close();
  }
});

test('Cache-Version erhoeht: Monatsstaende mit fehlenden Stundenpreisen werden neu gerechnet', async () => {
  const { SUMMARY_CACHE_VERSION } = await import('../../history-runtime.js');
  assert.ok(SUMMARY_CACHE_VERSION >= 3);
});
