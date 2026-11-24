// services/optimizer/terminal-value.js — M17: „EOS bewertet die Akkuladung am
// Planende mit X ct/kWh".
//
// Hintergrund (Feld 16.11.2026): EOS hielt den Akku 32 h (idle/non_export), SoC
// 59–65 %, weil Einspeisen sich nicht lohnte (Einspeisewert < Bezugspreis). Bei
// festem Bezugspreis ist eine gespeicherte kWh heute so viel wert wie morgen —
// Halten kostet ohne PV-Überschuss nichts. Kunden fragen „warum tut EOS nichts";
// diese Kennzahl beantwortet das.
//
// Quelle ist der TERMINAL-WERT, den EOS selbst in der Lösung liefert
// (GeneticSolution.terminal_value, Rust-Kern src/solution/model.rs:
// `TerminalValueResult` / `TerminalValueCurve`), NICHT eine DVhub-Preisannahme:
//   • terminal_value.curve.marginal_euro_per_kwh[] — der Grenzwert je Segment der
//     stückweise linearen Wertkurve (EUR/kWh); gebaut aus den Preisen/Lasten am
//     Horizontende (curves.rs build_terminal_value_curve). Der Grenzwert an der
//     am Planende gespeicherten Energie = der Wert der „letzten" gehaltenen kWh =
//     die Schwelle, unter der Entladen/Verkaufen sich nicht mehr lohnt.
//   • Nur im FIXED-Modus fehlt die Kurve; dann ist der Wert je kWh die
//     Gutschrift credited_euro / battery_energy_wh (= der feste Terminalpreis).
//
// Warum NICHT durchgängig credited_euro / battery_energy_wh: Im TAIL-Modus
// (DVhub-Standard, tail_horizon_hours 48) enthält credited_euro auch den Wert des
// Akku-Betriebs über den Schwanz, und battery_energy_wh ist die Energie am
// HORIZONTENDE — in den Parity-Fixtures ≈ 0 Wh bei credited ≈ 1,22 €. Die
// Division explodiert dort. Der Kurven-Grenzwert ist beschränkt und ökonomisch
// die richtige „ct/kWh je gespeicherter kWh".

/** Energie am Planende, unter der die Division credited/Energie unbrauchbar wird. */
export const MIN_ENERGY_WH = 10;

const n = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

/**
 * Grenzwert der Terminal-Wert-Kurve an der Energie `energyWh` [Wh] → EUR/kWh.
 * Die Kurve hat N Stützstellen `energy_wh` (kumulierte Energie, aufsteigend) und
 * N-1 Segment-Grenzwerte `marginal_euro_per_kwh` (fallend: wertvollste Nutzung
 * zuerst). Der Grenzwert an `energyWh` ist der des Segments, in dem die am
 * Planende gespeicherte Energie liegt.
 * @returns {number|null} EUR/kWh, oder null ohne brauchbare Kurve.
 */
export function marginalEurPerKwhAt(curve, energyWh) {
  if (!curve || typeof curve !== 'object') return null;
  const en = Array.isArray(curve.energy_wh) ? curve.energy_wh : null;
  const mg = Array.isArray(curve.marginal_euro_per_kwh) ? curve.marginal_euro_per_kwh : null;
  if (!en || !mg || mg.length === 0) return null;
  const e = n(energyWh) ?? 0;
  if (!(n(en[0]) === null) && e <= Number(en[0])) return n(mg[0]);
  for (let i = 0; i < mg.length; i += 1) {
    const hi = Number(en[i + 1]);
    if (!Number.isFinite(hi)) break;
    if (e < hi) return n(mg[i]);
  }
  return n(mg[mg.length - 1]);
}

/**
 * Formt den rohen EOS-Terminalwert (GeneticSolution.terminal_value) in die
 * Leitstand-Anzeige. Alle Zahlen stammen aus der EOS-Lösung; DVhub rechnet nur
 * um (EUR/kWh → ct/kWh) und wählt das Kurvensegment.
 *
 * @param {object|null|undefined} tv  solution.terminal_value aus EOS
 * @returns {{
 *   available: boolean,
 *   ctPerKwh: number|null,            // Wert je am Planende gespeicherter kWh [ct/kWh]
 *   basis: 'curve'|'credit'|null,     // 'curve' = Kurven-Grenzwert, 'credit' = Gutschrift/Energie (FIXED)
 *   mode: string|null,                // EOS-Modus: 'TAIL'|'AUTO'|'FIXED'
 *   batteryEnergyWh: number|null,     // nutzbare AC-Energie am Horizontende
 *   heldCharge: boolean,              // am Planende nennenswerte Ladung vorhanden?
 *   creditedEuro: number|null,
 *   continuationEuro: number|null,
 *   tailOperatingEuro: number|null,
 *   importLowCt: number|null,         // Bezugspreis-Band im Schwanz [ct/kWh]
 *   importHighCt: number|null,
 *   source: 'eos',                    // immer aus der EOS-Lösung, keine DVhub-Annahme
 *   reason: string|null,
 * }}
 */
export function deriveTerminalValue(tv) {
  const empty = {
    available: false, ctPerKwh: null, basis: null, mode: null,
    batteryEnergyWh: null, heldCharge: false,
    creditedEuro: null, continuationEuro: null, tailOperatingEuro: null,
    importLowCt: null, importHighCt: null, source: 'eos', reason: null,
  };
  if (!tv || typeof tv !== 'object') return empty;

  const mode = typeof tv.mode === 'string' ? tv.mode : null;
  const batteryEnergyWh = n(tv.battery_energy_wh);
  const creditedEuro = n(tv.credited_euro);
  const continuationEuro = n(tv.continuation_value_euro);
  const tailOperatingEuro = n(tv.tail_operating_euro);
  const curve = tv.curve && typeof tv.curve === 'object' ? tv.curve : null;

  let ctPerKwh = null;
  let basis = null;
  const marginal = marginalEurPerKwhAt(curve, batteryEnergyWh);
  if (marginal !== null) {
    ctPerKwh = marginal * 100;              // EUR/kWh → ct/kWh
    basis = 'curve';
  } else if (batteryEnergyWh !== null && batteryEnergyWh >= MIN_ENERGY_WH && creditedEuro !== null) {
    ctPerKwh = (creditedEuro / batteryEnergyWh) * 100000; // EUR/Wh → ct/kWh
    basis = 'credit';
  }

  const td = tv.tail_diagnostics && typeof tv.tail_diagnostics === 'object' ? tv.tail_diagnostics : null;
  const importLow = td ? n(td.min_import_price_euro_per_kwh) : null;
  const importHigh = td ? n(td.max_import_price_euro_per_kwh) : null;

  return {
    available: ctPerKwh !== null && Number.isFinite(ctPerKwh),
    ctPerKwh: ctPerKwh !== null && Number.isFinite(ctPerKwh) ? ctPerKwh : null,
    basis,
    mode,
    batteryEnergyWh,
    heldCharge: batteryEnergyWh !== null && batteryEnergyWh >= MIN_ENERGY_WH,
    creditedEuro,
    continuationEuro,
    tailOperatingEuro,
    importLowCt: importLow !== null ? importLow * 100 : null,
    importHighCt: importHigh !== null ? importHigh * 100 : null,
    source: 'eos',
    reason: typeof tv.reason === 'string' && tv.reason ? tv.reason : null,
  };
}
