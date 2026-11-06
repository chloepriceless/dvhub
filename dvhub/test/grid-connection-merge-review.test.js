// test/grid-connection-merge-review.test.js — Befunde der Gesamtprüfung des
// Merge-Commits 4bf1eb18 (release/1.0.10): Wechselwirkungen zwischen
// Netzanschluss-Deckel, EOS-Plan, Not-Halt und vorgemerkter evcc-Rückkehr.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createEosEvccBridge } from '../services/optimizer/eos-evcc-bridge.js';
import { createGridConnectionGuard, createGuardState, guardStep, resolveGridConnection, RELEASE_TICKS, HOLD_AFTER_CUT_MS } from '../services/grid-connection/index.js';
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


// --- Codex 8bf189b7: unquittierte Ladung und bestätigte Ziele -------------------

function evccMulti({ enabled = true, override = null } = {}) {
  const h = {};
  const modes = { 1: 'pv', 2: 'pv' };
  const fail = { 1: false, 2: false };   // Quittung bleibt aus
  const noEffect = { 1: false, 2: false }; // Befehl wirkt gar nicht
  const calls = [];
  const evcc = {
    getStatus: () => ({ url: 'http://evcc.local:7070' }),
    getLoadpoints: () => [1, 2].map((id) => ({ id, mode: modes[id], connected: true })),
    refresh: async () => { if (h.refreshFailOnce) { h.refreshFailOnce = false; return false; } return true; },
    setMaxCurrent: async (id, a) => { calls.push(['maxcurrent', id, a]); return { ok: true }; },
    setMode: async (id, m) => {
      calls.push(['mode', id, m]);
      if (!noEffect[id]) modes[id] = m;
      return fail[id] && m === 'now' ? { ok: false, error: 'timeout' } : { ok: true };
    },
  };
  const cfg = { evcc: { url: 'http://evcc.local:7070' }, wallbox: { type: 'evcc' }, optimizer: { eosOptimizeEv: enabled, evEvccControl: enabled, evEvccLoadpoint: 1, evMaxChargeW: 11000, evStopMode: 'pv' } };
  const t = Date.now();
  const ref = { paused: false, now: t };
  const store = { value: override };
  const bridge = createEosEvccBridge({
    getCfg: () => cfg,
    getSolution: async () => ({ slotMinutes: 15, rows: [{ ts_utc: new Date(Math.floor(t / 900000) * 900000).toISOString(), evChargeFactor: 1 }] }),
    getCharger: (_c, bc) => createEvccAdapter(evcc, () => bc.loadpoint, () => bc.stopMode),
    isPaused: () => ref.paused, now: () => ref.now,
    getGridCapW: () => h.capW ?? null,
    loadOverride: () => store.value,
    saveOverride: (ov) => { store.value = ov ? JSON.parse(JSON.stringify(ov)) : null; },
  });
  Object.assign(h, { bridge, modes, fail, noEffect, calls, cfg, ref, store, failStop: null, capW: null });
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

// --- Codex 009826e9 -----------------------------------------------------------------

function directBox({ type = 'openevse', stopMode = 'pv' } = {}) {
  const calls = [];
  const box = { claim: null };
  const ref = { fail: false, paused: false, factor: 0, enabled: true };
  const cfg = { optimizer: { eosOptimizeEv: true, evEvccControl: true, evMaxChargeW: 11000, evStopMode: stopMode }, wallbox: { type } };
  const t = Date.now();
  const bridge = createEosEvccBridge({
    getCfg: () => { cfg.optimizer.eosOptimizeEv = ref.enabled; cfg.optimizer.evEvccControl = ref.enabled; return cfg; },
    getSolution: async () => ({ slotMinutes: 15, rows: [{ ts_utc: new Date(Math.floor(t / 900000) * 900000).toISOString(), evChargeFactor: ref.factor }] }),
    getCharger: () => ({
      type, isConfigured: () => true,
      charge: async (a) => { calls.push(['charge', a]); box.claim = 'charge'; return ref.fail ? { ok: false, error: 'timeout' } : { ok: true }; },
      stop: async () => { calls.push(['stop']); box.claim = 'disabled'; return { ok: true }; },
      release: async () => { calls.push(['release']); box.claim = null; return { ok: true }; },
      status: async () => ({ ok: true, connected: true }),
    }),
    isPaused: () => ref.paused, now: () => t,
  });
  return { bridge, calls, box, ref };
}

test('Codex 009826e9 P2: nach dem Not-Halt gilt ein früherer Stopp-Befehl nicht als „unverändert“ — die Box wird wieder freigegeben', async () => {
  const h = directBox();
  await h.bridge.tick();                 // Plan: nicht laden → release (pv)
  assert.equal(h.calls.at(-1)[0], 'release');
  h.ref.factor = 1; h.ref.fail = true;
  await h.bridge.tick();                 // Ladung ohne Quittung
  h.ref.paused = true;
  await h.bridge.emergencyStop();
  assert.equal(h.box.claim, 'disabled');
  h.ref.paused = false; h.ref.fail = false; h.ref.factor = 0;
  await h.bridge.tick();
  assert.equal(h.calls.at(-1)[0], 'release', 'Not-Halt-Sperre wird wieder freigegeben');
});

test('Codex 009826e9 P2: release() einer direkten Box nimmt DVhubs Vorgabe weg — danach schickt der Not-Halt nichts', async () => {
  const h = directBox();
  h.ref.factor = 1;
  await h.bridge.tick();                 // bestätigt
  h.ref.factor = 0.5; h.ref.fail = true;
  await h.bridge.tick();                 // Aktualisierung ohne Quittung
  h.ref.enabled = false; h.ref.fail = false;
  await h.bridge.tick();                 // Weitergabe aus → release()
  assert.equal(h.calls.at(-1)[0], 'release');
  h.ref.paused = true;
  const n = h.calls.length;
  await h.bridge.emergencyStop();
  assert.equal(h.calls.length, n);
});

test('Codex 009826e9 P2: unquittiertes „Sofort laden“ läuft im Not-Halt ab — nach dem Aufheben kommt der alte evcc-Modus zurück', async () => {
  const h = evccMulti({ enabled: false });
  h.fail[1] = true;
  await h.bridge.setOverride({ kind: 'charge', powerW: 11000, untilMs: h.ref.now + 60_000 });
  h.fail[1] = false;
  h.ref.paused = true;
  await h.bridge.emergencyStop();
  assert.equal(h.modes[1], 'off');
  h.ref.now += 120_000;                  // läuft im Not-Halt ab …
  await h.bridge.tick();                 // … verarbeitet wird es erst nach dem Aufheben
  assert.ok(h.bridge.getOverride());
  h.ref.paused = false;
  await h.bridge.tick();
  assert.equal(h.bridge.getOverride(), null);
  assert.equal(h.modes[1], 'pv', 'evcc zurück auf „pv“');
});


// --- Gesamtprüfung des Zweigs, Runde 3 / Codex 7055aa8c --------------------------------

const SKI = 'a'.repeat(40);
const RG = resolveGridConnection({ gridConnection: { limitKw: 29 } });
const fresh = (importW) => ({ fresh: true, reason: null, importW, phasesW: null });
const wallbox = (currentW) => ({ id: 'wallbox', kind: 'wallbox', name: 'Wallbox', currentW, maxW: 11000, minW: 4140 });
function run(st, n, args, t0) { for (let i = 0; i < n; i += 1) guardStep(st, { resolved: RG, now: t0 + i * 2000, ...args }); }

test('Gesamtprüfung 3 P1: EEBUS-Wallbox zählt nur einmal (nicht als Wallbox UND als EEBUS-Gerät)', () => {
  const cfg = { gridConnection: { limitKw: 29 }, optimizer: { eosOptimizeEv: false, evEvccControl: false, evMaxChargeW: 11000 }, wallbox: { type: 'eebus', eebus: { ski: SKI } } };
  const state = { meter: { ok: true, updatedAt: Date.now(), grid_total_w: -39000 }, victron: {}, schedule: {}, ctrl: {} };
  const ctx = {
    getCfg: () => cfg, state, pushLog: () => {},
    chargerStatus: { fresh: () => ({ powerW: 8000 }) },
    eebus: { consumptionDevices: () => [{ id: `eebus:${SKI}`, ski: SKI, name: 'Wallbox', maxW: 11000, powerW: 8000 }] },
    eosEvccBridge: { apply: async () => ({ ok: true }), getOverride: () => null },
  };
  const guard = createGridConnectionGuard(ctx);
  guard.tick();
  const s = guard.summary();
  assert.deepEqual(s.caps.map((c) => c.id), ['wallbox'], 'nur einmal geführt');
  assert.equal(s.exhausted, true, '11 kW zu viel, nur 8 kW steuerbar → gemeldet');
});

test('Gesamtprüfung 3 P2: ohne Pro gibt die Brücke eine Grenz-Sperre wieder frei, wenn die Grenze weg ist', async () => {
  const calls = [];
  let capW = 0;
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
    getGridCapW: () => capW,
    isProActive: () => false,
  });
  await bridge.apply();
  assert.deepEqual(calls.at(-1), ['stop']);
  capW = null;
  await bridge.apply();
  assert.deepEqual(calls.at(-1), ['release']);
});


