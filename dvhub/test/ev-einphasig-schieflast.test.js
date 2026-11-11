// test/ev-einphasig-schieflast.test.js -- Einphasig höchstens 20 A (Fable R5 P2-2).
//
// VDE-AR-N 4100: einphasig höchstens 4,6 kVA Schieflast = 20 A an 230 V. evcc
// selbst deckelt einphasig nicht (core/loadpoint.go: 1p skaliert bis maxCurrent,
// begrenzt nur über Fahrzeug, Box und Lastmanagement-Kreise; geprüft am Stand
// master 1ca89f238f, 10.11.2026) — die Grenze muss DVhub ziehen.
//
// 22-kW-Box (32 A dreiphasig) mit Phasenumschaltung, Mindeststrom 6, 8, 10 A:
// dreiphasig geht erst ab Mindeststrom × 3 × 230 V (4,14 / 5,52 / 6,9 kW),
// einphasig nur bis 20 A (4,6 kW). Dazwischen gibt es keine Stufe; wo einphasig
// mit ≤ 20 A nichts geht (Mindeststrom > 20 A), nur dreiphasig.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as bridgeModule from '../services/optimizer/eos-evcc-bridge.js';
import { buildEosElectricVehicles } from '../services/optimizer/eos-config-sync.js';
import { createEvccAdapter } from '../services/wallbox/adapters.js';

const { evChargeRates, createEosEvccBridge, resolveEvccBridgeConfig, powerToCurrentA, onePhaseChargingAvailable } = bridgeModule;
const V = 230;
const BOX_W = 22000;

function bcFor(extra = {}) {
  return resolveEvccBridgeConfig({ optimizer: { eosOptimizeEv: true, evEvccControl: true, evMaxChargeW: BOX_W, evPhases: 3, ...extra } });
}

describe('Grenze', () => {
  test('20 A einphasig (4,6 kVA)', () => {
    assert.equal(bridgeModule.ONE_PHASE_MAX_A, 20);
    assert.equal(bcFor().onePhaseMaxA, 20);
  });
  test('Konfiguration darf nur verschärfen', () => {
    assert.equal(bcFor({ evOnePhaseMaxCurrentA: 16 }).onePhaseMaxA, 16);
    assert.equal(bcFor({ evOnePhaseMaxCurrentA: 32 }).onePhaseMaxA, 20);
    assert.equal(bcFor({ evOnePhaseMaxCurrentA: 0 }).onePhaseMaxA, 20);
    assert.equal(bcFor({ evOnePhaseMaxCurrentA: 'x' }).onePhaseMaxA, 20);
  });
});

describe('Ladestufen für EOS, 22-kW-Box mit Phasenumschaltung', () => {
  for (const minA of [6, 8, 10]) {
    test(`Mindeststrom ${minA} A: einphasig höchstens 4,6 kW, keine Stufe zwischen 4,6 kW und dreiphasig`, () => {
      const bc = bcFor({ evMinCurrentA: minA });
      const rates = evChargeRates({ maxChargeW: BOX_W, minCurrentA: minA, maxCurrentA: bc.maxCurrentA, phases: 3, onePhase: true, onePhaseMaxA: bc.onePhaseMaxA });
      const min3pW = minA * 3 * V;
      for (const r of rates) {
        const w = r * BOX_W;
        assert.ok(r === 0 || w <= 20 * V + 1e-6 || w >= min3pW - 1e-6, `Stufe ${r} = ${w} W bei ${minA} A`);
      }
      assert.ok(rates.some((r) => r > 0 && r * BOX_W < min3pW), 'einphasige Stufen gibt es weiter');
    });
  }

  test('EOS-Gerät (buildEosElectricVehicles) bekommt dieselben Stufen', () => {
    const cfg = { optimizer: { evMaxChargeW: BOX_W, evMinCurrentA: 10, evPhases: 3 } };
    const rates = buildEosElectricVehicles(cfg, { onePhaseCharging: true })[0].charge_rates;
    assert.ok(rates.every((r) => r === 0 || r * BOX_W <= 4600 || r * BOX_W >= 6900), JSON.stringify(rates));
  });

  test('strengere Grenze aus der Konfiguration (16 A): einphasig höchstens 3,68 kW', () => {
    const bc = bcFor({ evMinCurrentA: 6, evOnePhaseMaxCurrentA: 16 });
    const rates = evChargeRates({ maxChargeW: BOX_W, minCurrentA: 6, maxCurrentA: bc.maxCurrentA, phases: 3, onePhase: true, onePhaseMaxA: bc.onePhaseMaxA });
    assert.ok(rates.every((r) => r === 0 || r * BOX_W <= 16 * V + 1e-6 || r * BOX_W >= 4140 - 1e-6), JSON.stringify(rates));
  });

  test('Mindeststrom über 20 A: einphasig geht nicht — nur dreiphasige Stufen, keine Umschaltung', () => {
    const bc = bcFor({ evMinCurrentA: 21 });
    const rates = evChargeRates({ maxChargeW: BOX_W, minCurrentA: 21, maxCurrentA: bc.maxCurrentA, phases: 3, onePhase: true, onePhaseMaxA: bc.onePhaseMaxA });
    assert.deepEqual(rates, evChargeRates({ maxChargeW: BOX_W, minCurrentA: 21, phases: 3, onePhase: false }));
    const cfg = { evcc: { url: 'http://evcc.local:7070' }, optimizer: { eosOptimizeEv: true, evEvccControl: true, evMaxChargeW: BOX_W, evPhases: 3, evMinCurrentA: 21 } };
    assert.equal(onePhaseChargingAvailable(cfg, [{ id: 1, phases1p3p: true }]), false);
  });

  test('Auto lädt nur einphasig (evPhases 1) an einer 7,4-kW-Box: höchstens 20 A, Stufen bis 4,6 kW', () => {
    const bc = resolveEvccBridgeConfig({ optimizer: { evMaxChargeW: 7360, evPhases: 1 } });
    assert.equal(bc.maxCurrentA, 20);
    assert.equal(powerToCurrentA(7360, bc), 20);
    const rates = evChargeRates({ maxChargeW: 7360, minCurrentA: 6, maxCurrentA: bc.maxCurrentA, phases: 1, onePhase: false, onePhaseMaxA: bc.onePhaseMaxA });
    assert.ok(rates.every((r) => r * 7360 <= 4600 + 1e-6), JSON.stringify(rates));
    assert.ok(rates.length > 3);
  });
});

