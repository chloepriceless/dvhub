import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSerialTaskRunner,
  createTelemetryWriteBuffer,
  normalizePollIntervalMs
} from '../runtime-performance.js';

test('serial task runner prevents overlap and coalesces one queued rerun', async () => {
  const deferred = [];
  let runs = 0;
  const runner = createSerialTaskRunner({
    task: async () => {
      runs += 1;
      await new Promise((resolve) => deferred.push(resolve));
    }
  });

  const first = runner.run();
  const second = runner.run();
  const third = runner.run();

  assert.equal(runs, 1);

  deferred.shift()();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(runs, 2);
  deferred.shift()();
  await first;
  await second;
  await third;

  assert.equal(runs, 2);
});

test('serial task runner can drop overlapping triggers instead of queueing them', async () => {
  const deferred = [];
  let runs = 0;
  const runner = createSerialTaskRunner({
    queueWhileRunning: false,
    task: async () => {
      runs += 1;
      await new Promise((resolve) => deferred.push(resolve));
    }
  });

  const first = runner.run();
  const second = runner.run();
  const third = runner.run();

  assert.equal(runs, 1);
  deferred.shift()();
  await first;
  await second;
  await third;
  assert.equal(runs, 1);
});

test('telemetry write buffer flushes immediately once and then only the latest snapshot after the throttle window', () => {
  let now = Date.UTC(2026, 2, 10, 4, 0, 0);
  const writes = [];
  const buffer = createTelemetryWriteBuffer({
    flushIntervalMs: 5000,
    now: () => now,
    buildSamples: (snapshot) => [snapshot],
    writeSamples: (rows) => writes.push(rows)
  });

  buffer.capture({
    ts: new Date(now).toISOString(),
    resolutionSeconds: 1,
    meter: { grid_total_w: 100 }
  });
  assert.equal(buffer.flush(), true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0].meter.grid_total_w, 100);
  assert.equal(writes[0][0].resolutionSeconds, 1);

  now += 1000;
  buffer.capture({
    ts: new Date(now).toISOString(),
    resolutionSeconds: 1,
    meter: { grid_total_w: 200 }
  });
  assert.equal(buffer.flush(), false);
  assert.equal(writes.length, 1);

  now += 5000;
  assert.equal(buffer.flush(), true);
  assert.equal(writes.length, 2);
  assert.equal(writes[1][0].meter.grid_total_w, 200);
  assert.equal(writes[1][0].resolutionSeconds, 6);
});

test('poll interval normalization enforces a one-second minimum cadence', () => {
  assert.equal(normalizePollIntervalMs(0), 1000);
  assert.equal(normalizePollIntervalMs(400), 1000);
  assert.equal(normalizePollIntervalMs(1000), 1000);
  assert.equal(normalizePollIntervalMs(2500), 2500);
});
