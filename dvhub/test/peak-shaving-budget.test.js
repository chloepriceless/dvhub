// test/peak-shaving-budget.test.js — Peak Shaving P1 (Christin 24.11.2026): Viertelstunden-Budget.
//
// RLM rechnet auf den 15-min-Mittelwert. DVhub zählt je Viertelstunde die bezogene Energie, rechnet bis zum Ende
// hoch und greift erst ein, wenn die Hochrechnung das Budget (Grenze − Abstand) × 15 min reißen würde — dann mit
// der nötigen Restleistung. Kann der Akku nicht sicher liefern, gilt sofort der Augenblickswert (wie bisher).
//
// Zahlen: Grenze 10 000 W, Abstand 300 W → Augenblicks-Ziel 9 700 W, Budget-Ziel 9 700 W × 900 s = 8 730 000 Ws.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  quarterHourSlot, createBudgetState, observeBudget, decideBudget, SLOT_MS, BUDGET_MAX_GAP_MS
} from '../services/peak-shaving/budget.js';
import { budgetBatteryInput } from '../services/peak-shaving/index.js';

const LIMIT = 10000;
const MARGIN = 300;
const T = LIMIT - MARGIN;
const TZ = 'Europe/Berlin';
// Akku: 50 % (Boden 5 %), entlädt gerade nicht, 10 kW Entladeleistung eingetragen.
const BAT = { socOk: true, socReason: null, soc: 50, floorPct: 5, dischargeW: 0, maxDischargeW: 10000, capacityWh: null };
// 24.11.2026 10:00 MEZ = 09:00 UTC (Viertelstundenanfang).
const SLOT0 = Date.parse('2026-11-24T09:00:00Z');

function run(st, { from, to, stepMs = 2000, load, cap = null, mono0 = 0, wall0 = SLOT0 }) {
  // Simuliert Zählerabfragen von `from` bis `to` (ms ab wall0). load(tMs) = Bedarf; mit cap(dec) folgt der Bezug
  // der Vorgabe (Akku deckt den Rest) — wie der Steuerpfad es täte.
  let lastDec = null;
  let trueWs = 0;
  for (let t = from; t <= to; t += stepMs) {
    const want = load(t);
    const importW = cap && lastDec ? Math.min(want, lastDec.targetW) : want;
    if (t > from) trueWs += importW * stepMs / 1000;
    observeBudget(st, { wallMs: wall0 + t, monoMs: mono0 + t, importW, limitW: LIMIT, timeZone: TZ });
    lastDec = decideBudget(st, { enabled: true, wallMs: wall0 + t, limitW: LIMIT, marginW: MARGIN, targetW: T, importW, battery: BAT });
  }
  return { dec: lastDec, trueWs };
}

// --- Viertelstunden ---------------------------------------------------------------

test('quarterHourSlot: ganzzahlig :00/:15/:30/:45 in Ortszeit', () => {
  const s = quarterHourSlot(Date.parse('2026-11-24T09:07:31Z'), TZ);
  assert.equal(new Date(s.startMs).toISOString(), '2026-11-24T09:00:00.000Z');
  assert.equal(s.endMs - s.startMs, SLOT_MS);
  // Zeitzone mit halber Stunde (Indien +05:30): 10:40 Ortszeit → 10:30
  const i = quarterHourSlot(Date.parse('2026-11-24T05:10:00Z'), 'Asia/Kolkata');
  assert.equal(new Date(i.startMs).toISOString(), '2026-11-24T05:00:00.000Z');
});

test('Zeitumstellung: jede Viertelstunde 15 min, die doppelte Stunde im Oktober bekommt eigene Viertelstunden', () => {
  // 25.10.2026: 03:00 MESZ → 02:00 MEZ (01:00 UTC). 02:15 MESZ (00:15 UTC) und 02:15 MEZ (01:15 UTC) sind zwei Slots.
  const a = quarterHourSlot(Date.parse('2026-10-25T00:20:00Z'), TZ);
  const b = quarterHourSlot(Date.parse('2026-10-25T01:20:00Z'), TZ);
  assert.equal(new Date(a.startMs).toISOString(), '2026-10-25T00:15:00.000Z');
  assert.equal(new Date(b.startMs).toISOString(), '2026-10-25T01:15:00.000Z');
  for (let t = Date.parse('2026-10-24T23:00:00Z'); t < Date.parse('2026-10-25T03:00:00Z'); t += 60_000) {
    const s = quarterHourSlot(t, TZ);
    assert.equal(s.endMs - s.startMs, SLOT_MS);
    assert.ok(t >= s.startMs && t < s.endMs);
  }
  // 29.03.2026: 02:00 MEZ → 03:00 MESZ (01:00 UTC): 01:59 MEZ und 03:00 MESZ liegen in benachbarten Slots.
  const c = quarterHourSlot(Date.parse('2026-03-29T00:59:00Z'), TZ);
  const d = quarterHourSlot(Date.parse('2026-03-29T01:00:00Z'), TZ);
  assert.equal(d.startMs, c.endMs);
});

