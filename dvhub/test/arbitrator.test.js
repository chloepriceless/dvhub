import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createArbitrator } from '../core/arbitrator.js';

describe('createArbitrator', () => {
  it('submitIntent with priority 2 (dv) and priority 4 (optimizer) for same target -> dv wins', () => {
    const arb = createArbitrator();

    arb.submitIntent({
      source: 'dv', priority: 2, action: 'curtail',
      targets: { feedExcessDcPv: false },
      reason: 'dv-curtail', timestamp: 1000
    });

    arb.submitIntent({
      source: 'optimizer', priority: 4, action: 'release',
      targets: { feedExcessDcPv: true },
      reason: 'opt-release', timestamp: 2000
    });

    const winner = arb.resolve('feedExcessDcPv');
    assert.equal(winner.source, 'dv');
    assert.equal(winner.priority, 2);
    assert.equal(winner.value, false);
  });

  it('submitIntent with priority 4 then priority 2 for same target -> dv wins (lower number wins)', () => {
    const arb = createArbitrator();

    arb.submitIntent({
      source: 'optimizer', priority: 4, action: 'release',
      targets: { feedExcessDcPv: true },
      reason: 'opt', timestamp: 1000
    });

    arb.submitIntent({
      source: 'dv', priority: 2, action: 'curtail',
      targets: { feedExcessDcPv: false },
      reason: 'dv', timestamp: 2000
    });

    const winner = arb.resolve('feedExcessDcPv');
    assert.equal(winner.source, 'dv');
    assert.equal(winner.priority, 2);
  });

  it('submitIntent with priority 2 then priority 4 -> dv stays (does not overwrite with lower priority)', () => {
    const arb = createArbitrator();

    arb.submitIntent({
      source: 'dv', priority: 2, action: 'curtail',
      targets: { gridSetpointW: 500 },
      reason: 'dv', timestamp: 1000
    });

    const result = arb.submitIntent({
      source: 'optimizer', priority: 4, action: 'set',
      targets: { gridSetpointW: 1000 },
      reason: 'opt', timestamp: 2000
    });

    const winner = arb.resolve('gridSetpointW');
    assert.equal(winner.source, 'dv');
    assert.equal(winner.value, 500);
    assert.deepEqual(result.overridden, ['gridSetpointW']);
  });

  it('different targets from different sources -> both stored independently', () => {
    const arb = createArbitrator();

    arb.submitIntent({
      source: 'dv', priority: 2, action: 'curtail',
      targets: { feedExcessDcPv: false },
      reason: 'dv', timestamp: 1000
    });

    arb.submitIntent({
      source: 'optimizer', priority: 4, action: 'set',
      targets: { gridSetpointW: 500 },
      reason: 'opt', timestamp: 2000
    });

    assert.equal(arb.resolve('feedExcessDcPv').source, 'dv');
    assert.equal(arb.resolve('gridSetpointW').source, 'optimizer');
  });

  it('clearSource removes all intents from that source, leaves others', () => {
    const arb = createArbitrator();

    arb.submitIntent({
      source: 'dv', priority: 2, action: 'curtail',
      targets: { feedExcessDcPv: false },
      reason: 'dv', timestamp: 1000
    });

    arb.submitIntent({
      source: 'optimizer', priority: 4, action: 'set',
      targets: { gridSetpointW: 500 },
      reason: 'opt', timestamp: 2000
    });

    const cleared = arb.clearSource('optimizer');
    assert.equal(cleared, 1);
    assert.equal(arb.resolve('gridSetpointW'), null);
    assert.equal(arb.resolve('feedExcessDcPv').source, 'dv');
  });

  it('resolveAll returns Map of all current winners', () => {
    const arb = createArbitrator();

    arb.submitIntent({
      source: 'dv', priority: 2, action: 'curtail',
      targets: { feedExcessDcPv: false, dontFeedExcessAcPv: true },
      reason: 'dv', timestamp: 1000
    });

    const all = arb.resolveAll();
    assert.ok(all instanceof Map);
    assert.equal(all.size, 2);
    assert.equal(all.get('feedExcessDcPv').source, 'dv');
    assert.equal(all.get('dontFeedExcessAcPv').source, 'dv');
  });

  it('resolve returns null for unknown target', () => {
    const arb = createArbitrator();
    assert.equal(arb.resolve('nonexistent'), null);
  });

  it('getOverridden returns list of intents that lost to higher-priority', () => {
    const arb = createArbitrator();

    arb.submitIntent({
      source: 'dv', priority: 2, action: 'curtail',
      targets: { feedExcessDcPv: false },
      reason: 'dv', timestamp: 1000
    });

    arb.submitIntent({
      source: 'optimizer', priority: 4, action: 'release',
      targets: { feedExcessDcPv: true },
      reason: 'opt', timestamp: 2000
    });

    const overridden = arb.getOverridden();
    assert.equal(overridden.length, 1);
    assert.equal(overridden[0].source, 'optimizer');
    assert.equal(overridden[0].target, 'feedExcessDcPv');
    assert.equal(overridden[0].overriddenBy, 'dv');
  });

  it('equal priority replaces for freshness', () => {
    const arb = createArbitrator();

    arb.submitIntent({
      source: 'dv', priority: 2, action: 'curtail',
      targets: { feedExcessDcPv: false },
      reason: 'old', timestamp: 1000
    });

    arb.submitIntent({
      source: 'dv', priority: 2, action: 'release',
      targets: { feedExcessDcPv: true },
      reason: 'new', timestamp: 2000
    });

    const winner = arb.resolve('feedExcessDcPv');
    assert.equal(winner.reason, 'new');
    assert.equal(winner.value, true);
  });

  it('clear removes all state', () => {
    const arb = createArbitrator();

    arb.submitIntent({
      source: 'dv', priority: 2, action: 'curtail',
      targets: { feedExcessDcPv: false },
      reason: 'dv', timestamp: 1000
    });

    arb.clear();
    assert.equal(arb.resolve('feedExcessDcPv'), null);
    assert.equal(arb.getOverridden().length, 0);
    assert.equal(arb.resolveAll().size, 0);
  });
});
