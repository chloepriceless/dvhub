// tests/visual-parity/ev-wochenplan-leeren-iphone.spec.mjs — Wochenplan: einen
// Tag am iPhone leeren (WebKit, devices['iPhone 15'], Touch). Ablauf und
// Begründung: ev-wochenplan-leeren.shared.mjs. Braucht einen laufenden DVhub
// (PLAYWRIGHT_BASE_URL, Standard http://localhost:8080).
//
// Grenze: Playwright-WebKit zeigt keinen nativen iOS-Zeit-Picker. Geprüft wird,
// dass „Leeren“ ohne Fokus auf ein Zeitfeld auskommt (kein Picker) und die
// Felder als „nicht gesetzt“ ankommen — nicht das Verhalten des Pickers selbst.
import { test, devices } from '@playwright/test';
import { seed, restore, integrationsFlow, tileFlow } from './ev-wochenplan-leeren.shared.mjs';

const { defaultBrowserType, ...iphone } = devices['iPhone 15'];
test.use({ ...iphone, browserName: defaultBrowserType });

test.describe('E-Auto-Wochenplan am iPhone: Tag leeren', () => {
  let before = null;
  test.beforeEach(async ({ request }) => { before = await seed(request); });
  test.afterEach(async ({ request }) => { await restore(request, before); });

  test('Integrationsseite: Mittwoch per Schalter heraus, Dienstag im Blatt 90 % → Speichern → Konfig', async ({ page, request }, testInfo) => {
    await integrationsFlow(page, request, testInfo, { touchMin: 44 });
  });

  test('Leitstand-Kachel: Mittwoch per Schalter heraus → Übernehmen schickt den Tag als nicht gesetzt', async ({ page, request, browserName }, testInfo) => {
    // Playwright-WebKit unter Linux (GitHub-CI): In der Leitstand-Kachel kommt tap() nicht verlässlich als Klick an bzw.
    // wartet bis zum Timeout auf „stabil“ — dreimal in Folge an wechselnden Knöpfen (Tag-CI v1.0.10, 13.11.2026), lokal
    // im Playwright-Container nicht nachstellbar. Den Ablauf prüft der Desktop-Test (Chromium); auf macOS läuft dieser
    // iPhone-Test weiter mit.
    test.skip(process.platform === 'linux' && browserName === 'webkit', 'Linux-WebKit: tap() in der Leitstand-Kachel unzuverlässig');
    await tileFlow(page, request, testInfo, { touchMin: 44 });
  });
});
