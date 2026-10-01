import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelemetryWriteBuffer } from '../runtime-performance.js';

function rig(batchMs, extra = {}) {
  let t = 1_000_000;
  const writes = [];
  const buf = createTelemetryWriteBuffer({
    flushIntervalMs: 5000, batchMs, now: () => t,
    buildSamples: (s) => [{ seriesKey: 'soc', ts: s.ts, value: s.v }],
    writeSamples: (rows) => writes.push(rows),
    ...extra,
  });
  const tick = (v) => { buf.capture({ v, ts: new Date(t).toISOString() }); buf.flush(); t += 5000; };
  return { buf, writes, tick, advance: (ms) => { t += ms; } };
}

test('SD-Karte: 5-s-Werte gesammelt, ein Schreibvorgang pro Minute, nichts verworfen', () => {
  const r = rig(60_000);
  for (let i = 0; i < 27; i++) r.tick(i);   // gut 2 min
  assert.equal(r.writes.length, 2, 'zwei Blöcke statt 25 Einzel-Writes');
  const all = r.writes.flat().map((x) => x.value);
  assert.deepEqual(all, all.slice().sort((a, b) => a - b));
  assert.ok(r.buf.queuedRows() > 0, 'Rest wartet auf den nächsten Block');
  r.buf.flush({ force: true });
  assert.deepEqual(r.writes.flat().map((x) => x.value), [...Array(27).keys()], 'beim Beenden alles geschrieben, volle Auflösung');
});

test('writeBatchSec = 0: wie früher sofort', () => {
  const r = rig(0);
  for (let i = 0; i < 3; i++) r.tick(i);
  assert.equal(r.writes.length, 3);
});

test('RAM begrenzt, wenn lange nicht geschrieben wird', () => {
  const r = rig(10 * 60_000, { maxQueuedRows: 5 });
  for (let i = 0; i < 20; i++) r.tick(i);
  assert.equal(r.buf.queuedRows(), 5);
  r.buf.flush({ force: true });
  assert.deepEqual(r.writes.flat().map((x) => x.value), [15, 16, 17, 18, 19], 'älteste fallen weg');
});
