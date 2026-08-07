// services/devices/index.js -- Device Service factory (INTG-05)
//
// Manages a registry of configured smart plugs with live power readings.
// Plugin-based adapter system: MQTT Generic and Shelly HTTP adapters.
//
// DB schema created inline matching project pattern (forecast-store.js,
// telemetry-store-pg.js) -- NO separate migration files.
//
// Factory: createDeviceService(ctx, hub) -> { start, close, getDevices }
// DI context: { getCfg, pushLog, db }

import { createMqttGenericAdapter } from './adapters/mqtt-generic.js';
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

  /**
   * Create DB schema if database available.
   */
  async function ensureSchema() {
    const db = getDb();
    if (!db) return;
    try {
      await db.query(SCHEMA_SQL);
    } catch (err) {
      pushLog('device_schema_error', { error: err.message });
    }
  }

  async function start() {
    // Step 1: Create DB schema
    await ensureSchema();

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

    // Step 4: Start persistence timer
    if (getDb()) {
      persistTimer = setInterval(() => persistReadings(), PERSIST_INTERVAL_MS);
    }

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
    const readings = getDevices();
    for (const r of readings) {
      try {
        await db.query(
          `INSERT INTO device_readings (device_id, ts_utc, power_w, energy_today_wh, online, meta_json)
           VALUES ($1, now(), $2, $3, $4, $5)`,
          [r.id, r.powerW, r.energyTodayWh, r.online, (r.output != null ? JSON.stringify({ output: r.output }) : null)]
        );
      } catch (err) {
        pushLog('device_persist_error', { device: r.id, error: err.message });
      }
    }
  }

  /**
   * Toggle a switchable device's relay (e.g. Shelly). Routes to the owning
   * adapter's setOutput(). Returns { ok, output } or { ok:false, error }.
   */
  async function setDeviceOutput(deviceId, on) {
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
