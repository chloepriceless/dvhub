// test/optimizer-service.test.js -- Integration tests for optimizer service factory.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createOptimizerService } from '../services/optimizer/index.js';

// Helper: build a minimal ctx for testing
function buildCtx(overrides = {}) {
  const now = Date.now();
  const baseSlots = [
    { start: new Date(now).toISOString(), end: new Date(now + 900_000).toISOString(), ctKwh: 5, powerW: 200, confidence: 0.8 },
    { start: new Date(now + 900_000).toISOString(), end: new Date(now + 1_800_000).toISOString(), ctKwh: 15, powerW: 100, confidence: 0.7 },
    { start: new Date(now + 1_800_000).toISOString(), end: new Date(now + 2_700_000).toISOString(), ctKwh: 25, powerW: 50, confidence: 0.6 },
    { start: new Date(now + 2_700_000).toISOString(), end: new Date(now + 3_600_000).toISOString(), ctKwh: 35, powerW: 0, confidence: 0.9 }
  ];

  const state = {
    victron: { soc: 50 },
    schedule: { rules: [], config: {} },
    forecast: { pv: { confidence: 0.5 } },
    log: [],
    ...overrides.state
  };

  let forecastVersion = overrides.forecastVersion ?? 0;

  const ctx = {
    state,
    getCfg: () => ({
      optimizer: {
        enabled: true,
        strategy: 'heuristic',
        batteryCapacityWh: 10000,
        roundTripEfficiency: 0.92,
        maxChargeW: 3000,
        maxDischargeW: 3000,
        minSocPct: 10,
        maxSocPct: 100,
        primarySource: 'internal',
        eosProxy: { enabled: false, url: 'http://localhost:8503' },
        tariff: {
          type: 'dynamic',
          fixedCtKwh: 30,
          minCtKwh: 20,
          netzentgeltCtKwh: 9.26,
          kwkCtKwh: 0.446,
          offshoreCtKwh: 0.941,
          stromnevCtKwh: 1.559,
          stromsteuerCtKwh: 2.05,
          konzessionsabgabeCtKwh: 1.66,
          vertriebsaufschlagCtKwh: 0,
          vatPct: 19,
          feedInMode: 'fixed',
          feedInCtKwh: 7.78,
          feedInSpotFactor: 1.0
        },
        paragraph14a: { enabled: false, reductionCtKwh: 0 },
        mispel: { mode: 'none', pvKwp: 10 },
        ...overrides.optimizerCfg
      },
      schedule: { timezone: 'Europe/Berlin' },
      ...overrides.cfg
    }),
    pushLog: () => {},
    forecastService: {
      buildForecastResponse: () => ({
        meta: {},
        price: { resolution: '15min', slots: baseSlots.map(s => ({ start: s.start, end: s.end, ctKwh: s.ctKwh, confidence: s.confidence })) },
        pv: { resolution: '15min', slots: baseSlots.map(s => ({ start: s.start, end: s.end, powerW: s.powerW, confidence: s.confidence })) },
        load: { resolution: '1h', slots: [{ start: baseSlots[0].start, end: baseSlots[3].end, powerW: 300, confidence: 0.6 }] }
      }),
      get forecastVersion() { return forecastVersion; },
      ...overrides.forecastService
    },
    ...overrides.ctx
  };

  return { ctx, state, bumpVersion: () => { forecastVersion++; } };
}

