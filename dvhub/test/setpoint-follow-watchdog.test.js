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
  // Kurze Lücke (30 s, unter maxAgeMs): danach geht es mit derselben Episode weiter.
  feed(state, { fromMs: 301000, toMs: 330000, sample: { ...STUCK, batteryW: null } });
  feed(state, { fromMs: 331000, toMs: 340000, sample: STUCK });
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
  // Das Entwarn-Protokoll trägt den letzten auffälligen Punkt.
  const cleared = logs.find(([event]) => event === 'setpoint_followed_again');
  assert.equal(cleared[1].netImportW, 1800);
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
    // Die Auswertung (schedule-eval) frischt Quelle und Halte-Signal jeden Takt auf.
    state.schedule.active.gridSetpointW = { value: s.setpointW, source: holdSource, at: now };
    state.ctrl = holdSource === 'eos_grid_hold' ? { eosGridHold: { at: now, known: true, valueW: Math.max(0, s.setpointW) } } : {};
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
    schedule: { active: { gridSetpointW: { value: 0, source: 'eos_grid_hold', at: T0 - 3 * 3600000 } } },
    ctrl: { eosGridHold: { at: T0 - 3 * 3600000, known: true, valueW: 0 } }
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

function runReadbackZero({ ownZero }) {
  const sent = [];
  const state = {
    meter: { ok: true },
    victron: { gridSetpointW: -100, gridImportW: 1800, gridExportW: 0, batteryPowerW: 0, soc: 70, minSocPct: 5, maxDischargeW: 0, errors: {} },
    schedule: { active: {}, lastWrite: ownZero ? { maxDischargeW: { value: 0, source: 'api', at: T0 - 3 * 3600000 } } : {} }
  };
  const watchdog = createSetpointFollowWatchdog({
    state, getCfg: () => ({}), pushLog: () => {},
    notificationService: { sendDirect: (msg) => { sent.push(msg); return Promise.resolve({ sent: 1 }); } }
  });
  for (let t = 0; t <= OPTS.holdMs * 2; t += 5000) {
    const now = T0 + t;
    state.victron.fieldUpdatedAt = { gridSetpointW: now, batteryPowerW: now, soc: now, maxDischargeW: now };
    watchdog.tick(now);
  }
  return sent;
}

test('Rücklesung 2704 = 0 mit eigener Sperre → kein Alarm', () => {
  assert.equal(runReadbackZero({ ownZero: true }).length, 0);
});

test('Rücklesung 2704 = 0 ohne eigene Sperre ist mehrdeutig (−1 liest sich als 0) → Alarm bleibt möglich', () => {
  assert.equal(runReadbackZero({ ownZero: false }).length, 1);
});

test('knownDischargeCapW: eigener Schreibwert ohne Rücklesung nur frisch', async () => {
  const { knownDischargeCapW } = await import('../services/setpoint-follow-watchdog.js');
  const state = { victron: { maxDischargeW: null }, schedule: { lastWrite: { maxDischargeW: { value: 0, source: 'api', at: T0 } } } };
  assert.equal(knownDischargeCapW(state, {}, T0 + 60000), 0);
  assert.equal(knownDischargeCapW(state, {}, T0 + 3 * 3600000), null);
});

