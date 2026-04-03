// services/forecast/open-meteo-solar.js -- Open-Meteo based PV power estimation.
// Uses GHI/DNI/DHI weather data (already fetched by weather-fetch.js) to estimate
// PV power output using a simple irradiance-to-power model.
// Free, no API key, no additional API calls needed (reuses weather data).

/**
 * Create Open-Meteo solar forecast estimator.
 * Converts irradiance data from weather-fetch into PV power estimates.
 *
 * @param {object} ctx - DI context { getCfg, pushLog }
 * @param {object} deps - { store }
 */
export function createOpenMeteoSolar(ctx, { store }) {
  const { getCfg, pushLog } = ctx;

  /**
   * Simple irradiance-to-power model.
   * Uses plane-of-array irradiance approximation.
   *
   * @param {number} ghi - Global Horizontal Irradiance (W/m2)
   * @param {number} dni - Direct Normal Irradiance (W/m2)
   * @param {number} dhi - Diffuse Horizontal Irradiance (W/m2)
   * @param {number} temperature - Ambient temperature (C)
   * @param {number} kwp - System capacity kWp
   * @param {number} tiltDeg - Panel tilt (degrees)
   * @param {number} azimuthDeg - Panel azimuth (0=N, 180=S)
   * @returns {number} Estimated power in watts
   */
  function estimatePower(ghi, dni, dhi, temperature, kwp, tiltDeg = 35, azimuthDeg = 180) {
    // Simplified plane-of-array irradiance
    // For a tilted surface, approximate POA from GHI using a tilt factor
    const tiltRad = (tiltDeg * Math.PI) / 180;
    // Simple tilt correction: at optimal tilt (~35 for 48N), factor is ~1.1-1.15
    const tiltFactor = 1 + 0.1 * Math.sin(tiltRad);
    const poa = ghi * tiltFactor;

    // Temperature derating: -0.4%/C above 25C (typical for crystalline silicon)
    const tempCoeff = -0.004;
    const tempDerate = 1 + tempCoeff * Math.max(0, (temperature + 25) - 25); // cell temp ~ ambient + 25

    // System losses: inverter (96%), wiring (98%), soiling (97%), mismatch (98%)
    const systemEfficiency = 0.96 * 0.98 * 0.97 * 0.98;

    // Power = POA / 1000 (STC reference) * kWp * 1000 (to watts) * derating * efficiency
    const powerW = (poa / 1000) * kwp * 1000 * tempDerate * systemEfficiency;

    return Math.max(0, Math.round(powerW));
  }

  /**
   * Generate PV forecast from stored weather data.
   * No additional API call needed — uses data already in DB from weather-fetch.js.
   */
  async function generateForecast() {
    const cfg = getCfg();
    const pv = cfg.forecast?.pv || {};

    // Get kWp from config or pvPlants
    let kwp = pv.totalKwp;
    if (!kwp && Array.isArray(cfg.userEnergyPricing?.pvPlants)) {
      kwp = cfg.userEnergyPricing.pvPlants.reduce((sum, p) => sum + (p.kwp || 0), 0);
    }
    if (!kwp) {
      pushLog('open_meteo_solar_skip', { reason: 'no_kwp' });
      return null;
    }

    const tiltDeg = pv.tiltDeg ?? 35;
    const azimuthDeg = pv.azimuthDeg ?? 180;

    // Read weather data from store (already fetched by weather-fetch.js)
    const now = new Date();
    const end = new Date(now.getTime() + 72 * 60 * 60 * 1000);

    try {
      const weatherRows = await store.getLatestWeather({
        start: now.toISOString(),
        end: end.toISOString()
      });

      if (!weatherRows || weatherRows.length === 0) {
        pushLog('open_meteo_solar_skip', { reason: 'no_weather_data' });
        return null;
      }

      // Multi-string support
      const strings = (pv.configLevel === 'detailed' && Array.isArray(pv.strings) && pv.strings.length > 0)
        ? pv.strings
        : [{ kwp, tiltDeg, azimuthDeg }];

      const slots = weatherRows.map(w => {
        // Sum power across all strings
        let totalPowerW = 0;
        for (const s of strings) {
          totalPowerW += estimatePower(
            w.ghi_wm2 ?? 0,
            w.dni_wm2 ?? 0,
            w.dhi_wm2 ?? 0,
            w.temperature_c ?? 15,
            s.kwp,
            s.tiltDeg ?? tiltDeg,
            s.azimuthDeg ?? azimuthDeg
          );
        }

        return {
          ts_utc: new Date(w.ts_utc).toISOString(),
          power_w: totalPowerW
        };
      });

      // Persist to DB
      if (store && slots.length > 0) {
        const points = slots.map(s => ({
          model: 'open_meteo',
          ts_utc: s.ts_utc,
          power_w: s.power_w,
          confidence: 0.5 // Simple model, lower confidence than API-based
        }));
        await store.writePvForecasts(points).catch(e =>
          pushLog('open_meteo_solar_store_error', { error: e.message })
        );
      }

      pushLog('open_meteo_solar_ok', { slots: slots.length, kwp, strings: strings.length });
      return slots;

    } catch (e) {
      pushLog('open_meteo_solar_error', { error: e.message });
      return null;
    }
  }

  return {
    generateForecast,
    // Exported for testing
    estimatePower
  };
}
