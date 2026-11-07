// test/grid-connection-wallbox-always.test.js — EINE Regel statt Sonderfälle
// (Christin 07.11.2026): „beim Peak Shaving steuert der Akku noch zu und erst
// wenn er nicht mehr kann, muss was abgeschaltet werden“ und „wir müssen mit
// unserem Steuer-Loop immer sicherstellen, dass die kW Netzanschluss nie
// überschritten werden“.
//
// Solange eine Netzanschluss-Grenze gilt (und kein Not-Halt), überwacht der
// Wächter die Wallbox IMMER — auch ohne EOS-Weitergabe, auch wenn evcc im
// eigenen Modus lädt, auch bei Handstart, und jeden ladenden evcc-Ladepunkt.
// Zuerst der Akku, dann Ladestrom (evcc maxcurrent bzw. Box-Strom), unter dem
// Mindeststrom Pause.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGridConnectionGuard, createGuardState, guardStep, resolveGridConnection,
  OBEY_MS, REASSERT_MS
} from '../services/grid-connection/index.js';
import { createEosEvccBridge } from '../services/optimizer/eos-evcc-bridge.js';
import { createEvccAdapter } from '../services/wallbox/adapters.js';

const R = resolveGridConnection({ gridConnection: { limitKw: 29 } }); // Ziel 28 000 W

// ── Wächter ────────────────────────────────────────────────────────────────

function guardFor({ loadpoints, importW, evEnabled = false, override = null, pendingRestore = false }) {
  const t = Date.now();
  const cfg = {
    gridConnection: { limitKw: 29 },
    evcc: { url: 'http://evcc.local:7070' },
    wallbox: { type: 'evcc' },
    optimizer: { eosOptimizeEv: evEnabled, evEvccControl: evEnabled, evEvccLoadpoint: 1, evMaxChargeW: 11000 }
  };
  const state = { meter: { ok: true, updatedAt: t, grid_total_w: -importW }, victron: {}, schedule: {}, ctrl: {} };
  const applied = [];
  const ctx = {
    getCfg: () => cfg, state, pushLog: () => {},
    evccIntegration: { getStatus: () => ({ url: cfg.evcc.url, lastPolledAt: t, lastError: null, loadpoints }) },
    eosEvccBridge: { apply: async () => { applied.push(1); return {}; }, getOverride: () => override, hasPendingRestore: () => pendingRestore },
  };
  return { guard: createGridConnectionGuard(ctx), applied, state };
}

const lp = (id, chargePowerW, extra = {}) => ({ id, mode: 'pv', charging: chargePowerW > 0, connected: true, chargePowerW, minCurrentA: 6, maxCurrentA: 16, phasesActive: 3, ...extra });

test('ohne EOS-Weitergabe und ohne Override: evcc im eigenen Modus wird gedeckelt', async () => {
  const { guard, applied } = guardFor({ loadpoints: [lp(1, 11000)], importW: 32000 });
  guard.tick();
  guard.tick();
  assert.equal(guard.capW('wallbox'), 7000, '32 − 28 = 4 kW von der Wallbox');
  await new Promise((r) => setImmediate(r));
  assert.ok(applied.length >= 1, 'Brücke setzt den Deckel durch');
});

test('jeder ladende evcc-Ladepunkt wird überwacht, nicht nur der gewählte', () => {
  const { guard } = guardFor({ loadpoints: [lp(1, 0), lp(2, 11000)], importW: 32000 });
  guard.tick();
  guard.tick();
  assert.equal(guard.capW('wallbox:evcc:2'), 7000);
  assert.equal(guard.capW('wallbox') ?? null, null, 'Ladepunkt 1 lädt nicht');
});

test('keine Wartestellung mehr für eine evcc-Rückkehr (kein „hold“ auf volle Leistung)', () => {
  const { guard } = guardFor({ loadpoints: [lp(1, 0)], importW: 5000, pendingRestore: true });
  guard.tick();
  assert.equal(guard.capW('wallbox') ?? null, null);
});

const wallbox = (currentW) => ({ id: 'wallbox', kind: 'wallbox', name: 'Wallbox', currentW, maxW: 11000, minW: 4140, phases: 3 });

