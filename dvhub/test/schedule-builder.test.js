// test/schedule-builder.test.js -- Unit tests for schedule-builder.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScheduleRules, insertOptimizerRules, optimizerSlotsToGridSetpoints } from '../services/optimizer/schedule-builder.js';

// Helper: create a mock getCfg returning configurable timezone
function mockGetCfg(tz = 'Europe/Berlin') {
  return () => ({ schedule: { timezone: tz } });
}

// Fixed timestamps for deterministic tests (2026-04-03 02:00 UTC = 04:00 CEST)
const BASE_TS = new Date('2026-04-03T02:00:00Z').getTime();
const QUARTER_MS = 15 * 60 * 1000;

function makeSlots(count = 2) {
  return Array.from({ length: count }, (_, i) => ({
    ts: BASE_TS + i * QUARTER_MS,
    endTs: BASE_TS + (i + 1) * QUARTER_MS,
    powerW: 3000,
    confidence: 0.85
  }));
}

test('buildScheduleRules converts optimizer slots to rule objects with correct shape', () => {
  const slots = makeSlots(1);
  const rules = buildScheduleRules({ slots, getCfg: mockGetCfg() });

  assert.equal(rules.length, 1);
  const r = rules[0];
  assert.equal(r.enabled, true);
  assert.equal(r.target, 'gridSetpointW');
  assert.equal(r.value, 3000);
  assert.equal(r.slotTs, slots[0].ts);
  assert.equal(r.slotEndTs, slots[0].endTs);
  assert.equal(r.autoManaged, true);
  assert.equal(r.confidence, 0.85);
  assert.equal(typeof r.start, 'string');
  assert.equal(typeof r.end, 'string');
  assert.ok(r.start.match(/^\d{2}:\d{2}$/), 'start is HH:MM format');
  assert.ok(r.end.match(/^\d{2}:\d{2}$/), 'end is HH:MM format');
});

test('buildScheduleRules uses source=forecast_optimizer and displayTone=blue', () => {
  const slots = makeSlots(1);
  const rules = buildScheduleRules({ slots, getCfg: mockGetCfg() });
  const r = rules[0];
  assert.equal(r.source, 'forecast_optimizer');
  assert.equal(r.displayTone, 'blue');
  assert.equal(r.optimizer, 'internal');
});

test('buildScheduleRules id format is opt-{slotTs}-{index}', () => {
  const slots = makeSlots(3);
  const rules = buildScheduleRules({ slots, getCfg: mockGetCfg() });
  assert.equal(rules[0].id, `opt-${slots[0].ts}-0`);
  assert.equal(rules[1].id, `opt-${slots[1].ts}-1`);
  assert.equal(rules[2].id, `opt-${slots[2].ts}-2`);
});

test('insertOptimizerRules replaces old rules with same source and prepends new rules', () => {
  const oldRules = [
    { id: 'opt-111-0', source: 'forecast_optimizer', value: 1000 },
    { id: 'sma-222-1', source: 'small_market_automation', value: -40 },
    { id: 'manual-1', source: 'manual', value: 500 }
  ];
  const newRules = [
    { id: 'opt-333-0', source: 'forecast_optimizer', value: 3000 }
  ];
  const result = insertOptimizerRules(oldRules, newRules, 'forecast_optimizer');

  // New rules first, then kept non-optimizer rules
  assert.equal(result.length, 3);
  assert.equal(result[0].id, 'opt-333-0');
  assert.equal(result[1].id, 'sma-222-1');
  assert.equal(result[2].id, 'manual-1');
  // Old optimizer rule removed
  assert.ok(!result.find(r => r.id === 'opt-111-0'));
});

test('formatHHMM uses configurable timezone, NOT hardcoded Europe/Berlin', () => {
  // 2026-04-03 02:00 UTC = 04:00 Europe/Berlin (CEST, UTC+2)
  // 2026-04-03 02:00 UTC = 11:00 Asia/Tokyo (JST, UTC+9)
  const slots = makeSlots(1);

  const berlinRules = buildScheduleRules({ slots, getCfg: mockGetCfg('Europe/Berlin') });
  const tokyoRules = buildScheduleRules({ slots, getCfg: mockGetCfg('Asia/Tokyo') });

  assert.equal(berlinRules[0].start, '04:00');
  assert.equal(tokyoRules[0].start, '11:00');
  assert.notEqual(berlinRules[0].start, tokyoRules[0].start);
});

test('buildScheduleRules with custom optimizer name', () => {
  const slots = makeSlots(1);
  const rules = buildScheduleRules({ slots, optimizer: 'eos', getCfg: mockGetCfg() });
  assert.equal(rules[0].optimizer, 'eos');
});

// --- T-0118 optimizerSlotsToGridSetpoints (battery dispatch → grid setpoint) ---

function slotAt(i, powerW) {
  return { ts: BASE_TS + i * QUARTER_MS, endTs: BASE_TS + (i + 1) * QUARTER_MS, powerW, confidence: 0.9 };
}

test('T-0118: pure self-consumption discharge (battery covers load deficit) → NO rule', () => {
  // discharge 3000 W, load 3000 W, PV 0 → net grid = 3000 - 0 - 3000 = 0 → self-consumption
  const slots = [slotAt(0, -3000)];
  const pv = [{ ts: BASE_TS, endTs: BASE_TS + QUARTER_MS, powerW: 0 }];
  const load = [{ ts: BASE_TS, endTs: BASE_TS + QUARTER_MS, powerW: 3000 }];
  const out = optimizerSlotsToGridSetpoints(slots, pv, load);
  assert.equal(out.length, 0, 'self-consumption slot must be dropped (no forced setpoint)');
});

