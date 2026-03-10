import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import {
  resolveActiveUserEnergyPricingForTimestamp,
  resolveUserImportPriceCtKwhForSlot
} from '../config-model.js';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const signatureEnd = source.indexOf(')', start);
  assert.notEqual(signatureEnd, -1, `missing signature end for ${name}`);
  const bodyStart = source.indexOf('{', signatureEnd);
  assert.notEqual(bodyStart, -1, `missing body for ${name}`);
  let depth = 0;
  let end = bodyStart;
  for (; end < source.length; end += 1) {
    const char = source[end];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    }
  }
  return source.slice(start, end);
}

function loadPricingHelpers() {
  const serverPath = path.join(repoRoot, 'server.js');
  const source = fs.readFileSync(serverPath, 'utf8');
  const snippets = [
    extractFunction(source, 'roundCtKwh'),
    extractFunction(source, 'effectiveBatteryCostCtKwh'),
    extractFunction(source, 'mixedCostCtKwh'),
    extractFunction(source, 'resolveLogLimit')
  ].join('\n\n');
  const sandbox = { globalThis: {}, Number, Math };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(`${snippets}\nglobalThis.helpers = { roundCtKwh, effectiveBatteryCostCtKwh, mixedCostCtKwh, resolveLogLimit };`, sandbox, {
    filename: 'server-pricing-helpers.js'
  });
  return sandbox.helpers;
}

test('battery effective cost includes the source energy cost before storage markup', () => {
  const helpers = loadPricingHelpers();

  assert.equal(
    helpers.effectiveBatteryCostCtKwh({
      pvCtKwh: 6.38,
      batteryBaseCtKwh: 2,
      batteryLossMarkupPct: 20
    }),
    10.06
  );
});

test('mixed cost stays between direct pv cost and battery path cost', () => {
  const helpers = loadPricingHelpers();

  assert.equal(
    helpers.mixedCostCtKwh({
      pvCtKwh: 6.38,
      batteryBaseCtKwh: 2,
      batteryLossMarkupPct: 20
    }),
    8.22
  );
});

test('log limit helper defaults to dashboard-sized payloads and clamps extreme values', () => {
  const helpers = loadPricingHelpers();

  assert.equal(helpers.resolveLogLimit(undefined), 20);
  assert.equal(helpers.resolveLogLimit('7'), 7);
  assert.equal(helpers.resolveLogLimit('0'), 20);
  assert.equal(helpers.resolveLogLimit('-5'), 20);
  assert.equal(helpers.resolveLogLimit('999'), 200);
  assert.equal(helpers.resolveLogLimit('not-a-number'), 20);
});

test('pricing resolver selects the period active for the slot date in Berlin local time', () => {
  const pricing = {
    mode: 'fixed',
    fixedGrossImportCtKwh: 29.9,
    periods: [
      {
        id: 'winter-fixed',
        startDate: '2026-01-01',
        endDate: '2026-03-31',
        mode: 'fixed',
        fixedGrossImportCtKwh: 31.5
      },
      {
        id: 'summer-dynamic',
        startDate: '2026-04-01',
        endDate: '2026-12-31',
        mode: 'dynamic',
        dynamicComponents: {
          energyMarkupCtKwh: 0,
          gridChargesCtKwh: 8.5,
          leviesAndFeesCtKwh: 3,
          vatPct: 19
        }
      }
    ]
  };

  const winter = resolveActiveUserEnergyPricingForTimestamp('2026-03-31T20:30:00.000Z', pricing);
  const summer = resolveActiveUserEnergyPricingForTimestamp('2026-03-31T22:30:00.000Z', pricing);

  assert.equal(winter?.id, 'winter-fixed');
  assert.equal(summer?.id, 'summer-dynamic');
  assert.equal(
    resolveUserImportPriceCtKwhForSlot({ ts: '2026-03-31T22:30:00.000Z', ct_kwh: 5 }, pricing),
    19.63
  );
});

test('legacy single-price config stays as fallback when no dated period matches', () => {
  const pricing = {
    mode: 'fixed',
    fixedGrossImportCtKwh: 29.9,
    periods: [
      {
        id: 'winter-fixed',
        startDate: '2026-01-01',
        endDate: '2026-03-31',
        mode: 'fixed',
        fixedGrossImportCtKwh: 31.5
      }
    ]
  };

  assert.equal(
    resolveUserImportPriceCtKwhForSlot({ ts: '2026-12-15T12:00:00.000Z', ct_kwh: 4.5 }, pricing),
    29.9
  );
});
