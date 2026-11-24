// test/storage-profile.test.js — Speicherprofil und Stufe (Speicher-Konzept
// 23.11.2026, Schritt 3; Entscheidungen Christin S1, S2 a, S4).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROFILES, profileForSize, harderProfile, fallbackThresholds, storageStage, decideProfile, chooseProfile, cappedReserveMb,
} from '../services/storage-profile.js';
import { rawPruneCutoff } from '../services/raw-retention.js';

const GiB = 1024;

test('Profil aus der Plattengröße (S1: 64/24/8 GB, Herstellerangabe)', () => {
  assert.equal(profileForSize(117 * GiB), 'gross', 'Prod A7S 128 GB');
  assert.equal(profileForSize(57 * GiB), 'gross', '64-GB-Karte nach Formatieren');
  assert.equal(profileForSize(29 * GiB), 'mittel', '32-GB-Karte');
  assert.equal(profileForSize(11 * GiB), 'klein', 'Kundenbox 12 GB');
  assert.equal(profileForSize(7.3 * GiB), 'klein', '8-GB-Karte');
  assert.equal(profileForSize(2.3 * GiB), 'winzig', 'EnergyLink');
  assert.equal(profileForSize(null), 'gross', 'unbekannt → nichts verschärfen');
  assert.equal(harderProfile('gross'), 'mittel');
  assert.equal(harderProfile('winzig'), 'winzig');
});

test('Kompression auf allen Profilen (S4), je kleiner desto früher', () => {
  for (const p of Object.values(PROFILES)) {
    assert.ok(p.compressAfter && p.chunkInterval, p.name);
    if (p.name !== 'gross') assert.ok(p.compressSchedule, p.name);
  }
  assert.equal(PROFILES.gross.compressSchedule, null, 'groß: Lauf-Intervall unangetastet');
  assert.equal(PROFILES.gross.compressAfter, '2 days', 'groß = heutiges Verhalten');
  assert.equal(PROFILES.gross.chunkInterval, '1 day');
  assert.equal(PROFILES.gross.rawKeepDays, null);
  assert.equal(PROFILES.klein.rawKeepDays, 365);
  assert.equal(PROFILES.winzig.rawKeepDays, 30);
  assert.equal(PROFILES.mittel.journaldMaxMb, null, 'S8 a: journald nur klein/winzig');
  assert.equal(PROFILES.klein.journaldMaxMb, 200);
});

test('Rückfall-Schwellen wie im Konzept (2,3 / 12 / 117 GB)', () => {
  const r = (t) => Object.fromEntries(Object.entries(fallbackThresholds(t)).map(([k, v]) => [k, Math.round(v)]));
  assert.deepEqual(r(2355), { knapp: 707, wenig: 353, kritisch: 188 });
  assert.deepEqual(r(12288), { knapp: 2458, wenig: 1229, kritisch: 614 });
  assert.deepEqual(r(119588), { knapp: 10240, wenig: 5120, kritisch: 2048 });
});

test('Stufe: Reichweite ist Hauptkriterium, ohne Wachstum der Rückfall', () => {
  const base = { totalMb: 117 * GiB, freeMb: 20 * GiB, reserveMb: 1000 };
  assert.equal(storageStage({ ...base, growthKnown: false }), 'ok');
  assert.equal(storageStage({ ...base, growthKnown: true, daysLeft: 400 }), 'ok');
  assert.equal(storageStage({ ...base, growthKnown: true, daysLeft: 100 }), 'knapp');
  assert.equal(storageStage({ ...base, growthKnown: true, daysLeft: 30 }), 'wenig');
  assert.equal(storageStage({ ...base, growthKnown: true, daysLeft: 10 }), 'kritisch');
  assert.equal(storageStage({ ...base, growthKnown: true, daysLeft: null }), 'ok', 'wächst nicht');
  assert.equal(storageStage({ ...base, freeMb: 1500, growthKnown: true, daysLeft: null }), 'kritisch', 'fester Boden 2 GB');
  assert.equal(storageStage({ totalMb: 12 * GiB, freeMb: 900, reserveMb: 0, growthKnown: false }), 'wenig');
  assert.equal(storageStage({ totalMb: null, freeMb: 1 }), 'unbekannt');
});

