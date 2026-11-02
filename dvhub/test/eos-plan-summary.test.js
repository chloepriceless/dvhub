// test/eos-plan-summary.test.js -- „Laut EOS-Plan“ unter dem Day-Ahead-Chart
// (Issue #27, Richtungswechsel 26.10.2026): statt eigener Schwellen zeigt der
// Leitstand, was EOS für heute (ab jetzt) und morgen plant — Einspeisung und
// Netzbezug in kWh, Stunden, höchster Leistung und dem niedrigsten Einspeisewert
// bzw. höchsten Bezugspreis der geplanten Slots (keine Schwellen, Christin
// 02.11.2026); mit Spitzenkappung die Slots über der Grenze.
// Reine Logik aus public/eos-plan-summary.js, geladen wie im Browser. Alle
// erwarteten Zahlen sind von Hand gerechnet (Kommentare an den Fixtures).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

function load() {
  const file = fileURLToPath(new URL('../public/eos-plan-summary.js', import.meta.url));
  const sandbox = { window: {}, document: undefined };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: 'eos-plan-summary.js' });
  return sandbox.window.DVhubEosPlanSummary;
}

const Q = 15 * 60 * 1000;
const H = 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const blank = (ts) => ({ ts_utc: iso(ts), socPct: 50, pvWh: 0, loadWh: 300, priceCtKwh: 26.9, feedInCtKwh: 10, gridConsumptionWh: 0, gridFeedinWh: 0 });

// 26.10.2026 ist Winterzeit (UTC+1). Plan ab 12:45Z, jetzt 13:09Z = 14:09 Uhr.
// Index i zählt ab 13:00Z (14:00 Uhr); der Slot 12:45Z ist vorbei und zählt nicht.
const P0 = Date.UTC(2026, 9, 26, 13, 0);
const NOW = Date.UTC(2026, 9, 26, 13, 9);
function plan15() {
  const rows = [];
  // vergangener Slot mit großer Einspeisung zu 1 ct — darf nichts beeinflussen
  rows.push({ ...blank(P0 - Q), gridFeedinWh: 9000, feedInCtKwh: 1, gridConsumptionWh: 9000, priceCtKwh: 99 });
  for (let i = 0; i < 80; i += 1) rows.push(blank(P0 + i * Q)); // bis 08:45Z morgen (Ende 10:00 Uhr)
  const at = (i, f) => Object.assign(rows[i + 1], f);
  // heute Einspeisung: 1000 Wh (4 kW) 19,94 ct · 500 Wh (2 kW) 21,1 ct · 2× 3000 Wh (12 kW)
  at(3, { gridFeedinWh: 1000, feedInCtKwh: 19.94 });
  at(7, { gridFeedinWh: 500, feedInCtKwh: 21.1 });
  at(14, { gridFeedinWh: 3000, feedInCtKwh: 27.2 });
  at(15, { gridFeedinWh: 3000, feedInCtKwh: 27.8 });
  // unter 300 W: 40 Wh (160 W) zu 15 ct und Rauschen 0,003 Wh zu 5 ct — zählen in
  // die kWh, aber nicht zu Stunden und Preis
  at(10, { gridFeedinWh: 40, feedInCtKwh: 15 });
  at(20, { gridFeedinWh: 0.003, feedInCtKwh: 5 });
  // heute Netzbezug: 100 Wh (400 W) + 200 Wh (800 W) zu 26,9 ct, 1500 Wh (6 kW)
  // um 23:00 Uhr zu 30,5 ct, 60 Wh (240 W) zu 40 ct unter der Schwelle
  at(8, { gridConsumptionWh: 100 });
  at(9, { gridConsumptionWh: 200 });
  at(36, { gridConsumptionWh: 1500, priceCtKwh: 30.5 });
  at(37, { gridConsumptionWh: 60, priceCtKwh: 40 });
  // morgen: 2000 Wh (8 kW) um 02:30 Uhr ohne EOS-Preis (Börse 01:00Z stündlich
  // 12,3 ct) und 1000 Wh (4 kW) um 03:00 Uhr zu 11 ct
  at(50, { gridConsumptionWh: 2000, priceCtKwh: null });
  at(52, { gridConsumptionWh: 1000, priceCtKwh: 11 });
  return { slotMinutes: 15, rows };
}
const EPEX = [{ ts: Date.UTC(2026, 9, 27, 1, 0), day: '2026-10-27', ct_kwh: 12.3 }];

