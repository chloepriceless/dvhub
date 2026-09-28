// test/datenspende-history.test.js — Bestandsdaten-Nachversand: Umrechnung der
// DB-Zeilen und der Hintergrundjob (Cursor, Fortsetzen, Fehlerverhalten).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { slotRowsToReadings, liveRowsToReadings, slotSeriesFor } from '../services/datenspende/history.js';
import { createDatenspende, SIDECAR_NAME } from '../services/datenspende/index.js';
import { DatenspendeRequestError, DatenspendeConnError } from '../services/datenspende/client.js';

const ALL = { grid: true, pv: true, load: true, battery: true, mqttTiles: true };

test('Viertelstunden: kWh×4000=W, W bleibt W, VRM vor eigener Messung, Batterie = Laden − Entladen', () => {
  const t = '2025-06-15T10:00:00.000Z';
  const rows = [
    { slot_start_utc: t, series_key: 'grid_import_w', source_kind: 'vrm_import', unit: 'kWh', value_num: 0.1 },
    { slot_start_utc: t, series_key: 'grid_export_w', source_kind: 'vrm_import', unit: 'kWh', value_num: 1.0 },
    { slot_start_utc: t, series_key: 'pv_total_w', source_kind: 'vrm_import', unit: 'kWh', value_num: 1.5 },
    { slot_start_utc: t, series_key: 'pv_total_w', source_kind: 'local_live', unit: 'kWh', value_num: 9.9 }, // verliert gegen VRM
    { slot_start_utc: t, series_key: 'self_consumption_w', source_kind: 'local_live', unit: 'kWh', value_num: 0.3 },
    { slot_start_utc: t, series_key: 'battery_charge_w', source_kind: 'vrm_import', unit: 'kWh', value_num: 0.2 },
    { slot_start_utc: t, series_key: 'battery_discharge_w', source_kind: 'vrm_import', unit: 'kWh', value_num: 0.5 },
    // VRM-battery_power_w ist vorzeichenlos (Laden+Entladen) — darf NIE verwendet werden
    { slot_start_utc: t, series_key: 'battery_power_w', source_kind: 'vrm_import', unit: 'kWh', value_num: 0.7 },
    // früher Zeitraum: Netz schon als W gespeichert
    { slot_start_utc: '2025-06-15T10:15:00.000Z', series_key: 'grid_import_w', source_kind: 'vrm_import', unit: 'W', value_num: 250 },
    { slot_start_utc: '2025-06-15T10:15:00.000Z', series_key: 'grid_export_w', source_kind: 'vrm_import', unit: 'W', value_num: 0 },
  ];
  const r = slotRowsToReadings(rows, ALL);
  const at = (key, ts = '2025-06-15T10:00:00Z') => r.find((x) => x.key === key && x.timestamp === ts)?.power;
  assert.equal(at('grid'), -3600, '0,1 − 1,0 kWh/15 min = −3600 W (Einspeisung)');
  assert.equal(at('pv'), 6000);
  assert.equal(at('load'), 1200);
  assert.equal(at('battery'), -1200, 'Entladen überwiegt → negativ');
  assert.equal(at('grid', '2025-06-15T10:15:00Z'), 250);
});

test('Viertelstunden: fehlende Paar-Seite = 0 (VRM lässt Null-Slots aus), beide fehlen = kein Wert', () => {
  const t = '2025-07-01T00:00:00.000Z';
  const r = slotRowsToReadings([
    { slot_start_utc: t, series_key: 'battery_discharge_w', source_kind: 'vrm_import', unit: 'kWh', value_num: 0.25 },
  ], ALL);
  assert.deepEqual(r.map((x) => [x.key, x.power]), [['battery', -1000]]);
});

test('Viertelstunden: unbekannte Einheit wird nicht geraten', () => {
  const r = slotRowsToReadings([{ slot_start_utc: '2025-07-01T00:00:00Z', series_key: 'pv_total_w', source_kind: 'vrm_import', unit: 'Wh', value_num: 5 }], ALL);
  assert.equal(r.length, 0);
});