// --- Kern: kurze Spitze vs. Dauerspitze ----------------------------------------------

test('kurze Spitze nach ruhiger Zeit: kein Eingriff (Hochrechnung bleibt unter dem Budget)', () => {
  // 10 min 5 kW = 3 000 000 Ws. Danach 14 kW. Erlaubt = (8 730 000 − 3 000 000) / 300 s = 19 100 W,
  // begrenzt auf Ziel + Akku-Reserve (9 700 + 10 000 − 0 − 1 000 = 18 700 W). 14 kW < 18,7 kW → kein Eingriff.
  const st = createBudgetState();
  run(st, { from: 0, to: 600_000, load: () => 5000 });
  const { dec } = run(st, { from: 602_000, to: 720_000, load: () => 14000, mono0: 0 });
  assert.equal(dec.mode, 'budget');
  assert.equal(dec.intervening, false, JSON.stringify(dec));
  assert.ok(dec.targetW > 14000, `Ziel ${dec.targetW}`);
});

test('Dauerspitze ab Anfang: Eingriff sofort, und die Viertelstunde bleibt im Mittel unter Grenze − Abstand', () => {
  const st = createBudgetState();
  const first = run(st, { from: 0, to: 4000, load: () => 14000 });
  assert.equal(first.dec.mode, 'budget');
  assert.equal(first.dec.intervening, true);
  assert.ok(first.dec.targetW <= T, `Ziel ${first.dec.targetW} ≤ ${T}`);
  const st2 = createBudgetState();
  const { trueWs } = run(st2, { from: 0, to: SLOT_MS - 2000, load: () => 14000, cap: true });
  const avgW = trueWs / (SLOT_MS / 1000);
  assert.ok(avgW <= T, `Mittel ${Math.round(avgW)} W ≤ ${T} W`);
});

test('Spitze spät in der Viertelstunde: Eingriff rechtzeitig, Mittel bleibt unter dem Ziel', () => {
  // 10 min 5 kW, dann 18 kW Bedarf bis zum Ende. Mit Eingriff (Bezug folgt der Vorgabe) bleibt das Mittel ≤ 9 700 W.
  const st = createBudgetState();
  const load = (t) => (t < 600_000 ? 5000 : 18000);
  const { trueWs, dec } = run(st, { from: 0, to: SLOT_MS - 2000, load, cap: true });
  const avgW = trueWs / (SLOT_MS / 1000);
  assert.ok(avgW <= T, `Mittel ${Math.round(avgW)} W ≤ ${T} W`);
  // Am Ende der Viertelstunde (Rest < 60 s) gilt der Augenblickswert.
  assert.equal(dec.mode, 'instant');
  assert.equal(dec.reason, 'slot_ending');
  // Ohne Eingriff wäre das Mittel darüber: 5 000 × 600 + 18 000 × 300 = 8 400 000 Ws / 900 s = 9 333 W …
  // … das passt noch — deshalb 20 kW: 5 000 × 600 + 20 000 × 300 = 9 000 000 Ws → 10 000 W > 9 700 W.
  const st2 = createBudgetState();
  const uncapped = run(st2, { from: 0, to: SLOT_MS - 2000, load: (t) => (t < 600_000 ? 5000 : 20000) });
  assert.ok(uncapped.trueWs / 900 > T);
  const st3 = createBudgetState();
  const capped = run(st3, { from: 0, to: SLOT_MS - 2000, load: (t) => (t < 600_000 ? 5000 : 20000), cap: true });
  assert.ok(capped.trueWs / 900 <= T, `mit Eingriff ${Math.round(capped.trueWs / 900)} W`);
});

// --- Harte Absicherung: Rückfall auf den Augenblickswert --------------------------------

