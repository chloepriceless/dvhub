import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createEosAdapter } from '../services/optimizer/eos-adapter.js';
import { buildScheduleRules } from '../services/optimizer/schedule-builder.js';

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
// Phase 21 (2026-05-23 v3): EOS' writable storage keys are per-provider
// record names (pvforecast_ac_power, loadforecast_power_w,
// elecprice_marketprice_wh, feed_in_tariff_wh). The body shape is
// PydanticDateTimeData: {start_datetime, interval, <recordKey>: [values]}.
// Plus ?force_enable=true via url.search.
test('pushForecast sends per-provider PUT with PydanticDateTimeData shape', async () => {
  const mock = await createMockEos((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  });

  try {
    const adapter = createEosAdapter(makeCtx(`http://127.0.0.1:${mock.port}`));

    // Slot shape MUST match buildForecastResponse() output exactly:
    // pv/load → { start: ISO, powerW }, price → { start: ISO, ctKwh }.
    // (Earlier this mock used { ts, watts }, a shape the real forecast service
    // never emits — so the test passed while production PUT a null body and EOS
    // returned HTTP 400 for every provider.)
    const forecastResponse = {
      pv: {
        slots: [
          { start: '2026-04-03T12:00:00Z', powerW: 3000 },
          { start: '2026-04-03T13:00:00Z', powerW: 2500 }
        ]
      },
      price: {
        slots: [
          { start: '2026-04-03T12:00:00Z', ctKwh: 15.2 },
          { start: '2026-04-03T13:00:00Z', ctKwh: 18.5 }
        ]
      },
      load: {
        slots: [
          { start: '2026-04-03T12:00:00Z', powerW: 800 },
          { start: '2026-04-03T13:00:00Z', powerW: 900 }
        ]
      }
    };

    const result = await adapter.pushForecast(forecastResponse);

    assert.equal(result.ok, true);
    assert.ok(result.perProvider, 'Should return perProvider report');
    assert.ok(mock.requests.length >= 2, 'Should fire pv/load PUTs (price/feed_in owned by the bridge — Phase 30 R2)');

    // Find each provider call. URLs MUST include ?force_enable=true after
    // the 2026-05-23 hotfix — without it EOS won't enable the *Import
    // provider on the fly and returns 404.
    const stripQs = u => (u || '').split('?')[0];
    const pvReq = mock.requests.find(r => stripQs(r.url) === '/v1/prediction/import/PVForecastImport');
    const loadReq = mock.requests.find(r => stripQs(r.url) === '/v1/prediction/import/LoadImport');
    const priceReq = mock.requests.find(r => stripQs(r.url) === '/v1/prediction/import/ElecPriceImport');
    const feedInReq = mock.requests.find(r => stripQs(r.url) === '/v1/prediction/import/FeedInTariffImport');
    assert.ok(pvReq, 'Should PUT PVForecastImport');
    assert.ok(loadReq, 'Should PUT LoadImport');
    // Phase 30 (P30-R2): the adapter no longer writes the price signal. The
    // EOS-Forecast-Bridge is the canonical single-source writer for elecprice +
    // feed_in (fixed-tariff import price + Direktvermarktung premium). The adapter
    // pushing raw spot here used to RACE the bridge (last-writer-wins) and clobber
    // both fixes (prod 2026-06-22: elecprice == feed_in == raw spot).
    assert.equal(priceReq, undefined, 'Adapter must NOT PUT ElecPriceImport — bridge owns the price signal (Phase 30 R2)');
    assert.equal(feedInReq, undefined, 'Adapter must NOT PUT FeedInTariffImport — bridge owns feed-in (Phase 30 R2)');
    assert.equal(pvReq.method, 'PUT');
    assert.ok((pvReq.url || '').includes('force_enable=true'), 'PV PUT must carry ?force_enable=true');
    assert.equal(typeof pvReq.body, 'object', 'PV body must be a dict');
    assert.ok(!Array.isArray(pvReq.body), 'PV body must be a plain dict, not array');
    assert.ok(typeof pvReq.body.start_datetime === 'string', 'PV body has start_datetime');
    assert.ok(typeof pvReq.body.interval === 'string', 'PV body has interval');
    assert.ok(Array.isArray(pvReq.body.pvforecast_ac_power), 'PV body keyed by pvforecast_ac_power');
    assert.equal(pvReq.body.pvforecast_ac_power.length, 2);
    // Lock the actual values — guards the null-body / wrong-field-name regression.
    assert.deepEqual(pvReq.body.pvforecast_ac_power, [3000, 2500], 'PV values from slot.powerW');
    assert.ok(Array.isArray(loadReq.body.loadforecast_power_w), 'Load body keyed by loadforecast_power_w');
    assert.deepEqual(loadReq.body.loadforecast_power_w, [800, 900], 'Load values from slot.powerW');
  } finally {
    await mock.close();
  }
});

