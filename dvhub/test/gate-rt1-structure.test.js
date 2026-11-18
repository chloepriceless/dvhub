// R-T1 Strukturtest im Berichtsmodus (VCL-Vertrag v6 D.1): „Die Senken sind nur noch aus dem Tor erreichbar … Bis
// alle acht Pfade umgestellt sind, zählt jeder verbleibende Direktaufruf als bekannte Ausnahme in einer
// eingecheckten Liste, die nur kürzer werden darf.“
//
// Berichtsmodus heißt: die heutigen Direktaufrufe sind erlaubt, solange sie in services/gate/rt1-direct-writes.json
// stehen. Der Test bricht, wenn
//   • eine NEUE Schreibstelle an einer Senke auftaucht, die in keiner Liste steht,
//   • ein Listeneintrag nicht mehr gefunden wird (Pfad umgestellt → Eintrag löschen, Liste wird kürzer),
//   • die Ausnahmeliste über ihre Obergrenze wächst.
// Funde ansehen: node test/helpers/sink-call-scan.js

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { DVHUB_DIR, scanProduction, scanSource, entryKey } from './helpers/sink-call-scan.js';

// Obergrenze der Ausnahmeliste. Darf NUR sinken: wer einen Pfad aufs Tor umstellt, löscht den Eintrag und senkt
// diese Zahl. Eine neue Ausnahme ist kein Nachtrag hier, sondern ein Schreibweg am Tor vorbei.
const MAX_EXCEPTIONS = 55;

// Nur diese Bausteine sind mehrdeutig (Steuerbefehl oder nicht); eine Modbus-/MQTT-Schreibfunktion oder writeReg
// ist immer ein Schreibweg und darf nie als „kein Steuerbefehl“ eingetragen werden.
const AMBIGUOUS_SINKS = /^(publish|send|http|stdin\.write|pickup:.+)$/;

const LIST_PATH = path.join(DVHUB_DIR, 'services', 'gate', 'rt1-direct-writes.json');
const list = JSON.parse(fs.readFileSync(LIST_PATH, 'utf8'));
const found = scanProduction();
const foundKeys = new Set(found.map(entryKey));
const exceptionKeys = new Set(list.exceptions.map(entryKey));
const notControlKeys = new Set(list.notControl.map(entryKey));

test('Scanner erkennt die Senken-Bausteine und ordnet sie der benannten Funktion zu', () => {
  const src = `
    import { buildControlSnapshot } from './services/control-snapshot.js';
    export function createThing(t) {
      async function writeIt(a) { await t.mbWriteSingle(a); }
      const viaArrow = (a) => t['mbWriteMultiple'](a);
      const { mbWriteCoil } = t;
      async function relay(a) { return mqtt.mqttWrite('x', a); }
      function mirror() { hub.publish('dvhub/control/x', '1'); return buildControlSnapshot({}); }
      function cap() { return typeof t.mbWriteSingle === 'function'; }
      function patch() { t.mbWriteSingle = async () => {}; }
      const later = () => setTimeout(() => writeReg(c, 1, 2), 1);
      return { writeIt, viaArrow, relay, mirror, cap, patch, later, mbWriteCoil };
    }
  `;
  const got = scanSource(src).map((f) => `${f.fn} :: ${f.sink}`).sort();
  assert.deepEqual(got, [
    'createThing :: mbWriteCoil',
    'createThing>later :: writeReg',
    'createThing>mirror :: pickup:buildControlSnapshot',
    'createThing>mirror :: publish',
    'createThing>relay :: mqttWrite',
    'createThing>viaArrow :: mbWriteMultiple',
    'createThing>writeIt :: mbWriteSingle',
  ]);
  // HTTP, WebSocket und EEBUS-Brücke nur in Geräteadaptern (sonst wäre jeder Preis-Abruf ein Fund).
  const http = 'function get(u) { return fetch(u); } function s(ws) { ws.send("x"); }';
  assert.deepEqual(scanSource(http), []);
  assert.deepEqual(scanSource(http, { deviceScope: true }).map((f) => `${f.fn} :: ${f.sink}`).sort(), ['get :: http', 's :: send']);
});

