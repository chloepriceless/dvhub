#!/usr/bin/env node
/*
 * tests/node-version-drift.mjs — läuft als Erstes in `npm test` (2026-10-15).
 *
 * Bricht ab, wenn der Testlauf nicht unter der Node-Hauptversion aus
 * `.node-version` läuft — derselben wie Docker-Image, native Installation und
 * CI (die Dateien selbst prüft test/node-version-contract.test.js). Sonst ist
 * „lokal grün“ nichts wert: Am 14.10.2026 lief lokal Node 26, die CI mit
 * Node 22 scheiterte an `node --test <ordner>` (25b54961).
 *
 * macOS mit Homebrew: PATH=/opt/homebrew/opt/node@22/bin:$PATH npm test
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const want = readFileSync(join(repoRoot, '.node-version'), 'utf8').trim().replace(/^v/, '').split('.')[0];
const running = process.versions.node.split('.')[0];
if (running !== want) {
  console.error(`node-version-drift: Testlauf unter Node ${process.versions.node}, Betrieb und CI unter Node ${want}.`);
  console.error(`  macOS/Homebrew: PATH=/opt/homebrew/opt/node@${want}/bin:$PATH npm test`);
  process.exit(1);
}
console.log(`node-version-drift: OK (Testlauf ${process.versions.node}, .node-version ${want})`);
