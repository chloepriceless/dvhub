// test/sqlite/history-second-battery-vrm.test.js -- VRM-Import und lokale
// Akku-2-Fluesse nicht mischen (Codex-Gegenpruefung 21.10.2026, P2).
// Lokal: 0,5 kWh Einspeisung = 0,3 aus Akku 1 + 0,2 aus Akku 2. Der VRM-Import
// kennt die zweite Anlage nicht und verteilt dieselben 0,5 kWh ganz auf die
// Hauptanlage. Nach dem Backfill bevorzugt der Slot VRM — die lokalen Akku-2-
// Werte duerfen dann nicht noch dazukommen (sonst 0,14 € statt 0,10 €).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTelemetryStore } from '../../telemetry-store.js';
import { createHistoryRuntime } from '../../history-runtime.js';

const TS = '2026-03-09T18:00:00.000Z';
const w = (kwh) => kwh * 4000; // 15 min: 1 kWh = 4000 W
const sample = (seriesKey, kwh, scope, source) => ({
  seriesKey, ts: TS, value: w(kwh), scope, source, quality: scope === 'live' ? 'raw' : 'backfilled',
  resolutionSeconds: 900, unit: 'W'
});

function storeWithBackfill(withVrm) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-second-vrm-'));
  const store = createTelemetryStore({ dbPath: path.join(dir, 'telemetry.sqlite'), rawRetentionDays: 30, rollupIntervals: [900] });
  const rows = [
    sample('grid_export_w', 0.5, 'live', 'local_poll'),
    sample('battery_discharge_w', 0.3, 'live', 'local_poll'),
    sample('battery_to_grid_w', 0.3, 'live', 'local_poll'),
    sample('second_battery_discharge_w', 0.2, 'live', 'local_poll'),
    sample('second_battery_to_grid_w', 0.2, 'live', 'local_poll'),
    { seriesKey: 'price_ct_kwh', ts: TS, value: 20, scope: 'history', source: 'price_backfill', quality: 'backfilled', resolutionSeconds: 900, unit: 'ct/kWh' }
  ];
  if (withVrm) {
    rows.push(
      sample('grid_export_w', 0.5, 'history', 'vrm_import'),
      sample('battery_discharge_w', 0.5, 'history', 'vrm_import'),
      sample('battery_to_grid_w', 0.5, 'history', 'vrm_import')
    );
  }
  store.writeSamples(rows);
  return store;
}

async function summaryFor(store) {
  const runtime = createHistoryRuntime({ store, getPricingConfig: () => ({}), getCurrentDate: () => '2027-04-02' });
  return runtime.getSummary({ view: 'day', date: '2026-03-09' });
}

const parts = (k) => Math.round((k.exportPvRevenueEur + k.exportBatteryRevenueEur + k.exportSecondBatteryRevenueEur) * 100) / 100;

test('nur lokal: Akku 1 und Akku 2 getrennt, Teile = gemessener Erloes', async () => {
  const store = storeWithBackfill(false);
  try {
    const { kpis } = await summaryFor(store);
    assert.equal(kpis.exportRevenueEur, 0.1);
    assert.equal(kpis.exportBatteryRevenueEur, 0.06);
    assert.equal(kpis.exportSecondBatteryRevenueEur, 0.04);
    assert.equal(parts(kpis), kpis.exportRevenueEur);
  } finally {
    store.close();
  }
});

test('nach VRM-Backfill: VRM-Fluesse ohne lokale Akku-2-Werte, Teile = gemessener Erloes', async () => {
  const store = storeWithBackfill(true);
  try {
    const { kpis } = await summaryFor(store);
    assert.equal(kpis.exportRevenueEur, 0.1);
    assert.equal(kpis.exportBatteryRevenueEur, 0.1);
    assert.equal(kpis.exportSecondBatteryRevenueEur, 0);
    assert.equal(kpis.secondBatteryToGridKwh, 0);
    assert.equal(kpis.secondBatteryDischargeKwh, 0);
    assert.equal(parts(kpis), kpis.exportRevenueEur, 'Erloessumme = gemessener Erloes');
  } finally {
    store.close();
  }
});
