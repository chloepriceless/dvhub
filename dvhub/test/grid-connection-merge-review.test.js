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
  const h = { bridge, modes, fail, noEffect, calls, cfg, ref, store, failStop: null };
  const origSetMode = evcc.setMode;
  evcc.setMode = async (id, m) => (m === 'off' && h.failStop === id ? { ok: false, error: 'timeout' } : origSetMode(id, m));
  return h;
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

// --- Codex 180dbd00 ------------------------------------------------------------------

test('Codex 180dbd00 P1: release() ohne Wirkung (openWB) bestätigt keinen Stopp — Not-Halt stoppt die unquittierte Ladung', async () => {
  const calls = [];
  const box = { charging: false };
  let fail = false;
  let paused = false;
  const cfg = { optimizer: { eosOptimizeEv: true, evEvccControl: true, evMaxChargeW: 11000, evStopMode: 'pv' }, wallbox: { type: 'openwb' } };
  const t = Date.now();
  let factor = 1;
  const bridge = createEosEvccBridge({
    getCfg: () => cfg,
    getSolution: async () => ({ slotMinutes: 15, rows: [{ ts_utc: new Date(Math.floor(t / 900000) * 900000).toISOString(), evChargeFactor: factor }] }),
    getCharger: () => ({
      type: 'openwb', isConfigured: () => true,
      charge: async (a) => { calls.push(['charge', a]); box.charging = true; return fail ? { ok: false, error: 'timeout' } : { ok: true }; },
      stop: async () => { calls.push(['stop']); box.charging = false; return { ok: true }; },
      release: async () => { calls.push(['release']); return { ok: true }; }, // lässt den Strom stehen
      status: async () => ({ ok: true, connected: true }),
    }),
    isPaused: () => paused, now: () => t,
  });
  await bridge.tick();
  fail = true; factor = 0.5;
  await bridge.tick(); // unquittiert
  cfg.optimizer.eosOptimizeEv = false; // Weitergabe aus → release()
  fail = false;
  await bridge.tick();
  assert.equal(calls.at(-1)[0], 'release');
  paused = true;
  const r = await bridge.emergencyStop();
  assert.equal(r.stopped, true, JSON.stringify(r));
  assert.equal(calls.at(-1)[0], 'stop');
});

test('Codex 180dbd00 P1: scheitert der Stopp am bestätigten Ladepunkt, bleibt er für den nächsten Not-Halt erhalten', async () => {
  const h = evccMulti();
  h.fail[1] = true;
  await h.bridge.tick();                // LP1: unquittiert, wirkt
  h.fail[1] = false;
  h.cfg.optimizer.evEvccLoadpoint = 2;
  await h.bridge.tick();                // LP2: bestätigt
  assert.deepEqual([h.modes[1], h.modes[2]], ['now', 'now']);
  h.ref.paused = true;
  h.noEffect[2] = true; h.failStop = 2;
  await h.bridge.emergencyStop();
  assert.equal(h.modes[1], 'off');
  assert.equal(h.modes[2], 'now', 'Stopp an LP2 gescheitert');
  h.noEffect[2] = false; h.failStop = null;
  h.ref.paused = false;
  h.ref.paused = true;                  // erneuter Not-Halt vor dem nächsten Takt
  const r = await h.bridge.emergencyStop();
  assert.equal(r.stopped, true, JSON.stringify(r));
  assert.equal(h.modes[2], 'off');
});

test('Codex 180dbd00 P2: vorgemerkte Rückkehr gehört zum Ladepunkt des „Sofort laden“, nicht zum ersten gestoppten', async () => {
  const h = evccMulti({ enabled: true });
  await h.bridge.tick();                // EOS lädt LP1, bestätigt
  h.cfg.optimizer.evEvccLoadpoint = 2;
  h.cfg.optimizer.eosOptimizeEv = false; h.cfg.optimizer.evEvccControl = false;
  h.fail[2] = true;
  await h.bridge.setOverride({ kind: 'charge', powerW: 11000 }); // LP2 unquittiert
  h.ref.paused = true;
  await h.bridge.emergencyStop();
  assert.deepEqual([h.modes[1], h.modes[2]], ['off', 'off']);
  await h.bridge.clearOverride();
  assert.equal(h.store.value?.kind, 'restore');
  assert.equal(h.store.value.loadpoint, 2);
  assert.equal(h.store.value.mode, 'pv');
});

// --- Gesamtprüfung des Zweigs, Runde 2 ------------------------------------------------

test('Gesamtprüfung 2 P1: Stopp-Slot mit Teil-Deckel → hart „aus“, nicht „minpv“ (evcc hielte die Grenze nicht ein)', async () => {
  const h = bridgeHarness({ plan: 0, capW: 5000, stopMode: 'minpv' });
  await h.bridge.tick();
  assert.deepEqual(h.calls.at(-1).slice(0, 2), ['stop', 'off']);
});

test('Gesamtprüfung 2 P1: direkte Wallbox, EOS-Steuerung an, Pro aus → Deckel wird trotzdem durchgesetzt', async () => {
  const calls = [];
  const cfg = { optimizer: { eosOptimizeEv: true, evEvccControl: true, evMaxChargeW: 11000, evStopMode: 'pv' }, wallbox: { type: 'openevse' } };
  const bridge = createEosEvccBridge({
    getCfg: () => cfg, getSolution: async () => null,
    getCharger: () => ({
      type: 'openevse', isConfigured: () => true,
      charge: async (a) => { calls.push(['charge', a]); return { ok: true }; },
      stop: async () => { calls.push(['stop']); return { ok: true }; },
      release: async () => { calls.push(['release']); return { ok: true }; },
      status: async () => ({ ok: true, connected: true }),
    }),
    getGridCapW: () => 6000,
    isProActive: () => false,
  });
  const r = await bridge.apply();
  assert.deepEqual(calls.at(-1), ['charge', 8.6], JSON.stringify(r));
});

test('Gesamtprüfung 2 P1: scheitert die Wallbox-Grenze, meldet der Wächter das', async () => {
  const cfg = { gridConnection: { limitKw: 29 }, optimizer: { eosOptimizeEv: true, evEvccControl: true, evMaxChargeW: 11000 }, wallbox: { type: 'evcc' } };
  const state = { meter: { ok: true, updatedAt: Date.now(), grid_total_w: -33000 }, victron: {}, schedule: {}, ctrl: {} };
  const logs = [];
  const ctx = {
    getCfg: () => cfg, state, pushLog: (e, d) => logs.push([e, d]),
    evccIntegration: { getStatus: () => ({ loadpoints: [{ chargePowerW: 11000 }] }) },
    eosEvccBridge: { apply: async () => ({ ok: false, error: 'evcc nicht erreichbar' }), getOverride: () => null },
  };
  createGridConnectionGuard(ctx).tick();
  await new Promise((r) => setImmediate(r));
  assert.ok(logs.some(([e]) => e === 'grid_connection_wallbox_failed'));
});
