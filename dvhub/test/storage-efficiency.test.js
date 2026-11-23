// test/storage-efficiency.test.js — Speicherweg mit Wandlung (T12, Christin
// 23.11.2026): Systemwirkungsgrad (AC) aus den Rohwerten, je Tag summiert.
// Alle Erwartungen sind von Hand nachgerechnet, die Rechnung steht daneben.
//
// SQL-Fall läuft nur mit DVHUB_TEST_PG_URL oder DATABASE_URL, sonst übersprungen.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import {
  STORAGE_EFFICIENCY_SQL,
  STORAGE_MIN_BATTERY_W,
  STORAGE_MAX_GAP_SECONDS,
  STORAGE_SERIES_KEYS,
  UPSERT_STORAGE_SQL,
  MISSING_STORAGE_DAYS_SQL,
  createStorageEfficiencyDaily,
  loadStorageEfficiency,
  storageEfficiencyCapability,
  summarizeStorageRows
} from '../services/inverter-efficiency/storage.js';

const close = (actual, expected, msg, eps = 0.001) => {
  assert.ok(Number.isFinite(Number(actual)), `${msg}: ${actual} ist keine Zahl`);
  assert.ok(Math.abs(Number(actual) - expected) <= eps, `${msg}: ${actual} statt ${expected}`);
};

// ── Messbarkeit je Herstellerprofil ──────────────────────────────────────────

test('Messbarkeit: Victron gemessen und geprüft, Standard ohne Herstellerangabe ist Victron', () => {
  const v = storageEfficiencyCapability({ manufacturer: 'victron', points: { selfConsumptionW: { enabled: true, address: 817 } } });
  assert.equal(v.measurable, true);
  assert.equal(v.verified, true);
  assert.equal(v.reason, null);
  assert.equal(storageEfficiencyCapability({}).measurable, true);
});

test('Messbarkeit: Hybrid-WR Sungrow/Deye messbar, aber ungeprüft — mit Hinweis', () => {
  for (const manufacturer of ['sungrow', 'deye-lv', 'deye-lp1', 'deye-hp3']) {
    const c = storageEfficiencyCapability({ manufacturer, points: { selfConsumptionW: { enabled: true } } });
    assert.equal(c.measurable, true, manufacturer);
    assert.equal(c.verified, false, manufacturer);
    assert.match(c.note, /nicht gegengeprüft/);
  }
});

test('Messbarkeit: nicht messbar mit Grund — nie geraten', () => {
  const fronius = storageEfficiencyCapability({ manufacturer: 'fronius', points: { selfConsumptionW: { enabled: false, derive: 'pv_plus_grid' } } });
  assert.equal(fronius.measurable, false);
  assert.match(fronius.reason, /nicht messbar bei Fronius/);
  const bridge = storageEfficiencyCapability({ manufacturer: 'bridge-mqtt', points: { selfConsumptionW: { enabled: true } } });
  assert.equal(bridge.measurable, false);
  assert.match(bridge.reason, /Bridge/);
  // Abgeleitete Last (energy_balance): die Verluste heben sich rechnerisch auf.
  const derived = storageEfficiencyCapability({ manufacturer: 'goodwe-et', points: { selfConsumptionW: { enabled: false, derive: 'energy_balance' } } });
  assert.equal(derived.measurable, false);
  assert.match(derived.reason, /abgeleitet/);
  // Auch Victron mit abgeschaltetem Lastpunkt.
  assert.equal(storageEfficiencyCapability({ manufacturer: 'victron', points: { selfConsumptionW: { enabled: false } } }).measurable, false);
  // Unbekanntes/ungeprüftes Profil.
  const solis = storageEfficiencyCapability({ manufacturer: 'solis', points: { selfConsumptionW: { enabled: true } } });
  assert.equal(solis.measurable, false);
  assert.match(solis.reason, /nicht geprüft/);
  // Zwei Sungrow: die Systemlast wird mit DC-Werten des zweiten WR korrigiert.
  const twin = storageEfficiencyCapability({ manufacturer: 'sungrow', points: { selfConsumptionW: { enabled: true } }, sungrow: { secondInverter: { host: '192.168.1.84' } } });
  assert.equal(twin.measurable, false);
  assert.match(twin.reason, /zweitem Wechselrichter/);
});

