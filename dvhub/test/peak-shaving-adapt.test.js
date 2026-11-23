// test/peak-shaving-adapt.test.js — Peak Shaving P3 (Christin 24.11.2026): Schalter „Grenze an erreichte
// Jahresspitze anpassen“ (bei Monatsleistungspreis: Monatsspitze), ab Werk AUS.
//
// Liegt die schon erreichte Spitze des Abrechnungszeitraums über der eingestellten Grenze, richtet sich der
// Leistungspreis ohnehin nach ihr — jede weitere Kappung darunter spart in diesem Zeitraum nichts, kostet aber
// Akku-Einsatz. Mit Schalter regelt DVhub dann auf die erreichte Spitze (auf 100 W abgerundet) − Abstand; mit dem
// neuen Zeitraum gilt wieder die Einstellung. Ohne Schalter bleibt alles wie eingestellt, die Kachel weist darauf hin.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createDefaultConfig, getConfigDefinition } from '../config-model.js';
import { createPeakShaving, resolvePeakShaving, peakPeriods } from '../services/peak-shaving/index.js';

const NOW = Date.parse('2026-11-24T09:05:00Z');
const base = (ps = {}, extra = {}) => ({
  updateChannel: 'dev', manufacturer: 'victron',
  peakShaving: { enabled: true, gridImportLimitW: 10000, marginW: 300, billing15min: false, ...ps }, ...extra
});

function svc(cfg, { year = 12345, month = 11000 } = {}) {
  const store = {
    getGridImportPeak: async (r) => {
      const p = peakPeriods(NOW, 'Europe/Berlin');
      if (r.start === p.year.start) return year == null ? null : { slotStart: '2026-03-10T08:00:00.000Z', powerW: year, energyKwh: year / 4000 };
      if (r.start === p.month.start) return month == null ? null : { slotStart: '2026-11-03T10:15:00.000Z', powerW: month, energyKwh: month / 4000 };
      return null;
    }
  };
  return createPeakShaving({ state: { victron: {}, meter: {}, ctrl: {} }, getCfg: () => cfg, telemetryStore: store, pushLog: () => {} }, { now: () => NOW });
}

test('Vorgabe: Schalter ab Werk aus, Einstellungsfeld vorhanden mit Hinweis auf Ersparnis/Kosten', () => {
  assert.equal(createDefaultConfig().peakShaving.adaptToReachedPeak, false);
  assert.equal(resolvePeakShaving(base()).adaptToReachedPeak, false);
  const f = getConfigDefinition().fields.find((x) => x.path === 'peakShaving.adaptToReachedPeak');
  assert.equal(f?.type, 'boolean');
  assert.match(f.help, /Jahresspitze/);
  assert.match(f.help, /spart/);
  assert.match(f.help, /kostet/);
});

test('Schalter aus: Jahresspitze 12,3 kW über der Grenze 10 kW ändert nichts (Ziel 9 700 W)', async () => {
  const s = svc(base());
  await s.refreshPeaks();
  const c = s.control();
  assert.equal(c.limitW, 10000);
  assert.equal(c.targetW, 9700);
  assert.equal(c.adaptedFrom, null);
});

test('Schalter an: Grenze = erreichte Jahresspitze, auf 100 W abgerundet (12 300 W) − Abstand → 12 000 W', async () => {
  const s = svc(base({ adaptToReachedPeak: true }));
  await s.refreshPeaks();
  const c = s.control();
  assert.equal(c.limitW, 12300);
  assert.equal(c.targetW, 12000);
  assert.equal(c.configuredLimitW, 10000);
  assert.equal(c.adaptedFrom, 'year');
  assert.equal(s.eosTargetW(), 12000, 'EOS bekommt die angepasste Grenze');
});

test('Schalter an, Spitze unter der Grenze: Einstellung gilt', async () => {
  const s = svc(base({ adaptToReachedPeak: true }), { year: 8000, month: 7000 });
  await s.refreshPeaks();
  assert.equal(s.control().limitW, 10000);
  assert.equal(s.control().adaptedFrom, null);
});

test('Monatsleistungspreis: maßgeblich ist die Monatsspitze', async () => {
  const s = svc(base({ adaptToReachedPeak: true, tariff: { model: 'month' } }), { year: 15000, month: 11000 });
  await s.refreshPeaks();
  const c = s.control();
  assert.equal(c.limitW, 11000);
  assert.equal(c.adaptedFrom, 'month');
});

test('Spitze aus einem früheren Zeitraum (noch nicht neu gelesen) zählt nicht', async () => {
  const s = svc(base({ adaptToReachedPeak: true }));
  await s.refreshPeaks(Date.parse('2025-12-31T12:00:00Z'));   // gelesen im alten Jahr
  const c = s.control();
  assert.equal(c.limitW, 10000, 'neues Jahr: wieder die Einstellung');
});

test('ohne Datenbank (keine Spitzen): keine Anpassung', async () => {
  const cfg = base({ adaptToReachedPeak: true });
  const s = createPeakShaving({ state: { victron: {}, meter: {}, ctrl: {} }, getCfg: () => cfg, pushLog: () => {} }, { now: () => NOW });
  await s.refreshPeaks();
  assert.equal(s.control().limitW, 10000);
});

