// tests/visual-parity/history-viz.spec.mjs
// Phase 09.3 — Aurora History-Viz Cards full assertion spec (Wave 8 closing sweep).
//
// Source-of-truth for the 14-card mount-ID list is ./history-viz.ids.mjs;
// binding-contract.mjs / the leak spec reuse it via the exported
// EXPECTED_VIZ_IDS array (re-exported below). The 14 mount IDs, for reference:
//   sankeySvg, hm, ledgerBody, dayProfileMount, vStack, autarkCal, ringSvg,
//   vDuration, vPHeat, vSpag, vCycles, vTop10, vCalYear, vScatter
//
// Waves 1-6 grew this file incrementally (smoke + per-wave partial asserts).
// Wave 8 (this plan) replaces the body with the FULL assertion set:
//   - 14 mount IDs present exactly once
//   - 4 view-conditional card-set assertions (day / week / month / year)
//   - chartjs-chart-matrix plugin auto-registration
//   - window.historyViz namespace surface
//   - theme-toggle repaint (no console errors)
//   - zero CSP inline-style violations across a full session + view-toggles
//
// Pre-deploy soft posture: /api/* endpoints may 503 on a dev server with an
// empty apiToken — the mount-ID / view-gating assertions are DOM-structural and
// hold regardless; the chart-paint assertions are exercised by the leak spec
// and the human-verify checkpoint (Plan 09.3-08 Task 2).

import { test, expect } from '@playwright/test';
// The 14 viz mount IDs — one per card — live in a plain (non-spec) ES module
// so the leak spec can import them too without tripping Playwright's
// "test file should not import test file" rule. Re-exported here for any
// consumer that already imports this spec by name.
import { EXPECTED_VIZ_IDS } from './history-viz.ids.mjs';
export { EXPECTED_VIZ_IDS };

// Benign noise filter. Three classes are NOT page defects:
//   1. Static asset 404s — favicons, apple-touch-icon, manifest, kiosk hero.
//   2. /api/* failures — a dev server returns 503 (empty apiToken), 429
//      (per-IP rate budget exhausted by a long CI run) or 500 (the viz
//      aggregators query PostgreSQL — a dev server with no DB / no config
//      returns 500 with `needsSetup: true`). None is a page bug; the
//      appliance LAN-trust / rate-limit model and the no-DB dev posture are
//      all intentional. The data-paint correctness of every card on a REAL
//      server with a live DB is covered by the human-verify checkpoint
//      (Plan 09.3-08 Task 2).
//   3. The viz builders' OWN logged fetch failures — history-viz.js calls
//      `console.error('history-viz: buildXxx failed', e)` when fetchCardData
//      rejects. The console message's location URL is history-viz.js (not the
//      /api/ URL), so the URL never matches the /api/ class — the filter MUST
//      also test the message TEXT, which begins with `history-viz: build`.
//      The Wave-6 leak spec already whitelists `history-viz: build`; this
//      full spec mirrors it (and tests url AND text — see the filter below).
// `Failed to load resource: … status of 5xx/429` is the browser's own generic
// console message for a rejected fetch — it carries neither the /api/ URL nor
// the `HTTP NNN` phrasing, so it is whitelisted explicitly.
const BENIGN = /favicon-|apple-touch-icon\.png|manifest\.json|family-scene\.png|\/api\/|history-viz: build|HTTP 429|HTTP 503|HTTP 500|Failed to load resource:.*status of (?:429|500|502|503)/;

