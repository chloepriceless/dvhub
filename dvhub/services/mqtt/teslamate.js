// services/mqtt/teslamate.js -- TeslaMate MQTT subscriber (INTG-04, INTG-06)
//
// Subscribes to TeslaMate MQTT topics via the MQTT Hub, caches 15 vehicle
// fields in memory, and persists snapshots to PostgreSQL at a configurable
// interval.  Display-only per D-10 -- no active vehicle control.
//
// Factory: createTeslamateSubscriber(hub, ctx) -> { start, close, getState, lastUpdateAt }
// DI context: { getCfg, pushLog, db }

// ── Topic-to-field mapping (15 TeslaMate topics from RESEARCH.md) ───

const TOPIC_MAP = {
  display_name:           { key: 'displayName',        parse: String },
  state:                  { key: 'state',              parse: String },
  battery_level:          { key: 'batteryLevel',       parse: Number },
  usable_battery_level:   { key: 'usableBatteryLevel', parse: Number },
  est_battery_range_km:   { key: 'estRangeKm',        parse: Number },
  rated_battery_range_km: { key: 'ratedRangeKm',      parse: Number },
  plugged_in:             { key: 'pluggedIn',          parse: v => v === 'true' },
  charging_state:         { key: 'chargingState',      parse: String },
  charge_energy_added:    { key: 'chargeEnergyAdded',  parse: Number },
  charge_limit_soc:       { key: 'chargeLimitSoc',     parse: Number },
  charger_power:          { key: 'chargerPower',       parse: Number },
  charger_voltage:        { key: 'chargerVoltage',     parse: Number },
  charger_actual_current: { key: 'chargerCurrent',     parse: Number },
  geofence:               { key: 'geofence',           parse: String },
  inside_temp:            { key: 'insideTemp',         parse: Number }
};

// Fields whose parse function returns a number and must be validated
const NUMERIC_KEYS = new Set(
  Object.values(TOPIC_MAP)
    .filter(v => v.parse === Number)
    .map(v => v.key)
);

// ── DB Schema (inline, matching forecast-store.js / telemetry-store-pg.js pattern) ──

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS tesla_snapshots (
    id BIGSERIAL PRIMARY KEY,
    car_id INTEGER NOT NULL DEFAULT 1,
    ts_utc TIMESTAMPTZ NOT NULL DEFAULT now(),
    battery_level DOUBLE PRECISION,
    usable_battery_level DOUBLE PRECISION,
    est_range_km DOUBLE PRECISION,
    state TEXT,
    charging_state TEXT,
    charger_power_kw DOUBLE PRECISION,
    charge_energy_added_kwh DOUBLE PRECISION,
    charge_limit_soc DOUBLE PRECISION,
    plugged_in BOOLEAN,
    geofence TEXT,
    inside_temp_c DOUBLE PRECISION,
    meta_json TEXT,
    -- Plan 08-08 Task 1: SoC percentages bounded to [0,100]; state/charging_state
    -- enums match Tesla API canonical values. A SoC of 110 nearly always means a
    -- unit-mix-up (fraction vs percent) — fail loud instead of silently corrupting
    -- charge logic. Unknown enum strings should also fail so we notice API drift.
    CONSTRAINT tesla_snapshots_battery_level_range
      CHECK (battery_level IS NULL OR (battery_level >= 0 AND battery_level <= 100)),
    CONSTRAINT tesla_snapshots_usable_battery_range
      CHECK (usable_battery_level IS NULL OR (usable_battery_level >= 0 AND usable_battery_level <= 100)),
    CONSTRAINT tesla_snapshots_charge_limit_range
      CHECK (charge_limit_soc IS NULL OR (charge_limit_soc >= 0 AND charge_limit_soc <= 100)),
    CONSTRAINT tesla_snapshots_state_enum
      CHECK (state IS NULL OR state IN ('asleep', 'online', 'offline', 'charging', 'driving')),
    CONSTRAINT tesla_snapshots_charging_state_enum
      CHECK (charging_state IS NULL OR charging_state IN ('Disconnected', 'Charging', 'Complete', 'Stopped', 'Starting', 'NoPower'))
  );
  CREATE INDEX IF NOT EXISTS idx_tesla_snapshots_car_ts ON tesla_snapshots(car_id, ts_utc);
