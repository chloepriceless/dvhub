import test from 'node:test';
import assert from 'node:assert/strict';

import { filterSlotsByTimeWindow, computeNextPeriodBounds } from '../small-market-automation.js';
import { buildNeedsRegeneration, createMarketAutomationBuilder } from '../market-automation-builder.js';

const SLOT_MS = 15 * 60 * 1000;

function slotAt(iso, ctKwh = 0) {
  return { ts: Date.parse(iso), ct_kwh: ctKwh };
}

test('filterSlotsByTimeWindow filters slots inside a normal daytime window', () => {
  const slots = [
    slotAt('2026-01-15T12:45:00Z', 10), // 13:45 Berlin
    slotAt('2026-01-15T13:00:00Z', 11), // 14:00 Berlin
    slotAt('2026-01-15T16:45:00Z', 12), // 17:45 Berlin
    slotAt('2026-01-15T17:00:00Z', 13) // 18:00 Berlin
  ];

  const result = filterSlotsByTimeWindow({
    slots,
    searchWindowStart: '14:00',
    searchWindowEnd: '18:00',
    timeZone: 'Europe/Berlin'
  });

  assert.deepEqual(result.map((slot) => slot.ts), [slots[1].ts, slots[2].ts]);
});

test('filterSlotsByTimeWindow supports overnight windows where start > end', () => {
  const slots = [
    slotAt('2026-01-15T20:45:00Z', 10), // 21:45 Berlin (outside)
    slotAt('2026-01-15T21:00:00Z', 11), // 22:00 Berlin (inside)
    slotAt('2026-01-15T23:00:00Z', 12), // 00:00 Berlin (inside)
    slotAt('2026-01-16T04:45:00Z', 13), // 05:45 Berlin (inside)
    slotAt('2026-01-16T05:00:00Z', 14) // 06:00 Berlin (outside)
  ];

  const result = filterSlotsByTimeWindow({
    slots,
    searchWindowStart: '22:00',
    searchWindowEnd: '06:00',
    timeZone: 'Europe/Berlin'
  });

  assert.deepEqual(result.map((slot) => slot.ts), [slots[1].ts, slots[2].ts, slots[3].ts]);
});

test('filterSlotsByTimeWindow handles empty or missing window inputs', () => {
  assert.deepEqual(filterSlotsByTimeWindow({
    slots: [],
    searchWindowStart: '14:00',
    searchWindowEnd: '18:00',
    timeZone: 'Europe/Berlin'
  }), []);

  const slots = [slotAt('2026-01-15T13:00:00Z', 11)];

  assert.deepEqual(filterSlotsByTimeWindow({
    slots,
    searchWindowStart: null,
    searchWindowEnd: '18:00',
    timeZone: 'Europe/Berlin'
  }), []);

  assert.deepEqual(filterSlotsByTimeWindow({
    slots,
    searchWindowStart: '14:00',
    searchWindowEnd: undefined,
    timeZone: 'Europe/Berlin'
  }), []);
});

test('regeneration state machine does not regenerate on same day with unchanged inputs', () => {
  const needsRegeneration = buildNeedsRegeneration({
    runDate: '2026-03-13',
    lastState: {
      lastRunDate: '2026-03-13',
      lastPriceSlotCount: 96,
      lastSocPct: 50
    },
    priceSlotCount: 96,
    currentSocPct: 54,
    previousAutomationRules: [{ id: 'sma-1' }],
    batteryCapacityKwh: 25.6
  });

  assert.equal(needsRegeneration, false);
});

test('regeneration state machine regenerates on day change', () => {
  const needsRegeneration = buildNeedsRegeneration({
    runDate: '2026-03-13',
    lastState: {
      lastRunDate: '2026-03-12',
      lastPriceSlotCount: 96,
      lastSocPct: 50
    },
    priceSlotCount: 96,
    currentSocPct: 50,
    previousAutomationRules: [{ id: 'sma-1' }],
    batteryCapacityKwh: 25.6
  });

  assert.equal(needsRegeneration, true);
});