// --- Test 1b (Phase 30 R2): adapter never writes the price signal, even in
// fixed-import + spot-feed-in mode — the bridge is the single source. Regression
// guard for the prod race (2026-06-22) where the adapter clobbered the bridge's
// flat 26.9 ct elecprice and premium feed-in with raw spot. ---
test('pushForecast never PUTs ElecPriceImport/FeedInTariffImport (bridge owns price — Phase 30 R2)', async () => {
  const mock = await createMockEos((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  try {
    // fixed import + spot feed-in: the exact prod config where the adapter used
    // to push raw spot to both providers and clobber both DVhub fixes.
    const ctx = {
      getCfg: () => ({
        optimizer: { eosProxy: { url: `http://127.0.0.1:${mock.port}` }, tariff: { feedInMode: 'spot', feedInSpotFactor: 1.0 } },
        userEnergyPricing: { mode: 'fixed', fixedGrossImportCtKwh: 26.9 }
      }),
      pushLog: () => {}
    };
    const adapter = createEosAdapter(ctx);
    const forecastResponse = {
      pv: { slots: [ { start: '2026-04-03T12:00:00Z', powerW: 3000 } ] },
      load: { slots: [ { start: '2026-04-03T12:00:00Z', powerW: 800 } ] },
      price: { slots: [ { start: '2026-04-03T12:00:00Z', ctKwh: 6.0 }, { start: '2026-04-03T12:15:00Z', ctKwh: 22.9 } ] }
    };
    const result = await adapter.pushForecast(forecastResponse);
    assert.equal(result.ok, true);
    const stripQs = u => (u || '').split('?')[0];
    const urls = mock.requests.map(r => stripQs(r.url));
    assert.ok(!urls.includes('/v1/prediction/import/ElecPriceImport'), 'adapter must not PUT ElecPriceImport (bridge owns it)');
    assert.ok(!urls.includes('/v1/prediction/import/FeedInTariffImport'), 'adapter must not PUT FeedInTariffImport (bridge owns it)');
    assert.equal(result.perProvider.price?.skipped != null, true, 'price marked skipped (bridge owns)');
    assert.equal(result.perProvider.feedIn?.skipped != null, true, 'feed-in marked skipped (bridge owns)');
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
      pv: { slots: [{ start: '2026-04-03T12:00:00Z', powerW: 1000 }] },
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

// --- Test 9: getOptimizationSolution parses EOS output into compact rows + KPIs ---
// EOS' /v1/energy-management/optimization/solution returns an OptimizationSolution
// with a datetime-keyed `solution.data` frame + KPI totals. The adapter projects
// it to { rows:[{ts_utc,socPct,gridConsumptionWh,gridFeedinWh,costsAmt,revenueAmt}],
// kpis, slotMinutes, ... }. SoC key is derived dynamically (battery1_soc_factor).
test('getOptimizationSolution parses solution.data into rows + KPIs', async () => {
  const solution = {
    generated_at: '2026-05-29T02:32:58+02:00',
    valid_from: '2026-05-29T02:00:00+02:00',
    valid_until: '2026-05-30T02:00:00+02:00',
    total_costs_amt: 5.62,
    total_revenues_amt: 8.71,
    total_losses_energy_wh: 9551.0,
    solution: {
      data: {
        '2026-05-29T02:00:00+02:00': {
          battery1_soc_factor: 0.13, grid_consumption_energy_wh: 815, grid_feedin_energy_wh: 0,
          costs_amt: 0.124, revenue_amt: 0.0, ev11_soc_factor: 0.7,
        },
        '2026-05-29T02:15:00+02:00': {
          battery1_soc_factor: 0.18, grid_consumption_energy_wh: 0, grid_feedin_energy_wh: 120,
          costs_amt: 0.0, revenue_amt: 0.03, ev11_soc_factor: 0.7,
        },
      },
    },
  };
  const mock = await createMockEos((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(solution));
  });
  try {
    const adapter = createEosAdapter(makeCtx(`http://127.0.0.1:${mock.port}`));
    const out = await adapter.getOptimizationSolution();
    assert.ok(out, 'should return parsed solution');
    assert.equal(out.rows.length, 2);
    assert.equal(out.slotMinutes, 15, 'derives 15-min spacing');
    // SoC factor -> percent, from the BATTERY key (not ev11)
    assert.equal(out.rows[0].socPct, 13);
    assert.equal(out.rows[1].socPct, 18);
    assert.equal(out.rows[0].gridConsumptionWh, 815);
    assert.equal(out.rows[1].gridFeedinWh, 120);
    assert.equal(out.rows[0].costsAmt, 0.124);
    assert.equal(out.rows[1].revenueAmt, 0.03);
    assert.equal(out.kpis.totalCostsAmt, 5.62);
    assert.equal(out.kpis.totalRevenuesAmt, 8.71);
    assert.equal(out.kpis.totalLossesWh, 9551.0);
    assert.equal(out.totalCount, 2);
    assert.equal(out.truncated, false);
  } finally {
    await mock.close();
  }
});

// --- Test 10: getOptimizationSolution returns null on 404 (no solution yet) ---
test('getOptimizationSolution returns null when EOS has no solution (404)', async () => {
  const mock = await createMockEos((req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ detail: 'Can not get the optimization solution.' }));
  });
  try {
    const adapter = createEosAdapter(makeCtx(`http://127.0.0.1:${mock.port}`));
    const out = await adapter.getOptimizationSolution();
    assert.equal(out, null);
  } finally {
    await mock.close();
  }
});

// --- T-0118: pullGridSetpoints maps EOS SOLUTION net-grid → export setpoints ---
// EOS' plan op-modes carry no power, so the export plan must come from the
// solution's per-slot net grid (grid_consumption − grid_feedin). Only deliberate
// EXPORTs are emitted; imports/holds are left to the plant default; exports at a
// negative feed-in price are dropped (never pay to export).
test('pullGridSetpoints emits only genuine exports, skips import/hold/negative-price', async () => {
  const solution = {
    generated_at: '2026-06-06T20:00:00Z',
    valid_from: '2026-06-06T20:00:00Z',
    valid_until: '2026-06-06T21:15:00Z',
    solution: {
      data: {
        // peak export @14ct → -14000 W setpoint  (EMIT)
        '2026-06-06T20:00:00Z': { battery1_soc_factor: 0.95, grid_consumption_energy_wh: 0, grid_feedin_energy_wh: 3500 },
        // tiny net import (self-consumption) → +80 W → SKIP
        '2026-06-06T20:15:00Z': { battery1_soc_factor: 0.90, grid_consumption_energy_wh: 20, grid_feedin_energy_wh: 0 },
        // grid covers load (battery at floor) → +3200 W import → SKIP (never force charge)
        '2026-06-06T20:30:00Z': { battery1_soc_factor: 0.90, grid_consumption_energy_wh: 800, grid_feedin_energy_wh: 0 },
        // export but at NEGATIVE price → -8000 W → SKIP (never pay to export)
        '2026-06-06T20:45:00Z': { battery1_soc_factor: 0.85, grid_consumption_energy_wh: 0, grid_feedin_energy_wh: 2000 },
        // export within the noise band → -200 W → SKIP
        '2026-06-06T21:00:00Z': { battery1_soc_factor: 0.85, grid_consumption_energy_wh: 0, grid_feedin_energy_wh: 50 },
      },
    },
    prediction: {
      data: {
        '2026-06-06T20:00:00Z': { feed_in_tariff_amt_kwh: 0.14 },
        '2026-06-06T20:15:00Z': { feed_in_tariff_amt_kwh: 0.13 },
        '2026-06-06T20:30:00Z': { feed_in_tariff_amt_kwh: 0.10 },
        '2026-06-06T20:45:00Z': { feed_in_tariff_amt_kwh: -0.02 },
        '2026-06-06T21:00:00Z': { feed_in_tariff_amt_kwh: 0.13 },
      },
    },
  };
  const mock = await createMockEos((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(solution));
  });
  try {
    const adapter = createEosAdapter(makeCtx(`http://127.0.0.1:${mock.port}`));
    const slots = await adapter.pullGridSetpoints();
    assert.equal(slots.length, 1, 'only the genuine peak export is emitted');
    const base = new Date('2026-06-06T20:00:00Z').getTime();
    assert.equal(slots[0].ts, base);
    assert.equal(slots[0].endTs, base + 15 * 60_000);
    assert.equal(slots[0].powerW, -14000, 'net-grid export setpoint = -(3500Wh / 0.25h)');
    assert.equal(slots[0].planAction, 'eos_grid_export');
    assert.equal(slots[0].confidence, 0.7);
  } finally {
    await mock.close();
  }
});

