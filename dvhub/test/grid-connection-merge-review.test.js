// test/grid-connection-merge-review.test.js — Befunde der Gesamtprüfung des
// Merge-Commits 4bf1eb18 (release/1.0.10): Wechselwirkungen zwischen
// Netzanschluss-Deckel, EOS-Plan, Not-Halt und vorgemerkter evcc-Rückkehr.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createEosEvccBridge } from '../services/optimizer/eos-evcc-bridge.js';
import { createGridConnectionGuard } from '../services/grid-connection/index.js';
import { createEvccAdapter } from '../services/wallbox/adapters.js';

function bridgeHarness({ type = 'evcc', stopMode = 'minpv', plan = 1, enabled = true, capW = null, override = null, chargeFails = false } = {}) {
  const calls = [];
  const box = { mode: 'pv' };
  const ref = { capW, paused: false, chargeFails, plan };
  const mk = (bc) => ({
    type, isConfigured: () => true,
    charge: async (a) => {
      calls.push(['charge', a, bc.loadpoint]);
      box.mode = 'now'; // kommt an …
      return ref.chargeFails ? { ok: false, error: 'timeout' } : { ok: true }; // … Quittung evtl. nicht
    },
    stop: async () => { calls.push(['stop', type === 'evcc' ? bc.stopMode : null, bc.loadpoint]); box.mode = type === 'evcc' ? bc.stopMode : 'stopped'; return { ok: true }; },
    release: async () => { calls.push(['release']); return { ok: true }; },
    status: async () => ({ ok: true, connected: true, raw: { mode: box.mode } }),
  });
  const cfg = { optimizer: { eosOptimizeEv: enabled, evEvccControl: enabled, evEvccLoadpoint: 1, evMaxChargeW: 11000, evStopMode: stopMode }, wallbox: { type } };
  const t = Date.now();
  const store = { value: override };
  const bridge = createEosEvccBridge({
    getCfg: () => cfg,
    getSolution: async () => ({ slotMinutes: 15, rows: [{ ts_utc: new Date(Math.floor(t / 900000) * 900000).toISOString(), evChargeFactor: ref.plan }] }),
    getCharger: (_c, bc) => mk(bc),
    getGridCapW: () => ref.capW,
    isPaused: () => ref.paused,
    loadOverride: () => store.value,
    saveOverride: (ov) => { store.value = ov ? JSON.parse(JSON.stringify(ov)) : null; },
    now: () => t,
  });
  return { bridge, calls, box, ref, cfg, store };
}

test('P1: EOS plant „nicht laden“, Deckel 0 → evcc hart „aus“, nicht der Stopp-Modus „minpv“', async () => {
  const h = bridgeHarness({ plan: 0, capW: 0, stopMode: 'minpv' });
  await h.bridge.tick();
  assert.deepEqual(h.calls.at(-1).slice(0, 2), ['stop', 'off']);
});

test('P1: EOS plant „nicht laden“, Deckel 0, direkte Box mit Stopp-Modus „pv“ → stop(), nicht release()', async () => {
  const h = bridgeHarness({ type: 'openevse', plan: 0, capW: 0, stopMode: 'pv' });
  await h.bridge.tick();
  assert.equal(h.calls.at(-1)[0], 'stop');
});

test('P1: ohne Deckel bleibt der Stopp-Modus des Plans („minpv“)', async () => {
  const h = bridgeHarness({ plan: 0, capW: null, stopMode: 'minpv' });
  await h.bridge.tick();
  assert.deepEqual(h.calls.at(-1).slice(0, 2), ['stop', 'minpv']);
});

