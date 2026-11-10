// test/nothalt-als-ob-aus.test.js — Not-Halt „als ob die Kiste aus ist“.
//
// Christin 06./07.11.2026: Not-Halt heißt „hör mit allen Steuerungen auf … so als
// ob DVhub ausgeschaltet ist“, Lesen und Logging laufen weiter. 10.11.2026: auch
// § 14a läuft nicht weiter, und „Ja, Not-Halt heißt auch die Punkte von §51 usw.“
// Umsetzung: beim Eintritt genau EINE Rücknahme jeder DVhub-eigenen Vorgabe (nur
// wo DVhub gerade selbst vorgibt, im Zweifel nicht), danach 0 Writes, kein Retry.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createScheduleEvaluator } from '../schedule-eval.js';
import { createFeedInLimitArbiter } from '../services/feed-in-limit-arbiter.js';
import { createMultiGx } from '../services/multi-gx/index.js';
import { setEmergencyStop } from '../services/control-commands.js';
import { readControlState, atomicWriteControlState } from '../control-state-io.js';
import {
  NOT_HALT_CONTINUES, notHaltAllowsControlSource, notHaltAllowsDvReason, notHaltAllowsFeedInSource,
  notHaltSuspendedLabels, setNotHaltProbe, notHaltActive,
} from '../services/emergency-stop/policy.js';
import { createSaliaAdapter } from '../services/wallbox/salia.js';
import { createNexblueAdapter } from '../services/wallbox/nexblue.js';

// --- Richtlinie --------------------------------------------------------------

test('Richtlinie 10.11.2026: keine Pflicht-Klasse schreibt im Not-Halt weiter; Leitstand nennt alles Ausgesetzte', () => {
  assert.deepEqual(Object.values(NOT_HALT_CONTINUES), [false, false, false, false, false]);
  assert.equal(notHaltAllowsControlSource('emergency_stop'), true, 'die eine Neutralisierung');
  for (const src of ['negative_price_protection', 'manual_override_soc_floor', 'eos_optimization', 'rule:x', 'kaputt']) {
    assert.equal(notHaltAllowsControlSource(src), false, src);
  }
  for (const r of ['dv_forced_off', 'negative_price_protection', 'paragraph14a_production_block']) assert.equal(notHaltAllowsDvReason(r), false, r);
  for (const src of ['dv', 'eebus_lpp', 'fixed']) assert.equal(notHaltAllowsFeedInSource(src), false, src);
  // schaltbar: eine Klasse wieder an → nur sie schreibt
  const old = { ...NOT_HALT_CONTINUES, negativePrice: true };
  assert.equal(notHaltAllowsControlSource('negative_price_protection', old), true);
  assert.equal(notHaltAllowsControlSource('manual_override_soc_floor', old), false);
  const labels = notHaltSuspendedLabels().join(' | ');
  for (const t of ['§14a', '§51', 'Direktvermarkter', 'SoC-Boden', 'Steuerbox']) assert.ok(labels.includes(t), t);
});

// --- Steuerpfad (schedule-eval) ----------------------------------------------

