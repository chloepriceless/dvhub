// ml-training.js -- Daily ML training orchestrator with rollback.
// Queries DB for training data, calls ml_train.py, handles rollback on MAE regression.
// Schedules daily training at configurable hour/minute (default 21:30 UTC = 23:30 CET).
// Factory: createMlTraining({ pythonBridge, store, getCfg, pushLog, mlCorrection })
//   -> { triggerTraining, scheduleDaily, cancelSchedule, getTrainingLog }

import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
   * Joins forecast vs actual values with weather features.
   * @returns {Promise<{training_data: Array, data_days: number}>}
   */
  async function queryTrainingData() {
    const cfg = getCfg();
    const months = cfg.ml?.mlSlidingWindowMonths ?? 6;

    try {
      // Count distinct days with data
      const countResult = await store.query(`
        SELECT COUNT(DISTINCT DATE(slot_start_utc)) AS data_days
        FROM energy_slots_15m
        WHERE series_key = 'solar_power_w'
          AND source_kind = 'live'
          AND slot_start_utc >= NOW() - ($1 || ' months')::INTERVAL
      `, [months]);

      const data_days = Number(countResult.rows[0]?.data_days ?? 0);

      if (data_days < (cfg.ml?.mlMinDataDays ?? 7)) {
        return { training_data: [], data_days };
      }

      // Query hourly training data: forecast vs actual with weather features
      const dataResult = await store.query(`
        SELECT
          f.ts_utc,
          f.power_w AS forecast_power_w,
          a.value_num AS actual_power_w,
          w.visibility,
          w.cloud_cover,
          w.humidity,
          w.temperature AS temp,
          EXTRACT(HOUR FROM f.ts_utc AT TIME ZONE 'Europe/Berlin') AS hour_of_day,
          EXTRACT(DOW FROM f.ts_utc) AS day_of_week,
          EXTRACT(MONTH FROM f.ts_utc) AS month
        FROM forecast_data f
        LEFT JOIN energy_slots_15m a
          ON a.slot_start_utc = f.ts_utc
          AND a.series_key = 'solar_power_w'
          AND a.source_kind = 'live'
        LEFT JOIN weather_data w
          ON w.ts_utc = f.ts_utc
        WHERE f.ts_utc >= NOW() - ($1 || ' months')::INTERVAL
        ORDER BY f.ts_utc
      `, [months]);

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

  return { triggerTraining, scheduleDaily, cancelSchedule, getTrainingLog };
}
