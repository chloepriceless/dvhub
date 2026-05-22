import test from 'node:test';
import assert from 'node:assert/strict';

// RED scaffolding (Phase 10 Wave 0, TDD gate).
// dvhub/predictive-pre-empty.js does NOT exist yet — plan 10-03 ships it.
// Every test below therefore fails RED with ERR_MODULE_NOT_FOUND on this import.
// That is the expected and required Wave-0 state. Do NOT create the module here.
import {
  detectQualifyingWindow,
  estimateWindowPvKwh,
  computePreEmptyTargetSoc,
  preEmptySlotSetpointW,
  resolveStage2Phase,
  computeFreigabeChargeThrottle
} from '../predictive-pre-empty.js';

const SLOT_MS = 15 * 60 * 1000;
const BASE_TS = Date.parse('2026-06-15T04:00:00Z');

// EPEX slot fixture — shape per epex-fetch.js: { ts, day, eur_mwh, ct_kwh }.
function slotAt(index, ctKwh) {
  return {
    ts: BASE_TS + index * SLOT_MS,
    day: '2026-06-15',
    ct_kwh: ctKwh,
    eur_mwh: ctKwh * 10
  };
}

// Normalized PV forecast row fixture — shape per market-automation-builder.js
// normalizeForecastRows: { start, end, powerW, confidence }.
function pvSlotAt(index, powerW, confidence) {
  return {
    start: new Date(BASE_TS + index * SLOT_MS).toISOString(),
    end: new Date(BASE_TS + (index + 1) * SLOT_MS).toISOString(),
    powerW,
    confidence
  };
}

// dayBounds spanning all 12 fixture slots used below.
const DAY_BOUNDS = { startTs: BASE_TS, endTs: BASE_TS + 12 * SLOT_MS };

// --- detectQualifyingWindow (D-04 / D-07) ---

test('detectQualifyingWindow returns a window for a contiguous negative-price run', () => {
  const slots = [
    slotAt(0, 8),
    slotAt(1, -2),
    slotAt(2, -5),
    slotAt(3, -1),
    slotAt(4, 12)
  ];
  const r = detectQualifyingWindow(slots, 6, DAY_BOUNDS);
  assert.ok(r, 'expected a qualifying window object');
  assert.equal(r.startTs, BASE_TS + 1 * SLOT_MS);
  assert.equal(r.endTs, BASE_TS + 3 * SLOT_MS + SLOT_MS);
});

test('detectQualifyingWindow returns a window for positive prices below PV generation cost', () => {
  // All prices positive but below pvGenerationCostCtKwh=8 -> still qualifies.
  const slots = [
    slotAt(0, 9),
    slotAt(1, 4),
    slotAt(2, 3),
    slotAt(3, 11)
  ];
  const r = detectQualifyingWindow(slots, 8, DAY_BOUNDS);
  assert.ok(r, 'expected a qualifying window object');
  assert.equal(r.startTs, BASE_TS + 1 * SLOT_MS);
  assert.equal(r.endTs, BASE_TS + 2 * SLOT_MS + SLOT_MS);
});

test('detectQualifyingWindow returns null when all prices are above PV cost and non-negative', () => {
  const slots = [
    slotAt(0, 12),
    slotAt(1, 15),
    slotAt(2, 9),
    slotAt(3, 20)
  ];
  const r = detectQualifyingWindow(slots, 8, DAY_BOUNDS);
  assert.equal(r, null);
});

// --- estimateWindowPvKwh (D-08) ---

test('estimateWindowPvKwh sums kWh and averages confidence over overlapping slots', () => {
  // Two 15-min slots at 4000 W -> 4000 W * 0.25 h = 1.0 kWh each -> 2.0 kWh total.
  const pvSlots = [
    pvSlotAt(0, 4000, 0.25),
    pvSlotAt(1, 4000, 0.30)
  ];
  const window = { startTs: BASE_TS, endTs: BASE_TS + 2 * SLOT_MS };
  const r = estimateWindowPvKwh({ pvSlots, window });
  assert.equal(r.slotsCounted, 2);
  assert.ok(Math.abs(r.totalKwh - 2.0) < 1e-6, `totalKwh ~= 2.0, got ${r.totalKwh}`);
  assert.ok(Math.abs(r.avgConfidence - 0.275) < 1e-6, `avgConfidence ~= 0.275, got ${r.avgConfidence}`);
});

