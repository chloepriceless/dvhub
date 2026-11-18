// H-1 Phase 3b — Paritätsnachweis Pfad 8 der D.1-Inventur über das Schreibtor im Legacy-Modus (VCL-Vertrag v6 D.2
// „bit-gleich zu main", Nachweis D.4(2)): die zweite Victron-GX (services/multi-gx), Netz-Sollwert 2716/2717 als
// int32 (FC16) im 5-s-Takt. Jedes Szenario läuft einmal über den ALTEN Weg (heutiger Code mit einem Tor-Ersatz, der
// jede Operation unmittelbar an die Senke gibt — oder, mit MGX_PARITY_BASE, die Originaldatei VOR dem Umbau) und
// einmal über das ECHTE Tor. Verglichen werden Draht-Folge (Lesen und Schreiben beider Geräte in EINEM Protokoll),
// volle Argument-Objekte, Status je Takt (state.multiGx), Log-Ereignisse samt Daten, die Verfügbarkeits-Meldungen an
// EOS und im Lese-Modus die abgewehrten Schreibversuche. Auf der neuen Seite zusätzlich: jeder Senken-Aufruf genau
// ein Tor-Ereignis (legacy, Gerät gx2), das Tor sperrt nichts selbst (außer im Lese-Modus), Aktionsklassen stehen fest.
//
// Gegenbeweis gegen den Stand VOR dem Umbau (516a5e60):
//   git show 516a5e60:dvhub/services/multi-gx/index.js > dvhub/services/multi-gx/index.parity-base.js
//   MGX_PARITY_BASE=services/multi-gx/index.parity-base.js node --test test/gate-multi-gx-parity.test.js   (in dvhub/;
//   danach löschen — die Kopie läge sonst im R-T1-Scan)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import * as current from '../services/multi-gx/index.js';
import { createLegacyGate, MULTI_GX_GATE_DEVICE, INVERTER_GATE_DEVICE } from '../services/gate/legacy.js';
import { blockedWriteCount } from '../read-only-guard.js';
import { HOST, fixClock, loadProfileConfig, baseState, evaluatorRig } from './helpers/gate-golden.js';
import { directGate, parityModbus } from './helpers/dv-parity-rig.js';

const BASE = process.env.MGX_PARITY_BASE
  ? await import(pathToFileURL(path.resolve(process.env.MGX_PARITY_BASE)).href)
  : null;

const GX2 = '192.0.2.20';
const ALIAS = { [HOST]: 'gx', [GX2]: 'gx2' };
// Zweite GX: SoC 60 %, Akku 0 W, Mindest-SoC 15,0 % (×10), AC-IN 0 W je Phase.
const GX2_REGS = { 843: 60, 842: 0, 2901: 150, 820: 0, 821: 0, 822: 0 };
const plain = (v) => JSON.parse(JSON.stringify(v ?? null));

function build(mode, sc) {
  const cfg = loadProfileConfig('victron', {
    updateChannel: 'dev', victron: { host: HOST }, gridPositiveMeans: 'grid_import',
    optimizer: { batteryCapacityWh: 64000, maxSocPct: 100, maxDischargeW: 10000, allowGridDischarge: true },
    multiGx: { enabled: true, host: GX2, port: 502, unitId: 100, batteryCapacityWh: 64000, maxChargeW: 10000,
      maxDischargeW: 10000, minSocPct: 10, rampWPerS: 200, deadbandW: 300, ...(sc.multiGx || {}) },
  });
  const hook = { fn: null };
  const transport = parityModbus({ hosts: { [GX2]: GX2_REGS }, hostAlias: ALIAS, ...structuredClone(sc.transport || {}) }, (e) => hook.fn?.(e));
  const state = baseState({ victron: { soc: 60, batteryPowerW: -4000, minSocPct: 10, gridSetpointW: 0, ...(sc.victron || {}) }, ctrl: sc.ctrl || {} });
  state.victron.fieldUpdatedAt.batteryPowerW = Date.now();
  const logs = [];
  const avail = [];
  const events = [];
  const pushLog = (event, data, level) => logs.push([event, plain(data), level ?? null]);
  const gate = mode === 'new'
    ? createLegacyGate({ isHalted: () => state.ctrl?.discretionaryWritesPaused === true, onEvent: (e) => events.push(e) })
    : (BASE ? null : directGate());
  const ctx = { getCfg: () => cfg, state, pushLog, onMultiGxAvailability: (v) => avail.push(v), ...(gate ? { gate } : {}) };
  const create = mode === 'old' && BASE ? BASE.createMultiGx : current.createMultiGx;
  const mgx = create(ctx, { transport });
  const rig = { mode, cfg, state, transport, gate, mgx, logs, avail, events, onWrite: (fn) => { hook.fn = fn; } };
  // Hauptanlage am selben Tor (Pfad 1 + Pfad 8 in einem Protokoll), nur wenn das Szenario sie braucht.
  if (sc.withMain) rig.main = evaluatorRig({ cfg, transport, state, ctx: gate ? { gate } : {} });
  return rig;
}

