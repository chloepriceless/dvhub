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
  const ctl = { capW, failCurrent: false, failPhases: false, staleTelemetry: false };
  const lp = { id: 1, mode: 'off', connected: true, charging: false, phases1p3p, phasesActive: 3 };
  const fakeEvcc = {
    getStatus: () => ({ url: 'http://evcc.local:7070' }),
    getLoadpoints: () => [lp],
    setMaxCurrent: async (id, a) => { calls.push(['maxcurrent', a]); return ctl.failCurrent ? { ok: false, error: 'HTTP 500' } : { ok: true }; },
    setMode: async (id, m) => { calls.push(['mode', m]); lp.mode = m; return { ok: true }; },
    setPhases: async (id, n) => { calls.push(['phases', n]); if (ctl.failPhases) return { ok: false, error: 'HTTP 500' }; if (!ctl.staleTelemetry) lp.phasesActive = n; return { ok: true }; },
  };
  const cfg = { evcc: { url: 'http://evcc.local:7070' }, optimizer: { eosOptimizeEv: true, evEvccControl: true, evEvccLoadpoint: 1, evMaxChargeW: 11000, evPhases: 3, ...extra } };
  let clock = T0 + 60_000;
  let sol = factors;
  const bridge = createEosEvccBridge({
    getCfg: () => cfg,
    getSolution: async () => ({ generatedAt: '2026-11-16T21:58:00Z', slotMinutes: 15, rows: sol.map((f, i) => ({ ts_utc: new Date(T0 + i * Q).toISOString(), evChargeFactor: f, evSocPct: 50 })) }),
    getCharger: (c, bc) => createEvccAdapter(fakeEvcc, () => bc.loadpoint, () => bc.stopMode),
    getEvccLoadpoints: () => [lp],
    getGridCapW: () => ctl.capW,
    now: () => clock,
  });
  return { bridge, calls, cfg, lp, ctl, advance: (ms) => { clock += ms; }, setFactors: (f) => { sol = f; } };
}

