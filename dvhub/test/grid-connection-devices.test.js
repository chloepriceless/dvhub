// test/grid-connection-devices.test.js — die Grenzen des Netzanschluss-Wächters
// kommen an den Geräten an, und mit §14a gilt je Gerät die kleinste:
//   Wallbox   eos-evcc-bridge getGridCapW (server.js: wallboxGridCapW)
//   EEBUS     paragraph14a → eebus.applyConsumptionShares
//   Heizstab  my-PV-Regler (getCapW)

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { createParagraph14aService } from '../services/paragraph14a/index.js';
import { createMypvRegulator } from '../services/devices/mypv-regulator.js';
import { wallboxGridCapW, createGridConnectionGuard } from '../services/grid-connection/index.js';
import { createEosEvccBridge } from '../services/optimizer/eos-evcc-bridge.js';

function p14aSetup({ gcEebus = {}, p14aLimitW = null } = {}) {
  const cfg = { gridPositiveMeans: 'grid_import', optimizer: { maxChargeW: 10000 }, paragraph14a: {} };
  const state = { ctrl: {}, victron: {}, meter: { grid_total_w: 1000 } };
  if (p14aLimitW != null) state.ctrl.eebusConsumptionLimitW = p14aLimitW;
  const applied = [];
  const ctx = {
    state, getCfg: () => cfg, pushLog: () => {},
    eebus: {
      consumptionDevices: () => [{ id: 'eebus:hp', kind: 'waermepumpe', maxW: 3000, powerW: 2500 }],
      applyConsumptionShares: (shares, until) => applied.push({ shares, until }),
    },
    gridConnection: { eebusCaps: () => gcEebus },
  };
  const svc = createParagraph14aService(ctx, { setInterval: () => 0, clearInterval: () => {} });
  return { svc, applied };
}

test('EEBUS: Netzanschluss-Grenze kommt auch ohne §14a-Vorgabe an', () => {
  const s = p14aSetup({ gcEebus: { 'eebus:hp': 1500 } });
  s.svc.update();
  assert.deepEqual(s.applied.at(-1).shares, { 'eebus:hp': 1500 });
});

test('EEBUS: kleinste gilt — §14a-Anteil 3 000 W, Netzanschluss 1 500 W → 1 500 W', () => {
  const s = p14aSetup({ gcEebus: { 'eebus:hp': 1500 }, p14aLimitW: 7560 });
  s.svc.update();
  assert.equal(s.applied.at(-1).shares['eebus:hp'], 1500);
});

test('EEBUS: ohne Netzanschluss-Grenze bleibt der §14a-Anteil', () => {
  const s = p14aSetup({ p14aLimitW: 7560 });
  s.svc.update();
  assert.equal(s.applied.at(-1).shares['eebus:hp'], 3000);
});

test('Wallbox: kleinste gilt aus §14a-Anteil und Netzanschluss', () => {
  assert.equal(wallboxGridCapW(null, null), null);
  assert.equal(wallboxGridCapW(4500, null), 4500);
  assert.equal(wallboxGridCapW(null, 6000), 6000);
  assert.equal(wallboxGridCapW(4500, 0), 0);
});

