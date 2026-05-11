// tests/playwright.config.mjs — Playwright bootstrap for Phase 09.1 visual-parity suite.
//
// Per-page specs ship with their respective wave plans (Wave 1 ships
// visual-parity/family.spec.mjs, Wave 2 ships history.spec.mjs, etc.). This
// Wave-0 config provides the runner skeleton so subsequent waves don't need to
// re-bootstrap. Run via `npm run test:e2e` from dvhub/ (the script is wired in
// dvhub/package.json).

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './visual-parity',
  use: {
    baseURL: 'http://localhost:3000',
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
  },
  reporter: 'list',
  retries: 0,
});