test('Gerät hält Deckel 0 nicht (Handstart): Befehl erzwungen neu, höchstens alle 30 s', () => {
  const st = createGuardState();
  st.caps = { wallbox: 0 };
  st.capAt = { wallbox: 0 };
  let t = OBEY_MS + 1000;
  const step = (cur) => guardStep(st, { resolved: R, now: t, meas: { fresh: true, importW: 20000, phasesW: null }, devices: [wallbox(cur)], battery: {} });
  const seen = [];
  for (let i = 0; i < 20; i += 1) { seen.push(step(11000)); t += 2000; }
  const re = seen.filter((r) => r.events.some((e) => e.type === 'reassert'));
  assert.ok(re.length >= 1, 'neu gesendet');
  assert.ok(re.every((r) => r.changed.has('wallbox')));
  assert.ok(re.length <= Math.ceil(40_000 / REASSERT_MS), `gedrosselt (${re.length})`);
});

test('Gerät folgt seinem Deckel: kein erneutes Senden', () => {
  const st = createGuardState();
  st.caps = { wallbox: 7000 };
  st.capAt = { wallbox: 0 };
  let t = OBEY_MS + 1000;
  for (let i = 0; i < 20; i += 1) {
    const r = guardStep(st, { resolved: R, now: t, meas: { fresh: true, importW: 20000, phasesW: null }, devices: [wallbox(6900)], battery: {} });
    assert.equal(r.events.some((e) => e.type === 'reassert'), false);
    t += 2000;
  }
});

test('Leerlauf-Box mit Deckel 0 (z. B. Fail-safe) wird ganz freigegeben, nicht per Teil-Deckel gestartet', () => {
  const st = createGuardState();
  st.caps = { wallbox: 0 };
  st.capAt = { wallbox: 0 };
  st.cutFrom = { wallbox: 0 };
  let t = 200_000;
  for (let i = 0; i < 30; i += 1) {
    guardStep(st, { resolved: R, now: t, meas: { fresh: true, importW: 20000, phasesW: null }, devices: [wallbox(0)], battery: {} });
    t += 2000;
  }
  assert.equal(st.caps.wallbox ?? null, null, 'ganz frei (release), kein raise mit Ladebefehl');
});

// ── Brücke: evcc-Ladepunkte, die DVhub nicht selbst steuert ───────────────────

function evccHarness({ enabled = false, loadpoints = [lp(1, 11000)], override = null } = {}) {
  const calls = [];
  const lps = loadpoints.map((l) => ({ ...l }));
  const evcc = {
    getStatus: () => ({ url: 'http://evcc.local:7070', lastPolledAt: Date.now(), lastError: null, loadpoints: lps }),
    getLoadpoints: () => lps.map((l) => ({ ...l })),
    refresh: async () => true,
    setMaxCurrent: async (id, a) => { calls.push(['maxcurrent', id, a]); const l = lps.find((x) => x.id === id); if (l) l.maxCurrentA = a; return { ok: true }; },
    setMode: async (id, m) => { calls.push(['mode', id, m]); const l = lps.find((x) => x.id === id); if (l) l.mode = m; return { ok: true }; },
  };
  const cfg = { evcc: { url: 'http://evcc.local:7070' }, wallbox: { type: 'evcc' }, optimizer: { eosOptimizeEv: enabled, evEvccControl: enabled, evEvccLoadpoint: 1, evMaxChargeW: 11000, evStopMode: 'pv' } };
  const ref = { paused: false, capW: null, lpCaps: {} };
  const ownedStore = { value: null };
  const store = { value: override };
  const make = () => createEosEvccBridge({
    getCfg: () => cfg,
    getSolution: async () => null,
    getCharger: (_c, bc) => createEvccAdapter(evcc, () => bc.loadpoint, () => bc.stopMode),
    getEvccLoadpoints: () => evcc.getLoadpoints(),
    isPaused: () => ref.paused,
    getGridCapW: () => ref.capW,
    getDeviceCapW: (id) => (id === 'wallbox' ? ref.capW : ref.lpCaps[Number(id.split(':')[2])] ?? null),
    loadOverride: () => store.value,
    saveOverride: (ov) => { store.value = ov ? JSON.parse(JSON.stringify(ov)) : null; },
    loadOwned: () => ownedStore.value,
    saveOwned: (list) => { ownedStore.value = list ? JSON.parse(JSON.stringify(list)) : null; },
  });
  return { bridge: make(), make, calls, lps, ref, cfg, ownedStore };
}

