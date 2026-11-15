// T-MPPT-TELEMETRY: Per-MPPT/String-Logging der SunSpec-WR-Familie. Testet die
// Kette state.victron.mppt → Live-Samples → energy_slots_15m (15-min-kWh) →
// pvnode-CSV, plus die Materialisierungs-Regel (nur _w, nicht _v/_a/_wh) und
// die Service-Uebersicht.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildMaterializedEnergySlotWrites } from '../telemetry-store-pg.js';
import { createTelemetryStore } from '../telemetry-store.js';
import { buildLiveTelemetrySamples } from '../telemetry-runtime.js';
import {
  mpptSeriesKey,
  isMpptModule,
  slotKwhToAvgW,
  buildMpptPvnodeCsv,
  createPvStringsService
} from '../services/pv-strings/index.js';

const live = (seriesKey, ts, value, resolutionSeconds) => ({
  seriesKey, scope: 'live', source: 'local_poll', quality: 'raw', ts, value, resolutionSeconds, unit: 'W'
});
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-mppt-')), 'telemetry.sqlite');

// ── Materialisierung: nur die Leistungsreihe _w wird zu kWh-Slots ──────────
describe('MPPT-Reihen verdichten wie pv_total_w', () => {
  test('pv_mppt_<n>_w landet als kWh-Slot in energy_slots_15m', () => {
    const writes = buildMaterializedEnergySlotWrites([live('pv_mppt_1_w', '2026-03-09T12:00:00.000Z', 4000, 900)]);
    const mppt = writes.filter((w) => w.seriesKey === 'pv_mppt_1_w');
    assert.equal(mppt.length, 1);
    assert.equal(mppt[0].unit, 'kWh');
    assert.ok(Math.abs(mppt[0].valueNum - 1) < 1e-9); // 4000 W × 900 s = 1 kWh
  });

  test('pv_mppt_<n>_v/_a/_wh sind Rohreihen — KEINE Slots', () => {
    const writes = buildMaterializedEnergySlotWrites([
      live('pv_mppt_1_v', '2026-03-09T12:00:00.000Z', 400, 900),
      live('pv_mppt_1_a', '2026-03-09T12:00:00.000Z', 5, 900),
      live('pv_mppt_1_wh', '2026-03-09T12:00:00.000Z', 12345, 900)
    ]);
    assert.equal(writes.length, 0);
  });

  test('zweistellige/dreistellige Modulnummern greifen, pv_mppt_0_w nicht', () => {
    assert.equal(buildMaterializedEnergySlotWrites([live('pv_mppt_12_w', '2026-03-09T12:00:00.000Z', 1000, 900)]).length, 1);
    assert.equal(buildMaterializedEnergySlotWrites([live('pv_mppt_0_w', '2026-03-09T12:00:00.000Z', 1000, 900)]).length, 0);
  });
});

// ── Live-Samples aus state.victron.mppt ────────────────────────────────────
describe('buildLiveTelemetrySamples: Per-MPPT-Reihen', () => {
  test('je String eine _w-Reihe; _v/_a/_wh nur bei vorhandenem Wert', () => {
    const rows = buildLiveTelemetrySamples({
      ts: '2026-03-09T12:00:00.000Z',
      resolutionSeconds: 5,
      meter: {},
      victron: {
        pvTotalW: 5300,
        mppt: [
          { n: 1, w: 3500, v: 400, a: 5, wh: 12345 },
          { n: 2, w: 1800, v: null, a: null, wh: null }
        ]
      }
    });
    const byKey = Object.fromEntries(rows.map((r) => [r.seriesKey, r.value]));
    assert.equal(byKey['pv_mppt_1_w'], 3500);
    assert.equal(byKey['pv_mppt_1_v'], 400);
    assert.equal(byKey['pv_mppt_1_a'], 5);
    assert.equal(byKey['pv_mppt_1_wh'], 12345);
    assert.equal(byKey['pv_mppt_2_w'], 1800);
    // Modul 2 ohne V/A/Wh → keine Zeilen (pushSample ueberspringt null).
    assert.ok(!('pv_mppt_2_v' in byKey));
    assert.ok(!('pv_mppt_2_a' in byKey));
  });

  test('ohne victron.mppt entstehen keine MPPT-Zeilen', () => {
    const rows = buildLiveTelemetrySamples({ ts: '2026-03-09T12:00:00.000Z', resolutionSeconds: 5, meter: {}, victron: { pvTotalW: 100 } });
    assert.ok(!rows.some((r) => /^pv_mppt_/.test(r.seriesKey)));
  });
});