test('Codex 7055aa8c P2: gerundete Freigabe ohne Zuwachs verbraucht den Schritt nicht — die Wallbox kommt dran', () => {
  const st = createGuardState();
  st.caps = { wallbox: 0, 'heater:h1': 5000 };
  st.capAt = { wallbox: 0, 'heater:h1': 0 };
  // Luft 6 050 − 1 000 = 5 050 W: Heizstab 0 + 5 050 → gerundet 5 000 = alte Grenze.
  const big = { id: 'heater:h1', kind: 'heater', name: 'Heizstab', currentW: 0, maxW: 9000, minW: 0 };
  run(st, RELEASE_TICKS, { meas: fresh(21950), devices: [wallbox(0), big], battery: {} }, HOLD_AFTER_CUT_MS);
  assert.equal(st.caps.wallbox, 5000, 'Wallbox bekommt die Luft (≥ Mindestleistung)');
});

test('Codex 7055aa8c P2: erfolgreiche Freigabe (Weitergabe aus) wird nicht als Fehler gemeldet', async () => {
  const cfg = { gridConnection: { limitKw: 29 }, optimizer: { eosOptimizeEv: false, evEvccControl: false, evMaxChargeW: 11000 }, wallbox: { type: 'openevse', openevse: { url: 'http://192.0.2.5' } } };
  let t = 1_000_000;
  const state = { meter: { ok: true, updatedAt: t, grid_total_w: -4000 }, victron: {}, schedule: {}, ctrl: {} };
  const logs = [];
  const ctx = {
    getCfg: () => cfg, state, pushLog: (e, d) => logs.push([e, d]),
    chargerStatus: { fresh: () => ({ powerW: 0 }) },
    eosEvccBridge: { apply: async () => ({ ok: false, skipped: 'disabled' }), getOverride: () => null },
  };
  const guard = createGridConnectionGuard(ctx, { now: () => t });
  Object.assign(guard._state, { caps: { wallbox: 0 }, capAt: { wallbox: 0 }, lastCutAt: 0 });
  for (let i = 0; i < RELEASE_TICKS + 2; i += 1) { t += 2000 + (i === 0 ? 70_000 : 0); state.meter.updatedAt = t; guard.tick(); }
  await new Promise((r) => setImmediate(r));
  assert.equal(guard.capW('wallbox'), null, 'freigegeben');
  assert.equal(logs.some(([e]) => e === 'grid_connection_wallbox_failed'), false);
});