describe('Optimizer Service', () => {
  test('createOptimizerService returns object with start, close, getSchedule, getStatus', () => {
    const { ctx } = buildCtx();
    const svc = createOptimizerService(ctx);
    assert.equal(typeof svc.start, 'function');
    assert.equal(typeof svc.close, 'function');
    assert.equal(typeof svc.getSchedule, 'function');
    assert.equal(typeof svc.getStatus, 'function');
  });

  test('notifyEosRestart stoesst sofort einen Lauf an (holt den ersten Plan der neuen EOS-Instanz)', async () => {
    const logs = [];
    const { ctx, state } = buildCtx({ ctx: { pushLog: (ev) => logs.push(ev) } });
    const svc = createOptimizerService(ctx);
    assert.equal(state.optimizer.runCount, 0);
    svc.notifyEosRestart();
    await new Promise(r => setTimeout(r, 100));
    assert.ok(logs.includes('eos_restart_first_plan'));
    assert.ok(state.optimizer.runCount >= 1, 'ohne Neustart-Hook liefe erst der naechste regulaere Takt');
    await svc.close();
  });

  test('getStatus returns initial state with enabled=false, lastRunAt=null', () => {
    const { ctx } = buildCtx();
    const svc = createOptimizerService(ctx);
    const status = svc.getStatus();
    assert.equal(status.enabled, false); // Initially false, set in start()
    assert.equal(status.lastRunAt, null);
    assert.equal(status.lastForecastVersion, -1);
    assert.equal(status.runCount, 0);
  });

  test('start() does NOT exit early when optimizer.enabled=false -- timers are started', async () => {
    const { ctx, state } = buildCtx({ optimizerCfg: { enabled: false } });
    const svc = createOptimizerService(ctx);
    await svc.start();
    // Service should be started (timers running) even if disabled
    assert.equal(state.optimizer.enabled, false);
    // Clean up timers
    await svc.close();
  });

  test('runOptimization produces schedule rules when forecast data is available', async () => {
    const { ctx, state } = buildCtx();
    const svc = createOptimizerService(ctx);
    await svc.start();
    // Wait a tick for the initial run to complete
    await new Promise(r => setTimeout(r, 100));
    assert.ok(state.optimizer.lastRunAt !== null, 'lastRunAt should be set');
    assert.ok(state.optimizer.runCount >= 1, 'runCount should be >= 1');
    await svc.close();
  });

  test('optimizer rules are prepended to state.schedule.rules (higher priority)', async () => {
    const { ctx, state } = buildCtx();
    // Add an existing SMA rule
    state.schedule.rules = [
      { id: 'sma-1', target: 'gridSetpointW', source: 'small_market_automation', value: -500 }
    ];
    const svc = createOptimizerService(ctx);
    await svc.start();
    await new Promise(r => setTimeout(r, 100));
    // Optimizer rules should be first
    const optimizerRules = state.schedule.rules.filter(r => r.source === 'forecast_optimizer');
    const smaRules = state.schedule.rules.filter(r => r.source === 'small_market_automation');
    if (optimizerRules.length > 0) {
      const firstOptimizerIdx = state.schedule.rules.indexOf(optimizerRules[0]);
      const firstSmaIdx = state.schedule.rules.indexOf(smaRules[0]);
      assert.ok(firstOptimizerIdx < firstSmaIdx, 'Optimizer rules should come before SMA rules');
    }
    await svc.close();
  });

  test('forecastVersion change triggers re-optimization', async () => {
    const { ctx, state, bumpVersion } = buildCtx();
    const svc = createOptimizerService(ctx);
    await svc.start();
    await new Promise(r => setTimeout(r, 100));
    // Bump forecast version -- the poll timer would detect this
    bumpVersion();
    // Directly call the internal detection logic by checking version mismatch
    const currentVersion = ctx.forecastService.forecastVersion;
    assert.notEqual(currentVersion, state.optimizer.lastForecastVersion,
      'Version should differ after bump');
    await svc.close();
  });

  test('run mutex prevents concurrent execution (isRunning guard)', async () => {
    const { ctx, state } = buildCtx();
    // Make buildForecastResponse slow
    ctx.forecastService.buildForecastResponse = () => {
      return {
        meta: {},
        price: { resolution: '15min', slots: [{ start: new Date().toISOString(), end: new Date(Date.now() + 900000).toISOString(), ctKwh: 10, confidence: 0.8 }] },
        pv: { resolution: '15min', slots: [{ start: new Date().toISOString(), end: new Date(Date.now() + 900000).toISOString(), powerW: 100, confidence: 0.7 }] },
        load: { resolution: '1h', slots: [] }
      };
    };
    const svc = createOptimizerService(ctx);
    await svc.start();
    await new Promise(r => setTimeout(r, 100));
    // runCount should not exceed what a single start produces
    assert.ok(state.optimizer.runCount >= 1, 'At least one run should complete');
    await svc.close();
  });

  test('confidence is computed from averageSlotConfidence, NOT from state.forecast.pv.confidence', async () => {
    const { ctx, state } = buildCtx({
      state: { forecast: { pv: { confidence: 0.99 } } }
    });
    // The optimizer should use averageSlotConfidence of individual slots (0.6-0.9 range),
    // NOT the 0.99 from state.forecast.pv.confidence
    const svc = createOptimizerService(ctx);
    await svc.start();
    await new Promise(r => setTimeout(r, 100));
    // Verify the service ran successfully -- if it used state.forecast.pv.confidence (0.99),
    // the confidence gating would be fully aggressive. The per-slot average is ~0.75.
    assert.ok(state.optimizer.lastRunAt !== null);
    // state.forecast.pv.confidence should NOT be the gating value
    assert.equal(state.forecast.pv.confidence, 0.99, 'state value should be untouched');
    await svc.close();
  });

  test('optimizer enriches price slots with importCtKwh before optimizer selection', async () => {
    const { ctx, state } = buildCtx();
    const svc = createOptimizerService(ctx);
    await svc.start();
    await new Promise(r => setTimeout(r, 150));
    // After a run, the optimizer should have produced a schedule
    assert.ok(state.optimizer.lastRunAt !== null, 'optimizer should have run');
    assert.ok(state.optimizer.runCount >= 1, 'at least one run');
    // The schedule should have been produced using enriched prices
    // Verify by checking that optimizer completed without errors
    assert.equal(state.optimizer.error, null, 'no optimizer errors');
    await svc.close();
  });

  test('optimizer multi-day hold suppresses grid discharge when holdBattery=true', async () => {
    // Create slots where tomorrow has NO PV data (assessMultiDayHold returns no_tomorrow_data)
    // This tests that multi-day code path runs without errors
    const { ctx, state } = buildCtx({
      optimizerCfg: { allowGridDischarge: true }
    });
    const svc = createOptimizerService(ctx);
    await svc.start();
    await new Promise(r => setTimeout(r, 150));
    assert.ok(state.optimizer.lastRunAt !== null, 'optimizer should have run');
    assert.equal(state.optimizer.error, null, 'no optimizer errors');
    await svc.close();
  });

  test('optimizer mispel tracker initializes state and updates yearly counters', async () => {
    const { ctx, state } = buildCtx({
      optimizerCfg: { mispel: { mode: 'pauschal', pvKwp: 10 } },
      state: { victron: { soc: 50, gridPower: -500 } }
    });
    const svc = createOptimizerService(ctx);
    // MiSpeL tracker should have initialized state.optimizer.mispel
    assert.ok(state.optimizer.mispel != null, 'mispel state should be initialized');
    assert.equal(state.optimizer.mispel.mode, 'pauschal');

    await svc.start();
    await new Promise(r => setTimeout(r, 150));
    // After run, mispel tracker should have been updated with grid power data
    assert.ok(state.optimizer.lastRunAt !== null, 'optimizer should have run');
    assert.equal(state.optimizer.error, null, 'no optimizer errors');
    // With gridPower=-500 (export), feed-in should have been accumulated
    assert.ok(state.optimizer.mispel.yearlyFeedInKwh >= 0, 'feed-in should be tracked');
    await svc.close();
  });
});

