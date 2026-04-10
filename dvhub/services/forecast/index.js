// services/forecast/index.js -- Forecast service factory.
// Wires all subsystems: weather, Solcast, PV forecast, load forecast, accuracy tracker.
// Exposes buildForecastResponse() for /api/forecast endpoint (D-01).
// Follows the factory pattern: createForecastService(ctx) -> { start, close, tier, store, buildForecastResponse }

import { detectRamTier } from './ram-tier.js';
import { createForecastStore } from './forecast-store.js';
import { createWeatherFetch } from './weather-fetch.js';
import { createSolcastClient } from './solcast-client.js';
import { createForecastSolar } from './forecast-solar.js';
import { createVrmForecast } from './vrm-forecast.js';
import { createOpenMeteoSolar } from './open-meteo-solar.js';
import { createPvnodeClient } from './pvnode-client.js';
import { createPvForecast } from './pv-forecast.js';
import { createLoadForecast } from './load-forecast.js';
import { createAccuracyTracker } from './accuracy-tracker.js';
import { createPythonBridge } from '../python-bridge/index.js';

/**
 * Create the forecast service. Detects RAM tier, initializes subsystems,
 * and provides buildForecastResponse() for the combined API endpoint.
 *
 * @param {object} ctx - DI context { state, getCfg, pushLog, db }
 * @returns {{ start: Function, close: Function, tier: number, store: object, buildForecastResponse: Function }}
 */