// --- T-0124b: pure PV-surplus feed-in → dcExportMode lever (live PV drives it);
//     deliberate battery export → gridSetpointW closed-loop. ---
test('pullGridSetpoints: pure PV-surplus (B=0) → dcExportMode lever, battery-export (B>0) → gridSetpointW', async () => {
  const solution = {
    generated_at: '2026-06-06T20:00:00Z',
    valid_from: '2026-06-06T20:00:00Z',
    valid_until: '2026-06-06T20:30:00Z',
    solution: {
      data: {
        // export 1000Wh/0.25h = -4000W, forecast PV surplus fully covers it → B=0 → dcExportMode
        '2026-06-06T20:00:00Z': { battery1_soc_factor: 0.60, grid_consumption_energy_wh: 0, grid_feedin_energy_wh: 1000 },
        // export 4000Wh/0.25h = -16000W, PV surplus only 1000W → B=15000 → gridSetpointW
        '2026-06-06T20:15:00Z': { battery1_soc_factor: 0.90, grid_consumption_energy_wh: 0, grid_feedin_energy_wh: 4000 },
      },
    },
    prediction: {
      data: {
        // PV surplus (1500-250)/0.25 = 5000W ≥ 4000W export → battery share 0
        '2026-06-06T20:00:00Z': { feed_in_tariff_amt_kwh: 0.12, pvforecast_ac_energy_wh: 1500, loadforecast_energy_wh: 250 },
        // PV surplus (250-0)/0.25 = 1000W ≪ 16000W export → battery share 15000
        '2026-06-06T20:15:00Z': { feed_in_tariff_amt_kwh: 0.12, pvforecast_ac_energy_wh: 250, loadforecast_energy_wh: 0 },
      },
    },
  };
  const mock = await createMockEos((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(solution));
  });
  try {
    const adapter = createEosAdapter(makeCtx(`http://127.0.0.1:${mock.port}`));
    const slots = await adapter.pullGridSetpoints();
    assert.equal(slots.length, 2, 'both genuine exports are emitted, each with its lever');

    const pv = slots.find((s) => s.ts === new Date('2026-06-06T20:00:00Z').getTime());
    assert.ok(pv, 'pure PV-surplus slot is emitted');
    assert.equal(pv.lever, 'dcExportMode', 'PV-surplus feed-in uses the dcExportMode lever');
    assert.equal(pv.planAction, 'eos_pv_export');
    assert.equal(pv.powerW, undefined, 'no static setpoint — live PV drives it');
    assert.ok(!pv.closedLoopExport, 'dcExportMode slot is not a closed-loop gridSetpointW export');

    const batt = slots.find((s) => s.ts === new Date('2026-06-06T20:15:00Z').getTime());
    assert.ok(batt, 'battery-export slot is emitted');
    assert.equal(batt.lever, 'gridSetpointW', 'battery export uses the gridSetpointW lever');
    assert.equal(batt.powerW, -16000);
    assert.equal(batt.closedLoopExport, true);
    assert.equal(batt.batteryShareW, 15000, 'B = |gridW| - forecast PV surplus = 16000 - 1000');
    assert.equal(batt.planAction, 'eos_grid_export');
  } finally {
    await mock.close();
  }
});

