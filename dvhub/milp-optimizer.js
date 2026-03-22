// milp-optimizer.js — MILP-based optimal block placement using HiGHS
// Drop-in replacement for pickMultiBlockPlan (greedy)

import { toFiniteNumber } from './util.js';
import {
  SLOT_DURATION_HOURS,
  buildAutomationRuleChain,
  expandChainSlots,
  splitIntoContiguousSegments
} from './small-market-automation.js';

let highsSolver = null;

async function getHiGHS() {
  if (highsSolver) return highsSolver;
  try {
    const mod = await import('highs');
    highsSolver = await mod.default();
    return highsSolver;
  } catch (e) {
    console.error('HiGHS solver not available:', e.message);
    return null;
  }
}

function estimateSlotRevenueCt(slot, powerW) {
  const priceCtKwh = toFiniteNumber(slot?.ct_kwh, 0);
  return (Math.abs(toFiniteNumber(powerW, 0)) / 1000) * SLOT_DURATION_HOURS * priceCtKwh;
}

/**
 * MILP optimizer: finds globally optimal block placement.
 *
 * Binary decision variable x_p for each valid placement p.
 * Maximize: sum( revenue(p) * x_p )
 * Subject to:
 *   - For each time slot t: sum( x_p for all p covering t ) <= 1  (no overlap)
 *   - Energy budget: sum( energy(p) * x_p ) <= availableKwh
 *
 * Returns same shape as pickMultiBlockPlan for drop-in compatibility.
 */