test('Codex 6e42ee3e P2: Grenze steht, die Brücke überspringt sie (z. B. EEBUS ohne LPC) → Warnung', async () => {
  const cfg = { gridConnection: { limitKw: 29 }, optimizer: { eosOptimizeEv: false, evEvccControl: false, evMaxChargeW: 11000 }, wallbox: { type: 'openevse', openevse: { url: 'http://192.0.2.5' } } };
  const state = { meter: { ok: true, updatedAt: Date.now(), grid_total_w: -33000 }, victron: {}, schedule: {}, ctrl: {} };
  const logs = [];
  const ctx = {
    getCfg: () => cfg, state, pushLog: (e, d) => logs.push([e, d]),
    chargerStatus: { fresh: () => ({ powerW: 11000 }) },
    eosEvccBridge: { apply: async () => ({ ok: false, skipped: 'openevse not configured' }), getOverride: () => null },
  };
  createGridConnectionGuard(ctx).tick();
  await new Promise((r) => setImmediate(r));
  assert.ok(logs.some(([e]) => e === 'grid_connection_wallbox_failed'));
});


// --- Codex bad876b1 -------------------------------------------------------------------

test('Codex bad876b1 P1: Ladepunkt mit gescheiterter Zustandsabfrage bleibt für den nächsten Not-Halt erhalten', async () => {
  const h = evccMulti();
  h.fail[1] = true;
  await h.bridge.tick();                 // LP1 unquittiert
  h.fail[1] = false;
  h.cfg.optimizer.evEvccLoadpoint = 2;
  await h.bridge.tick();                 // LP2 bestätigt
  h.ref.paused = true;
  h.refreshFailOnce = true;              // die erste Abfrage scheitert
  await h.bridge.emergencyStop();
  assert.equal([h.modes[1], h.modes[2]].filter((m) => m === 'off').length, 1, 'einer gestoppt, einer unbekannt');
  const r = await h.bridge.emergencyStop();
  assert.equal(r.stopped, true, JSON.stringify(r));
  assert.deepEqual([h.modes[1], h.modes[2]], ['off', 'off']);
});


// --- Gesamtprüfung des Zweigs, Runde 4 ------------------------------------------------

test('Gesamtprüfung 4 P1: zwei bestätigt ladende Ladepunkte — der Not-Halt stoppt beide', async () => {
  const h = evccMulti();
  await h.bridge.tick();                 // LP1 bestätigt
  h.cfg.optimizer.evEvccLoadpoint = 2;
  await h.bridge.tick();                 // LP2 bestätigt, LP1 bleibt in „now“
  assert.deepEqual([h.modes[1], h.modes[2]], ['now', 'now']);
  h.ref.paused = true;
  await h.bridge.emergencyStop();
  assert.deepEqual([h.modes[1], h.modes[2]], ['off', 'off']);
});

test('Gesamtprüfung 4 P2: Freigabe nach 30 s ZEIT, nicht nach Takten (1-s-Abfrage)', () => {
  const st = createGuardState();
  st.caps = { wallbox: 0 };
  st.capAt = { wallbox: 0 };
  const args = { meas: fresh(10000), devices: [wallbox(0)], battery: {} };
  const t0 = HOLD_AFTER_CUT_MS + 1000;
  for (let i = 0; i < 16; i += 1) guardStep(st, { resolved: RG, now: t0 + i * 1000, ...args });
  assert.equal(st.caps.wallbox, 0, 'nach 15 s noch nicht');
  for (let i = 16; i < 32; i += 1) guardStep(st, { resolved: RG, now: t0 + i * 1000, ...args });
  assert.equal(st.caps.wallbox, undefined, 'nach 31 s frei');
});

test('Codex 82e96f40 P2: behaltener „Sofort laden“-Merker gilt nach dem Not-Halt nicht als „unverändert“ — die direkte Box lädt wieder', async () => {
  const calls = [];
  let stopAckFails = false;
  let paused = false;
  const t = Date.now();
  const cfg = { optimizer: { eosOptimizeEv: true, evEvccControl: true, evEvccLoadpoint: 1, evMaxChargeW: 11000, evStopMode: 'pv' }, wallbox: { type: 'evcc' } };
  const bridge = createEosEvccBridge({
    getCfg: () => cfg,
    getSolution: async () => ({ slotMinutes: 15, rows: [{ ts_utc: new Date(Math.floor(t / 900000) * 900000).toISOString(), evChargeFactor: 1 }] }),
    getCharger: (_c, bc) => ({
      type: bc.charger, isConfigured: () => true,
      charge: async (a) => { calls.push(['charge', bc.charger, a]); return { ok: true }; },
      stop: async () => { calls.push(['stop', bc.charger]); return stopAckFails && bc.charger === 'openevse' ? { ok: false, error: 'timeout' } : { ok: true }; },
      release: async () => { calls.push(['release', bc.charger]); return { ok: true }; },
      status: async () => ({ ok: true, connected: true, raw: { mode: 'now' } }),
    }),
    isPaused: () => paused, now: () => t,
  });
  await bridge.tick();                                           // evcc:1 bestätigt
  cfg.wallbox.type = 'openevse';
  cfg.optimizer.eosOptimizeEv = false; cfg.optimizer.evEvccControl = false;
  await bridge.setOverride({ kind: 'charge', powerW: 11000 });   // openevse, Override
  paused = true; stopAckFails = true;
  await bridge.emergencyStop();                                  // evcc gestoppt, openevse-Stopp ohne Quittung
  paused = false; stopAckFails = false;
  await bridge.tick();
  assert.deepEqual(calls.at(-1).slice(0, 2), ['charge', 'openevse'], 'lädt nach dem Aufheben wieder');
});

