// pv-forecast.js -- PV forecast orchestrator.
// Gates pvlib to Tier 2+ (D-09). Tier 1 uses Solcast-only.
// Supports 3 config levels: simple, standard, detailed (D-11).
// Model can be 'solcast', 'pvlib', or 'both'.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PV_FORECAST_SCRIPT = path.join(__dirname, '..', 'python-bridge', 'scripts', 'pv_forecast.py');

// Forecast interval: every 6 hours
const FORECAST_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Build pvlib input JSON from config.
 * Supports 3 config levels per D-11:
 *   - simple: uses totalKwp with default tilt=35, azimuth=180
 *   - standard: uses totalKwp with configured tilt and azimuth
 *   - detailed: passes strings[] array directly for multi-string calculation
 *
 * @param {object} cfg - Full config object
 * @returns {object} pvlib input data
 */
export function buildPvlibInput(cfg) {
  const fc = cfg.forecast;
  const pv = fc.pv;
  const loc = fc.location;

  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);

  const base = {
    lat: loc.latitude,
    lon: loc.longitude,
    start: start.toISOString().replace('Z', ''),
    periods: 288, // 72h at 15-min intervals
    weather: []
  };

  // configLevel: 'simple' (default), 'standard', or 'detailed' per D-11
  const level = pv.configLevel || 'simple';

  if (level === 'detailed' && pv.strings && pv.strings.length > 0) {
    // Detailed mode: pass strings array, kwp is sum (used as fallback)
    return {
      ...base,
      kwp: pv.totalKwp || pv.strings.reduce((sum, s) => sum + s.kwp, 0),
      tilt: pv.tiltDeg ?? 35,
      azimuth: pv.azimuthDeg ?? 180,
      strings: pv.strings
    };
  }

  if (level === 'standard') {
    // Standard mode: use configured tilt and azimuth
    return {
      ...base,
      kwp: pv.totalKwp,
      tilt: pv.tiltDeg ?? 35,
      azimuth: pv.azimuthDeg ?? 180,
      strings: []
    };
  }

  // Simple mode (default): use defaults
  return {
    ...base,
    kwp: pv.totalKwp,
    tilt: 35,
    azimuth: 180,
    strings: []
  };
}

/**
 * Merge Solcast and pvlib forecast results.
 * Averages power_w values for matching timestamps. Takes max confidence.
 *
 * @param {Array} solcastRows - [{ ts, power_w, ... }]
 * @param {Array} pvlibRows - [{ ts, power_w, ... }]
 * @returns {Array} merged rows with model='combined'
 */
export function mergePvForecasts(solcastRows, pvlibRows) {
  const map = new Map();

  for (const row of solcastRows) {
    map.set(row.ts, { solcast: row.power_w, pvlib: null });
  }
  for (const row of pvlibRows) {
    const existing = map.get(row.ts);
    if (existing) {
      existing.pvlib = row.power_w;
    } else {
      map.set(row.ts, { solcast: null, pvlib: row.power_w });
    }
  }

  const merged = [];
  for (const [ts, values] of map) {
    let power_w;
    if (values.solcast !== null && values.pvlib !== null) {
      power_w = Math.round((values.solcast + values.pvlib) / 2);
    } else {
      power_w = values.solcast ?? values.pvlib;
    }
    merged.push({
      model: 'combined',
      ts_utc: ts,
      power_w,
      confidence: 0.5 // Combined forecast starts with moderate confidence
    });
  }

  return merged.sort((a, b) => a.ts_utc.localeCompare(b.ts_utc));
}

/**
 * Create PV forecast orchestrator.
 * Gates pvlib to Tier 2+ per D-09. Tier 1 uses Solcast-only.
 *
 * @param {object} ctx - DI context { state, getCfg, pushLog }
 * @param {object} deps - { tier, store, pythonBridge, solcastClient }
 * @returns {{ start: Function, close: Function, runForecast: Function }}
 */
