import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createDvState } from '../modules/dv/dv-state.js';
import { createCurtailmentManager } from '../modules/dv/curtailment.js';

describe('createCurtailmentManager', () => {
  let state, emitter, mgr;
  const OFF_LEASE_MS = 480_000; // 8 minutes

  function mockEmitter() {
    const calls = [];
    return {
      emitCurtailment(feedIn, reason) { calls.push({ feedIn, reason }); },
      calls
    };
  }

  beforeEach(() => {
    state = createDvState();
    emitter = mockEmitter();
    mgr = createCurtailmentManager({ state, emitter, offLeaseMs: OFF_LEASE_MS });
  });

  afterEach(() => {
    mgr.destroy();
  });

  it('returns object with setForcedOff, clearForcedOff, controlValue, startLeaseTimer, stopLeaseTimer', () => {
    assert.strictEqual(typeof mgr.setForcedOff, 'function');
    assert.strictEqual(typeof mgr.clearForcedOff, 'function');
    assert.strictEqual(typeof mgr.controlValue, 'function');
    assert.strictEqual(typeof mgr.startLeaseTimer, 'function');
    assert.strictEqual(typeof mgr.stopLeaseTimer, 'function');
  });

  it('setForcedOff sets state and calls emitter', () => {
    const before = Date.now();
    mgr.setForcedOff('test_reason');

    assert.strictEqual(state.ctrl.forcedOff, true);
    assert.ok(state.ctrl.offUntil >= before + OFF_LEASE_MS);
    assert.strictEqual(state.ctrl.lastSignal, 'test_reason');
    assert.ok(state.ctrl.updatedAt >= before);
    assert.strictEqual(emitter.calls.length, 1);
    assert.deepStrictEqual(emitter.calls[0], { feedIn: false, reason: 'test_reason' });
  });

  it('clearForcedOff clears state and calls emitter', () => {
    mgr.setForcedOff('initial');
    const before = Date.now();
    mgr.clearForcedOff('clear_reason');

    assert.strictEqual(state.ctrl.forcedOff, false);
    assert.strictEqual(state.ctrl.offUntil, 0);
    assert.strictEqual(state.ctrl.lastSignal, 'clear_reason');
    assert.ok(state.ctrl.updatedAt >= before);
    assert.strictEqual(emitter.calls.length, 2);
    assert.deepStrictEqual(emitter.calls[1], { feedIn: true, reason: 'clear_reason' });
  });

  it('controlValue returns 0 when forcedOff=true', () => {
    mgr.setForcedOff('test');
    assert.strictEqual(mgr.controlValue(), 0);
  });

  it('controlValue returns 1 when forcedOff=false', () => {
    assert.strictEqual(mgr.controlValue(), 1);
  });

  it('controlValue expires lease and emits release intent', () => {
    mgr.setForcedOff('test');
    // Force offUntil to be in the past
    state.ctrl.offUntil = Date.now() - 1;

    const val = mgr.controlValue();
    assert.strictEqual(val, 1);
    assert.strictEqual(state.ctrl.forcedOff, false);
    assert.strictEqual(state.ctrl.lastSignal, 'lease_expired');
    // emitter.calls: [0] = setForcedOff, [1] = lease_expired
    assert.strictEqual(emitter.calls.length, 2);
    assert.deepStrictEqual(emitter.calls[1], { feedIn: true, reason: 'lease_expired' });
  });

  it('startLeaseTimer starts periodic check, stopLeaseTimer clears it', () => {
    // Just verify start/stop don't throw
    mgr.startLeaseTimer();
    mgr.stopLeaseTimer();
  });

  it('after destroy, no further lease expiry checks run', () => {
    mgr.startLeaseTimer();
    mgr.destroy();
    // Verify timer is cleared (no throw, no lingering intervals)
    // Calling destroy again should be safe
    mgr.destroy();
  });
});
