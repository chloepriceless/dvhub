// test/peak-shaving-peaks.test.js — Peak Shaving (GitHub #28): höchste
// Viertelstunden-Bezugsleistung im Monat und im Jahr.
//
// RLM rechnet mit 15-Minuten-Mittelwerten. DVhub verdichtet den Netzbezug
// ohnehin in energy_slots_15m (kWh je Viertelstunde) — der Mittelwert ist
// kWh × 4 000 W. Je Slot zählt die größere Quelle (eigener Messwert oder
// VRM-Import). Monat und Jahr laufen in der Zeitzone der Anlage.

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createTelemetryStorePg, GRID_IMPORT_PEAK_SQL } from '../telemetry-store-pg.js';
import { peakPeriods, createPeakShaving } from '../services/peak-shaving/index.js';

// --- Zeiträume ----------------------------------------------------------------

test('peakPeriods: Monat/Jahr in Europe/Berlin (Sommerzeit → Winterzeit)', () => {
  const p = peakPeriods(Date.parse('2026-10-26T10:00:00Z'), 'Europe/Berlin');
  // 01.10. 00:00 MESZ = 30.09. 22:00 UTC; 01.11. 00:00 MEZ = 31.10. 23:00 UTC
  assert.equal(p.month.start, '2026-09-30T22:00:00.000Z');
  assert.equal(p.month.end, '2026-10-31T23:00:00.000Z');
  // 01.01.2026 00:00 MEZ = 31.12.2025 23:00 UTC
  assert.equal(p.year.start, '2025-12-31T23:00:00.000Z');
  assert.equal(p.year.end, '2026-12-31T23:00:00.000Z');
});

test('peakPeriods: Silvester 23:30 UTC ist in Berlin schon das neue Jahr', () => {
  const p = peakPeriods(Date.parse('2026-12-31T23:30:00Z'), 'Europe/Berlin');
  assert.equal(p.year.start, '2026-12-31T23:00:00.000Z');
  assert.equal(p.month.start, '2026-12-31T23:00:00.000Z');
  assert.equal(p.month.end, '2027-01-31T23:00:00.000Z');
});

// --- Store-Abfrage (Pool-Attrappe) -----------------------------------------------

function fakePool(rowsFor) {
  const calls = [];
  return {
    calls,
    connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
    query: async (text, params) => { calls.push({ text: String(text), params }); return { rows: rowsFor(String(text), params) }; }
  };
}

test('getGridImportPeak: kWh je Viertelstunde → mittlere Leistung (× 4 000)', async () => {
  const pool = fakePool(() => [{ slot_start_utc: new Date('2026-10-14T17:15:00.000Z'), value_num: 3.2 }]);
  const store = createTelemetryStorePg(pool);
  const peak = await store.getGridImportPeak({ start: '2026-09-30T22:00:00.000Z', end: '2026-10-31T23:00:00.000Z' });
  assert.deepEqual(peak, { slotStart: '2026-10-14T17:15:00.000Z', powerW: 12800, energyKwh: 3.2 });
  const call = pool.calls.at(-1);
  assert.equal(call.text, GRID_IMPORT_PEAK_SQL);
  assert.deepEqual(call.params, ['2026-09-30T22:00:00.000Z', '2026-10-31T23:00:00.000Z']);
});

test('getGridImportPeak: keine Daten → null', async () => {
  const store = createTelemetryStorePg(fakePool(() => []));
  assert.equal(await store.getGridImportPeak({ start: '2026-01-01T00:00:00Z', end: '2026-02-01T00:00:00Z' }), null);
});

test('GRID_IMPORT_PEAK_SQL: nur Netzbezug, je Slot die größere Quelle, größter Slot', () => {
  assert.match(GRID_IMPORT_PEAK_SQL, /series_key = 'grid_import_w'/);
  assert.match(GRID_IMPORT_PEAK_SQL, /MAX\(value_num\)/);
  assert.match(GRID_IMPORT_PEAK_SQL, /GROUP BY slot_start_utc/);
  assert.match(GRID_IMPORT_PEAK_SQL, /ORDER BY value_num DESC/);
});

// --- Echte Datenbank (läuft in der CI, pg-integration) ----------------------------

const DATABASE_URL = process.env.DATABASE_URL;

