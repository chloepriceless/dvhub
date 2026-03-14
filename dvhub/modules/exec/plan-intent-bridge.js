/**
 * Plan-Intent Bridge
 *
 * Converts active optimizer plan slots into control:intent events.
 * Subscribes to the plan engine's active plan stream and emits
 * optimizer intents (priority 4) for the current time slot.
 */

/**
 * Creates a bridge that converts optimizer plan slots to control:intent events.
 * @param {object} options
 * @param {object} options.planEngine - Plan engine with getActivePlan$()
 * @param {object} options.eventBus - Event bus with emit()
 * @param {object} [options.log] - Optional Pino-compatible logger
 * @returns {{ destroy: () => void }}
 */
export function createPlanIntentBridge({ planEngine, eventBus, log }) {
  let slotTimer = null;
  let subscription = null;

  /**
   * Find the current active slot from plan slots array.
   * @param {Array} slots
   * @returns {object|null}
   */
  function findCurrentSlot(slots) {
    if (!Array.isArray(slots) || slots.length === 0) return null;
    const now = Date.now();
    for (const slot of slots) {
      const start = new Date(slot.start).getTime();
      const end = new Date(slot.end).getTime();
      if (now >= start && now < end) return slot;
    }
    return null;
  }

  /**
   * Find the next slot boundary (earliest start or end after now).
   * @param {Array} slots
   * @returns {number|null} ms until next boundary
   */
  function msToNextBoundary(slots) {
    if (!Array.isArray(slots) || slots.length === 0) return null;
    const now = Date.now();
    let nearest = Infinity;
    for (const slot of slots) {
      const start = new Date(slot.start).getTime();
      const end = new Date(slot.end).getTime();
      if (start > now && start < nearest) nearest = start;
      if (end > now && end < nearest) nearest = end;
    }
    return nearest === Infinity ? null : nearest - now;
  }

  /**
   * Clear any pending slot boundary timer.
   */
  function clearSlotTimer() {
    if (slotTimer !== null) {
      clearTimeout(slotTimer);
      slotTimer = null;
    }
  }

  /**
   * Emit optimizer intents for the current slot, or clear if no slot active.
   * @param {object|null} plan
   */
  function evaluatePlan(plan) {
    clearSlotTimer();

    if (!plan) {
      // Plan cleared -- signal arbitrator to clear optimizer intents
      eventBus.emit({
        type: 'control:intent',
        source: 'optimizer',
        priority: 4,
        action: 'clear',
        targets: {},
        reason: 'plan_cleared',
        timestamp: Date.now()
      });
      log?.info('Plan-intent bridge: plan cleared, optimizer intents removed');
      return;
    }

    const slots = plan.slots;
    const currentSlot = findCurrentSlot(slots);

    if (currentSlot) {
      // Build targets from slot fields (only defined, non-null values)
      const targets = {};
      const fields = ['gridSetpointW', 'chargeCurrentA', 'minSocPct'];
      for (const field of fields) {
        if (currentSlot[field] != null) {
          targets[field] = currentSlot[field];
        }
      }

      if (Object.keys(targets).length > 0) {
        eventBus.emit({
          type: 'control:intent',
          source: 'optimizer',
          priority: 4,
          action: 'set',
          targets,
          reason: `plan_slot ${currentSlot.start}`,
          timestamp: Date.now()
        });
        log?.info({ targets, slot: currentSlot.start }, 'Plan-intent bridge: emitted optimizer intent for current slot');
      }
    } else {
      // No current slot -- clear optimizer intents
      eventBus.emit({
        type: 'control:intent',
        source: 'optimizer',
        priority: 4,
        action: 'clear',
        targets: {},
        reason: 'no_active_slot',
        timestamp: Date.now()
      });
      log?.info('Plan-intent bridge: no active slot, optimizer intents cleared');
    }

    // Schedule re-evaluation at next slot boundary
    const msNext = msToNextBoundary(slots);
    if (msNext != null && msNext > 0) {
      slotTimer = setTimeout(() => evaluatePlan(plan), msNext);
      slotTimer.unref();
    }
  }

  // Subscribe to active plan changes
  subscription = planEngine.getActivePlan$().subscribe(plan => {
    evaluatePlan(plan);
  });

  return {
    destroy() {
      clearSlotTimer();
      if (subscription) {
        subscription.unsubscribe();
        subscription = null;
      }
    }
  };
}
