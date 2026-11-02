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

function rig(raw2704) {
  const sent = [];
  const reads = [];
  const state = {
    meter: { ok: true },
    victron: { gridSetpointW: -100, gridImportW: 1800, gridExportW: 0, batteryPowerW: 0, soc: 70, minSocPct: 5, maxDischargeW: null },
    schedule: { active: {}, lastWrite: {} },
    ctrl: {}
  };
  const transport = {
    type: 'modbus',
    async mbRequest(conf) { reads.push(conf); return [raw2704.value]; }
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

test('Sperre an der GX (2704 = 0), DVhub kennt keinen eigenen Write (Neustart): Wächter liest, kein Alarm', async () => {
  const { sent, reads, run } = rig({ value: 0 });
  await run(OPTS.holdMs * 2);
  assert.equal(sent.length, 0);
  assert.ok(reads.length >= 1 && reads.every((r) => r.address === 2704 && r.fc === 3));
  // gedrosselt: höchstens alle 30 s
  assert.ok(reads.length <= Math.ceil((OPTS.holdMs * 2) / 30000) + 1, `${reads.length} Lesevorgänge`);
});

test('kleiner Deckel 2704 = 100 W (raw 10): gilt als Sperre, kein Alarm', async () => {
  const { sent, run } = rig({ value: 10 });
  await run(OPTS.holdMs * 2);
  assert.equal(sent.length, 0);
});

test('2704 unbegrenzt (raw 32767): echter Ausfall wird gemeldet', async () => {
  const { sent, run } = rig({ value: 32767 });
  await run(OPTS.holdMs + 30000);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].event, 'setpoint_not_followed');
});

test('nichts Auffälliges: 2704 wird nicht gelesen', async () => {
  const { state, reads, run } = rig({ value: 0 });
  Object.assign(state.victron, { gridImportW: 0, gridExportW: 90, batteryPowerW: -1900 });
  await run(OPTS.holdMs);
  assert.equal(reads.length, 0);
});
