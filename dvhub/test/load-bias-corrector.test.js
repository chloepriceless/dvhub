import test from 'node:test';
import assert from 'node:assert/strict';

import {
  selectNightConfig,
  isNightHour,
  median,
  buildNightQuery,
  aggregateNights,
  computeConsecutiveBias,
  medianByHour,
  blendSlot,
  createLoadBiasCorrector,
} from '../services/forecast/load-bias-corrector.js';

// --- selectNightConfig ---

test('selectNightConfig defaults are ON with operator parameters', () => {
  const c = selectNightConfig({});
  assert.equal(c.enabled, true, 'default ON');
  assert.equal(c.consecutiveNights, 3);
  assert.equal(c.nightStartHour, 22);
  assert.equal(c.nightEndHour, 6);
  assert.equal(c.alphaFast, 0.6);
  assert.equal(c.alphaSlow, 0.25);
  assert.equal(c.marginW, 150);
});

test('selectNightConfig: enabled only false when EXPLICITLY false', () => {
  assert.equal(selectNightConfig({ forecast: { load: { adaptiveNight: {} } } }).enabled, true);
  assert.equal(selectNightConfig({ forecast: { load: { adaptiveNight: { enabled: false } } } }).enabled, false);
  assert.equal(selectNightConfig({ forecast: { load: { adaptiveNight: { enabled: 0 } } } }).enabled, true,
    'falsy-but-not-false stays ON');
});

test('selectNightConfig clamps and overrides', () => {
  const c = selectNightConfig({ forecast: { load: { adaptiveNight: {
    consecutiveNights: 5, nightStartHour: 23, nightEndHour: 5, alphaFast: 2, alphaSlow: -1, marginW: -10,
  } } } });
  assert.equal(c.consecutiveNights, 5);
  assert.equal(c.nightStartHour, 23);
  assert.equal(c.nightEndHour, 5);
  assert.equal(c.alphaFast, 1, 'alpha clamped to [0,1]');
  assert.equal(c.alphaSlow, 0, 'alpha clamped to [0,1]');
  assert.equal(c.marginW, 0, 'margin clamped to >= 0');
});

test('selectNightConfig rejects out-of-range hours back to default', () => {
  const c = selectNightConfig({ forecast: { load: { adaptiveNight: { nightStartHour: 99, nightEndHour: -3 } } } });
  assert.equal(c.nightStartHour, 22);
  assert.equal(c.nightEndHour, 6);
});

// --- isNightHour ---

test('isNightHour handles midnight-crossing window 22..6', () => {
  for (const h of [22, 23, 0, 1, 5]) assert.equal(isNightHour(h, 22, 6), true, `h=${h} is night`);
  for (const h of [6, 7, 12, 18, 21]) assert.equal(isNightHour(h, 22, 6), false, `h=${h} is day`);
});

test('isNightHour handles non-crossing window 0..6', () => {
  assert.equal(isNightHour(0, 0, 6), true);
  assert.equal(isNightHour(5, 0, 6), true);
  assert.equal(isNightHour(6, 0, 6), false);
  assert.equal(isNightHour(22, 0, 6), false);
});

// --- median ---

test('median odd/even/empty', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
  assert.equal(median([5, NaN, 1]), 3, 'ignores non-finite');
});

// --- buildNightQuery ---

test('buildNightQuery crossing window uses OR predicate + correct series + x4000', () => {
  const sql = buildNightQuery(22, 6);
  assert.ok(sql.includes('energy_slots_15m'));
  assert.ok(sql.includes("'load_power_w'") && sql.includes("'grid_import_w'"));
  assert.ok(sql.includes('value_num * 4000'), 'kWh-per-15min -> avg W');
  assert.ok(sql.includes('(h >= 22 OR h < 6)'), 'crossing window predicate');
  assert.ok(sql.includes("local_date - INTERVAL '1 day'"), 'pre-midnight night attribution');
});

test('buildNightQuery non-crossing window uses AND predicate', () => {
  const sql = buildNightQuery(0, 6);
  assert.ok(sql.includes('h >= 0 AND h < 6'));
});

test('buildNightQuery coerces hour args (no injection surface)', () => {
  // A non-numeric hour coerces to 0 (NaN | 0), never reaching the SQL as text.
  const sql = buildNightQuery('22; DROP TABLE x', '6');
  assert.ok(!sql.includes('DROP TABLE'), 'string hour coerced to integer, not inlined');
  assert.ok(/h >= 0\b/.test(sql), 'malformed hour falls back to integer 0');
  // A clean numeric string is honoured.
  assert.ok(buildNightQuery('23', '5').includes('h >= 23'));
});

// --- aggregateNights ---

function row(night_date, h, series_key, avg_w) {
  return { night_date, h, series_key, avg_w, n: 4 };
}

