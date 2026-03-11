import test from 'node:test';
import assert from 'node:assert/strict';

import {
  autoDisableExpiredScheduleRules,
  parseHHMM,
  sanitizePersistedScheduleRules
} from '../schedule-runtime.js';

test('sanitizePersistedScheduleRules removes transient and legacy fields', () => {
  const cleaned = sanitizePersistedScheduleRules([
    {
      id: 'legacy',
      enabled: true,
      target: 'gridSetpointW',
      start: '08:00',
      end: '09:00',
      value: -40,
      _wasActive: true,
      days: [1, 2],
      oneTime: true
    }
  ]);

  assert.deepEqual(cleaned, [
    {
      id: 'legacy',
      enabled: true,
      target: 'gridSetpointW',
      start: '08:00',
      end: '09:00',
      value: -40
    }
  ]);
});

test('autoDisableExpiredScheduleRules disables a previously active one-shot rule after the window ends', () => {
  const result = autoDisableExpiredScheduleRules([
    {
      id: 'oneshot',
      enabled: true,
      target: 'gridSetpointW',
      start: '08:00',
      end: '09:00',
      value: -40,
      _wasActive: true
    }
  ], parseHHMM('09:00'));

  assert.equal(result.changed, true);
  assert.deepEqual(result.rules, [
    {
      id: 'oneshot',
      enabled: false,
      target: 'gridSetpointW',
      start: '08:00',
      end: '09:00',
      value: -40
    }
  ]);
});

test('autoDisableExpiredScheduleRules keeps an active rule enabled while its window is still open', () => {
  const result = autoDisableExpiredScheduleRules([
    {
      id: 'oneshot',
      enabled: true,
      target: 'gridSetpointW',
      start: '08:00',
      end: '09:00',
      value: -40,
      _wasActive: true
    }
  ], parseHHMM('08:30'));

  assert.equal(result.changed, false);
  assert.deepEqual(result.rules, [
    {
      id: 'oneshot',
      enabled: true,
      target: 'gridSetpointW',
      start: '08:00',
      end: '09:00',
      value: -40,
      _wasActive: true
    }
  ]);
});
