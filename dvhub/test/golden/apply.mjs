// test/golden/apply.mjs — EINZIGE Aufrufkonvention der Golden-Split-Vektoren (S0, „Bestand festschreiben“).
//
// Generator (generate-split-vectors.mjs) UND Test (golden-split-vectors.test.js) rufen die heutigen reinen
// Funktionen ausschliesslich ueber applyGolden() auf. So kann die Aufrufkonvention nicht zwischen „erzeugt“ und
// „geprueft“ auseinanderlaufen: applyGolden verdrahtet nur die Argumente, die Logik steckt allein in den echten
// Quellfunktionen. Aendert sich eine Quellfunktion, weicht ihr Ergebnis von den eingecheckten Vektoren ab — genau
// das ist der Sinn der Golden-Vektoren.
//
// Zwei Eingangs-Formen (siehe test/golden/README.md):
//   • reine Funktionen:  input = { args: [...] }      → fn(...args)
//   • ctx-basiert:       input = { state, cfg, now, primaryMinSocPct? }
//        ctx wird als { state, getCfg: () => cfg } rekonstruiert; Date.now() wird waehrend des Aufrufs auf
//        input.now festgenagelt (die Planungs-/Netzanteil-Funktionen fragen in secondInverterTelemetry einen
//        Frische-Zeitpunkt ueber Date.now() ab — mit festem now sind sie deterministisch und reproduzierbar).

import {
  splitStrategyShares,
  splitSungrowPower,
  socBalanceWeights,
  sungrowRealSocPct,
  sungrowDischargeFloorPct,
  sungrowChargeCeilPct,
  sungrowEffectivePowerW,
  decideEmsCommand,
  isSungrowEmergencyCharge,
} from '../../services/inverter/sungrow.js';
import {
  planningCfg,
  planningSocPct,
  planningMinSocPct,
} from '../../services/multi-gx/planning.js';
import { gridShareCapacityInput } from '../../services/optimizer/grid-share-poll.js';

/** Reihenfolge = Reihenfolge der eingecheckten Vektor-Dateien. */
export const PURE_FUNCTIONS = [
  'splitStrategyShares',
  'splitSungrowPower',
  'socBalanceWeights',
  'sungrowRealSocPct',
  'sungrowDischargeFloorPct',
  'sungrowChargeCeilPct',
  'sungrowEffectivePowerW',
  'decideEmsCommand',
  'isSungrowEmergencyCharge',
];

/** ctx-basiert, aber deterministisch bei festem now (state/cfg/now sind der vollstaendige Eingang). */
export const CTX_FUNCTIONS = [
  'planningCfg',
  'planningSocPct',
  'planningMinSocPct',
  'gridShareCapacityInput',
];

export const ALL_FUNCTIONS = [...PURE_FUNCTIONS, ...CTX_FUNCTIONS];

function buildCtx(input) {
  const cfg = input.cfg;
  return { state: input.state, getCfg: () => cfg };
}

function withPinnedNow(now, fn) {
  if (now == null) return fn();
  const orig = Date.now;
  try {
    Date.now = () => now;
    return fn();
  } finally {
    Date.now = orig;
  }
}

/**
 * Heutige Quellfunktion gegen einen Vektor-Eingang aufrufen.
 * @param {string} fnName
 * @param {object} input  { args } oder { state, cfg, now, primaryMinSocPct? }
 * @returns {*} das rohe Funktionsergebnis (der Aufrufer normiert via JSON fuer den Vergleich)
 */
export function applyGolden(fnName, input) {
  switch (fnName) {
    // --- reine Funktionen (Positionsargumente) ---
    case 'splitStrategyShares': return splitStrategyShares(...input.args);
    case 'splitSungrowPower': return splitSungrowPower(...input.args);
    case 'socBalanceWeights': return socBalanceWeights(...input.args);
    case 'sungrowRealSocPct': return sungrowRealSocPct(...input.args);
    case 'sungrowDischargeFloorPct': return sungrowDischargeFloorPct(...input.args);
    case 'sungrowChargeCeilPct': return sungrowChargeCeilPct(...input.args);
    case 'sungrowEffectivePowerW': return sungrowEffectivePowerW(...input.args);
    case 'decideEmsCommand': return decideEmsCommand(...input.args);
    case 'isSungrowEmergencyCharge': return isSungrowEmergencyCharge(...input.args);
    // --- ctx-basiert (now festgenagelt) ---
    case 'planningCfg': return withPinnedNow(input.now, () => planningCfg(buildCtx(input), input.cfg));
    case 'planningSocPct': return withPinnedNow(input.now, () => planningSocPct(buildCtx(input)));
    case 'planningMinSocPct': return withPinnedNow(input.now, () => planningMinSocPct(buildCtx(input), input.primaryMinSocPct));
    case 'gridShareCapacityInput': return withPinnedNow(input.now, () => gridShareCapacityInput(buildCtx(input), input.cfg));
    default: throw new Error(`Unbekannte Golden-Funktion: ${fnName}`);
  }
}

/** JSON-normiertes Ergebnis (−0 → 0, undefined-Felder weg, Floats wie JSON sie schreibt). */
export function normalized(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}
