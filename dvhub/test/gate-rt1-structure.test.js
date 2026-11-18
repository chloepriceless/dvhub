// R-T1 Strukturtest im Berichtsmodus (VCL-Vertrag v6 D.1): „Die Senken sind nur noch aus dem Tor erreichbar … Bis
// alle acht Pfade umgestellt sind, zählt jeder verbleibende Direktaufruf als bekannte Ausnahme in einer
// eingecheckten Liste, die nur kürzer werden darf.“
//
// Berichtsmodus heißt: die heutigen Direktaufrufe sind erlaubt, solange sie in services/gate/rt1-direct-writes.json
// stehen — je (Datei, Funktion, Senke) mit der Zahl der Aufrufstellen. Der Test bricht, wenn
//   • eine NEUE Schreibstelle an einer Senke auftaucht, die in keiner Liste steht,
//   • in einer gelisteten Funktion MEHR Aufrufstellen stehen als eingetragen,
//   • ein Eintrag nicht mehr (oder seltener) gefunden wird (Pfad umgestellt → Eintrag löschen bzw. Zahl senken),
//   • die Ausnahmeliste über ihre Obergrenzen wächst.
// Funde ansehen: node test/helpers/sink-call-scan.js

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { DVHUB_DIR, scanProduction, scanSource, entryKey } from './helpers/sink-call-scan.js';

// Obergrenzen der Ausnahmeliste: Einträge und Aufrufstellen insgesamt. Dürfen NUR sinken: wer einen Pfad aufs Tor
// umstellt, löscht den Eintrag (bzw. senkt dessen count) und senkt diese Zahlen. Eine neue Ausnahme ist kein
// Nachtrag hier, sondern ein Schreibweg am Tor vorbei.
// Phase 2 (feat/vcl-tor-p2): Sungrow writeReg (D.1 #6) über das Tor → 55/65 auf 48/51.
// Phase 3 (feat/vcl-tor-p3a): runDvControlSequence (D.1 #2/#4) → 46/49; zfiWrite (D.1 #5) → 45/48;
// applyDvVictronControl (D.1 #3) → 43/44.
// Phase 3b (feat/vcl-tor-p3b): applyControlTargetCore (D.1 #1) → 40/41; zweite GX (D.1 #8) → 39/40.
const MAX_EXCEPTIONS = 39;
const MAX_EXCEPTION_SITES = 40;

