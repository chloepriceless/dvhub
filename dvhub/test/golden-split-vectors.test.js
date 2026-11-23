// test/golden-split-vectors.test.js — S0 „Bestand festschreiben“: prueft die HEUTIGEN reinen Split-/Planungs-
// Funktionen gegen die eingecheckten Golden-Vektoren (test/golden/inverter-split/*.json).
//
// Dieser Test MUSS gruen sein. Er wird ROT, sobald sich eine der erfassten Funktionen im Verhalten aendert —
// genau das ist der Zweck: die reinen Funktionen sind damit als Referenz eingefroren (Grundlage fuer das spaetere
// Herausloesen in S1 und die Rust-Paritaet). Er aendert KEINEN Produktcode.
//
// Erzeugt werden die Vektoren mit test/golden/generate-split-vectors.mjs (deterministisch, byte-gleich
// reproduzierbar). Die Aufrufkonvention teilt sich der Test mit dem Generator ueber test/golden/apply.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyGolden, normalized, ALL_FUNCTIONS } from './golden/apply.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, 'golden', 'inverter-split');
const SCHEMA = 'dvhub.golden-split/1';

// Pflicht-Feldfaelle, die laut Auftrag einzeln und erkennbar dabei sein muessen (Datei → Vektornamen).
const REQUIRED_FIELD_CASES = {
  'splitStrategyShares.json': ['feld_9.2_14.4_entladen', 'feld_9.2_14.4_laden', 'feld_0.8_2.2_entladen', 'feld_0.8_2.2_laden', 'slave_offline', 'boden_je_einheit_N1_slave_am_boden', 'master_only_slave_uncommanded', 'ungleiche_boeden_slave_am_boden', 'ungleiche_decken_slave_voll',
    // M28: Übernahme bei „liefert nicht“ und Entlade-Marge (masterOut/slaveOut).
    'm28_master_haengt_slave_uebernimmt', 'm28_slave_haengt_master_uebernimmt', 'm28_beide_haengen_normale_aufteilung', 'm28_master_haengt_slave_am_boden_behaelt', 'm28_marge_slave_knapp_ueber_boden_raus'],
  // Eingetragener Puffer 1 (Standard seit M24 = 0): Boden Gerätemin 10 + 1 = 11 %.
  'planningMinSocPct.json': ['sungrow_single_puffer1_primaryMin5', 'sungrow_aggregiert_puffer1_primaryMin5'],
  'gridShareCapacityInput.json': ['sungrow_single_puffer1', 'sungrow_aggregiert_puffer1'],
  'socBalanceWeights.json': ['feld_9.2_14.4_entladen', 'feld_9.2_14.4_laden', 'feld_0.8_2.2_entladen', 'feld_0.8_2.2_laden'],
  'sungrowRealSocPct.json': ['gemeldet_0_real_geraetemin', 'gemeldet_100_real_max', 'min_gleich_max_kein_fenster'],
  'sungrowDischargeFloorPct.json': ['N1_hardFloor5_deviceMin10_buffer1'],
  'isSungrowEmergencyCharge.json': ['notladung_0x4001'],
  'decideEmsCommand.json': ['entlade_boden_sperrt_entladen', 'netzlade_verbot_charge_pv_only', 'nur_last_decken_discharge_load_only'],
};

// Benannte Faelle, deren Reglerzweig (reason) ausdruecklich eingefroren wird.
const REQUIRED_REASONS = {
  'decideEmsCommand.json': {
    entlade_boden_sperrt_entladen: 'discharge_floor',
    netzlade_verbot_charge_pv_only: 'charge_pv_only',
    nur_last_decken_discharge_load_only: 'discharge_load_only',
    // Unter dem Boden bleibt Laden aus PV erlaubt → reason regulate (command charge), NICHT discharge_floor.
    unter_boden_laden_aus_pv_erlaubt: 'regulate',
  },
};

function loadFile(fn) {
  const file = path.join(DIR, `${fn}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('Golden-Split-Vektoren: fuer jede Funktion existiert eine Vektor-Datei', () => {
  const present = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort();
  assert.deepStrictEqual(present, [...ALL_FUNCTIONS].sort(), 'erfasste Funktionen weichen von den eingecheckten Dateien ab');
});

for (const fn of ALL_FUNCTIONS) {
  test(`Golden-Split-Vektoren: ${fn} — heutige Funktion == eingecheckte Vektoren`, () => {
    const data = loadFile(fn);
    assert.equal(data.schema, SCHEMA, `${fn}: Schema`);
    assert.equal(data.function, fn, `${fn}: function-Feld`);
    assert.ok(Array.isArray(data.vectors) && data.vectors.length > 0, `${fn}: vectors nicht leer`);
    assert.equal(data.count, data.vectors.length, `${fn}: count == vectors.length`);

    const names = new Set();
    let mismatches = 0;
    const firstBad = [];
    for (const v of data.vectors) {
      assert.ok(typeof v.name === 'string' && v.name.length > 0, `${fn}: Vektor ohne Namen`);
      assert.ok(!names.has(v.name), `${fn}: doppelter Vektorname ${v.name}`);
      names.add(v.name);
      const got = normalized(applyGolden(fn, v.input));
      try {
        assert.deepStrictEqual(got, v.output);
      } catch {
        mismatches += 1;
        if (firstBad.length < 5) firstBad.push(`${v.name}: erwartet ${JSON.stringify(v.output)} vs heute ${JSON.stringify(got)}`);
      }
    }
    assert.equal(mismatches, 0, `${fn}: ${mismatches} Abweichung(en)\n${firstBad.join('\n')}`);

    const required = REQUIRED_FIELD_CASES[`${fn}.json`];
    if (required) {
      for (const name of required) assert.ok(names.has(name), `${fn}: Pflicht-Feldfall "${name}" fehlt`);
    }

    // Benannte decideEmsCommand-Faelle muessen den Zweig ihres Namens auch wirklich treffen (Codex P3):
    // nicht nur der Name, sondern das erwartete reason ist eingefroren.
    const reasons = REQUIRED_REASONS[`${fn}.json`];
    if (reasons) {
      for (const [name, reason] of Object.entries(reasons)) {
        const v = data.vectors.find((x) => x.name === name);
        assert.ok(v, `${fn}: Pflicht-Feldfall "${name}" fehlt`);
        assert.equal(v.output.reason, reason, `${fn}: "${name}" trifft Zweig "${reason}" nicht (reason=${v.output.reason})`);
      }
    }
  });
}

test('Golden-Split-Vektoren: Gesamtzahl plausibel (einige Tausend)', () => {
  let total = 0;
  for (const fn of ALL_FUNCTIONS) total += loadFile(fn).vectors.length;
  assert.ok(total >= 2000, `nur ${total} Vektoren insgesamt`);
});
