// services/forecast/index.js -- Forecast service factory skeleton.
// Initializes RAM tier detection, forecast DB store, and tier-gated subsystem flags.
// Follows the factory pattern: createForecastService(ctx) -> { start, close, tier, store }

import { detectRamTier } from './ram-tier.js';
import { createForecastStore } from './forecast-store.js';

/**
 * Create the forecast service. Detects RAM tier, initializes DB schema,
 * and sets up tier-gated feature flags in state.
 *
 * @param {object} ctx - DI context { state, getCfg, pushLog, db }
 * @returns {{ start: Function, close: Function, tier: number, store: object }}
 */
export function createForecastService(ctx) {
  const { state, pushLog } = ctx;

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

  // Create store (schema will be ensured on start)
  const store = createForecastStore(ctx);

  pushLog('forecast_init', { tier, totalMB });

  /**
   * Start the forecast service: ensure DB schema.
   * Subsystem startup will be added in later plans.
   */
  async function start() {
    if (ctx.db) {
      await store.ensureSchema(ctx.db);
      pushLog('forecast_schema_ready', { tier });
    }
  }

  /**
   * Graceful shutdown. Subsystem cleanup will be added in later plans.
   */
  async function close() {
    store.close();
  }

  return { start, close, tier, store };
}
