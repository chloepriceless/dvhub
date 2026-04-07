// load-forecast.js -- SQL-based load prediction from existing telemetry rollups.
// Queries same-weekday historical data from energy_slots_15m,
// produces 72 x 1h slots (per D-02, D-03). Falls back to constant power on cold-start.
// Factory: createLoadForecast(ctx, { store }) -> { start, close, runForecast }

/**
 * Build the SQL query for same-weekday load forecast from energy_slots_15m.
 * Averages hourly power for the same day-of-week over a 28-day lookback window.
 * Exported for testability.
 * @returns {string} SQL query text (parameterized: $1 = reference date)
 */
export function buildLoadForecastQuery() {
  return `
    SELECT
      EXTRACT(HOUR FROM slot_start_utc AT TIME ZONE 'Europe/Berlin') AS hour_of_day,
      AVG(value_num) AS avg_power_w,
      COUNT(*) AS sample_count
    FROM energy_slots_15m
    WHERE series_key = 'load_power_w'
      AND source_kind = 'live'
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

  // Start from current hour boundary
  const startHour = new Date(now);
  startHour.setMinutes(0, 0, 0);

  const slots = [];
  for (let i = 0; i < SLOT_COUNT; i++) {
    const ts = new Date(startHour.getTime() + i * 3600000);
    const hourOfDay = ts.getUTCHours();
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
 * Create load forecast service.
 * Queries same-weekday data from energy_slots_15m, produces 72 x 1h slots.
 * @param {object} ctx - DI context { state, getCfg, pushLog, db }
 * @param {{ store: object }} options - forecast store with insertLoadForecast
 * @returns {{ start: Function, close: Function, runForecast: Function }}
 */
export function createLoadForecast(ctx, { store, vrmForecast }) {
  const { state, getCfg, pushLog } = ctx;
  // db accessed lazily via ctx.db — not destructured at create time because
  // ctx.db is set after createTelemetryStoreIfEnabled() which runs AFTER factory creation
  const getDb = () => ctx.db;
  let intervalHandle = null;

  /**
   * Execute the load forecast: query historical data, compute slots, persist.
   */
  async function runForecast() {
    const cfg = getCfg();
    const defaultPowerW = cfg?.forecast?.load?.defaultPowerW ?? 800;

    try {
      const sql = buildLoadForecastQuery();
      const result = await getDb().query(sql, [new Date().toISOString()]);
      const sqlRows = result.rows;

      const now = new Date();
      const slots = formatLoadSlots(sqlRows, defaultPowerW, now);

      // Determine confidence from slots (all slots share same confidence)
      const confidence = slots.length > 0 ? slots[0].confidence : 0.3;

      // Persist via store
      for (const slot of slots) {
        await store.insertLoadForecast({
          model: 'sql_weekday',
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

      pushLog('load_forecast_updated', {
        slots: slots.length,
        confidence,
        coldStart: confidence === 0.3
      });
    } catch (err) {
      pushLog('load_forecast_error', { error: err.message });
    }

    // VRM consumption fallback — if SQL produced no slots, use VRM data
    if ((!state.forecast.load.data || state.forecast.load.data.length === 0) && vrmForecast?.isAvailable()) {
      try {
        const vrmLoad = await vrmForecast.readLoadForecast();
        if (vrmLoad && vrmLoad.length > 0) {
          const slots = vrmLoad.map(r => ({ ts_utc: r.ts_utc, power_w: r.power_w, confidence: 0.25 }));
          state.forecast.load.data = slots;
          state.forecast.load.lastFetchAt = new Date().toISOString();
          state.forecast.load.confidence = 0.25;
          ctx.bumpForecastVersion?.();
          pushLog('load_forecast_vrm_fallback', { slots: slots.length });
        }
      } catch (err) {
        pushLog('load_forecast_vrm_error', { error: err.message });
      }
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
    await runForecast();
    intervalHandle = setInterval(runForecast, 6 * 60 * 60 * 1000);
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

  return { start, close, runForecast };
}