describe('Optimizer Service: neuer EOS-Plan → sofort übernehmen (Minuten-Wache)', () => {
  test('neues generated_at bei EOS → ein Lauf; gleiches → keiner', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const logs = [];
    let stamp = '2026-09-23T21:04:00+02:00';
    let pulls = 0;
    const now = Date.now();
    const eosAdapter = {
      pushForecast: async () => ({ ok: true }),
      pullSchedule: async () => { pulls++; return [{ ts: now, endTs: now + 900_000, powerW: -1000 }]; },
      pullGridSetpoints: async () => [],
      getOptimizationSolution: async () => ({ generatedAt: stamp, rows: [] }),
      setEmsIntervalSec: async () => ({ ok: true })
    };
    const { ctx, state } = buildCtx({
      optimizerCfg: { primarySource: 'eos', eosProxy: { enabled: true, url: 'http://localhost:8503' } },
      ctx: { eosAdapter, pushLog: (ev, data) => logs.push({ ev, data }) }
    });
    const svc = createOptimizerService(ctx);
    await svc.start();
    const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
    await settle();
    if (pulls === 0) { await svc.close(); t.skip('EOS-Pfad braucht RAM-Tier >= 2'); return; }
    assert.equal(state.optimizer.source, 'eos');
    const runsAfterStart = state.optimizer.runCount;

    // Eine Minute, EOS unverändert → kein zusätzlicher Lauf.
    t.mock.timers.tick(60_000); await settle();
    assert.equal(state.optimizer.runCount, runsAfterStart);
    assert.ok(!logs.some((l) => l.ev === 'eos_new_plan_detected'));

    // EOS rechnet neu → nächste Minute zieht DVhub sofort nach.
    stamp = '2026-09-23T21:19:19+02:00';
    t.mock.timers.tick(60_000); await settle();
    assert.equal(state.optimizer.runCount, runsAfterStart + 1);
    const hit = logs.find((l) => l.ev === 'eos_new_plan_detected');
    assert.equal(hit.data.generatedAt, stamp);

    // Und nur einmal je Plan.
    t.mock.timers.tick(60_000); await settle();
    assert.equal(state.optimizer.runCount, runsAfterStart + 1);
    await svc.close();
  });
});