test('Halte-Signal: Frischegrenze wächst mit einem langsamen Auswertungstakt', async () => {
  const { activeDischargeHold, HOLD_SIGNAL_MAX_AGE_MS } = await import('../services/setpoint-follow-watchdog.js');
  const state = { ctrl: { eosGridHold: { at: T0, known: true, valueW: 0 } } };
  // Standardtakt (15 s): 200 s alt ist zu alt.
  assert.equal(activeDischargeHold(state, T0 + 200000), null);
  assert.equal(activeDischargeHold(state, T0 + HOLD_SIGNAL_MAX_AGE_MS), 'eos_grid_hold');
  // Takt 5 min: der Eintrag ist zwischen zwei Takten bis zu 5 min alt.
  const slow = { schedule: { evaluateMs: 300000 } };
  assert.equal(activeDischargeHold(state, T0 + 200000, slow), 'eos_grid_hold');
  assert.equal(activeDischargeHold(state, T0 + 3 * 300000 + 1000, slow), null);
  // Ohne Halte-Signal kein Halten, auch wenn die letzte Quelle eos_grid_hold hieß.
  const other = { schedule: { active: { gridSetpointW: { value: 0, source: 'eos_grid_hold', at: T0 } } } };
  assert.equal(activeDischargeHold(other, T0), null);
  // Last unbekannt → Eigenverbrauch, kein Halten.
  assert.equal(activeDischargeHold({ ctrl: { eosGridHold: { at: T0, known: false, valueW: 0 } } }, T0), null);
  // Peak Shaving hat den Halte-Wert gedeckelt: der Akku SOLL den Rest liefern.
  const clamped = {
    ctrl: {
      eosGridHold: { at: T0, known: true, valueW: 14700 },
      _peakShaving: { clamp: { requestedW: 14700, valueW: 9700, mode: 'target', source: 'eos_grid_hold', at: T0 } }
    }
  };
  assert.equal(activeDischargeHold(clamped, T0), null);
});

// --- Vorfall 02.11.2026 10:50:24 UTC: Fehlalarm durch kurze Spitzen ---------
//
// Prod A7S (Image netzstrom-test-2), Quelle „default“, evcc schaltet die
// Wallbox mehrfach um: setpoint_not_followed {sinceMs 605267, setpointW −100,
// netImportW 1057, batteryW +4410, soc 42}. 5-min-Mittel 11:30–11:50 MEZ:
// Bezug 29–124 W, Akku lädt — der Wechselrichter folgte im Mittel. Kurze
// Laststöße mit < 2 min Pause hielten suspectSince wach, bis „10 min durchgehend“
// erreicht war.
const SPIKE_0211 = { setpointW: -100, netImportW: 1057, batteryW: 4410, soc: 42, minSocPct: 5 };
const CALM_0211 = { setpointW: -100, netImportW: 40, batteryW: 4300, soc: 42, minSocPct: 5 };

test('Vorfall 02.11.: kurze Spitzen alle 90 s summieren sich nicht zu einem Alarm', () => {
  const state = createSetpointFollowState();
  const transitions = feed(state, {
    toMs: OPTS.holdMs * 3, stepMs: 5000,
    sample: (t) => ((t % 90000) < 20000 ? SPIKE_0211 : CALM_0211)
  });
  assert.deepEqual(transitions, []);
});

test('Fenster: Fehler überwiegt (≥ 80 %), aber der mittlere Netzbezug bleibt unter der Schwelle → kein Alarm', () => {
  const state = createSetpointFollowState();
  const bad = { setpointW: -100, netImportW: 450, batteryW: 0, soc: 60, minSocPct: 5 };
  const export_ = { setpointW: -100, netImportW: -4000, batteryW: -5000, soc: 60, minSocPct: 5 };
  // 85 % auffällig, 15 % kräftige Einspeisung: Mittel ≈ −220 W Bezug.
  const transitions = feed(state, {
    toMs: OPTS.holdMs * 2, stepMs: 5000,
    sample: (t) => ((t % 100000) < 85000 ? bad : export_)
  });
  assert.deepEqual(transitions, []);
});

test('Fenster: echter, nur leicht gestörter Dauerfehler (90 % auffällig) meldet weiter', () => {
  const state = createSetpointFollowState();
  const transitions = feed(state, {
    toMs: OPTS.holdMs + 60000, stepMs: 5000,
    // alle 100 s ein 10-s-Entlade-Zacken — wie ein Regler, der kurz anspringt
    sample: (t) => ((t % 100000) < 10000 && t > 0 ? { ...STUCK, batteryW: -900, netImportW: 900 } : STUCK)
  });
  assert.deepEqual(transitions.map(([name]) => name), ['alarm']);
  assert.ok(transitions[0][1] >= OPTS.holdMs);
});

