// load-forecast.js -- Load prediction from telemetry rollups.
// Primary: StatsForecast delegation on Tier 2+ (via Python bridge, D-09, D-10).
// Fallback: SQL same-weekday rollups from energy_slots_15m.
// Produces 72 x 1h slots (per D-02, D-03). Falls back to constant power on cold-start.
// Factory: createLoadForecast(ctx, { store, vrmForecast, pythonBridge }) -> { start, close, runForecast, getState }

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.resolve(__dirname, '../python-bridge/scripts');

/**
 * Pure state-transition helper for load-forecast fallback chain.
 * Phase 07 FORE-12 REVIEWS L-cost: exported for direct unit testing.
 *
 * Semantics:
 *   - source='statsforecast' → reset consecutiveNonSfRuns=0, status='ok'
 *   - otherwise               → increment consecutiveNonSfRuns;
 *                               status='ok' while <2, 'degraded' at 2-3, 'failed' at 4+
 *
 * @param {{source: string, status: string, consecutiveNonSfRuns: number, lastUpdatedAt: string|null}} currentState
 * @param {'statsforecast'|'sql_rollup'|'vrm_fallback'|'naive_constant'|string} source
 * @returns {{source: string, status: string, consecutiveNonSfRuns: number, lastUpdatedAt: string}}
 */
export function nextLoadForecastState(currentState, source) {
  const next = {
    ...currentState,
    source,
    lastUpdatedAt: new Date().toISOString()
  };
  if (source === 'statsforecast') {
    next.consecutiveNonSfRuns = 0;
    next.status = 'ok';
  } else {
    next.consecutiveNonSfRuns = (currentState.consecutiveNonSfRuns || 0) + 1;
    if (next.consecutiveNonSfRuns >= 4) {
      next.status = 'failed';
    } else if (next.consecutiveNonSfRuns >= 2) {
      next.status = 'degraded';
    } else {
      next.status = 'ok';
    }
  }
  return next;
}

/**
 * Build the SQL query for same-weekday load forecast from energy_slots_15m.
 * Averages hourly power for the same day-of-week over a 28-day lookback window.
 * Exported for testability.
 *
 * Unit note: `load_power_w` rows in energy_slots_15m store kWh-per-15min-slot
 * (unit = 'kWh', written by telemetry-store-pg.js buildMaterializedEnergySlotWrites).
 * Convert to average watts with × 4000 (× 4 for 15min→h, × 1000 for kW→W) — same
 * conversion as telemetry-store-pg.js listPvActualSlots. A `unit = 'kWh'` guard
 * keeps the ×4000 from double-scaling any legacy `unit = 'W'` rows.
 *
 * source_kind note: telemetry-store-pg.js writes 'local_live' / 'vrm_import' —
 * never the legacy 'live' value, which would match 0 rows.
 *
 * @returns {string} SQL query text (parameterized: $1 = reference date)
 */
export function buildLoadForecastQuery() {
  return `
    SELECT
      EXTRACT(HOUR FROM slot_start_utc AT TIME ZONE 'Europe/Berlin') AS hour_of_day,
      AVG(value_num * 4000) AS avg_power_w,
      COUNT(*) AS sample_count
    FROM energy_slots_15m
    WHERE series_key = 'load_power_w'
      AND source_kind IN ('vrm_import', 'local_live')
      AND unit = 'kWh'
      AND EXTRACT(DOW FROM slot_start_utc) = EXTRACT(DOW FROM $1::timestamptz)
      AND slot_start_utc >= NOW() - INTERVAL '28 days'
    GROUP BY 1
    ORDER BY 1
  `;
}

/**
 * Compute confidence score based on sample count.
 * Low data = low confidence, per D-05 pitfall #3.
 * @param {number} sampleCount - minimum sample count across hours
 * @returns {number} confidence between 0.3 and 0.85
 */
export function computeLoadConfidence(sampleCount) {
  if (sampleCount < 7) return 0.3;
  if (sampleCount < 14) return 0.5;
  if (sampleCount < 28) return 0.7;
  return 0.85;
}

/**
 * Format SQL result rows into 72 x 1h forecast slots.
 * Falls back to constant defaultPowerW when fewer than 7 unique hours have data (cold-start).
 * Exported for testability.
 * @param {Array<{hour_of_day: number, avg_power_w: number, sample_count: string}>} sqlRows
 * @param {number} defaultPowerW - fallback power (e.g. 800W)
 * @param {Date} now - current time reference
 * @returns {Array<{ts_utc: string, power_w: number, confidence: number}>}
 */
