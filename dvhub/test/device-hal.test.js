import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Mock transport that simulates Victron Modbus responses
function createMockTransport(registerMap = {}) {
  const calls = [];
  return {
    calls,
    isConnected() { return true; },
    mbRequest({ host, port, unitId, fc, address, quantity, timeoutMs }) {
      calls.push({ method: 'mbRequest', unitId, fc, address, quantity });
      const regs = [];
      for (let i = 0; i < quantity; i++) {
        regs.push(registerMap[address + i] ?? 0);
      }
      return Promise.resolve(regs);
    },
    mbWriteSingle({ host, port, unitId, address, value, timeoutMs }) {
      calls.push({ method: 'mbWriteSingle', unitId, address, value });
      return Promise.resolve({ addr: address, value });
    }
  };
}

test('createDeviceHal with victron loads profile and returns driver', async () => {
  const { createDeviceHal } = await import('../modules/gateway/device-hal.js');
  const transport = createMockTransport();
  const driver = await createDeviceHal({ manufacturer: 'victron' }, transport);

  assert.equal(driver.manufacturer, 'victron');
  assert.equal(typeof driver.readMeter, 'function');
  assert.equal(typeof driver.writeControl, 'function');
  assert.equal(typeof driver.checkHealth, 'function');
});

test('victron driver readMeter calls transport.mbRequest and returns structured reading', async () => {
  const { createDeviceHal } = await import('../modules/gateway/device-hal.js');
  const registerMap = {
    820: 100, 821: 200, 822: 300,  // meter registers (grid power L1/L2/L3)
    843: 75,                        // SoC
    842: 500,                       // battery power
    850: 2000,                      // PV power (DC)
    808: 400, 809: 300, 810: 200,   // AC PV L1/L2/L3
    2700: 0,                        // grid setpoint
    2901: 100,                      // min SoC
    817: 100, 818: 200, 819: 300    // self consumption L1/L2/L3
  };
  const transport = createMockTransport(registerMap);
  const driver = await createDeviceHal({ manufacturer: 'victron' }, transport);

  const reading = await driver.readMeter();

  assert.ok(reading.timestamp > 0, 'timestamp should be set');
  assert.equal(typeof reading.soc, 'number');
  assert.equal(typeof reading.batteryPower, 'number');
  assert.equal(typeof reading.pvPower, 'number');
  assert.ok(reading.raw !== undefined, 'raw data should be present');

  // Verify transport was called
  const mbCalls = transport.calls.filter(c => c.method === 'mbRequest');
  assert.ok(mbCalls.length > 0, 'should have made mbRequest calls');
});

test('victron driver writeControl gridSetpointW calls mbWriteSingle with correct register', async () => {
  const { createDeviceHal } = await import('../modules/gateway/device-hal.js');
  const transport = createMockTransport();
  const driver = await createDeviceHal({ manufacturer: 'victron' }, transport);

  const result = await driver.writeControl('gridSetpointW', -5000);

  assert.ok(result.success);
  assert.equal(result.target, 'gridSetpointW');
  assert.equal(result.value, -5000);
  assert.equal(typeof result.register, 'number');

  const writeCalls = transport.calls.filter(c => c.method === 'mbWriteSingle');
  assert.ok(writeCalls.length === 1, 'should have made exactly one write call');
  assert.equal(writeCalls[0].address, 2700); // gridSetpointW register
});

test('victron driver checkHealth returns health status', async () => {
  const { createDeviceHal } = await import('../modules/gateway/device-hal.js');
  const transport = createMockTransport();
  const driver = await createDeviceHal({ manufacturer: 'victron' }, transport);

  const health = await driver.checkHealth();

  assert.equal(health.connected, true);
  assert.equal(health.manufacturer, 'victron');
  assert.ok(health.lastPollTs > 0);
  assert.ok(Array.isArray(health.errors));
});

test('createDeviceHal with deye throws not-yet-implemented error', async () => {
  const { createDeviceHal } = await import('../modules/gateway/device-hal.js');
  const transport = createMockTransport();

  await assert.rejects(
    async () => {
      const driver = await createDeviceHal({ manufacturer: 'deye' }, transport);
      // If createDeviceHal doesn't throw, the driver methods should throw
      await driver.readMeter();
    },
    (err) => {
      assert.ok(err.message.toLowerCase().includes('not yet implemented') || err.message.toLowerCase().includes('deye'),
        `Error should mention 'not yet implemented' or 'deye', got: ${err.message}`);
      return true;
    }
  );
});

test('createDeviceHal with unknown manufacturer throws error', async () => {
  const { createDeviceHal } = await import('../modules/gateway/device-hal.js');
  const transport = createMockTransport();

  await assert.rejects(
    () => createDeviceHal({ manufacturer: 'unknown' }, transport),
    (err) => {
      assert.ok(err.message.includes('unknown'), `Error should mention 'unknown', got: ${err.message}`);
      return true;
    }
  );
});

test('profile path resolves relative to hersteller/ directory', async () => {
  const { createDeviceHal } = await import('../modules/gateway/device-hal.js');
  const transport = createMockTransport();

  // victron.json must exist at dvhub/hersteller/victron.json
  // If we can load victron, the path is resolving correctly
  const driver = await createDeviceHal({ manufacturer: 'victron' }, transport);
  assert.equal(driver.manufacturer, 'victron');
});
