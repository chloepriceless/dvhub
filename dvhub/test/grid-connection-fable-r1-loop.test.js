// test/grid-connection-fable-r1-loop.test.js — Fable-Prüfung R1 (1.0.10),
// Wächter im GESCHLOSSENEN Regelkreis gegen ein kleines Anlagenmodell:
//   Multi hält den Bezug auf dem (gedeckelten) Netz-Sollwert, mit Regelabweichung
//   (Rauschen ± 100 W, reproduzierbar) und Nachregeln; was eine gekürzte Last
//   abgibt, lädt er zusätzlich in den Akku. Die Wallbox folgt ihrem Deckel mit
//   Totzeit, unter dem Mindeststrom pausiert sie.
//
//   P1-1  Rauschen/Einregeln des Multi um den Sollwert ist kein Akku-Versagen:
//         keine Kürzung der Wallbox, solange der Akku aus dem Netz lädt; eine
//         Kürzung, die nur in den Akku-Ladestrom fließt, beendet „hängt“.
//   P1-2  Gerät ohne Leistungsmeldung schluckt die Kürzung nicht: die nächste
//         Last wird im selben Takt gekürzt.
//   P2-6  Fail-safe stoppt eine Wallbox ohne Leistungsmeldung nicht.
//   P2-8  Heizstab im Eigenbetrieb (DVhub gibt 0 vor) zählt nicht als steuerbar.
//   P3-1  Merker überleben das Zurücksetzen nicht.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveGridConnection, createGuardState, guardStep, createGridConnectionGuard,
  FAILSAFE_TICKS, BATTERY_STUCK_HOLD_MS
} from '../services/grid-connection/index.js';

// Reproduzierbares Rauschen (mulberry32).
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Anlage: Haus, Wallbox (11 kW, 3 × 6 A Mindeststrom, Totzeit 10 s), Multi mit
 * EOS-Sollwert 34,4 kW, gedeckelt auf die Decke des Wächters. Bezug = Sollwert
 * + Regelabweichung (+ Störung), solange der Akku Spielraum hat.
 */
function simulate({ r, seconds = 3600, noiseW = 100, seed = 1, disturb = () => 0, houseW = 2000, wbWantW = 11000, requestW = 34400, maxChargeW = 27000, tickMs = 2000 }) {
  const st = createGuardState();
  const rand = rng(seed);
  const capLog = []; // [t, cap] für die Totzeit
  const minW = 6 * 230 * 3;
  const out = { cuts: 0, paused: false, maxOverMs: 0, overHardMs: 0, events: [], st };
  let overSince = null;
  for (let t = 0; t <= seconds * 1000; t += tickMs) {
    // Wallbox folgt dem Deckel von vor 10 s.
    const old = capLog.filter(([at]) => at <= t - 10_000).at(-1);
    const capOld = old ? old[1] : null;
    const wb = capOld == null ? wbWantW : (capOld < minW ? 0 : Math.min(wbWantW, capOld));
    if (wb === 0) out.paused = true;
    const sp = Math.min(requestW, st.ceilingW ?? r.ceilingTargetW ?? r.targetW);
    const err = (rand() * 2 - 1) * noiseW + disturb(t);
    // Multi: Bezug = Sollwert + Abweichung; Akku lädt den Rest (0 … maxChargeW).
    let charge = sp + err - houseW - wb;
    charge = Math.max(0, Math.min(maxChargeW, charge));
    const total = houseW + wb + charge;
    if (total > r.limitW) { overSince ??= t; out.overHardMs = Math.max(out.overHardMs, t - overSince); } else overSince = null;
    const res = guardStep(st, {
      resolved: r, now: t,
      meas: { fresh: true, reason: null, importW: total, phasesW: null },
      devices: [{ id: 'wallbox', kind: 'wallbox', name: 'Wallbox', currentW: wb, maxW: wbWantW, minW, phases: 3 }],
      battery: { setpointW: sp, chargeW: charge }
    });
    for (const e of res.events) {
      out.events.push({ t, ...e });
      if (e.type === 'cut') out.cuts += 1;
    }
    capLog.push([t, st.caps.wallbox ?? null]);
  }
  out.finalCap = st.caps.wallbox ?? null;
  return out;
}

test('P1-1 Regelkreis: Victron 40 A (27,6 kW), Rauschen ± 100 W, 11-kW-Wallbox → keine Kürzung, nie über der Grenze', () => {
  const r = resolveGridConnection({}, { victronPhaseLimitA: 40 });
  assert.equal(r.targetW, 27600);
  for (const seed of [1, 2, 3, 4, 5]) {
    const s = simulate({ r, seed });
    assert.equal(s.cuts, 0, `Lauf ${seed}: ${s.cuts} Kürzungen (${JSON.stringify(s.events.slice(0, 3))})`);
    assert.equal(s.paused, false, `Lauf ${seed}: Wallbox pausiert`);
    assert.equal(s.overHardMs, 0, `Lauf ${seed}: über der Grenze`);
  }
});

