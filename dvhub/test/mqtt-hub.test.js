// test/mqtt-hub.test.js -- MQTT Hub factory unit tests (INTG-02)
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// ---------- mock helpers ----------

function makeMockClient() {
  const handlers = {};
  return {
    connected: false,
    on(ev, fn) { handlers[ev] = fn; return this; },
    subscribe(topic, _opts, cb) { if (cb) cb(null); },
    publish(topic, payload, opts, cb) { if (typeof opts === 'function') { cb = opts; } if (cb) cb(null); },
    end(force, cb) { if (typeof force === 'function') { cb = force; } if (cb) cb(); },
    _handlers: handlers,
    _simulateConnect() { this.connected = true; if (handlers.connect) handlers.connect(); },
    _simulateMessage(topic, payload) { if (handlers.message) handlers.message(topic, Buffer.from(payload)); }
  };
}

function makeMockAedesBroker() {
  return {
    handle: () => {},
    close(cb) { if (cb) cb(); }
  };
}

// ---------- Tests ----------

// Plan 16-04 (D-06 triage, "config-model mqtt sections"): REBUILT.
// The original block asserted that mqtt / integrations / devices / notifications
// were present in createDefaultConfig(). That contract changed by design:
// createDefaultConfig() is intentionally MINIMAL — these optional feature
// sections are absent-by-default ("feature off") and only materialise when the
// user configures them via the settings UI. routes-api.js ALLOWED_CONFIG_ROOTS
// documents them explicitly as "Migration-seeded / optional sections", and every
// runtime consumer reads them defensively (getCfg().mqtt || {} etc.). These
// tests now assert that REAL contract: an absent section degrades gracefully to
// "off", which is the property that actually matters.
describe('config-model optional-section contract', () => {
  it('createDefaultConfig is importable and minimal — optional feature sections are absent by default', async () => {
    const { createDefaultConfig } = await import('../config-model.js');
    const cfg = createDefaultConfig();
    assert.ok(cfg && typeof cfg === 'object', 'createDefaultConfig returns an object');
    // Optional feature sections are NOT seeded into the minimal default config —
    // they are layered in by the settings UI / migrations when actually used.
    for (const optional of ['mqtt', 'integrations', 'devices', 'notifications', 'family', 'support']) {
      assert.equal(cfg[optional], undefined,
        `${optional} is an optional section — absent from the minimal default config`);
    }
  });

  it('routes-api ALLOWED_CONFIG_ROOTS still accepts the optional sections on POST /api/config', async () => {
    // The sections are absent from defaults but MUST round-trip through the
    // strict root-key allowlist when a user saves them — otherwise the settings
    // UI could never configure MQTT / integrations / notifications.
    const { ALLOWED_CONFIG_ROOTS } = await import('../routes-api.js');
    for (const optional of ['mqtt', 'integrations', 'devices', 'notifications', 'family', 'support']) {
      assert.ok(ALLOWED_CONFIG_ROOTS.has(optional),
        `${optional} must be an accepted POST /api/config root key`);
    }
  });

  it('the MQTT hub treats an absent mqtt section as "feature off" (no throw)', async () => {
    const { createMqttHub } = await import('../services/mqtt/index.js');
    // getCfg() with NO mqtt section — the documented absent-by-default state.
    const offHub = createMqttHub({ getCfg: () => ({}), pushLog: () => {} });
    // getMqttConfig() -> getCfg().mqtt || {} -> {}; start() returns early on
    // !mqttCfg.enabled. close() before start must be safe.
    await assert.doesNotReject(() => offHub.close(),
      'close() on a hub built from config with no mqtt section must not throw');
    assert.equal(offHub.connected, false, 'hub stays disconnected when mqtt section is absent');
  });
});

