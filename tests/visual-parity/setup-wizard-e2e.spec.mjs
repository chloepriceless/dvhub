// tests/visual-parity/setup-wizard-e2e.spec.mjs — Phase 27 Plan 03.
//
// Setup-wizard HAPPY-PATH e2e. This is the behavioural complement to
// setup.spec.mjs, which is DOM/visual-parity only: that spec asserts ID/CSS
// presence and that /api/config is GET once on load, but it NEVER fills a
// field, NEVER ticks the legal gate, NEVER clicks save, and NEVER POSTs the
// bootstrap. CONTEXT §5 requires a happy-path walk-through so a regression in
// the first-run onboarding wizard (the operator's only path into a fresh
// install) is caught.
//
// What this spec drives (the real bootstrap path, see dvhub/public/setup.js):
//   1. page.goto('/setup.html') + waitForLoadState('networkidle')
//   2. Fill the one required EMPTY transport field — #setup_field_victron_host
//      (the Anlagenadresse). Every other required value (httpPort 8080,
//      modbusListenHost/Port, gridPositiveMeans, schedule.timezone,
//      manufacturer=victron) ships as an effectiveConfig DEFAULT, so the
//      wizard validates with just the plant host filled.
//   3. #legalAck.check() — per the §14a EnWG / EEG legal gate the toggles
//      #allowGridCharge / #allowGridDischarge ship DISABLED + UNCHECKED and
//      are NEVER silently opt-in; the happy path explicitly ticks the ack.
//      (project_grid_charge_legal memory rule.)
//   4. #setupSaveBtn click → saveSetup() POSTs { config } to /api/config with
//      the x-confirm-legal-gate:true header. We waitForResponse on that POST
//      and assert it returns HTTP 200 with { ok:true } — bootstrap succeeded.
//
// Boot strategy (RESEARCH.md Pitfall 5 / Q2 + threat T-27-03): the server is
// booted EXTERNALLY (no webServer block here — that lands in 27-04). It boots
// DB-free via the server.js try/catch (telemetry store DISABLED, still
// listen(:8080)). To never touch operator config/license state, boot it with a
// throwaway DV_APP_CONFIG (absent file → needs-setup) AND a throwaway
// DV_DATA_DIR, e.g.:
//
//   TMP=$(mktemp -d); DV_APP_CONFIG=$TMP/config.json DV_DATA_DIR=$TMP node server.js &
//
// The spec also runs green against the repo's already-valid config.json
// (needsSetup=false): saveSetup() is an overwrite path that POSTs the same
// bootstrap regardless of needs-setup state, so the happy-path assertion holds
// either way. The re-bootstrap idempotency check is a SOFT assertion (it only
// fires when the server reports the config became valid after save, which needs
// the manufacturer profile + persistence present) — never fails the test.
//
// Reuses tests/playwright.config.mjs (baseURL :8080) — NO new config, NO new
// framework, NO webServer block. Requires a dev server on http://localhost:8080.

import { test, expect } from '@playwright/test';

// The wizard generates field input ids via getFieldInputId(path) =
// `setup_field_${path.replace(/[^a-zA-Z0-9]+/g, '_')}` (setup.js). The single
// required EMPTY field in the transport step is victron.host.
const VICTRON_HOST_INPUT_ID = 'setup_field_victron_host';
const PLANT_HOST_VALUE = '192.168.1.99'; // plausible LAN address; never reaches a real device in a DB-free e2e

