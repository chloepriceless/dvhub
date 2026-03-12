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
  }), /Keine offenen VRM-Luecken/);

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