test('P1-1 Regelkreis: Victron 40 A mit fester Regelabweichung +20 W → keine Kürzung', () => {
  const r = resolveGridConnection({}, { victronPhaseLimitA: 40 });
  const s = simulate({ r, noiseW: 0, disturb: () => 20 });
  assert.equal(s.cuts, 0, JSON.stringify(s.events.slice(0, 3)));
  assert.equal(s.overHardMs, 0);
});

test('P1-1 Regelkreis: DVhub 28,6 kW mit 1 kW Abstand, Rauschen ± 100 W, Wallbox-Anlauf 14 s +800 W → keine Kürzung', () => {
  const r = resolveGridConnection({ gridConnection: { limitKw: 28.6 } });
  assert.equal(r.targetW, 27600);
  for (const seed of [1, 2, 3, 4, 5]) {
    const s = simulate({ r, seed, disturb: (t) => (t >= 120_000 && t < 134_000 ? 800 : 0) });
    assert.equal(s.cuts, 0, `Lauf ${seed}: ${s.cuts} Kürzungen (${JSON.stringify(s.events.slice(0, 3))})`);
    assert.equal(s.paused, false, `Lauf ${seed}: Wallbox pausiert`);
  }
});

test('P1-1 Regelkreis: Kürzung, die nur in den Akku fließt, beendet „hängt“ — Wallbox kommt zurück, kein Kürzen bis zur Pause', () => {
  // Der Multi regelt einmal 40 s lang 800 W zu hoch (länger als jede Frist):
  // DVhub kürzt die Wallbox, der Multi lädt die gekürzte Leistung in den Akku.
  const r = resolveGridConnection({ gridConnection: { limitKw: 28.6 } });
  const s = simulate({ r, seconds: 1200, disturb: (t) => (t >= 120_000 && t < 160_000 ? 800 : 0) });
  const follows = s.events.find((e) => e.type === 'battery_follows');
  assert.ok(follows, `Akku folgt erkannt (${JSON.stringify(s.events.slice(0, 4))})`);
  assert.ok(follows.t <= 300_000, `binnen Minuten statt 15 min (${follows.t / 1000} s)`);
  // Vorher (d46a21c3/9fffd671): Dutzende Kürzungen bis zur Pause, frei erst nach ~15 min.
  assert.ok(s.cuts <= 6, `wenige kleine Kürzungen (${s.cuts})`);
  const minCap = Math.min(...s.events.filter((e) => e.type === 'cut').map((e) => e.capW));
  assert.ok(minCap >= 9000, `Wallbox nie tief gekürzt (${minCap})`);
  assert.equal(s.paused, false, 'Wallbox nie pausiert');
  assert.equal(s.finalCap, null, 'Wallbox wieder frei');
  assert.ok(s.events.some((e) => e.type === 'release' && e.t <= 400_000), 'frei binnen Minuten');
});

test('P1-1: ein Akku, der wirklich hängt (Ladung bleibt), wird weiter als hängend behandelt', () => {
  // Haus 10 kW, Wallbox 11 kW, Akku lädt fest 10 kW (Sollwert kommt nicht an).
  const r = resolveGridConnection({ gridConnection: { limitKw: 29 } });
  const st = createGuardState();
  let cap = null;
  for (let t = 0; t <= 600_000; t += 2000) {
    const wb = Math.min(11000, cap ?? Infinity);
    const total = 10000 + 10000 + wb;
    guardStep(st, { resolved: r, now: t, meas: { fresh: true, importW: total, phasesW: null }, devices: [{ id: 'wallbox', kind: 'wallbox', currentW: wb, maxW: 11000, minW: 4140 }], battery: { setpointW: 28000, chargeW: 10000 } });
    cap = st.caps.wallbox ?? null;
  }
  assert.ok(cap != null && cap <= 8000, `Wallbox bleibt gekürzt (${cap})`);
  assert.ok(st.batteryStuckAt != null, 'hängt weiter');
  assert.ok(BATTERY_STUCK_HOLD_MS >= 600_000);
});

// --- P1-2 ------------------------------------------------------------------------

