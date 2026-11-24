// test/eos-localnative-compose.test.js — Compose-Überlagerung für den
// local-native-EOS (docker/compose.eos-localnative.yml, 1.0.11). Geprüft wird,
// dass die Umstellung den Dienst auf das Binär `dvhub-optimize serve` unter dem
// UNVERÄNDERTEN Wächter setzt (Neustart-Weg bleibt), das native Image nimmt und
// den Python-Weg der Basis nicht verändert (Rückweg). Ohne YAML-Abhängigkeit —
// String-Prüfung wie eos-watch-compose.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const base = fs.readFileSync(fileURLToPath(new URL('../../docker/compose.yml', import.meta.url)), 'utf8');
const over = fs.readFileSync(fileURLToPath(new URL('../../docker/compose.eos-localnative.yml', import.meta.url)), 'utf8');

// Die command:-Flow-Liste (über mehrere Zeilen) als Token-Array einlesen.
function commandTokens(yaml) {
  const i = yaml.indexOf('command:');
  assert.ok(i >= 0, 'command: fehlt');
  const open = yaml.indexOf('[', i);
  const close = yaml.indexOf(']', open);
  assert.ok(open >= 0 && close > open, 'command:-Liste nicht gefunden');
  return yaml.slice(open + 1, close).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

test('Überlagerung fährt dvhub-optimize serve unter dem Wächter', () => {
  const cmd = commandTokens(over);
  // Wächter zuerst, dann als Kind (nach --) das native Binär.
  assert.deepEqual(cmd.slice(0, 3), ['python', '/dvhub-eos-watch.py', '--'],
    'Wächter muss der Hauptprozess bleiben (Neustart-Weg)');
  const sep = cmd.indexOf('--');
  const child = cmd.slice(sep + 1);
  assert.equal(child[0], 'dvhub-optimize', 'Kindprozess ist das native Binär');
  assert.equal(child[1], 'serve');
  assert.ok(child.includes('--listen'), '--listen gesetzt');
  assert.ok(child.some((t) => t.includes('127.0.0.1:')), 'lauscht nur auf 127.0.0.1');
  assert.ok(child.includes('--state-dir') && child.includes('/data'),
    '--state-dir /data (gemeinsamer Zustand mit Python-EOS)');
  // Kein Python-EOS mehr im Kind.
  assert.ok(!child.some((t) => t.includes('akkudoktoreos')), 'kein Python-EOS im Kind');
});

test('Überlagerung nimmt das local-native-Image und baut nicht versehentlich Python-EOS', () => {
  assert.match(over, /image:\s*\$\{EOS_LOCALNATIVE_IMAGE:-[^}]*dvhub-eos-localnative\}/,
    'Image zeigt auf dvhub-eos-localnative');
  assert.match(over, /build:\s*!reset\s+null/,
    'build: !reset null — kein versehentlicher Python-Bau in den local-native-Tag');
});

test('mem_limit deutlich kleiner als der Python-Weg (320m)', () => {
  const m = over.match(/mem_limit:\s*\$\{[^:]*:-(\d+)m\}/);
  assert.ok(m, 'mem_limit mit Vorgabe gesetzt');
  assert.ok(Number(m[1]) < 320, `mem_limit-Vorgabe ${m[1]}m muss < 320m sein`);
});

test('Basis bleibt Python-EOS (Rückweg unverändert) und behält den Wächter', () => {
  // Default-Dienst der Basis fährt weiter Python-EOS …
  assert.match(base, /akkudoktoreos\.server\.eos/, 'Basis-command bleibt Python-EOS');
  // … und die Überlagerung definiert den Wächter NICHT neu (erbt den Mount),
  // damit das Wächter-Skript die einzige Quelle bleibt (eos-watch-compose.test.js).
  assert.ok(base.includes('  dvhub-eos-watch:'), 'configs.dvhub-eos-watch in der Basis');
  assert.ok(!over.includes('content: |'), 'Überlagerung bettet kein zweites Wächter-Skript ein');
});