function midSlot(extra = {}) {
  const st = createBudgetState();
  run(st, { from: 0, to: 300_000, load: () => 5000 });
  return decideBudget(st, {
    enabled: true, wallMs: SLOT0 + 300_000, limitW: LIMIT, marginW: MARGIN, targetW: T, importW: 12000,
    battery: BAT, ...extra
  });
}

test('Akku nahe am Boden / leer / unbekannt: sofort Augenblickswert (Ziel = Grenze − Abstand)', () => {
  for (const [battery, reason] of [
    [{ ...BAT, soc: 8 }, 'soc_near_floor'],
    [{ ...BAT, socOk: false, socReason: 'soc_floor', soc: 5 }, 'soc_floor'],
    [{ ...BAT, socOk: false, socReason: 'soc_unknown', soc: null }, 'soc_unknown'],
    [{ ...BAT, maxDischargeW: null }, 'discharge_unknown'],
    [{ ...BAT, dischargeW: 9000 }, 'discharge_limited']
  ]) {
    const dec = midSlot({ battery });
    assert.equal(dec.mode, 'instant', reason);
    assert.equal(dec.reason, reason);
    assert.equal(dec.targetW, T, reason);
  }
});

test('Entladeleistung reicht nicht, um vom Bezug zurück auf den Augenblickswert zu kommen → Augenblickswert', () => {
  // Bezug 15 kW, Ziel 9 700 W → 5 300 W müssten zusätzlich aus dem Akku. Kann er nur 4 000 W (5 000 − 1 000 Reserve
  // bei 5 kW Entladeleistung, entlädt gerade nicht → 4 000 W Luft): Rückfall.
  const dec = midSlot({ importW: 15000, battery: { ...BAT, maxDischargeW: 5000 } });
  assert.equal(dec.mode, 'instant');
  assert.equal(dec.reason, 'discharge_limited');
});

test('Budget-Ziel nie weiter über dem Augenblickswert, als der Akku zusätzlich entladen kann', () => {
  // Erlaubt wäre (8 730 000 − 1 500 000) / 600 = 12 050 W; Akku 3 kW → Luft 3 000 − 500 = 2 500 W → höchstens 12 200 W.
  const dec = midSlot({ importW: 9000, battery: { ...BAT, maxDischargeW: 3000 } });
  assert.equal(dec.mode, 'budget');
  assert.equal(dec.targetW, 12000);
  const dec2 = midSlot({ importW: 9000, battery: { ...BAT, maxDischargeW: 2000 } });
  assert.equal(dec2.mode, 'budget');
  assert.equal(dec2.targetW, 11200, 'Luft 2 000 − 500 = 1 500 W → 9 700 + 1 500');
});

test('Energie im Akku reicht nicht für den Rest der Viertelstunde (Kapazität eingetragen) → Augenblickswert', () => {
  // 10 kWh, Ladestand 11 %, Boden 5 % → 11 − 5 − 5 = 1 % = 100 Wh nutzbar. Bezug 12 kW, Ziel ≈ 12 050 W →
  // nötig max(0, 12 000 − 9 700) × 600 s = 383 Wh > 100 Wh.
  const dec = midSlot({ battery: { ...BAT, soc: 11, capacityWh: 10000 } });
  assert.equal(dec.mode, 'instant');
  assert.equal(dec.reason, 'soc_energy');
  const ok = midSlot({ battery: { ...BAT, soc: 60, capacityWh: 10000 } });
  assert.equal(ok.mode, 'budget');
});

test('Einstellung aus: immer Augenblickswert', () => {
  const st = createBudgetState();
  run(st, { from: 0, to: 300_000, load: () => 5000 });
  const dec = decideBudget(st, { enabled: false, wallMs: SLOT0 + 300_000, limitW: LIMIT, marginW: MARGIN, targetW: T, importW: 12000, battery: BAT });
  assert.equal(dec.mode, 'instant');
  assert.equal(dec.reason, 'billing_instant');
  assert.equal(dec.targetW, T);
});

test('Zählerwert jetzt nicht frisch → Augenblickswert', () => {
  assert.equal(midSlot({ importW: null }).reason, 'meter_stale');
});

