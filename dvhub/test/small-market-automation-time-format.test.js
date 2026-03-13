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

function loadTimeFormattingHelpers() {
  const serverPath = path.join(repoRoot, 'server.js');
  const source = fs.readFileSync(serverPath, 'utf8');
  const snippet = extractFunction(source, 'formatLocalHHMM');
  const sandbox = {
    globalThis: {},
    Intl,
    Date
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(`${snippet}\nglobalThis.helpers = { formatLocalHHMM };`, sandbox, {
    filename: 'server-small-market-automation-time-format-helper.js'
  });
  return sandbox.helpers;
}

test('formatLocalHHMM returns deterministic HH:MM for Europe/Berlin', () => {
  const { formatLocalHHMM } = loadTimeFormattingHelpers();
  assert.equal(formatLocalHHMM(new Date('2026-01-15T00:05:00Z'), 'Europe/Berlin'), '01:05');
  assert.equal(formatLocalHHMM(new Date('2026-07-15T00:05:00Z'), 'Europe/Berlin'), '02:05');
});
