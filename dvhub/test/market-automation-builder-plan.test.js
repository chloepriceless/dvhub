// test/market-automation-builder-plan.test.js — Regel-Erzeuger der Kleinen
// Börsenautomatik am echten Ablauf (2026-10-15, Wartung: 60 % Zeilen,
// 44 % Funktionen getestet; die Regeln steuern den Akku).
//
// Von Hand gerechnet (computeAvailableEnergyKwh, small-market-automation.js):
//   10 kWh · (1 − 5 % Sicherheit) = 9,5 kWh nutzbar; SoC 50 % − Reserve 30 %
//   = 20 % → 1,9 kWh (Wirkungsgrad 100 %). Bei −4000 W liefert ein 15-min-Slot
//   1,0 kWh → Kette [−4000 × 2] wird auf 1 Slot gekürzt; die restlichen 0,9 kWh
//   gehen als Teil-Slot −3600 W in den teuersten Slot NACH dem gewählten.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMarketAutomationBuilder } from '../market-automation-builder.js';

const NOW = Date.parse('2026-01-15T12:00:00Z');          // 13:00 Berlin (MEZ, UTC+1)
const at = (hhmmBerlin) => Date.parse(`2026-01-15T${hhmmBerlin}:00+01:00`);
// Preise im Suchfenster 17:00–21:00 (Berlin).
const PRICES = [['17:00', 20], ['17:15', 25], ['17:30', 50], ['17:45', 30], ['18:00', 40], ['18:15', 10]];
const epex = () => PRICES.map(([t, ct]) => ({ ts: at(t), ct_kwh: ct }));

const manual = { id: 'm1', enabled: true, target: 'gridSetpointW', start: '20:00', end: '20:30', value: -500, source: 'manual' };

function setup({ enabled = true, soc = 50, rules = [manual], sunTimes = { cache: {} }, extra = {} } = {}) {
  const state = {
    victron: { soc, minSocPct: 5, pvTotalW: 0 },
    epex: { data: epex() },
    forecast: {},
    optimizer: {},
    schedule: { rules: rules.map((r) => ({ ...r })), smallMarketAutomation: {} },
  };
  const cfg = {
    epex: { timezone: 'Europe/Berlin' },
    optimizer: { enabled: false },
    schedule: {
      timezone: 'Europe/Berlin',
      smallMarketAutomation: {
        enabled, engine: 'greedy', searchWindowStart: '17:00', searchWindowEnd: '21:00',
        batteryCapacityKwh: 10, minSocPct: 30, inverterEfficiencyPct: 100, maxDischargeW: -4000, ...extra,
      },
    },
  };
  let persisted = 0;
  const logs = [];
  const mab = createMarketAutomationBuilder({
    state, getCfg: () => cfg, pushLog: (e, p) => logs.push({ e, p }),
    persistConfig: () => { persisted++; },
    getSunTimesCacheForPlanning: () => sunTimes,
  });
  return { mab, state, cfg, logs, persisted: () => persisted };
}

const sma = (state) => state.schedule.rules.filter((r) => r.source === 'small_market_automation');
const energyKwh = (rules) => rules.reduce((s, r) => s + Math.abs(r.value) / 1000 * 0.25, 0);

describe('Plan erzeugen', () => {
  it('teuerster Slot −4000 W, Rest −3600 W im teuersten Slot danach; Energie = Budget 1,9 kWh', async () => {
    const { mab, state, persisted } = setup();
    await mab.regenerateSmallMarketAutomationRules({ now: NOW, force: true });
    const plan = sma(state).map((r) => [r.start, r.value]);
    assert.deepEqual(plan, [['17:30', -4000], ['18:00', -3600]]);
    assert.equal(Math.round(energyKwh(sma(state)) * 100) / 100, 1.9);
    assert.equal(state.schedule.smallMarketAutomation.lastOutcome, 'generated');
    assert.equal(state.schedule.smallMarketAutomation.availableEnergyKwh, 1.9);
    assert.equal(persisted(), 1);
  });

  it('Regel von Hand bleibt erhalten und steht vor den Automatik-Regeln', async () => {
    const { mab, state } = setup();
    await mab.regenerateSmallMarketAutomationRules({ now: NOW, force: true });
    assert.deepEqual(state.schedule.rules[0], manual);
    assert.equal(state.schedule.rules.filter((r) => r.id === 'm1').length, 1);
  });

  it('von Hand belegtes Fenster (17:15–17:45) wird ausgespart', async () => {
    const busy = { ...manual, id: 'm2', start: '17:15', end: '17:45' };
    const { mab, state } = setup({ rules: [busy] });
    await mab.regenerateSmallMarketAutomationRules({ now: NOW, force: true });
    // ohne 17:15/17:30: teuerster freier Slot 18:00 (40 ct), Rest danach 18:15 (10 ct)
    assert.deepEqual(sma(state).map((r) => [r.start, r.value]), [['18:00', -4000], ['18:15', -3600]]);
  });

  it('Slots in der Vergangenheit werden nicht verplant (jetzt 17:40)', async () => {
    const { mab, state } = setup();
    await mab.regenerateSmallMarketAutomationRules({ now: at('17:40'), force: true });
    // 17:45 (30) ist schon angebrochen? Nein: Slot-Start 17:45 > 17:40 → frei. Teuerster: 18:00 (40); danach 18:15.
    assert.deepEqual(sma(state).map((r) => r.start), ['18:00', '18:15']);
    assert.ok(sma(state).every((r) => r.slotTs >= at('17:40')));
  });

  it('jede Automatik-Regel ist an ihren Slot gebunden (slotTs/slotEndTs, 15 min)', async () => {
    const { mab, state } = setup();
    await mab.regenerateSmallMarketAutomationRules({ now: NOW, force: true });
    for (const r of sma(state)) {
      assert.equal(r.slotEndTs - r.slotTs, 15 * 60_000);
      assert.equal(r.autoManaged, true);
      assert.equal(r.target, 'gridSetpointW');
    }
  });
});

