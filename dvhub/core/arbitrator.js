/**
 * Fixed-Priority Intent Arbitrator
 *
 * Resolves conflicts when multiple sources (DV, optimizer, manual, system)
 * submit control intents for the same hardware target. Lower priority
 * number wins (system=1 > dv=2 > manual=3 > optimizer=4).
 */

/** @type {Record<string, number>} */
const PRIORITY_MAP = { system: 1, dv: 2, manual: 3, optimizer: 4 };

const MAX_OVERRIDDEN = 100;

/**
 * Creates a new arbitrator instance.
 * @param {object} [options]
 * @param {object} [options.log] - Optional Pino-compatible logger
 * @returns {object} Arbitrator with submitIntent, resolve, resolveAll, clearSource, getOverridden, clear
 */
export function createArbitrator({ log } = {}) {
  /**
   * Active winning intents keyed by target string.
   * @type {Map<string, {source: string, priority: number, value: *, timestamp: number, reason: string}>}
   */
  const activeIntents = new Map();

  /**
   * Recent overridden intents (capped at MAX_OVERRIDDEN).
   * @type {Array<{source: string, priority: number, target: string, value: *, overriddenBy: string}>}
   */
  const overridden = [];

  /**
   * Submit an intent for arbitration.
   * @param {object} intent - Intent with source, priority, targets, timestamp, reason
   * @returns {{applied: string[], overridden: string[]}}
   */
  function submitIntent(intent) {
    const { source, priority, targets, timestamp, reason } = intent;

    if (!source || priority == null || !targets || !timestamp) {
      throw new Error('Intent must have source, priority, targets, and timestamp');
    }

    const applied = [];
    const overriddenTargets = [];

    for (const [target, value] of Object.entries(targets)) {
      const current = activeIntents.get(target);

      if (!current || priority <= current.priority) {
        // New intent wins (lower number = higher priority, equal replaces for freshness)
        activeIntents.set(target, { source, priority, value, timestamp, reason });
        applied.push(target);

        if (current && current.source !== source) {
          log?.info({ target, winner: source, loser: current.source },
            `Intent ${source} (p${priority}) replaced ${current.source} (p${current.priority}) for ${target}`);
        }
      } else {
        // Current winner has higher priority -- reject this intent
        overridden.push({
          source, priority, target, value, overriddenBy: current.source
        });

        // Cap overridden list
        if (overridden.length > MAX_OVERRIDDEN) {
          overridden.shift();
        }

        overriddenTargets.push(target);

        log?.warn({ target, rejected: source, winner: current.source },
          `Intent ${source} (p${priority}) overridden by ${current.source} (p${current.priority}) for ${target}`);
      }
    }

    return { applied, overridden: overriddenTargets };
  }

  /**
   * Resolve the current winner for a target.
   * @param {string} target
   * @returns {object|null}
   */
  function resolve(target) {
    return activeIntents.get(target) || null;
  }

  /**
   * Resolve all current winners.
   * @returns {Map<string, object>}
   */
  function resolveAll() {
    return new Map(activeIntents);
  }

  /**
   * Clear all intents from a specific source.
   * @param {string} source
   * @returns {number} Count of cleared entries
   */
  function clearSource(source) {
    let count = 0;
    for (const [target, entry] of activeIntents) {
      if (entry.source === source) {
        activeIntents.delete(target);
        count++;
      }
    }
    return count;
  }

  /**
   * Get list of recently overridden intents.
   * @returns {Array<object>}
   */
  function getOverridden() {
    return [...overridden];
  }

  /**
   * Clear all state (active intents and overridden history).
   */
  function clear() {
    activeIntents.clear();
    overridden.length = 0;
  }

  return { submitIntent, resolve, resolveAll, clearSource, getOverridden, clear };
}

export { PRIORITY_MAP };