test('Reserve gedeckelt: EnergyLink nicht dauerhaft kritisch', () => {
  assert.equal(cappedReserveMb(1536 + 128 + 230, 2355), 188);
  assert.equal(cappedReserveMb(1536 + 1024 + 230, 119588), 2790, 'große Platte: volle Reserve');
  assert.equal(storageStage({ totalMb: 2355, freeMb: 1200, reserveMb: cappedReserveMb(1894, 2355), growthKnown: true, daysLeft: 400 }), 'ok');
});

test('Hysterese: zurück erst 25 % über der Schwelle', () => {
  const g = { totalMb: 117 * GiB, freeMb: 20 * GiB, reserveMb: 0, growthKnown: true };
  assert.equal(storageStage({ ...g, daysLeft: 65, prev: 'wenig' }), 'wenig', '65 < 60 × 1,25');
  assert.equal(storageStage({ ...g, daysLeft: 76, prev: 'wenig' }), 'knapp');
  assert.equal(storageStage({ ...g, daysLeft: 300, prev: 'kritisch' }), 'ok');
  assert.equal(storageStage({ ...g, daysLeft: 16, prev: 'kritisch' }), 'kritisch');
  assert.equal(storageStage({ ...g, daysLeft: 16, prev: 'ok' }), 'wenig', 'schlechter geht sofort');
});

test('S2 a: Neuinstallation automatisch, Bestandsbox bleibt „groß“ mit Vorschlag', () => {
  const neu = decideProfile({ sizeProfile: 'klein', fresh: true });
  assert.deepEqual([neu.state.mode, neu.state.origin, neu.effective, neu.suggested], ['auto', 'install', 'klein', null]);
  const alt = decideProfile({ sizeProfile: 'klein', fresh: false });
  assert.deepEqual([alt.state.mode, alt.state.origin, alt.effective, alt.suggested], ['fixed', 'existing', 'gross', 'klein']);
  assert.match(alt.reason, /bisheriges Verhalten/);
});

test('S2 a: bei „wenig“/„kritisch“ greift DVhub selbst ein (eine Stufe härter, befristet)', () => {
  const st = { version: 1, mode: 'fixed', base: 'gross', origin: 'existing' };
  assert.equal(decideProfile({ state: st, sizeProfile: 'klein', stage: 'knapp' }).effective, 'gross');
  const w = decideProfile({ state: st, sizeProfile: 'klein', stage: 'wenig' });
  assert.equal(w.effective, 'mittel');
  assert.equal(w.temporary, true);
  assert.equal(w.state.base, 'gross', 'gespeichertes Profil bleibt');
  assert.equal(decideProfile({ state: st, sizeProfile: 'klein', stage: 'ok' }).effective, 'gross', 'danach zurück');
});

test('Automatisch nur härter, weicher nur per Klick', () => {
  const st = { version: 1, mode: 'auto', base: 'klein', origin: 'install' };
  const grown = decideProfile({ state: st, sizeProfile: 'gross' });
  assert.equal(grown.effective, 'klein');
  assert.equal(grown.suggested, 'gross');
  const shrunk = decideProfile({ state: st, sizeProfile: 'winzig' });
  assert.equal(shrunk.effective, 'winzig');
  assert.equal(shrunk.state.base, 'winzig');
  assert.deepEqual(chooseProfile(st, 'auto', { sizeProfile: 'gross' }).base, 'gross');
  assert.equal(chooseProfile(st, 'mittel', { sizeProfile: 'gross' }).mode, 'fixed');
  assert.throws(() => chooseProfile(st, 'riesig', { sizeProfile: 'gross' }));
});

test('Schnittstelle Rohwert-Aufbewahrung: nie jünger als der verdichtete Stand', () => {
  const now = Date.parse('2026-11-23T00:00:00Z');
  assert.equal(rawPruneCutoff({ keepDays: 30, now, compactedUntil: new Date('2026-11-20T00:00:00Z') }).toISOString(), '2026-10-24T00:00:00.000Z');
  assert.equal(rawPruneCutoff({ keepDays: 30, now, compactedUntil: new Date('2026-10-01T00:00:00Z') }).toISOString(), '2026-10-01T00:00:00.000Z');
  assert.equal(rawPruneCutoff({ keepDays: 30, now, compactedUntil: null }), null, 'nichts verdichtet → nichts löschen');
  assert.equal(rawPruneCutoff({ keepDays: null, now, compactedUntil: new Date() }), null, 'für immer');
});
