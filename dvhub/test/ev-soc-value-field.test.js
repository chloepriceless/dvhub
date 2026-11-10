// test/ev-soc-value-field.test.js -- Schnittstelle zum EOS-Feld soc_value_steps
// (EOS-PR pr/ev-soc-value 04ba0dc): Einheit je GESPEICHERTER kWh (AC-Preis ÷ η)
// und dieselben Prüfregeln wie EOS (devicesabc.validate_soc_value_steps +
// Überlauf am Fahrzeug) — DVhub schickt nie etwas, das EOS ablehnen würde.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validSocValueSteps, EOS_EV_SOC_VALUE_FIELD } from '../services/optimizer/eos-capabilities.js';
import { valueSteps } from '../services/optimizer/ev-minmax.js';
import { buildEosElectricVehicles } from '../services/optimizer/eos-config-sync.js';

const golden = JSON.parse(readFileSync(new URL('./fixtures/ev-minmax-golden.json', import.meta.url), 'utf8'));

describe('Prüfregeln wie EOS', () => {
  test('gültig: aufsteigend in ]0, 100], Beträge endlich, ≥ 0, nicht steigend', () => {
    assert.deepEqual(validSocValueSteps([[55, 0.3], [80, 0.3], [100, 0]], { capacityWh: 75000 }), [[55, 0.3], [80, 0.3], [100, 0]]);
  });
  test('leer / null = keine Wertung', () => {
    assert.equal(validSocValueSteps([], { capacityWh: 75000 }), null);
    assert.equal(validSocValueSteps(null, { capacityWh: 75000 }), null);
  });
  for (const [name, steps] of [
    ['SoC 0', [[0, 0.2]]], ['SoC über 100', [[101, 0.2]]], ['SoC NaN', [[NaN, 0.2]]],
    ['nicht streng steigend', [[60, 0.3], [60, 0.2]]], ['absteigend', [[70, 0.3], [60, 0.2]]],
    ['Betrag negativ', [[60, -0.1]]], ['Betrag unendlich', [[60, Infinity]]], ['Betrag steigt', [[60, 0.2], [70, 0.3]]],
    ['Überlauf mit der Kapazität', [[80, 1e308]]], ['kein Paar', [[60]]],
  ]) {
    test(`abgelehnt: ${name}`, () => assert.equal(validSocValueSteps(steps, { capacityWh: 75000 }), null));
  }
  test('alle Golden-Wertstufen erfüllen die Regeln', () => {
    for (const s of golden.scenarios) if (s.expect.steps.length) assert.deepEqual(validSocValueSteps(s.expect.steps, { capacityWh: s.capacityWh }), s.expect.steps, s.name);
  });
  test('ungültige Stufen gehen nicht an EOS (Feld null statt Ablehnung des ganzen Fahrzeugs)', () => {
    const [ev] = buildEosElectricVehicles({ optimizer: { evMaxChargeW: 11000 } }, { supportsSocValue: true, targets: { minSocPct: 50, maxSocPct: 80, steps: [[60, 0.2], [70, 0.3]] } });
    assert.equal(ev[EOS_EV_SOC_VALUE_FIELD], null);
  });
});

describe('Einheit: Betrag je gespeicherter kWh', () => {
  test('fester Bezugspreis 30 ct (AC), später sicher nachzuladen: Wert = (30 − 1 ct Abschlag) ÷ 0,88', () => {
    const SLOT = 15 * 60_000;
    const base = Date.parse('2026-11-16T19:00:00Z');
    const n = 10 * 96;
    const flat = (v) => new Array(n).fill(v);
    // Abfahrt in 3 Tagen mit Mindestziel 80 %: was jetzt über 50 % geladen ist, muss sonst später zum selben Preis nachgeladen werden.
    const trips = [{ depMs: base + 72 * 3600_000, retMs: base + 80 * 3600_000, tripPct: 30, minPct: 80 }];
    const r = valueSteps({
      baseMs: base, slotMs: SLOT, importCt: flat(30), feedInCt: flat(8), surplusWh: flat(0),
      eMs: base, sEPct: 50, maxPct: 80, trips, marginCt: 1, capacityWh: 75000, eta: 0.88, chargeW: 11000, timeZone: 'Europe/Berlin',
    });
    const expected = Math.round((30 - 1) / 0.88 / 100 * 1e5) / 1e5;
    assert.ok(r.steps.length > 0);
    for (const [, v] of r.steps) assert.equal(v, expected, JSON.stringify(r.steps));
  });
});
