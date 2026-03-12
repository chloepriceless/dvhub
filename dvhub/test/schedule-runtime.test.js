import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  autoDisableStopSocScheduleRules,
  autoDisableExpiredScheduleRules,
  parseHHMM,
  sanitizePersistedScheduleRules
} from '../schedule-runtime.js';

const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));

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

test('sanitizePersistedScheduleRules keeps stopSocPct while removing transient fields', () => {
  const cleaned = sanitizePersistedScheduleRules([
    {
      id: 'grid-stop',
      enabled: true,
      target: 'gridSetpointW',
      start: '08:00',
      end: '09:00',
      value: -40,
      stopSocPct: 25,
      _wasActive: true
    }
  ]);

  assert.deepEqual(cleaned, [
    {
      id: 'grid-stop',
      enabled: true,
      target: 'gridSetpointW',
      start: '08:00',
      end: '09:00',
      value: -40,
      stopSocPct: 25
    }
  ]);
});

test('sanitizePersistedScheduleRules keeps automation metadata for dated one-shot rules', () => {
  const cleaned = sanitizePersistedScheduleRules([
    {
      id: 'sma-1',
      enabled: true,
      target: 'gridSetpointW',
      start: '18:15',
      end: '18:30',
      value: -12000,
      activeDate: '2026-06-02',
      source: 'small_market_automation',
      autoManaged: true,
      displayTone: 'yellow'
    }
  ]);

  assert.equal(cleaned[0].source, 'small_market_automation');
  assert.equal(cleaned[0].autoManaged, true);
  assert.equal(cleaned[0].displayTone, 'yellow');
  assert.equal(cleaned[0].activeDate, '2026-06-02');
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

test('autoDisableStopSocScheduleRules disables only the active grid rule when soc reaches the stop threshold', () => {
  const result = autoDisableStopSocScheduleRules({
    rules: [
      {
        id: 'grid-stop',
        enabled: true,
        target: 'gridSetpointW',
        start: '08:00',
        end: '09:00',
        value: -40,
        stopSocPct: 25
      },
      {
        id: 'charge-same-slot',
        enabled: true,
        target: 'chargeCurrentA',
        start: '08:00',
        end: '09:00',
        value: 80
      }
    ],
    nowMin: parseHHMM('08:30'),
    batterySocPct: 24
  });

  assert.equal(result.changed, true);
  assert.deepEqual(result.disabledRuleIds, ['grid-stop']);
  assert.deepEqual(result.rules, [
    {
      id: 'grid-stop',
      enabled: false,
      target: 'gridSetpointW',
      start: '08:00',
      end: '09:00',
      value: -40,
      stopSocPct: 25
    },
    {
      id: 'charge-same-slot',
      enabled: true,
      target: 'chargeCurrentA',
      start: '08:00',
      end: '09:00',
      value: 80
    }
  ]);
});

test('autoDisableStopSocScheduleRules ignores missing soc or non-grid rules', () => {
  const originalRules = [
    {
      id: 'charge-only',
      enabled: true,
      target: 'chargeCurrentA',
      start: '08:00',
      end: '09:00',
      value: 80
    },
    {
      id: 'grid-stop',
      enabled: true,
      target: 'gridSetpointW',
      start: '08:00',
      end: '09:00',
      value: -40,
      stopSocPct: 25
    }
  ];

  const result = autoDisableStopSocScheduleRules({
    rules: originalRules,
    nowMin: parseHHMM('08:30'),
    batterySocPct: null
  });

  assert.equal(result.changed, false);
  assert.deepEqual(result.disabledRuleIds, []);
  assert.deepEqual(result.rules, originalRules);
});

test('server schedule evaluator wires stop-soc auto-disable and dedicated logging', () => {
  const source = fs.readFileSync(serverPath, 'utf8');

  assert.match(source, /autoDisableStopSocScheduleRules/);
  assert.match(source, /schedule_stop_soc_reached/);
  assert.match(source, /batterySocPct:\s*state\.victron\.soc/);
});
