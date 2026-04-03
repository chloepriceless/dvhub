// services/forecast/pvnode-client.js -- pvnode.io PV forecast client.
// 15-minute resolution PV production forecasts.
// Free plan: +1 day forecast. API key required (free registration).
// API: https://pvnode.io

/**
 * Create pvnode forecast client.
 *
 * @param {object} ctx - DI context { getCfg, pushLog }
 * @param {object} deps - { store }
 */
export function createPvnodeClient(ctx, { store }) {
  const { getCfg, pushLog } = ctx;

  let lastFetchAt = null;
  let cachedData = null;
  const MIN_INTERVAL_MS = 15 * 60 * 1000; // 15 min between fetches

  /**
   * Resolve config parameters for pvnode.
   */
  function resolveParams() {
    const cfg = getCfg();
    const fc = cfg.forecast || {};
    const pvnode = fc.pvnode || {};

    if (!pvnode.apiKey) return null;

    const lat = fc.location?.latitude
      || cfg.schedule?.smallMarketAutomation?.location?.latitude;
    const lon = fc.location?.longitude
      || cfg.schedule?.smallMarketAutomation?.location?.longitude;

    if (!lat || !lon) return null;

    const pv = fc.pv || {};
    let kwp = pv.totalKwp;
    if (!kwp && Array.isArray(cfg.userEnergyPricing?.pvPlants)) {
      kwp = cfg.userEnergyPricing.pvPlants.reduce((sum, p) => sum + (p.kwp || 0), 0);
    }
    if (!kwp) return null;

    const tiltDeg = pv.tiltDeg ?? 35;
    const azimuthDeg = pv.azimuthDeg ?? 180;

    return {
      apiKey: pvnode.apiKey,
      lat, lon, kwp,
      tiltDeg,
      azimuthDeg
    };
  }

  /**
   * Fetch PV forecast from pvnode API.
   * Returns array of { ts_utc, power_w }.
   */
  async function fetchForecast() {
    const params = resolveParams();
    if (!params) {
      pushLog('pvnode_skip', { reason: 'missing_params_or_apikey' });
      return null;
    }

    // Rate limit
    if (lastFetchAt && (Date.now() - lastFetchAt) < MIN_INTERVAL_MS) {
      return cachedData;
    }

    const { apiKey, lat, lon, kwp, tiltDeg, azimuthDeg } = params;

    // pvnode API: POST with system params
    const url = 'https://api.pvnode.io/v1/forecast';

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          latitude: lat,
          longitude: lon,
          kwp,
          tilt: tiltDeg,
          azimuth: azimuthDeg - 180, // pvnode uses -180..180 convention like evcc
          resolution: 15 // 15-minute intervals
        }),
        signal: AbortSignal.timeout(15000)
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        pushLog('pvnode_error', { status: res.status, body: text.slice(0, 200) });
        return cachedData;
      }

      const data = await res.json();
      lastFetchAt = Date.now();

      // Parse response — pvnode returns array of { timestamp, power_w } or similar
      const forecasts = data?.forecasts || data?.data || [];
      const slots = [];

      for (const entry of forecasts) {
        const ts = entry.timestamp || entry.time || entry.ts;
        const power = entry.power_w || entry.power || entry.watts || 0;
        if (!ts) continue;

        slots.push({
          ts_utc: new Date(ts).toISOString(),
          power_w: Math.round(power * 10) / 10
        });
      }

      // Persist to DB
      if (store && slots.length > 0) {
        const points = slots.map(s => ({
          model: 'pvnode',
          ts_utc: s.ts_utc,
          power_w: s.power_w,
          confidence: 0.75 // 15-min resolution, good accuracy
        }));
        await store.writePvForecasts(points).catch(e =>
          pushLog('pvnode_store_error', { error: e.message })
        );
      }

      cachedData = slots;
      pushLog('pvnode_ok', { slots: slots.length, kwp });
      return slots;

    } catch (e) {
      pushLog('pvnode_error', { error: e.message });
      return cachedData;
    }
  }

  return {
    fetchForecast,
    get lastFetchAt() { return lastFetchAt; },
    get isConfigured() { return Boolean(getCfg().forecast?.pvnode?.apiKey); }
  };
}
