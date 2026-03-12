import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const publicDir = path.join(repoRoot, 'public');
const appPath = path.join(publicDir, 'app.js');
const stylesPath = path.join(publicDir, 'styles.css');

function loadDashboardHelpers() {
  const source = fs.readFileSync(appPath, 'utf8');
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
        apiFetch: async () => ({
          ok: true,
          json: async () => ({ rules: [], config: {} })
        })
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

test('formatChartCentValue renders cent labels with two decimal places', () => {
  const helpers = loadDashboardHelpers();

  assert.equal(typeof helpers.formatChartCentValue, 'function');
  assert.equal(helpers.formatChartCentValue(0.08123), '8,12 Cent');
});

test('getChartHighlightSets returns the four highest and eight lowest slot indices', () => {
  const helpers = loadDashboardHelpers();

  assert.equal(typeof helpers.getChartHighlightSets, 'function');
  const result = helpers.getChartHighlightSets([2, 7, -1, -3, 5, 1, -2, 8, -5, 4, -4, 6]);

  assert.deepEqual([...result.high].sort((left, right) => left - right), [1, 4, 7, 11]);
  assert.deepEqual([...result.low].sort((left, right) => left - right), [2, 3, 6, 8, 10]);
});

test('createPriceChartScale keeps the near-zero band as a narrow strip', () => {
  const helpers = loadDashboardHelpers();

  assert.equal(typeof helpers.createPriceChartScale, 'function');
  const scale = helpers.createPriceChartScale({
    min: -0.08,
    max: 0.12,
    top: 16,
    bottom: 260,
    enableFocusBand: true,
    focusBandCeiling: 0.01,
    focusBandFloor: -0.01
  });

  const upperSmallGap = Math.abs(scale.y(0.01) - scale.y(0));
  const lowerSmallGap = Math.abs(scale.y(0) - scale.y(-0.01));
  const nearZeroBandHeight = Math.abs(scale.y(0.01) - scale.y(-0.01));
  const fullChartHeight = Math.abs(scale.y(0.12) - scale.y(-0.08));

  assert.ok(upperSmallGap > 0);
  assert.ok(lowerSmallGap > 0);
  assert.ok(nearZeroBandHeight < fullChartHeight / 4);
  assert.ok(nearZeroBandHeight > fullChartHeight / 12);
});

test('dashboard chart styles expose highlight signal colors', () => {
  const css = fs.readFileSync(stylesPath, 'utf8');

  assert.match(css, /--chart-positive-highlight:/);
  assert.match(css, /--chart-negative-highlight:/);
});

test('dashboard source uses cent chart labels and highlight fills', () => {
  const app = fs.readFileSync(appPath, 'utf8');

  assert.match(app, /formatChartCentValue\(vv\)/);
  assert.match(app, /getChartHighlightSets\(vals\)/);
  assert.match(app, /enableFocusBand:\s*vals\.some\(\(value\)\s*=>\s*Number\.isFinite\(value\)\s*&&\s*value\s*>=\s*-0\.01\s*&&\s*value\s*<=\s*0\.01\)/);
  assert.match(app, /chartPositiveHighlight/);
  assert.match(app, /chartNegativeHighlight/);
  assert.match(app, /createPriceChartScale\(/);
});

test('dashboard source formats tooltip market prices with two cent decimals', () => {
  const app = fs.readFileSync(appPath, 'utf8');

  assert.match(app, /fmtCt\(row\.ct_kwh,\s*2\)/);
});

test('dashboard markup labels the price chart as ct per kwh', () => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');

  assert.match(html, /Day-Ahead-Preise \(ct\/kWh\)/);
  assert.doesNotMatch(html, /EUR\/kWh/);
});
