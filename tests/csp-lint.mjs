#!/usr/bin/env node
/*
 * tests/csp-lint.mjs — static CSP lint (AURORA-05, T-09.1-01-01).
 *
 * Production CSP (routes-api.js#SECURITY_HEADERS) allows:
 *   script-src 'self' https://unpkg.com/swagger-ui-dist@5.11.0/ https://unpkg.com/leaflet@1.9.4/
 *   style-src  'self' 'unsafe-inline' …  (← 'unsafe-inline' targeted for removal in Plan 09.1-07)
 *
 * To make the eventual style-src tightening safe, this lint fails NOW on:
 *   1. <script>…</script> bodies WITHOUT a src= attribute (truly-inline script)
 *   2. inline `style="…"` attributes
 *   3. on*= event-handler attributes (onclick=, onload=, …)
 *
 * Permitted (CSP `style-src 'self'` allows same-origin style blocks):
 *   - `<style>…</style>` blocks (an entire <style> element is allowed under style-src 'self')
 *
 * Usage:
 *   node tests/csp-lint.mjs                # scan all dvhub/public/*.html
 *   node tests/csp-lint.mjs --page family  # scan only family.html
 *
 * Exits 0 when clean; exits 1 with per-violation `FAIL: file:line: reason` lines.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(repoRoot, 'dvhub', 'public');

const argv = process.argv.slice(2);
let pageFilter = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--page' && argv[i + 1]) { pageFilter = argv[i + 1]; i++; }
}

function lineNumberAt(src, idx) {
  let line = 1;
  for (let i = 0; i < idx && i < src.length; i++) if (src.charCodeAt(i) === 10) line++;
  return line;
}

/**
 * Find inline <script>…</script> bodies (no src= attr, has non-whitespace body content).
 * Returns array of { line, reason }.
 */
function findInlineScripts(src) {
  const violations = [];
  // Match <script ...> ... </script> non-greedy
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    const attrs = m[1] || '';
    const body = m[2] || '';
    const hasSrc = /\bsrc\s*=\s*["']/i.test(attrs);
    if (hasSrc) continue; // external script, OK
    if (body.trim().length === 0) continue; // empty body, OK
    violations.push({
      line: lineNumberAt(src, m.index),
      reason: `inline <script> body (length=${body.trim().length}); externalise to a .js file referenced via src=`,
    });
  }
  return violations;
}

function findInlineStyles(src) {
  const violations = [];
  const re = /\sstyle\s*=\s*["'][^"']*["']/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    violations.push({
      line: lineNumberAt(src, m.index),
      reason: `inline style= attribute`,
    });
  }
  return violations;
}

function findOnHandlers(src) {
  const violations = [];
  // `on<word>=...` (e.g., onclick="...", onload='...'). Require letter after on.
  const re = /\son[a-z]+\s*=\s*["'][^"']*["']/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    violations.push({
      line: lineNumberAt(src, m.index),
      reason: `inline on*= event-handler attribute`,
    });
  }
  return violations;
}

/**
 * Find `el.style.display = ''` (the visibility-clear anti-pattern banned by
 * Phase 09.3 D-25). Allow-override via `csp-lint:allow-display-clear` comment
 * on the SAME line.
 *
 * SCOPE NOTE: applied only to NEW Phase 09.3+ JS files (currently
 * dvhub/public/history-viz.js). The 17 pre-existing call-sites in legacy
 * modules (history.js, app.js, family.js, settings.js, tools.js,
 * leitstand-charts.js) pre-date D-25 and are out of scope for Phase 09.3.
 * They will be migrated when the page they belong to is touched.
 */
function findDisplayClear(src) {
  const violations = [];
  const re = /\.style\.display\s*=\s*['"]['"]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    // Inspect the rest of the line for the allow-override.
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    const lineEnd = src.indexOf('\n', m.index);
    const line = src.slice(lineStart, lineEnd === -1 ? src.length : lineEnd);
    if (line.includes('csp-lint:allow-display-clear')) continue;
    violations.push({
      line: lineNumberAt(src, m.index),
      reason: `el.style.display = '' (visibility-clear anti-pattern; use classList.toggle('viz-hidden-by-view', !visible) per D-25)`,
    });
  }
  return violations;
}

