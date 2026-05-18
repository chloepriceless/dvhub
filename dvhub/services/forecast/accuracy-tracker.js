// accuracy-tracker.js -- Forecast accuracy tracking with MAE/RMSE computation and confidence scoring.
// Compares forecast vs actual values from energy_slots_15m, derives confidence per D-05.
// Factory: createAccuracyTracker(ctx, { store }) -> { start, close, evaluateAccuracy, evaluatePerProvider, evaluateAndWrite, computeRolling7dMae }
//
// Phase 07 Plan 07-04 extensions (REVIEWS H1 + H9 locked):
//   - evaluatePerProvider(dateStr) computes RAW daily MAE per layer by querying
//     forecast_snapshots WHERE target_date=$1 AND layer=$provider (REVIEWS H1).
//     Returns { mae_daily_pvnode, mae_daily_solcast, mae_daily_pvlib, mae_daily_merged, mae_daily_ml }.
//   - computeRolling7dMae(dateStr) runs a single SQL UPDATE using AVG(mae_daily_*)
//     over an INCLUSIVE 7-day window [dateStr - INTERVAL '6 days', dateStr] (REVIEWS H9).
//   - evaluateAndWrite(dateStr) orchestrates: evaluatePerProvider → UPSERT mae_daily_*
//     → computeRolling7dMae → SQL-window UPDATE mae_7d_*.
//   - filterOfflineGaps drops runs of 4+ consecutive (actual=0, forecast>100W) pairs
//     (Pitfall A-1 extension: offline device should NOT inflate MAE for the day).
//   - All queries UTC-only (Pitfall A-2). The existing 02:00 scheduler now calls
//     evaluateAndWrite(yesterday).

// energy_slots_15m stores materialized rows as kWh-per-15-min-slot (unit='kWh');
// forecasts (store.getLatest*Forecast / forecast_snapshots) are in watts. To make
// MAE/RMSE/confidence a watts-vs-watts comparison, normalize the actual to average
// watts: kWh-per-15min -> W is x4000 (x4 for 15min->h, x1000 for kW->W). Legacy
// unit='W' rows, if any, pass through unscaled.
const ACTUAL_POWER_W_SQL = `CASE WHEN unit = 'kWh' THEN value_num * 4000 ELSE value_num END`;

/**
 * Compute Mean Absolute Error.
 * @param {number[]} forecasted - Forecasted values
 * @param {number[]} actual - Actual measured values
 * @returns {number|null} MAE or null if empty or mismatched
 */
export function computeMAE(forecasted, actual) {
  if (!forecasted.length || forecasted.length !== actual.length) return null;
  const sum = forecasted.reduce((acc, f, i) => acc + Math.abs(f - actual[i]), 0);
  return sum / forecasted.length;
}

/**
 * Compute Root Mean Squared Error.
 * @param {number[]} forecasted
 * @param {number[]} actual
 * @returns {number|null}
 */
export function computeRMSE(forecasted, actual) {
  if (!forecasted.length || forecasted.length !== actual.length) return null;
  const sumSq = forecasted.reduce((acc, f, i) => acc + (f - actual[i]) ** 2, 0);
  return Math.sqrt(sumSq / forecasted.length);
}

/**
 * Derive confidence score from MAE relative to mean actual value.
 * Low MAE/mean ratio = high confidence. Clamps to [0.3, 1.0] per D-05.
 * @param {number} mae
 * @param {number} meanActual
 * @returns {number} confidence between 0.3 and 1.0
 */
export function computeConfidenceFromMAE(mae, meanActual) {
  if (!Number.isFinite(mae) || !Number.isFinite(meanActual) || meanActual === 0) return 0.3;
  const ratio = mae / meanActual;
  const raw = 1.0 - ratio;
  return Math.max(0.3, Math.min(1.0, Math.round(raw * 100) / 100));
}

/**
 * Match forecast slots to actual telemetry values by timestamp.
 * Uses ISO string comparison for timestamp matching.
 * Exported for testability.
 * @param {Array<{ts_utc: string, power_w: number}>} forecast
 * @param {Array<{ts_utc: string, value_num: number}>} actuals
 * @returns {Array<{ts_utc: string, forecasted: number, actual: number}>}
 */
