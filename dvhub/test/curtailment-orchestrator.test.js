// test/curtailment-orchestrator.test.js -- T-CURTAIL Increment 2b pure helpers.
// No DB/network: the orchestrator's data-shaping + curtailment math is tested in
// isolation with in-memory rows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hourKey, slotKey, berlinDate, buildGhiByHour, buildGhiIndex, resolveGhi,
  buildDirtyDays, buildActualByTs,
  buildSamples, computeCurtailment, calibrationInputsHash,
} from '../services/curtailment/index.js';
import { binKeyFor } from '../services/curtailment/calibration.js';

const LAT = 48.13, LON = 9.43;

test('hourKey: truncates ms to the start of the UTC hour', () => {
  const t = Date.parse('2025-06-21T13:47:30Z');
  assert.equal(hourKey(t), Date.parse('2025-06-21T13:00:00Z'));
});

test('berlinDate: rolls into local day across the UTC midnight (CEST = UTC+2)', () => {
  // 2025-06-14T23:30Z = 2025-06-15T01:30 Berlin
  assert.equal(berlinDate(Date.parse('2025-06-14T23:30:00Z')), '2025-06-15');
  assert.equal(berlinDate(Date.parse('2025-06-14T10:00:00Z')), '2025-06-14');
});

test('buildGhiByHour: prefers loxone_measured over open_meteo_archive for the same hour', () => {
  const rows = [
    { ts_utc: '2025-06-21T13:00:00Z', ghi_wm2: 800, temperature_c: 24, source: 'open_meteo_archive' },
    { ts_utc: '2025-06-21T13:00:00Z', ghi_wm2: 850, temperature_c: 25, source: 'loxone_measured' },
  ];
  const m = buildGhiByHour(rows);
  const g = m.get(hourKey(Date.parse('2025-06-21T13:00:00Z')));
  assert.equal(g.ghi, 850);
  assert.equal(g.source, 'loxone_measured');
});

test('slotKey: truncates ms to the start of the 15-min slot', () => {
  assert.equal(slotKey(Date.parse('2025-06-21T13:47:30Z')), Date.parse('2025-06-21T13:45:00Z'));
  assert.equal(slotKey(Date.parse('2025-06-21T13:14:59Z')), Date.parse('2025-06-21T13:00:00Z'));
});

test('buildGhiIndex + resolveGhi: a 15-min measured value wins for its slot; hourly fills the rest', () => {
  const rows = [
    // hourly archive at 13:00 covers the whole hour
    { ts_utc: '2025-06-21T13:00:00Z', ghi_wm2: 800, temperature_c: 24, source: 'open_meteo_archive', resolution_seconds: 3600 },
    // one fine measured slot at 13:15
    { ts_utc: '2025-06-21T13:15:00Z', ghi_wm2: 905, temperature_c: 26, source: 'loxone_measured', resolution_seconds: 900 },
  ];
  const idx = buildGhiIndex(rows);
  // 13:15 slot -> the per-slot measurement
  const at1315 = resolveGhi(idx, Date.parse('2025-06-21T13:15:10Z'));
  assert.equal(at1315.ghi, 905);
  assert.equal(at1315.source, 'loxone_measured');
  // 13:30 slot has no fine measurement -> falls back to the hourly archive
  const at1330 = resolveGhi(idx, Date.parse('2025-06-21T13:30:00Z'));
  assert.equal(at1330.ghi, 800);
  assert.equal(at1330.source, 'open_meteo_archive');
});

test('buildGhiIndex: hourly-resolution measured rows do NOT enter the slot map', () => {
  const rows = [
    { ts_utc: '2025-06-21T13:00:00Z', ghi_wm2: 850, temperature_c: 25, source: 'loxone_measured', resolution_seconds: 3600 },
  ];
  const idx = buildGhiIndex(rows);
  assert.equal(idx.bySlot.size, 0);                 // hourly measured -> hour map only
  assert.equal(resolveGhi(idx, Date.parse('2025-06-21T13:00:00Z')).ghi, 850);
});

test('resolveGhi: back-compat with a plain hourly Map', () => {
  const m = new Map([[hourKey(Date.parse('2025-06-21T13:00:00Z')), { ghi: 777, temp: 20, source: 'x' }]]);
  assert.equal(resolveGhi(m, Date.parse('2025-06-21T13:42:00Z')).ghi, 777);
});

test('buildDirtyDays: any negative-price slot marks the whole local day dirty', () => {
  const rows = [
    { ts_utc: '2025-06-14T11:00:00Z', value_num: 5 },
    { ts_utc: '2025-06-14T12:00:00Z', value_num: -1.2 },
    { ts_utc: '2025-06-15T12:00:00Z', value_num: 3 },
  ];
  const dirty = buildDirtyDays(rows);
  assert.ok(dirty.has('2025-06-14'));
  assert.ok(!dirty.has('2025-06-15'));
});

