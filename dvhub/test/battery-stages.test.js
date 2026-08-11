// Akku-Ausbaustufen (Christin 2026-08-07).
//
// Der Anlass in einem Satz: der Betreiber startete mit 43 kWh, baute auf 60 und
// dann auf 77 kWh aus. Die Zyklenrechnung teilte JEDE historische Zeile durch
// die HEUTIGE Kapazität — nach jedem Ausbau schrumpften damit rückwirkend alle
// früheren Zyklenwerte, obwohl an der Vergangenheit nichts passiert war.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  sanitizeBatteryStages,
  resolveBatteryCapacityWhForDate,
  resolveBatteryCapacityWhForTimestamp,
  resolveCurrentBatteryCapacityWh,
  localDateOf
} from '../battery-stages.js';

const REAL_STAGES = sanitizeBatteryStages([
  { label: 'Start', startDate: '2025-11-01', capacityWh: 43000 },
  { label: 'Ausbau 2', startDate: '2026-03-15', capacityWh: 60000 },
  { label: 'Ausbau 3', startDate: '2026-08-01', capacityWh: 77000 }
]);

test('sanitize sortiert nach Datum, unabhängig von der Eingabereihenfolge', () => {
  const stages = sanitizeBatteryStages([
    { startDate: '2026-08-01', capacityWh: 77000 },
    { startDate: '2025-11-01', capacityWh: 43000 },
    { startDate: '2026-03-15', capacityWh: 60000 }
  ]);
  assert.deepEqual(stages.map((s) => s.capacityWh), [43000, 60000, 77000]);
});

test('sanitize verwirft einen unmöglichen Kalendertag statt ihn zu sortieren', () => {
  // 2026-13-01 besteht das reine Formatmuster. Ungeprüft sortiert es sich als
  // JÜNGSTE Stufe ganz nach hinten und würde die heute gültige Kapazität
  // kapern — im Smoke-Test genau so passiert (1000 Wh statt 77000 Wh).
  const warnings = [];
  const stages = sanitizeBatteryStages([
    { id: 'gut', startDate: '2026-08-01', capacityWh: 77000 },
    { id: 'tippfehler', startDate: '2026-13-01', capacityWh: 1000 }
  ], warnings);
  assert.equal(stages.length, 1);
  assert.equal(resolveBatteryCapacityWhForDate(stages, '2027-01-01', null), 77000);
  assert.ok(warnings.some((w) => w.includes('tippfehler')));
});

test('sanitize verwirft den 29. Februar in einem Nicht-Schaltjahr, behält ihn im Schaltjahr', () => {
  const stages = sanitizeBatteryStages([
    { id: 'kein-schaltjahr', startDate: '2026-02-29', capacityWh: 10000 },
    { id: 'schaltjahr', startDate: '2028-02-29', capacityWh: 88000 }
  ]);
  assert.deepEqual(stages.map((s) => s.id), ['schaltjahr']);
});

test('sanitize verwirft nur den kaputten Eintrag, nicht die ganze Liste', () => {
  // Sonst würde ein Tippfehler in einer Stufe die Kapazität ALLER anderen
  // verlieren und die Historie fiele auf den Einzelwert zurück.
  const warnings = [];
  const stages = sanitizeBatteryStages([
    { id: 'ok-1', startDate: '2025-11-01', capacityWh: 43000 },
    { id: 'leer', startDate: '2026-01-01', capacityWh: 0 },
    { id: 'ok-2', startDate: '2026-03-15', capacityWh: 60000 }
  ], warnings);
  assert.deepEqual(stages.map((s) => s.id), ['ok-1', 'ok-2']);
  assert.equal(warnings.length, 1);
});

test('sanitize behält bei doppeltem Datum die erste Stufe und meldet die zweite', () => {
  const warnings = [];
  const stages = sanitizeBatteryStages([
    { id: 'erste', startDate: '2026-03-15', capacityWh: 60000 },
    { id: 'zweite', startDate: '2026-03-15', capacityWh: 5000 }
  ], warnings);
  assert.deepEqual(stages.map((s) => s.id), ['erste']);
  assert.ok(warnings.some((w) => w.includes('duplicate startDate')));
});

