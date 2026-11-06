// test/grid-connection-eos.test.js — EOS plant realistischer (Behelf, bis EOS
// selbst eine Bezugsgrenze kennt): Mit eingetragenem Netzanschluss bekommt EOS
// als AC-Ladeleistung aus dem Netz (inverter max_ac_charge_power_w) höchstens
//   min(maxChargeW, Grenze − Abstand − Grundlast − E-Auto, falls EOS es plant).
//
// Bewusst NICHT battery max_charge_power_w: EOS v0.4.0rc3 nimmt diesen Wert auch
// als Entladegrenze (battery.py discharge_energy, „TODO rename to
// max_discharge_power_w“) — die Abend-Entladung würde mitgekürzt, und das
// PV-Laden (DC, kein Netzbezug) ebenso. max_ac_charge_power_w deckelt in
// v0.4.0rc3 genau das Laden aus dem Netz (inverter.py ac_charge_factor).

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildEosInverters } from '../services/optimizer/eos-config-sync.js';

const LICENSED = { allowGridCharge: true, mispel: { mode: 'pauschal' } };

test('Christins Prod: 27 kW Akku + 11 kW E-Auto an 29 kW → EOS lädt höchstens 16 kW aus dem Netz', () => {
  const cfg = {
    gridConnection: { limitKw: 29 },
    optimizer: { ...LICENSED, maxChargeW: 27000, eosOptimizeEv: true, evMaxChargeW: 11000 }
  };
  // 29 000 − 1 000 Abstand − 1 000 Grundlast − 11 000 E-Auto = 16 000 W
  assert.equal(buildEosInverters(cfg)[0].max_ac_charge_power_w, 16000);
});

test('E-Auto nicht von EOS geplant: 27 kW (Grenze − Abstand − Grundlast), maxChargeW 27 kW passt', () => {
  const cfg = { gridConnection: { limitKw: 29 }, optimizer: { ...LICENSED, maxChargeW: 30000, eosOptimizeEv: false } };
  assert.equal(buildEosInverters(cfg)[0].max_ac_charge_power_w, 27000);
});

test('maxChargeW kleiner als die Netzanschluss-Rechnung: maxChargeW gilt', () => {
  const cfg = { gridConnection: { limitKw: 29 }, optimizer: { ...LICENSED, maxChargeW: 12000 } };
  assert.equal(buildEosInverters(cfg)[0].max_ac_charge_power_w, 12000);
});

test('ohne Netzanschluss-Grenze: unverändert maxChargeW', () => {
  const cfg = { optimizer: { ...LICENSED, maxChargeW: 27000, eosOptimizeEv: true, evMaxChargeW: 11000 } };
  assert.equal(buildEosInverters(cfg)[0].max_ac_charge_power_w, 27000);
});

test('Netzladen nicht erlaubt: bleibt 0, egal welche Grenze', () => {
  const cfg = { gridConnection: { limitKw: 29 }, optimizer: { maxChargeW: 27000 } };
  assert.equal(buildEosInverters(cfg)[0].max_ac_charge_power_w, 0);
});

test('maxChargeW leer: die Netzanschluss-Rechnung allein', () => {
  const cfg = { gridConnection: { limitKw: 29 }, optimizer: { ...LICENSED } };
  assert.equal(buildEosInverters(cfg)[0].max_ac_charge_power_w, 27000);
});
