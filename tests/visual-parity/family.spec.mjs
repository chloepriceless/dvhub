// tests/visual-parity/family.spec.mjs — Wave 1 pilot end-to-end gate.
//
// Asserts the just-ported family page renders cleanly: no console errors, no
// CSP violations, all 31 current binding IDs (plus the 5 Aurora additions)
// present in the DOM, the live #leitstandPowerflow canvas paints particles,
// and theme.js is NOT loaded (kitchen tablet dark-locked per CONTEXT D-24).
//
// Requires a dev server on http://localhost:3000 (run `npm start` from dvhub/
// in another terminal, OR rely on the test:e2e npm script which spawns one).

import { test, expect } from '@playwright/test';

const EXPECTED_IDS = [
  // Greeting
  'g-hello', 'g-msg', 'g-mood', 'g-time', 'g-date',
  // Flow SVG
  'flowSvg', 'gl', 'flowGroup',
  // 5 main tags + friendly/value/status spans
  'tag-solar', 'tf-solar', 'v-s', 'ts-solar',
  'tag-home',  'tf-home',  'v-h',
  'tag-bat',   'tf-bat',   'v-b', 'ts-bat',
  'tag-ev',    'tf-ev',    'v-e', 'ts-ev',
  'tag-grid',  'tf-grid',  'v-g', 'ts-grid',
  // Device tray + message tray + history overlay
  'devices-tray',
  'msgTray', 'msgLatest', 'msgIcon', 'msgText', 'msgMeta',
  'msgOverlay', 'msgOverlayBg', 'msgOverlayClose', 'msgHistory',
  // Right-side widgets
  'widgets', 'forecast-chart',
  'price-now', 'price-min', 'price-max',
  'optimizer-action', 'optimizer-next',
  // Bottom bar + edit toggle + picker + detail panel
  'glass', 'slots', 'editBtn',
  'pickerOverlay', 'picker', 'picker-title', 'pickerGrid',
  'overlay', 'panel',
  'p-icon', 'p-title', 'p-sub', 'p-summary', 'p-stats', 'p-chart', 'p-details', 'p-api',
  // Aurora additions (5 new — bgFlow, pfCenter overlay, pf-center-v/d, leitstandPowerflow mount):
  'bgFlow', 'pfCenter', 'pf-center-v', 'pf-center-d', 'leitstandPowerflow',
];

test.describe('Family page (Aurora pilot, AURORA-03/04/05/06)', () => {
  test('loads with no console errors and no CSP violations', async ({ page }) => {
    const errors = [];
    const failedResources = []; // { url, status }
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        // Chromium's "Failed to load resource" console error doesn't include
        // the URL in msg.text(); capture msg.location().url so we can tell a
        // benign decorative-asset 404 from a real CSP / JS error.
        const loc = msg.location();
        errors.push({ text: msg.text(), url: (loc && loc.url) || '' });
      }
    });
    page.on('pageerror', (err) => errors.push({ text: String(err), url: '' }));
    page.on('response', (resp) => {
      const status = resp.status();
      if (status >= 400) failedResources.push({ url: resp.url(), status });
    });
    await page.goto('/family');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2500);
    // The kitchen-tablet background painting (/assets/family-scene.png) is an
    // optional decorative asset; if absent the CSS falls back to a flat dark
    // colour. Pre-existing baseline drift (carried forward from before Aurora);
    // out of scope for this plan. We DO fail-loud on any JS/CSP/unhandled
    // rejection error or any other 404 (e.g. dropped script or stylesheet).
    const benign = /family-scene\.png/;
    const blocking = errors.filter((e) => !benign.test(e.url || e.text));
    const blockingTexts = blocking.map((e) => `${e.text}  (url=${e.url || '<none>'})`);
    expect(blocking, blockingTexts.join('\n')).toEqual([]);
    // Surface non-benign failed requests too so a dropped /family.css /
    // /dvhub-powerflow.js etc. fails this gate even if Chromium chose not to
    // emit a console error for it.
    const blockingFailed = failedResources.filter((r) => !benign.test(r.url));
    const blockingFailedTexts = blockingFailed.map((r) => `${r.status} ${r.url}`);
    expect(blockingFailed, blockingFailedTexts.join('\n')).toEqual([]);
  });

  test('has Aurora dark-locked theme attribute', async ({ page }) => {
    await page.goto('/family');
    const theme = await page.locator('html').getAttribute('data-theme');
    expect(theme).toBe('dark');
    const explicit = await page.locator('html').getAttribute('data-theme-explicit');
    expect(explicit).toBe('true');
  });

  test('powerflow mount exists and paints (canvas data-URL > 4 KB)', async ({ page }) => {
    await page.goto('/family');
    // The dvhub-powerflow.js mount creates a child <canvas>. Wait for it.
    const mount = page.locator('#leitstandPowerflow');
    await mount.waitFor({ state: 'attached', timeout: 5000 });
    const canvas = page.locator('#leitstandPowerflow canvas');
    await canvas.waitFor({ state: 'attached', timeout: 5000 });
    const dims = await canvas.evaluate((el) => ({ w: el.clientWidth, h: el.clientHeight }));
    expect(dims.w).toBeGreaterThan(0);
    expect(dims.h).toBeGreaterThan(0);
    // Give the particle animation a moment to actually paint.
    await page.waitForTimeout(1500);
    const dataUrlLength = await canvas.evaluate((el) => el.toDataURL().length);
    // A truly blank canvas serialises to ~~ 200 chars (transparent PNG header).
    // Particle paint pushes the data URL well past 4000 chars even with very
    // low pixel density.
    expect(dataUrlLength).toBeGreaterThan(4000);
  });

  test('all bound IDs present in DOM', async ({ page }) => {
    await page.goto('/family');
    const missing = [];
    for (const id of EXPECTED_IDS) {
      // CSS.escape isn't needed for any ID in the list (alphanumeric + hyphen),
      // but using a quoted attr selector is safer than #id-with-hyphen quirks
      // across engines.
      const count = await page.locator(`[id="${id}"]`).count();
      if (count !== 1) missing.push(`${id} (count=${count})`);
    }
    expect(missing, `IDs missing or duplicated: ${missing.join(', ')}`).toEqual([]);
  });

  test('theme.js is NOT loaded on family (kiosk dark lock)', async ({ page }) => {
    await page.goto('/family');
    const hasThemeJs = await page.evaluate(() =>
      Array.from(document.scripts).some((s) => (s.src || '').endsWith('/theme.js')),
    );
    expect(hasThemeJs).toBe(false);
  });
});
