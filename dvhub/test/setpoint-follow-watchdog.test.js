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
  const stamp = (t) => { state.victron.fieldUpdatedAt = { gridSetpointW: t, batteryPowerW: t, soc: t }; };
  for (let t = 0; t <= OPTS.holdMs; t += 5000) { stamp(T0 + t); watchdog.tick(T0 + t); }
  assert.equal(sent.length, 1);
  assert.equal(sent[0].event, 'setpoint_not_followed');
  assert.match(sent[0].body, /1,8 kW aus dem Netz/);
  assert.match(sent[0].body, /70 %/);
  assert.equal(state.victron.setpointFollow.active, true);
  assert.equal(logs[0][0], 'setpoint_not_followed');

  Object.assign(state.victron, { gridImportW: 0, gridExportW: 90, batteryPowerW: -1900 });
  for (let t = OPTS.holdMs + 5000; t <= OPTS.holdMs + OPTS.clearMs + 10000; t += 5000) { stamp(T0 + t); watchdog.tick(T0 + t); }
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

test('veraltete Messwerte (fehlgeschlagene Reads): keine Meldung', () => {
  const sent = [];
  const state = {
    meter: { ok: true },
    victron: {
      gridSetpointW: -100, gridImportW: 1800, gridExportW: 0, batteryPowerW: 0, soc: 70, minSocPct: 5,
      fieldUpdatedAt: { gridSetpointW: T0, batteryPowerW: T0, soc: T0 }
    }
  };
  const watchdog = createSetpointFollowWatchdog({
    state, getCfg: () => ({}), pushLog: () => {},
    notificationService: { sendDirect: (msg) => { sent.push(msg); return Promise.resolve({ sent: 1 }); } }
  });
  // Der Akku-Wert wird nie wieder gelesen, die anderen Felder schon.
  for (let t = 0; t <= OPTS.holdMs * 2; t += 5000) {
    state.victron.fieldUpdatedAt.gridSetpointW = T0 + t;
    state.victron.fieldUpdatedAt.soc = T0 + t;
    watchdog.tick(T0 + t);
  }
  assert.equal(sent.length, 0);
});

// --- Vorfall 31.10.2026 12:32 (MEZ): Fehlalarm bei „Akku halten“ ------------
//
// Prod A7S, audit_log: setpoint_not_followed 11:32:41 UTC {soc 10, batteryW
// +1196, setpointW −100, netImportW 598} und schon 10:55:25 UTC {soc 10,
// batteryW +337, setpointW 5069, netImportW 5787}. Aktive Steuerquelle in
// beiden Fenstern: eos_grid_hold (EOS „Akku halten“, Tesla lädt ~11 kW, Last
// 12,7 kW, PV 3–16 kW). −100 W ist der Eigenverbrauchs-Boden, wenn die
// Halteregel bei PV > Last auf 0 fällt; 5069 W ist der nachlaufende Live-Bezug.
// Der Victron meldete zugleich die aktive SoC-Grenze 10 % (Reg. 2903 = 100),
// DVhub kannte nur die Mindestgrenze 5 % (Reg. 2901).
const INCIDENT_1031 = [
  { setpointW: -100, netImportW: 598, batteryW: 1196, soc: 10 },
  { setpointW: 5069, netImportW: 5787, batteryW: 337, soc: 10 }
];

function runIncident({ holdSource, socLimitPct = null } = {}) {
  const sent = [];
  const state = {
    meter: { ok: true },
    victron: { gridExportW: 0, minSocPct: 5, ...(socLimitPct != null ? { activeSocLimitPct: socLimitPct } : {}) },
    schedule: { active: {} }
  };
  const watchdog = createSetpointFollowWatchdog({
    state,
    getCfg: () => ({}),
    pushLog: () => {},
    notificationService: { sendDirect: (msg) => { sent.push(msg); return Promise.resolve({ sent: 1 }); } }
  });
  for (let t = 0; t <= OPTS.holdMs * 2; t += 5000) {
    const now = T0 + t;
    const s = INCIDENT_1031[(t / 5000) % 2];
    // Die Auswertung (schedule-eval) frischt den aktiven Eintrag jeden Takt auf.
    state.schedule.active.gridSetpointW = { value: s.setpointW, source: holdSource, at: now };
    Object.assign(state.victron, {
      gridSetpointW: s.setpointW, gridImportW: s.netImportW, batteryPowerW: s.batteryW, soc: s.soc,
      fieldUpdatedAt: { gridSetpointW: now, batteryPowerW: now, soc: now, ...(socLimitPct != null ? { activeSocLimitPct: now } : {}) }
    });
    watchdog.tick(now);
  }
  return sent;
}

test('Vorfall 31.10.: ohne Halte-Signal und ohne SoC-Grenze schlüge der Wächter an (Nachweis des Bildes)', () => {
  const sent = runIncident({ holdSource: 'forecast_optimizer' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].event, 'setpoint_not_followed');
});

test('Vorfall 31.10.: EOS „Akku halten“ (eos_grid_hold) aktiv → kein Alarm', () => {
  assert.deepEqual(runIncident({ holdSource: 'eos_grid_hold' }), []);
});

