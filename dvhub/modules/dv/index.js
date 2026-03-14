/**
 * DV Module stub -- Direktvermarktung module for Phase 3 implementation.
 *
 * Provides the module interface contract (name, requires, init, destroy)
 * so the module registry can manage its lifecycle.
 */

/**
 * Create a DV module instance.
 * @param {object} config - Module configuration
 * @returns {object} Module with lifecycle hooks
 */
export function createDvModule(config) {
  return {
    name: 'dv',
    requires: ['gateway'],

    async init(ctx) {
      ctx.fastify?.log?.info('DV module stub initialized (Phase 3 implementation)');
    },

    async destroy() {
      // Phase 3 will add cleanup
    }
  };
}
