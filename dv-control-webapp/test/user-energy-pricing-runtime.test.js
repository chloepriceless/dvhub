import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

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
    extractFunction(source, 'mixedCostCtKwh')
  ].join('\n\n');
  const sandbox = { globalThis: {}, Number, Math };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(`${snippets}\nglobalThis.helpers = { roundCtKwh, effectiveBatteryCostCtKwh, mixedCostCtKwh };`, sandbox, {
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
