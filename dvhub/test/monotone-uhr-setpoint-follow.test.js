// A23 b (Christin 23.11.2026): Entlade-Wächter (setpoint-follow-watchdog) — Fenster, Verdachtszeit, Erinnerung,
// Entwarnung, Frische der Messwerte und der Takt der eigenen Rücklesung laufen monoton. „Seit“ (ISO) bleibt Wanduhr.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSetpointFollowWatchdog, resolveSetpointFollowOptions, CAP_READ_EVERY_MS } from '../services/setpoint-follow-watchdog.js';

const OPTS = resolveSetpointFollowOptions({});
const WALL0 = 1_800_000_000_000;

function setup({ cfg = {}, transport = null } = {}) {
  const sent = [];
  const state = {
    meter: { ok: true },
    victron: { gridSetpointW: -100, gridImportW: 1800, gridExportW: 0, batteryPowerW: 0, soc: 70, minSocPct: 5 },
  };
  const watchdog = createSetpointFollowWatchdog({
    state, getCfg: () => cfg, pushLog: () => {}, transport,
    notificationService: { sendDirect: (msg) => { sent.push(msg); return Promise.resolve({ sent: 1 }); } },
  });
  const c = { wall: WALL0, mono: 50_000 };
  const poll = () => {
    state.victron.fieldUpdatedAt = { gridSetpointW: c.wall, batteryPowerW: c.wall, soc: c.wall };
    watchdog.tick(c.wall, c.mono);
  };
  return { state, watchdog, sent, c, poll };
}

test('Wächter: Rücksprung mitten in der Episode — Alarm nach holdMs Laufzeit, „seit“ als Wanduhr, Minuten richtig', () => {
  const s = setup();
  const firstWall = s.c.wall;
  for (let t = 0; t <= OPTS.holdMs; t += 5000) {
    if (t === OPTS.holdMs / 2) s.c.wall -= 3_600_000;
    s.poll();
    if (t < OPTS.holdMs) { s.c.wall += 5000; s.c.mono += 5000; }
  }
  assert.equal(s.sent.length, 1, 'Alarm nach 10 min Laufzeit');
  assert.equal(s.sent[0].event, 'setpoint_not_followed');
  assert.match(s.sent[0].body, new RegExp(`Seit ${Math.round(OPTS.holdMs / 60000)} Minuten`));
  assert.equal(s.state.victron.setpointFollow.since, new Date(firstWall).toISOString());
  assert.equal(s.state.victron.setpointFollow.sinceMs, OPTS.holdMs);
});

test('Wächter: Sprung vorwärts mitten in der Episode — keine Lücke, Alarm nach holdMs Laufzeit', () => {
  const s = setup();
  for (let t = 0; t <= OPTS.holdMs; t += 5000) {
    if (t === OPTS.holdMs / 2) s.c.wall += 3_600_000;
    s.poll();
    if (t < OPTS.holdMs) { s.c.wall += 5000; s.c.mono += 5000; }
  }
  assert.equal(s.sent.length, 1);
  assert.equal(s.watchdog._state().active, true);
});

test('Wächter: Rücksprung — stehende Messwerte veralten nach maxAgeMs Laufzeit (kein Punkt aus alten Werten)', () => {
  const s = setup();
  s.poll();
  assert.equal(s.watchdog._state().window.length, 1);
  // Der Poller steht (Stempel bleiben), die Uhr springt zurück.
  s.c.wall -= 3_600_000;
  s.c.mono += OPTS.maxAgeMs + 5000;
  s.watchdog.tick(s.c.wall, s.c.mono);
  assert.equal(s.watchdog._state().window.length, 1, 'kein neuer Punkt aus veralteten Werten');
});

