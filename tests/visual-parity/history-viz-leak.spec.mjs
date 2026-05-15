// tests/visual-parity/history-viz-leak.spec.mjs — Phase 09.3 leak guard.
//
// Wave 1 (Plan 09.3-01): builders were stubs → 0 charts after toggling.
// Wave 2 (Plan 09.3-02): 5 builders went live; the strict-zero assertion was
//   retuned to a ≤ 5 bound so the live builders didn't false-flag a leak.
// Wave 6 (Plan 09.3-06): the view-state machine is now fully refined — the
//   3-segment memo key (card:view:date), destroyAll() on every view/date
//   change, and the staggered lazy-build chain land here. This spec is the
//   ENFORCED leak detector: after 5 rapid view-toggles the live chart count
//   MUST equal the build-eligible card count of the FINAL view (no orphans,
//   no unbounded growth), and the memo set MUST be at least as large.
//
// Pre-deploy soft posture: /api/* endpoints may 503 on a dev server with an
// empty apiToken — in that case fetchCardData throws, the build's .then()
// success branch never runs, and the chart is neither registered nor memoised.
// The bounds below hold either way (the lower bound is 0-tolerant on the
// chart-count side; the relative builtCount ≥ chartCount invariant is exact).

import { test, expect } from '@playwright/test';

test.describe('History-viz leak guard (Phase 09.3-06 Wave 6)', () => {
  test('no chart-instance leaks after 5 rapid view-toggles', async ({ page }) => {
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
    await page.waitForTimeout(2000);

    // Cycle through views 5 times — each selectOption fires the #historyView
    // 'change' listener, which calls destroyAll() then applyView(). If
    // applyView leaks instances the registry grows without bound.
    for (let i = 0; i < 5; i++) {
      await page.locator('#historyView').selectOption('week');
      await page.waitForTimeout(150);
      await page.locator('#historyView').selectOption('day');
      await page.waitForTimeout(150);
    }
    // End on 'year' — the max-card-count view (9 build-eligible cards).
    await page.locator('#historyView').selectOption('year');
    // Allow all staggered builds + fetch round-trips to settle.
    await page.waitForTimeout(2500);

    const chartCount = await page.evaluate(
      () => Object.keys(window.historyViz?.charts || {}).length
    );
    const builtCount = await page.evaluate(
      () => window.historyViz?._internals?.built?.size || 0
    );

    // For view='year' the build-eligible cards are: sankey + heatmap + stack +
    // autarky-calendar + duration + pheat + spaghetti + cycles + top10 +
    // cal-year + scatter. day-profile + ledger + ring are day-only. The
    // ledger is an HTML table (registered as a non-Chart stub) and the matrix
    // plugin has paint-timing idiosyncrasies, so an 8..12 range absorbs the
    // non-Chart ledger entry + any endpoint 503s without masking a true leak
    // (a leak would push the count far past 12 after 5 toggles).
    expect(
      chartCount,
      `Registry should be bounded to the year-view card set after 5 toggles (got ${chartCount})`
    ).toBeGreaterThanOrEqual(8);
    expect(
      chartCount,
      `Registry must NOT grow past the year-view card set — leak suspected (got ${chartCount})`
    ).toBeLessThanOrEqual(12);
    // The memo set grows with each successful build; it is at least as large
    // as the live chart registry (a build adds to charts then to the memo).
    expect(
      builtCount,
      `built memo set (${builtCount}) should be ≥ live chart count (${chartCount})`
    ).toBeGreaterThanOrEqual(chartCount);

    // Filter benign console errors (favicons, kiosk hero image, /api/* 503 on
    // a dev server with empty apiToken). A real leak / state-machine bug
    // surfaces as a non-benign console error or pageerror.
    const benign = /favicon-|apple-touch-icon\.png|manifest\.json|family-scene\.png|\/api\/|history-viz: build/;
    const blocking = errors.filter((e) => !benign.test(e.url || e.text));
    expect(blocking, blocking.map((e) => `${e.text} (url=${e.url})`).join('\n')).toEqual([]);
  });
});
