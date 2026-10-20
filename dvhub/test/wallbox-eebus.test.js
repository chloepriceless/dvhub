// EEBUS-Wallbox als Hauptwallbox (Christin 2026-10-20): Elli/VW ID. Charger,
// Cupra, Audi, Škoda, Porsche, Kontron/Steca/ghostONE — über DVhubs EEBUS-Dienst
// und die Verbrauchsgrenze (LPC). Laden = Grenze A × 230 V × Phasen, Stopp = 0 W,
// Freigeben = Grenze aufheben (die Box lädt wieder nach eigener Einstellung).
import test from 'node:test';
import assert from 'node:assert/strict';

import { createEebusWallboxAdapter } from '../services/wallbox/eebus-wallbox.js';
import { WALLBOX_TYPES, directWallboxConfigured } from '../services/wallbox/types.js';
import { WALLBOX_LABELS } from '../services/wallbox/main-wallbox.js';

const SKI = 'e'.repeat(40);
function fakeEebus(info = { connected: true, hasLpc: true, powerW: 0, name: 'Elli' }) {
  const calls = [];
  return { calls, deviceInfo: (ski) => (ski === SKI ? info : null), setEmsLimit: async (ski, w) => { calls.push([ski, w]); return { ok: true }; } };
}

test('Typ „eebus“ wählbar, eingerichtet mit SKI', () => {
  assert.ok(WALLBOX_TYPES.includes('eebus'));
  assert.equal(WALLBOX_LABELS.eebus, 'EEBUS-Wallbox');
  assert.equal(directWallboxConfigured({ wallbox: { type: 'eebus', eebus: { ski: SKI } } }), true);
  assert.equal(directWallboxConfigured({ wallbox: { type: 'eebus', eebus: { ski: '' } } }), false);
});

test('Laden: Grenze aus Strom × 230 V × Phasen; Stopp 0 W; Freigeben hebt auf', async () => {
  const e = fakeEebus();
  const a = createEebusWallboxAdapter(() => ({ ski: SKI, phases: 3 }), { getEebus: () => e });
  assert.equal((await a.charge(10.8)).ok, true);
  assert.equal((await a.stop()).ok, true);
  assert.equal((await a.release()).ok, true);
  assert.deepEqual(e.calls, [[SKI, 6900], [SKI, 0], [SKI, null]]);
  const one = createEebusWallboxAdapter(() => ({ ski: SKI, phases: 1 }), { getEebus: () => e });
  await one.charge(16);
  assert.deepEqual(e.calls.at(-1), [SKI, 3680]);
});

test('Status: lädt ab 100 W; angesteckt nur sicher, wenn es lädt; nicht verbunden → Fehler', async () => {
  const a = (info) => createEebusWallboxAdapter(() => ({ ski: SKI, phases: 3 }), { getEebus: () => fakeEebus(info) });
  const st = await a({ connected: true, hasLpc: true, powerW: 3650 }).status();
  assert.deepEqual([st.ok, st.charging, st.connected, st.powerW], [true, true, true, 3650]);
  const idle = await a({ connected: true, hasLpc: true, powerW: 20 }).status();
  assert.deepEqual([idle.charging, idle.connected], [false, null]);
  assert.equal((await a({ connected: false, hasLpc: true, powerW: null }).status()).ok, false);
  const none = createEebusWallboxAdapter(() => ({ ski: SKI }), { getEebus: () => null });
  assert.match((await none.charge(10)).error, /EEBUS/);
});

// Go-Fassung (eebus-go, 20.10.): steckt ein Auto und meldet die Box OPEV, steuert DVhub
// den Ladestrom je Phase direkt (OPEV). eebus-go setzt Werte unter dem Minimum auf den
// Standardwert der Box (meist 0 = Pause; features/internal/electricalconnection.go:297).
function fakeEebusEv(ev) {
  const calls = [];
  return {
    calls,
    deviceInfo: (ski) => (ski === SKI ? { connected: true, hasLpc: true, powerW: 7000, name: 'Elli', ev } : null),
    setEmsLimit: async (ski, w) => { calls.push(['lpc', w]); return { ok: true }; },
    setEvCurrentLimits: async (ski, amps) => { calls.push(['opev', amps]); return { ok: true }; },
  };
}

test('Auto steckt + OPEV: Laden = Strom je Phase, Stopp = 0 A, Freigeben hebt OPEV und eine frühere LPC-Grenze auf', async () => {
  const ev = { connected: false, soc: null, powerW: null, phasesA: null, opev: false, maxA: null };
  const e = fakeEebusEv(ev);
  const a = createEebusWallboxAdapter(() => ({ ski: SKI, phases: 3 }), { getEebus: () => e });
  await a.stop(); // noch kein Auto → LPC 0 W
  Object.assign(ev, { connected: true, soc: 40, powerW: 6900, phasesA: [10, 10, 10], opev: true, opevStop: true, maxA: 16 });
  await a.charge(10.6);
  await a.charge(40);
  await a.stop();
  await a.release();
  assert.deepEqual(e.calls, [['lpc', 0], ['lpc', null], ['opev', [10]], ['opev', [16]], ['opev', [0]], ['opev', null]]);
});

test('Status mit Auto: verbunden sicher, Ladestand vom Auto, Leistung und Strom aus den Auto-Messwerten', async () => {
  const e = fakeEebusEv({ connected: true, soc: 63, powerW: 6900, phasesA: [10, 9.5, 10.2], opev: true, opevStop: true, maxA: 16 });
  const st = await createEebusWallboxAdapter(() => ({ ski: SKI, phases: 3 }), { getEebus: () => e }).status();
  assert.deepEqual([st.ok, st.connected, st.charging, st.powerW, st.currentA, st.vehicleSocPct], [true, true, true, 6900, 10.2, 63]);
  const off = await createEebusWallboxAdapter(() => ({ ski: SKI, phases: 3 }), { getEebus: () => fakeEebusEv({ connected: false, soc: null, powerW: null, phasesA: null, opev: false, maxA: null }) }).status();
  assert.deepEqual([off.connected, off.vehicleSocPct], [false, null]);
});

test('Standardwert > 0 (OPEV kann nicht auf 0): Stopp bleibt bei LPC 0 W, Laden hebt sie wieder auf (Codex 20.10.)', async () => {
  const e = fakeEebusEv({ connected: true, soc: 40, powerW: 0, phasesA: [0, 0, 0], opev: true, opevStop: false, maxA: 16 });
  const a = createEebusWallboxAdapter(() => ({ ski: SKI, phases: 3 }), { getEebus: () => e });
  await a.stop();
  await a.charge(8);
  assert.deepEqual(e.calls, [['lpc', 0], ['lpc', null], ['opev', [8]]]);
});

test('Box ohne LPC, aber Auto mit OPEV → eingerichtet (Codex 20.10.)', () => {
  const e = { deviceInfo: () => ({ connected: true, hasLpc: false, ev: { connected: true, opev: true, opevStop: true, maxA: 16 } }), setEmsLimit: async () => ({ ok: true }), setEvCurrentLimits: async () => ({ ok: true }) };
  assert.equal(createEebusWallboxAdapter(() => ({ ski: SKI }), { getEebus: () => e }).isConfigured(), true);
});
