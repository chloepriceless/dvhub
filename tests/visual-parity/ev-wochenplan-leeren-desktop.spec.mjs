// tests/visual-parity/ev-wochenplan-leeren-desktop.spec.mjs — Wochenplan: einen
// Tag am Desktop leeren (Chromium, Maus). Ablauf: ev-wochenplan-leeren.shared.mjs.
// Braucht einen laufenden DVhub (PLAYWRIGHT_BASE_URL, Standard http://localhost:8080).
import { test } from '@playwright/test';
import { seed, restore, integrationsFlow, tileFlow } from './ev-wochenplan-leeren.shared.mjs';

test.use({ browserName: 'chromium' });

test.describe('E-Auto-Wochenplan am Desktop: Tag leeren', () => {
  let before = null;
  test.beforeEach(async ({ request }) => { before = await seed(request); });
  test.afterEach(async ({ request }) => { await restore(request, before); });

  test('Integrationsseite: Mittwoch per Schalter heraus, Dienstag im Blatt 90 % → Speichern → Konfig', async ({ page, request }, testInfo) => {
    // Maus: Schalter in der Wochenleiste (breite Schublade) darf flacher sein.
    await integrationsFlow(page, request, testInfo, { touchMin: 36 });
  });

  test('Leitstand-Kachel: Mittwoch per Schalter heraus → Übernehmen schickt den Tag als nicht gesetzt', async ({ page, request }, testInfo) => {
    // Schmale Leitstand-Spalte: Karte mit Schalter in Fingergröße.
    await tileFlow(page, request, testInfo, { touchMin: 44 });
  });
});
