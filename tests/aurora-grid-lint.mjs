#!/usr/bin/env node
/*
 * tests/aurora-grid-lint.mjs — static Aurora grid invariant lint (Plan 09.3-01 D-24).
 *
 * Bans bare `repeat(N, 1fr)` (without `minmax(0, …)`) in the per-page CSS files
 * that ship under Phase 09.3 (history-viz.css today; future phases extend this
 * list as new per-page Aurora CSS lands).
 *
 * The phase-09.1 `.continue-here.md` Anti-Pattern entry: German compound labels
 * (e.g. "Direktvermarktungs-Verfügbarkeit") overflowed grid tracks because bare
 * `1fr` lets a single oversized cell push the whole row past the viewport. Aurora
 * grids therefore require `repeat(N, minmax(0, 1fr))` PLUS `> * { min-width: 0 }`
 * so the track collapses to fit content.
 *
 * SCOPE NOTE: this lint deliberately scopes itself to NEW Phase 09.3+ files. The
 * pre-existing CSS files (dvhub-app.css, history.css, family.css, settings.css,
 * setup.css, integrations.css, index.css) carry legacy `repeat(N, 1fr)` rules
 * that pre-date this invariant. Retroactively rejecting them is out of scope for
 * Phase 09.3 — those rules will be migrated when the page they style is touched.
 *
 * To opt a future file in, append it to AURORA_GRID_FILES.
 *
 * Allow-override: append `/* aurora-grid-lint:allow * /` (without spaces) on the
 * SAME line as the offending rule to skip it.
 *
 * Usage:
 *   node tests/aurora-grid-lint.mjs
 *
 * Exits 0 when clean; exits 1 with `FAIL: file:line: rule` lines on stderr otherwise.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(repoRoot, 'dvhub', 'public');

// Files in scope for the Aurora grid invariant. Add new per-page Aurora CSS
// here as future phases land. Each file is OPTIONAL — missing files are skipped
// (Wave 1 ships history-viz.css in Task 2; Task 1 leaves the lint live so
// subsequent tasks cannot regress).
const AURORA_GRID_FILES = [
  'history-viz.css',
];

const BARE_1FR_RE = /repeat\(\s*\d+\s*,\s*1fr\s*\)/;
const ALLOW_TAG = 'aurora-grid-lint:allow';

let scanned = 0;
let failures = 0;
const failureLines = [];

for (const fname of AURORA_GRID_FILES) {
  const fpath = path.join(publicDir, fname);
  if (!fs.existsSync(fpath)) continue; // not yet shipped — skip
  scanned++;
  const src = fs.readFileSync(fpath, 'utf8');
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes(ALLOW_TAG)) continue;
    if (BARE_1FR_RE.test(line)) {
      failures++;
      failureLines.push(`FAIL: dvhub/public/${fname}:${i + 1}: bare repeat(N, 1fr) detected — use repeat(N, minmax(0, 1fr)) + > * { min-width: 0 } (D-24)`);
    }
  }
}

if (failures > 0) {
  for (const line of failureLines) console.error(line);
  console.error(`aurora-grid-lint: FAIL — ${failures} violation(s) across ${scanned} file(s)`);
  process.exit(1);
}
console.log(`aurora-grid-lint: OK (${scanned} file(s) scanned)`);
process.exit(0);