describe('Kein Plan', () => {
  it('SoC = Reserve (30 %) → keine Energie → keine Regeln, alte Automatik-Regeln weg', async () => {
    const old = { id: 'sma-1-1', source: 'small_market_automation', target: 'gridSetpointW', value: -4000, start: '17:00', end: '17:15', slotTs: at('17:00') - 86_400_000, slotEndTs: at('17:15') - 86_400_000 };
    const { mab, state } = setup({ soc: 30, rules: [manual, old] });
    await mab.regenerateSmallMarketAutomationRules({ now: NOW, force: true });
    assert.deepEqual(sma(state), []);
    assert.equal(state.schedule.smallMarketAutomation.lastOutcome, 'no_slots');
    assert.deepEqual(state.schedule.rules, [manual]);
  });

  it('Automatik aus → vorhandene Automatik-Regeln entfernt, Regel von Hand bleibt', async () => {
    const old = { id: 'sma-1-1', source: 'small_market_automation', target: 'gridSetpointW', value: -4000, start: '17:00', end: '17:15' };
    const { mab, state, persisted } = setup({ enabled: false, rules: [manual, old] });
    await mab.regenerateSmallMarketAutomationRules({ now: NOW });
    assert.deepEqual(state.schedule.rules, [manual]);
    assert.equal(state.schedule.smallMarketAutomation.lastOutcome, 'disabled');
    assert.equal(persisted(), 1);
  });

  it('keine Sonnenzeiten → Planung scheitert sichtbar, alte Automatik-Regeln weg', async () => {
    const old = { id: 'sma-1-1', source: 'small_market_automation', target: 'gridSetpointW', value: -4000, start: '17:00', end: '17:15' };
    const { mab, state } = setup({ sunTimes: null, rules: [manual, old] });
    await mab.regenerateSmallMarketAutomationRules({ now: NOW, force: true });
    assert.equal(state.schedule.smallMarketAutomation.lastOutcome, 'missing_sun_times_cache');
    assert.deepEqual(state.schedule.rules, [manual]);
  });
});

describe('Planungssperre: laufender Plan wird nicht umgeworfen', () => {
  const running = () => ({
    id: `sma-${at('17:30')}-1`, enabled: true, source: 'small_market_automation', target: 'gridSetpointW', value: -4000,
    start: '17:30', end: '17:45', slotTs: at('17:30'), slotEndTs: at('17:45'),
  });

  it('Slot läuft gerade (17:35) → kein Neuplanen, auch nicht mit force', async () => {
    const { mab, state } = setup({ rules: [manual, running()] });
    // gleiche Preisanzahl wie beim letzten Lauf → keine neuen Preisdaten
    state.schedule.smallMarketAutomation = { lastRunDate: '2026-01-14', lastPriceSlotCount: PRICES.length, lastSocPct: 50 };
    await mab.regenerateSmallMarketAutomationRules({ now: at('17:35'), force: true });
    assert.deepEqual(sma(state).map((r) => r.id), [running().id]);
  });

  it('neue Preisdaten während eines laufenden Slots → es wird neu geplant', async () => {
    const { mab, state } = setup({ rules: [manual, running()] });
    state.schedule.smallMarketAutomation = { lastRunDate: '2026-01-14', lastPriceSlotCount: 2, lastSocPct: 50 };
    await mab.regenerateSmallMarketAutomationRules({ now: at('17:35'), force: true });
    assert.equal(state.schedule.smallMarketAutomation.lastOutcome, 'generated');
    assert.ok(sma(state).every((r) => r.slotTs >= at('17:35')), 'nur Slots ab jetzt');
  });
});
