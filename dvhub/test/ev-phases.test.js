// test/ev-phases.test.js -- Einphasig laden, wenn die Wallbox die
// Phasenumschaltung kann (1,4–3,7 kW), sonst dreiphasig ab ~4,1 kW
// (Christin 07.11.2026). EOS bekommt nur Ladestufen, die die Wallbox wirklich
// fahren kann; die Brücke schaltet bei kleiner geplanter Leistung auf eine Phase.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { evChargeRates, createEosEvccBridge, resolveEvccBridgeConfig } from '../services/optimizer/eos-evcc-bridge.js';
import { buildEosElectricVehicles } from '../services/optimizer/eos-config-sync.js';
import { createEvccAdapter } from '../services/wallbox/adapters.js';

describe('Ladestufen für EOS', () => {
  test('11 kW dreiphasig, 6 A: erst ab 4,14 kW (Stufe 0,4)', () => {
    assert.deepEqual(evChargeRates({ maxChargeW: 11000, minCurrentA: 6, phases: 3, onePhase: false }), [0, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]);
  });
  test('11 kW mit Phasenumschaltung: 1,38–3,68 kW einphasig dazu', () => {
    assert.deepEqual(evChargeRates({ maxChargeW: 11000, minCurrentA: 6, maxCurrentA: 16, phases: 3, onePhase: true }),
      [0, 0.13, 0.15, 0.2, 0.25, 0.3, 0.33, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]);
  });
  test('22 kW dreiphasig: ab 0,2', () => {
    assert.deepEqual(evChargeRates({ maxChargeW: 22000, minCurrentA: 6, phases: 3, onePhase: false }), [0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]);
  });
  test('einphasige Wallbox 3,7 kW: ab 1,38 kW', () => {
    assert.deepEqual(evChargeRates({ maxChargeW: 3680, minCurrentA: 6, phases: 1, onePhase: false }), [0, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]);
  });
  test('EOS-Gerät nimmt die Stufen der Wallbox', () => {
    const cfg = { optimizer: { evMaxChargeW: 11000, evMinCurrentA: 6, evPhases: 3 } };
    assert.deepEqual(buildEosElectricVehicles(cfg)[0].charge_rates, [0, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]);
    assert.deepEqual(buildEosElectricVehicles(cfg, { onePhaseCharging: true })[0].charge_rates.slice(0, 3), [0, 0.13, 0.15]);
  });
});

const T0 = Date.parse('2026-11-16T22:00:00Z');
const Q = 15 * 60_000;
function harness({ factors, phases1p3p = true, capW = null, extra = {} }) {
  const calls = [];
  const lp = { id: 1, mode: 'off', connected: true, charging: false, phases1p3p, phasesActive: 3 };
  const fakeEvcc = {
    getStatus: () => ({ url: 'http://evcc.local:7070' }),
    getLoadpoints: () => [lp],
    setMaxCurrent: async (id, a) => { calls.push(['maxcurrent', a]); return { ok: true }; },
    setMode: async (id, m) => { calls.push(['mode', m]); lp.mode = m; return { ok: true }; },
    setPhases: async (id, n) => { calls.push(['phases', n]); lp.phasesActive = n; return { ok: true }; },
  };
  const cfg = { evcc: { url: 'http://evcc.local:7070' }, optimizer: { eosOptimizeEv: true, evEvccControl: true, evEvccLoadpoint: 1, evMaxChargeW: 11000, evPhases: 3, ...extra } };
  let clock = T0 + 60_000;
  let sol = factors;
  const bridge = createEosEvccBridge({
    getCfg: () => cfg,
    getSolution: async () => ({ generatedAt: '2026-11-16T21:58:00Z', slotMinutes: 15, rows: sol.map((f, i) => ({ ts_utc: new Date(T0 + i * Q).toISOString(), evChargeFactor: f, evSocPct: 50 })) }),
    getCharger: (c, bc) => createEvccAdapter(fakeEvcc, () => bc.loadpoint, () => bc.stopMode),
    getEvccLoadpoints: () => [lp],
    getGridCapW: () => capW,
    now: () => clock,
  });
  return { bridge, calls, advance: (ms) => { clock += ms; }, setFactors: (f) => { sol = f; } };
}

describe('Brücke: einphasig bei kleiner Leistung', () => {
  test('evcc mit 1p3p: 2,75 kW → eine Phase, 12 A; danach volle Leistung → drei Phasen, 16 A', async () => {
    const h = harness({ factors: [0.25, 1] });
    await h.bridge.tick();
    assert.deepEqual(h.calls, [['phases', 1], ['maxcurrent', 12], ['mode', 'now']]);
    h.advance(Q);
    await h.bridge.tick();
    assert.deepEqual(h.calls.slice(3), [['phases', 3], ['maxcurrent', 16], ['mode', 'now']]);
  });

  test('Wallbox ohne Umschaltung: wie bisher dreiphasig mit Mindeststrom', async () => {
    const h = harness({ factors: [0.25], phases1p3p: false });
    await h.bridge.tick();
    assert.deepEqual(h.calls, [['maxcurrent', 6], ['mode', 'now']]);
  });

  test('ausgeschaltet (evPhaseSwitch=false): dreiphasig', async () => {
    const h = harness({ factors: [0.25], extra: { evPhaseSwitch: false } });
    await h.bridge.tick();
    assert.ok(!h.calls.some((c) => c[0] === 'phases'));
  });

  test('Leistungsgrenze aktiv: keine Umschaltung (Wächter rechnet dreiphasig)', async () => {
    const h = harness({ factors: [0.25], capW: 9000 });
    await h.bridge.tick();
    assert.ok(!h.calls.some((c) => c[0] === 'phases'));
  });

  test('Status nennt, ob einphasig geladen werden kann', () => {
    const h = harness({ factors: [0.25] });
    assert.equal(h.bridge.getStatus().onePhaseCharging, true);
    assert.equal(resolveEvccBridgeConfig({ optimizer: { evPhases: 3 } }).phaseSwitch, true);
  });
});
