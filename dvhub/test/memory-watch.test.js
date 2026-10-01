import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryWatch, trackRequest, trackJob } from '../services/memory-watch.js';

test('Speichersprung wird mit laufender Anfrage und Job protokolliert', () => {
  const logs = [];
  let rss = 150; let t = 0;
  const w = createMemoryWatch({ pushLog: (e, d) => logs.push([e, d]), memoryUsage: () => ({ rss: rss * 1048576, heapUsed: 0, heapTotal: 0, external: 0 }), now: () => t });
  w.sample();
  const endReq = trackRequest('GET', '/api/history/summary');
  const endJob = trackJob('eos-fresh-soc');
  rss = 420; t = 5000;
  w.sample();
  assert.equal(logs.length, 1);
  const [ev, d] = logs[0];
  assert.equal(ev, 'memory_spike');
  assert.equal(d.jumpMb, 270);
  assert.equal(d.requests[0].path, '/api/history/summary');
  assert.equal(d.jobs[0].name, 'eos-fresh-soc');
  endReq(); endJob();
  rss = 425; t = 10_000; w.sample();
  assert.equal(logs.length, 2, 'höher als zuvor → wieder gemeldet');
  rss = 410; t = 20_000; w.sample();
  assert.equal(logs.length, 2, 'nicht höher, innerhalb 1 min → kein Spam');
  assert.equal(w.peak().rssMb, 425);
});