// --- Codex 6bb9f304 / Gesamtprüfung des Zweigs, Runde 5 ----------------------------------

function directBridge({ type = 'openevse', enabled = false, store = { value: null }, ownedStore = { value: null }, capRef = { capW: null }, paused = { v: false } } = {}) {
  const h = { chargeFails: false };
  const calls = [];
  const cfg = { optimizer: { eosOptimizeEv: enabled, evEvccControl: enabled, evEvccLoadpoint: 1, evMaxChargeW: 11000, evStopMode: 'pv' }, wallbox: { type } };
  const make = () => createEosEvccBridge({
    getCfg: () => cfg, getSolution: async () => null,
    getCharger: (_c, bc) => ({
      type: bc.charger, isConfigured: () => true,
      charge: async (a) => { calls.push(['charge', bc.charger, a]); return h.chargeFails ? { ok: false, error: 'timeout' } : { ok: true }; },
      stop: async () => { calls.push(['stop', bc.charger, bc.stopMode]); return h.stopFails ? { ok: false, error: 'timeout' } : { ok: true }; },
      release: async () => { calls.push(['release', bc.charger]); return { ok: true }; },
      status: async () => ({ ok: true, connected: true, raw: { mode: 'now' } }),
    }),
    getGridCapW: () => capRef.capW,
    isPaused: () => paused.v,
    loadOverride: () => store.value,
    saveOverride: (ov) => { store.value = ov ? JSON.parse(JSON.stringify(ov)) : null; },
    loadOwned: () => ownedStore.value,
    saveOwned: (list) => { ownedStore.value = list ? JSON.parse(JSON.stringify(list)) : null; },
  });
  Object.assign(h, { make, calls, cfg, store, ownedStore, capRef, paused });
  h.bridge = make();
  return h;
}

test('Codex 6bb9f304 P2: direkte Box gilt unabhängig vom Ladepunkt als EIN Ziel — nach release() kein Not-Halt-Befehl', async () => {
  const h = directBridge();
  await h.bridge.setOverride({ kind: 'charge', powerW: 11000 });   // openevse, LP1
  h.cfg.optimizer.evEvccLoadpoint = 2;                              // Einstellung geändert …
  await h.bridge.clearOverride();                                   // … dann release()
  h.paused.v = true;
  const n = h.calls.length;
  await h.bridge.emergencyStop();
  assert.equal(h.calls.length, n);
});

test('Codex 6bb9f304/Runde 5 P2: frisch bestätigte Hand-Umstellung löscht DVhubs Anspruch — eine spätere Handladung bleibt unberührt', async () => {
  const h = evccMulti({ enabled: false });
  await h.bridge.setOverride({ kind: 'charge', powerW: 11000 });
  h.modes[1] = 'minpv';                  // von Hand umgestellt
  h.ref.paused = true;
  await h.bridge.emergencyStop();        // nichts, aber Anspruch weg
  h.modes[1] = 'now';                    // von Hand gestartet
  h.ref.paused = false;
  h.ref.paused = true;
  const n = h.calls.length;
  await h.bridge.emergencyStop();
  assert.equal(h.calls.length, n, 'Handladung nicht gestoppt');
  assert.equal(h.modes[1], 'now');
});

test('Runde 5 P2: Grenz-Sperre einer direkten Box übersteht einen Neustart und wird danach freigegeben', async () => {
  const ownedStore = { value: null };
  const capRef = { capW: 0 };
  const h = directBridge({ ownedStore, capRef });
  await h.bridge.apply();
  assert.deepEqual(h.calls.at(-1), ['stop', 'openevse', 'pv']);
  const fresh = h.make();               // Neustart
  capRef.capW = null;
  await fresh.tick();
  assert.deepEqual(h.calls.at(-1), ['release', 'openevse']);
});

test('Runde 5 P2: openWB — Grenze weg, dann bekommt die Box ihren vollen Strom zurück (release() tut dort nichts)', async () => {
  const capRef = { capW: 0 };
  const h = directBridge({ type: 'openwb', capRef });
  await h.bridge.apply();
  assert.equal(h.calls.at(-1)[0], 'stop');
  capRef.capW = null;
  await h.bridge.apply();
  assert.deepEqual(h.calls.at(-1), ['charge', 'openwb', 16]);
});


// --- Codex c45418be / Gesamtprüfung des Zweigs, Runde 6 ----------------------------------

test('Codex c45418be P1: evcc-Rückkehr wartet — die Grenze an der jetzt eingestellten direkten Box gilt trotzdem', async () => {
  const h = evccMulti({ enabled: false });
  await h.bridge.setOverride({ kind: 'charge', powerW: 11000 });
  h.ref.paused = true;
  await h.bridge.emergencyStop();
  await h.bridge.clearOverride();        // evcc LP1: Rückkehr vorgemerkt
  h.ref.paused = false;
  h.capW = 0;
  h.cfg.wallbox.type = 'openevse';
  h.cfg.wallbox.openevse = { url: 'http://192.0.2.5' };
  const directCalls = [];
  h.directCalls = directCalls;
  const r = await h.bridge.tick();
  assert.notEqual(r?.deferred, true, 'nicht vor der direkten Box stehen bleiben');
});