describe('Auto lädt nur einphasig (Codex 6390684a)', () => {
  test('wirksame Höchstleistung 4,6 kW: EOS-Gerät, „Sofort laden“, Plan-Umrechnung', () => {
    const cfg = { optimizer: { evMaxChargeW: 7360, evPhases: 1, evMinCurrentA: 6 } };
    assert.equal(bridgeModule.effectiveEvMaxChargeW(cfg), 4600);
    const bc = resolveEvccBridgeConfig(cfg);
    assert.equal(bc.maxChargeW, 4600);
    assert.equal(bridgeModule.overrideLimits(bc).maxPowerW, 4600);
    const [ev] = buildEosElectricVehicles(cfg);
    assert.equal(ev.max_charge_power_w, 4600);
    assert.ok(ev.charge_rates.every((r) => r * 4600 <= 4600 + 1e-6));
    const plan = bridgeModule.buildEvPlan({ slotMinutes: 15, rows: [{ ts_utc: '2026-11-16T22:00:00Z', evChargeFactor: 1 }] }, bc);
    assert.equal(plan[0].chargePowerW, 4600);
    assert.equal(plan[0].currentA, 20);
  });

  test('Mindeststrom über der strengeren Grenze: nie über die Grenze (10 A Mindeststrom, 8 A Grenze)', () => {
    const cfg = { optimizer: { evMaxChargeW: 7360, evPhases: 1, evMinCurrentA: 10, evOnePhaseMaxCurrentA: 8 } };
    const bc = resolveEvccBridgeConfig(cfg);
    assert.ok(bc.maxCurrentA <= 8, `maxCurrentA ${bc.maxCurrentA}`);
    assert.ok(powerToCurrentA(7360, bc) <= 8);
    assert.ok(powerToCurrentA(500, bc) <= 8);
    const rates = buildEosElectricVehicles(cfg)[0].charge_rates;
    assert.ok(rates.every((r) => r * bc.maxChargeW <= 8 * V + 1e-6), JSON.stringify(rates));
    const raw = evChargeRates({ maxChargeW: 7360, minCurrentA: 10, phases: 1, onePhaseMaxA: 8 });
    assert.ok(raw.every((r) => r * 7360 <= 8 * V + 1e-6), JSON.stringify(raw));
  });
});

describe('Strom einphasig', () => {
  test('powerToCurrentA einphasig nie über 20 A', () => {
    const bc = bcFor({ evMinCurrentA: 10 });
    assert.equal(powerToCurrentA(11000, { ...bc, phases: 1 }), 20);
    assert.equal(powerToCurrentA(6800, { ...bc, phases: 1 }), 20);
    assert.equal(powerToCurrentA(11000, bc), 16, 'dreiphasig unverändert');
  });
});

