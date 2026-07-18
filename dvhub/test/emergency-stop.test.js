// test/emergency-stop.test.js
//
// T-0099 NOT-HALT contract:
//   1. isMandatoryControlSource is a WHITELIST — only §51 curtailment, the
//      SoC-floor safety write and the stop's own neutralization pass; every
//      other (including future, unclassified) source is discretionary.
//   2. With state.ctrl.discretionaryWritesPaused set, applyControlTarget
//      blocks discretionary sources BEFORE any state mutation (lastWrite/
//      active untouched) and logs control_write_blocked_nothalt once per
//      (target,source).
//   3. Mandatory sources keep writing hardware while paused.
//   4. POST /api/control/stop sets the flag FIRST, then neutralizes
//      gridSetpointW=0 via the whitelisted 'emergency_stop' source, persists,
//      and never auto-resumes. POST /api/control/resume clears flag + throttle.
//
// Harness: makeCtx from control-path-hardening.test.js (gate) + minimal-ctx
// route harness from schedule-rules-toggle.test.js (endpoints).

import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';

import { createScheduleEvaluator, isMandatoryControlSource } from '../schedule-eval.js';
import { createApiRoutes } from '../routes-api.js';

// ─── Part 1: source classification ──────────────────────────────────────────

test('whitelist: mandatory sources pass, everything else is discretionary', () => {
  assert.equal(isMandatoryControlSource('negative_price_protection'), true);
  assert.equal(isMandatoryControlSource('manual_override_soc_floor'), true);
  assert.equal(isMandatoryControlSource('emergency_stop'), true);
  // Christin 2026-06-12: dc_export_mode is DV revenue maximization → blocked.
  for (const src of [
    'dc_export_mode', 'sell_price_floor',
    'eos_optimization', 'emhass_optimization', 'api_manual_write',
    'manual_override', 'manual_override_persistent', 'default',
    'rule:abc', 'some_future_unclassified_source', '', null, undefined
  ]) {
    assert.equal(isMandatoryControlSource(src), false, `${src} must be discretionary`);
  }
});

// ─── Part 2: gate in applyControlTarget ──────────────────────────────────────

function makeEvalCtx() {
  const logs = [];
  const writes = [];
  const state = {
    victron: { soc: 50, batteryDischargeW: 0, batteryChargeW: 0, batteryPowerW: 0, pvTotalW: 0, pvPowerW: 0 },
    schedule: {
      rules: [],
      active: {},
      lastWrite: {},
      manualOverride: {},
      config: { defaultGridSetpointW: -40, defaultChargeCurrentA: null, defaultFeedExcessDcPv: 1 },
      lastEvalAt: 0
    },
    ctrl: { negativePriceActive: false, forcedOff: false, discretionaryWritesPaused: false, _stopBlockLogged: {} },
    epex: { data: [] }
  };
  const cfg = {
    controlWrite: { gridSetpointW: { enabled: true, address: 100 } },
    dvControl: { enabled: false, negativePriceProtection: { enabled: true, gridSetpointW: -40 } },
    optimizer: { enabled: false, allowGridCharge: false, allowGridDischarge: true },
    dcExportMode: {},
    schedule: { timezone: 'Europe/Berlin', manualOverrideTtlMs: 300000, controlKeepaliveMs: 0, smallMarketAutomation: { enabled: false } }
  };
  const ctx = {
    state,
    getCfg: () => cfg,
    transport: { type: 'mqtt', mqttWrite: async (target, value) => { writes.push({ target, value }); } },
    pushLog: (event, payload) => { logs.push({ event, payload: payload || {} }); },
    telemetrySafeWrite: (fn) => { try { fn?.(); } catch { /* no-op */ } },
    persistConfig: async () => {},
    telemetryStore: null,
    epexNowNext: () => null,
    regenerateSmallMarketAutomationRules: async () => {},
    onEvalComplete: () => {}
  };
  const evaluator = createScheduleEvaluator(ctx);
  return { evaluator, state, cfg, logs, writes };
}

test('paused: discretionary write is blocked, no hardware write, no state mutation', async () => {
  const { evaluator, state, writes, logs } = makeEvalCtx();
  state.ctrl.discretionaryWritesPaused = true;

  const r = await evaluator.applyControlTarget('gridSetpointW', -5000, 'eos_optimization');

  assert.equal(r.ok, false);
  assert.equal(r.blocked, true);
  assert.equal(r.error, 'emergency_stop_active');
  assert.equal(writes.length, 0, 'no hardware write while paused');
  assert.equal(state.schedule.lastWrite.gridSetpointW, undefined, 'lastWrite untouched');
  assert.equal(state.schedule.active.gridSetpointW, undefined, 'active untouched');
  assert.equal(logs.filter((l) => l.event === 'control_write_blocked_nothalt').length, 1);
});