// ── pvnode-CSV: kWh/Slot → mittlere Leistung (W) ───────────────────────────
describe('pvnode-Export je MPPT', () => {
  test('slotKwhToAvgW: 1 kWh in 900 s = 4000 W', () => {
    assert.equal(slotKwhToAvgW(1, 900), 4000);
    assert.equal(slotKwhToAvgW(0.25, 900), 1000);
    assert.equal(slotKwhToAvgW(null, 900), 0);
  });

  test('buildMpptPvnodeCsv: Kopfzeile + W je Slot', () => {
    const csv = buildMpptPvnodeCsv([
      { ts: '2026-03-09T11:00:00.000Z', kWh: 1 },
      { ts: '2026-03-09T11:15:00.000Z', kWh: 0.25 }
    ], { timeZone: 'Europe/Berlin' });
    const lines = csv.trim().split('\n');
    assert.equal(lines[0], 'timestamp;pv_power');
    assert.ok(lines[1].endsWith(';4000'));
    assert.ok(lines[2].endsWith(';1000'));
  });

  test('isMpptModule / mpptSeriesKey', () => {
    assert.equal(mpptSeriesKey(3), 'pv_mppt_3_w');
    assert.ok(isMpptModule(1) && isMpptModule(999));
    assert.ok(!isMpptModule(0) && !isMpptModule(1000) && !isMpptModule(1.5));
  });
});

// ── Store-Round-Trip + Service ─────────────────────────────────────────────
describe('readMaterializedSeries + Service (SQLite-Round-Trip)', () => {
  test('geschriebene MPPT-Leistung kommt als kWh-Slot zurueck und als pvnode-CSV', async () => {
    const store = createTelemetryStore({ dbPath: tmpDb() });
    try {
      store.writeSamples([
        live('pv_mppt_1_w', '2026-03-09T12:00:00.000Z', 4000, 900),
        live('pv_mppt_1_w', '2026-03-09T12:15:00.000Z', 2000, 900),
        live('pv_mppt_1_v', '2026-03-09T12:00:00.000Z', 400, 900) // darf NICHT als Slot auftauchen
      ]);
      const slots = store.readMaterializedSeries({
        seriesKeys: ['pv_mppt_1_w'],
        start: '2026-03-09T00:00:00.000Z',
        end: '2026-03-10T00:00:00.000Z',
        sourceKinds: ['local_live']
      });
      assert.equal(slots.length, 2);
      assert.ok(Math.abs(slots[0].kWh - 1) < 1e-9);
      assert.ok(Math.abs(slots[1].kWh - 0.5) < 1e-9);

      const cfg = { schedule: { timezone: 'Europe/Berlin' }, pvStrings: { mppt: { labels: { 1: 'Süd' }, kwp: { 1: 9 } } } };
      // now auf den Tag nach den Testdaten setzen, damit das Overview-Fenster greift.
      const svc = createPvStringsService({ telemetryStore: store, getCfg: () => cfg, now: () => Date.parse('2026-03-10T00:00:00.000Z') });
      const r = await svc.readMpptSeries(1, { start: '2026-03-09T00:00:00.000Z', end: '2026-03-10T00:00:00.000Z' });
      const csv = buildMpptPvnodeCsv(r.rows, { timeZone: 'Europe/Berlin' });
      assert.ok(csv.split('\n')[1].endsWith(';4000'));

      const overview = await svc.mpptOverview([1], { days: 90 });
      assert.equal(overview.length, 1);
      assert.equal(overview[0].n, 1);
      assert.equal(overview[0].label, 'Süd');
      assert.equal(overview[0].kwp, 9);
      assert.equal(overview[0].slots, 2);
      // Tagesertrag 09.03.: 1 kWh + 0,5 kWh = 1,5 kWh.
      const day = overview[0].dailyKwh.find((d) => d.day === '2026-03-09');
      assert.ok(day && Math.abs(day.kwh - 1.5) < 1e-9);
    } finally {
      store.close?.();
    }
  });

  test('mpptOverview zeigt auch einen nur live-aktiven, unbeschrifteten String', async () => {
    const store = createTelemetryStore({ dbPath: tmpDb() });
    try {
      const svc = createPvStringsService({ telemetryStore: store, getCfg: () => ({ pvStrings: { mppt: {} } }) });
      const overview = await svc.mpptOverview([2], { days: 30 });
      assert.equal(overview.length, 1);
      assert.equal(overview[0].n, 2);
      assert.equal(overview[0].label, 'MPPT 2');
      assert.equal(overview[0].slots, 0);
    } finally {
      store.close?.();
    }
  });
});
