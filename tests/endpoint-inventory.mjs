#!/usr/bin/env node
/*
 * tests/endpoint-inventory.mjs — fetch-URL regression gate (AURORA-05, T-09.1-01-08).
 *
 * Catches the silent failure mode where a `/api/*` or `/auth/*` fetch URL is
 * accidentally dropped during a page port (e.g., a feature is removed alongside
 * a markup re-skin). The binding-contract gate cannot detect this; an endpoint
 * deletion produces zero `getElementById` complaints — the feature simply stops
 * being called.
 *
 * Adds are allowed (logged as INFO). Only DROPS fail.
 *
 * Update the baseline by running `node tests/endpoint-inventory.mjs --snapshot`
 * and committing the new tests/endpoint-baseline.json.
 *
 * Usage:
 *   node tests/endpoint-inventory.mjs --snapshot   # write baseline (one-shot)
 *   node tests/endpoint-inventory.mjs --verify     # default; exit 1 on drop, 0 on adds/no-op
 *   node tests/endpoint-inventory.mjs              # alias for --verify
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODE = process.argv[2] || '--verify';
const PUBLIC_DIR = join(repoRoot, 'dvhub', 'public');
const BASELINE = join(repoRoot, 'tests', 'endpoint-baseline.json');

// fetch('/api/...') | fetch("/auth/...") | fetch(`/api/...`)
// Also matches the project's wrapper apiFetch(...) — `[Ff]etch(` is the literal
// suffix shared by both call shapes. Capture path until quote, ${interpolation},
// or whitespace. (Deviation Rule 3: plan-spec regex matched only raw `fetch(`,
// but production code uses apiFetch() in ≥90% of call sites — a literal port
// would yield a 0-URL baseline and a useless gate. See SUMMARY.md.)
//
// Phase 09.2-09 extension: also match downloadServerExport(`/api/...`) — the
// canonical Bearer-protected file-download helper introduced in Plan 09.2-07
// (Pattern A — apiFetch + Blob + a.click). The Plan 09.2-07/08 explorer
// invocations use template literals with `${params.toString()}` interpolation,
// so the captured path includes the trailing `?` (matches the existing baseline
// pattern for /api/history/export?view= etc.).
const FETCH_RE = /(?:[Ff]etch|downloadServerExport)\s*\(\s*['"`](\/(?:api|auth)\/[^'"`${}\s]+)/g;

function extract() {
  const urls = new Set();
  for (const f of readdirSync(PUBLIC_DIR)) {
    if (!f.endsWith('.js')) continue;
    const src = readFileSync(join(PUBLIC_DIR, f), 'utf8');
    for (const m of src.matchAll(FETCH_RE)) urls.add(m[1]);
  }
  return [...urls].sort();
}

const current = extract();

if (MODE === '--snapshot') {
  writeFileSync(BASELINE, JSON.stringify({ urls: current }, null, 2) + '\n');
  console.log(`endpoint-inventory: snapshot wrote ${current.length} URLs to tests/endpoint-baseline.json`);
  process.exit(0);
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(BASELINE, 'utf8')).urls;
} catch (err) {
  console.error(`endpoint-inventory: FAIL — cannot read baseline (${BASELINE}): ${err.message}`);
  console.error('  Run `node tests/endpoint-inventory.mjs --snapshot` to create it.');
  process.exit(1);
}

const baseSet = new Set(baseline);
const curSet = new Set(current);
const dropped = baseline.filter(u => !curSet.has(u));
const added = current.filter(u => !baseSet.has(u));

if (added.length) {
  console.log('endpoint-inventory: NEW endpoints (allowed):');
  for (const u of added) console.log('  ' + u);
}
if (dropped.length) {
  console.error('endpoint-inventory: DROPPED endpoints (regression):');
  for (const u of dropped) console.error('  ' + u);
  process.exit(1);
}

console.log(`endpoint-inventory: OK (${current.length} URLs, ${added.length} added, 0 dropped)`);
process.exit(0);
