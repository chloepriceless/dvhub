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

function loadEpexSummaryHelper({ now, epexState }) {
  const serverPath = path.join(repoRoot, 'server.js');
  const source = fs.readFileSync(serverPath, 'utf8');
  const snippet = extractFunction(source, 'epexNowNext');
  const sandbox = {
    globalThis: {},
    state: { epex: epexState },
    Date: class FakeDate extends Date {
      static now() {
        return now;
      }
    },
    Number,
    Math,
    Array
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(`${snippet}\nglobalThis.helpers = { epexNowNext };`, sandbox, {
    filename: 'server-epex-summary-helper.js'
  });
  return sandbox.helpers;
}

test('epex summary ignores negative slots from tomorrow when reporting today still negative', () => {
  const now = Date.parse('2026-03-12T18:00:00.000Z');
  const helpers = loadEpexSummaryHelper({
    now,
    epexState: {
      ok: true,
      date: '2026-03-12',
      nextDate: '2026-03-13',
      data: [
        { ts: Date.parse('2026-03-12T17:00:00.000Z'), day: '2026-03-12', eur_mwh: 15, ct_kwh: 1.5 },
        { ts: Date.parse('2026-03-12T19:00:00.000Z'), day: '2026-03-12', eur_mwh: 8, ct_kwh: 0.8 },
        { ts: Date.parse('2026-03-13T02:00:00.000Z'), day: '2026-03-13', eur_mwh: -12, ct_kwh: -1.2 }
      ]
    }
  });

  const summary = JSON.parse(JSON.stringify(helpers.epexNowNext()));

  assert.equal(summary.hasFutureNegative, false);
  assert.equal(summary.tomorrowNegative, true);
});