test('Live: Bezug/Einspeisung gepaart, eine Messung je Sekunde, Kachel kW→W, sortiert', () => {
  const rows = [
    { ts_utc: '2026-04-01T10:00:05.400Z', series_key: 'grid_import_w', value_num: 0 },
    { ts_utc: '2026-04-01T10:00:05.400Z', series_key: 'grid_export_w', value_num: 800 },
    { ts_utc: '2026-04-01T10:00:00.100Z', series_key: 'battery_power_w', value_num: 500 },
    { ts_utc: '2026-04-01T10:00:00.900Z', series_key: 'battery_power_w', value_num: 510 }, // gleiche Sekunde → verworfen
    { ts_utc: '2026-04-01T10:00:10.000Z', series_key: 'grid_import_w', value_num: 100 }, // ohne Partner → verworfen
    { ts_utc: '2026-04-01T10:00:01.000Z', series_key: 'mqtt_tile_sauna', value_num: 2.5, unit: 'kW' },
    { ts_utc: '2026-04-01T10:00:02.000Z', series_key: 'mqtt_tile_temp', value_num: 21, unit: '°C' },
  ];
  const r = liveRowsToReadings(rows, ALL);
  assert.deepEqual(r, [
    { key: 'battery', timestamp: '2026-04-01T10:00:00Z', power: 500 },
    { key: 'tile:sauna', timestamp: '2026-04-01T10:00:01Z', power: 2500 },
    { key: 'grid', timestamp: '2026-04-01T10:00:05Z', power: -800 },
  ]);
});

test('abgewählte Quellen werden auch im Nachversand nicht gesendet', () => {
  const r = liveRowsToReadings([{ ts_utc: '2026-04-01T10:00:00Z', series_key: 'pv_total_w', value_num: 1 }], { ...ALL, pv: false });
  assert.equal(r.length, 0);
});

// ── Hintergrundjob ───────────────────────────────────────────────────────────

const SLOT_FROM = Date.parse('2025-05-22T16:30:00Z');
const LIVE_FROM = Date.parse('2026-03-26T00:00:00Z');
const LINKED = LIVE_FROM + 2 * 3600_000; // Live-Spende startete 2 h nach Beginn der Live-Daten

// Nachgebaute DB: Viertelstunden (nur PV, 0,25 kWh) vom 22.05.2025 bis Live-Beginn,
// danach Live-PV alle 5 s mit 1000 W.
function fakeDb({ calls }) {
  return {
    async query(sql, params) {
      calls.push(sql.replace(/\s+/g, ' ').slice(0, 60));
      if (sql.includes('min(slot_start_utc)')) return { rows: [{ t: new Date(SLOT_FROM) }] };
      if (sql.includes('LIMIT 1')) return { rows: [{ t: new Date(LIVE_FROM) }] };
      const from = Date.parse(params[sql.includes('energy_slots_15m') ? 0 : 1]);
      const to = Date.parse(params[sql.includes('energy_slots_15m') ? 1 : 2]);
      const rows = [];
      if (sql.includes('energy_slots_15m')) {
        for (let t = Math.ceil(from / 900_000) * 900_000; t < Math.min(to, LIVE_FROM); t += 900_000) {
          rows.push({ slot_start_utc: new Date(t), series_key: 'pv_total_w', source_kind: 'vrm_import', unit: 'kWh', value_num: 0.25 });
        }
      } else {
        for (let t = Math.max(from, LIVE_FROM); t < to; t += 5000) rows.push({ ts_utc: new Date(t), series_key: 'pv_total_w', value_num: 1000 });
      }
      return { rows };
    },
  };
}
function setupBackfill({ submitImpl } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-dsbf-'));
  fs.writeFileSync(path.join(dir, SIDECAR_NAME), JSON.stringify({ apiKey: 'KEY', clientId: 'C1', meters: {}, donated: 0, linkedAt: new Date(LINKED).toISOString() }));
  const calls = [];
  const sent = [];
  const client = {
    registerMeter: async (k, c, meta) => { calls.push(`register:${meta.name}`); return 'M-PV'; },
    submitBatch: async (k, c, readings) => {
      if (submitImpl) { const r = submitImpl(readings); if (r) return r; }
      sent.push(...readings);
      return { accepted: readings.length, unknownMeters: [] };
    },
  };
  const cfg = { datenspende: { enabled: true, sources: { grid: false, load: false, battery: false } } };
  const svc = createDatenspende({ getDataDir: () => dir, getCfg: () => cfg, pushLog: () => {}, db: fakeDb({ calls }) },
    { client, now: () => LINKED + 60_000, sleep: async () => {} });
  return { dir, svc, sent, calls, cfg };
}