test('estimateWindowPvKwh returns zero kWh when the window is outside all slots', () => {
  const pvSlots = [
    pvSlotAt(0, 4000, 0.25),
    pvSlotAt(1, 4000, 0.25)
  ];
  // Window starts 10 slots after the last PV slot -> no overlap.
  const window = { startTs: BASE_TS + 10 * SLOT_MS, endTs: BASE_TS + 12 * SLOT_MS };
  const r = estimateWindowPvKwh({ pvSlots, window });
  assert.equal(r.totalKwh, 0);
  assert.equal(r.slotsCounted, 0);
});

// --- computePreEmptyTargetSoc (D-09 / D-10) ---

test('computePreEmptyTargetSoc moves at real prod confidence 0.27 (depthFactor strictly between 0 and 1)', () => {
  // Confidence 0.27 sits between confidenceFactorLow 0.25 and confidenceFactorHigh 0.30.
  // This proves Stage 2 ACTS at the real prod confidence band - NOT calibrated to 0.5/0.7.
  const r = computePreEmptyTargetSoc({
    windowPvKwh: 20,
    confidence: 0.27,
    batteryCapacityKwh: 43,
    currentSocPct: 80,
    hardFloorSocPct: 5,
    inverterEfficiencyPct: 93,
    confidenceFactorLow: 0.25,
    confidenceFactorHigh: 0.30
  });
  assert.ok(r.depthFactor > 0 && r.depthFactor < 1,
    `depthFactor strictly in (0,1), got ${r.depthFactor}`);
  assert.ok(r.targetSocPct < 80,
    `targetSocPct strictly below currentSocPct 80, got ${r.targetSocPct}`);
});

test('computePreEmptyTargetSoc holds at confidence 0.20 below the low endpoint (depthFactor 0)', () => {
  const r = computePreEmptyTargetSoc({
    windowPvKwh: 20,
    confidence: 0.20,
    batteryCapacityKwh: 43,
    currentSocPct: 80,
    hardFloorSocPct: 5,
    inverterEfficiencyPct: 93,
    confidenceFactorLow: 0.25,
    confidenceFactorHigh: 0.30
  });
  assert.equal(r.depthFactor, 0);
  assert.equal(r.targetSocPct, 80);
  assert.equal(r.reason, 'low_confidence');
});

test('computePreEmptyTargetSoc clamps targetSocPct to the hard floor, never below (D-10)', () => {
  // A huge windowPvKwh would imply emptying far past the hard floor; must clamp.
  const r = computePreEmptyTargetSoc({
    windowPvKwh: 200,
    confidence: 0.30,
    batteryCapacityKwh: 43,
    currentSocPct: 80,
    hardFloorSocPct: 10,
    inverterEfficiencyPct: 93,
    confidenceFactorLow: 0.25,
    confidenceFactorHigh: 0.30
  });
  assert.ok(r.targetSocPct >= 10,
    `targetSocPct never below hardFloorSocPct 10, got ${r.targetSocPct}`);
  assert.equal(r.targetSocPct, 10);
});

// --- preEmptySlotSetpointW (D-12 / D-17 dynamic headroom) ---

test('preEmptySlotSetpointW: below the soft limit -> battery exports freely (no taper)', () => {
  // 8 kW PV, 4 kW load, AC cap -16 kW. acBatteryExportShare = 16000-8000 = 8000;
  // raw battery discharge = 8000 + 4000 = 12000, well below the 18 kW soft limit.
  const r = preEmptySlotSetpointW({
    pvForecastW: 8000,
    expectedHouseLoadW: 4000,
    maxDischargeW: -16000,
    akkuHardLimitW: 20000,
    akkuSoftLimitW: 18000
  });
  assert.equal(r.gridSetpointW, -16000);
  assert.equal(r.impliedBatteryDischargeW, 12000);
  assert.equal(r.mode, 'aggressiveExport');
});

