// A23 b (Christin 23.11.2026): Einspeisegrenze — Überschreiten/Erholen, Rücklesetakt und Frische des Zählers monoton.
// Episoden-Zeiten (start/end) und readback.at bleiben Wanduhr (Anzeige, Protokoll).
import test from 'node:test';
import assert from 'node:assert/strict';

import { createExceedMonitor, createFeedInCap } from '../services/feed-in-cap/index.js';
import { createFeedInLimitArbiter } from '../services/feed-in-limit-arbiter.js';
import { HOST, fixClock, loadProfileConfig, recordingModbus, baseState, evaluatorRig } from './helpers/gate-golden.js';

function clocks(wall0 = 1_800_000_000_000, mono0 = 0) {
  const c = { wall: wall0, mono: mono0 };
  c.now = () => c.wall;
  c.monoNow = () => c.mono;
  c.tick = (ms) => { c.wall += ms; c.mono += ms; };
  c.jump = (ms) => { c.wall += ms; };
  return c;
}

test('Überwachung: Rücksprung — Überschreitung wird nach 60 s Laufzeit gemeldet, Start bleibt Wanduhr', () => {
  const c = clocks();
  const m = createExceedMonitor({ now: c.now, monoNow: c.monoNow });
  const start = c.wall;
  assert.equal(m.observe({ exportW: 7000, limitW: 6000 }).event, undefined);
  c.tick(30_000);
  c.jump(-3_600_000);
  m.observe({ exportW: 7000, limitW: 6000 });
  c.tick(30_000);
  const r = m.observe({ exportW: 7000, limitW: 6000 });
  assert.equal(r.event, 'exceeded');
  assert.equal(r.episode.start, start);
});

test('Überwachung: Sprung vorwärts — keine Meldung nach 10 s Laufzeit; Erholung erst nach 30 s Laufzeit', () => {
  const c = clocks();
  const m = createExceedMonitor({ now: c.now, monoNow: c.monoNow });
  m.observe({ exportW: 7000, limitW: 6000 });
  c.tick(5000);
  c.jump(3_600_000);
  c.tick(5000);
  assert.equal(m.observe({ exportW: 7000, limitW: 6000 }).event, undefined);
  c.tick(60_000);
  assert.equal(m.observe({ exportW: 7000, limitW: 6000 }).event, 'exceeded');
  m.observe({ exportW: 5000, limitW: 6000 });
  c.tick(5000);
  c.jump(3_600_000);
  c.tick(5000);
  assert.equal(m.observe({ exportW: 5000, limitW: 6000 }).event, undefined, 'erst 10 s darunter');
  c.tick(25_000);
  const r = m.observe({ exportW: 5000, limitW: 6000 });
  assert.equal(r.event, 'recovered');
  assert.equal(r.episode.end, c.wall);
});

function svc(c, { meterStamp = () => c.wall } = {}) {
  const cfg = { manufacturer: 'victron', userEnergyPricing: { pvPlants: [{ kwp: 10 }] }, controlWrite: { dvFeedInLimitW: { enabled: true, address: 2706, host: 'gx', port: 502, unitId: 100 } }, feedInCap: { mode: 'pct60' } };
  const warnings = new Map();
  const reads = [];
  const transport = { type: 'modbus', async mbRequest(a) { reads.push(a); return [6000]; } };
  const arbiter = createFeedInLimitArbiter({ applyLimit: async () => {} });
  const state = { victron: { gridExportW: 7000 }, meter: { ok: true, updatedAt: meterStamp() }, ctrl: {} };
  const s = createFeedInCap({ getCfg: () => cfg, state, feedInLimit: arbiter, pushLog: () => {} }, {
    getTransport: () => transport, now: c.now, monoNow: c.monoNow,
    setWarning: (id, msg) => { if (msg == null) warnings.delete(id); else warnings.set(id, msg); },
  });
  return { s, state, warnings, reads };
}

