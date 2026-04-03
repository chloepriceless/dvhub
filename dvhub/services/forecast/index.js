// services/forecast/index.js -- Forecast service factory.
// Wires all subsystems: weather, Solcast, PV forecast, load forecast, accuracy tracker.
// Exposes buildForecastResponse() for /api/forecast endpoint (D-01).
// Follows the factory pattern: createForecastService(ctx) -> { start, close, tier, store, buildForecastResponse }

import { detectRamTier } from './ram-tier.js';
import { createForecastStore } from './forecast-store.js';
import { createWeatherFetch } from './weather-fetch.js';
import { createSolcastClient } from './solcast-client.js';
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
  const pythonBridge = tier >= 2 ? createPythonBridge(ctx, { tier }) : null;
  const pvForecast = createPvForecast(ctx, { tier, store, pythonBridge, solcastClient });
  const loadForecast = createLoadForecast(ctx, { store });
  const accuracyTracker = createAccuracyTracker(ctx, { store });

  /**
   * Start the forecast service: ensure DB schema, start all subsystems.
   */
  async function start() {
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
   * @returns {{ meta: object, price: object, pv: object, load: object }}
   */
  function buildForecastResponse() {
    const cfg = getCfg();
    return {
      meta: {
        generatedAt: new Date().toISOString(),
        horizon: '72h',
        tier,
        pvModel: state.forecast.pv.model || cfg.forecast?.pv?.model || 'solcast',
        loadModel: cfg.forecast?.load?.model || 'sql_weekday'
      },
      price: buildPriceSection(),
      pv: buildPvSection(),
      load: buildLoadSection()
    };
  }

  return { start, close, tier, store, buildForecastResponse };
}
