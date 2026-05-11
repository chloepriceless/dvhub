// test/widget-error-boundary.test.js — Plan 09-04 Task 5
//
// Validates DVhubCommon.safeRender behaviour:
//   1. returns { ok: true } on success and does NOT POST to /api/log
//   2. returns { ok: false } on sync throw, POSTs widget_error to /api/log,
//      and renders a 'dvhub-widget-error' placeholder
//   3. catches async/Promise rejections (the awaited-then branch)
//   4. sibling isolation: one throwing widget does not prevent the next from
//      completing in the same refresh tick (the whole point of per-widget
//      isolation BELOW the coarse 08-07 withWidgetBoundary wrapper)
//   5. Plan 08-07 helpers are preserved (regression guard):
//      - installGlobalErrorBoundary still exported by common.js
//      - withWidgetBoundary('dashboard', ...) still wraps refresh in app.js
//
// Strategy: load public/common.js source, extract the safeRender body,
// evaluate in a sandboxed VM context with stubs for document / window /
// apiFetch. Avoids the jsdom dependency (QUAL-03 — no new deps).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMMON_PATH = path.resolve(__dirname, '..', 'public', 'common.js');
const APP_PATH = path.resolve(__dirname, '..', 'public', 'app.js');

function loadSafeRenderSource() {
  const src = fs.readFileSync(COMMON_PATH, 'utf8');
  // Greedy-ish match: scan for the function literal and balance braces.
  // The function is roughly 35 lines; we capture from `async function safeRender`
  // to the matching closing brace that ends the function body.
  const startMatch = src.match(/async function safeRender\s*\([^)]*\)\s*\{/);
  if (!startMatch) {
    throw new Error('safeRender not found in common.js — Plan 09-04 Task 1 must run first');
  }
  const start = startMatch.index;
  // Walk braces from the opening { to find the matching close.
  let depth = 0;
  let i = start + startMatch[0].length - 1; // position of the opening {
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return src.slice(start, i + 1);
      }
    }
  }
  throw new Error('Could not find matching close brace for safeRender');
}

function makeSandbox({ apiFetchCalls = [], placeholderEl = null } = {}) {
  const sandbox = {
    document: {
      createElement: () => ({
        className: '',
        title: '',
        textContent: '',
        appendChild: () => {}
      }),
      getElementById: () => placeholderEl
    },
    location: { pathname: '/test' },
    apiFetch: (...args) => {
      apiFetchCalls.push(args);
      return Promise.resolve();
    },
    console: { warn: () => {}, error: () => {} }
  };
  vm.createContext(sandbox);
  return sandbox;
}

test('safeRender returns { ok: true } on success and does not POST to /api/log', async () => {
  const fnSrc = loadSafeRenderSource();
  const apiFetchCalls = [];
  const sandbox = makeSandbox({ apiFetchCalls });
  vm.runInContext(`${fnSrc}\nglobalThis.__safeRender = safeRender;`, sandbox);

  const result = await sandbox.__safeRender('w1', () => {});
  assert.equal(result.ok, true);
  assert.equal(apiFetchCalls.length, 0, '/api/log must NOT be called when fn succeeds');
});

test('safeRender returns { ok: false } on throw and POSTs widget_error', async () => {
  const fnSrc = loadSafeRenderSource();
  const apiFetchCalls = [];
  const placeholderEl = {
    replaceChildren: () => {},
    appendChild: () => {}
  };
  const sandbox = makeSandbox({ apiFetchCalls, placeholderEl });
  vm.runInContext(`${fnSrc}\nglobalThis.__safeRender = safeRender;`, sandbox);

  const result = await sandbox.__safeRender(
    'w1',
    () => { throw new Error('boom'); },
    { placeholderTarget: placeholderEl }
  );
  assert.equal(result.ok, false);
  assert.ok(result.error instanceof Error);
  assert.equal(apiFetchCalls.length, 1, 'exactly one /api/log POST on throw');

  const [url, init] = apiFetchCalls[0];
  assert.equal(url, '/api/log');
  assert.equal(init.method, 'POST');
  const body = JSON.parse(init.body);
  assert.equal(body.event, 'widget_error', 'event must be widget_error to distinguish from frontend_*');
  assert.equal(body.widget, 'w1');
  assert.equal(body.level, 'error');
  assert.equal(body.source, 'widget');
  assert.ok(body.message.includes('boom'));
  assert.equal(typeof body.stack, 'string');
  // Stack must be capped at 500 chars per the plan's contract.
  assert.ok(body.stack.length <= 500);
});

