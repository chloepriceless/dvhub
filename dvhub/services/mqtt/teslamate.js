// services/mqtt/teslamate.js -- TeslaMate MQTT subscriber (INTG-04, INTG-06)
//
// Subscribes to TeslaMate MQTT topics via the MQTT Hub, caches 15 vehicle
// fields in memory, and persists snapshots to PostgreSQL at a configurable
// interval.  Display-only per D-10 -- no active vehicle control.
//
// Restart-persistence (Phase 11-06 round 7): TeslaMate only re-publishes a
// topic when its value CHANGES. Fast-changing topics (battery_level, temps,
// charger_voltage) come back within minutes after a dvhub restart, but
// rarely-changing ones (charging_state, charger_power, plugged_in,
// charge_limit_soc, geofence, state) are NOT re-published during steady-state
// charging -- so a RAM-only cache leaves those fields null until the next
// state change, and the Family Dashboard EV tile goes blank after a restart.
// To fix this the cache + lastUpdateAt are mirrored to a JSON file in the
// runtime data directory (next to energy_state.json), seeded back into the
// cache on start() before subscribing. Live MQTT messages always arrive after
// seeding, so the seed is a starting point and never masks fresh data. The
// file is a RUNTIME artefact -- it lives in DV_DATA_DIR (outside the repo) in
// production, and is .gitignore'd for the dev fallback path; it is never
// committed and never added to the deploy tar.
//
// Factory: createTeslamateSubscriber(hub, ctx) -> { start, close, getState, lastUpdateAt }
// DI context: { getCfg, pushLog, db }

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ── Runtime cache-persistence file ──────────────────────────────────
//
// Resolved the SAME way server.js resolves energy_state.json: DV_DATA_DIR
// when set (production -- a directory OUTSIDE the repo, injected via the
// systemd unit), else the dvhub/ application directory for the dev fallback.
// From services/mqtt/ the dvhub/ root is two levels up.
const __teslamateDir = dirname(fileURLToPath(import.meta.url));
const TESLA_CACHE_PATH = join(
  process.env.DV_DATA_DIR || join(__teslamateDir, '..', '..'),
  'tesla-cache.json'
);

// Debounce window for cache writes -- a burst of MQTT messages collapses to
// one disk write this many ms after the last update.
const CACHE_WRITE_DEBOUNCE_MS = 8000;

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
      CHECK (charging_state IS NULL OR charging_state IN ('Disconnected', 'Charging', 'Complete', 'Stopped', 'Starting', 'NoPower')),
    -- Plan 08-08 Task 2: prevent duplicate snapshots per car/timestamp.
    -- Migration 006-unique-constraints.sql also drops the redundant non-unique
    -- index idx_tesla_snapshots_car_ts since the UNIQUE constraint creates its
    -- own implicit btree on the same columns. Fresh installs skip the index
    -- entirely (UNIQUE covers the lookup pattern).
    CONSTRAINT tesla_snapshots_unique_car_ts UNIQUE (car_id, ts_utc)
  );
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
  let cacheWriteTimer = null;

  // Known cache keys -- used to filter a seeded file so an unexpected/renamed
  // field in a stale tesla-cache.json can never inject an unknown property.
  const CACHE_KEYS = Object.keys(cache);

  // ── Cache persistence helpers ──

  /**
   * Write the current cache + lastUpdateAt to the runtime JSON file.
   * Synchronous + try/catch-guarded -- a disk failure must NEVER throw into
   * the MQTT message path or the close() path. On failure we log and continue.
   */
  function writeCacheFile() {
    try {
      const payload = JSON.stringify({
        cache,
        lastUpdateAt: lastUpdateAt ? new Date(lastUpdateAt).toISOString() : null
      });
      writeFileSync(TESLA_CACHE_PATH, payload, 'utf8');
    } catch (err) {
      pushLog(`[TeslaMate] Cache file write error: ${err.message}`);
    }
  }

  /**
   * Schedule a debounced cache write. A burst of MQTT messages resets the
   * timer so it collapses to a single disk write CACHE_WRITE_DEBOUNCE_MS
   * after the last update.
   */
  function scheduleCacheWrite() {
    if (cacheWriteTimer) clearTimeout(cacheWriteTimer);
    cacheWriteTimer = setTimeout(() => {
      cacheWriteTimer = null;
      writeCacheFile();
    }, CACHE_WRITE_DEBOUNCE_MS);
    // Don't let the debounce timer keep Node.js alive.
    if (cacheWriteTimer.unref) cacheWriteTimer.unref();
  }

  /**
   * Seed the in-memory cache from the runtime JSON file, if it exists and is
   * valid. Only known keys are copied. A missing or corrupt file degrades
   * cleanly to the empty cache (current first-boot behaviour) -- never throws.
   */
  function seedCacheFromFile() {
    let raw;
    try {
      raw = readFileSync(TESLA_CACHE_PATH, 'utf8');
    } catch {
      return; // No file yet (first boot / fresh install) -- empty cache.
    }
    try {
      const parsed = JSON.parse(raw);
      const saved = parsed && typeof parsed.cache === 'object' && parsed.cache
        ? parsed.cache
        : null;
      if (saved) {
        for (const key of CACHE_KEYS) {
          if (saved[key] !== undefined) cache[key] = saved[key];
        }
      }
      if (parsed && parsed.lastUpdateAt) {
        const d = new Date(parsed.lastUpdateAt);
        if (!Number.isNaN(d.getTime())) lastUpdateAt = d;
      }
      pushLog('teslamate_cache_seeded', { path: TESLA_CACHE_PATH });
    } catch (err) {
      // Corrupt JSON -- ignore, start with the empty cache.
      pushLog(`[TeslaMate] Cache file seed error (ignored): ${err.message}`);
    }
  }

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
      scheduleCacheWrite();
      return;
    }

    const parsed = mapping.parse(raw);

    cache[mapping.key] = parsed;
    lastUpdateAt = new Date();
    scheduleCacheWrite();
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

    // Restart-persistence: seed the cache from the runtime JSON file BEFORE
    // subscribing, so the last-known Tesla state is available immediately
    // after a restart. Live MQTT messages arrive after this and overwrite
    // any seeded value, so the seed never masks fresh data.
    seedCacheFromFile();

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
    // Flush any pending debounced write and persist the final cache state, so
    // a graceful shutdown never loses the most recent updates.
    if (cacheWriteTimer) {
      clearTimeout(cacheWriteTimer);
      cacheWriteTimer = null;
    }
    if (lastUpdateAt) writeCacheFile();
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
