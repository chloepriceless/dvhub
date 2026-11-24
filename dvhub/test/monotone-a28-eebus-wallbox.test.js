// A28 (Koordinator nach Empfehlung, 24.11.2026): EEBUS-Failsafe im laufenden Prozess und die Frische des
// Wallbox-Status (charger-status.fresh) messen monoton. Das Wiederherstellen eines Failsafe nach einem Neustart prüft
// weiter mit der Systemzeit. Die Wanduhr springt um ±3 h, die monotone Uhr läuft gleichmäßig. Jeder Test war vorher rot.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createLimitStateMachine, HEARTBEAT_TIMEOUT_MS } from '../services/eebus/limit-state.js';
import { createChargerStatusPoller } from '../services/wallbox/charger-status.js';

const H3 = 3 * 3_600_000;

function clocks(wall0 = 1_800_000_000_000, mono0 = 10_000) {
  const c = { wall: wall0, mono: mono0 };
  c.now = () => c.wall;
  c.monoNow = () => c.mono;
  c.tick = (ms) => { c.wall += ms; c.mono += ms; };
  c.jump = (ms) => { c.wall += ms; };
  return c;
}

function machine(c, failsafeDurationS = 7200) {
  const m = createLimitStateMachine({ kind: 'lpc', failsafeW: 4200, failsafeDurationS, now: c.now, monoNow: c.monoNow });
  m.setEnabled(true);
  m.onHeartbeat(true);
  return m;
}

test('EEBUS: Rücksprung (−3 h) — ohne Heartbeat geht es nach 120 s Laufzeit in den Failsafe', () => {
  const c = clocks();
  const m = machine(c);
  m.onHeartbeat(false);
  c.jump(-H3); c.tick(HEARTBEAT_TIMEOUT_MS + 1000);
  m.evaluate();
  assert.equal(m.effective().state, 'failsafe');
});

test('EEBUS: Sprung vorwärts (+3 h) — ein kurzer Heartbeat-Aussetzer (10 s) ist noch kein Failsafe', () => {
  const c = clocks();
  const m = machine(c);
  m.onHeartbeat(false);
  c.jump(H3); c.tick(10_000);
  m.evaluate();
  assert.notEqual(m.effective().state, 'failsafe');
});

test('EEBUS: Sprung vorwärts (+3 h) im Failsafe — die Failsafe-Dauer (2 h) endet nicht vorzeitig', () => {
  const c = clocks();
  const m = machine(c);
  m.onHeartbeat(false);
  c.tick(HEARTBEAT_TIMEOUT_MS + 1000);
  m.evaluate();
  assert.equal(m.effective().state, 'failsafe');
  c.jump(H3); c.tick(60_000);
  m.evaluate();
  assert.equal(m.effective().state, 'failsafe', 'nach 1 min Laufzeit noch im Failsafe');
  assert.equal(m.effective().limitW, 4200);
});

test('EEBUS: Rücksprung (−3 h) im Failsafe — er endet nach 2 h Laufzeit, nicht 3 h später', () => {
  const c = clocks();
  const m = machine(c);
  m.onHeartbeat(false);
  c.tick(HEARTBEAT_TIMEOUT_MS + 1000);
  m.evaluate();
  c.jump(-H3); c.tick(7200 * 1000 + 1000);
  m.evaluate();
  assert.equal(m.effective().state, 'unlimited_autonomous');
});

test('EEBUS: Rücksprung (−3 h) — eine Grenze von VOR dem Failsafe beendet ihn nicht, wenn der Heartbeat zurückkommt', () => {
  const c = clocks();
  const m = machine(c);
  m.onLimit({ w: 6000, durationS: 0, active: true }); // Grenze vor dem Rücksprung (Wanduhr später als alles danach)
  c.jump(-H3);
  m.onHeartbeat(false);
  c.tick(HEARTBEAT_TIMEOUT_MS + 1000);
  m.evaluate();
  assert.equal(m.effective().state, 'failsafe');
  c.tick(5000);
  m.onHeartbeat(true); // Heartbeat allein beendet den Failsafe nicht, nur eine NEUE Grenze
  assert.equal(m.effective().state, 'failsafe');
  m.onLimit({ w: 5000, durationS: 0, active: true });
  assert.equal(m.effective().state, 'limited', 'neue Grenze beendet ihn');
});

test('EEBUS: Wiederherstellen nach Neustart prüft mit der Systemzeit und läuft danach monoton weiter', () => {
  const c = clocks();
  const saved = { failsafeSince: c.wall - 3600_000 }; // seit 1 h im Failsafe (früherer Prozess)
  const m = createLimitStateMachine({ kind: 'lpc', failsafeW: 4200, failsafeDurationS: 7200, now: c.now, monoNow: c.monoNow });
  m.setEnabled(true);
  m.restore(saved);
  assert.equal(m.effective().state, 'failsafe');
  c.jump(-H3); c.tick(3600_000 + 1000); // Restzeit 1 h Laufzeit
  m.evaluate();
  assert.equal(m.effective().state, 'unlimited_autonomous');
});

// --- Wallbox-Status (services/wallbox/charger-status.js) -----------------------------------------------------------

function wallbox(c, status) {
  let st = status;
  const poller = createChargerStatusPoller({
    getCfg: () => ({ wallbox: { type: 'keba' } }),
    getAdapter: () => ({ isConfigured: () => true, status: async () => st }),
    now: c.now, monoNow: c.monoNow,
  });
  return { poller, set: (x) => { st = x; } };
}

test('Wallbox-Status: Sprung vorwärts (+3 h) — ein eben gelesener Status bleibt frisch', async () => {
  const c = clocks();
  const w = wallbox(c, { ok: true, connected: true, charging: true, powerW: 7400 });
  await w.poller.poll();
  c.jump(H3); c.tick(1000);
  assert.equal(w.poller.fresh()?.powerW, 7400);
});

test('Wallbox-Status: Rücksprung (−3 h) — nach Lesefehlern veraltet der alte Status nach 90 s Laufzeit', async () => {
  const c = clocks();
  const w = wallbox(c, { ok: true, connected: true, charging: true, powerW: 7400 });
  await w.poller.poll();
  w.set({ ok: false, error: 'timeout' });
  c.jump(-H3); c.tick(30_000);
  await w.poller.poll(); // Fehler: alter Zustand bleibt stehen
  c.tick(61_000);
  assert.equal(w.poller.fresh(), null, '91 s Laufzeit seit der letzten gültigen Lesung');
});
