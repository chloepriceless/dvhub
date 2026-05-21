import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createEosAdapter } from '../services/optimizer/eos-adapter.js';

/**
 * Helper: Create a mock EOS HTTP server on a random port.
 * Returns { server, port, close, requests } where requests is an array
 * of captured { method, url, body } objects.
 */
function createMockEos(handler) {
  const requests = [];
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        const parsed = body ? JSON.parse(body) : null;
        requests.push({ method: req.method, url: req.url, body: parsed });
        handler(req, res, parsed);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        port,
        requests,
        close: () => new Promise(r => server.close(r))
      });
    });
    server.on('error', reject);
  });
}

/**
 * Helper: Create a minimal ctx for EOS adapter with the given base URL.
 */
function makeCtx(baseUrl) {
  return {
    getCfg: () => ({ optimizer: { eosProxy: { url: baseUrl } } }),
    pushLog: () => {}
  };
}

// --- Test 1: pushForecast sends per-provider PUT to /v1/prediction/import/{provider} ---
// Phase 19.1-01: EOS v0.3.0 replaced PUT /v1/prediction/list with per-provider
// PUT /v1/prediction/import/{PVForecastImport,LoadImport,ElecPriceImport}.
// Each call carries a PydanticDateTimeData {timestamps, values} body and
// ?force_enable=true query param.
test('pushForecast sends per-provider PUT to /v1/prediction/import with DateTimeData body', async () => {
  const mock = await createMockEos((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  });

  try {
    const adapter = createEosAdapter(makeCtx(`http://127.0.0.1:${mock.port}`));

    const forecastResponse = {
      pv: {
        slots: [
          { ts: '2026-04-03T12:00:00Z', watts: 3000 },
          { ts: '2026-04-03T13:00:00Z', watts: 2500 }
        ]
      },
      price: {
        slots: [
          { ts: '2026-04-03T12:00:00Z', ctKwh: 15.2 },
          { ts: '2026-04-03T13:00:00Z', ctKwh: 18.5 }
        ]
      },
      load: {
        slots: [
          { ts: '2026-04-03T12:00:00Z', watts: 800 },
          { ts: '2026-04-03T13:00:00Z', watts: 900 }
        ]
      }
    };

    const result = await adapter.pushForecast(forecastResponse);

    assert.equal(result.ok, true);
    assert.ok(result.perProvider, 'Should return perProvider report');
    assert.ok(mock.requests.length >= 3, 'Should fire 3 PUTs (pv/load/price)');

    // Find each provider call. URLs include ?force_enable=true; strip query for match.
    const stripQs = u => (u || '').split('?')[0];
    const pvReq = mock.requests.find(r => stripQs(r.url) === '/v1/prediction/import/PVForecastImport');
    const loadReq = mock.requests.find(r => stripQs(r.url) === '/v1/prediction/import/LoadImport');
    const priceReq = mock.requests.find(r => stripQs(r.url) === '/v1/prediction/import/ElecPriceImport');
    assert.ok(pvReq, 'Should PUT PVForecastImport');
    assert.ok(loadReq, 'Should PUT LoadImport');
    assert.ok(priceReq, 'Should PUT ElecPriceImport');
    assert.equal(pvReq.method, 'PUT');
    assert.ok(Array.isArray(pvReq.body.timestamps), 'PV body should have timestamps array');
    assert.ok(Array.isArray(pvReq.body.values), 'PV body should have values array');
    assert.equal(pvReq.body.values.length, 2, 'PV body should carry 2 slots');
  } finally {
    await mock.close();
  }
});

// --- Test 2: pullSchedule GETs /v1/energy-management/plan and returns parsed schedule ---
test('pullSchedule GETs /v1/energy-management/plan and returns parsed schedule', async () => {
  const eosPlan = {
    result: [
      { start_time: '2026-04-03T12:00:00', battery_power: 2000 },
      { start_time: '2026-04-03T13:00:00', battery_power: -1500 }
    ]
  };

  const mock = await createMockEos((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(eosPlan));
  });

  try {
    const adapter = createEosAdapter(makeCtx(`http://127.0.0.1:${mock.port}`));
    const slots = await adapter.pullSchedule();

    assert.ok(Array.isArray(slots), 'pullSchedule should return an array');
    assert.ok(slots.length > 0, 'Should have slots');
    // Each hourly entry is split into 4x 15-min slots
    assert.equal(slots.length, 8, 'Two hourly entries -> 8x 15-min slots');
    assert.ok(typeof slots[0].ts === 'number', 'Slot should have numeric ts');
    assert.ok(typeof slots[0].endTs === 'number', 'Slot should have numeric endTs');
    assert.ok(typeof slots[0].powerW === 'number', 'Slot should have numeric powerW');
    assert.equal(slots[0].confidence, 0.7, 'Confidence should be 0.7 for EOS');
  } finally {
    await mock.close();
  }
});

