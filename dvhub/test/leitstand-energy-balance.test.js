// test/leitstand-energy-balance.test.js — Kachel „Überschuss / Defizit“ im
// Leitstand (Christin 02.11.2026).
//
// (a) Akkugröße und Untergrenze kamen aus statusData.config.optimizer — das
//     /api/status gar nicht liefert. Es griffen die Ersatzwerte 43 kWh / 5 %:
//     auf Prod (77 kWh) zeigte 43 % dann 18,5 statt 33,1 kWh. Jetzt liefert
//     /api/status den Akku so, wie EOS ihn sieht (status.energyBalance.battery:
//     Kapazität, Ladestand, Untergrenze — mit zweiter GX-Anlage beide).
// (b) Hauptzahl = Rest heute (PV-Rest − Verbrauchs-Rest), darunter klein der
//     ganze Tag; „Verfügbar“ = Rest heute + nutzbarer Akku.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const src = fs.readFileSync(path.resolve(import.meta.dirname, '../public/leitstand-charts.js'), 'utf8');

function loadHelpers() {
  const sandbox = {
    console, Date, Math, Number, JSON, Intl, Set, Map,
    document: { readyState: 'loading', addEventListener() {}, getElementById: () => null },
    window: {},
    setInterval() {},
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(src, sandbox, { filename: 'leitstand-charts.js' });
  return sandbox.window.DVhubLeitstand;
}

const PROD = { capacityWh: 77000, socPct: 43, minSocPct: 5 };

test('Akku aus status.energyBalance: 43 % von 77 kWh = 33,1 kWh, nutzbar über 5 %', () => {
  const { energyBalanceSummary } = loadHelpers();
  const s = energyBalanceSummary({ pvRestKwh: 3, loadRestKwh: 12.5, pvDayKwh: 10, loadDayKwh: 20.5, battery: PROD });
  assert.equal(s.restKwh, -9.5);
  assert.equal(s.dayKwh, -10.5);
  assert.equal(Math.round(s.battKwh * 100) / 100, 33.11);
  assert.equal(Math.round(s.usableKwh * 100) / 100, 29.26);
  // Verfügbar = Rest heute + nutzbarer Akku (nicht der ganze Tag)
  assert.equal(Math.round(s.availableKwh * 100) / 100, 19.76);
});

test('ohne Akkugröße keine erfundenen kWh (kein Ersatzwert 43 kWh)', () => {
  const { energyBalanceSummary, energyBalanceView } = loadHelpers();
  const s = energyBalanceSummary({ pvRestKwh: 5, loadRestKwh: 2, pvDayKwh: 9, loadDayKwh: 8, battery: { capacityWh: null, socPct: 43, minSocPct: 5 } });
  assert.equal(s.battKwh, null);
  assert.equal(s.usableKwh, null);
  assert.equal(s.availableKwh, null);
  const v = energyBalanceView(s);
  assert.equal(v.battery, '🔋 43 % · Akkugröße nicht eingestellt');
  assert.equal(v.available, null);
});

test('Untergrenze über dem Ladestand: nutzbar 0, nicht negativ', () => {
  const { energyBalanceSummary } = loadHelpers();
  const s = energyBalanceSummary({ pvRestKwh: 0, loadRestKwh: 1, pvDayKwh: 0, loadDayKwh: 1, battery: { capacityWh: 10000, socPct: 4, minSocPct: 10 } });
  assert.equal(s.usableKwh, 0);
  assert.equal(s.availableKwh, -1);
});

test('Anzeige: Hauptzahl Rest heute, klein der ganze Tag, Akku und Verfügbar', () => {
  const { energyBalanceSummary, energyBalanceView } = loadHelpers();
  const v = energyBalanceView(energyBalanceSummary({ pvRestKwh: 3, loadRestKwh: 12.5, pvDayKwh: 10, loadDayKwh: 20.5, battery: PROD }));
  assert.equal(v.main, '-9.5 kWh');
  assert.equal(v.positive, false);
  assert.equal(v.day, 'ganzer Tag: -10.5 kWh');
  assert.equal(v.battery, '🔋 43 % = 33.1 kWh (29.3 nutzbar)');
  assert.equal(v.available, 'Verfügbar: +19.8 kWh');
  assert.match(v.title, /Rest heute/);
  assert.match(v.title, /Verfügbar/);
  const plus = energyBalanceView(energyBalanceSummary({ pvRestKwh: 8, loadRestKwh: 3, pvDayKwh: 20, loadDayKwh: 9, battery: null }));
  assert.equal(plus.main, '+5.0 kWh');
  assert.equal(plus.positive, true);
  assert.equal(plus.day, 'ganzer Tag: +11.0 kWh');
  assert.equal(plus.battery, null);
  assert.equal(plus.available, null);
});

test('Kachel liest den Akku aus status.energyBalance, nicht aus status.config', () => {
  const start = src.indexOf('function updateForecastSummary(');
  const body = src.slice(start, src.indexOf('\n  }\n', start));
  assert.doesNotMatch(body, /statusData\?\.config\?\.optimizer/);
  assert.doesNotMatch(body, /43000/);
  assert.match(body, /statusData\?\.energyBalance\?\.battery/);
});

test('/api/status liefert energyBalance.battery aus energyBalanceBattery(ctx)', () => {
  const server = fs.readFileSync(path.resolve(import.meta.dirname, '../server.js'), 'utf8');
  const start = server.indexOf('function buildCurrentStatusPayload(');
  const body = server.slice(start, server.indexOf('\n}\n', start));
  assert.match(body, /energyBalance: \{ battery: energyBalanceBattery\(ctx\) \}/);
});

test('energyBalanceBattery: Kapazität, Ladestand und Untergrenze wie EOS', async () => {
  const { energyBalanceBattery } = await import('../services/energy-balance-battery.js');
  const cfg = { optimizer: { batteryCapacityWh: 77000, hardFloorSocPct: 5 } };
  // Untergrenze: der höhere aus Live-BMS-Wert und eingestellter (resolveEosMinSocPct)
  assert.deepEqual(
    { ...energyBalanceBattery({ getCfg: () => cfg, state: { victron: { soc: 43, minSocPct: 10 } } }) },
    { capacityWh: 77000, socPct: 43, minSocPct: 10 },
  );
  assert.deepEqual(
    { ...energyBalanceBattery({ getCfg: () => cfg, state: { victron: { soc: 43, minSocPct: null } } }) },
    { capacityWh: 77000, socPct: 43, minSocPct: 5 },
  );
  // nichts eingestellt, kein Ladestand: null statt Ersatzwerte
  assert.deepEqual(
    { ...energyBalanceBattery({ getCfg: () => ({}), state: { victron: {} } }) },
    { capacityWh: null, socPct: null, minSocPct: 5 },
  );
  // kaputter Kontext wirft nicht
  assert.equal(energyBalanceBattery(null), null);
});

// /api/forecast reicht state.forecast.*.data durch — die Reihen beginnen beim
// letzten Abruf, nicht bei „jetzt“. „Rest heute“ zählt deshalb nur, was ab jetzt
// kommt: vergangene Slots gar nicht, den laufenden anteilig.
test('restKwhFrom: nur ab jetzt, laufender Slot anteilig', () => {
  const { restKwhFrom } = loadHelpers();
  const T = Date.UTC(2026, 10, 2, 10, 0);
  const slots = [0, 1, 2, 3].map((i) => ({ start: new Date(T + i * 3600000).toISOString(), powerW: 1000 }));
  // jetzt 11:15 → Slot 10:00 vorbei, 11:00 zu 3/4, 12:00 und 13:00 voll = 2,75 kWh
  assert.equal(restKwhFrom(slots, 1, T + 75 * 60000), 2.75);
  // 15-min-Slots
  const q = [0, 1, 2].map((i) => ({ start: new Date(T + i * 900000).toISOString(), powerW: 4000 }));
  assert.equal(restKwhFrom(q, 0.25, T + 1800000), 1); // nur der dritte Slot
  assert.equal(restKwhFrom([{ start: 'kaputt', powerW: 5 }], 1, T), 0);
});

test('Kachel zählt PV- und Verbrauchs-Rest mit restKwhFrom', () => {
  const start = src.indexOf('function updateForecastSummary(');
  const body = src.slice(start, src.indexOf('\n  }\n', start));
  assert.match(body, /pvKwhRest = restKwhFrom\(pvSlots, pvH, nowMs\)/);
  assert.match(body, /loadKwhRest = restKwhFrom\(loadSlots, loadH, nowMs\)/);
});

test('Überschrift der Kachel nennt „Rest heute“ (Hauptzahl)', () => {
  const html = fs.readFileSync(path.resolve(import.meta.dirname, '../public/index.html'), 'utf8');
  const i = html.indexOf('id="surplus-daily-card"');
  assert.match(html.slice(i, i + 300), /<span class="kicker-mini">&Uuml;berschuss \/ Defizit &middot; Rest heute<\/span>/);
});

// --- Gegenprüfung 527906fc ----------------------------------------------------
// P1: Liefert nur ein Prognosedienst, liegen seine Rohzeilen im State (Solcast
// 30 min, VRM stündlich), /api/forecast meldet trotzdem resolution '15min'.
// Die Slot-Dauer kommt deshalb aus den Zeitabständen der Daten.
test('restKwhFrom: Slot-Dauer aus den Daten, nicht aus der gemeldeten Auflösung', () => {
  const { restKwhFrom } = loadHelpers();
  const T = Date.UTC(2026, 10, 2, 10, 0);
  const half = [0, 1, 2, 3].map((i) => ({ start: new Date(T + i * 1800000).toISOString(), powerW: 1000 }));
  assert.equal(restKwhFrom(half, 0.25, T), 2); // 4 × 30 min × 1 kW, nicht 1
  const hourly = [0, 1, 2].map((i) => ({ start: new Date(T + i * 3600000).toISOString(), powerW: 2000 }));
  assert.equal(restKwhFrom(hourly, 0.25, T + 30 * 60000), 5); // 1 h anteilig + 2 h
  // ein einzelner Slot: gemeldete Auflösung
  assert.equal(restKwhFrom([{ start: new Date(T).toISOString(), powerW: 4000 }], 0.25, T), 1);
});

// P2: readDailyTotals liefert ohne VRM-Zeilen 0 statt null — dann gibt es
// keinen „ganzen Tag“, die Zeile entfällt.
test('ganzer Tag nur mit beiden Tagessummen', () => {
  const { energyBalanceSummary, energyBalanceView } = loadHelpers();
  const s = energyBalanceSummary({ pvRestKwh: 5, loadRestKwh: 2, pvDayKwh: null, loadDayKwh: 8, battery: null });
  assert.equal(s.dayKwh, null);
  assert.equal(energyBalanceView(s).day, null);
});

test('Kachel nimmt VRM-Tagessummen nur mit Slots (pvSlots/loadSlots > 0)', () => {
  const start = src.indexOf('function updateForecastSummary(');
  const body = src.slice(start, src.indexOf('\n  }\n', start));
  assert.match(body, /totals\?\.today\?\.pvSlots > 0/);
  assert.match(body, /totals\?\.today\?\.loadSlots > 0/);
});

// P3: Fehlt die Lastprognose, ist der Rest unbekannt — kein grüner Überschuss.
test('ohne Lastprognose: Rest unbekannt, „--“ neutral, kein Verfügbar', () => {
  const { energyBalanceSummary, energyBalanceView } = loadHelpers();
  const s = energyBalanceSummary({ pvRestKwh: 3, loadRestKwh: null, pvDayKwh: 10, loadDayKwh: null, battery: { capacityWh: 77000, socPct: 43, minSocPct: 5 } });
  assert.equal(s.restKwh, null);
  assert.equal(s.availableKwh, null);
  const v = energyBalanceView(s);
  assert.equal(v.main, '--');
  assert.equal(v.positive, null);
  assert.equal(v.available, null);
  assert.equal(v.battery, '🔋 43 % = 33.1 kWh (29.3 nutzbar)');
});

// P3: Mit zweiter GX-Anlage, aber ohne eingestellte Hauptkapazität erfand
// planningCfg 8 kWh für die Hauptanlage. Ohne Hauptkapazität: null.
test('energyBalanceBattery mit zweiter Anlage: beide Kapazitäten, ohne Hauptkapazität null', async () => {
  const { energyBalanceBattery } = await import('../services/energy-balance-battery.js');
  const multiGx = { enabled: true, batteryCapacityWh: 20000, minSocPct: 10 };
  const state = { victron: { soc: 40, minSocPct: 5 }, multiGx: { online: true, socPct: 80, minSocPct: 10 } };
  const withMain = { updateChannel: 'dev', multiGx, optimizer: { batteryCapacityWh: 60000, hardFloorSocPct: 5 } };
  const b = energyBalanceBattery({ getCfg: () => withMain, state });
  assert.equal(b.capacityWh, 80000);
  assert.equal(b.socPct, 50); // (40·60 + 80·20) / 80
  const noMain = { updateChannel: 'dev', multiGx, optimizer: { hardFloorSocPct: 5 } };
  assert.equal(energyBalanceBattery({ getCfg: () => noMain, state }).capacityWh, null);
});

// --- Gegenprüfung e07271be ----------------------------------------------------
// P2: forecast.solar liefert neben dem Stundenraster Punkte zu Sonnenauf- und
// -untergang (07:22:57, 19:00:15, eos-forecast-bridge.js). Der kleinste Abstand
// wäre dann 37 min → jede Stunde zählte 0,62 h. Jede Zeile gilt bis zur
// nächsten, höchstens den üblichen (mittleren) Abstand.
test('restKwhFrom: Zwischenpunkte verzerren die Slot-Dauer nicht', () => {
  const { restKwhFrom } = loadHelpers();
  const T = Date.UTC(2026, 10, 2, 7, 0); // 08:00 Uhr
  const rows = [{ start: new Date(T - (37 * 60 + 3) * 1000).toISOString(), powerW: 0 }]; // 07:22:57
  for (let i = 0; i < 4; i += 1) rows.push({ start: new Date(T + i * 3600000).toISOString(), powerW: 1000 });
  assert.equal(restKwhFrom(rows, 0.25, T - 3600000), 4); // 4 volle Stunden à 1 kW
  // Lücke über Nacht zählt nicht als lange Leistung: letzter Punkt höchstens 1 h
  const night = [{ start: new Date(T).toISOString(), powerW: 500 }, { start: new Date(T + 3600000).toISOString(), powerW: 500 },
    { start: new Date(T + 14 * 3600000).toISOString(), powerW: 0 }];
  assert.equal(restKwhFrom(night, 0.25, T), 1);
});

// P3: „Reihe fehlt“ heißt: keine Zeile für heute oder später — eine veraltete
// Reihe (nur gestern) ist unbekannt, Zeilen heute (auch vergangene) sind bekannt.
test('seriesCoversToday', () => {
  const { seriesCoversToday } = loadHelpers();
  const today = '2026-11-02';
  assert.equal(seriesCoversToday([{ start: '2026-11-01T20:00:00Z' }], today), false);
  assert.equal(seriesCoversToday([{ start: '2026-11-02T06:00:00Z' }], today), true);
  assert.equal(seriesCoversToday([{ start: '2026-11-03T07:00:00Z' }], today), true);
  assert.equal(seriesCoversToday([], today), false);
  const start = src.indexOf('function updateForecastSummary(');
  const body = src.slice(start, src.indexOf('\n  }\n', start));
  assert.match(body, /pvRestKwh: seriesCoversToday\(pvSlotsAll, berlinTodayKey\) \? pvKwhRest : null/);
  // Last: strenger, seriesCoversUntil bis Mitternacht (eigener Test)
});

// P3: Scheitert der Prognose-Abruf, darf kein farbiges „--“ über alten Zeilen stehen.
test('ohne Prognose: Farbe und Detailzeilen der Bilanz zurückgesetzt', () => {
  const start = src.indexOf('function updateForecastSummary(');
  const body = src.slice(start, src.indexOf('\n  }\n', start));
  const early = body.slice(body.indexOf('if (!forecastData) {'), body.indexOf('return;', body.indexOf('if (!forecastData) {')));
  assert.match(early, /surplusEl\.style\.color = ''/);
  assert.match(early, /surplusDetailEl\.textContent = ''/);
});

// P3: Ohne Hauptkapazität auch Ladestand und Untergrenze der Hauptanlage
// ungewichtet — sonst gewichtete planningSocPct mit erfundenen 8 kWh.
test('energyBalanceBattery ohne Hauptkapazität: Ladestand ungewichtet', async () => {
  const { energyBalanceBattery } = await import('../services/energy-balance-battery.js');
  const multiGx = { enabled: true, batteryCapacityWh: 20000, minSocPct: 10 };
  const state = { victron: { soc: 40, minSocPct: 5 }, multiGx: { online: true, socPct: 80, minSocPct: 10 } };
  const b = energyBalanceBattery({ getCfg: () => ({ updateChannel: 'dev', multiGx, optimizer: { hardFloorSocPct: 5 } }), state });
  assert.deepEqual({ ...b }, { capacityWh: null, socPct: 40, minSocPct: 5 });
});

// --- Gegenprüfung ffa322f1 ----------------------------------------------------
// P2: Eine Lastreihe, die heute vor „jetzt“ endet, ist veraltet (Telemetrie
// steht, SQL-Fehler) — Last braucht eine Zeile, die nach jetzt endet. PV darf
// zum Sonnenuntergang enden.
test('Last, die heute vor jetzt endet, ist unbekannt (seriesCoversUntil)', () => {
  const { seriesCoversUntil } = loadHelpers();
  const T = Date.UTC(2026, 11, 2, 13, 0); // 14:00
  const load = [0, 1, 2].map((i) => ({ start: new Date(T - 3 * 3600000 + i * 3600000).toISOString(), powerW: 800 })); // bis 14:00
  assert.equal(seriesCoversUntil(load, 1, T + 3600000, T + 9 * 3600000), false); // 15:00
});

// P3: forecast.solar-Stundenwerte sind Wh je Stunde (forecast-solar.js); ein
// Rasterpunkt vor einem Zwischenpunkt (Sonnenuntergang) behält seine Stunde.
test('Rasterzeile vor einem Zwischenpunkt behält die volle Dauer', () => {
  const { restKwhFrom } = loadHelpers();
  const T = Date.UTC(2026, 10, 2, 14, 0); // 15:00
  const rows = [
    { start: new Date(T).toISOString(), powerW: 1000 },
    { start: new Date(T + 3600000).toISOString(), powerW: 500 },
    { start: new Date(T + 3600000 + (47 * 60 + 12) * 1000).toISOString(), powerW: 0 }, // 16:47:12
  ];
  assert.equal(restKwhFrom(rows, 0.25, T), 1.5);
  const sunset = [
    { start: new Date(T).toISOString(), powerW: 400 },
    { start: new Date(T + 3600000).toISOString(), powerW: 400 },
    { start: new Date(T + 3600000 + 15000).toISOString(), powerW: 0 }, // 16:00:15
  ];
  assert.equal(restKwhFrom(sunset, 0.25, T), 0.8);
});

// P3: Beim gescheiterten Abruf auch die Detailzeile des Verbrauchs leeren.
test('ohne Prognose: Detailzeile Verbrauch geleert', () => {
  const start = src.indexOf('function updateForecastSummary(');
  const body = src.slice(start, src.indexOf('\n  }\n', start));
  const early = body.slice(body.indexOf('if (!forecastData) {'), body.indexOf('return;', body.indexOf('if (!forecastData) {')));
  assert.match(early, /loadDetailEl\.textContent = ''/);
});

// Gegenprüfung 27a172cb (P2): Die Lastreihe muss den Rest des Tages lückenlos
// bis Mitternacht abdecken — sonst zählten die fehlenden Stunden als 0 kWh.
test('seriesCoversUntil: lückenlos bis zum Ende', () => {
  const { seriesCoversUntil } = loadHelpers();
  const T = Date.UTC(2026, 10, 2, 13, 30); // 14:30 Uhr
  const H = 3600000;
  const mk = (from, n) => Array.from({ length: n }, (_, i) => ({ start: new Date(from + i * H).toISOString(), powerW: 800 }));
  const midnight = Date.UTC(2026, 10, 2, 23, 0);
  assert.equal(seriesCoversUntil(mk(Date.UTC(2026, 10, 2, 13, 0), 5), 1, T, midnight), false, 'endet 18:00');
  assert.equal(seriesCoversUntil(mk(Date.UTC(2026, 10, 2, 13, 0), 12), 1, T, midnight), true);
  const gap = [...mk(Date.UTC(2026, 10, 2, 13, 0), 3), ...mk(Date.UTC(2026, 10, 2, 18, 0), 8)];
  assert.equal(seriesCoversUntil(gap, 1, T, midnight), false, 'Lücke 16–18 Uhr');
  assert.equal(seriesCoversUntil(mk(Date.UTC(2026, 10, 3, 0, 0), 5), 1, T, midnight), false, 'nur morgen');
});

test('berlinMidnightAfter: Mitternacht in Berliner Zeit (Winter/Sommer)', () => {
  const { berlinMidnightAfter } = loadHelpers();
  assert.equal(berlinMidnightAfter(Date.UTC(2026, 10, 2, 13, 30)), Date.UTC(2026, 10, 2, 23, 0));
  assert.equal(berlinMidnightAfter(Date.UTC(2026, 6, 2, 13, 30)), Date.UTC(2026, 6, 2, 22, 0));
  assert.equal(berlinMidnightAfter(Date.UTC(2026, 10, 2, 23, 30)), Date.UTC(2026, 10, 3, 23, 0), 'nach Mitternacht Ortszeit: nächste');
});

test('Kachel: Last nur bekannt, wenn sie bis Mitternacht reicht', () => {
  const start = src.indexOf('function updateForecastSummary(');
  const body = src.slice(start, src.indexOf('\n  }\n', start));
  assert.match(body, /loadRestKwh: seriesCoversUntil\(loadSlotsAll, loadH, nowMs, berlinMidnightAfter\(nowMs\)\) \? loadKwhRest : null/);
});

// Gegenprüfung 290a70dc (P2): StatsForecast und VRM liefern die Lastreihe ab
// der nächsten vollen Stunde. Am Anfang ist ein Abstand bis zu einer
// Zeilenlänge erlaubt (Lücken zwischen Zeilen bleiben streng); die angebrochene
// Stunde zählt mit dem Wert der ersten Zeile.
test('Lastreihe ab der nächsten vollen Stunde: bekannt, angebrochene Stunde zählt mit', () => {
  const { seriesCoversUntil, restKwhFrom } = loadHelpers();
  const H = 3600000;
  const now = Date.UTC(2026, 10, 2, 14, 25);
  const rows = Array.from({ length: 8 }, (_, i) => ({ start: new Date(Date.UTC(2026, 10, 2, 15, 0) + i * H).toISOString(), powerW: 600 }));
  const midnight = Date.UTC(2026, 10, 2, 23, 0);
  assert.equal(seriesCoversUntil(rows, 1, now, midnight), true);
  // 35 min × 0,6 kW + 8 h × 0,6 kW = 0,35 + 4,8
  assert.equal(restKwhFrom(rows, 1, now), 5.15);
  // erste Zeile erst in mehr als einer Zeilenlänge → Lücke
  assert.equal(seriesCoversUntil(rows.slice(1), 1, now, midnight), false);
  assert.equal(restKwhFrom(rows.slice(1), 1, now), 4.2);
});
