// tests/visual-parity/setup.spec.mjs — Wave 4 gate (Plan 09.1-05 Task 2).
//
// Asserts the just-ported setup page renders cleanly:
//  - No blocking console / resource errors (benign /api/* auth-gate
//    responses on the dev-server-without-apiToken setup are tolerated;
//    /api/config returns either 200 with the loaded config or a bootstrap
//    needs-setup payload depending on dev state).
//  - All 13 static IDs the markup must carry are present in the DOM.
//  - theme.js IS loaded (setup respects the theme toggle).
//  - AURORA-02 single-writer: setup.js never writes
//    localStorage['dvhub.theme'] — only theme.js does.
//  - styles.css is NOT linked (Wave-4 link migration).
//  - dvhub-app.css + setup.css ARE linked.
//  - **One-shot bootstrap (Phase 08-06):** /api/config is called exactly
//    once during initial page load (no duplicate calls — the wizard
//    state machine fetches config exactly once on init; subsequent reads
//    are from the in-memory setupWizardState draft). Server-side idempotency
//    rejects re-bootstrap when setup.complete=true.
//  - §14a EnWG / EEG legal gate: #legalAck is unchecked by default, and
//    #allowGridCharge + #allowGridDischarge ship disabled — never opt-in
//    silently. (project_grid_charge_legal memory rule.)
//
// Requires a dev server on http://localhost:8080.

import { test, expect } from '@playwright/test';

// All static binding IDs that the ported setup.html must carry.
// 13 IDs (was 14 with menuToggle, which is dropped in the port — setup
// has no top-nav). 1 dynamic ID (#setupMeta) is JS-injected via the
// field-generator template inside #setupGrid; it's covered by the
// binding-contract gate, not here.
const EXPECTED_IDS = [
  'setupProgress',
  'setupBanner',
  'setupGrid',
  'setupLegalSection',
  'setupLegalHeading',
  'legalAck',
  'allowGridCharge',
  'allowGridDischarge',
  'setupImportRow',
  'setupImportLink',
  'setupImportFile',
  'setupSaveBarText',
  'setupSaveBtn',
];

