// test/ev-r5-schutzbedingungen.test.js -- Fable R5 P3-5: vier Schutzbedingungen,
// die sich ohne roten Test entfernen ließen (Mutationsproben), jetzt je mit
// einem gezielten Test:
//   1. restorePhases: kein Phasenbefehl, wenn der Not-Halt während des Stopps kam.
//   2. restorePhases: Wartezeit EV_PHASE_SETTLE_MS — keine Rückkehr auf Grundlage
//      einer evcc-Meldung, die den eigenen Phasenbefehl noch nicht zeigt.
//   3. neutralizePhases: nur nach DVhubs eigenem Stopp (nicht bei reiner
//      Phasen-Buchführung).
//   4. ev-targets: Wertgrundlage höchstens 3 h alt.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createEosEvccBridge, EV_PHASE_SETTLE_MS } from '../services/optimizer/eos-evcc-bridge.js';
import { createEvccAdapter } from '../services/wallbox/adapters.js';
import { resolveEvTargets, buildEvValueInputs, EV_VALUE_INPUTS_MAX_AGE_MS, _test } from '../services/optimizer/ev-targets.js';

const T0 = Date.parse('2026-11-16T22:00:00Z');
const Q = 15 * 60_000;

function harness({ factors = [0.25, 0, 0, 0], configured = 0, owned = null, lpMode = 'pv' } = {}) {
  const calls = [];
  const ctl = { paused: false, saved: owned, staleConfigured: false, onMode: null };
  const lp = { id: 1, mode: lpMode, connected: true, charging: false, phases1p3p: true, phasesConfigured: configured, phasesActive: configured === 0 ? 3 : configured };
  const fakeEvcc = {
    getStatus: () => ({ url: 'http://evcc.local:7070' }),
    getLoadpoints: () => [{ ...lp }],
    refresh: async () => true,
    setMaxCurrent: async (id, a) => { calls.push(['maxcurrent', a]); return { ok: true }; },
    setMode: async (id, m) => { calls.push(['mode', m]); lp.mode = m; ctl.onMode?.(m); return { ok: true }; },
    setPhases: async (id, n) => { calls.push(['phases', n]); if (!ctl.staleConfigured) lp.phasesConfigured = n; lp.phasesActive = n === 0 ? 3 : n; return { ok: true }; },
  };
  const cfg = { evcc: { url: 'http://evcc.local:7070' }, optimizer: { eosOptimizeEv: true, evEvccControl: true, evEvccLoadpoint: 1, evMaxChargeW: 11000, evPhases: 3, evStopMode: 'pv' } };
  let clock = T0 + 60_000;
  let sol = factors;
  const bridge = createEosEvccBridge({
    getCfg: () => cfg,
    getSolution: async () => ({ generatedAt: '2026-11-16T21:58:00Z', slotMinutes: 15, rows: sol.map((f, i) => ({ ts_utc: new Date(T0 + i * Q).toISOString(), evChargeFactor: f, evSocPct: 50 })) }),
    getCharger: (c, bc) => createEvccAdapter(fakeEvcc, () => bc.loadpoint, () => bc.stopMode),
    getEvccLoadpoints: () => [{ ...lp }],
    getGridCapW: () => null,
    isPaused: () => ctl.paused,
    loadOwned: () => ctl.saved,
    saveOwned: (list) => { ctl.saved = list; },
    now: () => clock,
  });
  return { bridge, calls, ctl, lp, advance: (ms) => { clock += ms; }, setFactors: (f) => { sol = f; } };
}
const phaseCalls = (calls) => calls.filter((c) => c[0] === 'phases');

