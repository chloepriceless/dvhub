// test/energy-source-rule.test.js — Historie „eigene Messwerte zuerst, VRM füllt
// auf“ (Christin 05.11.2026, Entscheidung B): wann deckt der eigene Wert eine
// Viertelstunde vollständig ab?
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  localSampleCreditSeconds, isLocalCoverageComplete, localCoverageFromMeta,
  isCompleteLocalSlotRow, pickSlotSourceRow, chooseRawEntries, slotSourceRankSql
} from '../energy-source-rule.js';

test('Probenzeit: je Probe hoechstens 90 s (ein Haenger deckt die Luecke nicht ab)', () => {
  assert.equal(localSampleCreditSeconds(5), 5);
  assert.equal(localSampleCreditSeconds(70), 70);
  assert.equal(localSampleCreditSeconds(600), 90);
  assert.equal(localSampleCreditSeconds(null), 0);
  assert.equal(localSampleCreditSeconds(-3), 0);
});

test('vollstaendig: lueckenlose 5-s-Proben inkl. Randverschiebung, 60-s-Abfragen', () => {
  assert.equal(isLocalCoverageComplete(900, 180), true);
  assert.equal(isLocalCoverageComplete(894, 179), true, 'Randprobe im Nachbarslot');
  assert.equal(isLocalCoverageComplete(840, 14), true, '60-s-Abfrage, eine Probe am Rand');
});

test('unvollstaendig: Neustart mitten in der Viertelstunde, halbe Abdeckung, unbekannt', () => {
  assert.equal(isLocalCoverageComplete(870, 174), false, '30 s Ausfall bei 5-s-Proben');
  assert.equal(isLocalCoverageComplete(450, 90), false);
  assert.equal(isLocalCoverageComplete(null, null), false, 'Slot vor 1.0.10 ohne Abdeckung');
  assert.equal(isLocalCoverageComplete(0, 0), false);
});

test('Abdeckung aus meta_json lesen (Text oder Objekt)', () => {
  assert.deepEqual(localCoverageFromMeta('{"coverageS":900,"samples":180,"maxResS":5}'), { coverageS: 900, samples: 180, maxResS: 5 });
  assert.deepEqual(localCoverageFromMeta({ coverageS: 450 }), { coverageS: 450, samples: null, maxResS: null });
  assert.equal(localCoverageFromMeta(null), null);
  assert.equal(localCoverageFromMeta('{"incomplete":true}'), null);
});

const full = { source_kind: 'local_live', value_num: 0.5, meta_json: '{"coverageS":900,"samples":180}' };
const half = { source_kind: 'local_live', value_num: 0.25, meta_json: '{"coverageS":450,"samples":90}' };
const legacy = { source_kind: 'local_live', value_num: 0.5, meta_json: null };
const vrm = { source_kind: 'vrm_import', value_num: 0.6, meta_json: '{"incomplete":true}' };
const order = ['vrm_import', 'local_live'];

test('Slot-Wahl: vollstaendig lokal → lokal; lokal halb → VRM; lokal fehlt → VRM; nur lokal → lokal', () => {
  assert.equal(isCompleteLocalSlotRow(full), true);
  assert.equal(isCompleteLocalSlotRow(vrm), false);
  assert.equal(pickSlotSourceRow(new Map([['vrm_import', vrm], ['local_live', full]]), order), full);
  assert.equal(pickSlotSourceRow(new Map([['vrm_import', vrm], ['local_live', half]]), order), vrm);
  assert.equal(pickSlotSourceRow(new Map([['vrm_import', vrm]]), order), vrm);
  assert.equal(pickSlotSourceRow(new Map([['local_live', half]]), order), half);
});

test('Slot-Wahl: alter Slot ohne Abdeckung behaelt die bisherige Reihenfolge (VRM vor lokal)', () => {
  assert.equal(pickSlotSourceRow(new Map([['vrm_import', vrm], ['local_live', legacy]]), order), vrm);
});

test('Slot-Wahl: ausdrücklich nur VRM angefragt → lokal zaehlt nicht', () => {
  assert.equal(pickSlotSourceRow(new Map([['vrm_import', vrm], ['local_live', full]]), ['vrm_import']), vrm);
});

