// test/grid-voltage-poll.test.js — der zentrale Poller liest die Netzwerte
// (services/grid-voltage.js) in jedem Durchlauf mit; eine Unit-Suche hält den
// Steuer-Takt nicht auf; SPiNE-Spannungen kommen aus derselben EM.GetStatus.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPoller } from '../polling.js';

function baseState() {
  return {
    meter: { ok: false, updatedAt: 0, raw: [], grid_l1_w: 0, grid_l2_w: 0, grid_l3_w: 0, grid_total_w: 0, error: null },
    victron: { errors: {}, updatedAt: 0 },
    dvRegs: new Array(8).fill(0),
    energy: { day: '2026-11-05', importWh: 0, exportWh: 0, costEur: 0, revenueEur: 0, lastTs: 0 },
  };
}
function makePoller({ transport, cfg, fetchImpl, gridVoltageFirstDelayMs = 0, gridVoltagePoller } = {}) {
  const state = baseState();
  const poller = createPoller({
    state,
    getCfg: () => cfg,
    transport,
    pushLog: () => {},
    energyPath: '/tmp/grid-voltage-poll-test.json',
    onPollComplete: () => {},
    epexNowNext: () => ({ current: { ct_kwh: 0 } }),
    fetchImpl,
    gridVoltageFirstDelayMs,
    gridVoltagePoller,
  });
  return { state, poller };
}
const victronCfg = (over = {}) => ({
  pollMs: 500,
  manufacturer: 'victron',
  gridPositiveMeans: 'feed_in',
  meter: { host: 'gx', port: 502, unitId: 100, fc: 4, address: 820, quantity: 3 },
  points: {},
  epex: { timezone: 'UTC' },
  userEnergyPricing: {},
  dvControl: {},
  victron: { host: 'gx', port: 502, unitId: 100 },
  ...over,
});

test('Poller: Netzspannung + Frequenz landen in state.victron.gridVoltage (Victron Modbus, Unit 100)', async () => {
  const transport = {
    type: 'modbus',
    mbRequest: async ({ address }) => {
      if (address === 2616) return [2382, 142, 2371, 139, 2374];
      if (address === 2644) return [4998];
      return [100, 200, 300];
    },
  };
  const { state, poller } = makePoller({ transport, cfg: victronCfg() });
  await poller.requestPoll();
  await new Promise((r) => setImmediate(r));
  const gv = state.victron.gridVoltage;
  assert.ok(gv, 'gridVoltage gesetzt');
  assert.deepEqual([gv.l1, gv.l2, gv.l3, gv.frequencyHz, gv.unitId, gv.source], [238.2, 237.1, 237.4, 49.98, 100, 'victron_modbus']);
});

test('Poller wartet nicht auf die Spannungs-Lesung (Unit-Suche blockiert den Steuer-Takt nicht)', async () => {
  let release;
  const gridVoltagePoller = { onPoll: () => new Promise((r) => { release = r; }) };
  const transport = { type: 'modbus', mbRequest: async () => [100, 200, 300] };
  const { state, poller } = makePoller({ transport, cfg: victronCfg(), gridVoltagePoller });
  await poller.requestPoll(); // hinge, wenn der Poller auf onPoll wartete
  assert.equal(state.meter.ok, true);
  release();
});

test('SPiNE EnergyLink: Spannungen aus derselben EM.GetStatus-Antwort an den zentralen Leser', async () => {
  const seen = [];
  const gridVoltagePoller = { onPoll: async (cfg, extra) => { seen.push(extra); } };
  const em = { a_voltage: 235.775, b_voltage: 236.1, c_voltage: 234.9, freq: 50.022, a_act_power: 1, b_act_power: 1, c_act_power: 1, total_act_power: 3 };
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => em });
  const transport = { type: 'modbus', mbRequest: async () => { throw new Error('nicht benutzen'); } };
  const { poller } = makePoller({ transport, cfg: victronCfg({ meter: { readType: 'spine-http', host: '192.168.1.137' }, victron: {} }), fetchImpl, gridVoltagePoller });
  await poller.requestPoll();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].spine.a_voltage, 235.775);
  assert.ok(seen[0].spineAt > 0);
});
