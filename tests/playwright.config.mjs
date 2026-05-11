// tests/playwright.config.mjs — Playwright bootstrap for Phase 09.1 visual-parity suite.
//
// Per-page specs ship with their respective wave plans (Wave 1 ships
// visual-parity/family.spec.mjs, Wave 2 ships history.spec.mjs, etc.). This
// Wave-0 config provides the runner skeleton so subsequent waves don't need to
// re-bootstrap. Run via `npm run test:e2e` from dvhub/ (the script is wired in
// dvhub/package.json).

import { defineConfig } from '@playwright/test';

// Plan 09.1-02 Task 2 finding (Rule 1 deviation): the dvhub dev server defaults to
// :8080 (see dvhub/server.js Web server listening on :8080), but the original
// Wave-0 config hardcoded :3000 from the planner's spec. Honour PLAYWRIGHT_BASE_URL
// when set, else default to the server's actual listen port so `npm run test:e2e`
// works without manual env-var nudging. Operators may still override via env.
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:8080';

export default defineConfig({
  testDir: './visual-parity',
  use: {
    baseURL: BASE_URL,
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
  },
  reporter: 'list',
  retries: 0,
});
