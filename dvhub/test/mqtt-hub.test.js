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
    for (const optional of ['mqtt', 'integrations', 'devices', 'notifications', 'family']) {
      assert.equal(cfg[optional], undefined,
        `${optional} is an optional section — absent from the minimal default config`);
    }
  });

  it('routes-api ALLOWED_CONFIG_ROOTS still accepts the optional sections on POST /api/config', async () => {
    // The sections are absent from defaults but MUST round-trip through the
    // strict root-key allowlist when a user saves them — otherwise the settings
    // UI could never configure MQTT / integrations / notifications.
    const { ALLOWED_CONFIG_ROOTS } = await import('../routes-api.js');
    for (const optional of ['mqtt', 'integrations', 'devices', 'notifications', 'family']) {
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
