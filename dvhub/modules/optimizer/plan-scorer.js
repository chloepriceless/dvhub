/**
 * Plan Scorer -- Evaluates optimization plans for feasibility and economic merit.
 *
 * Provides configurable scoring with feasibility checks (SoC bounds, grid limits)
 * and weighted economic + SoC scoring. chooseWinningPlan selects the best feasible
 * candidate from a set of scored plans.
 */

/**
 * Create a plan scorer with configurable constraints and weights.
 * @param {object} config
 * @param {number} [config.maxSocPct=100] - Maximum allowed SoC percentage per slot
 * @param {number} [config.minSocPct=5] - Minimum allowed SoC percentage per slot
 * @param {number} [config.maxGridImportWh=5000] - Maximum grid import per slot in Wh
 * @param {number} [config.economicWeight=0.7] - Weight for economic score in total
 * @param {number} [config.socWeight=0.3] - Weight for SoC score in total
 * @returns {{ scorePlan: Function }}
 */
export function createPlanScorer(config = {}) {
  const maxSocPct = config.maxSocPct ?? 100;
  const minSocPct = config.minSocPct ?? 5;
  const maxGridImportWh = config.maxGridImportWh ?? 5000;
  const economicWeight = config.economicWeight ?? 0.7;
  const socWeight = config.socWeight ?? 0.3;

  /**
   * Score a canonical plan for feasibility and economic merit.
   * @param {object} plan - Canonical plan object with slots array
   * @returns {{ feasible: boolean, reason?: string, economicScore?: number, socScore?: number, totalScore?: number }}
   */
  function scorePlan(plan) {
    const slots = plan.slots || [];

    // Feasibility checks -- return on first failure
    for (const slot of slots) {
      const soc = slot.targetSocPct ?? 0;
      if (soc > maxSocPct) {
        return { feasible: false, reason: `SoC target ${soc}% exceeds max ${maxSocPct}%` };
      }
      if (soc < minSocPct) {
        return { feasible: false, reason: `SoC target ${soc}% below min ${minSocPct}%` };
      }
      const gridImport = slot.gridImportWh ?? 0;
      if (gridImport > maxGridImportWh) {
        return { feasible: false, reason: `Grid import ${gridImport}Wh exceeds max ${maxGridImportWh}Wh` };
      }
    }

    // Economic score: sum of expectedProfitEur across all slots
    const economicScore = slots.reduce((sum, s) => sum + (s.expectedProfitEur ?? 0), 0);

    // SoC score: based on last slot targetSocPct
    // Maps to 0-1 range: 0 at minSocPct, 1 at 50%+, then * 100 for readability
    const lastSoc = slots.length > 0 ? (slots[slots.length - 1].targetSocPct ?? 0) : 0;
    const socRange = Math.max(50 - minSocPct, 1); // avoid division by zero
    const socNormalized = Math.min(Math.max((lastSoc - minSocPct) / socRange, 0), 1);
    const socScore = socNormalized * 100;

    const totalScore = economicScore * economicWeight + socScore * socWeight;

    return { feasible: true, economicScore, socScore, totalScore };
  }

  return { scorePlan };
}

/**
 * Choose the winning plan from a set of candidates.
 * Each candidate must have a `score` property from scorePlan().
 * @param {Array<object>} candidates - Array of objects with { score, ...planData }
 * @returns {{ active: object|null, rejected: Array<object> }}
 */
export function chooseWinningPlan(candidates = []) {
  if (candidates.length === 0) {
    return { active: null, rejected: [] };
  }

  const feasible = candidates.filter(c => c.score?.feasible !== false);
  const infeasible = candidates.filter(c => c.score?.feasible === false);

  if (feasible.length === 0) {
    return { active: null, rejected: [...candidates] };
  }

  const ranked = [...feasible].sort(
    (a, b) => Number(b.score?.totalScore || 0) - Number(a.score?.totalScore || 0)
  );

  return {
    active: ranked[0],
    rejected: [...ranked.slice(1), ...infeasible],
  };
}