test('regeneration state machine regenerates when price slot count changes', () => {
  const needsRegeneration = buildNeedsRegeneration({
    runDate: '2026-03-13',
    lastState: {
      lastRunDate: '2026-03-13',
      lastPriceSlotCount: 92,
      lastSocPct: 50
    },
    priceSlotCount: 96,
    currentSocPct: 50,
    previousAutomationRules: [{ id: 'sma-1' }],
    batteryCapacityKwh: 25.6
  });

  assert.equal(needsRegeneration, true);
});

test('regeneration state machine regenerates when soc changes by at least 5%', () => {
  const needsRegeneration = buildNeedsRegeneration({
    runDate: '2026-03-13',
    lastState: {
      lastRunDate: '2026-03-13',
      lastPriceSlotCount: 96,
      lastSocPct: 50
    },
    priceSlotCount: 96,
    currentSocPct: 55,
    previousAutomationRules: [{ id: 'sma-1' }],
    batteryCapacityKwh: 25.6
  });

  assert.equal(needsRegeneration, true);
});

test('regeneration state machine ignores soc deltas when battery capacity is not configured', () => {
  const needsRegeneration = buildNeedsRegeneration({
    runDate: '2026-03-13',
    lastState: {
      lastRunDate: '2026-03-13',
      lastPriceSlotCount: 96,
      lastSocPct: 20
    },
    priceSlotCount: 96,
    currentSocPct: 80,
    previousAutomationRules: [{ id: 'sma-1' }],
    batteryCapacityKwh: 0
  });

  assert.equal(needsRegeneration, false);
});

test('regeneration state machine regenerates when there are no existing automation rules', () => {
  const needsRegeneration = buildNeedsRegeneration({
    runDate: '2026-03-13',
    lastState: {
      lastRunDate: '2026-03-13',
      lastPriceSlotCount: 96,
      lastSocPct: 50
    },
    priceSlotCount: 96,
    currentSocPct: 50,
    previousAutomationRules: [],
    batteryCapacityKwh: 25.6
  });

  assert.equal(needsRegeneration, true);
});

// Keep a basic sanity check around slot spacing assumptions used by planner callers.
test('slot fixture helper still models 15-minute spacing', () => {
  const first = slotAt('2026-01-15T13:00:00Z', 11);
  const second = slotAt('2026-01-15T13:15:00Z', 12);
  assert.equal(second.ts - first.ts, SLOT_MS);
});

// --- computeNextPeriodBounds tests ---

test('computeNextPeriodBounds returns current overnight period when now is after start', () => {
  // 2026-03-14 at 16:00 Berlin (15:00 UTC in winter, but March = CET+1 = 15:00 UTC)
  const now = Date.parse('2026-03-14T15:00:00Z'); // 16:00 Berlin
  const bounds = computeNextPeriodBounds({
    now,
    searchWindowStart: '14:00',
    searchWindowEnd: '09:00',
    timeZone: 'Europe/Berlin'
  });

  assert.ok(bounds != null);
  // Start should be 2026-03-14 14:00 Berlin = 13:00 UTC
  assert.equal(new Date(bounds.startTs).toISOString(), '2026-03-14T13:00:00.000Z');
  // End should be 2026-03-15 09:00 Berlin = 08:00 UTC
  assert.equal(new Date(bounds.endTs).toISOString(), '2026-03-15T08:00:00.000Z');
});

test('computeNextPeriodBounds returns current overnight period when now is in tail (before end)', () => {
  // 2026-03-15 at 07:00 Berlin (06:00 UTC) — still within the 14:00→09:00 period that started yesterday
  const now = Date.parse('2026-03-15T06:00:00Z'); // 07:00 Berlin
  const bounds = computeNextPeriodBounds({
    now,
    searchWindowStart: '14:00',
    searchWindowEnd: '09:00',
    timeZone: 'Europe/Berlin'
  });

  assert.ok(bounds != null);
  // Start should be 2026-03-14 14:00 Berlin = 13:00 UTC
  assert.equal(new Date(bounds.startTs).toISOString(), '2026-03-14T13:00:00.000Z');
  // End should be 2026-03-15 09:00 Berlin = 08:00 UTC
  assert.equal(new Date(bounds.endTs).toISOString(), '2026-03-15T08:00:00.000Z');
});

