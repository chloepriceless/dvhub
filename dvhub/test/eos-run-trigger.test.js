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
function harness({ active = true, horizon = 6, soc = { soc: { battery1: 55 } }, status = 'up', startAt = T0 + 60_000, prepareRun } = {}) {
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
    ...(prepareRun ? { prepareRun: () => prepareRun(h) } : {}),
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

// Gegenprüfung a25589cc (P2): Ein Neuplan nach dem Speichern, der auf einen
// laufenden oder gerade gestarteten Lauf trifft, ging verloren. Er wird jetzt
// nachgeholt — nach dem Lauf, frühestens 2 min nach dessen Start; startet
// inzwischen ohnehin ein Lauf, entfällt er.
test('Neuplan während eines Laufs wird nachgeholt', async () => {
  const h = harness();
  let release;
  h.replies.push(() => new Promise((r) => { release = r; }));
  const first = h.trigger.trigger('boundary');
  assert.equal((await h.trigger.kick('replan:config')).skipped, 'recent');
  assert.equal(h.timers.length, 0, 'solange der Lauf rechnet, kein Termin');
  h.nowMs += 70_000;
  release(solution(new Array(24).fill(1), '2026-10-11T12:00:00Z'));
  await first;
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, EOS_RUN_KICK_MIN_GAP_MS - 70_000);
  h.nowMs += EOS_RUN_KICK_MIN_GAP_MS - 70_000;
  h.replies.push(solution(new Array(24).fill(1), '2026-10-11T12:15:00Z'));
  const t = h.timers.shift();
  await t.fn();
  assert.equal(h.posts.length, 2);
  assert.ok(h.logs.some((l) => l.type === 'eos_run_started' && l.data.reason === 'replan:config'));
});

test('nachgeholter Neuplan entfällt, wenn inzwischen ein Lauf startet; no_plan wird nicht nachgeholt', async () => {
  const h = harness();
  h.replies.push(solution(new Array(24).fill(1), '2026-10-11T12:00:00Z'));
  await h.trigger.trigger('boundary');
  await h.trigger.kick('no_plan');
  assert.equal(h.timers.length, 0, 'no_plan: kein Nachholen');
  await h.trigger.kick('replan:config');
  assert.equal(h.timers.length, 1, 'innerhalb der 2 min: Termin');
  h.nowMs += 30_000;
  h.replies.push(solution(new Array(24).fill(1), '2026-10-11T12:15:00Z'));
  await h.trigger.trigger('boundary');
  assert.equal(h.timers.length, 0, 'neuer Lauf rechnet schon mit der neuen Einstellung');
});

// Gegenprüfung 27a172cb (P3): EOS rechnet nach einem DVhub-Neustart noch
// (eos_busy) — der Neuplan wird nach 2 min nachgeholt, nicht verworfen.
test('Neuplan bei eos_busy nach dem Neustart wird nachgeholt', async () => {
  const h = harness({ status: 'busy' });
  assert.equal((await h.trigger.kick('replan:config')).skipped, 'eos_busy');
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, EOS_RUN_KICK_MIN_GAP_MS);
});

// Gegenprüfung 27a172cb (P3): scheitert der reguläre Lauf, der den Neuplan
// aufgenommen hätte, wird der Neuplan wieder vorgemerkt (einmal).
test('gescheiterter Lauf behält den vorgemerkten Neuplan', async () => {
  const h = harness();
  h.replies.push(solution(new Array(24).fill(1), '2026-10-11T12:00:00Z'));
  await h.trigger.trigger('boundary');
  await h.trigger.kick('replan:config');
  assert.equal(h.timers.length, 1);
  h.nowMs += 30_000;
  h.replies.push({ ok: false, error: 'EOS returned HTTP 503' });
  await h.trigger.trigger('boundary');
  assert.equal(h.timers.length, 1, 'wieder vorgemerkt');
  h.nowMs += EOS_RUN_KICK_MIN_GAP_MS;
  h.replies.push({ ok: false, error: 'EOS returned HTTP 503' });
  await h.timers.shift().fn();
  assert.equal(h.posts.length, 3);
  assert.equal(h.timers.length, 0, 'der Neuplan-Lauf selbst wird nicht endlos wiederholt');
});

// Gegenprüfung a6dbbd1d (P2): Schätzpreise dürfen nie im Steuerzeitraum
// liegen. Beim Push war das geprüft, beim Laufstart nicht — ein Lauf an der
// Grenze oder per kick kam ohne Push. Vor jedem Lauf prüft die Bridge die
// Abdeckung (prepareRun) und pusht/löscht neu; danach gilt der neue
// Steuerzeitraum.
test('Laufstart: Vorbereitung vor dem Lauf, danach gilt der neue Steuerzeitraum', async () => {
  const order = [];
  const h = harness({
    horizon: 3,
    prepareRun: async (hh) => { order.push('prepare'); hh.horizon = 1; return { ok: true, pushed: true }; },
  });
  h.replies.push(solution(new Array(4).fill(1), '2026-10-11T12:00:00Z'));
  const res = await h.trigger.trigger('boundary');
  assert.equal(res.ok, true);
  assert.deepEqual(order, ['prepare']);
  assert.equal(h.logs.find((l) => l.type === 'eos_run_started').data.horizonHours, 1);
  assert.equal(h.trigger.lastStartSolution().slots, 4);
});

