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

  // Plan 16-04 (D-06 triage, brittle test): the window start/end strings come
  // from app.js `fmtHm`, which uses `toLocaleTimeString` WITHOUT a timeZone —
  // so the output follows the runner's ambient TZ (the test was authored on a
  // Europe/Berlin box; CI here runs Etc/UTC). The behaviour under test is the
  // CONTIGUITY GROUPING (a 1h gap splits the selection into two windows), not
  // the absolute clock formatting. Derive the expected strings the exact same
  // way the production code does, so the assertion is TZ-independent.
  const hm = (ts) => new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const HOUR = 3600 * 1000;

  assert.equal(typeof helpers.buildScheduleWindowsFromSelection, 'function');
  const windows = JSON.parse(JSON.stringify(helpers.buildScheduleWindowsFromSelection(data, [0, 1, 2, 3])));
  assert.equal(windows.length, 2, 'the 1h gap splits the selection into two windows');
  assert.deepEqual(windows, [
    // window 1: slots [0,1] -> 05:00Z..06:00Z, ends at the 06:00Z slot's end (07:00Z)
    { start: hm(data[0].ts), end: hm(data[1].ts + HOUR) },
    // window 2: slots [2,3] -> 08:00Z..09:00Z, ends at the 09:00Z slot's end (10:00Z)
    { start: hm(data[2].ts), end: hm(data[3].ts + HOUR) }
  ]);
});

test('dashboard markup and styles expose the chart selection callout and bar highlight states', () => {
  // Plan 16-04 (D-06 triage, UI-drift): the Aurora dashboard moved the price
  // chart to a Chart.js canvas (no per-bar `.price-bar` DOM element), and split
  // the monolithic styles.css into dvhub-app.css + index.css. Rebuilt as
  // targeted assertions on the shipped chart-selection callout markup + CSS.
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(publicDir, 'index.css'), 'utf8');

  assert.match(html, /id="chartScheduleCallout"/);
  assert.match(html, /id="createSelectionScheduleBtn"/);
  // The callout element carries the .chart-selection-callout class and is
  // toggled via the [hidden] attribute (CSS rule .chart-selection-callout[hidden]).
  assert.match(html, /class="chart-selection-callout"/);
  assert.match(css, /\.chart-selection-callout\s*\{/);
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
  // Plan 16-04 (D-06 triage, UI-drift): styles.css -> per-page index.css. The
  // expired-row styling moved from a CSS class rule to an inline opacity set in
  // app.js (renderScheduleRow toggles `sched-row-expired` + sets tr.style.opacity).
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');

  assert.match(html, /id="chartComparisonSummary"/);
  assert.match(html, /id="chartComparisonDetail"/);
  // Expired schedule windows: app.js toggles the sched-row-expired class and
  // dims the row — assert the shipped behaviour, not a removed CSS-class rule.
  assert.match(app, /sched-row-expired/);
  assert.match(app, /isScheduleWindowExpired/);
});

test('dashboard schedule table exposes stop-soc via the Steuerung column and the slot editor', () => {
  // Operator redesign 2026-06-12: the per-value columns collapsed into one
  // read-only "Steuerung" summary column; STOP-SOC editing moved into the
  // dv-modal slot editor (app.js openSlotEditor).
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(html, /STOP-SOC \(%\)/); // column tooltip documents the summary fields
  assert.match(app, /STOP-SOC \(%\)/); // editor field label
  assert.match(app, /Stop-SoC \$\{Number\(slot\.stopSocPct\)\}%/); // summary text renders the value
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

  // Plan 16-04 (D-06 triage, brittle test): the grouped-rule object legitimately
  // gained an `activeDate` field (per-slot scheduling — app.js ~L2102). A full-
  // object deepEqual pinned every field and broke on the additive change.
  // Hardened to assert the load-bearing fields (the stopSocPct hydration this
  // test exists to guard), tolerant of additive object growth.
  const grouped = JSON.parse(JSON.stringify(helpers.groupScheduleRulesForDashboard(rules)));
  assert.equal(grouped.length, 1, 'one grouped window');
  const g = grouped[0];
  assert.equal(g.start, '08:00');
  assert.equal(g.end, '09:00');
  assert.equal(g.enabled, true);
  assert.equal(g.grid, -40);
  assert.equal(g.charge, 80);
  assert.equal(g.stopSocPct, 25, 'stopSocPct hydrated back onto the grouped rule');
  assert.equal(g.dcExport, false);
  assert.equal(g.ruleId, 'grid_1');
});

test('dashboard schedule row template includes stop-soc controls', () => {
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');

  assert.match(app, /sched-stop-soc-en/);
  assert.match(app, /sched-stop-soc-val/);
});

