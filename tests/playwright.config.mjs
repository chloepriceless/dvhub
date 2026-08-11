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
  // Confirmed by isolation (2026-07): with Playwright's default worker count
  // (= CPU cores on the runner) two specs flake under real, correctly
  // enforced rate-limiting/connection contention against the single dev
  // server instance (routes-api.js RATE_LIMIT_MAX_REQUESTS /
  // LAN_RATE_LIMIT_MAX_REQUESTS). --workers=1 was the only setting that made
  // the FULL suite reliably green — 4 workers still reproduced the flake
  // under the full 100+ test load (not just these two specs), so this is a
  // real capacity ceiling of one dev-server instance, not a tunable margin.
  // The suite serialises in ~1-2min either way; reliability over speed here.
  workers: 1,
  // Belt-and-braces on top of the serial run: a transient failure (e.g. a
  // slow first-boot asset fetch) still gets one retry.
  retries: 1,
});
