/**
 * Exec Module -- Arbitration and Execution lifecycle.
 *
 * Wires the arbitrator and executor into the event bus, subscribes to
 * control:intent events, and optionally bridges optimizer plans to intents.
 * All hardware control flows through this module -- no direct HAL writes.
 */

import { createArbitrator } from '../../core/arbitrator.js';
import { createExecutor } from '../../core/executor.js';
import { createPlanIntentBridge } from './plan-intent-bridge.js';
import execPlugin from './plugin.js';

/**
 * Create an exec module instance.
 * @returns {object} Module with lifecycle hooks matching module registry contract
 */
export function createExecModule() {
  let subscription = null;
  let bridge = null;
  let arbitrator = null;
  let executor = null;

  return {
    name: 'exec',
    requires: ['gateway'],
    plugin: null,

    async init(ctx) {
      const log = ctx.log || ctx.fastify?.log;

      // 1. Create arbitrator
      arbitrator = createArbitrator({ log });

      // 2. Get HAL from gateway module
      const gateway = ctx.registry.get('gateway');
      const hal = gateway?.hal;

      // 3. Create executor
      executor = createExecutor({
        hal,
        db: ctx.db,
        eventBus: ctx.eventBus,
        log
      });

      // 4. Subscribe to control:intent events
      subscription = ctx.eventBus.on$('control:intent').subscribe(intent => {
        // Handle clear action -- remove all intents from source
        if (intent.action === 'clear' && intent.source) {
          arbitrator.clearSource(intent.source);
          log?.info({ source: intent.source }, `Cleared intents for source: ${intent.source}`);
          return;
        }

        // Submit intent for arbitration
        const result = arbitrator.submitIntent(intent);

        // Execute applied targets
        for (const target of result.applied) {
          executor.executeCommand({
            source: intent.source,
            priority: intent.priority,
            target,
            value: intent.targets[target],
            reason: intent.reason
          }).catch(err => {
            log?.error({ err, target }, `Executor failed for ${target}`);
          });
        }

        // Log overridden targets
        for (const target of result.overridden) {
          const winner = arbitrator.resolve(target);
          log?.info(
            { source: intent.source, target, overriddenBy: winner?.source },
            `Intent overridden: ${intent.source} ${target} by ${winner?.source}`
          );
        }
      });

      // 5. If optimizer module available, create plan-intent bridge
      const optimizer = ctx.registry.get('optimizer');
      if (optimizer?.planEngine) {
        bridge = createPlanIntentBridge({
          planEngine: optimizer.planEngine,
          eventBus: ctx.eventBus,
          log
        });
        log?.info('Plan-intent bridge active (optimizer module detected)');
      }

      // 6. Create Fastify plugin wrapper for route registration
      const pluginOpts = { arbitrator, executor, db: ctx.db };
      this.plugin = async function execPluginWrapper(fastify) {
        await fastify.register(execPlugin, pluginOpts);
      };

      log?.info('Exec module initialized -- all control flows through arbitrator');

      // Expose for route handlers and testing
      return { arbitrator, executor };
    },

    async destroy() {
      if (bridge) {
        bridge.destroy();
        bridge = null;
      }
      if (subscription) {
        subscription.unsubscribe();
        subscription = null;
      }
      arbitrator = null;
      executor = null;
      this.plugin = null;
    }
  };
}
