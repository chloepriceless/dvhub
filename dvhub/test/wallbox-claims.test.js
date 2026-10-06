import test from 'node:test';
import assert from 'node:assert/strict';
import { wholeAmps, findForeignClaim, OPENEVSE_DVHUB_CLIENT } from '../services/wallbox/adapters.js';
import { createEosEvccBridge } from '../services/optimizer/eos-evcc-bridge.js';

test('ganze Ampere: gerundet, nie unter 6 A — 11 kW meinen die 16-A-Stufe', () => {
  assert.equal(wholeAmps(15.9), 16);
  assert.equal(wholeAmps(15.4), 15);
  assert.equal(wholeAmps(8), 8);
  assert.equal(wholeAmps(3), 6);
});

test('fremder Auftrag an der OpenEVSE wird erkannt, der eigene nicht', () => {
  // Stand der Box am 06.10.2026: ein fremder Regler mit 6 A, gleiche Priorität.
  const seen = [{ client: 262145, priority: 500, state: 'disabled', charge_current: 6, auto_release: false }];
  assert.deepEqual(findForeignClaim(seen), { client: 262145, priority: 500, state: 'disabled', chargeCurrentA: 6 });
  assert.equal(findForeignClaim([{ client: OPENEVSE_DVHUB_CLIENT, priority: 500, state: 'active', charge_current: 16 }]), null);
  assert.equal(findForeignClaim([]), null);
  assert.equal(findForeignClaim(null), null);
  const two = [{ client: 1, priority: 100, state: 'active', charge_current: 10 }, { client: 2, priority: 1000, state: 'active', charge_current: 8 }];
  assert.equal(findForeignClaim(two).client, 2, 'der mit der höchsten Priorität zählt');
});

function bridgeWith({ capW, optimizer = {} }) {
  const calls = [];
  const logs = [];
  let cap = capW;
  const charger = {
    type: 'openevse',
    isConfigured: () => true,
    charge: async (a) => { calls.push(['charge', a]); return { ok: true }; },
    stop: async () => { calls.push(['stop']); return { ok: true }; },
    release: async () => { calls.push(['release']); return { ok: true }; },
    status: async () => ({ ok: true, connected: true })
  };
  const bridge = createEosEvccBridge({
    getCfg: () => ({ wallbox: { type: 'openevse', openevse: { url: 'http://box' } }, optimizer: { evMaxChargeW: 11000, evMinCurrentA: 6, ...optimizer } }),
    getSolution: async () => null,
    getCharger: () => charger,
    getGridCapW: () => cap,
    pushLog: (event, data) => logs.push({ event, data }),
    now: () => Date.parse('2026-10-06T12:00:00Z')
  });
  return { bridge, calls, logs, setCap: (v) => { cap = v; } };
}

test('§14a ohne EOS-Steuerung: direkt angebundene Wallbox wird auf ihren Anteil gedeckelt und danach freigegeben', async () => {
  const h = bridgeWith({ capW: 4200 });
  await h.bridge.tick();
  assert.deepEqual(h.calls, [['charge', 6]], '4,2 kW an 3 Phasen = 6,09 A → 6 A');
  assert.equal(h.logs.some((l) => l.event === 'paragraph14a_wallbox_capped'), true);
  await h.bridge.tick();
  assert.equal(h.calls.length, 1, 'unverändert → kein zweiter Befehl');
  h.setCap(null);
  await h.bridge.tick();
  assert.deepEqual(h.calls.at(-1), ['release'], 'Grenze aufgehoben → Vorgabe zurückgeben');
});

test('§14a ohne EOS-Steuerung: Grenze unter dem Mindeststrom → nicht laden', async () => {
  const h = bridgeWith({ capW: 2000 });
  await h.bridge.tick();
  assert.deepEqual(h.calls, [['stop']]);
});

test('keine Begrenzung → die Wallbox bleibt unberührt', async () => {
  const h = bridgeWith({ capW: null });
  await h.bridge.tick();
  assert.deepEqual(h.calls, []);
});
