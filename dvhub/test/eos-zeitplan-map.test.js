import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyEosSlotAction } from '../eos-zeitplan-map.js';

// DVhub fork (2026-06-01) — EOS slot → Zeitplan lever (display-only).

test('co-export: feed-in well above PV with discharge allowed → dcExportMode + battery share', () => {
  // 12:00 prod sample: PV ~9 kW, feed-in 28.4 kW → battery share ~19.4 kW (clamped to 16 kW)
  const r = classifyEosSlotAction({
    pvW: 9000, feedinW: 28436, dischargeAllowed: true, socPct: 52
  });
  assert.equal(r.action, 'co_export');
  assert.equal(r.target, 'dcExportMode');
  assert.equal(r.batteryExportW, 16000); // clamped to akku AC limit
  // export = pv 9000 + share 16000 - buffer 100 = 24900, within 29 kW conn cap
  assert.equal(r.gridSetpointW, -24900);
});

test('co-export trims battery share to stay within the 29 kW connection cap', () => {
  const r = classifyEosSlotAction({
    pvW: 20000, feedinW: 34000, dischargeAllowed: true, bufferW: 0
  });
  assert.equal(r.action, 'co_export');
  // raw share 14000; pv 20000 + 14000 = 34000 > 29000 → trim share to 9000
  assert.equal(r.batteryExportW, 9000);
  assert.equal(r.gridSetpointW, -29000);
});

test('evening no-PV sell → battery-only export via gridSetpointW (NOT dcExportMode)', () => {
  // 21:00: PV gone, EOS still feeds 4 kWh-equiv from the battery to grid.
  const r = classifyEosSlotAction({ pvW: 0, feedinW: 4000, dischargeAllowed: true, socPct: 40 });
  assert.equal(r.action, 'battery_export');
  assert.equal(r.label, 'Akku einspeisen');
  assert.equal(r.target, 'gridSetpointW'); // dcExportMode would do nothing at pvW≈0
  assert.equal(r.gridSetpointW, -4000);
  assert.equal(r.batteryExportW, 4000);
});

test('battery-only export is clamped to the 16 kW AC battery cap', () => {
  const r = classifyEosSlotAction({ pvW: 0, feedinW: 25000, dischargeAllowed: true });
  assert.equal(r.action, 'battery_export');
  assert.equal(r.batteryExportW, 16000);
  assert.equal(r.gridSetpointW, -16000);
});

test('pv-export: feed-in ≈ PV (battery net ~0) → dcExportMode, no battery share', () => {
  const r = classifyEosSlotAction({ pvW: 6000, feedinW: 6050, dischargeAllowed: true, bufferW: 100 });
  assert.equal(r.action, 'pv_export');
  assert.equal(r.target, 'dcExportMode');
  assert.equal(r.batteryExportW, 0);
  assert.equal(r.gridSetpointW, -5900); // -(6000 - 100)
});

test('charge: dc_charge factor set, no feed-in → Halten (no active charge lever)', () => {
  const r = classifyEosSlotAction({ pvW: 4000, feedinW: 0, dcChargeFactor: 1, socPct: 30 });
  assert.equal(r.action, 'charge');
  assert.equal(r.target, 'gridSetpointW');
  assert.equal(r.gridSetpointW, -40);
  assert.equal(r.batteryExportW, 0);
});

// T-0118 (2026-06-06): the dc_charge gene is left ON in almost every slot so the
// pack fills AS SOON AS PV appears. At NIGHT (pvW≈0) it charges nothing, so the
// slot must NOT be labelled "Akku lädt (PV)" — it falls through to grid-draw/hold.
test('charge label requires real PV: dc_charge gene at night (pvW=0) is NOT "charge"', () => {
  const idle = classifyEosSlotAction({ pvW: 0, feedinW: 0, importW: 0, dcChargeFactor: 1, socPct: 30 });
  assert.notEqual(idle.action, 'charge', 'no PV at night → never "Akku lädt (PV)"');
  assert.equal(idle.action, 'hold');

  const drawing = classifyEosSlotAction({ pvW: 0, feedinW: 0, importW: 800, dcChargeFactor: 1, socPct: 8 });
  assert.notEqual(drawing.action, 'charge');
  assert.equal(drawing.action, 'grid_draw', 'night load coverage with dc-gene on reads as Netzbezug, not charge');
});

test('grid draw: importing to cover load, no export/charge → Halten', () => {
  const r = classifyEosSlotAction({ pvW: 0, feedinW: 0, importW: 800, socPct: 10 });
  assert.equal(r.action, 'grid_draw');
  assert.equal(r.gridSetpointW, -40);
});

test('hold: nothing flowing → Halten', () => {
  const r = classifyEosSlotAction({ pvW: 0, feedinW: 0, importW: 0 });
  assert.equal(r.action, 'hold');
  assert.equal(r.target, 'gridSetpointW');
  assert.equal(r.gridSetpointW, -40);
});

test('co-export respects the SoC floor → drops to PV-only export', () => {
  const r = classifyEosSlotAction({
    pvW: 5000, feedinW: 18000, dischargeAllowed: true, socPct: 5, stopSocPct: 5, bufferW: 100
  });
  // at floor → battery share dropped, PV-only
  assert.equal(r.batteryExportW, 0);
  assert.equal(r.gridSetpointW, -4900);
});

test('discharge_allowed but no actual feed-in → not co-export (hold)', () => {
  const r = classifyEosSlotAction({ pvW: 0, feedinW: 0, dischargeAllowed: true });
  assert.equal(r.action, 'hold');
});

test('small feed-in below noise threshold is ignored', () => {
  const r = classifyEosSlotAction({ pvW: 0, feedinW: 100, dischargeAllowed: true });
  assert.equal(r.action, 'hold');
});

test('never emits a positive (grid-charge) setpoint', () => {
  for (const f of [0, 100, 6000, 28000, 40000]) {
    for (const pv of [0, 5000, 20000, 31000]) {
      const r = classifyEosSlotAction({ pvW: pv, feedinW: f, dischargeAllowed: true, importW: 500 });
      assert.ok(r.gridSetpointW <= 0, `gridSetpointW ${r.gridSetpointW} must be <= 0 (pv=${pv}, feedin=${f})`);
    }
  }
});
