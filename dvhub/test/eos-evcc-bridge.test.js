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

function harness({ config = cfg(), sol = solution([0.5, 0, 1]), failMode = false, liveMode = undefined } = {}) {
  let clock = T0 + 60_000;
  let currentCfg = config;
  let currentSol = sol;
  const calls = [];
  const logs = [];
  // Live-Modus des Ladepunkts, wie evcc-integration ihn meldet (null = kein
  // Ladepunkt bekannt → status() scheitert, keine Modus-Pruefung).
  let lpMode = liveMode;
  const fakeEvcc = {
    getStatus: () => ({ url: currentCfg?.evcc?.url || null }),
    getLoadpoints: () => (lpMode === undefined ? [] : [{ id: 2, mode: lpMode, connected: true, charging: false }]),
    setMaxCurrent: async (lp, a) => { calls.push(['maxcurrent', lp, a]); return { ok: true }; },
    setMode: async (lp, m) => {
      calls.push(['mode', lp, m]);
      if (failMode) return { ok: false, error: 'HTTP 500' };
      if (lpMode !== undefined) lpMode = m;
      return { ok: true };
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
    setSol: (s) => { currentSol = s; },
    setLiveMode: (m) => { lpMode = m; }
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

  test('Plan: Faktor > 0 laden, 0 stoppen, fehlend = keine Slot-Aktion', () => {
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

  test('EOS plant kein E-Auto (Faktor fehlt): Stopp — evcc laedt nicht auf eigene Faust', async () => {
    const h = harness({ sol: solution([null]) });
    const r = await h.bridge.tick();
    assert.equal(r.ok, true);
    assert.deepEqual(h.calls, [['mode', 2, 'off']]);
    assert.match(h.bridge.getStatus().lastError, /E-Auto/);
    h.advance(30_000);
    await h.bridge.tick();
    assert.equal(h.calls.length, 1, 'Stopp nur einmal');
  });

  test('evcc von aussen umgestellt (z.B. „smart“) → unser Modus wird erneut gesetzt', async () => {
    const h = harness({ sol: solution([0, 0, 0]), liveMode: 'off' });
    await h.bridge.tick();
    assert.deepEqual(h.calls, [['mode', 2, 'off']]);
    h.advance(30_000);
    await h.bridge.tick();
    assert.equal(h.calls.length, 1, 'Modus stimmt → nichts senden');
    h.setLiveMode(null); // evcc meldet einen DVhub unbekannten Modus
    h.advance(30_000);
    await h.bridge.tick();
    assert.deepEqual(h.calls.at(-1), ['mode', 2, 'off']);
    assert.ok(h.logs.some((l) => l.event === 'eos_evcc_mode_corrected' && l.data.found === null));
    h.setLiveMode('now');
    h.advance(30_000);
    await h.bridge.tick();
    assert.equal(h.calls.length, 3);
    assert.deepEqual(h.calls.at(-1), ['mode', 2, 'off']);
  });

  test('Plan verloren, waehrend wir Laden befohlen haben → Stopp erst, wenn der letzte Plan ausgelaufen ist', async () => {
    const h = harness({ sol: solution([1]) }); // ein Lade-Slot T0 … T0+15 min
    await h.bridge.tick();
    assert.deepEqual(h.calls.at(-1), ['mode', 2, 'now']);
    h.setSol(null); // EOS nicht abrufbar
    h.advance(30_000);
    await h.bridge.tick();
    assert.equal(h.calls.length, 2, 'noch im gueltigen Slot: kein Stopp');
    h.advance(Q); // Slot vorbei, kein neuer Plan
    await h.bridge.tick();
    assert.deepEqual(h.calls.at(-1), ['mode', 2, 'off']);
    assert.ok(h.logs.some((l) => l.event === 'eos_evcc_plan_lost'));
    // Und nur einmal — danach steht der Stopp.
    h.advance(30_000);
    await h.bridge.tick();
    assert.equal(h.calls.length, 3);
  });

  test('EOS antwortet waehrend eines Rechenlaufs zeitweise nicht → kein An/Aus-Flattern', async () => {
    // Prod 2026-09-28: Abruf scheiterte jeden 2. Takt (Timeout waehrend GA-Lauf),
    // die Bruecke schickte abwechselnd Laden/Stopp im Minutentakt.
    const h = harness({ sol: solution([0.5, 0.5, 0.5, 0.5]) });
    await h.bridge.tick();
    assert.deepEqual(h.calls, [['maxcurrent', 2, 8], ['mode', 2, 'now']]);
    const good = solution([0.5, 0.5, 0.5, 0.5]);
    for (let i = 0; i < 8; i++) {
      h.setSol(i % 2 ? good : null);
      h.advance(30_000);
      await h.bridge.tick();
    }
    assert.equal(h.calls.length, 2, `keine weiteren Befehle, bekam: ${JSON.stringify(h.calls.slice(2))}`);
    assert.ok(!h.logs.some((l) => l.event === 'eos_evcc_plan_lost'));
    assert.ok(h.logs.some((l) => l.event === 'eos_evcc_plan_fallback'), 'Rueckfall wird protokolliert');
  });

  test('Rueckfall auf den letzten Plan hoechstens 60 min nach dem letzten erfolgreichen Abruf', async () => {
    const h = harness({ sol: solution(new Array(16).fill(1)) }); // 4 h Laden geplant
    await h.bridge.tick();
    assert.deepEqual(h.calls.at(-1), ['mode', 2, 'now']);
    h.setSol(null); // EOS dauerhaft weg
    h.advance(59 * 60_000);
    await h.bridge.tick();
    assert.equal(h.calls.length, 2, 'nach 59 min gilt der Plan noch');
    h.advance(2 * 60_000);
    await h.bridge.tick();
    assert.deepEqual(h.calls.at(-1), ['mode', 2, 'off'], 'nach 61 min: kein stundenalter Plan mehr');
  });

  test('Neuer EOS-Plan ohne Slot fuer jetzt ist eine echte Entscheidung → sofort Stopp', async () => {
    const h = harness({ sol: solution([1, 1, 1, 1]) });
    await h.bridge.tick();
    assert.deepEqual(h.calls.at(-1), ['mode', 2, 'now']);
    // EOS hat neu gerechnet: Plan beginnt erst in 2 h (kein Slot fuer jetzt).
    h.setSol(solution([1, 1], { start: T0 + 8 * Q, generatedAt: '2026-09-22T10:05:00Z' }));
    h.advance(30_000);
    await h.bridge.tick();
    assert.deepEqual(h.calls.at(-1), ['mode', 2, 'off']);
  });

  test('Leere EOS-Loesung (z. B. direkt nach EOS-Neustart) verwirft den gueltigen Plan nicht', async () => {
    const h = harness({ sol: solution([1, 1]) });
    await h.bridge.tick();
    h.setSol({ generatedAt: null, slotMinutes: 15, rows: [] });
    h.advance(30_000);
    await h.bridge.tick();
    assert.equal(h.calls.length, 2, 'kein Stopp');
    const st = h.bridge.getStatus();
    assert.match(String(st.lastError || ''), /letzter Plan gilt weiter/);
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
