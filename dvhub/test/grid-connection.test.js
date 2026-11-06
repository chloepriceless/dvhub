// test/grid-connection.test.js — Netzanschluss-Wächter (Christin 06.11.2026):
// Einstellungen, Regeltakt (Reihenfolge, Hysterese, Phasen, Fail-safe) und die
// EOS-Ladegrenze als Behelf. Rein, ohne Geräte — der Ende-zu-Ende-Test mit
// echtem Steuerpfad und EOS-Brücke steht in grid-connection-e2e.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveGridConnection, eosGridChargeCapW, createGuardState, guardStep,
  ENTER_TICKS, RELEASE_TICKS, HOLD_AFTER_CUT_MS, FAILSAFE_TICKS
} from '../services/grid-connection/index.js';
import { meterImport, capPositiveSetpoint, smallestLimit, mergeDeviceCaps } from '../services/import-limit/core.js';

const CHRISTIN = { gridConnection: { limitKw: 29 } };

// --- Einstellungen ---------------------------------------------------------------

test('ab Werk aus: ohne Grenze regelt DVhub nicht', () => {
  const r = resolveGridConnection({});
  assert.equal(r.active, false);
  assert.equal(r.reason, 'not_set');
  assert.equal(r.limitW, null);
  assert.equal(resolveGridConnection({ gridConnection: { limitKw: null } }).active, false);
  assert.equal(resolveGridConnection({ gridConnection: { limitKw: '' } }).active, false);
});

test('29 kW: Abstand ab Werk 1 kW (3 % = 870 W < 1 kW), Regelziel 28 kW', () => {
  const r = resolveGridConnection(CHRISTIN);
  assert.equal(r.active, true);
  assert.equal(r.limitW, 29000);
  assert.equal(r.marginW, 1000);
  assert.equal(r.targetW, 28000);
  assert.equal(r.baseLoadW, 1000);
  assert.deepEqual(r.order, ['wallbox', 'heater', 'eebus']);
});

test('100 kW: Abstand ab Werk wächst mit (3 % = 3 kW)', () => {
  const r = resolveGridConnection({ gridConnection: { limitKw: 100 } });
  assert.equal(r.marginW, 3000);
  assert.equal(r.targetW, 97000);
});

test('eigener Abstand gilt, höchstens die halbe Grenze', () => {
  assert.equal(resolveGridConnection({ gridConnection: { limitKw: 29, marginW: 500 } }).targetW, 28500);
  assert.equal(resolveGridConnection({ gridConnection: { limitKw: 4, marginW: 9000 } }).marginW, 2000);
});

test('Tippfehler (W statt kW, unter 2 kW, über 2 MW) regelt nicht und sagt es', () => {
  assert.equal(resolveGridConnection({ gridConnection: { limitKw: 1.5 } }).reason, 'limit_invalid');
  assert.equal(resolveGridConnection({ gridConnection: { limitKw: 29000 } }).reason, 'limit_invalid');
  assert.equal(resolveGridConnection({ gridConnection: { limitKw: 29000 } }).active, false);
});

test('Phasengrenze 40 A → 9 200 W je Phase, Abstand ein Drittel (333 W)', () => {
  const r = resolveGridConnection({ gridConnection: { limitKw: 29, phaseLimitA: 40 } });
  assert.equal(r.phaseLimitW, 9200);
  assert.equal(r.phaseMarginW, 333);
  assert.equal(r.phaseTargetW, 8867);
});

test('kein Beta: wirkt auch im stabilen Kanal', () => {
  const r = resolveGridConnection({ updateChannel: 'stable', ...CHRISTIN });
  assert.equal(r.active, true);
});

test('Akku-Hebel nur bei Victron (positiver Sollwert = Bezug am Zähler)', () => {
  assert.equal(resolveGridConnection(CHRISTIN).batterySupported, true);
  assert.equal(resolveGridConnection({ ...CHRISTIN, manufacturer: 'fronius' }).batterySupported, false);
});

// --- EOS-Behelf ------------------------------------------------------------------