describe('createMqttHub', () => {
  let hub;
  let mockClient;
  let originalConnect;

  beforeEach(async () => {
    mockClient = makeMockClient();
  });

  afterEach(async () => {
    if (hub) { try { await hub.close(); } catch {} }
    hub = null;
  });

  it('returns object with start, close, subscribe, publish, connected', async () => {
    const { createMqttHub } = await import('../services/mqtt/index.js');
    hub = createMqttHub({
      getCfg: () => ({ mqtt: { brokerUrl: 'mqtt://test:1883', embeddedBroker: { enabled: false, port: 1883 }, topicPrefix: 'dvhub', username: '', password: '' } }),
      pushLog: () => {}
    });
    assert.equal(typeof hub.start, 'function');
    assert.equal(typeof hub.close, 'function');
    assert.equal(typeof hub.subscribe, 'function');
    assert.equal(typeof hub.publish, 'function');
    assert.equal(hub.connected, false, 'not connected before start');
  });

  it('subscribe registers handler and dispatches messages', async () => {
    const { createMqttHub } = await import('../services/mqtt/index.js');
    hub = createMqttHub({
      getCfg: () => ({ mqtt: { brokerUrl: 'mqtt://test:1883', embeddedBroker: { enabled: false, port: 1883 }, topicPrefix: 'dvhub', username: '', password: '' } }),
      pushLog: () => {}
    });
    const received = [];
    hub.subscribe('test/topic', (topic, payload) => received.push({ topic, payload }));
    // Simulate message dispatch
    hub._dispatchMessage('test/topic', Buffer.from('hello'));
    assert.equal(received.length, 1);
    assert.equal(received[0].topic, 'test/topic');
  });

  it('wildcard subscription # matches child topics', async () => {
    const { createMqttHub } = await import('../services/mqtt/index.js');
    hub = createMqttHub({
      getCfg: () => ({ mqtt: { brokerUrl: 'mqtt://test:1883', embeddedBroker: { enabled: false, port: 1883 }, topicPrefix: 'dvhub', username: '', password: '' } }),
      pushLog: () => {}
    });
    const received = [];
    hub.subscribe('teslamate/#', (topic, payload) => received.push(topic));
    hub._dispatchMessage('teslamate/cars/1/soc', Buffer.from('50'));
    assert.equal(received.length, 1, 'wildcard # handler called');
    assert.equal(received[0], 'teslamate/cars/1/soc');
  });

  it('wildcard subscription + matches single level', async () => {
    const { createMqttHub } = await import('../services/mqtt/index.js');
    hub = createMqttHub({
      getCfg: () => ({ mqtt: { brokerUrl: 'mqtt://test:1883', embeddedBroker: { enabled: false, port: 1883 }, topicPrefix: 'dvhub', username: '', password: '' } }),
      pushLog: () => {}
    });
    const received = [];
    hub.subscribe('devices/+/status', (topic, payload) => received.push(topic));
    hub._dispatchMessage('devices/lamp1/status', Buffer.from('on'));
    assert.equal(received.length, 1, 'wildcard + handler called');
    hub._dispatchMessage('devices/lamp1/status/detail', Buffer.from('x'));
    assert.equal(received.length, 1, '+ does not match multiple levels');
  });

  it('embedded broker detection when brokerUrl is empty', async () => {
    const { createMqttHub } = await import('../services/mqtt/index.js');
    hub = createMqttHub({
      getCfg: () => ({ mqtt: { brokerUrl: '', embeddedBroker: { enabled: true, port: 18830 }, topicPrefix: 'dvhub', username: '', password: '' } }),
      pushLog: () => {}
    });
    assert.equal(hub._shouldUseEmbeddedBroker(), true);
  });

  it('no embedded broker when brokerUrl is set', async () => {
    const { createMqttHub } = await import('../services/mqtt/index.js');
    hub = createMqttHub({
      getCfg: () => ({ mqtt: { brokerUrl: 'mqtt://remote:1883', embeddedBroker: { enabled: true, port: 1883 }, topicPrefix: 'dvhub', username: '', password: '' } }),
      pushLog: () => {}
    });
    assert.equal(hub._shouldUseEmbeddedBroker(), false);
  });

  it('reconnectPeriod is 5000ms (not aggressive default)', async () => {
    const { createMqttHub } = await import('../services/mqtt/index.js');
    hub = createMqttHub({
      getCfg: () => ({ mqtt: { brokerUrl: 'mqtt://test:1883', embeddedBroker: { enabled: false, port: 1883 }, topicPrefix: 'dvhub', username: '', password: '' } }),
      pushLog: () => {}
    });
    assert.equal(hub._getReconnectPeriod(), 5000);
  });

  it('close cleans up without errors', async () => {
    const { createMqttHub } = await import('../services/mqtt/index.js');
    hub = createMqttHub({
      getCfg: () => ({ mqtt: { brokerUrl: 'mqtt://test:1883', embeddedBroker: { enabled: false, port: 1883 }, topicPrefix: 'dvhub', username: '', password: '' } }),
      pushLog: () => {}
    });
    // close before start should be safe
    await hub.close();
  });
});

