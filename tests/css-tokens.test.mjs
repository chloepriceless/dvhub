// tests/css-tokens.test.mjs — assert Aurora design tokens present in dvhub-app.css (AURORA-01).
//
// Gates the design-token surface that ported pages depend on. The target CSS is
// resolved relative to this file's own location, so the test runs identically
// from the repo root AND from dvhub/ (the cwd `npm test` uses).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { strict as assert } from 'node:assert';

// __dirname is <repo>/tests — the CSS lives at <repo>/dvhub/public/dvhub-app.css.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(repoRoot, 'dvhub/public/dvhub-app.css'), 'utf8');

for (const tok of ['--bg-0', '--text', '--aurora', '--cyan', '--red', '--yellow']) {
  assert.ok(css.includes(tok), `missing token: ${tok}`);
}

assert.ok(
  css.includes("[data-theme='light']") || css.includes('[data-theme="light"]'),
  'light-theme block missing'
);

console.log('css-tokens: OK');