// Brücke wie in test/ev-phases.test.js, mit 22-kW-Box.
const T0 = Date.parse('2026-11-16T22:00:00Z');
const Q = 15 * 60_000;
function harness({ factors, minA }) {
  const calls = [];
  const lp = { id: 1, mode: 'off', connected: true, charging: false, phases1p3p: true, phasesActive: 3 };
  const fakeEvcc = {
    getStatus: () => ({ url: 'http://evcc.local:7070' }),
    getLoadpoints: () => [lp],
    setMaxCurrent: async (id, a) => { calls.push(['maxcurrent', a]); return { ok: true }; },
    setMode: async (id, m) => { calls.push(['mode', m]); lp.mode = m; return { ok: true }; },
    setPhases: async (id, n) => { calls.push(['phases', n]); lp.phasesActive = n; return { ok: true }; },
  };
  const cfg = { evcc: { url: 'http://evcc.local:7070' }, optimizer: { eosOptimizeEv: true, evEvccControl: true, evEvccLoadpoint: 1, evMaxChargeW: BOX_W, evPhases: 3, evMinCurrentA: minA } };
  const bridge = createEosEvccBridge({
    getCfg: () => cfg,
    getSolution: async () => ({ generatedAt: '2026-11-16T21:58:00Z', slotMinutes: 15, rows: factors.map((f, i) => ({ ts_utc: new Date(T0 + i * Q).toISOString(), evChargeFactor: f, evSocPct: 50 })) }),
    getCharger: (c, bc) => createEvccAdapter(fakeEvcc, () => bc.loadpoint, () => bc.stopMode),
    getEvccLoadpoints: () => [lp],
    getGridCapW: () => null,
    now: () => T0 + 60_000,
  });
  return { bridge, calls };
}

describe('Brücke: einphasig nur bis 20 A, sonst dreiphasig', () => {
  for (const [minA, factor, wantPhases, wantA] of [
    [6, 0.18, 1, 17.2], // 3,96 kW einphasig
    [8, 0.2, 1, 19.1], // 4,4 kW einphasig
    [8, 0.24, null, 8], // 5,28 kW: einphasig 23 A verboten → dreiphasig mit Mindeststrom
    [10, 0.2, 1, 19.1], // 4,4 kW einphasig
    [10, 0.25, null, 10], // 5,5 kW: sonst 24 A einphasig
    [10, 0.3, null, 10], // 6,6 kW: sonst 29 A einphasig
  ]) {
    test(`Mindeststrom ${minA} A, Plan ${Math.round(factor * BOX_W)} W → ${wantPhases === 1 ? 'einphasig' : 'dreiphasig'} ${wantA} A`, async () => {
      const h = harness({ factors: [factor], minA });
      await h.bridge.tick();
      const amps = h.calls.filter((c) => c[0] === 'maxcurrent').map((c) => c[1]);
      if (wantPhases === 1) assert.deepEqual(h.calls, [['phases', 1], ['maxcurrent', wantA], ['mode', 'now']]);
      else {
        assert.ok(!h.calls.some((c) => c[0] === 'phases' && c[1] === 1), JSON.stringify(h.calls));
        assert.equal(amps[amps.length - 1], wantA);
      }
      assert.ok(amps.every((a) => a <= 32));
    });
  }
});

// ── Codex 701bde37: einphasig unmöglich (Mindeststrom über der Grenze) ──
function harness2({ factors = [1], optimizer = {}, lpExtra = {}, owned = null } = {}) {
  const calls = [];
  const lp = { id: 1, mode: 'pv', connected: true, charging: true, phases1p3p: true, phasesActive: 3, ...lpExtra };
  const fakeEvcc = {
    getStatus: () => ({ url: 'http://evcc.local:7070' }),
    getLoadpoints: () => [lp],
    refresh: async () => true,
    setMaxCurrent: async (id, a) => { calls.push(['maxcurrent', a]); return { ok: true }; },
    setMode: async (id, m) => { calls.push(['mode', m]); lp.mode = m; return { ok: true }; },
    setPhases: async (id, n) => { calls.push(['phases', n]); return { ok: true }; },
  };
  const cfg = { evcc: { url: 'http://evcc.local:7070' }, wallbox: { type: 'evcc' }, optimizer: { eosOptimizeEv: true, evEvccControl: true, evEvccLoadpoint: 1, evMaxChargeW: BOX_W, evPhases: 3, evStopMode: 'pv', ...optimizer } };
  const store = { owned, override: null };
  let sol = factors;
  const bridge = createEosEvccBridge({
    getCfg: () => cfg,
    getSolution: async () => ({ generatedAt: '2026-11-16T21:58:00Z', slotMinutes: 15, rows: sol.map((f, i) => ({ ts_utc: new Date(T0 + i * Q).toISOString(), evChargeFactor: f, evSocPct: 50 })) }),
    getCharger: (c, bc) => createEvccAdapter(fakeEvcc, () => bc.loadpoint, () => bc.stopMode),
    getEvccLoadpoints: () => [lp],
    getGridCapW: () => null,
    now: () => T0 + 60_000,
    loadOwned: () => store.owned,
    saveOwned: (l) => { store.owned = l ? JSON.parse(JSON.stringify(l)) : null; },
    loadOverride: () => store.override,
    saveOverride: (o) => { store.override = o ? JSON.parse(JSON.stringify(o)) : null; },
  });
  return { bridge, calls, lp, setFactors: (f) => { sol = f; } };
}