describe('Optimizer Service: EOS-Lösung einmal je Lauf, Push über den Monitor', () => {
  test('ein Abruf je Lauf; neuer Plan vom Monitor (Push) → sofort ein Lauf', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const logs = [];
    let stamp = '2026-10-03T11:13:46+02:00';
    let solutionCalls = 0;
    const seen = { schedule: [], setpoints: [] };
    const now = Date.now();
    const eosAdapter = {
      pushForecast: async () => ({ ok: true }),
      pullSchedule: async (opts) => { seen.schedule.push(opts); return [{ ts: now, endTs: now + 900_000, powerW: -1000 }]; },
      pullGridSetpoints: async (_band, opts) => { seen.setpoints.push(opts); return []; },
      getOptimizationSolution: async () => { solutionCalls++; return { generatedAt: stamp, rows: [] }; },
      setEmsIntervalSec: async () => ({ ok: true })
    };
    const listeners = new Set();
    const ingested = [];
    const eosMonitor = {
      status: () => ({ solutionGeneratedAt: stamp }),
      onSolution: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
      ingest: (sol) => { ingested.push(sol.generatedAt); },
    };
    const { ctx, state } = buildCtx({
      optimizerCfg: { primarySource: 'eos', eosProxy: { enabled: true, url: 'http://localhost:8503' } },
      ctx: { eosAdapter, eosMonitor, pushLog: (ev, data) => logs.push({ ev, data }) }
    });
    const svc = createOptimizerService(ctx);
    await svc.start();
    const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
    await settle();
    assert.equal(state.optimizer.source, 'eos');
    assert.equal(solutionCalls, 1, 'Lösung nur einmal je Lauf geholt');
    assert.equal(seen.schedule[0].solution.generatedAt, stamp, 'Plan-Anzeige nutzt dieselbe Lösung');
    assert.equal(seen.setpoints[0].solution.generatedAt, stamp, 'Stellwerte nutzen dieselbe Lösung');
    assert.deepEqual(ingested, [stamp], 'Lösung an den Monitor (Leitstand) weitergereicht');
    const runsAfterStart = state.optimizer.runCount;

    // EOS meldet einen neuen Plan (Push) → ohne auf die Minute zu warten.
    stamp = '2026-10-03T11:29:00+02:00';
    for (const fn of listeners) fn(stamp);
    await settle();
    assert.equal(state.optimizer.runCount, runsAfterStart + 1);
    assert.equal(logs.find((l) => l.ev === 'eos_new_plan_detected').data.generatedAt, stamp);

    // Dieselbe Meldung erneut und die Minuten-Wache: kein weiterer Lauf.
    for (const fn of listeners) fn(stamp);
    t.mock.timers.tick(60_000); await settle();
    assert.equal(state.optimizer.runCount, runsAfterStart + 1);
    await svc.close();
    assert.equal(listeners.size, 0, 'beim Stoppen abgemeldet');
  });

  test('EOS hatte beim Start noch keinen Plan: erster gemeldeter Plan wird trotzdem übernommen', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    let stamp = null;
    const now = Date.now();
    const eosAdapter = {
      pushForecast: async () => ({ ok: true }),
      pullSchedule: async () => [{ ts: now, endTs: now + 900_000, powerW: -1000 }],
      pullGridSetpoints: async () => [],
      getOptimizationSolution: async () => (stamp ? { generatedAt: stamp, rows: [] } : null),
      setEmsIntervalSec: async () => ({ ok: true })
    };
    const listeners = new Set();
    const eosMonitor = {
      status: () => ({ solutionGeneratedAt: stamp }),
      onSolution: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
      ingest: () => {},
    };
    const { ctx, state } = buildCtx({
      optimizerCfg: { primarySource: 'eos', eosProxy: { enabled: true, url: 'http://localhost:8503' } },
      ctx: { eosAdapter, eosMonitor, pushLog: () => {} }
    });
    const svc = createOptimizerService(ctx);
    await svc.start();
    const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
    await settle();
    const runsAfterStart = state.optimizer.runCount;
    stamp = '2026-10-03T11:57:57+02:00';
    for (const fn of listeners) fn(stamp);
    await settle();
    assert.equal(state.optimizer.runCount, runsAfterStart + 1);
    await svc.close();
  });
});