test('P1-2: Fronius, Grenze 14,5 kW, Heizstab 6 kW, Wallbox ohne Messwert → Heizstab im ersten Eingriff gekürzt', () => {
  const r = resolveGridConnection({ manufacturer: 'fronius', gridConnection: { limitKw: 14.5 } });
  assert.equal(r.targetW, 13500);
  const st = createGuardState();
  let heater = 6000;
  let firstHeaterCutAt = null;
  let overHardTicks = 0;
  for (let t = 0; t <= 120_000; t += 2000) {
    const total = 10000 + heater; // Wallbox lädt nicht, meldet aber nichts
    if (total > r.limitW) overHardTicks += 1;
    guardStep(st, {
      resolved: r, now: t,
      meas: { fresh: true, importW: total, phasesW: null },
      devices: [
        { id: 'wallbox', kind: 'wallbox', name: 'Wallbox', currentW: null, maxW: 22080, minW: 4140, phases: 3 },
        { id: 'heater:h1', kind: 'heater', name: 'Heizstab', currentW: heater, maxW: 6000, minW: 0 }
      ],
      battery: {}
    });
    if (st.caps['heater:h1'] != null && firstHeaterCutAt == null) firstHeaterCutAt = t;
    // Heizstab folgt nach einem Takt.
    if (st.caps['heater:h1'] != null) heater = Math.min(heater, st.caps['heater:h1']);
  }
  assert.equal(firstHeaterCutAt, 0, `erster wirksamer Eingriff im ersten Takt (bei ${firstHeaterCutAt} ms)`);
  assert.ok(overHardTicks <= 1, `höchstens ein Takt über der harten Grenze (${overHardTicks})`);
  assert.ok(10000 + heater <= r.targetW, `danach unter dem Ziel (${10000 + heater})`);
});

test('P1-2: gekürzte Leistung eines Geräts ohne Messwert zählt nicht als „unterwegs“', () => {
  const r = resolveGridConnection({ manufacturer: 'fronius', gridConnection: { limitKw: 14.5 } });
  const st = createGuardState();
  const wbUnknown = { id: 'wallbox', kind: 'wallbox', currentW: null, maxW: 22080, minW: 4140, phases: 3 };
  guardStep(st, { resolved: r, now: 0, meas: { fresh: true, importW: 16000, phasesW: null }, devices: [wbUnknown], battery: {} });
  const first = st.caps.wallbox;
  guardStep(st, { resolved: r, now: 2000, meas: { fresh: true, importW: 16000, phasesW: null }, devices: [wbUnknown], battery: {} });
  assert.ok(st.caps.wallbox < first, `nächster Takt kürzt weiter (${first} → ${st.caps.wallbox})`);
});

// --- P2-6 ------------------------------------------------------------------------

test('P2-6: Fail-safe stoppt eine Wallbox ohne Leistungsmeldung nicht', () => {
  const r = resolveGridConnection({ gridConnection: { limitKw: 29 } });
  const st = createGuardState();
  const stale = { fresh: false, reason: 'meter_error', importW: null, phasesW: null };
  const wb = { id: 'wallbox', kind: 'wallbox', currentW: null, maxW: 11000, minW: 4140, phases: 3 };
  for (let i = 0; i < FAILSAFE_TICKS + 1; i += 1) guardStep(st, { resolved: r, now: i * 2000, meas: stale, devices: [wb], battery: {} });
  assert.equal(st.failsafe, true);
  assert.notEqual(st.caps.wallbox, 0, 'kein Stopp');
  assert.equal(st.caps.wallbox ?? null, null, 'ohne Grenze bleibt sie frei');
  assert.ok(st.ceilingW <= 28000 - 1000 - 11000, `Akku-Decke rechnet ihre Höchstleistung ein (${st.ceilingW})`);
  // Mit bestehender Grenze: eingefroren auf der Grenze.
  const st2 = createGuardState();
  st2.caps = { wallbox: 7000 }; st2.capAt = { wallbox: 0 };
  for (let i = 0; i < FAILSAFE_TICKS + 1; i += 1) guardStep(st2, { resolved: r, now: 100_000 + i * 2000, meas: stale, devices: [wb], battery: {} });
  assert.equal(st2.caps.wallbox, 7000);
});

// --- P2-8 ------------------------------------------------------------------------

test('P2-8: Heizstab, dem DVhub 0 W vorgibt (läuft von selbst), schluckt keine Kürzung', () => {
  const t = Date.now();
  const cfg = {
    manufacturer: 'fronius',
    gridConnection: { limitKw: 14.5, order: 'heater_first' },
    devices: [{ id: 'h1', name: 'Heizstab', kind: 'modulating', schedulable: true, plan: { maxPowerW: 6000, intervalS: 5 }, endpoint: { type: 'mypv', host: '192.0.2.5' } }]
  };
  const state = { meter: { ok: true, updatedAt: t, grid_total_w: -16000 }, victron: {}, schedule: {}, ctrl: {} };
  const guard = createGridConnectionGuard({
    getCfg: () => cfg, state, pushLog: () => {},
    mypvRegulator: { getStatus: () => ({ h1: { powerW: 3000, setpointW: 0 } }) },
    eebus: { consumptionDevices: () => [{ id: 'eebus:wp', name: 'Wärmepumpe', powerW: 4000, maxW: 6000 }] },
    p14a: { update: () => {} }
  }, { now: () => t });
  const listed = guard.tick();
  assert.ok(listed, 'Takt lief');
  assert.equal(guard.capW('heater:h1'), null, 'Heizstab nicht „gekürzt“');
  assert.ok(guard.eebusCaps()['eebus:wp'] != null, 'stattdessen die nächste Last');
});

