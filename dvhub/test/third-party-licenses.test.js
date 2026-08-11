import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// dvhub/test/ -> repo root is two levels up.
const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const src = fs.readFileSync(path.join(repoRoot, 'THIRD-PARTY-LICENSES.md'), 'utf8');

test('THIRD-PARTY header is bumped to DVhub-Version 1.0.0', () => {
  assert.match(src, /1\.0\.0/, 'attribution header must mention version 1.0.0');
  assert.doesNotMatch(
    src,
    /DVhub-Version 0\.8\.0/,
    'attribution header must no longer read the frozen 0.8.0 version'
  );
});

test('THIRD-PARTY keeps the 4-source structure (npm + 3 manual sections)', () => {
  // The npm table is tool-generated; Python / Frontend / Systemsoftware are
  // partly manual and MUST survive a regeneration (Pitfall 4).
  assert.match(
    src,
    /requirements\.txt/,
    'Python section anchor (requirements.txt) must be preserved'
  );
  assert.match(
    src,
    /public\//,
    'Frontend section anchor (public/) must be preserved'
  );
  assert.match(
    src,
    /install\.sh/,
    'Systemsoftware section anchor (install.sh) must be preserved'
  );
});

test('THIRD-PARTY npm table still lists multiple production packages', () => {
  // Structural guard against a collapsed regen: count the npm attribution rows
  // (| `pkg` | version | copyright |). Keep this a floor, not a hardcoded list,
  // so the test survives future dependency churn.
  const pkgRows = src
    .split('\n')
    .filter((line) => /^\|\s*`[^`]+`\s*\|\s*\d/.test(line));
  assert.ok(
    pkgRows.length > 50,
    `npm attribution table must list many packages, found ${pkgRows.length}`
  );
});
