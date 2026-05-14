// CSP-violation sweep: load every public route and assert ZERO
// "Refused to apply inline style" / "Refused to execute inline script"
// console messages.
//
// Why this file exists: 2026-05-14 — Plan 09.1-07 Task 3 removed
// 'unsafe-inline' from style-src in routes-api.js. After refactoring
// ~42 inline-style sites across 7 JS files + api-docs.html, every
// route must load WITHOUT triggering CSP violations.

import { test, expect } from '@playwright/test';

const ROUTES = [
  '/',
  '/family',
  '/history.html',
  '/explorer.html',
  '/settings.html',
  '/setup.html',
  '/integrations',
  '/api-docs.html',
  '/tools.html',
];

for (const route of ROUTES) {
  test(`CSP: no inline-style/script violations on ${route}`, async ({ page }) => {
    const violations = [];
    page.on('console', (msg) => {
      const text = msg.text();
      if (/Refused to (apply inline style|execute inline script)/i.test(text)) {
        violations.push(text);
      }
    });
    page.on('pageerror', (err) => {
      const text = String(err);
      if (/Content Security Policy|CSP/i.test(text)) {
        violations.push(text);
      }
    });

    await page.goto(route, { waitUntil: 'domcontentloaded' });
    // Give late-rendering paths (Chart.js, fetch banners, etc) a chance.
    await page.waitForTimeout(1500);

    expect(violations, `CSP violations on ${route}:\n${violations.join('\n')}`).toEqual([]);
  });
}