// --- Test 3: pullSchedule returns null when EOS returns non-200 status ---
test('pullSchedule returns null when EOS returns non-200 status', async () => {
  const mock = await createMockEos((req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal Server Error' }));
  });

  try {
    const adapter = createEosAdapter(makeCtx(`http://127.0.0.1:${mock.port}`));
    const result = await adapter.pullSchedule();
    assert.equal(result, null, 'Should return null on non-200');
  } finally {
    await mock.close();
  }
});

// --- Test 4: pullSchedule returns null when EOS returns malformed JSON ---
test('pullSchedule returns null when EOS returns malformed JSON', async () => {
  const mock = await createMockEos((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('not valid json {{{');
  });

  try {
    const adapter = createEosAdapter(makeCtx(`http://127.0.0.1:${mock.port}`));
    const result = await adapter.pullSchedule();
    assert.equal(result, null, 'Should return null on malformed JSON');
  } finally {
    await mock.close();
  }
});

// --- Test 5: convertEosPlanToSlots converts EOS plan format to 15-min slot array ---
test('convertEosPlanToSlots converts EOS plan format to array of { ts, endTs, powerW, confidence }', async () => {
  const eosPlan = {
    result: [
      { start_time: '2026-04-03T12:00:00', battery_power: 2000 }
    ]
  };

  const mock = await createMockEos((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(eosPlan));
  });

  try {
    const adapter = createEosAdapter(makeCtx(`http://127.0.0.1:${mock.port}`));
    const slots = await adapter.pullSchedule();

    assert.equal(slots.length, 4, 'One hourly entry -> 4x 15-min slots');

    const baseTs = new Date('2026-04-03T12:00:00Z').getTime();
    assert.equal(slots[0].ts, baseTs);
    assert.equal(slots[0].endTs, baseTs + 15 * 60_000);
    assert.equal(slots[0].powerW, 2000);
    assert.equal(slots[0].confidence, 0.7);

    assert.equal(slots[1].ts, baseTs + 15 * 60_000);
    assert.equal(slots[1].endTs, baseTs + 30 * 60_000);
    assert.equal(slots[2].ts, baseTs + 30 * 60_000);
    assert.equal(slots[3].ts, baseTs + 45 * 60_000);
    assert.equal(slots[3].endTs, baseTs + 60 * 60_000);
  } finally {
    await mock.close();
  }
});

// --- Test 6: EOS response validation rejects missing required fields ---
test('EOS response validation rejects missing required fields (no result key)', async () => {
  const mock = await createMockEos((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // Missing 'result' key entirely
    res.end(JSON.stringify({ status: 'ok', data: [] }));
  });

  try {
    const adapter = createEosAdapter(makeCtx(`http://127.0.0.1:${mock.port}`));
    const result = await adapter.pullSchedule();
    assert.equal(result, null, 'Should return null when result key is missing');
  } finally {
    await mock.close();
  }
});

// --- Test 7: httpRequest times out after configured timeout ---
test('httpRequest times out and returns { ok: false, error } (consistent error contract)', async () => {
  // Create a server that never responds
  const mock = await createMockEos((req, res) => {
    // Intentionally do not respond -- let it hang
  });

  try {
    // Use a very short timeout override for test speed
    const adapter = createEosAdapter(makeCtx(`http://127.0.0.1:${mock.port}`), { timeoutMs: 200 });
    // 19.1-01: pushForecast now skips empty-slot sections, so we must supply
    // at least one non-empty section to trigger the HTTP call that will time out.
    const result = await adapter.pushForecast({
      pv: { slots: [{ ts: '2026-04-03T12:00:00Z', watts: 1000 }] },
      price: { slots: [] },
      load: { slots: [] }
    });

    assert.equal(result.ok, false, 'Should return ok: false on timeout');
    assert.ok(typeof result.error === 'string', 'Should have error string');
    assert.ok(result.error.toLowerCase().includes('timeout') || result.error.toLowerCase().includes('timed out'),
      'Error should mention timeout');
  } finally {
    await mock.close();
  }
});

// --- Test 8: isAvailable returns false when EOS is not reachable ---
test('isAvailable() returns false when EOS is not reachable (connection refused)', async () => {
  // Use a port that is NOT listening
  const adapter = createEosAdapter(makeCtx('http://127.0.0.1:19999'));
  const available = await adapter.isAvailable();
  assert.equal(available, false, 'Should return false when connection is refused');
});
