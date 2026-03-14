/**
 * TimescaleDB/PostgreSQL backend adapter.
 *
 * Uses pg.Pool for connection management, reads SQL migration files
 * for schema setup, and routes queries to the correct hypertable or
 * continuous aggregate view based on requested resolution.
 *
 * Rollups, retention, and compression are no-ops because TimescaleDB
 * Continuous Aggregates and native policies handle them automatically.
 *
 * @module core/database/timescaledb
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, 'migrations', 'timescaledb');
const require = createRequire(import.meta.url);

/** Resolution -> table/view mapping */
const RESOLUTION_MAP = {
  raw: 'telemetry_raw',
  '5min': 'telemetry_5min',
  '15min': 'telemetry_15min',
  daily: 'telemetry_daily'
};

/** Time column differs between raw table and aggregate views */
const TIME_COL = {
  telemetry_raw: 'ts',
  telemetry_5min: 'bucket',
  telemetry_15min: 'bucket',
  telemetry_daily: 'bucket'
};

/** Migration files in execution order */
const MIGRATION_FILES = [
  '001-schemas.sql',
  '002-telemetry-raw.sql',
  '003-continuous-aggs.sql',
  '004-policies.sql',
  '005-shared-tables.sql'
];

/** Max rows per INSERT batch (safety margin for param count limits) */
const BATCH_SIZE = 500;
const PARAMS_PER_ROW = 7;

/**
 * Create a TimescaleDB adapter instance.
 *
 * @param {object} dbConfig - Database configuration
 * @param {string} [dbConfig.connectionString] - PostgreSQL connection string
 * @param {object} [dbConfig._pool] - Injected pool for testing (dependency injection)
 * @returns {import('./adapter.js').DatabaseAdapter}
 */
export function createTimescaleAdapter(dbConfig = {}) {
  let pool = dbConfig._pool;

  // Only create a real pg.Pool if no test pool was injected
  if (!pool) {
    pool = createRealPool(dbConfig);
  }

  return {
    async initialize() {
      // Create migrations tracking table
      await pool.query(`
        CREATE TABLE IF NOT EXISTS _migrations (
          name TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      // Execute each migration file in order
      for (const file of MIGRATION_FILES) {
        // Check if already applied
        const check = await pool.query(
          'SELECT 1 FROM _migrations WHERE name = $1',
          [file]
        );
        if (check.rows.length > 0) continue;

        const sqlPath = join(MIGRATIONS_DIR, file);
        const sql = readFileSync(sqlPath, 'utf8');

        try {
          await pool.query(sql);
          await pool.query(
            'INSERT INTO _migrations (name) VALUES ($1)',
            [file]
          );
        } catch (err) {
          const msg = `Migration ${file} failed: ${err.message}`;
          console.error(msg);
          throw new Error(msg, { cause: err });
        }
      }
    },

    async healthCheck() {
      const start = Date.now();
      await pool.query('SELECT 1');
      return {
        ok: true,
        backend: 'timescaledb',
        latencyMs: Date.now() - start
      };
    },

    async close() {
      await pool.end();
    },

    async insertSamples(rows) {
      if (!rows || rows.length === 0) return;

      // Batch in groups of BATCH_SIZE
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        const values = [];
        const params = [];

        for (let j = 0; j < batch.length; j++) {
          const row = batch[j];
          const offset = j * PARAMS_PER_ROW;
          values.push(
            `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7})`
          );
          params.push(
            row.ts,
            row.seriesKey,
            row.valueNum,
            row.unit,
            row.source || 'local_poll',
            row.quality || 'raw',
            JSON.stringify(row.metaJson || {})
          );
        }

        const sql = `INSERT INTO telemetry_raw (ts, series_key, value_num, unit, source, quality, meta_json) VALUES ${values.join(', ')}`;
        await pool.query(sql, params);
      }
    },

    async insertControlEvent(event) {
      const sql = `
        INSERT INTO shared.event_log (ts, event_type, source, details_json)
        VALUES ($1, $2, $3, $4)
      `;
      await pool.query(sql, [
        event.ts,
        event.type,
        event.source,
        JSON.stringify(event.details || {})
      ]);
    },

    async querySamples({ seriesKeys, start, end, resolution }) {
      const table = RESOLUTION_MAP[resolution] || 'telemetry_raw';
      const timeCol = TIME_COL[table];

      const sql = `SELECT * FROM ${table} WHERE series_key = ANY($1) AND ${timeCol} >= $2 AND ${timeCol} < $3 ORDER BY ${timeCol} ASC`;
      const result = await pool.query(sql, [seriesKeys, start, end]);
      return result.rows;
    },

    async queryAggregates({ seriesKeys, start, end, bucket }) {
      const table = RESOLUTION_MAP[bucket] || 'telemetry_5min';
      const timeCol = TIME_COL[table];

      const sql = `SELECT * FROM ${table} WHERE series_key = ANY($1) AND ${timeCol} >= $2 AND ${timeCol} < $3 ORDER BY ${timeCol} ASC`;
      const result = await pool.query(sql, [seriesKeys, start, end]);
      return result.rows.map(row => ({
        bucket: row[timeCol],
        seriesKey: row.series_key,
        avgValue: row.avg_value,
        minValue: row.min_value,
        maxValue: row.max_value,
        sampleCount: row.sample_count,
        unit: row.unit
      }));
    },

    async queryLatest(seriesKeys) {
      const sql = `
        SELECT DISTINCT ON (series_key) series_key, ts, value_num, unit
        FROM telemetry_raw
        WHERE series_key = ANY($1)
        ORDER BY series_key, ts DESC
      `;
      const result = await pool.query(sql, [seriesKeys]);
      return result.rows;
    },

    // TimescaleDB Continuous Aggregates handle rollups via refresh policies
    async runRollups(_opts) {
      return { rolledUp: 0 };
    },

    // TimescaleDB retention policies handle cleanup automatically
    async runRetention(_opts) {
      return { deleted: 0 };
    },

    // TimescaleDB compression policies handle this automatically
    async runCompression(_opts) {
      return undefined;
    },

    getBackendInfo() {
      return { backend: 'timescaledb' };
    }
  };
}

/**
 * Create a real pg.Pool instance.
 * Separated for testability -- unit tests inject a mock pool via dbConfig._pool.
 *
 * @param {object} dbConfig
 * @returns {import('pg').Pool}
 */
function createRealPool(dbConfig) {
  let pg;
  try {
    pg = require('pg');
  } catch {
    throw new Error(
      'pg package not installed. Install it with: npm install pg\n' +
      'For SQLite-only deployments, set database.backend to "sqlite" in config.'
    );
  }

  const { Pool } = pg;
  const pool = new Pool({
    connectionString: dbConfig.connectionString || 'postgresql://dvhub:dvhub@localhost:5432/dvhub',
    max: 10,
    min: 2,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    maxUses: 7500
  });

  pool.on('error', (err) => {
    console.error('Unexpected pg pool error:', err.message);
    // Don't crash -- pool will attempt reconnection on next query
  });

  return pool;
}
