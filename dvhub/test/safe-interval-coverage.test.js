// safe-interval-coverage.test.js — Plan 09-07
// Coverage assertions (static): every plan-listed file imports safeInterval and
// contains zero raw setInterval call sites. Behavior assertions (dynamic):
// sync throw is caught, async Promise rejection is caught, no
// UnhandledPromiseRejection event fires across a multi-tick window.
//
// Run target: `cd dvhub && node --test test/safe-interval-coverage.test.js`
// Paths in TARGET_FILES are RELATIVE to dvhub/ (the cwd when `npm test` runs).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeInterval, configureSafeAsync, _resetForTests } from '../services/safe-async.js';

// Resolve the dvhub/ root from this test file's location so the coverage
// assertions work whether the test is run via `npm test` (cwd=dvhub) or via
// an absolute path from a different cwd.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DVHUB_ROOT = path.resolve(__dirname, '..');

// --- Coverage tests (static) -----------------------------------------------
// Plan-listed scope: 8 files. Some files (transport-modbus.js, system-discovery.js,
// schedule-eval.js, services/llm/ollama-client.js) have ZERO setInterval call
// sites today; plan over-estimated counts. Reserved imports keep the helper one
// edit away when a future ticker is added. All 8 files MUST satisfy the strict
// truth: zero raw setInterval AND the safeInterval token appears (either in the
// import or in a call site).

const TARGET_FILES = [
  'epex-fetch.js',
  'transport-modbus.js',
  'transport-mqtt.js',
  'system-discovery.js',
  'schedule-eval.js',
  'services/python-bridge/index.js',
  'services/llm/index.js',
  'services/llm/ollama-client.js'
];

for (const rel of TARGET_FILES) {
  test(`coverage: ${rel} imports safeInterval and contains no raw setInterval call sites`, () => {
    const abs = path.join(DVHUB_ROOT, rel);
    const src = fs.readFileSync(abs, 'utf8');
    assert.ok(src.includes('safeInterval'), `${rel} must reference safeInterval (import or call)`);

    // Strip line comments and block comments so a reference inside a comment
    // doesn't false-positive. Then scan for setInterval(.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
      .replace(/\/\/.*$/gm, '');           // line comments

    const matches = stripped.match(/\bsetInterval\s*\(/g) || [];
    assert.equal(
      matches.length,
      0,
      `${rel} still has ${matches.length} raw setInterval call(s) — all should be safeInterval`
    );
  });
}

// --- Behavior tests --------------------------------------------------------

test('safeInterval catches sync throws and continues ticking', async () => {
  _resetForTests();
  let calls = 0;
  const errors = [];
  configureSafeAsync({
    logger: { error: (msg, meta) => errors.push({ msg, meta }) },
    pushLog: () => {}
  });
  const handle = safeInterval('test.sync', () => {
    calls++;
    if (calls === 2) throw new Error('boom');
  }, 10);
  await new Promise((r) => setTimeout(r, 100));
  clearInterval(handle);
  assert.ok(calls >= 4, `expected at least 4 ticks, got ${calls}`);
  assert.ok(errors.length >= 1, `expected at least 1 error logged, got ${errors.length}`);
  assert.ok(errors[0].meta.interval === 'test.sync', `error meta should carry interval name, got ${errors[0].meta.interval}`);
});

test('safeInterval catches async Promise rejections and continues ticking', async () => {
  _resetForTests();
  let calls = 0;
  const errors = [];
  configureSafeAsync({
    logger: { error: (msg, meta) => errors.push({ msg, meta }) },
    pushLog: () => {}
  });
  const handle = safeInterval('test.async', async () => {
    calls++;
    if (calls === 2) throw new Error('async boom');
  }, 10);
  await new Promise((r) => setTimeout(r, 100));
  clearInterval(handle);
  assert.ok(calls >= 4, `expected at least 4 ticks, got ${calls}`);
  assert.ok(errors.length >= 1, `expected at least 1 error logged, got ${errors.length}`);
});

test('no UnhandledPromiseRejection during a 100ms run with throwing async callback', async () => {
  _resetForTests();
  const unhandled = [];
  const listener = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', listener);
  try {
    configureSafeAsync({ logger: { error: () => {} }, pushLog: () => {} });
    const handle = safeInterval('test.no-unhandled', async () => {
      throw new Error('would-be-unhandled');
    }, 10);
    await new Promise((r) => setTimeout(r, 120));
    clearInterval(handle);
    // Give the microtask queue one drain cycle so any pending rejections settle.
    await new Promise((r) => setImmediate(r));
  } finally {
    process.removeListener('unhandledRejection', listener);
  }
  assert.equal(unhandled.length, 0, `expected 0 unhandled rejections, got ${unhandled.length}`);
});

test('safeInterval rejects invalid args (TypeError / RangeError)', () => {
  _resetForTests();
  configureSafeAsync({ logger: { error: () => {} }, pushLog: () => {} });
  assert.throws(() => safeInterval('', () => {}, 100), /name/);
  assert.throws(() => safeInterval('x', null, 100), /function/);
  assert.throws(() => safeInterval('x', () => {}, 0), /positive/);
  assert.throws(() => safeInterval('x', () => {}, -1), /positive/);
  assert.throws(() => safeInterval('x', () => {}, NaN), /positive/);
});

test('configureSafeAsync rejects mis-wired args', () => {
  _resetForTests();
  assert.throws(() => configureSafeAsync({ logger: null, pushLog: () => {} }), /logger/);
  assert.throws(() => configureSafeAsync({ logger: {}, pushLog: () => {} }), /logger/);
  assert.throws(() => configureSafeAsync({ logger: { error: () => {} }, pushLog: 'not a fn' }), /pushLog/);
});

// Note: the "throws loudly when fired before configureSafeAsync" behavior is
// covered indirectly by `configureSafeAsync rejects mis-wired args` (asserts
// the contract is enforced at wire-up). A runtime test that triggers
// _logError without configure would generate asynchronous-after-test activity
// in node:test, polluting other tests; the wire-up contract is the cleaner
// failure mode to assert.