// Files scoped for the D-25 visibility-clear rule. Add new Phase 09.3+ JS
// files here as they ship; legacy modules stay out of scope until their page
// is touched.
const DISPLAY_CLEAR_SCOPE_JS = [
  'history-viz.js',
];

const htmlFiles = fs.readdirSync(publicDir).filter(f => f.endsWith('.html'));
let failures = 0;
let scanned = 0;
for (const f of htmlFiles) {
  if (pageFilter) {
    const base = f.replace(/\.html$/, '');
    if (base !== pageFilter) continue;
  }
  scanned++;
  const src = fs.readFileSync(path.join(publicDir, f), 'utf8');
  const all = [
    ...findInlineScripts(src),
    ...findInlineStyles(src),
    ...findOnHandlers(src),
  ];
  for (const v of all) {
    failures++;
    console.error(`FAIL: dvhub/public/${f}:${v.line}: ${v.reason}`);
  }
}

// --- Phase 09.3-01 rule: D-25 visibility-clear ban (scoped to new files) ---
let jsScanned = 0;
for (const fname of DISPLAY_CLEAR_SCOPE_JS) {
  const fpath = path.join(publicDir, fname);
  if (!fs.existsSync(fpath)) continue; // not shipped yet
  jsScanned++;
  const src = fs.readFileSync(fpath, 'utf8');
  for (const v of findDisplayClear(src)) {
    failures++;
    console.error(`FAIL: dvhub/public/${fname}:${v.line}: ${v.reason}`);
  }
}

// --- Phase 09.3-01 rule: D-21 single-writer policy for localStorage['dvhub.theme'] ---
// Asserts that EXACTLY ONE file under dvhub/public/*.js writes the key
// 'dvhub.theme' to localStorage (theme.js is the sole legitimate writer per
// AURORA-02). A file is considered a "writer" if it contains BOTH:
//   1. a `localStorage.setItem(` call site, and
//   2. the literal string 'dvhub.theme' or "dvhub.theme" anywhere in the file.
// theme.js qualifies (line 6 declares `const KEY = 'dvhub.theme'`, line 47
// calls `localStorage.setItem(KEY, next)`). Any other module that adds either
// pattern alongside a setItem will trip this gate.
//
// Skip this rule if a --page filter is active (the global single-writer count
// is meaningless for a single-page scan).
if (!pageFilter) {
  const SETITEM_RE = /localStorage\.setItem\s*\(/;
  const KEY_LITERAL_RE = /['"]dvhub\.theme['"]/;
  const jsFiles = fs.readdirSync(publicDir).filter(f => f.endsWith('.js'));
  const writers = []; // { file, setItemLine }
  for (const f of jsFiles) {
    const src = fs.readFileSync(path.join(publicDir, f), 'utf8');
    if (!SETITEM_RE.test(src)) continue;
    if (!KEY_LITERAL_RE.test(src)) continue;
    // Locate the first setItem line for the diagnostic.
    const firstSetItem = src.match(/localStorage\.setItem\s*\(/);
    const lineNo = firstSetItem ? lineNumberAt(src, firstSetItem.index) : 1;
    writers.push({ file: f, line: lineNo });
  }
  if (writers.length !== 1) {
    failures++;
    console.error(`FAIL: localStorage['dvhub.theme'] writer count is ${writers.length} (expected EXACTLY 1 per D-21 single-writer / AURORA-02):`);
    for (const w of writers) console.error(`       dvhub/public/${w.file}:${w.line}`);
    if (writers.length === 0) {
      console.error(`       theme.js is the sole legitimate writer; if it was deleted or refactored, restore it.`);
    } else {
      console.error(`       Only theme.js may write the key. Other modules MUST read via document.documentElement.dataset.theme.`);
    }
  }
}

if (failures > 0) {
  console.error(`csp-lint: FAIL — ${failures} violation(s) across ${scanned} html file(s) + ${jsScanned} scoped js file(s)`);
  process.exit(1);
}
console.log(`csp-lint: OK (${scanned} html file(s) clean, ${jsScanned} scoped js file(s) clean)`);
process.exit(0);
