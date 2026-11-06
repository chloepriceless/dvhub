// test/grid-connection-e2e.test.js — Ende zu Ende mit simuliertem Zähler:
// echter Steuerpfad (ausgeliefertes Victron-Profil, Schedule-Evaluator,
// Modbus-Rohwörter), echte EOS-evcc-Brücke mit einer Wallbox-Attrappe, echter
// Wächter. Eine kleine Anlagen-Simulation rechnet je Takt den Bezug am Zähler:
//
//   Victron ESS: positiver Sollwert S = Bezug am Zähler. Der Akku lädt
//   S − (Haus + E-Auto), höchstens 27 kW, nie negativ (Akku halten).
//   Bezug = Haus + E-Auto + Akku-Ladung, auf drei Phasen verteilt.
//
// Christins Anlage: Anschluss 29 kW (Regelziel 28 kW), Akku 27 kW, E-Auto
// 11 kW (16 A, 3 Phasen), EOS will 34,4 kW aus dem Netz.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { loadVictronConfig, makeTelemetryState, makeEvaluator, gridSetpointWrites } from './helpers/peak-shaving-harness.js';
import { createGridConnectionGuard, wallboxGridCapW } from '../services/grid-connection/index.js';
import { createEosEvccBridge } from '../services/optimizer/eos-evcc-bridge.js';

const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r)); };

function plant({ gridConnection, house = [500, 500, 500] }) {
  const cfg = loadVictronConfig({
    gridConnection,
    optimizer: {
      allowGridCharge: true, allowGridDischarge: true,
      eosOptimizeEv: true, evEvccControl: true, evMaxChargeW: 11000, evMinCurrentA: 6, evPhases: 3, maxChargeW: 27000
    },
    evcc: { url: 'http://192.0.2.30:7070' }
  });
  const state = makeTelemetryState({});
  let t = Date.now();
  const sim = { house: [...house], evW: 0, batteryW: 0 };

  // Wallbox-Attrappe (evcc-Ladepunkt): folgt dem Befehl sofort.
  const charger = {
    type: 'evcc', mode: 'off', currentA: 0, commands: [],
    isConfigured: () => true,
    async charge(a) { this.mode = 'now'; this.currentA = a; this.commands.push(a); return { ok: true }; },
    async stop() { this.mode = 'off'; this.currentA = 0; this.commands.push('stop'); return { ok: true }; },
    async release() { return { ok: true }; },
    async status() { return { ok: true, connected: true, charging: this.mode === 'now', raw: { mode: this.mode } }; }
  };
  // EOS-Plan: E-Auto lädt in jedem Slot mit voller Leistung.
  const slot0 = Math.floor(t / 900_000) * 900_000 - 900_000;
  const solution = {
    slotMinutes: 15,
    rows: Array.from({ length: 40 }, (_, i) => ({ ts_utc: new Date(slot0 + i * 900_000).toISOString(), evChargeFactor: 1 }))
  };

  const logs = [];
  const ctx = {
    getCfg: () => cfg, state,
    pushLog: (event, payload) => logs.push({ event, payload: payload || {} }),
    evccIntegration: { getStatus: () => ({ url: cfg.evcc.url, loadpoints: [{ chargePowerW: sim.evW }] }) },
    licenseService: { isProActive: () => true }
  };
  const guard = createGridConnectionGuard(ctx, { now: () => t });
  const bridge = createEosEvccBridge({
    getCfg: () => cfg,
    getSolution: async () => solution,
    getCharger: () => charger,
    getGridCapW: () => wallboxGridCapW(null, guard.capW('wallbox')),
    now: () => t
  });
  ctx.eosEvccBridge = bridge;
  const h = makeEvaluator({ cfg, state, extraCtx: { gridConnection: guard } });
  ctx.applyControlTarget = h.evaluator.applyControlTarget;

  function physics() {
    sim.evW = charger.mode === 'now' ? Math.round(charger.currentA * 230 * 3) : 0;
    const S = Number(state.schedule.lastWrite?.gridSetpointW?.value ?? 0);
    const loadW = sim.house.reduce((a, b) => a + b, 0) + sim.evW;
    sim.batteryW = S > 0 ? Math.max(0, Math.min(27000, S - loadW)) : 0;
    const phases = sim.house.map((hW) => hW + sim.evW / 3 + sim.batteryW / 3);
    const importW = phases.reduce((a, b) => a + b, 0);
    // Zähler zählt ab Werk Einspeisung positiv (gridPositiveMeans feed_in).
    Object.assign(state.meter, {
      ok: true, updatedAt: t, grid_total_w: -Math.round(importW),
      grid_l1_w: -Math.round(phases[0]), grid_l2_w: -Math.round(phases[1]), grid_l3_w: -Math.round(phases[2])
    });
    state.victron.gridImportW = Math.round(importW);
    state.victron.batteryChargeW = sim.batteryW;
    state.victron.fieldUpdatedAt.batteryPowerW = t;
    // Victron-Keepalive: der Sollwert bleibt bestätigt.
    if (state.schedule.lastWrite?.gridSetpointW) state.schedule.lastWrite.gridSetpointW.at = t;
    return { importW, phases };
  }

  /** n Zählerabfragen im 2-s-Takt: Physik, Wächter, Befehle wirken lassen. */
  async function polls(n) {
    let m;
    for (let i = 0; i < n; i += 1) {
      t += 2000;
      physics();
      guard.pollTick();
      await settle();
      m = physics();
    }
    return m;
  }

  return { cfg, state, guard, bridge, charger, sim, logs, transport: h.transport, evaluator: h.evaluator, polls, physics, advance: (ms) => { t += ms; } };
}