test('letzte Minute der Viertelstunde → Augenblickswert', () => {
  const st = createBudgetState();
  run(st, { from: 0, to: SLOT_MS - 50_000, load: () => 5000 });
  const dec = decideBudget(st, { enabled: true, wallMs: SLOT0 + SLOT_MS - 50_000, limitW: LIMIT, marginW: MARGIN, targetW: T, importW: 5000, battery: BAT });
  assert.equal(dec.reason, 'slot_ending');
});

test('Budget verbraucht → Augenblickswert', () => {
  const st = createBudgetState();
  run(st, { from: 0, to: 700_000, load: () => 13000 });
  const dec = decideBudget(st, { enabled: true, wallMs: SLOT0 + 700_000, limitW: LIMIT, marginW: MARGIN, targetW: T, importW: 13000, battery: BAT });
  assert.equal(dec.mode, 'instant');
  assert.equal(dec.reason, 'budget_exceeded');
});

// --- Lücken, Neustart, Viertelstundenwechsel, Uhrsprung ---------------------------------------

test('Lücke von 20 s zählt als Bezug mindestens an der Grenze', () => {
  const st = createBudgetState();
  observeBudget(st, { wallMs: SLOT0, monoMs: 0, importW: 2000, limitW: LIMIT, timeZone: TZ });
  const before = st.usedWs;
  observeBudget(st, { wallMs: SLOT0 + 20_000, monoMs: 20_000, importW: 3000, limitW: LIMIT, timeZone: TZ });
  assert.equal(st.usedWs - before, LIMIT * 20, '20 s × 10 000 W');
  assert.equal(st.gapMs, 20_000);
  // Ein fehlender Messwert (null) ist ebenfalls Lücke — auch wenn der Abstand kurz ist; höherer Nachbarwert gilt.
  const st2 = createBudgetState();
  observeBudget(st2, { wallMs: SLOT0, monoMs: 0, importW: 12000, limitW: LIMIT, timeZone: TZ });
  observeBudget(st2, { wallMs: SLOT0 + 2000, monoMs: 2000, importW: null, limitW: LIMIT, timeZone: TZ });
  assert.equal(st2.usedWs, 12000 * 2);
});

test('mehr als 60 s Lücke in der Viertelstunde → Messwerte unsicher → Augenblickswert', () => {
  const st = createBudgetState();
  run(st, { from: 0, to: 100_000, load: () => 3000 });
  observeBudget(st, { wallMs: SLOT0 + 100_000 + BUDGET_MAX_GAP_MS + 2000, monoMs: 100_000 + BUDGET_MAX_GAP_MS + 2000, importW: 3000, limitW: LIMIT, timeZone: TZ });
  const dec = decideBudget(st, { enabled: true, wallMs: SLOT0 + 170_000, limitW: LIMIT, marginW: MARGIN, targetW: T, importW: 3000, battery: BAT });
  assert.equal(dec.mode, 'instant');
  assert.equal(dec.reason, 'measurements_uncertain');
});

test('Start mitten in der Viertelstunde: die Zeit davor ist Lücke an der Grenze → Augenblickswert bis zur nächsten', () => {
  const st = createBudgetState();
  observeBudget(st, { wallMs: SLOT0 + 420_000, monoMs: 5, importW: 3000, limitW: LIMIT, timeZone: TZ });
  assert.equal(st.usedWs, LIMIT * 420);
  const dec = decideBudget(st, { enabled: true, wallMs: SLOT0 + 420_000, limitW: LIMIT, marginW: MARGIN, targetW: T, importW: 3000, battery: BAT });
  assert.equal(dec.reason, 'measurements_uncertain');
  // Nächste Viertelstunde lückenlos → Budget.
  const { dec: next } = run(st, { from: 422_000, to: SLOT_MS + 60_000, load: () => 3000, mono0: 5 - 420_000 });
  assert.equal(next.mode, 'budget', JSON.stringify(next));
});

test('Viertelstundenwechsel: nur der Teil nach der Grenze zählt zur neuen Viertelstunde, Zähler beginnt neu', () => {
  const st = createBudgetState();
  run(st, { from: 0, to: SLOT_MS - 1000, load: () => 8000 });
  assert.ok(st.usedWs > 7_000_000);
  // Nächste Abfrage 2 s später = 1 s nach der Grenze.
  observeBudget(st, { wallMs: SLOT0 + SLOT_MS + 1000, monoMs: SLOT_MS + 1000, importW: 4000, limitW: LIMIT, timeZone: TZ });
  assert.equal(st.slotStartMs, SLOT0 + SLOT_MS);
  assert.equal(st.usedWs, 8000 * 1, 'max(8 000, 4 000) W × 1 s');
  assert.equal(st.gapMs, 0);
});

