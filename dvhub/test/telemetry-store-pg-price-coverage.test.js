// test/telemetry-store-pg-price-coverage.test.js -- PG-Store: Stundenpreise
// (vor dem 01.10.2025, 24 Zeilen je Tag) gelten fuer alle vier Viertelstunden
// ihrer Stunde, in der Slot-Suche und in der Fehlend-Erkennung des Backfills
// (Review 25.10.2026, P2). Gegenstueck: test/sqlite/price-hourly-coverage.test.js.
//
// Die SQL-Faelle laufen nur mit DVHUB_TEST_PG_URL (z. B.
// postgres://postgres:test@127.0.0.1:55432/postgres), sonst uebersprungen.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { createTelemetryStorePg } from '../telemetry-store-pg.js';

const URL = process.env.DVHUB_TEST_PG_URL;
const skip = URL ? false : 'DVHUB_TEST_PG_URL nicht gesetzt';

const quarters = (hourIso) => [0, 15, 30, 45].map((m) => new Date(new Date(hourIso).getTime() + m * 60000).toISOString());

function mockPool(rows) {
  const calls = [];
  return {
    calls,
    connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
    query: async (text, params) => {
      calls.push({ text: String(text), params });
      if (/price_ct_kwh', 'price_eur_mwh/.test(String(text))) {
        const [from, to] = params.map((p) => new Date(p).getTime());
        return { rows: rows.filter((r) => r.ts_utc.getTime() >= from && r.ts_utc.getTime() < to) };
      }
      return { rows: [] };
    }
  };
}

const hourlyRow = (iso, value) => ({ series_key: 'price_ct_kwh', ts_utc: new Date(iso), resolution_seconds: 900, value_num: value });

test('PG listPriceSlots: Stundenpreis deckt :15/:30/:45, auch wenn der Bereich mitten in der Stunde beginnt', async () => {
  const pool = mockPool([
    hourlyRow('2025-06-10T09:00:00.000Z', 10),
    hourlyRow('2025-06-10T10:00:00.000Z', 20),
    hourlyRow('2025-06-10T11:00:00.000Z', 30)
  ]);
  const store = createTelemetryStorePg(pool);
  const all = await store.listPriceSlots({ start: '2025-06-10T09:00:00.000Z', end: '2025-06-10T12:00:00.000Z' });
  assert.equal(all.length, 12);
  const byTs = new Map(all.map((s) => [s.ts, s.priceCtKwh]));
  for (const ts of quarters('2025-06-10T10:00:00.000Z')) assert.equal(byTs.get(ts), 20, ts);

  const mid = await store.listPriceSlots({ start: '2025-06-10T10:30:00.000Z', end: '2025-06-10T11:30:00.000Z' });
  assert.deepEqual(mid.map((s) => [s.ts, s.priceCtKwh]), [
    ['2025-06-10T10:30:00.000Z', 20],
    ['2025-06-10T10:45:00.000Z', 20],
    ['2025-06-10T11:00:00.000Z', 30],
    ['2025-06-10T11:15:00.000Z', 30]
  ]);
});

async function withDb(fn) {
  const client = new pg.Client({ connectionString: URL });
  await client.connect();
  try {
    await client.query(`CREATE TEMP TABLE timeseries_samples (
      series_key text, scope text, source text, quality text, ts_utc timestamptz,
      resolution_seconds integer, value_num double precision, value_text text, unit text, meta_json jsonb)`);
    await client.query('CREATE TEMP TABLE energy_slots_15m (series_key text, slot_start_utc timestamptz)');
    const store = createTelemetryStorePg({ query: (text, params) => client.query(text, params), connect: async () => client });
    return await fn(client, store);
  } finally {
    await client.end();
  }
}

async function insert(client, rows) {
  for (const [seriesKey, ts, value, res = 900] of rows) {
    await client.query(
      'INSERT INTO timeseries_samples (series_key, ts_utc, value_num, resolution_seconds) VALUES ($1, $2, $3, $4)',
      [seriesKey, ts, value, res]
    );
  }
}

