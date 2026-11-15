// tests/visual-parity/ev-wochenplan-leeren.shared.mjs — gemeinsamer Ablauf der
// Specs ev-wochenplan-leeren-{iphone,desktop}.spec.mjs.
//
// Seit T-0427 (Karten je Abfahrtstag): einen Tag per Schalter „fahre an diesem
// Tag“ herausnehmen, OHNE ein Zeitfeld anzutippen (am iPhone öffnete das
// sofort den Zeit-Picker, Christin 10.11.2026), einen anderen Tag im Blatt
// ändern (mind. 90 %), dann speichern — die Konfig zeigt den Tag als „nicht
// gesetzt“, die Änderung des anderen Tages ist da.
//
//  1. Integrationsseite (Wallbox-Schublade): echtes Speichern über
//     POST /api/integrations/evcc, danach GET zeigt Mittwoch leer.
//  2. Leitstand-Kachel: „Übernehmen“ geht an POST /api/ev (braucht Pro). Die
//     Anfrage wird abgefangen und ihr Inhalt geprüft; was der Server daraus
//     machte, rechnet POST /api/ev/preview (ohne Pro) echt nach.
//
// Einmal-Ziel (Knopf + Dialog + Karte, ev-once.js, auf beiden Seiten):
// „Beenden“ → Rückfrage „Beenden“ → sofort POST /api/ev mit leerem
// Einmal-Ziel (abgefangen, Pro). Die Wochenplan-Speicher schicken kein
// Einmal-Ziel mit.
//
// Setzt vorher einen Plan und stellt danach den vorherigen Stand wieder her.
// Screenshots: EVW_SHOT_DIR (sonst test-results).

import { expect } from '@playwright/test';

// Mittwoch 07:30 mit 60 %, zuhause ab Dienstag 18:00; Mo–Fr sonst 07:00.
export const WED_FULL = { day: 3, departure: '07:30', minSocPct: 60, tripSocPct: 25, homeFrom: '18:00', homeFromPrevDay: true };
export const WED_EMPTY = { day: 3, departure: '', minSocPct: null, tripSocPct: null, homeFrom: '', homeFromPrevDay: false };
const PLAN = [1, 2, 3, 4, 5, 6, 7].map((day) => (day === 3 ? WED_FULL
  : { day, departure: day <= 5 ? '07:00' : '', minSocPct: null, tripSocPct: null, homeFrom: '', homeFromPrevDay: false }));
const ONCE = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 16) + ':00.000Z';

// POST /api/integrations/evcc setzt einen fehlenden dashboardLoadpoint auf
// null — darum immer den vorhandenen mitschicken (Codex dc0028cc, P2).
const keepLp = (lp) => (lp == null || lp === '' ? {} : { dashboardLoadpoint: lp });

export async function seed(request) {
  const before = await (await request.get('/api/integrations/evcc')).json();
  const r = await request.post('/api/integrations/evcc', { data: { ...keepLp(before?.dashboardLoadpoint), eos: { departure: {
    enabled: true, weeklyDepartures: PLAN, once: ONCE, onceMinSocPct: 75, onceTripSocPct: 40, targetMode: 'percent', targetValue: 80,
  } } } });
  expect(r.ok(), await r.text()).toBeTruthy();
  return before?.eos?.departure ? { dep: before.eos.departure, lp: before.dashboardLoadpoint } : null;
}

export async function restore(request, saved) {
  if (!saved) return;
  const { dep, lp } = saved;
  await request.post('/api/integrations/evcc', { data: { ...keepLp(lp), eos: { departure: {
    enabled: dep.enabled === true, weeklyDepartures: dep.weeklyDepartures || [], once: dep.once || '', arrivalOnce: dep.arrivalOnce || '',
    onceMinSocPct: dep.onceMinSocPct ?? '', onceTripSocPct: dep.onceTripSocPct ?? '', maxSocPct: dep.maxSocPct ?? '',
    targetMode: 'percent', targetValue: dep.defaultMinSocPct ?? dep.targetValue ?? 80,
  } } } });
}

export function shotPath(testInfo, name) {
  const dir = process.env.EVW_SHOT_DIR;
  const which = String(testInfo.file || '').replace(/^.*ev-wochenplan-leeren-/, '').replace(/\.spec\.mjs$/, '') || 'pw';
  return dir ? `${dir}/${which}-${name}.png` : testInfo.outputPath(`${name}.png`);
}

// Tippen (Touch-Geraet) oder klicken.
async function press(page, locator) {
  const touch = await page.evaluate(() => 'ontouchstart' in window || navigator.maxTouchPoints > 0);
  // Mittig scrollen: Am unteren Rand lag „Übernehmen“ in der CI unter dem Warnbanner (Linux-WebKit, iPhone-Viewport).
  await locator.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  if (touch) await locator.tap(); else await locator.click();
}