describe('Brücke: einphasig bei kleiner Leistung', () => {
  test('evcc mit 1p3p: 2,75 kW → eine Phase, 12 A; danach volle Leistung → drei Phasen, 16 A', async () => {
    const h = harness({ factors: [0.25, 1] });
    await h.bridge.tick();
    assert.deepEqual(h.calls, [['phases', 1], ['maxcurrent', 12], ['mode', 'now']]);
    h.advance(Q);
    await h.bridge.tick();
    // mehr Phasen: erst der Strom (bestätigt), dann umschalten, dann laden
    assert.deepEqual(h.calls.slice(3), [['maxcurrent', 16], ['phases', 3], ['maxcurrent', 16], ['mode', 'now']]);
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

describe('Codex 52c5ee20: Phasen zurück und je Ladepunkt', () => {
  test('nach einphasigem Slot: „Sofort laden“ schaltet erst wieder auf drei Phasen', async () => {
    const h = harness({ factors: [0.25, 0.25] });
    await h.bridge.tick();
    assert.deepEqual(h.calls.slice(0, 1), [['phases', 1]]);
    const r = await h.bridge.setOverride({ powerW: 11000 });
    assert.equal(r.ok, true, JSON.stringify(r));
    const after = h.calls.slice(3);
    // erst der Strom (einphasig bestätigt), dann drei Phasen, dann laden
    assert.deepEqual(after.slice(0, 2), [['maxcurrent', 16], ['phases', 3]], JSON.stringify(after));
    assert.ok(after.slice(2).some((c) => c[0] === 'maxcurrent' && c[1] === 16));
  });

  test('Umschaltung abgeschaltet: der nächste Ladebefehl stellt drei Phasen wieder her', async () => {
    const h = harness({ factors: [0.25, 0.25] });
    await h.bridge.tick();
    h.cfg.optimizer.evPhaseSwitch = false;
    h.advance(Q);
    await h.bridge.tick();
    assert.deepEqual(h.calls.slice(3, 5), [['maxcurrent', 6], ['phases', 3]], JSON.stringify(h.calls));
  });
});

test('Codex 52c5ee20: Ladepunkt gewechselt — gemerkte Phasen gelten nur für den alten', async () => {
  const calls = [];
  const lps = [1, 2].map((id) => ({ id, mode: 'off', connected: true, charging: false, phases1p3p: true, phasesActive: 3 }));
  const fakeEvcc = {
    getStatus: () => ({ url: 'http://evcc.local:7070' }),
    getLoadpoints: () => lps,
    setMaxCurrent: async (id, a) => { calls.push(['maxcurrent', id, a]); return { ok: true }; },
    setMode: async (id, m) => { calls.push(['mode', id, m]); return { ok: true }; },
    setPhases: async (id, n) => { calls.push(['phases', id, n]); lps[id - 1].phasesActive = n; return { ok: true }; },
  };
  const cfg = { evcc: { url: 'http://evcc.local:7070' }, optimizer: { eosOptimizeEv: true, evEvccControl: true, evEvccLoadpoint: 1, evMaxChargeW: 11000, evPhases: 3 } };
  let clock = T0 + 60_000;
  const bridge = createEosEvccBridge({
    getCfg: () => cfg,
    getSolution: async () => ({ generatedAt: 'x', slotMinutes: 15, rows: [0, 1].map((i) => ({ ts_utc: new Date(T0 + i * Q).toISOString(), evChargeFactor: 0.25, evSocPct: 50 })) }),
    getCharger: (c, bc) => createEvccAdapter(fakeEvcc, () => bc.loadpoint, () => bc.stopMode),
    getEvccLoadpoints: () => lps,
    now: () => clock,
  });
  await bridge.tick();
  assert.deepEqual(calls[0], ['phases', 1, 1]);
  cfg.optimizer.evEvccLoadpoint = 2;
  clock += Q;
  await bridge.tick();
  assert.ok(calls.some((c) => c[0] === 'phases' && c[1] === 2 && c[2] === 1), JSON.stringify(calls));
});

describe('Codex 42a5d784: Reihenfolge und Phasenzahl', () => {
  test('Grenze kommt bei einphasigem Laden: erst kleinerer Strom, schlägt er fehl, bleibt es einphasig', async () => {
    const h = harness({ factors: [0.25, 0.25] });
    await h.bridge.tick();
    h.ctl.capW = 4140;
    h.ctl.failCurrent = true;
    h.advance(Q);
    await h.bridge.tick();
    const after = h.calls.slice(3);
    assert.ok(!after.some((c) => c[0] === 'phases' && c[1] === 3), JSON.stringify(after));
  });

  test('Wallbox einphasig eingestellt (evPhases 1): keine Umschaltung auf drei Phasen', async () => {
    const h = harness({ factors: [0.25, 1] });
    await h.bridge.tick();
    h.cfg.optimizer.evPhases = 1;
    h.cfg.optimizer.evMaxChargeW = 3680;
    h.advance(Q);
    await h.bridge.tick();
    assert.ok(!h.calls.slice(3).some((c) => c[0] === 'phases' && c[1] === 3), JSON.stringify(h.calls));
  });

  // Nur die aktiven Phasen (Messwert) melden wieder drei, die Einstellung
  // (phasesConfigured) fehlt in der Meldung: im Zweifel erneut setzen. Ist die
  // Einstellung von außen geändert, stellt DVhub die Phasen dagegen für diesen
  // Ladevorgang nicht mehr ein (test/ev-wochenplan-rest.test.js).
  test('evcc meldet wieder drei aktive Phasen (Einstellung unbekannt): nächster einphasiger Slot schaltet erneut', async () => {
    const h = harness({ factors: [0.25, 0.3] });
    await h.bridge.tick();
    h.lp.phasesActive = 3;
    h.advance(Q);
    await h.bridge.tick();
    assert.ok(h.calls.slice(3).some((c) => c[0] === 'phases' && c[1] === 1), JSON.stringify(h.calls));
  });
});

describe('Codex 1c280569: veraltete Meldung und halber Übergang', () => {
  test('Sofort laden kurz an und aus, evcc meldet noch eine Phase: Plan schaltet trotzdem wieder auf eine', async () => {
    const h = harness({ factors: [0.25, 0.25] });
    await h.bridge.tick();
    h.ctl.staleTelemetry = true;
    assert.equal((await h.bridge.setOverride({ powerW: 11000 })).ok, true);
    const n = h.calls.length;
    // Beenden stellt sofort den Plan wieder her (einphasiger Slot).
    await h.bridge.clearOverride();
    assert.ok(h.calls.slice(n).some((c) => c[0] === 'phases' && c[1] === 1), JSON.stringify(h.calls.slice(n)));
  });

  test('Strom gesenkt, Umschaltung scheitert, Grenze weg: der alte Befehl wird neu gesendet', async () => {
    const h = harness({ factors: [0.25, 0.25, 0.25] });
    await h.bridge.tick();
    h.ctl.capW = 4140;
    h.ctl.failPhases = true;
    h.advance(Q);
    await h.bridge.tick();
    h.ctl.capW = null;
    h.ctl.failPhases = false;
    const n = h.calls.length;
    h.advance(60_000);
    await h.bridge.tick();
    assert.ok(h.calls.slice(n).some((c) => c[0] === 'maxcurrent' && c[1] === 12), JSON.stringify(h.calls.slice(n)));
  });
});

test('Codex d31e5119: auf drei Phasen auch bei veralteter Meldung erst den Strom — scheitert er, bleibt es einphasig', async () => {
  const h = harness({ factors: [0.25, 0.4] });
  h.ctl.staleTelemetry = true;
  await h.bridge.tick();
  assert.deepEqual(h.calls[0], ['phases', 1]);
  h.ctl.failCurrent = true;
  const n = h.calls.length;
  h.advance(Q);
  await h.bridge.tick();
  assert.ok(!h.calls.slice(n).some((c) => c[0] === 'phases' && c[1] === 3), JSON.stringify(h.calls.slice(n)));
});
