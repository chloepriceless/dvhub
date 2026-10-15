// test/control-write-route.test.js — POST /api/control/write am echten Weg
// (2026-10-15, Wartung: der Steuerweg hatte keinen einzigen Test).
//
// Route → applyManualControlWrite (services/control-commands.js) → der echte
// Engpass applyControlTarget aus createScheduleEvaluator (Not-Halt, Grenzen,
// Min-SoC-Klemme, EEG/§14a-Gate, Entlade-Boden) → Test-Hardware (mqttWrite).
// Erwartungen von Hand aus den Regeln in schedule-eval.js / server-utils.js.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createScheduleEvaluator } from '../schedule-eval.js';
import { createApiRoutes } from '../routes-api.js';
import { createRuntimeCommandRequest, validateRuntimeCommand } from '../runtime-commands.js';

function assertValidRuntimeCommand(type, payload) {
  const v = validateRuntimeCommand(createRuntimeCommandRequest(type, payload));
  if (!v.ok) { const e = new Error(v.error); e.statusCode = 400; throw e; }
}

function setup({ soc = 50, socFresh = true, paused = false, allowGridCharge = false, allowGridDischarge = true } = {}) {
  const writes = [];
  const logs = [];
  const state = {
    meter: { ok: false, updatedAt: 0, grid_total_w: 0 },
    victron: { soc, batteryPowerW: 0, pvTotalW: 0, updatedAt: Date.now(), fieldUpdatedAt: socFresh ? { soc: Date.now() } : { soc: Date.now() - 10 * 60_000 } },
    epex: { ok: false, data: [] },
    energy: { day: null, importWh: 0, exportWh: 0, costEur: 0, revenueEur: 0 },
    telemetry: { enabled: false, ok: false },
    keepalive: { modbusLastQuery: null, appPulse: { periodSec: 30 } },
    schedule: {
      rules: [], active: {}, lastWrite: {}, manualOverride: {}, lastEvalAt: 0,
      config: { defaultGridSetpointW: null, defaultChargeCurrentA: null, defaultFeedExcessDcPv: 1 },
    },
    ctrl: { forcedOff: false, offUntil: 0, lastSignal: 'init', updatedAt: 0, dvControl: null, negativePriceActive: false,
      discretionaryWritesPaused: paused, pausedAt: paused ? Date.now() : 0, pausedBy: null, _stopBlockLogged: {} },
    log: [],
    forecast: null,
  };
  const cfg = {
    apiToken: null,
    epex: { enabled: false, timezone: 'Europe/Berlin' },
    controlWrite: {
      gridSetpointW: { enabled: true, address: 100 },
      minSocPct: { enabled: true, address: 101 },
    },
    dvControl: { enabled: false },
    optimizer: { enabled: false, allowGridCharge, allowGridDischarge, hardFloorSocPct: 10 },
    dcExportMode: {},
    victron: { telemetryMaxAgeMs: 90_000 },
    schedule: { timezone: 'Europe/Berlin', manualOverrideTtlMs: 300_000, controlKeepaliveMs: 0, smallMarketAutomation: { enabled: false } },
    telemetry: { enabled: false },
    family: {},
    gridPositiveMeans: 'grid_import',
    keepalivePulseSec: 30,
    corsAllowedOrigins: [],
    allowedHosts: [],
  };
  const ctx = {
    state,
    getCfg: () => cfg,
    getRawCfg: () => cfg,
    transport: { type: 'mqtt', mqttWrite: async (target, value) => { writes.push({ target, value }); } },
    pushLog: (event, payload) => { logs.push({ event, payload: payload || {} }); },
    telemetrySafeWrite: (fn) => { try { fn?.(); } catch { /* no-op */ } },
    persistConfig: () => {},
    persistControlState: () => {},
    telemetryStore: null,
    epexNowNext: () => null,
    regenerateSmallMarketAutomationRules: async () => {},
    onEvalComplete: () => {},
    assertValidRuntimeCommand,
    getLoadedConfig: () => ({ exists: true, valid: true, needsSetup: false }),
    getAppVersion: () => ({ version: '0.0.0-test' }),
    controlValue: () => 'off',
    needsSetup: () => false,
    expireLeaseIfNeeded: () => {},
  };
  const evaluator = createScheduleEvaluator(ctx);
  ctx.applyControlTarget = evaluator.applyControlTarget;
  return { ctx, state, cfg, writes, logs, evaluator };
}

async function post(ctx, path, body) {
  const routes = createApiRoutes(ctx);
  const req = {
    method: 'POST', url: path,
    headers: { host: 'dvhub.test', 'content-type': 'application/json' },
    socket: { remoteAddress: '192.168.1.20' },
    on(ev, cb) {
      if (ev === 'data') setTimeout(() => cb(Buffer.from(JSON.stringify(body))), 0);
      if (ev === 'end') setTimeout(() => cb(), 1);
      return req;
    },
    destroy() {},
  };
  const captured = { status: 0, body: '' };
  const res = { writeHead(c) { captured.status = c; }, setHeader() {}, end(b) { captured.body = b == null ? '' : String(b); } };
  await routes.handleRequest(req, res, new URL(path, 'http://dvhub.test'));
  return { status: captured.status, body: captured.body ? JSON.parse(captured.body) : null };
}