test('Fenster: nach einer Lücke ohne Messwerte zählt die alte Vorgeschichte nicht', () => {
  const state = createSetpointFollowState();
  feed(state, { toMs: 30000, stepMs: 5000, sample: STUCK });
  // 20 min nicht beurteilbar (z. B. Akku-Wert fehlt) …
  feed(state, { fromMs: 35000, toMs: 35000 + 20 * 60000, stepMs: 5000, sample: { ...STUCK, batteryW: null } });
  // … danach 30 s auffällig: das ist kein 10-min-Bild.
  const start = 40000 + 20 * 60000;
  assert.deepEqual(feed(state, { fromMs: start, toMs: start + 30000, stepMs: 5000, sample: STUCK }), []);
});

test('eigener 2704-Schreibwert ohne Rücklesung zählt nur befristet (Gegenprüfung 415a2f25)', () => {
  // 2704 = 0 über DVhub gesetzt, später an der GX wieder freigegeben; ohne
  // Rücklesung darf der alte Schreibwert echte Alarme nicht ewig stummschalten.
  const sent = [];
  const state = {
    meter: { ok: true },
    victron: { gridSetpointW: -100, gridImportW: 1800, gridExportW: 0, batteryPowerW: 0, soc: 70, minSocPct: 5, maxDischargeW: null },
    schedule: { active: {}, lastWrite: { maxDischargeW: { value: 0, source: 'api', at: T0 - 3 * 3600000 } } }
  };
  const watchdog = createSetpointFollowWatchdog({
    state, getCfg: () => ({}), pushLog: () => {},
    notificationService: { sendDirect: (msg) => { sent.push(msg); return Promise.resolve({ sent: 1 }); } }
  });
  for (let t = 0; t <= OPTS.holdMs + 10000; t += 5000) {
    const now = T0 + t;
    state.victron.fieldUpdatedAt = { gridSetpointW: now, batteryPowerW: now, soc: now };
    watchdog.tick(now);
  }
  assert.equal(sent.length, 1);
});

test('gewolltes Halten während eines Alarms: keine falsche Entwarnung (Gegenprüfung 415a2f25)', () => {
  const state = createSetpointFollowState();
  assert.deepEqual(feed(state, { toMs: OPTS.holdMs, stepMs: 5000, sample: STUCK }).map(([n]) => n), ['alarm']);
  // 10 min „Akku halten“: der Akku steht gewollt — weder Entwarnung noch Erinnerung.
  const from = OPTS.holdMs + 5000;
  assert.deepEqual(feed(state, { fromMs: from, toMs: from + OPTS.holdMs, stepMs: 5000, sample: { ...STUCK, holdReason: 'eos_grid_hold' } }), []);
  assert.equal(state.active, true);
  // Danach entlädt er wirklich wieder → Entwarnung nach clearMs.
  const back = from + OPTS.holdMs + 5000;
  const ok = { ...STUCK, netImportW: -90, batteryW: -1900 };
  assert.deepEqual(feed(state, { fromMs: back, toMs: back + OPTS.clearMs + 5000, stepMs: 5000, sample: ok }).map(([n]) => n), ['clear']);
});

test('tick(): langsamer Auswertungstakt (evaluateMs 300 s) hält das Halte-Signal gültig (Gegenprüfung 97cfa505)', () => {
  const sent = [];
  const state = {
    meter: { ok: true },
    victron: { gridSetpointW: -100, gridImportW: 1800, gridExportW: 0, batteryPowerW: 0, soc: 70, minSocPct: 5 },
    schedule: { active: {} },
    ctrl: {}
  };
  const watchdog = createSetpointFollowWatchdog({
    state, getCfg: () => ({ schedule: { evaluateMs: 300000 } }), pushLog: () => {},
    notificationService: { sendDirect: (msg) => { sent.push(msg); return Promise.resolve({ sent: 1 }); } }
  });
  for (let t = 0; t <= OPTS.holdMs * 2; t += 5000) {
    const now = T0 + t;
    if (t % 300000 === 0) state.ctrl.eosGridHold = { at: now, known: true, valueW: 0 };
    state.victron.fieldUpdatedAt = { gridSetpointW: now, batteryPowerW: now, soc: now };
    watchdog.tick(now);
    // Jeder Punkt ist gewolltes Halten — keiner darf ins Fenster (Gegenprüfung 01f4558b).
    assert.equal(watchdog._state().window.length, 0, `t=${t}`);
  }
  assert.equal(sent.length, 0);
});