export async function pickMilpPlan({
  slots = [],
  stages = [],
  maxDischargeW,
  availableKwh = null,
  slotDurationMs = 15 * 60 * 1000,
  slotDurationH = SLOT_DURATION_HOURS
}) {
  const emptyResult = { selectedSlotTimestamps: [], totalRevenueCt: 0, chain: [], peakDischargeW: 0, blocks: [], engine: 'milp' };

  const ordered = (Array.isArray(slots) ? [...slots] : [])
    .filter(s => s && toFiniteNumber(s?.ts, null) != null)
    .sort((a, b) => toFiniteNumber(a.ts, 0) - toFiniteNumber(b.ts, 0));

  if (!ordered.length || !Array.isArray(stages) || !stages.length) return emptyResult;

  // Build expanded blocks per stage
  const stageBlocks = stages.map((stage, si) => {
    const chain = buildAutomationRuleChain({ maxDischargeW, stages: [stage] });
    const expanded = expandChainSlots(chain);
    const energyKwh = expanded.reduce((sum, e) =>
      sum + (Math.abs(toFiniteNumber(e.powerW, 0)) / 1000) * slotDurationH, 0);
    return { chain, expanded, energyKwh, stage, stageIdx: si };
  }).filter(b => b.expanded.length > 0);

  if (!stageBlocks.length) return emptyResult;

  // Build slot index map: ts -> index in ordered array
  const slotIndex = new Map();
  ordered.forEach((s, i) => slotIndex.set(toFiniteNumber(s.ts, 0), i));

  const segments = splitIntoContiguousSegments(ordered, slotDurationMs);

  // Enumerate all valid placements
  const placements = [];
  for (const block of stageBlocks) {
    for (const segment of segments) {
      for (let i = 0; i + block.expanded.length <= segment.length; i++) {
        const window = segment.slice(i, i + block.expanded.length);
        const revenueCt = window.reduce((sum, slot, idx) =>
          sum + estimateSlotRevenueCt(slot, block.expanded[idx]?.powerW), 0);

        if (revenueCt <= 0) continue; // only profitable placements

        const timestamps = window.map(s => toFiniteNumber(s.ts, 0));
        const slotIndices = timestamps.map(ts => slotIndex.get(ts));

        placements.push({
          id: `p${placements.length}`,
          block,
          revenueCt,
          energyKwh: block.energyKwh,
          timestamps,
          slotIndices
        });
      }
    }
  }

  if (!placements.length) return emptyResult;

  // Build CPLEX LP model
  const varNames = placements.map(p => p.id);

  // Objective: Maximize revenue (scale to avoid floating point: multiply by 100)
  const objTerms = placements.map(p => `${Math.round(p.revenueCt * 100)} ${p.id}`).join(' + ');
  let lp = `Maximize\n obj: ${objTerms}\nSubject To\n`;

  // Overlap constraints: for each time slot, sum of placements covering it <= 1
  const slotCoverage = new Map(); // slotIdx -> [placement ids]
  for (const p of placements) {
    for (const si of p.slotIndices) {
      if (!slotCoverage.has(si)) slotCoverage.set(si, []);
      slotCoverage.get(si).push(p.id);
    }
  }

  let cIdx = 0;
  for (const [si, pIds] of slotCoverage) {
    if (pIds.length > 1) {
      lp += ` overlap_${cIdx}: ${pIds.join(' + ')} <= 1\n`;
      cIdx++;
    }
  }

  // Energy budget constraint
  if (availableKwh != null && Number.isFinite(availableKwh) && availableKwh > 0) {
    const energyTerms = placements.map(p =>
      `${Math.round(p.energyKwh * 10000)} ${p.id}`
    ).join(' + ');
    lp += ` energy: ${energyTerms} <= ${Math.round(availableKwh * 10000)}\n`;
  }

  // Max repetitions per stage: use energy-based cap when available, otherwise 20
  const maxRepCap = (availableKwh != null && Number.isFinite(availableKwh) && availableKwh > 0)
    ? Math.max(1, Math.ceil(availableKwh / Math.max(...stageBlocks.map(b => b.energyKwh || 1))))
    : 20;
  for (const block of stageBlocks) {
    const stagePlacements = placements.filter(p => p.block.stageIdx === block.stageIdx);
    if (stagePlacements.length > 1) {
      lp += ` maxrep_s${block.stageIdx}: ${stagePlacements.map(p => p.id).join(' + ')} <= ${maxRepCap}\n`;
    }
  }

  // Binary variables
  lp += `Binary\n ${varNames.join(' ')}\nEnd`;

  // Solve
  const highs = await getHiGHS();
  if (!highs) {
    console.warn('MILP: HiGHS not available, returning empty result');
    return emptyResult;
  }

  let result;
  try {
    result = highs.solve(lp);
  } catch (e) {
    console.error('MILP solver error:', e.message);
    return emptyResult;
  }

  if (result.Status !== 'Optimal') {
    console.warn('MILP: non-optimal status:', result.Status);
    return emptyResult;
  }

  // Extract selected placements
  const selected = placements.filter(p => {
    const col = result.Columns[p.id];
    return col && Math.round(col.Primal) === 1;
  });

  // Sort chronologically
  selected.sort((a, b) => a.timestamps[0] - b.timestamps[0]);

  // Build combined result
  const allTimestamps = [];
  const combinedChain = [];
  let totalRevenueCt = 0;
  let peakDischargeW = 0;

  for (const p of selected) {
    allTimestamps.push(...p.timestamps);
    combinedChain.push(...p.block.chain.map(e => ({
      powerW: toFiniteNumber(e.powerW, 0),
      slots: Math.max(0, toFiniteNumber(e.slots, 0))
    })));
    totalRevenueCt += p.revenueCt;
    const blockPeak = p.block.expanded.reduce((pk, e) =>
      Math.max(pk, Math.abs(toFiniteNumber(e.powerW, 0))), 0);
    if (blockPeak > peakDischargeW) peakDischargeW = blockPeak;
  }

  return {
    selectedSlotTimestamps: allTimestamps,
    totalRevenueCt,
    chain: combinedChain,
    peakDischargeW,
    blocks: selected.map(p => ({
      stage: p.block.stage,
      startTs: p.timestamps[0],
      revenueCt: p.revenueCt,
      slots: p.timestamps.length
    })),
    engine: 'milp',
    solverStatus: result.Status,
    placementsConsidered: placements.length
  };
}
