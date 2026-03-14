import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createPlanEngine } from '../modules/optimizer/plan-engine.js';

/**
 * Helper: create a canonical plan with sensible defaults.
 */
function makePlan(overrides = {}) {
  const now = new Date();
  const slots = (overrides.slots || [0, 1, 2, 3]).map((s, i) => {
    const slotData = typeof s === 'object' ? s : {};
    const start = new Date(now.getTime() + i * 15 * 60_000);
    const end = new Date(start.getTime() + 15 * 60_000);
    return {
      start: start.toISOString(),
      end: end.toISOString(),
      gridImportWh: 500,
      gridExportWh: 0,
      batteryChargeWh: 200,
      batteryDischargeWh: 0,
      targetSocPct: 60,
      expectedProfitEur: 0.25,
      meta: null,
      ...slotData,
    };
  });
  return {
    optimizer: 'eos',
    runId: overrides.runId || crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    slots,
    ...Object.fromEntries(
      Object.entries(overrides).filter(([k]) => k !== 'slots' && k !== 'runId')
    ),
  };
}

/**
 * Mock scorer that returns configurable scores.
 * By default: feasible with totalScore = sum of expectedProfitEur.
 */
function createMockScorer(overrides = {}) {
  return {
    scorePlan(plan) {
      if (overrides.feasible === false) {
        return { feasible: false, reason: overrides.reason || 'mock infeasible' };
      }
      const economicScore = plan.slots.reduce((s, sl) => s + (sl.expectedProfitEur || 0), 0);
      const totalScore = overrides.totalScore ?? economicScore;
      return { feasible: true, economicScore, socScore: 50, totalScore };
    },
  };
}

describe('plan-engine', () => {
  let engine;
  let scorer;

  beforeEach(() => {
    scorer = createMockScorer();
    engine = createPlanEngine({ scorer });
  });

  it('createPlanEngine returns object with expected methods', () => {
    assert.equal(typeof engine.submitPlan, 'function');
    assert.equal(typeof engine.getActivePlan, 'function');
    assert.equal(typeof engine.getActivePlan$, 'function');
    assert.equal(typeof engine.getHistory, 'function');
    assert.equal(typeof engine.clearActivePlan, 'function');
  });

  it('submitPlan scores the plan and stores it', () => {
    const plan = makePlan();
    const result = engine.submitPlan(plan);
    assert.ok(result.entry);
    assert.ok(result.entry.score);
    assert.equal(result.entry.score.feasible, true);
    assert.equal(engine.getHistory().length, 1);
  });

  it('submitPlan with a feasible plan that beats current active updates active plan', () => {
    const plan1 = makePlan({ runId: 'low', slots: [{ expectedProfitEur: 1.0 }] });
    const plan2 = makePlan({ runId: 'high', slots: [{ expectedProfitEur: 5.0 }] });
    engine.submitPlan(plan1);
    const result = engine.submitPlan(plan2);
    assert.equal(result.isNewWinner, true);
    assert.equal(engine.getActivePlan().runId, 'high');
  });

  it('submitPlan with an infeasible plan leaves active unchanged', () => {
    const goodPlan = makePlan({ runId: 'good' });
    engine.submitPlan(goodPlan);

    // Create engine with scorer that rejects next plan
    const infeasibleScorer = {
      scorePlan(plan) {
        if (plan.runId === 'bad') {
          return { feasible: false, reason: 'test infeasible' };
        }
        return { feasible: true, economicScore: 1, socScore: 50, totalScore: 1 };
      },
    };
    const engine2 = createPlanEngine({ scorer: infeasibleScorer });
    engine2.submitPlan(makePlan({ runId: 'good2' }));
    engine2.submitPlan(makePlan({ runId: 'bad' }));
    assert.equal(engine2.getActivePlan().runId, 'good2');
    assert.equal(engine2.getHistory().length, 2);
  });

  it('submitPlan with a lower-scoring feasible plan does not change active', () => {
    const highPlan = makePlan({ runId: 'high', slots: [{ expectedProfitEur: 10.0 }] });
    const lowPlan = makePlan({ runId: 'low', slots: [{ expectedProfitEur: 1.0 }] });
    engine.submitPlan(highPlan);
    const result = engine.submitPlan(lowPlan);
    assert.equal(result.isNewWinner, false);
    assert.equal(engine.getActivePlan().runId, 'high');
  });

  it('getActivePlan returns null initially', () => {
    assert.equal(engine.getActivePlan(), null);
  });

  it('getActivePlan$ returns observable that emits on active plan changes', () => {
    const emissions = [];
    const sub = engine.getActivePlan$().subscribe(v => emissions.push(v));

    const plan = makePlan({ runId: 'test' });
    engine.submitPlan(plan);

    // Should have: initial null + the active plan
    assert.equal(emissions.length, 2);
    assert.equal(emissions[0], null);
    assert.equal(emissions[1].runId, 'test');

    sub.unsubscribe();
  });

  it('getHistory returns all submitted plans newest first', () => {
    engine.submitPlan(makePlan({ runId: 'first' }));
    engine.submitPlan(makePlan({ runId: 'second' }));
    engine.submitPlan(makePlan({ runId: 'third' }));
    const history = engine.getHistory();
    assert.equal(history.length, 3);
    assert.equal(history[0].plan.runId, 'third');
    assert.equal(history[2].plan.runId, 'first');
  });

  it('getHistory({ limit: 5 }) returns at most 5 entries', () => {
    for (let i = 0; i < 10; i++) {
      engine.submitPlan(makePlan());
    }
    const limited = engine.getHistory({ limit: 5 });
    assert.equal(limited.length, 5);
  });

  it('plan engine keeps at most maxHistory plans in memory', () => {
    const smallEngine = createPlanEngine({ scorer, maxHistory: 3 });
    for (let i = 0; i < 10; i++) {
      smallEngine.submitPlan(makePlan());
    }
    assert.equal(smallEngine.getHistory().length, 3);
  });

  it('clearActivePlan sets active to null and emits on stream', () => {
    const emissions = [];
    const sub = engine.getActivePlan$().subscribe(v => emissions.push(v));

    engine.submitPlan(makePlan({ runId: 'active' }));
    engine.clearActivePlan();

    assert.equal(engine.getActivePlan(), null);
    // emissions: null (initial), plan, null (cleared)
    assert.equal(emissions[emissions.length - 1], null);

    sub.unsubscribe();
  });
});