test('Hinweis im Status: Spitze über der Grenze und Schalter aus → adapt.suggest', async () => {
  const off = svc(base());
  await off.refreshPeaks();
  const a = off.summary().adapt;
  assert.equal(a.on, false);
  assert.equal(a.suggest, true);
  assert.equal(a.scope, 'year');
  assert.equal(a.reachedPeakW, 12345);
  const on = svc(base({ adaptToReachedPeak: true }));
  await on.refreshPeaks();
  const b = on.summary();
  assert.equal(b.adapt.on, true);
  assert.equal(b.adapt.active, true);
  assert.equal(b.adapt.effectiveLimitW, 12300);
  assert.equal(b.limitW, 10000, 'eingestellte Grenze bleibt sichtbar');
});

test('angepasste Grenze ändert sich → EOS wird neu abgeglichen (einmal, höchstens jede Minute)', async () => {
  const cfg = base({ adaptToReachedPeak: false });
  let syncs = 0;
  const store = { getGridImportPeak: async () => ({ slotStart: '2026-03-10T08:00:00.000Z', powerW: 12345 }) };
  let mono = 0;
  const s = createPeakShaving({
    state: { victron: {}, meter: {}, ctrl: {} }, getCfg: () => cfg, telemetryStore: store, pushLog: () => {},
    eosConfigSync: { sync: async () => { syncs += 1; } }
  }, { now: () => NOW, monoNow: () => mono });
  await s.refreshPeaks();
  s.pollTick();
  assert.equal(syncs, 0, 'Startwert löst nichts aus');
  cfg.peakShaving.adaptToReachedPeak = true;
  await s.refreshPeaks();
  mono += 1000;
  s.pollTick();
  assert.equal(syncs, 1);
  mono += 1000;
  s.pollTick();
  assert.equal(syncs, 1, 'unverändert → kein weiterer Abgleich');
});

test('Codex ac14daee P1: angepasst wird nur an abgeschlossene Viertelstunden (laufende wächst noch)', async () => {
  const cfg = base({ adaptToReachedPeak: true });
  const calls = [];
  const store = {
    getGridImportPeak: async (r) => {
      calls.push(r);
      // offene Viertelstunde 09:00 UTC hat schon 5 kWh = 20 kW; abgeschlossen höchstens 11 kW
      return Date.parse(r.end) > NOW ? { slotStart: '2026-11-24T09:00:00.000Z', powerW: 20000 } : { slotStart: '2026-11-03T10:15:00.000Z', powerW: 11000 };
    }
  };
  const s = createPeakShaving({ state: { victron: {}, meter: {}, ctrl: {} }, getCfg: () => cfg, telemetryStore: store, pushLog: () => {} }, { now: () => NOW });
  await s.refreshPeaks();
  assert.ok(calls.some((r) => r.end === '2026-11-24T09:00:00.000Z'), 'Abfrage bis zum Anfang der laufenden Viertelstunde');
  assert.equal(s.control().limitW, 11000);
});

test('Codex ac14daee P2: gescheiterter EOS-Abgleich wird nach der Minute wiederholt', async () => {
  const cfg = base({ adaptToReachedPeak: false });
  let syncs = 0;
  let ok = false;
  const store = { getGridImportPeak: async () => ({ slotStart: '2026-03-10T08:00:00.000Z', powerW: 12345 }) };
  let mono = 0;
  const s = createPeakShaving({
    state: { victron: {}, meter: {}, ctrl: {} }, getCfg: () => cfg, telemetryStore: store, pushLog: () => {},
    eosConfigSync: { sync: async () => { syncs += 1; return ok ? { ok: true, applied: ['devices/inverters'], errors: {} } : { ok: false, applied: [], errors: { probe: 'eos_unreachable' } }; } }
  }, { now: () => NOW, monoNow: () => mono });
  await s.refreshPeaks();
  s.pollTick();
  cfg.peakShaving.adaptToReachedPeak = true;
  await s.refreshPeaks();
  mono += 1000; s.pollTick();
  await new Promise((r) => setImmediate(r));
  assert.equal(syncs, 1);
  mono += 30_000; s.pollTick();
  await new Promise((r) => setImmediate(r));
  assert.equal(syncs, 1, 'innerhalb der Minute nicht');
  ok = true;
  mono += 31_000; s.pollTick();
  await new Promise((r) => setImmediate(r));
  assert.equal(syncs, 2, 'nach der Minute erneut');
  mono += 61_000; s.pollTick();
  await new Promise((r) => setImmediate(r));
  assert.equal(syncs, 2, 'quittiert → kein weiterer Abgleich');
});

test('Codex 4638c207 P2: Teil-Abgleich (Wechselrichter angekommen, anderer Abschnitt nicht) quittiert den Wert; Rückkehr wird geschickt', async () => {
  const cfg = base({ adaptToReachedPeak: false });
  const sent = [];
  const store = { getGridImportPeak: async () => ({ slotStart: '2026-03-10T08:00:00.000Z', powerW: 12345 }) };
  let mono = 0;
  const s = createPeakShaving({
    state: { victron: {}, meter: {}, ctrl: {} }, getCfg: () => cfg, telemetryStore: store, pushLog: () => {},
    eosConfigSync: { sync: async () => { sent.push(s.eosTargetW()); return { ok: false, applied: ['devices/inverters'], errors: { 'devices/batteries': 'boom' } }; } }
  }, { now: () => NOW, monoNow: () => mono });
  await s.refreshPeaks();
  s.pollTick();
  cfg.peakShaving.adaptToReachedPeak = true;
  await s.refreshPeaks();
  mono += 61_000; s.pollTick();
  await new Promise((r) => setImmediate(r));
  cfg.peakShaving.adaptToReachedPeak = false;
  mono += 61_000; s.pollTick();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, [12000, 9700], 'angepasst geschickt, Rückkehr auf 9 700 W ebenfalls');
});
