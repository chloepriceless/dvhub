// test/schedulable-devices.test.js -- Validierung/Normalisierung planbarer Geräte
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateSchedulableDevice, loadSchedulableDevices, isSchedulableDevice,
  allowedEndpointsForKind, DEVICE_KINDS, ENDPOINT_TYPES,
} from '../services/devices/schedulable.js';

const goodDeferrable = {
  id: 'dishwasher', name: 'Geschirrspüler', schedulable: true, kind: 'deferrable',
  plan: { energyWh: 1200, durationH: 2, deadline: '18:00', earliestStart: '08:00' },
  endpoint: { type: 'shelly', shellyDeviceId: 'shelly-1' },
};
const goodModulating = {
  id: 'elwa', name: 'MYPV Elwa', schedulable: true, kind: 'modulating',
  plan: { maxPowerW: 3000, minPowerW: 100, capacityWh: 8000, targetPct: 80, deadline: '20:00' },
  endpoint: { type: 'mqtt_publish', powerTopic: 'elwa/power/set', powerTemplate: '{value}' },
};

describe('validateSchedulableDevice', () => {
  it('accepts a valid deferrable device (shelly endpoint)', () => {
    const r = validateSchedulableDevice(goodDeferrable);
    assert.equal(r.ok, true);
    assert.equal(r.device.kind, 'deferrable');
    assert.equal(r.device.plan.energyWh, 1200);
    assert.equal(r.device.plan.deadline, '18:00');
    assert.equal(r.device.endpoint.type, 'shelly');
    assert.equal(r.device.endpoint.shellyDeviceId, 'shelly-1');
  });

  it('accepts a valid modulating device (mqtt_publish power endpoint)', () => {
    const r = validateSchedulableDevice(goodModulating);
    assert.equal(r.ok, true);
    assert.equal(r.device.plan.maxPowerW, 3000);
    assert.equal(r.device.endpoint.powerTopic, 'elwa/power/set');
  });

  it('rejects unknown kind', () => {
    const r = validateSchedulableDevice({ ...goodDeferrable, kind: 'toaster' });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => /kind/.test(e)));
  });

  it('rejects a shelly endpoint for a modulating device (needs power control)', () => {
    const r = validateSchedulableDevice({ ...goodModulating, endpoint: { type: 'shelly', shellyDeviceId: 'x' } });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => /shelly.*modulating|modulating.*erlaubt|nicht erlaubt/.test(e)));
  });

  it('rejects modulating without powerTopic on mqtt_publish', () => {
    const r = validateSchedulableDevice({ ...goodModulating, endpoint: { type: 'mqtt_publish' } });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => /powerTopic/.test(e)));
  });

  it('rejects deferrable with invalid energy/duration', () => {
    const r = validateSchedulableDevice({ ...goodDeferrable, plan: { energyWh: 0, durationH: 99 } });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => /energyWh/.test(e)));
    assert.ok(r.errors.some(e => /durationH/.test(e)));
  });

  it('rejects invalid deadline format', () => {
    const r = validateSchedulableDevice({ ...goodDeferrable, plan: { ...goodDeferrable.plan, deadline: '25:99' } });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => /deadline/.test(e)));
  });

  it('rejects publish topic with MQTT wildcards', () => {
    const r = validateSchedulableDevice({ ...goodModulating, endpoint: { type: 'mqtt_publish', powerTopic: 'a/+/set' } });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => /Wildcard/.test(e)));
  });

  it('rejects invalid id', () => {
    const r = validateSchedulableDevice({ ...goodDeferrable, id: 'bad id!' });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => /id/.test(e)));
  });
});

describe('allowedEndpointsForKind', () => {
  it('modulating excludes shelly', () => {
    assert.deepEqual(allowedEndpointsForKind('modulating'), ['mqtt_expose', 'mqtt_publish']);
  });
  it('deferrable includes shelly', () => {
    assert.ok(allowedEndpointsForKind('deferrable').includes('shelly'));
  });
});

describe('loadSchedulableDevices', () => {
  it('picks only schedulable entries and reports errors for broken ones', () => {
    const cfg = { devices: [
      { id: 'plain-shelly', name: 'X', adapter: 'shelly-http', shelly: { host: '192.168.1.5' } }, // nicht schedulable
      goodDeferrable,
      { id: 'broken', name: 'B', schedulable: true, kind: 'deferrable', plan: {}, endpoint: {} },
    ] };
    const { devices, errors } = loadSchedulableDevices(cfg);
    assert.equal(devices.length, 1);
    assert.equal(devices[0].id, 'dishwasher');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].id, 'broken');
  });
  it('empty config → empty', () => {
    const r = loadSchedulableDevices({});
    assert.deepEqual(r.devices, []);
    assert.deepEqual(r.errors, []);
  });
});

describe('constants', () => {
  it('kinds and endpoint types', () => {
    assert.deepEqual(DEVICE_KINDS, ['deferrable', 'modulating']);
    assert.deepEqual(ENDPOINT_TYPES, ['mqtt_expose', 'shelly', 'mqtt_publish']);
  });
  it('isSchedulableDevice gate', () => {
    assert.equal(isSchedulableDevice({ schedulable: true }), true);
    assert.equal(isSchedulableDevice({ }), false);
    assert.equal(isSchedulableDevice(null), false);
  });
});
