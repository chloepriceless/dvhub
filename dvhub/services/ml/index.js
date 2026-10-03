// services/ml/index.js -- ML service factory.
// Wires ML correction, training, and health modules into a unified service.
// Needs the forecast Python environment: without it a stub service is returned.
// Factory: createMlService(ctx) -> { start, close, correct, getStatus, getAccuracyTrend, getTrainingLog }

import fs from 'node:fs';
import path from 'node:path';
import { createMlCorrection } from './ml-correction.js';
import { createMlTraining } from './ml-training.js';
import { createMlHealth } from './ml-health.js';
import { createPersistentBridge, createPythonBridge, isPythonAvailable } from '../python-bridge/index.js';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ML_SERVER_SCRIPT = path.resolve(__dirname, '../python-bridge/scripts/ml_server.py');

/**
 * Create the ML service and wire its sub-modules.
 * Without an installed Python environment: stub service (no ML features).
 * With it: batch Python bridge + ML correction + training; the persistent
 * Python server only runs with ml.mlEnabled.
 *
 * @param {object} ctx - DI context { state, getCfg, pushLog, db, forecastService, pythonBridge }
 * @returns {{ start: Function, close: Function, correct: Function, getStatus: Function, getAccuracyTrend: Function, getTrainingLog: Function }}
 */
export function createMlService(ctx) {
  const { getCfg, pushLog } = ctx;
  const pythonAvailable = ctx.pythonBridge ? true : isPythonAvailable();

  // No Python environment: stub service, no ML features.
  if (!pythonAvailable) {
    return {
      start: async () => {},
      close: async () => {},
      correct: async (pvSlots) => ({ applied: false, corrected: pvSlots, model: null }),
      getStatus: () => ({
        pythonAvailable: false,
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
        features: [],
        // Phase 07 FORE-12 D-D2: consistent shape with the full service.
        load_forecast: {
          source: 'unknown',
          status: 'unknown',
          consecutive_non_sf_runs: 0,
          last_updated_at: null
        }
      }),
      getAccuracyTrend: () => [],
      getTrainingLog: () => [],
      // Phase 07 MLAI-08 stubs: admin endpoints still return 409/ok so the
      // HTTP handler has a consistent contract without Python.
      has14DaysOfAccuracyData: async () => ({ ok: false, daysAvailable: 0 }),
      runRetrainEndpoint: async () => ({
        ok: false,
        error: 'ml_python_unavailable',
        message: 'ML retrain requires the forecast Python environment',
      }),
      promoteIfBetter: async () => { throw new Error('ml_python_unavailable'); },
    };
  }

  // Full ML service.
  // Create our own batch python-bridge (forecast service does not expose its bridge on ctx).
  // start() may also launch the persistent bridge (only with ml.mlEnabled).
  const pythonBridge = ctx.pythonBridge ?? createPythonBridge(ctx);
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
    pythonAvailable: true,
    // Phase 07 FORE-12 D-D2: route load-forecast state into /api/ml/status.
    getLoadForecastState: () => ctx.forecastService?.getLoadForecastState?.() ?? null
  });

  /**
   * Start the ML service.
   * Loads existing model if available, schedules daily training.
   * With ml.mlEnabled: starts the persistent Python bridge.
   */
  async function start() {
    // Try to load existing model metadata.
    //
    // There are TWO codepaths in this repo that produce a "trained model" on disk:
    //
    //   (a) Daily training (scheduleDaily → triggerTraining → ml_train.py with
    //       no candidate_path) saves to {modelDir}/pv_correction_{type}_v{N}/.
    //       This is the historical convention from Phase 06.
    //
    //   (b) runRetrainEndpoint → promoteIfBetter (REVIEWS H11 atomic swap from
    //       Phase 07 MLAI-08) operates on {modelDir}/active/ — the candidate
    //       directory is renamed onto that path after sanity-gate + MAE checks.
    //
    // Pre-fix, this loader only scanned for pattern (a). After a successful
    // runRetrainEndpoint the promoted model lived at {modelDir}/active/ and was
    // invisible to startup — getStatus() showed modelVersion=0, /api/forecast
    // showed mlActive=false, runtime sanity-fallback engaged on every build
    // (verified on prod 2026-05-20 after Phase-18-01 unit fix + first
    // promotion). Operator workaround: `mv active pv_correction_lightgbm_v1`.
    //
    // Phase 18-01e: prefer the atomic-swap `active/` dir when it exists (it's
    // the authoritative current model per the H11 contract), else fall back to
    // the daily-training scan. Both meta.json shapes are identical; only the
    // host directory name differs.
    const modelDir = getCfg().ml?.mlModelDir ?? '/opt/dvhub/ml-models';
    const activeModelPath = getCfg().ml?.activeModelPath ?? path.join(modelDir, 'active');
    let modelLoaded = false;

    try {
      let best = null;

      // (b) atomic-swap promoted model takes precedence
      const activeMetaPath = path.join(activeModelPath, 'meta.json');
      if (fs.existsSync(activeMetaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(activeMetaPath, 'utf8'));
          if (meta.model_type && meta.version != null) {
            best = { ...meta, _loadedFrom: 'active' };
          }
        } catch {
          // fall through to daily-training scan
        }
      }

      // (a) fall back to daily-training scan if no `active/meta.json` or it was malformed
      if (!best && fs.existsSync(modelDir)) {
        const entries = fs.readdirSync(modelDir, { withFileTypes: true })
          .filter(e => e.isDirectory() && e.name.startsWith('pv_correction_'));
        for (const entry of entries) {
          const metaPath = path.join(modelDir, entry.name, 'meta.json');
          if (!fs.existsSync(metaPath)) continue;
          try {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            if (meta.model_type && meta.version != null) {
              if (!best || meta.version > best.version) {
                best = { ...meta, _loadedFrom: entry.name };
              }
            }
          } catch {
            // skip malformed meta.json
          }
        }
      }

      if (best) {
        mlCorrection.setModel(best);
        modelLoaded = true;
      }
    } catch (err) {
      pushLog('ml_model_load_error', { error: err.message });
    }

    // Schedule daily training
    mlTraining.scheduleDaily();

    // Persistent Python server only serves ML correction — run it only with ML on.
    if (getCfg().ml?.mlEnabled === true) {
      try {
        persistentBridge = createPersistentBridge(ctx, { scriptPath: ML_SERVER_SCRIPT });
        await persistentBridge.start();
      } catch (err) {
        pushLog('ml_persistent_bridge_error', { error: err.message });
      }
    }

    pushLog('ml_service_started', { modelLoaded });
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
    getTrainingLog: mlTraining.getTrainingLog,
    // Phase 07 MLAI-08 REVIEWS H10/H11/H12 — async retrain pipeline
    has14DaysOfAccuracyData: mlTraining.has14DaysOfAccuracyData,
    runRetrainEndpoint: mlTraining.runRetrainEndpoint,
    promoteIfBetter: mlTraining.promoteIfBetter,
  };
}
