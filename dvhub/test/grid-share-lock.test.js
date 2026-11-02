// test/grid-share-lock.test.js — Sperre der Akku-Einspeisung, solange Netzstrom
// im Akku ist (Christin 01./02.11.2026).
//
// Ausführung (schedule-eval): jeder diskretionäre negative Netz-Sollwert wird auf
// den Live-PV-Überschuss gedeckelt — der Akku entlädt nie ins Netz, PV-Einspeisung
// bleibt. Der Standard-Puffer (−100 W) bleibt. Planung: EOS bekommt die
// Akku-Netzeinspeisung abgeschaltet (feedintariff/direct_marketing_enabled),
// der eingebaute Planer allowGridDischarge = false.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import http from 'node:http';

import { createScheduleEvaluator } from '../schedule-eval.js';
import { createEosConfigSync } from '../services/optimizer/eos-config-sync.js';
import { GRID_SHARE_EXPORT_MARGIN_W } from '../services/optimizer/grid-share.js';
import { activeWindow } from './helpers/active-window.js';

function makeCtx({ locked = true, pvW = 0, loadW = 1_000, mutate } = {}) {
  const logs = [];
  const writes = [];
  const now = Date.now();
  const state = {
    victron: {
      soc: 60, batteryDischargeW: 0, batteryChargeW: 0, batteryPowerW: 0,
      pvTotalW: pvW, pvPowerW: 0, selfConsumptionW: loadW,
      fieldUpdatedAt: { soc: now, pvTotalW: now, pvPowerW: now, selfConsumptionW: now }
    },
    schedule: { rules: [], active: {}, lastWrite: {}, manualOverride: {}, config: { defaultGridSetpointW: -100 }, lastEvalAt: 0 },
    ctrl: { negativePriceActive: false, forcedOff: false },
    epex: { data: [] }
  };
  const cfg = {
    controlWrite: { gridSetpointW: { enabled: true, address: 100 }, chargeCurrentA: { enabled: false } },
    dvControl: { enabled: false, negativePriceProtection: { enabled: true } },
    optimizer: { enabled: true, allowGridCharge: true, gridChargeWithoutMispel: true, allowGridDischarge: true },
    dcExportMode: {},
    schedule: { timezone: 'Europe/Berlin', manualOverrideTtlMs: 300000, controlKeepaliveMs: 0, defaultGridSetpointW: -100, smallMarketAutomation: { enabled: false } }
  };
  const ctx = {
    state,
    getCfg: () => cfg,
    transport: { type: 'mqtt', mqttWrite: async (target, value) => { writes.push({ target, value }); } },
    pushLog: (event, payload) => { logs.push({ event, payload: payload || {} }); },
    telemetrySafeWrite: (fn) => { try { fn?.(); } catch { /* no-op */ } },
    persistConfig: async () => {},
    telemetryStore: null,
    epexNowNext: () => ({ current: { ct_kwh: 12, eur_mwh: 120 }, next: null }),
    regenerateSmallMarketAutomationRules: async () => {},
    onEvalComplete: () => {},
    gridShare: { isLocked: () => locked }
  };
  mutate?.({ state, cfg, ctx });
  return { evaluator: createScheduleEvaluator(ctx), state, cfg, logs, writes };
}
const gridWrites = (w) => w.filter((x) => x.target === 'gridSetpointW').map((x) => x.value);

test('gesperrt: Akku-Verkauf (EOS, −8 kW) ohne PV wird auf den Puffer −100 W gedeckelt', async () => {
  const { evaluator, writes, logs } = makeCtx({ pvW: 0, loadW: 800 });
  const r = await evaluator.applyControlTarget('gridSetpointW', -8000, 'eos_optimization');
  assert.equal(r.ok, true);
  assert.deepEqual(gridWrites(writes), [-100]);
  assert.ok(logs.some((l) => l.event === 'grid_share_export_capped'));
});

test('gesperrt: mit PV darf nur der PV-Überschuss raus', async () => {
  const { evaluator, writes } = makeCtx({ pvW: 6_000, loadW: 1_000 });
  await evaluator.applyControlTarget('gridSetpointW', -9000, 'rule:sma-1');
  assert.deepEqual(gridWrites(writes), [-(5_000 - GRID_SHARE_EXPORT_MARGIN_W)]);
});

test('gesperrt: kleinere Einspeisung als der PV-Überschuss bleibt unverändert', async () => {
  const { evaluator, writes } = makeCtx({ pvW: 6_000, loadW: 1_000 });
  await evaluator.applyControlTarget('gridSetpointW', -2000, 'dc_export_mode');
  assert.deepEqual(gridWrites(writes), [-2000]);
});