test('P1: Wallbox mit ausstehender Rückkehr bleibt im Wächter eingeschrieben', () => {
  const cfg = { gridConnection: { limitKw: 29 }, optimizer: { eosOptimizeEv: false, evEvccControl: false, evMaxChargeW: 11000 }, wallbox: { type: 'evcc' } };
  const state = { meter: { ok: true, updatedAt: Date.now(), grid_total_w: -33000 }, victron: {}, schedule: {}, ctrl: {} };
  const ctx = {
    getCfg: () => cfg, state, pushLog: () => {},
    evccIntegration: { getStatus: () => ({ loadpoints: [{ chargePowerW: 11000 }] }) },
    eosEvccBridge: { apply: async () => ({}), getOverride: () => null, hasPendingRestore: () => true },
  };
  const guard = createGridConnectionGuard(ctx);
  guard.tick();
  assert.equal(guard.capW('wallbox'), 6000, 'Deckel bleibt (33 − 28 = 5 kW weniger)');
});

test('P1: Ladebefehl kam an, Quittung im Timeout → Not-Halt prüft frisch und stoppt', async () => {
  const h = bridgeHarness({ chargeFails: true, stopMode: 'pv' });
  await h.bridge.tick();
  assert.equal(h.box.mode, 'now', 'Befehl wirkte');
  h.ref.paused = true;
  const r = await h.bridge.emergencyStop();
  assert.equal(r.stopped, true, JSON.stringify(r));
  assert.deepEqual(h.calls.at(-1).slice(0, 2), ['stop', 'off']);
});

test('P1: unquittierter Ladebefehl, evcc inzwischen von Hand umgestellt → kein Befehl', async () => {
  const h = bridgeHarness({ chargeFails: true, stopMode: 'pv' });
  await h.bridge.tick();
  h.box.mode = 'minpv';
  h.ref.paused = true;
  const n = h.calls.length;
  const r = await h.bridge.emergencyStop();
  assert.equal(r.skipped, 'not_dvhub_state');
  assert.equal(h.calls.length, n);
});

test('P2: vorgemerkte Rückkehr gilt dem ursprünglichen Ladepunkt, auch nach Umstellen und Neustart', async () => {
  const override = { kind: 'charge', powerW: 11000, startedAt: new Date().toISOString(), until: null, seenConnected: true, prevMode: 'pv' };
  const h = bridgeHarness({ enabled: false, override });
  await h.bridge.apply();
  assert.equal(h.calls.at(-1)[2], 1, 'lädt an Ladepunkt 1');
  h.ref.paused = true;
  await h.bridge.emergencyStop();
  await h.bridge.clearOverride();
  assert.equal(h.store.value.loadpoint, 1, 'Ladepunkt mitgespeichert');
  h.cfg.optimizer.evEvccLoadpoint = 2;
  h.ref.paused = false;
  await h.bridge.tick();
  assert.deepEqual(h.calls.at(-1), ['stop', 'pv', 1], '„pv“ zurück an Ladepunkt 1, nicht 2');
});

// --- Codex 8bf189b7: unquittierte Ladung und bestätigte Ziele -------------------

function evccMulti({ enabled = true, override = null } = {}) {
  const modes = { 1: 'pv', 2: 'pv' };
  const fail = { 1: false, 2: false };   // Quittung bleibt aus
  const noEffect = { 1: false, 2: false }; // Befehl wirkt gar nicht
  const calls = [];
  const evcc = {
    getStatus: () => ({ url: 'http://evcc.local:7070' }),
    getLoadpoints: () => [1, 2].map((id) => ({ id, mode: modes[id], connected: true })),
    refresh: async () => true,
    setMaxCurrent: async (id, a) => { calls.push(['maxcurrent', id, a]); return { ok: true }; },
    setMode: async (id, m) => {
      calls.push(['mode', id, m]);
      if (!noEffect[id]) modes[id] = m;
      return fail[id] && m === 'now' ? { ok: false, error: 'timeout' } : { ok: true };
    },
  };
  const cfg = { evcc: { url: 'http://evcc.local:7070' }, wallbox: { type: 'evcc' }, optimizer: { eosOptimizeEv: enabled, evEvccControl: enabled, evEvccLoadpoint: 1, evMaxChargeW: 11000, evStopMode: 'pv' } };
  const ref = { paused: false };
  const t = Date.now();
  const store = { value: override };
  const bridge = createEosEvccBridge({
    getCfg: () => cfg,
    getSolution: async () => ({ slotMinutes: 15, rows: [{ ts_utc: new Date(Math.floor(t / 900000) * 900000).toISOString(), evChargeFactor: 1 }] }),
    getCharger: (_c, bc) => createEvccAdapter(evcc, () => bc.loadpoint, () => bc.stopMode),
    isPaused: () => ref.paused, now: () => t,
    loadOverride: () => store.value,
    saveOverride: (ov) => { store.value = ov ? JSON.parse(JSON.stringify(ov)) : null; },
  });
  return { bridge, modes, fail, noEffect, calls, cfg, ref };
}