// --- Gegenprüfung 39bbcd6e ----------------------------------------------------
const OK_PT = { ...STUCK, netImportW: -90, batteryW: -1900 };

test('Fenster: Alarm erst, wenn die Episode selbst holdMs dauert — nicht nach 8 min dank ok-Vorgeschichte', () => {
  const state = createSetpointFollowState();
  feed(state, { toMs: OPTS.holdMs, stepMs: 5000, sample: OK_PT });
  const S = OPTS.holdMs + 5000;
  // 9:30 min auffällig (z. B. ein Ladeblock), danach wieder ok.
  const transitions = feed(state, {
    fromMs: S, toMs: S + 2 * OPTS.holdMs, stepMs: 5000,
    sample: (t) => (t < S + 570000 ? STUCK : OK_PT)
  });
  assert.deepEqual(transitions, []);
});

test('Fenster: kein Alarm, wenn die Störung im Moment schon vorbei ist', () => {
  const state = createSetpointFollowState();
  // 0–480 s auffällig, danach ok: bei t=600 wären es noch 80 % — aber jetzt folgt er.
  const transitions = feed(state, { toMs: OPTS.holdMs + 60000, stepMs: 5000, sample: (t) => (t <= 480000 ? STUCK : OK_PT) });
  assert.deepEqual(transitions, []);
});

test('„Seit X Minuten“ zählt ab Beginn der Episode, nicht ab einer alten Spitze', () => {
  const state = createSetpointFollowState();
  // 1 h Spitzen-Muster (02.11.), dann echter Dauerfehler.
  feed(state, { toMs: 3600000, stepMs: 5000, sample: (t) => ((t % 90000) < 20000 ? SPIKE_0211 : CALM_0211) });
  const S = 3605000;
  const transitions = feed(state, { fromMs: S, toMs: S + OPTS.holdMs + 30000, stepMs: 5000, sample: STUCK });
  assert.deepEqual(transitions.map(([n]) => n), ['alarm']);
  const [, at] = transitions[0];
  assert.ok((T0 + at) - state.suspectSince <= OPTS.holdMs + 30000, `seit ${(T0 + at - state.suspectSince) / 60000} min`);
});

test('keine Entwarnung, solange der Akku weiter nicht entlädt (Anteil 70 %, Bezug hoch)', () => {
  const state = createSetpointFollowState();
  assert.deepEqual(feed(state, { toMs: OPTS.holdMs, stepMs: 5000, sample: STUCK }).map(([n]) => n), ['alarm']);
  // Danach je 100 s: 70 s 1,8 kW Bezug, 30 s 100 W (unter minImportW) — Akku steht immer.
  const from = OPTS.holdMs + 5000;
  const transitions = feed(state, {
    fromMs: from, toMs: from + 3 * OPTS.holdMs, stepMs: 5000,
    sample: (t) => (((t - from) % 100000) < 70000 ? STUCK : { ...STUCK, netImportW: 100 })
  });
  assert.equal(transitions.some(([n]) => n === 'clear'), false);
  assert.equal(state.active, true);
});

test('Lückengrenze wächst mit langsamem Poll-Takt (meterPollMs 60 s)', () => {
  const opts = { ...OPTS, gapMs: 3 * 61000 };
  const state = createSetpointFollowState();
  const transitions = [];
  for (let t = 0; t <= OPTS.holdMs + 2 * 61000; t += 61000) {
    const { transition } = evaluateSetpointFollow(state, { nowMs: T0 + t, ...STUCK }, opts);
    if (transition) transitions.push(transition);
  }
  assert.deepEqual(transitions, ['alarm']);
});