test('T-0118: self-consumption with PV (discharge = load − PV) → NO rule', () => {
  // discharge 2000 W, load 3000 W, PV 1000 → net grid = 3000 - 1000 - 2000 = 0
  const slots = [slotAt(0, -2000)];
  const pv = [{ ts: BASE_TS, endTs: BASE_TS + QUARTER_MS, powerW: 1000 }];
  const load = [{ ts: BASE_TS, endTs: BASE_TS + QUARTER_MS, powerW: 3000 }];
  assert.equal(optimizerSlotsToGridSetpoints(slots, pv, load).length, 0);
});

test('T-0118: genuine arbitrage export (discharge beyond load) → grid setpoint = net export', () => {
  // discharge 16000 W, load 2000 W, PV 0 → net grid = 2000 - 0 - 16000 = -14000 (export 14 kW)
  const slots = [slotAt(0, -16000)];
  const pv = [{ ts: BASE_TS, endTs: BASE_TS + QUARTER_MS, powerW: 0 }];
  const load = [{ ts: BASE_TS, endTs: BASE_TS + QUARTER_MS, powerW: 2000 }];
  const out = optimizerSlotsToGridSetpoints(slots, pv, load);
  assert.equal(out.length, 1);
  assert.equal(out[0].powerW, -14000, 'export setpoint is the net grid, not the raw battery power');
});

test('T-0118: small discharge within the band → NO rule (noise/self-consumption)', () => {
  // net grid = 0 - 0 + (-200) = -200, |200| <= 300 band → dropped
  assert.equal(optimizerSlotsToGridSetpoints([slotAt(0, -200)], [], []).length, 0);
});

test('T-0118: no PV/load context → grid setpoint falls back to raw powerW (band still applies)', () => {
  // -1000 with no context → grid = -1000 (emit); -200 → dropped
  const out = optimizerSlotsToGridSetpoints([slotAt(0, -1000), slotAt(1, -200)], [], []);
  assert.equal(out.length, 1);
  assert.equal(out[0].powerW, -1000);
});

test('T-0118: original slot fields (ts/endTs/confidence) are preserved on emitted slots', () => {
  const out = optimizerSlotsToGridSetpoints([slotAt(0, -16000)], [], [{ ts: BASE_TS, endTs: BASE_TS + QUARTER_MS, powerW: 0 }]);
  assert.equal(out[0].ts, BASE_TS);
  assert.equal(out[0].endTs, BASE_TS + QUARTER_MS);
  assert.equal(out[0].confidence, 0.9);
});

// ── Operator slot-disable (2026-06-12) ──────────────────────────────────────

test('insertOptimizerRules inherits enabled:false onto the replanned rule for the same slot', () => {
  const oldRules = [
    { id: 'opt-111-0', source: 'forecast_optimizer', target: 'gridSetpointW', slotTs: 111, enabled: false, value: -3000 },
    { id: 'opt-222-1', source: 'forecast_optimizer', target: 'gridSetpointW', slotTs: 222, enabled: true, value: -2000 }
  ];
  const newRules = [
    { id: 'opt-111-7', source: 'forecast_optimizer', target: 'gridSetpointW', slotTs: 111, enabled: true, value: -3500 },
    { id: 'opt-222-8', source: 'forecast_optimizer', target: 'gridSetpointW', slotTs: 222, enabled: true, value: -2500 },
    { id: 'opt-333-9', source: 'forecast_optimizer', target: 'gridSetpointW', slotTs: 333, enabled: true, value: -1000 }
  ];
  const result = insertOptimizerRules(oldRules, newRules, 'forecast_optimizer');

  assert.equal(result.find(r => r.slotTs === 111).enabled, false, 'operator disable survives the replan');
  assert.equal(result.find(r => r.slotTs === 222).enabled, true, 'enabled slot stays enabled');
  assert.equal(result.find(r => r.slotTs === 333).enabled, true, 'new slot unaffected');
  // Input rules are never mutated (atomic replacement contract)
  assert.equal(newRules[0].enabled, true);
});

test('insertOptimizerRules disable-inheritance keys on slotTs AND target — no cross-target bleed', () => {
  const oldRules = [
    { id: 'opt-111-0', source: 'forecast_optimizer', target: 'dcExportMode', slotTs: 111, enabled: false, value: 1 }
  ];
  const newRules = [
    { id: 'opt-111-5', source: 'forecast_optimizer', target: 'gridSetpointW', slotTs: 111, enabled: true, value: -3000 }
  ];
  const result = insertOptimizerRules(oldRules, newRules, 'forecast_optimizer');
  assert.equal(result[0].enabled, true, 'different target on the same slot must NOT inherit the disable');
});

test('isForecastOptimizerRule matches source and opt- id prefix, rejects SMA/manual', async () => {
  const { isForecastOptimizerRule } = await import('../services/optimizer/schedule-builder.js');
  assert.equal(isForecastOptimizerRule({ source: 'forecast_optimizer' }), true);
  assert.equal(isForecastOptimizerRule({ id: 'opt-123-0' }), true);
  assert.equal(isForecastOptimizerRule({ id: 'sma-123-0', source: 'small_market_automation' }), false);
  assert.equal(isForecastOptimizerRule({ id: 'grid_1' }), false);
  assert.equal(isForecastOptimizerRule(null), false);
});