test('server.js: die EOS-Brücke fragt die zusammengeführte Wallbox-Grenze ab', () => {
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(src, /getGridCapW: \(\) => wallboxGridCapW\(/);
});

test('Heizstab: der my-PV-Regler hält die Netzanschluss-Grenze ein', async () => {
  const NOW = 1_700_000_000_000;
  let t = NOW;
  const writes = [];
  const state = { meter: { ok: true, updatedAt: NOW }, victron: { gridExportW: 9000, gridImportW: 0, batteryDischargeW: 0, soc: 60 }, ctrl: {}, optimizer: {} };
  const cfg = { devices: [{ id: 'heizstab', name: 'Heizstab', kind: 'modulating', schedulable: true, plan: { maxPowerW: 9000, intervalS: 5 }, endpoint: { type: 'mypv', host: '192.0.2.20' } }] };
  let capW = null;
  const reg = createMypvRegulator({
    getCfg: () => cfg, state, now: () => t,
    getCapW: (id) => (id === 'heizstab' ? capW : null),
    createClient: () => ({ read: async () => ({ powerW: 0, deviceOn: true }), writePower: async (w) => { writes.push(w); return w; }, close() {} })
  });
  for (let i = 0; i < 6; i += 1) { await reg.tick(); t += 5000; state.meter.updatedAt = t; }
  assert.ok(writes.at(-1) > 1000, 'fährt mit Überschuss hoch');
  capW = 500;
  await reg.tick();
  assert.equal(writes.at(-1), 500, 'gedeckelt auf die Netzanschluss-Grenze');
  assert.match(reg.getStatus().heizstab.reason, /Netzanschluss/);
  capW = 0;
  t += 5000; state.meter.updatedAt = t;
  await reg.tick();
  assert.equal(writes.at(-1), 0, 'aus');
});

// --- Codex P1: Sicherheits-Pause unabhängig vom Stopp-Modus ------------------

function bridgeFor({ type, stopMode, capW, override = null }) {
  const calls = [];
  const mk = (bc) => ({
    type, isConfigured: () => true,
    charge: async (a) => { calls.push(['charge', a, bc.stopMode]); return { ok: true }; },
    stop: async () => { calls.push(['stop', bc.stopMode]); return { ok: true }; },
    release: async () => { calls.push(['release']); return { ok: true }; },
    status: async () => ({ ok: true, connected: true, raw: { mode: 'now' } }),
  });
  const cfg = { optimizer: { eosOptimizeEv: true, evEvccControl: true, evMaxChargeW: 11000, evStopMode: stopMode }, wallbox: { type } };
  const t = Date.now();
  const bridge = createEosEvccBridge({
    getCfg: () => cfg,
    getSolution: async () => ({ slotMinutes: 15, rows: [{ ts_utc: new Date(Math.floor(t / 900000) * 900000).toISOString(), evChargeFactor: 1 }] }),
    getCharger: (_c, bc) => mk(bc),
    getGridCapW: () => capW,
    loadOverride: () => override,
    now: () => t,
  });
  return { bridge, calls };
}

test('Pause bei Grenze unter dem Mindeststrom: evcc wird auf „aus“ gestellt, auch bei Stopp-Modus „minpv“', async () => {
  const { bridge, calls } = bridgeFor({ type: 'evcc', stopMode: 'minpv', capW: 0 });
  await bridge.apply();
  assert.deepEqual(calls.at(-1), ['stop', 'off']);
});

test('Pause bei Grenze: direkte Wallbox wird gestoppt, nicht freigegeben (Stopp-Modus „pv“)', async () => {
  const { bridge, calls } = bridgeFor({ type: 'openevse', stopMode: 'pv', capW: 0 });
  await bridge.apply();
  assert.equal(calls.at(-1)[0], 'stop');
});

test('Pause bei Grenze während „Sofort laden“: evcc auf „aus“', async () => {
  const override = { kind: 'charge', powerW: 11000, startedAt: new Date().toISOString(), until: null, seenConnected: true };
  const { bridge, calls } = bridgeFor({ type: 'evcc', stopMode: 'minpv', capW: 0, override });
  await bridge.apply();
  assert.deepEqual(calls.at(-1), ['stop', 'off']);
});

test('Codex P1: „Sofort laden“ ohne EOS-Weitergabe zählt als steuerbare Wallbox', () => {
  const cfg = { gridConnection: { limitKw: 29 }, optimizer: { eosOptimizeEv: false, evEvccControl: false, evMaxChargeW: 11000 }, wallbox: { type: 'evcc' } };
  const state = { meter: { ok: true, updatedAt: Date.now(), grid_total_w: -32000 }, victron: {}, schedule: {}, ctrl: {} };
  let override = null;
  const ctx = {
    getCfg: () => cfg, state, pushLog: () => {},
    evccIntegration: { getStatus: () => ({ loadpoints: [{ chargePowerW: 11000 }] }) },
    eosEvccBridge: { apply: async () => ({}), getOverride: () => override },
  };
  const guard = createGridConnectionGuard(ctx);
  guard.tick();
  assert.equal(guard.capW('wallbox'), null, 'ohne Override steuert DVhub evcc nicht');
  override = { kind: 'charge', powerW: 11000 };
  guard.tick();
  assert.equal(guard.capW('wallbox'), 7000, '32 − 28 = 4 kW von der Wallbox');
});

test('Codex P2 (Runde 2): Pause während „Sofort laden“ behält den Override — beim Ende kehrt evcc in den alten Modus zurück', async () => {
  const override = { kind: 'charge', powerW: 11000, startedAt: new Date().toISOString(), until: null, seenConnected: true, prevMode: 'pv' };
  const calls = [];
  const mk = (bc) => ({
    type: 'evcc', isConfigured: () => true,
    charge: async (a) => { calls.push(['charge', a]); return { ok: true }; },
    stop: async () => { calls.push(['stop', bc.stopMode]); return { ok: true }; },
    release: async () => { calls.push(['release']); return { ok: true }; },
    status: async () => ({ ok: true, connected: true, raw: { mode: 'off' } }),
  });
  const cfg = { optimizer: { eosOptimizeEv: false, evEvccControl: false, evMaxChargeW: 11000, evStopMode: 'off' }, wallbox: { type: 'evcc' } };
  let capW = 0;
  const bridge = createEosEvccBridge({ getCfg: () => cfg, getSolution: async () => null, getCharger: (_c, bc) => mk(bc), getGridCapW: () => capW, loadOverride: () => override });
  await bridge.apply();
  assert.deepEqual(calls.at(-1), ['stop', 'off'], 'Pause');
  capW = null;
  await bridge.clearOverride();
  assert.deepEqual(calls.at(-1), ['stop', 'pv'], 'evcc zurück auf „pv“');
});

test('Codex P1 (Runde 3): „Sofort laden“ endet während der Pause — evcc bleibt aus, bis die Grenze es erlaubt', async () => {
  const override = { kind: 'charge', powerW: 11000, startedAt: new Date().toISOString(), until: null, seenConnected: true, prevMode: 'minpv' };
  const calls = [];
  const mk = (bc) => ({
    type: 'evcc', isConfigured: () => true,
    charge: async (a) => { calls.push(['charge', a]); return { ok: true }; },
    stop: async () => { calls.push(['stop', bc.stopMode]); return { ok: true }; },
    release: async () => { calls.push(['release']); return { ok: true }; },
    status: async () => ({ ok: true, connected: true, raw: { mode: 'off' } }),
  });
  const cfg = { optimizer: { eosOptimizeEv: false, evEvccControl: false, evMaxChargeW: 11000, evStopMode: 'off' }, wallbox: { type: 'evcc' } };
  let capW = 0;
  const bridge = createEosEvccBridge({ getCfg: () => cfg, getSolution: async () => null, getCharger: (_c, bc) => mk(bc), getGridCapW: () => capW, loadOverride: () => override });
  await bridge.apply();
  assert.deepEqual(calls.at(-1), ['stop', 'off']);
  await bridge.clearOverride();
  assert.equal(calls.some((c) => c[0] === 'stop' && c[1] === 'minpv'), false, 'nicht zurück auf minpv, solange die Grenze pausiert');
  await bridge.tick();
  assert.equal(calls.some((c) => c[1] === 'minpv'), false);
  capW = null;
  await bridge.tick();
  assert.deepEqual(calls.at(-1), ['stop', 'minpv'], 'Grenze weg: evcc zurück in den alten Modus');
});

function evccBridge({ override, enabled = false }) {
  const calls = [];
  const mk = (bc) => ({
    type: 'evcc', isConfigured: () => true,
    charge: async (a) => { calls.push(['charge', a]); return { ok: true }; },
    stop: async () => { calls.push(['stop', bc.stopMode]); return { ok: true }; },
    release: async () => { calls.push(['release']); return { ok: true }; },
    status: async () => ({ ok: true, connected: true, raw: { mode: 'now' } }),
  });
  const cfg = { optimizer: { eosOptimizeEv: enabled, evEvccControl: enabled, evMaxChargeW: 11000, evStopMode: 'off' }, wallbox: { type: 'evcc' } };
  const ref = { capW: 0, pro: true };
  const bridge = createEosEvccBridge({ getCfg: () => cfg, getSolution: async () => null, getCharger: (_c, bc) => mk(bc), getGridCapW: () => ref.capW, loadOverride: () => override, isProActive: () => ref.pro });
  return { bridge, calls, ref };
}

test('Codex P1 (Runde 4): Override läuft im selben Takt ab, in dem die Grenze kommt — evcc wird trotzdem hart gestoppt', async () => {
  const override = { kind: 'charge', powerW: 11000, startedAt: new Date(Date.now() - 3600_000).toISOString(), until: null, seenConnected: true, prevMode: 'minpv' };
  const { bridge, calls, ref } = evccBridge({ override });
  ref.capW = null;
  await bridge.apply();
  assert.deepEqual(calls.at(-1), ['charge', 16], 'Sofort laden läuft');
  // Override läuft ab, im selben Takt kommt die Grenze.
  override.until = new Date(Date.now() - 1000).toISOString();
  ref.capW = 0;
  await bridge.apply();
  assert.deepEqual(calls.at(-1), ['stop', 'off']);
  ref.capW = null;
  await bridge.tick();
  assert.deepEqual(calls.at(-1), ['stop', 'minpv']);
});

test('Codex P2 (Runde 4): ohne Pro übernimmt der Plan nicht — der vorgemerkte Modus bleibt und kommt zurück', async () => {
  const override = { kind: 'charge', powerW: 11000, startedAt: new Date().toISOString(), until: null, seenConnected: true, prevMode: 'pv' };
  const { bridge, calls, ref } = evccBridge({ override, enabled: true });
  await bridge.apply();
  assert.deepEqual(calls.at(-1), ['stop', 'off'], 'Pause während Sofort laden');
  ref.pro = false;
  await bridge.tick();
  assert.equal(calls.some((c) => c[1] === 'pv'), false);
  ref.capW = null;
  await bridge.tick();
  assert.deepEqual(calls.at(-1), ['stop', 'pv']);
});

test('Codex P2 (Runde 4): neues „Sofort laden“ während der vorgemerkten Rückkehr übernimmt den alten Modus, nicht „aus“', async () => {
  const override = { kind: 'charge', powerW: 11000, startedAt: new Date().toISOString(), until: null, seenConnected: true, prevMode: 'pv' };
  const { bridge, calls, ref } = evccBridge({ override });
  await bridge.apply();
  await bridge.clearOverride();
  await bridge.setOverride({ kind: 'charge', powerW: 11000 });
  assert.equal(bridge.getOverride().prevMode, 'pv');
  ref.capW = null;
  await bridge.clearOverride();
  assert.deepEqual(calls.at(-1), ['stop', 'pv']);
});