export function formatLoadSlots(sqlRows, defaultPowerW, now) {
  const SLOT_COUNT = 72;
  const isColdStart = sqlRows.length < 7;

  // Build hour -> power map from SQL results
  const hourMap = new Map();
  let minSampleCount = Infinity;
  for (const row of sqlRows) {
    const hour = Number(row.hour_of_day);
    hourMap.set(hour, Number(row.avg_power_w));
    const sc = Number(row.sample_count);
    if (sc < minSampleCount) minSampleCount = sc;
  }

  const confidence = isColdStart ? 0.3 : computeLoadConfidence(minSampleCount);

  // Phase 18-01k: hourMap is keyed by Berlin local hour-of-day (the SQL query
  // uses `EXTRACT(HOUR FROM slot_start_utc AT TIME ZONE 'Europe/Berlin')`).
  // Earlier code used ts.getUTCHours() here, which is OFF by +1 or +2 hours
  // depending on DST, so every lookup missed and every slot fell through to
  // defaultPowerW (verified prod 2026-05-20: state.forecast.load.data was
  // 24x 800W constant). Match the SQL domain.
  const berlinHourFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Berlin', hour12: false, hour: '2-digit'
  });
  function getBerlinHour(date) {
    // formatToParts returns [{type:'hour', value:'00'..'23'}] when hour12=false.
    // Note: some locales render 24 instead of 0 for midnight - coerce.
    const parts = berlinHourFmt.formatToParts(date);
    const raw = parts.find(p => p.type === 'hour')?.value ?? '0';
    const h = Number(raw) % 24;
    return h;
  }

  // Start from current hour boundary
  const startHour = new Date(now);
  startHour.setMinutes(0, 0, 0);

  const slots = [];
  for (let i = 0; i < SLOT_COUNT; i++) {
    const ts = new Date(startHour.getTime() + i * 3600000);
    const hourOfDay = getBerlinHour(ts);
    const power = isColdStart ? defaultPowerW : (hourMap.get(hourOfDay) ?? defaultPowerW);
    slots.push({
      ts_utc: ts.toISOString(),
      power_w: Math.round(power * 100) / 100,
      confidence
    });
  }

  return slots;
}

/**
 * Query load history for StatsForecast input.
 * @param {object} store - Forecast store with query method
 * @param {number} months - Lookback window in months
 * @returns {Promise<Array<{ts_utc: string, power_w: number}>>}
 */
async function queryLoadHistory(store, months) {
  // Unit + source_kind: see buildLoadForecastQuery — load_power_w rows store
  // kWh-per-15min (unit='kWh'); × 4000 yields average watts so StatsForecast
  // trains on watts consistent with the rest of the forecast pipeline.
  const result = await store.query(`
    SELECT
      slot_start_utc AS ts_utc,
      value_num * 4000 AS power_w
    FROM energy_slots_15m
    WHERE series_key = 'load_power_w'
      AND source_kind IN ('vrm_import', 'local_live')
      AND unit = 'kWh'
      AND slot_start_utc >= NOW() - ($1 || ' months')::INTERVAL
    ORDER BY slot_start_utc ASC
  `, [months]);
  return result.rows;
}

/**
 * Format StatsForecast output to match SQL rollup slot contract.
 * @param {Array<{ts_utc: string, power_w: number, confidence: number}>} sfRows
 * @returns {Array<{ts_utc: string, power_w: number, confidence: number}>}
 */
function formatStatsForecastSlots(sfRows) {
  return sfRows.map(row => ({
    ts_utc: row.ts_utc,
    power_w: typeof row.power_w === 'number' ? Math.round(row.power_w * 100) / 100 : 0,
    confidence: typeof row.confidence === 'number' ? row.confidence : 0.7
  }));
}

/**
 * Create load forecast service.
 * Queries same-weekday data from energy_slots_15m, produces 72 x 1h slots.
 * On Tier 2+: delegates to StatsForecast via Python bridge (D-09, D-10).
 * On error or Tier 1: falls back to SQL rollup.
 * @param {object} ctx - DI context { state, getCfg, pushLog, db, forecastService }
 * @param {{ store: object, vrmForecast: object, pythonBridge?: object }} options
 * @returns {{ start: Function, close: Function, runForecast: Function }}
 */