function world({ priceCt = 12, forcedOff = false, lastDvFeedIn, failDvOnce = false } = {}) {
  const writes = [];
  const logs = [];
  let failDv = failDvOnce;
  const state = {
    victron: { soc: 50, batteryDischargeW: 0, batteryChargeW: 0, batteryPowerW: 0, pvTotalW: 3000, pvPowerW: 3000, fieldUpdatedAt: { soc: Date.now() } },
    schedule: {
      rules: [], active: {}, lastWrite: {}, manualOverride: {},
      config: { defaultGridSetpointW: -100, defaultChargeCurrentA: null, defaultFeedExcessDcPv: 0 }, lastEvalAt: 0,
    },
    ctrl: { negativePriceActive: false, forcedOff, discretionaryWritesPaused: false, pausedAt: 0, _stopBlockLogged: {} },
    epex: { data: [] },
  };
  if (lastDvFeedIn !== undefined) state.ctrl._lastDvFeedIn = lastDvFeedIn;
  const cfg = {
    controlWrite: { gridSetpointW: { enabled: true, address: 100 }, chargeCurrentA: { enabled: false }, maxDischargeW: { enabled: true, address: 2704 } },
    dvControl: { enabled: true, feedExcessDcPv: { enabled: true, address: 2707 }, dontFeedExcessAcPv: { enabled: true, address: 2708 }, negativePriceProtection: { enabled: true } },
    optimizer: { enabled: false, allowGridCharge: false, allowGridDischarge: true, hardFloorSocPct: 5 },
    negativePriceProtection: { enabled: true, gridSetpointW: -40 },
    schedule: { timezone: 'Europe/Berlin', smallMarketAutomation: { enabled: false } },
  };
  const ctx = {
    state, getCfg: () => cfg,
    transport: {
      type: 'mqtt',
      mqttWrite: async (target, value) => {
        if (failDv && (target === 'feedExcessDcPv' || target === 'dontFeedExcessAcPv')) { failDv = false; throw new Error('timeout'); }
        writes.push({ target, value });
      },
    },
    pushLog: (event, payload) => logs.push({ event, payload: payload || {} }),
    telemetrySafeWrite: (fn) => { try { fn?.(); } catch { /* */ } },
    persistConfig: async () => {}, telemetryStore: null,
    epexNowNext: () => ({ current: { ct_kwh: priceCt, eur_mwh: priceCt * 10 }, next: null }),
    regenerateSmallMarketAutomationRules: async () => {},
    onEvalComplete: () => {},
  };
  const ev = createScheduleEvaluator(ctx);
  const enter = () => { state.ctrl.discretionaryWritesPaused = true; state.ctrl.pausedAt = Date.now(); };
  return { ev, state, cfg, writes, logs, enter };
}

test('Not-Halt bei negativem Preis: von DVhub gesetzte §51-Sperre einmal frei, danach 0 Writes über viele Takte', async () => {
  const w = world({ priceCt: -3 });
  await w.ev.evaluateSchedule(); // Normalbetrieb: §51 sperrt die PV und pinnt den Sollwert
  assert.ok(w.writes.some((x) => x.target === 'feedExcessDcPv' && x.value === 0), '§51 hat gesperrt');
  assert.equal(w.state.ctrl._lastDvFeedIn, false);
  w.enter();
  await w.ev.applyControlTarget('gridSetpointW', 0, 'emergency_stop');
  const n = w.writes.length;
  await w.ev.evaluateSchedule();
  assert.deepEqual(w.writes.slice(n), [{ target: 'feedExcessDcPv', value: 1 }, { target: 'dontFeedExcessAcPv', value: 0 }], 'eine Freigabe');
  const m = w.writes.length;
  for (let i = 0; i < 4; i++) await w.ev.evaluateSchedule();
  assert.equal(w.writes.length, m, 'danach kein einziger Write, obwohl der Preis negativ bleibt');
  assert.ok(w.logs.some((l) => l.event === 'control_write_blocked_nothalt' && l.payload.source === 'negative_price_protection'));
});

test('Not-Halt bei DV-Abregelung (forcedOff): DVhubs Sperre einmal frei, ein neues DV-Signal schreibt nichts', async () => {
  const w = world({ forcedOff: true });
  await w.ev.evaluateSchedule();
  assert.equal(w.state.ctrl._lastDvFeedIn, false, 'DV-Sperre stand');
  w.enter();
  const n = w.writes.length;
  await w.ev.evaluateSchedule();
  assert.equal(w.writes.slice(n).length, 2, 'Freigabe 2707/2708');
  // Neues Signal des Direktvermarkters (server.js setForcedOff → applyDvVictronControl)
  await w.ev.applyDvVictronControl(false, { reason: 'dv_forced_off' });
  for (let i = 0; i < 3; i++) await w.ev.evaluateSchedule();
  assert.equal(w.writes.length, n + 2, 'DV-Abregelung schreibt im Not-Halt nicht');
  assert.ok(w.logs.some((l) => l.event === 'dv_write_blocked_nothalt'));
});

test('Not-Halt ohne eigene Sperre (Neustart, Zustand unbekannt): im Zweifel nichts senden', async () => {
  const w = world({ priceCt: -3 });
  w.enter();
  for (let i = 0; i < 3; i++) await w.ev.evaluateSchedule();
  assert.deepEqual(w.writes, [], 'kein Write — weder Sperre noch Freigabe');
});

