// Entlade-Wächter liest die Entlade-Sperre 2704 selbst (Gegenprüfung 01f4558b,
// 11f597d3). Das Victron-Profil pollt 2704 bewusst nicht (Peak-Shaving-
// Entscheidung eb2f1a26); DVhubs eigener Schreibwert fehlt nach einem Neustart,
// stammt evtl. von Peak Shaving oder ist ein kleiner Deckel statt 0. Darum
// liest der Wächter das Register, sobald er etwas Auffälliges sieht, alarmiert
// oder zuletzt eine Sperre gelesen hat — und nur dann.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSetpointFollowWatchdog, resolveSetpointFollowOptions } from '../services/setpoint-follow-watchdog.js';

const OPTS = resolveSetpointFollowOptions({});
const T0 = 1_000_000;
const CFG = {
  victron: { host: '192.0.2.10', port: 502, unitId: 100 },
  controlWrite: {
    maxDischargeW: {
      enabled: true, fc: 6, address: 2704, writeType: 'int16', signed: true, scale: 10, offset: 0,
      rawSentinels: [0], rawSentinelMap: { '-1': 32767 }, host: '192.0.2.10', port: 502, unitId: 100
    }
  }
};

// regs: Adresse → Rohwörter (Array) oder Error (Register unbekannt). 2720 =
// MaxDischargePower als int32 in W (−1 eindeutig), 2704 = int16 in 10-W-Schritten.
function rig(regs, { ownWrite = null } = {}) {
  const sent = [];
  const reads = [];
  const state = {
    meter: { ok: true },
    victron: { gridSetpointW: -100, gridImportW: 1800, gridExportW: 0, batteryPowerW: 0, soc: 70, minSocPct: 5, maxDischargeW: null },
    schedule: { active: {}, lastWrite: ownWrite ? { maxDischargeW: ownWrite } : {} },
    ctrl: {}
  };
  const transport = {
    type: 'modbus',
    async mbRequest(conf) {
      reads.push(conf);
      const v = regs[conf.address];
      if (v instanceof Error || v === undefined) throw v || new Error('modbus exception 2');
      return v;
    }
  };
  const watchdog = createSetpointFollowWatchdog({
    state, getCfg: () => CFG, transport, pushLog: () => {},
    notificationService: { sendDirect: (msg) => { sent.push(msg); return Promise.resolve({ sent: 1 }); } }
  });
  async function run(toMs, { fromMs = 0, stepMs = 5000 } = {}) {
    for (let t = fromMs; t <= toMs; t += stepMs) {
      const now = T0 + t;
      state.victron.fieldUpdatedAt = { gridSetpointW: now, batteryPowerW: now, soc: now };
      watchdog.tick(now);
      await new Promise((r) => setImmediate(r)); // Lesevorgang abschließen lassen
    }
  }
  return { state, sent, reads, run, watchdog };
}

test('Sperre an der GX (2720 = 0), DVhub kennt keinen eigenen Write (Neustart): Wächter liest, kein Alarm', async () => {
  const { sent, reads, run } = rig({ 2720: [0, 0], 2704: [0] });
  await run(OPTS.holdMs * 2);
  assert.equal(sent.length, 0);
  assert.ok(reads.length >= 1 && reads.every((r) => r.address === 2720 && r.fc === 3 && r.quantity === 2));
  // gedrosselt: höchstens alle 30 s
  assert.ok(reads.length <= Math.ceil((OPTS.holdMs * 2) / 30000) + 1, `${reads.length} Lesevorgänge`);
});

test('kleiner Deckel 100 W (2720 = 100): gilt als Sperre, kein Alarm', async () => {
  const { sent, run } = rig({ 2720: [0, 100], 2704: [10] });
  await run(OPTS.holdMs * 2);
  assert.equal(sent.length, 0);
});

test('unbegrenzt (2720 = 32767 W wie DVhub es schreibt): echter Ausfall wird gemeldet', async () => {
  const { sent, run } = rig({ 2720: [0, 32767], 2704: [32767] });
  await run(OPTS.holdMs + 30000);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].event, 'setpoint_not_followed');
});

test('nichts Auffälliges: 2704 wird nicht gelesen', async () => {
  const { state, reads, run } = rig({ 2720: [0, 0], 2704: [0] });
  Object.assign(state.victron, { gridImportW: 0, gridExportW: 90, batteryPowerW: -1900 });
  await run(OPTS.holdMs);
  assert.equal(reads.length, 0);
});