test('15-min-Plan: heute ab jetzt bis Tagesende, morgen bis 10:00, Plan-Preis vor Börsenpreis', () => {
  const { summarize } = load();
  const s = summarize({ available: true, output: plan15() }, { now: NOW, epex: EPEX, peakLimitW: 5000 });
  assert.equal(s.available, true);
  assert.equal(s.slotMinutes, 15);
  const t = s.today;
  assert.equal(t.complete, true);
  // (1000 + 500 + 3000 + 3000 + 40 + 0,003) Wh = 7,540003 kWh → 7,54
  assert.equal(t.export.kwh, 7.54); // auf Wh gerundet
  assert.equal(t.export.hours, 1);          // 4 Slots ≥ 300 W × 0,25 h
  assert.equal(t.export.peakKw, 12);        // 3000 Wh / 0,25 h
  assert.equal(t.export.minCt, 19.94);
  // (100 + 200 + 1500 + 60) Wh = 1,86 kWh; 3 Slots ≥ 300 W
  assert.equal(t.import.kwh, 1.86);
  assert.equal(t.import.hours, 0.75);
  assert.equal(t.import.peakKw, 6);
  assert.equal(t.import.peakAt, P0 + 36 * Q);
  assert.equal(t.import.maxCt, 30.5);
  assert.deepEqual({ ...t.peak }, { limitKw: 5, slots: 1, hours: 0.25, maxKw: 6 });

  const m = s.tomorrow;
  assert.equal(m.complete, false);
  assert.equal(m.until, Date.UTC(2026, 9, 27, 9, 0)); // 10:00 Uhr
  assert.equal(m.export.kwh, 0);
  assert.equal(m.export.hours, 0);
  assert.equal(m.import.kwh, 3);
  assert.equal(m.import.hours, 0.5);
  assert.equal(m.import.peakKw, 8);
  // Gegenprüfung 14e131b4 (P3): der Plan-Preis ist EOS' Endkundenpreis, der
  // Börsenpreis ein anderer Preis — kein Maximum über beide.
  assert.equal(m.import.maxCt, 11);
  assert.equal(m.import.maxSpotCt, null);
  assert.equal(m.peak.slots, 1); // nur der 8-kW-Slot liegt über 5 kW
});

test('Anzeige zum 15-min-Plan', () => {
  const { summarize, view } = load();
  const v = view(summarize({ available: true, output: plan15() }, { now: NOW, epex: EPEX, peakLimitW: 5000 }));
  assert.equal(v.note, '');
  assert.equal(v.today.head, 'Heute ab jetzt');
  assert.equal(v.today.export, 'Einspeisung 7,5 kWh in 1 h · bis 12 kW · niedrigster Einspeisewert 19,9 ct');
  assert.equal(v.today.import, 'Netzbezug 1,9 kWh in 0,75 h · Spitze 6 kW um 23:00 · höchster Bezugspreis 30,5 ct');
  assert.equal(v.today.peak, 'Spitzenkappung 5 kW: 1 Slot darüber (0,25 h, bis 6 kW)');
  assert.equal(v.tomorrow.head, 'Morgen bis 10:00');
  assert.equal(v.tomorrow.export, 'Einspeisung: keine geplant');
  assert.equal(v.tomorrow.import, 'Netzbezug 3 kWh in 0,5 h · Spitze 8 kW um 02:30 · höchster Bezugspreis 11 ct');
  assert.equal(v.tomorrow.peak, 'Spitzenkappung 5 kW: 1 Slot darüber (0,25 h, bis 8 kW)');
});

// Stundenraster: 13:00Z–17:00Z (Ende 19:00 Uhr), jetzt 13:30Z mitten im ersten Slot.
function plan60(slotMinutes) {
  const T = Date.UTC(2026, 9, 26, 13, 0);
  const rows = Array.from({ length: 5 }, (_, i) => blank(T + i * H));
  Object.assign(rows[0], { gridFeedinWh: 3000, feedInCtKwh: 20 });   // 3 kW
  Object.assign(rows[1], { gridFeedinWh: 6000, feedInCtKwh: 25 });   // 6 kW
  Object.assign(rows[2], { gridConsumptionWh: 250, priceCtKwh: 30 }); // 250 W, unter 300 W
  Object.assign(rows[3], { gridConsumptionWh: 2000, priceCtKwh: 28 }); // 2 kW
  return { slotMinutes, rows };
}