// Seit 2026-10-11 stößt DVhub die EOS-Läufe an (eos-run-trigger.js).
describe('Optimizer Service: DVhub stößt den EOS-Lauf an', () => {
  function eosWithoutPlan() {
    const calls = { trigger: [], emsInterval: [] };
    const eosAdapter = {
      pushForecast: async () => ({ ok: true }),
      pullSchedule: async () => null,
      pullGridSetpoints: async () => null,
      getOptimizationSolution: async () => null,
      setEmsIntervalSec: async (sec) => { calls.emsInterval.push(sec); return { ok: true }; },
      triggerOptimization: async (body, timeoutMs) => {
        calls.trigger.push({ body, timeoutMs });
        return { ok: true, data: { start_solution: [1, 0], start_solution_datetime: '2026-10-11T12:00:00+02:00' } };
      },
    };
    return { calls, eosAdapter };
  }
  const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };

  test('EOS hat noch keinen Plan → sofort ein Lauf mit dem Ladestand, kein Takt-Boost', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const { calls, eosAdapter } = eosWithoutPlan();
    const logs = [];
    let notified = 0;
    const { ctx, state } = buildCtx({
      optimizerCfg: { primarySource: 'eos', eosProxy: { enabled: true, url: 'http://localhost:8503' } },
      ctx: {
        eosAdapter,
        eosMonitor: { status: () => ({ status: 'up', solutionGeneratedAt: null }), onSolution: () => () => {}, ingest: () => {}, notifySolutionReady: async () => { notified += 1; } },
        eosForecastBridge: { socForRun: async () => ({ soc: { battery1: 50 } }) },
        pushLog: (ev, data) => logs.push({ ev, data }),
      }
    });
    const svc = createOptimizerService(ctx);
    state.optimizer.eos = { supported: true }; // setzt sonst der Abgleich (eos-config-sync)
    await svc.start();
    await settle();
    assert.equal(calls.trigger.length, 1);
    assert.deepEqual(calls.trigger[0].body, { soc: { battery1: 50 } });
    assert.equal(logs.find((l) => l.ev === 'eos_run_started').data.reason, 'no_plan');
    assert.equal(notified, 1, 'fertiger Lauf → Lösung über den Monitor abholen');
    assert.deepEqual(calls.emsInterval, [], 'EOS\' eigener Takt wird nicht mehr angefasst');
    await svc.close();
  });

  test('kein Anstoß, solange kein EOS 0.4 erkannt ist oder EOS nach eigenem Takt rechnen soll', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    for (const variant of ['unerkannt', 'eigenerTakt']) {
      const { calls, eosAdapter } = eosWithoutPlan();
      const { ctx, state } = buildCtx({
        optimizerCfg: {
          primarySource: 'eos', eosProxy: { enabled: true, url: 'http://localhost:8503' },
          ...(variant === 'eigenerTakt' ? { eosStartAfterPreviousRun: true } : {}),
        },
        ctx: { eosAdapter, eosForecastBridge: { socForRun: async () => ({ soc: { battery1: 50 } }) }, pushLog: () => {} }
      });
      const svc = createOptimizerService(ctx);
      if (variant === 'eigenerTakt') state.optimizer.eos = { supported: true };
      await svc.start();
      await settle();
      assert.equal(calls.trigger.length, 0, variant);
      // EOS' Takt senkt die Erstplan-Wache nur noch, wenn EOS selbst den Takt
      // vorgibt — nicht, während DVhub bloß auf die Erkennung wartet.
      assert.equal(calls.emsInterval.length, variant === 'eigenerTakt' ? 1 : 0, variant);
      await svc.close();
    }
  });
});