// ── Summen der Tageszeilen ───────────────────────────────────────────────────

const cap10 = { capacityKwhForDay: () => 10 };

test('Zeitraum: Wirkungsgrade energiegewichtet aus Tageszeilen, kein Mittel der Tage', () => {
  const s = summarizeStorageRows([
    // Tag 1: 10 kWh geladen (6 PV direkt, 4 über den Lader aus 4,4 kWh AC), 9 kWh entladen → 8,28 kWh AC (92 %);
    // alle Proben 10,2 / 8,9 kWh; Ladestand 50 → 53 %.
    { day: '2026-11-02', charge_dc_wh: 10000, pv_to_batt_wh: 6000, conv_to_batt_wh: 4000, ac_in_wh: 4400,
      discharge_dc_wh: 9000, ac_out_wh: 8280, charge_all_wh: 10200, discharge_all_wh: 8900, converter_loss_wh: 1500,
      soc_delta_pct: 3, soc_intervals: 8000, seconds: 40000, samples: 8000 },
    // Tag 2: 5 kWh nur PV, 6 kWh entladen → 5,4 kWh AC (90 %); Ladestand 40 → 38 %.
    { day: '2026-11-01', charge_dc_wh: 5000, pv_to_batt_wh: 5000, conv_to_batt_wh: 0, ac_in_wh: 0,
      discharge_dc_wh: 6000, ac_out_wh: 5400, charge_all_wh: 5000, discharge_all_wh: 6000, converter_loss_wh: 900,
      soc_delta_pct: -2, soc_intervals: 6000, seconds: 30000, samples: 6000 }
  ], cap10);
  assert.equal(s.status, 'ok');
  // η Laden = 15 000 ÷ (11 000 PV + 4 400 AC) = 0,974026.
  close(s.chargeEta, 15000 / 15400, 'η Laden', 1e-9);
  // η Entladen = 13 680 ÷ 15 000 = 0,912 — das Tagesmittel wäre (0,92 + 0,90) / 2 = 0,91.
  close(s.dischargeEta, 0.912, 'η Entladen', 1e-9);
  // Lader allein: 4 000 ÷ 4 400 = 0,90909.
  close(s.chargerEta, 4000 / 4400, 'η Lader', 1e-9);
  // ΔSoC = (+3 % − 2 %) × 10 kWh = +0,1 kWh; η Akku DC = 14,9 ÷ (15,2 − 0,1) = 0,986755.
  close(s.storedDeltaKwh, 0.1, 'ΔSoC', 1e-9);
  close(s.dcEta, 14900 / 15100, 'η Akku DC', 1e-9);
  assert.equal(s.days, 2);
  assert.equal(s.firstDay, '2026-11-01');
  assert.equal(s.lastDay, '2026-11-02');
  assert.equal(s.hours, 19.4); // 70 000 s
  assert.equal(s.acInKwh, 4.4);
  assert.equal(s.converterLossKwh, 2.4);
  const { storedDeltaKwh, ...raw } = s.raw;
  assert.deepEqual(raw, { chargeKwh: 15, inputKwh: 15.4, dischargeKwh: 15, acOutKwh: 13.68, chargeAllKwh: 15.2, dischargeAllKwh: 14.9 });
  close(storedDeltaKwh, 0.1, 'ΔSoC ungerundet', 1e-9);
});

const okDay = (over = {}) => ({ day: '2026-11-01', charge_dc_wh: 10000, pv_to_batt_wh: 10000, ac_in_wh: 0, discharge_dc_wh: 10000,
  ac_out_wh: 9000, charge_all_wh: 10000, discharge_all_wh: 9700, soc_delta_pct: 0, soc_intervals: 720, seconds: 3600, ...over });