test.describe('Setup wizard happy-path (fill → legalAck → save → bootstrap)', () => {
  test('completes the first-run bootstrap: fills the plant host, ticks the §14a legal ack, saves, and the /api/config POST succeeds', async ({ page }) => {
    await page.goto('/setup.html');
    await page.waitForLoadState('networkidle');

    // The full e2e suite hammers /api/config from many spec files in
    // parallel; this test's own loadSetup() GET can land on an exhausted
    // per-IP rate bucket (429 "Too many requests", routes-api.js RATE_LIMIT_*
    // — a real, correctly-enforced limit, not a bug). loadSetup() shows a
    // banner and returns before rendering #setupGrid in that case. Retry with
    // a reload — the sliding 60s window drains as other specs finish.
    for (let attempt = 0; attempt < 3; attempt++) {
      const rateLimited = await page.getByText('Too many requests').count();
      if (rateLimited === 0) break;
      await page.waitForTimeout(2000);
      await page.reload();
      await page.waitForLoadState('networkidle');
    }

    // ---- Step 1: the legal gate ships SAFE (project_grid_charge_legal) ----
    // Sanity-guard the precondition the happy-path depends on: the ack is
    // UNCHECKED and both grid toggles are DISABLED until the ack is ticked.
    const legalAck = page.locator('#legalAck');
    await expect(legalAck).toBeAttached();
    expect(await legalAck.evaluate((el) => el.checked), '#legalAck must ship UNCHECKED').toBe(false);
    const allowCharge = page.locator('#allowGridCharge');
    const allowDischarge = page.locator('#allowGridDischarge');
    expect(await allowCharge.evaluate((el) => el.disabled), '#allowGridCharge must ship DISABLED').toBe(true);
    expect(await allowDischarge.evaluate((el) => el.disabled), '#allowGridDischarge must ship DISABLED').toBe(true);

    // ---- Step 2: fill the one required EMPTY wizard field (#setupGrid) ----
    // The wizard only renders the transport step; victron.host is the sole
    // required text field that ships blank. All other required values are
    // effectiveConfig defaults, so this single fill makes the form valid.
    const hostInput = page.locator(`#${VICTRON_HOST_INPUT_ID}`);
    await expect(hostInput, 'the Anlagenadresse field (#setup_field_victron_host) must render inside #setupGrid').toBeVisible();
    await hostInput.fill(PLANT_HOST_VALUE);

    // ---- Step 3: tick the §14a EnWG / EEG legal acknowledgement ----
    // Ticking #legalAck fires the change handler that ENABLES the two grid
    // toggles (wireLegalSection in setup.js). We do NOT tick the toggles — the
    // happy path only needs the ack so the bootstrap POST carries the
    // x-confirm-legal-gate header; the grid toggles stay off by default.
    await legalAck.check();
    expect(await legalAck.evaluate((el) => el.checked), '#legalAck must be checked after .check()').toBe(true);
    // The gate must have UNLOCKED the toggles (proves the change handler ran).
    await expect(allowCharge).toBeEnabled();
    await expect(allowDischarge).toBeEnabled();

    // ---- Step 4: click save and assert the bootstrap POST succeeds ----
    // saveSetup() POSTs { config } to /api/config. Match that exact request
    // (POST + /api/config, NOT the GET on load, NOT /api/config/import).
    const bootstrapResponsePromise = page.waitForResponse(
      (resp) => {
        const url = resp.url();
        return /\/api\/config(\?|$)/.test(url) && resp.request().method() === 'POST';
      },
      { timeout: 15000 },
    );

    await page.locator('#setupSaveBtn').click();

    const bootstrapResponse = await bootstrapResponsePromise;
    expect(bootstrapResponse.status(), 'bootstrap POST /api/config must return HTTP 200').toBe(200);

    const body = await bootstrapResponse.json();
    expect(body.ok, `bootstrap POST must report ok:true — got ${JSON.stringify(body).slice(0, 300)}`).toBe(true);

    // The saved config must carry the plant host we entered (proves the fill
    // flowed through draftConfig → POST body → persisted config), and the
    // legal toggles must NOT have been silently opted-in.
    const savedHost =
      body.effectiveConfig?.victron?.host ?? body.config?.victron?.host;
    expect(savedHost, 'the saved config must carry the entered Anlagenadresse').toBe(PLANT_HOST_VALUE);
    const savedOptimizer = body.effectiveConfig?.optimizer ?? body.config?.optimizer ?? {};
    expect(Boolean(savedOptimizer.allowGridCharge), 'allowGridCharge must NOT be auto-enabled by the happy path').toBe(false);
    expect(Boolean(savedOptimizer.allowGridDischarge), 'allowGridDischarge must NOT be auto-enabled by the happy path').toBe(false);

    // ---- Soft / optional: server-side setup-complete idempotency ----
    // If the booted server has the manufacturer profile + persistence so the
    // config became valid after save (needsSetup→false), a *re-bootstrap*
    // round-trips the same overwrite path and must still succeed (the server
    // never hard-rejects a re-save of an already-valid config; it returns ok
    // with restartRequired flags). This is environment-dependent (PG / profile)
    // so it is a SOFT check — it asserts only when the server reports the
    // post-save validity, and never fails the happy-path otherwise.
    if (body.meta && body.meta.needsSetup === false) {
      const reResp = await page.request.post('/api/config', {
        headers: { 'content-type': 'application/json', 'x-confirm-legal-gate': 'true' },
        data: { config: body.config ?? {} },
      });
      expect(reResp.status(), 'a re-bootstrap of an already-valid config must still return HTTP 200').toBe(200);
      const reBody = await reResp.json();
      expect(reBody.ok, 're-bootstrap must report ok:true (idempotent overwrite)').toBe(true);
    }
  });
});