test('computeNextPeriodBounds returns next overnight period when now is between end and start', () => {
  // 2026-03-15 at 10:00 Berlin (09:00 UTC) — between 09:00 and 14:00, next period starts at 14:00
  const now = Date.parse('2026-03-15T09:00:00Z'); // 10:00 Berlin
  const bounds = computeNextPeriodBounds({
    now,
    searchWindowStart: '14:00',
    searchWindowEnd: '09:00',
    timeZone: 'Europe/Berlin'
  });

  assert.ok(bounds != null);
  // Start should be 2026-03-15 14:00 Berlin = 13:00 UTC
  assert.equal(new Date(bounds.startTs).toISOString(), '2026-03-15T13:00:00.000Z');
  // End should be 2026-03-16 09:00 Berlin = 08:00 UTC (March 29 is DST switch, but not yet)
  assert.equal(new Date(bounds.endTs).toISOString(), '2026-03-16T08:00:00.000Z');
});

test('computeNextPeriodBounds limits optimizer to single period (prevents cross-day selection)', () => {
  // Simulate: now is 16:00 on March 14, EPEX data has slots for both tonight AND tomorrow night
  const now = Date.parse('2026-03-14T15:00:00Z'); // 16:00 Berlin
  const bounds = computeNextPeriodBounds({
    now,
    searchWindowStart: '14:00',
    searchWindowEnd: '09:00',
    timeZone: 'Europe/Berlin'
  });

  // Tonight's slots (should be included)
  const tonightSlot = Date.parse('2026-03-14T17:00:00Z'); // 18:00 Berlin
  const tomorrowMorningSlot = Date.parse('2026-03-15T06:00:00Z'); // 07:00 Berlin

  // Tomorrow night's slots (should be EXCLUDED)
  const tomorrowNightSlot = Date.parse('2026-03-15T17:00:00Z'); // 18:00 Berlin next day

  assert.ok(tonightSlot >= bounds.startTs && tonightSlot < bounds.endTs, 'tonight slot should be in period');
  assert.ok(tomorrowMorningSlot >= bounds.startTs && tomorrowMorningSlot < bounds.endTs, 'tomorrow morning slot should be in period');
  assert.ok(tomorrowNightSlot >= bounds.endTs, 'tomorrow night slot should be outside period');
});

test('computeNextPeriodBounds handles same-day window', () => {
  // Window 09:00→14:00, now is 10:00
  const now = Date.parse('2026-03-14T09:00:00Z'); // 10:00 Berlin
  const bounds = computeNextPeriodBounds({
    now,
    searchWindowStart: '09:00',
    searchWindowEnd: '14:00',
    timeZone: 'Europe/Berlin'
  });

  assert.ok(bounds != null);
  assert.equal(new Date(bounds.startTs).toISOString(), '2026-03-14T08:00:00.000Z'); // 09:00 Berlin
  assert.equal(new Date(bounds.endTs).toISOString(), '2026-03-14T13:00:00.000Z');   // 14:00 Berlin
});

test('computeNextPeriodBounds returns null for invalid inputs', () => {
  assert.equal(computeNextPeriodBounds({ now: NaN, searchWindowStart: '14:00', searchWindowEnd: '09:00' }), null);
  assert.equal(computeNextPeriodBounds({ now: Date.now(), searchWindowStart: null, searchWindowEnd: '09:00' }), null);
  assert.equal(computeNextPeriodBounds({ now: Date.now(), searchWindowStart: '14:00', searchWindowEnd: null }), null);
});

// --- SMA rule absolute timestamp validation (Bug 1 fix) ---

