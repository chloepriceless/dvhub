// test/license-whitelist.test.js — Phase 19 Plan 19-01.
//
// Static assertion that services/license/index.js ALLOWED_FEATURES contains
// exactly the 4 slugs needed by Phase 17 (family-dashboard) + Phase 19
// (forecast-inspector-{ml,eos,stage2}). This is the V5 ASVS whitelist that
// prevents log/response injection via the requirePro(featureName) 403 body
// — any new Pro slug MUST be added here BEFORE it is used by a route.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LICENSE_SRC = path.resolve(__dirname, '..', 'services', 'license', 'index.js');

test('ALLOWED_FEATURES set declaration exists', () => {
  const src = fs.readFileSync(LICENSE_SRC, 'utf8');
  const m = src.match(/const\s+ALLOWED_FEATURES\s*=\s*new\s+Set\(\[([\s\S]*?)\]\s*\)/);
  assert.ok(m, 'ALLOWED_FEATURES declaration must exist in services/license/index.js');
});

test('ALLOWED_FEATURES contains family-dashboard (Phase 17)', () => {
  const src = fs.readFileSync(LICENSE_SRC, 'utf8');
  const m = src.match(/const\s+ALLOWED_FEATURES\s*=\s*new\s+Set\(\[([\s\S]*?)\]\s*\)/);
  assert.ok(m);
  assert.match(m[1], /'family-dashboard'/);
});

test('ALLOWED_FEATURES contains forecast-inspector-ml (Phase 19 Plan 19-04)', () => {
  const src = fs.readFileSync(LICENSE_SRC, 'utf8');
  const m = src.match(/const\s+ALLOWED_FEATURES\s*=\s*new\s+Set\(\[([\s\S]*?)\]\s*\)/);
  assert.ok(m);
  assert.match(m[1], /'forecast-inspector-ml'/);
});

test('ALLOWED_FEATURES contains forecast-inspector-eos (Phase 19 Plan 19-05)', () => {
  const src = fs.readFileSync(LICENSE_SRC, 'utf8');
  const m = src.match(/const\s+ALLOWED_FEATURES\s*=\s*new\s+Set\(\[([\s\S]*?)\]\s*\)/);
  assert.ok(m);
  assert.match(m[1], /'forecast-inspector-eos'/);
});

test('ALLOWED_FEATURES contains forecast-inspector-stage2 (Phase 19 Plan 19-06)', () => {
  const src = fs.readFileSync(LICENSE_SRC, 'utf8');
  const m = src.match(/const\s+ALLOWED_FEATURES\s*=\s*new\s+Set\(\[([\s\S]*?)\]\s*\)/);
  assert.ok(m);
  assert.match(m[1], /'forecast-inspector-stage2'/);
});