test('sanitize akzeptiert einen Rückbau — kleinere Kapazität ist kein Sonderfall', () => {
  const stages = sanitizeBatteryStages([
    { startDate: '2026-03-15', capacityWh: 60000 },
    { startDate: '2026-09-01', capacityWh: 43000 }
  ]);
  assert.equal(resolveBatteryCapacityWhForDate(stages, '2026-10-01', null), 43000);
});

test('die Stufe gilt ab ihrem Datum, der Vortag gehört noch zur alten', () => {
  assert.equal(resolveBatteryCapacityWhForDate(REAL_STAGES, '2026-03-14', null), 43000);
  assert.equal(resolveBatteryCapacityWhForDate(REAL_STAGES, '2026-03-15', null), 60000);
  assert.equal(resolveBatteryCapacityWhForDate(REAL_STAGES, '2026-07-31', null), 60000);
  assert.equal(resolveBatteryCapacityWhForDate(REAL_STAGES, '2026-08-01', null), 77000);
});

test('vor der ältesten Stufe gilt deren Kapazität rückwärts weiter', () => {
  // Bewusste Festlegung: wer nicht mehr weiß, wann die erste Ausbaustufe in
  // Betrieb ging, muss kein Datum erfinden. Immer noch richtiger als der
  // heutige Wert und ohne Null-Datum als Sonderfall.
  assert.equal(resolveBatteryCapacityWhForDate(REAL_STAGES, '2025-06-01', null), 43000);
});

test('leere Liste fällt auf den manuell gepflegten Einzelwert zurück', () => {
  // Damit verhalten sich Bestandsinstallationen exakt wie vor der Zeitleiste.
  assert.equal(resolveBatteryCapacityWhForDate([], '2026-01-01', 43000), 43000);
  assert.equal(resolveBatteryCapacityWhForDate(null, '2026-01-01', 43000), 43000);
});

test('ohne Stufen UND ohne brauchbaren Einzelwert bleibt es null', () => {
  // Kein Ratewert: der Zyklenrechner zeigt lieber nichts als etwas Falsches.
  assert.equal(resolveBatteryCapacityWhForDate([], '2026-01-01', 0), null);
  assert.equal(resolveBatteryCapacityWhForDate([], '2026-01-01', null), null);
});

test('der Zeitstempel wird auf den BERLINER Kalendertag abgebildet, nicht auf den UTC-Tag', () => {
  // 23:30 UTC am 14.03. ist in Berlin bereits der 15.03. — der Slot gehört zur
  // neuen Stufe. Ohne Zonenbezug landete er im Vortag und damit bei 43 kWh.
  assert.equal(localDateOf('2026-03-14T23:30:00Z'), '2026-03-15');
  assert.equal(resolveBatteryCapacityWhForTimestamp(REAL_STAGES, '2026-03-14T23:30:00Z', null), 60000);
  assert.equal(resolveBatteryCapacityWhForTimestamp(REAL_STAGES, '2026-03-14T21:00:00Z', null), 43000);
});

test('der Jetzt-Wert ist die zum injizierten Datum gültige Stufe', () => {
  assert.equal(resolveCurrentBatteryCapacityWh(REAL_STAGES, null, new Date('2026-05-01T12:00:00Z')), 60000);
  assert.equal(resolveCurrentBatteryCapacityWh(REAL_STAGES, null, new Date('2026-08-07T12:00:00Z')), 77000);
});

test('eine Stufe mit Datum in der Zukunft ändert den Jetzt-Wert noch nicht', () => {
  const stages = sanitizeBatteryStages([
    { startDate: '2025-11-01', capacityWh: 43000 },
    { startDate: '2027-01-01', capacityWh: 99000 }
  ]);
  assert.equal(resolveCurrentBatteryCapacityWh(stages, null, new Date('2026-08-07T12:00:00Z')), 43000);
});

test('derselbe Tag liefert nach einem späteren Ausbau denselben Wert (der eigentliche Bug)', () => {
  // Kern des Ganzen: ein Tag im Januar 2026 muss 43 kWh sehen — egal, ob
  // danach noch auf 60 und 77 kWh ausgebaut wurde.
  const nurStart = sanitizeBatteryStages([{ startDate: '2025-11-01', capacityWh: 43000 }]);
  const januar = '2026-01-20';
  assert.equal(resolveBatteryCapacityWhForDate(nurStart, januar, null), 43000);
  assert.equal(resolveBatteryCapacityWhForDate(REAL_STAGES, januar, null), 43000);
});
