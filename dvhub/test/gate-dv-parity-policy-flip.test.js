// H-1 Phase 3 — Paritätsnachweis mit umgeschalteter Not-Halt-Richtlinie (services/emergency-stop/policy.js
// NOT_HALT_CONTINUES): Eine im Not-Halt weiterlaufende Pflicht-Abregelung (§ 51, Direktvermarkter, feste
// Einspeisegrenze als Regelschleife) muss über das Schreibtor genauso durchgehen wie heute. Ab Werk ist keine Klasse
// eingeschaltet (Christin 10.11.2026) — erreichbar ist der Weg nur über den Schalter in policy.js. Die Richtlinie ist
// eingefroren; darum läuft der Nachweis in einem Kind-Prozess mit Modul-Attrappe (--experimental-test-module-mocks),
// die Szenarien stehen in test/helpers/dv-parity-scenarios.js (flipScenarios), der Vergleich ist derselbe wie in
// test/gate-dv-parity.test.js. DV_PARITY_BASE gilt auch hier (Gegenbeweis gegen die Originaldatei).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const HELPER = path.join(import.meta.dirname, 'helpers', 'dv-parity-policy-flip.mjs');

test('Parität alt ↔ Tor mit weiterlaufender Pflicht-Klasse im Not-Halt (Kind-Prozess)', () => {
  // Ohne NODE_TEST_CONTEXT: sonst meldet der innere Testlauf im Kind-Protokoll des äußeren statt als TAP.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--test', '--test-reporter=tap', HELPER], {
    encoding: 'utf8', cwd: path.join(import.meta.dirname, '..'), env,
  });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.equal(r.status, 0, out);
  const pass = Number(/^# pass (\d+)/m.exec(r.stdout)?.[1] ?? 0);
  assert.match(r.stdout, /^# fail 0$/m, out);
  assert.ok(pass >= 3, `zu wenige Szenarien im Kind-Prozess (${pass})\n${out}`);
});

test('Hilfsdatei ohne Modul-Attrappen-Schalter (z. B. npm run test:all) läuft still durch (Codex a4949f2a P2)', () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', HELPER], {
    encoding: 'utf8', cwd: path.join(import.meta.dirname, '..'), env,
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /^# fail 0$/m);
});
