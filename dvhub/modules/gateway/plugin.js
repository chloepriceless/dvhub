import fp from 'fastify-plugin';
import fastifyStatic from '@fastify/static';
import { registerWebSocketRoutes } from './routes/websocket.js';
import { registerStatusRoutes } from './routes/status.js';
import { registerControlRoutes } from './routes/control.js';
import { registerScheduleRoutes } from './routes/schedule.js';
import { registerIntegrationRoutes } from './routes/integration.js';
import { registerMeterRoutes } from './routes/meter.js';
import { registerHistoryRoutes } from './routes/history.js';

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin'
};

async function registerGatewayPlugin(fastify, opts) {
  const {
    api,
    config,
    rawConfig,
    getSnapshot,
    getState,
    configPath,
    logBuffer,
    appVersion,
    hal,
    eventBus,
    scheduleRuntime,
    onConfigSaved
  } = opts;

  fastify.addHook('onSend', async (request, reply, payload) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      reply.header(name, value);
    }
    return payload;
  });

  await fastify.register(fastifyStatic, {
    root: api.getPublicDir(),
    prefix: '/',
    wildcard: false,
    index: false
  });

  fastify.get('/', async (request, reply) => {
    const page = api.getRootPage();
    return reply.sendFile(page);
  });

  registerStatusRoutes(fastify, {
    getSnapshot,
    config,
    rawConfig,
    getState,
    configPath,
    logBuffer,
    appVersion,
    onConfigSaved
  });

  registerControlRoutes(fastify, {
    ...opts,
    api,
    hal,
    eventBus,
    config
  });

  registerScheduleRoutes(fastify, {
    ...opts,
    api,
    scheduleRuntime,
    config
  });

  registerIntegrationRoutes(fastify, {
    ...opts,
    api,
    config
  });

  registerMeterRoutes(fastify, {
    ...opts,
    api,
    hal,
    config
  });

  registerHistoryRoutes(fastify, {
    ...opts,
    api,
    config
  });

  const { broadcast } = registerWebSocketRoutes(fastify, { config });

  // Wire broadcast to aggregate telemetry stream -- pushes live data to all WS clients
  const telemetryStream = eventBus?.getStream('telemetry');
  if (telemetryStream) {
    telemetryStream.subscribe(data => {
      if (data) {
        broadcast({ type: 'telemetry', data });
      }
    });
  }

  fastify.get('/*', async (request, reply) => {
    const pathname = String(request.params['*'] || '').replace(/^\/+/, '');
    if (!pathname || pathname.startsWith('api/') || pathname.startsWith('dv/')) {
      return reply.code(404).send({ error: 'not found' });
    }

    try {
      return reply.sendFile(pathname);
    } catch {
      return reply.code(404).send({ error: 'not found' });
    }
  });
}

export default function createGatewayPlugin(options = {}) {
  return fp(async function gatewayPlugin(fastify) {
    await registerGatewayPlugin(fastify, options);
  }, {
    name: 'dvhub-gateway-plugin',
    fastify: '5.x'
  });
}