describe('getGridImportPeak gegen echtes PostgreSQL', { skip: !DATABASE_URL }, () => {
  let client;
  before(async () => {
    const pg = await import('pg');
    client = new pg.default.Client({ connectionString: DATABASE_URL });
    await client.connect();
    await client.query('DROP SCHEMA IF EXISTS ps_peak_test CASCADE; CREATE SCHEMA ps_peak_test; SET search_path TO ps_peak_test');
    await client.query(`CREATE TABLE energy_slots_15m (
      id BIGSERIAL PRIMARY KEY, slot_start_utc TIMESTAMPTZ NOT NULL, series_key TEXT NOT NULL,
      source_kind TEXT NOT NULL, quality TEXT NOT NULL, value_num DOUBLE PRECISION, unit TEXT, meta_json TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(slot_start_utc, series_key, source_kind))`);
    const rows = [
      // 10:00 — eigener Messwert unvollständig (Neustart): 2 kWh, VRM 2,5 kWh →
      // je Slot zählt die größere Quelle (10 000 W), sonst würde die Spitze unterschätzt.
      ['2026-10-14T10:00:00Z', 'grid_import_w', 'vrm_import', 2.5],
      ['2026-10-14T10:00:00Z', 'grid_import_w', 'local_live', 2],
      // 11:00 — eigener Messwert 2,9 kWh, VRM 1 kWh → 11 600 W (eigener größer).
      ['2026-10-14T11:00:00Z', 'grid_import_w', 'vrm_import', 1],
      ['2026-10-14T11:00:00Z', 'grid_import_w', 'local_live', 2.9],
      // 10:15 — nur VRM: 3 kWh = 12 000 W → Monatsspitze.
      ['2026-10-14T10:15:00Z', 'grid_import_w', 'vrm_import', 3],
      // 10:30 — Einspeisung zählt nicht.
      ['2026-10-14T10:30:00Z', 'grid_export_w', 'local_live', 9],
      // September: 4 kWh = 16 000 W → nur Jahresspitze.
      ['2026-09-10T08:00:00Z', 'grid_import_w', 'local_live', 4],
      // Vorjahr: zählt nicht.
      ['2025-12-31T22:45:00Z', 'grid_import_w', 'local_live', 9]
    ];
    for (const [ts, key, kind, kwh] of rows) {
      await client.query(`INSERT INTO energy_slots_15m (slot_start_utc, series_key, source_kind, quality, value_num, unit)
        VALUES ($1, $2, $3, 'raw_derived', $4, 'kWh')`, [ts, key, kind, kwh]);
    }
  });
  after(async () => { await client?.query('DROP SCHEMA IF EXISTS ps_peak_test CASCADE'); await client?.end(); });

  test('Monat und Jahr', async () => {
    const pool = { query: (text, params) => client.query(text, params), connect: async () => client };
    const store = createTelemetryStorePg(pool);
    const p = peakPeriods(Date.parse('2026-10-26T10:00:00Z'), 'Europe/Berlin');
    assert.deepEqual(await store.getGridImportPeak(p.month), { slotStart: '2026-10-14T10:15:00.000Z', powerW: 12000, energyKwh: 3 });
    assert.deepEqual(await store.getGridImportPeak(p.year), { slotStart: '2026-09-10T08:00:00.000Z', powerW: 16000, energyKwh: 4 });
    // Ein Tag: 10:00 zählt mit der größeren Quelle (VRM 2,5 kWh, nicht lokal 2 kWh).
    assert.deepEqual(await store.getGridImportPeak({ start: '2026-10-14T09:00:00Z', end: '2026-10-14T10:15:00Z' }),
      { slotStart: '2026-10-14T10:00:00.000Z', powerW: 10000, energyKwh: 2.5 });
  });
});

// --- Dienst ----------------------------------------------------------------------

function serviceCtx({ cfg, store, state } = {}) {
  return {
    getCfg: () => cfg,
    state: state || { victron: {}, meter: {}, ctrl: {} },
    telemetryStore: store,
    pushLog: () => {}
  };
}

const ON = { updateChannel: 'dev', manufacturer: 'victron', schedule: { timezone: 'Europe/Berlin' },
  peakShaving: { enabled: true, gridImportLimitW: 10000, marginW: 300 } };

test('Dienst: aus → kein Status, keine Abfrage', async () => {
  const calls = [];
  const store = { getGridImportPeak: async (r) => { calls.push(r); return null; } };
  const svc = createPeakShaving(serviceCtx({ cfg: { manufacturer: 'victron', peakShaving: { enabled: false } }, store }));
  await svc.refreshPeaks(Date.parse('2026-10-26T10:00:00Z'));
  assert.equal(svc.summary(), null);
  assert.deepEqual(calls, []);
});

test('Dienst: an → Monats- und Jahresspitze aus der Datenbank im Status', async () => {
  const calls = [];
  const store = {
    getGridImportPeak: async (r) => {
      calls.push(r);
      return r.start.startsWith('2026-09-30')
        ? { slotStart: '2026-10-14T10:15:00.000Z', powerW: 12000, energyKwh: 3 }
        : { slotStart: '2026-09-10T08:00:00.000Z', powerW: 16000, energyKwh: 4 };
    }
  };
  const svc = createPeakShaving(serviceCtx({ cfg: ON, store }));
  await svc.refreshPeaks(Date.parse('2026-10-26T10:00:00Z'));
  assert.deepEqual(calls.map((c) => c.start), ['2026-09-30T22:00:00.000Z', '2025-12-31T23:00:00.000Z']);
  const s = svc.summary();
  assert.equal(s.enabled, true);
  assert.equal(s.active, true);
  assert.equal(s.limitW, 10000);
  assert.equal(s.targetW, 9700);
  assert.deepEqual(s.peaks.month, { slotStart: '2026-10-14T10:15:00.000Z', powerW: 12000 });
  assert.deepEqual(s.peaks.year, { slotStart: '2026-09-10T08:00:00.000Z', powerW: 16000 });
  assert.equal(s.peaks.error, null);
});