test('buildActualByTs: dedups by slot, keeping the first (local_live before vrm_import)', () => {
  const rows = [
    { slot_start_utc: '2025-06-21T11:00:00Z', value_num: 5.0 }, // local_live (arrives first)
    { slot_start_utc: '2025-06-21T11:00:00Z', value_num: 9.9 }, // vrm_import (ignored)
  ];
  const m = buildActualByTs(rows);
  assert.equal(m.get(Date.parse('2025-06-21T11:00:00Z')), 5.0);
});

test('buildSamples: clean-day daytime slots only; dirty days + night excluded', () => {
  const ts = (s) => Date.parse(s);
  const actualByTs = new Map([
    [ts('2025-06-21T11:00:00Z'), 6],   // clean noon -> kept
    [ts('2025-06-20T11:00:00Z'), 6],   // dirty day -> dropped
    [ts('2025-06-21T00:00:00Z'), 0],   // night -> dropped (elev < 0)
  ]);
  const ghiByHour = new Map([
    [hourKey(ts('2025-06-21T11:00:00Z')), { ghi: 850, temp: 25, source: 'x' }],
    [hourKey(ts('2025-06-20T11:00:00Z')), { ghi: 800, temp: 25, source: 'x' }],
    [hourKey(ts('2025-06-21T00:00:00Z')), { ghi: 0, temp: 12, source: 'x' }],
  ]);
  const dirtyDays = new Set(['2025-06-20']);
  const samples = buildSamples({ actualByTs, ghiByHour, dirtyDays, kWp: 29.7, lat: LAT, lon: LON });
  assert.equal(samples.length, 1);
  assert.equal(samples[0].ghi, 850);
  assert.equal(samples[0].actualW, 6 * 4000);
  assert.equal(samples[0].month, 6);
});

test('computeCurtailment: only neg-price slots; curtailed = max(0, wouldHave - actual)', () => {
  const ts = (s) => Date.parse(s);
  // One trusted bin: slope so wouldHave at GHI 800 = slope*800*kWp/4000 kWh.
  // Pick slope=0.8, kWp=10 -> wouldHaveW = 0.8*800*10 = 6400 W -> 1.6 kWh/slot.
  // Noon at 48.13°N on the solstice sits at ~65° elevation -> band 5.
  const bins = new Map([
    [binKeyFor('total', 6, 5), { arrayId: 'total', month: 6, elevBand: 5, slope: 0.8, n: 50, trusted: true }],
  ]);
  const noonTs = ts('2025-06-21T11:00:00Z');
  const priceRows = [
    { ts_utc: '2025-06-21T11:00:00Z', value_num: -2 }, // negative -> curtailed slot
    { ts_utc: '2025-06-21T11:15:00Z', value_num: 5 },  // positive -> ignored
  ];
  const ghiByHour = new Map([[hourKey(noonTs), { ghi: 800, temp: null, source: 'x' }]]);
  const actualByTs = new Map([[noonTs, 0.5]]); // throttled: actual 0.5 kWh
  const r = computeCurtailment({ priceRows, actualByTs, ghiByHour, bins, pAcRated: 50000, kWp: 10, lat: LAT, lon: LON });
  assert.equal(r.negSlots, 1);
  assert.equal(r.computedSlots, 1);
  // wouldHave 1.6 kWh - actual 0.5 = 1.1 curtailed
  assert.ok(Math.abs(r.curtailedKwh - 1.1) < 0.05, `curtailed ${r.curtailedKwh}`);
});

test('computeCurtailment: untrusted bin falls back to the array-global slope', () => {
  const ts = (s) => Date.parse(s);
  const bins = new Map([
    // trusted bin in a DIFFERENT band (4) provides the global fallback slope;
    // the noon slot lands in band 5 which has no trusted bin -> fallback.
    [binKeyFor('total', 6, 4), { arrayId: 'total', month: 6, elevBand: 4, slope: 0.8, n: 100, trusted: true }],
  ]);
  const noonTs = ts('2025-06-21T11:00:00Z'); // band 5, no trusted bin -> fallback
  const priceRows = [{ ts_utc: '2025-06-21T11:00:00Z', value_num: -1 }];
  const ghiByHour = new Map([[hourKey(noonTs), { ghi: 800, temp: null, source: 'x' }]]);
  const actualByTs = new Map([[noonTs, 0]]);
  const r = computeCurtailment({ priceRows, actualByTs, ghiByHour, bins, pAcRated: 50000, kWp: 10, lat: LAT, lon: LON });
  assert.equal(r.fallbackSlots, 1);
  assert.ok(r.curtailedKwh > 0);
});

test('calibrationInputsHash: deterministic + sensitive to inputs', () => {
  const s1 = [{ ghi: 800, actualW: 6400 }, { ghi: 500, actualW: 4000 }];
  const h1 = calibrationInputsHash({ kWp: 29.7, samples: s1 });
  const h2 = calibrationInputsHash({ kWp: 29.7, samples: s1 });
  assert.equal(h1, h2);
  const h3 = calibrationInputsHash({ kWp: 29.7, samples: [{ ghi: 801, actualW: 6400 }, { ghi: 500, actualW: 4000 }] });
  assert.notEqual(h1, h3);
});