test('EOS-Ladegrenze aus dem Netz: Grenze − Abstand − Grundlast − E-Auto (Christins Prod)', () => {
  // 29 000 − 1 000 − 1 000 − 11 000 = 16 000 W
  const cfg = { ...CHRISTIN, optimizer: { maxChargeW: 27000, eosOptimizeEv: true, evMaxChargeW: 11000 } };
  assert.equal(eosGridChargeCapW(cfg), 16000);
});

test('EOS-Ladegrenze ohne eingeplantes E-Auto: Grenze − Abstand − Grundlast', () => {
  assert.equal(eosGridChargeCapW({ ...CHRISTIN, optimizer: { eosOptimizeEv: false, evMaxChargeW: 11000 } }), 27000);
});

test('EOS-Ladegrenze ohne Netzanschluss-Grenze: null (keine Änderung)', () => {
  assert.equal(eosGridChargeCapW({ optimizer: { maxChargeW: 27000 } }), null);
});

test('EOS-Ladegrenze nie negativ', () => {
  assert.equal(eosGridChargeCapW({ gridConnection: { limitKw: 10 }, optimizer: { eosOptimizeEv: true, evMaxChargeW: 11000 } }), 0);
});

// --- gemeinsamer Kern ------------------------------------------------------------

test('meterImport: Bezug positiv, egal wie der Zähler zählt', () => {
  const now = 1_000_000;
  const meter = { ok: true, updatedAt: now - 1000, grid_total_w: -5000, grid_l1_w: -2000, grid_l2_w: -2000, grid_l3_w: -1000 };
  const feedIn = meterImport({ meter }, { gridPositiveMeans: 'feed_in' }, { now, maxAgeMs: 90000 });
  assert.equal(feedIn.importW, 5000);
  assert.deepEqual(feedIn.phasesW, [2000, 2000, 1000]);
  const imp = meterImport({ meter: { ...meter, grid_total_w: 5000, grid_l1_w: 2000, grid_l2_w: 2000, grid_l3_w: 1000 } }, { gridPositiveMeans: 'grid_import' }, { now, maxAgeMs: 90000 });
  assert.equal(imp.importW, 5000);
});

test('meterImport: Fehler und Alter > 90 s sind nicht frisch', () => {
  const now = 1_000_000;
  assert.equal(meterImport({ meter: { ok: false, updatedAt: now, grid_total_w: 1 } }, {}, { now, maxAgeMs: 90000 }).reason, 'meter_error');
  assert.equal(meterImport({ meter: { ok: true, updatedAt: now - 91000, grid_total_w: 1 } }, {}, { now, maxAgeMs: 90000 }).reason, 'meter_stale');
  assert.equal(meterImport({ meter: { ok: true, updatedAt: now - 1000, grid_total_w: 1, grid_l1_w: null } }, {}, { now, maxAgeMs: 90000 }).phasesW, null);
});

test('capPositiveSetpoint senkt nur positive Werte über der Decke, nie unter 0', () => {
  assert.deepEqual(capPositiveSetpoint(34400, 28000), { value: 28000, clamped: true });
  assert.deepEqual(capPositiveSetpoint(20000, 28000), { value: 20000, clamped: false });
  assert.deepEqual(capPositiveSetpoint(-5000, 0), { value: -5000, clamped: false });
  assert.deepEqual(capPositiveSetpoint(3000, -200), { value: 0, clamped: true });
  assert.deepEqual(capPositiveSetpoint(3000, null), { value: 3000, clamped: false });
});

test('kleinste gilt: smallestLimit und mergeDeviceCaps', () => {
  assert.equal(smallestLimit([null, 5000, 4200, undefined]), 4200);
  assert.equal(smallestLimit({ a: null }), null);
  assert.deepEqual(mergeDeviceCaps({ 'eebus:1': 4200, 'eebus:2': null }, { 'eebus:1': 3000, 'eebus:3': 0 }),
    { 'eebus:1': 3000, 'eebus:2': null, 'eebus:3': 0 });
});

// --- Regeltakt -------------------------------------------------------------------

