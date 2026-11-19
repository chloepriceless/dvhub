// test/device-readings-m23.test.js — M23 (Feld 19.11.2026): nach dem Update kam
// im Systemprotokoll jede Minute rot
//   device_persist_error … device "shelly_mwjoco230", error "Relation »device_readings« existiert nicht".
//
// Ursache (am Code): Die Tabelle legte nur der Geräte-Dienst selbst an
// (ensureSchema in start()). start() läuft beim Hochfahren, oft BEVOR der
// Datenbank-Pool steht (server.js weist dbPool erst nach Verbindung und
// Migrationen zu). Dann übersprang ensureSchema die Tabelle; stand der Pool,
// bis start() den Speicher-Takt einrichtete (nach dem Start der Adapter), lief
// der Takt jede Minute gegen eine fehlende Tabelle. Stand er auch dann noch
// nicht, wurde nie etwas gespeichert.
// Jetzt: Migration 024 legt die Tabelle an (läuft vor dem Pool, auf jeder
// Installation); der Dienst legt sie vor dem ersten Speichern an, wenn nötig,
// richtet den Takt immer ein und meldet einen Speicherfehler einmal je Episode
// (Warnung), nicht jede Minute.

import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeviceService } from '../services/devices/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEVICES = [{ id: 'shelly_test', name: 'Steckdose', adapter: 'mqtt-generic', mqtt: { topic: 'test/plug', powerField: 'power', energyField: 'energy' } }];
const hub = { subscribe() {}, publish() {} };

function makePushLog() {
  const logs = [];
  const fn = (event, data, level) => logs.push({ event, data, level });
  fn.logs = logs;
  return fn;
}

/** DB ohne device_readings: INSERT scheitert wie PostgreSQL (42P01), bis CREATE TABLE lief. */
function makeDb({ createFails = false } = {}) {
  const queries = [];
  let table = false;
  return {
    queries,
    get tableExists() { return table; },
    query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('CREATE TABLE IF NOT EXISTS device_readings')) {
        if (createFails) return Promise.reject(Object.assign(new Error('keine Berechtigung für Schema public'), { code: '42501' }));
        table = true;
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('INSERT INTO device_readings') && !table) {
        return Promise.reject(Object.assign(new Error('Relation »device_readings« existiert nicht'), { code: '42P01' }));
      }
      return Promise.resolve({ rows: [] });
    },
  };
}

const flush = () => new Promise((r) => setImmediate(r));
const services = [];
const track = (svc) => { services.push(svc); return svc; };
afterEach(async () => { while (services.length) await services.pop().close(); });

