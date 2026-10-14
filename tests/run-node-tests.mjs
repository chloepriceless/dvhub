#!/usr/bin/env node
/*
 * tests/run-node-tests.mjs — node --test mit Vollständigkeits-Prüfung und
 * einem gezielten zweiten Anlauf (2026-10-15).
 *
 * Testdateien enden gelegentlich still mitten im Lauf (CI: in 2 von 4 grünen
 * Läufen fehlten 17 bzw. 23 Tests; lokal unter Last family-routes). Ursache
 * ungeklärt; nicht reproduzierbar ohne Last. tests/complete-reporter.mjs
 * erkennt es. Hier: Gab es sonst KEINEN Fehler, laufen genau die betroffenen
 * Dateien noch einmal. Sind sie dann vollständig und grün, gilt der Lauf mit
 * Warnung als bestanden; sonst rot. Ein Abbruch, der jedes Mal kommt (z. B.
 * echtes process.exit im Code), wird so weiter gefunden.
 *
 * Aufruf wie node --test: node ../tests/run-node-tests.mjs [--optionen] dateien…
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const reporter = join(dirname(fileURLToPath(import.meta.url)), 'complete-reporter.mjs');
const args = process.argv.slice(2);
const options = args.filter((a) => a.startsWith('--'));
const files = args.filter((a) => !a.startsWith('--'));
const work = mkdtempSync(join(tmpdir(), 'dvhub-test-run-'));

function run(fileList, label) {
  const report = join(work, `${label}.json`);
  const r = spawnSync(process.execPath, [
    '--test', ...options,
    '--test-reporter=tap', '--test-reporter-destination=stdout',
    `--test-reporter=${reporter}`, '--test-reporter-destination=stderr',
    ...fileList,
  ], { stdio: 'inherit', env: { ...process.env, DVHUB_COMPLETE_REPORT: report } });
  let summary = null;
  try { summary = JSON.parse(readFileSync(report, 'utf8')); } catch { /* kein Bericht */ }
  return { status: r.status ?? 1, summary };
}

let code;
try {
  const first = run(files, 'lauf1');
  const missing = first.summary?.missingFiles || [];
  if (first.summary && first.summary.failed === 0 && missing.length) {
    console.error(`run-node-tests: ${missing.length} Datei(en) still abgebrochen — zweiter Anlauf nur dafür:`);
    for (const f of missing) console.error(`  ${f}`);
    const second = run(missing, 'lauf2');
    if (second.status === 0 && second.summary && !second.summary.missingFiles.length && second.summary.failed === 0) {
      console.error('run-node-tests: WARNUNG — im zweiten Anlauf vollständig und grün. Bestanden, aber der stille Abbruch bleibt zu klären.');
      code = 0;
    } else {
      console.error('run-node-tests: FEHLER — auch im zweiten Anlauf nicht vollständig/grün.');
      code = 1;
    }
  } else {
    code = first.status;
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.exit(code);