test('preEmptySlotSetpointW: dynamic headroom tapers the battery share above the soft limit', () => {
  // No PV, no load, AC cap -19 kW -> raw battery discharge demand = 19000,
  // 1 kW into the [18 kW, 20 kW] taper band -> must be tapered DOWN.
  const r = preEmptySlotSetpointW({
    pvForecastW: 0,
    expectedHouseLoadW: 0,
    maxDischargeW: -19000,
    akkuHardLimitW: 20000,
    akkuSoftLimitW: 18000
  });
  assert.ok(r.impliedBatteryDischargeW > 18000 && r.impliedBatteryDischargeW < 19000,
    `tapered discharge must land in (18000,19000), got ${r.impliedBatteryDischargeW}`);
  assert.ok(r.impliedBatteryDischargeW < 20000, 'discharge stays below the hard limit');
  assert.equal(r.mode, 'dcDischarge');
});

test('preEmptySlotSetpointW: PV is never throttled — only the battery share is tapered', () => {
  // 6 kW PV with a generous AC cap so the battery is the binding side.
  const r = preEmptySlotSetpointW({
    pvForecastW: 6000,
    expectedHouseLoadW: 0,
    maxDischargeW: -40000,
    akkuHardLimitW: 20000,
    akkuSoftLimitW: 18000
  });
  // |gridExport| = the full 6 kW PV + the tapered battery share (rounding aside).
  assert.ok(Math.abs(Math.abs(r.gridSetpointW) - r.batteryShareW - 6000) <= 1,
    `full PV must be exported on top of the battery share, got ${r.gridSetpointW}`);
  assert.ok(r.impliedBatteryDischargeW < 20000, 'battery discharge stays below the hard limit');
});

test('preEmptySlotSetpointW: a huge demand drives the discharge to — but not past — the hard limit', () => {
  const r = preEmptySlotSetpointW({
    pvForecastW: 0,
    expectedHouseLoadW: 0,
    maxDischargeW: -200000,
    akkuHardLimitW: 20000,
    akkuSoftLimitW: 18000
  });
  assert.ok(r.impliedBatteryDischargeW <= 20000,
    `discharge must never exceed akkuHardLimitW, got ${r.impliedBatteryDischargeW}`);
  assert.ok(r.impliedBatteryDischargeW > 19000, 'a huge demand drives it close to the limit');
});

test('preEmptySlotSetpointW invariant: discharge <= akkuHardLimitW, gridSetpointW <= 0', () => {
  const cases = [
    { pvForecastW: 8000, expectedHouseLoadW: 4000, maxDischargeW: -16000, akkuHardLimitW: 20000, akkuSoftLimitW: 18000 },
    { pvForecastW: 0, expectedHouseLoadW: 4000, maxDischargeW: -16000, akkuHardLimitW: 14000, akkuSoftLimitW: 12000 },
    { pvForecastW: 2000, expectedHouseLoadW: 6000, maxDischargeW: -16000, akkuHardLimitW: 12000, akkuSoftLimitW: 10000 },
    { pvForecastW: 0, expectedHouseLoadW: 0, maxDischargeW: -16000, akkuHardLimitW: 16000, akkuSoftLimitW: 14000 }
  ];
  for (const c of cases) {
    const r = preEmptySlotSetpointW(c);
    assert.ok(r.impliedBatteryDischargeW <= c.akkuHardLimitW + 1e-6,
      `impliedBatteryDischargeW ${r.impliedBatteryDischargeW} must be <= akkuHardLimitW ${c.akkuHardLimitW}`);
    assert.ok(r.gridSetpointW <= 0,
      `gridSetpointW must be <= 0 (export-only), got ${r.gridSetpointW}`);
  }
});

// --- resolveStage2Phase (D-13) ---

test('resolveStage2Phase returns LEEREN before holdStartTs', () => {
  const r = resolveStage2Phase({
    nowTs: BASE_TS,
    windowStartTs: BASE_TS + 8 * SLOT_MS,
    holdStartTs: BASE_TS + 4 * SLOT_MS,
    targetReached: false,
    forecastDegraded: false
  });
  assert.equal(r.phase, 'LEEREN');
});