test('Wächter: Rücksprung — eigene Rücklesung der Entladegrenze nach 30 s Laufzeit wieder fällig', async () => {
  const reads = [];
  const transport = { type: 'modbus', async mbRequest(a) { reads.push(a); return a.quantity === 2 ? [0, 5000] : [500]; } };
  const cfg = { manufacturer: 'victron', victron: { host: 'gx' }, controlWrite: { maxDischargeW: { enabled: true, address: 2704 } } };
  const s = setup({ cfg, transport });
  s.poll();
  await new Promise((r) => setImmediate(r));
  const n1 = reads.length;
  assert.ok(n1 >= 1, 'erste Rücklesung (auffälliger Punkt)');
  s.c.wall -= 3_600_000; s.c.mono += CAP_READ_EVERY_MS + 1000;
  s.poll();
  await new Promise((r) => setImmediate(r));
  assert.ok(reads.length > n1, 'nach 31 s Laufzeit erneut gelesen');
});

test('Wächter: Sprung vorwärts — keine vorzeitige Rücklesung', async () => {
  const reads = [];
  const transport = { type: 'modbus', async mbRequest(a) { reads.push(a); return a.quantity === 2 ? [0, 5000] : [500]; } };
  const cfg = { manufacturer: 'victron', victron: { host: 'gx' }, controlWrite: { maxDischargeW: { enabled: true, address: 2704 } } };
  const s = setup({ cfg, transport });
  s.poll();
  await new Promise((r) => setImmediate(r));
  const n1 = reads.length;
  s.c.wall += 3_600_000; s.c.mono += 5000;
  s.poll();
  await new Promise((r) => setImmediate(r));
  assert.equal(reads.length, n1);
});

// Codex 29b60b7e (P2): die eigene Rücklesung bleibt auf der Wanduhr-Achse der anderen Rücklesungen. Eine neuere Sperre
// aus Peak Shaving geht der älteren eigenen Lesung „unbegrenzt“ auch nach einem Sprung vorwärts vor (kein Fehlpunkt).
test('Wächter: Sprung vorwärts — neuere Sperre aus Peak Shaving geht der älteren eigenen Lesung vor', async () => {
  const transport = { type: 'modbus', async mbRequest(a) { return a.quantity === 2 ? [0xffff, 0xffff] : [0]; } };
  const cfg = { manufacturer: 'victron', victron: { host: 'gx' }, controlWrite: { maxDischargeW: { enabled: true, address: 2704 } } };
  const s = setup({ cfg, transport });
  s.poll(); // auffälliger Punkt, eigene Lesung 2720 = −1 (unbegrenzt)
  await new Promise((r) => setImmediate(r));
  const n = s.watchdog._state().window.length;
  s.c.wall += 29_000; s.c.mono += 29_000;
  s.state.ctrl = { _peakShaving: { readback: { value: 0, at: s.c.wall, ambiguousZero: false } } }; // Sperre bestätigt
  s.c.wall += 1000; s.c.mono += 1000;
  s.c.wall += 30_000; // Sprung vorwärts
  s.poll();
  assert.equal(s.watchdog._state().window.length, n, 'Sperre entschuldigt: kein neuer auffälliger Punkt');
});

// Codex 4fd0803c (P2): eine monoton frische eigene Lesung der Sperre gilt auch nach einem Sprung über 90 s hinaus.
test('Wächter: Rücksprung > 90 s — frische eigene Lesung „gesperrt“ entschuldigt weiter', async () => {
  const transport = { type: 'modbus', async mbRequest(a) { return a.quantity === 2 ? [0, 0] : [0]; } }; // 2720 = 0 W
  const cfg = { manufacturer: 'victron', victron: { host: 'gx' }, controlWrite: { maxDischargeW: { enabled: true, address: 2704 } } };
  const s = setup({ cfg, transport });
  s.poll(); // auffälliger Punkt, eigene Lesung: gesperrt (0 W, eindeutig)
  await new Promise((r) => setImmediate(r));
  const n = s.watchdog._state().window.length;
  s.c.wall -= 3_600_000; s.c.mono += 5000;
  s.poll();
  assert.equal(s.watchdog._state().window.length, n, 'Sperre entschuldigt: kein neuer auffälliger Punkt');
});