test('Zeitraum: zu wenig Daten, Ladestand fehlt, abgeleitete Last, unplausibel', () => {
  assert.equal(summarizeStorageRows([]).status, 'insufficient_data');
  assert.match(summarizeStorageRows([]).reason, /noch keine Messwerte/);
  assert.equal(summarizeStorageRows([okDay()], cap10).status, 'ok');
  const few = summarizeStorageRows([okDay({ charge_dc_wh: 900, pv_to_batt_wh: 900 })], cap10);
  assert.equal(few.status, 'insufficient_data');
  assert.equal(few.chargeEta, null);
  // Ohne Ladestand oder ohne Kapazität kein Akku-Anteil — nicht raten.
  // Ohne Ladestand liefert der Tagesjob auch keine DC-Mengen (Codex 700aef31).
  const noSoc = summarizeStorageRows([okDay({ soc_delta_pct: null, soc_intervals: 0, charge_all_wh: 0, discharge_all_wh: 0 })], cap10);
  assert.equal(noSoc.status, 'insufficient_data');
  assert.match(noSoc.reason, /Ladestand/);
  assert.equal(summarizeStorageRows([okDay()]).status, 'insufficient_data', 'ohne Kapazität');
  // Ein Tag ohne Ladestand neben einem mit: DC-Teil nur aus dem Tag mit Ladestand.
  const mixed = summarizeStorageRows([
    okDay(),
    okDay({ day: '2026-11-02', soc_delta_pct: null, soc_intervals: 0, charge_all_wh: 0, discharge_all_wh: 0 })
  ], cap10);
  assert.equal(mixed.status, 'ok');
  close(mixed.dcEta, 0.97, 'η Akku DC nur Tag 1', 1e-9);
  // Zeitgewichtet (Codex 43827b0a): 720 Abstände à 5 s mit Ladestand (3600 s), 720 à 60 s ohne
  // (43 200 s) → 3600 ÷ 46 800 = 7,69 % der Messzeit, nicht 50 % der Abstände.
  const half = summarizeStorageRows([
    okDay({ samples: 720, soc_seconds: 3600 }),
    okDay({ day: '2026-11-02', samples: 720, seconds: 43200, soc_delta_pct: null, soc_intervals: 0, soc_seconds: 0, charge_all_wh: 0, discharge_all_wh: 0 })
  ], cap10);
  assert.equal(half.socCoveragePct, 7.69);
  assert.equal(half.socComplete, false);
  // Exakt statt Schwelle: ein einziger Abstand ohne Ladestand unter 100 000 gilt als unvollständig.
  const almost = summarizeStorageRows([okDay({ samples: 100000, soc_intervals: 99999, seconds: 500000, soc_seconds: 499995 })], cap10);
  assert.equal(almost.socComplete, false);
  assert.equal(almost.socCoveragePct, 100);
  assert.equal(summarizeStorageRows([okDay({ samples: 720, soc_seconds: 3600 })], cap10).socComplete, true);
  // Entladen 9 990 von 10 000 Wh (99,9 %): Last aus der Akku-Leistung abgeleitet.
  assert.equal(summarizeStorageRows([okDay({ ac_out_wh: 9990 })], cap10).status, 'not_measurable');
  // Entladen 40 %: Vorzeichen/Bedeutung falsch.
  assert.equal(summarizeStorageRows([okDay({ ac_out_wh: 4000 })], cap10).status, 'implausible');
});

test('loadStorageEfficiency liest [von, bis) aus der Tagestabelle', async () => {
  const calls = [];
  const db = { async query(sql, params) { calls.push({ sql, params }); return { rows: [] }; } };
  const s = await loadStorageEfficiency(db, { from: '2026-11-01', toExclusive: '2026-12-01' });
  assert.deepEqual(calls[0].params, ['2026-11-01', '2026-12-01']);
  assert.match(calls[0].sql, /FROM storage_efficiency_daily/);
  assert.equal(s.status, 'insufficient_data');
  assert.equal(await loadStorageEfficiency(null, { from: '2026-11-01', toExclusive: '2026-12-01' }), null);
});

// ── Tagesjob ─────────────────────────────────────────────────────────────────