const R = resolveGridConnection(CHRISTIN); // Ziel 28 000 W, Grenze 29 000 W
const fresh = (importW, phasesW = null) => ({ fresh: true, reason: null, importW, phasesW });
const wallbox = (currentW) => ({ id: 'wallbox', kind: 'wallbox', name: 'Wallbox', currentW, maxW: 11000, minW: 4140 });
const heater = (currentW) => ({ id: 'heater:h1', kind: 'heater', name: 'Heizstab', currentW, maxW: 3000, minW: 0 });

function run(st, n, args, t0, stepMs = 2000) {
  let res;
  for (let i = 0; i < n; i += 1) res = guardStep(st, { resolved: R, now: t0 + i * stepMs, ...args });
  return res;
}

test('Akku zuerst: Decke = Regelziel; lädt der Akku, kürzt DVhub keine Wallbox', () => {
  // Sollwert 28 kW gedeckelt, Bezug kurz 29,5 kW (Multi regelt noch), Akku lädt 15 kW:
  // der Multi senkt seine Ladung — die Wallbox bleibt.
  const st = createGuardState();
  const res = run(st, 5, { meas: fresh(29500), devices: [wallbox(11000)], battery: { setpointW: 28000, chargeW: 15000 } }, 0);
  assert.equal(st.ceilingW, 28000);
  assert.equal(st.caps.wallbox, undefined);
  assert.equal(res.events.length, 0);
});

test('Akku lädt nicht (mehr): nach zwei Takten über dem Ziel wird die Wallbox gekürzt', () => {
  // Bezug 29 000 W, Ziel 28 000 W → 1 000 W zu viel → Wallbox 11 000 → 10 000 W.
  const st = createGuardState();
  const args = { meas: fresh(29000), devices: [wallbox(11000), heater(2000)], battery: { setpointW: 28000, chargeW: 0 } };
  const first = guardStep(st, { resolved: R, now: 0, ...args });
  assert.equal(first.events.length, 0, 'ein Takt reicht nicht (Entprellung)');
  assert.equal(ENTER_TICKS, 2);
  const second = guardStep(st, { resolved: R, now: 2000, ...args });
  assert.equal(st.caps.wallbox, 10000);
  assert.equal(st.caps['heater:h1'], undefined, 'Heizstab erst nach der Wallbox');
  assert.ok(second.changed.has('wallbox'));
  assert.equal(second.events[0].type, 'cut');
});

test('über der harten Grenze: sofort kürzen, ohne Entprellung', () => {
  const st = createGuardState();
  guardStep(st, { resolved: R, now: 0, meas: fresh(31000), devices: [wallbox(11000)], battery: {} });
  assert.equal(st.caps.wallbox, 8000);
});

test('unter dem Mindeststrom: Wallbox pausiert, dann der Heizstab', () => {
  // 7 000 W zu viel: Wallbox 11 000 − 7 000 = 4 000 < 4 140 → Pause (0), Rest 4 000 W gedeckt.
  const st = createGuardState();
  run(st, 2, { meas: fresh(35000), devices: [wallbox(11000), heater(2000)], battery: {} }, 0);
  assert.equal(st.caps.wallbox, 0);
  assert.equal(st.caps['heater:h1'], undefined);
  // Danach reicht die Pause nicht (Herd): 2 000 W zu viel, Wallbox steht → Heizstab aus.
  run(st, 2, { meas: fresh(30000), devices: [wallbox(0), heater(2000)], battery: {} }, 30_000);
  assert.equal(st.caps['heater:h1'], 0);
});

test('Befehl unterwegs: kein zweites Kürzen, solange die Wallbox herunterregelt', () => {
  const st = createGuardState();
  run(st, 2, { meas: fresh(30000), devices: [wallbox(11000)], battery: {} }, 0);
  assert.equal(st.caps.wallbox, 9000);
  // Wallbox zieht noch 11 kW (Rampe), Bezug weiter 30 kW: erwartet 30 − 2 = 28 kW → nichts tun.
  run(st, 4, { meas: fresh(30000), devices: [wallbox(11000)], battery: {} }, 4000);
  assert.equal(st.caps.wallbox, 9000);
});

