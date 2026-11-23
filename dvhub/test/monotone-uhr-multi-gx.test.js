// A23 b (Christin 23.11.2026): zweite Victron-GX — Rampe (dt), Frische, Gnadenfrist, Wiederholung und die Reihenfolge
// „Messwert nach dem Schreiben“ laufen monoton. Jeder Test lässt die Wanduhr springen, die monotone Uhr läuft normal.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createMultiGx } from '../services/multi-gx/index.js';
import { createFloorHandoff } from '../services/multi-gx/floor-handoff.js';
import { followerBatteryForFlow } from '../services/multi-gx/planning.js';

function clocks(wall0 = 1_800_000_000_000, mono0 = 10_000) {
  const c = { wall: wall0, mono: mono0 };
  c.now = () => c.wall;
  c.monoNow = () => c.mono;
  c.tick = (ms) => { c.wall += ms; c.mono += ms; };
  c.jump = (ms) => { c.wall += ms; };
  return c;
}

// --- Laufzeitdienst (index.js) ------------------------------------------------------------------------------------

function fakeTransport({ soc = 60, batteryW = 0, minSocRaw = 150 } = {}) {
  const regs = { 843: soc, 842: batteryW < 0 ? batteryW + 65536 : batteryW, 2901: minSocRaw };
  const writes = [];
  return {
    writes,
    // AC-IN der zweiten Anlage nicht lesbar (null) → keine Leine um den gemessenen AC-IN, die Rampe allein begrenzt.
    async mbRequest(req) {
      if (!(req.address in regs)) throw new Error('modbus exception 2');
      return Array.from({ length: req.quantity || 1 }, (_, i) => regs[req.address + i] ?? 0);
    },
    async mbWriteMultiple(req) { writes.push(req); return { addr: req.address, quantity: req.values.length }; },
  };
}

function gxSetup(c, { victron = {} } = {}) {
  const cfg = {
    updateChannel: 'dev', gridPositiveMeans: 'grid_import',
    optimizer: { batteryCapacityWh: 64000, maxSocPct: 100, maxDischargeW: 10000 },
    multiGx: { enabled: true, host: '192.168.1.20', port: 502, unitId: 100, batteryCapacityWh: 64000,
      maxChargeW: 10000, maxDischargeW: 10000, minSocPct: 10, rampWPerS: 200, deadbandW: 300 },
  };
  const state = {
    victron: { soc: 60, batteryPowerW: -8000, minSocPct: 10, errors: {}, gridSetpointW: 0, fieldUpdatedAt: { batteryPowerW: c.wall }, ...victron },
    meter: { ok: true, grid_total_w: 0 },
    ctrl: { forcedOff: false, discretionaryWritesPaused: false, negativePriceActive: false },
  };
  const mgx = createMultiGx({ getCfg: () => cfg, state, pushLog: () => {}, onMultiGxAvailability: () => {} },
    { transport: fakeTransport(), now: c.now, monoNow: c.monoNow });
  return { cfg, state, mgx };
}

test('multi-gx: Sprung vorwärts — die Rampe der zweiten Anlage bleibt bei 200 W/s (dt monoton)', async () => {
  const a = clocks();
  const b = clocks();
  const A = gxSetup(a);
  const B = gxSetup(b);
  for (const [c, s] of [[a, A], [b, B]]) {
    for (let i = 0; i < 3; i += 1) { s.state.victron.fieldUpdatedAt.batteryPowerW = c.wall; await s.mgx.tick(); c.tick(5000); }
  }
  b.jump(3_600_000);
  for (const [c, s] of [[a, A], [b, B]]) { s.state.victron.fieldUpdatedAt.batteryPowerW = c.wall; await s.mgx.tick(); }
  assert.equal(B.state.multiGx.setpointW, A.state.multiGx.setpointW, 'gleicher Sollwert wie ohne Sprung');
  assert.ok(Math.abs(B.state.multiGx.setpointW) <= 200 * 20, `Rampe gehalten: ${B.state.multiGx.setpointW}`);
});

test('multi-gx: Rücksprung — ein stehender Akkuwert der Hauptanlage veraltet nach 30 s Laufzeit', async () => {
  const c = clocks();
  const s = gxSetup(c);
  await s.mgx.tick();
  c.jump(-3_600_000);
  c.tick(31_000);
  await s.mgx.tick();
  assert.equal(s.state.multiGx.reason, 'no_data', 'alter Akkuwert der Hauptanlage zählt nicht');
});

// --- Planung (planning.js) ----------------------------------------------------------------------------------------

test('planning: Akkuwerte der zweiten Anlage veralten nach 20 s Laufzeit, unabhängig von der Wanduhr', async () => {
  const c = clocks();
  const s = gxSetup(c);
  const ctx = { getCfg: () => s.cfg, state: s.state };
  await s.mgx.tick();
  assert.notEqual(followerBatteryForFlow(ctx, c.wall), null, 'frisch');
  c.jump(3_600_000); c.tick(5000);
  assert.notEqual(followerBatteryForFlow(ctx, c.wall), null, 'Sprung vorwärts: 5 s alt, weiter frisch');
  c.jump(-7_200_000); c.tick(20_000);
  assert.equal(followerBatteryForFlow(ctx, c.wall), null, 'Rücksprung: 25 s alt → veraltet');
});

// --- Übergabe am Boden (floor-handoff.js) -------------------------------------------------------------------------

function memoryStore() {
  let value = null;
  return { load: () => value, save: (v) => { value = { ...v }; }, clear: () => { value = null; }, get: () => value };
}

