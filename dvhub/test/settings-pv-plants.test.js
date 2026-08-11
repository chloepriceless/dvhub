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
      DVhubCommon: {
        escapeHtml: (v) => String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
      },
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
  pvPlantsLicenseCapWarning,
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
  assert.match(markup, /Marktprämie/);
  assert.match(markup, /1 konfiguriert/);
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

// ---------------------------------------------------------------------------
// T-LICENSE-KWP-GATING Increment 4: nicht-blockierende Lizenz-kWp-Eingabe-Warnung.
// ---------------------------------------------------------------------------

test('licence cap warning: null when max_kwp is null (Community/Pro L/Legacy)', () => {
  const plants = [{ kwp: 80 }, { kwp: 40 }];
  assert.equal(pvPlantsLicenseCapWarning(plants, { status: 'active', max_kwp: null }), null);
  assert.equal(pvPlantsLicenseCapWarning(plants, null), null);
  assert.equal(pvPlantsLicenseCapWarning(plants, {}), null);
});

test('licence cap warning: null when total kWp is within the tier', () => {
  const plants = [{ kwp: 30 }, { kwp: 15 }]; // 45 ≤ 50
  assert.equal(pvPlantsLicenseCapWarning(plants, { max_kwp: 50 }), null);
});

test('licence cap warning: warns with both numbers when total exceeds the tier', () => {
  const plants = [{ kwp: 60 }, { kwp: 25 }]; // 85 > 50
  const warning = pvPlantsLicenseCapWarning(plants, { max_kwp: 50 });
  assert.ok(typeof warning === 'string' && warning.length > 0);
  assert.match(warning, /50 kWp/);
  assert.match(warning, /85 kWp/);
  assert.match(warning, /gekappt/i);
  assert.match(warning, /upgrad/i);
});

test('licence cap warning: ignores invalid/negative kWp entries in the sum', () => {
  const plants = [{ kwp: 55 }, { kwp: 'x' }, { kwp: -10 }, {}]; // effective 55 > 50
  const warning = pvPlantsLicenseCapWarning(plants, { max_kwp: 50 });
  assert.match(warning, /55 kWp/);
});
