import test from 'node:test';
import assert from 'node:assert/strict';

import {
  alignStartSolution,
  createEosRunTrigger,
  nextBoundaryMs,
  EOS_RUN_BOUNDARY_OFFSET_MS,
  EOS_RUN_KICK_MIN_GAP_MS,
  EOS_RUN_STARTUP_GRACE_MS,
} from '../services/optimizer/eos-run-trigger.js';

const SLOT_MS = 15 * 60_000;
const T0 = Date.parse('2026-10-11T12:00:00Z');

test('nextBoundaryMs: nächste volle Viertelstunde, auf der Grenze die folgende', () => {
  assert.equal(nextBoundaryMs(Date.parse('2026-10-11T12:07:31Z'), SLOT_MS), Date.parse('2026-10-11T12:15:00Z'));
  assert.equal(nextBoundaryMs(Date.parse('2026-10-11T12:15:00Z'), SLOT_MS), Date.parse('2026-10-11T12:30:00Z'));
  assert.equal(nextBoundaryMs(Date.parse('2026-10-11T12:59:59Z'), 3600_000), Date.parse('2026-10-11T13:00:00Z'));
});

test('alignStartSolution: Steuerzeitraum schrumpft (8 → 4 Slots), ein Slot vergangen, Geräte-Gene bleiben', () => {
  // Akku-Block 10..17, dahinter zwei Geräte-Gene. Slot 0 (10) ist vorbei, von
  // 11..17 bleiben die ersten vier.
  const res = alignStartSolution({
    genes: [10, 11, 12, 13, 14, 15, 16, 17, 90, 91], geneStartMs: T0,
    previousSlots: 8, currentSlots: 4, slotMs: SLOT_MS, runStartMs: T0 + SLOT_MS,
  });
  assert.deepEqual(res.genes, [11, 12, 13, 14, 90, 91]);
  assert.equal(res.startMs, T0 + SLOT_MS);
  assert.equal(res.blocks, 1);
  assert.equal(res.elapsedSlots, 1);
});

test('alignStartSolution: Steuerzeitraum wächst (4 → 6), Akku- und Auto-Block, letztes Gen füllt auf', () => {
  const res = alignStartSolution({
    genes: [1, 2, 3, 4, 5, 6, 7, 8, 9], geneStartMs: T0,
    previousSlots: 4, currentSlots: 6, slotMs: SLOT_MS, runStartMs: T0 + SLOT_MS,
  });
  // Akku 1..4 → 2,3,4 + dreimal die 4; Auto 5..8 → 6,7,8 + dreimal die 8; Gerät 9.
  assert.deepEqual(res.genes, [2, 3, 4, 4, 4, 4, 6, 7, 8, 8, 8, 8, 9]);
  assert.equal(res.blocks, 2);
});

test('alignStartSolution: gleicher Slot, nur kürzen; Laufbeginn mitten im Slot zählt zum Slot davor', () => {
  const res = alignStartSolution({
    genes: [1, 2, 3, 4, 5, 6], geneStartMs: T0,
    previousSlots: 6, currentSlots: 5, slotMs: SLOT_MS, runStartMs: T0 + SLOT_MS - 1,
  });
  assert.deepEqual(res.genes, [1, 2, 3, 4, 5]);
  assert.equal(res.startMs, T0);
  assert.equal(res.elapsedSlots, 0);
});

test('alignStartSolution: nicht zuordenbar → null (EOS rechnet dann ohne Warmstart)', () => {
  const base = { genes: [1, 2, 3, 4], geneStartMs: T0, previousSlots: 4, currentSlots: 3, slotMs: SLOT_MS, runStartMs: T0 };
  assert.equal(alignStartSolution({ ...base, runStartMs: T0 + 4 * SLOT_MS }), null, 'alle Slots vergangen');
  assert.equal(alignStartSolution({ ...base, runStartMs: T0 - SLOT_MS }), null, 'Lösung beginnt nach dem Lauf');
  assert.equal(alignStartSolution({ ...base, genes: [1, 2, 3] }), null, 'kürzer als ein Block');
  assert.equal(alignStartSolution({ ...base, genes: new Array(12).fill(0) }), null, 'drei Blöcke gibt es nicht');
  assert.equal(alignStartSolution({ ...base, genes: [1, 2, NaN, 4] }), null);
  assert.equal(alignStartSolution({ ...base, genes: null }), null);
  assert.equal(alignStartSolution({ ...base, currentSlots: 0 }), null);
});

