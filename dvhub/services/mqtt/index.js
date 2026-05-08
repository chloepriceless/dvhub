// services/mqtt/index.js -- MQTT Hub factory (INTG-02, INTG-03)
//
// Creates a pub/sub hub that:
//   - Connects to an external MQTT broker when mqtt.brokerUrl is set
//   - Falls back to an embedded aedes broker on 127.0.0.1 (NEVER 0.0.0.0, T-04-02)
//   - Supports wildcard topic subscriptions (MQTT + and # patterns)
//   - Uses reconnectPeriod: 5000 to prevent reconnect storms (T-04-04)
//
// Factory pattern matching services/family/index.js:
//   createMqttHub(ctx) -> { start, close, subscribe, publish, connected }
//
// DI context: { getCfg, pushLog }

import { redactUrlCreds } from '../../config-redaction.js';

/**
 * Match an MQTT topic against a subscription pattern.
 * Supports + (single level) and # (multi-level) wildcards.
 * @param {string} pattern - subscription pattern (e.g. "devices/+/status" or "teslamate/#")
 * @param {string} topic - actual topic (e.g. "devices/lamp1/status")
 * @returns {boolean}
 */
function mqttTopicMatch(pattern, topic) {
  const patParts = pattern.split('/');
  const topParts = topic.split('/');

  for (let i = 0; i < patParts.length; i++) {
    const p = patParts[i];
    if (p === '#') return true;           // # matches everything remaining
    if (i >= topParts.length) return false;
    if (p !== '+' && p !== topParts[i]) return false;
  }
  return patParts.length === topParts.length;
}

/**
 * @param {{ getCfg: Function, pushLog: Function }} ctx
 * @returns {{ start: Function, close: Function, subscribe: Function, publish: Function, connected: boolean }}
 */
export function createMqttHub(ctx) {
  const { getCfg, pushLog } = ctx;

  /** @type {Map<string, Set<Function>>} topic-pattern -> handlers */
  const handlers = new Map();

  let client = null;
  let aedesBroker = null;
  let netServer = null;

  // ── Internal helpers ──────────────────────────────────────────────

  function getMqttConfig() {
    return getCfg().mqtt || {};
  }

  function shouldUseEmbeddedBroker() {
    const mqttCfg = getMqttConfig();
    return !mqttCfg.brokerUrl && mqttCfg.embeddedBroker?.enabled !== false;
  }

  function getBrokerUrl() {
    const mqttCfg = getMqttConfig();
    if (mqttCfg.brokerUrl) return mqttCfg.brokerUrl;
    const port = mqttCfg.embeddedBroker?.port || 1883;
    return `mqtt://127.0.0.1:${port}`;
  }

  /**
   * Dispatch an incoming MQTT message to all matching handlers.
   * Handles exact matches and wildcard patterns (+ and #).
   */
  function dispatchMessage(topic, payload) {
    for (const [pattern, handlerSet] of handlers.entries()) {
      if (mqttTopicMatch(pattern, topic)) {
        for (const fn of handlerSet) {
          try { fn(topic, payload); }
          catch (err) { pushLog(`[MQTT] Handler error for ${topic}: ${err.message}`); }
        }
      }
    }
  }

  // ── Public API ─────────────────────────────────────────────────────

  async function start() {
    const mqttCfg = getMqttConfig();
    if (!mqttCfg.enabled) return; // Master switch off — skip MQTT entirely

    // Step 1: Start embedded broker if needed
    if (shouldUseEmbeddedBroker()) {
      try {
        const aedes = (await import('aedes')).default;
        const net = await import('node:net');
        aedesBroker = aedes();
        const port = mqttCfg.embeddedBroker?.port || 1883;
        netServer = net.createServer(aedesBroker.handle);
        await new Promise((resolve, reject) => {
          netServer.listen(port, '127.0.0.1', () => {   // T-04-02: ALWAYS 127.0.0.1
            pushLog(`[MQTT] Embedded broker listening on 127.0.0.1:${port}`);
            resolve();
          });
          netServer.on('error', (err) => {
            pushLog(`[MQTT] Embedded broker port ${port} in use, skipping: ${err.message}`);
            aedesBroker = null;
            netServer = null;
            resolve(); // Don't reject — continue without embedded broker
          });
        });
      } catch (err) {
        pushLog(`[MQTT] Failed to load aedes for embedded broker: ${err.message}`);
        aedesBroker = null;
        netServer = null;
      }
    }

    // Step 2: Connect MQTT client
    const brokerUrl = getBrokerUrl();
    try {
      const mqtt = await import('mqtt');
      const connectOpts = {
        reconnectPeriod: 5000,   // T-04-04: prevent reconnect storm
        connectTimeout: 10000,
      };
      if (mqttCfg.username) connectOpts.username = mqttCfg.username;
      if (mqttCfg.password) connectOpts.password = mqttCfg.password;

      client = mqtt.connect(brokerUrl, connectOpts);

      client.on('connect', () => {
        // Plan 08-06 Task 2 Step 5: redact creds from any URL ever logged.
        // brokerUrl may be `mqtt://user:pass@host:1883` — write it verbatim and the
        // password leaks into journalctl, the operator UI log, and any monitoring
        // pipeline that scrapes those logs.
        pushLog(`[MQTT] Connected to ${redactUrlCreds(brokerUrl)}`);
        // Re-subscribe all registered topics
        for (const pattern of handlers.keys()) {
          client.subscribe(pattern, { qos: 0 });
        }
      });

      client.on('message', (topic, payload) => {
        dispatchMessage(topic, payload);
      });

      client.on('error', (err) => {
        pushLog(`[MQTT] Client error: ${err.message}`);
      });

      client.on('offline', () => {
        pushLog('[MQTT] Client offline');
      });
    } catch (err) {
      pushLog(`[MQTT] Failed to load mqtt library: ${err.message}`);
      client = null;
    }
  }

  function subscribe(topic, handler) {
    if (!handlers.has(topic)) handlers.set(topic, new Set());
    handlers.get(topic).add(handler);
    // If already connected, subscribe on the wire
    if (client?.connected) {
      client.subscribe(topic, { qos: 0 });
    }
  }

  function publish(topic, payload, opts = {}) {
    if (!client?.connected) return;
    const msg = typeof payload === 'string' ? payload : JSON.stringify(payload);
    client.publish(topic, msg, {
      qos: opts.qos ?? 0,
      retain: opts.retain ?? false
    });
  }

  async function close() {
    if (client) {
      await new Promise((resolve) => client.end(false, () => resolve()));
      client = null;
    }
    if (aedesBroker) {
      await new Promise((resolve) => aedesBroker.close(() => resolve()));
      aedesBroker = null;
    }
    if (netServer) {
      await new Promise((resolve) => netServer.close(() => resolve()));
      netServer = null;
    }
  }

  return {
    start,
    close,
    subscribe,
    publish,
    get connected() { return client?.connected ?? false; },

    // Test-only helpers (prefixed with _ to indicate internal)
    _dispatchMessage: dispatchMessage,
    _shouldUseEmbeddedBroker: shouldUseEmbeddedBroker,
    _getReconnectPeriod: () => 5000,
  };
}
