// test/control-snapshot.test.js -- gemeinsame Sicht auf die aktiven
// Steuerbefehle (2026-09-14, Christin: "Steuerbefehle des EOS transparent
// über MQTT/Loxone weitergeben").
//
// buildControlSnapshot(state) liefert je Steuerziel den zuletzt gewollten
// Wert (state.schedule.active), sonst die Rücklesung (state.victron), plus
// Quelle/Regel/Zeitstempel. controlSnapshotFlat() macht daraus die flachen
// dvhub_control_*-Felder für den Loxone-Text-Endpunkt. feedExcessDcPv ist
// Victron-spezifisch und gehört NICHT ins generische Schema.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildControlSnapshot, controlSnapshotFlat, CONTROL_KEYS } from '../services/control-snapshot.js';

const T0 = 1_789_000_000_000;

function makeState() {
  return {
    ctrl: { discretionaryWritesPaused: false, forcedOff: false },
    victron: { gridSetpointW: -100, minSocPct: 20, maxDischargeW: -1, chargeCurrentA: null },
    schedule: {
      rules: [{ id: 'abend-entladen', target: 'gridSetpointW', value: -3000 }],
      active: {
        gridSetpointW: { value: -3000, source: 'rule:abend-entladen', at: T0 + 5000 },
        chargeCurrentA: { value: 50, source: 'default', at: T0 + 1000, skipped: true, reason: 'unchanged' },
        feedExcessDcPv: { value: 1, source: 'runtime', at: T0 + 9000 }
      },
      lastWrite: {}
    }
  };
}

describe('buildControlSnapshot', () => {
  it('kennt genau die vier generischen Steuerziele, ohne feedExcessDcPv', () => {
    assert.deepEqual([...CONTROL_KEYS].sort(), ['chargeCurrentA', 'gridSetpointW', 'maxDischargeW', 'minSocPct']);
  });

  it('nimmt den aktiven Sollwert vor der Rücklesung und nennt Herkunft + Regel', () => {
    const s = buildControlSnapshot(makeState(), T0 + 10_000);
    assert.equal(s.values.gridSetpointW.value, -3000, 'aktiver Sollwert gewinnt gegen Rücklesung -100');
    assert.equal(s.values.gridSetpointW.origin, 'active');
    assert.equal(s.values.gridSetpointW.source, 'rule:abend-entladen', 'Rohquelle bleibt im Detail erhalten');
    assert.equal(s.values.chargeCurrentA.value, 50, 'gehaltener (skipped) Wert zählt als aktiv');
    assert.equal(s.values.minSocPct.value, 20, 'ohne aktiven Sollwert: Rücklesung');
    assert.equal(s.values.minSocPct.origin, 'readback');
    assert.equal(s.values.maxDischargeW.value, -1);
    assert.equal('feedExcessDcPv' in s.values, false, 'Victron-spezifisch, nicht im Schema');
    assert.equal(s.source, 'rule', 'manuelle Zeitplan-Regel → Herkunft "rule"');
    assert.equal(s.rule, 'abend-entladen');
    assert.equal(s.updatedAtMs, T0 + 5000, 'jüngster at der generischen Ziele (feedExcess zählt nicht)');
    assert.equal(s.updatedAt, new Date(T0 + 5000).toISOString());
    assert.equal(s.paused, false);
  });

  it('leerer Zustand → null-Werte, source none, kein Zeitstempel', () => {
    const s = buildControlSnapshot({ victron: {}, schedule: { active: {} } });
    for (const k of CONTROL_KEYS) {
      assert.equal(s.values[k].value, null);
      assert.equal(s.values[k].origin, null);
    }
    assert.equal(s.source, 'none');
    assert.equal(s.rule, null);
    assert.equal(s.updatedAt, null);
  });

  it('Herkunft: EOS-Regel → eos, interner Optimizer → optimizer, Kleinmarkt → market_automation, Override → override', () => {
    const st = makeState();
    st.schedule.rules = [
      { id: 'opt-1-0', source: 'forecast_optimizer', optimizer: 'eos' },
      { id: 'opt-2-0', source: 'forecast_optimizer', optimizer: 'internal' },
      { id: 'sma-3-1', source: 'small_market_automation' }
    ];
    st.schedule.active.gridSetpointW = { value: -3000, source: 'rule:opt-1-0', at: T0 };
    assert.equal(buildControlSnapshot(st).source, 'eos');
    assert.equal(buildControlSnapshot(st).rule, 'opt-1-0');
    st.schedule.active.gridSetpointW = { value: -3000, source: 'rule:opt-2-0', at: T0 };
    assert.equal(buildControlSnapshot(st).source, 'optimizer');
    st.schedule.active.gridSetpointW = { value: -3000, source: 'rule:sma-3-1', at: T0 };
    assert.equal(buildControlSnapshot(st).source, 'market_automation');
    st.schedule.active.gridSetpointW = { value: 0, source: 'manual_override', at: T0 };
    assert.equal(buildControlSnapshot(st).source, 'override');
    st.schedule.active.gridSetpointW = { value: 0, source: 'manual_override_persistent', at: T0 };
    assert.equal(buildControlSnapshot(st).source, 'override');
    st.schedule.active.gridSetpointW = { value: -100, source: 'default', at: T0 };
    assert.equal(buildControlSnapshot(st).source, 'default');
    st.schedule.active.gridSetpointW = { value: -100, source: 'rule:unbekannt-99', at: T0 };
    assert.equal(buildControlSnapshot(st).source, 'rule', 'Regel nicht mehr in der Liste → rule');
    assert.equal(buildControlSnapshot(st).rule, 'unbekannt-99');
  });

  it('meldet paused/forcedOff aus state.ctrl', () => {
    const st = makeState();
    st.ctrl.discretionaryWritesPaused = true;
    st.ctrl.forcedOff = true;
    const s = buildControlSnapshot(st);
    assert.equal(s.paused, true);
    assert.equal(s.forcedOff, true);
  });
});

describe('controlSnapshotFlat', () => {
  it('liefert flache dvhub_control_*-Felder für Loxone', () => {
    const flat = controlSnapshotFlat(buildControlSnapshot(makeState(), T0 + 10_000));
    assert.deepEqual(flat, {
      dvhub_control_grid_setpoint_w: -3000,
      dvhub_control_charge_current_a: 50,
      dvhub_control_min_soc_pct: 20,
      dvhub_control_max_discharge_w: -1,
      dvhub_control_source: 'rule',
      dvhub_control_rule: 'abend-entladen',
      dvhub_control_updated_at: new Date(T0 + 5000).toISOString(),
      dvhub_control_paused: false
    });
  });
});