/** Auslöser mit gestellter Uhr; Timer werden gesammelt, nicht ausgeführt. */
function harness({ active = true, horizon = 6, soc = { soc: { battery1: 55 } }, status = 'up', startAt = T0 + 60_000 } = {}) {
  const h = {
    nowMs: startAt, active, horizon, soc, status,
    posts: [], logs: [], timers: [], solutionCalls: 0, state: { optimizer: {} },
    replies: [],
  };
  h.trigger = createEosRunTrigger({
    isActive: () => h.active,
    getIntervalSec: () => 900,
    getSlotSec: () => 900,
    getHorizonHours: () => h.horizon,
    collectSoc: async () => h.soc,
    postOptimize: (body, timeoutMs) => {
      h.posts.push({ body, timeoutMs });
      const next = h.replies.shift();
      return typeof next === 'function' ? next() : Promise.resolve(next ?? { ok: false, error: 'EOS returned HTTP 503' });
    },
    onSolution: async () => { h.solutionCalls += 1; },
    eosStatus: () => ({ status: h.status }),
    state: h.state,
    pushLog: (type, data) => h.logs.push({ type, data }),
    now: () => h.nowMs,
    setTimer: (fn, ms) => { const t = { fn, ms }; h.timers.push(t); return t; },
    clearTimer: (t) => { h.timers = h.timers.filter((x) => x !== t); },
  });
  return h;
}
const solution = (genes, startIso) => ({ ok: true, data: { start_solution: genes, start_solution_datetime: startIso } });
const types = (h) => h.logs.map((l) => l.type);

test('Takt: erster Lauf zur nächsten vollen Viertelstunde (+2 s), danach wieder zur nächsten', async () => {
  const h = harness({ startAt: Date.parse('2026-10-11T12:07:31Z') });
  h.replies.push(solution(new Array(24).fill(1), '2026-10-11T12:15:00Z'));
  h.trigger.start();
  assert.equal(h.timers.length, 1);
  const wait = Date.parse('2026-10-11T12:15:00Z') + EOS_RUN_BOUNDARY_OFFSET_MS - h.nowMs;
  assert.equal(h.timers[0].ms, wait);
  assert.equal(h.posts.length, 0, 'vor der Grenze kein Lauf');

  h.nowMs += wait;
  const due = h.timers.shift();
  due.fn();
  await h.trigger.trigger('noop'); // läuft schon → übersprungen; wartet nicht
  assert.equal(h.timers.length, 1, 'nächster Termin steht');
  assert.equal(h.timers[0].ms, SLOT_MS, '12:30:02');
  h.trigger.stop();
  assert.equal(h.timers.length, 0);
});

test('Lauf: Ladestand im Aufruf, keine Startlösung beim ersten Lauf, Lösung wird abgeholt', async () => {
  const h = harness();
  h.replies.push(solution(new Array(24).fill(1), '2026-10-11T12:00:00Z'));
  const res = await h.trigger.trigger('boundary');
  assert.equal(res.ok, true);
  assert.deepEqual(h.posts[0].body, { soc: { battery1: 55 } });
  assert.equal(h.posts[0].timeoutMs, 3 * 3600_000);
  assert.equal(h.solutionCalls, 1);
  assert.deepEqual(types(h), ['eos_run_started', 'eos_run_done']);
  assert.equal(h.state.optimizer.eosRun.inFlight, false);
  assert.equal(h.state.optimizer.eosRun.lastError, null);
  assert.equal(h.trigger.lastStartSolution().slots, 24);
});

test('Lauf: gleicher Steuerzeitraum → keine Startlösung mitschicken (EOS verschiebt seine eigene)', async () => {
  const h = harness();
  h.replies.push(solution(new Array(24).fill(1), '2026-10-11T12:00:00Z'), solution(new Array(24).fill(1), '2026-10-11T12:15:00Z'));
  await h.trigger.trigger();
  h.nowMs += SLOT_MS;
  await h.trigger.trigger();
  assert.deepEqual(h.posts[1].body, { soc: { battery1: 55 } });
});

test('Lauf: Steuerzeitraum 6 h → 5 h, ein Slot später → gekürzte Startlösung mit neuem Beginn', async () => {
  const h = harness({ startAt: T0 + 2_000 });
  const genes = Array.from({ length: 24 }, (_, i) => i); // 0..23, ein Block
  h.replies.push(solution(genes, '2026-10-11T12:00:00Z'), solution(new Array(20).fill(0), '2026-10-11T12:15:00Z'));
  await h.trigger.trigger();
  h.horizon = 5;
  h.nowMs = T0 + SLOT_MS + 2_000;
  await h.trigger.trigger();
  // Slot 0 ist vorbei: 1..23, davon die ersten 20 → 1..20.
  assert.deepEqual(h.posts[1].body.start_solution, Array.from({ length: 20 }, (_, i) => i + 1));
  assert.equal(h.posts[1].body.start_solution_datetime, '2026-10-11T12:15:00.000Z');
  assert.deepEqual(h.logs.filter((l) => l.type === 'eos_run_started')[1].data.warmStart, { from: 24, to: 20, elapsedSlots: 1 });
  assert.equal(h.trigger.lastStartSolution().slots, 20, 'die neue Lösung gilt für den nächsten Lauf');
});

