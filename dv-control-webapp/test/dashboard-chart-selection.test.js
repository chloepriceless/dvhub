import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const publicDir = path.join(repoRoot, 'public');

function loadDashboardHelpers() {
  const appPath = fileURLToPath(new URL('../public/app.js', import.meta.url));
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

test('dashboard helper groups contiguous slots and splits gaps into separate schedule windows', () => {
  const helpers = loadDashboardHelpers();
  const data = [
    { ts: Date.parse('2026-03-09T05:00:00Z'), ct_kwh: 1 },
    { ts: Date.parse('2026-03-09T06:00:00Z'), ct_kwh: 2 },
    { ts: Date.parse('2026-03-09T08:00:00Z'), ct_kwh: 3 },
    { ts: Date.parse('2026-03-09T09:00:00Z'), ct_kwh: 4 }
  ];

  assert.equal(typeof helpers.buildScheduleWindowsFromSelection, 'function');
  const windows = JSON.parse(JSON.stringify(helpers.buildScheduleWindowsFromSelection(data, [0, 1, 2, 3])));
  assert.deepEqual(
    windows,
    [
      { start: '06:00', end: '08:00' },
      { start: '09:00', end: '11:00' }
    ]
  );
});

test('dashboard markup and styles expose the chart selection callout and bar highlight states', () => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(publicDir, 'styles.css'), 'utf8');

  assert.match(html, /chartScheduleCallout/);
  assert.match(html, /createSelectionScheduleBtn/);
  assert.match(css, /\.price-bar\.is-hovered/);
  assert.match(css, /\.chart-selection-callout\.is-visible/);
});

test('dashboard exposes and renders today min max with the same scaling as tomorrow', () => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');

  assert.match(html, /id="todayMinMax"/);
  assert.match(app, /'todayMinMax'/);
  assert.match(app, /Number\(s\.todayMin\) \/ 10/);
  assert.match(app, /Number\(s\.todayMax\) \/ 10/);
});
