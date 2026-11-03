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

// Gegenprüfung Release 1.0.9 (P2): MQTT-Werte aus dem Cache tragen einen
// frischen Abfrage-Stempel (fieldUpdatedAt = jetzt), ihr Empfangsalter steht in
// fieldSourceAt. Zehn Minuten alte 6 kW AC-PV und 1 kW Last öffneten den Deckel
// auf −4,9 kW — fällt die PV inzwischen aus, liefert der Akku die Einspeisung.
test('gesperrt: MQTT-Wert aus dem Cache mit altem Empfang (fieldSourceAt) → nur der Puffer', async () => {
  for (const field of ['pvTotalW', 'acPvL1W', 'pvPowerW', 'selfConsumptionW']) {
    const { evaluator, writes } = makeCtx({
      pvW: 6_000, loadW: 1_000,
      mutate: ({ state }) => {
        const now = Date.now();
        state.victron.acPvL1W = 6_000;
        state.victron.fieldUpdatedAt.acPvL1W = now;
        state.victron.fieldSourceAt = { [field]: now - 10 * 60_000 };
      }
    });
    await evaluator.applyControlTarget('gridSetpointW', -5000, 'eos_optimization');
    assert.deepEqual(gridWrites(writes), [-100], field);
  }
});

test('gesperrt: frischer MQTT-Empfang (fieldSourceAt < 90 s) lässt den PV-Überschuss raus', async () => {
  const { evaluator, writes } = makeCtx({
    pvW: 6_000, loadW: 1_000,
    mutate: ({ state, cfg }) => {
      cfg.victron = { telemetryMaxAgeMs: 30_000 };
      state.victron.fieldSourceAt = { pvTotalW: Date.now() - 60_000, selfConsumptionW: Date.now() - 60_000 };
    }
  });
  await evaluator.applyControlTarget('gridSetpointW', -9000, 'eos_optimization');
  assert.deepEqual(gridWrites(writes), [-(5_000 - GRID_SHARE_EXPORT_MARGIN_W)]);
});

// ── Gesamtprüfung r109, Befund 2: Einfrier-Signale gelten auch für den Deckel ──
// Der GX friert mittags bei 6 kW PV / 1 kW Last ein, die Stempel bleiben frisch.
// Abends verlangt EOS −5 kW: der Deckel darf die eingefrorenen 6 kW nicht als
// PV-Überschuss nehmen (grid-share.js wertet dieselben Signale als unsicher).
for (const [name, flag] of [
  ['Einfrier-Verdacht (Stable-Kanal)', { freezeSuspect: { active: true } }],
  ['Einfrier-Wächter', { freeze: { active: true } }],
  ['Kreuzprobe MQTT/Modbus', { sourceMismatch: { active: true } }],
]) {
  test(`gesperrt: ${name} → eingefrorene PV öffnet den Deckel nicht, nur der Puffer`, async () => {
    const { evaluator, writes } = makeCtx({
      pvW: 6_000, loadW: 1_000,
      mutate: ({ state }) => { Object.assign(state.victron, flag); }
    });
    await evaluator.applyControlTarget('gridSetpointW', -5000, 'eos_optimization');
    // Höchstens der Puffer; Einfrier-Wächter und Kreuzprobe halten zusätzlich auf 0.
    const g = gridWrites(writes);
    assert.equal(g.length, 1);
    assert.ok(g[0] >= -100, `höchstens der Puffer: ${g}`);
  });
}

// ── Gegenprüfung ecc27ea3 (3× P3): Hauslast mit richtigem Empfangsalter ──────
// Abgeleitete Hauslast (energy_balance, DVhub-MQTT-Schema) bekam einen frischen
// Abfrage-Stempel, aber ihr Empfangsalter blieb stehen (alter Eintrag aus der
// Zeit mit Verbrauchs-Topic) bzw. fehlte ganz (Eingänge alt). Und bei der
// Phasensumme zählte die frischeste Phase.
async function pollDvhubMqtt({ staleMaxAgeMs, ingest, prior = {} }) {
  const { createMqttTransport } = await import('../transport-mqtt.js');
  const { createPoller } = await import('../polling.js');
  const os = await import('node:os');
  const path = await import('node:path');
  const tr = createMqttTransport({ host: '', mqtt: { schema: 'dvhub', topicPrefix: 'dvhub', staleMaxAgeMs } });
  ingest(tr);
  const state = {
    meter: { ok: false, updatedAt: 0, raw: [], grid_l1_w: 0, grid_l2_w: 0, grid_l3_w: 0, grid_total_w: 0, error: null },
    victron: { errors: {}, updatedAt: 0, fieldUpdatedAt: {}, ...prior },
    dvRegs: new Array(8).fill(0),
    energy: { day: '2026-11-03', importWh: 0, exportWh: 0, costEur: 0, revenueEur: 0, lastTs: 0 },
  };
  const pcfg = {
    pollMs: 500, gridPositiveMeans: 'grid_import',
    points: { soc: { enabled: true }, batteryPowerW: { enabled: true }, pvPowerW: { enabled: true }, selfConsumptionW: { enabled: true, derive: 'energy_balance' } },
    epex: { timezone: 'UTC' }, userEnergyPricing: {}, dvControl: {},
  };
  const poller = createPoller({
    state, getCfg: () => pcfg, transport: tr, pushLog: () => {},
    energyPath: path.join(os.tmpdir(), `grid-share-lock-mqtt-${process.pid}.json`), onPollComplete: () => {},
    epexNowNext: () => ({ current: { ct_kwh: 0 } }),
  });
  await poller.requestPoll();
  return state;
}

test('abgeleitete Hauslast: altes Empfangsalter aus der Verbrauchs-Topic-Zeit bleibt nicht stehen', async () => {
  const old = Date.now() - 10 * 60_000;
  const state = await pollDvhubMqtt({
    staleMaxAgeMs: 90_000,
    ingest: (tr) => { tr.ingest('grid_total', -4_000); tr.ingest('pv_total', 6_000); tr.ingest('battery_power', 0); tr.ingest('battery_soc', 60); },
    prior: { fieldSourceAt: { selfConsumptionW: old } },
  });
  assert.equal(state.victron.selfConsumptionDerived, true, 'abgeleitet');
  const at = state.victron.fieldSourceAt?.selfConsumptionW;
  assert.ok(!(at > 0) || Date.now() - at < 5_000, `Empfangsalter der Ableitung, nicht der alte Eintrag: ${at}`);
});

test('abgeleitete Hauslast: alter Akkuwert (Cache ohne Frist) macht die Last alt', async () => {
  const old = Date.now() - 10 * 60_000;
  const state = await pollDvhubMqtt({
    staleMaxAgeMs: 0,
    ingest: (tr) => { tr.ingest('grid_total', -4_000); tr.ingest('pv_total', 6_000); tr.ingest('battery_power', 3_000, old); tr.ingest('battery_soc', 60); },
  });
  assert.equal(state.victron.selfConsumptionDerived, true);
  assert.equal(state.victron.fieldSourceAt?.selfConsumptionW, old, 'ältester Eingang');
});

test('Phasensumme: Empfangsalter ist das der ältesten gesehenen Phase', async () => {
  const { sumConsumptionEntries } = await import('../transport-mqtt.js');
  const now = Date.now();
  assert.deepEqual(sumConsumptionEntries([{ value: 100, ts: now }, { value: 200, ts: now - 600_000 }, undefined], 0, now), { value: 300, ts: now - 600_000 });
});
