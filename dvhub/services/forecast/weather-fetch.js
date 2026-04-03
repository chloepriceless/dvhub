// weather-fetch.js -- Open-Meteo weather data fetcher with hourly cache.
// Factory: createWeatherFetch(ctx, { store }) -> { start, close }
// Fetches GHI/DNI/DHI/temperature/wind/visibility/humidity hourly.

const OPEN_METEO_BASE = 'https://api.open-meteo.com/v1/forecast';

const HOURLY_VARS = [
  'shortwave_radiation',
  'direct_normal_irradiance',
  'diffuse_radiation',
  'temperature_2m',
  'windspeed_10m',
  'cloudcover',
  'visibility',
  'relative_humidity_2m'
].join(',');

/**
 * Build the Open-Meteo URL for weather forecast data.
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude
 * @returns {string} Full URL
 */
export function buildOpenMeteoUrl(lat, lon) {
  return `${OPEN_METEO_BASE}?latitude=${lat}&longitude=${lon}&hourly=${HOURLY_VARS}&forecast_days=4&timezone=Europe/Berlin`;
}

/**
 * Parse Open-Meteo hourly response into weather_forecasts row objects.
 * @param {object} data - Open-Meteo response JSON
 * @returns {Array<object>} rows matching weather_forecasts schema
 */
export function parseOpenMeteoResponse(data) {
  const hourly = data?.hourly;
  if (!hourly || !Array.isArray(hourly.time)) return [];

  const times = hourly.time;
  const rows = [];

  for (let i = 0; i < times.length; i++) {
    rows.push({
      provider: 'open_meteo',
      ts_utc: times[i],
      ghi_wm2: hourly.shortwave_radiation?.[i] ?? null,
      dni_wm2: hourly.direct_normal_irradiance?.[i] ?? null,
      dhi_wm2: hourly.diffuse_radiation?.[i] ?? null,
      temperature_c: hourly.temperature_2m?.[i] ?? null,
      wind_speed_ms: hourly.windspeed_10m?.[i] ?? null,
      cloud_cover_pct: hourly.cloudcover?.[i] ?? null,
      visibility_m: hourly.visibility?.[i] ?? null,
      humidity_pct: hourly.relative_humidity_2m?.[i] ?? null
    });
  }

  return rows;
}

/**
 * Create a weather fetch service that fetches from Open-Meteo periodically.
 * @param {object} ctx - DI context { state, getCfg, pushLog }
 * @param {{ store: object }} deps - forecast-store instance
 * @returns {{ start: Function, close: Function }}
 */
export function createWeatherFetch(ctx, { store }) {
  const { state, getCfg, pushLog } = ctx;

  let timer = null;

  /**
   * Resolve lat/lon from config with fallback to SMA location.
   * @returns {{ lat: number, lon: number }|null}
   */
  function resolveLocation() {
    const cfg = getCfg();
    let lat = cfg.forecast?.location?.latitude;
    let lon = cfg.forecast?.location?.longitude;

    // Fallback: schedule.smallMarketAutomation.location (D-12)
    if (lat == null || lon == null) {
      lat = cfg.schedule?.smallMarketAutomation?.location?.latitude;
      lon = cfg.schedule?.smallMarketAutomation?.location?.longitude;
    }

    if (lat == null || lon == null) return null;
    return { lat, lon };
  }

  /**
   * Fetch weather data from Open-Meteo and persist via forecast-store.
   */
  async function fetchWeather() {
    const loc = resolveLocation();
    if (!loc) {
      pushLog('weather_fetch_skip', { reason: 'no_location_configured' });
      return;
    }

    const url = buildOpenMeteoUrl(loc.lat, loc.lon);

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);

      const data = await res.json();
      const rows = parseOpenMeteoResponse(data);

      // Persist each row via forecast-store
      for (const row of rows) {
        await store.insertWeather(row);
      }

      // Update state
      state.forecast.weather.lastFetchAt = Date.now();
      state.forecast.weather.data = rows;
      state.forecast.weather.error = null;
      ctx.bumpForecastVersion?.();

      pushLog('weather_fetch_ok', { count: rows.length });
    } catch (error) {
      state.forecast.weather.error = error.message;
      pushLog('weather_fetch_error', { error: error.message });
    }
  }

  /**
   * Start periodic weather fetching.
   */
  function start() {
    const cfg = getCfg();
    const intervalMs = cfg.forecast?.weather?.fetchIntervalMs ?? 3_600_000;

    // Fetch immediately on start
    fetchWeather();

    // Then fetch on interval
    timer = setInterval(fetchWeather, intervalMs);
  }

  /**
   * Stop periodic weather fetching.
   */
  function close() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { start, close, fetchWeather };
}