// --- T-0124b: buildScheduleRules maps a dcExportMode lever slot to a dcExportMode rule ---
test('buildScheduleRules: dcExportMode lever slot → target=dcExportMode, value=1', () => {
  const slots = [
    { ts: 1717704000000, endTs: 1717704900000, lever: 'dcExportMode', planAction: 'eos_pv_export', confidence: 0.7 },
    { ts: 1717704900000, endTs: 1717705800000, lever: 'gridSetpointW', powerW: -16000, batteryShareW: 15000, closedLoopExport: true, confidence: 0.7 },
  ];
  const rules = buildScheduleRules({ slots, source: 'forecast_optimizer', optimizer: 'eos', getCfg: () => ({ schedule: { timezone: 'Europe/Berlin' } }) });
  assert.equal(rules.length, 2);
  assert.equal(rules[0].target, 'dcExportMode');
  assert.equal(rules[0].value, 1);
  assert.ok(!('closedLoopExport' in rules[0]), 'dcExportMode rule carries no closed-loop fields');
  assert.equal(rules[1].target, 'gridSetpointW');
  assert.equal(rules[1].value, -16000);
  assert.equal(rules[1].closedLoopExport, true);
  assert.equal(rules[1].batteryShareW, 15000);
});

// --- T-CURTAIL-CHARGE (Christin 2026-06-25): a surplus slot where EOS ALSO charges
// the battery (planned net export < PV surplus) must carry chargeReserveW = PV surplus
// − planned net export, so schedule-eval reserves it instead of exporting the charge.
// A pure-surplus slot (residual ≤ band) carries no reserve (behaviour unchanged).
test('pullGridSetpoints: surplus+charge slot carries chargeReserveW; pure-surplus slot does not', async () => {
  const solution = {
    generated_at: '2026-06-20T08:00:00Z',
    valid_from: '2026-06-20T08:00:00Z',
    valid_until: '2026-06-20T08:30:00Z',
    solution: {
      data: {
        // export 2000Wh/0.25h = -8000W; PV surplus 18000W ≫ 8000W → B=0 (dcExportMode);
        // plannedCharge = surplus 18000 − net export 8000 = 10000W > band → reserve 10000
        '2026-06-20T08:00:00Z': { battery1_soc_factor: 0.50, grid_consumption_energy_wh: 0, grid_feedin_energy_wh: 2000 },
        // export 1000Wh/0.25h = -4000W; PV surplus 4000W == export → plannedCharge 0 → no reserve
        '2026-06-20T08:15:00Z': { battery1_soc_factor: 0.55, grid_consumption_energy_wh: 0, grid_feedin_energy_wh: 1000 },
      },
    },
    prediction: {
      data: {
        // PV (5000-500)/0.25 = 18000W surplus
        '2026-06-20T08:00:00Z': { feed_in_tariff_amt_kwh: 0.12, pvforecast_ac_energy_wh: 5000, loadforecast_energy_wh: 500 },
        // PV (1250-250)/0.25 = 4000W surplus == 4000W export → no charge
        '2026-06-20T08:15:00Z': { feed_in_tariff_amt_kwh: 0.12, pvforecast_ac_energy_wh: 1250, loadforecast_energy_wh: 250 },
      },
    },
  };
  const mock = await createMockEos((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(solution));
  });
  try {
    const adapter = createEosAdapter(makeCtx(`http://127.0.0.1:${mock.port}`));
    const slots = await adapter.pullGridSetpoints();

    const charge = slots.find((s) => s.ts === new Date('2026-06-20T08:00:00Z').getTime());
    assert.ok(charge, 'surplus+charge slot is emitted');
    assert.equal(charge.lever, 'dcExportMode', 'still a PV-surplus (dcExportMode) lever');
    assert.equal(charge.planAction, 'eos_pv_export');
    assert.equal(charge.chargeReserveW, 10000, 'chargeReserveW = PV surplus 18000 − net export 8000');

    const pure = slots.find((s) => s.ts === new Date('2026-06-20T08:15:00Z').getTime());
    assert.ok(pure, 'pure-surplus slot is emitted');
    assert.equal(pure.lever, 'dcExportMode');
    assert.equal(pure.chargeReserveW, undefined, 'no charge reserve when export ≈ PV surplus');
  } finally {
    await mock.close();
  }
});