test('Runde 6 P1: einphasige Wallbox — Freigabe rechnet mit der Luft EINER Phase', () => {
  const RP = resolveGridConnection({ gridConnection: { limitKw: 29, phaseLimitA: 40 } }); // Phasenziel 8 867 W
  const st = createGuardState();
  st.caps = { wallbox: 0 };
  st.capAt = { wallbox: 0 };
  const wb1 = { id: 'wallbox', kind: 'wallbox', name: 'Wallbox', currentW: 0, maxW: 3680, minW: 1380, phases: 1 };
  for (let i = 0; i < 40; i += 1) {
    guardStep(st, { resolved: RP, now: HOLD_AFTER_CUT_MS + i * 2000, meas: { fresh: true, importW: 19000, phasesW: [7000, 6000, 6000] }, devices: [wb1], battery: {} });
  }
  // L1: 8 867 − 7 000 = 1 867 W Luft (− 333 W Rückschalt-Anteil bleibt außen vor) → höchstens ~1,8 kW, nicht 3,68 kW.
  assert.ok(st.caps.wallbox != null && st.caps.wallbox <= 1900, `Grenze ${st.caps.wallbox}`);
});

test('Runde 6 P1: Gerät ohne Leistungsmeldung wird bei Überlast trotzdem begrenzt', () => {
  const st = createGuardState();
  const dev = { id: 'eebus:x', kind: 'eebus', name: 'WP', currentW: null, maxW: 6000, minW: 0 };
  // 32 kW > 29 kW: sofort; angenommen 6 kW → Grenze 2 kW. Solange der Befehl
  // unterwegs ist, wird nicht weiter gekürzt.
  for (let i = 0; i < 3; i += 1) guardStep(st, { resolved: RG, now: i * 2000, meas: fresh(32000), devices: [dev], battery: {} });
  assert.equal(st.caps['eebus:x'], 2000);
  assert.equal(st.exhausted, false);
});

test('Runde 6 P2: dauerhafter Sollwert ohne Keepalive zählt weiter (aktiver Eintrag), Wallbox bleibt', () => {
  const t0 = 1_000_000;
  let t = t0;
  const cfg = { gridConnection: { limitKw: 29 }, optimizer: { eosOptimizeEv: true, evEvccControl: true, evMaxChargeW: 11000 }, wallbox: { type: 'evcc' } };
  const state = {
    meter: { ok: true, updatedAt: t, grid_total_w: -28050 },
    victron: { batteryChargeW: 8000, fieldUpdatedAt: { batteryPowerW: t } },
    schedule: { lastWrite: { gridSetpointW: { value: 28000, at: t0 - 200_000, source: 'rule:x' } }, active: { gridSetpointW: { value: 28000, at: t, skipped: true } } },
    ctrl: {}
  };
  const ctx = {
    getCfg: () => cfg, state, pushLog: () => {},
    evccIntegration: { getStatus: () => ({ loadpoints: [{ chargePowerW: 11000 }] }) },
    eosEvccBridge: { apply: async () => ({ ok: true }), getOverride: () => null },
  };
  const guard = createGridConnectionGuard(ctx, { now: () => t });
  for (let i = 0; i < 80; i += 1) {
    t += 2000;
    state.meter.updatedAt = t; state.victron.fieldUpdatedAt.batteryPowerW = t; state.schedule.active.gridSetpointW.at = t;
    guard.tick();
  }
  assert.equal(guard.capW('wallbox'), null);
});

test('Codex c45418be P2: Plan-Befehl ersetzt eine gespeicherte Grenz-Vorgabe — nach Neustart kein veralteter Freigabe-Befehl', async () => {
  const ownedStore = { value: null };
  const capRef = { capW: 0 };
  const h = directBridge({ type: 'openwb', ownedStore, capRef });
  await h.bridge.apply();                    // Grenz-Vorgabe
  assert.equal(ownedStore.value?.[0]?.gridCap, true);
  capRef.capW = null;
  h.cfg.optimizer.eosOptimizeEv = true; h.cfg.optimizer.evEvccControl = true;
  await h.bridge.apply();                    // Plan übernimmt
  assert.equal(ownedStore.value?.some((e) => e.gridCap), false, 'Grenz-Vermerk weg');
  const n = h.calls.length;
  h.cfg.optimizer.eosOptimizeEv = false; h.cfg.optimizer.evEvccControl = false;
  await h.make().tick();                     // Neustart
  assert.equal(h.calls.slice(n).some((c) => c[0] === 'charge'), false, 'kein Strom-Zurückgeben ohne Grenze');
});

// --- Gesamtprüfung des Zweigs, Runde 7 / Codex bf1c2c23 --------------------------------

test('Runde 7 P1: volle Freigabe erst, wenn die Leistung VOR dem Eingriff Platz hat (direkte Box > evMaxChargeW)', () => {
  const st = createGuardState();
  const box = (cur) => ({ id: 'wallbox', kind: 'wallbox', name: 'Wallbox', currentW: cur, maxW: 5000, minW: 4140, phases: 3 });
  guardStep(st, { resolved: RG, now: 0, meas: fresh(35000), devices: [box(11000)], battery: {} }); // hart: 11 kW → 4 kW < Mindest → 0
  assert.equal(st.caps.wallbox, 0);
  for (let i = 0; i < 40; i += 1) guardStep(st, { resolved: RG, now: HOLD_AFTER_CUT_MS + i * 2000, meas: fresh(21000), devices: [box(0)], battery: {} });
  // Luft 7 kW − 1 kW = 6 kW: genug für den Mindeststrom, nicht für 11 kW.
  assert.ok(st.caps.wallbox != null && st.caps.wallbox <= 6000, `Grenze ${st.caps.wallbox}`);
});