test('Codex 8bf189b7 P1: bestätigt ladender Ladepunkt 1 wird gestoppt, auch wenn danach ein Versuch an Ladepunkt 2 ohne Wirkung scheiterte', async () => {
  const h = evccMulti();
  await h.bridge.tick();
  assert.equal(h.modes[1], 'now');
  h.cfg.optimizer.evEvccLoadpoint = 2;
  h.fail[2] = true; h.noEffect[2] = true;
  await h.bridge.tick();
  assert.equal(h.modes[2], 'pv', 'Versuch an 2 ohne Wirkung');
  h.ref.paused = true;
  await h.bridge.emergencyStop();
  assert.equal(h.modes[1], 'off', 'Ladepunkt 1 aus');
  assert.equal(h.modes[2], 'pv', 'Ladepunkt 2 unberührt');
});

test('Codex 8bf189b7 P2: unquittierte Ladung, danach bestätigter Stopp, dann Handladung → Not-Halt schickt nichts', async () => {
  const h = evccMulti({ enabled: false });
  h.fail[1] = true;
  await h.bridge.setOverride({ kind: 'charge', powerW: 11000 });
  assert.equal(h.modes[1], 'now', 'Befehl wirkte ohne Quittung');
  h.fail[1] = false;
  await h.bridge.setOverride({ kind: 'stop' });
  assert.equal(h.modes[1], 'off', 'bestätigter Stopp');
  await h.bridge.clearOverride();
  h.modes[1] = 'now'; // Handladung in der evcc-App
  h.ref.paused = true;
  const n = h.calls.length;
  await h.bridge.emergencyStop();
  assert.equal(h.calls.length, n, 'kein Befehl');
  assert.equal(h.modes[1], 'now');
});

test('Codex 8bf189b7 P2: erstes „Sofort laden“ ohne Quittung, Not-Halt stoppt — Ende im Not-Halt stellt danach den alten Modus her', async () => {
  const h = evccMulti({ enabled: false });
  h.fail[1] = true;
  await h.bridge.setOverride({ kind: 'charge', powerW: 11000 });
  assert.equal(h.modes[1], 'now');
  h.ref.paused = true;
  await h.bridge.emergencyStop();
  assert.equal(h.modes[1], 'off');
  await h.bridge.clearOverride();
  h.ref.paused = false;
  h.fail[1] = false;
  await h.bridge.tick();
  assert.equal(h.modes[1], 'pv', 'evcc zurück auf „pv“');
});

test('Gesamtprüfung P1: Teil-Freigabe (0 → 5 kW) stellt den evcc-Modus noch nicht her — erst ohne Deckel', async () => {
  const override = { kind: 'charge', powerW: 11000, startedAt: new Date().toISOString(), until: null, seenConnected: true, prevMode: 'pv' };
  const h = bridgeHarness({ enabled: false, override, capW: 0 });
  await h.bridge.apply();
  await h.bridge.clearOverride();
  assert.equal(h.bridge.hasPendingRestore(), true);
  h.ref.capW = 5000; // Teil-Freigabe durch den Wächter
  await h.bridge.tick();
  assert.equal(h.calls.some((c) => c[0] === 'stop' && c[1] === 'pv'), false, 'noch nicht zurück auf „pv“');
  assert.equal(h.bridge.hasPendingRestore(), true, 'Wallbox bleibt eingeschrieben');
  h.ref.capW = null;
  await h.bridge.tick();
  assert.deepEqual(h.calls.at(-1).slice(0, 2), ['stop', 'pv']);
});
