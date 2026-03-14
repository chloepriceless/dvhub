/**
 * DV Module -- Direktvermarktung module lifecycle.
 *
 * Wires all DV components (state, provider, modbus slave, curtailment,
 * intent emitter, plugin) into a cohesive module with init/destroy lifecycle.
 *
 * The DV module requires the gateway module for Modbus proxy access.
 * When disabled in config, zero DV runtime footprint exists.
 */

import { createDvState } from './dv-state.js';
import { createModbusSlave } from './modbus-slave.js';
import { createCurtailmentManager } from './curtailment.js';
import { createIntentEmitter } from './control-intents.js';
import { createLuoxProvider } from './providers/luox.js';
import dvPlugin from './plugin.js';

/**
 * Create a DV module instance.
 * @param {object} config - Full application configuration
 * @returns {object} Module with lifecycle hooks matching module registry contract
 */
export function createDvModule(config) {
  const dvConfig = config.modules?.dv || {};
  const offLeaseMs = dvConfig.offLeaseMs || config.offLeaseMs || 480000;

  let telemetrySub = null;
  let dvState = null;
  let curtailment = null;
  let modbusSlave = null;
  let provider = null;

  return {
    name: 'dv',
    requires: ['gateway'],
    plugin: null,

    async init(ctx) {
      const log = ctx.fastify?.log;

      // 1. Create provider (LUOX is default, extensible later)
      const providerName = dvConfig.provider || 'luox';
      if (providerName === 'luox') {
        provider = createLuoxProvider();
      } else {
        throw new Error(`Unknown DV provider: ${providerName}`);
      }

      // 2. Initialize DV state
      dvState = createDvState();

      // 3. Create intent emitter
      const emitter = createIntentEmitter(ctx.eventBus);

      // 4. Create curtailment manager
      curtailment = createCurtailmentManager({
        state: dvState,
        emitter,
        offLeaseMs,
        log
      });

      // 5. Create Modbus slave
      modbusSlave = createModbusSlave({
        state: dvState,
        provider,
        onWrite: (signal) => {
          if (signal.action === 'curtail') {
            curtailment.setForcedOff(signal.reason);
          } else if (signal.action === 'release') {
            curtailment.clearForcedOff(signal.reason);
          }
        },
        log
      });

      // 6. Subscribe to telemetry stream for register updates (SYNCHRONOUS path)
      const telemetryStream = ctx.eventBus.getStream('telemetry');
      if (telemetryStream) {
        telemetrySub = telemetryStream.subscribe(data => {
          if (data?.meter) {
            dvState.updateRegistersFromTelemetry(data.meter, provider);
          }
        });
      }

      // 7. Register frame handler on gateway's Modbus proxy
      const gateway = ctx.registry?.get('gateway');
      const mbProxy = gateway?.modbusProxy;
      if (mbProxy) {
        mbProxy.setFrameHandler((frame, socket) => {
          const remote = `${socket?.remoteAddress || 'unknown'}:${socket?.remotePort || 0}`;
          const response = modbusSlave.processFrame(frame, remote);
          if (response && socket?.writable) {
            socket.write(response);
          }
        });
      }

      // 8. Inject DV state into gateway's /api/status response
      if (gateway?.setDvStateProvider) {
        gateway.setDvStateProvider(() => ({
          dvRegs: { ...dvState.dvRegs },
          ctrl: { ...dvState.ctrl },
          controlValue: curtailment.controlValue()
        }));
      }

      // 9. Start lease expiry timer
      curtailment.startLeaseTimer();

      // 10. Create Fastify plugin as wrapper so server.js can register without opts
      const pluginOpts = { state: dvState, curtailment, provider };
      this.plugin = async function dvPluginWrapper(fastify) {
        await fastify.register(dvPlugin, pluginOpts);
      };

      log?.info({ provider: provider.name, offLeaseMs }, 'DV module initialized');
    },

    async destroy() {
      // Reverse order cleanup
      if (curtailment) curtailment.destroy();
      if (telemetrySub) {
        telemetrySub.unsubscribe();
        telemetrySub = null;
      }
      dvState = null;
      curtailment = null;
      modbusSlave = null;
      provider = null;
      this.plugin = null;
    }
  };
}