test('bcbfaff1 P1: Phasengrenze — Akku-Ladung zählt NICHT als Luft je Phase (einphasiger Multi möglich)', () => {
  const RP = resolveGridConnection({ gridConnection: { limitKw: 29, phaseLimitA: 40 } }); // Phasenziel 8 867 W
  const st = createGuardState();
  st.caps = { wallbox: 0 };
  st.capAt = { wallbox: 0 };
  const wb1 = { id: 'wallbox', kind: 'wallbox', name: 'Wallbox', currentW: 0, maxW: 3680, minW: 1380, phases: 1 };
  for (let i = 0; i < 40; i += 1) {
    guardStep(st, { resolved: RP, now: HOLD_AFTER_CUT_MS + i * 2000, meas: { fresh: true, importW: 16800, phasesW: [8800, 6000, 2000] }, devices: [wb1], battery: { setpointW: 16800, chargeW: 6000 } });
  }
  assert.equal(st.caps.wallbox, 0, 'L1 hat nur 67 W Luft — die Wallbox bleibt aus');
});

test('bf1c2c23 P1: Gerät ohne Leistungsmeldung — Grenze wächst nicht über die Luft hinaus', () => {
  const st = createGuardState();
  st.caps = { 'eebus:x': 2000 };
  st.capAt = { 'eebus:x': 0 };
  const dev = { id: 'eebus:x', kind: 'eebus', name: 'WP', currentW: null, maxW: 6000, minW: 0 };
  for (let i = 0; i < 200; i += 1) guardStep(st, { resolved: RG, now: HOLD_AFTER_CUT_MS + i * 2000, meas: fresh(25000), devices: [dev], battery: {} });
  assert.ok(st.caps['eebus:x'] != null && st.caps['eebus:x'] <= 2000, `Grenze ${st.caps['eebus:x']}`);
});

// --- Vereinfachte Zustandsführung (Koordinator, 06.11.2026): keine
// aufgeschobene evcc-Rückkehr mehr, stattdessen Hinweis ---------------------------

test('Vereinfacht: „Sofort laden“ endet im Not-Halt → kein Write, Hinweis mit altem Modus, KEINE automatische Rückkehr', async () => {
  const h = evccMulti({ enabled: false });
  await h.bridge.setOverride({ kind: 'charge', powerW: 11000 });
  h.ref.paused = true;
  await h.bridge.emergencyStop();
  const n = h.calls.length;
  await h.bridge.clearOverride();
  assert.equal(h.calls.length, n, 'im Not-Halt kein Write');
  const st = h.bridge.getStatus();
  assert.equal(st.restoreHint.mode, 'pv');
  assert.equal(st.restoreHint.reason, 'paused');
  assert.match(st.lastError, /„pv“/);
  h.ref.paused = false;
  await h.bridge.tick();
  assert.equal(h.modes[1], 'off', 'keine automatische Rückkehr');
});

test('Vereinfacht: „Sofort laden“ endet bei aktiver Grenze → evcc hart aus, Hinweis; keine Rückkehr, wenn die Grenze fällt', async () => {
  const h = evccMulti({ enabled: false });
  await h.bridge.setOverride({ kind: 'charge', powerW: 11000 });
  h.capW = 5000;
  await h.bridge.clearOverride();
  assert.equal(h.modes[1], 'off');
  assert.equal(h.bridge.getStatus().restoreHint.reason, 'grid_cap');
  h.capW = null;
  await h.bridge.tick();
  assert.equal(h.modes[1], 'off');
});

test('Vereinfacht: neues „Sofort laden“ am selben Ladepunkt übernimmt den Hinweis-Modus und stellt ihn beim Ende her', async () => {
  const h = evccMulti({ enabled: false });
  await h.bridge.setOverride({ kind: 'charge', powerW: 11000 });
  h.capW = 5000;
  await h.bridge.clearOverride();       // Hinweis: „pv“
  h.capW = null;
  await h.bridge.setOverride({ kind: 'charge', powerW: 11000 });
  assert.equal(h.bridge.getOverride().prevMode, 'pv');
  assert.equal(h.bridge.getStatus().restoreHint, null);
  await h.bridge.clearOverride();
  assert.equal(h.modes[1], 'pv');
});

test('Vereinfacht: Wächter schreibt eine Wallbox nur wegen eines Hinweises nicht ein', () => {
  const cfg = { gridConnection: { limitKw: 29 }, optimizer: { eosOptimizeEv: false, evEvccControl: false, evMaxChargeW: 11000 }, wallbox: { type: 'evcc' } };
  const state = { meter: { ok: true, updatedAt: Date.now(), grid_total_w: -33000 }, victron: {}, schedule: {}, ctrl: {} };
  const ctx = {
    getCfg: () => cfg, state, pushLog: () => {},
    evccIntegration: { getStatus: () => ({ loadpoints: [{ chargePowerW: 0 }] }) },
    eosEvccBridge: { apply: async () => ({ ok: true }), getOverride: () => null },
  };
  const guard = createGridConnectionGuard(ctx);
  guard.tick();
  assert.equal(guard.capW('wallbox'), null);
});

test('Vereinfacht (Prod-Fall): EOS-Weitergabe an, „Sofort laden“ endet im Not-Halt → kein Hinweis, nach dem Aufheben übernimmt der Plan', async () => {
  const h = evccMulti({ enabled: true });
  await h.bridge.setOverride({ kind: 'charge', powerW: 11000 });
  h.ref.paused = true;
  await h.bridge.emergencyStop();
  assert.equal(h.modes[1], 'off');
  await h.bridge.clearOverride();
  assert.equal(h.bridge.getStatus().restoreHint, null);
  h.ref.paused = false;
  await h.bridge.tick();
  assert.equal(h.modes[1], 'now', 'Plan lädt wieder');
});

