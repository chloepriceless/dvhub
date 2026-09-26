// test/device-actuator.test.js -- Endpunkt-Routing des Geräte-Aktors
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceActuator } from '../services/devices/actuator.js';

function harness() {
  const pubs = [];
  const outputs = [];
  const hub = { publish: (t, p, o) => pubs.push({ t, p, o }) };
  const deviceService = { setDeviceOutput: async (id, on) => { outputs.push({ id, on }); return { ok: true, output: on }; } };
  const act = createDeviceActuator({ hub, deviceService, getCfg: () => ({ mqtt: { topicPrefix: 'dvhub' } }), pushLog: () => {} });
  return { act, pubs, outputs };
}

describe('createDeviceActuator', () => {
  it('shelly endpoint → setDeviceOutput on referenced device', async () => {
    const { act, outputs } = harness();
    const dev = { id: 'dw', kind: 'deferrable', endpoint: { type: 'shelly', shellyDeviceId: 'shelly-1' } };
    const r = await act.apply(dev, { on: true });
    assert.equal(r.ok, true);
    assert.deepEqual(outputs, [{ id: 'shelly-1', on: true }]);
  });

  it('mqtt_publish on/off → publishes on/off payload to commandTopic', async () => {
    const { act, pubs } = harness();
    const dev = { id: 'dw', kind: 'deferrable', endpoint: { type: 'mqtt_publish', commandTopic: 'x/set', onPayload: 'ON', offPayload: 'OFF' } };
    await act.apply(dev, { on: true });
    await act.apply(dev, { on: false });
    assert.deepEqual(pubs.map(p => [p.t, p.p]), [['x/set', 'ON'], ['x/set', 'OFF']]);
  });

  it('mqtt_publish modulating → publishes rounded power to powerTopic via template', async () => {
    const { act, pubs } = harness();
    const dev = { id: 'elwa', kind: 'modulating', endpoint: { type: 'mqtt_publish', powerTopic: 'elwa/pwr', powerTemplate: 'P={value}' } };
    await act.apply(dev, { powerW: 1499.6 });
    assert.deepEqual(pubs.map(p => [p.t, p.p]), [['elwa/pwr', 'P=1500']]);
  });

  it('mqtt_expose on/off → publishes retained desired ON/OFF under prefix/device/<id>', async () => {
    const { act, pubs } = harness();
    const dev = { id: 'dw', kind: 'deferrable', endpoint: { type: 'mqtt_expose' } };
    await act.apply(dev, { on: true });
    assert.deepEqual(pubs, [{ t: 'dvhub/device/dw/desired', p: 'ON', o: { retain: true } }]);
  });

  it('mqtt_expose modulating → publishes desired_power_w and desired', async () => {
    const { act, pubs } = harness();
    const dev = { id: 'elwa', kind: 'modulating', endpoint: { type: 'mqtt_expose' } };
    await act.apply(dev, { powerW: 800 });
    assert.deepEqual(pubs.map(p => p.t), ['dvhub/device/elwa/desired_power_w', 'dvhub/device/elwa/desired']);
    assert.equal(pubs[0].p, '800');
    assert.equal(pubs[1].p, 'ON');
  });

  it('modulating powerW=0 → desired OFF', async () => {
    const { act, pubs } = harness();
    const dev = { id: 'elwa', kind: 'modulating', endpoint: { type: 'mqtt_expose' } };
    await act.apply(dev, { powerW: 0 });
    assert.equal(pubs.find(p => p.t.endsWith('/desired')).p, 'OFF');
  });

  it('Codex-P1: reports failure when the MQTT broker is disconnected', async () => {
    const pubs = [];
    const hub = { publish: (t, p, o) => pubs.push({ t, p, o }), get connected() { return false; } };
    const act = createDeviceActuator({ hub, deviceService: {}, getCfg: () => ({ mqtt: {} }), pushLog: () => {} });
    const dev = { id: 'dw', kind: 'deferrable', endpoint: { type: 'mqtt_expose' } };
    const r = await act.apply(dev, { on: true });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'mqtt_disconnected');
    assert.equal(pubs.length, 0); // nichts gesendet
  });

  it('commandKey dedups by state', () => {
    const { act } = harness();
    assert.equal(act.commandKey({ kind: 'deferrable' }, { on: true }), 'o:1');
    assert.equal(act.commandKey({ kind: 'deferrable' }, { on: false }), 'o:0');
    assert.equal(act.commandKey({ kind: 'modulating' }, { powerW: 1200 }), 'p:1200');
  });
});
