// test/peak-shaving-off-unchanged.test.js — Peak Shaving (GitHub #28):
// Aus oder nicht eingerichtet ⇒ jeder Steuerwert bitgenau wie vorher.
//
// Dieselben Abläufe laufen gegen den echten Evaluator mit dem ausgelieferten
// Victron-Profil, einmal ohne peakShaving-Block (Stand vor dem Feature) und
// dann in jeder „wirkt nicht“-Variante. Verglichen wird alles, was auf dem
// Draht landet (Register + Rohwörter), und die erwarteten Werte stehen
// handgerechnet daneben. Die Datei läuft unverändert auch gegen den Stand vor
// dem Feature (dort fehlt der Block ganz) — so ist belegt, dass die Basis
// „heute“ ist.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loadVictronConfig, makeTelemetryState, makeEvaluator, gridSetpointWrites, maxDischargeWrites
} from './helpers/peak-shaving-harness.js';
import { activeWindow } from './helpers/active-window.js';

const BASE = { optimizer: { enabled: true, allowGridCharge: true, allowGridDischarge: true } };
const ON = { enabled: true, gridImportLimitW: 10000, marginW: 300, releaseHysteresisW: 500 };

const VARIANTS = {
  'ohne Block (heute)': () => loadVictronConfig(BASE),
  'Vorgabe aus (enabled:false)': () => loadVictronConfig({ ...BASE, updateChannel: 'dev', peakShaving: { ...ON, enabled: false } }),
  'an, aber Stable-Kanal': () => loadVictronConfig({ ...BASE, peakShaving: ON }),
  'an, Kanal fehlt': () => loadVictronConfig({ ...BASE, updateChannel: '', peakShaving: ON }),
  'an, dev, ohne Grenze': () => loadVictronConfig({ ...BASE, updateChannel: 'dev', peakShaving: { ...ON, gridImportLimitW: null } }),
  'an, dev, Grenze < 1000 W': () => loadVictronConfig({ ...BASE, updateChannel: 'dev', peakShaving: { ...ON, gridImportLimitW: 500 } }),
  'an, dev, anderer Hersteller': () => {
    const cfg = loadVictronConfig({ ...BASE, updateChannel: 'dev', peakShaving: ON });
    cfg.manufacturer = 'fronius';
    return cfg;
  }
};

function eosHoldRule() {
  const now = Date.now();
  return {
    id: 'eos-hold', enabled: true, target: 'gridSetpointW', ...activeWindow(),
    value: 1400, source: 'forecast_optimizer', optimizer: 'eos', closedLoopHold: true,
    slotTs: now - 60000, slotEndTs: now + 600000
  };
}

// Jeder Ablauf: frischer Zustand, frischer Evaluator. Ergebnis = Drahtprotokoll.
const SCENARIOS = {
  // Netzladen 12 kW bei 3 kW Last → 12 000 W
  gridCharge: async (cfg) => {
    const h = makeEvaluator({ cfg, state: makeTelemetryState({ loadW: 3000 }) });
    await h.evaluator.applyControlTarget('gridSetpointW', 12000, 'rule:charge');
    return h.transport;
  },
  // Dauer-Sollwert 15 kW → 15 000 W
  manualPersistent: async (cfg) => {
    const h = makeEvaluator({ cfg, state: makeTelemetryState() });
    await h.evaluator.applyControlTarget('gridSetpointW', 15000, 'manual_override_persistent');
    return h.transport;
  },
  // EOS „Akku halten“: 15 000 − 0 − 300 = 14 700 W
  eosHold: async (cfg) => {
    const state = makeTelemetryState({ soc: 60, loadW: 15000, importW: 15000 });
    state.schedule.rules = [eosHoldRule()];
    const h = makeEvaluator({ cfg, state });
    await h.evaluator.evaluateSchedule();
    return h.transport;
  },
  // Verkauf −5 kW → −5 000 W
  sell: async (cfg) => {
    const h = makeEvaluator({ cfg, state: makeTelemetryState() });
    await h.evaluator.applyControlTarget('gridSetpointW', -5000, 'rule:sell');
    return h.transport;
  },
  // SoC veraltet, 12 kW Netzladen bei 11 kW Last → 12 000 W
  staleSoc: async (cfg) => {
    const h = makeEvaluator({ cfg, state: makeTelemetryState({ loadW: 11000, socAgeMs: 200000 }) });
    await h.evaluator.applyControlTarget('gridSetpointW', 12000, 'rule:charge');
    return h.transport;
  },
  // Akku gesperrt (2704 = 0), Bezug 14 kW über drei Takte: nur die Sperre selbst.
  dischargeBlocked: async (cfg) => {
    const state = makeTelemetryState({ soc: 60, loadW: 14000, importW: 14000 });
    const h = makeEvaluator({ cfg, state });
    await h.evaluator.applyControlTarget('maxDischargeW', 0, 'api_manual_write');
    for (let i = 0; i < 3; i += 1) await h.evaluator.evaluateSchedule();
    return h.transport;
  }
};

const EXPECTED = {
  gridCharge: { grid: [12000], maxDischarge: [] },
  manualPersistent: { grid: [15000], maxDischarge: [] },
  eosHold: { grid: [14700], maxDischarge: [] },
  sell: { grid: [-5000], maxDischarge: [] },
  staleSoc: { grid: [12000], maxDischarge: [] },
  dischargeBlocked: { grid: [], maxDischarge: [0] }
};

for (const [name, run] of Object.entries(SCENARIOS)) {
  test(`aus/nicht eingerichtet: ${name} — Drahtprotokoll in jeder Variante wie heute`, async () => {
    const baseline = await run(VARIANTS['ohne Block (heute)']());
    assert.deepEqual(gridSetpointWrites(baseline), EXPECTED[name].grid, 'Basis handgerechnet');
    assert.deepEqual(maxDischargeWrites(baseline), EXPECTED[name].maxDischarge, 'Basis handgerechnet');
    for (const [variant, makeCfg] of Object.entries(VARIANTS)) {
      const t = await run(makeCfg());
      assert.deepEqual(t.writes, baseline.writes, `${variant}: anderes Drahtprotokoll als heute`);
    }
  });
}
