/**
 * Curtailment Manager
 *
 * Manages DV curtailment state with lease-based expiry.
 * Replaces the gateway's setForcedOff/clearForcedOff/expireLeaseIfNeeded
 * with structured intent emission instead of direct hardware writes.
 */

const DEFAULT_OFF_LEASE_MS = 480_000; // 8 minutes
const LEASE_CHECK_INTERVAL_MS = 1000;

/**
 * Creates a curtailment manager.
 * @param {object} opts
 * @param {object} opts.state - DV state (from createDvState)
 * @param {object} opts.emitter - Intent emitter (from createIntentEmitter)
 * @param {number} [opts.offLeaseMs=480000] - Lease duration in ms
 * @param {object} [opts.log] - Optional logger
 * @returns {object} Manager with setForcedOff, clearForcedOff, controlValue, startLeaseTimer, stopLeaseTimer, destroy
 */
export function createCurtailmentManager({ state, emitter, offLeaseMs, log }) {
  const leaseMs = offLeaseMs ?? DEFAULT_OFF_LEASE_MS;
  let leaseTimer = null;

  function expireLeaseIfNeeded() {
    if (state.ctrl.forcedOff && Date.now() > state.ctrl.offUntil) {
      state.ctrl.forcedOff = false;
      state.ctrl.offUntil = 0;
      state.ctrl.lastSignal = 'lease_expired';
      state.ctrl.updatedAt = Date.now();
      emitter.emitCurtailment(true, 'lease_expired');
      log?.info?.('Curtailment lease expired');
    }
  }

  return {
    /**
     * Set forced-off state with lease.
     * @param {string} reason
     */
    setForcedOff(reason) {
      state.ctrl.forcedOff = true;
      state.ctrl.offUntil = Date.now() + leaseMs;
      state.ctrl.lastSignal = reason;
      state.ctrl.updatedAt = Date.now();
      emitter.emitCurtailment(false, reason);
      log?.info?.({ reason, offUntil: new Date(state.ctrl.offUntil).toISOString() }, 'Curtailment set');
    },

    /**
     * Clear forced-off state.
     * @param {string} reason
     */
    clearForcedOff(reason) {
      state.ctrl.forcedOff = false;
      state.ctrl.offUntil = 0;
      state.ctrl.lastSignal = reason;
      state.ctrl.updatedAt = Date.now();
      emitter.emitCurtailment(true, reason);
      log?.info?.({ reason }, 'Curtailment cleared');
    },

    /**
     * Get current control value (0 = curtailed, 1 = normal).
     * Automatically expires lease if needed.
     * @returns {number} 0 or 1
     */
    controlValue() {
      expireLeaseIfNeeded();
      return state.ctrl.forcedOff ? 0 : 1;
    },

    /**
     * Start periodic lease expiry check.
     */
    startLeaseTimer() {
      if (leaseTimer) return;
      leaseTimer = setInterval(expireLeaseIfNeeded, LEASE_CHECK_INTERVAL_MS);
      if (leaseTimer.unref) leaseTimer.unref();
    },

    /**
     * Stop periodic lease expiry check.
     */
    stopLeaseTimer() {
      if (leaseTimer) {
        clearInterval(leaseTimer);
        leaseTimer = null;
      }
    },

    /**
     * Clean up resources.
     */
    destroy() {
      if (leaseTimer) {
        clearInterval(leaseTimer);
        leaseTimer = null;
      }
    }
  };
}
