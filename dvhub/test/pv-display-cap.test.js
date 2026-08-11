import test from 'node:test';
import assert from 'node:assert/strict';
import { capVictronPvForDisplay } from '../runtime-state.js';

test('capVictronPvForDisplay: caps pv fields over the cap, leaves below-cap + non-pv untouched', () => {
  const v = { pvPowerW: 12000, pvAcW: 5000, pvTotalW: 17000, batteryPowerW: -3000, soc: 55 };
  capVictronPvForDisplay(v, 10000); // 10 kWp
  assert.equal(v.pvPowerW, 10000, 'DC capped');
  assert.equal(v.pvAcW, 5000, 'AC below cap unchanged');
  assert.equal(v.pvTotalW, 10000, 'total capped');
  assert.equal(v.batteryPowerW, -3000, 'non-pv untouched');
  assert.equal(v.soc, 55);
});

test('capVictronPvForDisplay: caps dcExportMode pv fields too', () => {
  const v = { pvTotalW: 20000, dcExportMode: { pvTotalW: 20000, pvDcW: 15000, other: 1 } };
  capVictronPvForDisplay(v, 10000);
  assert.equal(v.pvTotalW, 10000);
  assert.equal(v.dcExportMode.pvTotalW, 10000);
  assert.equal(v.dcExportMode.pvDcW, 10000);
  assert.equal(v.dcExportMode.other, 1);
});

test('capVictronPvForDisplay: capW null → no-op (Community/Pro L/Legacy)', () => {
  const v = { pvTotalW: 20000, pvPowerW: 18000 };
  capVictronPvForDisplay(v, null);
  assert.equal(v.pvTotalW, 20000);
  assert.equal(v.pvPowerW, 18000);
});

test('capVictronPvForDisplay: tolerant of missing fields / bad input', () => {
  assert.doesNotThrow(() => capVictronPvForDisplay(null, 10000));
  assert.doesNotThrow(() => capVictronPvForDisplay(undefined, 10000));
  const v = { soc: 50 };
  capVictronPvForDisplay(v, 10000);
  assert.deepEqual(v, { soc: 50 }, 'no pv fields → unchanged');
});
