import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldAlarmTelemetryDown } from '../server-utils.js';

// T-0080 (P1 sweep): the T-0106 telemetry outage was SILENT. This helper decides
// when to raise a throttled telemetry-DOWN alarm: only when CONFIGURED-but-down.

const NOW = 2_000_000_000;
const THROTTLE = 300_000;

test('not configured → never alarms (telemetry intentionally off)', () => {
  assert.equal(shouldAlarmTelemetryDown({ configured: false, healthy: false, lastAlarmAt: 0, nowMs: NOW, throttleMs: THROTTLE }), false);
});

test('configured + healthy → no alarm', () => {
  assert.equal(shouldAlarmTelemetryDown({ configured: true, healthy: true, lastAlarmAt: 0, nowMs: NOW, throttleMs: THROTTLE }), false);
});

test('configured + down + no prior alarm → alarm', () => {
  assert.equal(shouldAlarmTelemetryDown({ configured: true, healthy: false, lastAlarmAt: 0, nowMs: NOW, throttleMs: THROTTLE }), true);
});

test('configured + down but within throttle window → suppressed', () => {
  assert.equal(shouldAlarmTelemetryDown({ configured: true, healthy: false, lastAlarmAt: NOW - 1000, nowMs: NOW, throttleMs: THROTTLE }), false);
});

test('configured + down at exactly throttleMs since last → alarm (>=)', () => {
  assert.equal(shouldAlarmTelemetryDown({ configured: true, healthy: false, lastAlarmAt: NOW - THROTTLE, nowMs: NOW, throttleMs: THROTTLE }), true);
});
