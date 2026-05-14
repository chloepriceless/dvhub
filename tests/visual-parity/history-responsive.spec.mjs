// Quick visual-check of history.html responsive layout at multiple widths.
// Captures full-page screenshots so the human can eyeball the fix.
//
// Why this file exists: 2026-05-14 — user reported menu/cards/charts don't
// shrink at narrow widths after commit a71226f. Investigation found 3 gaps
// in the 09.1-07 styles.css port:
//   (A) .page-content base layout missing
//   (B) .page-content .history-chart-grid stack-override missing
//   (C) .nav-toggle + @media(760px) topbar drawer missing
// This spec verifies the fix is visible at typical phone/tablet/desktop widths.

import { test, expect } from '@playwright/test';

const VIEWPORTS = [
  { name: 'phone-360',    width: 360,  height: 740  },
  { name: 'phone-414',    width: 414,  height: 896  },
  { name: 'tablet-768',   width: 768,  height: 1024 },
  { name: 'tablet-1024',  width: 1024, height: 768  },
  { name: 'desktop-1280', width: 1280, height: 800  },
  { name: 'desktop-1440', width: 1440, height: 900  },
];

for (const vp of VIEWPORTS) {
  test(`history.html @ ${vp.name} (${vp.width}x${vp.height})`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto('/history.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800); // chart paints

    // No horizontal scrollbar at any viewport
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth, `horizontal overflow at ${vp.name}`).toBeLessThanOrEqual(clientWidth + 1);

    // Topbar hamburger visibility flips at 760px
    const navToggleVisible = await page.locator('.nav-toggle').isVisible();
    if (vp.width <= 760) {
      expect(navToggleVisible, `hamburger should show below 760px`).toBe(true);
    } else {
      expect(navToggleVisible, `hamburger should hide above 760px`).toBe(false);
    }

    await page.screenshot({
      path: `test-results/history-${vp.name}.png`,
      fullPage: true,
    });
  });
}