test('Entwarn-Protokoll trägt die Fensterwerte', () => {
  const logs = [];
  const state = {
    meter: { ok: true },
    victron: { gridSetpointW: -100, gridImportW: 1800, gridExportW: 0, batteryPowerW: 0, soc: 70, minSocPct: 5 }
  };
  const watchdog = createSetpointFollowWatchdog({ state, getCfg: () => ({}), pushLog: (e, d) => logs.push([e, d]) });
  const stamp = (t) => { state.victron.fieldUpdatedAt = { gridSetpointW: t, batteryPowerW: t, soc: t }; };
  for (let t = 0; t <= OPTS.holdMs; t += 5000) { stamp(T0 + t); watchdog.tick(T0 + t); }
  Object.assign(state.victron, { gridImportW: 0, gridExportW: 90, batteryPowerW: -1900 });
  for (let t = OPTS.holdMs + 5000; t <= OPTS.holdMs + OPTS.clearMs + 10000; t += 5000) { stamp(T0 + t); watchdog.tick(T0 + t); }
  const cleared = logs.find(([e]) => e === 'setpoint_followed_again');
  assert.ok(cleared);
  assert.equal(typeof cleared[1].sharePct, 'number');
  assert.equal(typeof cleared[1].avgImportW, 'number');
});

// --- Gegenprüfung ae1cd3d7 ----------------------------------------------------

test('keine Entwarnung bei geringem Bezug, solange der Akku steht (Nacht-Grundlast)', () => {
  const state = createSetpointFollowState();
  feed(state, { toMs: OPTS.holdMs, stepMs: 5000, sample: STUCK });
  assert.equal(state.active, true);
  const from = OPTS.holdMs + 5000;
  const transitions = feed(state, { fromMs: from, toMs: from + OPTS.holdMs, stepMs: 5000, sample: { ...STUCK, netImportW: 200 } });
  assert.deepEqual(transitions, []);
  assert.equal(state.active, true);
});

test('keine Entwarnung über Mittelwerte allein (Wolken: 60 % Bezug, 40 % Einspeisung, Akku steht)', () => {
  const state = createSetpointFollowState();
  feed(state, { toMs: OPTS.holdMs, stepMs: 5000, sample: STUCK });
  const from = OPTS.holdMs + 5000;
  const transitions = feed(state, {
    fromMs: from, toMs: from + 3 * OPTS.holdMs, stepMs: 5000,
    sample: (t) => (((t - from) % 100000) < 60000 ? STUCK : { ...STUCK, netImportW: -3000 })
  });
  assert.equal(transitions.some(([n]) => n === 'clear'), false);
});

test('Entwarnung, wenn der Akku nach dem Alarm wieder lädt bzw. entlädt (echte Erholung)', () => {
  const state = createSetpointFollowState();
  feed(state, { toMs: OPTS.holdMs, stepMs: 5000, sample: STUCK });
  const from = OPTS.holdMs + 5000;
  // Muster 02.11.: Akku lädt aus PV, Bezug ~0, alle 90 s eine kurze Spitze.
  const transitions = feed(state, {
    fromMs: from, toMs: from + 2 * OPTS.holdMs, stepMs: 5000,
    sample: (t) => (((t - from) % 90000) < 20000 ? SPIKE_0211 : CALM_0211)
  });
  assert.deepEqual(transitions.map(([n]) => n), ['clear']);
});

test('eine einzelne Spitze verkürzt die nötige Episode nicht auf 8 min', () => {
  const state = createSetpointFollowState();
  feed(state, { toMs: OPTS.holdMs, stepMs: 5000, sample: OK_PT });
  const t0 = OPTS.holdMs + 5000;
  const transitions = feed(state, {
    fromMs: t0, toMs: t0 + 715000, stepMs: 5000,
    sample: (t) => (t === t0 || t >= t0 + 120000 ? STUCK : OK_PT)
  });
  assert.deepEqual(transitions, [], 'Block ab t0+120 s braucht bis t0+720 s');
});