test('Not-Halt: scheitert die eine Freigabe, wird sie nicht wiederholt', async () => {
  const w = world({ lastDvFeedIn: false, failDvOnce: true });
  w.enter();
  for (let i = 0; i < 4; i++) await w.ev.evaluateSchedule();
  assert.ok(w.writes.length <= 1, `höchstens der zweite Punkt der einen Freigabe, kein Retry (${JSON.stringify(w.writes)})`);
});

test('Not-Halt am SoC-Boden: die Sicherheits-Nullung schreibt nicht', async () => {
  const w = world();
  w.enter();
  const r = await w.ev.applyControlTarget('gridSetpointW', 0, 'manual_override_soc_floor');
  assert.equal(r.error, 'emergency_stop_active');
  assert.deepEqual(w.writes, []);
});

test('Not-Halt-Tor: eine Rücknahme je Quelle und Not-Halt, kein Wiederholen; neuer Not-Halt darf wieder', async () => {
  const w = world();
  w.state.schedule.lastWrite.maxDischargeW = { value: 5000, source: 'grid_connection_assist', at: Date.now() };
  w.enter();
  const a = await w.ev.applyControlTarget('maxDischargeW', 0, 'peak_shaving_restore');
  assert.equal(a.ok, true);
  delete w.state.schedule.lastWrite.maxDischargeW;
  const b = await w.ev.applyControlTarget('maxDischargeW', 0, 'peak_shaving_restore');
  assert.equal(b.error, 'emergency_stop_active', 'zweiter Versuch im selben Not-Halt blockiert');
  w.state.ctrl.pausedAt += 1; // neuer Not-Halt
  const c = await w.ev.applyControlTarget('maxDischargeW', 0, 'peak_shaving_restore');
  assert.equal(c.ok, true);
});

// Nach dem Merge der Multi-GX-Übergabe (feat/mgx-uebergabe-am-boden, 970ebf36):
// ihre Rücknahme 'multi_gx_handoff_stop' läuft durch dasselbe zentrale Tor und
// ist damit ebenfalls höchstens einmal je Not-Halt möglich.
test('Multi-GX-Übergabe: multi_gx_handoff_stop nur einmal je Not-Halt durch das Tor, Sperren nie', async () => {
  const handoffFile = new URL('../services/multi-gx/floor-handoff.js', import.meta.url);
  if (!fs.existsSync(handoffFile)) return; // vor dem Merge: nichts zu prüfen
  const w = world();
  w.enter();
  const lock = await w.ev.applyControlTarget('maxDischargeW', 0, 'multi_gx_handoff');
  assert.equal(lock.error, 'emergency_stop_active', 'Sperren im Not-Halt blockiert');
  const unannounced = await w.ev.applyControlTarget('maxDischargeW', -1, 'multi_gx_handoff_stop');
  assert.equal(unannounced.error, 'emergency_stop_active', 'ohne angemeldeten Rückschreibwert nichts');
  assert.deepEqual(w.writes, []);
});

// --- Begrenzer 2706 ------------------------------------------------------------

test('Begrenzer 2706 im Not-Halt: DV-/Steuerbox-Grenze einmal zurück auf die feste Grenze, danach still; nach dem Aufheben wieder', async () => {
  const applied = [];
  let paused = false;
  const arb = createFeedInLimitArbiter({ applyLimit: async (w) => { applied.push(w); }, isPaused: () => paused });
  await arb.set('fixed', 6000);
  await arb.set('dv', 3000);
  assert.deepEqual(applied, [6000, 3000]);
  paused = true;
  assert.deepEqual(await arb.emergencyStop(), { ok: true, limitW: 6000 });
  assert.deepEqual(applied, [6000, 3000, 6000], 'DV-Teilvorgabe einmal zurückgenommen, feste Grenze bleibt');
  await arb.set('dv', 1000);
  await arb.set('eebus_lpp', 2000);
  await arb.set('fixed', 5000);
  await arb.reapply();
  assert.equal(applied.length, 3, 'im Not-Halt kein Write mehr — auch kein Nachprüfen');
  paused = false;
  await arb.set('fixed', 5000);
  assert.equal(applied.at(-1), 1000, 'nach dem Aufheben gilt wieder die kleinste Grenze');
});

test('Begrenzer 2706 ohne DV-/Steuerbox-Grenze: im Not-Halt nichts zu neutralisieren', async () => {
  const applied = [];
  const arb = createFeedInLimitArbiter({ applyLimit: async (w) => { applied.push(w); }, isPaused: () => true });
  assert.equal((await arb.emergencyStop()).skipped, 'unchanged');
  assert.deepEqual(applied, []);
});