// Victron dbus_modbustcp (mappings.cpp convertFromDbus): round(−1 W × 0,1) = 0 —
// die Werkseinstellung „unbegrenzt“ (−1) liest sich auf 2704 als Rohwert 0,
// genau wie eine Sperre. Ohne 2720 hätte der Wächter dauerhaft geschwiegen
// (Gegenprüfung 7c9e01aa, P1).
test('Werkseinstellung −1: 2720 liest −1, 2704 läse 0 — kein Freibrief, Alarm kommt', async () => {
  const { sent, run } = rig({ 2720: [0xffff, 0xffff], 2704: [0] });
  await run(OPTS.holdMs + 30000);
  assert.equal(sent.length, 1);
});

test('alte GX ohne 2720: 2704 = 0 zählt nur, wenn DVhub selbst 0 geschrieben hat', async () => {
  const noOwn = rig({ 2720: new Error('modbus exception 2'), 2704: [0] });
  await noOwn.run(OPTS.holdMs + 30000);
  assert.equal(noOwn.sent.length, 1, 'mehrdeutig (−1 oder Sperre) → kein Freibrief');
  const own = rig({ 2720: new Error('modbus exception 2'), 2704: [0] }, { ownWrite: { value: 0, source: 'api', at: T0 - 3 * 3600000 } });
  await own.run(OPTS.holdMs * 2);
  assert.equal(own.sent.length, 0, 'eigene Sperre bestätigt');
});

test('eine einzelne Spitze, danach lange gewolltes Halten: 2704/2720 wird nicht dauernd gelesen', async () => {
  const { state, watchdog, reads } = rig({ 2720: [0xffff, 0xffff], 2704: [0] });
  const at = (t) => { state.victron.fieldUpdatedAt = { gridSetpointW: T0 + t, batteryPowerW: T0 + t, soc: T0 + t }; };
  at(0); watchdog.tick(T0); await new Promise((r) => setImmediate(r));
  // danach 2 h SoC an der Untergrenze (entschuldigt)
  state.victron.soc = 6;
  for (let t = 5000; t <= 2 * 3600000; t += 5000) { at(t); watchdog.tick(T0 + t); await new Promise((r) => setImmediate(r)); }
  assert.ok(reads.length <= Math.ceil(OPTS.holdMs / 30000) + 1, `${reads.length} Lesevorgänge in 2 h`);
});

// --- Gegenprüfung 0ff2eb8d -----------------------------------------------------
test('ein Timeout auf 2720 schaltet nicht dauerhaft auf 2704 um', async () => {
  let n2720 = 0;
  const regs = {
    get 2720() { n2720 += 1; return n2720 === 1 ? new Error('modbus timeout') : [0, 0]; },
    2704: [0]
  };
  const { sent, reads, run } = rig(regs);
  await run(OPTS.holdMs * 2);
  assert.equal(sent.length, 0, 'Sperre (2720 = 0) nach dem Timeout erkannt');
  assert.ok(reads.filter((r) => r.address === 2720).length >= 2, '2720 erneut versucht');
});

test('eindeutiges 2720 = −1 sticht eine alte eigene 0 plus 2704-Rücklesung 0 aus', async () => {
  const { state, sent, watchdog } = rig({ 2720: [0xffff, 0xffff], 2704: [0] }, { ownWrite: { value: 0, source: 'peak_shaving_restore', at: T0 - 3 * 3600000 } });
  // Operator-Poll-Punkt bzw. Peak-Shaving-Rücklesung meldet 2704 = 0 (mehrdeutig).
  state.victron.maxDischargeW = 0;
  state.victron.errors = {};
  for (let t = 0; t <= OPTS.holdMs + 60000; t += 5000) {
    const now = T0 + t;
    state.victron.fieldUpdatedAt = { gridSetpointW: now, batteryPowerW: now, soc: now, maxDischargeW: now };
    watchdog.tick(now);
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(sent.length, 1, 'echter Ausfall wird gemeldet');
});

test('leere Modbus-Antwort ist ein Lesefehler, keine Sperre', async () => {
  const { sent, run } = rig({ 2720: [], 2704: [] });
  await run(OPTS.holdMs + 30000);
  assert.equal(sent.length, 1);
});

test('GX ohne 2720 mit Werkseinstellung (2704 liest 0, kein eigener Write): kein Dauerlesen', async () => {
  const { state, watchdog, reads } = rig({ 2720: new Error('modbus exception 2'), 2704: [0] });
  const at = (t) => { state.victron.fieldUpdatedAt = { gridSetpointW: T0 + t, batteryPowerW: T0 + t, soc: T0 + t }; };
  at(0); watchdog.tick(T0); await new Promise((r) => setImmediate(r));
  state.victron.soc = 6; // danach lange entschuldigt
  for (let t = 5000; t <= 2 * 3600000; t += 5000) { at(t); watchdog.tick(T0 + t); await new Promise((r) => setImmediate(r)); }
  assert.ok(reads.length <= 2 * (Math.ceil(OPTS.holdMs / 30000) + 1), `${reads.length} Lesevorgänge in 2 h`);
});