test('gesperrt: Netzladen (positiver Sollwert) läuft unverändert', async () => {
  const { evaluator, writes } = makeCtx({ pvW: 0, loadW: 500 });
  await evaluator.applyControlTarget('gridSetpointW', 9000, 'rule:eos-grid-charge');
  assert.deepEqual(gridWrites(writes), [9000]);
});

test('gesperrt: veraltete AC-PV-Messung → nur der Puffer', async () => {
  const { evaluator, writes } = makeCtx({
    pvW: 6_000, loadW: 1_000,
    mutate: ({ state }) => {
      delete state.victron.fieldUpdatedAt.pvTotalW;   // polling stempelt pvTotalW nie
      state.victron.fieldUpdatedAt.acPvL1W = Date.now() - 10 * 60_000;
    }
  });
  await evaluator.applyControlTarget('gridSetpointW', -5000, 'eos_optimization');
  assert.deepEqual(gridWrites(writes), [-100]);
});

test('gesperrt: großer Standard-Puffer (−2000 W) wird nachts auf 100 W begrenzt', async () => {
  const { evaluator, writes } = makeCtx({
    pvW: 0, loadW: 800,
    mutate: ({ cfg, state }) => { cfg.schedule.defaultGridSetpointW = -2000; state.schedule.config.defaultGridSetpointW = -2000; }
  });
  await evaluator.applyControlTarget('gridSetpointW', -2000, 'default');
  assert.deepEqual(gridWrites(writes), [-100]);
});

test('gesperrt: der Deckel-Hinweis kommt einmal je Quelle, nicht in jedem Takt', async () => {
  const { evaluator, logs, state } = makeCtx({ pvW: 6_000, loadW: 1_000 });
  for (const pv of [6_000, 5_900, 5_800, 5_700]) {
    state.victron.pvTotalW = pv;
    await evaluator.applyControlTarget('gridSetpointW', -9000, 'rule:sma-1');
  }
  assert.equal(logs.filter((l) => l.event === 'grid_share_export_capped').length, 1);
});

test('ohne Sperre: Akku-Verkauf läuft wie bisher', async () => {
  const { evaluator, writes } = makeCtx({ locked: false, pvW: 0, loadW: 800 });
  await evaluator.applyControlTarget('gridSetpointW', -8000, 'eos_optimization');
  assert.deepEqual(gridWrites(writes), [-8000]);
});

test('gesperrt: EOS-Akku-Export-Regel speist nur noch den Live-PV-Überschuss ein (B = 0)', async () => {
  const now = Date.now();
  const { evaluator, writes } = makeCtx({
    pvW: 3_000, loadW: 1_000,
    mutate: ({ state }) => {
      state.schedule.rules = [{
        id: 'eos-x', source: 'forecast_optimizer', optimizer: 'eos', target: 'gridSetpointW',
        value: -10000, closedLoopExport: true, batteryShareW: 8_000,
        ...activeWindow(), enabled: true, slotTs: now - 60_000, slotEndTs: now + 600_000
      }];
    }
  });
  await evaluator.evaluateSchedule();
  const g = gridWrites(writes);
  assert.ok(g.length >= 1, 'ein Sollwert');
  assert.ok(g.every((v) => v >= -2_000 && v < 0), `nur der PV-Überschuss: ${g}`);
});

async function createMockEos() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : undefined });
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && req.url === '/v1/config') {
        res.end(JSON.stringify({ optimization: { genetic: { interval_sec: 3600 } }, feedintariff: { direct_marketing_enabled: false }, devices: { batteries: {} } }));
        return;
      }
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, requests, close: () => new Promise((r) => server.close(r)) };
}

for (const [locked, expected] of [[true, false], [false, true]]) {
  test(`EOS: Direktvermarktung (Akku→Netz) ${expected ? 'an' : 'aus'}, wenn der Netzstrom-Zähler ${locked ? 'sperrt' : 'frei ist'}`, async () => {
    const mock = await createMockEos();
    try {
      const ctx = {
        getCfg: () => ({
          optimizer: {
            batteryCapacityWh: 77000, tariff: { feedInMode: 'spot' },
            eosProxy: { enabled: true, url: `http://127.0.0.1:${mock.port}` }
          }
        }),
        pushLog: () => {},
        state: {},
        gridShare: { isLocked: () => locked }
      };
      await createEosConfigSync(ctx).sync();
      const put = mock.requests.find((r) => r.method === 'PUT' && r.url === '/v1/config/feedintariff/direct_marketing_enabled');
      assert.ok(put, 'Schalter gesendet');
      assert.equal(put.body, expected);
    } finally {
      await mock.close();
    }
  });
}