test('R-T1: jede Schreibstelle an einer Senke außerhalb des Tors steht in der Liste', (t) => {
  assert.ok(found.length > 40, `Scanner fand nur ${found.length} Stellen — Muster kaputt?`);
  const unlisted = found.filter((e) => !exceptionKeys.has(entryKey(e)) && !notControlKeys.has(entryKey(e)));
  assert.deepEqual(unlisted.map(entryKey), [],
    'Neue Schreibstelle(n) an einer Senke außerhalb von services/gate/. Schreiben gehört über gate.submit() '
    + '(D.1 R-T1). Ist es nachweislich KEIN Steuerbefehl (Lesen, Konfiguration, Senke selbst), mit Begründung in '
    + 'services/gate/rt1-direct-writes.json unter notControl eintragen.');
  const byPath = {};
  for (const e of list.exceptions) byPath[e.path] = (byPath[e.path] || 0) + 1;
  t.diagnostic(`R-T1 Bericht: ${list.exceptions.length} bekannte Direktaufrufe (Obergrenze ${MAX_EXCEPTIONS}), `
    + `${list.notControl.length} geprüfte Nicht-Steuer-Stellen, ${found.length} Funde gesamt`);
  for (const [p, n] of Object.entries(byPath).sort()) t.diagnostic(`  ${p}: ${n}`);
});

test('R-T1: die Liste wird nur kürzer — kein Eintrag ohne Fund, Ausnahmen unter der Obergrenze', () => {
  const stale = [...list.exceptions, ...list.notControl].filter((e) => !foundKeys.has(entryKey(e)));
  assert.deepEqual(stale.map(entryKey), [],
    'Eintrag ohne Fund: der Pfad läuft jetzt über das Tor oder wurde umbenannt. Eintrag löschen (bzw. Namen '
    + 'nachziehen) und bei Ausnahmen MAX_EXCEPTIONS senken.');
  assert.ok(list.exceptions.length <= MAX_EXCEPTIONS,
    `Ausnahmeliste gewachsen (${list.exceptions.length} > ${MAX_EXCEPTIONS}) — neue Direktaufrufe sind nicht erlaubt`);
});

test('R-T1: Listeneinträge sind eindeutig, vollständig und richtig eingeordnet', () => {
  const all = [...list.exceptions, ...list.notControl];
  assert.equal(new Set(all.map(entryKey)).size, all.length, 'doppelter Eintrag');
  for (const e of list.exceptions) {
    assert.ok(e.file && e.fn && e.sink && e.path && e.note, `unvollständig: ${entryKey(e)}`);
    assert.ok(fs.existsSync(path.join(DVHUB_DIR, e.file)), `Datei fehlt: ${e.file}`);
  }
  for (const e of list.notControl) {
    assert.ok(['sink', 'read', 'noControl'].includes(e.why) && e.note, `Begründung fehlt: ${entryKey(e)}`);
    assert.match(e.sink, AMBIGUOUS_SINKS, `${entryKey(e)}: eine Schreibfunktion ist nie „kein Steuerbefehl“`);
  }
  // Alle acht Schreibpfade der D.1-Inventur sind vertreten (Pfad 4 läuft über die Sequenz von Pfad 2).
  for (const p of ['#1', '#2', '#3', '#4', '#5', '#6', '#7', '#8']) {
    assert.ok(list.exceptions.some((e) => e.path.split(/[ ,]+/).includes(p)), `D.1 Pfad ${p} fehlt in der Liste`);
  }
  // Pfad 7 (Außen-Wächter) bleibt laut D.1 dauerhaft außerhalb; nur er darf `permanent` sein.
  assert.deepEqual(list.exceptions.filter((e) => e.permanent).map((e) => e.path), ['D.1 #7']);
});
