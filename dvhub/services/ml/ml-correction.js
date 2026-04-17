// ml-correction.js -- ML correction post-processing hook for PV forecast.
// Applies trained ML model corrections to PV forecast slots.
// Transparently bypasses when no model exists (D-07 fallback).
// Builds feature dict internally (D-A1), caches by forecastVersion (D-A3).
// Factory: createMlCorrection({ pythonBridge, getCfg, pushLog, store, state }) -> { correct, getModelInfo, setModel }

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkModelSchema } from './ml-schema-guard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.resolve(__dirname, '../python-bridge/scripts');

/**
 * Create ML correction module for PV forecast post-processing.
 * Per D-02: ML correction is applied after mergePvForecasts() in buildForecastResponse().
 * Per D-07: Transparently bypasses when no model exists.
 * Per D-A1: Builds feature dict from weather_forecasts, plant config, and constant accuracy zeros.
 * Per D-A3: Caches predictions by forecastVersion (size-2 eviction).
 *
 * @param {object} deps - { pythonBridge, getCfg, pushLog, store, state }
 * @returns {{ correct: Function, getModelInfo: Function, setModel: Function }}
 */
export function createMlCorrection({ pythonBridge, getCfg, pushLog, store, state }) {
  /** @type {null|{model_type: string, version: number, mae: number}} */
  let currentModel = null;

  /** @type {Map<number, {slots: Array, model: string}>} forecastVersion -> cached result */
  const cache = new Map();

  /**
   * Build feature dict for ml_predict.py (D-A1).
   * Queries weather_forecasts via store.getLatestWeather, extracts plant config from cfg,
   * and sets accuracy to constant zeros (D-A2).
   *
   * @param {Array<{start: string, powerW: number}>} pvSlots
   * @param {object} cfg - getCfg() result
   * @returns {Promise<{weather: Array, plant: object, accuracy: object}>}
   */
  async function buildFeatures(pvSlots, cfg) {
    // Query weather data for the forecast time range
    let weather = [];
    if (store?.getLatestWeather && pvSlots.length > 0) {
      try {
        const start = new Date(pvSlots[0].start);
        const end = new Date(new Date(pvSlots[pvSlots.length - 1].start).getTime() + 3600000);
        const weatherRows = await store.getLatestWeather({ start, end });
        weather = (weatherRows || []).map(row => ({
          hour: new Date(row.ts_utc).getUTCHours(),
          visibility_m: row.visibility_m ?? null,
          cloud_cover_pct: row.cloud_cover_pct ?? null,
          humidity_pct: row.humidity_pct ?? null,
          temp_c: row.temperature_c ?? null
        }));
      } catch (err) {
        pushLog('ml_weather_query_error', { error: err.message });
      }
    }

    // Extract plant config: dominant string (highest kwp) for tilt/azimuth, total kwp
    const pv = cfg.forecast?.pv || {};
    const strings = Array.isArray(pv.strings) ? pv.strings : [];
    const totalKwp = Number(pv.totalKwp) || strings.reduce((s, x) => s + (Number(x.kwp) || 0), 0) || 10;
    let tiltDeg = Number(pv.tiltDeg) || 35;
    let azimuthDeg = Number(pv.azimuthDeg) || 180;
    if (strings.length > 0) {
      const dominant = strings.reduce((m, s) => (Number(s.kwp) || 0) > (Number(m.kwp) || 0) ? s : m, strings[0]);
      tiltDeg = Number(dominant.tiltDeg ?? dominant.tilt) || tiltDeg;
      azimuthDeg = Number(dominant.azimuthDeg ?? dominant.azimuth) || azimuthDeg;
    }

    // Phase 07 D-C2/D-C3 + REVIEWS H2: read real mae_7d_* from accuracy_tracker
    // via the single-source store.getLatestAccuracyRow() helper. Pre-14-day
    // periods return all-zero accuracy dict (matches Pattern 5 accumulation
    // phase — v1 model remains active until the rolling window is populated).
    let accuracyRow = null;
    if (store?.getLatestAccuracyRow) {
      try {
        accuracyRow = await store.getLatestAccuracyRow();
      } catch (err) {
        pushLog('ml_accuracy_read_error', { error: err.message });
      }
    }
    const accuracy = {
      mae_7d_pvnode:  accuracyRow?.mae_7d_pvnode  ?? 0,
      mae_7d_solcast: accuracyRow?.mae_7d_solcast ?? 0,
      mae_7d_pvlib:   accuracyRow?.mae_7d_pvlib   ?? 0,
      mae_7d_merged:  accuracyRow?.mae_7d_merged  ?? 0,
      mae_7d_ml:      accuracyRow?.mae_7d_ml      ?? 0,
    };

    return {
      weather,
      plant: { tilt_deg: tiltDeg, azimuth_deg: azimuthDeg, kwp: totalKwp },
      accuracy
    };
  }

  /**
   * Apply ML correction to PV forecast slots.
   * Never throws -- all errors caught and logged, returns bypass result.
   * Uses forecastVersion-based cache (D-A3) to avoid redundant Python spawns.
   *
   * @param {Array<{start: string, powerW: number}>} pvSlots - PV forecast slots
   * @param {object} opts - { forecastVersion }
   * @returns {Promise<{applied: boolean, corrected: Array, model: string|null}>}
   */
  async function correct(pvSlots, { forecastVersion } = {}) {
    // Bypass: ML disabled
    if (!getCfg().ml?.mlEnabled) {
      return { applied: false, corrected: pvSlots, model: null };
    }

    // Bypass: no model loaded
    if (currentModel === null) {
      return { applied: false, corrected: pvSlots, model: null };
    }

    // D-A3: Check forecastVersion cache
    if (forecastVersion != null && cache.has(forecastVersion)) {
      const cached = cache.get(forecastVersion);
      return { applied: true, corrected: cached.slots, model: cached.model };
    }

    try {
      // Phase 07 MLAI-08 Pitfall ML-1: schema-version guard before Python call.
      // Short-circuits with applied=false ONLY when a meta.json exists AND
      // declares a mismatched feature_schema_version. Missing meta.json / read
      // errors are passed through to Python (ml_predict has the same guard
      // and owns the fail-open behaviour — this Node-side check is a
      // defence-in-depth shortcut to skip the subprocess spawn when we can
      // already see the model version won't match).
      const modelDir = getCfg().ml?.mlModelDir ?? '/opt/dvhub/ml-models';
      const modelName = `pv_correction_${currentModel.model_type}_v${currentModel.version}`;
      const metaPath = path.join(modelDir, modelName, 'meta.json');
      if (fs.existsSync(metaPath)) {
        const guard = checkModelSchema(metaPath);
        if (!guard.ok && guard.reason === 'schema_mismatch') {
          pushLog('ml_schema_guard_block', guard);
          return { applied: false, corrected: pvSlots, model: null };
        }
      }

      // D-A1: Build feature dict internally
      const features = await buildFeatures(pvSlots, getCfg());

      const scriptPath = path.join(SCRIPTS_DIR, 'ml_predict.py');
      const result = await pythonBridge.call(scriptPath, {
        slots: pvSlots,
        features,
        model_dir: modelDir,
        model_type: currentModel.model_type,
        version: currentModel.version
      }, 30000);

      if (result && result.applied) {
        // Map corrected result back onto pvSlots format
        const mappedSlots = result.corrected.map(s => ({
          start: s.start,
          powerW: s.powerW ?? s.power_w ?? 0,
          rawPowerW: s.rawPowerW ?? s.raw_power_w ?? 0,
          confidence: s.confidence
        }));
        const model = `${result.model}`;

        // D-A3: Store in forecastVersion cache, evict oldest when size >= 2
        if (forecastVersion != null) {
          if (cache.size >= 2) {
            const oldestKey = cache.keys().next().value;
            cache.delete(oldestKey);
          }
          cache.set(forecastVersion, { slots: mappedSlots, model });
        }

        return { applied: true, corrected: mappedSlots, model };
      }

      // Bridge returned applied:false (e.g., no_model on disk)
      return { applied: false, corrected: pvSlots, model: null };
    } catch (error) {
      pushLog('ml_predict_error', { error: error.message });
      return { applied: false, corrected: pvSlots, model: null };
    }
  }

  /**
   * Get current model metadata.
   * @returns {null|{model_type: string, version: number, mae: number}}
   */
  function getModelInfo() {
    return currentModel;
  }

  /**
   * Set model metadata after successful training or model load.
   * @param {{model_type: string, version: number, mae: number}} meta
   */
  function setModel(meta) {
    currentModel = {
      model_type: meta.model_type,
      version: meta.version,
      mae: meta.mae
    };
  }

  return { correct, getModelInfo, setModel };
}