test('60-min-Slots: Wh je Stunde = W, Plan endet vor Mitternacht, morgen fehlt', () => {
  const { summarize, view } = load();
  for (const slotMinutes of [60, null]) { // ohne slotMinutes aus dem Zeitabstand
    const s = summarize({ available: true, output: plan60(slotMinutes) }, { now: Date.UTC(2026, 9, 26, 13, 30) });
    assert.equal(s.slotMinutes, 60);
    assert.equal(s.today.export.kwh, 9);
    assert.equal(s.today.export.hours, 2);
    assert.equal(s.today.export.peakKw, 6);
    assert.equal(s.today.export.minCt, 20);
    assert.equal(s.today.import.kwh, 2.25);
    assert.equal(s.today.import.hours, 1);
    assert.equal(s.today.import.peakKw, 2);
    assert.equal(s.today.import.maxCt, 28);
    assert.equal(s.today.peak, null); // keine Spitzenkappung eingerichtet
    assert.equal(s.tomorrow, null);
    const v = view(s);
    assert.equal(v.today.head, 'Heute ab jetzt bis 19:00');
    assert.equal(v.today.export, 'Einspeisung 9 kWh in 2 h · bis 6 kW · niedrigster Einspeisewert 20 ct');
    assert.equal(v.today.import, 'Netzbezug 2,3 kWh in 1 h · Spitze 2 kW um 17:00 · höchster Bezugspreis 28 ct');
    assert.equal(v.today.peak, null);
    assert.equal(v.tomorrow.head, 'Morgen: noch nicht im Plan');
    assert.equal(v.tomorrow.export, null);
  }
});

test('kein Plan: nicht verfügbar, Grund, keine Zeilen', () => {
  const { summarize, view } = load();
  assert.equal(view(summarize(null, { now: NOW })).note, 'Kein EOS-Plan');
  assert.equal(view(summarize({ available: false, reason: 'eos_off', output: null }, { now: NOW })).note, 'Kein EOS-Plan (EOS ist aus)');
  assert.equal(view(summarize({ available: false, reason: 'eos_not_answering', output: null }, { now: NOW })).note, 'Kein EOS-Plan (EOS antwortet nicht)');
  assert.equal(view(summarize({ available: true, output: null }, { now: NOW })).note, 'Kein EOS-Plan');
  const leer = view(summarize({ available: true, output: { slotMinutes: 15, rows: [] } }, { now: NOW }));
  assert.equal(leer.note, 'Kein EOS-Plan');
  assert.equal(leer.today, null);
  assert.equal(leer.tomorrow, null);
});

test('Plan liegt ganz in der Vergangenheit: heute nichts mehr', () => {
  const { summarize, view } = load();
  const old = { slotMinutes: 15, rows: [blank(P0 - 2 * Q), blank(P0 - Q)] };
  const v = view(summarize({ available: true, output: old, plan: { current: false } }, { now: NOW }));
  assert.equal(v.note, 'EOS rechnet neu');
  assert.equal(v.today.head, 'Heute: kein Plan mehr ab jetzt');
  assert.equal(v.today.export, null);
});

test('Slots ohne jeden Preis: Leistung und Menge ja, Preisangabe entfällt', () => {
  const { summarize, view } = load();
  const rows = [blank(P0), blank(P0 + Q)];
  Object.assign(rows[0], { gridFeedinWh: 500, feedInCtKwh: null });
  Object.assign(rows[1], { gridConsumptionWh: 500, priceCtKwh: null });
  const v = view(summarize({ available: true, output: { slotMinutes: 15, rows } }, { now: NOW }));
  assert.equal(v.today.export, 'Einspeisung 0,5 kWh in 0,25 h · bis 2 kW');
  assert.equal(v.today.import, 'Netzbezug 0,5 kWh in 0,25 h · Spitze 2 kW um 14:15');
});