export function createPvForecast(ctx, { tier, store, pythonBridge, solcastClient, forecastSolar, vrmForecast, openMeteoSolar, pvnodeClient }) {
  const { state, getCfg, pushLog } = ctx;
  let intervalId = null;

  /**
   * Transform weather rows from DB format to pvlib input format.
   */
  function weatherToInput(weatherRows) {
    return weatherRows.map(w => ({
      timestamp: w.ts_utc,
      ghi: w.ghi_wm2 ?? 0,
      dni: w.dni_wm2 ?? 0,
      dhi: w.dhi_wm2 ?? 0,
      temperature: w.temperature_c ?? 15,
      wind_speed: w.wind_speed_ms ?? 3
    }));
  }

  /**
   * Run a PV forecast cycle.
   * On Tier 1 or model='solcast': Solcast only.
   * On Tier 2+ and model='pvlib': pvlib only.
   * On Tier 2+ and model='both': run both, merge results.
   */
  async function runForecast() {
    const cfg = getCfg();
    const pvCfg = cfg.forecast?.pv;
    const model = pvCfg?.model || 'auto';
    const isTier1 = tier === 1;

    let solcastResult = [];
    let pvlibResult = [];
    let forecastSolarResult = [];
    let vrmResult = [];

    // --- VRM Forecast (always try if available — free, already fetched by epex-fetch) ---
    if (vrmForecast?.isAvailable()) {
      try {
        vrmResult = await vrmForecast.readPvForecast() || [];
      } catch (err) {
        pushLog('pv_vrm_error', { error: err.message });
      }
    }

    // --- Forecast.Solar (free, no API key, all tiers) ---
    if (model === 'auto' || model === 'forecast_solar' || model === 'both') {
      try {
        forecastSolarResult = await forecastSolar.fetchForecast() || [];
      } catch (err) {
        pushLog('pv_forecast_solar_error', { error: err.message });
      }
    }

    // --- Open-Meteo Solar (free, uses existing weather data, no extra API call) ---
    let openMeteoResult = [];
    if (model === 'auto' || model === 'open_meteo' || model === 'both') {
      try {
        openMeteoResult = await openMeteoSolar.generateForecast() || [];
      } catch (err) {
        pushLog('pv_open_meteo_solar_error', { error: err.message });
      }
    }

    // --- pvnode (needs API key, 15-min resolution) ---
    let pvnodeResult = [];
    if (model === 'pvnode' || model === 'both' || (model === 'auto' && pvnodeClient?.isConfigured)) {
      try {
        pvnodeResult = await pvnodeClient.fetchForecast() || [];
      } catch (err) {
        pushLog('pv_pvnode_error', { error: err.message });
      }
    }

    // --- Solcast (needs API key) ---
    if (model === 'solcast' || model === 'both' || (model === 'auto' && cfg.forecast?.solcast?.apiKey)) {
      try {
        solcastResult = await solcastClient.fetchPvForecast() || [];
      } catch (err) {
        pushLog('pv_solcast_error', { error: err.message });
      }
    }

    // --- pvlib (Tier 2+ only) ---
    if (!isTier1 && (model === 'pvlib' || model === 'both')) {
      try {
        const input = buildPvlibInput(cfg);

        // Get latest weather data for pvlib
        const now = new Date();
        const end = new Date(now.getTime() + 72 * 60 * 60 * 1000);
        const weatherRows = await store.getLatestWeather({ start: now.toISOString(), end: end.toISOString() });

        if (weatherRows.length > 0) {
          input.weather = weatherToInput(weatherRows);
        }

        pvlibResult = await pythonBridge.call(PV_FORECAST_SCRIPT, input) || [];
      } catch (err) {
        pushLog('pv_pvlib_error', { error: err.message });
      }
    }

    // --- Store results ---
    if (model === 'both' && !isTier1 && solcastResult.length > 0 && pvlibResult.length > 0) {
      // Merge both sources
      const merged = mergePvForecasts(solcastResult, pvlibResult);
      for (const row of merged) {
        await store.insertPvForecast(row);
      }
      state.forecast.pv = {
        lastFetchAt: new Date().toISOString(),
        model: 'combined',
        data: merged,
        confidence: 0.5
      };
    } else if (pvlibResult.length > 0) {
      // pvlib-only results
      for (const row of pvlibResult) {
        await store.insertPvForecast({
          model: 'pvlib',
          ts_utc: row.ts,
          power_w: row.power_w,
          confidence: 0.4
        });
      }
      state.forecast.pv = {
        lastFetchAt: new Date().toISOString(),
        model: 'pvlib',
        data: pvlibResult,
        confidence: 0.4
      };
    } else if (solcastResult.length > 0) {
      // Solcast-only results
      for (const row of solcastResult) {
        await store.insertPvForecast({
          model: 'solcast',
          ts_utc: row.ts,
          power_w: row.power_w,
          confidence: 0.6
        });
      }
      state.forecast.pv = {
        lastFetchAt: new Date().toISOString(),
        model: 'solcast',
        data: solcastResult,
        confidence: 0.6
      };
    }

    pushLog('pv_forecast_complete', {
      model,
      tier,
      solcastCount: solcastResult.length,
      pvlibCount: pvlibResult.length
    });
  }

  /**
   * Start the PV forecast service.
   * Sets interval for periodic forecast (every 6h). Runs immediately on start.
   */
  async function start() {
    // Run once immediately
    await runForecast();

    // Schedule periodic runs
    intervalId = setInterval(() => {
      runForecast().catch(err => {
        pushLog('pv_forecast_interval_error', { error: err.message });
      });
    }, FORECAST_INTERVAL_MS);
  }

  /**
   * Stop the PV forecast service. Clear interval.
   */
  function close() {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  return { start, close, runForecast };
}