test('paused: block log is throttled once per (target,source)', async () => {
  const { evaluator, state, logs } = makeEvalCtx();
  state.ctrl.discretionaryWritesPaused = true;

  await evaluator.applyControlTarget('gridSetpointW', -5000, 'eos_optimization');
  await evaluator.applyControlTarget('gridSetpointW', -4000, 'eos_optimization');
  await evaluator.applyControlTarget('gridSetpointW', -3000, 'api_manual_write');

  const blocked = logs.filter((l) => l.event === 'control_write_blocked_nothalt');
  assert.equal(blocked.length, 2, 'one log per (target,source), not per attempt');
});

test('paused: mandatory §51 curtailment still writes hardware', async () => {
  const { evaluator, state, writes } = makeEvalCtx();
  state.ctrl.discretionaryWritesPaused = true;

  const r = await evaluator.applyControlTarget('gridSetpointW', -40, 'negative_price_protection');

  assert.equal(r.ok, true);
  assert.equal(writes.length, 1, '§51 curtailment must not be gated');
  assert.equal(writes[0].value, -40);
});

test('paused: the emergency_stop neutralization itself passes the gate', async () => {
  const { evaluator, state, writes } = makeEvalCtx();
  state.ctrl.discretionaryWritesPaused = true;

  const r = await evaluator.applyControlTarget('gridSetpointW', 0, 'emergency_stop');

  assert.equal(r.ok, true);
  assert.equal(writes.length, 1, 'neutralization write must pass');
  assert.equal(writes[0].value, 0);
});

test('resume: clearing the flag restores discretionary writes', async () => {
  const { evaluator, state, writes } = makeEvalCtx();
  state.ctrl.discretionaryWritesPaused = true;
  await evaluator.applyControlTarget('gridSetpointW', -5000, 'eos_optimization');
  assert.equal(writes.length, 0);

  state.ctrl.discretionaryWritesPaused = false;
  state.ctrl._stopBlockLogged = {};
  const r = await evaluator.applyControlTarget('gridSetpointW', -5000, 'eos_optimization');

  assert.equal(r.ok, true);
  assert.equal(writes.length, 1, 'write goes through after resume');
});

// ─── Part 2b: 25-01 EEG-Gate Mandatory-Source-Ausnahme + NOT-HALT-Regression ──
// Das EEG-Gate (Legalität im Normalbetrieb) und das NOT-HALT-Gate sind ZWEI
// getrennte source-prüfende Achsen (Pitfall 2 / Threat T-25-01-03).
//  - Test 4: Mandatory-Quellen (negative_price_protection) passieren das EEG-Gate
//    auch bei allowGridDischarge=false — die §51-Begrenzung darf nie gegatet werden.
//  - Test 5: dc_export_mode bleibt im NOT-HALT (discretionaryWritesPaused) WEITERHIN
//    BLOCKIERT — die EEG-Gate-Verfeinerung darf die NOT-HALT-Achse NICHT verändern.

test('25-01: mandatory negative_price_protection (-40) passiert das EEG-Gate bei allowGridDischarge=false', async () => {
  const { evaluator, state, cfg, writes, logs } = makeEvalCtx();
  cfg.optimizer.allowGridDischarge = false; // legale Sperre aktiv
  state.victron.fieldUpdatedAt = { soc: Date.now() }; // frisch — kein T-0075-Reject

  const r = await evaluator.applyControlTarget('gridSetpointW', -40, 'negative_price_protection');

  assert.equal(r.ok, true, '§51-Begrenzung (mandatory) muss das EEG-Gate immer passieren');
  assert.notEqual(r.error, 'grid_discharge_not_allowed');
  assert.equal(
    logs.filter((l) => l.event === 'control_write_rejected' && l.payload.reason === 'grid_discharge_not_allowed').length,
    0,
    'eine Mandatory-Quelle darf nicht als Netzentladung abgelehnt werden'
  );
  assert.equal(writes.length, 1, 'der -40 Schutzwert erreicht die Hardware');
  assert.equal(writes[0].value, -40);
});

