// Warnung „Preis-Zeitraum endet bald“ (Chrissi 28.10.2026): 14 Tage vor dem Ende
// eines Strompreis-Zeitraums, auf den kein Zeitraum direkt folgt, gelb oben im
// Leitstand — sonst rechnet DVhub ab dem Folgetag still mit dem Grundtarif.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pricingPeriodEndWarning } from '../services/pricing-period-warning.js';

const at = (iso) => Date.parse(iso);
const base = {
  mode: 'fixed',
  fixedGrossImportCtKwh: 26.9,
  periods: [
    { id: 'p1', label: 'Grüün', startDate: '2025-12-10', endDate: '2026-10-31', mode: 'fixed', fixedGrossImportCtKwh: 26.9 },
    { id: 'p2', label: 'Lichtblick Dynamisch', startDate: '2026-11-01', endDate: '2026-12-31', mode: 'provider' }
  ]
};

test('direkter Folgezeitraum: keine Warnung', () => {
  assert.equal(pricingPeriodEndWarning(base, at('2026-10-25T10:00:00Z')), null);
});

test('Ende in weniger als 14 Tagen ohne Folgezeitraum: Warnung mit Datum und Grundtarif', () => {
  const msg = pricingPeriodEndWarning(base, at('2026-12-20T10:00:00Z'));
  assert.match(msg, /„Lichtblick Dynamisch“ endet am 31\.12\.2026/);
  assert.match(msg, /Grundtarif \(fest 26,9 ct\/kWh\)/);
  assert.match(msg, /ab 01\.01\.2027/);
});

test('mehr als 14 Tage vor dem Ende: keine Warnung', () => {
  assert.equal(pricingPeriodEndWarning(base, at('2026-12-16T10:00:00Z')), null);
});

test('letzter Tag (Berliner Zeit) zählt noch, Folgetag nicht mehr', () => {
  assert.match(pricingPeriodEndWarning(base, at('2026-12-31T22:30:00Z')) || '', /endet am 31\.12\.2026/, '23:30 Berlin am 31.12.');
  assert.equal(pricingPeriodEndWarning(base, at('2026-12-31T23:30:00Z')), null, '00:30 Berlin am 01.01. — Zeitraum vorbei');
});

test('Lücke: nächster Zeitraum beginnt erst später', () => {
  const p = { ...base, periods: [base.periods[1], { label: 'Neu', startDate: '2027-01-15', endDate: '2027-12-31', mode: 'fixed', fixedGrossImportCtKwh: 30 }] };
  const msg = pricingPeriodEndWarning(p, at('2026-12-28T10:00:00Z'));
  assert.match(msg, /bis zum Beginn von „Neu“ am 15\.01\.2027/);
});

test('ohne Zeiträume oder ohne aktiven Zeitraum: keine Warnung', () => {
  assert.equal(pricingPeriodEndWarning({ mode: 'fixed', fixedGrossImportCtKwh: 30 }, at('2026-12-28T10:00:00Z')), null);
  assert.equal(pricingPeriodEndWarning({ ...base, periods: [base.periods[0]] }, at('2027-02-01T10:00:00Z')), null);
});

test('Grundtarif dynamisch bzw. vom Stromanbieter: passender Text', () => {
  assert.match(pricingPeriodEndWarning({ ...base, mode: 'dynamic' }, at('2026-12-20T10:00:00Z')), /Grundtarif \(dynamisch\)/);
  assert.match(pricingPeriodEndWarning({ ...base, mode: 'provider' }, at('2026-12-20T10:00:00Z')), /Grundtarif \(vom Stromanbieter\)/);
});

// Verdrahtung: server.js setzt die Systemwarnung beim Start und regelmäßig nach
// (ein neu gespeicherter Zeitraum nimmt sie binnen Minuten wieder weg).
test('server.js setzt die Warnung pricing_period_ending über setSystemWarning', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(src, /import \{ pricingPeriodEndWarning \} from '\.\/services\/pricing-period-warning\.js'/);
  assert.match(src, /setSystemWarning\('pricing_period_ending', pricingPeriodEndWarning\(/);
  assert.match(src, /setInterval\(refreshPricingPeriodWarning, 10 \* 60_000\)/);
});

// Gegenprüfung 7c47107f (P3): neue Zeiträume haben anfangs keinen Namen
// (createEmptyPricingPeriod: label ''). Der Text darf dann nicht doppelt
// „Strompreis-Zeitraum“ sagen und nicht „von des nächsten Zeitraums“.
test('Zeitraum ohne Namen: lesbarer Text ohne doppelten Vorsatz', () => {
  const p = { ...base, periods: [{ ...base.periods[1], label: '' }, { label: '', startDate: '2027-01-15', endDate: '2027-12-31', mode: 'fixed', fixedGrossImportCtKwh: 30 }] };
  const msg = pricingPeriodEndWarning(p, at('2026-12-28T10:00:00Z'));
  assert.match(msg, /^Dein Strompreis-Zeitraum endet am 31\.12\.2026\./);
  assert.doesNotMatch(msg, /Strompreis-Zeitraum Dein/);
  assert.match(msg, /bis zum Beginn des nächsten Zeitraums am 15\.01\.2027/);
  assert.doesNotMatch(msg, /von des/);
});

test('Zeitraum mit Namen: Text unverändert', () => {
  const msg = pricingPeriodEndWarning(base, at('2026-12-20T10:00:00Z'));
  assert.match(msg, /^Strompreis-Zeitraum „Lichtblick Dynamisch“ endet am 31\.12\.2026\./);
});

// Gegenprüfung 7c47107f (P3): Wer den Folgezeitraum anlegt, soll die Warnung
// nicht noch bis zu 10 min sehen — applyLoadedConfig rechnet sie sofort neu.
// Die Referenz wird erst gesetzt, wenn setSystemWarning existiert (die
// einmalige Regel-Übernahme ruft saveAndApplyConfig schon früher auf).
test('server.js rechnet die Warnung nach jedem Übernehmen der Config neu', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const apply = src.slice(src.indexOf('function applyLoadedConfig('), src.indexOf('function refreshDerivedBatteryCapacity('));
  assert.match(apply, /pricingPeriodWarningRefresh\?\.\(\)|typeof pricingPeriodWarningRefresh === 'function'/);
  const decl = src.indexOf('let pricingPeriodWarningRefresh = null;');
  assert.ok(decl > 0, 'Deklaration fehlt');
  assert.ok(decl < src.indexOf('if (rulesMigratedFromConfig)'), 'muss vor dem ersten saveAndApplyConfig-Aufruf deklariert sein');
  assert.match(src, /pricingPeriodWarningRefresh = refreshPricingPeriodWarning;/);
});