// --- Zweite GX -------------------------------------------------------------------

function mgxWorld() {
  const calls = [];
  const regs = { 843: 60, 842: 0, 2901: 150 };
  const transport = {
    async mbRequest(req) { calls.push({ op: 'read', ...req }); return Array.from({ length: req.quantity || 1 }, (_, i) => regs[req.address + i] ?? 0); },
    async mbWriteMultiple(req) { calls.push({ op: 'write', ...req }); return {}; },
  };
  const cfg = {
    updateChannel: 'dev', gridPositiveMeans: 'grid_import',
    optimizer: { batteryCapacityWh: 64000, maxSocPct: 100, maxDischargeW: 10000 },
    multiGx: { enabled: true, host: '192.168.1.20', port: 502, unitId: 100, batteryCapacityWh: 64000, maxChargeW: 10000, maxDischargeW: 10000, minSocPct: 10 },
  };
  const state = {
    victron: { soc: 60, batteryPowerW: -4000, minSocPct: 10, errors: {}, gridSetpointW: 0 },
    meter: { ok: true, grid_total_w: 0 },
    ctrl: { forcedOff: false, discretionaryWritesPaused: false, negativePriceActive: false, pausedAt: 0 },
  };
  let t = 0;
  const mgx = createMultiGx({ getCfg: () => cfg, state, pushLog: () => {} }, { transport, now: () => t });
  return { mgx, state, calls, tick: async () => { t += 5000; await mgx.tick(); }, writes: () => calls.filter((c) => c.op === 'write') };
}

test('Zweite GX im Not-Halt: genau eine 0, danach nur noch lesen; nach dem Aufheben wieder Sollwerte', async () => {
  const w = mgxWorld();
  for (let i = 0; i < 4; i++) await w.tick();
  const before = w.writes().length;
  assert.ok(before > 0);
  w.state.ctrl.discretionaryWritesPaused = true; w.state.ctrl.pausedAt = 77;
  for (let i = 0; i < 6; i++) await w.tick();
  const during = w.writes().slice(before);
  assert.equal(during.length, 1, 'eine Neutralisierung');
  assert.deepEqual(during[0].values, [0, 0]);
  assert.ok(w.calls.slice(-3).every((c) => c.op === 'read'), 'Werte laufen weiter');
  assert.equal(w.state.multiGx.online, true, 'lesbar = verfügbar');
  w.state.ctrl.discretionaryWritesPaused = false;
  await w.tick();
  assert.equal(w.writes().length, before + 2, 'Steuerung läuft wieder');
});

test('Zweite GX: Start im Not-Halt (nie beschrieben) → keine einzige Schreibanfrage', async () => {
  const w = mgxWorld();
  w.state.ctrl.discretionaryWritesPaused = true; w.state.ctrl.pausedAt = 5;
  for (let i = 0; i < 4; i++) await w.tick();
  assert.equal(w.writes().length, 0);
});

// --- Eintritt und Aufheben (control-commands) ------------------------------------

test('setEmergencyStop: Wallbox, Heizstab, Geräte, EEBUS und Begrenzer je einmal im Neutralisierungsfenster; Aufheben startet EEBUS neu', async () => {
  const order = [];
  const state = { ctrl: { discretionaryWritesPaused: false } };
  const seen = (name) => async () => { order.push([name, state.ctrl._notHaltNeutralizing === true]); return { ok: true }; };
  const ctx = {
    state, pushLog: () => {}, persistControlState: () => {},
    applyControlTarget: async () => ({ ok: true }),
    eosEvccBridge: { emergencyStop: seen('wallbox') },
    mypvRegulator: { emergencyStop: seen('heater') },
    eosDeviceBridge: { emergencyStop: seen('devices') },
    eebus: { emergencyStop: seen('eebus'), resumeAfterEmergencyStop: () => { order.push(['eebus_resume', state.ctrl.discretionaryWritesPaused]); return { ok: true }; } },
    feedInLimit: { emergencyStop: seen('feedInLimit') },
    p14a: { update: () => order.push(['p14a', state.ctrl.discretionaryWritesPaused]) },
  };
  await setEmergencyStop(ctx, { on: true });
  assert.deepEqual(order, [['wallbox', true], ['heater', true], ['devices', true], ['eebus', true], ['feedInLimit', true], ['p14a', true]]);
  assert.equal(state.ctrl._notHaltNeutralizing, false, 'Fenster wieder zu');
  await setEmergencyStop(ctx, { on: true });
  assert.equal(order.length, 6, 'zweites Auslösen: keine zweite Neutralisierung');
  const r = await setEmergencyStop(ctx, { on: false });
  assert.equal(r.resumed, true);
  assert.deepEqual(order.at(-1), ['eebus_resume', false]);
});

