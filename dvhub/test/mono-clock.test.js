// A23 b (Christin 23.11.2026): gemeinsame monotone Zeitquelle (services/mono-clock.js).
import test from 'node:test';
import assert from 'node:assert/strict';

import { monoNow, pickMonoNow, createStampAge, markMono, monoAgeOf } from '../services/mono-clock.js';

test('monoNow: steigt nie und ist unabhängig von Date.now', () => {
  const a = monoNow();
  const b = monoNow();
  assert.ok(b >= a);
  const realNow = Date.now;
  try {
    Date.now = () => 0; // Wanduhr „springt“
    assert.ok(monoNow() >= b);
  } finally { Date.now = realNow; }
});

test('pickMonoNow: übergebene monotone Uhr > eingespielte Wanduhr (Test) > monoNow; echte Date.now zählt nicht', () => {
  const m = () => 1;
  const w = () => 2;
  assert.equal(pickMonoNow(m, w), m);
  assert.equal(pickMonoNow(null, w), w);
  assert.equal(pickMonoNow(undefined, Date.now), monoNow);
  assert.equal(pickMonoNow(), monoNow);
});

test('createStampAge: neuer Stempel einmal per Wanduhr (nie negativ), danach monoton', () => {
  let wall = 1_000_000;
  let mono = 50;
  const sa = createStampAge({ now: () => wall, monoNow: () => mono });
  assert.equal(sa.ageMs('x', wall - 3000), 3000);
  // Wanduhr springt 1 h zurück, 2 s vergehen: derselbe Stempel ist 5 s alt, nicht −1 h.
  wall -= 3_600_000; mono += 2000;
  assert.equal(sa.ageMs('x', 1_000_000 - 3000), 5000);
  // Wanduhr springt 2 h vor, 1 s vergeht: 6 s, nicht 2 h.
  wall += 7_200_000; mono += 1000;
  assert.equal(sa.ageMs('x', 1_000_000 - 3000), 6000);
  // Neuer Stempel in der „Zukunft“ (nach Rücksprung gesehen) zählt als jetzt empfangen.
  assert.equal(sa.ageMs('y', wall + 10_000), 0);
  // Ungültig → Infinity, receivedMono null.
  assert.equal(sa.ageMs('z', null), Infinity);
  assert.equal(sa.ageMs('z', 0), wall, 'Stempel 0 = Epoche (wie Date.now() - 0)');
  assert.equal(sa.ageMs('z', 'abc'), Infinity);
  assert.equal(sa.receivedMono('z', undefined), null);
  // Schlüssel getrennt.
  assert.equal(sa.receivedMono('x', 1_000_000 - 3000), 50 - 3000);
});

test('markMono/monoAgeOf: Alter mit der Uhr des Erzeugers, unsichtbar im JSON, nur am selben Objekt', () => {
  let m = 100;
  const o = markMono({ a: 1 }, () => m);
  m += 250;
  assert.equal(monoAgeOf(o), 250);
  assert.equal(JSON.stringify(o), '{"a":1}');
  assert.equal(monoAgeOf({ a: 1 }), null);
  assert.equal(monoAgeOf(null), null);
  assert.equal(markMono(null), null);
  const real = markMono({});
  assert.ok(monoAgeOf(real) >= 0);
});
