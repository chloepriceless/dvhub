// tests/visual-parity/explorer.spec.mjs — Wave 5 gate (Plan 09.1-06 Task 1).
//
// Asserts the explorer page (Aurora port + Option-B mockup-fidelity layout)
// renders cleanly:
//  - No blocking console / resource errors (benign /api/* auth-gate
//    responses on the dev-server-without-apiToken setup are tolerated).
//  - All 12 legacy binding IDs explorer.js reads are present in the DOM
//    (the visible UI is pill-based; the IDs back hidden <select>s).
//  - theme.js IS loaded; <html data-theme> applies; clicking .theme-toggle
//    cycles the attribute.
//  - AURORA-02 single-writer: explorer.js never writes
//    localStorage['dvhub.theme'] — only theme.js does.
//  - styles.css is NOT linked (Wave-5 link migration — full port).
//  - dvhub-app.css + explorer.css ARE linked.
//  - Mockup-fidelity layout: .explorer-grid (rail + main), .filter-card with
//    signal-list (≥ 13 .sig-row entries — one per SERIES_DEF), pill-groups
//    for range + agg, and raw-data-table.
//
// Requires a dev server on http://localhost:8080.

import { test, expect } from '@playwright/test';

const EXPECTED_IDS = [
  'explorerRange',
  'customStartWrap',
  'explorerStart',
  'customEndWrap',
  'explorerEnd',
  'explorerAgg',
  'explorerLoadBtn',
  'explorerResetZoomBtn',
  'explorerSeriesChips',
  'explorerCanvas',
  'explorerCsvBtn',
  'explorerStatus',
];