const live = (n, res = 5) => Array.from({ length: n }, () => ({ scope: 'live', resolution_seconds: res, value_num: 2000 }));
const vrmRaw = [{ scope: 'history', resolution_seconds: 900, value_num: 2400 }];

test('Rohdaten: lokal vollstaendig → lokal, lokal halb → VRM, lokal fehlt → VRM, nie gemischt', () => {
  const fullLive = live(180);
  assert.deepEqual(chooseRawEntries([...vrmRaw, ...fullLive]), fullLive);
  assert.deepEqual(chooseRawEntries([...vrmRaw, ...live(90)]), vrmRaw);
  assert.deepEqual(chooseRawEntries(vrmRaw), vrmRaw);
  assert.deepEqual(chooseRawEntries(live(90)).length, 90);
  // Eine einzelne 900-s-Probe ist keine Messung ueber die Viertelstunde.
  assert.deepEqual(chooseRawEntries([...vrmRaw, ...live(1, 900)]), vrmRaw);
});

test('SQL-Rang: vollstaendig lokal 0, VRM 1, sonstiges lokal 2', () => {
  const sql = slotSourceRankSql();
  assert.match(sql, /coverageS/);
  assert.match(sql, /THEN 0 WHEN source_kind = 'vrm_import' THEN 1 WHEN source_kind = 'local_live' THEN 2/);
});

// Codex 633d1caf (P2): eine Probe nach einer Pause traegt ihre ganze Dauer als
// Energie in den Slot, zaehlt aber nur 60 s Abdeckung. 300 s + 179 × 5 s ergaeben
// 955 s Abdeckung bei 1195 s Energie — der Slot darf nicht als vollstaendig gelten.
test('Probe ueber 90 s im Slot: nie vollstaendig (Energie waere hochgerechnet)', () => {
  assert.equal(isLocalCoverageComplete(955, 180, 900, 300), false);
  assert.equal(isLocalCoverageComplete(900, 180, 900, 5), true);
  assert.equal(isCompleteLocalSlotRow({ source_kind: 'local_live', meta_json: '{"coverageS":955,"samples":180,"maxResS":300}' }), false);
  assert.deepEqual(chooseRawEntries([...vrmRaw, { scope: 'live', resolution_seconds: 300, value_num: 2000 }, ...live(179)]), vrmRaw);
});

// Codex 633d1caf (P1): Proben aus einer fehlgeschlagenen Abfrage (alte Werte)
// zaehlen nicht zur Abdeckung.
test('veraltete Proben (meta stale) zaehlen nicht zur Abdeckung', () => {
  assert.equal(localSampleCreditSeconds(5, 900, { stale: true }), 0);
  const staleLive = live(180).map((e) => ({ ...e, meta_json: '{"stale":true}' }));
  assert.deepEqual(chooseRawEntries([...vrmRaw, ...staleLive]), vrmRaw);
});

// Codex 26452e9b (P2): bei 60-s-Abfragen kommt die Abfragedauer dazu (61 s);
// das ist keine Pause. Erst ueber 90 s gilt eine Probe als Luecke.
test('60-s-Abfragen mit Abfragedauer (61 s) bleiben vollstaendig, 120 s nicht', () => {
  assert.equal(isLocalCoverageComplete(900, 15, 900, 61), true);
  assert.equal(isLocalCoverageComplete(900, 15, 900, 120), false);
  assert.deepEqual(chooseRawEntries([...vrmRaw, ...live(15, 61)]).length, 15);
});

// Codex 607fa4b2 (P2): Bei 60-s-Abfrage kommt die Lesedauer dazu. Lückenlose
// 70-s-Zyklen (13 Proben je Viertelstunde, keine über 90 s) decken den Slot ab —
// vorher zählte jede Probe nur 60 s (780 s < 810 s), der VRM-Import gewann immer.
test('vollstaendig: lueckenlose 70-s-Zyklen bei 60-s-Abfrage', () => {
  const samples = 13;
  const coverage = samples * localSampleCreditSeconds(70);
  assert.equal(isLocalCoverageComplete(coverage, samples, 900, 70), true);
  // eine 120-s-Pause bleibt unvollständig
  assert.equal(isLocalCoverageComplete(11 * localSampleCreditSeconds(70) + localSampleCreditSeconds(120), 12, 900, 120), false);
});
