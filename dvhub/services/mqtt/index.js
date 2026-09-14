// services/mqtt/index.js -- MQTT Hub factory (INTG-02, INTG-03)
//
// Creates a pub/sub hub that:
//   - Connects to an external MQTT broker when mqtt.brokerUrl is set
//   - Falls back to an embedded aedes broker on 127.0.0.1 (NEVER 0.0.0.0, T-04-02)
//   - Supports wildcard topic subscriptions (MQTT + and # patterns)
//   - Uses reconnectPeriod: 5000 by default to prevent reconnect storms (T-04-04)
//
// Factory pattern matching services/family/index.js:
//   createMqttHub(ctx) -> { start, close, subscribe, publish, connected,
//                           getStatus, getLog, connect, disconnect, restart }
//
// DI context: { getCfg, pushLog, mqttLib?, aedesLib? }
//   mqttLib / aedesLib are test seams (an object with connect() / Aedes) so
//   unit tests never open a socket; production leaves them undefined and the
//   real libraries are imported lazily on first start().
//
// Zustand + Steuerung (2026-09-14): Der Broker war weg, DVhub schrieb alle
// 5 s "Client error: ECONNREFUSED" ins Audit-Log und die Oberfläche zeigte
// nur "Offline" ohne Grund und ohne Knopf. Der Hub führt deshalb eine kleine
// Zustandsmaschine (getStatus), einen eigenen Ereignis-Ring (getLog), kann
// ohne Service-Neustart getrennt/verbunden/neu gestartet werden
// (disconnect/connect/restart — restart liest die Config neu, damit eine
// geänderte Broker-URL sofort gilt, vgl. GH #9) und dedupliziert
// wiederholte Fehler im Audit-Log.

import { redactUrlCreds } from '../../config-redaction.js';

const LOG_RING_MAX = 200;
// Derselbe Fehlertext geht höchstens alle 5 min ins Audit-Log; der eigene
// Ring behält jeden Versuch.
const PUSHLOG_DEDUPE_MS = 5 * 60 * 1000;
const DEFAULT_RECONNECT_MS = 5000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10000;

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

function finitePositive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * @param {{ getCfg: Function, pushLog: Function, mqttLib?: object, aedesLib?: object }} ctx
 */
