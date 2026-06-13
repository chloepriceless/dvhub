// services/mqtt/teslamate.js -- TeslaMate MQTT subscriber (INTG-04, INTG-06)
//
// Subscribes to TeslaMate MQTT topics via the MQTT Hub, caches 15 vehicle
// fields in memory, and persists snapshots to PostgreSQL at a configurable
// interval.  Display-only per D-10 -- no active vehicle control.
//
// Restart-persistence (Phase 11-06 round 8): TeslaMate only re-publishes a
// topic when its value CHANGES. Fast-changing topics (battery_level, temps,
// charger_voltage) come back within minutes after a dvhub restart, but
// rarely-changing ones (charging_state, charger_power, plugged_in,
// charge_limit_soc, geofence, state) are NOT re-published during steady-state
// charging -- so a RAM-only cache leaves those fields null until the next
// state change, and the Family Dashboard EV tile goes blank after a restart.
// To fix this -- and to give Tesla values a proper history, just like the
// generic MQTT tiles -- every received Tesla value is HISTORISED into the
// shared `timeseries_samples` table via ctx.telemetryStore (one series per
// field, keyed `tesla_<field>`), mirroring Plan 11-02's MQTT-tile
// historisation: read lazily at message time, fire-and-forget, never throws
// into the MQTT path. start() then seeds the in-memory cache from the latest
// DB sample per series before subscribing, so a restart restores the
// last-known Tesla state. The round-7 tesla-cache.json runtime file has been
// removed -- the database is now the single persistence mechanism.
//
// Note: the store's read API (querySeries) only returns the numeric value_num
// column. To let string/enum fields (chargingState, state) survive a restart
// the write stores BOTH value_text AND a stable numeric ENUM CODE in value,
// and the seed decodes that code back to the enum string. Booleans (pluggedIn)
// store 0/1. Free-text fields with no numeric encoding (displayName, geofence)
// are historised as text only and are not seeded back -- they are display-only
// labels, not charging-critical, and re-publish quickly enough.
//
// Factory: createTeslamateSubscriber(hub, ctx) -> { start, close, getState, lastUpdateAt }
// DI context: { getCfg, pushLog, db, telemetryStore }

// ── Topic-to-field mapping (15 TeslaMate topics from RESEARCH.md) ───