test('E2E: Bezug steigt über die Grenze → Akku-Ladung zuerst, dann Wallbox kürzen, dann pausieren, danach wieder frei', async () => {
  const p = plant({ gridConnection: { limitKw: 29 } });
  // EOS: 34,4 kW Netzbezug geplant (Akku 27 kW + E-Auto 11 kW + Haus).
  await p.bridge.tick();
  assert.equal(p.charger.currentA, 16, 'E-Auto lädt mit 16 A (11 kW)');
  await p.evaluator.applyControlTarget('gridSetpointW', 34400, 'rule:eos-grid-charge');
  assert.deepEqual(gridSetpointWrites(p.transport), [28000], '1. Akku: Sollwert auf 28 kW gedeckelt');
  let m = await p.polls(10);
  assert.equal(Math.round(m.importW), 28000, 'Bezug = Regelziel, Akku lädt mit dem Rest');
  assert.ok(p.sim.batteryW > 14000);
  assert.deepEqual(p.charger.commands, [16], 'Wallbox unberührt, solange der Akku nachgibt');

  // Herd + Durchlauferhitzer: Haus 18 kW. Der Akku lädt nicht mehr (S < Last),
  // Bezug 29 kW > 28 kW → 2. Wallbox herunter.
  p.sim.house = [6000, 6000, 6000];
  m = await p.polls(3);
  assert.equal(p.charger.commands.at(-1), 14.4, 'Wallbox auf 14,4 A (10 kW)');
  assert.ok(m.importW <= 28000, `Bezug ${m.importW} W unter dem Regelziel`);
  assert.ok(p.logs.some((l) => l.event === 'grid_connection_limit' && /begrenzt Wallbox auf 10,0 kW/.test(l.payload.text)));

  // Noch mehr Last: Haus 25 kW → Wallbox unter Mindeststrom → Pause.
  p.sim.house = [8400, 8300, 8300];
  m = await p.polls(2);
  assert.equal(p.charger.commands.at(-1), 'stop', 'Wallbox pausiert');
  assert.ok(m.importW <= 29000, 'nie über dem Anschluss');
  assert.ok(p.logs.some((l) => l.event === 'grid_connection_limit' && /Wallbox pausiert/.test(l.payload.text)));
  assert.equal(p.guard.summary().caps[0].capW, 0);
  assert.match(p.guard.summary().text, /Wallbox pausiert/);

  // Herd aus. Der Akku lädt wieder mit ~26 kW — für die Wallbox ist das Luft.
  // Freigabe erst nach 60 s Haltezeit und 30 s Luft, dann wieder 16 A.
  p.sim.house = [500, 500, 500];
  await p.polls(10);
  assert.equal(p.charger.commands.at(-1), 'stop', 'nach 20 s noch keine Freigabe (Hysterese)');
  await p.polls(30);
  assert.equal(p.charger.commands.at(-1), 16, 'Wallbox wieder frei');
  assert.equal(p.guard.capW('wallbox'), null);
  m = await p.polls(5);
  assert.ok(m.importW <= 28000);
  assert.ok(p.logs.some((l) => l.event === 'grid_connection_release'));
  // Kein Pendeln: in der ganzen Folge genau ein Kürzen, eine Pause, eine Freigabe.
  assert.deepEqual(p.charger.commands, [16, 14.4, 'stop', 16]);
});

