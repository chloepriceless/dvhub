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

function loadReadbackHelpers() {
  const serverPath = path.join(repoRoot, 'server.js');
  const source = fs.readFileSync(serverPath, 'utf8');
  const snippets = [
    extractFunction(source, 'buildDvControlReadbackPollConfig'),
    extractFunction(source, 'buildDvControlReadbackPolls')
  ].join('\n\n');
  const sandbox = { globalThis: {}, Number };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(`${snippets}\nglobalThis.helpers = { buildDvControlReadbackPollConfig, buildDvControlReadbackPolls };`, sandbox, {
    filename: 'server-dv-readback-helpers.js'
  });
  return sandbox.helpers;
}

test('dv control readback polls reuse the configured GX connection and ESS register addresses', () => {
  const helpers = loadReadbackHelpers();

  const polls = JSON.parse(JSON.stringify(helpers.buildDvControlReadbackPolls({
    victron: {
      host: 'venus-gx.local',
      port: 502,
      unitId: 100,
      timeoutMs: 1200
    },
    dvControl: {
      feedExcessDcPv: { enabled: true, address: 2707 },
      dontFeedExcessAcPv: { enabled: true, address: 2708 }
    }
  })));

  assert.deepEqual(polls, [
    ['feedExcessDcPv', { enabled: true, fc: 3, address: 2707, quantity: 1, signed: false, scale: 1, offset: 0, host: 'venus-gx.local', port: 502, unitId: 100, timeoutMs: 1200 }],
    ['dontFeedExcessAcPv', { enabled: true, fc: 3, address: 2708, quantity: 1, signed: false, scale: 1, offset: 0, host: 'venus-gx.local', port: 502, unitId: 100, timeoutMs: 1200 }]
  ]);
});
