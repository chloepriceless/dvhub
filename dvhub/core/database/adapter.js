/**
 * Database Adapter - Interface contract and factory function.
 *
 * Provides a unified interface for database access regardless of backend.
 * Two backends are supported:
 *   - TimescaleDB/PostgreSQL (default) -- via ./timescaledb.js
 *   - SQLite (fallback)               -- via ./sqlite.js
 *
 * @module core/database/adapter
 */

/**
 * @typedef {Object} DatabaseAdapter
 * @property {() => Promise<void>} initialize - Run migrations, create tables/hypertables
 * @property {() => Promise<{ok: boolean, backend: string, latencyMs: number}>} healthCheck
 * @property {() => Promise<void>} close - Graceful shutdown
 * @property {(rows: Array<{ts: Date, seriesKey: string, valueNum: number, unit: string, source?: string, quality?: string, metaJson?: object}>) => Promise<void>} insertSamples
 * @property {(event: {ts: Date, type: string, source: string, details: object}) => Promise<void>} insertControlEvent
 * @property {(opts: {seriesKeys: string[], start: Date, end: Date, resolution?: string}) => Promise<Array>} querySamples
 * @property {(opts: {seriesKeys: string[], start: Date, end: Date, bucket: string}) => Promise<Array>} queryAggregates
 * @property {(seriesKeys: string[]) => Promise<Array>} queryLatest
 * @property {(opts: {now: Date}) => Promise<{rolledUp: number}>} runRollups
 * @property {(opts: {now: Date}) => Promise<{deleted: number}>} runRetention
 * @property {(opts: {now: Date}) => Promise<void>} runCompression
 * @property {() => {backend: string, version?: string}} getBackendInfo
 */

/**
 * All required method names that a valid DatabaseAdapter must implement.
 * Used for interface validation in tests and runtime checks.
 */
export const ADAPTER_METHODS = [
  'initialize', 'healthCheck', 'close',
  'insertSamples', 'insertControlEvent',
  'querySamples', 'queryAggregates', 'queryLatest',
  'runRollups', 'runRetention', 'runCompression',
  'getBackendInfo'
];

/**
 * Create a database adapter for the configured backend.
 *
 * @param {object} config - Application config object
 * @param {object} [config.database] - Database configuration
 * @param {string} [config.database.backend='timescaledb'] - Backend type: 'timescaledb' or 'sqlite'
 * @returns {Promise<DatabaseAdapter>} Configured database adapter
 * @throws {Error} If backend is unknown
 */
export async function createDatabaseAdapter(config) {
  const backend = config.database?.backend || 'timescaledb';

  if (backend === 'timescaledb') {
    const { createTimescaleAdapter } = await import('./timescaledb.js');
    return createTimescaleAdapter(config.database);
  }

  if (backend === 'sqlite') {
    const { createSqliteAdapter } = await import('./sqlite.js');
    return createSqliteAdapter(config.database);
  }

  throw new Error(`Unknown database backend: ${backend}`);
}
