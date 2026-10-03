import test from 'node:test';
import assert from 'node:assert/strict';

import { connectWithRetry, DB_CONNECT_RETRY_DELAYS_MS } from '../db-client.js';

function flakyPool(failures) {
  let calls = 0;
  return {
    get calls() { return calls; },
    query: async () => {
      calls += 1;
      if (calls <= failures) throw new Error('Connection terminated due to connection timeout');
      return { rows: [{ '?column?': 1 }] };
    },
  };
}

test('erster Versuch klappt: keine Pause', async () => {
  const slept = [];
  const n = await connectWithRetry(flakyPool(0), { sleep: async (ms) => { slept.push(ms); } });
  assert.equal(n, 1);
  assert.deepEqual(slept, []);
});

test('Zeitüberschreitung beim Hochfahren: wiederholt mit wachsenden Pausen', async () => {
  const slept = [];
  const retries = [];
  const pool = flakyPool(2);
  const n = await connectWithRetry(pool, { sleep: async (ms) => { slept.push(ms); }, onRetry: (i) => retries.push(i.attempt) });
  assert.equal(n, 3);
  assert.deepEqual(slept, [5000, 10000]);
  assert.deepEqual(retries, [1, 2]);
});

test('Datenbank bleibt weg: nach allen Versuchen kommt der Fehler', async () => {
  const pool = flakyPool(100);
  await assert.rejects(connectWithRetry(pool, { sleep: async () => {} }), /connection timeout/);
  assert.equal(pool.calls, DB_CONNECT_RETRY_DELAYS_MS.length + 1);
});
