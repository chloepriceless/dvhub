// forecast-store.js -- PostgreSQL schema creation, forecast CRUD, and smart retention.
// Factory receives DI context; ensureSchema creates tables on init.

import { execFileSync } from 'node:child_process';

// --- SQL Schema ---

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS weather_forecasts (
    id BIGSERIAL PRIMARY KEY,
    provider TEXT NOT NULL DEFAULT 'open_meteo',
    ts_utc TIMESTAMPTZ NOT NULL,
    ghi_wm2 DOUBLE PRECISION,
    dni_wm2 DOUBLE PRECISION,
    dhi_wm2 DOUBLE PRECISION,
    temperature_c DOUBLE PRECISION,
    wind_speed_ms DOUBLE PRECISION,
    cloud_cover_pct DOUBLE PRECISION,
    visibility_m DOUBLE PRECISION,
    humidity_pct DOUBLE PRECISION,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(provider, ts_utc)
  );
  CREATE INDEX IF NOT EXISTS idx_weather_forecasts_ts ON weather_forecasts(ts_utc);

  CREATE TABLE IF NOT EXISTS pv_forecasts (
    id BIGSERIAL PRIMARY KEY,
    model TEXT NOT NULL,
    ts_utc TIMESTAMPTZ NOT NULL,
    power_w DOUBLE PRECISION NOT NULL,
    confidence DOUBLE PRECISION NOT NULL DEFAULT 0.3,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    meta_json TEXT,
    UNIQUE(model, ts_utc),
    -- Plan 08-08 Task 1: confidence is a probability scalar in [0,1]; values
    -- outside that range mean the producer is broken. Reject at write time so
    -- downstream merge logic can trust the field as a weight.
    CONSTRAINT pv_forecasts_confidence_range
      CHECK (confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0))
  );
  CREATE INDEX IF NOT EXISTS idx_pv_forecasts_ts ON pv_forecasts(ts_utc);

  CREATE TABLE IF NOT EXISTS load_forecasts (
    id BIGSERIAL PRIMARY KEY,
    model TEXT NOT NULL DEFAULT 'sql_weekday',
    ts_utc TIMESTAMPTZ NOT NULL,
    power_w DOUBLE PRECISION NOT NULL,
    confidence DOUBLE PRECISION NOT NULL DEFAULT 0.3,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    meta_json TEXT,
    UNIQUE(model, ts_utc)
  );
  CREATE INDEX IF NOT EXISTS idx_load_forecasts_ts ON load_forecasts(ts_utc);

  CREATE TABLE IF NOT EXISTS forecast_accuracy (
    id BIGSERIAL PRIMARY KEY,
    forecast_type TEXT NOT NULL,
    model TEXT NOT NULL,
    evaluation_date DATE NOT NULL,
    mae DOUBLE PRECISION,
    rmse DOUBLE PRECISION,
    mape DOUBLE PRECISION,
    sample_count INTEGER,
    confidence_score DOUBLE PRECISION,
    meta_json TEXT,
    UNIQUE(forecast_type, model, evaluation_date),
    -- Plan 08-08 Task 1: error metrics are non-negative by definition (REPOLENS
    -- database/data-integrity/011). A negative MAE/RMSE/MAPE almost always
    -- indicates a sign error in the producer; sample_count below zero is nonsense.
    CONSTRAINT forecast_accuracy_mae_nonneg CHECK (mae IS NULL OR mae >= 0),
    CONSTRAINT forecast_accuracy_rmse_nonneg CHECK (rmse IS NULL OR rmse >= 0),
    CONSTRAINT forecast_accuracy_mape_nonneg CHECK (mape IS NULL OR mape >= 0),
    CONSTRAINT forecast_accuracy_sample_count_nonneg CHECK (sample_count IS NULL OR sample_count >= 0)
  );
  CREATE INDEX IF NOT EXISTS idx_forecast_accuracy_date ON forecast_accuracy(evaluation_date);

  -- Phase 07 FORE-11 / REVIEWS H1: forecast_snapshots with SEPARATE forecast_date + target_date
  -- forecast_date = when the forecast was generated (provenance)
  -- target_date   = which day the slot predicts (accuracy-join key)
  -- Per D-B1 + Pitfall S-2 + REVIEWS.md H1 locked-semantics decision.
  CREATE TABLE IF NOT EXISTS forecast_snapshots (
    forecast_date DATE NOT NULL,
    target_date DATE NOT NULL,
    slot_utc TIMESTAMPTZ NOT NULL,
    layer TEXT NOT NULL,
    power_w DOUBLE PRECISION NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (target_date, slot_utc, layer)
  );
  CREATE INDEX IF NOT EXISTS idx_forecast_snapshots_target_date ON forecast_snapshots(target_date);
  CREATE INDEX IF NOT EXISTS idx_forecast_snapshots_forecast_date ON forecast_snapshots(forecast_date);
  CREATE INDEX IF NOT EXISTS idx_forecast_snapshots_layer ON forecast_snapshots(layer);

  -- Phase 07 FORE-10 D-A5 (re-scoped): client-side quota counter per RESEARCH empirical probe 2026-04-16
  -- Note: billing-month reset semantics are UTC-estimated (first day of calendar month UTC).
  -- Real pvnode billing may use provider-account timezone; for HEMS solo-dev this approximation is acceptable.
  CREATE TABLE IF NOT EXISTS pvnode_quota (
    month_utc DATE PRIMARY KEY,
    calls_used INTEGER NOT NULL DEFAULT 0,
    last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- Phase 07 D-B4 + REVIEWS H9: additive MAE columns -- TWO families:
  --   mae_daily_* = raw per-day MAE (written by Plan 04 each evaluation)
  --   mae_7d_*    = rolling 7-day MAE (computed from mae_daily_* via SQL window -- see Plan 04)
  -- Keeping both avoids the anti-pattern of storing single-day MAE in a column named "7d".
  ALTER TABLE forecast_accuracy ADD COLUMN IF NOT EXISTS mae_daily_pvnode DOUBLE PRECISION;
  ALTER TABLE forecast_accuracy ADD COLUMN IF NOT EXISTS mae_daily_solcast DOUBLE PRECISION;
  ALTER TABLE forecast_accuracy ADD COLUMN IF NOT EXISTS mae_daily_pvlib DOUBLE PRECISION;
  ALTER TABLE forecast_accuracy ADD COLUMN IF NOT EXISTS mae_daily_merged DOUBLE PRECISION;
  ALTER TABLE forecast_accuracy ADD COLUMN IF NOT EXISTS mae_daily_ml DOUBLE PRECISION;
  ALTER TABLE forecast_accuracy ADD COLUMN IF NOT EXISTS mae_7d_pvnode DOUBLE PRECISION;
  ALTER TABLE forecast_accuracy ADD COLUMN IF NOT EXISTS mae_7d_solcast DOUBLE PRECISION;
  ALTER TABLE forecast_accuracy ADD COLUMN IF NOT EXISTS mae_7d_pvlib DOUBLE PRECISION;
  ALTER TABLE forecast_accuracy ADD COLUMN IF NOT EXISTS mae_7d_merged DOUBLE PRECISION;
  ALTER TABLE forecast_accuracy ADD COLUMN IF NOT EXISTS mae_7d_ml DOUBLE PRECISION;
`;

// --- Disk free check (Linux/macOS) ---

/**
 * Get free disk percentage for the given mount path.
 * Returns null if the check fails (e.g. on unsupported OS).
 * @param {string} mountPath
 * @returns {number|null} free percentage 0-100
 */
export function getFreeDiskPct(mountPath = '/') {
  try {
    const output = execFileSync('df', ['-P', mountPath], { encoding: 'utf8', timeout: 5000 });
    const lines = output.trim().split('\n');
    if (lines.length < 2) return null;
    // df -P output: Filesystem 1024-blocks Used Available Capacity Mounted
    const parts = lines[1].split(/\s+/);
    const capacityStr = parts[4]; // e.g. "42%"
    if (!capacityStr) return null;
    const usedPct = parseInt(capacityStr, 10);
    if (isNaN(usedPct)) return null;
    return 100 - usedPct;
  } catch {
    return null;
  }
}

// --- Factory ---

/**
 * Create a forecast store with DB operations and smart retention.
 * @param {object} ctx - DI context { state, getCfg, pushLog, db }
 * @returns {object} store API
 */
export function createForecastStore(ctx) {
  const { getCfg, pushLog } = ctx;

  // Pool will be set after ensureSchema is called
  let pool = null;

  async function ensureSchema(dbPool) {
    pool = dbPool;
    await pool.query(SCHEMA_SQL);
  }

  // --- Insert methods (upsert via ON CONFLICT DO UPDATE) ---

  async function insertWeather(row) {
    const sql = `
      INSERT INTO weather_forecasts (provider, ts_utc, ghi_wm2, dni_wm2, dhi_wm2, temperature_c, wind_speed_ms, cloud_cover_pct, visibility_m, humidity_pct)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (provider, ts_utc) DO UPDATE SET
        ghi_wm2 = EXCLUDED.ghi_wm2, dni_wm2 = EXCLUDED.dni_wm2, dhi_wm2 = EXCLUDED.dhi_wm2,
        temperature_c = EXCLUDED.temperature_c, wind_speed_ms = EXCLUDED.wind_speed_ms,
        cloud_cover_pct = EXCLUDED.cloud_cover_pct, visibility_m = EXCLUDED.visibility_m,
        humidity_pct = EXCLUDED.humidity_pct, fetched_at = NOW()
    `;
    const params = [
      row.provider || 'open_meteo', row.ts_utc,
      row.ghi_wm2 ?? null, row.dni_wm2 ?? null, row.dhi_wm2 ?? null,
      row.temperature_c ?? null, row.wind_speed_ms ?? null,
      row.cloud_cover_pct ?? null, row.visibility_m ?? null, row.humidity_pct ?? null
    ];
    return pool.query(sql, params);
  }

  async function insertPvForecast(row) {
    const sql = `
      INSERT INTO pv_forecasts (model, ts_utc, power_w, confidence, meta_json)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (model, ts_utc) DO UPDATE SET
        power_w = EXCLUDED.power_w, confidence = EXCLUDED.confidence,
        meta_json = EXCLUDED.meta_json, fetched_at = NOW()
    `;
    // power_w is NOT NULL in the schema. Some upstream merges (ensemble) can
    // produce rows where a slot has no value for a given model — coerce to 0
    // here so a single bad slot does not abort the whole forecast.start()
    // chain (which would in turn block load-forecast and forecast-aware reserve).
    const power = Number.isFinite(Number(row.power_w)) ? Number(row.power_w) : 0;
    const params = [
      row.model, row.ts_utc, power,
      row.confidence ?? 0.3, row.meta_json ?? null
    ];
    return pool.query(sql, params);
  }

  async function insertLoadForecast(row) {
    const sql = `
      INSERT INTO load_forecasts (model, ts_utc, power_w, confidence, meta_json)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (model, ts_utc) DO UPDATE SET
        power_w = EXCLUDED.power_w, confidence = EXCLUDED.confidence,
        meta_json = EXCLUDED.meta_json, fetched_at = NOW()
    `;
    const loadPower = Number.isFinite(Number(row.power_w)) ? Number(row.power_w) : 0;
    const params = [
      row.model || 'sql_weekday', row.ts_utc, loadPower,
      row.confidence ?? 0.3, row.meta_json ?? null
    ];
    return pool.query(sql, params);
  }

  async function insertAccuracy(row) {
    const sql = `
      INSERT INTO forecast_accuracy (forecast_type, model, evaluation_date, mae, rmse, mape, sample_count, confidence_score, meta_json)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (forecast_type, model, evaluation_date) DO UPDATE SET
        mae = EXCLUDED.mae, rmse = EXCLUDED.rmse, mape = EXCLUDED.mape,
        sample_count = EXCLUDED.sample_count, confidence_score = EXCLUDED.confidence_score,
        meta_json = EXCLUDED.meta_json
    `;
    const params = [
      row.forecast_type, row.model, row.evaluation_date,
      row.mae ?? null, row.rmse ?? null, row.mape ?? null,
      row.sample_count ?? null, row.confidence_score ?? null, row.meta_json ?? null
    ];
    return pool.query(sql, params);
  }

  // --- Query methods ---

  async function getLatestWeather({ start, end } = {}) {
    const sql = `
      SELECT * FROM weather_forecasts
      WHERE ts_utc >= $1 AND ts_utc <= $2
      ORDER BY ts_utc ASC
    `;
    const result = await pool.query(sql, [start, end]);
    return result.rows;
  }

  async function getLatestPvForecast({ start, end } = {}) {
    const sql = `
      SELECT * FROM pv_forecasts
      WHERE ts_utc >= $1 AND ts_utc <= $2
      ORDER BY ts_utc ASC
    `;
    const result = await pool.query(sql, [start, end]);
    return result.rows;
  }

  async function getLatestLoadForecast({ start, end } = {}) {
    const sql = `
      SELECT * FROM load_forecasts
      WHERE ts_utc >= $1 AND ts_utc <= $2
      ORDER BY ts_utc ASC
    `;
    const result = await pool.query(sql, [start, end]);
    return result.rows;
  }

  async function getAccuracyHistory({ start, end } = {}) {
    const sql = `
      SELECT * FROM forecast_accuracy
      WHERE evaluation_date >= $1 AND evaluation_date <= $2
      ORDER BY evaluation_date ASC
    `;
    const result = await pool.query(sql, [start, end]);
    return result.rows;
  }

  // --- Smart Retention ---

  async function runSmartRetention() {
    const cfg = getCfg();
    const minFree = cfg?.forecast?.retention?.minFreeDiskPct ?? 20;
    const freePct = getFreeDiskPct('/');

    if (freePct === null) {
      pushLog('retention_skip', { reason: 'disk_check_failed' });
      return { action: 'skip', reason: 'disk_check_failed' };
    }

    if (freePct >= minFree) {
      return { action: 'none', freePct };
    }

    // Free < threshold: delete weather_forecasts older than 30 days
    const weatherResult = await pool.query(`
      DELETE FROM weather_forecasts
      WHERE fetched_at < NOW() - INTERVAL '30 days'
    `);

    // Also trim old raw telemetry (high-resolution samples)
    const telemetryResult = await pool.query(`
      DELETE FROM timeseries_samples
      WHERE resolution_seconds <= 15 AND ts_utc < NOW() - INTERVAL '30 days'
    `);

    const deleted = {
      weather_rows: weatherResult.rowCount,
      telemetry_rows: telemetryResult.rowCount
    };

    pushLog('retention_compress', { freePct, minFree, deleted });
    return { action: 'compressed', freePct, deleted };
  }

  function close() {
    pool = null;
  }

  // --- Phase 07 Wave-0 store helpers (REVIEWS H2: first-class deliverables) ---

  /**
   * Generic query wrapper for downstream idempotency checks (Plans 03, 04).
   * REVIEWS H2.
   * @param {string} sql
   * @param {Array} params
   */
  async function query(sql, params = []) {
    return pool.query(sql, params);
  }

  /**
   * Accuracy row lookup for a specific evaluation date.
   * Used by Plan 04 ensemble weights read.
   * REVIEWS H2.
   * @param {string} dateStr - ISO date string (YYYY-MM-DD)
   * @returns {Promise<object|null>}
   */
  async function getForecastAccuracyRow(dateStr) {
    const r = await pool.query(
      `SELECT * FROM forecast_accuracy WHERE evaluation_date = $1 ORDER BY id DESC LIMIT 1`,
      [dateStr]
    );
    return r.rows[0] || null;
  }

  /**
   * Latest accuracy row for ml-correction feature-read (used by Plan 05).
   * REVIEWS H2.
   * @returns {Promise<object|null>}
   */
  async function getLatestAccuracyRow() {
    const r = await pool.query(
      `SELECT * FROM forecast_accuracy ORDER BY evaluation_date DESC, id DESC LIMIT 1`
    );
    return r.rows[0] || null;
  }

  /**
   * UPSERT into forecast_snapshots with forecast_date + target_date (REVIEWS H1).
   * forecast_date defaults to today UTC if caller omits; target_date defaults to slot's date.
   * Backfill MUST pass forecast_date = today as "when generated" provenance.
   * @param {{forecast_date?: string, target_date?: string, slot_utc: string, layer: string, power_w: number}} row
   */
  async function insertSnapshot(row) {
    const forecastDate = row.forecast_date ?? new Date().toISOString().slice(0, 10);
    const slotUtc = typeof row.slot_utc === 'string' ? row.slot_utc : new Date(row.slot_utc).toISOString();
    const targetDate = row.target_date ?? slotUtc.slice(0, 10);
    const sql = `
      INSERT INTO forecast_snapshots (forecast_date, target_date, slot_utc, layer, power_w)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (target_date, slot_utc, layer) DO UPDATE SET
        power_w = EXCLUDED.power_w,
        forecast_date = EXCLUDED.forecast_date,
        fetched_at = NOW()
    `;
    return pool.query(sql, [forecastDate, targetDate, slotUtc, row.layer, row.power_w]);
  }

  /**
   * Increment pvnode monthly call counter (client-side quota tracking per D-A5 re-scope).
   * @param {number} n - increment amount (default 1)
   */
  async function incrementPvnodeQuota(n = 1) {
    const month = new Date().toISOString().slice(0, 7) + '-01';
    await pool.query(`
      INSERT INTO pvnode_quota (month_utc, calls_used, last_updated)
      VALUES ($1, $2, NOW())
      ON CONFLICT (month_utc) DO UPDATE SET
        calls_used = pvnode_quota.calls_used + EXCLUDED.calls_used,
        last_updated = NOW()
    `, [month, n]);
  }

  /**
   * Read pvnode monthly call counter for current UTC month.
   * @returns {Promise<number>} calls used this month (0 if no row)
   */
  async function getPvnodeQuotaUsed() {
    const month = new Date().toISOString().slice(0, 7) + '-01';
    const r = await pool.query(`SELECT calls_used FROM pvnode_quota WHERE month_utc = $1`, [month]);
    return r.rows[0]?.calls_used ?? 0;
  }

  return {
    ensureSchema,
    insertWeather,
    insertPvForecast,
    insertLoadForecast,
    insertAccuracy,
    getLatestWeather,
    getLatestPvForecast,
    getLatestLoadForecast,
    getAccuracyHistory,
    runSmartRetention,
    close,
    // Phase 07 Wave-0 helpers (REVIEWS H1/H2)
    query,
    getForecastAccuracyRow,
    getLatestAccuracyRow,
    insertSnapshot,
    incrementPvnodeQuota,
    getPvnodeQuotaUsed,
    // Exposed for testing
    get SCHEMA_SQL() { return SCHEMA_SQL; }
  };
}