test('Spitzenkappung eingerichtet, Plan bleibt darunter', () => {
  const { summarize, view } = load();
  const v = view(summarize({ available: true, output: plan60(60) }, { now: Date.UTC(2026, 9, 26, 13, 30), peakLimitW: 4200 }));
  assert.equal(v.today.peak, 'Spitzenkappung 4,2 kW: Plan bleibt darunter');
});

test('peakLimitOf liest status.peakShaving nur, wenn eingeschaltet mit Grenze', () => {
  const { peakLimitOf } = load();
  assert.equal(peakLimitOf(undefined), null);
  assert.equal(peakLimitOf({ peakShaving: null }), null);
  assert.equal(peakLimitOf({ peakShaving: { enabled: true, limitW: 0 } }), null);
  assert.equal(peakLimitOf({ peakShaving: { enabled: false, limitW: 4000 } }), null);
  assert.equal(peakLimitOf({ peakShaving: { enabled: true, limitW: 4000 } }), 4000);
});

test('render: erst „wird geladen“, dann Plan + Status zusammen; ohne Plan Tage ausgeblendet', () => {
  const { render } = load();
  const els = {};
  const ids = ['eosPlanSummary', 'eosPlanSummaryNote'];
  for (const p of ['eosPlanSummaryToday', 'eosPlanSummaryTomorrow']) ids.push(p, `${p}Head`, `${p}Export`, `${p}Import`, `${p}Peak`);
  for (const id of ids) els[id] = { textContent: '', hidden: false };
  const doc = { getElementById: (id) => els[id] || null };
  render({ status: { now: NOW, epex: { data: EPEX }, peakShaving: { enabled: true, limitW: 5000 } } }, doc);
  assert.equal(els.eosPlanSummaryNote.textContent, 'EOS-Plan wird geladen …');
  render({ plan: { available: true, output: plan15() } }, doc); // Status vom letzten Aufruf bleibt
  assert.equal(els.eosPlanSummaryNote.hidden, true);
  assert.equal(els.eosPlanSummaryTodayExport.textContent, 'Einspeisung 7,5 kWh in 1 h · bis 12 kW · niedrigster Einspeisewert 19,9 ct');
  assert.equal(els.eosPlanSummaryTomorrowImport.textContent, 'Netzbezug 3 kWh in 0,5 h · Spitze 8 kW um 02:30 · höchster Bezugspreis 11 ct');
  assert.equal(els.eosPlanSummaryTodayPeak.hidden, false);
  render({ plan: null }, doc);
  assert.equal(els.eosPlanSummaryNote.textContent, 'Kein EOS-Plan');
  assert.equal(els.eosPlanSummaryToday.hidden, true);
  assert.equal(els.eosPlanSummaryTomorrow.hidden, true);
});

test('Plan ohne eigene Preise: Börsenpreis nur als solcher benannt (Gegenprüfung 14e131b4, P3)', () => {
  const { summarize, view } = load();
  const T = Date.UTC(2026, 9, 27, 1, 0);
  const rows = [blank(T), blank(T + Q)];
  Object.assign(rows[0], { gridConsumptionWh: 2000, priceCtKwh: null });
  Object.assign(rows[1], { gridFeedinWh: 1000, feedInCtKwh: null });
  const s = summarize({ available: true, output: { slotMinutes: 15, rows } }, { now: T, epex: EPEX });
  assert.equal(s.today.import.maxCt, null);
  assert.equal(s.today.import.maxSpotCt, 12.3);
  assert.equal(s.today.export.minCt, null);
  assert.equal(s.today.export.minSpotCt, 12.3);
  const v = view(s);
  assert.equal(v.today.import, 'Netzbezug 2 kWh in 0,25 h · Spitze 8 kW um 02:00 · höchster Börsenpreis 12,3 ct');
  assert.equal(v.today.export, 'Einspeisung 1 kWh in 0,25 h · bis 4 kW · niedrigster Börsenpreis 12,3 ct');
});