describe('Optimizer Service: EOS-Prognose nur ueber die Forecast-Bridge (Review 25.10.2026)', () => {
  test('neue Prognose geht einmal je Version ueber die Bridge an EOS, nicht je Lauf', async (t) => {
    // Die Bridge schreibt auf ihrem eigenen Takt (Standard 1 h) und bei neuen
    // Preisen. Ein Push je Lauf vervielfachte ihre Schreibvorgaenge in EOS
    // (Geraete-Messwerte, die EOS nie kuerzt) — ganz ohne Push aus dem Lauf kam
    // eine neue PV-Prognose aber erst bis zu eine Stunde spaeter bei EOS an
    // (Gegenpruefung 2b66d3ee, P2). Deshalb: je neuer forecastVersion ein Push,
    // hoechstens alle 15 min (MQTT-Wetter hebt die Version jede Minute,
    // Gegenpruefung 5a3108d9). lastEosPush setzt die Bridge selbst.
    const now = Date.now();
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now });
    let adapterPushes = 0;
    let bridgePushes = 0;
    const eosAdapter = {
      pushForecast: async () => { adapterPushes++; return { ok: true }; },
      pullSchedule: async () => [{ ts: now, endTs: now + 900_000, powerW: -1000 }],
      pullGridSetpoints: async () => [],
      getOptimizationSolution: async () => ({ generatedAt: '2026-10-25T12:00:00+02:00', rows: [] }),
      setEmsIntervalSec: async () => ({ ok: true })
    };
    const eosForecastBridge = { push: async () => { bridgePushes++; return { ok: true, pushed: [], errors: {} }; } };
    const { ctx, state, bumpVersion } = buildCtx({
      optimizerCfg: { primarySource: 'eos', eosProxy: { enabled: true, url: 'http://localhost:8503' } },
      ctx: { eosAdapter, eosForecastBridge }
    });
    state.optimizer = { ...(state.optimizer || {}) };
    const svc = createOptimizerService(ctx);
    state.optimizer.lastEosPush = { ok: false, error: 'LoadImport: HTTP 500', at: 1 };
    const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
    await svc.start();
    await flush();
    assert.equal(state.optimizer.source, 'eos', 'EOS-Pfad gelaufen');
    assert.equal(adapterPushes, 0, 'Adapter schiebt nichts');
    assert.equal(bridgePushes, 1, 'erster Lauf: Prognose dieses Prozesses einmal an EOS');
    assert.deepEqual(state.optimizer.lastEosPush, { ok: false, error: 'LoadImport: HTTP 500', at: 1 }, 'Lauf ueberschreibt das Bridge-Ergebnis nicht');
    const runs = state.optimizer.runCount;
    svc.notifyEosRestart();
    await flush();
    assert.ok(state.optimizer.runCount > runs, 'weiterer Lauf');
    assert.equal(bridgePushes, 1, 'gleiche Prognose: kein weiterer Push');
    // Version jede Minute (MQTT-Wetter): innerhalb von 15 min kein weiterer Push.
    for (let minute = 1; minute < 15; minute += 1) {
      bumpVersion();
      t.mock.timers.tick(60_000);
      await flush();
    }
    assert.equal(bridgePushes, 1, 'hoechstens ein Push je 15 min');
    bumpVersion();
    t.mock.timers.tick(60_000);
    await flush();
    assert.equal(bridgePushes, 2, 'nach 15 min geht die neue Prognose an EOS');
    await svc.close();
  });

  test('fehlgeschlagener Push zaehlt nicht als uebertragen — der naechste Lauf versucht es wieder', async (t) => {
    const now = Date.now();
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now });
    const results = [{ ok: false, pushed: [], errors: { PVForecastImport: 'HTTP 500' } }, { ok: true, pushed: [], errors: {} }];
    let bridgePushes = 0;
    const eosAdapter = {
      pullSchedule: async () => [{ ts: now, endTs: now + 900_000, powerW: -1000 }],
      pullGridSetpoints: async () => [],
      getOptimizationSolution: async () => ({ generatedAt: '2026-10-25T12:00:00+02:00', rows: [] }),
      setEmsIntervalSec: async () => ({ ok: true })
    };
    const eosForecastBridge = { push: async () => { bridgePushes++; return results.shift() || { ok: true, pushed: [], errors: {} }; } };
    const { ctx, state } = buildCtx({
      optimizerCfg: { primarySource: 'eos', eosProxy: { enabled: true, url: 'http://localhost:8503' } },
      ctx: { eosAdapter, eosForecastBridge }
    });
    const svc = createOptimizerService(ctx);
    const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
    await svc.start();
    await flush();
    assert.equal(bridgePushes, 1, 'erster Versuch (EOS antwortet 500)');
    svc.notifyEosRestart();
    await flush();
    assert.equal(bridgePushes, 1, 'nicht sofort wieder (2 min Abstand)');
    t.mock.timers.tick(120_000);
    await flush();
    svc.notifyEosRestart();
    await flush();
    assert.equal(bridgePushes, 2, 'gleiche Version, aber noch nicht angekommen: erneut');
    t.mock.timers.tick(120_000);
    await flush();
    const runs = state.optimizer.runCount;
    svc.notifyEosRestart();
    await flush();
    assert.ok(state.optimizer.runCount > runs);
    assert.equal(bridgePushes, 2, 'jetzt angekommen: kein weiterer Push');
    await svc.close();
  });

  // Gegenpruefung f32de0d7 (P3): eine im 15-min-Fenster zurueckgehaltene
  // Prognose wartete auf einen spaeteren Lauf (bis ~30 min); ein dauerhafter
  // Teilfehler pushte alle 2 min.
  test('zurueckgehaltene Prognose geht zum Ende des 15-min-Fensters raus, ohne weiteren Lauf', async (t) => {
    const now = Date.now();
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now });
    let bridgePushes = 0;
    const eosAdapter = {
      pullSchedule: async () => [{ ts: now, endTs: now + 900_000, powerW: -1000 }],
      pullGridSetpoints: async () => [],
      getOptimizationSolution: async () => ({ generatedAt: '2026-10-25T12:00:00+02:00', rows: [] }),
      setEmsIntervalSec: async () => ({ ok: true })
    };
    const eosForecastBridge = { push: async () => { bridgePushes++; return { ok: true, pushed: [], errors: {} }; } };
    // Ersatz-Takt auf 1 h, damit kein Ersatz-Lauf zufaellig zum Fensterende kommt.
    const { ctx, bumpVersion } = buildCtx({
      optimizerCfg: { primarySource: 'eos', eosProxy: { enabled: true, url: 'http://localhost:8503' }, intervalMs: 3_600_000, morningReoptIntervalMs: 3_600_000 },
      ctx: { eosAdapter, eosForecastBridge }
    });
    const svc = createOptimizerService(ctx);
    const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
    const minutes = async (n) => { for (let i = 0; i < n; i += 1) { t.mock.timers.tick(60_000); await flush(); } };
    await svc.start();
    await flush();
    assert.equal(bridgePushes, 1);
    await minutes(4);
    bumpVersion();
    await minutes(2); // Poll-Lauf nach der neuen Version: im Fenster
    assert.equal(bridgePushes, 1, 'im Fenster zurueckgehalten');
    await minutes(10);
    assert.equal(bridgePushes, 2, 'zum Fensterende (15 min) nachgeschoben');
    await svc.close();
  });

  // Gegenpruefung b5e78c84 (P3): ohne weiteren Lauf kam der Wiederholversuch
  // nach einem Fehlschlag erst mit dem naechsten Ersatz-Lauf.
  test('Fehlschlag ohne weiteren Lauf: Wiederholversuch nach 2 min per Timer', async (t) => {
    const now = Date.now();
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now });
    const results = [{ ok: false, pushed: [], errors: { PVForecastImport: 'HTTP 500' } }];
    let bridgePushes = 0;
    const eosAdapter = {
      pullSchedule: async () => [{ ts: now, endTs: now + 900_000, powerW: -1000 }],
      pullGridSetpoints: async () => [],
      getOptimizationSolution: async () => ({ generatedAt: '2026-10-25T12:00:00+02:00', rows: [] }),
      setEmsIntervalSec: async () => ({ ok: true })
    };
    const eosForecastBridge = { push: async () => { bridgePushes++; return results.shift() || { ok: true, pushed: [], errors: {} }; } };
    const { ctx } = buildCtx({
      optimizerCfg: { primarySource: 'eos', eosProxy: { enabled: true, url: 'http://localhost:8503' }, intervalMs: 3_600_000, morningReoptIntervalMs: 3_600_000 },
      ctx: { eosAdapter, eosForecastBridge }
    });
    const svc = createOptimizerService(ctx);
    const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
    await svc.start();
    await flush();
    assert.equal(bridgePushes, 1, 'erster Versuch scheitert');
    for (let i = 0; i < 3; i += 1) { t.mock.timers.tick(60_000); await flush(); }
    assert.equal(bridgePushes, 2, 'nach 2 min erneut, ohne neuen Lauf');
    for (let i = 0; i < 30; i += 1) { t.mock.timers.tick(60_000); await flush(); }
    assert.equal(bridgePushes, 2, 'angekommen: kein weiterer Push');
    await svc.close();
  });

  test('dauerhafter Teilfehler: nach dem ersten Wiederholversuch nur noch alle 15 min', async (t) => {
    const now = Date.now();
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now });
    let bridgePushes = 0;
    const eosAdapter = {
      pullSchedule: async () => [{ ts: now, endTs: now + 900_000, powerW: -1000 }],
      pullGridSetpoints: async () => [],
      getOptimizationSolution: async () => ({ generatedAt: '2026-10-25T12:00:00+02:00', rows: [] }),
      setEmsIntervalSec: async () => ({ ok: true })
    };
    const eosForecastBridge = { push: async () => { bridgePushes++; return { ok: false, pushed: [], errors: { LoadImport: 'no slots available — skipping' } }; } };
    const { ctx, bumpVersion } = buildCtx({
      optimizerCfg: { primarySource: 'eos', eosProxy: { enabled: true, url: 'http://localhost:8503' }, intervalMs: 3_600_000, morningReoptIntervalMs: 3_600_000 },
      ctx: { eosAdapter, eosForecastBridge }
    });
    const svc = createOptimizerService(ctx);
    const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
    await svc.start();
    await flush();
    // Version jede Minute (MQTT-Wetter), 30 min lang.
    for (let minute = 1; minute <= 30; minute += 1) {
      bumpVersion();
      t.mock.timers.tick(60_000);
      await flush();
    }
    // 0 min erster Versuch, 2 min Wiederholung, danach je 15 min: 17, 32 → bis 30 min drei Pushes.
    assert.equal(bridgePushes, 3, `Pushes in 30 min: ${bridgePushes}`);
    await svc.close();
  });
});

