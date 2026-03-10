import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

function loadHistoryHelpers() {
  const settingsPath = fileURLToPath(new URL('../public/settings.js', import.meta.url));
  const source = fs.readFileSync(settingsPath, 'utf8');
  const sandbox = {
    console,
    globalThis: {},
    window: {
      DVhubCommon: {},
      addEventListener() {},
      setTimeout() {}
    }
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: path.basename(settingsPath) });
  return sandbox.DVhubSettingsHistory;
}

const {
  buildHistoryImportActionState,
  buildHistoryBackfillActionState,
  buildHistoryBackfillRequest,
  buildHistoryImportRequest,
  shouldRenderHistoryImportPanel
} = loadHistoryHelpers();

test('history import panel is only rendered for the telemetry destination', () => {
  assert.equal(shouldRenderHistoryImportPanel('telemetry'), true);
  assert.equal(shouldRenderHistoryImportPanel('connection'), false);
});

test('history import action stays disabled until vrm status is ready and dates are valid', () => {
  const readyState = buildHistoryImportActionState({
    destinationId: 'telemetry',
    status: { enabled: true, ready: true, provider: 'vrm' },
    form: { start: '2026-03-01T00:00', end: '2026-03-02T00:00' },
    busy: false
  });
  const blockedState = buildHistoryImportActionState({
    destinationId: 'telemetry',
    status: { enabled: true, ready: false, provider: 'vrm' },
    form: { start: '2026-03-01T00:00', end: '2026-03-02T00:00' },
    busy: false
  });

  assert.equal(readyState.visible, true);
  assert.equal(readyState.disabled, false);
  assert.equal(readyState.reason, '');
  assert.equal(blockedState.visible, true);
  assert.equal(blockedState.disabled, true);
  assert.equal(blockedState.reason, 'VRM-Zugang ist noch nicht vollständig konfiguriert.');
});

test('history import request converts datetime-local fields into API payload', () => {
  const payload = buildHistoryImportRequest({
    start: '2026-03-01T12:30',
    end: '2026-03-02T00:00',
    interval: 'hours'
  });

  assert.equal(payload.interval, '15mins');
  assert.ok(Number.isFinite(new Date(payload.start).getTime()));
  assert.ok(Number.isFinite(new Date(payload.end).getTime()));
  assert.ok(new Date(payload.end).getTime() > new Date(payload.start).getTime());
});

test('history backfill action is date-free and only gated by vrm readiness', () => {
  const readyState = buildHistoryBackfillActionState({
    destinationId: 'telemetry',
    status: { enabled: true, ready: true, provider: 'vrm' },
    busy: false
  });
  const blockedState = buildHistoryBackfillActionState({
    destinationId: 'telemetry',
    status: { enabled: true, ready: false, provider: 'vrm' },
    busy: false
  });
  const payload = buildHistoryBackfillRequest();

  assert.equal(readyState.visible, true);
  assert.equal(readyState.disabled, false);
  assert.equal(readyState.reason, '');
  assert.equal(blockedState.visible, true);
  assert.equal(blockedState.disabled, true);
  assert.equal(blockedState.reason, 'VRM-Zugang ist noch nicht vollständig konfiguriert.');
  assert.equal(payload.mode, 'backfill');
  assert.equal(payload.interval, '15mins');
});
