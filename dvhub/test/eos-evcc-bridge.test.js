// test/eos-evcc-bridge.test.js -- EOS → evcc: E-Auto-Plan an den Ladepunkt.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createEosEvccBridge, buildEvPlan, powerToCurrentA, resolveEvccBridgeConfig, slotAt
} from '../services/optimizer/eos-evcc-bridge.js';
import { createEvccAdapter } from '../services/wallbox/adapters.js';

const T0 = Date.parse('2026-09-22T10:00:00Z');
const Q = 15 * 60_000;

function cfg(extra = {}) {
  return {
    evcc: { url: 'http://evcc.local:7070' },
    optimizer: {
      eosOptimizeEv: true, evEvccControl: true, evEvccLoadpoint: 2,
      evMaxChargeW: 11000, evPhases: 3, ...extra
    }
  };
}

function solution(factors, { generatedAt = '2026-09-22T09:58:00Z', start = T0 } = {}) {
  return {
    generatedAt,
    slotMinutes: 15,
    rows: factors.map((f, i) => ({
      ts_utc: new Date(start + i * Q).toISOString(),
      evChargeFactor: f,
      evSocPct: 40 + i
    }))
  };
}

function harness({ config = cfg(), sol = solution([0.5, 0, 1]), failMode = false } = {}) {
  let clock = T0 + 60_000;
  let currentCfg = config;
  let currentSol = sol;
  const calls = [];
  const logs = [];
  const fakeEvcc = {
    getStatus: () => ({ url: currentCfg?.evcc?.url || null }),
    setMaxCurrent: async (lp, a) => { calls.push(['maxcurrent', lp, a]); return { ok: true }; },
    setMode: async (lp, m) => {
      calls.push(['mode', lp, m]);
      return failMode ? { ok: false, error: 'HTTP 500' } : { ok: true };
    }
  };
  const bridge = createEosEvccBridge({
    getCfg: () => currentCfg,
    getSolution: async () => currentSol,
    getCharger: (cfg, bc) => createEvccAdapter(fakeEvcc, () => bc.loadpoint, () => bc.stopMode),
    pushLog: (event, data) => logs.push({ event, data }),
    now: () => clock
  });
  return {
    bridge, calls, logs,
    advance: (ms) => { clock += ms; },
    setCfg: (c) => { currentCfg = c; },
    setSol: (s) => { currentSol = s; }
  };
}

describe('eos-evcc-bridge: Umrechnung', () => {
  test('Faktor × max. Ladeleistung → Strom je Phase, begrenzt auf min/max', () => {
    const bc = resolveEvccBridgeConfig(cfg());
    assert.equal(bc.loadpoint, 2);
    assert.equal(Math.round(bc.maxCurrentA * 10) / 10, 15.9); // 11 kW ÷ (230 V × 3)
    assert.equal(powerToCurrentA(5500, bc), 8);
    assert.equal(powerToCurrentA(1100, bc), 6, 'unter dem Mindeststrom → Mindeststrom');
    assert.equal(powerToCurrentA(20000, bc), 15.9, 'nie mehr als EOS kennt');
    const one = resolveEvccBridgeConfig(cfg({ evPhases: 1, evMaxChargeW: 3680 }));
    assert.equal(powerToCurrentA(3680, one), 16);
  });

  test('Plan: Faktor > 0 laden, 0 stoppen, fehlend = kein Befehl', () => {
    const bc = resolveEvccBridgeConfig(cfg());
    const plan = buildEvPlan(solution([0.5, 0, null]), bc);
    assert.deepEqual(plan.map((s) => s.action), ['charge', 'stop', null]);
    assert.equal(plan[0].chargePowerW, 5500);
    assert.equal(plan[0].currentA, 8);
    assert.equal(plan[1].currentA, null);
    assert.equal(slotAt(plan, T0 + Q + 1).action, 'stop');
    assert.equal(slotAt(plan, T0 + 10 * Q), null);
  });

  test('aus, solange E-Auto-Optimierung ODER evcc-Steuerung aus ist', () => {
    assert.equal(resolveEvccBridgeConfig(cfg({ evEvccControl: false })).enabled, false);
    assert.equal(resolveEvccBridgeConfig(cfg({ eosOptimizeEv: false })).enabled, false);
    assert.equal(resolveEvccBridgeConfig({}).enabled, false);
  });
});

