// test/node-version-contract.test.js — Node-Basisversion an einer Stelle halten.
// package.json engines, die Schwelle in install.sh und die CI-Version müssen
// dieselbe Hauptversion nennen. Anlass (Codex-Review 2026-09-29): engines sagte
// >=18, die Test-Flags (--test-timeout/--test-force-exit) und Tests
// (import.meta.dirname) brauchen aber >=20.11/22 — npm test brach auf Node 18.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

// Seit 2026-10-15 ist `.node-version` die Quelle; die CI liest sie
// (node-version-file), das Docker-Image und install.sh müssen sie treffen.
test('engines, install.sh, Dockerfile und CI nennen dieselbe Node-Hauptversion wie .node-version', () => {
  const major = Number(read('../../.node-version').trim().replace(/^v/, '').split('.')[0]);
  assert.ok(major >= 22, `.node-version ${major}`);
  const engines = JSON.parse(read('../package.json')).engines.node;
  assert.equal(Number(/>=\s*(\d+)/.exec(engines)?.[1]), major, `engines ${engines}`);
  const install = read('../../install.sh');
  const threshold = Number(/process\.versions\.node\.split\("\."\)\[0\]\) >= (\d+)/.exec(install)?.[1]);
  assert.equal(threshold, major, 'install.sh aktualisiert Node unterhalb der engines-Version');
  assert.match(install, new RegExp(`setup_${major}\\.x`), 'install.sh installiert dieselbe Hauptversion');
  const docker = /^ARG NODE_VERSION=(\d+)/m.exec(read('../../Dockerfile'));
  assert.equal(Number(docker?.[1]), major, 'Dockerfile ARG NODE_VERSION');
  const ci = read('../../.github/workflows/ci.yml');
  const fixed = [...ci.matchAll(/^\s*node-version:\s*(\S+)/gm)].map((m) => m[1]);
  assert.deepEqual(fixed, [], 'CI ohne feste node-version');
  assert.match(ci, /node-version-file:\s*\.node-version/, 'CI liest .node-version');
  const portal = JSON.parse(read('../../installer-portal/package.json')).engines.node;
  assert.equal(Number(/>=\s*(\d+)/.exec(portal)?.[1]), major, 'Portal-engines');
});

test('Node-Laufzeit erfüllt die Test-Flags aus package.json', () => {
  const [maj, min] = process.versions.node.split('.').map(Number);
  assert.ok(maj > 22 || (maj === 22 && min >= 0), `Node ${process.versions.node} < 22`);
});
