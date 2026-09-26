// test/eos-device-bridge.test.js -- Aktuierungs-Bridge für planbare Geräte
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createEosDeviceBridge, deferrableOnNow, surplusW } from '../services/optimizer/eos-device-bridge.js';

function fakeActuator() {
  const calls = [];
  return {
    calls,
    apply: async (device, command) => { calls.push({ id: device.id, ...command }); return { ok: true }; },
    commandKey: (device, command) => device.kind === 'modulating' ? `p:${Math.round(command.powerW || 0)}` : `o:${command.on ? 1 : 0}`,
  };
}

const dishwasher = { id: 'dw', name: 'GS', schedulable: true, kind: 'deferrable', plan: { energyWh: 1000, durationH: 1 }, endpoint: { type: 'mqtt_expose' } };
const heater = { id: 'elwa', name: 'Elwa', schedulable: true, kind: 'modulating', plan: { maxPowerW: 3000, minPowerW: 100 }, endpoint: { type: 'mqtt_publish', powerTopic: 't' } };

describe('deferrableOnNow', () => {
  it('true inside a window, false outside', () => {
    const nowMs = 1000;
    assert.equal(deferrableOnNow({ appl_dw: [{ startMs: 500, endMs: 1500 }] }, 'appl_dw', nowMs), true);
    assert.equal(deferrableOnNow({ appl_dw: [{ startMs: 2000, endMs: 3000 }] }, 'appl_dw', nowMs), false);
    assert.equal(deferrableOnNow({}, 'appl_dw', nowMs), false);
  });
});

describe('surplusW', () => {
  it('export (negative grid) plus already-drawing', () => {
    assert.equal(surplusW({ meter: { grid_total_w: -1500 } }, 500), 2000);
    assert.equal(surplusW({ meter: { grid_total_w: 800 } }, 0), 0); // importing → no surplus
  });
});

describe('createEosDeviceBridge', () => {
  afterEach(() => { delete process.env.DVHUB_READ_ONLY; });

  it('skips in read-only mode', async () => {
    process.env.DVHUB_READ_ONLY = '1';
    const act = fakeActuator();
    const b = createEosDeviceBridge({ getCfg: () => ({ devices: [dishwasher] }), getSolution: async () => ({ rows: [] }), actuator: act, state: {} });
    const r = await b.tick();
    assert.equal(r.skipped, 'read_only');
    assert.equal(act.calls.length, 0);
  });

  it('deferrable: turns ON when EOS dispatch covers now', async () => {
    const now = () => Date.parse('2026-09-26T13:30:00.000Z');
    const rows = [
      { ts_utc: '2026-09-26T13:00:00.000Z', appliances: { appl_dw_running: 1 } },
      { ts_utc: '2026-09-26T14:00:00.000Z', appliances: { appl_dw_running: 0 } },
    ];
    const act = fakeActuator();
    const state = { optimizer: { eosApplianceIdMap: { appl_dw: 'dw' } } };
    const b = createEosDeviceBridge({ getCfg: () => ({ devices: [dishwasher] }), getSolution: async () => ({ rows }), actuator: act, state, now });
    await b.tick();
    assert.deepEqual(act.calls, [{ id: 'dw', on: true }]);
  });

  it('deferrable: OFF when no dispatch window now', async () => {
    const now = () => Date.parse('2026-09-26T20:00:00.000Z');
    const rows = [{ ts_utc: '2026-09-26T13:00:00.000Z', appliances: { appl_dw_running: 1 } }];
    const act = fakeActuator();
    const state = { optimizer: { eosApplianceIdMap: { appl_dw: 'dw' } } };
    const b = createEosDeviceBridge({ getCfg: () => ({ devices: [dishwasher] }), getSolution: async () => ({ rows }), actuator: act, state, now });
    await b.tick();
    assert.deepEqual(act.calls, [{ id: 'dw', on: false }]);
  });

  it('modulating: follows PV surplus', async () => {
    const act = fakeActuator();
    const state = { meter: { grid_total_w: -1200 } };
    const b = createEosDeviceBridge({ getCfg: () => ({ devices: [heater] }), getSolution: async () => ({ rows: [] }), actuator: act, state });
    await b.tick();
    assert.deepEqual(act.calls, [{ id: 'elwa', powerW: 1200 }]);
  });

  it('dedups: unchanged command not re-sent (heater pinned at max)', async () => {
    const act = fakeActuator();
    // Großer Überschuss → Leistung an maxPowerW geklemmt, bleibt über Ticks gleich
    // (auch mit Ramp: Export + Heizlast bleibt > max → clamp auf max) → Dedup.
    const state = { meter: { grid_total_w: -5000 } };
    const b = createEosDeviceBridge({ getCfg: () => ({ devices: [heater] }), getSolution: async () => ({ rows: [] }), actuator: act, state });
    await b.tick();
    await b.tick();
    assert.equal(act.calls.length, 1);
    assert.deepEqual(act.calls[0], { id: 'elwa', powerW: 3000 });
  });

  it('modulating ramp: surplus accounts for already-drawing power', async () => {
    const act = fakeActuator();
    const state = { meter: { grid_total_w: -1200 } };
    const b = createEosDeviceBridge({ getCfg: () => ({ devices: [heater] }), getSolution: async () => ({ rows: [] }), actuator: act, state });
    await b.tick(); // surplus 1200 → power 1200, lastPower=1200
    state.meter.grid_total_w = 0; // now no export, but heater draws 1200 → surplus = 1200
    await b.tick();
    // command unchanged (still 1200) → deduped, so still 1 call
    assert.equal(act.calls.length, 1);
  });
});
