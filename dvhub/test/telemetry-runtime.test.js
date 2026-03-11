import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildHistoricalPriceTelemetrySamples,
  buildLiveTelemetrySamples,
  buildOptimizerRunPayload,
  buildPriceTelemetrySamples,
  resolveTelemetryDbPath
} from '../telemetry-runtime.js';

test('resolveTelemetryDbPath prefers explicit config path over default data dir layout', () => {
  const explicit = resolveTelemetryDbPath({
    configPath: '/etc/dvhub/config.json',
    telemetryConfig: { dbPath: '/srv/dvhub/custom.sqlite' },
    dataDir: '/var/lib/dvhub'
  });
  const fallback = resolveTelemetryDbPath({
    configPath: '/etc/dvhub/config.json',
    telemetryConfig: { dbPath: '' },
    dataDir: '/var/lib/dvhub'
  });

  assert.equal(explicit, '/srv/dvhub/custom.sqlite');
  assert.equal(fallback, '/var/lib/dvhub/telemetry.sqlite');
});

test('buildLiveTelemetrySamples maps meter and victron state to named series', () => {
  const rows = buildLiveTelemetrySamples({
    ts: '2026-03-09T12:00:00.000Z',
    resolutionSeconds: 2,
    meter: {
      grid_l1_w: 100,
      grid_l2_w: 200,
      grid_l3_w: 300,
      grid_total_w: 600
    },
    victron: {
      soc: 64.2,
      batteryPowerW: -500,
      pvPowerW: 1200,
      acPvL1W: 100,
      acPvL2W: 200,
      acPvL3W: 300,
      pvTotalW: 1800,
      gridImportW: 0,
      gridExportW: 600,
      selfConsumptionW: 900,
      batteryChargeW: 0,
      batteryDischargeW: 500,
      solarDirectUseW: 700,
      solarToBatteryW: 300,
      solarToGridW: 400,
      gridDirectUseW: 200,
      gridToBatteryW: 100,
      batteryDirectUseW: 150,
      batteryToGridW: 50,
      gridSetpointW: -40,
      minSocPct: 20
    }
  });

  const map = new Map(rows.map((row) => [row.seriesKey, row.value]));
  assert.equal(map.get('grid_total_w'), 600);
  assert.equal(map.get('pv_total_w'), 1800);
  assert.equal(map.get('battery_discharge_w'), 500);
  assert.equal(map.get('battery_soc_pct'), 64.2);
  assert.equal(map.get('solar_direct_use_w'), 700);
  assert.equal(map.get('grid_to_battery_w'), 100);
  assert.equal(map.get('battery_to_grid_w'), 50);
});

test('buildPriceTelemetrySamples expands EPEX rows into storable series', () => {
  const rows = buildPriceTelemetrySamples([
    { ts: Date.UTC(2026, 2, 9, 12, 0, 0), eur_mwh: 50, ct_kwh: 5 }
  ], {
    source: 'price_api'
  });

  assert.equal(rows.length, 2);
  assert.equal(rows[0].seriesKey, 'price_eur_mwh');
  assert.equal(rows[1].seriesKey, 'price_ct_kwh');
});

test('buildHistoricalPriceTelemetrySamples creates history-scoped backfill rows', () => {
  const rows = buildHistoricalPriceTelemetrySamples([
    { ts: Date.UTC(2026, 0, 2, 12, 0, 0), eur_mwh: 44, ct_kwh: 4.4 }
  ]);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].scope, 'history');
  assert.equal(rows[0].source, 'price_backfill');
  assert.equal(rows[0].quality, 'backfilled');
  assert.equal(rows[0].resolutionSeconds, 900);
});

test('buildOptimizerRunPayload stores scalar optimizer outputs as output series', () => {
  const payload = buildOptimizerRunPayload({
    optimizer: 'emhass',
    body: {
      gridSetpointW: -50,
      chargeCurrentA: 30
    },
    source: 'emhass_apply'
  });

  assert.equal(payload.optimizer, 'emhass');
  assert.equal(payload.status, 'applied');
  assert.equal(payload.series.length, 2);
  assert.deepEqual(
    payload.series.map((entry) => entry.seriesKey).sort(),
    ['charge_current_a', 'grid_setpoint_w']
  );
});
