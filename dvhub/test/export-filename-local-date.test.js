// Export-Dateiname nach dem Ortsdatum der Anlage, nicht dem UTC-Datum (Rest aus
// der Oberflächen-Prüfung 25.10.: zwischen 00:00 und 02:00 Berliner Zeit trug die
// Datei sonst das Datum von gestern).
import test from 'node:test';
import assert from 'node:assert/strict';
import { exportDateStamp } from '../routes-api.js';

test('Ortsdatum Europe/Berlin kurz nach Mitternacht', () => {
  assert.equal(exportDateStamp('Europe/Berlin', Date.parse('2026-10-26T23:30:00Z')), '2026-10-27');
  assert.equal(exportDateStamp('Europe/Berlin', Date.parse('2026-07-14T22:30:00Z')), '2026-07-15');
});

test('ungültige Zeitzone fällt auf Europe/Berlin zurück', () => {
  assert.equal(exportDateStamp('Nirgendwo/Stadt', Date.parse('2026-10-26T23:30:00Z')), '2026-10-27');
});
