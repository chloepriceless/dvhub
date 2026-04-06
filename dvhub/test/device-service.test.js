// test/device-service.test.js -- Device Service unit tests (INTG-05)
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceService } from '../services/devices/index.js';

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

function makeMockDb() {
  const queries = [];
  return {
    query(sql, params) {
      queries.push({ sql, params });
      return Promise.resolve({ rows: [] });
    },
    _queries: queries,
  };
}

function makePushLog() {
  const logs = [];
  const fn = (msg, data) => logs.push({ msg, data });
  fn.logs = logs;
  return fn;
}

// ---------- Tests ----------

describe('createDeviceService', () => {
  let hub, db, pushLog;

  const deviceConfig = [
    {
      id: 'waschmaschine',
      name: 'Waschmaschine',
      adapter: 'mqtt-generic',
      mqtt: { topic: 'zigbee2mqtt/waschmaschine', powerField: 'power', energyField: 'energy' }
    },
    {
      id: 'buero',
      name: 'Buero',
      adapter: 'shelly-http',
      shelly: { host: '192.168.1.50', pollIntervalSec: 999 }  // Long poll to prevent actual polling
    }
  ];

  beforeEach(() => {
    hub = makeMockHub();
    db = makeMockDb();
    pushLog = makePushLog();
  });

  it('returns { start, close, getDevices }', () => {
    const ctx = { getCfg: () => ({ devices: [] }), pushLog, db };
    const service = createDeviceService(ctx, hub);
    assert.equal(typeof service.start, 'function');
    assert.equal(typeof service.close, 'function');
    assert.equal(typeof service.getDevices, 'function');
  });

  it('start() calls ensureSchema to create device_readings table', async () => {
    const ctx = { getCfg: () => ({ devices: [] }), pushLog, db };
    const service = createDeviceService(ctx, hub);
    await service.start();

    const schemaQuery = db._queries.find(q => q.sql.includes('CREATE TABLE IF NOT EXISTS device_readings'));
    assert.ok(schemaQuery, 'ensureSchema SQL executed');
    assert.ok(schemaQuery.sql.includes('device_id TEXT'), 'has device_id column');
    assert.ok(schemaQuery.sql.includes('power_w DOUBLE PRECISION'), 'has power_w column');
    assert.ok(schemaQuery.sql.includes('energy_today_wh DOUBLE PRECISION'), 'has energy_today_wh column');
    assert.ok(schemaQuery.sql.includes('idx_device_readings_device_ts'), 'has index');

    await service.close();
  });

  it('start() creates adapters from getCfg().devices and starts them', async () => {
    const ctx = { getCfg: () => ({ devices: deviceConfig }), pushLog, db };
    const service = createDeviceService(ctx, hub);
    await service.start();

    // MQTT adapter should have subscribed
    assert.ok(hub._subscriptions.has('zigbee2mqtt/waschmaschine'), 'MQTT topic subscribed');

    // Should have logged device_service_started
    const startLog = pushLog.logs.find(l => l.msg === 'device_service_started');
    assert.ok(startLog, 'service started log');
    assert.equal(startLog.data.count, 2);

    await service.close();
  });

  it('getDevices() aggregates results from all adapters', async () => {
    const ctx = { getCfg: () => ({ devices: deviceConfig }), pushLog, db };
    const service = createDeviceService(ctx, hub);
    await service.start();

    // Simulate MQTT message
    hub._simulateMessage('zigbee2mqtt/waschmaschine', JSON.stringify({ power: 100, energy: 0.5 }));

    const devices = service.getDevices();
    assert.ok(Array.isArray(devices));
    // Should have devices from both adapters (even if Shelly ones show as offline since host is unreachable in test)
    assert.ok(devices.length >= 1, 'at least MQTT device present');

    const mqttDev = devices.find(d => d.id === 'waschmaschine');
    assert.ok(mqttDev, 'MQTT device found');
    assert.equal(mqttDev.powerW, 100);
    assert.equal(mqttDev.energyTodayWh, 0.5);

    await service.close();
  });

  it('getDevices() returns DeviceReading[] with { id, name, powerW, energyTodayWh, online, lastSeen }', async () => {
    const ctx = { getCfg: () => ({ devices: deviceConfig }), pushLog, db };
    const service = createDeviceService(ctx, hub);
    await service.start();

    hub._simulateMessage('zigbee2mqtt/waschmaschine', JSON.stringify({ power: 75, energy: 1.2 }));

    const devices = service.getDevices();
    const dev = devices.find(d => d.id === 'waschmaschine');
    assert.ok(dev);
    assert.equal(typeof dev.id, 'string');
    assert.equal(typeof dev.name, 'string');
    assert.ok('powerW' in dev);
    assert.ok('energyTodayWh' in dev);
    assert.equal(typeof dev.online, 'boolean');
    assert.equal(typeof dev.lastSeen, 'number');

    await service.close();
  });

  it('empty config (no devices) returns empty array', async () => {
    const ctx = { getCfg: () => ({ devices: [] }), pushLog, db };
    const service = createDeviceService(ctx, hub);
    await service.start();

    const devices = service.getDevices();
    assert.ok(Array.isArray(devices));
    assert.equal(devices.length, 0);

    await service.close();
  });

  it('undefined devices config returns empty array', async () => {
    const ctx = { getCfg: () => ({}), pushLog, db };
    const service = createDeviceService(ctx, hub);
    await service.start();

    const devices = service.getDevices();
    assert.equal(devices.length, 0);

    await service.close();
  });

  it('persistence: readings written to device_readings table via persistReadings', async () => {
    // Use only MQTT device (Shelly will fail to connect in test)
    const mqttOnly = [deviceConfig[0]];
    const ctx = { getCfg: () => ({ devices: mqttOnly }), pushLog, db };
    const service = createDeviceService(ctx, hub);
    await service.start();

    // Simulate message
    hub._simulateMessage('zigbee2mqtt/waschmaschine', JSON.stringify({ power: 200, energy: 3.5 }));

    // Trigger manual persist via _persistReadings test helper
    await service._persistReadings();

    const insertQuery = db._queries.find(q => q.sql.includes('INSERT INTO device_readings'));
    assert.ok(insertQuery, 'INSERT executed');
    assert.ok(insertQuery.sql.includes('$1'), 'parameterized query');
    assert.deepEqual(insertQuery.params, ['waschmaschine', 200, 3.5, true]);

    await service.close();
  });

  it('close() stops all adapters and persistence timer', async () => {
    const ctx = { getCfg: () => ({ devices: deviceConfig }), pushLog, db };
    const service = createDeviceService(ctx, hub);
    await service.start();

    // Should not throw
    await service.close();

    // Double close should be safe
    await service.close();
  });

  it('handles missing db gracefully', async () => {
    const ctx = { getCfg: () => ({ devices: deviceConfig }), pushLog, db: null };
    const service = createDeviceService(ctx, hub);
    await service.start();  // Should not throw

    const devices = service.getDevices();
    assert.ok(Array.isArray(devices));

    await service.close();
  });
});