// --- control_state.json ------------------------------------------------------------

test('control_state.json: fehlt → normal; kaputt/ungültig → unlesbar (Start im Not-Halt); gültig → wie gespeichert', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nothalt-state-'));
  const f = path.join(dir, 'control_state.json');
  assert.equal(readControlState(f).status, 'missing');
  for (const broken of ['', '{"discretionaryWritesPaused": tr', '[]', '{"pausedAt":1}', '{"discretionaryWritesPaused":"yes"}', 'null']) {
    fs.writeFileSync(f, broken);
    assert.equal(readControlState(f).status, 'unreadable', JSON.stringify(broken));
  }
  atomicWriteControlState(f, { discretionaryWritesPaused: false, pausedAt: 0, pausedBy: null });
  assert.deepEqual(readControlState(f), { status: 'ok', saved: { discretionaryWritesPaused: false, pausedAt: 0, pausedBy: null } });
  const noRead = { readFileSync: () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; } };
  assert.equal(readControlState(f, noRead).status, 'unreadable', 'Datei da, aber nicht lesbar');
});

// --- Wallbox-Lebenszeichen ---------------------------------------------------------

test('Wallbox-Lebenszeichen (Salia, Nexblue) schweigen im Not-Halt — die Box geht in ihren eigenen Failsafe', async () => {
  const mk = () => {
    const writes = [];
    const t = {
      async mbRequest() { return [0, 0, 0, 0]; },
      async mbWriteSingle(req) { writes.push(req.address); return {}; },
      async mbWriteMultiple(req) { writes.push(req.address); return {}; },
    };
    return { writes, t };
  };
  const s = mk();
  const salia = createSaliaAdapter(() => ({ host: '10.0.0.5' }), { getTransport: () => s.t });
  await salia.charge(10);
  const n = mk();
  const nex = createNexblueAdapter(() => ({ host: '10.0.0.6' }), { getTransport: () => n.t });
  await nex.charge(10);
  const sBefore = s.writes.length; const nBefore = n.writes.length;
  let paused = true;
  setNotHaltProbe(() => paused);
  try {
    assert.equal(notHaltActive(), true);
    await salia.status(); await nex.status();
    assert.equal(s.writes.length, sBefore, 'Salia: kein Lebenszeichen 207');
    assert.equal(n.writes.length, nBefore, 'Nexblue: Strom 1000 nicht nachgeführt');
    paused = false;
    await salia.status(); await nex.status();
    assert.ok(s.writes.length > sBefore && n.writes.length > nBefore, 'ohne Not-Halt wieder Lebenszeichen');
  } finally {
    setNotHaltProbe(null);
  }
});

// --- Codex 2f215968 -------------------------------------------------------------

function evWithTransport(w, mqttWrite) {
  return createScheduleEvaluator({
    state: w.state, getCfg: () => w.cfg, pushLog: () => {}, telemetrySafeWrite: () => {}, persistConfig: async () => {}, telemetryStore: null,
    epexNowNext: () => ({ current: { ct_kwh: -3, eur_mwh: -30 }, next: null }), regenerateSmallMarketAutomationRules: async () => {}, onEvalComplete: () => {},
    transport: { type: 'mqtt', mqttWrite },
  });
}