test('evcc ohne Weitergabe, Deckel über dem Mindeststrom: nur maxcurrent, Modus bleibt', async () => {
  const h = evccHarness();
  h.ref.capW = 7000; // 3 × 230 V → 10 A
  await h.bridge.apply();
  assert.deepEqual(h.calls, [['maxcurrent', 1, 10]]);
  assert.equal(h.lps[0].mode, 'pv');
});

test('evcc Deckel unter dem Mindeststrom: Modus aus; ohne Deckel maxcurrent und Modus zurück', async () => {
  const h = evccHarness();
  h.ref.capW = 2000;
  await h.bridge.apply();
  assert.equal(h.lps[0].mode, 'off');
  h.ref.capW = null;
  await h.bridge.apply();
  assert.equal(h.lps[0].mode, 'pv', 'Modus von vorher');
  assert.equal(h.lps[0].maxCurrentA, 16, 'Strom von vorher');
});

test('evcc Deckel steigt wieder über den Mindeststrom: Modus zurück, Strom gedeckelt', async () => {
  const h = evccHarness();
  h.ref.capW = 2000;
  await h.bridge.apply();
  h.ref.capW = 5000; // 7 A
  await h.bridge.apply();
  assert.equal(h.lps[0].mode, 'pv');
  assert.equal(h.lps[0].maxCurrentA, 7);
  h.ref.capW = null;
  await h.bridge.apply();
  assert.equal(h.lps[0].maxCurrentA, 16);
});

test('Kunde stellt während der Pause selbst um: DVhub stellt den Modus nicht zurück', async () => {
  const h = evccHarness();
  h.ref.capW = 2000;
  await h.bridge.apply();
  h.lps[0].mode = 'minpv';
  h.ref.capW = null;
  await h.bridge.apply();
  assert.equal(h.lps[0].mode, 'minpv');
});

test('anderer Ladepunkt bekommt seinen eigenen Deckel', async () => {
  const h = evccHarness({ loadpoints: [lp(1, 0), lp(2, 11000)] });
  h.ref.lpCaps[2] = 7000;
  await h.bridge.apply();
  assert.deepEqual(h.calls, [['maxcurrent', 2, 10]]);
});

test('erzwungen (apply) geht derselbe Deckel erneut raus — kein Dubletten-Filter', async () => {
  const h = evccHarness();
  h.ref.capW = 7000;
  await h.bridge.apply();
  await h.bridge.apply();
  assert.equal(h.calls.filter((c) => c[0] === 'maxcurrent').length, 2);
});

test('Not-Halt: kein Befehl aus dem Wächter', async () => {
  const h = evccHarness();
  h.ref.capW = 2000;
  h.ref.paused = true;
  await h.bridge.apply();
  assert.deepEqual(h.calls, []);
});

test('Ende „Sofort laden“ unter Deckel: Modus sofort zurück, der Deckel bleibt über maxcurrent', async () => {
  const override = { kind: 'charge', powerW: 11000, startedAt: new Date().toISOString(), until: null, seenConnected: true, prevMode: 'pv' };
  const h = evccHarness({ override });
  h.lps[0].mode = 'now';
  h.ref.capW = 7000;
  await h.bridge.apply();
  await h.bridge.clearOverride();
  assert.equal(h.lps[0].mode, 'pv', 'sofort zurück, kein Warten auf Luft');
  assert.equal(h.lps[0].maxCurrentA, 10, 'Deckel weiter über maxcurrent');
});

test('Neustart: der gemerkte Ursprungsstrom kommt nach dem Deckel zurück', async () => {
  const h = evccHarness();
  h.ref.capW = 7000;
  await h.bridge.apply();
  const b2 = h.make();
  h.ref.capW = null;
  await b2.apply();
  assert.equal(h.lps[0].maxCurrentA, 16);
});