test.describe('Setup page (Aurora Wave 4, AURORA-01/02/03/05/06)', () => {
  test('loads with no blocking console / resource errors', async ({ page }) => {
    const errors = [];
    const failedResources = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const loc = msg.location();
        errors.push({ text: msg.text(), url: (loc && loc.url) || '' });
      }
    });
    page.on('pageerror', (err) => errors.push({ text: String(err), url: '' }));
    page.on('response', (resp) => {
      const status = resp.status();
      if (status >= 400) failedResources.push({ url: resp.url(), status });
    });
    await page.goto('/setup.html');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);
    const benign = /favicon-|apple-touch-icon\.png|manifest\.json|family-scene\.png|\/api\//;
    const blocking = errors.filter((e) => !benign.test(e.url || e.text));
    const blockingTexts = blocking.map((e) => `${e.text}  (url=${e.url || '<none>'})`);
    expect(blocking, blockingTexts.join('\n')).toEqual([]);
    const blockingFailed = failedResources.filter((r) => !benign.test(r.url));
    const blockingFailedTexts = blockingFailed.map((r) => `${r.status} ${r.url}`);
    expect(blockingFailed, blockingFailedTexts.join('\n')).toEqual([]);
  });

  test('theme.js IS loaded and data-theme attribute applies', async ({ page }) => {
    await page.goto('/setup.html');
    await page.waitForTimeout(500);
    const theme = await page.locator('html').getAttribute('data-theme');
    expect(['dark', 'light']).toContain(theme);
    const hasThemeJs = await page.evaluate(() =>
      Array.from(document.scripts).some((s) => (s.src || '').endsWith('/theme.js')),
    );
    expect(hasThemeJs).toBe(true);
  });

  test('all 13 bound IDs present in DOM (count >= 1)', async ({ page }) => {
    await page.goto('/setup.html');
    await page.waitForLoadState('networkidle');
    const missing = [];
    for (const id of EXPECTED_IDS) {
      const count = await page.locator(`[id="${id}"]`).count();
      if (count < 1) missing.push(`${id} (count=${count})`);
    }
    expect(missing, `IDs missing: ${missing.join(', ')}`).toEqual([]);
  });

  test('AURORA-02 single-writer: setup.js does NOT call setItem on dvhub.theme key', async ({ page }) => {
    await page.goto('/setup.html');
    const jsBody = await page.evaluate(async () => {
      const resp = await fetch('/setup.js');
      return resp.text();
    });
    expect(jsBody).not.toMatch(/localStorage\.setItem\(\s*['"]dvhub\.theme['"]/);
  });

  test('styles.css is NOT loaded; dvhub-app.css + setup.css ARE (Wave-4 link migration)', async ({ page }) => {
    await page.goto('/setup.html');
    const linkedStyles = await page.evaluate(() =>
      Array.from(document.styleSheets).map((s) => s.href || '').filter(Boolean),
    );
    const hasLegacyStyles = linkedStyles.some((href) => /\/styles\.css(\?|$)/.test(href));
    expect(hasLegacyStyles, `styles.css must NOT be linked from setup.html (found: ${linkedStyles.join(', ')})`).toBe(false);
    const hasAuroraStyles = linkedStyles.some((href) => /\/dvhub-app\.css(\?|$)/.test(href));
    expect(hasAuroraStyles, 'dvhub-app.css must be linked from setup.html').toBe(true);
    const hasSetupCss = linkedStyles.some((href) => /\/setup\.css(\?|$)/.test(href));
    expect(hasSetupCss, 'setup.css must be linked from setup.html').toBe(true);
  });

  test('§14a EnWG / EEG legal gate defaults are safe (project_grid_charge_legal memory rule)', async ({ page }) => {
    await page.goto('/setup.html');
    await page.waitForLoadState('networkidle');
    // Acknowledgement must NOT auto-tick.
    const legalAck = page.locator('#legalAck');
    await expect(legalAck).toBeAttached();
    const ackChecked = await legalAck.evaluate((el) => el.checked);
    expect(ackChecked, '#legalAck must default to UNCHECKED — operator must read the legal copy first').toBe(false);
    // Both legal toggles must ship disabled (user has to tick the ack to enable them).
    const allowCharge = page.locator('#allowGridCharge');
    await expect(allowCharge).toBeAttached();
    const chargeDisabled = await allowCharge.evaluate((el) => el.disabled);
    expect(chargeDisabled, '#allowGridCharge must default to DISABLED until #legalAck is ticked').toBe(true);
    const chargeChecked = await allowCharge.evaluate((el) => el.checked);
    expect(chargeChecked, '#allowGridCharge must default to UNCHECKED — never auto-enable grid charging').toBe(false);
    const allowDischarge = page.locator('#allowGridDischarge');
    await expect(allowDischarge).toBeAttached();
    const dischargeDisabled = await allowDischarge.evaluate((el) => el.disabled);
    expect(dischargeDisabled, '#allowGridDischarge must default to DISABLED until #legalAck is ticked').toBe(true);
    const dischargeChecked = await allowDischarge.evaluate((el) => el.checked);
    expect(dischargeChecked, '#allowGridDischarge must default to UNCHECKED — never auto-enable grid discharging').toBe(false);
  });

  test('one-shot bootstrap: /api/config is called exactly once on initial load', async ({ page }) => {
    const configCalls = [];
    page.on('request', (req) => {
      const url = req.url();
      if (/\/api\/config(\?|$)/.test(url)) {
        configCalls.push({ url, method: req.method() });
      }
    });
    await page.goto('/setup.html');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);
    // Exactly one GET /api/config on init (the wizard state machine's
    // initial config read). Any second call would indicate a duplicate
    // bootstrap, which is the Phase 08-06 regression the gate guards.
    const initCalls = configCalls.filter((c) => c.method === 'GET');
    expect(initCalls.length, `Expected exactly 1 GET /api/config on init, saw ${initCalls.length}: ${JSON.stringify(initCalls)}`).toBe(1);
  });

  test('setup-page CSS hooks paint (legal-section, status-banner, config-save-bar)', async ({ page }) => {
    // Sanity-check that setup.css carries the key class hooks the markup +
    // setup.js use. If any of these are missing the wizard renders unstyled
    // (no glass cards, no banner background, no save-bar floating tray).
    //
    // Note: setup.js#setBanner() replaces #setupBanner's class="config-banner"
    // with class="status-banner ${kind}" on first call (which fires
    // immediately after init). So we check .status-banner (the post-init
    // class), NOT .config-banner (the pre-init markup class). Both class
    // blocks must exist in setup.css.
    await page.goto('/setup.html');
    await page.waitForLoadState('networkidle');
    const legalSection = page.locator('.legal-section');
    await expect(legalSection).toBeAttached();
    const banner = page.locator('#setupBanner');
    await expect(banner).toBeAttached();
    // After setup.js init, the banner has class="status-banner ..." — verify
    // the .status-banner CSS is in scope by reading its computed background.
    const saveBar = page.locator('.config-save-bar');
    await expect(saveBar).toBeAttached();
    // Verify the legal-section paints with its warn-tint background
    // (rgba(230,162,60,...) from setup.css). If the class is missing,
    // computed background-color falls back to transparent.
    const bg = await legalSection.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg, `legal-section background must paint — got "${bg}"`).not.toBe('rgba(0, 0, 0, 0)');
    expect(bg, `legal-section background must paint — got "${bg}"`).not.toBe('transparent');
    // The setupBanner is hit by setup.js#setBanner with either status-banner
    // or config-banner depending on init state — accept either being styled.
    const bannerBg = await banner.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bannerBg, `#setupBanner must paint (status-banner or config-banner styling) — got "${bannerBg}"`).not.toBe('rgba(0, 0, 0, 0)');
    expect(bannerBg, `#setupBanner must paint — got "${bannerBg}"`).not.toBe('transparent');
  });
});
