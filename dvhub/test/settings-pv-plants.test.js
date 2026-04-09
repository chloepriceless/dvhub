import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

function loadPvPlantHelpers() {
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
  return sandbox.DVhubSettingsPvPlants;
}

const {
  addPvPlant,
  buildMarketPremiumEditorMarkup,
  createEmptyPvPlant,
  getDraftMarketValueMode,
  removePvPlant,
  serializeMarketValueMode,
  serializePvPlants,
  validatePvPlants
} = loadPvPlantHelpers();

test('pv plant rows can be added and removed', () => {
  const added = addPvPlant([]);
  const addedTwice = addPvPlant(added);
  const removed = removePvPlant(addedTwice, addedTwice[0].id);

  assert.equal(added.length, 1);
  assert.equal(addedTwice.length, 2);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].id, addedTwice[1].id);
});

test('pv plants serialize into premium config payload entries', () => {
  const serialized = JSON.parse(JSON.stringify(serializePvPlants([
    {
      ...createEmptyPvPlant(0),
      kwp: '9.8',
      commissionedAt: '2021-04-15'
    },
    {
      ...createEmptyPvPlant(1),
      kwp: '4.2',
      commissionedAt: '2023-09-01'
    }
  ])));

  assert.deepEqual(serialized, [
    {
      kwp: 9.8,
      commissionedAt: '2021-04-15'
    },
    {
      kwp: 4.2,
      commissionedAt: '2023-09-01'
    }
  ]);
});

test('market value mode defaults to annual when missing and serializes valid values', () => {
  assert.equal(getDraftMarketValueMode({ userEnergyPricing: {} }), 'annual');
  assert.equal(getDraftMarketValueMode({ userEnergyPricing: { marketValueMode: 'monthly' } }), 'monthly');
  assert.equal(serializeMarketValueMode('monthly'), 'monthly');
  assert.equal(serializeMarketValueMode('invalid'), 'annual');
});

test('market premium editor markup keeps global mode separate from pv plants list', () => {
  const markup = buildMarketPremiumEditorMarkup({
    marketValueMode: 'monthly',
    plants: [createEmptyPvPlant(0)],
    validationHtml: '<div class="status-banner info">ok</div>'
  });

  assert.match(markup, /Marktwert-Modus/);
  assert.match(markup, /Jahresmarktwert/);
  assert.match(markup, /Monatsmarktwert/);
  assert.match(markup, /<h3>PV-Anlagen<\/h3>/);
  assert.match(markup, /1 konfigurierte Anlagen/);
});

test('pv plant validation reports missing commissioning date and invalid capacity', () => {
  const result = validatePvPlants([
    {
      ...createEmptyPvPlant(0),
      kwp: '',
      commissionedAt: '2021-04-15'
    },
    {
      ...createEmptyPvPlant(1),
      kwp: '4.2',
      commissionedAt: ''
    }
  ]);

  assert.equal(result.valid, false);
  assert.match(result.messages.join('\n'), /kWp fehlt/i);
  assert.match(result.messages.join('\n'), /inbetriebnahme/i);
});