export function createMqttHub(ctx) {
  const { getCfg, pushLog } = ctx;

  /** @type {Map<string, Set<Function>>} topic-pattern -> handlers */
  const handlers = new Map();

  let client = null;
  let aedesBroker = null;
  let netServer = null;
  // C1 (2026-07-02): raw sockets accepted by netServer, tracked so close()
  // can force them shut instead of waiting on server.close()'s callback,
  // which only fires once every accepted connection has ended.
  const openSockets = new Set();

  // ── Zustand / Log ────────────────────────────────────────────────
  const status = {
    enabled: false,
    state: 'idle',            // idle|disabled|connecting|connected|reconnecting|offline|stopped
    brokerUrl: null,          // immer ohne Zugangsdaten
    embedded: false,
    embeddedListening: false,
    embeddedPort: null,
    clientId: null,
    startedAt: null,
    connectedAt: null,
    disconnectedAt: null,
    lastError: null,
    lastErrorAt: null,
    reconnects: 0,
    connectAttempts: 0,
    manualStop: false
  };
  const logRing = [];
  let lastPushed = { msg: null, at: 0, suppressed: 0 };
  let activeReconnectMs = DEFAULT_RECONNECT_MS;

  function logEvent(level, msg, { audit = true } = {}) {
    logRing.push({ ts: Date.now(), level, msg });
    if (logRing.length > LOG_RING_MAX) logRing.shift();
    if (!audit) return;
    const now = Date.now();
    if (msg === lastPushed.msg && now - lastPushed.at < PUSHLOG_DEDUPE_MS) {
      lastPushed.suppressed++;
      return;
    }
    const suffix = lastPushed.suppressed > 0 ? ` (${lastPushed.suppressed}× gleiche Meldung unterdrückt)` : '';
    lastPushed = { msg, at: now, suppressed: 0 };
    pushLog(`[MQTT] ${msg}${suffix}`, {}, level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info');
  }

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

  function buildConnectOptions(mqttCfg) {
    const connectOpts = {
      reconnectPeriod: finitePositive(mqttCfg.reconnectPeriodMs, DEFAULT_RECONNECT_MS),   // T-04-04
      connectTimeout: finitePositive(mqttCfg.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS),
    };
    if (mqttCfg.username) connectOpts.username = mqttCfg.username;
    if (mqttCfg.password) connectOpts.password = mqttCfg.password;
    if (typeof mqttCfg.clientId === 'string' && mqttCfg.clientId.trim()) connectOpts.clientId = mqttCfg.clientId.trim();
    if (Number.isFinite(Number(mqttCfg.keepaliveSec)) && Number(mqttCfg.keepaliveSec) > 0) connectOpts.keepalive = Number(mqttCfg.keepaliveSec);
    if (typeof mqttCfg.rejectUnauthorized === 'boolean') connectOpts.rejectUnauthorized = mqttCfg.rejectUnauthorized;
    return connectOpts;
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

  async function startEmbeddedBroker(mqttCfg) {
    try {
      // B5 (2026-07-02): aedes 1.x removed the default export + sync
      // constructor (breaking change) — named export + async factory now.
      // drainTimeout defaults to 60000ms in 1.x (was 0/disabled in 0.x): a
      // frozen/slow client on the embedded broker gets force-disconnected
      // after 60s instead of blocking delivery to every other subscriber
      // indefinitely. Kept at the new default — strictly a hardening, not
      // a behaviour DVhub relied on.
      const { Aedes } = ctx.aedesLib || await import('aedes');
      const net = await import('node:net');
      aedesBroker = await Aedes.createBroker();
      const port = mqttCfg.embeddedBroker?.port || 1883;
      status.embeddedPort = port;
      netServer = net.createServer(aedesBroker.handle);
      // C1: track every accepted socket so close() can force-destroy
      // stragglers instead of waiting indefinitely on netServer.close().
      netServer.on('connection', (sock) => {
        openSockets.add(sock);
        sock.on('close', () => openSockets.delete(sock));
      });
      await new Promise((resolve) => {
        netServer.listen(port, '127.0.0.1', () => {   // T-04-02: ALWAYS 127.0.0.1
          status.embeddedListening = true;
          logEvent('info', `Embedded broker listening on 127.0.0.1:${port}`);
          resolve();
        });
        netServer.on('error', (err) => {
          logEvent('warn', `Embedded broker port ${port} in use, skipping: ${err.message}`);
          aedesBroker = null;
          netServer = null;
          status.embeddedListening = false;
          resolve(); // Don't reject — continue without embedded broker
        });
      });
    } catch (err) {
      logEvent('error', `Failed to load aedes for embedded broker: ${err.message}`);
      aedesBroker = null;
      netServer = null;
      status.embeddedListening = false;
    }
  }

  function openClient(mqttCfg, mqtt) {
    const brokerUrl = getBrokerUrl();
    const connectOpts = buildConnectOptions(mqttCfg);
    activeReconnectMs = connectOpts.reconnectPeriod;
    status.brokerUrl = redactUrlCreds(brokerUrl);
    status.clientId = connectOpts.clientId || null;
    status.state = 'connecting';
    status.connectAttempts++;
    status.manualStop = false;
    logEvent('info', `Connecting to ${status.brokerUrl}`, { audit: false });

    const c = mqtt.connect(brokerUrl, connectOpts);
    client = c;
    const mine = () => client === c;   // Events eines bereits ersetzten Clients ignorieren

    c.on('connect', () => {
      if (!mine()) return;
      status.state = 'connected';
      status.connectedAt = Date.now();
      // Plan 08-06 Task 2 Step 5: redact creds from any URL ever logged.
      // brokerUrl may be `mqtt://user:pass@host:1883` — write it verbatim and the
      // password leaks into journalctl, the operator UI log, and any monitoring
      // pipeline that scrapes those logs.
      logEvent('info', `Connected to ${status.brokerUrl}`);
      // Re-subscribe all registered topics
      for (const pattern of handlers.keys()) {
        c.subscribe(pattern, { qos: 0 });
      }
    });

    c.on('message', (topic, payload) => {
      if (!mine()) return;
      dispatchMessage(topic, payload);
    });

    c.on('error', (err) => {
      if (!mine()) return;
      const msg = redactUrlCreds(String(err?.message || err));
      status.lastError = msg;
      status.lastErrorAt = Date.now();
      logEvent('error', `Client error: ${msg}`);
    });

    c.on('reconnect', () => {
      if (!mine()) return;
      status.state = 'reconnecting';
      status.reconnects++;
      status.connectAttempts++;
      logEvent('info', `Reconnecting to ${status.brokerUrl} (attempt ${status.reconnects})`, { audit: false });
    });

    c.on('offline', () => {
      if (!mine()) return;
      status.state = 'offline';
      status.disconnectedAt = Date.now();
      logEvent('warn', 'Client offline');
    });

    c.on('close', () => {
      if (!mine()) return;
      if (status.state === 'connected' || status.state === 'connecting' || status.state === 'reconnecting') {
        status.disconnectedAt = Date.now();
      }
      status.state = status.manualStop ? 'stopped' : 'offline';
      logEvent(status.manualStop ? 'info' : 'warn', status.manualStop ? 'Connection closed (manual stop)' : 'Connection closed', { audit: false });
    });

    c.on('disconnect', (packet) => {
      if (!mine()) return;
      const reason = packet && packet.reasonCode != null ? ` (reason ${packet.reasonCode})` : '';
      logEvent('warn', `Broker sent DISCONNECT${reason}`);
    });

    c.on('end', () => {
      if (!mine()) return;
      status.state = 'stopped';
      logEvent('info', 'Client ended', { audit: false });
    });
  }

  // ── Public API ─────────────────────────────────────────────────────

  async function start() {
    const mqttCfg = getMqttConfig();
    status.enabled = !!mqttCfg.enabled;
    status.startedAt = Date.now();
    if (!mqttCfg.enabled) {
      status.state = 'disabled';
      logEvent('info', 'MQTT disabled in config (mqtt.enabled=false)', { audit: false });
      return; // Master switch off — skip MQTT entirely
    }

    // Step 1: Start embedded broker if needed
    status.embedded = shouldUseEmbeddedBroker();
    if (status.embedded) await startEmbeddedBroker(mqttCfg);

    // Step 2: Connect MQTT client
    try {
      const mqtt = ctx.mqttLib || await import('mqtt');
      openClient(mqttCfg, mqtt);
    } catch (err) {
      status.state = 'offline';
      status.lastError = err.message;
      status.lastErrorAt = Date.now();
      logEvent('error', `Failed to load mqtt library: ${err.message}`);
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

  async function endClient() {
    if (!client) return false;
    // C1 (2026-07-02): force=false client.end() was the PROVEN culprit of a
    // 90s prod shutdown hang + SIGKILL (journal: "step 'mqttHub.close'
    // still pending after 5000ms" on an aged connection to the external
    // broker). force=false waits for in-flight QoS acks and any pending
    // reconnect-state to settle before firing its callback — under an
    // unlucky broker/network state that wait can effectively never
    // resolve. This client only carries best-effort retained telemetry
    // (mqttPublisher state topics, family tiles, teslamate) — never the
    // safety-critical control path, which runs over Modbus — so skipping
    // the graceful flush at shutdown time is a fully acceptable trade-off.
    // Belt-and-braces: still race against a short timeout in case some
    // other mqtt.js internal state manages to wedge the callback anyway
    // (same pattern as the server.js gracefulShutdown step watchdog).
    // Long-term proof (2026-07-02, 56min-old connection — the exact
    // condition of the historical hangs): SIGTERM to teardown-complete in
    // <1s, c.end() callback fired the same tick. Confirmed fixed.
    const c = client;
    client = null;
    let timer = null;
    let timedOut = false;
    await Promise.race([
      new Promise((resolve) => c.end(true, () => { if (timer) clearTimeout(timer); resolve(); })),
      new Promise((resolve) => {
        timer = setTimeout(() => { timedOut = true; resolve(); }, 2000);
      })
    ]);
    return timedOut;
  }

  async function closeEmbeddedBroker() {
    if (aedesBroker) {
      await new Promise((resolve) => aedesBroker.close(() => resolve()));
      aedesBroker = null;
    }
    if (netServer) {
      // netServer.close()'s callback only fires once every accepted TCP
      // connection has ended — a still-open embedded-broker client socket
      // (e.g. a device that never sent DISCONNECT) would hang this
      // indefinitely. aedesBroker.close() above already told well-behaved
      // clients to disconnect; force-destroy whatever's still open so
      // close() always resolves promptly.
      for (const sock of openSockets) { try { sock.destroy(); } catch { /* already gone */ } }
      openSockets.clear();
      await new Promise((resolve) => netServer.close(() => resolve()));
      netServer = null;
    }
    status.embeddedListening = false;
  }

  async function close() {
    const startedAt = Date.now();
    status.manualStop = true;
    const clientTimedOut = await endClient();
    await closeEmbeddedBroker();
    status.state = status.enabled ? 'stopped' : 'disabled';
    logEvent('info', `close() done in ${Date.now() - startedAt}ms${clientTimedOut ? ' (client.end() fallback triggered — did not resolve within 2s)' : ''}`);
  }

  /** Verbindung trennen, Hub bleibt nutzbar (Handler bleiben registriert). */
  async function disconnect() {
    status.manualStop = true;
    const had = !!client;
    await endClient();
    status.state = status.enabled ? 'stopped' : 'disabled';
    if (had) status.disconnectedAt = Date.now();
    logEvent('info', 'Disconnected by operator');
    return { ok: true, state: status.state };
  }

  /** Verbindung (wieder) aufbauen — mit der aktuellen Config. */
  async function connect() {
    const mqttCfg = getMqttConfig();
    if (!mqttCfg.enabled) {
      status.enabled = false;
      status.state = 'disabled';
      return { ok: false, reason: 'disabled', state: status.state };
    }
    if (client?.connected) return { ok: true, state: status.state, alreadyConnected: true };
    if (client) await endClient();
    logEvent('info', 'Connect requested by operator');
    await start();
    return { ok: true, state: status.state };
  }

  /** Alles neu: Client + Embedded-Broker zu, Config neu lesen, wieder hoch. */
  async function restart() {
    logEvent('info', 'Restart requested (re-reading config)');
    await endClient();
    await closeEmbeddedBroker();
    await start();
    return { ok: true, state: status.state };
  }

  function getStatus() {
    return { ...status, connected: client?.connected ?? false, handlers: handlers.size, reconnectPeriodMs: activeReconnectMs };
  }

  function getLog(limit = 100) {
    const n = Math.max(1, Math.min(LOG_RING_MAX, Number(limit) || 100));
    return logRing.slice(-n).reverse();
  }

  return {
    start,
    close,
    subscribe,
    publish,
    connect,
    disconnect,
    restart,
    getStatus,
    getLog,
    get connected() { return client?.connected ?? false; },

    // Test-only helpers (prefixed with _ to indicate internal)
    _dispatchMessage: dispatchMessage,
    _shouldUseEmbeddedBroker: shouldUseEmbeddedBroker,
    _getReconnectPeriod: () => finitePositive(getMqttConfig().reconnectPeriodMs, DEFAULT_RECONNECT_MS),
  };
}