test('nur Slots unter 300 W: Energie wird gezeigt, nicht „keine geplant“ (Gegenprüfung 14e131b4, P3)', () => {
  const { summarize, view } = load();
  const rows = Array.from({ length: 16 }, (_, i) => blank(P0 + i * Q));
  for (const r of rows) Object.assign(r, { gridFeedinWh: 50, gridConsumptionWh: 40 }); // 200 W bzw. 160 W
  const v = view(summarize({ available: true, output: { slotMinutes: 15, rows } }, { now: NOW }));
  assert.equal(v.today.export, 'Einspeisung 0,8 kWh · bis 0,2 kW');
  assert.equal(v.today.import, 'Netzbezug 0,6 kWh · Spitze 0,2 kW um 14:00');
  // Rundungsreste der EOS-Lösung bleiben „keine“
  const tiny = [blank(P0)];
  Object.assign(tiny[0], { gridFeedinWh: 0.003, gridConsumptionWh: 0.003 });
  const t = view(summarize({ available: true, output: { slotMinutes: 15, rows: tiny } }, { now: NOW }));
  assert.equal(t.today.export, 'Einspeisung: keine geplant');
  assert.equal(t.today.import, 'Netzbezug: keiner geplant');
});

test('render nimmt die eingestellte Zeitzone aus status.timeZone (Gegenprüfung 14e131b4, P3)', () => {
  const { render } = load();
  const els = {};
  const ids = ['eosPlanSummary', 'eosPlanSummaryNote'];
  for (const p of ['eosPlanSummaryToday', 'eosPlanSummaryTomorrow']) ids.push(p, `${p}Head`, `${p}Export`, `${p}Import`, `${p}Peak`);
  for (const id of ids) els[id] = { textContent: '', hidden: false };
  const doc = { getElementById: (id) => els[id] || null };
  const now = Date.UTC(2026, 9, 26, 13, 30);
  render({ plan: { available: true, output: plan60(60) }, status: { now, timeZone: 'Europe/London' } }, doc);
  assert.equal(els.eosPlanSummaryTodayHead.textContent, 'Heute ab jetzt bis 18:00'); // London = UTC am 26.10.
  render({ plan: { available: true, output: plan60(60) }, status: { now } }, doc);
  assert.equal(els.eosPlanSummaryTodayHead.textContent, 'Heute ab jetzt bis 19:00'); // ohne Angabe Berlin
});

test('Status-Payload liefert die eingestellte Zeitzone (timeZone)', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../server.js', import.meta.url)), 'utf8');
  const start = src.indexOf('function buildCurrentStatusPayload(');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  assert.match(body, /timeZone: cfg\.schedule\?\.timezone \|\| 'Europe\/Berlin'/);
});

// Christin 02.11.2026: „EOS verkauft ab X ct“ las sich wie eine Schwelle. Es ist
// der niedrigste Einspeisewert der geplanten Einspeise-Slots (womit EOS die kWh
// bewertet, z. B. Börse + Marktprämie) bzw. der höchste Bezugspreis der
// geplanten Bezugs-Slots. Grundlage aus /api/eos/plan (priceBasis.feedIn).
test('Einspeisewert nennt seine Grundlage aus dem Plan (priceBasis.feedIn)', () => {
  const { summarize, view } = load();
  const cases = [
    ['spot_premium', ' (Börse + Marktprämie)'],
    ['spot', ' (Börse)'],
    ['fixed', ' (feste Vergütung)'],
    [undefined, ''],
    ['unbekannt', ''],
  ];
  for (const [feedIn, suffix] of cases) {
    const resp = { available: true, output: plan60(60), ...(feedIn ? { priceBasis: { feedIn } } : {}) };
    const v = view(summarize(resp, { now: Date.UTC(2026, 9, 26, 13, 30) }));
    assert.equal(v.today.export, `Einspeisung 9 kWh in 2 h · bis 6 kW · niedrigster Einspeisewert 20 ct${suffix}`, String(feedIn));
    // Der Bezugspreis bleibt ohne Zusatz — er ist immer der Endkundenpreis.
    assert.equal(v.today.import, 'Netzbezug 2,3 kWh in 1 h · Spitze 2 kW um 17:00 · höchster Bezugspreis 28 ct');
  }
});

