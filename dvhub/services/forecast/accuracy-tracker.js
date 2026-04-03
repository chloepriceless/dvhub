// accuracy-tracker.js -- Forecast accuracy tracking with MAE/RMSE computation and confidence scoring.
// Compares forecast vs actual values from energy_slots_15m, derives confidence per D-05.
// Factory: createAccuracyTracker(ctx, { store }) -> { start, close, evaluateAccuracy }

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
      const seriesKey = forecastType === 'pv' ? 'solar_power_w' : 'load_power_w';
      const actualResult = await db.query(`
        SELECT slot_start_utc AS ts_utc, value_num
        FROM energy_slots_15m
        WHERE series_key = $1
          AND source_kind = 'live'
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

    timeoutHandle = setTimeout(async () => {
      await evaluateAccuracy('pv');
      await evaluateAccuracy('load');
      // Then run every 24 hours
      intervalHandle = setInterval(async () => {
        await evaluateAccuracy('pv');
        await evaluateAccuracy('load');
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

  return { start, close, evaluateAccuracy };
}
