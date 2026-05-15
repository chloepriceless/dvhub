// tests/visual-parity/history-viz-leak.spec.mjs — Phase 09.3 leak guard.
//
// Wave 1 (Plan 09.3-01): builders were stubs → 0 charts after toggling.
// Wave 2 (Plan 09.3-02): 5 builders went live; the original strict-zero
// assertion is now obsolete. Retuned per the comment in the original file
// ("Plan 09.3-06 retunes the assertion") — bringing the retune forward into
// Wave 2 so the live builders don't false-flag a leak.
//
// Invariant under test now: applyView() destroys old charts before lazy-
// rebuilding for the new view. Across 5 toggles the registry size MUST stay
// bounded (≤ total Wave-2 card count = 5). Plan 09.3-06 will tighten further
// once view-state-machine refinements land.
//
// Pre-deploy soft-pass: /api/* endpoints may 503 on a dev server with empty
// apiToken — in that case builders never register a chart. The bound check
// holds either way (0 ≤ 5).

import { test, expect } from '@playwright/test';

test.describe('History-viz leak guard (Phase 09.3-02 Wave 2)', () => {
  test('after 5x applyView toggle, registry stays bounded and no console errors', async ({ page }) => {
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

    // Toggle through 6 views (day/week/month/year/day/week). Each call goes
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
    await page.waitForTimeout(500);

    const chartCount = await page.evaluate(() =>
      window.historyViz && window.historyViz.charts
        ? Object.keys(window.historyViz.charts).length
        : 0
    );
    // Bound = 5 Wave-2 cards (sankey/dayProfile/stack/heatmap/ledger). If
    // applyView leaks instances across toggles, the count would grow without
    // bound — this assertion catches that regression.
    expect(
      chartCount,
      `Registry should stay bounded at ≤ 5 across toggles (got ${chartCount}). Wave 3+ may raise this bound.`
    ).toBeLessThanOrEqual(5);

    // Filter benign console errors (e.g. /api/* 503 on a dev server with
    // empty apiToken — same posture as history-viz.spec.mjs Spec 1).
    const benign = /favicon-|apple-touch-icon\.png|manifest\.json|family-scene\.png|\/api\/|history-viz: build/;
    const blocking = errors.filter((e) => !benign.test(e.url || e.text));
    expect(blocking, blocking.map((e) => `${e.text} (url=${e.url})`).join('\n')).toEqual([]);
  });
});