test('nichts mehr steuerbar: Meldung „exhausted“ (Herd kann DVhub nicht abschalten)', () => {
  const st = createGuardState();
  const res = guardStep(st, { resolved: R, now: 0, meas: fresh(33000), devices: [wallbox(0)], battery: {} });
  assert.equal(res.events.at(-1).type, 'exhausted');
  assert.equal(res.events.at(-1).restW, 5000);
  assert.equal(guardStep(st, { resolved: R, now: 2000, meas: fresh(33000), devices: [wallbox(0)], battery: {} }).events.length, 0, 'nur einmal melden');
});

test('Freigabe: erst nach 30 s Luft (Rückschalt-Abstand) und 60 s nach dem Eingriff, ohne Pendeln', () => {
  const st = createGuardState();
  run(st, 2, { meas: fresh(35000), devices: [wallbox(11000), heater(2000)], battery: {} }, 0);
  assert.equal(st.caps.wallbox, 0);
  const cutAt = st.lastCutAt;
  // Herd aus: Bezug 18 kW → 10 kW Luft. Vor Ablauf der Haltezeit keine Freigabe.
  run(st, RELEASE_TICKS + 5, { meas: fresh(18000), devices: [wallbox(0), heater(2000)], battery: {} }, cutAt + 2000);
  assert.ok(cutAt + 2000 + (RELEASE_TICKS + 4) * 2000 < cutAt + HOLD_AFTER_CUT_MS);
  assert.equal(st.caps.wallbox, 0, 'Haltezeit nach dem Eingriff');
  // Luft nur knapp unter dem Rückschalt-Abstand: keine Freigabe, egal wie lange.
  run(st, 60, { meas: fresh(27200), devices: [wallbox(0), heater(2000)], battery: {} }, cutAt + HOLD_AFTER_CUT_MS);
  assert.equal(st.caps.wallbox, 0, 'Luft 800 W < 1 000 W Rückschalt-Abstand');
  // Genug Luft (10 kW − 1 kW = 9 kW ≥ Mindestleistung): Wallbox frei bis 9 kW.
  const res = run(st, RELEASE_TICKS, { meas: fresh(18000), devices: [wallbox(0), heater(2000)], battery: {} }, cutAt + 300_000);
  assert.equal(st.caps.wallbox, 9000);
  assert.equal(res.events.at(-1).type, 'raise');
});

test('Freigabe in umgekehrter Reihenfolge: zuletzt gekürzt, zuerst wieder frei; ein Gerät je Schritt', () => {
  const st = createGuardState();
  st.caps = { wallbox: 0, 'heater:h1': 0 };
  st.capAt = { wallbox: 0, 'heater:h1': 0 };
  const devices = [wallbox(0), heater(0)];
  run(st, RELEASE_TICKS, { meas: fresh(10000), devices, battery: {} }, HOLD_AFTER_CUT_MS);
  assert.equal(st.caps['heater:h1'], undefined, 'Heizstab (in der Reihenfolge später) zuerst frei');
  assert.equal(st.caps.wallbox, 0, 'Wallbox im selben Schritt noch nicht');
  run(st, RELEASE_TICKS, { meas: fresh(10000), devices, battery: {} }, HOLD_AFTER_CUT_MS + 60_000);
  assert.equal(st.caps.wallbox, undefined, 'dann die Wallbox, ganz frei (Luft ≥ 11 kW)');
});

test('Freigabe zählt die Akku-Netzladung als Luft — der Akku gibt zuerst nach', () => {
  // Sollwert 28 kW, Akku lädt 20 kW, Bezug 28 kW: ohne diese Regel bliebe die
  // Wallbox gesperrt, solange der Akku lädt (falsche Reihenfolge).
  const st = createGuardState();
  st.caps = { wallbox: 0 };
  st.capAt = { wallbox: 0 };
  run(st, RELEASE_TICKS, { meas: fresh(28000), devices: [wallbox(0)], battery: { setpointW: 28000, chargeW: 20000 } }, HOLD_AFTER_CUT_MS);
  assert.equal(st.caps.wallbox, undefined);
});

// --- Phasen ----------------------------------------------------------------------

const RP = resolveGridConnection({ gridConnection: { limitKw: 29, phaseLimitA: 40 } }); // Phase: Grenze 9 200, Ziel 8 867 W

