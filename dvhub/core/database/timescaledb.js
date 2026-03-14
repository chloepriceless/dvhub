/**
 * TimescaleDB/PostgreSQL backend adapter stub.
 *
 * This is a placeholder that will be replaced by the full implementation
 * in Phase 02 Plan 03. All methods throw 'not implemented' except
 * getBackendInfo() which returns the backend identifier.
 *
 * @module core/database/timescaledb
 */

const NOT_IMPLEMENTED = 'TimescaleDB adapter not implemented';

/**
 * Create a TimescaleDB adapter instance.
 *
 * @param {object} dbConfig - Database configuration (connectionString, pool settings, etc.)
 * @returns {import('./adapter.js').DatabaseAdapter}
 */
export function createTimescaleAdapter(dbConfig) {
  return {
    async initialize() { throw new Error(NOT_IMPLEMENTED); },
    async healthCheck() { throw new Error(NOT_IMPLEMENTED); },
    async close() { throw new Error(NOT_IMPLEMENTED); },
    async insertSamples(_rows) { throw new Error(NOT_IMPLEMENTED); },
    async insertControlEvent(_event) { throw new Error(NOT_IMPLEMENTED); },
    async querySamples(_opts) { throw new Error(NOT_IMPLEMENTED); },
    async queryAggregates(_opts) { throw new Error(NOT_IMPLEMENTED); },
    async queryLatest(_seriesKeys) { throw new Error(NOT_IMPLEMENTED); },
    async runRollups(_opts) { throw new Error(NOT_IMPLEMENTED); },
    async runRetention(_opts) { throw new Error(NOT_IMPLEMENTED); },
    async runCompression(_opts) { throw new Error(NOT_IMPLEMENTED); },
    getBackendInfo() { return { backend: 'timescaledb' }; }
  };
}