test('E2E Phase: Herd auf L1 → Akku-Sollwert und Wallbox so weit herunter, dass L1 unter 40 A bleibt', async () => {
  const p = plant({ gridConnection: { limitKw: 29, phaseLimitA: 40 }, house: [6000, 500, 500] });
  await p.bridge.tick();
  await p.evaluator.applyControlTarget('gridSetpointW', 34400, 'rule:eos-grid-charge');
  p.physics();
  const before = p.physics().phases[0];
  assert.ok(before > 9200, `vorher L1 ${before} W über 9 200 W (40 A)`);
  const m = await p.polls(3);
  assert.ok(m.phases[0] <= 9200, `L1 ${Math.round(m.phases[0])} W ≤ 9 200 W`);
  assert.ok(gridSetpointWrites(p.transport).at(-1) < 28000, 'Akku-Sollwert unter das Gesamtziel gesenkt');
  assert.ok(p.charger.currentA < 16, 'Wallbox reduziert');
  const later = await p.polls(20);
  assert.ok(later.phases[0] <= 9200, 'bleibt darunter');
});

test('E2E Fail-safe: Zähler fällt aus → keine neue Last, Akku-Sollwert auf Grenze − Abstand − Grundlast − Wallbox', async () => {
  const p = plant({ gridConnection: { limitKw: 29 } });
  await p.bridge.tick();
  await p.evaluator.applyControlTarget('gridSetpointW', 34400, 'rule:eos-grid-charge');
  await p.polls(3);
  // Zähler gestört: zwei Abfragen ohne Wert.
  for (let i = 0; i < 2; i += 1) {
    p.advance(2000);
    p.state.meter.ok = false;
    p.guard.pollTick();
    await settle();
  }
  assert.equal(p.guard.summary().failsafe, true);
  // E-Auto 16 A = 11 040 W, auf 100 W aufgerundet 11 100 W eingefroren:
  // 28 000 − 1 000 − 11 100 = 15 900 W.
  assert.equal(p.guard.batteryCeilingW(), 15900);
  assert.equal(gridSetpointWrites(p.transport).at(-1), 15900, 'laufender Sollwert sofort gesenkt');
  assert.equal(p.charger.currentA, 16, 'die Wallbox läuft weiter, nur nicht höher');
  assert.ok(p.logs.some((l) => l.event === 'grid_connection_failsafe'));
  assert.match(p.guard.summary().text, /keine neue Last/);
});

test('polling.js: jede Zählerabfrage ist ein Regeltakt des Wächters', async () => {
  const { createPoller } = await import('../polling.js');
  const { createMqttTransport } = await import('../transport-mqtt.js');
  const tr = createMqttTransport({ host: '', mqtt: { schema: 'dvhub', topicPrefix: 'dvhub', staleMaxAgeMs: 0 } });
  tr.ingest('grid_total', 6_000);
  const state = {
    meter: { ok: false, updatedAt: 0, raw: [], grid_l1_w: 0, grid_l2_w: 0, grid_l3_w: 0, grid_total_w: 0, error: null },
    victron: { errors: {}, updatedAt: 0, fieldUpdatedAt: {} },
    dvRegs: new Array(8).fill(0),
    energy: { day: '2026-11-06', importWh: 0, exportWh: 0, costEur: 0, revenueEur: 0, lastTs: 0 },
  };
  let ticks = 0;
  const poller = createPoller({
    state,
    getCfg: () => ({ pollMs: 500, gridPositiveMeans: 'grid_import', points: {}, epex: { timezone: 'UTC' }, userEnergyPricing: {}, dvControl: {} }),
    transport: tr, pushLog: () => {},
    energyPath: path.join(os.tmpdir(), `grid-connection-poll-${process.pid}.json`),
    onPollComplete: () => {},
    gridConnection: { pollTick: () => { ticks += 1; } },
    epexNowNext: () => ({ current: { ct_kwh: 0 } }),
  });
  await poller.requestPoll();
  await poller.requestPoll();
  assert.equal(ticks, 2);
});
