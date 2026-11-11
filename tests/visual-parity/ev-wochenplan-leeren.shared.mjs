// tests/visual-parity/ev-wochenplan-leeren.shared.mjs — gemeinsamer Ablauf der
// Specs ev-wochenplan-leeren-{iphone,desktop}.spec.mjs (Christin 10.11.2026):
// einen Tag im E-Auto-Wochenplan leeren, OHNE ins Zeitfeld zu tippen (am
// iPhone oeffnete das sofort den Zeit-Picker und setzte eine Zeit), dann
// speichern — die Konfig zeigt den Tag als „nicht gesetzt“.
//
//  1. Integrationsseite (Wallbox-Schublade): echtes Speichern über
//     POST /api/integrations/evcc, danach GET zeigt Mittwoch leer.
//  2. Leitstand-Kachel: „Übernehmen“ geht an POST /api/ev (braucht Pro). Die
//     Anfrage wird abgefangen und ihr Inhalt geprüft; was der Server daraus
//     machte, rechnet POST /api/ev/preview (ohne Pro) echt nach.
//
// Einmal-Ziel (seit 11.11.2026 Knopf + Dialog + Aktiv-Chip, ev-once.js, auf
// beiden Seiten): „Beenden“ → Rückfrage „Beenden“ → sofort POST /api/ev mit
// leerem Einmal-Ziel (abgefangen, Pro). Die Wochenplan-Speicher schicken kein
// Einmal-Ziel mehr mit.
//
// Setzt vorher einen Plan mit Werten am Mittwoch und stellt danach den
// vorherigen Stand wieder her. Screenshots: EVW_SHOT_DIR (sonst test-results).

import { expect } from '@playwright/test';

export const WED_FULL = { day: 3, arrival: '18:00', departure: '07:30', minSocPct: 60, tripSocPct: 25 };
export const WED_EMPTY = { day: 3, arrival: '', departure: '', minSocPct: null, tripSocPct: null };
const PLAN = [1, 2, 3, 4, 5, 6, 7].map((day) => (day === 3 ? WED_FULL
  : { day, arrival: '', departure: day <= 5 ? '07:00' : '', minSocPct: null, tripSocPct: null }));
const ONCE = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 16) + ':00.000Z';

// POST /api/integrations/evcc setzt einen fehlenden dashboardLoadpoint auf
// null — darum immer den vorhandenen mitschicken (Codex dc0028cc, P2).
const keepLp = (lp) => (lp == null || lp === '' ? {} : { dashboardLoadpoint: lp });

export async function seed(request) {
  const before = await (await request.get('/api/integrations/evcc')).json();
  const r = await request.post('/api/integrations/evcc', { data: { ...keepLp(before?.dashboardLoadpoint), eos: { departure: {
    enabled: true, weeklyPlan: PLAN, once: ONCE, onceMinSocPct: 75, onceTripSocPct: 40, targetMode: 'percent', targetValue: 80,
  } } } });
  expect(r.ok(), await r.text()).toBeTruthy();
  return before?.eos?.departure ? { dep: before.eos.departure, lp: before.dashboardLoadpoint } : null;
}

