// test/effective-pv.test.js — effektive PV-Gesamtgröße über beide Sungrow-WR (Punkt 5).
import test from 'node:test';
import assert from 'node:assert/strict';
import { effectivePvKwp, secondInverterPvKwp, stringsCoverWholePlant } from '../services/forecast/effective-pv.js';

const twoWr = {
  manufacturer: 'sungrow',
  forecast: { pv: { totalKwp: 12.32 } },
  sungrow: { secondInverter: { host: '192.168.68.83', pvKwp: 11.88 } },
};

test('effectivePvKwp: totalKwp + PV des zweiten WR (Feldbox 12,32 + 11,88 = 24,2)', () => {
  assert.equal(effectivePvKwp(twoWr), 24.2);
  assert.equal(effectivePvKwp(twoWr, 12.32), 24.2);   // Aufrufer gibt Basis vor
  assert.equal(secondInverterPvKwp(twoWr), 11.88);
});

test('effectivePvKwp: ohne zweiten WR nur die Basis', () => {
  assert.equal(effectivePvKwp({ manufacturer: 'sungrow', forecast: { pv: { totalKwp: 10 } }, sungrow: {} }), 10);
  // Nicht-Sungrow: Slave-PV zählt nicht.
  assert.equal(effectivePvKwp({ manufacturer: 'victron', forecast: { pv: { totalKwp: 10 } }, sungrow: { secondInverter: { host: 'x', pvKwp: 5 } } }), 10);
  // Host leer → kein zweiter WR.
  assert.equal(effectivePvKwp({ manufacturer: 'sungrow', forecast: { pv: { totalKwp: 10 } }, sungrow: { secondInverter: { host: '', pvKwp: 5 } } }), 10);
});

test('effectivePvKwp: Basis aus pvPlants-Summe, wenn totalKwp fehlt', () => {
  const cfg = { manufacturer: 'sungrow', forecast: { pv: {} }, userEnergyPricing: { pvPlants: [{ kwp: 6 }, { kwp: 6.32 }] }, sungrow: { secondInverter: { host: 'x', pvKwp: 11.88 } } };
  assert.equal(effectivePvKwp(cfg), 24.2);
  // Keine Basis und kein Slave → null.
  assert.equal(effectivePvKwp({ forecast: { pv: {} } }), null);
});

// M13 (Feld 16.11.): keine Doppelzählung, wenn die Strings schon BEIDE WR beschreiben.
const twoWrDetailed = {
  manufacturer: 'sungrow',
  forecast: {
    pv: {
      configLevel: 'detailed',
      totalKwp: 24.2, // = String-Summe (von migratePvTotalKwp synchron gehalten)
      strings: [
        { kwp: 12.32, tiltDeg: 40, azimuthDeg: 216 },
        { kwp: 11.88, tiltDeg: 40, azimuthDeg: 25 },
      ],
    },
  },
  sungrow: { secondInverter: { host: '192.168.68.83', pvKwp: 11.88 } },
};

test('effectivePvKwp: detaillierte Strings decken BEIDE WR → Zweit-WR NICHT addieren (24,2 statt 36,08)', () => {
  assert.equal(stringsCoverWholePlant(twoWrDetailed), true);
  assert.equal(effectivePvKwp(twoWrDetailed), 24.2);        // Basis aus String-Summe
  assert.equal(effectivePvKwp(twoWrDetailed, 24.2), 24.2);  // Aufrufer reicht totalKwp als Basis durch
});

test('effectivePvKwp: simple/kein strings → Zweit-WR wie bisher addieren (12,32 + 11,88 = 24,2)', () => {
  const simple = {
    manufacturer: 'sungrow',
    forecast: { pv: { configLevel: 'simple', totalKwp: 12.32 } },
    sungrow: { secondInverter: { host: '192.168.68.84', pvKwp: 11.88 } },
  };
  assert.equal(stringsCoverWholePlant(simple), false);
  assert.equal(effectivePvKwp(simple), 24.2);
  assert.equal(effectivePvKwp(simple, 12.32), 24.2);
});

test('stringsCoverWholePlant: nur bei detailed UND nicht-leerem strings-Array', () => {
  assert.equal(stringsCoverWholePlant({ forecast: { pv: { configLevel: 'detailed', strings: [] } } }), false);
  assert.equal(stringsCoverWholePlant({ forecast: { pv: { configLevel: 'simple', strings: [{ kwp: 5 }] } } }), false);
  assert.equal(stringsCoverWholePlant({ forecast: { pv: { configLevel: 'standard' } } }), false);
  assert.equal(stringsCoverWholePlant({ forecast: { pv: {} } }), false);
});