describe('Einphasig unmöglich (Codex 701bde37)', () => {
  const blocked = { evPhases: 1, evMaxChargeW: 7360, evMinCurrentA: 10, evOnePhaseMaxCurrentA: 8 };

  test('EOS bekommt keine positive Ladestufe', () => {
    assert.deepEqual(buildEosElectricVehicles({ optimizer: blocked })[0].charge_rates, [0]);
  });

  test('Plan will laden → harter Stopp (evcc „aus“), kein Strom unter dem Mindeststrom', async () => {
    const h = harness2({ optimizer: blocked });
    await h.bridge.tick();
    assert.ok(!h.calls.some((c) => c[0] === 'maxcurrent'), JSON.stringify(h.calls));
    assert.deepEqual(h.calls.at(-1), ['mode', 'off']);
  });

  test('„Sofort laden“ → harter Stopp statt Strom unter dem Mindeststrom', async () => {
    const h = harness2({ optimizer: blocked });
    const r = await h.bridge.setOverride({ kind: 'charge', powerW: 1840 });
    assert.ok(!h.calls.some((c) => c[0] === 'maxcurrent'), JSON.stringify([r, h.calls]));
    assert.deepEqual(h.calls.at(-1), ['mode', 'off']);
  });

  test('„Sofort laden“ mit 22 kW, Kunde hat in evcc einphasig gewählt: höchstens 20 A', async () => {
    const ident = 'evcc|http://evcc.local:7070';
    const owned = [{ charger: 'evcc', loadpoint: 1, identity: ident, cmd: 'limit', confirmed: true, gridCap: false, dvhubModes: ['now'],
      phasesForeign: { found: 1, expected: 3, since: '2026-11-16T21:00:00Z' } }];
    const h = harness2({ owned, lpExtra: { phasesConfigured: 1, phasesActive: 1 } });
    await h.bridge.setOverride({ kind: 'charge', powerW: BOX_W });
    const amps = h.calls.filter((c) => c[0] === 'maxcurrent').map((c) => c[1]);
    assert.ok(amps.length && amps.every((a) => a <= 20), JSON.stringify(h.calls));
  });
});

describe('Einphasig unmöglich (Codex d4e3104f)', () => {
  const blocked = { evPhases: 1, evMaxChargeW: 7360, evMinCurrentA: 10, evOnePhaseMaxCurrentA: 8 };

  test('auch ein Stopp-Slot ist hart „aus“ — nie der PV-Modus (evcc lüde einphasig mit Mindeststrom)', async () => {
    const h = harness2({ optimizer: blocked, factors: [0] });
    await h.bridge.tick();
    assert.ok(!h.calls.some((c) => c[0] === 'mode' && c[1] !== 'off'), JSON.stringify(h.calls));
    assert.deepEqual(h.calls.at(-1), ['mode', 'off']);
    h.setFactors([1]);
    await h.bridge.tick({ force: true });
    h.setFactors([0]);
    await h.bridge.tick({ force: true });
    assert.ok(!h.calls.some((c) => c[0] === 'mode' && c[1] !== 'off'), JSON.stringify(h.calls));
  });

  test('„Sofort laden“ blockiert: evcc von außen auf „now“ → nächster Takt setzt wieder „aus“', async () => {
    const h = harness2({ optimizer: blocked });
    await h.bridge.setOverride({ kind: 'charge', powerW: 1840 });
    assert.deepEqual(h.calls.at(-1), ['mode', 'off']);
    h.lp.mode = 'now';
    const n = h.calls.length;
    await h.bridge.tick();
    assert.deepEqual(h.calls.slice(n), [['mode', 'off']], JSON.stringify(h.calls));
  });
});