describe('POST /api/control/write — Erfolg', () => {
  it('Entladesollwert −1500 W: Hardware bekommt −1500, Override 5 min, Protokoll', async () => {
    const { ctx, state, writes, logs } = setup();
    const r = await post(ctx, '/api/control/write', { target: 'gridSetpointW', value: -1500 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(writes, [{ target: 'gridSetpointW', value: -1500 }]);
    assert.equal(state.schedule.manualOverride.gridSetpointW.value, -1500);
    assert.equal(state.schedule.manualOverride.gridSetpointW.persistent, undefined);
    assert.ok(logs.some((l) => l.event === 'control_write' && l.payload.result === 'applied'));
  });

  it('persist: true → dauerhafter Override', async () => {
    const { ctx, state } = setup();
    const r = await post(ctx, '/api/control/write', { target: 'gridSetpointW', value: -800, persist: true });
    assert.equal(r.status, 200);
    assert.equal(state.schedule.manualOverride.gridSetpointW.persistent, true);
  });

  it('clear: true → Override weg, keine Hardware-Schreibung', async () => {
    const { ctx, state, writes } = setup();
    state.schedule.manualOverride.gridSetpointW = { value: -800, at: Date.now(), persistent: true };
    const r = await post(ctx, '/api/control/write', { target: 'gridSetpointW', clear: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.cleared, true);
    assert.equal(state.schedule.manualOverride.gridSetpointW, undefined);
    assert.deepEqual(writes, []);
  });

  it('Min-SoC 3 % bei hartem Boden 10 % → geklemmt auf 10', async () => {
    const { ctx, writes } = setup();
    const r = await post(ctx, '/api/control/write', { target: 'minSocPct', value: 3 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(writes, [{ target: 'minSocPct', value: 10 }]);
  });
});

describe('POST /api/control/write — Prüfungen vor dem Engpass (400, nichts geschrieben)', () => {
  for (const [name, body, error] of [
    ['unbekanntes Ziel', { target: 'foo', value: 1 }, 'invalid target'],
    ['Wert keine Zahl', { target: 'gridSetpointW', value: 'abc' }, 'value_not_finite'],
    ['|Sollwert| > 100 kW', { target: 'gridSetpointW', value: -100_001 }, 'value_out_of_range'],
    ['Min-SoC > 100 %', { target: 'minSocPct', value: 101 }, 'minsoc_out_of_range'],
  ]) {
    it(name, async () => {
      const { ctx, state, writes } = setup();
      const r = await post(ctx, '/api/control/write', body);
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(r.body.error, error);
      assert.deepEqual(writes, []);
      assert.deepEqual(state.schedule.manualOverride, {});
    });
  }
});

describe('POST /api/control/write — Sperren am Engpass', () => {
  it('Netzladen +2000 W ohne allowGridCharge → abgelehnt, nichts geschrieben', async () => {
    const { ctx, writes } = setup({ allowGridCharge: false });
    const r = await post(ctx, '/api/control/write', { target: 'gridSetpointW', value: 2000 });
    assert.equal(r.body.ok, false);
    assert.equal(r.body.error, 'grid_charge_not_allowed');
    assert.deepEqual(writes, []);
  });

  it('erzwungene Netzentladung −1500 W ohne allowGridDischarge → abgelehnt', async () => {
    const { ctx, writes } = setup({ allowGridDischarge: false });
    const r = await post(ctx, '/api/control/write', { target: 'gridSetpointW', value: -1500 });
    assert.equal(r.body.error, 'grid_discharge_not_allowed');
    assert.deepEqual(writes, []);
  });

  it('SoC 8 % unter hartem Boden 10 % → Entladung auf 0 gehalten', async () => {
    const { ctx, writes } = setup({ soc: 8 });
    const r = await post(ctx, '/api/control/write', { target: 'gridSetpointW', value: -1500 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(writes, [{ target: 'gridSetpointW', value: 0 }]);
  });

  it('SoC veraltet (10 min) → Entladung auf 0 gehalten', async () => {
    const { ctx, writes } = setup({ socFresh: false });
    await post(ctx, '/api/control/write', { target: 'gridSetpointW', value: -1500 });
    assert.deepEqual(writes, [{ target: 'gridSetpointW', value: 0 }]);
  });

  it('Not-Halt aktiv → blockiert, keine Hardware-Schreibung', async () => {
    const { ctx, writes } = setup({ paused: true });
    const r = await post(ctx, '/api/control/write', { target: 'gridSetpointW', value: -1500 });
    assert.equal(r.body.ok, false);
    assert.equal(r.body.error, 'emergency_stop_active');
    assert.deepEqual(writes, []);
  });
});

describe('Abgelehnter Befehl bleibt nicht als Override stehen', () => {
  // Fund 2026-10-15: der Override wurde VOR dem Engpass gespeichert. Ein im
  // Not-Halt abgelehnter dauerhafter Befehl wurde so nach dem Aufheben vom
  // nächsten Takt angewandt — ein ausdrücklich abgelehnter Befehl wirkte später.
  it('Not-Halt: dauerhafter Befehl wird abgelehnt und nach dem Aufheben NICHT angewandt', async () => {
    const { ctx, state, writes, evaluator } = setup({ paused: true });
    await post(ctx, '/api/control/write', { target: 'gridSetpointW', value: -1500, persist: true });
    assert.equal(state.schedule.manualOverride.gridSetpointW, undefined, 'kein Override aus einem abgelehnten Befehl');
    await post(ctx, '/api/control/resume', {});
    await evaluator.evaluateSchedule();
    assert.equal(writes.some((w) => w.target === 'gridSetpointW' && w.value === -1500), false,
      `nach dem Aufheben darf −1500 nicht geschrieben werden: ${JSON.stringify(writes)}`);
  });

  it('EEG-Gate: abgelehntes Netzladen hinterlässt keinen Override', async () => {
    const { ctx, state } = setup({ allowGridCharge: false });
    await post(ctx, '/api/control/write', { target: 'gridSetpointW', value: 2000, persist: true });
    assert.equal(state.schedule.manualOverride.gridSetpointW, undefined);
  });

  it('vorheriger Override bleibt, wenn ein neuer Befehl abgelehnt wird', async () => {
    const { ctx, state } = setup({ allowGridCharge: false });
    await post(ctx, '/api/control/write', { target: 'gridSetpointW', value: -500, persist: true });
    await post(ctx, '/api/control/write', { target: 'gridSetpointW', value: 2000, persist: true });
    assert.equal(state.schedule.manualOverride.gridSetpointW.value, -500);
    assert.equal(state.schedule.manualOverride.gridSetpointW.persistent, true);
  });
});

describe('Ausnahme im Engpass', () => {
  it('wirft applyControlTarget, bleibt kein Override stehen', async () => {
    const { ctx, state } = setup();
    ctx.applyControlTarget = async () => { throw new Error('modbus kaputt'); };
    await post(ctx, '/api/control/write', { target: 'gridSetpointW', value: -1500, persist: true }).catch(() => {});
    assert.equal(state.schedule.manualOverride.gridSetpointW, undefined);
  });
});

describe('Statuscodes: Ablehnung ist kein Serverfehler (2026-10-15)', () => {
  it('EEG/§14a-Verbot → 403', async () => {
    const { ctx } = setup({ allowGridCharge: false });
    assert.equal((await post(ctx, '/api/control/write', { target: 'gridSetpointW', value: 2000 })).status, 403);
    const d = setup({ allowGridDischarge: false });
    assert.equal((await post(d.ctx, '/api/control/write', { target: 'gridSetpointW', value: -1500 })).status, 403);
  });

  it('Not-Halt aktiv → 409', async () => {
    const { ctx } = setup({ paused: true });
    assert.equal((await post(ctx, '/api/control/write', { target: 'gridSetpointW', value: -1500 })).status, 409);
  });

  it('Ziel nicht freigegeben → 409', async () => {
    const { ctx } = setup();
    const r = await post(ctx, '/api/control/write', { target: 'chargeCurrentA', value: 10 });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'write target not enabled in config');
  });

  it('Gerät nimmt nicht an → 502; Lese-Modus → 409; SunSpec ausstehend → 503', async () => {
    for (const [error, status] of [
      ['modbus exception 2', 502],
      ['Schreibzugriff im Lese-Modus abgelehnt (Modbus fc=6)', 409],
      ['sunspec address not resolved yet (device scan pending)', 503],
      ['value_out_of_range', 400],
    ]) {
      const { ctx } = setup();
      ctx.applyControlTarget = async () => ({ ok: false, error });
      const r = await post(ctx, '/api/control/write', { target: 'gridSetpointW', value: -100 });
      assert.equal(r.status, status, error);
    }
  });
});

describe('EOS/EMHASS-Übernahme: ok nur, wenn alles geschrieben wurde', () => {
  for (const path of ['/api/integration/eos/apply', '/api/integration/emhass/apply']) {
    it(`${path}: alles ok → 200`, async () => {
      const { ctx, writes } = setup();
      const r = await post(ctx, path, { gridSetpointW: -1500 });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.ok, true);
      assert.deepEqual(writes, [{ target: 'gridSetpointW', value: -1500 }]);
    });
    it(`${path}: im Not-Halt abgelehnt → 409, ok false, Einzelergebnisse dabei`, async () => {
      const { ctx, writes } = setup({ paused: true });
      const r = await post(ctx, path, { gridSetpointW: -1500 });
      assert.equal(r.status, 409);
      assert.equal(r.body.ok, false);
      assert.equal(r.body.results[0].error, 'emergency_stop_active');
      assert.deepEqual(writes, []);
    });
  }
});