export function matchForecastToActuals(forecast, actuals) {
  const actualMap = new Map();
  for (const a of actuals) {
    // Normalize timestamp to ISO string for matching
    const key = new Date(a.ts_utc).toISOString();
    actualMap.set(key, Number(a.value_num));
  }

  const matched = [];
  for (const f of forecast) {
    const key = new Date(f.ts_utc).toISOString();
    if (actualMap.has(key)) {
      matched.push({
        ts_utc: key,
        forecasted: Number(f.power_w),
        actual: actualMap.get(key)
      });
    }
  }
  return matched;
}

/**
 * Drop runs of 4+ consecutive pairs where actual === 0 AND forecast > 100W.
 * Pitfall A-1 extension: such runs indicate the device was offline/unreachable; the forecast
 * was correct in expecting non-zero output, but the missing actuals inflate the MAE.
 * Natural-zero pairs (forecast also ~0 during dark hours) are preserved.
 *
 * @param {Array<{ts_utc:string, forecasted:number, actual:number}>} matched
 * @returns {Array<{ts_utc:string, forecasted:number, actual:number}>}
 */
export function filterOfflineGaps(matched) {
  if (!Array.isArray(matched) || matched.length === 0) return [];
  const kept = [];
  let runStart = -1; // index where the current offline-like run began

  for (let i = 0; i < matched.length; i++) {
    const m = matched[i];
    const isOfflineLike = m.actual === 0 && m.forecasted > 100;
    if (isOfflineLike) {
      if (runStart < 0) runStart = i;
      continue;
    }
    // non-offline entry: resolve the previous run (if any) before pushing this entry
    if (runStart >= 0) {
      const runLen = i - runStart;
      if (runLen < 4) {
        for (let j = runStart; j < i; j++) kept.push(matched[j]);
      }
      // else: 4+ consecutive offline-like — DROP the entire run
      runStart = -1;
    }
    kept.push(m);
  }
  // tail run handling: if the array ends with an offline-like run, drop it only when >= 4 long
  if (runStart >= 0) {
    const runLen = matched.length - runStart;
    if (runLen < 4) {
      for (let j = runStart; j < matched.length; j++) kept.push(matched[j]);
    }
  }
  return kept;
}

/**
 * Create accuracy tracker service.
 * Evaluates forecast accuracy daily by comparing forecast vs actual telemetry data.
 * @param {object} ctx - DI context { state, getCfg, pushLog, db }
 * @param {{ store: object }} options - forecast store with insertAccuracy, getLatest*
 * @returns {{ start: Function, close: Function, evaluateAccuracy: Function }}
 */
