// ml-training.js -- Daily ML training orchestrator with rollback.
// Queries DB for training data, calls ml_train.py, handles rollback on MAE regression.
// Schedules daily training at configurable hour/minute (default 21:30 UTC = 23:30 CET).
//
// Phase 07 MLAI-08 additions:
//   - has14DaysOfAccuracyData (REVIEWS H10): 14-day rolling-MAE precondition gate
//   - promoteIfBetter (REVIEWS H11): true-atomic validate → archive → swap → verify
//     → rollback pattern for v1→v2 LightGBM transition
//   - runRetrainEndpoint: orchestrates gate → triggerTraining → ml_load_heldout →
//     promoteIfBetter; the job is invoked async by routes-api.js via
//     ml-retrain-jobs.startJob (REVIEWS H12)
//
// Factory: createMlTraining({ pythonBridge, store, getCfg, pushLog, mlCorrection })
//   -> { triggerTraining, scheduleDaily, cancelSchedule, getTrainingLog,
//        has14DaysOfAccuracyData, promoteIfBetter, runRetrainEndpoint }

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkModelSchema, RUNTIME_FEATURE_SCHEMA_VERSION } from './ml-schema-guard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.resolve(__dirname, '../python-bridge/scripts');
const MAX_LOG_ENTRIES = 5;

/**
 * Create ML training orchestrator.
 * Per D-01: Daily training with configurable schedule.
 * Per D-04, D-05: Sliding window data selection.
 * Per D-07: Rollback when new model MAE exceeds previous.
 * Per D-08: Uses pvlib theoretical_power_w as ground truth.
 *
 * @param {object} deps - { pythonBridge, store, getCfg, pushLog, mlCorrection }
 * @returns {{ triggerTraining: Function, scheduleDaily: Function, cancelSchedule: Function, getTrainingLog: Function }}
 */
