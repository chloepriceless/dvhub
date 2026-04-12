// services/ml/index.js -- ML service factory.
// Wires ML correction, training, and health modules into a unified service.
// Tier-gated: returns stub on Tier 1, full service on Tier 2+.
// Factory: createMlService(ctx) -> { start, close, correct, getStatus, getAccuracyTrend, getTrainingLog }

import fs from 'node:fs';
import path from 'node:path';
import { createMlCorrection } from './ml-correction.js';
import { createMlTraining } from './ml-training.js';
import { createMlHealth } from './ml-health.js';
import { createPersistentBridge, createPythonBridge } from '../python-bridge/index.js';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ML_SERVER_SCRIPT = path.resolve(__dirname, '../python-bridge/scripts/ml_server.py');

/**
 * Create the ML service. Detects tier, wires sub-modules.
 * Tier 1: Returns stub service (bypass all ML features).
 * Tier 2: Batch Python bridge + ML correction + training.
 * Tier 3: Persistent Python bridge + ML correction + training.
 *
 * @param {object} ctx - DI context { state, getCfg, pushLog, db, forecastService, pythonBridge }
 * @returns {{ start: Function, close: Function, correct: Function, getStatus: Function, getAccuracyTrend: Function, getTrainingLog: Function }}
 */
export function createMlService(ctx) {
  const { getCfg, pushLog } = ctx;
  const tier = ctx.forecastService?.tier ?? 1;

  // Tier 1 stub: no ML features
  if (tier < 2) {
    return {
      start: async () => {},
      close: async () => {},
      correct: async (pvSlots) => ({ applied: false, corrected: pvSlots, model: null }),
      getStatus: () => ({
        tier,
        mlEnabled: false,
        modelType: null,
        modelVersion: 0,
        mae: null,
        dataStatus: 'inactive',
        nextTraining: null,
        lastTraining: null,
        trainingLog: [],
        sfEnabled: false,
        sfUseMstl: false,
        tierFeatures: []
      }),
      getAccuracyTrend: () => [],
      getTrainingLog: () => []
    };
  }

  // Tier 2+: Full ML service.
  // Create our own batch python-bridge (forecast service does not expose its bridge on ctx).
  // Tier 3 will also start a persistent bridge below; that's still a separate concern.
  const pythonBridge = ctx.pythonBridge ?? createPythonBridge(ctx, { tier });
  let persistentBridge = null;

  const mlCorrection = createMlCorrection({
    pythonBridge,
    getCfg,
    pushLog,
    store: ctx.forecastService?.store,
    state: ctx.state
  });

  const mlTraining = createMlTraining({
    pythonBridge,
    store: ctx.forecastService?.store ?? { query: async () => ({ rows: [] }) },
    getCfg,
    pushLog,
    mlCorrection
  });

  const mlHealth = createMlHealth({
    mlCorrection,
    mlTraining,
    getCfg,
    tier
  });

  /**
   * Start the ML service.
   * Loads existing model if available, schedules daily training.
   * On Tier 3: starts persistent Python bridge.
   */
  async function start() {
    // Try to load existing model metadata
    const modelDir = getCfg().ml?.mlModelDir ?? '/opt/dvhub/ml-models';
    let modelLoaded = false;

    try {
      // Training saves to {modelDir}/pv_correction_{model_type}_v{version}/meta.json.
      // Scan subdirectories and pick the most recent (highest version) trained model.
      if (fs.existsSync(modelDir)) {
        const entries = fs.readdirSync(modelDir, { withFileTypes: true })
          .filter(e => e.isDirectory() && e.name.startsWith('pv_correction_'));
        let best = null;
        for (const entry of entries) {
          const metaPath = path.join(modelDir, entry.name, 'meta.json');
          if (!fs.existsSync(metaPath)) continue;
          try {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            if (meta.model_type && meta.version != null) {
              if (!best || meta.version > best.version) {
                best = meta;
              }
            }
          } catch {
            // skip malformed meta.json
          }
        }
        if (best) {
          mlCorrection.setModel(best);
          modelLoaded = true;
        }
      }
    } catch (err) {
      pushLog('ml_model_load_error', { error: err.message });
    }

    // Schedule daily training
    mlTraining.scheduleDaily();

    // Tier 3: start persistent Python bridge
    if (tier >= 3) {
      try {
        persistentBridge = createPersistentBridge(ctx, { scriptPath: ML_SERVER_SCRIPT });
        await persistentBridge.start();
      } catch (err) {
        pushLog('ml_persistent_bridge_error', { error: err.message });
      }
    }

    pushLog('ml_service_started', { tier, modelLoaded });
  }

  /**
   * Graceful shutdown.
   */
  async function close() {
    mlTraining.cancelSchedule();
    if (persistentBridge) {
      await persistentBridge.close();
    }
    pushLog('ml_service_closed');
  }

  return {
    start,
    close,
    correct: mlCorrection.correct,
    getStatus: mlHealth.getStatus,
    getAccuracyTrend: mlHealth.getAccuracyTrend,
    getTrainingLog: mlTraining.getTrainingLog
  };
}
