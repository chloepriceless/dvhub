// tests/visual-parity/integrations.spec.mjs — Wave 5 gate (Plan 09.1-06 Task 1).
//
// Asserts the just-ported integrations page renders cleanly:
//  - No blocking console / resource errors (benign /api/* auth-gate
//    responses on the dev-server-without-apiToken setup are tolerated).
//  - Both static IDs the markup must carry are present: #intg-list, #intg-empty.
//  - theme.js IS loaded; <html data-theme> applies; clicking .theme-toggle
//    cycles the attribute (Aurora topbar theme cycle).
//  - AURORA-02 single-writer: integrations.js never writes
//    localStorage['dvhub.theme'] — only theme.js does.
//  - styles.css is NOT linked (Wave-5 link migration — full port).
//  - dvhub-app.css + integrations.css ARE linked.
//
// Requires a dev server on http://localhost:8080.

import { test, expect } from '@playwright/test';

const EXPECTED_IDS = [
  'intg-list',
  'intg-empty',
];

test.describe('Integrations page (Aurora Wave 5, AURORA-01/02/03/05/06)', () => {
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
    await page.goto('/integrations.html');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);
    const benign = /favicon-|apple-touch-icon\.png|manifest\.json|\/api\//;
    const blocking = errors.filter((e) => !benign.test(e.url || e.text));
    const blockingTexts = blocking.map((e) => `${e.text}  (url=${e.url || '<none>'})`);
    expect(blocking, blockingTexts.join('\n')).toEqual([]);
    const blockingFailed = failedResources.filter((r) => !benign.test(r.url));
    const blockingFailedTexts = blockingFailed.map((r) => `${r.status} ${r.url}`);
    expect(blockingFailed, blockingFailedTexts.join('\n')).toEqual([]);
  });

  test('theme.js IS loaded and data-theme attribute applies', async ({ page }) => {
    await page.goto('/integrations.html');
    await page.waitForTimeout(500);
    const theme = await page.locator('html').getAttribute('data-theme');
    expect(['dark', 'light']).toContain(theme);
    const hasThemeJs = await page.evaluate(() =>
      Array.from(document.scripts).some((s) => (s.src || '').endsWith('/theme.js')),
    );
    expect(hasThemeJs).toBe(true);
  });

  test('both bound IDs present in DOM', async ({ page }) => {
    await page.goto('/integrations.html');
    await page.waitForLoadState('networkidle');
    const missing = [];
    for (const id of EXPECTED_IDS) {
      const count = await page.locator(`[id="${id}"]`).count();
      if (count < 1) missing.push(`${id} (count=${count})`);
    }
    expect(missing, `IDs missing: ${missing.join(', ')}`).toEqual([]);
  });

  test('AURORA-02 single-writer: integrations.js does NOT call setItem on dvhub.theme key', async ({ page }) => {
    await page.goto('/integrations.html');
    const jsBody = await page.evaluate(async () => {
      const resp = await fetch('/integrations.js');
      return resp.text();
    });
    expect(jsBody).not.toMatch(/localStorage\.setItem\(\s*['"]dvhub\.theme['"]/);
  });

  test('styles.css is NOT loaded; dvhub-app.css + integrations.css ARE (Wave-5 link migration)', async ({ page }) => {
    await page.goto('/integrations.html');
    const linkedStyles = await page.evaluate(() =>
      Array.from(document.styleSheets).map((s) => s.href || '').filter(Boolean),
    );
    const hasLegacyStyles = linkedStyles.some((href) => /\/styles\.css(\?|$)/.test(href));
    expect(hasLegacyStyles, `styles.css must NOT be linked from integrations.html (found: ${linkedStyles.join(', ')})`).toBe(false);
    const hasAuroraStyles = linkedStyles.some((href) => /\/dvhub-app\.css(\?|$)/.test(href));
    expect(hasAuroraStyles, 'dvhub-app.css must be linked from integrations.html').toBe(true);
    const hasPageCss = linkedStyles.some((href) => /\/integrations\.css(\?|$)/.test(href));
    expect(hasPageCss, 'integrations.css must be linked from integrations.html').toBe(true);
  });

  test('theme-toggle button cycles <html data-theme>', async ({ page }) => {
    await page.goto('/integrations.html');
    await page.waitForLoadState('networkidle');
    const before = await page.locator('html').getAttribute('data-theme');
    const toggle = page.locator('.theme-toggle').first();
    await expect(toggle).toBeAttached();
    await toggle.click();
    await page.waitForTimeout(150);
    const after = await page.locator('html').getAttribute('data-theme');
    // theme.js cycles dark → auto → light → dark; whichever current was, after
    // one click it must change to one of the other states (or "auto").
    expect(after, `theme-toggle click must change data-theme — was ${before}, still ${after}`).not.toBe(before);
  });

  test('integrations page chrome paints (page-header-card, intg-empty)', async ({ page }) => {
    await page.goto('/integrations.html');
    await page.waitForLoadState('networkidle');
    const header = page.locator('.page-header-card').first();
    await expect(header).toBeAttached();
    const headerBg = await header.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(headerBg, `.page-header-card must paint — got "${headerBg}"`).not.toBe('rgba(0, 0, 0, 0)');
    expect(headerBg, `.page-header-card must paint — got "${headerBg}"`).not.toBe('transparent');
    const empty = page.locator('#intg-empty');
    await expect(empty).toBeAttached();
    // Empty state is the visible default until integrations.js polls config.
    const emptyText = await empty.locator('h3').textContent();
    expect(emptyText).toContain('Keine Integrationen');
  });
});
