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

describe('config-model mqtt sections', () => {
  it('createDefaultConfig includes mqtt section with brokerUrl and embeddedBroker', async () => {
    const { createDefaultConfig } = await import('../config-model.js');
    const cfg = createDefaultConfig();
    assert.ok(cfg.mqtt, 'mqtt section exists');
    assert.equal(cfg.mqtt.brokerUrl, '');
    assert.ok(cfg.mqtt.embeddedBroker, 'embeddedBroker exists');
    assert.equal(cfg.mqtt.embeddedBroker.port, 1883);
    assert.equal(cfg.mqtt.embeddedBroker.host, undefined, 'no host field for security');
    assert.equal(cfg.mqtt.publishIntervalMs, 5000);
    assert.equal(cfg.mqtt.topicPrefix, 'dvhub');
    assert.ok(cfg.mqtt.haDiscovery, 'haDiscovery exists');
    assert.equal(cfg.mqtt.haDiscovery.enabled, false);
    assert.equal(cfg.mqtt.haDiscovery.prefix, 'homeassistant');
  });

  it('createDefaultConfig includes integrations section', async () => {
    const { createDefaultConfig } = await import('../config-model.js');
    const cfg = createDefaultConfig();
    assert.ok(cfg.integrations, 'integrations section exists');
    assert.ok(cfg.integrations.tesla, 'tesla config exists');
    assert.equal(cfg.integrations.tesla.enabled, false);
    assert.equal(cfg.integrations.tesla.teslamateCarId, 1);
  });

  it('createDefaultConfig includes devices array', async () => {
    const { createDefaultConfig } = await import('../config-model.js');
    const cfg = createDefaultConfig();
    assert.ok(Array.isArray(cfg.devices), 'devices is an array');
    assert.equal(cfg.devices.length, 0);
  });

  it('createDefaultConfig includes notifications section', async () => {
    const { createDefaultConfig } = await import('../config-model.js');
    const cfg = createDefaultConfig();
    assert.ok(cfg.notifications, 'notifications section exists');
    assert.equal(cfg.notifications.enabled, false);
    assert.ok(cfg.notifications.providers.telegram, 'telegram provider exists');
    assert.ok(cfg.notifications.providers.pushover, 'pushover provider exists');
    assert.ok(Array.isArray(cfg.notifications.triggers), 'triggers is array');
    assert.ok(cfg.notifications.throttle, 'throttle exists');
    assert.equal(cfg.notifications.throttle.minIntervalSec, 300);
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