test('25-02: dc_export_mode (-3000) bleibt im NOT-HALT BLOCKIERT (NOT-HALT-Achse unverändert)', async () => {
  const { evaluator, state, writes, logs } = makeEvalCtx();
  state.ctrl.discretionaryWritesPaused = true; // NOT-HALT aktiv

  const r = await evaluator.applyControlTarget('gridSetpointW', -3000, 'dc_export_mode');

  // dc_export_mode ist bewusst DISKRETIONÄR (Christin 2026-06-12) → im NOT-HALT
  // blockiert. Die EEG-Gate-Verfeinerung (eigene Achse) darf das NICHT aufheben.
  assert.equal(r.ok, false);
  assert.equal(r.blocked, true, 'dc_export_mode bleibt im NOT-HALT blockiert');
  assert.equal(r.error, 'emergency_stop_active');
  assert.equal(writes.length, 0, 'kein Hardware-Export im NOT-HALT');
  assert.equal(logs.filter((l) => l.event === 'control_write_blocked_nothalt').length, 1);
});

// ─── Part 3: stop/resume endpoints ───────────────────────────────────────────

const LAN_IP = '192.168.1.5';

function mockRes() {
  const captured = { status: 0, headers: {}, body: '' };
  return {
    writeHead(code, headers) { captured.status = code; Object.assign(captured.headers, headers); },
    setHeader(k, v) { captured.headers[k] = v; },
    end(payload) { captured.body = payload == null ? '' : String(payload); },
    _captured: captured,
  };
}

function makeReq(method, urlPath) {
  const req = {
    method,
    url: urlPath,
    headers: { host: 'dvhub.test', 'content-type': 'application/json' },
    socket: { remoteAddress: LAN_IP },
    on(event, cb) {
      if (event === 'end') setTimeout(() => cb(), 0);
      return req;
    },
    destroy() { req._destroyed = true; }
  };
  return req;
}

function mockRouteCtx() {
  const cfg = {
    apiToken: null,
    epex: { enabled: false, timezone: 'Europe/Berlin' },
    optimizer: { enabled: false },
    schedule: { timezone: 'Europe/Berlin' },
    telemetry: { enabled: false },
    family: {},
    gridPositiveMeans: 'grid_import',
    keepalivePulseSec: 30,
    corsAllowedOrigins: [],
    allowedHosts: [],
  };
  const controlWrites = [];
  const persisted = [];
  const logged = [];
  return {
    controlWrites,
    persisted,
    logged,
    state: {
      meter: { ok: false, updatedAt: 0, grid_total_w: 0 },
      victron: { soc: 50, batteryPowerW: 0, pvTotalW: 0, updatedAt: 0 },
      epex: { ok: false, data: [] },
      energy: { day: null, importWh: 0, exportWh: 0, costEur: 0, revenueEur: 0 },
      telemetry: { enabled: false, ok: false },
      keepalive: { modbusLastQuery: null, appPulse: { periodSec: 30 } },
      schedule: { rules: [], config: {}, active: {}, lastWrite: {}, manualOverride: {}, lastEvalAt: 0 },
      ctrl: { forcedOff: false, offUntil: 0, lastSignal: 'init', updatedAt: 0, dvControl: null, discretionaryWritesPaused: false, pausedAt: 0, pausedBy: null, _stopBlockLogged: {} },
      log: [],
      forecast: null,
    },
    getCfg: () => cfg,
    getRawCfg: () => cfg,
    getLoadedConfig: () => ({ exists: true, valid: true, needsSetup: false }),
    getConfigPath: () => '/tmp/config.json',
    getConfigDefinition: () => [],
    getAppVersion: () => ({ version: '0.9.0-test' }),
    getTransportType: () => 'modbus',
    getAppDir: () => '/tmp',
    getRepoRoot: () => '/tmp',
    getServiceActionsEnabled: () => false,
    getServiceName: () => 'dvhub',
    getServiceUseSudo: () => false,
    runServiceCommand: async () => ({ ok: true }),
    controlValue: () => 'off',
    pushLog: (event, payload) => { logged.push({ event, payload }); },
    telemetrySafeWrite: () => {},
    needsSetup: () => false,
    epexNowNext: () => null,
    expireLeaseIfNeeded: () => {},
    persistConfig: () => {},
    persistControlState: () => { persisted.push('control_state'); },
    getCachedRuntimeStatusPayload: () => null,
    buildFallbackStatusPayload: (now) => ({ ok: true, now }),
    buildRuntimeRouteMeta: () => ({}),
    applyControlTarget: async (target, value, source) => {
      controlWrites.push({ target, value, source });
      return { ok: true };
    },
    buildSystemDiscoveryPayload: async () => ({ ok: true }),
  };
}

async function call(ctx, method, urlPath) {
  const routes = createApiRoutes(ctx);
  const req = makeReq(method, urlPath);
  const res = mockRes();
  const url = new URL(req.url, `http://${req.headers.host}`);
  await routes.handleRequest(req, res, url);
  const parsed = res._captured.body ? JSON.parse(res._captured.body) : null;
  return { status: res._captured.status, body: parsed };
}

