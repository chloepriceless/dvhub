// Einstellungen → Strompreise → „LUOX / Lumenaza“ (T-0417): Texte für
// Verbindungstest, Stand und Abgleich — ohne DOM, wie die Anbieterpreis-Texte.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const source = fs.readFileSync(fileURLToPath(new URL('../public/settings.js', import.meta.url)), 'utf8');
function load() {
  const sandbox = { console, window: { DVhubCommon: {}, addEventListener() {}, setTimeout() {} } };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: 'settings.js' });
  return sandbox.DVhubSettingsLuox;
}
const { luoxTestText, luoxStateText, luoxSettlementText } = load();

test('Verbindungstest: Verträge mit Art und Status, Hinweis auf die inoffizielle Schnittstelle', () => {
  const text = luoxTestText({ ok: true, notice: 'LUOX-Kundenportal: inoffizielle Portal-Schnittstelle', contracts: [
    { id: 'C90000001-1', kind: 'consumer', status: 'not_delivering' }, { id: 'P90000001-1', kind: 'producer', status: 'delivering' }
  ] });
  assert.match(text, /C90000001-1 \(Bezug, not_delivering\)/);
  assert.match(text, /P90000001-1 \(Erzeugung, delivering\)/);
  assert.match(text, /inoffizielle/);
  assert.match(luoxTestText({ ok: false, error: 'LUOX-Anmeldung abgelehnt' }), /^Fehlgeschlagen: LUOX-Anmeldung abgelehnt/);
});

test('Stand: Day-Ahead, Endkundenpreis (ungeprüft), Abgleich, Partner ohne Zugangsdaten, Sperre', () => {
  const text = luoxStateText({
    notice: 'inoffiziell',
    portal: { configured: true },
    partner: { enabled: true, active: false },
    dvSync: { enabled: true },
    authBlockedUntil: '2026-11-11T20:00:00Z',
    dayAhead: { lastSuccessAt: '2026-11-11T13:00:00Z', source: 'luox_portal', todayCount: 96, tomorrowCount: 96 },
    tariff: { complete: true, displayName: 'LUOX Dynamisch', percentOfSpot: 3, vatPct: 19, perKwh: { gross: 17.78 } },
    settlement: { lastSuccessAt: null }
  });
  assert.match(text, /Kundenportal\): heute 96, morgen 96/);
  assert.match(text, /LUOX Dynamisch \(vorbereitet, ungeprüft\): \(Spot \+ 3 % vom Betrag\) × 119 % \+ 17,78 ct\/kWh/);
  assert.match(text, /Abgleich noch nicht gelaufen/);
  assert.match(text, /ohne Zugangsdaten — es gilt das Kundenportal/);
  assert.match(text, /Zugangsdaten abgelehnt/);
  assert.match(luoxStateText({ portal: { configured: false } }), /Zugangsdaten fehlen/);
});

test('Abgleich: Summen und letzte Tage; leer und Fehler verständlich', () => {
  const text = luoxSettlementText({ ok: true, note: 'Nur zum Abgleich', totals: { luoxFeedKwh: 1.4, luoxRevenueEur: 0.132, dvhubExportKwh: 1.4, dvhubRevenueEur: 0.1325 },
    days: [{ date: '2026-11-04', luoxFeedKwh: 1.4, luoxRevenueEur: 0.132, luoxPortalDayKwh: 4.2, dvhubExportKwh: 1.4, dvhubRevenueEur: 0.1325 }] });
  assert.match(text, /1 Tage: LUOX 1,4 kWh \/ 0,13 € · DVhub 1,4 kWh \/ 0,13 €/);
  assert.match(text, /2026-11-04: LUOX 1,4 kWh \(0,13 €\), Tagessumme 4,2 kWh/);
  assert.match(luoxSettlementText({ ok: true, days: [] }), /Noch keine Abrechnungsdaten/);
  assert.match(luoxSettlementText({ ok: false, error: 'Keine Datenbank' }), /Keine Datenbank/);
});

test('Anbieterauswahl und Auswahl-Optionen: LUOX wählbar, gespeicherter Vertrag geht nicht verloren', () => {
  assert.match(source, /<option value="luox"\$\{name === 'luox' \? ' selected' : ''\}>LUOX Dynamisch<\/option>/);
  assert.match(source, /Gespeicherten Wert nie still verlieren/);
});