test('resolveStage2Phase returns HALTEN between holdStartTs and windowStartTs when target reached', () => {
  const r = resolveStage2Phase({
    nowTs: BASE_TS + 6 * SLOT_MS,
    windowStartTs: BASE_TS + 8 * SLOT_MS,
    holdStartTs: BASE_TS + 4 * SLOT_MS,
    targetReached: true,
    forecastDegraded: false
  });
  assert.equal(r.phase, 'HALTEN');
});

test('resolveStage2Phase returns FREIGEBEN at or after windowStartTs', () => {
  const r = resolveStage2Phase({
    nowTs: BASE_TS + 8 * SLOT_MS,
    windowStartTs: BASE_TS + 8 * SLOT_MS,
    holdStartTs: BASE_TS + 4 * SLOT_MS,
    targetReached: true,
    forecastDegraded: false
  });
  assert.equal(r.phase, 'FREIGEBEN');
});

test('resolveStage2Phase aborts HALTEN when the forecast degrades', () => {
  // Within the HALTEN window but forecastDegraded -> abort the hold.
  const r = resolveStage2Phase({
    nowTs: BASE_TS + 6 * SLOT_MS,
    windowStartTs: BASE_TS + 8 * SLOT_MS,
    holdStartTs: BASE_TS + 4 * SLOT_MS,
    targetReached: true,
    forecastDegraded: true
  });
  assert.ok(r.phase === 'IDLE' || r.phase === 'FREIGEBEN',
    `degraded forecast aborts HALTEN to IDLE or FREIGEBEN, got ${r.phase}`);
  assert.ok(typeof r.reason === 'string' && /degrad|abort|halten/i.test(r.reason),
    `reason should indicate the Halten abort, got ${r.reason}`);
});

// --- computeFreigabeChargeThrottle (operator request 2026-05-22) ---

test('computeFreigabeChargeThrottle spreads charge over window when PV exceeds need', () => {
  // Battery at 50% on a 43 kWh pack, 4-slot window. Plenty of PV (40 kWh
  // forecast) vs ~20 kWh refill need -> throttle should activate.
  const windowEndTs = BASE_TS + 4 * SLOT_MS;
  const pv = [0,1,2,3].map(i => pvSlotAt(i, 10000, 0.5)); // 10 kW per slot = 10 kWh total (since 15min slots), need 4x to reach 40
  // Use bigger PV: 40 kW per slot = 10 kWh / slot * 4 slots = 40 kWh
  const bigPv = [0,1,2,3].map(i => pvSlotAt(i, 40000, 0.5));
  const load = [];
  const r = computeFreigabeChargeThrottle({
    now: BASE_TS,
    windowEndTs,
    currentSocPct: 50,
    batteryCapacityKwh: 43,
    pvSlots: bigPv,
    loadSlots: load,
    epexSlots: [0,1,2,3].map(i => slotAt(i, 5)),
    batteryVoltageV: 55.2,
    maxChargeCurrentA: 350,
    inverterEfficiencyPct: 90
  });
  assert.equal(r.rules.length, 4, 'should emit one rule per remaining slot');
  assert.equal(r.anchorTriggered, false, 'PV >> need => anchor should NOT trigger');
  for (const slot of r.rules) {
    assert.ok(slot.throttled, 'every positive-price slot should be throttled');
    assert.ok(slot.chargeCurrentA >= 0 && slot.chargeCurrentA <= 350, `current within [0,350] got ${slot.chargeCurrentA}`);
  }
});

