// test/heater-ev-pause.test.js -- Heizstab-Option „Pausieren, solange das
// E-Auto lädt“ (plan.pauseWhileEvCharging): Validierung, Brücke, Wallbox-Probe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSchedulableDevice } from '../services/devices/schedulable.js';
import { createEosDeviceBridge } from '../services/optimizer/eos-device-bridge.js';
import { createEvChargingProbe } from '../services/wallbox/ev-charging.js';

const heater = (plan = {}) => ({
  id: 'elwa', name: 'Elwa', schedulable: true, kind: 'modulating',
  plan: { maxPowerW: 3000, minPowerW: 100, ...plan }, endpoint: { type: 'mqtt_publish', powerTopic: 't' },
});

function fakeActuator() {
  const calls = [];
  return {
    calls,
    apply: async (device, command) => { calls.push({ id: device.id, ...command }); return { ok: true }; },
    commandKey: (device, command) => `p:${Math.round(command.powerW || 0)}`,
  };
}

function bridge(devices, { evCharging, gridW = -2500 } = {}) {
  const actuator = fakeActuator();
  let asked = 0;
  const b = createEosDeviceBridge({
    getCfg: () => ({ devices }),
    getSolution: async () => ({ rows: [] }),
    actuator,
    state: { meter: { grid_total_w: gridW }, ctrl: {} },
    isEvCharging: evCharging === undefined ? undefined : async () => { asked++; if (evCharging instanceof Error) throw evCharging; return evCharging; },
  });
  return { b, actuator, asked: () => asked };
}

test('Validierung: Option nur bei true übernommen, deferrable ignoriert sie', () => {
  assert.equal(validateSchedulableDevice(heater({ pauseWhileEvCharging: true })).device.plan.pauseWhileEvCharging, true);
  assert.equal('pauseWhileEvCharging' in validateSchedulableDevice(heater({ pauseWhileEvCharging: 'ja' })).device.plan, false);
  assert.equal('pauseWhileEvCharging' in validateSchedulableDevice(heater()).device.plan, false);
  const dw = validateSchedulableDevice({ id: 'dw', name: 'GS', kind: 'deferrable', plan: { energyWh: 1000, durationH: 1, pauseWhileEvCharging: true }, endpoint: { type: 'mqtt_expose' } });
  assert.equal('pauseWhileEvCharging' in dw.device.plan, false);
});

test('Brücke: Auto lädt → Heizstab 0 W mit Grund ev_charging', async () => {
  const { b, actuator } = bridge([heater({ pauseWhileEvCharging: true })], { evCharging: true });
  const r = await b.tick();
  assert.deepEqual(actuator.calls, [{ id: 'elwa', powerW: 0 }]);
  assert.equal(r.status[0].reason, 'ev_charging');
});

test('Brücke: Auto lädt nicht / Zustand unbekannt / Abfrage wirft → normal dem Überschuss folgen', async () => {
  for (const evCharging of [false, null, new Error('down')]) {
    const { b, actuator } = bridge([heater({ pauseWhileEvCharging: true })], { evCharging });
    const r = await b.tick();
    assert.deepEqual(actuator.calls, [{ id: 'elwa', powerW: 2500 }], String(evCharging));
    assert.equal(r.status[0].reason, 'surplus_follow');
  }
});

test('Brücke: ohne Option wird die Wallbox gar nicht gefragt und der Stab heizt weiter', async () => {
  const { b, actuator, asked } = bridge([heater()], { evCharging: true });
  await b.tick();
  assert.equal(asked(), 0);
  assert.deepEqual(actuator.calls, [{ id: 'elwa', powerW: 2500 }]);
});

test('Brücke: nach dem Laden heizt der Stab im nächsten Takt wieder', async () => {
  let charging = true;
  const actuator = fakeActuator();
  const b = createEosDeviceBridge({
    getCfg: () => ({ devices: [heater({ pauseWhileEvCharging: true })] }),
    getSolution: async () => ({ rows: [] }),
    actuator, state: { meter: { grid_total_w: -2000 }, ctrl: {} },
    isEvCharging: async () => charging,
  });
  await b.tick();
  charging = false;
  await b.tick();
  assert.deepEqual(actuator.calls.map((c) => c.powerW), [0, 2000]);
});

test('Probe evcc: irgendein Ladepunkt > 100 W; veraltet/ohne URL → unbekannt', async () => {
  const now = 1_000_000;
  const mk = (st) => createEvChargingProbe({ getCfg: () => ({}), evccIntegration: { getStatus: () => st }, now: () => now });
  const lp = (charging, chargePowerW) => ({ charging, chargePowerW });
  assert.equal(await mk({ url: 'http://evcc', lastPolledAt: now - 5000, loadpoints: [lp(false, 0), lp(true, 7400)] })(), true);
  assert.equal(await mk({ url: 'http://evcc', lastPolledAt: now - 5000, loadpoints: [lp(true, 50)] })(), false, 'Handshake-Phantom');
  assert.equal(await mk({ url: 'http://evcc', lastPolledAt: now - 10 * 60_000, loadpoints: [lp(true, 7400)] })(), null, 'veraltet');
  assert.equal(await mk({ url: null, loadpoints: [] })(), null);
});

test('Probe OpenEVSE/go-e: Adapter-Status; Fehler/nicht eingerichtet → unbekannt', async () => {
  const mk = (adapter) => createEvChargingProbe({ getCfg: () => ({ wallbox: { type: 'goe' } }), getAdapter: () => adapter });
  assert.equal(await mk({ isConfigured: () => true, status: async () => ({ ok: true, charging: true, powerW: 11000 }) })(), true);
  assert.equal(await mk({ isConfigured: () => true, status: async () => ({ ok: true, charging: true, powerW: null }) })(), true);
  assert.equal(await mk({ isConfigured: () => true, status: async () => ({ ok: true, charging: false, powerW: 0 }) })(), false);
  assert.equal(await mk({ isConfigured: () => true, status: async () => ({ ok: false }) })(), null);
  assert.equal(await mk({ isConfigured: () => true, status: async () => { throw new Error('x'); } })(), null);
  assert.equal(await mk({ isConfigured: () => false, status: async () => ({ ok: true, charging: true }) })(), null);
});
