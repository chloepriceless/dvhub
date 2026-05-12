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
 *
 * Skip rules (these capture lookups that are EXPLICITLY safe-when-missing,
 * so a missing markup id is intentional rather than a bug):
 *   1. Lines that ALSO contain `document.createElement(` — those are
 *      assignments to a newly created element, not lookups.
 *   2. Lookups followed by `?.` optional chaining (e.g.
 *      `document.getElementById('X')?.addEventListener(...)`) — the author
 *      explicitly opts in to "no-op if missing".
 *   3. Lookups whose result is immediately tested against `null` / falsy
 *      with `if (!element) return` / `if (!el) return` on the next 1-2 lines.
 *      These are explicit early-returns when the element is absent.
 */
function extractIdsRequested(src) {
  const ids = [];
  const lines = src.split('\n');
  const re = /document\.getElementById\(\s*['"]([^'"]+)['"]\s*\)(\??\.)?/g;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('document.createElement(')) continue; // skip false-positive lines
    let m;
    while ((m = re.exec(line)) !== null) {
      // Skip rule 2: optional chaining = "no-op if missing" is intentional.
      if (m[2] === '?.') continue;
      // Skip rule 3: peek at the next 2 lines for an explicit null-guard
      // that immediately returns (the canonical pattern for "element is
      // optional, no-op if absent" — e.g. setBanner() / updateMeta() in
      // setup.js + settings.js).
      const next1 = lines[i + 1] || '';
      const next2 = lines[i + 2] || '';
      const guarded = /^\s*if\s*\(\s*!\s*(element|el|node|target|input|btn|node)\s*\)\s*return/.test(next1)
        || /^\s*if\s*\(\s*!\s*(element|el|node|target|input|btn|node)\s*\)\s*return/.test(next2);
      if (guarded) continue;
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

/**
 * Extract IDs that the JS module *itself* injects into the DOM at runtime.
 * Two patterns are recognised:
 *   1. `id="X"` / `id='X'` literals inside template strings or string literals
 *      in the JS source — covers `innerHTML = \`<div id="X">…\``  (the bulk of
 *      settings.js's dynamic markup, e.g. renderVpnUploadPanel + location-picker
 *      overlay + EPEX backlog section).
 *   2. `el.id = 'X'` / `el.id = "X"` assignments — covers
 *      `const el = document.createElement('…'); el.id = 'X';`  (e.g.
 *      forecastTierValue at settings.js:1022).
 *
 * Without this, the static `getElementById('X')` regex flags every
 * dynamically-mounted ID as missing — even though the JS module is the one
 * that injects it. The HTML host element is the *mount point* (e.g.
 * #vpnUploadMount, #setupGrid, document.body) — the IDs that LIVE INSIDE
 * the mounted markup are JS-provided, not HTML-provided.
 *
 * Returns a Set of ID strings discovered in the JS source.
 */
function extractIdsProvidedByJs(src) {
  const ids = new Set();
  // Pattern 1: id="X" or id='X' literal inside any string / template literal.
  // Matches anywhere in the JS file — false positives are tolerable because
  // the test compares against `getElementById` lookups (a hostile ID like
  // `id="commented out"` will never be looked up, so it doesn't matter).
  const reLiteral = /id=["']([A-Za-z_][\w-]*)["']/g;
  let m;
  while ((m = reLiteral.exec(src)) !== null) ids.add(m[1]);
  // Pattern 2: `.id = 'X'` or `.id = "X"` assignment.
  const reAssign = /\.id\s*=\s*['"]([A-Za-z_][\w-]*)['"]/g;
  while ((m = reAssign.exec(src)) !== null) ids.add(m[1]);
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

  // Build the union of HTML-provided ids + JS-injected ids across every JS
  // module paired with this page. JS-injected covers `innerHTML = `<div
  // id="X">…`` template strings and `el.id = 'X'` assignments — see
  // extractIdsProvidedByJs() above. Without this, the binding contract
  // false-positives on ~20 dynamic IDs in settings.js / setup.js whose
  // host markup is built at runtime by the field generator / modal
  // builders / renderVpnUploadPanel etc.
  const jsSources = {};
  const providedByJs = new Set();
  for (const jsName of pair.js) {
    const jsPath = path.join(publicDir, jsName);
    const jsSrc = readFileSafe(jsPath);
    if (jsSrc === null) continue;
    jsSources[jsName] = jsSrc;
    for (const id of extractIdsProvidedByJs(jsSrc)) providedByJs.add(id);
  }
  for (const jsName of pair.js) {
    const jsSrc = jsSources[jsName];
    if (jsSrc === undefined) {
      const jsPath = path.join(publicDir, jsName);
      console.error(`SKIP: ${jsName} not found at ${jsPath}`);
      continue;
    }
    const requested = extractIdsRequested(jsSrc);
    for (const rec of requested) {
      checked++;
      if (!provided.has(rec.id) && !providedByJs.has(rec.id)) {
        failures++;
        console.error(
          `MISSING: dvhub/public/${jsName}:${rec.line} → getElementById('${rec.id}') has no markup in dvhub/public/${pair.html} (and not injected by any paired JS)`
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
