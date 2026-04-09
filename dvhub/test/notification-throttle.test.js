// test/notification-throttle.test.js -- Throttle + quiet hours unit tests (INTG-07)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isThrottled, isInQuietHours } from '../services/notifications/index.js';

// ---------- isThrottled ----------

describe('isThrottled', () => {

  it('returns false when event never fired', () => {
    const lastFired = new Map();
    assert.equal(isThrottled('soc_low', Date.now(), 300, lastFired), false);
  });

  it('returns true within minIntervalSec', () => {
    const now = Date.now();
    const lastFired = new Map([['soc_low', now - 100_000]]); // 100s ago
    assert.equal(isThrottled('soc_low', now, 300, lastFired), true); // 300s interval
  });

  it('returns false after minIntervalSec elapsed', () => {
    const now = Date.now();
    const lastFired = new Map([['soc_low', now - 301_000]]); // 301s ago
    assert.equal(isThrottled('soc_low', now, 300, lastFired), false); // 300s interval
  });

  it('different event types are independent', () => {
    const now = Date.now();
    const lastFired = new Map([['soc_low', now - 10_000]]); // 10s ago
    assert.equal(isThrottled('soc_low', now, 300, lastFired), true);
    assert.equal(isThrottled('negative_price', now, 300, lastFired), false);
  });
});

// ---------- isInQuietHours ----------

describe('isInQuietHours', () => {

  it('returns true when time is within same-day range', () => {
    assert.equal(isInQuietHours('14:30', '14:00', '16:00'), true);
  });

  it('returns false when time is outside same-day range', () => {
    assert.equal(isInQuietHours('13:00', '14:00', '16:00'), false);
  });

  it('handles cross-midnight range (22:00-07:00)', () => {
    assert.equal(isInQuietHours('23:00', '22:00', '07:00'), true);
    assert.equal(isInQuietHours('03:00', '22:00', '07:00'), true);
    assert.equal(isInQuietHours('12:00', '22:00', '07:00'), false);
    assert.equal(isInQuietHours('08:00', '22:00', '07:00'), false);
  });

  it('boundary: exact start is within quiet hours', () => {
    assert.equal(isInQuietHours('22:00', '22:00', '07:00'), true);
  });

  it('boundary: exact end is NOT within quiet hours', () => {
    assert.equal(isInQuietHours('07:00', '22:00', '07:00'), false);
  });

  it('returns false when start equals end (disabled)', () => {
    assert.equal(isInQuietHours('14:00', '00:00', '00:00'), false);
  });
});

// ---------- SOC hysteresis ----------

describe('SOC hysteresis', () => {

  it('soc_low clears at threshold + 5 (no re-trigger until cleared)', async () => {
    // Import the service for hysteresis testing
    const { createNotificationService } = await import('../services/notifications/index.js');

    const dispatched = [];
    const mockProvider = {
      type: 'telegram',
      notify: async (msg) => { dispatched.push(msg); return { ok: true }; }
    };

    const svc = createNotificationService({
      getCfg: () => ({
        notifications: {
          enabled: true,
          providers: { telegram: { enabled: true, botToken: 'tok', chatId: '1' } },
          triggers: [{ event: 'soc_low', threshold: 15, channels: ['telegram'], level: 'warning' }],
          throttle: { minIntervalSec: 0, quietHoursStart: '00:00', quietHoursEnd: '00:00' }
        }
      }),
      pushLog: () => {},
      state: {}
    });

    svc._setProviders({ telegram: mockProvider });

    const now = Date.now();

    // First: SOC at 10 -- should trigger
    await svc.evaluate({ victron: { soc: 10 } }, now);
    assert.equal(dispatched.length, 1, 'first trigger should fire');

    // Second: SOC at 12 -- still below threshold, but hysteresis prevents re-trigger
    await svc.evaluate({ victron: { soc: 12 } }, now + 1000);
    assert.equal(dispatched.length, 1, 'should NOT re-trigger within hysteresis band');

    // Third: SOC recovers to 20 (threshold + 5 = 20) -- clears hysteresis
    await svc.evaluate({ victron: { soc: 20 } }, now + 2000);
    assert.equal(dispatched.length, 1, 'recovery should not trigger notification');

    // Fourth: SOC drops below threshold again -- should trigger
    await svc.evaluate({ victron: { soc: 10 } }, now + 3000);
    assert.equal(dispatched.length, 2, 'should trigger again after hysteresis cleared');
  });
});

// ---------- Quiet hours + critical bypass ----------

describe('Quiet hours critical bypass', () => {

  it('critical notifications bypass quiet hours', async () => {
    const { createNotificationService } = await import('../services/notifications/index.js');

    const dispatched = [];
    const mockProvider = {
      type: 'telegram',
      notify: async (msg) => { dispatched.push(msg); return { ok: true }; }
    };

    const svc = createNotificationService({
      getCfg: () => ({
        notifications: {
          enabled: true,
          providers: { telegram: { enabled: true, botToken: 'tok', chatId: '1' } },
          triggers: [{ event: 'soc_low', threshold: 15, channels: ['telegram'], level: 'critical' }],
          throttle: { minIntervalSec: 0, quietHoursStart: '00:00', quietHoursEnd: '23:59' } // always quiet
        }
      }),
      pushLog: () => {},
      state: {}
    });

    svc._setProviders({ telegram: mockProvider });

    // Even during "always quiet hours", critical should still fire
    await svc.evaluate({ victron: { soc: 5 } }, Date.now());
    assert.ok(dispatched.length >= 1, 'critical notification should bypass quiet hours');
  });
});
