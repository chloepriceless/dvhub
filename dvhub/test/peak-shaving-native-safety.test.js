// test/peak-shaving-native-safety.test.js — Peak Shaving P5, nativer Hebel: Ladestand-Schutz und Not-Halt
// (Codex 2be66554 P1/P2). Der Wächter prüft beim Netz-Sollwert-Deckel keinen Ladestand und bei der Entladegrenze nur
// seine eigenen Böden — Peak Shaving fordert deshalb nur an, wenn sein Ladestand frisch und über dem Boden
// (inkl. peakShaving.minSocPct) ist, und nimmt eine stehende Anforderung sonst zurück.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createPeakShaving } from '../services/peak-shaving/index.js';

const CFG = {
  manufacturer: 'bridge-mqtt', updateChannel: 'dev', victron: { transport: 'mqtt' },
  controlWrite: { gridSetpointW: { enabled: true }, maxDischargeW: { enabled: true } },
  peakShaving: { enabled: true, gridImportLimitW: 10000, marginW: 300, billing15min: false, minSocPct: 40 }
};

function makeState({ soc = 60, socAgeMs = 1000 } = {}) {
  const now = Date.now();
  return {
    victron: { soc, batteryPowerW: 0, gridImportW: 14000, fieldUpdatedAt: { soc: now - socAgeMs, batteryPowerW: now }, errors: {} },
    meter: { ok: true, updatedAt: now, grid_total_w: -14000 }, schedule: { lastWrite: {} }, ctrl: {}
  };
}

function fakeAssist() {
  const live = new Map();
  return {
    live,
    request(q) { if (this.paused) return { ok: false, reason: 'emergency_stop' }; live.set(q.source, q); return { ok: true, kind: 'native' }; },
    release(src) { return { ok: live.delete(src) }; },
    status() { return {}; }
  };
}

test('Ladestand unter peakShaving.minSocPct: keine Anforderung; eine stehende wird zurückgenommen', () => {
  const state = makeState({ soc: 60 });
  const assist = fakeAssist();
  const ps = createPeakShaving({ state, getCfg: () => CFG, pushLog: () => {}, batteryAssist: assist });
  ps.pollTick();
  assert.equal(assist.live.has('peak-shaving'), true);
  state.victron.soc = 30;
  ps.pollTick();
  assert.equal(assist.live.has('peak-shaving'), false);
  assert.equal(state.ctrl._peakShaving.assist.requested, false);
  assert.equal(state.ctrl._peakShaving.assist.reason, 'soc_floor');
});

test('Ladestand veraltet: keine Anforderung', () => {
  const state = makeState({ socAgeMs: 10 * 60_000 });
  const assist = fakeAssist();
  createPeakShaving({ state, getCfg: () => CFG, pushLog: () => {}, batteryAssist: assist }).pollTick();
  assert.equal(assist.live.has('peak-shaving'), false);
});

test('Not-Halt lehnt die Erneuerung ab → die alte Anforderung wird freigegeben (nicht nach dem Not-Halt wieder aktiv)', () => {
  const state = makeState();
  const assist = fakeAssist();
  const cfg = structuredClone(CFG);
  const ps = createPeakShaving({ state, getCfg: () => cfg, pushLog: () => {}, batteryAssist: assist });
  ps.pollTick();
  assert.equal(assist.live.has('peak-shaving'), true);
  assist.paused = true;
  ps.pollTick();
  assert.equal(assist.live.has('peak-shaving'), false, 'abgelehnte Erneuerung gibt die alte frei');
  cfg.peakShaving.enabled = false;
  assist.paused = false;
  ps.pollTick();
  assert.equal(assist.live.has('peak-shaving'), false);
});

test('Codex e5a25ac1: Sungrow — Boden gegen den echten Ladestand (Fenster 10–100 %: gemeldet 35 % = 41,5 %)', () => {
  const now = Date.now();
  const cfg = { ...CFG, manufacturer: 'sungrow', victron: { transport: 'modbus' },
    controlWrite: { gridSetpointW: { enabled: true, emulate: 'sungrow-ems' } } };
  const state = makeState({ soc: 35 });
  state.victron.device = { minSocPctDevice: 10, maxSocPctDevice: 100 };
  state.victron.fieldUpdatedAt.soc = now;
  const assist = fakeAssist();
  createPeakShaving({ state, getCfg: () => cfg, pushLog: () => {}, batteryAssist: assist }).pollTick();
  assert.equal(assist.live.has('peak-shaving'), true, JSON.stringify(state.ctrl._peakShaving?.assist));
});

test('Codex 65c52509: Sungrow — Geräte-Minimum zählt als Boden (Fenster 30–100 %, gemeldet 0 % = echt 30 %)', () => {
  // Echter Ladestand 30 % liegt auf dem Geräte-Minimum (über dem harten Boden 5 %) → keine Anforderung.
  const cfg = { ...CFG, manufacturer: 'sungrow', victron: { transport: 'modbus' }, peakShaving: { ...CFG.peakShaving, minSocPct: null },
    controlWrite: { gridSetpointW: { enabled: true, emulate: 'sungrow-ems' } } };
  const state = makeState({ soc: 0 });
  state.victron.device = { minSocPctDevice: 30, maxSocPctDevice: 100 };
  const assist = fakeAssist();
  createPeakShaving({ state, getCfg: () => cfg, pushLog: () => {}, batteryAssist: assist }).pollTick();
  assert.equal(assist.live.has('peak-shaving'), false);
  assert.equal(state.ctrl._peakShaving.assist.reason, 'soc_floor');
});

test('Codex 57c5dc10: zwei Sungrow-WR — jeder gegen seinen eigenen Boden; einer mit Luft reicht', () => {
  // Master echt 65 % bei Boden 70 % (Geräte-Minimum 70): am Boden. Slave echt 20 % bei Boden 10 %: hat Luft.
  const cfg = { ...CFG, manufacturer: 'sungrow', victron: { transport: 'modbus' }, peakShaving: { ...CFG.peakShaving, minSocPct: null },
    sungrow: { secondInverter: { host: '192.0.2.20', aggregateTelemetry: true } },
    controlWrite: { gridSetpointW: { enabled: true, emulate: 'sungrow-ems' } } };
  const state = makeState({ soc: 65 });
  state.victron.device = { minSocPctDevice: 70, maxSocPctDevice: 100 };
  state.victron.sungrowMasterSocPct = 0;   // relativ 0 % = echt 70 % = Geräte-Minimum
  state.sungrowSecond = { online: true, updatedAt: Date.now(), socPct: 20, minSocPctDevice: 10, maxSocPctDevice: 100 };
  // Slave: relativ 20 % → echt 10 + 0,2 × 90 = 28 % > Boden 10 % (+ Puffer)
  const assist = fakeAssist();
  createPeakShaving({ state, getCfg: () => cfg, pushLog: () => {}, batteryAssist: assist }).pollTick();
  assert.equal(assist.live.has('peak-shaving'), true, JSON.stringify(state.ctrl._peakShaving?.assist));
});
