// services/devices/index.js -- Device Service factory (INTG-05)
//
// Manages a registry of configured smart plugs with live power readings.
// Plugin-based adapter system: MQTT Generic and Shelly HTTP adapters.
//
// DB schema: Migration 024-device-readings.sql legt die Tabelle an (läuft vor dem
// Datenbank-Pool, auf jeder Installation). Der Dienst legt sie zusätzlich vor dem
// ersten Speichern an und nach „Relation existiert nicht“ (42P01) neu — M23
// (Feld 19.11.2026): start() lief oft, bevor der Pool stand; die Tabelle fehlte,
// der Speicher-Takt lief trotzdem und meldete jede Minute rot.
//
// Factory: createDeviceService(ctx, hub) -> { start, close, getDevices }
// DI context: { getCfg, pushLog, db }

import { createMqttGenericAdapter } from './adapters/mqtt-generic.js';
import { isReadOnlyMode } from '../../read-only-guard.js';
import { notHaltActive } from '../emergency-stop/policy.js';
import { createShellyHttpAdapter } from './adapters/shelly-http.js';

// --- Inline DB Schema (matches forecast-store.js pattern) ---

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS device_readings (
    id BIGSERIAL PRIMARY KEY,
    device_id TEXT NOT NULL,
    ts_utc TIMESTAMPTZ NOT NULL DEFAULT now(),
    power_w DOUBLE PRECISION,
    energy_today_wh DOUBLE PRECISION,
    online BOOLEAN NOT NULL DEFAULT true,
    meta_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_device_readings_device_ts ON device_readings(device_id, ts_utc);
`;

const PERSIST_INTERVAL_MS = 60_000; // 60 seconds

/**
 * @param {{ getCfg: Function, pushLog: Function, db: object|null }} ctx
 * @param {{ subscribe: Function, publish: Function }|null} hub - MQTT hub (optional)
 * @returns {{ start: Function, close: Function, getDevices: Function, _persistReadings: Function }}
 */
export function createDeviceService(ctx, hub) {
  const { getCfg, pushLog } = ctx;
  // ctx.db is a LAZY GETTER in server.js — dbPool is only assigned later, inside
  // createTelemetryStoreIfEnabled(). Destructuring `db` here would evaluate that
  // getter at factory time (server.js:1067), long before the pool exists
  // (server.js:1425), and freeze it to null forever: the schema was never created
  // and no reading was ever persisted. Read it through the getter on every use.
  const getDb = () => ctx.db || null;
  const adapters = [];
  let persistTimer = null;
  // M23: Tabelle angelegt? (Pool kann nach start() kommen, die Tabelle kann verschwinden.)
  let schemaReady = false;
  // M23: Speicherfehler einmal je Episode melden: { sinceMs, failed }.
  let persistFailure = null;

  /**
   * Create DB schema if database available.
   * @returns {Promise<{ok:boolean, error?:Error}>}
   */
  async function ensureSchema() {
    const db = getDb();
    if (!db) return { ok: false };
    try {
      await db.query(SCHEMA_SQL);
      schemaReady = true;
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err };
    }
  }

  function notePersistFailure(deviceId, err) {
    if (!persistFailure) {
      persistFailure = { sinceMs: Date.now(), failed: 0 };
      // Geräte-Verlauf (Smart-Plugs) ist kein Steuerweg: Warnung, einmal je Episode — nicht jede Minute rot.
      pushLog('device_persist_error', {
        device: deviceId,
        error: err?.message || String(err),
        code: err?.code ?? null,
        note: 'Geräte-Verlauf wird nicht gespeichert; Meldung einmal je Episode, das Ende meldet device_persist_recovered',
      }, 'warn');
    }
    persistFailure.failed += 1;
  }

  function notePersistOk() {
    if (!persistFailure) return;
    pushLog('device_persist_recovered', {
      failed: persistFailure.failed,
      minutes: Math.round((Date.now() - persistFailure.sinceMs) / 60_000),
    });
    persistFailure = null;
  }

  async function start() {
    // Step 1: Create DB schema (ohne Pool später, vor dem ersten Speichern)
    const schema = await ensureSchema();
    if (schema.error) pushLog('device_schema_error', { error: schema.error.message, code: schema.error.code ?? null }, 'warn');

    // Step 2: Read device configs
    const devices = getCfg().devices || [];
    if (!devices.length) {
      pushLog('device_service_skip', { reason: 'no devices configured' });
      return;
    }

    // Step 3: Group devices by adapter type and create adapters
    const mqttDevices = devices.filter(d => d.adapter === 'mqtt-generic');
    const shellyDevices = devices.filter(d => d.adapter === 'shelly-http');

    if (mqttDevices.length && hub) {
      const mqttAdapter = createMqttGenericAdapter(hub, mqttDevices, pushLog);
      adapters.push(mqttAdapter);
      await mqttAdapter.start();
    }

    if (shellyDevices.length) {
      const shellyAdapter = createShellyHttpAdapter(shellyDevices, pushLog);
      adapters.push(shellyAdapter);
      await shellyAdapter.start();
    }

    // Step 4: Start persistence timer — immer: der Pool kann erst nach start()
    // kommen (ctx.db ist ein später Getter); ohne Pool kehrt persistReadings sofort
    // zurück. Vorher entschied ein einmaliger Blick hier, ob je gespeichert wird.
    persistTimer = setInterval(() => persistReadings(), PERSIST_INTERVAL_MS);

    pushLog('device_service_started', { count: devices.length });
  }

  /**
   * Aggregate readings from all adapters into a single DeviceReading[].
   *
   * Inc 2 (Last-Separation): the `managed` flag is resolved HERE from config
   * rather than threaded through every adapter. It says "dvhub itself switches
   * this device", which is what makes its power eligible to be subtracted from
   * the learned load curve. Adapters describe what a device *measures*; whether
   * we *control* it is registry knowledge, so it belongs in one place. Default
   * is false -- an unmarked device is never subtracted.
   *
   * @returns {Array<{id: string, name: string, powerW: number|null, energyTodayWh: number|null, online: boolean, lastSeen: number, managed: boolean}>}
   */
  function getDevices() {
    const managedById = new Map(
      (getCfg().devices || []).map(d => [d.id, d.managed === true])
    );
    const all = [];
    for (const adapter of adapters) {
      for (const dev of adapter.getDevices()) {
        all.push({ ...dev, managed: managedById.get(dev.id) === true });
      }
    }
    return all;
  }

  /**
   * Persist current readings to PostgreSQL device_readings table.
   */
  async function persistReadings() {
    const db = getDb();
    if (!db) return;
    if (!schemaReady) await ensureSchema();
    const readings = getDevices();
    const insert = (r) => db.query(
      `INSERT INTO device_readings (device_id, ts_utc, power_w, energy_today_wh, online, meta_json)
       VALUES ($1, now(), $2, $3, $4, $5)`,
      [r.id, r.powerW, r.energyTodayWh, r.online, (r.output != null ? JSON.stringify({ output: r.output }) : null)]
    );
    // Episode je Speicher-Durchgang (Codex 372cd1db P2): beendet erst ein Durchgang ganz ohne Fehler — sonst
    // meldete ein gesundes Gerät neben einem dauerhaft scheiternden jede Minute „wieder gut“ und neu „Fehler“.
    let firstFailure = null;
    let wrote = 0;
    for (const r of readings) {
      try {
        await insert(r);
        wrote += 1;
      } catch (err) {
        let failure = err;
        // Tabelle fehlt (42P01, z. B. Datenbank zurückgesetzt): einmal neu anlegen, dann erneut speichern.
        if (err?.code === '42P01') {
          schemaReady = false;
          const schema = await ensureSchema();
          if (schema.ok) {
            try {
              await insert(r);
              wrote += 1;
              continue;
            } catch (retryErr) {
              failure = retryErr;
            }
          }
        }
        if (!firstFailure) firstFailure = { id: r.id, err: failure };
      }
    }
    if (firstFailure) notePersistFailure(firstFailure.id, firstFailure.err);
    else if (wrote > 0) notePersistOk();
  }

  /**
   * Toggle a switchable device's relay (e.g. Shelly). Routes to the owning
   * adapter's setOutput(). Returns { ok, output } or { ok:false, error }.
   */
  async function setDeviceOutput(deviceId, on) {
    // Lese-Modus (DVHUB_READ_ONLY=1): keine echten Relais schalten.
    if (isReadOnlyMode()) return { ok: false, error: 'read_only' };
    // Not-Halt „als ob aus“: kein Schalten über DVhub, auch nicht von Hand.
    if (notHaltActive()) return { ok: false, error: 'emergency_stop_active' };
    for (const adapter of adapters) {
      if (typeof adapter.setOutput !== 'function') continue;
      const r = await adapter.setOutput(deviceId, on);
      if (r && r.ok) return r;
      // 'unknown_device' → device belongs to another adapter; keep looking.
      if (r && r.error && r.error !== 'unknown_device') return r;
    }
    return { ok: false, error: 'device_not_found_or_not_switchable' };
  }

  async function close() {
    if (persistTimer) {
      clearInterval(persistTimer);
      persistTimer = null;
    }
    for (const adapter of adapters) {
      if (adapter.close) await adapter.close();
    }
    adapters.length = 0;
  }

  return {
    start,
    close,
    getDevices,
    setDeviceOutput,
    // Test helper: allows tests to trigger manual persistence
    _persistReadings: persistReadings,
  };
}
