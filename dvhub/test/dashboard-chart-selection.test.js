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
  assert.match(app, /fmtCentFromTenthCt\(Number\(s\.todayMin\)\)/);
  assert.match(app, /fmtCentFromTenthCt\(Number\(s\.todayMax\)\)/);
  assert.match(app, /Cent/);
});

test('dashboard helpers compute dynamic gross import prices from market price and surcharges', () => {
  const helpers = loadDashboardHelpers();

  assert.equal(typeof helpers.computeDynamicGrossImportCtKwh, 'function');
  assert.equal(
    helpers.computeDynamicGrossImportCtKwh({
      marketCtKwh: 8,
      components: {
        energyMarkupCtKwh: 2,
        gridChargesCtKwh: 9,
        leviesAndFeesCtKwh: 3,
        vatPct: 19
      }
    }),
    26.18
  );
});

test('dashboard helpers mark schedule windows as expired based on the current local time', () => {
  const helpers = loadDashboardHelpers();

  assert.equal(typeof helpers.isScheduleWindowExpired, 'function');
  assert.equal(
    helpers.isScheduleWindowExpired({ start: '06:00', end: '07:00' }, Date.parse('2026-03-09T08:00:00+01:00')),
    true
  );
  assert.equal(
    helpers.isScheduleWindowExpired({ start: '08:30', end: '09:30' }, Date.parse('2026-03-09T08:45:00+01:00')),
    false
  );
});

test('dashboard refresh helper prevents overlapping refresh runs and coalesces one trailing rerun', async () => {
  const helpers = loadDashboardHelpers();
  const deferred = [];
  let runs = 0;

  assert.equal(typeof helpers.createRefreshCoordinator, 'function');

  const coordinator = helpers.createRefreshCoordinator({
    refreshTask: async () => {
      runs += 1;
      await new Promise((resolve) => deferred.push(resolve));
    }
  });

  const first = coordinator.run();
  const second = coordinator.run();
  const third = coordinator.run();

  assert.equal(runs, 1);
  assert.equal(coordinator.isRunning(), true);

  deferred.shift()();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(runs, 2);

  deferred.shift()();
  await first;
  await second;
  await third;

  assert.equal(runs, 2);
  assert.equal(coordinator.isRunning(), false);
});

test('dashboard refresh task applies status before log resolution and requests only the visible log rows', async () => {
  const helpers = loadDashboardHelpers();
  const calls = [];
  let resolveStatus;
  let resolveLog;
  let statusApplied = false;
  let logApplied = false;

  assert.equal(typeof helpers.createDashboardRefreshTask, 'function');
  assert.equal(typeof helpers.getDashboardLogUrl, 'function');
  assert.equal(helpers.getDashboardLogUrl(), '/api/log?limit=20');

  const refreshTask = helpers.createDashboardRefreshTask({
    fetchStatus: async () => new Promise((resolve) => {
      resolveStatus = () => resolve({ ok: true, json: async () => ({ now: 123 }) });
    }),
    fetchLog: async () => {
      calls.push(helpers.getDashboardLogUrl());
      return new Promise((resolve) => {
        resolveLog = () => resolve({ ok: true, json: async () => ({ rows: [{ event: 'log' }] }) });
      });
    },
    applyStatus: async (status) => {
      statusApplied = true;
      calls.push(`status:${status.now}`);
    },
    applyLog: async (payload) => {
      logApplied = true;
      calls.push(`log:${payload.rows.length}`);
    }
  });

  const pending = refreshTask();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ['/api/log?limit=20']);
  assert.equal(statusApplied, false);
  assert.equal(logApplied, false);

  resolveStatus();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(statusApplied, true);
  assert.equal(logApplied, false);
  assert.deepEqual(calls, ['/api/log?limit=20', 'status:123']);

  resolveLog();
  await pending;
  assert.equal(logApplied, true);
  assert.deepEqual(calls, ['/api/log?limit=20', 'status:123', 'log:1']);
});

test('dashboard dv control helper prefers live GX readback over the last write result', () => {
  const helpers = loadDashboardHelpers();

  assert.equal(typeof helpers.resolveDvControlIndicators, 'function');
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.resolveDvControlIndicators({
      victron: {
        feedExcessDcPv: 1,
        dontFeedExcessAcPv: 0
      },
      ctrl: {
        dvControl: null
      }
    }))),
    {
      dc: { text: 'EIN', tone: 'ok' },
      ac: { text: 'Nein', tone: 'ok' }
    }
  );
});