// B5 (2026-07-02): real integration coverage for the embedded-broker path —
// the unit tests above only assert the pure _shouldUseEmbeddedBroker()
// config logic, never actually start()+listen() a real aedes broker or
// round-trip a real mqtt.js client through it. That path is exactly what
// the aedes 0.51->1.x migration (named export + async Aedes.createBroker())
// touches, and it had zero coverage before this. No mocks below.
describe('createMqttHub — embedded broker (real aedes + real mqtt.js client)', () => {
  let hub;
  let externalClient;

  afterEach(async () => {
    if (externalClient) { await new Promise((resolve) => externalClient.end(true, resolve)); externalClient = null; }
    if (hub) { await hub.close(); hub = null; }
  });

  it('starts, round-trips a publish/subscribe over the real embedded broker, and closes cleanly', async () => {
    const mqtt = await import('mqtt');
    const port = 18831; // distinct from the config-detection test's port (18830) to avoid port races
    const logs = [];
    const { createMqttHub } = await import('../services/mqtt/index.js');
    hub = createMqttHub({
      getCfg: () => ({ mqtt: { enabled: true, brokerUrl: '', embeddedBroker: { enabled: true, port }, topicPrefix: 'dvhub', username: '', password: '' } }),
      pushLog: (msg) => logs.push(msg)
    });

    const received = [];
    hub.subscribe('test/roundtrip', (topic, payload) => received.push({ topic, payload: payload.toString() }));

    await hub.start();
    assert.ok(logs.some((l) => l.includes(`listening on 127.0.0.1:${port}`)), 'broker should log it is listening');

    // hub.publish() only works once hub's OWN client is connected to the
    // broker it just started — poll briefly instead of a fixed sleep.
    for (let i = 0; i < 50 && !hub.connected; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(hub.connected, true, "hub's own client should connect to the broker it just started");

    hub.publish('test/roundtrip', 'hello-from-hub', { retain: false });
    for (let i = 0; i < 50 && received.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(received, [{ topic: 'test/roundtrip', payload: 'hello-from-hub' }]);

    // A second, independent real mqtt.js client connecting from outside —
    // exercises aedesBroker.handle (net.createServer callback) end-to-end,
    // not just the hub's own internal client.
    externalClient = mqtt.connect(`mqtt://127.0.0.1:${port}`, { connectTimeout: 3000 });
    await new Promise((resolve, reject) => {
      externalClient.on('connect', resolve);
      externalClient.on('error', reject);
    });
    externalClient.publish('test/roundtrip', 'hello-from-external-client');
    for (let i = 0; i < 50 && received.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(received[1], { topic: 'test/roundtrip', payload: 'hello-from-external-client' });

    const closeStart = Date.now();
    await hub.close();
    const closeMs = Date.now() - closeStart;
    assert.ok(closeMs < 5000, `close() should resolve quickly, took ${closeMs}ms`);
  });
});

// C1 (2026-07-02): reproduces the actual failure class that caused the proven
// prod shutdown hang — a broker that accepts the TCP connection but never
// behaves like a real MQTT broker (never sends CONNACK, never acks
// DISCONNECT). Before this fix, force=false client.end() would wait
// indefinitely for exactly this kind of unresponsive broker/network state.
describe('createMqttHub — close() against an unresponsive ("black hole") broker', () => {
  let hub;
  let blackHoleServer;

  afterEach(async () => {
    if (hub) { await hub.close(); hub = null; }
    if (blackHoleServer) { await new Promise((resolve) => blackHoleServer.close(resolve)); blackHoleServer = null; }
  });

  it('close() resolves within the 2s force-fallback instead of hanging on an unresponsive broker', async () => {
    const net = await import('node:net');
    const port = 18841;
    // Accepts the TCP connection and then does nothing — no CONNACK, ever.
    // mqtt.js's client sits in a perpetual "connecting" limbo, which is
    // exactly the internal state a plain client.end(false) can wait on
    // forever.
    blackHoleServer = net.createServer((sock) => { sock.on('error', () => {}); });
    await new Promise((resolve) => blackHoleServer.listen(port, '127.0.0.1', resolve));

    const { createMqttHub } = await import('../services/mqtt/index.js');
    hub = createMqttHub({
      getCfg: () => ({ mqtt: { enabled: true, brokerUrl: `mqtt://127.0.0.1:${port}`, embeddedBroker: { enabled: false }, topicPrefix: 'dvhub', username: '', password: '' } }),
      pushLog: () => {}
    });
    await hub.start(); // never resolves a real 'connect' — client stays in limbo, as intended

    const closeStart = Date.now();
    await hub.close();
    const closeMs = Date.now() - closeStart;
    // Must resolve well under the old 90s systemd hang, and comfortably
    // under the 2s force-fallback + margin — proves force=true is doing the
    // work, not the fallback timer (which would land ~2000ms).
    assert.ok(closeMs < 1500, `close() against a black-hole broker took ${closeMs}ms — expected fast force-disconnect, not a hang`);
  });
});