function fakeDb({ dayRow = {}, firstDay = null, missing = [] } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql === STORAGE_EFFICIENCY_SQL) return { rows: [dayRow] };
      if (sql.includes('min(ts_utc)')) return { rows: [{ first_day: firstDay }] };
      if (sql === MISSING_STORAGE_DAYS_SQL) return { rows: missing.map((day) => ({ day })) };
      return { rows: [] };
    }
  };
}

test('Tagesjob: rechnet heute, Vortag einmal, dann fehlende Tage; schreibt jede Zeile', async () => {
  const db = fakeDb({
    dayRow: { charge_dc_wh: 1266.667, pv_to_batt_wh: 500, conv_to_batt_wh: 766.667, ac_in_wh: 833.333,
      discharge_dc_wh: 500, ac_out_wh: 456.667, charge_all_wh: 1275, discharge_all_wh: 500, converter_loss_wh: 165,
      soc_delta_pct: 1.5, soc_intervals: 600, soc_seconds: 3000, seconds: 3000, samples: 600 },
    firstDay: '2026-11-01', missing: ['2026-11-20']
  });
  const job = createStorageEfficiencyDaily({ getDb: () => db, getCfg: () => ({ timeZone: 'Europe/Berlin' }), maxBackfillDays: 5 });
  const res = await job.runOnce({ now: new Date('2026-11-23T10:00:00Z') });
  assert.deepEqual(res.computed, ['2026-11-23', '2026-11-22', '2026-11-20']);
  const dayQuery = db.calls.find((c) => c.sql === STORAGE_EFFICIENCY_SQL);
  assert.deepEqual(dayQuery.params, ['2026-11-23', 'Europe/Berlin', STORAGE_SERIES_KEYS, STORAGE_MIN_BATTERY_W, STORAGE_MAX_GAP_SECONDS]);
  assert.ok(STORAGE_SERIES_KEYS.includes('pv_total_w'), 'PV gesamt für die zweite AC-PV-Position');
  const upserts = db.calls.filter((c) => c.sql === UPSERT_STORAGE_SQL).map((c) => c.params);
  assert.equal(upserts.length, 3);
  assert.deepEqual(upserts[0], ['2026-11-23', 1266.667, 500, 766.667, 833.333, 500, 456.667, 1275, 500, 165, 1.5, 600, 3000, 3000, 600]);
  assert.deepEqual(db.calls.find((c) => c.sql === MISSING_STORAGE_DAYS_SQL).params, ['2026-11-01', '2026-11-22', 5]);
  // Zweiter Lauf am selben Tag: Vortag nicht noch einmal.
  const again = await job.runOnce({ now: new Date('2026-11-23T11:00:00Z') });
  assert.deepEqual(again.computed, ['2026-11-23', '2026-11-20']);
});

test('Tagesjob: Tag ohne Proben bekommt eine 0-Zeile; nicht messbar oder ohne DB → nichts', async () => {
  const db = fakeDb({ dayRow: {} });
  const job = createStorageEfficiencyDaily({ getDb: () => db, getCfg: () => ({}) });
  await job.computeDay(db, '2026-11-01');
  assert.deepEqual(db.calls.find((c) => c.sql === UPSERT_STORAGE_SQL).params, ['2026-11-01', 0, 0, 0, 0, 0, 0, 0, 0, 0, null, 0, 0, 0, 0]);
  const fronius = createStorageEfficiencyDaily({ getDb: () => db, getCfg: () => ({ manufacturer: 'fronius' }) });
  assert.deepEqual(await fronius.runOnce(), { skipped: 'not measurable' });
  const noDb = createStorageEfficiencyDaily({ getDb: () => null, getCfg: () => ({}) });
  assert.deepEqual(await noDb.runOnce(), { skipped: 'no database' });
});

test('Tagesjob: Fehler wird gemeldet, Job bleibt nutzbar', async () => {
  const logs = [];
  const job = createStorageEfficiencyDaily({
    getDb: () => ({ async query() { throw new Error('boom'); } }),
    getCfg: () => ({}),
    pushLog: (event, data) => logs.push({ event, data })
  });
  assert.equal((await job.runOnce({ now: new Date('2026-11-23T10:00:00Z') })).error, 'boom');
  assert.equal(logs[0].event, 'storage_efficiency_daily_error');
  assert.equal((await job.runOnce({ now: new Date('2026-11-23T11:00:00Z') })).error, 'boom');
});