export function createForecastService(ctx) {
  const { state, getCfg, pushLog } = ctx;

  // Detect hardware tier
  const { tier, totalMB } = detectRamTier();

  // Version counter: increments on any forecast data change.
  // Optimizer polls this to detect when re-optimization is needed (D-02).
  let forecastVersion = 0;

  /** Increment forecast version. Called by subsystems when data changes. */
  function bumpForecastVersion() { forecastVersion++; }
  ctx.bumpForecastVersion = bumpForecastVersion;

  // Initialize forecast state with tier-gated flags
  state.forecast = {
    tier,
    totalMB,
    weather: { lastFetchAt: null, data: null, error: null },
    pv: { lastFetchAt: null, model: null, data: null, confidence: 0.3 },
    load: { lastFetchAt: null, data: null, confidence: 0.3 },
    price: { source: 'epex', data: null },
    workerReady: tier === 1  // Tier 1 has no worker, always "ready"
  };

  pushLog('forecast_init', { tier, totalMB });

  // Create store (schema will be ensured on start)
  const store = createForecastStore(ctx);

  // Create subsystems
  const weatherFetch = createWeatherFetch(ctx, { store });
  const solcastClient = createSolcastClient(ctx, { store });
  const forecastSolar = createForecastSolar(ctx, { store });
  const vrmForecast = createVrmForecast(ctx);
  const openMeteoSolar = createOpenMeteoSolar(ctx, { store });
  const pvnodeClient = createPvnodeClient(ctx, { store });
  const pythonBridge = tier >= 2 ? createPythonBridge(ctx, { tier }) : null;
  const pvForecast = createPvForecast(ctx, { tier, store, pythonBridge, solcastClient, forecastSolar, vrmForecast, openMeteoSolar, pvnodeClient });
  const loadForecast = createLoadForecast(ctx, { store, vrmForecast, pythonBridge });
  const accuracyTracker = createAccuracyTracker(ctx, { store });

  /**
   * Start the forecast service: ensure DB schema, start all subsystems.
   */
  async function start() {
    // ctx.db is a getter that reads dbPool — set during createTelemetryStoreIfEnabled() before start() is called
    if (ctx.db) {
      await store.ensureSchema(ctx.db);
      pushLog('forecast_schema_ready', { tier });
    }
    await weatherFetch.start();
    await pvForecast.start();
    await loadForecast.start();
    await accuracyTracker.start();
    pushLog('forecast_started', { tier, subsystems: ['weather', 'pv', 'load', 'accuracy'] });
  }

  /**
   * Graceful shutdown. Stop all subsystems.
   */
  async function close() {
    weatherFetch.close();
    pvForecast.close();
    loadForecast.close();
    accuracyTracker.close();
    if (pythonBridge) pythonBridge.close();
    store.close();
  }

  // --- Internal helpers for buildForecastResponse ---

  /**
   * Build price section from existing EPEX data (15-min resolution per D-02).
   * EPEX day-ahead prices are published facts -- confidence is high for today, lower for tomorrow.
   * @returns {{ resolution: string, slots: Array }}
   */
  function buildPriceSection() {
    const epexData = state.epex?.data;
    if (!Array.isArray(epexData) || epexData.length === 0) {
      return { resolution: '15min', slots: [] };
    }

    const now = Date.now();
    const slots = epexData.map(row => {
      const tsMs = Number(row.ts);
      const endMs = tsMs + 15 * 60 * 1000;
      // Published day-ahead prices for today/tomorrow have near-certain confidence.
      // Prices further out (if any) have lower confidence.
      const hoursAhead = (tsMs - now) / 3_600_000;
      const confidence = hoursAhead <= 24 ? 0.95 : hoursAhead <= 48 ? 0.85 : 0.7;

      return {
        start: new Date(tsMs).toISOString(),
        end: new Date(endMs).toISOString(),
        ctKwh: Number(row.ct_kwh ?? 0),
        confidence
      };
    });

    return { resolution: '15min', slots };
  }

  /**
   * Build PV section from forecast state (15-min resolution per D-02).
   * @returns {{ resolution: string, slots: Array }}
   */
  function buildPvSection() {
    const pvData = state.forecast.pv.data;
    if (!Array.isArray(pvData) || pvData.length === 0) {
      return { resolution: '15min', slots: [] };
    }

    const slots = pvData.map(row => ({
      start: row.ts ? new Date(row.ts).toISOString() : (row.ts_utc || ''),
      end: row.ts
        ? new Date(new Date(row.ts).getTime() + 15 * 60 * 1000).toISOString()
        : '',
      powerW: row.powerW ?? row.power_w ?? 0,
      confidence: row.confidence ?? state.forecast.pv.confidence ?? 0.3
    }));

    return { resolution: '15min', slots };
  }

  /**
   * Build load section from forecast state (1h resolution per D-02).
   * @returns {{ resolution: string, slots: Array }}
   */
  function buildLoadSection() {
    const loadData = state.forecast.load.data;
    if (!Array.isArray(loadData) || loadData.length === 0) {
      return { resolution: '1h', slots: [] };
    }

    const slots = loadData.map(row => ({
      start: row.ts_utc || '',
      end: row.ts_utc
        ? new Date(new Date(row.ts_utc).getTime() + 3_600_000).toISOString()
        : '',
      powerW: row.power_w ?? 0,
      confidence: row.confidence ?? state.forecast.load.confidence ?? 0.3
    }));

    return { resolution: '1h', slots };
  }

  /**
   * Build combined forecast response for /api/forecast per D-01.
   * ML post-processing: applies ML correction after PV section is built (D-02).
   * @returns {{ meta: object, price: object, pv: object, rawPv: object, load: object }}
   */
  async function buildForecastResponse() {
    const cfg = getCfg();
    const pv = buildPvSection();
    const load = buildLoadSection();

    // ML post-processing: correct PV forecast if model available (Tier 2+).
    // correct() is async (spawns Python), so await it.
    let mlResult = { applied: false, corrected: pv.slots, model: null };
    if (ctx.mlService?.correct) {
      try {
        mlResult = (await ctx.mlService.correct(pv.slots, {
          weather: state.forecast.weather?.data,
          pvConfig: cfg.forecast?.pv,
          accuracy: state.forecast.pv?.accuracy
        })) ?? mlResult;
      } catch {
        // Swallow — bypass ML correction on error, keep raw pv
      }
    }

    const mlActive = mlResult.applied || false;

    // Sanity check: if ML correction collapses the forecast (feature pipeline mismatch
    // can cause the model to output ~0 for everything), reject the correction and
    // fall back to raw PV. Compare peaks: if ML peak is < 20% of raw peak AND raw peak
    // was significant (>500W), treat the correction as broken.
    const rawPeak = pv.slots.reduce((max, s) => Math.max(max, s.powerW || 0), 0);
    const mlPeak = mlActive ? mlResult.corrected.reduce((max, s) => Math.max(max, s.powerW || 0), 0) : 0;
    const mlCollapsed = mlActive && rawPeak > 500 && mlPeak < rawPeak * 0.2;
    const correctedPv = (mlActive && !mlCollapsed) ? { ...pv, slots: mlResult.corrected } : pv;
    const mlActiveFinal = mlActive && !mlCollapsed;

    // Legacy compat for app.js drawPriceChart: always use raw PV for the Börsenchart
    // overlay so the curve stays visually correct even if ML correction collapses.
    const solar = pv.slots.map(s => ({ ts: new Date(s.start).getTime(), w: s.powerW || 0 }));
    const consumption = load.slots.map(s => ({ ts: new Date(s.start).getTime(), w: s.powerW || 0 }));

    return {
      ok: true,
      meta: {
        generatedAt: new Date().toISOString(),
        horizon: '72h',
        tier,
        pvModel: state.forecast.pv.model || cfg.forecast?.pv?.model || 'solcast',
        loadModel: cfg.forecast?.load?.model || 'sql_weekday',
        mlActive: mlActiveFinal,
        mlModel: mlActiveFinal ? (mlResult.model || null) : null,
        mlCollapsed: mlCollapsed ? { rawPeak, mlPeak } : false
      },
      price: buildPriceSection(),
      pv: correctedPv,     // ML-corrected (or raw if no model)
      rawPv: pv,           // Pre-ML for comparison chart (D-22)
      load,
      // Legacy fields for app.js Börsenchart overlay (drawPriceChart expects these)
      solar,
      consumption
    };
  }

  return { start, close, tier, store, buildForecastResponse, get forecastVersion() { return forecastVersion; } };
}