test('Dienst: Rücksprung — Rücklesung der Grenze nach 10 min Laufzeit wieder fällig', async () => {
  const c = clocks();
  const r = svc(c);
  await r.s.tick();
  assert.equal(r.reads.length, 1);
  const at1 = r.s.status().readback.at;
  c.jump(-3_600_000);
  c.tick(11 * 60_000);
  r.state.meter.updatedAt = c.wall;
  await r.s.tick();
  assert.equal(r.reads.length, 2);
  assert.notEqual(r.s.status().readback.at, at1, 'readback.at = Wanduhr der neuen Lesung');
});

test('Dienst: Sprung vorwärts — keine vorzeitige Rücklesung', async () => {
  const c = clocks();
  const r = svc(c);
  await r.s.tick();
  c.jump(3_600_000);
  c.tick(5000);
  r.state.meter.updatedAt = c.wall;
  await r.s.tick();
  assert.equal(r.reads.length, 1);
});

test('Dienst: Rücksprung — ein stehender Zählerwert veraltet nach 15 s Laufzeit (keine Meldung aus alten Daten)', async () => {
  const c = clocks();
  const r = svc(c);
  // Der Zähler-Poller steht: updatedAt bleibt beim ersten Wert. Die Uhr springt 1 h zurück.
  c.jump(-3_600_000);
  for (let i = 0; i <= 16; i += 1) { await r.s.tick(); c.tick(5000); }
  assert.equal(r.warnings.has('feed_in_cap_exceeded'), false);
  assert.equal(r.s.meterFresh(), false);
});

test('Dienst: frischer Zähler gilt, auch wenn sein Stempel nach einem Rücksprung in der Zukunft liegt', async () => {
  const c = clocks();
  const r = svc(c);
  assert.equal(r.s.meterFresh(), true);
  c.jump(-3_600_000);
  c.tick(1000);
  assert.equal(r.s.meterFresh(), true, '1 s alt');
  r.state.meter.ok = false;
  assert.equal(r.s.meterFresh(), false, 'ok=false bleibt nicht frisch');
});

// Regelschleife (schedule-eval feedInCapTick): die Frische des Zählers kommt vom Dienst (monoton), nicht mehr aus
// Date.now() − state.meter.updatedAt.

const ADDR = { storCtlMod: 40191, outWRte: 40198, wMaxLimPct: 40242, wMaxLimPctRvrtTms: 40244, wMaxLimEna: 40246 };
function froniusLoopRig(meterFresh) {
  const cfg = loadProfileConfig('fronius', { victron: { host: HOST } });
  for (const [k, a] of Object.entries(ADDR)) cfg.controlWrite[k].address = a;
  const state = baseState({ ctrl: { _lastDvFeedIn: true, _dvBlockReason: null } });
  const rig = evaluatorRig({ cfg, ctx: { feedInCap: { limitForLoop: () => 6000, meterFresh } }, state, transport: recordingModbus({ holding: { [ADDR.wMaxLimPct]: 10000 } }) });
  const now = Date.now();
  Object.assign(rig.state.victron, { soc: 50, gridImportW: 0, gridExportW: 7000, selfConsumptionW: 1000, pvTotalW: 9000, pvPowerW: 9000, fieldUpdatedAt: { soc: now, selfConsumptionW: now, pvPowerW: now } });
  Object.assign(rig.state.meter, { ok: true, updatedAt: now, grid_total_w: -7000 });
  return rig;
}

test('Regelschleife: Zähler laut Dienst veraltet → kein Eintritt, obwohl updatedAt nach Wanduhr frisch ist', async (t) => {
  fixClock(t);
  const stale = froniusLoopRig(() => false);
  await stale.ev.feedInCapTick();
  assert.equal(stale.state.ctrl._fic?.capActive === true, false);
  const fresh = froniusLoopRig(() => true);
  await fresh.ev.feedInCapTick();
  assert.equal(fresh.state.ctrl._fic?.capActive, true);
});