test('dashboard escapes dynamic schedule and plan row template values', () => {
  // Operator redesign 2026-06-12: schedule rows are now built exclusively via
  // createElement + textContent (renderScheduleTable / openSlotEditor) — no
  // innerHTML templates remain, so injection is impossible by construction.
  // The SMA plan rows still use an innerHTML template and must stay escaped.
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');

  assert.match(app, /function escapeAttr\(value\)/);
  // renderScheduleTable builds rows DOM-node-wise, not via innerHTML
  assert.match(app, /function renderScheduleTable\(\)/);
  assert.match(app, /controlText\.textContent = describeSlotControl\(slot\)/);
  assert.match(app, /tdWindow\.textContent =/);
  assert.doesNotMatch(app, /tr\.innerHTML = `\s*\n?\s*<td><input type="checkbox" class="sched-row-enabled"/);
  // SMA plan rows (innerHTML template) keep their escaping
  assert.match(app, /<td>\$\{escapeAttr\(slot\.time \|\| '\\u2014'\)\}<\/td>/);
  assert.match(app, /<td>\$\{escapeAttr\(powerLabel\)\}<\/td>/);
  assert.match(app, /<td>\$\{escapeAttr\(slot\.priceCtKwh != null \? \(Number\(slot\.priceCtKwh\)\)\.toFixed\(2\) : '\\u2014'\)\} ct\/kWh<\/td>/);
});

test('schedule slot economics: export revenue, import cost, no estimate without fixed wattage', () => {
  const helpers = loadDashboardHelpers();
  assert.equal(typeof helpers.estimateSlotEconomics, 'function');

  // 4 EPEX 15-min slots covering 18:00–19:00 UTC at 40/40/20/20 ct
  const base = Date.parse('2026-06-12T18:00:00Z');
  const Q = 15 * 60000;
  const epex = [
    { ts: base, ct_kwh: 40 },
    { ts: base + Q, ct_kwh: 40 },
    { ts: base + 2 * Q, ct_kwh: 20 },
    { ts: base + 3 * Q, ct_kwh: 20 }
  ];

  // Export slot: −2000 W over the full hour → 2 kWh × 30 ct avg = +0.60 €
  const exportSlot = { grid: -2000, slotTs: base, slotEndTs: base + 4 * Q };
  const exportEcon = helpers.estimateSlotEconomics(exportSlot, epex, base);
  assert.equal(exportEcon.avgCt, 30);
  assert.equal(exportEcon.kwh, 2);
  assert.ok(Math.abs(exportEcon.eur - 0.6) < 1e-9, 'export = revenue (+)');

  // Import slot: +2000 W → cost (−0.60 €)
  const importEcon = helpers.estimateSlotEconomics({ grid: 2000, slotTs: base, slotEndTs: base + 4 * Q }, epex, base);
  assert.ok(Math.abs(importEcon.eur + 0.6) < 1e-9, 'import = cost (−)');

  // dcExport-only slot (no fixed wattage): price yes, € estimate no
  const dcEcon = helpers.estimateSlotEconomics({ dcExport: true, slotTs: base, slotEndTs: base + 4 * Q }, epex, base);
  assert.equal(dcEcon.avgCt, 30);
  assert.equal(dcEcon.eur, null);

  // No overlapping price data → null
  assert.equal(helpers.estimateSlotEconomics({ grid: -2000, slotTs: base + 86400000, slotEndTs: base + 86400000 + Q }, epex, base), null);
});

test('schedule slot window resolves daily HH:MM rules and midnight crossings', () => {
  const helpers = loadDashboardHelpers();
  assert.equal(typeof helpers.scheduleSlotWindowMs, 'function');

  const now = new Date('2026-06-12T10:00:00');
  const win = helpers.scheduleSlotWindowMs({ start: '22:00', end: '02:00' }, now.getTime());
  assert.ok(win.endMs > win.startMs, 'midnight crossing extends into tomorrow');
  assert.equal(win.endMs - win.startMs, 4 * 3600000, '22:00–02:00 = 4h window');

  // Absolute slotTs/slotEndTs wins over HH:MM
  const abs = JSON.parse(JSON.stringify(helpers.scheduleSlotWindowMs({ start: '22:00', end: '02:00', slotTs: 1000, slotEndTs: 2000 }, now.getTime())));
  assert.deepEqual(abs, { startMs: 1000, endMs: 2000 });
});

test('dashboard places the schedule panel directly after the price chart panel', () => {
  // Plan 16-04 (D-06 triage, UI-drift): the Aurora dashboard renamed the
  // schedule panel heading from "Zeitplan" to "Optimizer · Schedule". The
  // load-bearing assertion — schedule panel ordered after the price chart —
  // is preserved against the shipped headings.
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const chartIndex = html.indexOf('Day-Ahead-Preise');
  const scheduleIndex = html.indexOf('Optimizer &middot; Schedule');

  assert.ok(chartIndex >= 0, 'price chart panel must exist');
  assert.ok(scheduleIndex > chartIndex, 'schedule panel must follow the price chart panel');
});

test('dashboard source preserves automation metadata and yellow rule styling', () => {
  // Plan 16-04 (D-06 triage, UI-drift): styles.css split — the
  // .sched-row-automation rule moved to index.css and the
  // --schedule-automation-yellow token moved to the global dvhub-app.css.
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const indexCss = fs.readFileSync(path.join(publicDir, 'index.css'), 'utf8');
  const globalCss = fs.readFileSync(path.join(publicDir, 'dvhub-app.css'), 'utf8');
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');

  // Aurora index.html uses the HTML entity B&ouml;rsenautomatik for the ö.
  assert.match(html, /B(ö|&ouml;)rsenautomatik/);
  assert.match(indexCss, /\.sched-row-automation/);
  assert.match(globalCss, /--schedule-automation-yellow/);
  assert.match(app, /displayTone/);
  assert.match(app, /small_market_automation/);
});