// --- T-CURTAIL-CHARGE: schedule-builder carries chargeReserveW onto the dcExportMode rule ---
test('buildScheduleRules: dcExportMode slot carries chargeReserveW onto the rule (only when >0)', () => {
  const slots = [
    { ts: 1717704000000, endTs: 1717704900000, lever: 'dcExportMode', planAction: 'eos_pv_export', confidence: 0.7, chargeReserveW: 10000 },
    { ts: 1717704900000, endTs: 1717705800000, lever: 'dcExportMode', planAction: 'eos_pv_export', confidence: 0.7 },
  ];
  const rules = buildScheduleRules({ slots, source: 'forecast_optimizer', optimizer: 'eos', getCfg: () => ({ schedule: { timezone: 'Europe/Berlin' } }) });
  assert.equal(rules.length, 2);
  assert.equal(rules[0].target, 'dcExportMode');
  assert.equal(rules[0].value, 1);
  assert.equal(rules[0].chargeReserveW, 10000, 'reserve carried onto the rule');
  assert.ok(!('chargeReserveW' in rules[1]), 'pure-surplus rule carries no reserve field');
});

// --- T-0121: pullGridSetpoints caps actuated rules to the horizon ---
test('pullGridSetpoints caps rules to ruleHorizonHours (no churning far-future rules)', async () => {
  const now = Date.now();
  const k0 = new Date(now + 1 * 3600_000).toISOString();          // +1 h  (in horizon)
  const k1 = new Date(now + 1 * 3600_000 + 900_000).toISOString(); // +1h15 (in horizon, sets slotMinutes=15)
  const k2 = new Date(now + 20 * 3600_000).toISOString();         // +20 h (BEYOND 12 h horizon → skip)
  const solution = {
    solution: { data: {
      [k0]: { battery1_soc_factor: 0.95, grid_consumption_energy_wh: 0, grid_feedin_energy_wh: 3500 },
      [k1]: { battery1_soc_factor: 0.94, grid_consumption_energy_wh: 0, grid_feedin_energy_wh: 3500 },
      [k2]: { battery1_soc_factor: 0.93, grid_consumption_energy_wh: 0, grid_feedin_energy_wh: 3500 },
    } },
    prediction: { data: {
      [k0]: { feed_in_tariff_amt_kwh: 0.14 },
      [k1]: { feed_in_tariff_amt_kwh: 0.14 },
      [k2]: { feed_in_tariff_amt_kwh: 0.14 },
    } },
  };
  const mock = await createMockEos((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(solution));
  });
  try {
    const adapter = createEosAdapter(makeCtx(`http://127.0.0.1:${mock.port}`));
    const slots = await adapter.pullGridSetpoints();
    assert.equal(slots.length, 2, 'only the two in-horizon exports are actuated; the +20 h one is dropped');
    const cutoff = now + 12 * 3600_000;
    for (const s of slots) assert.ok(s.ts <= cutoff, 'no rule beyond the 12 h horizon');
  } finally {
    await mock.close();
  }
});