test('Codex P1: eine vor dem Eintritt begonnene, danach fertige Sperre bekommt nur EINE Freigabe, auch wenn sie scheitert', async () => {
  const w = world({ priceCt: -3 });
  let fail = false;
  let releaseAttempts = 0;
  const ev = evWithTransport(w, async (target, value) => {
    if (fail && target === 'feedExcessDcPv' && value === 1) { releaseAttempts += 1; throw new Error('timeout'); }
    w.writes.push({ target, value });
  });
  // Sperre aus dem Takt vor dem Not-Halt, fertig erst danach
  const p = ev.applyDvVictronControl(false, { reason: 'negative_price_protection' });
  w.enter();
  await p;
  assert.equal(w.state.ctrl._notHaltDv?.mandatoryBlock ?? false, false, 'ausgesetzte Klasse: keine Wiederhol-Freigabe');
  fail = true;
  for (let i = 0; i < 5; i++) await ev.evaluateSchedule();
  assert.equal(releaseAttempts, 1, 'genau ein Freigabe-Versuch, kein Retry');
});

test('Codex P2: Begrenzer — Neutralisierung wartet auf einen laufenden DV-Write', async () => {
  const applied = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  let paused = false;
  const arb = createFeedInLimitArbiter({
    applyLimit: async (w) => { if (w === 3000) await gate; applied.push(w); },
    isPaused: () => paused,
  });
  await arb.set('fixed', 6000);
  const pending = arb.set('dv', 3000); // läuft noch
  paused = true;
  const stop = arb.emergencyStop();
  release();
  await pending;
  assert.deepEqual(await stop, { ok: true, limitW: 6000 });
  assert.deepEqual(applied, [6000, 3000, 6000], 'DV-Grenze nach dem laufenden Write zurückgenommen');
});

test('Codex P2: Teil-Sperre (ein Register gesperrt, das andere gescheitert) wird im Not-Halt einmal freigegeben', async () => {
  const w = world({ lastDvFeedIn: true, priceCt: 12 });
  let n = 0;
  const ev = evWithTransport(w, async (target, value) => { n += 1; if (n === 2) throw new Error('timeout'); w.writes.push({ target, value }); });
  await ev.applyDvVictronControl(false, { reason: 'default' });
  assert.deepEqual(w.writes, [{ target: 'feedExcessDcPv', value: 0 }]);
  assert.equal(w.state.ctrl._lastDvFeedIn, true, 'Cache unverändert (Teilerfolg)');
  w.enter();
  await ev.evaluateSchedule();
  assert.deepEqual(w.writes.slice(1), [{ target: 'feedExcessDcPv', value: 1 }, { target: 'dontFeedExcessAcPv', value: 0 }], 'Teil-Sperre einmal freigegeben');
  for (let i = 0; i < 3; i++) await ev.evaluateSchedule();
  assert.equal(w.writes.length, 3, 'danach nichts mehr');
});

test('Codex b416bf7a: Begrenzer — eine während des Wartens geänderte feste Grenze schreibt die Neutralisierung nicht mit', async () => {
  const applied = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  let paused = false;
  const arb = createFeedInLimitArbiter({
    applyLimit: async (w) => { if (w === 3000) await gate; applied.push(w); },
    isPaused: () => paused,
  });
  await arb.set('fixed', 6000);
  const pending = arb.set('dv', 3000);
  paused = true;
  const stop = arb.emergencyStop();
  const changed = arb.set('fixed', 0); // Konfiguration im Not-Halt geändert → blockiert (wartet auf die Kette)
  release();
  await pending;
  assert.deepEqual(await stop, { ok: true, limitW: 6000 }, 'Stand beim Eintritt, nicht die neue Grenze');
  await changed;
  assert.deepEqual(applied, [6000, 3000, 6000]);
});

// --- Start-Reihenfolge (Fable R2 P2-7) -------------------------------------------
// Neustart im Not-Halt: der Not-Halt muss geladen sein, bevor irgendein Dienst
// startet — feedInCap.start() ruft seinen Takt sofort und schrieb sonst 2706.
test('server.js: loadControlState() läuft vor dem ersten Dienststart (feedInCap, peakShaving, gridConnection, multiGx)', () => {
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const calls = [...src.matchAll(/^\s*(?:if \(IS_RUNTIME_PROCESS\) )?loadControlState\(\);/gm)].map((m) => m.index);
  assert.equal(calls.length, 1, 'genau ein Aufruf');
  for (const start of ['ctx.feedInCap.start()', 'ctx.peakShaving.start()', 'ctx.gridConnection.start()', 'ctx.multiGx.start()', 'mypvRegulator.start()']) {
    const i = src.indexOf(start);
    assert.ok(i > 0, `${start} gefunden`);
    assert.ok(calls[0] < i, `loadControlState() vor ${start}`);
  }
});
