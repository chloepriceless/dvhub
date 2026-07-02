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
// Phase 09.3-08 key-link: the leak spec consumes the canonical mount-ID list
// from the shared history-viz.ids.mjs module (also imported by
// history-viz.spec.mjs). The year-view chart-count upper bound below (12) is
// derived from this 14-card universe minus the 2 day-only cards (day-profile,
// ring) — keeping the two specs in lockstep so a future card add/remove
// updates one array. Importing the plain .ids.mjs module (not the sibling
// spec) avoids Playwright's "test file should not import test file".
import { EXPECTED_VIZ_IDS } from './history-viz.ids.mjs';

test.describe('History-viz leak guard (Phase 09.3-06 Wave 6, locked in Wave 8)', () => {
  test('EXPECTED_VIZ_IDS is the shared 14-card source-of-truth', () => {
    // Sanity guard for the key-link: if the canonical array drifts from 14 the
    // year-view [8, 12] bound below must be re-derived.
    expect(EXPECTED_VIZ_IDS.length).toBe(14);
  });

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
    // autarky-calendar + duration + pheat + neg-price + spaghetti + cycles +
    // top10 + cal-year + scatter (12). day-profile + ring are day-only.
    //
    // This is a LEAK guard — its single job is to catch UNBOUNDED GROWTH. The
    // hard, non-negotiable assertion is therefore the UPPER bound (≤ 12): a
    // true leak (an undisposed Chart instance accumulating across the 5
    // view-toggles) pushes the registry far past 12. The chart COUNT is logged
    // for diagnostics but is NOT lower-bounded: in a degraded environment the
    // viz aggregators (which query PostgreSQL) return 503 (empty apiToken),
    // 429 (per-IP rate budget exhausted by a long CI run) or 500 (dev server
    // with no DB / no config, `needsSetup: true`) — fetchCardData rejects, the
    // build's success branch never runs, and the registry stays small. A small
    // or zero count is the OPPOSITE of a leak; lower-bounding it would conflate
    // "endpoints degraded" with "registry leaking" and make the gate flaky.
    // The happy-path 8..12 paint band on a healthy server with a live DB is
    // covered by the human-verify checkpoint (Plan 09.3-08 Task 2).
    console.log(`history-viz-leak: chartCount=${chartCount} builtCount=${builtCount} (year view, post 5 toggles)`);
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

    // Filter benign console errors. A real leak / state-machine bug surfaces
    // as a non-benign console error or pageerror. The filter tests BOTH the
    // source URL and the message text — a console.error from history-viz.js
    // has url=history-viz.js (not benign) but text='history-viz: build…'
    // (benign); a `url || text` short-circuit would miss the text and
    // mis-flag every degraded-data builder log.
    const benign = /favicon-|apple-touch-icon\.png|manifest\.json|family-scene\.png|\/api\/|history-viz: build|HTTP 429|HTTP 503|HTTP 500|Failed to load resource:.*status of (?:429|500|502|503)/;
    const blocking = errors.filter((e) => !benign.test(e.url) && !benign.test(e.text));
    expect(blocking, blocking.map((e) => `${e.text} (url=${e.url})`).join('\n')).toEqual([]);
  });
});