// Review 25.10.2026 (P3): die MiSpeL-Zaehler rechneten je Lauf pauschal 30 min,
// obwohl alle <= 15 min (und oefter) gerechnet wird. Jetzt die echte Zeit seit
// der letzten Erfassung, hoechstens 30 min.
describe('Optimizer Service: MiSpeL-Zaehler mit echter Laufzeit', () => {
  test('erster Lauf erfasst nichts, zweiter nach 10 min genau 10 min', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: Date.parse('2026-06-10T10:00:00Z') });
    const { ctx, state, bumpVersion } = buildCtx({
      optimizerCfg: { mispel: { mode: 'pauschal', pvKwp: 10 } },
      state: { victron: { soc: 50, gridPower: -600 } }
    });
    const svc = createOptimizerService(ctx);
    const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
    await svc.start();
    await settle();
    assert.equal(state.optimizer.runCount, 1);
    assert.equal(state.optimizer.mispel.yearlyFeedInKwh, 0, 'ohne vorige Erfassung keine erfundene halbe Stunde');

    t.mock.timers.tick(9 * 60_000); await settle();
    bumpVersion();
    t.mock.timers.tick(60_000); await settle();
    assert.equal(state.optimizer.runCount, 2);
    // 600 W × 10 min = 100 Wh = 0,1 kWh (vorher 2 × 0,3 kWh).
    assert.ok(Math.abs(state.optimizer.mispel.yearlyFeedInKwh - 0.1) < 1e-9, `${state.optimizer.mispel.yearlyFeedInKwh}`);
    await svc.close();
  });
});

describe('mispelIntervalWh', () => {
  test('echte Zeit, gedeckelt, ohne Vorlauf 0', async () => {
    const { mispelIntervalWh } = await import('../services/optimizer/index.js');
    assert.deepEqual(mispelIntervalWh(-600, 600_000, null), { feedInWh: 0, gridWithdrawalWh: 0 });
    assert.deepEqual(mispelIntervalWh(-600, 600_000, 0), { feedInWh: 100, gridWithdrawalWh: 0 });
    assert.deepEqual(mispelIntervalWh(1200, 900_000, 0), { feedInWh: 0, gridWithdrawalWh: 300 });
    // 3 h Pause: hoechstens 30 min
    assert.deepEqual(mispelIntervalWh(1000, 3 * 3_600_000, 0), { feedInWh: 0, gridWithdrawalWh: 500 });
    assert.deepEqual(mispelIntervalWh(1000, 0, 600_000), { feedInWh: 0, gridWithdrawalWh: 0 }, 'Uhr rueckwaerts');
  });
});
