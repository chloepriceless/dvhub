/**
 * Optimizer Fastify Plugin
 *
 * Wraps optimizer route registration as a fastify-plugin for proper
 * encapsulation and module lifecycle integration.
 */

import fp from 'fastify-plugin';
import { createOptimizerRoutes } from './routes/optimizer-routes.js';
import { createEvccRoutes } from './routes/evcc-routes.js';
import { createForecastRoutes } from './routes/forecast-routes.js';
import { createTariffRoutes } from './routes/tariff-routes.js';

export default fp(async function optimizerPlugin(fastify, opts) {
  const { planEngine, adapterRegistry, triggerOptimization, evccBridge, forecastBroker, tariffEngine, mispelTracker } = opts;

  // Register core optimizer routes
  const registerRoutes = createOptimizerRoutes({ planEngine, adapterRegistry, triggerOptimization });
  registerRoutes(fastify);

  // Register EVCC routes (only if bridge is configured)
  if (evccBridge) {
    const registerEvccRoutes = createEvccRoutes({ evccBridge });
    registerEvccRoutes(fastify);
  }

  // Register forecast routes (always available when forecastBroker exists)
  if (forecastBroker) {
    const registerForecastRoutes = createForecastRoutes({ forecastBroker });
    registerForecastRoutes(fastify);
  }

  // Register tariff and MISPEL routes (always available when tariffEngine exists)
  if (tariffEngine) {
    const registerTariffRoutes = createTariffRoutes({ tariffEngine, mispelTracker });
    registerTariffRoutes(fastify);
  }
}, { name: 'optimizer-plugin' });