// --- Abschlussrunde A (Gesamtprüfung) + Codex bcbfaff1 -------------------------------

test('Abschluss A P1: Wallbox-Abfrage ohne Leistungswert bleibt „unbekannt“ (nicht 0) — der Wächter begrenzt sie', async () => {
  const { createChargerStatusPoller } = await import('../services/wallbox/charger-status.js');
  const poller = createChargerStatusPoller({
    getCfg: () => ({ wallbox: { type: 'ocpp' } }),
    getAdapter: () => ({ isConfigured: () => true, status: async () => ({ ok: true, connected: true, charging: true, powerW: null }) }),
  });
  await poller.poll();
  assert.equal(poller.fresh().powerW, null);
});

test('Abschluss A P2: Entlade-Wächter — eine Netzanschluss-Decke auf „Akku halten“ ist kein Halten mehr', async () => {
  const { activeDischargeHold } = await import('../services/setpoint-follow-watchdog.js');
  const t = Date.now();
  const state = { ctrl: {
    eosGridHold: { at: t, known: true, valueW: 34000 },
    _gridConnection: { clamp: { source: 'eos_grid_hold', requestedW: 34000, valueW: 28000, at: t } },
  } };
  assert.equal(activeDischargeHold(state, t, {}), null);
});

test('bcbfaff1/fa219ab7 P1: Sicherheits-Stopp beim Override-Ende scheitert → „Laden stoppen“ hält evcc aus, das Laden lebt nicht wieder auf', async () => {
  const h = evccMulti({ enabled: false });
  await h.bridge.setOverride({ kind: 'charge', powerW: 11000 });
  h.capW = 6000;                         // Teil-Grenze
  h.failStop = 1;
  await h.bridge.clearOverride();
  assert.equal(h.bridge.getOverride()?.kind, 'stop', 'aus dem Laden wird ein Stopp');
  const charges = h.calls.filter((c) => c[0] === 'mode' && c[2] === 'now').length;
  h.failStop = null;
  await h.bridge.tick();
  assert.equal(h.modes[1], 'off');
  h.capW = null;
  await h.bridge.tick();
  assert.equal(h.calls.filter((c) => c[0] === 'mode' && c[2] === 'now').length, charges, 'kein erneutes Laden');
  assert.equal(h.modes[1], 'off');
});

test('bcbfaff1 P2: normaler Stopp nach einem Grenz-Stopp löscht den Grenz-Vermerk', async () => {
  const ownedStore = { value: null };
  const capRef = { capW: 0 };
  const h = directBridge({ type: 'openwb', ownedStore, capRef, enabled: true });
  await h.bridge.apply();                    // Plan-Stopp unter Grenze → hart
  assert.equal(ownedStore.value?.[0]?.gridCap, true);
  capRef.capW = null;
  await h.bridge.apply();                    // normaler Stopp (Plan)
  assert.equal(ownedStore.value?.some((e) => e.gridCap), false);
});

test('bcbfaff1 P2: unquittierte Grenz-Aktualisierung behält den Grenz-Vermerk', async () => {
  const ownedStore = { value: null };
  const capRef = { capW: 6000 };
  const h = directBridge({ ownedStore, capRef });
  await h.bridge.apply();                    // Grenz-Vorgabe (laden 8,6 A) quittiert
  assert.equal(ownedStore.value?.[0]?.gridCap, true);
  h.chargeFails = true;
  capRef.capW = 5000;
  await h.bridge.apply();                    // Aktualisierung ohne Quittung
  assert.equal(ownedStore.value?.[0]?.gridCap, true);
});

test('bcbfaff1 P2: direkte Box — unquittierte Ladung, Not-Halt, Ende im Not-Halt → nach dem Aufheben freigegeben', async () => {
  const ownedStore = { value: null };
  const paused = { v: false };
  const h = directBridge({ ownedStore, paused });
  h.chargeFails = true;
  await h.bridge.setOverride({ kind: 'charge', powerW: 11000 });
  paused.v = true;
  await h.bridge.emergencyStop();
  assert.equal(h.calls.at(-1)[0], 'stop');
  await h.bridge.clearOverride();
  paused.v = false;
  h.chargeFails = false;
  await h.bridge.tick();
  assert.deepEqual(h.calls.at(-1), ['release', 'openevse']);
});

// --- Abschlussrunde B + Codex fa219ab7 ---------------------------------------------

test('fa219ab7 P2: quittiertes „Sofort laden“ ohne Grenze löscht den Grenz-Vermerk', async () => {
  const ownedStore = { value: null };
  const capRef = { capW: 0 };
  const h = directBridge({ type: 'openwb', ownedStore, capRef });
  await h.bridge.apply();
  assert.equal(ownedStore.value?.[0]?.gridCap, true);
  capRef.capW = null;
  await h.bridge.setOverride({ kind: 'charge', powerW: 11000 });
  assert.equal(ownedStore.value?.[0]?.gridCap, false);
});

test('Abschluss B P2: Plan-Sicherheitsstopp an openWB — beim Freigeben kommt der volle Strom zurück', async () => {
  const capRef = { capW: 0 };
  const h = directBridge({ type: 'openwb', capRef, enabled: true });
  await h.bridge.apply();                    // Plan-Stopp unter Grenze
  assert.equal(h.calls.at(-1)[0], 'stop');
  capRef.capW = null;
  h.cfg.optimizer.eosOptimizeEv = false; h.cfg.optimizer.evEvccControl = false;
  await h.bridge.apply();                    // Weitergabe aus → freigeben
  assert.deepEqual(h.calls.at(-1), ['charge', 'openwb', 16]);
});

