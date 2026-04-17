// ml-schema-guard.js -- Phase 07 MLAI-08: Node-side mirror of Python RUNTIME_FEATURE_SCHEMA_VERSION.
//
// Pure guard module — called by ml-correction (before cache write) and ml-training
// (before and after atomic swap) to check that an on-disk model's meta.json
// carries the feature_schema_version that this runtime expects.
//
// Exports:
//   - RUNTIME_FEATURE_SCHEMA_VERSION: number (2 for Phase 07)
//   - checkModelSchema(metaPath): { ok, modelVersion, runtimeVersion, reason, error? }
//
// Non-throwing: any I/O or JSON error returns { ok:false, reason:'meta_read_error' }.

import fs from 'node:fs';

/**
 * Runtime feature schema version. Must match ml_train.py FEATURE_SCHEMA_VERSION
 * and ml_predict.py RUNTIME_FEATURE_SCHEMA_VERSION.
 * @type {number}
 */
export const RUNTIME_FEATURE_SCHEMA_VERSION = 2;

/**
 * Check whether a model's meta.json declares the same feature_schema_version
 * that this Node runtime expects. Never throws — callers can branch on
 * `result.ok` alone.
 *
 * @param {string} metaPath - absolute path to a model directory's meta.json
 * @returns {{
 *   ok: boolean,
 *   modelVersion?: number,
 *   runtimeVersion: number,
 *   reason: string | null,
 *   error?: string,
 * }}
 */
export function checkModelSchema(metaPath) {
  try {
    const raw = fs.readFileSync(metaPath, 'utf-8');
    const meta = JSON.parse(raw);
    const modelVer = meta.feature_schema_version ?? 1;
    return {
      ok: modelVer === RUNTIME_FEATURE_SCHEMA_VERSION,
      modelVersion: modelVer,
      runtimeVersion: RUNTIME_FEATURE_SCHEMA_VERSION,
      reason: modelVer === RUNTIME_FEATURE_SCHEMA_VERSION ? null : 'schema_mismatch',
    };
  } catch (e) {
    return {
      ok: false,
      reason: 'meta_read_error',
      error: e?.message || String(e),
      runtimeVersion: RUNTIME_FEATURE_SCHEMA_VERSION,
    };
  }
}