test('Vorfall 31.10.: aktive SoC-Grenze des Victron (10 %) → kein Alarm, auch ohne Halteregel', () => {
  assert.deepEqual(runIncident({ holdSource: 'default', socLimitPct: 10 }), []);
});

test('Halte-Signal und aktive SoC-Grenze im Messpunkt', () => {
  // Gewolltes Halten (eigene Steuerung) ist wie eine Entlade-Sperre.
  assert.equal(isRefusingDischarge({ ...STUCK, holdReason: 'eos_grid_hold' }, OPTS), false);
  // Aktive SoC-Grenze über der Mindestgrenze: maßgeblich ist die höhere.
  assert.equal(isRefusingDischarge({ ...STUCK, soc: 12, minSocPct: 5, activeSocLimitPct: 10 }, OPTS), false);
  assert.equal(isRefusingDischarge({ ...STUCK, soc: 47, minSocPct: 5, activeSocLimitPct: 45 }, OPTS), false);
  // Echter Fall bleibt: SoC weit über der aktiven Grenze.
  assert.equal(isRefusingDischarge({ ...STUCK, soc: 70, minSocPct: 5, activeSocLimitPct: 10 }, OPTS), true);
  // Eine niedrigere aktive Grenze senkt die Mindestgrenze nicht.
  assert.equal(isRefusingDischarge({ ...STUCK, soc: 12, minSocPct: 10, activeSocLimitPct: 5 }, OPTS), false);
});

test('echter Ausfall wird weiter gemeldet: keine Halteregel, Akku voll über der aktiven SoC-Grenze', () => {
  const sent = [];
  const state = {
    meter: { ok: true },
    victron: { gridSetpointW: -100, gridImportW: 1800, gridExportW: 0, batteryPowerW: 0, soc: 70, minSocPct: 5, activeSocLimitPct: 10 },
    schedule: { active: { gridSetpointW: { value: -100, source: 'default', at: T0 } } }
  };
  const watchdog = createSetpointFollowWatchdog({
    state, getCfg: () => ({}), pushLog: () => {},
    notificationService: { sendDirect: (msg) => { sent.push(msg); return Promise.resolve({ sent: 1 }); } }
  });
  for (let t = 0; t <= OPTS.holdMs; t += 5000) {
    const now = T0 + t;
    state.schedule.active.gridSetpointW.at = now;
    state.victron.fieldUpdatedAt = { gridSetpointW: now, batteryPowerW: now, soc: now, activeSocLimitPct: now };
    watchdog.tick(now);
  }
  assert.equal(sent.length, 1);
  assert.equal(sent[0].event, 'setpoint_not_followed');
});

test('veraltetes Halte-Signal oder veraltete SoC-Grenze entschuldigen nichts', () => {
  const sent = [];
  const state = {
    meter: { ok: true },
    victron: { gridSetpointW: -100, gridImportW: 1800, gridExportW: 0, batteryPowerW: 0, soc: 70, minSocPct: 5, activeSocLimitPct: 80 },
    // Letzte Halteregel liegt Stunden zurück (Auswertung steht) — kein Freibrief.
    schedule: { active: { gridSetpointW: { value: 0, source: 'eos_grid_hold', at: T0 - 3 * 3600000 } } }
  };
  const watchdog = createSetpointFollowWatchdog({
    state, getCfg: () => ({}), pushLog: () => {},
    notificationService: { sendDirect: (msg) => { sent.push(msg); return Promise.resolve({ sent: 1 }); } }
  });
  for (let t = 0; t <= OPTS.holdMs; t += 5000) {
    const now = T0 + t;
    // SoC-Grenze wird nie frisch gelesen (Stempel bleibt alt).
    state.victron.fieldUpdatedAt = { gridSetpointW: now, batteryPowerW: now, soc: now, activeSocLimitPct: T0 - 3600000 };
    watchdog.tick(now);
  }
  assert.equal(sent.length, 1);
});

test('Entlade-Sperre ohne Rücklese-Register: DVhubs eigener Schreibwert 2704 = 0 zählt', () => {
  // Prod-Profil liest 2704 nicht zurück (victron.maxDischargeW bleibt null);
  // ein manuelles / geplantes „Halten“ (maxDischargeW 0) kennt DVhub dann nur
  // aus dem eigenen Schreibvorgang.
  const sent = [];
  const state = {
    meter: { ok: true },
    victron: { gridSetpointW: -100, gridImportW: 1800, gridExportW: 0, batteryPowerW: 0, soc: 70, minSocPct: 5, maxDischargeW: null },
    schedule: { active: {}, lastWrite: { maxDischargeW: { value: 0, source: 'schedule', at: T0 } } }
  };
  const watchdog = createSetpointFollowWatchdog({
    state, getCfg: () => ({}), pushLog: () => {},
    notificationService: { sendDirect: (msg) => { sent.push(msg); return Promise.resolve({ sent: 1 }); } }
  });
  for (let t = 0; t <= OPTS.holdMs * 2; t += 5000) {
    const now = T0 + t;
    state.victron.fieldUpdatedAt = { gridSetpointW: now, batteryPowerW: now, soc: now };
    watchdog.tick(now);
  }
  assert.equal(sent.length, 0);
});
