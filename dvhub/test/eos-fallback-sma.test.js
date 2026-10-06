import test from 'node:test';
import assert from 'node:assert/strict';
import { isEosFallbackActive } from '../market-automation-builder.js';

test('Rückfallebene: Kleine Börsenautomatik springt nur ein, wenn EOS gewählt ist und kein Plan da ist', () => {
  const waiting = { optimizer: { eosWaiting: true } };
  assert.equal(isEosFallbackActive({ optimizer: { enabled: true } }, waiting), true);
  assert.equal(isEosFallbackActive({ optimizer: { enabled: true, eosFallbackSma: false } }, waiting), false, 'abgeschaltet');
  assert.equal(isEosFallbackActive({ optimizer: { enabled: false } }, waiting), false, 'Betriebsart nicht EOS');
  assert.equal(isEosFallbackActive({ optimizer: { enabled: true } }, { optimizer: { eosWaiting: false } }), false, 'EOS liefert');
  assert.equal(isEosFallbackActive({ optimizer: { enabled: true } }, {}), false);
});

import { createMarketAutomationBuilder } from '../market-automation-builder.js';

function builderWith({ waiting, fallback = true }) {
  const state = {
    victron: { soc: 80, minSocPct: 5 }, epex: { data: [] }, forecast: {},
    optimizer: { eosWaiting: waiting },
    schedule: { rules: [{ id: 'sma-1-1', source: 'small_market_automation', target: 'gridSetpointW', value: -1000, start: '18:00', end: '18:15' }], smallMarketAutomation: {} }
  };
  const cfg = {
    epex: { timezone: 'Europe/Berlin' },
    schedule: { timezone: 'Europe/Berlin', smallMarketAutomation: { enabled: false, searchWindowStart: '14:00', searchWindowEnd: '09:00', minSocPct: 30, batteryCapacityKwh: 20, maxDischargeW: -5000 } },
    optimizer: { enabled: true, eosFallbackSma: fallback }
  };
  const mab = createMarketAutomationBuilder({ state, getCfg: () => cfg, pushLog: () => {}, persistConfig: () => {}, getSunTimesCacheForPlanning: async () => null });
  return { mab, state };
}

test('Rückfallebene greift: ausgeschaltete Automatik plant, solange auf EOS gewartet wird', async () => {
  const waiting = builderWith({ waiting: true });
  await waiting.mab.regenerateSmallMarketAutomationRules({ force: true });
  assert.notEqual(waiting.state.schedule.smallMarketAutomation.lastOutcome, 'disabled', 'läuft in die Planung, nicht in „deaktiviert“');

  const back = builderWith({ waiting: false });
  await back.mab.regenerateSmallMarketAutomationRules({ force: true });
  assert.equal(back.state.schedule.smallMarketAutomation.lastOutcome, 'disabled');

  const off = builderWith({ waiting: true, fallback: false });
  await off.mab.regenerateSmallMarketAutomationRules({ force: true });
  assert.equal(off.state.schedule.smallMarketAutomation.lastOutcome, 'disabled', 'Rückfallebene abgeschaltet');
});
