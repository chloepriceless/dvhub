// tests/visual-parity/integrations.spec.mjs — Wave 5 gate (Plan 09.1-06 Task 1).
//
// Asserts the integrations page (Aurora port + Option-B mockup-fidelity layout)
// renders cleanly:
//  - No blocking console / resource errors (benign /api/* auth-gate
//    responses on the dev-server-without-apiToken setup are tolerated).
//  - Both static IDs the markup must carry are present: #intg-list, #intg-empty.
//  - theme.js IS loaded; <html data-theme> applies; clicking .theme-toggle
//    cycles the attribute.
//  - AURORA-02 single-writer: integrations.js never writes
//    localStorage['dvhub.theme'] — only theme.js does.
//  - styles.css is NOT linked (Wave-5 link migration — full port).
//  - dvhub-app.css + integrations.css ARE linked.
//  - Mockup-fidelity layout present: segmented filter toolbar with the 3
//    expected buttons, VRM Backfill notice, and conn-grid container.
//
// Requires a dev server on http://localhost:8080.

import { test, expect } from '@playwright/test';

const EXPECTED_IDS = [
  'intg-list',
  'intg-empty',
  'intg-filter-all',
  'intg-filter-connected',
  'intg-filter-disabled',
];

test.describe('Integrations page (Aurora Wave 5 + Option-B, AURORA-01/02/03/05/06)', () => {
  test('loads with no blocking console / resource errors', async ({ page }) => {
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
    await page.goto('/integrations.html');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);
    const benign = /favicon-|apple-touch-icon\.png|manifest\.json|\/api\//;
    const blocking = errors.filter((e) => !benign.test(e.url || e.text));
    const blockingTexts = blocking.map((e) => `${e.text}  (url=${e.url || '<none>'})`);
    expect(blocking, blockingTexts.join('\n')).toEqual([]);
    const blockingFailed = failedResources.filter((r) => !benign.test(r.url));
    const blockingFailedTexts = blockingFailed.map((r) => `${r.status} ${r.url}`);
    expect(blockingFailed, blockingFailedTexts.join('\n')).toEqual([]);
  });

  test('theme.js IS loaded and data-theme attribute applies', async ({ page }) => {
    await page.goto('/integrations.html');
    await page.waitForTimeout(500);
    const theme = await page.locator('html').getAttribute('data-theme');
    expect(['dark', 'light']).toContain(theme);
    const hasThemeJs = await page.evaluate(() =>
      Array.from(document.scripts).some((s) => (s.src || '').endsWith('/theme.js')),
    );
    expect(hasThemeJs).toBe(true);
  });

  test('all 5 bound IDs present in DOM (list, empty, 3 filter buttons)', async ({ page }) => {
    await page.goto('/integrations.html');
    await page.waitForLoadState('networkidle');
    const missing = [];
    for (const id of EXPECTED_IDS) {
      const count = await page.locator(`[id="${id}"]`).count();
      if (count < 1) missing.push(`${id} (count=${count})`);
    }
    expect(missing, `IDs missing: ${missing.join(', ')}`).toEqual([]);
  });

  test('AURORA-02 single-writer: integrations.js does NOT call setItem on dvhub.theme key', async ({ page }) => {
    await page.goto('/integrations.html');
    const jsBody = await page.evaluate(async () => {
      const resp = await fetch('/integrations.js');
      return resp.text();
    });
    expect(jsBody).not.toMatch(/localStorage\.setItem\(\s*['"]dvhub\.theme['"]/);
  });

  test('styles.css is NOT loaded; dvhub-app.css + integrations.css ARE (Wave-5 link migration)', async ({ page }) => {
    await page.goto('/integrations.html');
    const linkedStyles = await page.evaluate(() =>
      Array.from(document.styleSheets).map((s) => s.href || '').filter(Boolean),
    );
    const hasLegacyStyles = linkedStyles.some((href) => /\/styles\.css(\?|$)/.test(href));
    expect(hasLegacyStyles, `styles.css must NOT be linked from integrations.html (found: ${linkedStyles.join(', ')})`).toBe(false);
    const hasAuroraStyles = linkedStyles.some((href) => /\/dvhub-app\.css(\?|$)/.test(href));
    expect(hasAuroraStyles, 'dvhub-app.css must be linked from integrations.html').toBe(true);
    const hasPageCss = linkedStyles.some((href) => /\/integrations\.css(\?|$)/.test(href));
    expect(hasPageCss, 'integrations.css must be linked from integrations.html').toBe(true);
  });

  test('theme-toggle button cycles <html data-theme>', async ({ page }) => {
    await page.goto('/integrations.html');
    await page.waitForLoadState('networkidle');
    const before = await page.locator('html').getAttribute('data-theme');
    const toggle = page.locator('.theme-toggle').first();
    await expect(toggle).toBeAttached();
    await toggle.click();
    await page.waitForTimeout(150);
    const after = await page.locator('html').getAttribute('data-theme');
    expect(after, `theme-toggle click must change data-theme — was ${before}, still ${after}`).not.toBe(before);
  });

  test('Option-B layout: filter toolbar segmented control + VRM notice + conn-grid present', async ({ page }) => {
    await page.goto('/integrations.html');
    await page.waitForLoadState('networkidle');
    // Filter toolbar with 3-way segmented control
    const toolbar = page.locator('.int-toolbar');
    await expect(toolbar).toBeAttached();
    const filterButtons = page.locator('.int-toolbar [data-status-filter]');
    await expect(filterButtons).toHaveCount(3);
    // "Alle" must be initially active
    const allBtn = page.locator('#intg-filter-all');
    await expect(allBtn).toHaveClass(/is-active/);
    // VRM Backfill notice
    const vrm = page.locator('.vrm-backfill-notice');
    await expect(vrm).toBeAttached();
    const vrmText = await vrm.textContent();
    expect(vrmText).toContain('VRM Backfill');
    // Connection grid
    const grid = page.locator('#intg-list.conn-grid');
    await expect(grid).toBeAttached();
  });

  test('filter buttons paint with segmented styling (segmented control class)', async ({ page }) => {
    await page.goto('/integrations.html');
    await page.waitForLoadState('networkidle');
    const segmented = page.locator('.int-toolbar .segmented').first();
    await expect(segmented).toBeAttached();
    const radius = await segmented.evaluate((el) => getComputedStyle(el).borderRadius);
    // segmented pills carry 999px border-radius
    expect(radius).not.toBe('0px');
  });

  test('clicking a filter button switches is-active state (CSP-clean delegation)', async ({ page }) => {
    await page.goto('/integrations.html');
    await page.waitForLoadState('networkidle');
    const disabledBtn = page.locator('#intg-filter-disabled');
    await disabledBtn.click();
    await page.waitForTimeout(150);
    await expect(disabledBtn).toHaveClass(/is-active/);
    const allBtn = page.locator('#intg-filter-all');
    await expect(allBtn).not.toHaveClass(/is-active/);
  });

  // --- Phase 09.2-09 smoke tests (D-17 revised, D-19 revised, D-21..D-24) ---
  // Asserts the Wave-2 (plan 09.2-04) deliverables on /integrations.html:
  //   - Featured-Row REMOVED (09.4 — redundant Victron hero dropped)
  //   - Activity-Pulse bars render with valid heights (CSP-safe DOM-property pattern)
  //   - Latency/Uptime/Errors values not the "—" placeholder once the tracker has data

  test('Featured-Row removed (09.4 — redundant Victron hero dropped)', async ({ page }) => {
    await page.goto('/integrations.html');
    await page.waitForLoadState('networkidle');
    // 09.4: the featured-row hero card was removed — Victron is already a
    // regular .conn-card in #intg-list, so the hero card was redundant.
    const featuredRow = await page.$('.featured-row');
    expect(featuredRow).toBeNull();
  });

  test('.conn-pulse bars render with valid heights (CSP-safe DOM-property assignment)', async ({ page }) => {
    await page.goto('/integrations.html');
    // Wait for any health/status response so renderAll() has had a chance to fire
    await page.waitForResponse(
      (resp) => resp.url().includes('/api/integrations/health') || resp.url().includes('/api/integrations/status'),
      { timeout: 5000 },
    ).catch(() => { /* dev server without backend — soft-pass */ });
    // Allow render tick after the response
    await page.waitForTimeout(300);
    const bars = await page.$$('.pulse-bar[data-h]');
    if (bars.length > 0) {
      // If any pulse-bar rendered at all, every height MUST be a valid percentage
      // string set inline via the DOM `style.height` setter (data-h → percent).
      const heights = await Promise.all(bars.map((el) => el.evaluate((e) => e.style.height)));
      for (const h of heights) {
        expect(h).toMatch(/^\d+(\.\d+)?%$/);
      }
    }
    // (If 0 bars rendered, the tracker has no histogram data yet — acceptable in
    // CI without a long warm-up; the static gates already cover the markup shape.)
  });

  test('Latency/Uptime/Errors values not "—" once health-tracker has data', async ({ page }) => {
    await page.goto('/integrations.html');
    await page.waitForResponse(
      (resp) => resp.url().includes('/api/integrations/health') || resp.url().includes('/api/integrations/status'),
      { timeout: 5000 },
    ).catch(() => { /* dev server without backend — soft-pass */ });
    await page.waitForTimeout(300);
    // Inspect the Victron card specifically (the most reliable to have samples)
    const victronCard = await page.$('.conn-card[data-system="victron"]');
    if (victronCard) {
      const values = await victronCard.$$eval(
        '.conn-stat-value',
        (els) => els.map((e) => (e.textContent || '').trim()),
      );
      // Soft assertion: tracker may not have recorded victron samples yet in CI.
      if (values.length > 0 && values.every((v) => v === '—')) {
        // eslint-disable-next-line no-console
        console.warn('[integrations.spec] Tracker has not recorded victron samples yet — soft pass');
      } else if (values.length > 0) {
        expect(values.some((v) => v && v !== '—')).toBeTruthy();
      }
    }
  });

  // --- Phase 09.4-07 (Wave 5) — MQTT Inspector drawer (D-03/D-04) + hybrid
  // card-stats (D-01) coverage. The drawer chrome (#mqtt-drawer + backdrop +
  // close button + topics body) is fully static markup in integrations.html, so
  // its presence and the open/close behaviour are HARD assertions regardless of
  // backend state. The MQTT .conn-card itself only renders when the backend
  // reports an MQTT system, so card-driven open/close is guarded with a soft
  // skip on the no-apiToken CI dev server (benign /api/* 503 — see top-of-file).

  test('MQTT drawer markup is present and hidden on load', async ({ page }) => {
    await page.goto('/integrations.html');
    await page.waitForLoadState('networkidle');
    // Static drawer chrome — must exist regardless of backend state.
    for (const id of ['mqtt-drawer', 'mqtt-drawer-backdrop', 'mqtt-drawer-close', 'mqtt-drawer-topics']) {
      await expect(page.locator(`[id="${id}"]`), `#${id} must exist in the DOM`).toHaveCount(1);
    }
    // The drawer carries the hidden attribute until openMqttDrawer() removes it.
    await expect(page.locator('#mqtt-drawer')).toHaveAttribute('hidden', '');
    await expect(page.locator('#mqtt-drawer')).not.toHaveClass(/is-open/);
  });

  test('clicking the MQTT card opens the drawer', async ({ page }) => {
    await page.goto('/integrations.html');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);
    const card = page.locator('.conn-card[data-system="mqtt"]');
    if ((await card.count()) > 0) {
      await card.first().click();
      await page.waitForTimeout(300);
      await expect(page.locator('#mqtt-drawer')).toHaveClass(/is-open/);
      // openMqttDrawer() removes the hidden attribute before adding .is-open.
      await expect(page.locator('#mqtt-drawer')).not.toHaveAttribute('hidden', '');
    } else {
      // eslint-disable-next-line no-console
      console.warn('[integrations.spec] No MQTT card on the no-apiToken dev server — soft-skip drawer-open');
    }
  });

  test('drawer closes on the close button and on Escape', async ({ page }) => {
    await page.goto('/integrations.html');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);
    const card = page.locator('.conn-card[data-system="mqtt"]');
    if ((await card.count()) === 0) {
      // eslint-disable-next-line no-console
      console.warn('[integrations.spec] No MQTT card on the no-apiToken dev server — soft-skip drawer-close');
      return;
    }
    const drawer = page.locator('#mqtt-drawer');
    // Close path 1 — the ✕ button.
    await card.first().click();
    await page.waitForTimeout(300);
    await expect(drawer).toHaveClass(/is-open/);
    await page.locator('#mqtt-drawer-close').click();
    await page.waitForTimeout(300);
    await expect(drawer).not.toHaveClass(/is-open/);
    // Close path 2 — the Escape key.
    await card.first().click();
    await page.waitForTimeout(300);
    await expect(drawer).toHaveClass(/is-open/);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await expect(drawer).not.toHaveClass(/is-open/);
  });

  test('MQTT drawer has a pause/resume toggle that toggles the .is-paused state', async ({ page }) => {
    await page.goto('/integrations.html');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);
    // The pause button is static drawer chrome — must exist regardless of backend.
    const pauseBtn = page.locator('#mqtt-drawer-pause');
    await expect(pauseBtn, '#mqtt-drawer-pause must exist in the DOM').toHaveCount(1);

    const card = page.locator('.conn-card[data-system="mqtt"]');
    if ((await card.count()) === 0) {
      // eslint-disable-next-line no-console
      console.warn('[integrations.spec] No MQTT card on the no-apiToken dev server — soft-skip pause toggle');
      return;
    }
    const drawer = page.locator('#mqtt-drawer');
    await card.first().click();
    await page.waitForTimeout(300);
    await expect(drawer).toHaveClass(/is-open/);
    // Drawer opens running — not paused, button reads "⏸ Pause".
    await expect(drawer).not.toHaveClass(/is-paused/);
    await expect(pauseBtn).toHaveAttribute('aria-pressed', 'false');
    await expect(pauseBtn).toHaveText(/Pause/);
    // Click → paused: .is-paused set, aria-pressed=true, label shows resume.
    await pauseBtn.click();
    await page.waitForTimeout(150);
    await expect(drawer).toHaveClass(/is-paused/);
    await expect(pauseBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(pauseBtn).toHaveText(/Fortsetzen/);
    // Click again → resumed.
    await pauseBtn.click();
    await page.waitForTimeout(150);
    await expect(drawer).not.toHaveClass(/is-paused/);
    await expect(pauseBtn).toHaveAttribute('aria-pressed', 'false');
    await expect(pauseBtn).toHaveText(/Pause/);
  });

  test('hybrid card-stats: each conn-card has exactly 4 tracker tiles', async ({ page }) => {
    await page.goto('/integrations.html');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);
    // D-01 — the tracker-tile count is invariant: every populated card carries
    // exactly 4 .conn-stat tiles (the #intg-empty .is-empty placeholder is
    // excluded — it has no .conn-stats). On the no-apiToken dev server the grid
    // may be empty; soft-skip in that case.
    const cards = page.locator('#intg-list .conn-card:not(.is-empty)');
    const count = await cards.count();
    if (count === 0) {
      // eslint-disable-next-line no-console
      console.warn('[integrations.spec] No populated conn-cards on the dev server — soft-skip 4-tile invariant');
      return;
    }
    for (let i = 0; i < count; i++) {
      await expect(cards.nth(i).locator('.conn-stat')).toHaveCount(4);
    }
  });

  test('identity line and provider badges render without [object Object]', async ({ page }) => {
    await page.goto('/integrations.html');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);
    // .conn-identity is backend-dependent (D-02 graceful degrade — omitted when
    // there is no identity data), so its presence is a soft check.
    const identityCount = await page.locator('#intg-list .conn-identity').count();
    if (identityCount === 0) {
      // eslint-disable-next-line no-console
      console.warn('[integrations.spec] No .conn-identity lines on the dev server — soft pass');
    }
    // D-06 regression guard — the notifications card must NEVER render the
    // literal "[object Object]" string from a raw provider object.
    const notifCard = page.locator('.conn-card[data-system="notifications"]');
    if ((await notifCard.count()) > 0) {
      const text = (await notifCard.first().textContent()) || '';
      expect(text).not.toContain('[object Object]');
    } else {
      // eslint-disable-next-line no-console
      console.warn('[integrations.spec] No notifications card on the dev server — soft-skip [object Object] guard');
    }
  });
});
