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

  test('Integrationsseite: „Mittwoch leeren“ → Speichern → Konfig zeigt Mittwoch leer', async ({ page, request }, testInfo) => {
    // Maus: kleinerer Knopf in der letzten Spalte (breite Schublade) ist erlaubt.
    await integrationsFlow(page, request, testInfo, { touchMin: 24 });
  });

  test('Leitstand-Kachel: „Mittwoch leeren“ → Übernehmen schickt den Tag als nicht gesetzt', async ({ page, request }, testInfo) => {
    // Schmale Leitstand-Spalte: zweizeilige Zeile, Knopf in Fingergröße.
    await tileFlow(page, request, testInfo, { touchMin: 44 });
  });
});