test.describe('Explorer page (Aurora Wave 5 + Option-B, AURORA-01/02/03/05/06)', () => {
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
    await page.goto('/explorer.html');
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
    await page.goto('/explorer.html');
    await page.waitForTimeout(500);
    const theme = await page.locator('html').getAttribute('data-theme');
    expect(['dark', 'light']).toContain(theme);
    const hasThemeJs = await page.evaluate(() =>
      Array.from(document.scripts).some((s) => (s.src || '').endsWith('/theme.js')),
    );
    expect(hasThemeJs).toBe(true);
  });

  test('all 12 bound IDs present in DOM', async ({ page }) => {
    await page.goto('/explorer.html');
    await page.waitForLoadState('networkidle');
    const missing = [];
    for (const id of EXPECTED_IDS) {
      const count = await page.locator(`[id="${id}"]`).count();
      if (count < 1) missing.push(`${id} (count=${count})`);
    }
    expect(missing, `IDs missing: ${missing.join(', ')}`).toEqual([]);
  });

  test('AURORA-02 single-writer: explorer.js does NOT call setItem on dvhub.theme key', async ({ page }) => {
    await page.goto('/explorer.html');
    const jsBody = await page.evaluate(async () => {
      const resp = await fetch('/explorer.js');
      return resp.text();
    });
    expect(jsBody).not.toMatch(/localStorage\.setItem\(\s*['"]dvhub\.theme['"]/);
  });

  test('styles.css is NOT loaded; dvhub-app.css + explorer.css ARE (Wave-5 link migration)', async ({ page }) => {
    await page.goto('/explorer.html');
    const linkedStyles = await page.evaluate(() =>
      Array.from(document.styleSheets).map((s) => s.href || '').filter(Boolean),
    );
    const hasLegacyStyles = linkedStyles.some((href) => /\/styles\.css(\?|$)/.test(href));
    expect(hasLegacyStyles, `styles.css must NOT be linked from explorer.html (found: ${linkedStyles.join(', ')})`).toBe(false);
    const hasAuroraStyles = linkedStyles.some((href) => /\/dvhub-app\.css(\?|$)/.test(href));
    expect(hasAuroraStyles, 'dvhub-app.css must be linked from explorer.html').toBe(true);
    const hasPageCss = linkedStyles.some((href) => /\/explorer\.css(\?|$)/.test(href));
    expect(hasPageCss, 'explorer.css must be linked from explorer.html').toBe(true);
  });

  test('theme-toggle button cycles <html data-theme>', async ({ page }) => {
    await page.goto('/explorer.html');
    await page.waitForLoadState('networkidle');
    const before = await page.locator('html').getAttribute('data-theme');
    const toggle = page.locator('.theme-toggle').first();
    await expect(toggle).toBeAttached();
    await toggle.click();
    await page.waitForTimeout(150);
    const after = await page.locator('html').getAttribute('data-theme');
    expect(after, `theme-toggle click must change data-theme — was ${before}, still ${after}`).not.toBe(before);
  });

  test('explorerCanvas is a real <canvas> element (Chart.js mount target)', async ({ page }) => {
    await page.goto('/explorer.html');
    await page.waitForLoadState('networkidle');
    const tagName = await page.locator('#explorerCanvas').evaluate((el) => el.tagName);
    expect(tagName.toUpperCase()).toBe('CANVAS');
  });

  test('Option-B layout: explorer-grid + filter-card rail + main pane present', async ({ page }) => {
    await page.goto('/explorer.html');
    await page.waitForLoadState('networkidle');
    const grid = page.locator('.explorer-grid');
    await expect(grid).toBeAttached();
    const rail = page.locator('.filter-card');
    await expect(rail).toBeAttached();
    const main = page.locator('.explorer-main');
    await expect(main).toBeAttached();
  });

  test('signal-list renders ≥ 13 .sig-row entries (one per SERIES_DEF)', async ({ page }) => {
    await page.goto('/explorer.html');
    await page.waitForLoadState('networkidle');
    const sigRows = page.locator('#explorerSeriesChips .sig-row');
    const count = await sigRows.count();
    expect(count, `expected ≥ 13 .sig-row entries, got ${count}`).toBeGreaterThanOrEqual(13);
  });

  test('range pill-group: clicking a pill updates hidden <select> + activates pill', async ({ page }) => {
    await page.goto('/explorer.html');
    await page.waitForLoadState('networkidle');
    // Click the "7T" pill (data-pill-value="7d")
    const pill7d = page.locator('.timerange-pills[data-pill-target="explorerRange"] button[data-pill-value="7d"]');
    await pill7d.click();
    await page.waitForTimeout(150);
    await expect(pill7d).toHaveClass(/is-active/);
    const selectVal = await page.locator('#explorerRange').evaluate((el) => el.value);
    expect(selectVal).toBe('7d');
  });

  test('agg pill-group: clicking 1h pill updates hidden <select id="explorerAgg">', async ({ page }) => {
    await page.goto('/explorer.html');
    await page.waitForLoadState('networkidle');
    const pill1h = page.locator('.timerange-pills[data-pill-target="explorerAgg"] button[data-pill-value="1h"]');
    await pill1h.click();
    await page.waitForTimeout(150);
    await expect(pill1h).toHaveClass(/is-active/);
    const selectVal = await page.locator('#explorerAgg').evaluate((el) => el.value);
    expect(selectVal).toBe('1h');
  });

  test('raw data table scaffold present (head + body + foot)', async ({ page }) => {
    await page.goto('/explorer.html');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#explorerRawHead')).toBeAttached();
    await expect(page.locator('#explorerRawBody')).toBeAttached();
    await expect(page.locator('#explorerRawFoot')).toBeAttached();
    const table = page.locator('#explorerRawTable.data-table');
    await expect(table).toBeAttached();
  });

  test('signal search input filters .sig-row entries', async ({ page }) => {
    await page.goto('/explorer.html');
    await page.waitForLoadState('networkidle');
    const search = page.locator('#explorerSignalSearch');
    await expect(search).toBeAttached();
    await search.fill('soc');
    await page.waitForTimeout(150);
    // After filtering by "soc", at least one row should match (Batterie SOC)
    // and the total should be less than 13.
    const visibleRows = await page.locator('#explorerSeriesChips .sig-row').count();
    expect(visibleRows).toBeGreaterThan(0);
    expect(visibleRows).toBeLessThan(13);
  });

  test('signal-list checkbox toggles .sig-row.is-active class', async ({ page }) => {
    await page.goto('/explorer.html');
    await page.waitForLoadState('networkidle');
    // Capture seriesId BEFORE the click — renderSignalList() replaces innerHTML
    // on change, detaching the original locator's element. Then we re-locate
    // by data-series after the re-render.
    const activeRow = page.locator('#explorerSeriesChips .sig-row.is-active').first();
    await expect(activeRow).toBeAttached();
    const seriesId = await activeRow.getAttribute('data-series');
    // Force a synchronous DOM click on the checkbox via evaluate — avoids
    // Playwright's actionability check that re-queries the (now detached)
    // element after the change handler's innerHTML rewrite.
    await activeRow.locator('input[type="checkbox"]').evaluate((el) => el.click());
    await page.waitForTimeout(200);
    const row = page.locator(`#explorerSeriesChips .sig-row[data-series="${seriesId}"]`);
    await expect(row).not.toHaveClass(/is-active/);
  });
});
