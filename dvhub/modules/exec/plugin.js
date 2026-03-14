/**
 * Exec Fastify Plugin
 *
 * Wraps exec route registration as a fastify-plugin for proper
 * encapsulation and module lifecycle integration.
 */

import fp from 'fastify-plugin';
import { registerExecRoutes } from './exec-routes.js';

export default fp(async function execPlugin(fastify, opts) {
  registerExecRoutes(fastify, opts);
}, { name: 'exec-plugin' });