test('tick(): meterPollMs 60 s — Lückengrenze aus der Konfiguration, Alarm kommt', () => {
  const sent = [];
  const state = {
    meter: { ok: true },
    victron: { gridSetpointW: -100, gridImportW: 1800, gridExportW: 0, batteryPowerW: 0, soc: 70, minSocPct: 5 }
  };
  const watchdog = createSetpointFollowWatchdog({
    state, getCfg: () => ({ meterPollMs: 60000 }), pushLog: () => {},
    notificationService: { sendDirect: (msg) => { sent.push(msg); return Promise.resolve({ sent: 1 }); } }
  });
  for (let t = 0; t <= OPTS.holdMs + 3 * 61000; t += 61000) {
    const now = T0 + t;
    state.victron.fieldUpdatedAt = { gridSetpointW: now, batteryPowerW: now, soc: now };
    watchdog.tick(now);
  }
  assert.equal(sent.length, 1);
});

// --- Gegenprüfung 11f597d3: Entwarntext nur bei echter Entladung -------------
test('Entwarnung nach reinem Laden: neutraler Text, kein „entlädt wieder“', () => {
  const sent = [];
  const state = {
    meter: { ok: true },
    victron: { gridSetpointW: -100, gridImportW: 1800, gridExportW: 0, batteryPowerW: 0, soc: 70, minSocPct: 5 }
  };
  const watchdog = createSetpointFollowWatchdog({
    state, getCfg: () => ({}), pushLog: () => {},
    notificationService: { sendDirect: (msg) => { sent.push(msg); return Promise.resolve({ sent: 1 }); } }
  });
  const stamp = (t) => { state.victron.fieldUpdatedAt = { gridSetpointW: t, batteryPowerW: t, soc: t }; };
  for (let t = 0; t <= OPTS.holdMs; t += 5000) { stamp(T0 + t); watchdog.tick(T0 + t); }
  // Morgens: PV lädt den Akku, kaum Bezug — das zeigt nicht, dass er wieder entlädt.
  Object.assign(state.victron, { gridImportW: 50, gridExportW: 0, batteryPowerW: 2500 });
  for (let t = OPTS.holdMs + 5000; t <= OPTS.holdMs + OPTS.clearMs + 10000; t += 5000) { stamp(T0 + t); watchdog.tick(T0 + t); }
  assert.equal(sent.length, 2);
  assert.equal(sent[1].event, 'setpoint_followed_again');
  assert.doesNotMatch(sent[1].title + sent[1].body, /entlädt wieder|folgt dem Sollwert wieder/);
});

test('Entwarnung über das Fenster: ein alter Entlade-Zacken vor der Erholung zählt nicht als „entlädt wieder“', () => {
  const state = createSetpointFollowState();
  feed(state, { toMs: OPTS.holdMs, stepMs: 5000, sample: STUCK });
  const blip = OPTS.holdMs + 5000;
  feed(state, { fromMs: blip, toMs: blip, sample: { ...STUCK, batteryW: -300, netImportW: 1500 } });
  feed(state, { fromMs: blip + 5000, toMs: blip + 60000, stepMs: 5000, sample: STUCK });
  const R = blip + 65000;
  const charge = { ...STUCK, batteryW: 2500, netImportW: 50 };
  const idle = { ...STUCK, batteryW: 0, netImportW: 100 };
  const transitions = feed(state, {
    fromMs: R, toMs: R + 2 * OPTS.holdMs, stepMs: 5000,
    sample: (t) => (((t - R) % 90000) === 85000 ? idle : charge)
  });
  assert.deepEqual(transitions.map(([n]) => n), ['clear']);
  assert.equal(state.clearedWithDischarge, false);
});