test('Phase: stärkste Phase über ihrer Grenze → Akku-Decke sinkt um das Dreifache', () => {
  // L1 9 500, L2/L3 7 000 → gesamt 23 500 < 28 000, aber L1 633 W über dem Phasenziel.
  // Decke = 23 500 − 3 × 633 = 21 601 → abgerundet 21 600 W.
  const st = createGuardState();
  guardStep(st, { resolved: RP, now: 0, meas: fresh(23500, [9500, 7000, 7000]), devices: [], battery: { setpointW: 23500, chargeW: 10000 } });
  assert.equal(st.ceilingW, 21600);
});

test('Phase: ohne Akku-Ladung kürzt DVhub die Wallbox (dreiphasig, 3 × Überschuss)', () => {
  // L1 9 300 W (Herd auf L1) liegt über der Phasengrenze 9 200 W → sofort:
  // 3 × (9 300 − 8 867) = 1 299 W kürzen → Wallbox 11 000 → 9 700 W.
  const st = createGuardState();
  const meas = fresh(23000, [9300, 6850, 6850]);
  run(st, 2, { resolved: RP, meas, devices: [wallbox(11000)], battery: {} }, 0);
  assert.equal(st.caps.wallbox, 9700);
});

test('Phase: Gesamt unter der Grenze, Phasen fehlen → Meldung, Regelung auf die Gesamtgrenze', () => {
  const st = createGuardState();
  const res = guardStep(st, { resolved: RP, now: 0, meas: fresh(20000, null), devices: [], battery: {} });
  assert.equal(res.events[0].type, 'phases_missing');
  assert.equal(st.ceilingW, 28000);
});

// --- Fail-safe -------------------------------------------------------------------

test('Fail-safe: Zähler gestört → keine neue Last, Akku-Decke = Ziel − Grundlast − laufende Geräte', () => {
  const st = createGuardState();
  const stale = { fresh: false, reason: 'meter_error', importW: null, phasesW: null };
  const devices = [wallbox(11000), heater(0)];
  const first = guardStep(st, { resolved: R, now: 0, meas: stale, devices, battery: {} });
  assert.equal(first.events.length, 0, 'ein einzelner Lesefehler ist noch kein Fail-safe');
  assert.equal(FAILSAFE_TICKS, 2);
  const res = guardStep(st, { resolved: R, now: 2000, meas: stale, devices, battery: {} });
  assert.equal(st.failsafe, true);
  assert.equal(res.events[0].type, 'failsafe_on');
  assert.equal(st.caps.wallbox, 11000, 'Wallbox darf nicht mehr als jetzt');
  assert.equal(st.caps['heater:h1'], 0, 'Heizstab darf nicht anlaufen');
  // 28 000 − 1 000 − 11 000 − 0 = 16 000 W
  assert.equal(st.ceilingW, 16000);
  // Im Fail-safe nie Freigabe, egal wie lange.
  run(st, 100, { meas: stale, devices, battery: {} }, 10_000);
  assert.equal(st.caps['heater:h1'], 0);
  // Zähler zurück: Fail-safe endet, Grenzen gehen über die normale Freigabe weg.
  const back = guardStep(st, { resolved: R, now: 500_000, meas: fresh(12000), devices, battery: {} });
  assert.equal(back.events[0].type, 'failsafe_off');
  assert.equal(st.failsafe, false);
});

test('Grenze gelöscht: alle Begrenzungen fallen weg', () => {
  const st = createGuardState();
  run(st, 2, { meas: fresh(35000), devices: [wallbox(11000)], battery: {} }, 0);
  const res = guardStep(st, { resolved: resolveGridConnection({}), now: 10_000, meas: null, devices: [], battery: {} });
  assert.deepEqual(st.caps, {});
  assert.equal(st.ceilingW, null);
  assert.ok(res.changed.has('wallbox'));
});

