// tests/visual-parity/build-reload.spec.mjs — T-0423 (Christin 11.11.2026):
// Nach dem Update auf test-5 zeigte die offene Home-Screen-Webapp die alte
// E-Auto-Kachel ohne Wochenplan, bis sie von Hand geschlossen wurde. Die
// Oberfläche erkennt jetzt eine neue Build-Kennung (Kopfzeile X-DVhub-Build)
// und lädt neu (public/build-watch.js).
//
// Der Versionswechsel wird simuliert: Playwright schreibt in die echten
// Antworten des laufenden DVhub eine andere Kennung. Braucht einen laufenden
// DVhub (PLAYWRIGHT_BASE_URL, Standard http://localhost:8080).
import { test, expect } from '@playwright/test';

// PW_BROWSER=webkit prüft die Safari-Engine (Home-Screen-Webapp am iPhone).
test.use({ browserName: process.env.PW_BROWSER || 'chromium' });

// Alle Antworten mit Kennung (API + /health) bekommen ggf. die gespielte.
async function fakeBuild(page) {
  const state = { build: null };
  await page.route(/\/(api\/.*|health)(\?.*)?$/, async (route) => {
    const res = await route.fetch();
    const headers = { ...res.headers() };
    if (state.build && headers['x-dvhub-build']) headers['x-dvhub-build'] = state.build;
    await route.fulfill({ response: res, headers });
  });
  return state;
}

async function baselineOf(page) {
  await expect.poll(() => page.evaluate(() => window.DVhubBuildWatch && window.DVhubBuildWatch.state().baseline), { timeout: 15_000 })
    .toMatch(/^[0-9a-f]{12}$/);
  return page.evaluate(() => window.DVhubBuildWatch.state().baseline);
}

const marked = (page) => page.evaluate(() => window.__vorReload === 1).catch(() => false);

test.describe('Neue DVhub-Version: Seite lädt neu', () => {
  test('Leitstand, nichts bearbeitet: Hinweis, dann automatisch neu — genau einmal', async ({ page }) => {
    const fake = await fakeBuild(page);
    await page.goto('/index.html');
    const base = await baselineOf(page);
    await page.evaluate(() => { window.__vorReload = 1; });
    fake.build = base === 'feedfacecafe' ? 'deadbeef0001' : 'feedfacecafe';

    const notice = page.locator('.dv-build-notice');
    await expect(notice).toBeVisible({ timeout: 15_000 });
    await expect(notice).toHaveAttribute('role', 'status');
    await expect(notice).toContainText('Neue DVhub-Version installiert');
    await expect.poll(() => marked(page), { timeout: 15_000 }).toBe(false);
    // neue Seite: Ausgangsstand = neue Kennung, kein zweites Neuladen
    expect(await baselineOf(page)).toBe(fake.build);
    await page.evaluate(() => { window.__nachReload = 1; });
    await page.waitForTimeout(8_000);
    expect(await page.evaluate(() => window.__nachReload)).toBe(1);
    const guard = await page.evaluate(() => JSON.parse(sessionStorage.getItem('dvhub.buildReload')));
    expect(guard.id).toBe(fake.build);
  });

  test('offener Dialog: Hinweis mit Knopf, kein Neuladen; nach dem Schließen automatisch', async ({ page }) => {
    const fake = await fakeBuild(page);
    await page.goto('/index.html');
    const base = await baselineOf(page);
    await page.evaluate(() => { window.__vorReload = 1; window.dvConfirm('Testdialog'); });
    await expect(page.locator('.dv-modal')).toBeVisible();
    fake.build = base === 'feedfacecafe' ? 'deadbeef0002' : 'feedfacecafe';

    const notice = page.locator('.dv-build-notice');
    await expect(notice).toBeVisible({ timeout: 15_000 });
    await expect(notice).toHaveAttribute('data-mode', 'waiting');
    await expect(notice).toContainText('Neue DVhub-Version installiert — neu laden');
    await expect(notice.getByRole('button', { name: 'Neu laden' })).toBeVisible();
    await page.waitForTimeout(6_000);
    expect(await marked(page)).toBe(true);

    await page.keyboard.press('Escape'); // Dialog zu
    await expect(page.locator('.dv-modal')).toHaveCount(0);
    await expect.poll(() => marked(page), { timeout: 10_000 }).toBe(false);
  });

  test('Einstellungen mit ungespeicherter Änderung: Hinweis; Knopf „Neu laden“ lädt', async ({ page }) => {
    const fake = await fakeBuild(page);
    await page.goto('/settings.html');
    const base = await baselineOf(page);
    await page.evaluate(() => { window.__vorReload = 1; document.body.classList.add('has-changes'); });
    fake.build = base === 'feedfacecafe' ? 'deadbeef0003' : 'feedfacecafe';
    // Einstellungen haben keinen Status-Poll: Rückkehr in die Seite prüft (/health)
    await page.waitForTimeout(5_500);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

    const notice = page.locator('.dv-build-notice');
    await expect(notice).toBeVisible({ timeout: 15_000 });
    await expect(notice).toHaveAttribute('data-mode', 'waiting');
    await page.waitForTimeout(4_000);
    expect(await marked(page)).toBe(true);
    await notice.getByRole('button', { name: 'Neu laden' }).click();
    await expect.poll(() => marked(page), { timeout: 10_000 }).toBe(false);
  });

  test('Integrationen am Desktop (Einstellungen in der Mitte): nichts bearbeitet → automatisch neu', async ({ page }) => {
    const fake = await fakeBuild(page);
    await page.goto('/integrations.html');
    const base = await baselineOf(page);
    await page.evaluate(() => { window.__vorReload = 1; });
    fake.build = base === 'feedfacecafe' ? 'deadbeef0006' : 'feedfacecafe';
    await expect.poll(() => marked(page), { timeout: 20_000 }).toBe(false);
  });

  test('Schleifenschutz: zweiter Wechsel binnen einer Minute nur als Hinweis', async ({ page }) => {
    const fake = await fakeBuild(page);
    await page.goto('/index.html');
    const base = await baselineOf(page);
    fake.build = base === 'feedfacecafe' ? 'deadbeef0004' : 'feedfacecafe';
    await page.evaluate(() => { window.__vorReload = 1; });
    await expect.poll(() => marked(page), { timeout: 15_000 }).toBe(false);
    await baselineOf(page);
    await page.evaluate(() => { window.__vorReload = 1; });
    fake.build = 'abcabcabc005';
    const notice = page.locator('.dv-build-notice');
    await expect(notice).toHaveAttribute('data-mode', 'manual', { timeout: 15_000 });
    await expect(notice).toBeVisible();
    await page.waitForTimeout(8_000);
    expect(await marked(page)).toBe(true);
    // ausblenden geht, Seite bleibt
    await notice.getByRole('button', { name: 'Hinweis ausblenden' }).click();
    await expect(notice).toBeHidden();
  });
});