test('safeRender catches async-Promise rejection (awaited-then branch)', async () => {
  const fnSrc = loadSafeRenderSource();
  const apiFetchCalls = [];
  const sandbox = makeSandbox({ apiFetchCalls });
  vm.runInContext(`${fnSrc}\nglobalThis.__safeRender = safeRender;`, sandbox);

  const result = await sandbox.__safeRender(
    'wAsync',
    async () => { throw new Error('async boom'); }
  );
  assert.equal(result.ok, false);
  assert.equal(apiFetchCalls.length, 1);
  const body = JSON.parse(apiFetchCalls[0][1].body);
  assert.equal(body.event, 'widget_error');
  assert.equal(body.widget, 'wAsync');
  assert.ok(body.message.includes('async boom'));
});

test('sibling isolation: one throwing safeRender does NOT prevent a sibling from completing', async () => {
  const fnSrc = loadSafeRenderSource();
  const apiFetchCalls = [];
  const sandbox = makeSandbox({ apiFetchCalls });
  vm.runInContext(`${fnSrc}\nglobalThis.__safeRender = safeRender;`, sandbox);

  let siblingRan = false;
  await sandbox.__safeRender('w1', () => { throw new Error('boom'); });
  await sandbox.__safeRender('w2', () => { siblingRan = true; });
  assert.equal(siblingRan, true, 'sibling widget must still run after a throwing widget');
});

test('Plan 08-07 helpers preserved: common.js still exports installGlobalErrorBoundary', () => {
  const src = fs.readFileSync(COMMON_PATH, 'utf8');
  assert.ok(
    src.includes('installGlobalErrorBoundary'),
    '08-07 helper installGlobalErrorBoundary must remain in common.js'
  );
});

test('Plan 08-07 onerror seed preserved: common.js still wires window.addEventListener(\'error\', ...)', () => {
  const src = fs.readFileSync(COMMON_PATH, 'utf8');
  assert.ok(
    /window\.addEventListener\(\s*['"]error['"]/.test(src),
    'window.addEventListener("error", ...) from 08-07 must remain'
  );
  assert.ok(
    /window\.addEventListener\(\s*['"]unhandledrejection['"]/.test(src),
    'window.addEventListener("unhandledrejection", ...) from 08-07 must remain'
  );
});

test('Plan 08-07 wrapper preserved: app.js still has withWidgetBoundary(\'dashboard\', ...)', () => {
  const src = fs.readFileSync(APP_PATH, 'utf8');
  assert.ok(
    src.includes("withWidgetBoundary('dashboard'") || src.includes('withWidgetBoundary("dashboard"'),
    '08-07 outer dashboard boundary must remain wrapped around refresh'
  );
  assert.ok(
    /function\s+withWidgetBoundary/.test(src),
    '08-07 withWidgetBoundary function definition must remain in app.js'
  );
});

test('Plan 08-07 epex wrapper preserved: app.js still has withWidgetBoundary(\'epex\', ...)', () => {
  const src = fs.readFileSync(APP_PATH, 'utf8');
  assert.ok(
    src.includes("withWidgetBoundary('epex'") || src.includes('withWidgetBoundary("epex"'),
    '08-07 outer epex boundary must remain wrapped around refreshEpex'
  );
});

test('Plan 09-04 contract: safeRender is exported on window.DVhubCommon', () => {
  const src = fs.readFileSync(COMMON_PATH, 'utf8');
  // Should appear inside the DVhubCommon export block.
  assert.ok(
    /window\.DVhubCommon\s*=\s*\{[\s\S]*safeRender[\s\S]*\}/m.test(src),
    'safeRender must be an exported key on window.DVhubCommon'
  );
  // Existing keys must NOT have been removed (QUAL-02 backward compat).
  assert.ok(/apiFetch\s*,/.test(src), 'apiFetch must still be exported');
  assert.ok(/escapeHtml\s*,/.test(src), 'escapeHtml must still be exported');
  assert.ok(/getStoredApiToken\s*,/.test(src), 'getStoredApiToken must still be exported');
});

test('Plan 09-04 placeholder text is the user-facing German string', () => {
  const src = fs.readFileSync(COMMON_PATH, 'utf8');
  assert.ok(
    src.includes('Widget aktuell nicht verfügbar'),
    'placeholder text must be the user-facing German string from the plan contract'
  );
  assert.ok(
    src.includes('dvhub-widget-error'),
    'placeholder element must have the dvhub-widget-error className for CSS targeting'
  );
});