// ── SQL gegen echtes PostgreSQL ──────────────────────────────────────────────

const URL = process.env.DVHUB_TEST_PG_URL || process.env.DATABASE_URL;
const skip = URL ? false : 'DVHUB_TEST_PG_URL/DATABASE_URL nicht gesetzt';

// Ein Fenster: Proben alle stepS Sekunden über durationS, gleiche Werte.
// Werte dürfen Funktionen der Sekunde im Fenster sein (Ladestand-Rampe); stale = meta_json {"stale":true}.
async function seedWindow(client, startIso, series, { durationS = 600, stepS = 5, stale = false, metaType = 'text' } = {}) {
  const startMs = new Date(startIso).getTime();
  const values = [];
  const params = [];
  const meta = stale ? JSON.stringify({ stale: true }) : null;
  for (let s = 0; s <= durationS; s += stepS) {
    const ts = new Date(startMs + s * 1000).toISOString();
    for (const [key, value] of Object.entries(series)) {
      params.push(key, ts, typeof value === 'function' ? value(s) : value, meta);
      const n = params.length;
      values.push(`($${n - 3}, 'live', $${n - 2}::timestamptz, $${n - 1}::double precision, $${n}::text::${metaType})`);
    }
  }
  await client.query(`INSERT INTO timeseries_samples (series_key, scope, ts_utc, value_num, meta_json) VALUES ${values.join(',')}`, params);
}

const base = { grid_import_w: 0, grid_export_w: 0, pv_dc_w: 0 };