export function createMlTraining({ pythonBridge, store, getCfg, pushLog, mlCorrection }) {
  /** @type {Array<{ts: number, model_type?: string, version?: number, mae?: number, status: string, error?: string}>} */
  const trainingLog = [];
  let currentVersion = 0;
  let dailyTimeout = null;
  let dailyInterval = null;

  /**
   * Query training data from PostgreSQL.
   * Direct weather→actual-PV training: learns to predict PV output
   * from weather features + time + plant config. Bypasses forecast-correction
   * approach because historical pv_forecasts may be empty on fresh installs.
   * @returns {Promise<{training_data: Array, data_days: number}>}
   */
  async function queryTrainingData() {
    const cfg = getCfg();
    const months = cfg.ml?.mlSlidingWindowMonths ?? 12;
    const pv = cfg.forecast?.pv || {};

    // Plant config: use dominant (highest-kWp) string's tilt/azimuth.
    // Model sees constant features per training run — LightGBM handles OK.
    const strings = Array.isArray(pv.strings) ? pv.strings : [];
    const totalKwp = Number(pv.totalKwp) || strings.reduce((s, x) => s + (Number(x.kwp) || 0), 0) || 10;
    let tiltDeg = Number(pv.tiltDeg) || 35;
    let azimuthDeg = Number(pv.azimuthDeg) || 180;
    if (strings.length > 0) {
      const dominant = strings.reduce((m, s) => (Number(s.kwp) || 0) > (Number(m.kwp) || 0) ? s : m, strings[0]);
      tiltDeg = Number(dominant.tiltDeg ?? dominant.tilt) || tiltDeg;
      azimuthDeg = Number(dominant.azimuthDeg ?? dominant.azimuth) || azimuthDeg;
    }

    try {
      // Count distinct days with actual PV data
      const countResult = await store.query(`
        SELECT COUNT(DISTINCT DATE(slot_start_utc)) AS data_days
        FROM energy_slots_15m
        WHERE series_key = 'pv_total_w'
          AND source_kind IN ('vrm_import', 'local_live')
          AND slot_start_utc >= NOW() - (($1)::int || ' months')::INTERVAL
      `, [months]);

      const data_days = Number(countResult.rows[0]?.data_days ?? 0);

      if (data_days < (cfg.ml?.mlMinDataDays ?? 7)) {
        return { training_data: [], data_days };
      }

      // Query hourly training data: weather features + actual PV (aggregated to hourly).
      // Joins weather_forecasts with energy_slots_15m averaged by hour, plus real rolling
      // MAE features from forecast_accuracy (Phase 07 MLAI-08 VERIFICATION gap fix):
      // without this LEFT JOIN, mae_7d_* features were always 0 during training while
      // inference (ml-correction.js) uses real values — defeats the retrain benefit.
      const dataResult = await store.query(`
        SELECT
          w.ts_utc,
          w.visibility_m,
          w.cloud_cover_pct,
          w.humidity_pct,
          w.temperature_c AS temp_c,
          EXTRACT(HOUR FROM w.ts_utc AT TIME ZONE 'UTC')::int AS hour,
          EXTRACT(MONTH FROM w.ts_utc)::int AS month,
          EXTRACT(DOW FROM w.ts_utc)::int AS weekday,
          $2::float AS tilt_deg,
          $3::float AS azimuth_deg,
          $4::float AS kwp,
          MAX(COALESCE(fa.mae_7d_pvnode,  0))::float AS mae_7d_pvnode,
          MAX(COALESCE(fa.mae_7d_solcast, 0))::float AS mae_7d_solcast,
          MAX(COALESCE(fa.mae_7d_pvlib,   0))::float AS mae_7d_pvlib,
          MAX(COALESCE(fa.mae_7d_merged,  0))::float AS mae_7d_merged,
          MAX(COALESCE(fa.mae_7d_ml,      0))::float AS mae_7d_ml,
          AVG(e.value_num) AS theoretical_power_w
        FROM weather_forecasts w
        LEFT JOIN energy_slots_15m e
          ON date_trunc('hour', e.slot_start_utc) = date_trunc('hour', w.ts_utc)
          AND e.series_key = 'pv_total_w'
          AND e.source_kind IN ('vrm_import', 'local_live')
        LEFT JOIN forecast_accuracy fa
          ON fa.evaluation_date = DATE(w.ts_utc AT TIME ZONE 'UTC')
          AND fa.forecast_type = 'pv'
          AND fa.model = 'ensemble_daily'
        WHERE w.ts_utc >= NOW() - (($1)::int || ' months')::INTERVAL
        GROUP BY w.id, w.ts_utc, w.visibility_m, w.cloud_cover_pct, w.humidity_pct, w.temperature_c
        HAVING AVG(e.value_num) IS NOT NULL
        ORDER BY w.ts_utc
      `, [months, tiltDeg, azimuthDeg, totalKwp]);

      return { training_data: dataResult.rows, data_days };
    } catch (err) {
      pushLog('ml_training_db_error', { error: err.message });
      return { training_data: [], data_days: 0 };
    }
  }

  /**
   * Trigger ML training.
   * Queries DB for training data, calls ml_train.py, handles rollback.
   */
  async function triggerTraining() {
    const cfg = getCfg();

    try {
      const { training_data, data_days } = await queryTrainingData();

      // Check minimum data days
      if (data_days < (cfg.ml?.mlMinDataDays ?? 7)) {
        pushLog('ml_training_skip', { reason: 'insufficient_data', data_days });
        return;
      }

      currentVersion++;

      const scriptPath = path.join(SCRIPTS_DIR, 'ml_train.py');
      const result = await pythonBridge.call(scriptPath, {
        training_data,
        data_days,
        version: currentVersion,
        previous_mae: mlCorrection.getModelInfo()?.mae ?? null,
        model_dir: cfg.ml?.mlModelDir ?? '/opt/dvhub/ml-models'
      }, 300000); // 5 min timeout for training

      if (!result) {
        addLogEntry({ ts: Date.now(), status: 'failed', error: 'null_result' });
        pushLog('ml_training_error', { error: 'Python bridge returned null' });
        return;
      }

      if (result.ok === true) {
        // Training succeeded
        mlCorrection.setModel(result);
        addLogEntry({
          ts: Date.now(),
          model_type: result.model_type,
          version: result.version,
          mae: result.mae,
          status: 'ok'
        });
        pushLog('ml_training_success', {
          model_type: result.model_type,
          version: result.version,
          mae: result.mae
        });
      } else if (result.ok === false && result.reason === 'rollback') {
        // Rollback: new model MAE exceeds previous
        addLogEntry({
          ts: Date.now(),
          model_type: result.model_type,
          version: currentVersion,
          mae: result.new_mae,
          status: 'rollback'
        });
        pushLog('ml_training_rollback', {
          new_mae: result.new_mae,
          previous_mae: result.previous_mae
        });
      } else if (result.ok === false) {
        // Training failed
        addLogEntry({
          ts: Date.now(),
          status: 'failed',
          error: result.error || 'unknown'
        });
        pushLog('ml_training_error', { error: result.error || 'unknown' });
      }
    } catch (err) {
      addLogEntry({ ts: Date.now(), status: 'failed', error: err.message });
      pushLog('ml_training_error', { error: err.message });
    }
  }

  /**
   * Add an entry to the training log, keeping only the last MAX_LOG_ENTRIES.
   * @param {object} entry
   */
  function addLogEntry(entry) {
    trainingLog.unshift(entry);
    if (trainingLog.length > MAX_LOG_ENTRIES) {
      trainingLog.length = MAX_LOG_ENTRIES;
    }
  }

  /**
   * Schedule daily training at configurable hour:minute UTC.
   * Uses setTimeout for initial delay, then setInterval for 24h repeat.
   */
  function scheduleDaily() {
    const cfg = getCfg();
    const hour = cfg.ml?.mlTrainingHour ?? 21;
    const minute = cfg.ml?.mlTrainingMinute ?? 30;

    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(hour, minute, 0, 0);
    if (next <= now) {
      next.setDate(next.getDate() + 1);
    }

    const delayMs = next.getTime() - now.getTime();

    dailyTimeout = setTimeout(async () => {
      await triggerTraining();
      dailyInterval = setInterval(async () => {
        await triggerTraining();
      }, 24 * 60 * 60 * 1000);
    }, delayMs);

    pushLog('ml_training_scheduled', { nextRunAt: next.toISOString() });
  }

  /**
   * Cancel scheduled training.
   */
  function cancelSchedule() {
    if (dailyTimeout) {
      clearTimeout(dailyTimeout);
      dailyTimeout = null;
    }
    if (dailyInterval) {
      clearInterval(dailyInterval);
      dailyInterval = null;
    }
  }

  /**
   * Get a copy of the training log.
   * @returns {Array}
   */
  function getTrainingLog() {
    return [...trainingLog];
  }

  // ───────────────────────────────────────────────────────────────────────
  // Phase 07 MLAI-08: REVIEWS H10 + H11 + H12 additions
  // ───────────────────────────────────────────────────────────────────────

  /** Absolute path to the ACTIVE model directory (config-driven). */
  function getActivePath() {
    return getCfg().ml?.activeModelPath ?? '/opt/dvhub/ml-models/active';
  }

  /** Absolute path to the CANDIDATE model directory (config-driven). */
  function getCandidatePath() {
    return getCfg().ml?.candidateModelPath ?? '/opt/dvhub/ml-models/candidate_v2';
  }

  /**
   * REVIEWS H10: 14-day precondition gate.
   *
   * Verifies at least 14 distinct `evaluation_date` rows exist in
   * forecast_accuracy with non-null `mae_7d_pvnode` in the last 14 days.
   * Day-1 retrain returns `{ok:false, daysAvailable:N}` so the HTTP handler
   * can respond 409 without spawning a job.
   *
   * @returns {Promise<{ok: boolean, daysAvailable: number}>}
   */
  async function has14DaysOfAccuracyData() {
    try {
      const result = await store.query(`
        SELECT COUNT(DISTINCT evaluation_date) AS d
        FROM forecast_accuracy
        WHERE mae_7d_pvnode IS NOT NULL
          AND evaluation_date >= CURRENT_DATE - INTERVAL '14 days'
      `);
      const d = Number(result.rows[0]?.d ?? 0);
      return { ok: d >= 14, daysAvailable: d };
    } catch (err) {
      pushLog('ml_retrain_gate_query_error', { error: err.message });
      return { ok: false, daysAvailable: 0, error: err.message };
    }
  }

  /**
   * REVIEWS H11: validate a model directory by checking its meta.json
   * declares the expected feature_schema_version. This stops us from
   * promoting a candidate whose schema drift would crash predict().
   *
   * @param {string} modelPath
   */
  async function validateModel(modelPath) {
    const metaPath = path.join(modelPath, 'meta.json');
    const check = checkModelSchema(metaPath);
    if (!check.ok) {
      throw new Error(`validateModel failed: ${check.reason ?? 'unknown'}`);
    }
    return true;
  }

  /**
   * REVIEWS H12: delegate to ml_eval.py Python helper.
   *
   * Plan 16-05 D-02: returns the per-row predictions alongside the MAE so the
   * caller can run the magnitude sanity gate. ml_eval.py emits `predictions`
   * (an array of `{rawPv, correctedPv}` aligned to the held-out rows); older
   * helper builds that return only `mae` degrade gracefully — `predictions`
   * is then `[]` and the sanity gate is skipped (empty-daylight path).
   *
   * @param {string} modelPath
   * @param {Array<object>} heldOutRows
   * @returns {Promise<{mae: number, predictions: Array<{rawPv: number, correctedPv: number}>}>}
   */
  async function evalModel(modelPath, heldOutRows) {
    const scriptPath = path.join(SCRIPTS_DIR, 'ml_eval.py');
    const result = await pythonBridge.call(scriptPath, {
      model_path: modelPath,
      held_out: heldOutRows,
    });
    if (!result || !result.ok) {
      throw new Error(`eval_failed: ${result?.error ?? 'null_result'}`);
    }
    return {
      mae: Number(result.mae),
      predictions: Array.isArray(result.predictions) ? result.predictions : [],
    };
  }

  /**
   * Load held-out slice via ml_load_heldout.py helper.
   *
   * @param {string} heldOutPath
   * @returns {Promise<Array<object>>} rows
   */
  async function loadHeldOutSlice(heldOutPath) {
    const scriptPath = path.join(SCRIPTS_DIR, 'ml_load_heldout.py');
    const result = await pythonBridge.call(scriptPath, { path: heldOutPath });
    if (!result || !result.ok) {
      throw new Error(`load_heldout_failed: ${result?.error ?? 'null_result'}`);
    }
    return Array.isArray(result.rows) ? result.rows : [];
  }

  /**
   * Move a rejected candidate out of the way so the next retrain starts from
   * a clean slate. Named with a timestamp for audit.
   *
   * @param {string} candidatePath
   * @returns {Promise<string>} rejectedPath
   */
  async function moveToRejected(candidatePath) {
    const rejectedDir = path.join(path.dirname(candidatePath), 'rejected');
    const rejectedPath = path.join(
      rejectedDir,
      `rejected_${new Date().toISOString().replace(/[:.]/g, '-')}`
    );
    await fs.promises.mkdir(rejectedDir, { recursive: true });
    await fs.promises.rename(candidatePath, rejectedPath);
    return rejectedPath;
  }

  /**
   * REVIEWS H11: true-atomic validate → archive → swap → verify → rollback.
   *
   * Flow:
   *   1. Validate candidate (reject before touching active)
   *   2. Evaluate v1 and v2 MAE on held-out slice
   *   3. Promotion gate: ≥10% improvement → promote,
   *      smaller improvement → promote_weak,
   *      regression → reject
   *   4. On promote: archive active → `${active}.backup-${ts}`,
   *      rename candidate → active, validate promoted, cleanup archive
   *   5. On ANY failure after step 4a: rollback archive → active,
   *      log `ml_atomic_swap_rollback_*` events
   *
   * No two-step window where both paths could be gone — see
   * anchor comment `ml_atomic_swap_rollback` below.
   *
   * @param {{candidatePath: string, activePath: string, heldOutRows: Array}} args
   * @returns {Promise<{decision: string, v1Mae: number, v2Mae: number, improveRatio: number, rejectedPath?: string}>}
   */
  async function promoteIfBetter({ candidatePath, activePath, heldOutRows }) {
    // Step 1: validate candidate BEFORE touching active
    await validateModel(candidatePath);

    // Step 2: evaluate both on held-out
    const v1Eval = await evalModel(activePath, heldOutRows);
    const v2Eval = await evalModel(candidatePath, heldOutRows);
    const v1Mae = v1Eval.mae;
    const v2Mae = v2Eval.mae;
    const improveRatio = v1Mae > 0 ? (v1Mae - v2Mae) / v1Mae : 0;
    pushLog('ml_candidate_eval', { v1Mae, v2Mae, improveRatio });

    // Plan 16-05 D-02: pre-promotion SANITY GATE — an orthogonal magnitude
    // check the MAE-improvement gate alone cannot catch. A collapsed model
    // (v1's failure mode: daytime peaks squashed to ~0 W) can still post a
    // deceptively "better" MAE on a degenerate held-out slice, so MAE is not
    // sufficient. Over daylight slots (raw PV > 0), mean(corrected)/mean(raw)
    // must land in [0.5, 1.5]; outside the band -> reject before promotion.
    // `corrected` = the candidate model's predictions, `raw` = the measured PV
    // ground truth carried per held-out row (the in-pipeline "raw" proxy).
    const daylight = (v2Eval.predictions || []).filter(p => Number(p.rawPv) > 0);
    if (daylight.length > 0) {
      const meanRaw = daylight.reduce((s, p) => s + Number(p.rawPv), 0) / daylight.length;
      const meanCorrected = daylight.reduce((s, p) => s + Number(p.correctedPv), 0) / daylight.length;
      const sanityRatio = meanRaw > 0 ? meanCorrected / meanRaw : 0;
      if (sanityRatio < 0.5 || sanityRatio > 1.5) {
        const rejectedPath = await moveToRejected(candidatePath);
        pushLog('ml_sanity_gate_rejected', {
          sanityRatio, meanCorrected, meanRaw,
          daylightSlots: daylight.length, rejectedPath,
        });
        return { decision: 'rejected', reason: 'sanity_gate', sanityRatio, rejectedPath };
      }
    }

    // Promotion gate: ≥10% improvement → promoted;
    // any improvement 0-10% → promoted_weak;
    // regression → rejected.
    const shouldPromote = improveRatio >= 0.10 || v2Mae < v1Mae;
    if (!shouldPromote) {
      const rejectedPath = await moveToRejected(candidatePath);
      pushLog('ml_candidate_rejected', { v1Mae, v2Mae, improveRatio, rejectedPath });
      return { decision: 'rejected', v1Mae, v2Mae, improveRatio, rejectedPath };
    }

    // Step 3: archive active to timestamped backup BEFORE swap
    const archivePath = `${activePath}.backup-${Date.now()}`;
    await fs.promises.rename(activePath, archivePath);

    // ml_atomic_swap_rollback: the try/catch below guarantees that any
    // failure between the archive-rename and the final validate is reversed
    // via a symmetric rename that restores the previous active model.
    try {
      // Step 4: promote candidate → active
      await fs.promises.rename(candidatePath, activePath);

      // Step 5: verify promoted model still loads with the expected schema
      await validateModel(activePath);

      // Step 6: cleanup archive on success (best-effort — swallow cleanup errors)
      await fs.promises.rm(archivePath, { recursive: true, force: true }).catch(() => {});

      pushLog('ml_atomic_swap_ok', { archivePath, activePath });
      const decision = improveRatio >= 0.10 ? 'promoted' : 'promoted_weak';
      return { decision, v1Mae, v2Mae, improveRatio };
    } catch (err) {
      // ml_atomic_swap_rollback: restore active from archive
      pushLog('ml_atomic_swap_rollback_attempt', { err: err.message });
      try {
        // If the candidate was already moved to active and then failed validation,
        // move it aside first so the rollback rename has a clean target.
        if (fs.existsSync(activePath)) {
          await fs.promises.rename(activePath, `${candidatePath}.failed-${Date.now()}`);
        }
        await fs.promises.rename(archivePath, activePath);
        pushLog('ml_atomic_swap_rollback_ok', { activePath });
      } catch (rollbackErr) {
        pushLog('ml_atomic_swap_rollback_failed', { error: rollbackErr.message });
      }
      throw err;
    }
  }

  /**
   * Phase 07 MLAI-08 D-C1 + REVIEWS H10/H11/H12: one-shot retrain endpoint.
   *
   * Called asynchronously by POST /api/ml/retrain via ml-retrain-jobs. Orchestrates:
   *   1. 14-day gate (early 409-equivalent if insufficient data)
   *   2. triggerTraining targeting candidate path
   *   3. Load held-out slice via ml_load_heldout.py
   *   4. promoteIfBetter with true-atomic swap + rollback
   *
   * @returns {Promise<object>}
   */
  async function runRetrainEndpoint() {
    // REVIEWS H10: 14-day gate BEFORE any training work
    const gate = await has14DaysOfAccuracyData();
    if (!gate.ok) {
      pushLog('ml_retrain_gate_insufficient_data', { daysAvailable: gate.daysAvailable });
      return {
        ok: false,
        error: 'insufficient_accuracy_data',
        message: 'Need ≥14 days of rolling MAE data before retrain',
        daysAvailable: gate.daysAvailable,
      };
    }

    const activePath = getActivePath();
    const candidatePath = getCandidatePath();
    const cfg = getCfg();

    // Step 1: invoke triggerTraining (reuses existing DB query + ml_train.py call)
    // Directly invoke the Python bridge with an explicit candidate model_dir so
    // the candidate artifact lands at candidatePath rather than the daily-training
    // default path.
    const { training_data, data_days } = await queryTrainingData();
    if (data_days < 14) {
      // Belt-and-braces with the REVIEWS H10 gate above — should never reach
      // here unless the gate query and queryTrainingData disagree.
      return {
        ok: false,
        error: 'insufficient_accuracy_data',
        message: 'queryTrainingData returned <14 distinct days',
        daysAvailable: data_days,
      };
    }

    currentVersion++;
    const scriptPath = path.join(SCRIPTS_DIR, 'ml_train.py');
    const trainResult = await pythonBridge.call(scriptPath, {
      training_data,
      data_days,
      version: currentVersion,
      previous_mae: mlCorrection?.getModelInfo?.()?.mae ?? null,
      model_dir: path.dirname(candidatePath),
      candidate_path: candidatePath,
      feature_schema_version: RUNTIME_FEATURE_SCHEMA_VERSION,
    });

    if (!trainResult || trainResult.ok !== true) {
      pushLog('ml_retrain_train_failed', { error: trainResult?.error ?? 'null_result' });
      return {
        ok: false,
        meta: {
          training_samples: 0,
          mae_before: null,
          mae_after: null,
          decision: 'train_failed',
          error: trainResult?.error ?? 'null_result',
        },
      };
    }

    // Step 2: load held-out slice via ml_load_heldout.py (REVIEWS H12)
    const heldOutPath = trainResult.held_out_slice_path
      ?? path.join(trainResult.model_path ?? candidatePath, 'held_out_slice.parquet');
    let heldOutRows = [];
    try {
      heldOutRows = await loadHeldOutSlice(heldOutPath);
    } catch (err) {
      pushLog('ml_retrain_heldout_load_failed', { error: err.message, heldOutPath });
      return {
        ok: false,
        meta: {
          training_samples: trainResult.n_samples ?? 0,
          mae_before: null,
          mae_after: trainResult.mae ?? null,
          decision: 'heldout_load_failed',
          error: err.message,
        },
      };
    }

    // Step 3: promoteIfBetter with true-atomic swap + rollback (REVIEWS H11)
    // When there is no active model yet (first-ever retrain), skip the eval
    // and just publish the candidate.
    const resolvedCandidatePath = trainResult.model_path ?? candidatePath;
    if (!fs.existsSync(activePath)) {
      await fs.promises.rename(resolvedCandidatePath, activePath);
      pushLog('ml_atomic_swap_initial', { activePath });
      mlCorrection?.setModel?.(trainResult);
      return {
        ok: true,
        meta: {
          training_samples: trainResult.n_samples ?? data_days,
          mae_before: null,
          mae_after: trainResult.mae ?? null,
          decision: 'promoted_initial',
        },
      };
    }

    try {
      const promotion = await promoteIfBetter({
        candidatePath: resolvedCandidatePath,
        activePath,
        heldOutRows,
      });
      if (promotion.decision === 'promoted' || promotion.decision === 'promoted_weak') {
        mlCorrection?.setModel?.(trainResult);
      }
      return {
        ok: true,
        meta: {
          training_samples: trainResult.n_samples ?? data_days,
          mae_before: promotion.v1Mae,
          mae_after: promotion.v2Mae,
          decision: promotion.decision,
          improveRatio: promotion.improveRatio,
        },
      };
    } catch (err) {
      pushLog('ml_retrain_promote_failed', { error: err.message });
      return {
        ok: false,
        meta: {
          training_samples: trainResult.n_samples ?? 0,
          mae_before: null,
          mae_after: trainResult.mae ?? null,
          decision: 'promote_failed',
          error: err.message,
        },
      };
    }
  }

  return {
    triggerTraining,
    scheduleDaily,
    cancelSchedule,
    getTrainingLog,
    // Phase 07 MLAI-08 exports
    has14DaysOfAccuracyData,
    promoteIfBetter,
    runRetrainEndpoint,
    validateModel,
  };
}
