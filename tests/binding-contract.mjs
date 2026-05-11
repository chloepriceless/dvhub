#!/usr/bin/env node
/*
 * tests/binding-contract.mjs — static binding-contract gate (AURORA-05, T-09.1-01-01).
 *
 * For each (HTML page, JS module) pair in dvhub/public/, scrape every
 * `document.getElementById('X')` literal from the JS and assert that the X
 * appears as an `id="X"` attribute in the paired HTML. Catches the silent
 * "ID dropped during page port → forever-dead tile" failure mode that the
 * per-widget error boundary CANNOT detect (a missing element produces
 * `null`, which JS code typically guards with `if (el) el.textContent = …`,
 * resulting in a no-op rather than a thrown error).
 *
 * Usage:
 *   node tests/binding-contract.mjs                # check all pairs
 *   node tests/binding-contract.mjs --page family  # check one pair
 *
 * Exits 0 when every requested ID resolves; exits 1 with `MISSING: …` lines on stderr otherwise.
 *
 * Heuristic for false-positives: IDs that appear inside a line that ALSO contains
 * `document.createElement(...)` are skipped (the ID is being assigned to a newly
 * created element, not looked up). This is a conservative regex pass; runtime-generated
 * IDs (settings.js field-generator) are by design out of scope — for those, the
 * binding contract is enforced by the test that exercises the generator, not by this gate.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(repoRoot, 'dvhub', 'public');

// Page → JS module pairing (PATTERNS.md §8).
const PAGES = {
  index:        { html: 'index.html',        js: ['app.js', 'leitstand-charts.js'] },
  family:       { html: 'family.html',       js: ['family.js'] },
  history:      { html: 'history.html',      js: ['history.js'] },
  settings:     { html: 'settings.html',     js: ['settings.js'] },
  setup:        { html: 'setup.html',        js: ['setup.js'] },
  integrations: { html: 'integrations.html', js: ['integrations.js'] },
  explorer:     { html: 'explorer.html',     js: ['explorer.js'] },
};

// CLI flag: --page <name>
const argv = process.argv.slice(2);
let pageFilter = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--page' && argv[i + 1]) { pageFilter = argv[i + 1]; i++; }
}

function readFileSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); }
  catch (err) { return null; }
}

/**
 * Extract `getElementById('X')` / "X" literals from a JS source.
 * Returns array of { id, line } records (line is 1-based).
 * Skips lines that ALSO contain `document.createElement(` — those are assignments,
 * not lookups, and would be false positives.
 */
function extractIdsRequested(src) {
  const ids = [];
  const lines = src.split('\n');
  const re = /document\.getElementById\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('document.createElement(')) continue; // skip false-positive lines
    let m;
    while ((m = re.exec(line)) !== null) {
      ids.push({ id: m[1], line: i + 1 });
    }
  }
  return ids;
}

/**
 * Extract every static `id="X"` / `id='X'` from an HTML source.
 * Returns a Set of ID strings.
 */
function extractIdsProvided(src) {
  const ids = new Set();
  const re = /id=["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(src)) !== null) ids.add(m[1]);
  return ids;
}

let failures = 0;
let checked = 0;

const pageEntries = Object.entries(PAGES);
for (const [pageName, pair] of pageEntries) {
  if (pageFilter && pageFilter !== pageName) continue;

  const htmlPath = path.join(publicDir, pair.html);
  const htmlSrc = readFileSafe(htmlPath);
  if (htmlSrc === null) {
    console.error(`SKIP: ${pair.html} not found at ${htmlPath}`);
    continue;
  }
  const provided = extractIdsProvided(htmlSrc);

  for (const jsName of pair.js) {
    const jsPath = path.join(publicDir, jsName);
    const jsSrc = readFileSafe(jsPath);
    if (jsSrc === null) {
      console.error(`SKIP: ${jsName} not found at ${jsPath}`);
      continue;
    }
    const requested = extractIdsRequested(jsSrc);
    for (const rec of requested) {
      checked++;
      if (!provided.has(rec.id)) {
        failures++;
        console.error(
          `MISSING: dvhub/public/${jsName}:${rec.line} → getElementById('${rec.id}') has no markup in dvhub/public/${pair.html}`
        );
      }
    }
  }
}

if (failures > 0) {
  console.error(`binding-contract: FAIL — ${failures} missing of ${checked} checked`);
  process.exit(1);
}
console.log(`binding-contract: OK (${checked} IDs checked across ${pageFilter ? '1 page' : pageEntries.length + ' pages'})`);
process.exit(0);
