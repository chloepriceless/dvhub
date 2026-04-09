import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const publicDir = path.join(repoRoot, 'public');

function loadDashboardHelpers(overrides = {}) {
  const appPath = fileURLToPath(new URL('../public/app.js', import.meta.url));
  const source = fs.readFileSync(appPath, 'utf8');
  const apiFetch = overrides.apiFetch || (async () => ({
    ok: true,
    json: async () => ({ rules: [], config: {} })
  }));
  const sandbox = {
    console,
    Date,
    Math,
    Number,
    JSON,
    Intl,
    Set,
    Map,
    globalThis: {},
    window: {
      DVhubCommon: {
        apiFetch
      },
      addEventListener() {},
      setInterval() {},
      clearInterval() {}
    },
    setInterval() {},
    clearInterval() {}
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: path.basename(appPath) });
  return sandbox.DVhubDashboard || sandbox.window.DVhubDashboard;
}

test('createMinSocPendingState keeps the previous readback and submitted target together', () => {
  const helpers = loadDashboardHelpers();

  assert.equal(typeof helpers.createMinSocPendingState, 'function');
  const pending = JSON.parse(JSON.stringify(helpers.createMinSocPendingState({
    currentReadback: 14,
    submittedValue: 20,
    submittedAt: 1234
  })));

  assert.deepEqual(pending, {
    previousReadback: 14,
    targetValue: 20,
    submittedAt: 1234
  });
});

test('resolveMinSocPendingState clears when a fresh readback confirms the submitted target', () => {
  const helpers = loadDashboardHelpers();

  assert.equal(typeof helpers.resolveMinSocPendingState, 'function');
  const next = helpers.resolveMinSocPendingState({
    pendingState: { previousReadback: 14, targetValue: 20, submittedAt: 1234 },
    readbackValue: 20
  });

  assert.equal(next, null);
});

test('resolveMinSocPendingState keeps pending state when the readback is temporarily missing', () => {
  const helpers = loadDashboardHelpers();

  const next = JSON.parse(JSON.stringify(helpers.resolveMinSocPendingState({
    pendingState: { previousReadback: 14, targetValue: 20, submittedAt: 1234 },
    readbackValue: null
  })));

  assert.deepEqual(next, {
    previousReadback: 14,
    targetValue: 20,
    submittedAt: 1234
  });
});

test('dashboard markup exposes a single top-level Minimum-SOC editor and removes the old manual write block', () => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');

  assert.match(html, /id="minSocRow"/);
  assert.match(html, /id="minSocEditor"/);
  assert.match(html, /id="minSocSlider"/);
  assert.match(html, /id="minSocSubmitBtn"/);
  assert.doesNotMatch(html, /manualMinSocValue/);
  assert.doesNotMatch(html, /manualMinSocBtn/);
});

test('dashboard styles define interactive Minimum-SOC row, popup editor, and pending state classes', () => {
  const css = fs.readFileSync(path.join(publicDir, 'styles.css'), 'utf8');

  assert.match(css, /\.metric-row-action/);
  assert.match(css, /\.min-soc-editor/);
  assert.match(css, /\.min-soc-pending/);
  assert.match(css, /@keyframes\s+minSocPulse/);
});

test('submitMinSocUpdate posts minSocPct and requests popup close plus pending state', async () => {
  const helpers = loadDashboardHelpers({
    apiFetch: async (_url, options) => ({
      ok: true,
      json: async () => ({ ok: true, options })
    })
  });

  assert.equal(typeof helpers.submitMinSocUpdate, 'function');
  const result = await helpers.submitMinSocUpdate({
    sliderValue: '20',
    currentReadback: 14
  });

  assert.equal(result.ok, true);
  assert.equal(JSON.parse(result.request.body).target, 'minSocPct');
  assert.equal(JSON.parse(result.request.body).value, 20);
  assert.equal(result.closeEditor, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.pendingState)), {
    previousReadback: 14,
    targetValue: 20,
    submittedAt: result.pendingState.submittedAt
  });
});

test('computeMinSocRenderState clears pending blink after changed Minimum-SOC readback arrives', () => {
  const helpers = loadDashboardHelpers();

  assert.equal(typeof helpers.computeMinSocRenderState, 'function');
  const result = JSON.parse(JSON.stringify(helpers.computeMinSocRenderState({
    readbackValue: 20,
    pendingState: { previousReadback: 14, targetValue: 20, submittedAt: 1234 }
  })));

  assert.equal(result.pendingState, null);
  assert.equal(result.shouldBlink, false);
});

test('computeMinSocRenderState keeps pending blink while readback still matches the old value', () => {
  const helpers = loadDashboardHelpers();

  const result = JSON.parse(JSON.stringify(helpers.computeMinSocRenderState({
    readbackValue: 14,
    pendingState: { previousReadback: 14, targetValue: 20, submittedAt: 1234 }
  })));

  assert.equal(result.shouldBlink, true);
});

test('invalid or failed submit does not leave Minimum-SOC in a pending state', async () => {
  const helpers = loadDashboardHelpers({
    apiFetch: async () => ({
      ok: false,
      status: 500,
      json: async () => ({ ok: false, error: 'write failed' })
    })
  });

  const result = await helpers.submitMinSocUpdate({
    sliderValue: '20',
    currentReadback: 14
  });

  assert.equal(result.ok, false);
  assert.equal(result.pendingState, undefined);
});