test('nach dem Fail-safe: Akku-Decke kehrt ganz aufs Regelziel zurück (nicht Ziel − Rückschalt-Abstand)', () => {
  const st = createGuardState();
  const stale = { fresh: false, reason: 'meter_error', importW: null, phasesW: null };
  run(st, FAILSAFE_TICKS, { meas: stale, devices: [wallbox(11000)], battery: {} }, 0);
  assert.equal(st.ceilingW, 16000);
  run(st, RELEASE_TICKS * 3, { meas: fresh(15000), devices: [wallbox(11000)], battery: {} }, 10_000);
  assert.equal(st.ceilingW, 28000);
});

test('Codex P1: Akku senkt seine Ladung nicht (Multi hängt) → nach 10 s zählt sie nicht mehr, Wallbox wird gekürzt', () => {
  // 31 kW gemessen, Sollwert 28 kW, Akku lädt weiter 10 kW: die erwartete
  // Lademinderung darf das Kürzen nicht dauerhaft verhindern.
  const st = createGuardState();
  const args = { meas: fresh(31000), devices: [wallbox(11000)], battery: { setpointW: 28000, chargeW: 10000 } };
  run(st, 3, args, 0);
  assert.equal(st.caps.wallbox, undefined, 'zuerst dem Multi Zeit lassen');
  run(st, 10, args, 6000);
  assert.ok(st.caps.wallbox != null && st.caps.wallbox <= 8000, `Wallbox gekürzt (${st.caps.wallbox})`);
});

test('Codex P1 (Runde 2): hängender Akku zählt auch bei der Freigabe nicht als Luft — kein Pendeln', () => {
  // Haus 10 kW, Akku hängt bei 10 kW Ladung, Wallbox 11 kW → 31 kW.
  // Nach dem Kürzen 28 kW = Sollwert — das ist KEIN Beleg, dass der Akku folgt.
  const st = createGuardState();
  const wb = 11000;
  const tick = (now) => {
    const total = 10000 + 10000 + Math.min(wb, st.caps.wallbox ?? Infinity);
    guardStep(st, { resolved: R, now, meas: fresh(total), devices: [wallbox(Math.min(wb, st.caps.wallbox ?? Infinity))], battery: { setpointW: 28000, chargeW: 10000 } });
    return total;
  };
  let maxAfterCut = 0;
  for (let t = 0; t <= 600_000; t += 2000) {
    const total = tick(t);
    if (st.caps.wallbox != null && t > 30_000) maxAfterCut = Math.max(maxAfterCut, total);
  }
  assert.ok(st.caps.wallbox != null && st.caps.wallbox <= 8000, `Wallbox bleibt gekürzt (${st.caps.wallbox})`);
  assert.ok(maxAfterCut <= 28000, `kein Rückfall über das Ziel (${maxAfterCut})`);
});

test('Codex P2 (Runde 2): Multi regelt 50 W über dem Sollwert ein — kein schleichendes Kürzen der Wallbox', () => {
  const st = createGuardState();
  for (let t = 0; t <= 300_000; t += 2000) {
    guardStep(st, { resolved: R, now: t, meas: fresh(28050), devices: [wallbox(11000)], battery: { setpointW: 28000, chargeW: 8000 } });
  }
  assert.equal(st.caps.wallbox, undefined);
});

test('Codex P2 (Runde 3): kleiner Abstand — über der harten Grenze gilt die Akku-Frist auch innerhalb der Einregel-Toleranz', () => {
  const r = resolveGridConnection({ gridConnection: { limitKw: 29, marginW: 100 } }); // Ziel 28 900 W
  const st = createGuardState();
  for (let t = 0; t <= 30_000; t += 2000) {
    guardStep(st, { resolved: r, now: t, meas: fresh(29200), devices: [wallbox(11000)], battery: { setpointW: 28900, chargeW: 8000 } });
  }
  assert.ok(st.caps.wallbox != null, 'Wallbox gekürzt');
});

test('Gesamtprüfung P2: kleine Absenkung der Akku-Decke (unter dem Rückschalt-Abstand) erholt sich wieder', () => {
  const st = createGuardState();
  st.ceilingW = 27500; // kurz durch eine Phase gesenkt
  run(st, RELEASE_TICKS + 2, { meas: fresh(15000), devices: [], battery: {} }, 0);
  assert.equal(st.ceilingW, 28000);
});