describe('eos-evcc-bridge: Steuern', () => {
  test('Laden: erst Strom, dann Modus now — und nur bei einem Wechsel', async () => {
    const h = harness();
    const r = await h.bridge.tick();
    assert.equal(r.ok, true);
    assert.deepEqual(h.calls, [['maxcurrent', 2, 8], ['mode', 2, 'now']]);

    // Gleicher Slot, gleicher Befehl → nichts schreiben.
    h.advance(30_000);
    assert.equal((await h.bridge.tick()).unchanged, true);
    assert.equal(h.calls.length, 2);

    // Naechster Slot: Stopp.
    h.advance(Q);
    await h.bridge.tick();
    assert.deepEqual(h.calls.at(-1), ['mode', 2, 'off']);
    // Danach volle Leistung.
    h.advance(Q);
    await h.bridge.tick();
    assert.deepEqual(h.calls.slice(-2), [['maxcurrent', 2, 15.9], ['mode', 2, 'now']]);
  });

  test('Stopp-Modus ist einstellbar (pv laesst evcc Ueberschuss nachladen)', async () => {
    const h = harness({ config: cfg({ evStopMode: 'pv' }), sol: solution([0]) });
    await h.bridge.tick();
    assert.deepEqual(h.calls, [['mode', 2, 'pv']]);
  });

  test('apply sendet den laufenden Befehl erneut, auch unveraendert', async () => {
    const h = harness();
    await h.bridge.tick();
    await h.bridge.apply();
    assert.equal(h.calls.length, 4);
  });

  test('ausgeschaltet oder ohne evcc-URL: kein Schreibzugriff', async () => {
    const h = harness({ config: cfg({ evEvccControl: false }) });
    assert.equal((await h.bridge.tick()).skipped, 'disabled');
    h.setCfg({ ...cfg(), evcc: { url: '' } });
    assert.equal((await h.bridge.tick()).skipped, 'evcc not configured');
    assert.equal(h.calls.length, 0);
  });

  test('EOS plant kein E-Auto (Faktor fehlt): nichts schreiben', async () => {
    const h = harness({ sol: solution([null]) });
    const r = await h.bridge.tick();
    assert.equal(r.ok, false);
    assert.match(r.skipped, /E-Auto/);
    assert.equal(h.calls.length, 0);
  });

  test('Plan verloren, waehrend wir Laden befohlen haben → Stopp', async () => {
    const h = harness({ sol: solution([1]) });
    await h.bridge.tick();
    assert.deepEqual(h.calls.at(-1), ['mode', 2, 'now']);
    h.setSol(null); // EOS weg
    h.advance(30_000);
    await h.bridge.tick();
    assert.deepEqual(h.calls.at(-1), ['mode', 2, 'off']);
    assert.ok(h.logs.some((l) => l.event === 'eos_evcc_plan_lost'));
    // Und nur einmal — danach steht der Stopp.
    h.advance(30_000);
    await h.bridge.tick();
    assert.equal(h.calls.length, 3);
  });

  test('Fehler von evcc: Befehl gilt als nicht gesendet, naechster Takt versucht erneut', async () => {
    const h = harness({ failMode: true, sol: solution([0]) });
    const r = await h.bridge.tick();
    assert.equal(r.ok, false);
    assert.equal(h.bridge.getStatus().lastSent, null);
    h.advance(30_000);
    await h.bridge.tick();
    assert.equal(h.calls.length, 2, 'erneuter Versuch');
  });

  test('Status zeigt laufenden Slot, letzten Befehl und die naechsten 24 h', async () => {
    const h = harness();
    await h.bridge.tick();
    const st = h.bridge.getStatus();
    assert.equal(st.enabled, true);
    assert.equal(st.evccUrlSet, true);
    assert.equal(st.current.action, 'charge');
    assert.equal(st.lastSent.currentA, 8);
    assert.equal(st.plan.length, 3);
    assert.equal(st.solutionGeneratedAt, '2026-09-22T09:58:00Z');
  });
});