test('Abschluss B P1: direkte Box ohne EOS-Weitergabe — volle Freigabe erst bei Luft für ihre Nennleistung (32 A)', () => {
  const cfg = { gridConnection: { limitKw: 29 }, optimizer: { eosOptimizeEv: false, evEvccControl: false, evMaxChargeW: 11000 }, wallbox: { type: 'openevse', openevse: { url: 'http://192.0.2.5' } } };
  let t = 1_000_000;
  let powerW = 11000;
  const state = { meter: { ok: true, updatedAt: t, grid_total_w: -33000 }, victron: {}, schedule: {}, ctrl: {} };
  const ctx = { getCfg: () => cfg, state, pushLog: () => {}, chargerStatus: { fresh: () => ({ powerW }) }, eosEvccBridge: { apply: async () => ({ ok: true }), getOverride: () => null } };
  const guard = createGridConnectionGuard(ctx, { now: () => t });
  guard.tick();                              // 33 kW → Wallbox gekürzt
  assert.ok(guard.capW('wallbox') != null);
  powerW = 0;
  state.meter.grid_total_w = -15000;         // 13 kW Luft — reicht für 11 kW, nicht für 22 kW
  for (let i = 0; i < 60; i += 1) { t += 2000; state.meter.updatedAt = t; guard.tick(); }
  assert.ok(guard.capW('wallbox') != null, 'bleibt begrenzt');
});

test('Codex 9d293571 P1: openWB — „Sofort laden“ endet bei aktiver Teil-Grenze → kein voller Strom, die Grenze gilt weiter', async () => {
  const capRef = { capW: 6000 };
  const h = directBridge({ type: 'openwb', capRef });
  await h.bridge.setOverride({ kind: 'charge', powerW: 11000 });   // gedeckelt
  await h.bridge.clearOverride();
  assert.equal(h.calls.some((c) => c[0] === 'charge' && c[2] === 16), false, 'kein voller Strom unter der Grenze');
  assert.deepEqual(h.calls.at(-1), ['charge', 'openwb', 8.6]);
});

test('Codex f42f6217 P2: openWB — gehaltene Freigabe macht den alten Befehl ungültig, die Grenz-Vorgabe kommt wieder an', async () => {
  const capRef = { capW: 6000 };
  const h = directBridge({ type: 'openwb', capRef });
  await h.bridge.apply();                                   // Grenz-Vorgabe 8,6 A
  assert.deepEqual(h.calls.at(-1), ['charge', 'openwb', 8.6]);
  h.stopFails = true;
  await h.bridge.setOverride({ kind: 'stop' });             // kommt an, Quittung fehlt
  h.stopFails = false;
  await h.bridge.clearOverride();
  await h.bridge.tick();
  assert.deepEqual(h.calls.at(-1), ['charge', 'openwb', 8.6], 'Grenz-Vorgabe neu geschickt');
});

// --- Punkt 5: Akku-Netzladung je Phase als Luft (Einstellung batteryPhases) ---------------

test('Punkt 5: dreiphasiger Multi — Akku-Ladung zählt gleichverteilt je Phase, die Wallbox kommt zurück', () => {
  const RP = resolveGridConnection({ gridConnection: { limitKw: 29, phaseLimitA: 40, batteryPhases: 'three' } });
  assert.equal(RP.batteryPhases, 'three');
  const st = createGuardState();
  st.caps = { wallbox: 0 };
  st.capAt = { wallbox: 0 };
  const wb3 = { id: 'wallbox', kind: 'wallbox', name: 'Wallbox', currentW: 0, maxW: 11000, minW: 4140, phases: 3 };
  for (let i = 0; i < 40; i += 1) {
    guardStep(st, { resolved: RP, now: HOLD_AFTER_CUT_MS + i * 2000, meas: { fresh: true, importW: 26400, phasesW: [8800, 8800, 8800] }, devices: [wb3], battery: { setpointW: 26400, chargeW: 24000 } });
  }
  assert.equal(st.caps.wallbox, undefined, 'freigegeben');
});

test('Punkt 5: einphasiger Multi auf L2 — Luft nur auf L2, eine einphasige Wallbox (Phase unbekannt) bleibt aus', () => {
  const RP = resolveGridConnection({ gridConnection: { limitKw: 29, phaseLimitA: 40, batteryPhases: 'L2' } });
  const st = createGuardState();
  st.caps = { wallbox: 0 };
  st.capAt = { wallbox: 0 };
  const wb1 = { id: 'wallbox', kind: 'wallbox', name: 'Wallbox', currentW: 0, maxW: 3680, minW: 1380, phases: 1 };
  for (let i = 0; i < 40; i += 1) {
    guardStep(st, { resolved: RP, now: HOLD_AFTER_CUT_MS + i * 2000, meas: { fresh: true, importW: 16800, phasesW: [8800, 6000, 2000] }, devices: [wb1], battery: { setpointW: 16800, chargeW: 6000 } });
  }
  assert.equal(st.caps.wallbox, 0);
});

test('Punkt 5: Einstellung „Akku-Phasen“ unter Netz & Recht, Standard unbekannt (keine Gutschrift)', async () => {
  const { getConfigDefinition, createDefaultConfig } = await import('../config-model.js');
  const f = getConfigDefinition().fields.find((x) => x.path === 'gridConnection.batteryPhases');
  assert.ok(f && f.type === 'select');
  assert.equal(createDefaultConfig().gridConnection.batteryPhases, '');
  assert.equal(resolveGridConnection({ gridConnection: { limitKw: 29 } }).batteryPhases, null);
});
