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
