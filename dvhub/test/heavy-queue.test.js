import test from 'node:test';
import assert from 'node:assert/strict';
import { createHeavyQueue, SKIPPED } from '../services/heavy-queue.js';

const defer = () => { let r; const p = new Promise((res) => { r = res; }); return { p, r }; };

test('höchstens 2 gleichzeitig, Rest wartet', async () => {
  const q = createHeavyQueue({ max: 2 });
  const gates = [defer(), defer(), defer()];
  let active = 0; let peak = 0;
  const jobs = gates.map((g, i) => q.run({ key: `k${i}` }, async () => { active++; peak = Math.max(peak, active); await g.p; active--; return i; }));
  await new Promise((r) => setImmediate(r));
  assert.equal(q.stats().running, 2);
  assert.equal(q.stats().waiting, 1);
  gates.forEach((g) => g.r());
  assert.deepEqual(await Promise.all(jobs), [0, 1, 2]);
  assert.equal(peak, 2);
});

test('weggeklickte Anfragen werden nicht gerechnet', async () => {
  const q = createHeavyQueue({ max: 1 });
  const g = defer(); let ran = 0;
  const a = q.run({ key: 'a' }, async () => { await g.p; return 'a'; });
  const req = { destroyed: false };
  const b = q.run({ key: 'b', req }, async () => { ran++; return 'b'; });
  req.destroyed = true;            // Browser hat weitergeklickt
  g.r();
  assert.equal(await a, 'a');
  assert.equal(await b, SKIPPED);
  assert.equal(ran, 0);
});

test('gleiche Anfrage gleichzeitig nur einmal gerechnet', async () => {
  const q = createHeavyQueue({ max: 2 });
  let calls = 0; const g = defer();
  const fn = async () => { calls++; await g.p; return { status: 200 }; };
  const [x, y] = [q.run({ key: '/api/history/summary?view=month&date=2026-05-01' }, fn), q.run({ key: '/api/history/summary?view=month&date=2026-05-01' }, fn)];
  g.r();
  assert.deepEqual(await x, await y);
  assert.equal(calls, 1);
});
