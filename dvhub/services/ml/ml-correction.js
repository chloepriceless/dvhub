// ml-correction.js -- ML correction post-processing hook for PV forecast.
// Applies trained ML model corrections to PV forecast slots.
// Transparently bypasses when no model exists (D-07 fallback).
// Factory: createMlCorrection({ pythonBridge, getCfg, pushLog }) -> { correct, getModelInfo, setModel }

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.resolve(__dirname, '../python-bridge/scripts');

/**
 * Create ML correction module for PV forecast post-processing.
 * Per D-02: ML correction is applied after mergePvForecasts() in buildForecastResponse().
 * Per D-07: Transparently bypasses when no model exists.
 *
 * @param {object} deps - { pythonBridge, getCfg, pushLog }
 * @returns {{ correct: Function, getModelInfo: Function, setModel: Function }}
 */
export function createMlCorrection({ pythonBridge, getCfg, pushLog }) {
  /** @type {null|{model_type: string, version: number, mae: number}} */
  let currentModel = null;

  /**
   * Apply ML correction to PV forecast slots.
   * Never throws -- all errors caught and logged, returns bypass result.
   *
   * @param {Array<{start: string, powerW: number}>} pvSlots - PV forecast slots
   * @param {object} features - { weather, pvConfig, accuracy }
   * @returns {Promise<{applied: boolean, corrected: Array, model: string|null}>}
   */
  async function correct(pvSlots, features) {
    // Bypass: ML disabled
    if (!getCfg().ml?.mlEnabled) {
      return { applied: false, corrected: pvSlots, model: null };
    }

    // Bypass: no model loaded
    if (currentModel === null) {
      return { applied: false, corrected: pvSlots, model: null };
    }

    try {
      const scriptPath = path.join(SCRIPTS_DIR, 'ml_predict.py');
      const result = await pythonBridge.call(scriptPath, {
        slots: pvSlots,
        features,
        model_dir: getCfg().ml.mlModelDir,
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
        return { applied: true, corrected: mappedSlots, model: `${result.model}` };
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