describe('Fable R5 P3-5: Phasen-Rückkehr', () => {
  test('1: Not-Halt kommt während des Stopp-Befehls → danach kein Phasenbefehl', async () => {
    const h = harness();
    await h.bridge.tick();
    assert.deepEqual(h.calls, [['phases', 1], ['maxcurrent', 12], ['mode', 'now']]);
    h.advance(Q);
    // Der Not-Halt kommt genau, während evcc den Stopp quittiert.
    h.ctl.onMode = (m) => { if (m === 'pv') h.ctl.paused = true; };
    const n = h.calls.length;
    await h.bridge.tick();
    assert.deepEqual(h.calls.slice(n), [['mode', 'pv']], 'nur der Stopp, keine Phasen danach');
  });

  test('2: Rückkehr erst nach der Wartezeit — eine Meldung ohne den eigenen Phasenbefehl gilt nicht als „schon zurück“', async () => {
    const h = harness({ factors: [0.25, 0.25, 0.25, 0.25] });
    h.ctl.staleConfigured = true; // evcc meldet die neue Einstellung erst später
    await h.bridge.tick();
    assert.deepEqual(phaseCalls(h.calls), [['phases', 1]]);
    // 30 s später: neuer Plan ohne Ladung, evcc meldet noch „automatisch“ (0).
    h.advance(30_000);
    h.setFactors([0, 0, 0, 0]);
    await h.bridge.tick();
    // Jetzt kommt die echte Einstellung (1) an; nach der Wartezeit muss DVhub zurückstellen.
    h.lp.phasesConfigured = 1;
    h.ctl.staleConfigured = false;
    for (let t = 0; t < EV_PHASE_SETTLE_MS + 60_000; t += 30_000) { h.advance(30_000); await h.bridge.tick(); }
    assert.deepEqual(phaseCalls(h.calls), [['phases', 1], ['phases', 0]], 'zurück auf automatisch');
    assert.equal(h.lp.phasesConfigured, 0);
  });

  test('3: Not-Halt ohne DVhubs eigenen Stopp (nur Phasen-Buchführung) → keine Phasen', async () => {
    const owned = [{
      charger: 'evcc', loadpoint: 1, identity: 'evcc|http://evcc.local:7070', cmd: 'limit', confirmed: true, gridCap: false,
      dvhubModes: ['now', 'pv'], phases: 1, phasesTried: 1, phasesAt: '2026-11-16T20:00:00.000Z', phasesPrev: 0, phasesForeign: null,
    }];
    const h = harness({ configured: 1, owned, lpMode: 'pv' });
    h.ctl.paused = true;
    await h.bridge.emergencyStop();
    assert.deepEqual(phaseCalls(h.calls), [], JSON.stringify(h.calls));
  });
});

describe('Fable R5 P3-5: Wertgrundlage höchstens 3 h alt', () => {
  const TZ = 'Europe/Berlin';
  const SLOT = 15 * 60_000;
  const NOW = Date.parse('2026-11-16T19:00:00Z');
  const PLAN = [
    { day: 1, arrival: '18:00', departure: '07:00', minSocPct: 50, tripSocPct: 30 },
    { day: 2, arrival: '18:00', departure: '07:00', minSocPct: 50, tripSocPct: 30 },
  ];
  const cfg = { schedule: { timezone: TZ }, optimizer: { eosOptimizeEv: true, evCapacityWh: 75000, evMaxChargeW: 11000, evDepartureEnabled: true, evTargetMode: 'percent', evTargetValue: 80, evWeeklyPlan: PLAN, evMaxSocPct: 80, evValueMarginCt: 1 } };
  function inputs(builtAtMs) {
    const priceSlots = [];
    const base = Math.floor(builtAtMs / SLOT) * SLOT;
    for (let i = 0; i < 10 * 96; i += 1) {
      const ms = base + i * SLOT;
      const h = new Date(ms).getUTCHours();
      priceSlots.push({ start: new Date(ms).toISOString(), end: new Date(ms + SLOT).toISOString(), ctKwh: h >= 22 || h < 4 ? 2 : 14 });
    }
    return buildEvValueInputs({ priceSlots, importCtOf: (s) => 1.2252 * s.ctKwh + 15.98, feedInCtOf: (s) => s.ctKwh + 3.052, pvSlots: [], loadSlots: [], nowMs: builtAtMs, timeZone: TZ });
  }
  const run = (builtAtMs) => {
    _test.resetMemo();
    return resolveEvTargets({ state: { optimizer: { eosControlHorizonH: 36, evValueInputs: inputs(builtAtMs) } } }, cfg, { decision: { mode: 'plugged', socPct: 46.7 }, valueSupported: true, nowMs: NOW });
  };

  test('4: frische Grundlage gibt Wertstufen, eine über 3 h alte nicht', () => {
    assert.equal(EV_VALUE_INPUTS_MAX_AGE_MS, 3 * 3600_000);
    const fresh = run(NOW - 3600_000);
    assert.ok(Array.isArray(fresh.steps) && fresh.steps.length > 0, JSON.stringify(fresh));
    const old = run(NOW - EV_VALUE_INPUTS_MAX_AGE_MS - 60_000);
    assert.deepEqual(old.steps, []);
    assert.equal(old.reason, 'noch keine Preise/PV für die Wertbestimmung');
  });
});
