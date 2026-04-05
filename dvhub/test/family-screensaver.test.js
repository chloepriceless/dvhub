// test/family-screensaver.test.js -- Pure-function tests for screensaver time-window logic.
// Covers D-16 (in-dashboard dimming), D-17 (time-window configurable timeout).
// State machine (enterScreensaver/exitScreensaver) is verified via the human checkpoint
// in Plan 03-03 Task 3 — node:test cannot exercise DOM-bound event listeners reliably.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isInWindow, getActiveTimeout } from '../public/family-screensaver-logic.js';

describe('family screensaver time-window logic (D-17)', () => {
  it('isInWindow: same-day window, time inside', () => {
    assert.equal(isInWindow('12:00', '08:00', '18:00'), true);
  });

  it('isInWindow: same-day window, time before', () => {
    assert.equal(isInWindow('06:00', '08:00', '18:00'), false);
  });

  it('isInWindow: same-day window, time after', () => {
    assert.equal(isInWindow('20:00', '08:00', '18:00'), false);
  });

  it('isInWindow: cross-midnight window, late evening', () => {
    assert.equal(isInWindow('23:30', '22:00', '06:00'), true);
  });

  it('isInWindow: cross-midnight window, early morning', () => {
    assert.equal(isInWindow('05:30', '22:00', '06:00'), true);
  });

  it('isInWindow: cross-midnight window, daytime', () => {
    assert.equal(isInWindow('14:00', '22:00', '06:00'), false);
  });

  it('isInWindow: cross-midnight window, exact end time (exclusive)', () => {
    assert.equal(isInWindow('06:00', '22:00', '06:00'), false);
  });

  it('getActiveTimeout: no windows returns default', () => {
    assert.equal(getActiveTimeout({ defaultTimeoutSec: 120, windows: [] }, '14:00'), 120);
  });

  it('getActiveTimeout: matching window returns its timeout', () => {
    assert.equal(
      getActiveTimeout({ defaultTimeoutSec: 120, windows: [{ start: '22:00', end: '06:00', timeoutSec: 60 }] }, '23:30'),
      60
    );
  });

  it('getActiveTimeout: non-matching window falls back to default', () => {
    assert.equal(
      getActiveTimeout({ defaultTimeoutSec: 120, windows: [{ start: '22:00', end: '06:00', timeoutSec: 60 }] }, '14:00'),
      120
    );
  });

  it('getActiveTimeout: window with timeoutSec=0 means disabled in that window', () => {
    assert.equal(
      getActiveTimeout({ defaultTimeoutSec: 120, windows: [{ start: '08:00', end: '18:00', timeoutSec: 0 }] }, '10:00'),
      0
    );
  });

  it('getActiveTimeout: globally disabled returns 0', () => {
    assert.equal(getActiveTimeout({ enabled: false, defaultTimeoutSec: 120, windows: [] }, '14:00'), 0);
  });

  it('getActiveTimeout: missing cfg returns 0 (safe fallback)', () => {
    assert.equal(getActiveTimeout(null, '14:00'), 0);
    assert.equal(getActiveTimeout(undefined, '14:00'), 0);
  });

  it('getActiveTimeout: multiple windows — first match wins, default on no match', () => {
    const cfg = {
      defaultTimeoutSec: 120,
      windows: [
        { start: '22:00', end: '06:00', timeoutSec: 60 },
        { start: '08:00', end: '18:00', timeoutSec: 0 }
      ]
    };
    assert.equal(getActiveTimeout(cfg, '23:30'), 60);
    assert.equal(getActiveTimeout(cfg, '10:00'), 0);
    assert.equal(getActiveTimeout(cfg, '19:00'), 120);
  });
});
