// services/forecast/vrm-forecast.js -- VRM Forecast reader.
// Reads solar_yield and consumption forecasts from vrm_forecasts table
// (already populated by epex-fetch.js fetchVrmForecast()).
// No additional API calls needed — just reads what's already there.
//
// Phase 18-05 VRM credential single-source-of-truth (verified 2026-05-20):
// The VRM portal-id + access-token live at exactly ONE location in cfg —
//   cfg.telemetry.historyImport.vrmPortalId
//   cfg.telemetry.historyImport.vrmToken
// — and are consumed by FOUR producers/consumers without duplication:
//   1. history-import.js              (Phase 09 backfill)
//   2. vrm-forecast.js (this file)    (forecast subsystem)
//   3. epex-fetch.js fetchVrmForecast (populates the vrm_forecasts table)
//   4. integrations-health-tracker.js (provider availability indicator)
// There is intentionally NO `cfg.forecast.vrm.*` slot. If a future setting
// needs a forecast-side override (separate token, different portal id), add
// it here with explicit fallback to telemetry.historyImport.* — do NOT
// silently fork the field into two places. The Phase 20 settings UI will
// surface the single source as the canonical entry point so the operator
// only ever fills it in once.

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

      // Silenced: was logging on every forecast build (~5 min) and crowding
      // out actually-interesting events in the Systemprotokoll ring buffer.
      // _empty and _error variants below still log so a regression is visible.
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

  // Berlin local day totals for today + tomorrow.
  // Filtered by ts_utc projected into Europe/Berlin so DST shifts and the
  // forecast_for_date label-bug (UTC date of local midnight) don't matter.
  // Resolution is 1h, so SUM(value_w)/1000 == kWh for the day.
  async function readDailyTotals() {
    if (!getDb()) return null;
    try {
      // to_char keeps the date as a plain ISO string (YYYY-MM-DD) so the
      // pg driver can't silently shift it via local-zone Date conversion.
      const result = await getDb().query(`
        SELECT
          forecast_type,
          to_char((ts_utc AT TIME ZONE 'Europe/Berlin')::date, 'YYYY-MM-DD') AS day_local,
          ROUND((SUM(value_w) / 1000.0)::numeric, 2) AS kwh,
          COUNT(*) AS slots
        FROM vrm_forecasts
        WHERE source = 'vrm'
          AND forecast_type IN ('solar_yield', 'consumption')
          AND (ts_utc AT TIME ZONE 'Europe/Berlin')
              >= ((NOW() AT TIME ZONE 'Europe/Berlin')::date)::timestamp
          AND (ts_utc AT TIME ZONE 'Europe/Berlin')
              <  ((NOW() AT TIME ZONE 'Europe/Berlin')::date + INTERVAL '2 days')::timestamp
        GROUP BY forecast_type, day_local
      `);
      const todayBerlin = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(new Date());
      const tomorrowDate = new Date(Date.now() + 24 * 3600 * 1000);
      const tomorrowBerlin = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(tomorrowDate);

      const blank = { pvKwh: 0, loadKwh: 0, pvSlots: 0, loadSlots: 0 };
      const out = { today: { ...blank }, tomorrow: { ...blank } };
      for (const r of result.rows) {
        const dayKey = String(r.day_local || '').slice(0, 10);
        const bucket = dayKey === todayBerlin ? out.today
          : dayKey === tomorrowBerlin ? out.tomorrow
          : null;
        if (!bucket) continue;
        const kwh = Number(r.kwh) || 0;
        if (r.forecast_type === 'solar_yield') {
          bucket.pvKwh = kwh;
          bucket.pvSlots = Number(r.slots) || 0;
        } else if (r.forecast_type === 'consumption') {
          bucket.loadKwh = kwh;
          bucket.loadSlots = Number(r.slots) || 0;
        }
      }
      return out;
    } catch (e) {
      pushLog('vrm_daily_totals_error', { error: e.message });
      return null;
    }
  }

  return {
    readPvForecast,
    readLoadForecast,
    readDailyTotals,
    isAvailable
  };
}
