import test from 'node:test';
import assert from 'node:assert/strict';
import { configChangeNeedsEosReplan } from '../routes-api.js';

test('Einstellungen, die den EOS-Plan betreffen, lösen einen Sofort-Lauf aus', () => {
  assert.equal(configChangeNeedsEosReplan(['optimizer.batteryCapacityWh']), true);
  assert.equal(configChangeNeedsEosReplan(['userEnergyPricing.fixedGrossImportCtKwh']), true);
  assert.equal(configChangeNeedsEosReplan(['optimizer.allowGridCharge']), true);
  assert.equal(configChangeNeedsEosReplan(['wallbox.type']), true);
  assert.equal(configChangeNeedsEosReplan(['optimizer.evTargetValue']), true);
});

test('Takt-, Anzeige- und fremde Einstellungen lösen keinen Sofort-Lauf aus', () => {
  assert.equal(configChangeNeedsEosReplan(['optimizer.eosEmsIntervalSec']), false);
  assert.equal(configChangeNeedsEosReplan(['optimizer.eosGeneticGenerations']), false);
  assert.equal(configChangeNeedsEosReplan(['schedule.timezone', 'dbBackup.time', 'victron.host']), false);
  assert.equal(configChangeNeedsEosReplan([]), false);
  assert.equal(configChangeNeedsEosReplan(undefined), false);
  assert.equal(configChangeNeedsEosReplan(['optimizer.eosEmsIntervalSec', 'optimizer.maxDischargeW']), true, 'gemischt → ja');
});