async function runSide(t, mode, sc) {
  let result;
  await t.test(mode === 'old' ? (BASE ? 'alt (Basis-Kopie)' : 'alt (direkt)') : 'neu (Tor)', async (st) => {
    const advance = fixClock(st);
    const rig = build(mode, sc);
    const steps = [];
    const tick = async (label) => {
      await advance(5000);
      rig.state.victron.fieldUpdatedAt.batteryPowerW = Date.now();
      await rig.mgx.tick();
      steps.push({ step: label, status: plain(rig.state.multiGx) });
    };
    const step = async (label, fn) => {
      try { steps.push({ step: label, value: plain(await fn()) }); } catch (e) { steps.push({ step: label, threw: e?.message }); }
    };
    const blockedBefore = blockedWriteCount();
    const prevRo = process.env.DVHUB_READ_ONLY;
    const prevWarn = console.warn;
    const readOnlyLines = [];
    if (sc.readOnly) {
      process.env.DVHUB_READ_ONLY = '1';
      console.warn = (...a) => { readOnlyLines.push(String(a[0]).replace(/ \(bisher \d+\)$/, '')); };
    }
    try {
      await sc.run(rig, { tick, step, advance });
    } finally {
      console.warn = prevWarn;
      if (prevRo === undefined) delete process.env.DVHUB_READ_ONLY; else process.env.DVHUB_READ_ONLY = prevRo;
    }
    result = {
      rig,
      out: {
        wire: [...rig.transport.ops], calls: [...rig.transport.calls], steps, logs: rig.logs, avail: rig.avail,
        mainLogs: rig.main ? rig.main.events : null,
        readOnlyBlocked: blockedWriteCount() - blockedBefore, readOnlyLines,
      },
    };
  });
  return result;
}

const SCENARIOS = {};
const halt = (r) => Object.assign(r.state.ctrl, { discretionaryWritesPaused: true, pausedAt: Date.now() });
const resume = (r) => Object.assign(r.state.ctrl, { discretionaryWritesPaused: false, pausedAt: 0 });

SCENARIOS.normal_block_halt_off = {
  run: async (r, { tick }) => {
    for (let i = 1; i <= 5; i += 1) await tick(`Takt ${i}`);
    r.state.ctrl.negativePriceActive = true;
    for (let i = 1; i <= 3; i += 1) await tick(`§51-Sperre ${i}`);
    r.state.ctrl.negativePriceActive = false;
    r.state.ctrl.forcedOff = true;
    await tick('DV-Sperre');
    r.state.ctrl.forcedOff = false;
    halt(r);
    for (let i = 1; i <= 2; i += 1) await tick(`Not-Halt ${i}`);
    resume(r);
    await tick('nach Not-Halt');
    r.cfg.multiGx.enabled = false;
    await tick('abgeschaltet → einmal 0');
    await tick('abgeschaltet, Ruhe');
    r.cfg.multiGx.enabled = true;
    await tick('wieder an');
  },
  expect: (n) => {
    const a = n.rig.events.map((e) => `${e.value.eng}:${e.action}`);
    assert.equal(a[0].split(':')[1], 'command');
    assert.ok(a.includes('0:autoRestore'), 'die eine 0 beim Abschalten = autoRestore');
    assert.ok(a.some((x) => x.endsWith(':keepalive')), 'gleicher Sollwert erneut = keepalive');
  },
};

SCENARIOS.off_in_halt_and_beta_closed = {
  run: async (r, { tick }) => {
    await tick('Takt 1');
    halt(r);
    r.cfg.multiGx.enabled = false;
    await tick('im Not-Halt abgeschaltet → keine 0');
    resume(r);
    r.cfg.multiGx.enabled = true;
    await tick('wieder an');
    r.cfg.updateChannel = 'stable';
    await tick('Beta-Kanal zu → einmal 0');
    await tick('Beta-Kanal zu, Ruhe');
  },
};

SCENARIOS.halt_during_reads = {
  run: async (r, { tick }) => {
    await tick('Takt 1');
    r.onWrite((e) => { if (e.startsWith('R4 gx2/u100 @843')) halt(r); });
    await tick('Not-Halt während des Lesens');
    r.onWrite(null);
    await tick('Not-Halt');
  },
  expect: (n) => assert.ok(n.rig.events.every((e) => e.state_flags.not_halt === false)),
};

SCENARIOS.read_errors = {
  transport: { failRead: { [`${GX2}@843`]: { msg: 'timeout', skip: 2, times: 3 } } },
  run: async (r, { tick }) => { for (let i = 1; i <= 7; i += 1) await tick(`Takt ${i}`); },
};

