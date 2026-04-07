// services/forecast/vrm-forecast.js -- VRM Forecast reader.
// Reads solar_yield and consumption forecasts from vrm_forecasts table
// (already populated by epex-fetch.js fetchVrmForecast()).
// No additional API calls needed — just reads what's already there.

/**
 * Create VRM Forecast reader.
 * Reads from existing vrm_forecasts table populated by epex-fetch.js.
 *
 * @param {object} ctx - DI context { state, getCfg, pushLog, db }
 */
export function createVrmForecast(ctx) {
  const { state, pushLog } = ctx;
  const getDb = () => ctx.db; // lazy — ctx.db set after telemetry store init

  /**
   * Read PV forecast from VRM data already in vrm_forecasts table.
   * Returns array of { ts_utc, power_w } for solar_yield forecast.
   */
  async function readPvForecast() {
    if (!getDb()) return null;

    try {
      const now = new Date().toISOString();
      const result = await getDb().query(`
        SELECT ts_utc, value_w
        FROM vrm_forecasts
        WHERE forecast_type = 'solar_yield'
          AND ts_utc >= $1
          AND source = 'vrm'
        ORDER BY ts_utc ASC
        LIMIT 288
      `, [now]);

      if (!result.rows.length) {
        pushLog('vrm_forecast_read_empty', { reason: 'no_solar_yield_data' });
        return null;
      }

      const slots = result.rows.map(r => ({
        ts_utc: new Date(r.ts_utc).toISOString(),
        power_w: Math.round(parseFloat(r.value_w) * 10) / 10
      }));

      pushLog('vrm_forecast_read_ok', { slots: slots.length, type: 'solar_yield' });
      return slots;

    } catch (e) {
      pushLog('vrm_forecast_read_error', { error: e.message });
      return null;
    }
  }

  /**
   * Read consumption forecast from VRM data.
   * Returns array of { ts_utc, power_w } for consumption forecast.
   */
  async function readLoadForecast() {
    if (!getDb()) return null;

    try {
      const now = new Date().toISOString();
      const result = await getDb().query(`
        SELECT ts_utc, value_w
        FROM vrm_forecasts
        WHERE forecast_type = 'consumption'
          AND ts_utc >= $1
          AND source = 'vrm'
        ORDER BY ts_utc ASC
        LIMIT 288
      `, [now]);

      if (!result.rows.length) return null;

      return result.rows.map(r => ({
        ts_utc: new Date(r.ts_utc).toISOString(),
        power_w: Math.round(parseFloat(r.value_w) * 10) / 10
      }));

    } catch (e) {
      pushLog('vrm_forecast_load_error', { error: e.message });
      return null;
    }
  }

  /**
   * Check if VRM forecast data is available and recent.
   */
  function isAvailable() {
    // VRM forecasts are populated by epex-fetch.js fetchVrmForecast()
    // Check if VRM token is configured (needed for fetch)
    const cfg = ctx.getCfg();
    return Boolean(cfg.telemetry?.historyImport?.vrmToken);
  }

  return {
    readPvForecast,
    readLoadForecast,
    isAvailable
  };
}
