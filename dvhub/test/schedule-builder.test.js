// test/schedule-builder.test.js -- Unit tests for schedule-builder.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScheduleRules, insertOptimizerRules } from '../services/optimizer/schedule-builder.js';

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