SCENARIOS.write_errors = {
  transport: { failWrite: { [`${GX2}@2716`]: { msg: 'timeout', skip: 1, times: 3 } } },
  run: async (r, { tick }) => {
    for (let i = 1; i <= 6; i += 1) await tick(`Takt ${i}`);
    // Eigener Zähler je Schlüssel in der Attrappe: ab hier '2716' (Zugriff 1 → Ausnahme 2, Zugriff 2 → Ausnahme 4).
    delete r.transport.failWrite[`${GX2}@2716`];
    r.transport.failWrite[2716] = { msg: 'modbus exception 2', times: 1 };
    await tick('Ausnahme 2');
    r.transport.failWrite[2716] = { msg: 'modbus exception 4', skip: 1, times: 1 };
    await tick('Ausnahme 4');
    await tick('danach');
  },
  expect: (n) => {
    const d = n.rig.events.filter((e) => e.outcome === 'error').map((e) => e.delivery);
    assert.ok(d.includes('rejected') && d.includes('unknown'), d.join(','));
  },
};

SCENARIOS.write_errors_in_halt = {
  transport: { failWrite: { [`${GX2}@2716`]: { msg: 'timeout', skip: 1, times: 2 } } },
  run: async (r, { tick }) => {
    for (let i = 1; i <= 3; i += 1) await tick(`Takt ${i}`);
    halt(r);
    await tick('Not-Halt (Schreibfehler vergessen)');
    resume(r);
    await tick('nach Not-Halt');
  },
};

SCENARIOS.read_only = {
  readOnly: true,
  run: async (r, { tick }) => {
    for (let i = 1; i <= 4; i += 1) await tick(`Takt ${i}`);
    r.cfg.multiGx.enabled = false;
    await tick('abgeschaltet → 0 im Lese-Modus');
  },
};

// Ungültige Config (writeSafety.ok=false): heute schreibt die zweite GX weiter (Befund, eigener Commit C2).
SCENARIOS.write_safety_invalid = {
  run: async (r, { tick }) => {
    await tick('Takt 1');
    r.cfg.writeSafety = { ok: false, reason: 'manufacturer_profile_error', manufacturer: 'victron' };
    for (let i = 2; i <= 3; i += 1) await tick(`Takt ${i} bei writeSafety.ok=false`);
    r.cfg.multiGx.enabled = false;
    await tick('abgeschaltet bei writeSafety.ok=false');
    r.cfg.multiGx.enabled = true;
    delete r.cfg.writeSafety;
    await tick('Config wieder gültig');
  },
};

// Hauptanlage (Pfad 1) und zweite GX (Pfad 8) am selben Tor, ein gemeinsames Protokoll.
SCENARIOS.shared_log_main_and_second = {
  withMain: true,
  run: async (r, { tick, step, advance }) => {
    const main = (value) => () => r.main.ev.applyControlTarget('gridSetpointW', value, 'rule:abend');
    await step('Haupt -2000', main(-2000));
    await tick('Takt 1');
    await step('Haupt -2000 (Keepalive fällig)', main(-2000));
    await step('Haupt -3000', main(-3000));
    await tick('Takt 2');
    halt(r);
    await step('Haupt -3000 im Not-Halt', main(-3000));
    await tick('Takt im Not-Halt');
    await advance(0);
  },
  expect: (n) => {
    const devices = new Set(n.rig.events.map((e) => e.target.device));
    assert.deepEqual([...devices].sort(), [INVERTER_GATE_DEVICE, MULTI_GX_GATE_DEVICE].sort());
  },
};

for (const [name, sc] of Object.entries(SCENARIOS)) {
  test(`Parität alt ↔ Tor (Pfad 8): ${name}`, async (t) => {
    const before = await runSide(t, 'old', sc);
    const after = await runSide(t, 'new', sc);
    if (BASE && sc.baseDiffers) sc.baseDiffers(before, after);
    else assert.deepEqual(after.out, before.out, `${name}: Tor-Pfad weicht vom alten Weg ab`);
    const ev = after.rig.events;
    const delivered = ev.filter((e) => e.outcome === 'ok' || e.outcome === 'error');
    assert.equal(delivered.length, after.out.calls.length, `${name}: jeder Senken-Aufruf ein Tor-Ereignis`);
    assert.ok(ev.every((e) => e.trust === 'legacy'), 'legacy');
    if (!sc.withMain) assert.ok(ev.every((e) => e.target.device === MULTI_GX_GATE_DEVICE && e.point === 'gridSetpointW'), 'Gerät gx2');
    const blocked = ev.filter((e) => !['ok', 'error'].includes(e.outcome));
    if (sc.readOnly) {
      assert.ok(blocked.length > 0 && blocked.every((e) => e.outcome === 'blocked_readonly'), 'im Lese-Modus sperrt das Tor');
      assert.equal(after.out.readOnlyBlocked, blocked.length, 'je Sperre eine Meldung');
    } else {
      assert.deepEqual(blocked.map((e) => `${e.point}:${e.outcome}:${e.detail}`), [], 'das Tor sperrt nichts, was heute geschrieben wird');
      assert.ok(delivered.length > 0, `${name}: Szenario ohne Write`);
    }
    sc.expect?.(after);
  });
}