test('PG listMissingPriceBuckets: Viertelstunden unter einem Stundenpreis gelten als bepreist', { skip }, async () => {
  await withDb(async (client, store) => {
    await insert(client, [
      ['price_ct_kwh', '2025-06-10T09:00:00.000Z', 10],
      ['price_ct_kwh', '2025-06-10T10:00:00.000Z', 20],
      ['price_ct_kwh', '2025-06-10T11:00:00.000Z', 30],
      ...quarters('2025-06-10T10:00:00.000Z').map((ts) => ['grid_export_w', ts, 2000]),
      // 15-min-Zeit (auch mit falschem 3600-s-Stempel): 14:15 fehlt wirklich.
      ['price_ct_kwh', '2026-03-27T14:00:00.000Z', 1, 3600],
      ['price_ct_kwh', '2026-03-27T14:30:00.000Z', 1, 3600],
      ['grid_export_w', '2026-03-27T14:15:00.000Z', 400],
      // Nach 10/2025 einzelner :00-Preis ohne Nachbarn in der Stunde: nicht vierteln.
      ['price_ct_kwh', '2026-01-10T08:00:00.000Z', 6],
      ['price_ct_kwh', '2026-01-10T10:00:00.000Z', 7],
      ['price_ct_kwh', '2026-01-10T12:00:00.000Z', 8],
      ...quarters('2026-01-10T10:00:00.000Z').map((ts) => ['grid_export_w', ts, 2000]),
      // Vor 10/2025 einzelner Stundenpreis ohne Nachbarn (900-s-Stempel): deckt.
      ['price_ct_kwh', '2025-07-01T10:00:00.000Z', 5],
      ['grid_export_w', '2025-07-01T10:30:00.000Z', 2000]
    ]);
    assert.deepEqual(await store.listMissingPriceBuckets({ start: '2025-06-10T00:00:00.000Z', end: '2025-06-11T00:00:00.000Z' }), []);
    assert.deepEqual(await store.listMissingPriceBuckets({ start: '2025-06-10T10:15:00.000Z', end: '2025-06-10T11:00:00.000Z' }), []);
    assert.deepEqual(
      await store.listMissingPriceBuckets({ start: '2026-03-27T00:00:00.000Z', end: '2026-03-28T00:00:00.000Z' }),
      ['2026-03-27T14:15:00.000Z']
    );
    assert.deepEqual(
      await store.listMissingPriceBuckets({ start: '2026-01-10T00:00:00.000Z', end: '2026-01-11T00:00:00.000Z' }),
      ['2026-01-10T10:15:00.000Z', '2026-01-10T10:30:00.000Z', '2026-01-10T10:45:00.000Z']
    );
    // Ohne Bereichsgrenzen alles zusammen; der Juli-2025-Slot ist gedeckt.
    assert.deepEqual(await store.listMissingPriceBuckets({}), [
      '2026-01-10T10:15:00.000Z', '2026-01-10T10:30:00.000Z', '2026-01-10T10:45:00.000Z', '2026-03-27T14:15:00.000Z'
    ]);
  });
});

test('PG listPriceSlots gegen echte Datenbank: Stundenpreise vierteln, 15-min-Preise nicht', { skip }, async () => {
  await withDb(async (client, store) => {
    await insert(client, [
      ['price_ct_kwh', '2025-06-10T09:00:00.000Z', 10],
      ['price_ct_kwh', '2025-06-10T10:00:00.000Z', 20],
      ['price_ct_kwh', '2026-03-27T10:00:00.000Z', 1, 3600],
      ['price_ct_kwh', '2026-03-27T10:15:00.000Z', 2, 3600]
    ]);
    const hourly = await store.listPriceSlots({ start: '2025-06-10T09:00:00.000Z', end: '2025-06-10T11:00:00.000Z' });
    assert.equal(hourly.length, 8);
    const quarter = await store.listPriceSlots({ start: '2026-03-27T10:00:00.000Z', end: '2026-03-27T11:00:00.000Z' });
    assert.deepEqual(quarter.map((s) => [s.ts, s.priceCtKwh]), [
      ['2026-03-27T10:00:00.000Z', 1],
      ['2026-03-27T10:15:00.000Z', 2]
    ]);
  });
});
