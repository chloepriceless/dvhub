// test/terminal-value.test.js -- M17: Wert, mit dem EOS die am Planende noch
// gespeicherte Akku-Energie bewertet (ct/kWh).
//
// Der Wert stammt aus EOS' eigenem terminal_value (GeneticSolution): im
// Normalfall der Grenzwert der Terminal-Wert-Kurve (curve.marginal_euro_per_kwh,
// EUR/kWh) an der am Planende gespeicherten Energie; nur im FIXED-Modus ohne
// Kurve die Gutschrift credited_euro/battery_energy_wh. Erwartete Zahlen von Hand
// gerechnet.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { deriveTerminalValue, marginalEurPerKwhAt, MIN_ENERGY_WH } from '../services/optimizer/terminal-value.js';

// Kurve wie aus curves.rs build_terminal_value_curve: aufsteigende Energie-
// Stützstellen, fallende Segment-Grenzwerte (wertvollste Nutzung zuerst).
// energy_wh hat N Punkte, marginal_euro_per_kwh N-1 Segmente.
const curve = {
  energy_wh: [0, 1000, 3000, 6000],
  // Segment [0,1000): 0,30 €/kWh; [1000,3000): 0,27 €/kWh; [3000,6000): 0,10 €/kWh
  marginal_euro_per_kwh: [0.30, 0.27, 0.10],
  value_euro: [0, 300, 840, 1140],
};

describe('marginalEurPerKwhAt', () => {
  it('nimmt den Grenzwert des Segments, in dem die Energie liegt', () => {
    assert.equal(marginalEurPerKwhAt(curve, 0), 0.30);       // genau am Anfang
    assert.equal(marginalEurPerKwhAt(curve, 500), 0.30);     // 1. Segment
    assert.equal(marginalEurPerKwhAt(curve, 1000), 0.27);    // Segmentgrenze → 2. Segment
    assert.equal(marginalEurPerKwhAt(curve, 4500), 0.10);    // 3. Segment (Feldfall: 60 % von 7,5 kWh)
  });
  it('klemmt unter 0 auf das erste und über das Ende auf das letzte Segment', () => {
    assert.equal(marginalEurPerKwhAt(curve, -50), 0.30);
    assert.equal(marginalEurPerKwhAt(curve, 99999), 0.10);
  });
  it('ist null ohne brauchbare Kurve', () => {
    assert.equal(marginalEurPerKwhAt(null, 100), null);
    assert.equal(marginalEurPerKwhAt({ energy_wh: [0, 1], marginal_euro_per_kwh: [] }, 0), null);
    assert.equal(marginalEurPerKwhAt({}, 0), null);
  });
});

describe('deriveTerminalValue', () => {
  it('TAIL/AUTO: ct/kWh = Kurven-Grenzwert an der Planende-Energie × 100', () => {
    const tv = {
      mode: 'TAIL',
      battery_energy_wh: 4500,     // 60 % eines 7,5-kWh-Akkus
      credited_euro: 1.2,
      continuation_value_euro: 0.14,
      tail_operating_euro: 1.06,
      curve,
      tail_diagnostics: { min_import_price_euro_per_kwh: 0.25, max_import_price_euro_per_kwh: 0.305 },
    };
    const r = deriveTerminalValue(tv);
    assert.equal(r.available, true);
    assert.equal(r.basis, 'curve');
    assert.equal(r.mode, 'TAIL');
    assert.ok(Math.abs(r.ctPerKwh - 10.0) < 1e-9); // 0,10 €/kWh → 10,0 ct/kWh
    assert.equal(r.heldCharge, true);
    assert.equal(r.batteryEnergyWh, 4500);
    assert.ok(Math.abs(r.importLowCt - 25.0) < 1e-9);
    assert.ok(Math.abs(r.importHighCt - 30.5) < 1e-9);
    assert.equal(r.source, 'eos');
  });

  it('nutzt die Kurve auch bei ~leerem Akku (credited/Energie würde explodieren)', () => {
    // Parity-Fixtures: battery_energy_wh ≈ 0 bei credited ≈ 1,22 € → Division
    // unbrauchbar. Die Kurve liefert trotzdem einen sinnvollen Grenzwert.
    const tv = { mode: 'TAIL', battery_energy_wh: 0.1, credited_euro: 1.2173, curve };
    const r = deriveTerminalValue(tv);
    assert.equal(r.basis, 'curve');
    assert.ok(Math.abs(r.ctPerKwh - 30.0) < 1e-9); // Grenzwert am Anfang: 0,30 €/kWh
    assert.equal(r.heldCharge, false);             // unter MIN_ENERGY_WH
  });

  it('FIXED ohne Kurve: ct/kWh = Gutschrift je kWh (credited/Energie × 100000)', () => {
    const tv = { mode: 'FIXED', battery_energy_wh: 5000, credited_euro: 1.345, reason: 'terminal_value_mode is FIXED' };
    const r = deriveTerminalValue(tv);
    assert.equal(r.basis, 'credit');
    // 1,345 € / 5000 Wh = 0,000269 €/Wh → 26,9 ct/kWh
    assert.ok(Math.abs(r.ctPerKwh - 26.9) < 1e-9);
    assert.equal(r.mode, 'FIXED');
    assert.equal(r.reason, 'terminal_value_mode is FIXED');
  });

  it('FIXED mit zu wenig Energie und ohne Kurve → kein Wert (Guard)', () => {
    const tv = { mode: 'FIXED', battery_energy_wh: MIN_ENERGY_WH - 1, credited_euro: 0.5 };
    const r = deriveTerminalValue(tv);
    assert.equal(r.available, false);
    assert.equal(r.ctPerKwh, null);
  });

  it('kein terminal_value / kein Akku → available:false', () => {
    assert.equal(deriveTerminalValue(null).available, false);
    assert.equal(deriveTerminalValue(undefined).available, false);
    const noBat = deriveTerminalValue({ mode: 'FIXED', reason: 'no battery in this optimization' });
    assert.equal(noBat.available, false);
    assert.equal(noBat.mode, 'FIXED');
  });
});
