// test/device-adapter-shelly.test.js -- Shelly HTTP Gen2 adapter unit tests (INTG-05)
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createShellyHttpAdapter } from '../services/devices/adapters/shelly-http.js';

// ---------- mock helpers ----------

function makePushLog() {
  const logs = [];
  const fn = (msg, data) => logs.push({ msg, data });
  fn.logs = logs;
  return fn;
}

/** Create a temporary HTTP server that responds like a Shelly Gen2 device */
function createMockShellyServer(responseData, statusCode = 200) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/rpc/Switch.GetStatus?id=0') {
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseData));
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port, host: `127.0.0.1` });
    });
  });
}

// ---------- Tests ----------

describe('createShellyHttpAdapter', () => {
  let pushLog;
  let mockServer;

  beforeEach(() => {
    pushLog = makePushLog();
  });

  afterEach(async () => {
    if (mockServer?.server) {
      await new Promise(r => mockServer.server.close(r));
      mockServer = null;
    }
  });

  it('returns { type, start, close, getDevices }', () => {
    const adapter = createShellyHttpAdapter([], pushLog);
    assert.equal(adapter.type, 'shelly-http');
    assert.equal(typeof adapter.start, 'function');
    assert.equal(typeof adapter.close, 'function');
    assert.equal(typeof adapter.getDevices, 'function');
  });

  it('fetches http://{host}/rpc/Switch.GetStatus?id=0 and parses apower + aenergy.total', async () => {
    const shellyResponse = {
      id: 0, source: 'init', output: true,
      apower: 125.3, voltage: 231.5, current: 0.542,
      aenergy: { total: 12345.67 },
      temperature: { tC: 42.3 }
    };
    mockServer = await createMockShellyServer(shellyResponse);

    const configs = [{
      id: 'buero',
      name: 'Buero Steckdose',
      shelly: { host: `127.0.0.1:${mockServer.port}`, pollIntervalSec: 1 }
    }];

    const adapter = createShellyHttpAdapter(configs, pushLog);
    await adapter.start();

    // Wait for first poll to complete
    await new Promise(r => setTimeout(r, 200));

    const devices = adapter.getDevices();
    const dev = devices.find(d => d.id === 'buero');
    assert.ok(dev, 'device found');
    assert.equal(dev.powerW, 125.3);
    assert.equal(dev.energyTodayWh, 12345.67);
    assert.equal(dev.online, true);

    await adapter.close();
  });

  it('marks device offline after 3 consecutive fetch failures', async () => {
    // Start server, do one successful poll, then close server to cause failures
    const shellyResponse = { apower: 50, aenergy: { total: 100 } };
    mockServer = await createMockShellyServer(shellyResponse);

    const configs = [{
      id: 'buero',
      name: 'Buero',
      shelly: { host: `127.0.0.1:${mockServer.port}`, pollIntervalSec: 60 }
    }];

    const adapter = createShellyHttpAdapter(configs, pushLog);
    await adapter.start();

    // Wait for first poll
    await new Promise(r => setTimeout(r, 200));

    let dev = adapter.getDevices().find(d => d.id === 'buero');
    assert.equal(dev.online, true, 'online after successful poll');

    // Close the server so subsequent polls fail
    await new Promise(r => mockServer.server.close(r));

    // Trigger 3 manual polls via _pollDevice test helper
    await adapter._pollDevice('buero');
    await adapter._pollDevice('buero');
    await adapter._pollDevice('buero');

    dev = adapter.getDevices().find(d => d.id === 'buero');
    assert.equal(dev.online, false, 'offline after 3 consecutive failures');

    mockServer = null; // Already closed
    await adapter.close();
  });

  it('validates host is private IP (SSRF prevention T-04-16)', () => {
    const configs = [{
      id: 'external',
      name: 'External',
      shelly: { host: '8.8.8.8', pollIntervalSec: 30 }
    }];

    const adapter = createShellyHttpAdapter(configs, pushLog);

    // Should have logged SSRF block
    const ssrfLog = pushLog.logs.find(l => l.msg === 'shelly_ssrf_blocked');
    assert.ok(ssrfLog, 'SSRF block logged');
    assert.equal(ssrfLog.data.host, '8.8.8.8');

    // Device should not be pollable (filtered out)
    const devices = adapter.getDevices();
    assert.equal(devices.length, 0, 'no devices for non-private host');
  });

  it('accepts private IPs: 192.168.x.x, 10.x.x.x, 172.16-31.x.x, localhost', () => {
    const privateHosts = ['192.168.1.100', '10.0.0.5', '172.16.0.1', '172.31.255.255', 'localhost', '127.0.0.1'];
    for (const host of privateHosts) {
      const configs = [{ id: `test-${host}`, name: host, shelly: { host, pollIntervalSec: 999 } }];
      const log = makePushLog();
      const adapter = createShellyHttpAdapter(configs, log);
      const ssrfLog = log.logs.find(l => l.msg === 'shelly_ssrf_blocked');
      assert.equal(ssrfLog, undefined, `${host} should be accepted as private`);
      adapter.close();
    }
  });

  it('rejects public IPs', () => {
    const publicHosts = ['8.8.8.8', '1.1.1.1', '203.0.113.1', 'example.com', '172.32.0.1'];
    for (const host of publicHosts) {
      const configs = [{ id: `test-${host}`, name: host, shelly: { host, pollIntervalSec: 999 } }];
      const log = makePushLog();
      createShellyHttpAdapter(configs, log);
      const ssrfLog = log.logs.find(l => l.msg === 'shelly_ssrf_blocked');
      assert.ok(ssrfLog, `${host} should be blocked as non-private`);
    }
  });

  it('accepts ctx for pushLog access', () => {
    const configs = [];
    // Shelly adapter takes pushLog as second argument
    const adapter = createShellyHttpAdapter(configs, pushLog);
    assert.ok(adapter, 'adapter created with pushLog');
  });

  it('parses only expected fields from Shelly response (T-04-15)', async () => {
    const shellyResponse = {
      id: 0, source: 'init', output: true,
      apower: 75.0, voltage: 230.0, current: 0.33,
      aenergy: { total: 500.0 },
      temperature: { tC: 35.0 },
      unexpected_field: 'should be ignored'
    };
    mockServer = await createMockShellyServer(shellyResponse);

    const configs = [{
      id: 'test-parse',
      name: 'Test',
      shelly: { host: `127.0.0.1:${mockServer.port}`, pollIntervalSec: 1 }
    }];

    const adapter = createShellyHttpAdapter(configs, pushLog);
    await adapter.start();
    await new Promise(r => setTimeout(r, 200));

    const dev = adapter.getDevices().find(d => d.id === 'test-parse');
    assert.equal(dev.powerW, 75.0);
    assert.equal(dev.energyTodayWh, 500.0);
    // Should not have unexpected fields
    assert.equal(dev.unexpected_field, undefined);

    await adapter.close();
  });
});
