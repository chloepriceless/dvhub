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
// Phase 21 (2026-05-23): EOS v0.3.0 doesn't actually accept the documented
// {timestamps, values} shape — its OpenAPI declares anyOf:[{},null] but the
// implementation only successfully imports a dict {ISO_TS: value}. The
// adapter now emits the dict shape (eos-adapter.js buildDateTimeData) — and
// includes ?force_enable=true via url.search (was being stripped by the
// http.request path:url.pathname call, silently returning 404).
test('pushForecast sends per-provider PUT to /v1/prediction/import with ts-keyed dict body', async () => {
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

    // Find each provider call. URLs MUST include ?force_enable=true after
    // the 2026-05-23 hotfix — without it EOS won't enable the *Import
    // provider on the fly and returns 404.
    const stripQs = u => (u || '').split('?')[0];
    const pvReq = mock.requests.find(r => stripQs(r.url) === '/v1/prediction/import/PVForecastImport');
    const loadReq = mock.requests.find(r => stripQs(r.url) === '/v1/prediction/import/LoadImport');
    const priceReq = mock.requests.find(r => stripQs(r.url) === '/v1/prediction/import/ElecPriceImport');
    assert.ok(pvReq, 'Should PUT PVForecastImport');
    assert.ok(loadReq, 'Should PUT LoadImport');
    assert.ok(priceReq, 'Should PUT ElecPriceImport');
    assert.equal(pvReq.method, 'PUT');
    assert.ok((pvReq.url || '').includes('force_enable=true'), 'PV PUT must carry ?force_enable=true (path:url.pathname+url.search bug fix)');
    assert.equal(typeof pvReq.body, 'object', 'PV body must be a dict');
    assert.ok(!Array.isArray(pvReq.body), 'PV body must be a plain dict, not array');
    const pvKeys = Object.keys(pvReq.body);
    assert.equal(pvKeys.length, 2, 'PV body should carry 2 ts→watts entries');
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(pvKeys[0]), 'PV body keys should be ISO timestamps');
    assert.equal(typeof pvReq.body[pvKeys[0]], 'number', 'PV body values should be numbers');
  } finally {
    await mock.close();
  }
});

// --- Test 2: pullSchedule GETs /v1/energy-management/plan and returns parsed schedule ---
// Phase 21 (2026-05-23): EOS v0.3.0 plan shape changed — top-level key
// `instructions` (was `result`) and per-entry FRBCInstruction shape with
// operation_mode_id + factor (was start_time + battery_power). The adapter
// translates FORCED_CHARGE/DISCHARGE to ±factor × maxChargeW.
test('pullSchedule GETs /v1/energy-management/plan and returns parsed schedule', async () => {
  const eosPlan = {
    id: 'plan-genetic@2026-04-03T12:00:00Z',
    generated_at: '2026-04-03T12:00:00Z',
    instructions: [
      { type: 'FRBCInstruction', actuator_id: 'battery1', execution_time: '2026-04-03T12:00:00Z',
        operation_mode_id: 'FORCED_CHARGE',    operation_mode_factor: 1.0 },
      { type: 'FRBCInstruction', actuator_id: 'battery1', execution_time: '2026-04-03T13:00:00Z',
        operation_mode_id: 'FORCED_DISCHARGE', operation_mode_factor: 0.5 }
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
    assert.equal(slots.length, 8, 'Two hourly FRBC entries -> 8x 15-min slots');
    assert.ok(typeof slots[0].ts === 'number', 'Slot should have numeric ts');
    assert.ok(typeof slots[0].endTs === 'number', 'Slot should have numeric endTs');
    assert.ok(typeof slots[0].powerW === 'number', 'Slot should have numeric powerW');
    assert.equal(slots[0].confidence, 0.7, 'Confidence should be 0.7 for EOS');
    assert.equal(slots[0].planAction, 'FORCED_CHARGE', 'planAction surfaces operation_mode_id');
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

// --- Test 5: convertEosPlanToSlots converts EOS FRBC plan to 15-min slot array ---
// Phase 21: FORCED_CHARGE at factor 0.5 with the makeCtx maxChargeW=5000
// fallback (no optimizer config supplied) → 0.5 × 5000 = 2500 W per slot.
test('convertEosPlanToSlots converts EOS plan format to array of { ts, endTs, powerW, confidence }', async () => {
  const eosPlan = {
    id: 'plan-x',
    instructions: [
      { type: 'FRBCInstruction', actuator_id: 'battery1', execution_time: '2026-04-03T12:00:00Z',
        operation_mode_id: 'FORCED_CHARGE', operation_mode_factor: 0.5 }
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
    assert.equal(slots[0].powerW, 2500, '0.5 × default maxChargeW (5000) = 2500');
    assert.equal(slots[0].planAction, 'FORCED_CHARGE');
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