test('SQL: Laden aus dem Netz, DC-PV, Entladen (auch neben PV), Ruhe und Lücken — nachgerechnet', { skip }, async () => {
  const client = new pg.Client({ connectionString: URL });
  await client.connect();
  try {
    await client.query('CREATE TEMP TABLE timeseries_samples (series_key text, scope text, ts_utc timestamptz, value_num double precision, meta_json text)');
    // 20.10.2026 in Berlin = 19.10. 22:00 Z bis 20.10. 22:00 Z. Jedes Fenster 600 s
    // im 5-s-Takt: die erste Probe hat keinen gültigen Vorgänger (Lücke > 90 s),
    // es zählen 120 Abstände × 5 s = 600 s. Energie je Fenster = W × 600 / 3600 = W / 6.
    // A Netzladen: Akku +4600 W, Last 400, Bezug 5400 → AC in den Wandler 5000 W.
    // Ladestand steigt im Fenster A von 40 auf 47 %.
    await seedWindow(client, '2026-10-20T00:00:00Z', { ...base, battery_power_w: 4600, load_power_w: 400, grid_import_w: 5400, battery_soc_pct: (sec) => 40 + (7 * sec) / 600 });
    // B DC-PV lädt: PV 5000, Akku +3000, Last 1000, Einspeisung 850 → Wandler gibt 1850 W AC ab.
    await seedWindow(client, '2026-10-20T01:00:00Z', { ...base, battery_power_w: 3000, pv_dc_w: 5000, load_power_w: 1000, grid_export_w: 850, battery_soc_pct: 47 });
    // C Entladen: Akku −2000, Last 1840 → 1840 W AC aus dem Akku.
    await seedWindow(client, '2026-10-20T02:00:00Z', { ...base, battery_power_w: -2000, load_power_w: 1840, battery_soc_pct: 47 });
    // D Entladen neben PV: Akku −1000, PV 1000, Last 1800 → Akku-Anteil 1000/2000 von 1800 = 900 W.
    await seedWindow(client, '2026-10-20T03:00:00Z', { ...base, battery_power_w: -1000, pv_dc_w: 1000, load_power_w: 1800, battery_soc_pct: 47 });
    // E Ruhe: Akku +50 W (unter 100 W), Wandler-Leerlauf aus dem Netz (Bezug 430, Last 300).
    await seedWindow(client, '2026-10-20T04:00:00Z', { ...base, battery_power_w: 50, load_power_w: 300, grid_import_w: 430, battery_soc_pct: 47 });
    // F Lücken: alle 120 s (> 90 s) — zählt gar nicht.
    await seedWindow(client, '2026-10-20T05:00:00Z', { ...base, battery_power_w: 5000, load_power_w: 0, grid_import_w: 5500 }, { stepS: 120 });
    // Am Vortag (Berlin) — gehört nicht zum Tag.
    await seedWindow(client, '2026-10-19T21:00:00Z', { ...base, battery_power_w: -3000, load_power_w: 2700, battery_soc_pct: 90 });
    const { rows } = await client.query(STORAGE_EFFICIENCY_SQL, ['2026-10-20', 'Europe/Berlin', STORAGE_SERIES_KEYS, STORAGE_MIN_BATTERY_W, STORAGE_MAX_GAP_SECONDS]);
    const r = rows[0];
    close(r.seconds, 3000, 'Sekunden (5 × 600)');
    assert.equal(Number(r.samples), 600);
    close(r.charge_dc_wh, (4600 + 3000) / 6, 'geladen');
    close(r.pv_to_batt_wh, 3000 / 6, 'PV → Akku');
    close(r.conv_to_batt_wh, 4600 / 6, 'Lader → Akku');
    close(r.ac_in_wh, 5000 / 6, 'AC rein');
    close(r.discharge_dc_wh, (2000 + 1000) / 6, 'entladen');
    close(r.ac_out_wh, (1840 + 900) / 6, 'AC raus vom Akku');
    // Wandler gesamt je Fenster: A 400, B 150, C 160, D 200, E 80 W → 990 W / 6.
    close(r.converter_loss_wh, 990 / 6, 'Wandlerverlust gesamt');
    // Alle Proben, auch unter 100 W: zusätzlich E mit 50 W Laden.
    close(r.charge_all_wh, (4600 + 3000 + 50) / 6, 'geladen (alle Proben)');
    close(r.discharge_all_wh, (2000 + 1000) / 6, 'entladen (alle Proben)');
    // ΔSoC nur über die gezählten Abstände: +7 % in A, B–E bleiben bei 47 %; der Vortag mit 90 % zählt nicht.
    close(r.soc_delta_pct, 7, 'ΔSoC', 1e-9);
    assert.equal(Number(r.soc_intervals), 600);
    close(r.soc_seconds, 3000, 'Sekunden mit Ladestand');
    // Zehn solche Tage (über der Mindestmenge von 1 kWh je Richtung):
    // η Laden = 7600 ÷ (3000 + 5000) = 0,95; η Entladen = 2740 ÷ 3000 = 0,91333; Lader 4600 ÷ 5000 = 0,92;
    // η Akku DC je Tag = 500 Wh ÷ (1275 Wh − 7 % × 10 kWh = 700 Wh) = 0,86957 (nur Testzahlen).
    const s = summarizeStorageRows(Array.from({ length: 10 }, (_, i) => ({ ...r, day: `2026-10-${10 + i}` })), cap10);
    assert.equal(s.status, 'ok');
    close(s.chargeEta, 0.95, 'η Laden', 1e-6);
    close(s.dischargeEta, 2740 / 3000, 'η Entladen', 1e-6);
    close(s.chargerEta, 0.92, 'η Lader', 1e-6);
    close(s.dcEta, 500 / 575, 'η Akku DC', 1e-6);
  } finally {
    await client.end();
  }
});

