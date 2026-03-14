/**
 * Optimizer Module -- Optimization module lifecycle.
 *
 * Wires adapter registry (EOS, EMHASS), plan engine, plan scorer,
 * and Fastify plugin into a cohesive module with init/destroy lifecycle.
 *
 * Fire-and-forget optimizer calls ensure the poll loop is never blocked.
 * Each adapter call uses AbortSignal.timeout(5000) for safety.
 */

import { createAdapterRegistry } from './adapter-registry.js';
import { createEosAdapter } from './adapters/eos.js';
import { createEmhassAdapter } from './adapters/emhass.js';
import { createPlanEngine } from './plan-engine.js';
import { createPlanScorer } from './plan-scorer.js';
import optimizerPlugin from './plugin.js';
import { createEvccBridge } from './services/evcc-bridge.js';
import { createForecastBroker } from './services/forecast-broker.js';
import { createTariffEngine } from './services/tariff-engine.js';
import { createMispelTracker } from './services/mispel-tracker.js';

/**
 * Create an Optimizer module instance.
 * @param {object} config - Full application configuration
 * @returns {object} Module with lifecycle hooks matching module registry contract
 */
export function createOptimizerModule(config) {
  const optConfig = config.modules?.optimizer || {};
  let adapterRegistry = null;
  let planEngine = null;
  let scorer = null;
  let evccBridge = null;
  let forecastBroker = null;
  let tariffEngine = null;
  let mispelTracker = null;
  let evccSubscription = null;

  return {
    name: 'optimizer',
    requires: ['gateway'],
    plugin: null,

    async init(ctx) {
      const log = ctx.fastify?.log;

      // 1. Create plan scorer with config
      scorer = createPlanScorer(optConfig.scoring || {});

      // 2. Create plan engine
      planEngine = createPlanEngine({
        scorer,
        maxHistory: optConfig.maxHistory || 50,
      });

      // 3. Create adapter registry and register configured adapters
      adapterRegistry = createAdapterRegistry({ log });
      const adaptersConfig = optConfig.adapters || {};

      // EOS adapter (enabled by default)
      if (adaptersConfig.eos?.enabled !== false) {
        const eosAdapter = createEosAdapter({
          baseUrl: adaptersConfig.eos?.baseUrl || 'http://localhost:8503',
          timeoutMs: adaptersConfig.eos?.timeoutMs || 5000,
          testedVersions: adaptersConfig.eos?.testedVersions || ['0.2.0'],
        });
        adapterRegistry.register(eosAdapter);
      }

      // EMHASS adapter (enabled by default)
      if (adaptersConfig.emhass?.enabled !== false) {
        const emhassAdapter = createEmhassAdapter({
          baseUrl: adaptersConfig.emhass?.baseUrl || 'http://localhost:5000',
          timeoutMs: adaptersConfig.emhass?.timeoutMs || 5000,
          testedVersions: adaptersConfig.emhass?.testedVersions || ['0.17.0'],
        });
        adapterRegistry.register(emhassAdapter);
      }

      // 4. Health check all adapters (logs warnings for untested versions)
      const healthResults = await adapterRegistry.healthCheckAll();
      for (const [name, result] of healthResults) {
        if (result.healthy) {
          log?.info({ adapter: name, version: result.version }, 'Optimizer adapter healthy');
        } else {
          log?.warn({ adapter: name, error: result.error }, 'Optimizer adapter health check failed');
        }
      }

      // 5b. Create forecast broker (always created)
      forecastBroker = createForecastBroker({ log, maxStaleMs: optConfig.forecastStaleMs || 21600000 });

      // 5c. Create tariff engine
      tariffEngine = createTariffEngine({ config: config.userEnergyPricing || {}, log });

      // 5d. Create MISPEL tracker (disabled by default)
      mispelTracker = createMispelTracker({ config: optConfig.mispel || { enabled: false }, db: ctx.db || null, log });

      // 5e. Create EVCC bridge (only if configured)
      const evccConfig = optConfig.evcc || {};
      if (evccConfig.baseUrl) {
        evccBridge = createEvccBridge({
          baseUrl: evccConfig.baseUrl,
          pollIntervalMs: evccConfig.pollIntervalMs || 30000,
          log,
        });
        evccBridge.start();

        // OPT-10: Publish EVCC state to event bus for unified telemetry
        evccSubscription = evccBridge.getState$().subscribe(state => {
          if (state && ctx.eventBus) {
            ctx.eventBus.publish('evcc.state', state);
          }
          // History persistence: write EVCC loadpoint telemetry to DB
          if (state && ctx.db) {
            const ts = state.updatedAt;
            const samples = (state.loadpoints || []).flatMap((lp, i) => [
              { ts, seriesKey: `evcc.lp${i}.chargePower`, valueNum: lp.chargePower, unit: 'W' },
              { ts, seriesKey: `evcc.lp${i}.vehicleSoc`, valueNum: lp.vehicleSoc ?? 0, unit: '%' },
            ]);
            if (samples.length > 0) {
              ctx.db.insertSamples(samples).catch(err => {
                log?.warn({ err: err.message }, 'Failed to persist EVCC telemetry');
              });
            }
          }
        });
      }

      // 5f. Create triggerOptimization function (fire-and-forget)
      const triggerOptimization = () => {
        // Get current telemetry snapshot from event bus
        const telemetry = ctx.eventBus?.getValue('telemetry') || {};
        const snapshot = {
          soc: telemetry.soc ?? 50,
          pvTotalW: telemetry.pvTotalW ?? 0,
          loadPowerW: telemetry.loadPowerW ?? 0,
          batteryPowerW: telemetry.batteryPowerW ?? 0,
          gridImportW: telemetry.gridImportW ?? 0,
          gridExportW: telemetry.gridExportW ?? 0,
          gridTotalW: telemetry.gridTotalW ?? 0,
          gridSetpointW: telemetry.gridSetpointW ?? 0,
          minSocPct: telemetry.minSocPct ?? 10,
          selfConsumptionW: telemetry.selfConsumptionW ?? 0,
          prices: telemetry.prices || [],
          timestamps: telemetry.timestamps || [],
        };

        // Fire-and-forget: call each adapter with AbortSignal.timeout(5000)
        for (const adapter of adapterRegistry.getAll()) {
          callOptimizer(adapter, snapshot, planEngine, forecastBroker, log)
            .catch(err => {
              log?.warn({ adapter: adapter.name, err: err.message }, 'Optimizer call failed');
            });
        }
      };

      // 6. Create Fastify plugin wrapper
      const pluginOpts = { planEngine, adapterRegistry, triggerOptimization, evccBridge, forecastBroker, tariffEngine, mispelTracker };
      this.plugin = async function optimizerPluginWrapper(fastify) {
        await fastify.register(optimizerPlugin, pluginOpts);
      };

      log?.info({
        adapters: adapterRegistry.getAll().map(a => a.name),
      }, 'Optimizer module initialized');
    },

    async destroy() {
      if (evccSubscription) { evccSubscription.unsubscribe(); evccSubscription = null; }
      if (evccBridge) { evccBridge.stop(); evccBridge = null; }
      if (forecastBroker) { forecastBroker.destroy(); forecastBroker = null; }
      tariffEngine = null;
      mispelTracker = null;
      if (planEngine) planEngine.destroy();
      adapterRegistry = null;
      planEngine = null;
      scorer = null;
      this.plugin = null;
    },
  };
}

/**
 * Internal helper: call optimizer via adapter.optimize() with AbortSignal.timeout.
 * Each adapter encapsulates its own HTTP flow (EOS 3-step, EMHASS single POST).
 * @param {object} adapter - Optimizer adapter with optimize() method
 * @param {object} snapshot - Current telemetry snapshot
 * @param {object} planEngine - Plan engine to submit results to
 * @param {object} log - Logger
 */
async function callOptimizer(adapter, snapshot, planEngine, forecastBroker, log) {
  try {
    const plan = await adapter.optimize(snapshot, { signal: AbortSignal.timeout(5000) });
    if (plan) {
      planEngine.submitPlan(plan);
      if (forecastBroker) {
        forecastBroker.ingestFromPlan(plan);
      }
    }
  } catch (err) {
    log?.warn({ optimizer: adapter.name, err: err.message }, 'Optimizer call failed');
  }
}