export function createLoadForecast(ctx, { store, vrmForecast, pythonBridge }) {
  const { state, getCfg, pushLog } = ctx;
  // ctx.db is a getter — always reads the current value (set after telemetry store init)
  const getDb = () => ctx.db;
  let intervalHandle = null;

  // Phase 07 FORE-12 D-D2: in-memory load-forecast state for /api/ml/status visibility.
  // Sources: 'statsforecast' | 'sql_rollup' | 'vrm_fallback' | 'naive_constant' | 'unknown'
  // Status: 'ok' | 'degraded' | 'failed'
  // degraded = 2+ consecutive non-SF runs; failed = 4+ consecutive non-SF runs.
  let loadForecastState = {
    source: 'unknown',
    status: 'ok',
    consecutiveNonSfRuns: 0,
    lastUpdatedAt: null
  };

  /** Mutate module-scope state via pure `nextLoadForecastState` + structured log. */
  function setLoadForecastState(source) {
    loadForecastState = nextLoadForecastState(loadForecastState, source);
    pushLog('load_forecast_state', loadForecastState);
  }

  /** @returns {{source: string, status: string, consecutiveNonSfRuns: number, lastUpdatedAt: string|null}} */
  function getState() {
    return { ...loadForecastState };
  }

  /**
   * Try StatsForecast delegation on Tier 2+.
   * @returns {Promise<{slots: Array, source: string, confidence: number}|null>} SF result or null
   */
  async function tryStatsForecast() {
    const cfg = getCfg();
    const tier = ctx.forecastService?.tier ?? 1;

    if (tier < 2 || !cfg.ml?.sfEnabled || !pythonBridge) {
      return null;
    }

    try {
      const history = await queryLoadHistory(store, cfg.ml?.mlSlidingWindowMonths ?? 1);

      // Check if enough history exists for StatsForecast (#19)
      if (!history || history.length < 48) {
        pushLog('sf_load_forecast_skip', {
          reason: 'insufficient_history',
          rows: history?.length ?? 0,
          minimum: 48,
          hint: 'load_power_w series in energy_slots_15m needs >= 48 rows (2 days of 15min data)'
        });
        return null; // Fall through to SQL rollup
      }

      const scriptPath = path.join(SCRIPTS_DIR, 'load_forecast_sf.py');
      const sfResult = await pythonBridge.call(scriptPath, {
        history,
        horizon: 72,
        use_mstl: tier >= 3 && (cfg.ml?.sfUseMstl ?? false),
        tier
      }, 120000); // 2 min timeout

      // Handle Python-side error responses (#19)
      if (sfResult && !Array.isArray(sfResult) && sfResult.ok === false) {
        pushLog('sf_load_forecast_error', {
          error: sfResult.error || 'Python script returned error object',
          historyRows: history.length
        });
        return null; // Fall through to SQL rollup
      }

      if (Array.isArray(sfResult)) {
        // Phase 07 FORE-12 Pitfall SF-2: flat-prediction is error-equivalent, NOT silent success.
        // Return null → outer runForecast falls through to SQL rollup (caller increments fallback counter).
        const uniqueValues = new Set(sfResult.map(r => Math.round(r.power_w)));
        if (uniqueValues.size === 1 && sfResult.length > 1) {
          pushLog('sf_load_forecast_flat_detected', {
            reason: 'flat_prediction',
            uniqueValues: [...uniqueValues],
            resultLength: sfResult.length
          });
          return null;
        }

        return {
          slots: formatStatsForecastSlots(sfResult),
          source: 'statsforecast',
          confidence: 0.7
        };
      }
    } catch (e) {
      pushLog('sf_load_forecast_error', { error: e.message });
      // Fall through to SQL rollup
    }

    return null;
  }

  /**
   * Execute the load forecast: try StatsForecast, fall back to SQL rollup.
   */
  async function runForecast() {
    const cfg = getCfg();
    const defaultPowerW = cfg?.forecast?.load?.defaultPowerW ?? 800;

    // Try StatsForecast delegation first (Tier 2+)
    const sfResult = await tryStatsForecast();
    if (sfResult) {
      const { slots, source, confidence } = sfResult;

      // Persist via store
      for (const slot of slots) {
        await store.insertLoadForecast({
          model: source,
          ts_utc: slot.ts_utc,
          power_w: slot.power_w,
          confidence: slot.confidence
        });
      }

      // Update state
      state.forecast.load.data = slots;
      state.forecast.load.lastFetchAt = new Date().toISOString();
      state.forecast.load.confidence = confidence;
      ctx.bumpForecastVersion?.();

      // Phase 07 FORE-12 D-D2: SF success resets fallback counter.
      setLoadForecastState('statsforecast');

      pushLog('load_forecast_updated', {
        slots: slots.length,
        confidence,
        source
      });
      return;
    }

    // SQL rollup fallback
    let sqlSucceeded = false;
    let sqlColdStart = false;
    try {
      const sql = buildLoadForecastQuery();
      const result = await getDb().query(sql, [new Date().toISOString()]);
      const sqlRows = result.rows;

      const now = new Date();
      const slots = formatLoadSlots(sqlRows, defaultPowerW, now);

      // Determine confidence from slots (all slots share same confidence)
      const confidence = slots.length > 0 ? slots[0].confidence : 0.3;
      sqlColdStart = confidence === 0.3 || sqlRows.length < 7;

      // Phase 18-01k: distinguish 'sql_weekday' (real rollup, isColdStart=false)
      // from 'sql_weekday_fallback' (constant defaultPowerW, isColdStart=true).
      // Phase 19 B2 Inspector reads load_forecasts.model and shows the operator
      // whether the served curve is genuine weekday-mean or a fallback constant.
      const persistModel = sqlColdStart ? 'sql_weekday_fallback' : 'sql_weekday';
      for (const slot of slots) {
        await store.insertLoadForecast({
          model: persistModel,
          ts_utc: slot.ts_utc,
          power_w: slot.power_w,
          confidence: slot.confidence
        });
      }

      // Update state
      state.forecast.load.data = slots;
      state.forecast.load.lastFetchAt = now.toISOString();
      state.forecast.load.confidence = confidence;
      ctx.bumpForecastVersion?.();
      sqlSucceeded = true;

      pushLog('load_forecast_updated', {
        slots: slots.length,
        confidence,
        coldStart: sqlColdStart,
        model: persistModel
      });
    } catch (err) {
      pushLog('load_forecast_error', { error: err.message });
    }

    // VRM consumption fallback — engage when the SQL rollup did not yield a
    // usable hour-of-day profile. Two degenerate cases trigger it:
    //   1. all-zero history (no telemetry rows at all), or
    //   2. cold-start / flat forecast — fewer than 7 unique hours had data, so
    //      formatLoadSlots served a constant `defaultPowerW` to every slot
    //      (signalled by sqlColdStart / confidence 0.3, or every slot identical).
    // The genuine VRM consumption forecast has real per-hour variation, so it
    // is a far better safety net than the flat-800 constant. flat-800 stays as
    // the last resort only when neither real source is available.
    const loadData = state.forecast.load.data || [];
    const hasRealData = loadData.some(s => (s.power_w || s.powerW || 0) > 0);
    const distinctPowers = new Set(
      loadData.map(s => Math.round((s.power_w ?? s.powerW ?? 0) * 100) / 100)
    );
    const isDegenerateForecast = sqlColdStart
      || !sqlSucceeded
      || (loadData.length > 1 && distinctPowers.size === 1);
    let vrmApplied = false;
    if ((!hasRealData || isDegenerateForecast) && vrmForecast?.isAvailable()) {
      try {
        const vrmLoad = await vrmForecast.readLoadForecast();
        if (vrmLoad && vrmLoad.length > 0) {
          const slots = vrmLoad.map(r => ({ ts_utc: r.ts_utc, power_w: r.power_w, confidence: 0.25 }));
          state.forecast.load.data = slots;
          state.forecast.load.lastFetchAt = new Date().toISOString();
          state.forecast.load.confidence = 0.25;
          ctx.bumpForecastVersion?.();
          pushLog('load_forecast_vrm_fallback', {
            slots: slots.length,
            reason: !hasRealData ? 'all_zero_history' : 'cold_start_flat'
          });
          vrmApplied = true;
        }
      } catch (err) {
        pushLog('load_forecast_vrm_error', { error: err.message });
      }
    }

    // Phase 07 FORE-12 D-D2: reflect which fallback path was taken.
    // Priority: vrm_fallback (overrides earlier state) > sql_rollup (real data) > naive_constant (cold start / no data)
    if (vrmApplied) {
      setLoadForecastState('vrm_fallback');
    } else if (sqlSucceeded && !sqlColdStart) {
      setLoadForecastState('sql_rollup');
    } else {
      // Either SQL threw, or cold-start defaultPowerW was served.
      setLoadForecastState('naive_constant');
    }
  }

  /**
   * Start the load forecast service.
   * Runs forecast immediately, then every 6 hours via setInterval.
   */
  async function start() {
    if (!getDb()) {
      pushLog('load_forecast_skip', { reason: 'no_db' });
      return;
    }
    try {
      await runForecast();
    } catch (err) {
      pushLog('load_forecast_first_run_error', { error: err?.message ?? String(err) });
    }
    let running = false;
    intervalHandle = setInterval(() => {
      if (running) return;
      running = true;
      runForecast()
        .catch(err => pushLog('load_forecast_interval_error', { error: err?.message ?? String(err) }))
        .finally(() => { running = false; });
    }, 6 * 60 * 60 * 1000);
  }

  /**
   * Stop the load forecast service.
   */
  function close() {
    if (intervalHandle) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
  }

  return { start, close, runForecast, getState };
}