test('aggregateNights folds rows into per-night means + per-hour load map', () => {
  const rows = [
    row('2026-06-25', 22, 'load_power_w', 400),
    row('2026-06-25', 23, 'load_power_w', 600),
    row('2026-06-25', 0, 'grid_import_w', 100),
    row('2026-06-26', 22, 'load_power_w', 800),
  ];
  const nights = aggregateNights(rows);
  assert.equal(nights.length, 2);
  assert.equal(nights[0].date, '2026-06-25', 'sorted oldest first');
  assert.equal(nights[0].loadMeanW, 500, '(400+600)/2');
  assert.equal(nights[0].gridMeanW, 100);
  assert.equal(nights[0].loadByHour.get(22), 400);
  assert.equal(nights[1].loadMeanW, 800);
  assert.equal(nights[1].gridMeanW, null, 'no grid rows -> null');
});

// --- computeConsecutiveBias (the tracking signal) ---

test('computeConsecutiveBias detects trailing persistent under-forecast (up)', () => {
  const nights = [
    { loadMeanW: 500 }, // close to base 500 -> not biased, breaks the run going backward
    { loadMeanW: 900 },
    { loadMeanW: 850 },
    { loadMeanW: 800 },
  ];
  const r = computeConsecutiveBias(nights, 500, 150);
  assert.equal(r.direction, 'up');
  assert.equal(r.count, 3, 'last 3 nights all > base+margin, 1st night breaks it');
});

test('computeConsecutiveBias detects persistent over-forecast (down)', () => {
  const nights = [{ loadMeanW: 200 }, { loadMeanW: 150 }, { loadMeanW: 180 }];
  const r = computeConsecutiveBias(nights, 500, 150);
  assert.equal(r.direction, 'down');
  assert.equal(r.count, 3);
});

test('computeConsecutiveBias: a sign flip stops the count', () => {
  const nights = [{ loadMeanW: 900 }, { loadMeanW: 100 }, { loadMeanW: 900 }];
  const r = computeConsecutiveBias(nights, 500, 150);
  assert.equal(r.direction, 'up', 'newest night drives direction');
  assert.equal(r.count, 1, 'middle night (down) stops the run');
});

test('computeConsecutiveBias: within margin = no signal', () => {
  const nights = [{ loadMeanW: 520 }, { loadMeanW: 480 }, { loadMeanW: 500 }];
  const r = computeConsecutiveBias(nights, 500, 150);
  assert.equal(r.direction, 'none');
  assert.equal(r.count, 0);
});

// --- medianByHour ---

test('medianByHour takes per-hour median over the recent window', () => {
  const nights = [
    { loadByHour: new Map([[22, 100], [23, 200]]) },
    { loadByHour: new Map([[22, 300], [23, 400]]) },
    { loadByHour: new Map([[22, 500], [23, 600]]) },
  ];
  const m = medianByHour(nights, 3);
  assert.equal(m.get(22), 300);
  assert.equal(m.get(23), 400);
});

test('medianByHour respects windowNights (only most recent N)', () => {
  const nights = [
    { loadByHour: new Map([[22, 1]]) },     // dropped (window=2)
    { loadByHour: new Map([[22, 100]]) },
    { loadByHour: new Map([[22, 300]]) },
  ];
  const m = medianByHour(nights, 2);
  assert.equal(m.get(22), 200, 'median of [100,300]');
});

// --- blendSlot ---

test('blendSlot is EWMA toward measured, clamped', () => {
  assert.equal(blendSlot(200, 800, 0.6, 0, 6000), 0.6 * 800 + 0.4 * 200); // 560
  assert.equal(blendSlot(200, 800, 0.25, 0, 6000), 0.25 * 800 + 0.75 * 200); // 350
  assert.equal(blendSlot(200, 100000, 0.6, 0, 6000), 6000, 'upper clamp');
  assert.equal(blendSlot(50, -1000, 0.9, 0, 6000), 0, 'lower clamp');
});

test('blendSlot pulls DOWN when measured is below base (symmetric)', () => {
  // consumer switched off: measured 200 < base 800 -> blended below base
  const out = blendSlot(800, 200, 0.6, 0, 6000);
  assert.equal(out, 0.6 * 200 + 0.4 * 800); // 440 < 800
  assert.ok(out < 800);
});

// --- applyNightCorrection (integration with a fake db) ---

function fakeCtx({ rows, cfg }) {
  const logs = [];
  return {
    ctx: {
      getCfg: () => cfg ?? {},
      pushLog: (ev, payload) => logs.push({ ev, payload }),
      db: { query: async () => ({ rows }) },
      bumpForecastVersion: () => {},
    },
    logs,
  };
}

// 72 hourly slots starting at a fixed UTC midnight; power_w = baseW everywhere.
function makeSlots(baseW, startIso = '2026-06-28T00:00:00.000Z') {
  const t0 = new Date(startIso).getTime();
  return Array.from({ length: 24 }, (_, i) => ({
    ts_utc: new Date(t0 + i * 3600000).toISOString(),
    power_w: baseW,
    confidence: 0.7,
  }));
}