test('Dienst: Datenbankfehler → Fehler im Status, alte Werte bleiben', async () => {
  let fail = false;
  const store = { getGridImportPeak: async () => { if (fail) throw new Error('db down'); return { slotStart: '2026-10-14T10:15:00.000Z', powerW: 12000, energyKwh: 3 }; } };
  const svc = createPeakShaving(serviceCtx({ cfg: ON, store }));
  await svc.refreshPeaks(Date.parse('2026-10-26T10:00:00Z'));
  fail = true;
  await svc.refreshPeaks(Date.parse('2026-10-26T10:05:00Z'));
  const s = svc.summary();
  assert.equal(s.peaks.month.powerW, 12000);
  assert.equal(s.peaks.error, 'db down');
});

test('Dienst: ohne Datenbank → Spitzen unbekannt, Grund im Status', async () => {
  const svc = createPeakShaving(serviceCtx({ cfg: ON, store: null }));
  await svc.refreshPeaks(Date.parse('2026-10-26T10:00:00Z'));
  assert.equal(svc.summary().peaks.month, null);
  assert.equal(svc.summary().peaks.error, 'no_database');
});

test('Dienst: anderer Hersteller → Status „nur Anzeige“, Spitzen trotzdem', async () => {
  const store = { getGridImportPeak: async () => ({ slotStart: '2026-10-14T10:15:00.000Z', powerW: 12000, energyKwh: 3 }) };
  const svc = createPeakShaving(serviceCtx({ cfg: { ...ON, manufacturer: 'fronius' }, store }));
  await svc.refreshPeaks(Date.parse('2026-10-26T10:00:00Z'));
  const s = svc.summary();
  assert.equal(s.active, false);
  assert.equal(s.supported, false);
  assert.equal(s.reason, 'manufacturer_unsupported');
  assert.match(s.message, /nur Victron/);
  assert.equal(s.peaks.month.powerW, 12000);
});

test('Dienst: „greift“ aus dem Steuerzustand (Deckel frisch oder Akku freigegeben)', () => {
  const now = Date.now();
  const state = {
    victron: { gridImportW: 9650 }, meter: { ok: true, updatedAt: now },
    ctrl: { _peakShaving: { clamp: { requestedW: 14700, valueW: 9700, mode: 'target', reason: null, source: 'eos_grid_hold', at: now - 2000 } } }
  };
  const svc = createPeakShaving(serviceCtx({ cfg: ON, store: null, state }));
  let s = svc.summary();
  assert.equal(s.acting, true);
  assert.equal(s.importW, 9650);
  assert.deepEqual(s.clamp, { requestedW: 14700, valueW: 9700, mode: 'target', reason: null, source: 'eos_grid_hold' });
  // alter Deckel-Eintrag (> 30 s) zählt nicht mehr
  state.ctrl._peakShaving.clamp.at = now - 60000;
  s = svc.summary();
  assert.equal(s.acting, false);
  assert.equal(s.clamp, null);
  // Akku-Freigabe
  state.ctrl._peakShaving.discharge = { phase: 'lifted', liftedW: 4300, since: now - 5000 };
  s = svc.summary();
  assert.equal(s.acting, true);
  assert.deepEqual(s.lift, { liftedW: 4300, since: now - 5000, waiting: null });
  // Zähler veraltet → kein Bezugswert
  state.meter.updatedAt = now - 60000;
  assert.equal(svc.summary().importW, null);
});

// --- Verdrahtung in server.js (Prozess-Start ist nicht importierbar) ------------
test('server.js: Dienst im Laufzeit-Prozess, Status in /api/status, Merker-Pfad im ctx', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(src, /ctx\.peakShaving = createPeakShaving\(ctx\);\s*\nif \(IS_RUNTIME_PROCESS\) ctx\.peakShaving\.start\(\);/);
  assert.match(src, /peakShaving: ctx\.peakShaving\?\.summary\?\.\(\) \?\? null,/);
  assert.match(src, /peakShavingLiftPath: PEAK_SHAVING_LIFT_PATH,/);
  assert.match(src, /safeSync\('peakShaving\.stop'/);
});

test('decodeMaxDischargeRaw: Victron-2704-Rohwerte wie beim Schreiben', async () => {
  const { decodeMaxDischargeRaw } = await import('../services/peak-shaving/index.js');
  const conf = { scale: 10, offset: 0, rawSentinels: [0], rawSentinelMap: { '-1': 32767 } };
  assert.equal(decodeMaxDischargeRaw(0, conf), 0);
  assert.equal(decodeMaxDischargeRaw(430, conf), 4300);
  assert.equal(decodeMaxDischargeRaw(32767, conf), -1);
  assert.equal(decodeMaxDischargeRaw(0xffff, conf), -1);
  assert.equal(decodeMaxDischargeRaw('x', conf), null);
});
