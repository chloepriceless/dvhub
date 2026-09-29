// test/node-version-contract.test.js — Node-Basisversion an einer Stelle halten.
// package.json engines, die Schwelle in install.sh und die CI-Version müssen
// dieselbe Hauptversion nennen. Anlass (Codex-Review 2026-09-29): engines sagte
// >=18, die Test-Flags (--test-timeout/--test-force-exit) und Tests
// (import.meta.dirname) brauchen aber >=20.11/22 — npm test brach auf Node 18.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

test('engines, install.sh und CI nennen dieselbe Node-Hauptversion', () => {
  const engines = JSON.parse(read('../package.json')).engines.node;
  const major = Number(/>=\s*(\d+)/.exec(engines)?.[1]);
  assert.ok(major >= 22, `engines ${engines}`);
  const install = read('../../install.sh');
  const threshold = Number(/process\.versions\.node\.split\("\."\)\[0\]\) >= (\d+)/.exec(install)?.[1]);
  assert.equal(threshold, major, 'install.sh aktualisiert Node unterhalb der engines-Version');
  assert.match(install, new RegExp(`setup_${major}\\.x`), 'install.sh installiert dieselbe Hauptversion');
  const ci = read('../../.github/workflows/ci.yml');
  const ciVersions = [...ci.matchAll(/node-version:\s*(\d+)/g)].map((m) => Number(m[1]));
  assert.ok(ciVersions.length && ciVersions.every((v) => v === major), `CI: ${ciVersions}`);
  const portal = JSON.parse(read('../../installer-portal/package.json')).engines.node;
  assert.equal(Number(/>=\s*(\d+)/.exec(portal)?.[1]), major, 'Portal-engines');
});

test('Node-Laufzeit erfüllt die Test-Flags aus package.json', () => {
  const [maj, min] = process.versions.node.split('.').map(Number);
  assert.ok(maj > 22 || (maj === 22 && min >= 0), `Node ${process.versions.node} < 22`);
});