test.describe('History Viz Cards (Phase 09.3, all 14 cards across 4 views)', () => {
  test('loads with no blocking console / resource errors', async ({ page }) => {
    const errors = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push({ text: m.text(), url: (m.location() || {}).url });
    });
    page.on('pageerror', (e) => errors.push({ text: String(e), url: '' }));
    page.on('response', (r) => {
      if (r.status() >= 400 && !BENIGN.test(r.url())) errors.push({ text: `HTTP ${r.status()}`, url: r.url() });
    });
    await page.goto('/history.html');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2500);
    // Test BOTH the source URL and the message text against BENIGN — a
    // console.error from history-viz.js has url=history-viz.js (not benign)
    // but text='history-viz: build… HTTP 5xx' (benign). The old
    // `BENIGN.test(e.url || e.text)` short-circuited on the truthy URL and
    // never inspected the text, mis-flagging every degraded-data builder log.
    const blocking = errors.filter((e) => !BENIGN.test(e.url) && !BENIGN.test(e.text));
    expect(blocking, blocking.map((e) => `${e.text} (url=${e.url})`).join('\n')).toEqual([]);
  });

  test('all 14 viz mount IDs are present exactly once', async ({ page }) => {
    await page.goto('/history.html');
    await page.waitForLoadState('networkidle');
    for (const id of EXPECTED_VIZ_IDS) {
      const count = await page.locator(`#${id}`).count();
      expect(count, `Expected exactly 1 element with id="${id}", found ${count}`).toBe(1);
    }
  });

  test('chartjs-chart-matrix plugin auto-registers', async ({ page }) => {
    await page.goto('/history.html');
    await page.waitForLoadState('networkidle');
    const matrixType = await page.evaluate(() => typeof window.Chart?.controllers?.matrix);
    expect(matrixType).toBe('function');
  });

  test('window.historyViz namespace exposed with applyView', async ({ page }) => {
    await page.goto('/history.html');
    await page.waitForLoadState('networkidle');
    const hasAPI = await page.evaluate(() => typeof window.historyViz?.applyView === 'function');
    expect(hasAPI).toBe(true);
  });

  // The expected visible-card slug set per view. The [data-viz-card] attribute
  // carries the slug; .viz-hidden-by-view is the view-conditional hide class.
  const visibleCards = {
    day:   ['sankey', 'day-profile', 'ledger', 'stack', 'autarky-calendar', 'ring', 'duration', 'pheat'],
    week:  ['sankey', 'heatmap', 'stack', 'autarky-calendar', 'duration', 'pheat', 'spaghetti', 'cycles', 'top10', 'scatter'],
    month: ['sankey', 'heatmap', 'stack', 'autarky-calendar', 'duration', 'pheat', 'spaghetti', 'cycles', 'top10', 'scatter'],
    year:  ['sankey', 'heatmap', 'stack', 'autarky-calendar', 'duration', 'pheat', 'spaghetti', 'cycles', 'top10', 'cal-year', 'scatter']
  };

  for (const [view, cards] of Object.entries(visibleCards)) {
    test(`view='${view}' shows exactly the expected card set`, async ({ page }) => {
      await page.goto('/history.html');
      await page.waitForLoadState('networkidle');
      await page.locator('#historyView').selectOption(view);
      await page.waitForTimeout(800);
      const all = await page.locator('[data-viz-card]').evaluateAll((els) => els.map((el) => ({
        card: el.dataset.vizCard,
        hidden: el.classList.contains('viz-hidden-by-view')
      })));
      const visible = all.filter((c) => !c.hidden).map((c) => c.card).sort();
      expect(visible).toEqual(cards.slice().sort());
    });
  }

  test('theme-toggle does not error', async ({ page }) => {
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto('/history.html');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await page.waitForTimeout(500);
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await page.waitForTimeout(500);
    // Re-use the shared BENIGN filter — a builder's logged 429/503 fetch
    // failure is not a theme-repaint defect. The intent of this test is that
    // toggling data-theme does not throw a Chart.js 'Cannot read of null'-class
    // error; an upstream /api 429 from an exhausted rate budget is orthogonal.
    const blocking = errors.filter((e) => !BENIGN.test(e));
    expect(blocking).toEqual([]);
  });

  test('zero CSP inline-style violations on history.html (additive to csp-violations spec)', async ({ page }) => {
    const cspViolations = [];
    page.on('console', (m) => {
      if (m.type() === 'error' && /Refused to apply inline style/.test(m.text())) cspViolations.push(m.text());
    });
    await page.goto('/history.html');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2500);
    // Also exercise view-toggles to surface any builder-driven CSP issue.
    await page.locator('#historyView').selectOption('year');
    await page.waitForTimeout(2500);
    expect(cspViolations).toEqual([]);
  });
});
