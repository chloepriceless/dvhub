// tests/visual-parity/history-viz-leak.spec.mjs — Phase 09.3 Wave 1 leak guard.
//
// Wave 1: builders are stubs (console.warn only) so chart count stays 0
// regardless of view-toggle frequency. The assertion ships now so future
// waves can NOT regress without flipping this test red.
//
// Plan 09.3-06 retunes the assertion: chart-count must equal the number of
// LAZY-built cards in the LAST view (memoised by `${card}:${view}`). Until
// then, the strict-zero floor catches any premature wiring of a builder
// from a later wave.

import { test, expect } from '@playwright/test';

test.describe('History-viz leak guard (Phase 09.3-01 Wave 1 stub baseline)', () => {
  test('after 5x applyView toggle, no Chart.js instances and no console errors', async ({ page }) => {
    const errors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const loc = msg.location();
        errors.push({ text: msg.text(), url: (loc && loc.url) || '' });
      }
    });
    page.on('pageerror', (err) => errors.push({ text: String(err), url: '' }));
    await page.goto('/history.html');
    await page.waitForLoadState('networkidle');

    // Toggle through 5 views (day/week/month/year/day/week). Each call goes
    // through applyView() which destroys all charts before re-applying.
    await page.evaluate(() => {
      const seq = ['day', 'week', 'month', 'year', 'day', 'week'];
      for (const v of seq) {
        if (window.historyViz && window.historyViz.applyView) {
          window.historyViz.applyView(v, '2026-05-15');
        }
      }
    });
    // Allow any setTimeout(0)-staged builds to flush.
    await page.waitForTimeout(200);

    const chartCount = await page.evaluate(() =>
      window.historyViz && window.historyViz.charts
        ? Object.keys(window.historyViz.charts).length
        : 0
    );
    expect(
      chartCount,
      `Wave 1 stubs MUST NOT mount any Chart.js instances (got ${chartCount}). If a later wave landed early, retune this assertion in Plan 09.3-06.`
    ).toBe(0);

    // Console errors must remain empty (the stub builders use console.warn,
    // not console.error — warns are allowed).
    expect(errors, errors.map((e) => `${e.text} (url=${e.url})`).join('\n')).toEqual([]);
  });
});
