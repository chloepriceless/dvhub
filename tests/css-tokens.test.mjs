// tests/css-tokens.test.mjs — assert Aurora design tokens present in dvhub-app.css (AURORA-01).
//
// Gates the design-token surface that ported pages depend on. Runs from the repo
// root (path is relative). Fails with ENOENT until Task 2 of Plan 09.1-01 ships
// dvhub/public/dvhub-app.css — by design.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const css = readFileSync('dvhub/public/dvhub-app.css', 'utf8');

for (const tok of ['--bg-0', '--text', '--aurora', '--cyan', '--red', '--yellow']) {
  assert.ok(css.includes(tok), `missing token: ${tok}`);
}

assert.ok(
  css.includes("[data-theme='light']") || css.includes('[data-theme="light"]'),
  'light-theme block missing'
);

console.log('css-tokens: OK');
