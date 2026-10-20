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