test('Nachversand: vom ältesten Viertelstundenwert bis zum Start der Live-Spende, danach „fertig“', async () => {
  const s = setupBackfill();
  s.svc.startBackfill();
  await s.svc.runBackfill();
  const st = s.svc.status();
  assert.equal(st.backfill.status, 'done');
  assert.equal(st.backfill.firstData, new Date(SLOT_FROM).toISOString());
  const slots = Math.round((LIVE_FROM - SLOT_FROM) / 900_000);
  const live = 2 * 3600 / 5;
  assert.equal(s.sent.length, slots + live, 'jede Viertelstunde + jeder Live-Wert genau einmal');
  assert.equal(s.sent[0].timestamp, '2025-05-22T16:30:00Z');
  assert.equal(s.sent[0].power, 1000, '0,25 kWh/15 min = 1000 W');
  assert.equal(s.sent.at(-1).timestamp, '2026-03-26T01:59:55Z', 'endet vor dem Start der Live-Spende');
  assert.ok(s.sent.every((r) => r.meter_id === 'M-PV'));
  assert.equal(st.backfill.sent, s.sent.length);
  assert.equal(s.calls.filter((c) => c.startsWith('register')).length, 1, 'Zähler nur einmal registriert');
  const ts = s.sent.map((r) => r.timestamp);
  assert.deepEqual(ts, [...ts].sort(), 'chronologisch');
});

test('Nachversand: Server lehnt ab → angehalten mit Fehlermeldung, Cursor bleibt stehen', async () => {
  let n = 0;
  const s = setupBackfill({ submitImpl: () => { if (++n === 3) throw new DatenspendeRequestError('400 bad_request: timestamp too old'); } });
  s.svc.startBackfill();
  await s.svc.runBackfill();
  const bf = s.svc.status().backfill;
  assert.equal(bf.status, 'error');
  assert.match(bf.error, /too old/);
  const cursorAtError = bf.cursor;
  // Erneut starten → setzt am selben Stand fort (nichts übersprungen)
  s.svc.startBackfill();
  assert.equal(s.svc.status().backfill.cursor, cursorAtError);
});

test('Nachversand: Verbindung weg → gleiches Fenster später erneut, nichts verloren', async () => {
  let n = 0;
  const s = setupBackfill({ submitImpl: () => { if (++n === 2) throw new DatenspendeConnError('offline'); } });
  s.svc.startBackfill();
  await s.svc.runBackfill();
  assert.equal(s.svc.status().backfill.status, 'done');
  const ts = s.sent.map((r) => r.timestamp);
  assert.equal(new Set(ts).size, Math.round((LIVE_FROM - SLOT_FROM) / 900_000) + 2 * 3600 / 5, 'alle Werte angekommen');
});

test('Nachversand: Stoppen, Pausieren der Spende und Trennen halten ihn an', async () => {
  const s = setupBackfill({ submitImpl: () => null });
  s.cfg.datenspende.enabled = false;
  s.svc.startBackfill();
  await s.svc.runBackfill();
  assert.equal(s.sent.length, 0, 'Spende pausiert → Nachversand ruht');
  assert.equal(s.svc.status().backfill.status, 'running', 'läuft beim Einschalten weiter');
  s.svc.stopBackfill();
  s.cfg.datenspende.enabled = true;
  await s.svc.runBackfill();
  assert.equal(s.sent.length, 0, 'gestoppt');
  s.svc.unlink();
  assert.equal(s.svc.status().backfill, null);
});

test('Viertelstunden: vorzeichenlose VRM-Reihe battery_power_w wird gar nicht abgefragt', () => {
  assert.ok(!slotSeriesFor(ALL).includes('battery_power_w'));
  assert.ok(slotSeriesFor(ALL).includes('battery_charge_w') && slotSeriesFor(ALL).includes('battery_discharge_w'));
});
