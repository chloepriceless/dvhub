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
  resolveStage2Phase
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

// --- preEmptySlotSetpointW (D-12 / D-17) ---

test('preEmptySlotSetpointW: AC limit binds (Example A) -> aggressiveExport at -16000 W', () => {
  // 8 kW PV, 4 kW load, AC cap -16 kW, akku cap 20 kW.
  // acBatteryShare = 16000-8000 = 8000 ; dcBatteryShare = 20000-4000 = 16000
  // batteryShare = min(8000,16000) = 8000 ; gridSetpointW = -(8000+8000) = -16000
  const r = preEmptySlotSetpointW({
    pvForecastW: 8000,
    expectedHouseLoadW: 4000,
    maxDischargeW: -16000,
    akkuHardLimitW: 20000,
    pvHeadroomFracW: 0
  });
  assert.equal(r.gridSetpointW, -16000);
  assert.equal(r.mode, 'aggressiveExport');
});

test('preEmptySlotSetpointW: Akku limit binds (operator scenario) -> dcDischarge clamped at the akku limit', () => {
  // 0 kW PV, 4 kW load, AC cap -16 kW, akku cap 14 kW (low -> the DC side binds).
  // acBatteryShare = 16000-0 = 16000 ; dcBatteryShare = 14000-4000 = 10000
  // batteryShare = min(16000,10000) = 10000 -> implied battery discharge clamps at 14000.
  const r = preEmptySlotSetpointW({
    pvForecastW: 0,
    expectedHouseLoadW: 4000,
    maxDischargeW: -16000,
    akkuHardLimitW: 14000,
    pvHeadroomFracW: 0
  });
  assert.ok(r.impliedBatteryDischargeW <= 14000,
    `implied battery discharge clamped at akkuHardLimitW 14000, got ${r.impliedBatteryDischargeW}`);
  assert.equal(r.mode, 'dcDischarge');
});

test('preEmptySlotSetpointW invariant: implied battery discharge never exceeds akkuHardLimitW', () => {
  const cases = [
    { pvForecastW: 8000, expectedHouseLoadW: 4000, maxDischargeW: -16000, akkuHardLimitW: 20000, pvHeadroomFracW: 0 },
    { pvForecastW: 0, expectedHouseLoadW: 4000, maxDischargeW: -16000, akkuHardLimitW: 14000, pvHeadroomFracW: 0 },
    { pvForecastW: 2000, expectedHouseLoadW: 6000, maxDischargeW: -16000, akkuHardLimitW: 12000, pvHeadroomFracW: 500 },
    { pvForecastW: 0, expectedHouseLoadW: 0, maxDischargeW: -16000, akkuHardLimitW: 16000, pvHeadroomFracW: 0 }
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
