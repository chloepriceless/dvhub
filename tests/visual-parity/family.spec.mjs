// tests/visual-parity/family.spec.mjs — Wave 1 pilot end-to-end gate.
//
// Asserts the just-ported family page renders cleanly: no console errors, no
// CSP violations, all current binding IDs present in the DOM, the live
// #famSky WebP frame-blend paints, and theme.js is NOT loaded (kitchen
// tablet dark-locked per CONTEXT D-24).
//
// Requires a dev server on http://localhost:3000 (run `npm start` from dvhub/
// in another terminal, OR rely on the test:e2e npm script which spawns one).

import { test, expect } from '@playwright/test';

const EXPECTED_IDS = [
  // Greeting (g-msg / g-mood removed — greeting strip keeps only hello + clock/date, family.js:1818)
  'g-hello', 'g-time', 'g-date',
  // Flow SVG
  'flowSvg', 'gl', 'flowGroup',
  // 5 main tags + friendly/value/status spans
  'tag-solar', 'tf-solar', 'v-s', 'ts-solar',
  // House is the centre readout now (#pfCenter), not a constellation tile —
  // tag-home / tf-home / v-h were removed in the 2026-06-21 House-centre redesign;
  // the live Hausverbrauch + source-mix moved into #pfCenter (pf-house-kw / -mix).
  'tag-bat',   'tf-bat',   'v-b', 'ts-bat',
  'tag-ev',    'tf-ev',    'v-e', 'ts-ev',
  'tag-grid',  'tf-grid',  'v-g', 'ts-grid',
  // Device tray (the message tray — msgTray/msgLatest/msgOverlay/msgHistory
  // etc. — was removed entirely, same redesign as the g-msg/g-mood greeting
  // cleanup; zero references left in family.html or family.js)
  'devices-tray',
  // Right-side widgets
  'widgets', 'forecast-chart',
  'price-now', 'price-min', 'price-max',
  'optimizer-action', 'optimizer-next',
  // Bottom bar + edit toggle + picker + detail panel
  'glass', 'slots', 'editBtn',
  'pickerOverlay', 'picker', 'picker-title', 'pickerGrid',
  'overlay', 'panel',
  'p-icon', 'p-title', 'p-sub', 'p-summary', 'p-stats', 'p-chart', 'p-details', 'p-api',
  // Aurora additions (bgFlow, pfCenter overlay, pf-center-v/d). NOTE: family
  // never got the shared #leitstandPowerflow canvas mount — its live paint is
  // the famSky WebP frame-blend system (see famSky test below), not a canvas.
  'bgFlow', 'pfCenter', 'pf-house-kw', 'pf-house-mix', 'pf-center-v', 'pf-center-d',
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

  test('famSky mount exists and paints (WebP frame-blend, not the shared powerflow canvas)', async ({ page }) => {
    await page.goto('/family');
    // family.js:famUpdateTagAnims/initFamTagAnims — the live PV-share paint on
    // family is an <img class="pf-frame"> WebP frame-blend inside #famSky
    // (--pv-i custom property), NOT the shared dvhub-powerflow.js <canvas>
    // mount (#leitstandPowerflow lives on the Leitstand/index page only).
    const sky = page.locator('#famSky');
    await sky.waitFor({ state: 'attached', timeout: 5000 });
    // initFamTagAnims() appends one <img class="pf-frame"> per FAM_SKY_PCTS entry (18).
    await expect(sky.locator('img.pf-frame')).toHaveCount(18, { timeout: 5000 });
    // Give the first data poll a moment to run famUpdateTagAnims and set --pv-i.
    await page.waitForTimeout(1500);
    const pvIndex = await sky.evaluate((el) => el.style.getPropertyValue('--pv-i'));
    expect(pvIndex, '#famSky must carry a --pv-i custom property once painted').not.toBe('');
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
