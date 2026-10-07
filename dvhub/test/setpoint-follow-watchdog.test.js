// Wächter „Speicher folgt dem Sollwert nicht" (07.10.2026).
//
// Ausfallbild: Sollwert korrekt geschrieben und zurückgelesen, der Wechselrichter
// gibt aber nichts aus dem Akku ab — Netzbezug trotz gefülltem Akku. Die Tests
// sperren die Erkennung und vor allem die Fehlalarm-Schranken fest.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSetpointFollowState,
  evaluateSetpointFollow,
  isRefusingDischarge,
  resolveSetpointFollowOptions,
  createSetpointFollowWatchdog,
  describeSetpoint
} from '../services/setpoint-follow-watchdog.js';

const OPTS = resolveSetpointFollowOptions({});
const T0 = 1_000_000;

// Das Bild vom Abend des 07.10.: Sollwert −100 W, 1,8 kW Netzbezug, Akku steht bei 70 %.
const STUCK = { setpointW: -100, netImportW: 1800, batteryW: 0, soc: 70, minSocPct: 5, maxDischargeW: null };

function feed(state, { fromMs = 0, toMs, stepMs = 1000, sample }) {
  const transitions = [];
  for (let t = fromMs; t <= toMs; t += stepMs) {
    const s = typeof sample === 'function' ? sample(t) : sample;
    const { transition } = evaluateSetpointFollow(state, { nowMs: T0 + t, ...s }, OPTS);
    if (transition) transitions.push([transition, t]);
  }
  return transitions;
}

test('Netzbezug trotz vollem Akku: Alarm nach der Haltezeit, nicht vorher', () => {
  const state = createSetpointFollowState();
  assert.deepEqual(feed(state, { toMs: OPTS.holdMs - 1000, sample: STUCK }), []);
  assert.deepEqual(feed(state, { fromMs: OPTS.holdMs, toMs: OPTS.holdMs + 5000, sample: STUCK }), [['alarm', OPTS.holdMs]]);
  assert.equal(state.active, true);
});

test('auch bei großem Einspeise-Sollwert (Abendverkauf) wird der Stillstand erkannt', () => {
  assert.equal(isRefusingDischarge({ ...STUCK, setpointW: -17700, netImportW: 1400 }, OPTS), true);
});

test('Fehlalarm-Schranken', () => {
  // Akku entlädt (Wechselrichter an der Leistungsgrenze): kein Fehler.
  assert.equal(isRefusingDischarge({ ...STUCK, batteryW: -5000 }, OPTS), false);
  // Akku wird gewollt gehalten: der Sollwert liegt beim Verbrauch.
  assert.equal(isRefusingDischarge({ ...STUCK, setpointW: 1750 }, OPTS), false);
  // Netzladen: Bezug entspricht dem Sollwert.
  assert.equal(isRefusingDischarge({ ...STUCK, setpointW: 8000, netImportW: 8100, batteryW: 6500 }, OPTS), false);
  // Akku an der Entlade-Untergrenze.
  assert.equal(isRefusingDischarge({ ...STUCK, soc: 7 }, OPTS), false);
  assert.equal(isRefusingDischarge({ ...STUCK, soc: 12, minSocPct: 10 }, OPTS), false);
  // Entlade-Sperre gesetzt.
  assert.equal(isRefusingDischarge({ ...STUCK, maxDischargeW: 0 }, OPTS), false);
  // Zu wenig Einspeisung, aber kein Netzbezug (z. B. Wechselrichter abgeregelt).
  assert.equal(isRefusingDischarge({ ...STUCK, setpointW: -6000, netImportW: -2000 }, OPTS), false);
  // Kleine Abweichung im Regelrauschen.
  assert.equal(isRefusingDischarge({ ...STUCK, netImportW: 250 }, OPTS), false);
});

test('fehlende Werte: nicht beurteilbar, kein Alarm und kein Zurücksetzen', () => {
  assert.equal(isRefusingDischarge({ ...STUCK, soc: null }, OPTS), null);
  assert.equal(isRefusingDischarge({ ...STUCK, setpointW: null }, OPTS), null);
  const state = createSetpointFollowState();
  feed(state, { toMs: 300000, sample: STUCK });
  const since = state.suspectSince;
  feed(state, { fromMs: 301000, toMs: 400000, sample: { ...STUCK, batteryW: null } });
  assert.equal(state.suspectSince, since);
});

