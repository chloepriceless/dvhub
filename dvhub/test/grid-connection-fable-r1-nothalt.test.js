// test/grid-connection-fable-r1-nothalt.test.js — Fable-Prüfung R1 (1.0.10):
// Not-Halt „als ob DVhub aus ist“ an der Wallbox (Christin 06./10.11.2026):
// beim Eintritt EINMAL die eigenen Vorgaben neutralisieren, danach keine
// Writes, manuell Gestartetes nie anfassen.
//   P2-1  Direkte Box, die DVhub nur BEGRENZT hat (Handstart, Netzanschluss-
//         Deckel als charge(A)): Begrenzung aufheben (release), nicht stoppen.
//   P2-2  evcc-Deckel (maxcurrent gesenkt bzw. Modus „aus“) einmal zurück.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createEosEvccBridge } from '../services/optimizer/eos-evcc-bridge.js';
import { createEvccAdapter } from '../services/wallbox/adapters.js';

// --- P2-1: direkte Box (go-e-Attrappe: charge = amp+frc=2, stop = frc=1, release = frc=0)

function directBox({ capW = 8300 } = {}) {
  const calls = [];
  const box = { frc: 0, amp: 16 };
  const ref = { capW, paused: false };
  const adapter = {
    type: 'goe', isConfigured: () => true,
    charge: async (a) => { calls.push(['charge', a]); box.frc = 2; box.amp = Math.floor(a); return { ok: true }; },
    stop: async () => { calls.push(['stop']); box.frc = 1; return { ok: true }; },
    release: async () => { calls.push(['release']); box.frc = 0; return { ok: true }; },
    status: async () => ({ ok: true, connected: true, charging: box.frc !== 1, raw: { frc: box.frc, amp: box.amp } }),
    dvhubState: async (r) => ({ known: true, active: box.frc === 2 && (r.currentAs || []).some((c) => Math.floor(c) === box.amp) }),
  };
  const cfg = { optimizer: { eosOptimizeEv: false, evEvccControl: false, evMaxChargeW: 11000 }, wallbox: { type: 'goe', goe: { url: 'http://192.0.2.30' } } };
  const store = { value: null };
  const bridge = createEosEvccBridge({
    getCfg: () => cfg,
    getSolution: async () => ({ slotMinutes: 15, rows: [] }),
    getCharger: () => adapter,
    getGridCapW: () => ref.capW,
    isPaused: () => ref.paused,
    loadOverride: () => store.value,
    saveOverride: (ov) => { store.value = ov ? JSON.parse(JSON.stringify(ov)) : null; },
  });
  return { bridge, calls, box, ref };
}

test('P2-1: Handladung an einer direkten Box, DVhub hat nur begrenzt → Not-Halt hebt die Begrenzung auf, stoppt nicht', async () => {
  const h = directBox();
  await h.bridge.tick();
  assert.deepEqual(h.calls.at(-1), ['charge', 12], 'Deckel 8,3 kW → 12 A');
  h.ref.paused = true;
  const r = await h.bridge.emergencyStop();
  assert.ok(!h.calls.some((c) => c[0] === 'stop'), `kein Stopp (${JSON.stringify(h.calls)})`);
  assert.deepEqual(h.calls.at(-1), ['release'], 'eigene Vorgabe zurück');
  assert.equal(h.box.frc, 0, 'Box regelt wieder selbst');
  assert.equal(r.ok, true);
  assert.deepEqual(r.released, ['goe:1']);
  // Danach still.
  const n = h.calls.length;
  await h.bridge.tick();
  await h.bridge.emergencyStop();
  assert.equal(h.calls.length, n, 'keine weiteren Writes');
});

test('P2-1: „Sofort laden“ (von DVhub gestartet) an der direkten Box → Not-Halt stoppt wie bisher', async () => {
  const h = directBox();
  h.ref.capW = null;
  const res = await h.bridge.setOverride({ kind: 'charge', powerW: 11000 });
  assert.equal(res.ok, true);
  h.ref.capW = 8300;
  await h.bridge.tick({ force: true });
  h.ref.paused = true;
  const r = await h.bridge.emergencyStop();
  assert.equal(r.stopped, true, JSON.stringify(r));
  assert.deepEqual(h.calls.at(-1), ['stop']);
});