test('Lauf rechnet noch: kein zweiter Aufruf (EOS würde ihn nur einreihen)', async () => {
  const h = harness();
  let finish;
  h.replies.push(() => new Promise((resolve) => { finish = resolve; }));
  const first = h.trigger.trigger('boundary');
  await Promise.resolve();
  await Promise.resolve();
  const second = await h.trigger.trigger('boundary');
  assert.equal(second.skipped, 'in_flight');
  assert.equal(h.posts.length, 1);
  assert.equal(h.trigger.isRunning(), true);
  finish(solution(new Array(24).fill(1), '2026-10-11T12:00:00Z'));
  await first;
  assert.equal(h.trigger.isRunning(), false);
});

test('Fehler: kein Plan (503) wird gemeldet, der nächste Lauf rechnet wieder', async () => {
  const h = harness();
  h.replies.push({ ok: false, error: 'EOS returned HTTP 503' }, solution(new Array(24).fill(1), '2026-10-11T12:15:00Z'));
  const res = await h.trigger.trigger();
  assert.equal(res.ok, false);
  assert.equal(h.state.optimizer.eosRun.lastError, 'EOS returned HTTP 503');
  assert.equal(h.solutionCalls, 0);
  assert.equal((await h.trigger.trigger()).ok, true);
  assert.equal(h.state.optimizer.eosRun.lastError, null);
});

test('Ohne Ladestand kein Aufruf', async () => {
  const h = harness({ soc: { skipped: 'no live battery soc in state' } });
  const res = await h.trigger.trigger();
  assert.equal(res.skipped, 'no live battery soc in state');
  assert.equal(h.posts.length, 0);
  assert.deepEqual(types(h), ['eos_run_skipped']);
});

test('Abgeschaltet (EOS aus, nicht erkannt oder eigener Takt gewählt): kein Aufruf', async () => {
  const h = harness({ active: false });
  assert.equal((await h.trigger.trigger()).skipped, 'inactive');
  assert.equal((await h.trigger.kick('no_plan')).skipped, 'inactive');
  assert.equal(h.posts.length, 0);
});

test('Nach DVhub-Neustart: rechnet EOS noch, wird nicht dahinter eingereiht — später schon', async () => {
  const h = harness({ status: 'busy' });
  assert.equal((await h.trigger.trigger()).skipped, 'eos_busy');
  assert.equal(h.posts.length, 0);
  // Antwortet EOS wieder, wird gerechnet.
  h.status = 'up';
  h.replies.push(solution(new Array(24).fill(1), '2026-10-11T12:00:00Z'));
  assert.equal((await h.trigger.trigger()).ok, true);
  // Danach gilt die Rücksicht nicht mehr: „busy“ ist dann unser eigener Lauf gewesen.
  h.status = 'busy';
  h.replies.push(solution(new Array(24).fill(1), '2026-10-11T12:15:00Z'));
  assert.equal((await h.trigger.trigger()).ok, true);

  // Und sie gilt nur die erste Stunde nach dem Start.
  const late = harness({ status: 'busy' });
  late.nowMs += EOS_RUN_STARTUP_GRACE_MS;
  late.replies.push(solution(new Array(24).fill(1), '2026-10-11T13:00:00Z'));
  assert.equal((await late.trigger.trigger()).ok, true);
});

test('kick: außer der Reihe höchstens alle 2 Minuten', async () => {
  const h = harness();
  h.replies.push({ ok: false, error: 'EOS returned HTTP 503' }, solution(new Array(24).fill(1), '2026-10-11T12:00:00Z'));
  assert.equal((await h.trigger.kick('no_plan')).ok, false);
  assert.equal(h.posts.length, 1);
  h.nowMs += EOS_RUN_KICK_MIN_GAP_MS - 1;
  assert.equal((await h.trigger.kick('no_plan')).skipped, 'recent');
  assert.equal(h.posts.length, 1);
  h.nowMs += 1;
  assert.equal((await h.trigger.kick('no_plan')).ok, true);
  assert.equal(h.posts.length, 2);
});