test('Laufstart: Schätzpreise im Steuerzeitraum nicht entfernbar → kein Lauf', async () => {
  const h = harness({ prepareRun: async () => ({ ok: false, error: 'Schätzpreise im Steuerzeitraum' }) });
  const res = await h.trigger.trigger('replan:ev');
  assert.equal(res.ok, false);
  assert.equal(res.skipped, 'Schätzpreise im Steuerzeitraum');
  assert.equal(h.posts.length, 0);
  assert.deepEqual(types(h), ['eos_run_skipped']);
  assert.equal(h.state.optimizer.eosRun.lastError, 'Schätzpreise im Steuerzeitraum');
});

test('Laufstart: Vorbereitung wirft → kein Lauf, Fehler gemeldet', async () => {
  const h = harness({ prepareRun: async () => { throw new Error('kaputt'); } });
  const res = await h.trigger.trigger();
  assert.equal(res.ok, false);
  assert.equal(h.posts.length, 0);
  assert.equal(h.state.optimizer.eosRun.lastError, 'kaputt');
});

// Gegenprüfung 16856110 (P3): Laufbeginn erst nach der Vorbereitung messen —
// ein Neu-Push (bis zu 5 min) gehört nicht zur Rechenzeit, und die
// Startlösung richtet sich nach dem tatsächlichen Beginn.
test('Laufstart: Rechenzeit und Beginn ohne die Vorbereitung', async () => {
  const h = harness({ prepareRun: async (hh) => { hh.nowMs += 120_000; return { ok: true, pushed: true }; } });
  const start = h.nowMs;
  h.replies.push(solution(new Array(24).fill(1), '2026-10-11T12:00:00Z'));
  await h.trigger.trigger('boundary');
  assert.equal(h.state.optimizer.eosRun.startedAt, start + 120_000);
  assert.equal(h.logs.find((l) => l.type === 'eos_run_done').data.durationS, 0);
});

// Gesamtprüfung Release 1.0.9: stop() hielt einen laufenden Lauf nicht davon
// ab, sich neu einzuplanen — scheiterte er, merkte er den übernommenen Neuplan
// wieder vor und stellte einen Timer, der nach dem Stopp noch einen Lauf anstieß.
test('stop() während eines Laufs: danach plant sich nichts mehr ein', async () => {
  const h = harness();
  h.trigger.start();
  h.replies.push(solution(new Array(24).fill(1), '2026-10-11T12:00:00Z'));
  await h.trigger.trigger('boundary');
  await h.trigger.kick('replan:config');           // vorgemerkt (innerhalb 2 min)
  h.nowMs += 30_000;
  let release;
  h.replies.push(() => new Promise((r) => { release = r; }));
  const running = h.trigger.trigger('boundary');   // übernimmt den Neuplan
  while (!release) await new Promise((r) => setImmediate(r));
  h.trigger.stop();
  release({ ok: false, error: 'EOS returned HTTP 503' });
  await running;
  assert.equal(h.timers.length, 0, 'kein Timer nach stop()');
  // Auch ein Neuplan nach dem Stopp stellt keinen Timer.
  h.status = 'busy';
  await h.trigger.kick('replan:config');
  assert.equal(h.timers.length, 0);
});

// Gegenprüfung a80fa938 (P3): kick()/trigger() nach stop() starteten nach
// Ablauf der 2-min-Frist noch einen ganzen Lauf (Abschalten: ein laufender
// runOptimization ruft kick('no_plan')).
test('nach stop(): kick() und trigger() starten keinen Lauf mehr', async () => {
  const h = harness();
  h.trigger.start();
  h.trigger.stop();
  h.nowMs += 10 * 60_000;
  h.replies.push(solution(new Array(24).fill(1), '2026-10-11T12:00:00Z'));
  assert.equal((await h.trigger.kick('no_plan')).skipped, 'stopped');
  assert.equal((await h.trigger.trigger('boundary')).skipped, 'stopped');
  assert.equal(h.posts.length, 0);
  h.trigger.start();
  assert.equal((await h.trigger.trigger('boundary')).ok, true, 'start() hebt den Stopp auf');
});

test('stop() während der Vorbereitung: kein POST an EOS (Gegenprüfung 63c034af, P3)', async () => {
  let releasePrep;
  const h = harness({ prepareRun: () => new Promise((r) => { releasePrep = r; }) });
  h.trigger.start();
  h.replies.push(solution(new Array(24).fill(1), '2026-10-11T12:00:00Z'));
  const running = h.trigger.trigger('boundary');
  while (!releasePrep) await new Promise((r) => setImmediate(r));
  h.trigger.stop();
  releasePrep({ ok: true, pushed: true });
  assert.equal((await running).skipped, 'stopped');
  assert.equal(h.posts.length, 0);
});
