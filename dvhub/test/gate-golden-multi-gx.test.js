// Golden-Master Pfad 8 der D.1-Inventur: zweite Victron-GX (services/multi-gx), Netz-Sollwert 2716/2717 als int32
// (FC16) im 5-s-Takt, Nachweis D.4(2). Aufbau wie server.js: createMultiGx(ctx, { transport }) ohne eigene Uhr
// (Date.now, hier fest gestellt), Beta-Freigabe über updateChannel 'dev'. Eingangsfolgen: Normalbetrieb
// (Lesen 843/842/2901/820–822, Schreiben jeden Takt), Einspeisesperre (§51/DV), Not-Halt (nur lesen),
// Abschalten (einmal 0), Lesefehler (offline/online), Schreibfehler, und Hauptanlage + zweite GX in EINEM
// gemeinsamen, nach Gerät getaggten Log (gx = Hauptanlage, gx2 = zweite GX), damit die Reihenfolge über beide
// Geräte eingefroren ist.
//
// Frieren: GOLDEN_FREEZE=1 node --test test/gate-golden-multi-gx.test.js (schreibt
// test/fixtures/gate-golden/multi-gx.json neu). Nur mit belegtem Grund.

import { test } from 'node:test';

import { createMultiGx } from '../services/multi-gx/index.js';
import {
  HOST, fixClock, loadProfileConfig, recordingModbus, baseState, evaluatorRig, recorder, goldenFile,
} from './helpers/gate-golden.js';

const golden = goldenFile('multi-gx');
const GX2 = '192.0.2.20';
const ALIAS = { [HOST]: 'gx', [GX2]: 'gx2' };
// Zweite GX: SoC 60 %, Akku 0 W, Mindest-SoC 15,0 % (×10), AC-IN 0 W je Phase.
const GX2_REGS = { 843: 60, 842: 0, 2901: 150, 820: 0, 821: 0, 822: 0 };

function setup({ multiGx = {}, ctrl = {}, victron = {}, transport } = {}) {
  const cfg = loadProfileConfig('victron', {
    updateChannel: 'dev', victron: { host: HOST }, gridPositiveMeans: 'grid_import',
    optimizer: { batteryCapacityWh: 64000, maxSocPct: 100, maxDischargeW: 10000, allowGridDischarge: true },
    multiGx: { enabled: true, host: GX2, port: 502, unitId: 100, batteryCapacityWh: 64000, maxChargeW: 10000,
      maxDischargeW: 10000, minSocPct: 10, rampWPerS: 200, deadbandW: 300, ...multiGx },
  });
  const tr = transport || recordingModbus({ hosts: { [GX2]: GX2_REGS }, hostAlias: ALIAS });
  const state = baseState({ victron: { soc: 60, batteryPowerW: -4000, minSocPct: 10, gridSetpointW: 0, ...victron }, ctrl });
  state.victron.fieldUpdatedAt.batteryPowerW = Date.now();
  const events = [];
  // Prüfstand mit fester Uhr (mock Date): sie misst auch die monotonen Abstände (A23 b, dt der Rampe), sonst liefe
  // dt in Echtzeit (performance.now ist nicht gemockt).
  const mgx = createMultiGx({ getCfg: () => cfg, state, pushLog: (e) => events.push(e), onMultiGxAvailability: () => {} }, { transport: tr, monoNow: () => Date.now() });
  return { cfg, state, mgx, transport: tr, events };
}

function tickStep(s, advance) {
  return async () => {
    await advance(5000);
    s.state.victron.fieldUpdatedAt.batteryPowerW = Date.now();
    await s.mgx.tick();
    const m = s.state.multiGx || {};
    return { online: m.online ?? null, setpointW: m.setpointW ?? null, reason: m.reason ?? null };
  };
}

test('Pfad 8 zweite GX: Normalbetrieb (jeden Takt 2716), Einspeisesperre, Not-Halt, Abschalten', async (t) => {
  const advance = fixClock(t);
  const s = setup();
  const r = recorder(s);
  for (let i = 1; i <= 5; i += 1) await r.step(`Takt ${i}`, tickStep(s, advance));
  s.state.ctrl.negativePriceActive = true;
  for (let i = 1; i <= 3; i += 1) await r.step(`Takt §51-Sperre ${i}`, tickStep(s, advance));
  s.state.ctrl.negativePriceActive = false;
  Object.assign(s.state.ctrl, { discretionaryWritesPaused: true, pausedAt: Date.now() });
  for (let i = 1; i <= 2; i += 1) await r.step(`Takt Not-Halt ${i}`, tickStep(s, advance));
  s.state.ctrl.discretionaryWritesPaused = false;
  await r.step('Takt nach Not-Halt', tickStep(s, advance));
  s.cfg.multiGx.enabled = false;
  await r.step('abgeschaltet → einmal 0', tickStep(s, advance));
  await r.step('abgeschaltet, Ruhe', tickStep(s, advance));
  golden.check('normal_block_stop_off', r.steps);
});

test('Pfad 8 zweite GX: Lesefehler (offline nach 3), Erholung; Schreibfehler (offline nach 3)', async (t) => {
  const advance = fixClock(t);
  const tr = recordingModbus({ hosts: { [GX2]: GX2_REGS }, hostAlias: ALIAS, failRead: { [`${GX2}@843`]: { msg: 'timeout', skip: 2, times: 3 } } });
  const s = setup({ transport: tr });
  const r = recorder(s);
  for (let i = 1; i <= 7; i += 1) await r.step(`Takt ${i}`, tickStep(s, advance));
  golden.check('read_errors', r.steps);

  const tw = recordingModbus({ hosts: { [GX2]: GX2_REGS }, hostAlias: ALIAS, failWrite: { [`${GX2}@2716`]: { msg: 'timeout', skip: 1, times: 3 } } });
  const w = setup({ transport: tw });
  const r2 = recorder(w);
  for (let i = 1; i <= 6; i += 1) await r2.step(`Takt ${i}`, tickStep(w, advance));
  golden.check('write_errors', r2.steps);
});

test('Pfad 8 + Pfad 1: Hauptanlage (gx 2716) und zweite GX (gx2 2716) in einem gemeinsamen Log', async (t) => {
  const advance = fixClock(t);
  const shared = recordingModbus({ hosts: { [GX2]: GX2_REGS }, hostAlias: ALIAS });
  const s = setup({ transport: shared });
  const main = evaluatorRig({ cfg: s.cfg, transport: shared, state: s.state });
  const r = recorder({ transport: shared, events: main.events });
  // Hauptanlage schreibt, danach läuft ein Takt der zweiten GX (5 s später) — Reihenfolge über beide Geräte.
  const both = (value) => async () => {
    const res = await main.ev.applyControlTarget('gridSetpointW', value, 'rule:abend');
    const out = await tickStep(s, advance)();
    return { ok: res.ok, main: res.skipped ? 'skipped' : (res.keepalive ? 'keepalive' : 'write'), ...out };
  };
  const mainOnly = (value) => async () => {
    const res = await main.ev.applyControlTarget('gridSetpointW', value, 'rule:abend');
    return { ok: res.ok, main: res.skipped ? 'skipped' : (res.keepalive ? 'keepalive' : 'write') };
  };
  await r.step('Haupt -2000, Takt 1', both(-2000));
  await r.step('Haupt -2000 nach 5 s (Keepalive fällig)', mainOnly(-2000));
  await r.step('Haupt -2000 sofort erneut (unverändert), Takt 2', both(-2000));
  await r.step('Haupt -3000, Takt 3', both(-3000));
  golden.check('shared_log_main_and_second', r.steps);
});