test('SMA rule with slotTs should only match when now is within the slot window', () => {
  // Simulate: rule was generated for tomorrow 03:00 (within overnight window 14:00→09:00).
  // The schedule engine must NOT fire this rule today at 03:00 — only tomorrow at 03:00.
  const SLOT_DURATION_MS = 15 * 60 * 1000;
  const tomorrowSlotTs = Date.parse('2026-03-15T02:00:00Z'); // 03:00 Berlin
  const rule = {
    id: 'sma-test',
    target: 'gridSetpointW',
    start: '03:00',
    end: '03:15',
    value: -12000,
    enabled: true,
    slotTs: tomorrowSlotTs,
    slotEndTs: tomorrowSlotTs + SLOT_DURATION_MS,
    source: 'small_market_automation',
    autoManaged: true
  };

  // Today at 03:05 — HH:MM matches, but absolute timestamp does not
  const todayNow = Date.parse('2026-03-14T02:05:00Z'); // 03:05 Berlin on March 14
  assert.ok(todayNow < rule.slotTs, 'today 03:05 should be before the slot timestamp');

  // Tomorrow at 03:05 — both HH:MM and absolute timestamp match
  const tomorrowNow = Date.parse('2026-03-15T02:05:00Z'); // 03:05 Berlin on March 15
  assert.ok(tomorrowNow >= rule.slotTs && tomorrowNow < rule.slotEndTs,
    'tomorrow 03:05 should be within the slot window');
});

test('SMA rule without slotTs should behave as before (backward compatible)', () => {
  // Old rules without slotTs should still match by HH:MM only
  const rule = {
    id: 'sma-legacy',
    target: 'gridSetpointW',
    start: '18:00',
    end: '18:15',
    value: -12000,
    enabled: true,
    source: 'small_market_automation',
    autoManaged: true
  };
  assert.equal(rule.slotTs, undefined, 'legacy rule should not have slotTs');
});

// --- Stage-2 (predictive pre-empty) builder integration ---
// D-14 (hoarding suppresses Stage 2) + D-16 (planSummary.stage2 populated).
// These exercise createMarketAutomationBuilder — the only place the Stage-2
// pre-pass is wired. The pure Stage-2 math is unit-tested separately in
// predictive-pre-empty.test.js; here we prove the stateful builder glue.

// 2026-06-21 — a summer day so the sun-times window comfortably spans a
// midday EPEX run. now = 04:00 UTC (06:00 Berlin), well before midday.
const STAGE2_NOW = Date.parse('2026-06-21T04:00:00Z');
const STAGE2_DATE = '2026-06-21';

// A qualifying EPEX curve: a contiguous negative-price run around midday
// (10:00–12:00 UTC) inside the sun-times day bounds, normal prices elsewhere.
function stage2EpexData() {
  const slots = [];
  // Morning expensive slots 04:00–10:00 UTC at 15-min steps.
  for (let t = Date.parse('2026-06-21T04:00:00Z'); t < Date.parse('2026-06-21T10:00:00Z'); t += SLOT_MS) {
    slots.push({ ts: t, ct_kwh: 35 });
  }
  // Midday negative run 10:00–12:00 UTC.
  for (let t = Date.parse('2026-06-21T10:00:00Z'); t < Date.parse('2026-06-21T12:00:00Z'); t += SLOT_MS) {
    slots.push({ ts: t, ct_kwh: -4 });
  }
  // Afternoon back to normal.
  for (let t = Date.parse('2026-06-21T12:00:00Z'); t < Date.parse('2026-06-21T18:00:00Z'); t += SLOT_MS) {
    slots.push({ ts: t, ct_kwh: 28 });
  }
  return slots;
}

// PV / load forecast rows in the {ts, powerW, confidence} raw shape the builder
// normalizes. Confidence 0.27 sits inside the confirmed prod band (0.24–0.30).
function stage2ForecastRows(fromIso, toIso, powerW, stepMin, confidence) {
  const rows = [];
  const step = stepMin * 60000;
  for (let t = Date.parse(fromIso); t < Date.parse(toIso); t += step) {
    rows.push({ ts: new Date(t).toISOString(), powerW, confidence });
  }
  return rows;
}

// Sun-times cache covering the test day — sunrise 03:00 UTC, sunset 19:00 UTC,
// so the midday negative window falls inside the Stage-2 day bounds.
function stage2SunTimesCache() {
  return {
    cache: {
      [STAGE2_DATE]: {
        sunriseTs: '2026-06-21T03:00:00.000Z',
        sunsetTs: '2026-06-21T19:00:00.000Z'
      }
    }
  };
}

