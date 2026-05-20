// test/inspector-b4.test.js — Phase 19 Plan 19-05 (RED until plan 19-05 lands).
//
// Scaffold contract for the B4 EOS-Output inspector. Asserts:
//   - getEos calls eosAdapter.isAvailable() first
//   - on false → returns {available:false} WITHOUT pushForecast/pullSchedule
//   - on true → calls both
//   - second adapter instance created with timeoutMs:5000 (server.js wiring;
//     verified via regex against server.js source — Pitfall 4)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInspector } from '../services/forecast/inspector.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = path.resolve(__dirname, '..', 'server.js');

function makeCtx() {
  return {
    state: {},
    getCfg: () => ({}),
    pushLog: () => {},
  };
}

function createMockEos({ available = true, push = [], pull = [] } = {}) {
  return {
    isAvailable: async () => available,
    pushForecast: async () => push,
    pullSchedule: async () => pull,
  };
}

test('B4 getEos short-circuits when adapter.isAvailable() returns false', async () => {
  let pushCalled = false, pullCalled = false;
  const eosAdapter = {
    isAvailable: async () => false,
    pushForecast: async () => { pushCalled = true; return []; },
    pullSchedule: async () => { pullCalled = true; return []; },
  };
  const inspector = createInspector(makeCtx(), { eosAdapter });
  const out = await inspector.getEos({ from: '2026-05-20T00:00:00Z', to: '2026-05-21T00:00:00Z' });
  // RED — Plan 19-05 implements.
  assert.equal(out.available, false);
  assert.equal(pushCalled, false);
  assert.equal(pullCalled, false);
});

test('B4 getEos calls both pushForecast + pullSchedule when available', async () => {
  let pushCalled = false, pullCalled = false;
  const eosAdapter = {
    isAvailable: async () => true,
    pushForecast: async () => { pushCalled = true; return []; },
    pullSchedule: async () => { pullCalled = true; return []; },
  };
  const inspector = createInspector(makeCtx(), { eosAdapter });
  const out = await inspector.getEos({ from: '2026-05-20T00:00:00Z', to: '2026-05-21T00:00:00Z' });
  // RED — Plan 19-05 implements.
  assert.equal(out.available, true);
  assert.equal(pushCalled, true);
  assert.equal(pullCalled, true);
});

test('B4 — server.js wires a second EOS adapter with timeoutMs:5000', () => {
  const src = fs.readFileSync(SERVER_SRC, 'utf8');
  // RED — Plan 19-05 will add `createEosAdapter(ctx, { timeoutMs: 5000 })` for the Inspector path.
  assert.match(src, /createEosAdapter\([^,]+,\s*\{\s*timeoutMs:\s*5000\s*\}\)/,
    'server.js must create a second EOS adapter with timeoutMs:5000 for the Inspector read path');
});
