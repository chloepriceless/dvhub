// test/eos-capabilities-local-native.test.js — D und E mit dem nativen Kern (A14, 21.11.2026).
//
// DVhub sendet die Schwellen-Spitzenkappung (D, #1531: Netzbezugsgrenze am Wechselrichter,
// der Plan trägt `peak_shaving_threshold_w`) und die E-Auto-Wertstufen (E, #1532:
// `soc_value_steps`) genau dann, wenn der laufende Kern sie meldet. Erkannt wird am Inhalt von
// GET /v1/config bzw. am Plan (eos-capabilities.js), nicht an der Betriebsart
// optimizer.eosProxy.mode: Python-DVhub-EOS (dvhub-eos-…-dvhub.2, enthält #1531/#1532) und
// der native Kern ab 0.2.0 melden beide D/E; der native Kern 0.1.x meldete E nicht und trug
// keine Schwelle im Plan, also bekam er beides auch nicht.
//
// Die Fixtures sind echte Antworten (Kurztest A14, aarch64-musl):
//   0.2.0-dev2611211058 = dvhub-rs a1c4434, EOS 0.4.0rc3 + unsere Änderungen (Referenz db8aa0a7)
//   0.1.0-dev2611152231 = bisheriger Pin (Kern-Semantik upstream main, D/E abgelehnt)
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  detectEosCapabilities, detectPlanCapabilities, peakShavingThresholdW,
  EOS_EV_SOC_VALUE_FIELD, EOS_GRID_IMPORT_LIMIT_FIELD, EOS_PEAK_SHAVING_THRESHOLD_FIELD,
} from '../services/optimizer/eos-capabilities.js';
import { buildEosElectricVehicles } from '../services/optimizer/eos-config-sync.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/dvhub-optimize/${name}`, import.meta.url), 'utf8'));
const NEW = '0.2.0-dev2611211058';
const OLD = '0.1.0-dev2611152231';
const steps = [[60, 0.2], [70, 0.1]];
const evFor = (caps) => buildEosElectricVehicles({ optimizer: { evMaxChargeW: 11000 } }, {
  supportsSocValue: caps.evSocValue === true, targets: { minSocPct: 50, maxSocPct: 80, steps },
})[0];

describe(`nativer Kern ${NEW} (rc3 + unsere Änderungen)`, () => {
  const caps = detectEosCapabilities(fixture(`config-${NEW}.json`), { version: '0.4.0rc3' });
  const plan = fixture(`plan-${NEW}-ev-socvalue-limit.json`).instructions;

  test('wird als EOS 0.4 erkannt und meldet Netzbezugsgrenze (D) und Wertstufen (E)', () => {
    assert.equal(caps.supported, true);
    assert.equal(caps.gridImportLimit, true, EOS_GRID_IMPORT_LIMIT_FIELD);
    assert.equal(caps.evSocValue, true, EOS_EV_SOC_VALUE_FIELD);
    assert.equal(caps.evChargeStart, true);
    assert.equal(caps.fitnessCacheLimit, true);
    assert.equal(caps.solutionNotify, false, 'bewusst ohne notify_url: POST /v1/optimize antwortet synchron');
  });

  test('der Plan trägt die Schwelle an jeder Akku-Anweisung (D), am Auto nicht', () => {
    assert.equal(detectPlanCapabilities(plan).peakShavingThreshold, true);
    const bat = plan.filter((e) => e.actuator_id === 'battery1');
    assert.ok(bat.length > 0);
    for (const e of bat) assert.equal(peakShavingThresholdW(e), 8000, `${EOS_PEAK_SHAVING_THRESHOLD_FIELD} @ ${e.execution_time}`);
  });

  test('DVhub schickt die Wertstufen mit (E)', () => {
    assert.deepEqual(evFor(caps)[EOS_EV_SOC_VALUE_FIELD], steps);
  });
});

describe(`bisheriger nativer Kern ${OLD} (ohne D/E)`, () => {
  const caps = detectEosCapabilities(fixture(`config-${OLD}.json`), { version: '0.4.0rc3' });
  const plan = fixture(`plan-${OLD}-ev-socvalue-limit.json`).instructions;

  test('meldet keine Wertstufen, der Plan keine Schwelle', () => {
    assert.equal(caps.supported, true);
    assert.equal(caps.evSocValue, false);
    assert.equal(detectPlanCapabilities(plan).peakShavingThreshold, false);
  });

  test('DVhub schickt ihm keine Wertstufen', () => {
    assert.equal(EOS_EV_SOC_VALUE_FIELD in evFor(caps), false);
  });
});
