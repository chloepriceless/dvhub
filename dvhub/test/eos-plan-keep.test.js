// test/eos-plan-keep.test.js -- Letzten EOS-Plan weiterfahren statt interner Fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keepLastEosPlan, eosPlanKeepMs } from '../services/optimizer/index.js';

const T0 = Date.parse('2026-09-23T18:30:00Z');
const Q = 15 * 60_000;
const H12 = 12 * 3_600_000;

function plan(at, slots) {
  return {
    at,
    schedule: slots.map((i) => ({ ts: T0 + i * Q, endTs: T0 + (i + 1) * Q, powerW: -1000 })),
    gridSetpoints: slots.map((i) => ({ ts: T0 + i * Q, endTs: T0 + (i + 1) * Q, lever: 'gridSetpointW', powerW: -18000 }))
  };
}

test('kein gemerkter Plan → null (interner Fallback)', () => {
  assert.equal(keepLastEosPlan(null, T0, H12), null);
});

test('gemerkter Plan: nur noch offene Slots, laufender Slot zählt', () => {
  const kept = keepLastEosPlan(plan(T0 - 60_000, [-1, 0, 1, 2]), T0 + 5 * 60_000, H12);
  assert.ok(kept);
  assert.equal(kept.schedule.length, 3, 'abgelaufener Slot -1 fällt weg');
  assert.equal(kept.gridSetpoints.length, 3);
  assert.equal(kept.gridSetpoints[0].ts, T0, 'laufender Slot bleibt');
});

test('Plan komplett abgelaufen → null', () => {
  assert.equal(keepLastEosPlan(plan(T0 - 60_000, [0, 1]), T0 + 2 * Q, H12), null);
});

test('Plan älter als die Haltedauer → null', () => {
  assert.equal(keepLastEosPlan(plan(T0 - H12 - 1, [0, 100]), T0, H12), null);
});

test('Plan ohne Netz-Sollwerte: Fahrplan bleibt, Sollwerte leer', () => {
  const last = { ...plan(T0, [0, 1]), gridSetpoints: null };
  const kept = keepLastEosPlan(last, T0, H12);
  assert.equal(kept.schedule.length, 2);
  assert.deepEqual(kept.gridSetpoints, []);
});

test('Haltedauer: Standard 12 h, per optimizer.eosPlanKeepHours einstellbar, 0 = aus', () => {
  assert.equal(eosPlanKeepMs({}), H12);
  assert.equal(eosPlanKeepMs({ optimizer: { eosPlanKeepHours: 3 } }), 3 * 3_600_000);
  assert.equal(eosPlanKeepMs({ optimizer: { eosPlanKeepHours: 0 } }), 0);
  assert.equal(eosPlanKeepMs({ optimizer: { eosPlanKeepHours: 'x' } }), H12);
});