test('Erklärhilfe: Tooltip-Texte für Einspeise- und Bezugszeile und den Block', () => {
  const { summarize, view, HELP } = load();
  const v = view(summarize({ available: true, output: plan60(60), priceBasis: { feedIn: 'spot_premium' } }, { now: Date.UTC(2026, 9, 26, 13, 30) }));
  assert.match(v.today.exportTitle, /niedrigste Einspeisewert/);
  assert.match(v.today.exportTitle, /keine Schwelle/);
  assert.match(v.today.exportTitle, /Börse \+ Marktprämie/);
  assert.match(v.today.importTitle, /höchste Bezugspreis/);
  assert.match(v.today.importTitle, /keine Schwelle/);
  assert.equal(typeof HELP, 'string');
  assert.match(HELP, /keine Schwellen/);
  // ohne Einspeisung/Bezug keine Erklärung nötig
  const leer = view(summarize({ available: true, output: { slotMinutes: 15, rows: [blank(P0)] } }, { now: NOW }));
  assert.equal(leer.today.exportTitle, '');
  assert.equal(leer.today.importTitle, '');
});

test('render setzt die Erklärhilfe als title an Zeilen und Info-Zeichen', () => {
  const { render, HELP } = load();
  const els = {};
  const ids = ['eosPlanSummary', 'eosPlanSummaryNote', 'eosPlanSummaryInfo'];
  for (const p of ['eosPlanSummaryToday', 'eosPlanSummaryTomorrow']) ids.push(p, `${p}Head`, `${p}Export`, `${p}Import`, `${p}Peak`);
  for (const id of ids) els[id] = { textContent: '', hidden: false, title: '' };
  const doc = { getElementById: (id) => els[id] || null };
  render({ plan: { available: true, output: plan15(), priceBasis: { feedIn: 'fixed' } }, status: { now: NOW, epex: { data: EPEX } } }, doc);
  assert.equal(els.eosPlanSummaryInfo.title, HELP);
  assert.match(els.eosPlanSummaryTodayExport.title, /feste Vergütung/);
  assert.match(els.eosPlanSummaryTodayImport.title, /höchste Bezugspreis/);
  assert.equal(els.eosPlanSummaryTomorrowExport.title, ''); // morgen keine Einspeisung
});

// Gegenprüfung 63b36983 (P2): Bei fester Vergütung bekommt EOS für Slots mit
// negativem Börsenpreis 0 ct (fixedFeedInSlots). Der niedrigste Wert ist dann
// genau so ein Slot — „0 ct (feste Vergütung)“ wäre falsch.
test('feste Vergütung: Minimum unter dem festen Satz heißt „negativer Börsenpreis“', () => {
  const { summarize, view } = load();
  const rows = plan60(60).rows;
  rows[0].feedInCtKwh = 0; rows[1].feedInCtKwh = 7.78;
  const basis = { feedIn: 'fixed', fixedCtKwh: 7.78 };
  const v = view(summarize({ available: true, output: { slotMinutes: 60, rows }, priceBasis: basis }, { now: Date.UTC(2026, 9, 26, 13, 30) }));
  assert.equal(v.today.export, 'Einspeisung 9 kWh in 2 h · bis 6 kW · niedrigster Einspeisewert 0 ct (negativer Börsenpreis)');
  assert.match(v.today.exportTitle, /negativer Börsenpreis/);
  rows[0].feedInCtKwh = 7.78;
  const w = view(summarize({ available: true, output: { slotMinutes: 60, rows }, priceBasis: basis }, { now: Date.UTC(2026, 9, 26, 13, 30) }));
  assert.equal(w.today.export, 'Einspeisung 9 kWh in 2 h · bis 6 kW · niedrigster Einspeisewert 7,8 ct (feste Vergütung)');
});

test('Börse + Marktprämie: negativer Slot ohne Prämie wird so benannt', () => {
  const { summarize, view } = load();
  const rows = plan60(60).rows;
  rows[0].feedInCtKwh = -1.2;
  const v = view(summarize({ available: true, output: { slotMinutes: 60, rows }, priceBasis: { feedIn: 'spot_premium' } }, { now: Date.UTC(2026, 9, 26, 13, 30) }));
  assert.equal(v.today.export, 'Einspeisung 9 kWh in 2 h · bis 6 kW · niedrigster Einspeisewert -1,2 ct (Börse, negativ: ohne Marktprämie)');
});

