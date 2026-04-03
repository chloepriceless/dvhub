// services/forecast/forecast-solar.js -- Forecast.Solar API client.
// Free, no API key required. 12 requests/hour limit.
// API: https://api.forecast.solar/estimate/{lat}/{lon}/{dec}/{az}/{kwp}

/**
 * Create Forecast.Solar client.
 * @param {object} ctx - DI context { getCfg, pushLog }
 * @param {object} deps - { store }
 */
export function createForecastSolar(ctx, { store }) {
  const { getCfg, pushLog } = ctx;

  let lastFetchAt = null;
  let cachedData = null;
  const MIN_INTERVAL_MS = 5 * 60 * 1000; // 5 min between fetches (12/hour limit)

  /**
   * Resolve PV system parameters from config.
   * Falls back to existing pvPlants and location data.
   */
  function resolveParams() {
    const cfg = getCfg();
    const fc = cfg.forecast || {};
    const pv = fc.pv || {};

    // Location: forecast.location -> schedule.smallMarketAutomation.location
    const lat = fc.location?.latitude
      || cfg.schedule?.smallMarketAutomation?.location?.latitude;
    const lon = fc.location?.longitude
      || cfg.schedule?.smallMarketAutomation?.location?.longitude;

    if (!lat || !lon) return null;

    // kWp: forecast.pv.totalKwp -> sum of pvPlants
    let kwp = pv.totalKwp;
    if (!kwp && Array.isArray(cfg.userEnergyPricing?.pvPlants)) {
      kwp = cfg.userEnergyPricing.pvPlants.reduce((sum, p) => sum + (p.kwp || 0), 0);
    }
    if (!kwp) return null;

    // Tilt and azimuth with defaults
    const dec = pv.tiltDeg ?? 35;
    // Forecast.Solar uses different azimuth convention: -180=N, -90=E, 0=S, 90=W
    // DVhub uses: 0=N, 90=E, 180=S, 270=W
    // Conversion: forecastSolarAz = dvhubAz - 180
    const dvhubAz = pv.azimuthDeg ?? 180;
    const az = dvhubAz - 180;

    return { lat, lon, dec, az, kwp };
  }

  /**
   * Fetch PV forecast from Forecast.Solar API.
   * Returns array of { ts_utc, power_w } for the next ~48h.
   */
  async function fetchForecast() {
    const params = resolveParams();
    if (!params) {
      pushLog('forecast_solar_skip', { reason: 'missing_params' });
      return null;
    }

    // Rate limit check
    if (lastFetchAt && (Date.now() - lastFetchAt) < MIN_INTERVAL_MS) {
      return cachedData;
    }

    const { lat, lon, dec, az, kwp } = params;
    const url = `https://api.forecast.solar/estimate/${lat}/${lon}/${dec}/${az}/${kwp}`;

    try {
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(15000)
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        pushLog('forecast_solar_error', { status: res.status, body: text.slice(0, 200) });
        return cachedData; // Return cached on error
      }

      const data = await res.json();
      lastFetchAt = Date.now();

      // Parse watt_hours_period into 15-min power slots
      const slots = [];
      const whPeriod = data?.result?.watt_hours_period || {};

      for (const [timeStr, wh] of Object.entries(whPeriod)) {
        const ts = new Date(timeStr);
        if (isNaN(ts.getTime())) continue;
        // watt_hours_period gives Wh for the period (typically 1h)
        // Convert to average power in W for the period
        const powerW = wh; // Wh per hour ≈ W average
        slots.push({
          ts_utc: ts.toISOString(),
          power_w: Math.round(powerW * 10) / 10
        });
      }

      // Also persist to DB if store available
      if (store && slots.length > 0) {
        const points = slots.map(s => ({
          model: 'forecast_solar',
          ts_utc: s.ts_utc,
          power_w: s.power_w,
          confidence: 0.7 // Free API, decent accuracy
        }));
        await store.writePvForecasts(points).catch(e =>
          pushLog('forecast_solar_store_error', { error: e.message })
        );
      }

      cachedData = slots;
      pushLog('forecast_solar_ok', { slots: slots.length, kwp });
      return slots;

    } catch (e) {
      pushLog('forecast_solar_error', { error: e.message });
      return cachedData;
    }
  }

  return {
    fetchForecast,
    get lastFetchAt() { return lastFetchAt; },
    get cachedSlots() { return cachedData?.length || 0; }
  };
}
