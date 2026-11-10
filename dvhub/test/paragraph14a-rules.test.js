import test from 'node:test';
import assert from 'node:assert/strict';

import {
  simultaneityFactor, groupSteuve, computePmin14a, budgetW, allocateBudget, demandW,
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
  // Fable R2 P1-1: null ist kein Bezug von 0 W — sonst würde die laufende
  // Leistung der SteuVE (17 kW) zum „PV-Überschuss“.
  assert.equal(budgetW({ limitW: 4200, gridImportW: null, steuveW: 17000 }), 4200, 'ohne Messwert kein Zuschlag');
  assert.equal(budgetW({ limitW: 4200, gridImportW: undefined, steuveW: 17000 }), 4200);
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

// ── Nach Bedarf (pv magazine 09.11.2026, „Beim Dimmen nur starre Leistungsgrenzen“) ──
// Erst bekommt jedes Gerät, was es gerade braucht, dann geht der Rest weiter.

test('nach Bedarf: Wärmepumpe mit 1,5 kW Last hält nicht 5,5 kW fest — die Wallbox bekommt den Rest', () => {
  const consumers = [
    { id: 'wp', kind: 'waermepumpe', maxW: 5500, needW: 2050 },
    { id: 'wb', kind: 'ladepunkt', maxW: 11000, needW: 6900, atCap: true },
  ];
  // Vorrang Wärme: früher WP 5500 / Wallbox 2060
  assert.deepEqual(allocateBudget(7560, consumers, { demand: true }), { wp: 2050, wb: 5510 });
});

test('nach Bedarf: bei Knappheit entscheidet der Vorrang über den Bedarf', () => {
  const consumers = [
    { id: 'wb', kind: 'ladepunkt', maxW: 11000, needW: 6000 },
    { id: 'wp', kind: 'waermepumpe', maxW: 5500, needW: 2000 },
  ];
  assert.deepEqual(allocateBudget(3000, consumers, { demand: true }), { wp: 2000, wb: 1000 });
  assert.deepEqual(allocateBudget(3000, consumers, { demand: true, priority: ['ladepunkt', 'waermepumpe'] }), { wb: 3000, wp: 0 });
});

test('nach Bedarf: der Rest geht zuerst an Geräte, die an ihrer Grenze laufen, dann nach Vorrang bis zur Höchstleistung', () => {
  const consumers = [
    { id: 'wp', kind: 'waermepumpe', maxW: 5500, needW: 2000 },
    { id: 'wb', kind: 'ladepunkt', maxW: 11000, needW: 4000, atCap: true },
    { id: 'bat', kind: 'speicher', maxW: 10000, needW: 1000 },
  ];
  assert.deepEqual(allocateBudget(10000, consumers, { demand: true }), { wp: 2000, wb: 7000, bat: 1000 });
  // Mehr als die Wallbox nehmen kann: der Rest nach Vorrang, nichts verfällt
  assert.deepEqual(allocateBudget(20000, consumers, { demand: true }), { wp: 5500, wb: 11000, bat: 3500 });
});

test('nach Bedarf: ohne Bedarfswert zählt die Höchstleistung (wie bisher)', () => {
  const consumers = [{ id: 'wp', kind: 'waermepumpe', maxW: 5500 }, { id: 'wb', kind: 'ladepunkt', maxW: 11000, needW: 3000 }];
  assert.deepEqual(allocateBudget(7560, consumers, { demand: true }), { wp: 5500, wb: 2060 });
});

test('nach Bedarf anteilig: knapp nach Bedarf, sonst der Rest nach freiem Spielraum', () => {
  const consumers = [
    { id: 'wp', kind: 'waermepumpe', maxW: 5500, needW: 2000 },
    { id: 'wb', kind: 'ladepunkt', maxW: 11000, needW: 6000 },
  ];
  assert.deepEqual(allocateBudget(4000, consumers, { mode: 'proportional', demand: true }), { wp: 1000, wb: 3000 });
  // Bedarf 8000 gedeckt, Rest 2000 nach Spielraum 3500 : 5000
  assert.deepEqual(allocateBudget(10000, consumers, { mode: 'proportional', demand: true }), { wp: 2823, wb: 7176 });
});

test('Aufteilung: die Summe liegt in keiner Betriebsart über dem Budget', () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const kinds = ['waermepumpe', 'klima', 'ladepunkt', 'speicher'];
  for (let i = 0; i < 500; i++) {
    const n = 1 + Math.floor(rnd() * 5);
    const consumers = Array.from({ length: n }, (_, k) => {
      const maxW = 1000 + Math.floor(rnd() * 12000);
      return { id: `d${k}`, kind: kinds[k % 4], maxW, needW: rnd() < 0.2 ? null : Math.floor(rnd() * maxW), atCap: rnd() < 0.5 };
    });
    const budget = Math.floor(rnd() * 30000);
    for (const opts of [{}, { mode: 'proportional' }, { demand: true }, { mode: 'proportional', demand: true }]) {
      const out = allocateBudget(budget, consumers, opts);
      const sum = Object.values(out).reduce((a, w) => a + w, 0);
      assert.ok(sum <= budget, `Summe ${sum} > Budget ${budget} (${JSON.stringify(opts)})`);
      for (const c of consumers) assert.ok(out[c.id] >= 0 && out[c.id] <= c.maxW, `${c.id} außerhalb 0…maxW`);
    }
  }
});

test('Bedarf je Gerät: Messwert plus Reserve, Anlaufstufe, ohne Messwert volle Leistung', () => {
  // Wärmepumpe 5,5 kW zieht 1,5 kW: + Reserve max(500, 10 %) = 550 W
  assert.equal(demandW({ kind: 'waermepumpe', maxW: 5500, currentW: 1500 }), 2050);
  // steht still: Anlaufreserve max(1000, 30 %) = 1650 W
  assert.equal(demandW({ kind: 'waermepumpe', maxW: 5500, currentW: 0 }), 1650);
  // Wallbox lädt nicht: Anlaufstufe (6 A · 3 Phasen · 230 V) vom Aufrufer
  assert.equal(demandW({ kind: 'ladepunkt', maxW: 11000, currentW: 0, startW: 4140 }), 4140);
  // kein Auto: kein Bedarf
  assert.equal(demandW({ kind: 'ladepunkt', maxW: 11000, currentW: 0, startW: 4140, available: false }), 0);
  // nie über der Höchstleistung
  assert.equal(demandW({ kind: 'ladepunkt', maxW: 11000, currentW: 10900 }), 11000);
  // ohne Messwert: volle Leistung
  assert.equal(demandW({ kind: 'waermepumpe', maxW: 5500, currentW: null }), 5500);
  // Speicher ohne Anlaufstufe: nur die Reserve
  assert.equal(demandW({ kind: 'speicher', maxW: 10000, currentW: 0 }), 1000);
});
