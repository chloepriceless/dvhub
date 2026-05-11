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

if (failures > 0) {
  console.error(`csp-lint: FAIL — ${failures} violation(s) across ${scanned} file(s)`);
  process.exit(1);
}
console.log(`csp-lint: OK (${scanned} file(s) clean)`);
process.exit(0);
