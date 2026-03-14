import Fastify from 'fastify';
import websocketPlugin from '@fastify/websocket';

import { loadConfig } from './core/config.js';
import { createEventBus } from './core/event-bus.js';
import { createModuleRegistry } from './core/module-registry.js';
import authPlugin from './core/auth.js';
import { createGatewayModule } from './modules/gateway/index.js';

function resolveConfigPath() {
  return process.env.DV_APP_CONFIG || './config.json';
}

async function registerOptionalModules({ config, registry }) {
  if (config.modules?.dv?.enabled) {
    const { createDvModule } = await import('./modules/dv/index.js');
    registry.register(createDvModule(config));
  }

  if (config.modules?.optimizer?.enabled) {
    const { createOptimizerModule } = await import('./modules/optimizer/index.js');
    registry.register(createOptimizerModule(config));
  }
}

async function bootstrapServer() {
  const configPath = resolveConfigPath();
  const { rawConfig, config } = loadConfig(configPath);

  const fastify = Fastify({
    logger: {
      level: config.logLevel || 'info'
    }
  });

  const eventBus = createEventBus();
  const registry = createModuleRegistry();

  await fastify.register(authPlugin, {
    apiToken: config.apiToken
  });

  await fastify.register(websocketPlugin);

  const gateway = createGatewayModule(config);
  registry.register(gateway);

  await registerOptionalModules({ config, registry });

  await registry.initAll({
    fastify,
    eventBus,
    config,
    rawConfig,
    configPath,
    registry
  });

  for (const mod of registry.getAll()) {
    if (mod.plugin) {
      await fastify.register(mod.plugin);
    }
  }

  return {
    fastify,
    eventBus,
    registry,
    config
  };
}

function createShutdownHandler({ fastify, eventBus, registry }) {
  let shuttingDown = false;

  return async signal => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    fastify.log.info({ signal }, 'Shutdown requested');

    try {
      await registry.destroyAll();
    } catch (error) {
      fastify.log.error({ err: error }, 'Failed to destroy modules');
    }

    try {
      eventBus.destroy();
    } catch (error) {
      fastify.log.error({ err: error }, 'Failed to destroy event bus');
    }

    try {
      await fastify.close();
    } catch (error) {
      fastify.log.error({ err: error }, 'Failed to close HTTP server');
    }

    process.exit(0);
  };
}

async function start() {
  const { fastify, eventBus, registry, config } = await bootstrapServer();

  const shutdown = createShutdownHandler({
    fastify,
    eventBus,
    registry
  });

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const port = config.httpPort || 3000;
  await fastify.listen({
    port,
    host: '0.0.0.0'
  });

  fastify.log.info({ port }, 'DVhub server started');
}

start().catch(error => {
  console.error(error);
  process.exit(1);
});
