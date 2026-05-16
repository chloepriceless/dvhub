// tests/visual-parity/api-docs.spec.mjs — Wave 5 gate (Plan 09.1-06 Task 2).
//
// Asserts the API documentation page renders cleanly. api-docs.html is a
// Swagger-UI host (not a hand-rolled Aurora doc browser — see 09.1-06-SUMMARY
// "Deviation 1"): the live OpenAPI spec at /openapi.json is the source of
// truth, so there is no static v2 doc section and no .aurora-banner-draft.
//
// Coverage:
//  - No blocking console / resource errors (benign favicon/manifest tolerated).
//  - Static shape: #swagger-ui mount div, back-link, /api-docs.css linked,
//    legacy styles.css NOT linked (Wave-5 link migration — full port).
//  - Swagger UI CDN tags keep their sha384 SRI integrity attributes
//    (Plan 08-05 supply-chain contract — regression guard).
//  - Swagger UI actually mounts: .swagger-ui attaches and the spec .info
//    block renders from /openapi.json.
//
// Requires a dev server on http://localhost:8080 with network access to the
// pinned unpkg swagger-ui-dist@5.11.0 CDN.

import { test, expect } from '@playwright/test';

test.describe('API docs page (Aurora Wave 5 — Swagger-UI host, AURORA-01/05/06)', () => {
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
    await page.goto('/api-docs.html');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);
    const benign = /favicon-|apple-touch-icon\.png|manifest\.json/;
    const blocking = errors.filter((e) => !benign.test(e.url || e.text));
    const blockingTexts = blocking.map((e) => `${e.text}  (url=${e.url || '<none>'})`);
    expect(blocking, blockingTexts.join('\n')).toEqual([]);
    const blockingFailed = failedResources.filter((r) => !benign.test(r.url));
    const blockingFailedTexts = blockingFailed.map((r) => `${r.status} ${r.url}`);
    expect(blockingFailed, blockingFailedTexts.join('\n')).toEqual([]);
  });

  test('static shape: #swagger-ui mount, back-link, api-docs.css linked, no styles.css', async ({ page }) => {
    await page.goto('/api-docs.html');
    await expect(page.locator('#swagger-ui')).toBeAttached();
    await expect(page.locator('a.back-link')).toBeAttached();
    const linkedStyles = await page.evaluate(() =>
      Array.from(document.styleSheets).map((s) => s.href || '').filter(Boolean),
    );
    const hasLegacyStyles = linkedStyles.some((href) => /\/styles\.css(\?|$)/.test(href));
    expect(hasLegacyStyles, `styles.css must NOT be linked (found: ${linkedStyles.join(', ')})`).toBe(false);
    const hasPageCss = linkedStyles.some((href) => /\/api-docs\.css(\?|$)/.test(href));
    expect(hasPageCss, 'api-docs.css must be linked').toBe(true);
  });

  test('Swagger UI CDN tags keep sha384 SRI integrity (Plan 08-05 supply-chain contract)', async ({ page }) => {
    await page.goto('/api-docs.html');
    const cdnTags = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('link[href], script[src]')) {
        const ref = el.getAttribute('href') || el.getAttribute('src') || '';
        if (ref.includes('unpkg.com/swagger-ui-dist')) {
          out.push({ ref, integrity: el.getAttribute('integrity') || '', crossorigin: el.getAttribute('crossorigin') || '' });
        }
      }
      return out;
    });
    expect(cdnTags.length, 'expected the pinned Swagger UI CSS + JS bundle CDN tags').toBeGreaterThanOrEqual(2);
    for (const tag of cdnTags) {
      expect(tag.ref, `${tag.ref} must be version-pinned to swagger-ui-dist@5.11.0`).toContain('swagger-ui-dist@5.11.0');
      expect(tag.integrity, `${tag.ref} missing sha384 SRI integrity attribute`).toMatch(/^sha384-/);
      expect(tag.crossorigin, `${tag.ref} missing crossorigin attribute`).toBe('anonymous');
    }
  });

  test('Swagger UI mounts and renders the /openapi.json spec', async ({ page }) => {
    await page.goto('/api-docs.html');
    // CDN bundle + /openapi.json fetch + render — allow a generous budget.
    await expect(page.locator('#swagger-ui .swagger-ui')).toBeAttached({ timeout: 20000 });
    // The spec .info block proves /openapi.json was fetched and parsed.
    await expect(page.locator('#swagger-ui .info')).toBeVisible({ timeout: 20000 });
  });
});
