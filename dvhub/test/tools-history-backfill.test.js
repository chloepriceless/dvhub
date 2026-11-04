import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

function loadToolsHelpers() {
  const toolsPath = fileURLToPath(new URL('../public/tools.js', import.meta.url));
  const source = fs.readFileSync(toolsPath, 'utf8');
  const sandbox = {
    console,
    globalThis: {},
    window: {
      DVhubCommon: {}
    }
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: path.basename(toolsPath) });
  return sandbox.DVhubToolsHistory;
}

const {
  buildHistoryGapBackfillRequest,
  buildHistoryFullBackfillRequest,
  buildHistoryBackfillActionState,
  buildHistoryFullBackfillActionState,
  buildMaintenanceBootstrapPlan,
  formatHistoryImportResult
} = loadToolsHelpers();

test('gap backfill request is date-free and defaults to gap mode', () => {
  const payload = buildHistoryGapBackfillRequest();
  const state = buildHistoryBackfillActionState({
    status: { enabled: true, ready: true, backfillRunning: false },
    busy: false
  });

  assert.equal(payload.mode, 'gap');
  assert.equal(payload.interval, '15mins');
  assert.equal(state.disabled, false);
  assert.equal(state.reason, '');
});

test('full backfill stays locked until the warning is acknowledged', () => {
  const payload = buildHistoryFullBackfillRequest();
  const lockedState = buildHistoryFullBackfillActionState({
    status: { enabled: true, ready: true, backfillRunning: false },
    busy: false,
    acknowledged: false
  });
  const unlockedState = buildHistoryFullBackfillActionState({
    status: { enabled: true, ready: true, backfillRunning: false },
    busy: false,
    acknowledged: true
  });

  assert.equal(payload.mode, 'full');
  assert.equal(payload.interval, '15mins');
  assert.equal(payload.maxLookbackDays, 14);
  assert.equal(lockedState.disabled, true);
  assert.match(lockedState.reason, /Warnung/);
  assert.equal(unlockedState.disabled, false);
  assert.equal(unlockedState.reason, '');
});

test('full backfill request uses a custom lookback only when the advanced option is active', () => {
  const defaultPayload = buildHistoryFullBackfillRequest({
    extendedLookbackEnabled: false,
    maxLookbackDays: '365'
  });
  const customPayload = buildHistoryFullBackfillRequest({
    extendedLookbackEnabled: true,
    maxLookbackDays: '365'
  });

  assert.equal(defaultPayload.maxLookbackDays, 14);
  assert.equal(customPayload.maxLookbackDays, 365);
});

test('tools result text distinguishes gap and full backfills', () => {
  assert.match(formatHistoryImportResult({
    ok: true,
    mode: 'gap',
    windowsVisited: 0,
    importedWindows: 0,
    importedRows: 0
  }), /Keine offenen VRM-Lücken/);

  assert.match(formatHistoryImportResult({
    ok: true,
    mode: 'full',
    windowsVisited: 12,
    importedWindows: 8,
    importedRows: 2400,
    jobId: 17
  }), /Voll-Backfill gestartet/);
});

test('maintenance bootstrap avoids automatic scan and health polling on page load', () => {
  const plan = buildMaintenanceBootstrapPlan();

  assert.equal(plan.loadSchedule, true);
  assert.equal(plan.loadHistoryImportStatus, true);
  assert.equal(plan.loadHealth, false);
  assert.equal(plan.refreshScan, false);
  assert.equal(plan.scanRefreshMs, 0);
});

// Gesamtprüfung 1.0.9 (Hauptbefund 14): Die Verfolgung eines Update-Auftrags
// verglich die Browser-Uhr (Date.now() − 30 s) mit `started` von der Box-Uhr.
// Weicht eine der Uhren ab, blieb der Auftrag unsichtbar (20 min „keine
// Rückmeldung“) oder ein altes Ergebnis galt als neues. Jetzt zählt nur, ob
// sich `started` gegenüber dem Stand vor dem Auftrag geändert hat.
test('Update-Auftrag: erkannt ohne Uhrvergleich zwischen Browser und Box', () => {
  const { releaseJobVerdict } = loadToolsHelpers();
  assert.equal(typeof releaseJobVerdict, 'function');
  const old = { state: 'ok', started: '2026-11-03T10:00:00.000Z' };
  const baseline = { known: true, started: old.started };
  // Box-Uhr weit hinter dem Browser (Pi ohne RTC): neuer Auftrag trotzdem sichtbar.
  const fresh = { state: 'running', phase: 'download', started: '2020-01-01T00:00:05.000Z' };
  assert.equal(releaseJobVerdict(fresh, baseline, false), 'active');
  assert.equal(releaseJobVerdict({ ...fresh, state: 'ok' }, baseline, true), 'done');
  // Box-Uhr vor dem Browser: das alte Ergebnis gilt nicht als neues.
  const future = { state: 'ok', started: '2099-01-01T00:00:00.000Z' };
  assert.equal(releaseJobVerdict(future, { known: true, started: future.started }, false), 'ignore');
  assert.equal(releaseJobVerdict(null, baseline, false), 'ignore');
  // Stand vor dem Auftrag unbekannt: Ergebnis erst, nachdem der Auftrag laufend gesehen wurde.
  assert.equal(releaseJobVerdict(old, { known: false }, false), 'ignore');
  assert.equal(releaseJobVerdict({ ...old, state: 'queued' }, { known: false }, false), 'active');
  assert.equal(releaseJobVerdict(old, { known: false }, true), 'done');
  // Anker (erster Stand nach dem Start): er und spätere zählen, frühere nicht —
  // auch ein schnell gescheiterter Auftrag (Gegenprüfung ce629829, P3).
  const anchor = { known: true, started: null, anchor: '2020-01-01T00:00:05.000Z' };
  assert.equal(releaseJobVerdict({ state: 'failed', started: '2020-01-01T00:00:06.000Z' }, anchor, false), 'done');
  assert.equal(releaseJobVerdict({ state: 'queued', started: anchor.anchor }, anchor, false), 'active');
  assert.equal(releaseJobVerdict({ state: 'ok', started: '2019-12-31T23:00:00.000Z' }, anchor, false), 'ignore');
  // Kein früherer Auftrag: jeder Stand ist der neue.
  assert.equal(releaseJobVerdict({ state: 'failed', started: 'x' }, { known: true, started: null }, false), 'done');
});

test('Update-Verfolgung nutzt keine Browser-Uhr mehr', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../public/tools.js', import.meta.url)), 'utf8');
  const fn = src.slice(src.indexOf('async function trackReleaseJob'), src.indexOf('async function rollbackUpdate'));
  assert.ok(fn.length > 0);
  assert.doesNotMatch(fn, /Date\.parse\(st\.started/);
  assert.doesNotMatch(fn, /Date\.now\(\) - 30000/);
});