// meta_json ist je nach Installation TEXT (Neuanlage) oder JSONB (Prod-Datenbank).
for (const metaType of ['text', 'jsonb']) test(`SQL (Codex 34516a12, meta_json ${metaType}): veraltete Proben, zweite AC-PV-Position und Ladestand über Lücken zählen nicht`, { skip }, async () => {
  const client = new pg.Client({ connectionString: URL });
  await client.connect();
  try {
    await client.query(`CREATE TEMP TABLE timeseries_samples (series_key text, scope text, ts_utc timestamptz, value_num double precision, meta_json ${metaType})`);
    // Entladen −2000 W, Last 3340 W, AC-PV 1500 W nur als PV gesamt (zweite Position, keine pv_ac_l*-Reihen):
    // AC aus dem Wandler = 3340 − 1500 = 1840 W. Ladestand 60 → 58 %.
    await seedWindow(client, '2026-10-20T00:00:00Z', { ...base, battery_power_w: -2000, load_power_w: 3340, pv_total_w: 1500, battery_soc_pct: (sec) => 60 - (2 * sec) / 600 }, { metaType });
    // Nach einem Lesefehler: gehaltene Werte mit frischem Zeitstempel (stale) — zählen nicht,
    // auch nicht der erste Abstand danach (Vorgänger veraltet).
    await seedWindow(client, '2026-10-20T00:10:05Z', { ...base, battery_power_w: -3000, load_power_w: 2700, pv_total_w: 0, battery_soc_pct: 58 }, { durationS: 300, stale: true, metaType });
    await seedWindow(client, '2026-10-20T00:15:10Z', { ...base, battery_power_w: 0, load_power_w: 300, grid_import_w: 300, pv_total_w: 0, battery_soc_pct: 50 }, { durationS: 5, metaType });
    // Lücken über 90 s mit Ladestand-Sprüngen.
    await seedWindow(client, '2026-10-20T02:00:00Z', { ...base, battery_power_w: 0, load_power_w: 300, grid_import_w: 300, battery_soc_pct: (sec) => 30 + sec / 60 }, { durationS: 600, stepS: 120, metaType });
    // Ladestand fehlt zeitweise (Codex 700aef31): −1000 W, Last 920 W. Zählt für die Wandlung,
    // nicht für den Akku-Wirkungsgrad (DC), weil ΔSoC dafür fehlt.
    await seedWindow(client, '2026-10-20T03:00:00Z', { ...base, battery_power_w: -1000, load_power_w: 920, pv_total_w: 0 }, { metaType });
    const { rows } = await client.query(STORAGE_EFFICIENCY_SQL, ['2026-10-20', 'Europe/Berlin', STORAGE_SERIES_KEYS, STORAGE_MIN_BATTERY_W, STORAGE_MAX_GAP_SECONDS]);
    const r = rows[0];
    close(r.discharge_dc_wh, (2000 + 1000) / 6, 'entladen: frisches Fenster + Fenster ohne Ladestand');
    close(r.ac_out_wh, (1840 + 920) / 6, 'AC raus ohne AC-PV der zweiten Position');
    close(r.discharge_all_wh, 2000 / 6, 'DC-Teil nur mit Ladestand an beiden Enden');
    // 600 s frisch + der zweite Abstand nach dem Fehler (5 s) + 600 s ohne Ladestand.
    close(r.seconds, 1205, 'Sekunden');
    close(r.soc_seconds, 605, 'Sekunden mit Ladestand (ohne das Fenster ohne Ladestand)');
    close(r.soc_delta_pct, -2, 'ΔSoC nur im frischen Fenster', 1e-9);
  } finally {
    await client.end();
  }
});

test('SQL: zweite GX — die gemessene Last der Haupt-GX zählt (wie daily.js)', { skip }, async () => {
  const client = new pg.Client({ connectionString: URL });
  await client.connect();
  try {
    await client.query('CREATE TEMP TABLE timeseries_samples (series_key text, scope text, ts_utc timestamptz, value_num double precision, meta_json text)');
    // Haupt-Akku −2000 W, Haupt-GX misst 1840 W; load_power_w ist um Akku 2 korrigiert (0).
    await seedWindow(client, '2026-10-20T00:00:00Z', { ...base, battery_power_w: -2000, load_power_w: 0, load_measured_w: 1840, second_battery_charge_w: 2500, second_battery_discharge_w: 0 });
    const { rows } = await client.query(STORAGE_EFFICIENCY_SQL, ['2026-10-20', 'Europe/Berlin', STORAGE_SERIES_KEYS, STORAGE_MIN_BATTERY_W, STORAGE_MAX_GAP_SECONDS]);
    close(rows[0].ac_out_wh, 1840 / 6, 'AC raus');
    close(rows[0].discharge_dc_wh, 2000 / 6, 'entladen');
  } finally {
    await client.end();
  }
});
