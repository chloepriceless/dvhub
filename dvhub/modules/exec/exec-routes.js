/**
 * Exec API Routes
 *
 * Provides:
 * - GET /api/exec/status  (JSON -- current arbitrator state and executor config)
 * - GET /api/exec/log     (JSON -- recent command log entries)
 */

/**
 * Register exec API routes on a Fastify instance.
 * @param {object} fastify - Fastify instance
 * @param {object} opts
 * @param {object} opts.arbitrator - Arbitrator instance
 * @param {object} opts.executor - Executor instance
 */
export function registerExecRoutes(fastify, { arbitrator, executor }) {
  // GET /api/exec/status -- returns current arbitrator state
  const statusOpts = {};
  if (fastify.authenticate) {
    statusOpts.preHandler = [fastify.authenticate];
  }
  fastify.get('/api/exec/status', statusOpts, async () => {
    return {
      arbitrator: {
        activeIntents: Object.fromEntries(arbitrator.resolveAll()),
        overridden: arbitrator.getOverridden().slice(-20)
      },
      executor: {
        config: executor.getConfig()
      }
    };
  });

  // GET /api/exec/log -- returns recent command results
  const logOpts = {};
  if (fastify.authenticate) {
    logOpts.preHandler = [fastify.authenticate];
  }
  fastify.get('/api/exec/log', logOpts, async (request) => {
    const limit = Math.min(
      Math.max(parseInt(request.query?.limit, 10) || 50, 1),
      200
    );
    return executor.getCommandLog(limit);
  });
}
