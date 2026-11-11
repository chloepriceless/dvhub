// Abrechnungs-XLSX der LUOX-Direktvermarktung (epex_price/{P…}/{von}/{bis}/producer/):
// schlanker XLSX-Leser (services/tariff-provider/xlsx-lite.js, ohne neue
// Abhängigkeit) und Auswertung der Spalten Zeitstempel, Einspeisung (Wh),
// Day-Ahead-Preis (€/MWh), Vergütung (EUR). Alle Daten sind erfunden.
import test from 'node:test';
import assert from 'node:assert/strict';

import { readXlsxRows, readZipEntries } from '../services/tariff-provider/xlsx-lite.js';
import { parseSettlementRows, parseSettlementXlsx } from '../services/tariff-provider/luox-data.js';
import { buildXlsx, buildZip } from './helpers/xlsx-build.js';

const HEADER = ['Zeitstempel', 'Einspeisung Messwerte (Wh)', 'DayAHead-Auktions Preis (€/MWh)', 'Vergütung (EUR)'];

test('ZIP: deflate und stored, Namen aus dem Zentralverzeichnis, CRC geprüft', () => {
  const zip = buildZip({ 'a.txt': 'hallo', 'b/c.xml': '<x>ü</x>' }, { stored: ['a.txt'] });
  const entries = readZipEntries(zip);
  assert.equal(entries.get('a.txt').toString(), 'hallo');
  assert.equal(entries.get('b/c.xml').toString(), '<x>ü</x>');
  const broken = Buffer.from(zip);
  broken[broken.indexOf(Buffer.from('hallo'))] = 0x48; // 'H' statt 'h'
  assert.throws(() => readZipEntries(broken), /Prüfsumme/);
  assert.throws(() => readZipEntries(Buffer.from('kein zip')), (e) => e.code === 'format');
});

test('ZIP-Bombe: Entpacken über der Grenze bricht ab', () => {
  const zip = buildZip({ 'xl/worksheets/sheet1.xml': Buffer.alloc(3 * 1024 * 1024, 0x20) });
  assert.throws(() => readZipEntries(zip, { maxEntryBytes: 1024 * 1024 }), (e) => e.code === 'format');
});

test('XLSX: gemeinsame, Inline- und Formel-Zeichenketten, Zahlen, Wahrheitswerte, Lücken, Blatt laut Beziehungen', () => {
  const buf = buildXlsx([
    ['Titel & Co', null, { inline: 'inline <x>' }],
    [1.5, true, { str: 'formel' }, -3],
    ['Vergütung (EUR)']
  ], { sheetPath: 'xl/worksheets/sheet3.xml' });
  const rows = readXlsxRows(buf);
  assert.deepEqual(rows[0], ['Titel & Co', null, 'inline <x>']);
  assert.deepEqual(rows[1], [1.5, true, 'formel', -3]);
  assert.deepEqual(rows[2], ['Vergütung (EUR)']);
});

test('Abrechnung: Excel-Datumszahl, Ortszeit, Summenzeile übersprungen', () => {
  // 2026-11-10 12:00 Ortszeit = Excel 46336.5
  const rows = [
    ['Abrechnungsschein-Detail'],
    [],
    HEADER,
    [46336.5, 812, 95.4, 0.0774648],
    [46336.5 + 1 / 96, 790, 93.1, 0.073549],
    ['Summe', 1602, null, 0.1510138]
  ];
  const r = parseSettlementRows(rows);
  assert.equal(r.rows.length, 2);
  assert.deepEqual(r.rows[0], { ts: Date.parse('2026-11-10T11:00:00Z'), durationMs: 900_000, feedWh: 812, priceEurMwh: 95.4, revenueEur: 0.0774648 });
  assert.equal(r.rows[1].ts, Date.parse('2026-11-10T11:15:00Z'));
  assert.equal(r.totals.feedKwh, 1.602);
  assert.equal(r.totals.revenueEur, 0.1510138);
});

test('Abrechnung: Zeitstempel als Text (TT.MM.JJJJ HH:MM und ISO), Zeitumstellung Oktober', () => {
  const rows = [HEADER];
  // 25.10.2026 01:45 MESZ … 03:00 MEZ ohne Versatz — 02:xx doppelt
  const startUtc = Date.parse('2026-10-24T23:45:00Z');
  for (let i = 0; i < 10; i++) {
    const local = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .format(new Date(startUtc + i * 900_000)).replace(',', '');
    rows.push([local, 100 + i, 50, 0.005]);
  }
  rows.push(['2026-10-25T03:15:00+01:00', 1, 50, 0.00005]);
  const r = parseSettlementRows(rows);
  assert.equal(r.rows.length, 11);
  for (let i = 1; i < r.rows.length; i++) assert.equal(r.rows[i].ts - r.rows[i - 1].ts, 900_000, `Abstand an Stelle ${i}`);
});

test('Abrechnung: ohne passende Kopfzeile = format; leere Tabelle = keine Zeilen', () => {
  assert.throws(() => parseSettlementRows([['a', 'b'], [1, 2]]), (e) => e.code === 'format');
  assert.deepEqual(parseSettlementRows([HEADER]).rows, []);
});

test('Abrechnung direkt aus der XLSX-Datei (gemeinsame Zeichenketten, deflate)', () => {
  const buf = buildXlsx([HEADER, [46336.5, 812, 95.4, 0.0774648]]);
  const r = parseSettlementXlsx(buf);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].feedWh, 812);
});
