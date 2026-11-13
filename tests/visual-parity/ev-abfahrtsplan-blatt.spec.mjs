// tests/visual-parity/ev-abfahrtsplan-blatt.spec.mjs — E-Auto-Abfahrtsplan am
// iPhone (WebKit, devices['iPhone 15']): Befunde der Codex-Gegenprüfung 720037e0
// an der echten Oberfläche (Integrationsseite, echtes Speichern):
//   - ein Tag mit zwei Abfahrten (aus einem umgerechneten alten Plan) wird mit
//     „fahre an diesem Tag“ ganz ausgeschaltet — keine Abfahrt rückt nach;
//   - 00:00 ist im Blatt eine gültige Abfahrt;
//   - ein ungültiger Prozentwert (120) wird gemeldet und blockiert „Fertig“.
// Braucht einen laufenden DVhub (PLAYWRIGHT_BASE_URL, Standard http://localhost:8080).
import { test, expect, devices } from '@playwright/test';

const { defaultBrowserType, ...iphone } = devices['iPhone 15'];
test.use({ ...iphone, browserName: defaultBrowserType });

const row = (day, departure, extra = {}) => ({ day, departure, minSocPct: null, tripSocPct: null, homeFrom: '', homeFromPrevDay: false, ...extra });
const PLAN = [row(1, '07:00'), row(6, '09:22', { minSocPct: 60, homeFrom: '09:17' }), row(6, '10:00', { minSocPct: 50 })];
const keepLp = (lp) => (lp == null || lp === '' ? {} : { dashboardLoadpoint: lp });

test.describe('E-Auto-Abfahrtsplan: Blatt und Schalter (Codex 720037e0)', () => {
  let before = null;
  test.beforeEach(async ({ request }) => {
    before = await (await request.get('/api/integrations/evcc')).json();
    const r = await request.post('/api/integrations/evcc', { data: { ...keepLp(before?.dashboardLoadpoint), eos: { departure: { enabled: true, weeklyDepartures: PLAN, targetMode: 'percent', targetValue: 80 } } } });
    expect(r.ok(), await r.text()).toBeTruthy();
  });
  test.afterEach(async ({ request }) => {
    const dep = before?.eos?.departure;
    if (!dep) return;
    await request.post('/api/integrations/evcc', { data: { ...keepLp(before.dashboardLoadpoint), eos: { departure: {
      enabled: dep.enabled === true, weeklyDepartures: dep.weeklyDepartures || [], maxSocPct: dep.maxSocPct ?? '', targetMode: 'percent', targetValue: dep.defaultMinSocPct ?? 80,
    } } } });
  });

  test('Samstag mit zwei Abfahrten ausschalten, Mittwoch 00:00 anlegen, 120 % wird abgelehnt → Speichern', async ({ page, request }) => {
    await page.goto('/integrations.html#evcc');
    const weekly = page.locator('#evcc-dep-weekly');
    // Playwright-WebKit unter Linux (CI): tap() ohne nachfolgenden Klick — bleibt die Schublade zu, einmal klicken.
    await page.waitForLoadState('networkidle');
    if (!(await weekly.isVisible())) {
      const card = page.locator('.conn-card', { hasText: 'Wallbox' }).first();
      await card.tap();
      const open = await expect(page.locator('#dv-drawer-evcc')).toHaveClass(/is-open/, { timeout: 2000 }).then(() => true, () => false);
      if (!open) await card.click();
    }
    await expect(weekly).toBeVisible();
    await page.waitForLoadState('networkidle');
    const sat = weekly.locator('.evw-day[data-day="6"]');
    await expect(sat.locator('.evw-card')).toHaveCount(2);
    await sat.locator('.evw-card').first().locator('.evw-card-sw').tap();
    await expect(sat.locator('.evw-card')).toHaveCount(1);
    await expect(sat.locator('.evw-card')).toHaveClass(/is-off/);
    await expect(sat.locator('.evw-drive')).not.toBeChecked();

    await weekly.locator('.evw-day[data-day="3"] .evw-card-main').tap();
    const sheet = page.locator('.evw-sheet');
    await sheet.locator('#evwSheetDep').fill('00:00');
    await expect(sheet.locator('#evwSheetOk')).toBeEnabled();
    await expect(sheet.locator('#evwSheetEffect')).toContainText('Mi 00:00');
    await sheet.locator('#evwSheetMin').fill('120');
    await expect(sheet.locator('#evwSheetError')).toHaveText('Mindestens bei Abfahrt: 0–100 % oder leer.');
    await expect(sheet.locator('#evwSheetOk')).toBeDisabled();
    // Andere Eingabe danach: der ungültige Wert bleibt sichtbar, der Fehler passt dazu (Codex 702e901a)
    await sheet.locator('#evwSheetDep').fill('00:05');
    await expect(sheet.locator('#evwSheetMin')).toHaveValue('120');
    await expect(sheet.locator('#evwSheetOk')).toBeDisabled();
    await sheet.locator('#evwSheetDep').fill('00:00');
    // leer ist erlaubt (= Standard)
    await sheet.locator('#evwSheetMin').fill('');
    await expect(sheet.locator('#evwSheetError')).toBeHidden();
    await expect(sheet.locator('#evwSheetOk')).toBeEnabled();
    await sheet.locator('#evwSheetMin').fill('85');
    await expect(sheet.locator('#evwSheetOk')).toBeEnabled();
    await sheet.locator('#evwSheetOk').tap();
    await expect(weekly.locator('.evw-day[data-day="3"] .evw-card-time')).toHaveText('00:00');

    const saved = page.waitForResponse((r) => r.url().endsWith('/api/integrations/evcc') && r.request().method() === 'POST');
    await page.locator('#evcc-save').tap();
    expect((await saved).ok()).toBeTruthy();
    const dep = (await (await request.get('/api/integrations/evcc')).json()).eos.departure;
    expect(dep.weeklyDepartures.filter((r) => r.day === 6)).toEqual([row(6, '')]);
    expect(dep.weeklyDepartures.find((r) => r.day === 3)).toEqual(row(3, '00:00', { minSocPct: 85 }));
  });
});