// Ein Zeitfeld darf beim Leeren nie den Fokus bekommen (iOS oeffnete sonst den Picker).
async function noTimeFieldFocused(page) {
  const t = await page.evaluate(() => (document.activeElement && document.activeElement.type) || '');
  expect(['time', 'datetime-local']).not.toContain(t);
}

// Karte zeigt „kein Termin“, Schalter aus.
async function expectDayOff(weekly, day) {
  const card = weekly.locator(`.evw-day[data-day="${day}"] .evw-card`).first();
  await expect(card).toHaveClass(/is-off/);
  await expect(card.locator('.evw-card-none')).toHaveText('kein Termin');
  await expect(card.locator('.evw-drive')).not.toBeChecked();
}

// Dienstag im Blatt auf „mind. 90 %“ stellen (Knopf statt Tippen).
async function setTuesday90(page, weekly) {
  await press(page, weekly.locator('.evw-day[data-day="2"] .evw-card-main').first());
  const sheet = page.locator('.evw-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('#evwSheetTitle')).toHaveText('Dienstag');
  await press(page, sheet.getByRole('button', { name: '90\u00a0%' }));
  await expect(sheet.getByRole('button', { name: '90\u00a0%' })).toHaveAttribute('aria-pressed', 'true');
  await expect(sheet.locator('#evwSheetEffect')).toContainText('Di 07:00 mit mindestens 90');
  await press(page, sheet.locator('#evwSheetOk'));
  await expect(sheet).toHaveCount(0);
  await expect(weekly.locator('.evw-day[data-day="2"] .evw-card-min')).toHaveText('mind. 90\u00a0%');
}

// Einmal-Ziel über den Chip beenden; liefert den Inhalt des (abgefangenen) POST /api/ev.
async function endOnceViaChip(page, slot, posted) {
  await expect(slot.locator('[data-evo="chip"]')).toBeVisible();
  await expect(slot.locator('[data-evo="title"]')).toContainText('Einmalig:');
  const n = posted.length;
  await press(page, slot.locator('[data-evo="end"]'));
  const dlg = page.locator('.ev-once-confirm');
  await expect(dlg).toBeVisible();
  await press(page, dlg.getByRole('button', { name: 'Beenden' }));
  await expect.poll(() => posted.length).toBeGreaterThan(n);
  const body = posted[posted.length - 1];
  expect(body).toEqual({ departure: { once: '', onceMinSocPct: '', onceTripSocPct: '', arrivalOnce: '' } });
  return body;
}

// POST /api/ev braucht Pro (Rig ohne Lizenz): abfangen, Inhalte sammeln.
async function catchEvPosts(page) {
  const posted = [];
  await page.route('**/api/ev', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    posted.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  return posted;
}

async function expectTouchSize(locator, min) {
  const box = await locator.boundingBox();
  expect(box, 'Knopf sichtbar').not.toBeNull();
  expect(box.width).toBeGreaterThanOrEqual(min);
  expect(box.height).toBeGreaterThanOrEqual(min);
}

export async function integrationsFlow(page, request, testInfo, { touchMin }) {
  const posted = await catchEvPosts(page);
  await page.goto('/integrations.html#evcc');
  // Wallbox-Schublade öffnen (Karte; inline-Ansicht zeigt sie ggf. schon).
  const weekly = page.locator('#evcc-dep-weekly');
  // Playwright-WebKit unter Linux (CI) erzeugt bei tap() nur Touch-Events, keinen nachfolgenden Klick; die Karte öffnet
  // ihre Schublade per Klick (echtes iOS und macOS-WebKit synthetisieren ihn). Bleibt sie zu, deshalb einmal klicken
  // (CI-Lauf cd33efa0, 13.11.2026).
  await page.waitForLoadState('networkidle');
  if (!(await weekly.isVisible())) {
    const card = page.locator('.conn-card', { hasText: 'Wallbox' }).first();
    await press(page, card);
    const open = await expect(page.locator('#dv-drawer-evcc')).toHaveClass(/is-open/, { timeout: 2000 }).then(() => true, () => false);
    if (!open) await card.click();
  }
  await expect(weekly).toBeVisible();
  // Die Schublade baut den Editor nach dem Laden der Daten neu auf — erst danach greifen.
  await page.waitForLoadState('networkidle');
  const wed = weekly.locator('.evw-day[data-day="3"] .evw-card').first();
  await expect(wed.locator('.evw-card-time')).toHaveText('07:30');
  await expect(wed.locator('.evw-card-min')).toHaveText('mind. 60\u00a0%');
  await expect(wed.locator('.evw-card-sub')).toContainText('zuhause ab Di 18:00');
  const sw = wed.locator('.evw-card-sw');
  await sw.scrollIntoViewIfNeeded();
  await expectTouchSize(sw, touchMin);
  await page.locator('#evcc-dep-weekly').screenshot({ path: shotPath(testInfo, 'integrations-vorher') });
  await press(page, sw);
  await noTimeFieldFocused(page);
  await expectDayOff(weekly, 3);
  await setTuesday90(page, weekly);
  // Andere Tage bleiben.
  await expect(weekly.locator('.evw-day[data-day="4"] .evw-card-time')).toHaveText('07:00');
  // Einmal-Ziel: Karte mit „Beenden“ (sofort gespeichert).
  await endOnceViaChip(page, page.locator('#evcc-once-slot'), posted);
  await noTimeFieldFocused(page);
  await page.locator('#evcc-dep-weekly').screenshot({ path: shotPath(testInfo, 'integrations-nachher') });
  const saved = page.waitForResponse((r) => r.url().endsWith('/api/integrations/evcc') && r.request().method() === 'POST');
  await press(page, page.locator('#evcc-save'));
  const res = await saved;
  expect(res.ok(), await res.text()).toBeTruthy();
  // Die Schublade schickt kein Einmal-Ziel mit.
  expect(JSON.stringify(res.request().postDataJSON()?.eos?.departure || {})).not.toMatch(/once|arrivalOnce/i);
  // Konfig am Server: Mittwoch nicht gesetzt, Dienstag 90 %; das Einmal-Ziel
  // fasst die Schublade nicht an (das „Beenden“ oben ging abgefangen an POST /api/ev).
  const dep = (await (await request.get('/api/integrations/evcc')).json()).eos.departure;
  expect(dep.weeklyDepartures.filter((r) => r.day === 3)).toEqual([WED_EMPTY]);
  expect(dep.weeklyDepartures.find((r) => r.day === 2)).toMatchObject({ departure: '07:00', minSocPct: 90 });
  expect(dep.once).toBe(ONCE);
  // Und daraus entsteht keine Abfahrt am Mittwoch.
  const ev = await (await request.get('/api/ev')).json();
  expect(ev.departure.resolved.day).not.toBe(3);
  return dep;
}

export async function tileFlow(page, request, testInfo, { touchMin }) {
  const posted = await catchEvPosts(page);
  // Leitstand direkt: „/“ zeigt auf einer frischen Box (config.example.json,
  // setupCompleted:false — so wie in der CI) den Einrichtungs-Assistenten.
  await page.goto('/index.html');
  const tog = page.locator('#evWeekToggle');
  if ((await tog.getAttribute('aria-expanded')) !== 'true') await press(page, tog);
  const weekly = page.locator('#evWeeklyGrid');
  const wed = weekly.locator('.evw-day[data-day="3"] .evw-card').first();
  await expect(wed.locator('.evw-card-time')).toHaveText('07:30');
  const sw = wed.locator('.evw-card-sw');
  await sw.scrollIntoViewIfNeeded();
  await expectTouchSize(sw, touchMin);
  await page.locator('#evWeekly').screenshot({ path: shotPath(testInfo, 'kachel-vorher') });
  await press(page, sw);
  await noTimeFieldFocused(page);
  await expectDayOff(weekly, 3);
  await setTuesday90(page, weekly);
  await expect(page.locator('#evActions')).toBeVisible();
  // Einmal-Ziel: Karte in der Kachel, „Beenden“ speichert sofort für sich.
  await endOnceViaChip(page, page.locator('#evOnceSlot'), posted);
  await page.locator('#evWeekly').screenshot({ path: shotPath(testInfo, 'kachel-nachher') });
  const n = posted.length;
  // In der GitHub-CI (Linux-WebKit, iPhone) lag „Übernehmen“ unter dem Warnbanner bzw. galt nie als „stabil“; tap()
  // lief dreimal in Folge in den Timeout (CI db1dcce0). Deshalb hier den Klick direkt auslösen: Geprüft wird, was
  // „Übernehmen“ schickt, nicht die Berührung (die prüfen die Schalter und das Blatt oben).
  await expect(page.locator('#evSave')).toBeVisible();
  await page.locator('#evSave').dispatchEvent('click');
  await expect.poll(() => posted.length).toBeGreaterThan(n);
  const d = posted[posted.length - 1].departure;
  expect(d.weeklyDepartures.filter((r) => r.day === 3)).toEqual([WED_EMPTY]);
  expect(d.weeklyDepartures.find((r) => r.day === 2)).toMatchObject({ departure: '07:00', minSocPct: 90 });
  // „Übernehmen“ des Wochenplans überschreibt das Einmal-Ziel nicht.
  expect('once' in d || 'onceMinSocPct' in d || 'arrivalOnce' in d).toBe(false);
  // Der echte Server nimmt genau diesen Inhalt an und plant keine Abfahrt am Mittwoch.
  const pv = await (await request.post('/api/ev/preview', { data: { departure: d } })).json();
  expect(pv.ok, JSON.stringify(pv)).toBe(true);
  expect(pv.resolved.day).not.toBe(3);
  return d;
}