// --- P3-1 ------------------------------------------------------------------------

test('P3-1: Merker (Leistung vor dem Eingriff, Ungehorsam) gehören zum Zustand und gehen mit ihm', () => {
  const st = createGuardState();
  for (const k of ['cutFrom', 'disobey', 'reassertAt']) assert.deepEqual(st[k], {}, k);
  const r = resolveGridConnection({ gridConnection: { limitKw: 29 } });
  const wb = (currentW) => ({ id: 'wallbox', kind: 'wallbox', currentW, maxW: 11000, minW: 4140, phases: 3 });
  guardStep(st, { resolved: r, now: 0, meas: { fresh: true, importW: 31000, phasesW: null }, devices: [wb(11000)], battery: {} });
  assert.ok(st.cutFrom.wallbox > 0);
  // Gerät verschwindet: auch der Merker.
  guardStep(st, { resolved: r, now: 2000, meas: { fresh: true, importW: 20000, phasesW: null }, devices: [], battery: {} });
  assert.equal(st.cutFrom.wallbox, undefined);
  // „aus“ (keine Grenze) setzt alles zurück.
  st.cutFrom.x = 5000;
  st.caps.x = 1000;
  guardStep(st, { resolved: resolveGridConnection({}), now: 4000, meas: { fresh: true, importW: 20000, phasesW: null }, devices: [], battery: {} });
  assert.deepEqual(st.cutFrom, {});
});

// --- Codex 9cbcf92f ----------------------------------------------------------------

test('Codex 9cbcf92f P2: harte Phasen-Überschreitung bei ladendem Akku wird nicht unbegrenzt als „gleich weg“ gezählt', () => {
  const r = resolveGridConnection({}, { victronPhaseLimitA: 40 }); // 9 200 W je Phase, ohne Abstand
  const st = createGuardState();
  for (let t = 0; t <= 30_000; t += 2000) {
    guardStep(st, {
      resolved: r, now: t,
      meas: { fresh: true, importW: 23250, phasesW: [9250, 7000, 7000] },
      devices: [{ id: 'wallbox', kind: 'wallbox', currentW: 11000, maxW: 11000, minW: 4140, phases: 3 }],
      battery: { setpointW: 23100, chargeW: 8000 }
    });
  }
  assert.ok(st.caps.wallbox != null, 'Wallbox gekürzt');
  assert.ok(st.ceilingW <= 23250 - 3 * (9250 - 9100), `Phasen-Decke mit Reserve (${st.ceilingW})`);
});

test('Codex 9cbcf92f P2: Heizstab — gemessene Leistung hinkt dem neuen Sollwert nach, die Kürzung bleibt „unterwegs“', () => {
  const r = resolveGridConnection({ manufacturer: 'fronius', gridConnection: { limitKw: 14.5 } }); // Ziel 13 500 W
  const st = createGuardState();
  const devs = (own, meas) => [
    { id: 'heater:h1', kind: 'heater', currentW: Math.min(own, meas), measuredW: meas, maxW: 6000, minW: 0 },
    { id: 'eebus:wp', kind: 'eebus', currentW: 4000, maxW: 6000, minW: 0 }
  ];
  const order = { ...r, order: ['heater', 'eebus', 'wallbox'] };
  guardStep(st, { resolved: order, now: 0, meas: { fresh: true, importW: 16500, phasesW: null }, devices: devs(6000, 6000), battery: {} });
  assert.equal(st.caps['heater:h1'], 3000);
  // Regler hat 3 000 W gesetzt, die Messung zeigt noch 6 000 W.
  guardStep(st, { resolved: order, now: 2000, meas: { fresh: true, importW: 16500, phasesW: null }, devices: devs(3000, 6000), battery: {} });
  guardStep(st, { resolved: order, now: 4000, meas: { fresh: true, importW: 16500, phasesW: null }, devices: devs(3000, 6000), battery: {} });
  assert.equal(st.caps['heater:h1'], 3000, 'nicht weiter gekürzt');
  assert.equal(st.caps['eebus:wp'] ?? null, null, 'nächste Last nicht gekürzt');
});