// Gegenprüfung 63b36983 (P2): die Grundlage kommt aus dem letzten Push an EOS
// (womit der Plan gerechnet ist), nicht aus der aktuellen Einstellung.
test('/api/eos/plan: Grundlage passend zum gezeigten Plan (eosPlanFeedInBasis)', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../routes-api.js', import.meta.url)), 'utf8');
  const start = src.indexOf("url.pathname === '/api/eos/plan'");
  const body = src.slice(start, src.indexOf('\n    }\n', start));
  assert.match(body, /priceBasis: eosPlanFeedInBasis\(state\.optimizer, getCfg\(\), Date\.parse\(plan\.data\?\.generatedAt\)\)/);
});

// Gegenprüfung d22f5a4d (P2): „negativer Börsenpreis“ nur bei ≈ 0 ct — ein
// anderer Wert als der feste Satz (z. B. Plan noch mit altem Satz) bekommt
// keinen Zusatz statt eines falschen.
test('feste Vergütung: abweichender Wert ungleich 0 ohne Zusatz', () => {
  const { summarize, view } = load();
  const rows = plan60(60).rows;
  rows[0].feedInCtKwh = 7.78; rows[1].feedInCtKwh = 7.78;
  const v = view(summarize({ available: true, output: { slotMinutes: 60, rows }, priceBasis: { feedIn: 'fixed', fixedCtKwh: 8.2 } }, { now: Date.UTC(2026, 9, 26, 13, 30) }));
  assert.equal(v.today.export, 'Einspeisung 9 kWh in 2 h · bis 6 kW · niedrigster Einspeisewert 7,8 ct');
});

// Gegenprüfung 63b36983 (P3): title erreicht Touch und Tastatur nicht — das
// Info-Zeichen klappt einen sichtbaren Erklärtext auf.
test('Info-Zeichen klappt die Erklärung sichtbar auf und zu', () => {
  const { render, HELP } = load();
  const els = {};
  const ids = ['eosPlanSummary', 'eosPlanSummaryNote', 'eosPlanSummaryHelp'];
  for (const p of ['eosPlanSummaryToday', 'eosPlanSummaryTomorrow']) ids.push(p, `${p}Head`, `${p}Export`, `${p}Import`, `${p}Peak`);
  for (const id of ids) els[id] = { textContent: '', hidden: id === 'eosPlanSummaryHelp', title: '' };
  const handlers = {};
  const attrs = {};
  els.eosPlanSummaryInfo = {
    title: '', dataset: {},
    addEventListener: (type, fn) => { handlers[type] = (handlers[type] || 0) + 1; els.eosPlanSummaryInfo['on' + type] = fn; },
    setAttribute: (k, v) => { attrs[k] = v; },
  };
  const doc = { getElementById: (id) => els[id] || null };
  render({ plan: { available: true, output: plan15() }, status: { now: NOW } }, doc);
  render({ plan: { available: true, output: plan15() } }, doc); // nur einmal binden
  assert.equal(handlers.click, 1);
  assert.equal(els.eosPlanSummaryHelp.textContent, HELP);
  assert.equal(els.eosPlanSummaryHelp.hidden, true);
  els.eosPlanSummaryInfo.onclick();
  assert.equal(els.eosPlanSummaryHelp.hidden, false);
  assert.equal(attrs['aria-expanded'], 'true');
  els.eosPlanSummaryInfo.onclick();
  assert.equal(els.eosPlanSummaryHelp.hidden, true);
  assert.equal(attrs['aria-expanded'], 'false');
});

test('index.html: Info-Zeichen ist ein Knopf mit aufklappbarem Erklärtext', () => {
  const html = fs.readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');
  assert.match(html, /<button type="button" class="eos-plan-summary-info" id="eosPlanSummaryInfo" aria-expanded="false" aria-controls="eosPlanSummaryHelp"/);
  assert.match(html, /<p class="eos-plan-summary-help" id="eosPlanSummaryHelp" hidden><\/p>/);
});

// Gegenprüfung 00f23b55 (P3): CONTRIBUTING.md verlangt bei jeder Änderung einen
// neuen ?v=-Schlüssel — für die in diesem Branch geänderten Dateien.
test('Cache-Schlüssel der geänderten Leitstand-Dateien angehoben', () => {
  const html = fs.readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');
  assert.match(html, /\/eos-plan-summary\.js\?v=20261102-beschriftungen"/);
  assert.match(html, /\/leitstand-charts\.js\?v=20261102-energiebilanz"/);
  assert.match(html, /\/index\.css\?v=20261102-eosplan-info"/);
});