export function createAccuracyTracker(ctx, { store }) {
  const { state, pushLog, db } = ctx;
  let timeoutHandle = null;
  let intervalHandle = null;

  /**
   * Get yesterday's date range (start/end) in UTC.
   * @returns {{ start: string, end: string, dateStr: string }}
   */
  function getYesterdayRange() {
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);
    const end = new Date(yesterday);
    end.setDate(end.getDate() + 1);
    return {
      start: yesterday.toISOString(),
      end: end.toISOString(),
      dateStr: yesterday.toISOString().slice(0, 10)
    };
  }

  /**
   * Evaluate accuracy for a given forecast type ('pv' or 'load').
   * Compares yesterday's forecast with actual telemetry data.
   * @param {string} forecastType - 'pv' or 'load'
   */
  async function evaluateAccuracy(forecastType) {
    if (!db) return;

    const { start, end, dateStr } = getYesterdayRange();

    try {
      // Get yesterday's forecast
      const getForecast = forecastType === 'pv'
        ? store.getLatestPvForecast
        : store.getLatestLoadForecast;
      const forecastRows = await getForecast({ start, end });

      if (!forecastRows.length) {
        pushLog('accuracy_skip', { forecastType, reason: 'no_forecast_data', date: dateStr });
        return;
      }

      // Get yesterday's actual values from energy_slots_15m
      // PV actuals are stored under 'pv_total_w' (the same series evaluatePerProvider
      // and the Phase-06 ml-correction use) — 'solar_power_w' was never written, so
      // the 'pv' path silently skipped on every run.
      const seriesKey = forecastType === 'pv' ? 'pv_total_w' : 'load_power_w';
      const actualResult = await db.query(`
        SELECT slot_start_utc AS ts_utc, ${ACTUAL_POWER_W_SQL} AS value_num
        FROM energy_slots_15m
        WHERE series_key = $1
          AND source_kind IN ('vrm_import', 'local_live')
          AND slot_start_utc >= $2
          AND slot_start_utc < $3
        ORDER BY slot_start_utc ASC
      `, [seriesKey, start, end]);

      const actuals = actualResult.rows;
      if (!actuals.length) {
        pushLog('accuracy_skip', { forecastType, reason: 'no_actual_data', date: dateStr });
        return;
      }

      // Match forecast to actuals
      const matched = matchForecastToActuals(forecastRows, actuals);
      if (!matched.length) {
        pushLog('accuracy_skip', { forecastType, reason: 'no_matched_pairs', date: dateStr });
        return;
      }

      const forecasted = matched.map(m => m.forecasted);
      const actual = matched.map(m => m.actual);

      // Compute error metrics
      const mae = computeMAE(forecasted, actual);
      const rmse = computeRMSE(forecasted, actual);

      // Compute confidence from MAE
      const meanActual = actual.reduce((s, v) => s + v, 0) / actual.length;
      const confidence = computeConfidenceFromMAE(mae, meanActual);

      // Determine model name
      const modelName = forecastType === 'pv'
        ? (forecastRows[0].model || 'solcast')
        : 'sql_weekday';

      // Persist accuracy record
      await store.insertAccuracy({
        forecast_type: forecastType,
        model: modelName,
        evaluation_date: dateStr,
        mae,
        rmse,
        sample_count: matched.length,
        confidence_score: confidence
      });

      // Update state confidence
      if (state.forecast[forecastType]) {
        state.forecast[forecastType].confidence = confidence;
      }

      pushLog('accuracy_evaluated', {
        forecastType,
        model: modelName,
        date: dateStr,
        mae: mae != null ? Math.round(mae * 100) / 100 : null,
        rmse: rmse != null ? Math.round(rmse * 100) / 100 : null,
        confidence,
        pairs: matched.length
      });
    } catch (err) {
      pushLog('accuracy_error', { forecastType, error: err.message });
    }
  }

  // --- Phase 07 Plan 07-04: per-provider + rolling-7d accuracy pipeline ---

  const PROVIDERS = ['pvnode', 'solcast', 'pvlib', 'merged', 'ml'];

  /**
   * Helper: yyyy-mm-dd → {start, end} UTC ISO strings covering that full day.
   * Pitfall A-2: UTC only.
   * @param {string} dateStr YYYY-MM-DD
   */
  function dayRange(dateStr) {
    const start = new Date(`${dateStr}T00:00:00.000Z`);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);
    return { start: start.toISOString(), end: end.toISOString() };
  }

  /**
   * REVIEWS H9: evaluatePerProvider returns RAW daily MAE per provider (writes to mae_daily_*).
   * REVIEWS H1: queries forecast_snapshots by `target_date` (the day the slot predicts), not
   * legacy `day` or forecast_date.
   *
   * @param {string} dateStr YYYY-MM-DD UTC
   * @returns {Promise<Record<string, number|null>>} e.g. { mae_daily_pvnode: 123.4, ... }
   */
  async function evaluatePerProvider(dateStr) {
    const result = {
      mae_daily_pvnode: null,
      mae_daily_solcast: null,
      mae_daily_pvlib: null,
      mae_daily_merged: null,
      mae_daily_ml: null
    };
    if (!store?.query) return result;

    const { start, end } = dayRange(dateStr);

    // Pitfall A-2: UTC-only. Match the series used by Phase 06 ml-correction (pv_total_w).
    let actuals = [];
    try {
      const actualsResult = await store.query(`
        SELECT slot_start_utc AS ts_utc, ${ACTUAL_POWER_W_SQL} AS value_num
        FROM energy_slots_15m
        WHERE series_key = 'pv_total_w'
          AND source_kind IN ('local_live','vrm_import','live')
          AND slot_start_utc >= $1
          AND slot_start_utc < $2
        ORDER BY slot_start_utc
      `, [start, end]);
      actuals = (actualsResult?.rows || []).map(r => ({ ts_utc: r.ts_utc, value_num: r.value_num }));
    } catch (err) {
      pushLog('accuracy_actuals_query_error', { dateStr, error: err?.message ?? String(err) });
      return result;
    }
    if (actuals.length === 0) {
      pushLog('accuracy_skip', { reason: 'no_actual_data', date: dateStr });
      return result;
    }

    for (const provider of PROVIDERS) {
      let forecast = [];
      try {
        // REVIEWS H1: target_date is the accuracy-join key
        const fcResult = await store.query(`
          SELECT slot_utc AS ts_utc, power_w
          FROM forecast_snapshots
          WHERE target_date = $1 AND layer = $2
          ORDER BY slot_utc
        `, [dateStr, provider]);
        forecast = fcResult?.rows || [];
      } catch (err) {
        pushLog('accuracy_forecast_query_error', { dateStr, provider, error: err?.message ?? String(err) });
        continue;
      }
      if (forecast.length === 0) continue;

      let matched = matchForecastToActuals(forecast, actuals);
      // Pitfall A-1: drop 4+ consecutive offline-like runs so device outages don't inflate MAE.
      matched = filterOfflineGaps(matched);
      if (matched.length === 0) continue;

      // REVIEWS H9: this is RAW daily MAE → mae_daily_*, NOT mae_7d_*.
      result[`mae_daily_${provider}`] = computeMAE(
        matched.map(m => m.forecasted),
        matched.map(m => m.actual)
      );
    }

    return result;
  }

  /**
   * REVIEWS H9: Separate pass computes mae_7d_* from mae_daily_* via SQL AVG window.
   * Inclusive 7-day window [dateStr - INTERVAL '6 days', dateStr].
   * The scheduler passes yesterday as dateStr so Pitfall A-3 (exclude today) is naturally respected.
   *
   * @param {string} dateStr YYYY-MM-DD UTC
   */
  async function computeRolling7dMae(dateStr) {
    if (!store?.query) return;
    try {
      await store.query(`
        UPDATE forecast_accuracy SET
          mae_7d_pvnode  = sub.mae_7d_pvnode,
          mae_7d_solcast = sub.mae_7d_solcast,
          mae_7d_pvlib   = sub.mae_7d_pvlib,
          mae_7d_merged  = sub.mae_7d_merged,
          mae_7d_ml      = sub.mae_7d_ml
        FROM (
          SELECT
            AVG(mae_daily_pvnode)  FILTER (WHERE mae_daily_pvnode  IS NOT NULL) AS mae_7d_pvnode,
            AVG(mae_daily_solcast) FILTER (WHERE mae_daily_solcast IS NOT NULL) AS mae_7d_solcast,
            AVG(mae_daily_pvlib)   FILTER (WHERE mae_daily_pvlib   IS NOT NULL) AS mae_7d_pvlib,
            AVG(mae_daily_merged)  FILTER (WHERE mae_daily_merged  IS NOT NULL) AS mae_7d_merged,
            AVG(mae_daily_ml)      FILTER (WHERE mae_daily_ml      IS NOT NULL) AS mae_7d_ml
          FROM forecast_accuracy
          WHERE evaluation_date BETWEEN $1::date - INTERVAL '6 days' AND $1::date
        ) sub
        WHERE evaluation_date = $1
      `, [dateStr]);
    } catch (err) {
      pushLog('accuracy_rolling_7d_error', { dateStr, error: err?.message ?? String(err) });
    }
  }

  /**
   * Orchestrate evaluation for `dateStr` (REVIEWS H9 three-step):
   *   1. evaluatePerProvider → raw per-day MAE per layer
   *   2. UPSERT mae_daily_* into forecast_accuracy (keyed on evaluation_date)
   *   3. computeRolling7dMae → UPDATE mae_7d_* via SQL AVG window
   *
   * Returns the raw daily MAE dict (for logging/testing).
   * @param {string} dateStr YYYY-MM-DD UTC
   */
  async function evaluateAndWrite(dateStr) {
    const daily = await evaluatePerProvider(dateStr);
    if (!store?.query) return daily;

    // UPSERT keyed on (forecast_type, model, evaluation_date) — we use forecast_type='pv'
    // and model='ensemble_daily' as a stable key for these rolling aggregates. The
    // per-provider mae_daily_* and mae_7d_* columns live additively alongside legacy rows.
    try {
      await store.query(`
        INSERT INTO forecast_accuracy (
          forecast_type, model, evaluation_date,
          mae_daily_pvnode, mae_daily_solcast, mae_daily_pvlib, mae_daily_merged, mae_daily_ml
        ) VALUES ('pv', 'ensemble_daily', $1, $2, $3, $4, $5, $6)
        ON CONFLICT (forecast_type, model, evaluation_date) DO UPDATE SET
          mae_daily_pvnode  = EXCLUDED.mae_daily_pvnode,
          mae_daily_solcast = EXCLUDED.mae_daily_solcast,
          mae_daily_pvlib   = EXCLUDED.mae_daily_pvlib,
          mae_daily_merged  = EXCLUDED.mae_daily_merged,
          mae_daily_ml      = EXCLUDED.mae_daily_ml
      `, [
        dateStr,
        daily.mae_daily_pvnode, daily.mae_daily_solcast, daily.mae_daily_pvlib,
        daily.mae_daily_merged, daily.mae_daily_ml
      ]);
    } catch (err) {
      pushLog('accuracy_upsert_error', { dateStr, error: err?.message ?? String(err) });
    }

    // REVIEWS H9 final step: SQL-window rollup
    await computeRolling7dMae(dateStr);

    pushLog('accuracy_evaluated_per_provider', { dateStr, daily });
    return daily;
  }

  /**
   * Start accuracy tracker. Runs daily at 02:00 (after all yesterday's data is in).
   * Uses setTimeout for initial delay to 02:00, then setInterval for 24h period.
   */
  async function start() {
    if (!db) {
      pushLog('accuracy_tracker_skip', { reason: 'no_db' });
      return;
    }

    // Calculate ms until next 02:00
    const now = new Date();
    const next0200 = new Date(now);
    next0200.setHours(2, 0, 0, 0);
    if (next0200 <= now) {
      next0200.setDate(next0200.getDate() + 1);
    }
    const delayMs = next0200.getTime() - now.getTime();

    async function runDailyEvaluation() {
      // Legacy per-type evaluation (kept for backward-compat with downstream consumers).
      await evaluateAccuracy('pv');
      await evaluateAccuracy('load');
      // Phase 07 Plan 07-04: per-provider daily MAE + rolling 7d via SQL window.
      try {
        const { dateStr } = getYesterdayRange();
        await evaluateAndWrite(dateStr);
      } catch (err) {
        pushLog('accuracy_per_provider_error', { error: err?.message ?? String(err) });
      }
    }

    timeoutHandle = setTimeout(() => {
      // First run — never let a throw prevent the recurring schedule
      runDailyEvaluation().catch(err => {
        pushLog('accuracy_tracker_first_run_error', { error: err?.message ?? String(err) });
      });
      // Schedule recurring regardless of first-run outcome
      intervalHandle = setInterval(() => {
        runDailyEvaluation().catch(err => {
          pushLog('accuracy_tracker_interval_error', { error: err?.message ?? String(err) });
        });
      }, 24 * 60 * 60 * 1000);
    }, delayMs);

    pushLog('accuracy_tracker_scheduled', { nextRunAt: next0200.toISOString() });
  }

  /**
   * Stop the accuracy tracker.
   */
  function close() {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    if (intervalHandle) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
  }

  return {
    start,
    close,
    evaluateAccuracy,
    // Phase 07 Plan 07-04 (REVIEWS H1 + H9): per-provider + rolling-7d pipeline
    evaluatePerProvider,
    computeRolling7dMae,
    evaluateAndWrite
  };
}