test('pullGridSetpoints returns null when EOS has no solution (404)', async () => {
  const mock = await createMockEos((req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ detail: 'Can not get the optimization solution.' }));
  });
  try {
    const adapter = createEosAdapter(makeCtx(`http://127.0.0.1:${mock.port}`));
    assert.equal(await adapter.pullGridSetpoints(), null);
  } finally {
    await mock.close();
  }
});

test('pullGridSetpoints returns [] when EOS plans no export (all self-consumption)', async () => {
  const solution = {
    generated_at: '2026-06-06T20:00:00Z',
    solution: {
      data: {
        '2026-06-06T20:00:00Z': { battery1_soc_factor: 0.5, grid_consumption_energy_wh: 100, grid_feedin_energy_wh: 0 },
        '2026-06-06T20:15:00Z': { battery1_soc_factor: 0.5, grid_consumption_energy_wh: 0, grid_feedin_energy_wh: 0 },
      },
    },
    prediction: { data: {} },
  };
  const mock = await createMockEos((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(solution));
  });
  try {
    const adapter = createEosAdapter(makeCtx(`http://127.0.0.1:${mock.port}`));
    const slots = await adapter.pullGridSetpoints();
    assert.deepEqual(slots, [], 'no export slots → empty list (plant self-regulates)');
  } finally {
    await mock.close();
  }
});