test('Uhrsprung (Wanduhr springt, monotone Uhr nicht) → Viertelstunde unsicher → Augenblickswert', () => {
  const st = createBudgetState();
  run(st, { from: 0, to: 120_000, load: () => 3000 });
  // Wanduhr +30 s, monotone Uhr +2 s
  observeBudget(st, { wallMs: SLOT0 + 152_000, monoMs: 122_000, importW: 3000, limitW: LIMIT, timeZone: TZ });
  const dec = decideBudget(st, { enabled: true, wallMs: SLOT0 + 152_000, limitW: LIMIT, marginW: MARGIN, targetW: T, importW: 3000, battery: BAT });
  assert.equal(dec.reason, 'clock_jump');
});

test('Einspeisung zählt nicht als negativer Bezug', () => {
  const st = createBudgetState();
  observeBudget(st, { wallMs: SLOT0, monoMs: 0, importW: -5000, limitW: LIMIT, timeZone: TZ });
  const u0 = st.usedWs;
  observeBudget(st, { wallMs: SLOT0 + 2000, monoMs: 2000, importW: -4000, limitW: LIMIT, timeZone: TZ });
  assert.equal(st.usedWs - u0, 0);
});

// --- Akku-Lage aus der Config ----------------------------------------------------------------

test('budgetBatteryInput: Entladeleistung nur, wenn eingetragen (keine Werks-Vorgabe)', () => {
  const tel = { socOk: true, socReason: null, soc: 50, floorPct: 5, batteryDischargeW: 1200, batteryFresh: true };
  assert.equal(budgetBatteryInput({}, tel).maxDischargeW, null, 'nur Vorgaben → unbekannt');
  assert.equal(budgetBatteryInput({ system: { power: { batteryMaxDischargeDcW: 8000 } } }, tel).maxDischargeW, 8000);
  assert.equal(budgetBatteryInput({ optimizer: { inverterMaxPowerW: 6000 }, system: { power: { batteryMaxDischargeDcW: 8000 } } }, tel).maxDischargeW, 6000);
  assert.equal(budgetBatteryInput({}, tel).capacityWh, null);
  assert.equal(budgetBatteryInput({ system: { power: { batteryCapacityWh: 20000 } } }, tel).capacityWh, 20000);
  assert.equal(budgetBatteryInput({}, tel).dischargeW, 1200);
});

test('Akku-Leistung unbekannt → Augenblickswert', () => {
  assert.equal(midSlot({ battery: { ...BAT, dischargeW: null } }).reason, 'battery_power_unknown');
});

test('Energie-Prüfung zählt die laufende Entladung mit (Codex d7dcce9c P2)', () => {
  // 20 kWh, Ladestand 13 % → 13 − 5 − 5 = 3 % = 600 Wh. Bezug 12 kW, Akku entlädt schon 3 kW:
  // nötig (3 000 + 12 000 − 9 700) × 600 s = 883 Wh > 600 Wh → Augenblickswert. Ohne laufende Entladung 383 Wh → Budget.
  assert.equal(midSlot({ battery: { ...BAT, soc: 13, capacityWh: 20000, dischargeW: 3000 } }).reason, 'soc_energy');
  assert.equal(midSlot({ battery: { ...BAT, soc: 13, capacityWh: 20000, dischargeW: 0 } }).mode, 'budget');
});

test('budgetBatteryInput: Akku-Leistung nicht frisch → dischargeW null; Live-Grenze nur mit Nennleistung', () => {
  const tel = { socOk: true, soc: 50, floorPct: 5, batteryDischargeW: 0, batteryFresh: false };
  assert.equal(budgetBatteryInput({}, tel).dischargeW, null);
  const cfg = { system: { power: { batteryMaxDischargeDcW: 8000 } } };
  assert.equal(budgetBatteryInput(cfg, { ...tel, batteryFresh: true }, { liveLimitW: 3000 }).maxDischargeW, 3000);
  assert.equal(budgetBatteryInput({}, { ...tel, batteryFresh: true }, { liveLimitW: 3000 }).maxDischargeW, null, 'ohne Nennleistung bleibt sie unbekannt');
});
