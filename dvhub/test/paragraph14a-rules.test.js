import test from 'node:test';
import assert from 'node:assert/strict';

import {
  simultaneityFactor, groupSteuve, computePmin14a, budgetW, allocateBudget,
} from '../services/paragraph14a/rules.js';

test('Gleichzeitigkeitsfaktor nach Ziffer 4.5.2', () => {
  assert.deepEqual([2, 3, 4, 5, 6, 7, 8, 9, 12].map(simultaneityFactor), [0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5, 0.45, 0.45]);
  assert.equal(simultaneityFactor(1), 1);
});

test('eine SteuVE: 4,2 kW', () => {
  const r = computePmin14a([{ id: 'wb', kind: 'ladepunkt', powerW: 11000 }]);
  assert.equal(r.pminW, 4200);
  assert.equal(r.n, 1);
});

test('Wallbox + Speicher: 4,2 + 0,8·4,2 = 7,56 kW', () => {
  const r = computePmin14a([
    { id: 'wb', kind: 'ladepunkt', powerW: 11000 },
    { id: 'bat', kind: 'speicher', powerW: 10000 },
  ]);
  assert.equal(r.pminW, 7560);
  assert.equal(r.gzf, 0.8);
});

test('Wallbox + Speicher + Wärmepumpe: 4,2 + 2·0,75·4,2 = 10,5 kW', () => {
  const r = computePmin14a([
    { id: 'wb', kind: 'ladepunkt', powerW: 11000 },
    { id: 'bat', kind: 'speicher', powerW: 10000 },
    { id: 'wp', kind: 'waermepumpe', powerW: 6000 },
  ]);
  assert.equal(r.pminW, 10500);
});

test('Wärmepumpe über 11 kW: 0,4·ΣP_WP statt 4,2 kW als erster Summand', () => {
  const r = computePmin14a([
    { id: 'wp', kind: 'waermepumpe', powerW: 15000 },
    { id: 'wb', kind: 'ladepunkt', powerW: 11000 },
  ]);
  assert.equal(r.formula, 'large_hp_ac');
  assert.equal(r.pminW, Math.round(0.4 * 15000 + 0.8 * 4200));
});

test('Geräte bis 4,2 kW sind keine SteuVE; WP/Klima werden je Fallgruppe zusammengefasst (Ziffer 2.4.2)', () => {
  const { steuve, ignored } = groupSteuve([
    { id: 'wb-klein', kind: 'ladepunkt', powerW: 3700 },
    { id: 'wp1', kind: 'waermepumpe', powerW: 3000 },
    { id: 'wp2', kind: 'waermepumpe', powerW: 2500 },
    { id: 'klima', kind: 'klima', powerW: 2000 },
  ]);
  assert.equal(steuve.length, 1, 'nur die zusammengefassten Wärmepumpen (5,5 kW)');
  assert.deepEqual(steuve[0].members, ['wp1', 'wp2']);
  assert.equal(steuve[0].powerW, 5500);
  assert.deepEqual(ignored.map((i) => i.id).sort(), ['klima', 'wb-klein']);
});

test('direkt angesteuerte SteuVE zählen nicht in die EMS-Formel', () => {
  const r = computePmin14a([
    { id: 'wb', kind: 'ladepunkt', powerW: 11000 },
    { id: 'wp', kind: 'waermepumpe', powerW: 12000, control: 'direct' },
  ]);
  assert.equal(r.n, 1);
  assert.equal(r.pminW, 4200);
  assert.deepEqual(r.direct, [{ key: 'waermepumpe:direct', kind: 'waermepumpe', powerW: 12000, pminW: 4800 }]);
});

test('ohne SteuVE: keine Mindestleistung', () => {
  assert.equal(computePmin14a([]).pminW, 0);
});

test('Budget: nur der netzwirksame Bezug ist begrenzt, PV-Überschuss kommt dazu', () => {
  // Haus 800 W, PV 6 kW, Wallbox lädt 4 kW → Netz −1200 W (Einspeisung)
  assert.equal(budgetW({ limitW: 4200, gridImportW: -1200, steuveW: 4000 }), 4200 + 5200);
  // Ohne PV: Haus 800 W, Wallbox 4 kW → Netz 4800 W
  assert.equal(budgetW({ limitW: 4200, gridImportW: 4800, steuveW: 4000 }), 4200);
  assert.equal(budgetW({ limitW: 4200, gridImportW: -1200, steuveW: 4000, usePvSurplus: false }), 4200);
  assert.equal(budgetW({ limitW: 4200, gridImportW: null, steuveW: 0 }), 4200, 'ohne Messwert: nur die Grenze');
});

test('Aufteilung nach Vorrang: Wärmepumpe, dann Wallbox, Speicher zuletzt', () => {
  const consumers = [
    { id: 'bat', kind: 'speicher', maxW: 10000 },
    { id: 'wb', kind: 'ladepunkt', maxW: 11000 },
    { id: 'wp', kind: 'waermepumpe', maxW: 3000 },
  ];
  assert.deepEqual(allocateBudget(7560, consumers), { wp: 3000, wb: 4560, bat: 0 });
  assert.deepEqual(allocateBudget(7560, consumers, { priority: ['speicher', 'ladepunkt', 'waermepumpe'] }), { bat: 7560, wb: 0, wp: 0 });
});

test('Aufteilung anteilig nach Höchstleistung', () => {
  const consumers = [{ id: 'bat', kind: 'speicher', maxW: 10000 }, { id: 'wb', kind: 'ladepunkt', maxW: 11000 }];
  assert.deepEqual(allocateBudget(4200, consumers, { mode: 'proportional' }), { bat: 2000, wb: 2200 });
});

test('Budget reicht für alle: jedes Gerät bis zur Höchstleistung', () => {
  assert.deepEqual(allocateBudget(30000, [{ id: 'wb', kind: 'ladepunkt', maxW: 11000 }]), { wb: 11000 });
});