test('dashboard markup and styles expose user price comparison summary and expired schedule styling', () => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(publicDir, 'styles.css'), 'utf8');

  assert.match(html, /chartComparisonSummary/);
  assert.match(html, /chartComparisonDetail/);
  assert.match(css, /\.sched-row-expired/);
});

test('dashboard schedule table exposes a stop-soc column', () => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  assert.match(html, /STOP-SOC \(%\)/);
});

test('dashboard helpers attach stopSocPct only to grid rules and hydrate it back from grouped rules', () => {
  const helpers = loadDashboardHelpers();

  assert.equal(typeof helpers.collectScheduleRulesFromRowState, 'function');
  assert.equal(typeof helpers.groupScheduleRulesForDashboard, 'function');

  const rules = JSON.parse(JSON.stringify(helpers.collectScheduleRulesFromRowState([
    {
      start: '08:00',
      end: '09:00',
      rowEnabled: true,
      gridEnabled: true,
      gridVal: -40,
      chargeEnabled: true,
      chargeVal: 80,
      stopSocEnabled: true,
      stopSocVal: 25
    }
  ])));

  assert.deepEqual(rules, [
    {
      id: 'grid_1',
      enabled: true,
      target: 'gridSetpointW',
      start: '08:00',
      end: '09:00',
      value: -40,
      stopSocPct: 25
    },
    {
      id: 'charge_1',
      enabled: true,
      target: 'chargeCurrentA',
      start: '08:00',
      end: '09:00',
      value: 80
    }
  ]);

  const grouped = JSON.parse(JSON.stringify(helpers.groupScheduleRulesForDashboard(rules)));
  assert.deepEqual(grouped, [
    {
      start: '08:00',
      end: '09:00',
      enabled: true,
      grid: -40,
      charge: 80,
      stopSocPct: 25,
      ruleId: 'grid_1'
    }
  ]);
});

test('dashboard schedule row template includes stop-soc controls', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');

  assert.match(app, /sched-stop-soc-en/);
  assert.match(app, /sched-stop-soc-val/);
});

test('dashboard escapes dynamic schedule and plan row template values', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');

  assert.match(app, /function escapeAttr\(value\)/);
  assert.match(app, /value="\$\{escapeAttr\(start\)\}"/);
  assert.match(app, /value="\$\{escapeAttr\(end\)\}"/);
  assert.match(app, /value="\$\{escapeAttr\(gridVal\)\}"/);
  assert.match(app, /value="\$\{escapeAttr\(chargeVal\)\}"/);
  assert.match(app, /value="\$\{escapeAttr\(stopSocVal\)\}"/);
  assert.match(app, /title="\$\{escapeAttr\(isAutomation \? 'Automatisch verwaltet' : 'Aktiv'\)\}"/);
  assert.match(app, /<td>\$\{escapeAttr\(slot\.time \|\| '\\u2014'\)\}<\/td>/);
  assert.match(app, /<td>\$\{escapeAttr\(powerLabel\)\}<\/td>/);
  assert.match(app, /<td>\$\{escapeAttr\(slot\.priceCtKwh != null \? \(Number\(slot\.priceCtKwh\)\)\.toFixed\(2\) : '\\u2014'\)\} ct\/kWh<\/td>/);
});

test('dashboard places the schedule panel directly after the price engine panel', () => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const priceIndex = html.indexOf('Preis-Engine');
  const scheduleIndex = html.indexOf('<p class="card-title">Zeitplan</p>');
  const controlIndex = html.indexOf('Manuelle Eingriffe');

  assert.ok(priceIndex >= 0);
  assert.ok(scheduleIndex > priceIndex);
  assert.ok(controlIndex > scheduleIndex);
});

test('dashboard source preserves automation metadata and yellow rule styling', () => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(publicDir, 'styles.css'), 'utf8');
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');

  assert.match(html, /kleine Börsenautomatik/);
  assert.match(css, /\.sched-row-automation/);
  assert.match(css, /--schedule-automation-yellow/);
  assert.match(app, /displayTone/);
  assert.match(app, /small_market_automation/);
});
