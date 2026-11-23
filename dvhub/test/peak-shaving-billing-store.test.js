// test/peak-shaving-billing-store.test.js — Peak Shaving P4: Monatswerte für das Leistungsentgelt aus
// energy_slots_15m (Arbeit, Spitze, Spitze ohne Akku-Beitrag). Je Viertelstunde zählt die größere Quelle (eigener
// Messwert oder VRM-Import), Monate in Ortszeit.

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createTelemetryStorePg, PEAK_BILLING_MONTHS_SQL } from '../telemetry-store-pg.js';

test('getPeakBillingMonths: Zeilen → kWh, W (× 4 000), Zeitpunkt, Akku-Viertelstunden; Parameter mit Zeitzone', async () => {
  const calls = [];
  const pool = {
    connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
    query: async (text, params) => {
      calls.push({ text, params });
      return { rows: [{ ym: '2026-10', energy_kwh: '1234.5', peak_kwh: 3, peak_slot: new Date('2026-10-14T10:15:00Z'), uncapped_kwh: 4.25, slots: '2976', battery_slots: '2900' },
        { ym: '2026-11', energy_kwh: 10, peak_kwh: 1, peak_slot: null, uncapped_kwh: null, slots: 4, battery_slots: 0 }] };
    }
  };
  const store = createTelemetryStorePg(pool);
  const rows = await store.getPeakBillingMonths({ start: '2025-12-31T23:00:00.000Z', end: '2026-12-31T23:00:00.000Z', timeZone: 'Europe/Berlin' });
  assert.deepEqual(rows[0], { ym: '2026-10', energyKwh: 1234.5, peakW: 12000, peakSlot: '2026-10-14T10:15:00.000Z', uncappedPeakW: 17000, slots: 2976, batterySlots: 2900 });
  assert.equal(rows[1].uncappedPeakW, null);
  assert.equal(calls[0].text, PEAK_BILLING_MONTHS_SQL);
  assert.deepEqual(calls[0].params, ['2025-12-31T23:00:00.000Z', '2026-12-31T23:00:00.000Z', 'Europe/Berlin']);
});

const DATABASE_URL = process.env.DATABASE_URL;

describe('getPeakBillingMonths gegen echtes PostgreSQL', { skip: !DATABASE_URL }, () => {
  let client;
  before(async () => {
    const pg = await import('pg');
    client = new pg.default.Client({ connectionString: DATABASE_URL });
    await client.connect();
    await client.query('DROP SCHEMA IF EXISTS ps_billing_test CASCADE; CREATE SCHEMA ps_billing_test; SET search_path TO ps_billing_test');
    await client.query(`CREATE TABLE energy_slots_15m (
      id BIGSERIAL PRIMARY KEY, slot_start_utc TIMESTAMPTZ NOT NULL, series_key TEXT NOT NULL,
      source_kind TEXT NOT NULL, quality TEXT NOT NULL, value_num DOUBLE PRECISION, unit TEXT, meta_json TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(slot_start_utc, series_key, source_kind))`);
    const rows = [
      // Oktober: 10:00 VRM 2,5 / lokal 2 → 2,5; Akku 1 kWh → ohne Akku 3,5 kWh = 14 000 W
      ['2026-10-14T10:00:00Z', 'grid_import_w', 'vrm_import', 2.5],
      ['2026-10-14T10:00:00Z', 'grid_import_w', 'local_live', 2],
      ['2026-10-14T10:00:00Z', 'battery_discharge_w', 'local_live', 1],
      // 10:15: 3 kWh = 12 000 W (Spitze), Akku 0
      ['2026-10-14T10:15:00Z', 'grid_import_w', 'local_live', 3],
      ['2026-10-14T10:15:00Z', 'battery_discharge_w', 'local_live', 0],
      ['2026-10-14T10:30:00Z', 'grid_export_w', 'local_live', 9],
      // 31.10. 23:30 UTC = 01.11. 00:30 MEZ → November
      ['2026-10-31T23:30:00Z', 'grid_import_w', 'local_live', 1]
    ];
    for (const [ts, key, kind, kwh] of rows) {
      await client.query(`INSERT INTO energy_slots_15m (slot_start_utc, series_key, source_kind, quality, value_num, unit)
        VALUES ($1, $2, $3, 'raw_derived', $4, 'kWh')`, [ts, key, kind, kwh]);
    }
  });
  after(async () => { await client?.query('DROP SCHEMA IF EXISTS ps_billing_test CASCADE'); await client?.end(); });

  test('Monate in Ortszeit, größere Quelle je Viertelstunde, Spitze ohne Akku', async () => {
    const store = createTelemetryStorePg({ query: (t, p) => client.query(t, p), connect: async () => client });
    const rows = await store.getPeakBillingMonths({ start: '2025-12-31T23:00:00Z', end: '2026-12-31T23:00:00Z', timeZone: 'Europe/Berlin' });
    assert.deepEqual(rows, [
      { ym: '2026-10', energyKwh: 5.5, peakW: 12000, peakSlot: '2026-10-14T10:15:00.000Z', uncappedPeakW: 14000, slots: 2, batterySlots: 2 },
      { ym: '2026-11', energyKwh: 1, peakW: 4000, peakSlot: '2026-10-31T23:30:00.000Z', uncappedPeakW: null, slots: 1, batterySlots: 0 }
    ]);
  });
});
