/**
 * Optimizer Module stub -- Optimizer module for Phase 4 implementation.
 *
 * Provides the module interface contract (name, requires, init, destroy)
 * so the module registry can manage its lifecycle.
 */

/**
 * Create an Optimizer module instance.
 * @param {object} config - Module configuration
 * @returns {object} Module with lifecycle hooks
 */
export function createOptimizerModule(config) {
  return {
    name: 'optimizer',
    requires: ['gateway'],

    async init(ctx) {
      ctx.fastify?.log?.info('Optimizer module stub initialized (Phase 4 implementation)');
    },

    async destroy() {
      // Phase 4 will add cleanup
    }
  };
}