function world(c, { transport = 'mqtt', deviceEcho = true } = {}) {
  const cfg = {
    updateChannel: 'dev', victron: { telemetryMaxAgeMs: 90000 }, optimizer: { hardFloorSocPct: 5 },
    schedule: { evaluateMs: 5000 }, controlWrite: { maxDischargeW: { enabled: true } },
    multiGx: { enabled: true, host: '192.168.1.20', minSocPct: 10, exportHandoffAtFloor: true },
  };
  const state = {
    victron: { soc: 4, maxDischargeW: -1, fieldUpdatedAt: { soc: c.wall, maxDischargeW: c.wall } },
    multiGx: { online: true, socPct: 80, minSocPct: 10, updatedAt: c.wall },
    ctrl: { discretionaryWritesPaused: false, forcedOff: false, negativePriceActive: false },
    schedule: { lastWrite: {} },
  };
  const applied = [];
  const logs = [];
  const handoff = createFloorHandoff({ getCfg: () => cfg, state, pushLog: (e, d) => logs.push([e, d]), now: c.now, monoNow: c.monoNow, store: memoryStore(), transportType: () => transport });
  async function apply(target, value, source) {
    if (state.schedule.lastWrite[target] && Number(state.schedule.lastWrite[target].value) === value) return { ok: true, skipped: true };
    applied.push({ target, value, source });
    state.schedule.lastWrite[target] = { value, at: c.wall };
    if (target === 'maxDischargeW' && deviceEcho) state.victron.maxDischargeW = value;
    return { ok: true };
  }
  // Poller frisch: alle Stempel auf die (aktuelle) Wanduhr.
  const poll = () => { state.victron.fieldUpdatedAt.soc = c.wall; state.victron.fieldUpdatedAt.maxDischargeW = c.wall; state.multiGx.updatedAt = c.wall; };
  const request = () => handoff.onFloorHold({ target: 'gridSetpointW', requested: -3000, source: 'rule:eos' });
  return { cfg, state, applied, logs, handoff, apply, poll, request };
}

async function toActive(c, w) {
  w.request(); await w.handoff.maintain(w.apply);
  w.state.victron.maxDischargeW = 0; c.tick(5000); w.poll();
  assert.equal(w.request(), -3000);
  assert.equal(w.state.multiGxHandoff.phase, 'active');
}

test('Übergabe: Rücksprung — ohne neue Einspeise-Anfrage endet sie nach 20 s Laufzeit', async () => {
  const c = clocks();
  const w = world(c);
  await toActive(c, w);
  c.jump(-3_600_000); c.tick(25_000); w.poll();
  await w.handoff.maintain(w.apply);
  assert.equal(w.state.multiGxHandoff.phase, 'restoring');
  assert.equal(w.state.multiGxHandoff.reason, 'no_export_request');
});

test('Übergabe: Sprung vorwärts — die Gnadenfrist läuft nicht vorzeitig ab, die Sperre bleibt bestätigt', async () => {
  const c = clocks();
  const w = world(c);
  await toActive(c, w);
  c.jump(3_600_000); c.tick(5000); w.poll();
  await w.handoff.maintain(w.apply);
  assert.equal(w.state.multiGxHandoff.phase, 'active');
  assert.equal(w.request(), -3000);
});

// Codex 32af6fd2 (P1): die Reihenfolge „Messwert nach dem Schreiben“ bleibt Wanduhr gegen Wanduhr. Ein Messwert, den
// die GX VOR dem Sperr-Write gesendet hat und der erst nach einem Rücksprung der Uhr ankommt, bestätigt die Sperre
// nicht (eine vom Verbraucher geschätzte Empfangszeit hätte ihn als „danach“ gewertet).
test('Übergabe: Rücksprung — ein vor dem Sperr-Write gesendeter 0-Wert bestätigt die Sperre nicht', async () => {
  const c = clocks();
  const w = world(c, { deviceEcho: false });
  w.request(); await w.handoff.maintain(w.apply);
  const writeWall = c.wall;
  assert.deepEqual(w.applied.map((a) => a.value), [0]);
  c.jump(-3_600_000); c.tick(5000); w.poll();
  w.state.victron.maxDischargeW = 0;
  w.state.victron.fieldSourceAt = { maxDischargeW: writeWall - 1000 }; // MQTT: von der GX vor dem Write gesendet
  assert.equal(w.request(), null, 'Boden hält');
  assert.equal(w.state.multiGxHandoff.phase, 'arming');
  assert.equal(w.state.multiGxHandoff.mainDischargeBlocked, false);
});

test('Übergabe: Rücksprung — stehende zweite Anlage gilt nach 15 s Laufzeit als veraltet', async () => {
  const c = clocks();
  const w = world(c);
  await w.handoff.maintain(w.apply); // Takt vor dem Sprung: Stempel gesehen
  c.jump(-3_600_000); c.tick(16_000);
  w.state.victron.fieldUpdatedAt.soc = c.wall; w.state.victron.fieldUpdatedAt.maxDischargeW = c.wall; // nur die Hauptanlage frisch
  assert.equal(w.request(), null);
  assert.equal(w.state.multiGxHandoff.phase, 'off', 'follower_stale → keine Übergabe');
});

test('Übergabe: Rücksprung — stehender Wert der Entladegrenze veraltet nach 90 s Laufzeit (nichts sichern)', async () => {
  const c = clocks();
  const w = world(c);
  await w.handoff.maintain(w.apply); // Takt vor dem Sprung: Stempel gesehen
  c.jump(-3_600_000); c.tick(91_000);
  w.state.multiGx.updatedAt = c.wall; w.state.victron.fieldUpdatedAt.soc = c.wall; // 2704 steht
  assert.equal(w.request(), null);
  assert.equal(w.state.multiGxHandoff.phase, 'off');
  assert.ok(w.logs.some(([e, d]) => e === 'multi_gx_handoff_skipped' && d.reason === 'max_discharge_unknown'));
});