`;

async function ensureSchema(db) {
  await db.query(SCHEMA_SQL);
}

// ── Snapshot INSERT (parameterized -- T-04-13) ──

const INSERT_SQL = `
  INSERT INTO tesla_snapshots (
    car_id, battery_level, usable_battery_level, est_range_km,
    state, charging_state, charger_power_kw, charge_energy_added_kwh,
    charge_limit_soc, plugged_in, geofence, inside_temp_c, meta_json
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
`;

// ── Factory ─────────────────────────────────────────────────────────

/**
 * @param {{ subscribe: Function }} hub  MQTT Hub from services/mqtt/index.js
 * @param {{ getCfg: Function, pushLog: Function, db: { query: Function } }} ctx  DI context
 */
export function createTeslamateSubscriber(hub, ctx) {
  const { getCfg, pushLog, db } = ctx;

  // Internal cached state
  const cache = {
    displayName: null,
    state: null,
    batteryLevel: null,
    usableBatteryLevel: null,
    estRangeKm: null,
    ratedRangeKm: null,
    pluggedIn: null,
    chargingState: null,
    chargeEnergyAdded: null,
    chargeLimitSoc: null,
    chargerPower: null,
    chargerVoltage: null,
    chargerCurrent: null,
    geofence: null,
    insideTemp: null
  };

  let lastUpdateAt = null;
  let snapshotTimer = null;

  // ── Helpers ──

  function getTeslaConfig() {
    return getCfg().integrations?.tesla || {};
  }

  /**
   * MQTT message handler. Extracts field name from topic, parses payload,
   * validates, and updates cache.
   */
  function handleMessage(topic, payloadBuffer) {
    const cfg = getTeslaConfig();
    const carId = cfg.teslamateCarId || 1;
    const prefix = `teslamate/cars/${carId}/`;

    if (!topic.startsWith(prefix)) return;

    const field = topic.slice(prefix.length);
    const mapping = TOPIC_MAP[field];
    if (!mapping) return; // Unknown topic -- ignore

    const raw = payloadBuffer.toString().trim();

    // Validate numeric fields: reject empty, NaN, Infinity before caching
    if (NUMERIC_KEYS.has(mapping.key)) {
      if (raw === '') return; // Empty payload -- ignore
      const parsed = mapping.parse(raw);
      if (!Number.isFinite(parsed)) return; // Rejects NaN, Infinity, non-numeric
      cache[mapping.key] = parsed;
      lastUpdateAt = new Date();
      return;
    }

    const parsed = mapping.parse(raw);

    cache[mapping.key] = parsed;
    lastUpdateAt = new Date();
  }

  /**
   * Persist a snapshot of the current cache to PostgreSQL.
   * Uses parameterized query only (T-04-13).
   */
  async function persistSnapshot() {
    const cfg = getTeslaConfig();
    const carId = cfg.teslamateCarId || 1;

    // Only persist if we have at least some data
    if (cache.batteryLevel === null && cache.state === null) return;
    if (!db) return;

    const meta = {
      displayName: cache.displayName,
      ratedRangeKm: cache.ratedRangeKm,
      chargerVoltage: cache.chargerVoltage,
      chargerCurrent: cache.chargerCurrent
    };

    try {
      await db.query(INSERT_SQL, [
        carId,
        cache.batteryLevel,
        cache.usableBatteryLevel,
        cache.estRangeKm,
        cache.state,
        cache.chargingState,
        cache.chargerPower,
        cache.chargeEnergyAdded,
        cache.chargeLimitSoc,
        cache.pluggedIn,
        cache.geofence,
        cache.insideTemp,
        JSON.stringify(meta)
      ]);
    } catch (err) {
      pushLog(`[TeslaMate] Snapshot persist error: ${err.message}`);
    }
  }

  // ── Public API ──

  async function start() {
    const cfg = getTeslaConfig();
    if (!cfg.enabled) return; // Disabled -- no-op

    // Create DB schema if database is available
    if (db) {
      await ensureSchema(db);
    }

    const carId = cfg.teslamateCarId || 1;
    const topic = `teslamate/cars/${carId}/#`;
    hub.subscribe(topic, handleMessage);

    // Set up periodic snapshot persistence
    const intervalSec = cfg.snapshotIntervalSec || 300;
    snapshotTimer = setInterval(() => {
      persistSnapshot().catch(err => {
        pushLog(`[TeslaMate] Snapshot timer error: ${err.message}`);
      });
    }, intervalSec * 1000);

    // Prevent timer from keeping Node.js alive
    if (snapshotTimer.unref) snapshotTimer.unref();

    pushLog('teslamate_connected', { carId });
  }

  function close() {
    if (snapshotTimer) {
      clearInterval(snapshotTimer);
      snapshotTimer = null;
    }
  }

  function getState() {
    return Object.freeze({ ...cache });
  }

  return {
    start,
    close,
    getState,
    get lastUpdateAt() { return lastUpdateAt; }
  };
}