describe('M23: device_readings fehlt nach dem Update', () => {
  it('Feldfall: Pool erst nach start() da — der Takt legt die Tabelle an und speichert ohne Fehler', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    try {
      let lateDb = null;
      const pushLog = makePushLog();
      const ctx = { getCfg: () => ({ devices: DEVICES }), pushLog, get db() { return lateDb; } };
      const service = track(createDeviceService(ctx, hub));
      await service.start();               // Pool noch nicht da
      lateDb = makeDb();                   // … jetzt (createTelemetryStoreIfEnabled)
      mock.timers.tick(60_000);
      await flush(); await flush();
      const sqls = lateDb.queries.map((q) => q.sql);
      const create = sqls.findIndex((s) => s.includes('CREATE TABLE IF NOT EXISTS device_readings'));
      const insert = sqls.findIndex((s) => s.includes('INSERT INTO device_readings'));
      assert.ok(create >= 0, 'Tabelle wird vor dem Speichern angelegt');
      assert.ok(insert > create, 'gespeichert wird danach');
      assert.equal(pushLog.logs.filter((l) => l.event === 'device_persist_error').length, 0);
      await service.close();
    } finally {
      mock.timers.reset();
    }
  });

  it('Tabelle verschwindet (42P01): einmal neu anlegen und erneut speichern', async () => {
    const pushLog = makePushLog();
    const db = makeDb();
    const ctx = { getCfg: () => ({ devices: DEVICES }), pushLog, db };
    const service = track(createDeviceService(ctx, hub));
    await service.start();
    db.queries.length = 0;
    // Tabelle weg (z. B. Datenbank zurückgesetzt), der Dienst hält sie für angelegt.
    const orig = db.query.bind(db);
    let dropped = true;
    db.query = (sql, params) => {
      if (dropped && sql.includes('INSERT INTO device_readings')) {
        db.queries.push({ sql, params });
        return Promise.reject(Object.assign(new Error('Relation »device_readings« existiert nicht'), { code: '42P01' }));
      }
      if (sql.includes('CREATE TABLE IF NOT EXISTS device_readings')) dropped = false;
      return orig(sql, params);
    };
    await service._persistReadings();
    const sqls = db.queries.map((q) => q.sql);
    assert.equal(sqls.filter((s) => s.includes('INSERT INTO device_readings')).length, 2, 'nach dem Neuanlegen ein zweiter Versuch');
    assert.equal(pushLog.logs.filter((l) => l.event === 'device_persist_error').length, 0);
    await service.close();
  });

  it('dauerhafter Fehler: einmal je Episode als Warnung, nicht jede Minute rot; Ende wird gemeldet', async () => {
    const pushLog = makePushLog();
    const db = makeDb({ createFails: true });
    const ctx = { getCfg: () => ({ devices: DEVICES }), pushLog, db };
    const service = track(createDeviceService(ctx, hub));
    await service.start();
    for (let i = 0; i < 5; i += 1) await service._persistReadings();
    const errs = pushLog.logs.filter((l) => l.event === 'device_persist_error');
    assert.equal(errs.length, 1, 'einmal je Episode');
    assert.equal(errs[0].level, 'warn', 'Geräte-Verlauf ist kein Steuerfehler — gelb, nicht rot');
    assert.match(errs[0].data.error, /existiert nicht/);
    // Wieder in Ordnung: Ende der Episode einmal melden.
    db.query = (sql) => Promise.resolve({ rows: [], sql });
    await service._persistReadings();
    await service._persistReadings();
    assert.equal(pushLog.logs.filter((l) => l.event === 'device_persist_recovered').length, 1);
    // Neue Episode → wieder eine Meldung.
    db.query = () => Promise.reject(new Error('Verbindung verloren'));
    await service._persistReadings();
    await service._persistReadings();
    assert.equal(pushLog.logs.filter((l) => l.event === 'device_persist_error').length, 2);
    await service.close();
  });

  // Codex 372cd1db P2: ein Gerät scheitert dauerhaft, ein anderes speichert — keine Meldung je Takt, kein falsches
  // „wieder gut“; das Ende meldet erst ein Durchgang ganz ohne Fehler.
  it('mehrere Geräte, eines scheitert dauerhaft: eine Warnung, kein falsches Ende; Ende nach fehlerfreiem Durchgang', async () => {
    const pushLog = makePushLog();
    let badFails = true;
    const db = {
      query(sql, params) {
        if (sql.includes('INSERT INTO device_readings') && params?.[0] === 'bad' && badFails) {
          return Promise.reject(Object.assign(new Error('Wert zu lang'), { code: '22001' }));
        }
        return Promise.resolve({ rows: [] });
      },
    };
    const devices = [
      { id: 'good', name: 'G', adapter: 'mqtt-generic', mqtt: { topic: 't/good', powerField: 'power' } },
      { id: 'bad', name: 'B', adapter: 'mqtt-generic', mqtt: { topic: 't/bad', powerField: 'power' } },
    ];
    const service = track(createDeviceService({ getCfg: () => ({ devices }), pushLog, db }, hub));
    await service.start();
    for (let i = 0; i < 4; i += 1) await service._persistReadings();
    assert.equal(pushLog.logs.filter((l) => l.event === 'device_persist_error').length, 1);
    assert.equal(pushLog.logs.filter((l) => l.event === 'device_persist_recovered').length, 0, 'das kaputte Gerät ist nicht wieder gut');
    badFails = false;
    await service._persistReadings();
    const rec = pushLog.logs.filter((l) => l.event === 'device_persist_recovered');
    assert.equal(rec.length, 1);
    assert.equal(rec[0].data.failed, 4, 'vier Durchgänge mit Fehler');
  });

  it('Migration 024 legt device_readings auf jeder Installation an (vor dem Pool, wie alle Migrationen)', () => {
    const file = path.join(__dirname, '..', 'db', 'migrations', '024-device-readings.sql');
    assert.ok(fs.existsSync(file), '024-device-readings.sql fehlt');
    const sql = fs.readFileSync(file, 'utf8');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS device_readings\s*\(/);
    assert.match(sql, /ts_utc\s+TIMESTAMPTZ/);
    assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_device_readings_device_ts ON device_readings\s*\(device_id, ts_utc\)/);
    assert.match(sql, /INSERT INTO schema_migrations[\s\S]*VALUES \(24,/);
    assert.equal((sql.match(/^BEGIN;\s*$/gm) || []).length, 1);
    assert.equal((sql.match(/^COMMIT;\s*$/gm) || []).length, 1);
  });
});
