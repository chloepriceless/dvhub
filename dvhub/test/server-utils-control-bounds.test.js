import test from 'node:test';
import assert from 'node:assert/strict';

import {
  controlWriteBoundsError,
  clampMinSoc,
  MAX_GRID_SETPOINT_W,
  MAX_MINSOC_PCT,
  MAX_BATTERY_DISCHARGE_W,
  MAX_CHARGE_CURRENT_A,
} from '../server-utils.js';

// T-0080: shared write-layer sanity bounds. These pure helpers are the single
// source of truth for both /api/control/write and the applyControlTarget
// chokepoint (so EOS/EMHASS/evcc are bounded too).

test('controlWriteBoundsError: non-finite is always rejected', () => {
  assert.deepEqual(controlWriteBoundsError('gridSetpointW', NaN), { error: 'value_not_finite' });
  assert.deepEqual(controlWriteBoundsError('minSocPct', Infinity), { error: 'value_not_finite' });
});

test('controlWriteBoundsError: gridSetpointW abs ceiling', () => {
  assert.equal(controlWriteBoundsError('gridSetpointW', -100), null);
  assert.equal(controlWriteBoundsError('gridSetpointW', MAX_GRID_SETPOINT_W), null);
  assert.deepEqual(controlWriteBoundsError('gridSetpointW', MAX_GRID_SETPOINT_W + 1), { error: 'value_out_of_range', max: MAX_GRID_SETPOINT_W });
  assert.deepEqual(controlWriteBoundsError('gridSetpointW', -200000), { error: 'value_out_of_range', max: MAX_GRID_SETPOINT_W });
});

test('controlWriteBoundsError: chargeCurrentA abs ceiling', () => {
  assert.equal(controlWriteBoundsError('chargeCurrentA', -50), null);
  assert.equal(controlWriteBoundsError('chargeCurrentA', MAX_CHARGE_CURRENT_A), null);
  assert.deepEqual(controlWriteBoundsError('chargeCurrentA', 5000), { error: 'charge_current_out_of_range', max: MAX_CHARGE_CURRENT_A });
});

test('controlWriteBoundsError: maxDischargeW with -1 sentinel', () => {
  assert.equal(controlWriteBoundsError('maxDischargeW', -1), null, '-1 = unlimited sentinel');
  assert.equal(controlWriteBoundsError('maxDischargeW', 0), null, '0 = hold');
  assert.equal(controlWriteBoundsError('maxDischargeW', 16000), null);
  assert.deepEqual(controlWriteBoundsError('maxDischargeW', 50000), { error: 'max_discharge_out_of_range', max: MAX_BATTERY_DISCHARGE_W });
  assert.deepEqual(controlWriteBoundsError('maxDischargeW', -5), { error: 'max_discharge_out_of_range', max: MAX_BATTERY_DISCHARGE_W }, 'negative non-sentinel rejected');
});

test('controlWriteBoundsError: feedExcessDcPv is a 0/1 flag', () => {
  assert.equal(controlWriteBoundsError('feedExcessDcPv', 0), null);
  assert.equal(controlWriteBoundsError('feedExcessDcPv', 1), null);
  assert.deepEqual(controlWriteBoundsError('feedExcessDcPv', 2), { error: 'feed_excess_flag_must_be_0_or_1' });
});

test('controlWriteBoundsError: minSocPct + unknown targets are not handled here (null)', () => {
  // minSocPct is clamped by the chokepoint / range-rejected by the route, not here.
  assert.equal(controlWriteBoundsError('minSocPct', 50), null);
  assert.equal(controlWriteBoundsError('minSocPct', 999), null);
  assert.equal(controlWriteBoundsError('someOtherTarget', 1e9), null);
});

test('clampMinSoc: raises below-floor to the hard floor', () => {
  assert.deepEqual(clampMinSoc(2, 5), { value: 5, clamped: true });
  assert.deepEqual(clampMinSoc(0, 5), { value: 5, clamped: true });
});

test('clampMinSoc: passes in-range values through', () => {
  assert.deepEqual(clampMinSoc(50, 5), { value: 50, clamped: false });
  assert.deepEqual(clampMinSoc(5, 5), { value: 5, clamped: false });
});

test('clampMinSoc: caps above 100 and handles bad input fail-safe', () => {
  assert.deepEqual(clampMinSoc(150, 5), { value: MAX_MINSOC_PCT, clamped: true });
  assert.deepEqual(clampMinSoc(NaN, 5), { value: 5, clamped: true });
  assert.deepEqual(clampMinSoc(-10, 5), { value: 5, clamped: true });
  assert.deepEqual(clampMinSoc(3, 0), { value: 3, clamped: false }, 'floor 0 leaves 3 untouched');
});