const TOPIC_MAP = {
  display_name:           { key: 'displayName',        parse: String },
  state:                  { key: 'state',              parse: String },
  // TeslaMate's state-change timestamp (ISO). Used to show "veraltet seit …" when
  // the car is offline/asleep and values are frozen (2026-06-13). Free-text like
  // displayName/geofence — no numeric encoding, not in the fixed snapshot INSERT.
  since:                  { key: 'since',              parse: String },
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

// ── Historisation series keys (timeseries_samples) ──────────────────
//
// One series per cache field, keyed tesla_<snake_case_field>. The mapping is
// the inverse of TOPIC_MAP's `key` -> its TeslaMate topic-name suffix, so the
// series key matches the upstream topic naming the operator already knows.
const FIELD_TO_TOPIC = Object.fromEntries(
  Object.entries(TOPIC_MAP).map(([topic, m]) => [m.key, topic])
);
function seriesKeyFor(cacheKey) {
  return 'tesla_' + (FIELD_TO_TOPIC[cacheKey] || cacheKey);
}

// ── Enum encoding ───────────────────────────────────────────────────
//
// querySeries only reads back the numeric value_num column, so an enum field
// is historised with BOTH its value_text AND a stable numeric code in `value`.
// The seed decodes the code back to the enum string. Codes are append-only --
// never renumber an existing entry or a stale DB row decodes to the wrong
// state. Index 0 is reserved as "unknown" so a NaN/missing code decodes to null.
const ENUM_CODES = {
  state:         ['', 'asleep', 'online', 'offline', 'charging', 'driving', 'suspended', 'updating', 'parked'],
  chargingState: ['', 'Disconnected', 'Charging', 'Complete', 'Stopped', 'Starting', 'NoPower']
};
function encodeEnum(field, str) {
  const list = ENUM_CODES[field];
  if (!list) return null;
  const idx = list.indexOf(str);
  return idx > 0 ? idx : null; // 0/unknown -> null (don't historise a code we can't trust)
}
function decodeEnum(field, code) {
  const list = ENUM_CODES[field];
  if (!list) return null;
  const idx = Math.round(Number(code));
  if (!Number.isInteger(idx) || idx <= 0 || idx >= list.length) return null;
  return list[idx];
}

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
 * @param {{ getCfg: Function, pushLog: Function, db: { query: Function }, telemetryStore?: object }} ctx  DI context
 */
export function createTeslamateSubscriber(hub, ctx) {
  // NOTE: telemetryStore is read LAZILY off `ctx` at call time (start() seed /
  // handleMessage write) -- it is assigned onto the shared ctx object by
  // server.js AFTER this factory runs (the same wiring order Plan 11-02 relies
  // on for family-tiles.js), so it is deliberately NOT destructured here.
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

  // ── Historisation ──

  /**
   * Fire-and-forget historise one Tesla field into timeseries_samples, exactly
   * like Plan 11-02's MQTT-tile write: lazy ctx.telemetryStore read, never
   * await, never throws into the MQTT message path; a missing store (boot
   * window) is a silent no-op; a failed PG write routes to pushLog.
   *
   * @param {string} cacheKey  the cache field name (e.g. 'chargingState')
   * @param {number|string|boolean} value  the parsed value already in cache
   */
  function historiseField(cacheKey, value) {
    const store = ctx && ctx.telemetryStore;
    if (!store || typeof store.writeSamples !== 'function') return; // boot-window no-op

    // Build the numeric `value` and textual `valueText` for this field.
    let num = null;
    let text = null;
    if (typeof value === 'number' && Number.isFinite(value)) {
      num = value;
    } else if (typeof value === 'boolean') {
      num = value ? 1 : 0;            // pluggedIn -> 0/1
      text = value ? 'true' : 'false';
    } else if (typeof value === 'string') {
      text = value;
      const code = encodeEnum(cacheKey, value); // enum fields also get a numeric code
      if (code != null) num = code;
    }
    // Nothing meaningful to write (e.g. empty string) -- skip.
    if (num == null && text == null) return;

    Promise.resolve()
      .then(() => store.writeSamples([{
        seriesKey: seriesKeyFor(cacheKey),
        scope: 'live',
        source: 'teslamate',
        quality: 'raw',
        ts: new Date(),
        resolutionSeconds: 1,
        value: num,
        valueText: text,
        unit: null,
        meta: { field: cacheKey }
      }]))
      .catch(err => {
        pushLog('teslamate_historise_error', { field: cacheKey, error: err && err.message });
      });
  }

  /**
   * Seed the in-memory cache from the latest DB sample of each tesla_* series
   * via ctx.telemetryStore.querySeries (the Plan 11-03 read API). Called by
   * start() BEFORE subscribing so a restart restores the last-known Tesla
   * state. Live MQTT messages always arrive after seeding and overwrite it,
   * so the seed never masks fresh data. A missing store / no data / a query
   * error degrades cleanly to the empty cache -- never throws.
   *
   * Note: querySeries returns only the numeric value_num column. Numeric
   * fields seed directly; enum fields decode the numeric code; pluggedIn
   * decodes 0/1; pure free-text fields (displayName, geofence) have no numeric
   * encoding and are intentionally not seeded (display-only, non-critical).
   */
  async function seedCacheFromStore() {
    const store = ctx && ctx.telemetryStore;
    if (!store || typeof store.querySeries !== 'function') return; // store not ready

    const cacheKeys = Object.keys(cache);
    const seriesKeys = cacheKeys.map(seriesKeyFor);
    // A wide window -- the latest sample within ~30 days is plenty to restore
    // the last-known state after a typical restart.
    const end = new Date();
    const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

    let rows;
    try {
      rows = await store.querySeries({ seriesKeys, start, end });
    } catch (err) {
      pushLog('teslamate_seed_error', { error: err && err.message });
      return; // empty cache -- first-boot behaviour
    }
    if (!Array.isArray(rows) || rows.length === 0) return;

    // querySeries returns rows ts ASC -- the LAST row for a series is its
    // newest sample. Walk all rows, keeping the latest per series key.
    const latestBySeries = new Map();
    for (const row of rows) {
      if (row && row.key) latestBySeries.set(row.key, row); // ASC -> last write wins
    }

    let seeded = 0;
    let newestTs = null;
    for (const cacheKey of cacheKeys) {
      const row = latestBySeries.get(seriesKeyFor(cacheKey));
      if (!row || row.value == null) continue;

      let restored = null;
      if (NUMERIC_KEYS.has(cacheKey)) {
        const n = Number(row.value);
        if (Number.isFinite(n)) restored = n;
      } else if (cacheKey === 'pluggedIn') {
        restored = Number(row.value) === 1;
      } else if (ENUM_CODES[cacheKey]) {
        restored = decodeEnum(cacheKey, row.value);
      }
      // Free-text fields (displayName, geofence) have no numeric encoding --
      // skip; they re-publish quickly and are not charging-critical.

      if (restored != null) {
        cache[cacheKey] = restored;
        seeded++;
        const ts = row.ts ? new Date(row.ts) : null;
        if (ts && !Number.isNaN(ts.getTime()) && (!newestTs || ts > newestTs)) {
          newestTs = ts;
        }
      }
    }

    if (seeded > 0) {
      if (newestTs) lastUpdateAt = newestTs;
      pushLog('teslamate_cache_seeded', { fields: seeded });
    }
  }

  // ── Helpers ──

  function getTeslaConfig() {
    return getCfg().integrations?.tesla || {};
  }

  /**
   * MQTT message handler. Extracts field name from topic, parses payload,
   * validates, updates cache, and fire-and-forget historises the value.
   */
  function handleMessage(topic, payloadBuffer) {
    const cfg = getTeslaConfig();
    const carId = cfg.teslamateCarId || 1;
    // Phase 21 (2026-05-23): the topic root is configurable so DVhub can sit
    // alongside a TeslaMate that publishes under a non-default base (e.g.
    // `home/teslamate/cars/...`). Default keeps the upstream-canonical value.
    const base = (cfg.topicPrefix && String(cfg.topicPrefix).trim()) || 'teslamate/cars';
    const prefix = `${base.replace(/\/+$/, '')}/${carId}/`;

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
      historiseField(mapping.key, parsed);
      return;
    }

    const parsed = mapping.parse(raw);

    cache[mapping.key] = parsed;
    lastUpdateAt = new Date();
    historiseField(mapping.key, parsed);
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

    // Restart-persistence: seed the cache from the latest timeseries_samples
    // sample of each tesla_* series BEFORE subscribing, so the last-known
    // Tesla state is available immediately after a restart. Live MQTT messages
    // arrive after this and overwrite any seeded value, so the seed never
    // masks fresh data. A missing store / no data degrades cleanly.
    await seedCacheFromStore();

    const carId = cfg.teslamateCarId || 1;
    const base = (cfg.topicPrefix && String(cfg.topicPrefix).trim()) || 'teslamate/cars';
    const topic = `${base.replace(/\/+$/, '')}/${carId}/#`;
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

    pushLog('teslamate_connected', { carId, topic });
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

  // Phase 21 (2026-05-23): expose the effective subscription topic so the
  // /api/integrations/status payload can show the operator exactly where
  // DVhub is listening (broker URL comes from the MQTT hub, prefix+carId
  // come from this service).
  function getSubscriptionTopic() {
    const cfg = getTeslaConfig();
    const carId = cfg.teslamateCarId || 1;
    const base = (cfg.topicPrefix && String(cfg.topicPrefix).trim()) || 'teslamate/cars';
    return `${base.replace(/\/+$/, '')}/${carId}/#`;
  }

  return {
    start,
    close,
    getState,
    getSubscriptionTopic,
    get lastUpdateAt() { return lastUpdateAt; }
  };
}