export async function restore(request, saved) {
  if (!saved) return;
  const { dep, lp } = saved;
  await request.post('/api/integrations/evcc', { data: { ...keepLp(lp), eos: { departure: {
    enabled: dep.enabled === true, weeklyPlan: dep.weeklyPlan || [], once: dep.once || '', arrivalOnce: dep.arrivalOnce || '',
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
  if (touch) await locator.tap(); else await locator.click();
}

// Ein Zeitfeld darf beim Leeren nie den Fokus bekommen (iOS oeffnete sonst den Picker).
async function noTimeFieldFocused(page) {
  const t = await page.evaluate(() => (document.activeElement && document.activeElement.type) || '');
  expect(['time', 'datetime-local']).not.toContain(t);
}

async function expectRowEmpty(row) {
  for (const sel of ['.evw-arr', '.evw-dep', '.evw-min', '.evw-trip']) await expect(row.locator(sel)).toHaveValue('');
  await expect(row.locator('.evw-res')).toHaveText('kein Termin');
  await expect(row.locator('.evw-res')).toBeVisible();
}

// Einmal-Ziel über den Chip beenden; liefert den Inhalt des (abgefangenen) POST /api/ev.
async function endOnceViaChip(page, slot, posted) {
  await expect(slot.locator('[data-evo="chip"]')).toBeVisible();
  await expect(slot.locator('[data-evo="title"]')).toContainText('Einmal-Ziel aktiv');
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
  if (!(await weekly.isVisible())) await press(page, page.locator('.conn-card', { hasText: 'Wallbox' }).first());
  // Die Schublade baut den Editor nach dem Laden der Daten neu auf — erst danach
  // greifen (sonst „Element is not attached to the DOM“, gelegentlich).
  await page.waitForLoadState('networkidle');
  const row = weekly.locator('.evw-row[data-day="3"]');
  await expect(row.locator('.evw-dep')).toHaveValue('07:30');
  await expect(row.locator('.evw-min')).toHaveValue('60');
  const btn = row.getByRole('button', { name: 'Mittwoch leeren' });
  await btn.scrollIntoViewIfNeeded();
  await expectTouchSize(btn, touchMin);
  await page.locator('#evcc-dep-weekly').screenshot({ path: shotPath(testInfo, 'integrations-vorher') });
  await press(page, btn);
  await noTimeFieldFocused(page);
  await expectRowEmpty(row);
  // Andere Tage bleiben.
  await expect(weekly.locator('.evw-row[data-day="2"] .evw-dep')).toHaveValue('07:00');
  // Einmal-Ziel: keine Dauerfelder mehr, Chip mit „Beenden“ (sofort gespeichert).
  await expect(page.locator('#evcc-dep-once')).toHaveCount(0);
  await endOnceViaChip(page, page.locator('#evcc-once-slot'), posted);
  await noTimeFieldFocused(page);
  await page.locator('#evcc-dep-weekly').screenshot({ path: shotPath(testInfo, 'integrations-nachher') });
  const saved = page.waitForResponse((r) => r.url().endsWith('/api/integrations/evcc') && r.request().method() === 'POST');
  await press(page, page.locator('#evcc-save'));
  const res = await saved;
  expect(res.ok(), await res.text()).toBeTruthy();
  // Die Schublade schickt kein Einmal-Ziel mehr mit.
  expect(JSON.stringify(res.request().postDataJSON()?.eos?.departure || {})).not.toMatch(/once|arrivalOnce/i);
  // Konfig am Server: Mittwoch nicht gesetzt; das Einmal-Ziel fasst die
  // Schublade nicht an (das „Beenden“ oben ging abgefangen an POST /api/ev).
  const dep = (await (await request.get('/api/integrations/evcc')).json()).eos.departure;
  expect(dep.weeklyPlan[2]).toEqual(WED_EMPTY);
  expect(dep.weeklyPlan[1].departure).toBe('07:00');
  expect(dep.once).toBe(ONCE);
  // Und daraus entsteht keine Abfahrt vom Mittwoch.
  const ev = await (await request.get('/api/ev')).json();
  expect(ev.departure.resolved.day).not.toBe(3);
  return dep;
}

export async function tileFlow(page, request, testInfo, { touchMin }) {
  const posted = await catchEvPosts(page);
  await page.goto('/');
  await press(page, page.locator('#evWeekToggle'));
  const row = page.locator('#evWeeklyGrid .evw-row[data-day="3"]');
  await expect(row.locator('.evw-arr')).toHaveValue('18:00');
  const btn = row.getByRole('button', { name: 'Mittwoch leeren' });
  await btn.scrollIntoViewIfNeeded();
  await expectTouchSize(btn, touchMin);
  await page.locator('#evWeekly').screenshot({ path: shotPath(testInfo, 'kachel-vorher') });
  await press(page, btn);
  await noTimeFieldFocused(page);
  await expectRowEmpty(row);
  await expect(page.locator('#evActions')).toBeVisible();
  // Einmal-Ziel: Chip in der Kachel, „Beenden“ speichert sofort für sich.
  await expect(page.locator('#evDepOnce')).toHaveCount(0);
  await endOnceViaChip(page, page.locator('#evOnceSlot'), posted);
  await page.locator('#evWeekly').screenshot({ path: shotPath(testInfo, 'kachel-nachher') });
  const n = posted.length;
  await press(page, page.locator('#evSave'));
  await expect.poll(() => posted.length).toBeGreaterThan(n);
  const d = posted[posted.length - 1].departure;
  expect(d.weeklyPlan[2]).toEqual(WED_EMPTY);
  expect(d.weeklyPlan[1].departure).toBe('07:00');
  // „Übernehmen“ des Wochenplans überschreibt das Einmal-Ziel nicht.
  expect('once' in d || 'onceMinSocPct' in d || 'arrivalOnce' in d).toBe(false);
  // Der echte Server nimmt genau diesen Inhalt an und plant keine Abfahrt vom Mittwoch.
  const pv = await (await request.post('/api/ev/preview', { data: { departure: d } })).json();
  expect(pv.ok, JSON.stringify(pv)).toBe(true);
  expect(pv.resolved.day).not.toBe(3);
  return d;
}
