// test/device-adapter-mqtt.test.js -- MQTT Generic adapter unit tests (INTG-05)
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMqttGenericAdapter } from '../services/devices/adapters/mqtt-generic.js';

// ---------- mock helpers ----------

function makeMockHub() {
  const subscriptions = new Map();
  return {
    subscribe(topic, handler) {
      if (!subscriptions.has(topic)) subscriptions.set(topic, new Set());
      subscriptions.get(topic).add(handler);
    },
    _simulateMessage(topic, payload) {
      const buf = typeof payload === 'string' ? Buffer.from(payload) : payload;
      for (const [pattern, handlers] of subscriptions.entries()) {
        if (pattern === topic) {
          for (const fn of handlers) fn(topic, buf);
        }
      }
    },
    _subscriptions: subscriptions,
  };
}

function makePushLog() {
  const logs = [];
  const fn = (msg, data) => logs.push({ msg, data });
  fn.logs = logs;
  return fn;
}

// ---------- Tests ----------

describe('createMqttGenericAdapter', () => {
  let hub, pushLog;

  const deviceConfigs = [
    {
      id: 'waschmaschine',
      name: 'Waschmaschine',
      mqtt: { topic: 'zigbee2mqtt/waschmaschine', powerField: 'power', energyField: 'energy' }
    },
    {
      id: 'trockner',
      name: 'Trockner',
      mqtt: { topic: 'zigbee2mqtt/trockner', powerField: 'power', energyField: 'energy' }
    }
  ];

  beforeEach(() => {
    hub = makeMockHub();
    pushLog = makePushLog();
  });

  it('returns { type, start, close, getDevices }', () => {
    const adapter = createMqttGenericAdapter(hub, deviceConfigs, pushLog);
    assert.equal(adapter.type, 'mqtt-generic');
    assert.equal(typeof adapter.start, 'function');
    assert.equal(typeof adapter.close, 'function');
    assert.equal(typeof adapter.getDevices, 'function');
  });

  it('subscribes to each device topic via hub.subscribe on start', async () => {
    const adapter = createMqttGenericAdapter(hub, deviceConfigs, pushLog);
    await adapter.start();
    assert.ok(hub._subscriptions.has('zigbee2mqtt/waschmaschine'));
    assert.ok(hub._subscriptions.has('zigbee2mqtt/trockner'));
  });

  it('parses JSON payload extracting powerField and energyField', async () => {
    const adapter = createMqttGenericAdapter(hub, deviceConfigs, pushLog);
    await adapter.start();

    hub._simulateMessage('zigbee2mqtt/waschmaschine', JSON.stringify({ power: 125.3, energy: 0.5 }));

    const devices = adapter.getDevices();
    const dev = devices.find(d => d.id === 'waschmaschine');
    assert.ok(dev, 'device found');
    assert.equal(dev.powerW, 125.3);
    assert.equal(dev.energyTodayWh, 0.5);
  });

  it('handles flat JSON keys (powerField extracts from payload[key])', async () => {
    const configs = [{
      id: 'lamp',
      name: 'Lamp',
      mqtt: { topic: 'zigbee2mqtt/lamp', powerField: 'active_power', energyField: 'energy_delivered' }
    }];
    const adapter = createMqttGenericAdapter(hub, configs, pushLog);
    await adapter.start();

    hub._simulateMessage('zigbee2mqtt/lamp', JSON.stringify({ active_power: 42.0, energy_delivered: 1.23 }));

    const dev = adapter.getDevices().find(d => d.id === 'lamp');
    assert.equal(dev.powerW, 42.0);
    assert.equal(dev.energyTodayWh, 1.23);
  });

  it('marks device online on message, offline after 5 minutes no update', async () => {
    const adapter = createMqttGenericAdapter(hub, deviceConfigs, pushLog);
    await adapter.start();

    hub._simulateMessage('zigbee2mqtt/waschmaschine', JSON.stringify({ power: 100, energy: 0.1 }));

    let devices = adapter.getDevices();
    let dev = devices.find(d => d.id === 'waschmaschine');
    assert.equal(dev.online, true);

    // Simulate stale lastSeen by manipulating internal state via _setLastSeen test helper
    adapter._setLastSeen('waschmaschine', Date.now() - 6 * 60 * 1000);

    devices = adapter.getDevices();
    dev = devices.find(d => d.id === 'waschmaschine');
    assert.equal(dev.online, false, 'device should be offline after 5+ minutes');
  });

  it('handles non-JSON payloads (plain number string like "125.3")', async () => {
    const adapter = createMqttGenericAdapter(hub, deviceConfigs, pushLog);
    await adapter.start();

    hub._simulateMessage('zigbee2mqtt/waschmaschine', '125.3');

    const dev = adapter.getDevices().find(d => d.id === 'waschmaschine');
    assert.ok(dev, 'device found');
    assert.equal(dev.powerW, 125.3);
    assert.equal(dev.energyTodayWh, null, 'energyTodayWh null for plain number');
  });

  it('validates numeric fields with Number.isFinite (T-04-14)', async () => {
    const adapter = createMqttGenericAdapter(hub, deviceConfigs, pushLog);
    await adapter.start();

    // Send invalid numeric data
    hub._simulateMessage('zigbee2mqtt/waschmaschine', JSON.stringify({ power: 'not-a-number', energy: NaN }));

    const dev = adapter.getDevices().find(d => d.id === 'waschmaschine');
    assert.equal(dev.powerW, null, 'non-finite power should be null');
    assert.equal(dev.energyTodayWh, null, 'NaN energy should be null');
  });

  it('getDevices returns DeviceReading[] shape', async () => {
    const adapter = createMqttGenericAdapter(hub, deviceConfigs, pushLog);
    await adapter.start();

    hub._simulateMessage('zigbee2mqtt/waschmaschine', JSON.stringify({ power: 50, energy: 0.2 }));

    const devices = adapter.getDevices();
    assert.ok(Array.isArray(devices));
    const dev = devices.find(d => d.id === 'waschmaschine');
    assert.equal(typeof dev.id, 'string');
    assert.equal(typeof dev.name, 'string');
    assert.equal(typeof dev.lastSeen, 'number');
    assert.equal(typeof dev.online, 'boolean');
    assert.ok('powerW' in dev);
    assert.ok('energyTodayWh' in dev);
  });

  it('returns all configured devices even before any message', async () => {
    const adapter = createMqttGenericAdapter(hub, deviceConfigs, pushLog);
    await adapter.start();

    const devices = adapter.getDevices();
    assert.equal(devices.length, 2);
    assert.ok(devices.every(d => d.online === false));
    assert.ok(devices.every(d => d.powerW === null));
  });
});
