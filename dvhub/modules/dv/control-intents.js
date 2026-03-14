/**
 * Control Intent Emitter
 *
 * Emits structured control intents to the event bus
 * instead of direct hardware writes. The arbitration layer
 * (Phase 6) will consume these intents and resolve conflicts.
 */

/**
 * Creates an intent emitter bound to an event bus.
 * @param {object} eventBus - Event bus with emit() method
 * @returns {object} Emitter with emitCurtailment method
 */
export function createIntentEmitter(eventBus) {
  return {
    /**
     * Emit a curtailment intent.
     * @param {boolean} feedIn - true = release (allow feed-in), false = curtail (block feed-in)
     * @param {string} reason - Human-readable reason for the state change
     */
    emitCurtailment(feedIn, reason) {
      eventBus.emit({
        type: 'control:intent',
        source: 'dv',
        priority: 2,
        action: feedIn ? 'release' : 'curtail',
        targets: {
          feedExcessDcPv: feedIn,
          dontFeedExcessAcPv: !feedIn
        },
        reason,
        timestamp: Date.now()
      });
    }
  };
}