// --- Test 11: convertEosPlanToSlots fills variable gaps (15-min change-points) ---
// After the geneticsolution.py 15-min fix, EOS emits an instruction only when
// the mode CHANGES, on the 15-min grid. Each instruction must hold until the
// NEXT one (not a blind 4x split); the trailing one fills to valid_until.
test('pullSchedule fills 15-min change-point instructions until next / valid_until', async () => {
  const eosPlan = {
    id: 'plan-15min',
    valid_until: '2026-04-03T12:45:00Z',
    instructions: [
      { type: 'FRBCInstruction', actuator_id: 'battery1', execution_time: '2026-04-03T12:00:00Z',
        operation_mode_id: 'FORCED_CHARGE', operation_mode_factor: 1.0 },
      { type: 'FRBCInstruction', actuator_id: 'battery1', execution_time: '2026-04-03T12:15:00Z',
        operation_mode_id: 'FORCED_DISCHARGE', operation_mode_factor: 1.0 },
    ],
  };
  const mock = await createMockEos((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(eosPlan));
  });
  try {
    const adapter = createEosAdapter(makeCtx(`http://127.0.0.1:${mock.port}`));
    const slots = await adapter.pullSchedule();
    // 12:00→12:15 = 1 CHARGE slot; 12:15→12:45 (valid_until) = 2 DISCHARGE slots.
    assert.equal(slots.length, 3, '1 charge + 2 discharge 15-min slots');
    assert.equal(slots[0].planAction, 'FORCED_CHARGE');
    assert.equal(slots[1].planAction, 'FORCED_DISCHARGE');
    assert.equal(slots[2].planAction, 'FORCED_DISCHARGE');
    // No overlap: timestamps strictly increase by 15 min.
    assert.equal(slots[1].ts - slots[0].ts, 15 * 60_000);
    assert.equal(slots[2].ts - slots[1].ts, 15 * 60_000);
  } finally {
    await mock.close();
  }
});