describe('POST /api/control/stop + /resume (T-0099 NOT-HALT)', () => {
  it('stop sets the flag, neutralizes gridSetpointW=0 via emergency_stop, persists', async () => {
    const ctx = mockRouteCtx();
    const out = await call(ctx, 'POST', '/api/control/stop');

    assert.equal(out.status, 200);
    assert.equal(out.body.ok, true);
    assert.equal(out.body.paused, true);
    assert.equal(ctx.state.ctrl.discretionaryWritesPaused, true);
    assert.ok(ctx.state.ctrl.pausedAt > 0);
    assert.deepEqual(ctx.controlWrites, [{ target: 'gridSetpointW', value: 0, source: 'emergency_stop' }]);
    assert.deepEqual(ctx.persisted, ['control_state']);
    assert.ok(ctx.logged.some((l) => l.event === 'emergency_stop_activated'));
  });

  it('stop is idempotent — second call reports alreadyStopped, no second neutralization', async () => {
    const ctx = mockRouteCtx();
    await call(ctx, 'POST', '/api/control/stop');
    const out = await call(ctx, 'POST', '/api/control/stop');

    assert.equal(out.status, 200);
    assert.equal(out.body.alreadyStopped, true);
    assert.equal(ctx.controlWrites.length, 1, 'neutralization fired exactly once');
    assert.equal(ctx.persisted.length, 1);
  });

  it('a failed neutralization still leaves writes paused and logs loudly', async () => {
    const ctx = mockRouteCtx();
    ctx.applyControlTarget = async () => ({ ok: false, error: 'modbus timeout' });
    const out = await call(ctx, 'POST', '/api/control/stop');

    assert.equal(out.status, 200);
    assert.equal(out.body.ok, true, 'pause succeeds even if neutralize fails');
    assert.equal(ctx.state.ctrl.discretionaryWritesPaused, true);
    assert.equal(out.body.neutralize.ok, false);
    assert.ok(ctx.logged.some((l) => l.event === 'emergency_stop_neutralize_failed'));
  });

  it('no failure log when NO gridSetpointW write path is enabled (Fronius sequence dialect)', async () => {
    // Fronius/Deye: Abregelung = M124-/Work-Mode-Sequenz, controlWrite.gridSetpointW
    // ist enabled:false → der Chokepoint meldet not-enabled. Das ist ein No-op,
    // kein Fehler — der Ring darf nicht bei jedem Not-Halt fluten.
    const ctx = mockRouteCtx();
    ctx.applyControlTarget = async () => ({ ok: false, error: 'write target not enabled in config' });
    const out = await call(ctx, 'POST', '/api/control/stop');

    assert.equal(out.status, 200);
    assert.equal(out.body.ok, true);
    assert.equal(ctx.state.ctrl.discretionaryWritesPaused, true, 'pause active regardless');
    assert.equal(out.body.neutralize.skipped, true);
    assert.equal(out.body.neutralize.reason, 'target_not_enabled');
    assert.ok(!ctx.logged.some((l) => l.event === 'emergency_stop_neutralize_failed'),
      'benign no-write-path case must not log a failure');
  });

  it('resume clears flag + throttle map and persists; idempotent when not paused', async () => {
    const ctx = mockRouteCtx();
    await call(ctx, 'POST', '/api/control/stop');
    ctx.state.ctrl._stopBlockLogged = { 'gridSetpointW|eos_optimization': true };

    const out = await call(ctx, 'POST', '/api/control/resume');
    assert.equal(out.status, 200);
    assert.equal(out.body.resumed, true);
    assert.equal(ctx.state.ctrl.discretionaryWritesPaused, false);
    assert.equal(ctx.state.ctrl.pausedAt, 0);
    assert.deepEqual(ctx.state.ctrl._stopBlockLogged, {}, 'block-log throttle cleared');
    assert.ok(ctx.logged.some((l) => l.event === 'emergency_stop_resumed'));

    const again = await call(ctx, 'POST', '/api/control/resume');
    assert.equal(again.body.alreadyRunning, true);
  });

  it('/api/status carries the emergencyStop field', async () => {
    const ctx = mockRouteCtx();
    await call(ctx, 'POST', '/api/control/stop');
    const out = await call(ctx, 'GET', '/api/status');

    assert.equal(out.status, 200);
    assert.equal(out.body.emergencyStop.active, true);
    assert.ok(out.body.emergencyStop.pausedAt > 0);
  });
});