// Build telemetry rows: N nights, each night's hours all at loadW, gridW.
function telemetryRows(nights) {
  const rows = [];
  for (const { date, loadW, gridW } of nights) {
    for (const h of [22, 23, 0, 1, 2, 3, 4, 5]) {
      rows.push({ night_date: date, h, series_key: 'load_power_w', avg_w: loadW, n: 4 });
      if (gridW != null) rows.push({ night_date: date, h, series_key: 'grid_import_w', avg_w: gridW, n: 4 });
    }
  }
  return rows;
}

test('applyNightCorrection: persistent under-forecast uses fast alpha and lifts night slots', async () => {
  const rows = telemetryRows([
    { date: '2026-06-25', loadW: 900, gridW: 400 },
    { date: '2026-06-26', loadW: 900, gridW: 400 },
    { date: '2026-06-27', loadW: 900, gridW: 400 },
  ]);
  const { ctx, logs } = fakeCtx({ rows, cfg: {} });
  const corrector = createLoadBiasCorrector(ctx);
  const slots = makeSlots(300);
  const res = await corrector.applyNightCorrection(slots);

  assert.equal(res.applied, true);
  assert.equal(res.signalActive, true, '3 consecutive biased nights -> signal');
  assert.equal(res.direction, 'up');
  assert.equal(res.alpha, 0.6, 'fast alpha');
  assert.equal(res.gridImportNights, 3, 'symptom logged');

  // Berlin summer = UTC+2, so the night window 22..6 Berlin maps to UTC 20..4.
  // Check a slot that is inside the night window: UTC 00:00 (Berlin 02:00).
  const night = slots.find((s) => s.ts_utc === '2026-06-28T00:00:00.000Z');
  assert.equal(night.nightCorrected, true);
  assert.equal(night.power_w, 0.6 * 900 + 0.4 * 300, '660W blended');

  // A daytime slot (UTC 10:00 = Berlin 12:00) stays untouched.
  const day = slots.find((s) => s.ts_utc === '2026-06-28T10:00:00.000Z');
  assert.equal(day.power_w, 300, 'daytime slot untouched');
  assert.equal(day.nightCorrected, undefined);

  assert.ok(logs.some((l) => l.ev === 'load_forecast_night_correction'));
});

test('applyNightCorrection: no persistent bias uses gentle alpha', async () => {
  // measured ~ base -> within margin -> no signal -> slow alpha (still tracks)
  const rows = telemetryRows([
    { date: '2026-06-25', loadW: 320, gridW: 0 },
    { date: '2026-06-26', loadW: 320, gridW: 0 },
    { date: '2026-06-27', loadW: 320, gridW: 0 },
  ]);
  const { ctx } = fakeCtx({ rows, cfg: {} });
  const corrector = createLoadBiasCorrector(ctx);
  const slots = makeSlots(300);
  const res = await corrector.applyNightCorrection(slots);
  assert.equal(res.signalActive, false);
  assert.equal(res.alpha, 0.25, 'gentle alpha');
  const night = slots.find((s) => s.ts_utc === '2026-06-28T00:00:00.000Z');
  assert.equal(night.power_w, 0.25 * 320 + 0.75 * 300, '305W gentle blend');
});

test('applyNightCorrection: disabled is a no-op', async () => {
  const { ctx } = fakeCtx({ rows: [], cfg: { forecast: { load: { adaptiveNight: { enabled: false } } } } });
  const corrector = createLoadBiasCorrector(ctx);
  const slots = makeSlots(300);
  const res = await corrector.applyNightCorrection(slots);
  assert.equal(res.applied, false);
  assert.equal(res.reason, 'disabled');
  assert.equal(slots[0].power_w, 300, 'untouched');
});

test('applyNightCorrection: no telemetry -> no-op, never throws', async () => {
  const { ctx } = fakeCtx({ rows: [], cfg: {} });
  const corrector = createLoadBiasCorrector(ctx);
  const slots = makeSlots(300);
  const res = await corrector.applyNightCorrection(slots);
  assert.equal(res.applied, false);
  assert.equal(res.reason, 'no_telemetry');
  assert.equal(slots[0].power_w, 300);
});

test('applyNightCorrection: db error is swallowed, slots untouched', async () => {
  const ctx = {
    getCfg: () => ({}),
    pushLog: () => {},
    db: { query: async () => { throw new Error('boom'); } },
    bumpForecastVersion: () => {},
  };
  const corrector = createLoadBiasCorrector(ctx);
  const slots = makeSlots(300);
  const res = await corrector.applyNightCorrection(slots);
  assert.equal(res.applied, false);
  assert.equal(res.reason, 'query_error');
  assert.equal(slots[0].power_w, 300);
});