// --- P2-2: evcc-Ladepunkt im eigenen Modus, von DVhub gedeckelt

function evccLoadpoint({ mode = 'pv', maxCurrentA = 16 } = {}) {
  const lp = { id: 1, mode, maxCurrentA, minCurrentA: 6, phasesActive: 3, connected: true, charging: true };
  const calls = [];
  const evcc = {
    getStatus: () => ({ url: 'http://evcc.local:7070' }),
    getLoadpoints: () => [{ ...lp }],
    refresh: async () => true,
    setMaxCurrent: async (id, a) => { calls.push(['maxcurrent', id, a]); lp.maxCurrentA = a; return { ok: true }; },
    setMode: async (id, m) => { calls.push(['mode', id, m]); lp.mode = m; return { ok: true }; },
  };
  const cfg = { evcc: { url: 'http://evcc.local:7070' }, wallbox: { type: 'evcc' }, optimizer: { eosOptimizeEv: false, evEvccControl: false, evEvccLoadpoint: 1, evMaxChargeW: 11000, evStopMode: 'pv' } };
  const ref = { capW: null, paused: false };
  const ownedStore = { value: null };
  const bridge = createEosEvccBridge({
    getCfg: () => cfg,
    getSolution: async () => ({ slotMinutes: 15, rows: [] }),
    getCharger: (_c, bc) => createEvccAdapter(evcc, () => bc.loadpoint, () => bc.stopMode),
    getGridCapW: () => ref.capW,
    getDeviceCapW: () => null,
    getEvccLoadpoints: () => evcc.getLoadpoints(),
    isPaused: () => ref.paused,
    loadOwned: () => ownedStore.value,
    saveOwned: (list) => { ownedStore.value = list ? JSON.parse(JSON.stringify(list)) : null; },
  });
  return { bridge, calls, lp, ref, ownedStore };
}

test('P2-2: evcc-Deckel über maxcurrent → Not-Halt stellt den Ursprungsstrom einmal zurück, danach still', async () => {
  const h = evccLoadpoint();
  h.ref.capW = 7000;
  await h.bridge.tick();
  assert.deepEqual(h.calls.at(-1), ['maxcurrent', 1, 10], 'gedeckelt auf 10 A');
  h.ref.paused = true;
  const r = await h.bridge.emergencyStop();
  assert.deepEqual(h.calls.at(-1), ['maxcurrent', 1, 16], `Ursprungsstrom zurück (${JSON.stringify(h.calls)})`);
  assert.equal(h.lp.mode, 'pv', 'Modus unberührt');
  assert.equal(r.ok, true);
  const n = h.calls.length;
  await h.bridge.tick();
  await h.bridge.emergencyStop();
  assert.equal(h.calls.length, n, 'keine weiteren Writes');
});

test('P2-2: evcc von DVhub auf „aus“ gedeckelt → Not-Halt stellt den Modus davor zurück', async () => {
  const h = evccLoadpoint();
  h.ref.capW = 2000; // unter dem Mindeststrom
  await h.bridge.tick();
  assert.equal(h.lp.mode, 'off');
  h.ref.paused = true;
  await h.bridge.emergencyStop();
  assert.equal(h.lp.mode, 'pv', `Modus davor (${JSON.stringify(h.calls)})`);
  const n = h.calls.length;
  await h.bridge.emergencyStop();
  assert.equal(h.calls.length, n);
});

test('P2-2: Kunde hat während des Deckels selbst umgestellt → Not-Halt fasst den Modus nicht an', async () => {
  const h = evccLoadpoint();
  h.ref.capW = 2000;
  await h.bridge.tick();
  assert.equal(h.lp.mode, 'off');
  h.lp.mode = 'now'; // in der evcc-App von Hand
  h.ref.paused = true;
  await h.bridge.emergencyStop();
  assert.equal(h.lp.mode, 'now');
  assert.ok(!h.calls.some((c) => c[0] === 'mode' && c[2] === 'pv'), JSON.stringify(h.calls));
});