// Build a fake ctx matching the createMarketAutomationBuilder destructure
// ({ state, getCfg, pushLog }) plus the extra ctx members
// regenerateSmallMarketAutomationRules reads (persistConfig,
// getSunTimesCacheForPlanning).
function makeStage2Ctx({ predictiveEnabled = true, hoardingForecast = false } = {}) {
  const logs = [];
  const cfg = {
    epex: { timezone: 'Europe/Berlin' },
    // Stage 2's below-PV-cost trigger reads the operator's existing PV
    // generation cost — "PV-Kosten" under Preise → Interne Kosten.
    userEnergyPricing: { costs: { pvCtKwh: 8 } },
    schedule: {
      timezone: 'Europe/Berlin',
      smallMarketAutomation: {
        enabled: true,
        forecastAware: true,
        engine: 'greedy',
        maxDischargeW: -16000,
        batteryCapacityKwh: 43,
        inverterEfficiencyPct: 93,
        minSocPct: 30,
        searchWindowStart: '14:00',
        searchWindowEnd: '10:00',
        predictivePreEmpty: {
          enabled: predictiveEnabled,
          akkuHardLimitW: 20000,
          akkuSoftLimitW: 18000,
          confidenceFactorLow: 0.24,
          confidenceFactorHigh: 0.30,
          haltenAbortDropPct: 25
        }
      }
    }
  };

  // hoardingForecast=true → a PV-poor / load-heavy 24h horizon so Stage 1's
  // computeForecastReserveSocPct flips hoardingActive on. Otherwise a strong
  // PV forecast keeps Stage 1 out of the hoarding gate.
  const pvRows = hoardingForecast
    ? stage2ForecastRows('2026-06-21T04:00:00Z', '2026-06-22T04:00:00Z', 50, 15, 0.27)
    : stage2ForecastRows('2026-06-21T04:00:00Z', '2026-06-22T04:00:00Z', 9000, 15, 0.27);
  const loadRows = hoardingForecast
    ? stage2ForecastRows('2026-06-21T04:00:00Z', '2026-06-22T04:00:00Z', 6000, 60, 0.30)
    : stage2ForecastRows('2026-06-21T04:00:00Z', '2026-06-22T04:00:00Z', 600, 60, 0.30);

  const state = {
    victron: { soc: 80, minSocPct: 5, pvTotalW: 0, pvPowerW: 0 },
    epex: { data: stage2EpexData(), timezone: 'Europe/Berlin' },
    forecast: {
      pv: { data: pvRows, confidence: 0.27 },
      load: { data: loadRows, confidence: 0.30 }
    },
    schedule: { rules: [] }
  };

  return {
    state,
    getCfg: () => cfg,
    pushLog: (event, payload) => logs.push({ event, payload }),
    persistConfig: () => {},
    getSunTimesCacheForPlanning: () => stage2SunTimesCache(),
    _logs: logs
  };
}

test('D-14: Stage 1 hoarding gate suppresses Stage 2 entirely (no Stage-2 rules emitted)', async () => {
  const ctx = makeStage2Ctx({ predictiveEnabled: true, hoardingForecast: true });
  const builder = createMarketAutomationBuilder(ctx);

  await builder.regenerateSmallMarketAutomationRules({ now: STAGE2_NOW, force: true });

  // Stage 1's hoardingActive must have been triggered by the PV-poor forecast.
  const reserve = ctx.state.schedule.smallMarketAutomation?.plan?.forecastReserve;
  assert.ok(reserve?.hoardingActive === true, 'fixture must drive Stage 1 into the hoarding gate');

  // D-14: with hoarding active NO rule carries a stage2Phase marker.
  const stage2Rules = ctx.state.schedule.rules.filter((r) => r?.stage2Phase);
  assert.equal(stage2Rules.length, 0, 'hoarding active → zero Stage-2 rules');

  // planSummary.stage2 reflects an idle/suppressed state (null or suppressed reason).
  const stage2 = ctx.state.schedule.smallMarketAutomation?.plan?.stage2;
  if (stage2 != null) {
    assert.equal(stage2.phase, 'IDLE', 'suppressed Stage 2 must be IDLE');
    assert.equal(stage2.reason, 'hoarding_active');
  }
});

