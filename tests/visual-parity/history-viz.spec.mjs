// tests/visual-parity/history-viz.spec.mjs — Phase 09.3 Wave 1 smoke spec.
//
// Wave 1 asserts the foundation only:
//   Spec 1 — page loads with no blocking console / resource errors.
//   Spec 2 — chartjs-chart-matrix UMD bundle self-registers as the 'matrix'
//            controller (RESEARCH §Pitfall 2 — register-order matters; this
//            confirms the script-tag order in history.html is correct).
//   Spec 3 — window.historyViz exists with the documented surface.
//   Spec 4 — view-state DOM bindings (#historyView + #historyDate) are
//            present so the IIFE can attach listeners.
//   Spec 5 — view-conditional class toggle (FIXME, enabled in Plan 09.3-02
//            once the first viz section ships with [data-show-view]).

import { test, expect } from '@playwright/test';

test.describe('History-viz foundation (Phase 09.3-01 Wave 1)', () => {
  test('Spec 1 — history.html loads with no blocking console / resource errors', async ({ page }) => {
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
    await page.goto('/history.html');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2500);
    // Re-use the benign-error filter from history.spec.mjs:92 (favicons,
    // manifest, kiosk hero image, /api/* 503 when apiToken unset).
    const benign = /favicon-|apple-touch-icon\.png|manifest\.json|family-scene\.png|\/api\//;
    const blocking = errors.filter((e) => !benign.test(e.url || e.text));
    expect(blocking, blocking.map((e) => `${e.text} (url=${e.url || '<none>'})`).join('\n')).toEqual([]);
    const blockingFailed = failedResources.filter((r) => !benign.test(r.url));
    expect(
      blockingFailed,
      blockingFailed.map((r) => `${r.status} ${r.url}`).join('\n')
    ).toEqual([]);
  });

  test('Spec 2 — chartjs-chart-matrix UMD self-registers (Pitfall §register-order)', async ({ page }) => {
    await page.goto('/history.html');
    await page.waitForLoadState('networkidle');
    const controllerType = await page.evaluate(() => {
      // Chart.js 4 stores controllers under `Chart.controllers.<id>` (legacy
      // surface that the matrix UMD relies on for self-registration). If the
      // matrix bundle is loaded BEFORE chart.min.js the registration silently
      // no-ops — Spec 2 catches that regression.
      try { return typeof window.Chart?.controllers?.matrix; }
      catch (_) { return 'undefined'; }
    });
    expect(
      controllerType,
      `Chart.controllers.matrix should be 'function' after page load (script order: chart.min.js → chartjs-chart-matrix.min.js)`
    ).toBe('function');
  });

  test('Spec 3 — window.historyViz exposes applyView + charts + _internals', async ({ page }) => {
    await page.goto('/history.html');
    await page.waitForLoadState('networkidle');
    const surface = await page.evaluate(() => ({
      hasNamespace: typeof window.historyViz === 'object' && window.historyViz !== null,
      applyView: typeof window.historyViz?.applyView,
      charts: typeof window.historyViz?.charts,
      cssVar: typeof window.historyViz?._internals?.cssVar,
    }));
    expect(surface.hasNamespace, 'window.historyViz should be an object').toBe(true);
    expect(surface.applyView, 'window.historyViz.applyView should be a function').toBe('function');
    expect(surface.charts, 'window.historyViz.charts should be an object').toBe('object');
    expect(surface.cssVar, 'window.historyViz._internals.cssVar should be a function (re-defined in IIFE scope)').toBe('function');
  });

  test('Spec 4 — view-state bindings (#historyView, #historyDate) present', async ({ page }) => {
    await page.goto('/history.html');
    await expect(page.locator('#historyView')).toBeAttached();
    await expect(page.locator('#historyDate')).toBeAttached();
  });

  // Spec 5 — view-conditional class toggle. Enabled in Plan 09.3-02 once the
  // first [data-show-view] section ships (Wave 1 has no viz sections in
  // history.html, so applyView() is a no-op).
  test.fixme('Spec 5 — applyView toggles .viz-hidden-by-view (enabled in Plan 09.3-02)', async () => {});
});
