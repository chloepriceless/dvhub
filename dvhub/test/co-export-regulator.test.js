import test from 'node:test';
import assert from 'node:assert/strict';

import { computeCoExportSetpointW } from '../co-export-setpoint.js';

// DVhub fork (2026-06-01) — EOS Option B: live PV + battery co-export regulator.
// Pure setpoint math; the runtime (schedule-eval dcExportMode block) feeds it the
// LIVE PV/SoC each tick. Convention: gridSetpointW <= 0 (export), never a grid charge.

test('PV-only when no battery share (legacy dcExportMode behaviour)', () => {
  const r = computeCoExportSetpointW({ pvW: 9000, batteryExportW: 0, bufferW: 100 });
  // -(pvW - buffer)
  assert.equal(r.gridSetpointW, -8900);
  assert.equal(r.batteryShareW, 0);
});

test('battery share rides on top of live PV', () => {
  const r = computeCoExportSetpointW({ pvW: 6000, batteryExportW: 8000, bufferW: 100, akkuAcLimitW: 16000, connectionLimitW: 29000 });
  // 6000 + 8000 - 100 = 13900 export
  assert.equal(r.gridSetpointW, -13900);
  assert.equal(r.batteryShareW, 8000);
  assert.equal(r.reason, 'co_export');
});

test('battery share clamped to the 16 kW AC battery limit', () => {
  const r = computeCoExportSetpointW({ pvW: 2000, batteryExportW: 25000, bufferW: 0, akkuAcLimitW: 16000, connectionLimitW: 29000 });
  // share clamped 25000 -> 16000; export = 2000 + 16000 = 18000
  assert.equal(r.batteryShareW, 16000);
  assert.equal(r.gridSetpointW, -18000);
  assert.equal(r.reason, 'akku_ac_clamp');
});

test('total export clamped to the 29 kW connection limit by trimming battery share first', () => {
  const r = computeCoExportSetpointW({ pvW: 20000, batteryExportW: 16000, bufferW: 0, akkuAcLimitW: 16000, connectionLimitW: 29000 });
  // raw = 20000 + 16000 = 36000 > 29000; trim share by 7000 -> 9000; export = 29000
  assert.equal(r.exportW, 29000);
  assert.equal(r.gridSetpointW, -29000);
  assert.equal(r.batteryShareW, 9000);
  assert.equal(r.reason, 'connection_clamp');
});

test('at/below stopSocPct the battery share is dropped → PV-only', () => {
  const r = computeCoExportSetpointW({ pvW: 5000, batteryExportW: 10000, socPct: 5, stopSocPct: 5, bufferW: 100 });
  assert.equal(r.batteryShareW, 0);
  assert.equal(r.gridSetpointW, -4900); // -(5000 - 100)
  assert.equal(r.reason, 'soc_floor_pv_only');
});

test('above stopSocPct the battery share is allowed', () => {
  const r = computeCoExportSetpointW({ pvW: 0, batteryExportW: 12000, socPct: 40, stopSocPct: 10, bufferW: 0 });
  assert.equal(r.batteryShareW, 12000);
  assert.equal(r.gridSetpointW, -12000);
});

test('never positive (no illegal grid charge) when PV+share below buffer', () => {
  const r = computeCoExportSetpointW({ pvW: 0, batteryExportW: 0, bufferW: 100 });
  assert.equal(r.gridSetpointW, 0); // max(0, 0 - 100) = 0
  assert.ok(r.gridSetpointW <= 0);
});

test('no SoC info → floor skipped, share kept', () => {
  const r = computeCoExportSetpointW({ pvW: 3000, batteryExportW: 5000, socPct: null, stopSocPct: 30, bufferW: 0 });
  assert.equal(r.batteryShareW, 5000);
  assert.equal(r.gridSetpointW, -8000);
});

test('non-finite inputs degrade safely to 0 export', () => {
  const r = computeCoExportSetpointW({ pvW: NaN, batteryExportW: undefined, bufferW: NaN });
  assert.equal(r.gridSetpointW, 0);
  assert.equal(r.batteryShareW, 0);
});

test('PV alone exceeding the connection cap is clamped (rare)', () => {
  const r = computeCoExportSetpointW({ pvW: 31000, batteryExportW: 0, bufferW: 0, connectionLimitW: 29000 });
  assert.equal(r.exportW, 29000);
  assert.equal(r.gridSetpointW, -29000);
  assert.equal(r.reason, 'connection_clamp');
});
