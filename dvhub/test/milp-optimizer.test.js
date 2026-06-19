import test from 'node:test';
import assert from 'node:assert/strict';

import { pickMilpPlan } from '../milp-optimizer.js';

// RED gate: the suite is authored but the contract is not yet pinned.
// This single failing assertion locks the RED state before the GREEN
// characterization tests are written.
test('RED placeholder — pickMilpPlan empty-result contract not yet pinned', async () => {
  const result = await pickMilpPlan({ slots: [], stages: [] });
  assert.equal(result.engine, 'NOT-YET-PINNED');
});