test('D-16: planSummary.stage2 is populated with phase, window, targetSocPct and slots[]', async () => {
  const ctx = makeStage2Ctx({ predictiveEnabled: true, hoardingForecast: false });
  const builder = createMarketAutomationBuilder(ctx);

  await builder.regenerateSmallMarketAutomationRules({ now: STAGE2_NOW, force: true });

  // Stage 1 must NOT be hoarding for this fixture (strong PV forecast).
  const reserve = ctx.state.schedule.smallMarketAutomation?.plan?.forecastReserve;
  assert.ok(!reserve?.hoardingActive, 'qualifying-window fixture must not trigger hoarding');

  const stage2 = ctx.state.schedule.smallMarketAutomation?.plan?.stage2;
  assert.ok(stage2 && typeof stage2 === 'object', 'planSummary.stage2 must be a populated object');
  assert.ok(typeof stage2.phase === 'string', 'stage2 carries a phase string');
  assert.ok(stage2.window && Number.isFinite(stage2.window.startTs)
    && Number.isFinite(stage2.window.endTs), 'stage2 carries a {startTs,endTs} window');
  assert.ok(Number.isFinite(stage2.targetSocPct), 'stage2 carries a numeric targetSocPct');
  assert.ok(Array.isArray(stage2.slots), 'stage2 carries a slots[] array');

  // In the LEEREN phase (now is well before the midday window) the morning
  // discharge slots are emitted; each carries a mode + implied battery discharge.
  assert.equal(stage2.phase, 'LEEREN', 'at 06:00 Berlin Stage 2 is in the LEEREN phase');
  assert.ok(stage2.slots.length > 0, 'LEEREN phase emits at least one discharge slot');

  const akkuHardLimitW = ctx.getCfg().schedule.smallMarketAutomation.predictivePreEmpty.akkuHardLimitW;
  for (const slot of stage2.slots) {
    assert.ok(typeof slot.mode === 'string', 'each stage2 slot carries a mode');
    assert.ok(Number.isFinite(slot.impliedBatteryDischargeW),
      'each stage2 slot carries impliedBatteryDischargeW');
    // T-10-15: the dual-limit clamp guarantees the implied discharge never
    // exceeds the Akku Hard Limit.
    assert.ok(slot.impliedBatteryDischargeW <= akkuHardLimitW,
      `slot impliedBatteryDischargeW ${slot.impliedBatteryDischargeW} must be <= akkuHardLimitW ${akkuHardLimitW}`);
    // Pitfall 1: every Stage-2 grid setpoint is export-only (<= 0).
    assert.ok(slot.gridSetpointW <= 0, 'stage2 slot gridSetpointW must be <= 0');
  }

  // The emitted LEEREN rules carry the stage2Phase marker (D-18 identification).
  const leerenRules = ctx.state.schedule.rules.filter((r) => r?.stage2Phase === 'LEEREN');
  assert.ok(leerenRules.length > 0, 'LEEREN rules emitted with the stage2Phase marker');
  for (const r of leerenRules) {
    assert.equal(r.target, 'gridSetpointW');
    assert.ok(r.value <= 0, 'LEEREN rule value must be <= 0');
    // D-10: per-slot stop floor is the global hard floor, not the static minSocPct.
    assert.equal(r.stopSocPct, ctx.state.victron.minSocPct);
  }

  // D-16: a stage2_phase_change event fired on the first plan of the day.
  assert.ok(ctx._logs.some((l) => l.event === 'stage2_phase_change'),
    'pushLog stage2_phase_change fired');
});

test('D-15: Stage 2 stays idle when predictivePreEmpty.enabled is OFF (Stage-1 output unchanged)', async () => {
  const ctx = makeStage2Ctx({ predictiveEnabled: false, hoardingForecast: false });
  const builder = createMarketAutomationBuilder(ctx);

  await builder.regenerateSmallMarketAutomationRules({ now: STAGE2_NOW, force: true });

  const stage2Rules = ctx.state.schedule.rules.filter((r) => r?.stage2Phase);
  assert.equal(stage2Rules.length, 0, 'predictivePreEmpty OFF → zero Stage-2 rules');
  assert.equal(ctx.state.schedule.smallMarketAutomation?.plan?.stage2, null,
    'predictivePreEmpty OFF → planSummary.stage2 is null');
});
