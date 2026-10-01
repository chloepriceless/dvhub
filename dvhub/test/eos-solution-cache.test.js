import test from 'node:test';
import assert from 'node:assert/strict';
import { createEosSolutionCache, EOS_SOLUTION_MAX_AGE_MS } from '../services/optimizer/eos-solution-cache.js';

test('eos-solution-cache: hält den letzten Plan, wenn EOS kurz nicht antwortet', async () => {
  let t = 1_000_000; let answer = { rows: [{ ts: 1 }], generatedAt: 'x' };
  const c = createEosSolutionCache({ fetchSolution: async () => answer, now: () => t });
  assert.deepEqual((await c.get()).solution.rows, [{ ts: 1 }]);
  answer = null; t += 60_000;                       // EOS rechnet, Timeout
  const r = await c.get();
  assert.equal(r.reason, null);
  assert.deepEqual(r.solution.rows, [{ ts: 1 }]);
  t += EOS_SOLUTION_MAX_AGE_MS;                    // zu alt
  const old = await c.get();
  assert.equal(old.solution, null);
  assert.equal(old.reason, 'EOS antwortet nicht');
});

test('eos-solution-cache: fragt EOS höchstens alle 20 s', async () => {
  let t = 0; let calls = 0;
  const c = createEosSolutionCache({ fetchSolution: async () => { calls++; return { rows: [] }; }, now: () => t });
  await c.get(); await c.get(); t += 5_000; await c.get();
  assert.equal(calls, 1);
  t += 20_000; await c.get();
  assert.equal(calls, 2);
});

test('eos-solution-cache: Fehler wirft nicht', async () => {
  const c = createEosSolutionCache({ fetchSolution: async () => { throw new Error('timeout'); } });
  assert.equal((await c.get()).reason, 'EOS antwortet nicht');
});