test('computeFreigabeChargeThrottle releases anchor when PV cannot cover refill', () => {
  // Battery at 10% (need ~34 kWh on a 43 kWh pack) but only 5 kWh forecast PV.
  const windowEndTs = BASE_TS + 4 * SLOT_MS;
  const weakPv = [0,1,2,3].map(i => pvSlotAt(i, 5000, 0.4)); // 5 kW * 15min = 1.25 kWh/slot = 5 kWh total
  const r = computeFreigabeChargeThrottle({
    now: BASE_TS,
    windowEndTs,
    currentSocPct: 10,
    batteryCapacityKwh: 43,
    pvSlots: weakPv,
    loadSlots: [],
    epexSlots: [0,1,2,3].map(i => slotAt(i, 5)),
    batteryVoltageV: 55.2,
    maxChargeCurrentA: 350,
    inverterEfficiencyPct: 90
  });
  assert.equal(r.anchorTriggered, true, 'PV << need => Notfall-Anker must trigger');
  assert.equal(r.rules.length, 0, 'anchor release => no throttle rules emitted');
  assert.equal(r.reason, 'anchor_pv_insufficient');
});

test('computeFreigabeChargeThrottle releases throttle on negative-price slots', () => {
  // 4-slot window: slots 0,2 negative-priced, slots 1,3 positive.
  const windowEndTs = BASE_TS + 4 * SLOT_MS;
  const pv = [0,1,2,3].map(i => pvSlotAt(i, 40000, 0.5));
  const epex = [slotAt(0, -3), slotAt(1, 4), slotAt(2, -1), slotAt(3, 6)];
  const r = computeFreigabeChargeThrottle({
    now: BASE_TS,
    windowEndTs,
    currentSocPct: 50,
    batteryCapacityKwh: 43,
    pvSlots: pv,
    loadSlots: [],
    epexSlots: epex,
    batteryVoltageV: 55.2,
    maxChargeCurrentA: 350,
    inverterEfficiencyPct: 90
  });
  assert.equal(r.rules.length, 4);
  assert.equal(r.rules[0].throttled, false, 'slot 0 negative price => released');
  assert.equal(r.rules[1].throttled, true,  'slot 1 positive price => throttled');
  assert.equal(r.rules[2].throttled, false, 'slot 2 negative price => released');
  assert.equal(r.rules[3].throttled, true,  'slot 3 positive price => throttled');
  // Negative-price slots run at HW max.
  assert.equal(r.rules[0].chargeCurrentA, 350);
  assert.equal(r.rules[2].chargeCurrentA, 350);
});

test('computeFreigabeChargeThrottle aligns slot grid to quarter-hour boundary', () => {
  // now sits 7 minutes into a quarter — the first slot must skip forward to
  // the next quarter, not start off-grid like the LEEREN loop did (the bug we
  // diagnosed on prod 2026-05-22 morning).
  const now = BASE_TS + 7 * 60 * 1000; // BASE_TS + 0:07
  const windowEndTs = BASE_TS + 4 * SLOT_MS;
  const pv = [0,1,2,3].map(i => pvSlotAt(i, 40000, 0.5));
  const r = computeFreigabeChargeThrottle({
    now,
    windowEndTs,
    currentSocPct: 50,
    batteryCapacityKwh: 43,
    pvSlots: pv,
    loadSlots: [],
    epexSlots: [0,1,2,3].map(i => slotAt(i, 5)),
    batteryVoltageV: 55.2,
    maxChargeCurrentA: 350,
    inverterEfficiencyPct: 90
  });
  assert.ok(r.rules.length > 0, 'must emit at least one rule');
  const firstSlot = r.rules[0].slotTs;
  assert.equal(firstSlot % SLOT_MS, 0, `first slotTs ${firstSlot} not aligned to quarter`);
  assert.equal(firstSlot, BASE_TS + SLOT_MS, 'first slot should be the next quarter after BASE_TS');
});

test('computeFreigabeChargeThrottle emits no rules when SOC is already full', () => {
  const r = computeFreigabeChargeThrottle({
    now: BASE_TS,
    windowEndTs: BASE_TS + 4 * SLOT_MS,
    currentSocPct: 100,
    batteryCapacityKwh: 43,
    pvSlots: [pvSlotAt(0, 40000, 0.5)],
    loadSlots: [],
    epexSlots: [slotAt(0, 5)],
    batteryVoltageV: 55.2,
    maxChargeCurrentA: 100
  });
  assert.equal(r.rules.length, 0);
  assert.equal(r.reason, 'already_full');
});

