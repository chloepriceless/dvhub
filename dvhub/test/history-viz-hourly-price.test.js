// test/history-viz-hourly-price.test.js -- Dispatch-Karten (Top-10, realisierte
// Fahrplaene) bewerten Slots vor 10/2025 mit dem Stundenpreis fuer alle vier
// Viertelstunden (Gegenpruefung 25.10.2026). Vorher bekam nur die :00-
// Viertelstunde einen Preis, :15/:30/:45 zaehlten mit 0 ct.
//
// Laeuft nur mit DVHUB_TEST_PG_URL oder DATABASE_URL, sonst uebersprungen.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { createHistoryVizAggregator } from '../services/history-viz/aggregator.js';

// In CI (pg-integration) ist DATABASE_URL gesetzt; die Tests legen nur TEMP-Tabellen an.
const URL = process.env.DVHUB_TEST_PG_URL || process.env.DATABASE_URL;
const skip = URL ? false : 'DVHUB_TEST_PG_URL/DATABASE_URL nicht gesetzt';

test('Top-10: Viertelstunden unter einem Stundenpreis tragen dessen Preis', { skip }, async () => {
  const client = new pg.Client({ connectionString: URL });
  await client.connect();
  try {
    await client.query(`CREATE TEMP TABLE timeseries_samples (series_key text, ts_utc timestamptz, value_num double precision, resolution_seconds integer)`);
    await client.query(`CREATE TEMP TABLE energy_slots_15m (slot_start_utc timestamptz, series_key text, source_kind text, unit text, value_num double precision)`);
    for (const [ts, ct] of [['2025-06-10T09:00:00Z', 10], ['2025-06-10T10:00:00Z', 20], ['2025-06-10T11:00:00Z', 30]]) {
      await client.query(`INSERT INTO timeseries_samples VALUES ('price_ct_kwh', $1, $2, 900)`, [ts, ct]);
    }
    // 10:00-10:45 je 1 kWh Einspeisung.
    for (const m of [0, 15, 30, 45]) {
      await client.query(`INSERT INTO energy_slots_15m VALUES ($1, 'grid_export_w', 'local_live', 'kWh', 1)`, [new Date(Date.UTC(2025, 5, 10, 10, m)).toISOString()]);
    }
    const api = createHistoryVizAggregator({ db: { query: (text, params) => client.query(text, params) }, getCfg: () => ({}), pushLog: () => {} });
    const res = await api.getTop10({ view: 'month', date: '2025-06-10' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    // 4 × 1 kWh × 20 ct = 0,80 EUR (vorher nur 10:00: 0,20 EUR).
    assert.equal(res.body.slots.length, 4);
    for (const slot of res.body.slots) assert.equal(slot.priceCt, 20, slot.ts);
    assert.equal(res.body.totalEur, 0.8);
  } finally {
    await client.end();
  }
});