// Nur diese Bausteine sind mehrdeutig (Steuerbefehl oder nicht); eine Modbus-/MQTT-Schreibfunktion oder writeReg
// ist immer ein Schreibweg und darf nie als „kein Steuerbefehl“ eingetragen werden.
const AMBIGUOUS_SINKS = /^(publish|send|http|stdin\.write|pickup:.+)$/;
// Herkunft je Ausnahme: einer der acht D.1-Pfade, die Geräteadapter-Zeile von D.1 oder der Abholpfad (R-T3).
const PATH_LABEL = /^D\.1 (#[1-8](, #[1-8])*|Geräte \(.+\)|R-T3 \(.+\))$/;

const LIST_PATH = path.join(DVHUB_DIR, 'services', 'gate', 'rt1-direct-writes.json');
const list = JSON.parse(fs.readFileSync(LIST_PATH, 'utf8'));
const found = scanProduction();
const foundByKey = new Map(found.map((e) => [entryKey(e), e]));
const listed = new Map([...list.exceptions, ...list.notControl].map((e) => [entryKey(e), e]));

test('Scanner erkennt die Senken-Bausteine, ordnet sie der benannten Funktion zu und zählt Aufrufstellen', () => {
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
      async function twice(a) { await t.mbWriteSingle(a); if (a.x) await t.mbWriteSingle({ ...a, value: 0 }); }
      return { writeIt, viaArrow, relay, mirror, cap, patch, later, twice, mbWriteCoil };
    }
  `;
  const got = scanSource(src).map((f) => `${f.fn} :: ${f.sink} ×${f.count}`).sort();
  assert.deepEqual(got, [
    'createThing :: mbWriteCoil ×1',
    'createThing>later :: writeReg ×1',
    'createThing>mirror :: pickup:buildControlSnapshot ×1',
    'createThing>mirror :: publish ×1',
    'createThing>relay :: mqttWrite ×1',
    'createThing>twice :: mbWriteSingle ×2',
    'createThing>viaArrow :: mbWriteMultiple ×1',
    'createThing>writeIt :: mbWriteSingle ×1',
  ]);
  // HTTP, WebSocket und EEBUS-Brücke nur in Geräteadaptern (sonst wäre jeder Preis-Abruf ein Fund).
  const http = 'function get(u) { return fetch(u); } function s(ws) { ws.send("x"); } function e(c) { c.stdin.write("x"); }';
  assert.deepEqual(scanSource(http), []);
  assert.deepEqual(scanSource(http, { deviceScope: true }).map((f) => `${f.fn} :: ${f.sink}`).sort(), ['e :: stdin.write', 'get :: http', 's :: send']);
});

test('R-T1: jede Schreibstelle an einer Senke außerhalb des Tors steht in der Liste — mit ihrer Zahl von Aufrufstellen', (t) => {
  const unlisted = found.filter((e) => !listed.has(entryKey(e)));
  assert.deepEqual(unlisted.map(entryKey), [],
    'Neue Schreibstelle(n) an einer Senke außerhalb von services/gate/. Schreiben gehört über gate.submit() '
    + '(D.1 R-T1). Ist es nachweislich KEIN Steuerbefehl (Lesen, Konfiguration, Senke selbst), mit Begründung in '
    + 'services/gate/rt1-direct-writes.json unter notControl eintragen.');
  const more = found.filter((e) => listed.has(entryKey(e)) && e.count > listed.get(entryKey(e)).count);
  assert.deepEqual(more.map((e) => `${entryKey(e)}: ${listed.get(entryKey(e)).count} → ${e.count}`), [],
    'Zusätzliche Direktaufrufe in einer schon gelisteten Funktion — auch sie gehören über gate.submit().');
  const sites = list.exceptions.reduce((n, e) => n + e.count, 0);
  const byPath = {};
  for (const e of list.exceptions) byPath[e.path] = (byPath[e.path] || 0) + e.count;
  t.diagnostic(`R-T1 Bericht: ${list.exceptions.length} bekannte Direktaufruf-Stellen in Funktionen (${sites} Aufrufe; `
    + `Obergrenzen ${MAX_EXCEPTIONS}/${MAX_EXCEPTION_SITES}), ${list.notControl.length} geprüfte Nicht-Steuer-Stellen`);
  for (const [p, n] of Object.entries(byPath).sort()) t.diagnostic(`  ${p}: ${n}`);
});

test('R-T1: die Liste wird nur kürzer — kein Eintrag ohne bzw. mit weniger Funden, Ausnahmen unter den Obergrenzen', () => {
  const stale = [...listed.values()].filter((e) => (foundByKey.get(entryKey(e))?.count ?? 0) < e.count);
  assert.deepEqual(stale.map((e) => `${entryKey(e)}: ${e.count} → ${foundByKey.get(entryKey(e))?.count ?? 0}`), [],
    'Eintrag mit weniger Funden: der Pfad läuft (teilweise) über das Tor oder wurde umbenannt. Eintrag löschen bzw. '
    + 'count senken (oder Namen nachziehen) und bei Ausnahmen die Obergrenzen senken.');
  assert.ok(list.exceptions.length <= MAX_EXCEPTIONS,
    `Ausnahmeliste gewachsen (${list.exceptions.length} > ${MAX_EXCEPTIONS}) — neue Direktaufrufe sind nicht erlaubt`);
  const sites = list.exceptions.reduce((n, e) => n + e.count, 0);
  assert.ok(sites <= MAX_EXCEPTION_SITES, `Aufrufstellen gewachsen (${sites} > ${MAX_EXCEPTION_SITES})`);
});

test('R-T1: Listeneinträge sind eindeutig, vollständig und richtig eingeordnet', () => {
  const all = [...list.exceptions, ...list.notControl];
  assert.equal(listed.size, all.length, 'doppelter Eintrag');
  for (const e of all) {
    assert.ok(e.file && e.fn && e.sink && e.note && Number.isInteger(e.count) && e.count >= 1, `unvollständig: ${entryKey(e)}`);
    assert.ok(fs.existsSync(path.join(DVHUB_DIR, e.file)), `Datei fehlt: ${e.file}`);
  }
  for (const e of list.exceptions) assert.match(e.path, PATH_LABEL, `Herkunft unklar: ${entryKey(e)}`);
  for (const e of list.notControl) {
    assert.ok(['sink', 'read', 'noControl'].includes(e.why), `Begründung fehlt: ${entryKey(e)}`);
    assert.match(e.sink, AMBIGUOUS_SINKS, `${entryKey(e)}: eine Schreibfunktion ist nie „kein Steuerbefehl“`);
  }
  // Pfad 7 (Außen-Wächter) bleibt laut D.1 dauerhaft außerhalb; nur er darf `permanent` sein.
  for (const e of list.exceptions.filter((x) => x.permanent)) assert.equal(e.path, 'D.1 #7', entryKey(e));
});
