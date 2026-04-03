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
    UNIQUE(model, ts_utc)
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
    UNIQUE(forecast_type, model, evaluation_date)
  );
  CREATE INDEX IF NOT EXISTS idx_forecast_accuracy_date ON forecast_accuracy(evaluation_date);
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
    const params = [
      row.model, row.ts_utc, row.power_w,
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
    const params = [
      row.model || 'sql_weekday', row.ts_utc, row.power_w,
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
    // Exposed for testing
    get SCHEMA_SQL() { return SCHEMA_SQL; }
  };
}
