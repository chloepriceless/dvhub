import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

function loadPricingHelpers() {
  const settingsPath = fileURLToPath(new URL('../public/settings.js', import.meta.url));
  const source = fs.readFileSync(settingsPath, 'utf8');
  const sandbox = {
    console,
    globalThis: {},
    window: {
      DVhubCommon: {},
      addEventListener() {},
      setTimeout() {}
    }
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: path.basename(settingsPath) });
  return sandbox.DVhubSettingsPricingPeriods;
}

const {
  addPricingPeriod,
  createEmptyPricingPeriod,
  removePricingPeriod,
  serializePricingPeriods,
  validatePricingPeriods
} = loadPricingHelpers();

test('pricing period rows can be added and removed', () => {
  const added = addPricingPeriod([]);
  const addedTwice = addPricingPeriod(added);
  const removed = removePricingPeriod(addedTwice, addedTwice[0].id);

  assert.equal(added.length, 1);
  assert.equal(addedTwice.length, 2);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].id, addedTwice[1].id);
});

test('pricing periods serialize into userEnergyPricing.periods payloads', () => {
  const serialized = serializePricingPeriods([
    {
      ...createEmptyPricingPeriod(0),
      id: 'winter-fixed',
      label: 'Winter',
      startDate: '2026-01-01',
      endDate: '2026-03-31',
      mode: 'fixed',
      fixedGrossImportCtKwh: '31.5'
    },
    {
      ...createEmptyPricingPeriod(1),
      id: 'summer-dynamic',
      label: 'Sommer',
      startDate: '2026-04-01',
      endDate: '2026-12-31',
      mode: 'dynamic',
      dynamicComponents: {
        energyMarkupCtKwh: '0',
        gridChargesCtKwh: '8.5',
        leviesAndFeesCtKwh: '3',
        vatPct: '19'
      }
    }
  ]);

  assert.equal(serialized[0].fixedGrossImportCtKwh, 31.5);
  assert.equal(serialized[1].dynamicComponents.gridChargesCtKwh, 8.5);
  assert.equal(serialized[1].dynamicComponents.vatPct, 19);
});

test('pricing period validation reports overlaps and missing fields before save', () => {
  const result = validatePricingPeriods([
    {
      ...createEmptyPricingPeriod(0),
      id: 'winter-fixed',
      startDate: '2026-01-01',
      endDate: '2026-03-31',
      mode: 'fixed',
      fixedGrossImportCtKwh: '31.5'
    },
    {
      ...createEmptyPricingPeriod(1),
      id: 'overlap-fixed',
      startDate: '2026-03-15',
      endDate: '2026-04-30',
      mode: 'fixed',
      fixedGrossImportCtKwh: '32'
    },
    {
      ...createEmptyPricingPeriod(2),
      id: 'missing-fixed',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      mode: 'fixed',
      fixedGrossImportCtKwh: ''
    }
  ]);

  assert.equal(result.valid, false);
  assert.match(result.messages.join('\n'), /Bruttopreis fehlt/i);
  assert.match(result.messages.join('\n'), /überschneidet/i);
});

test('config definition exposes the small market automation fields and advanced stages', async () => {
  const { getConfigDefinition } = await import('../config-model.js');
  const definition = getConfigDefinition();
  const paths = definition.fields.map((field) => field.path).filter(Boolean);

  assert.ok(paths.includes('schedule.smallMarketAutomation.enabled'));
  assert.ok(paths.includes('schedule.smallMarketAutomation.searchWindowStart'));
  assert.ok(paths.includes('schedule.smallMarketAutomation.location.latitude'));
  assert.ok(paths.includes('schedule.smallMarketAutomation.aggressivePremiumPct'));
  assert.ok(paths.includes('schedule.smallMarketAutomation.stages'));
});