test('ein kurzer Entlade-Zacken setzt die Haltezeit nicht zurück', () => {
  const state = createSetpointFollowState();
  const transitions = feed(state, {
    toMs: OPTS.holdMs + 2000,
    sample: (t) => (t >= 200000 && t < 215000 ? { ...STUCK, batteryW: -700, netImportW: 1100 } : STUCK)
  });
  assert.deepEqual(transitions, [['alarm', OPTS.holdMs]]);
});

test('Entwarnung erst, wenn die Entladung dauerhaft zurück ist; danach neuer Alarm möglich', () => {
  const state = createSetpointFollowState();
  feed(state, { toMs: OPTS.holdMs, sample: STUCK });
  const ok = { ...STUCK, netImportW: -90, batteryW: -1900 };
  const start = OPTS.holdMs + 1000;
  assert.deepEqual(feed(state, { fromMs: start, toMs: start + OPTS.clearMs - 1000, sample: ok }), []);
  assert.deepEqual(feed(state, { fromMs: start + OPTS.clearMs, toMs: start + OPTS.clearMs, sample: ok }), [['clear', start + OPTS.clearMs]]);
  assert.equal(state.active, false);
  const again = start + OPTS.clearMs + 1000;
  assert.deepEqual(feed(state, { fromMs: again, toMs: again + OPTS.holdMs, sample: STUCK }), [['alarm', again + OPTS.holdMs]]);
});

test('Erinnerung, solange es anhält', () => {
  const state = createSetpointFollowState();
  const transitions = feed(state, { toMs: OPTS.holdMs + OPTS.reminderMs, stepMs: 10000, sample: STUCK });
  assert.deepEqual(transitions.map(([name]) => name), ['alarm', 'reminder']);
});

test('Sollwert in Worten', () => {
  assert.equal(describeSetpoint(-100), 'kein Netzbezug');
  assert.equal(describeSetpoint(-17700), 'Einspeisung mit 17,7 kW');
  assert.equal(describeSetpoint(8000), 'höchstens 8,0 kW Netzbezug');
});

test('Wächter im Poll-Pfad: Push bei Alarm und bei Entwarnung, Status im Live-State', () => {
  const sent = [];
  const logs = [];
  const state = {
    meter: { ok: true },
    victron: { gridSetpointW: -100, gridImportW: 1800, gridExportW: 0, batteryPowerW: 0, soc: 70, minSocPct: 5 }
  };
  const watchdog = createSetpointFollowWatchdog({
    state,
    getCfg: () => ({}),
    pushLog: (event, detail) => logs.push([event, detail]),
    notificationService: { sendDirect: (msg) => { sent.push(msg); return Promise.resolve({ sent: 1 }); } }
  });
  for (let t = 0; t <= OPTS.holdMs; t += 5000) watchdog.tick(T0 + t);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].event, 'setpoint_not_followed');
  assert.match(sent[0].body, /1,8 kW aus dem Netz/);
  assert.match(sent[0].body, /70 %/);
  assert.equal(state.victron.setpointFollow.active, true);
  assert.equal(logs[0][0], 'setpoint_not_followed');

  Object.assign(state.victron, { gridImportW: 0, gridExportW: 90, batteryPowerW: -1900 });
  for (let t = OPTS.holdMs + 5000; t <= OPTS.holdMs + OPTS.clearMs + 10000; t += 5000) watchdog.tick(T0 + t);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].event, 'setpoint_followed_again');
  assert.equal(state.victron.setpointFollow, null);
});

test('abgeschaltet oder eingefrorene Live-Daten: keine Meldung', () => {
  const sent = [];
  const state = {
    meter: { ok: true },
    victron: { gridSetpointW: -100, gridImportW: 1800, gridExportW: 0, batteryPowerW: 0, soc: 70, minSocPct: 5, freeze: { active: true } }
  };
  let cfg = {};
  const watchdog = createSetpointFollowWatchdog({
    state, getCfg: () => cfg, pushLog: () => {},
    notificationService: { sendDirect: (msg) => { sent.push(msg); return Promise.resolve({ sent: 1 }); } }
  });
  for (let t = 0; t <= OPTS.holdMs * 2; t += 5000) watchdog.tick(T0 + t);
  state.victron.freeze = null;
  cfg = { victron: { setpointWatchdog: { enabled: false } } };
  for (let t = 0; t <= OPTS.holdMs * 2; t += 5000) watchdog.tick(T0 + OPTS.holdMs * 3 + t);
  assert.equal(sent.length, 0);
});
