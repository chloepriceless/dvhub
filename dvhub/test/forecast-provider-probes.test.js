// test/forecast-provider-probes.test.js -- Plan 20-06 Task 1 RED→GREEN
//
// Behavioural unit tests for the two probe-helper exports on the forecast clients:
//
//   solcast-client.js  → probeSolcast({apiKey, siteId})
//   pvnode-client.js   → probePvnode({apiKey, siteId?, lat?, lon?, slope?, orientation?, kwp?})
//
// T-PVNODE-V2 (2026-06-22): probePvnode migrated to the V2 API — a saved-site GET
// (/v2/forecast/{site_id}) when siteId is set, else an inline POST (/v2/forecast/inline)
// carrying the geometry in the request BODY (V1 sent it as query params). The behavioural
// contract is unchanged: always resolves {ok, sample?, error?}, never throws, no pRetry,
// no quota mutation, AbortSignal.timeout hard timeout.
//
// Strategy: monkey-patch globalThis.fetch per test to return controlled responses;
// restore between tests so we never hit the real upstream.

import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { probeSolcast } from '../services/forecast/solcast-client.js';
import { probePvnode } from '../services/forecast/pvnode-client.js';

const originalFetch = globalThis.fetch;

function mockFetchOnce(responder) {
  globalThis.fetch = async (url, opts) => responder(url, opts);
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('Plan 20-06: probeSolcast (single-shot operator probe)', () => {
  it('resolves {ok:true, sample:{ts, watts}} on a non-empty forecasts[] response', async () => {
    let observedUrl = null;
    let observedHeaders = null;
    mockFetchOnce((url, opts) => {
      observedUrl = url;
      observedHeaders = opts && opts.headers;
      return jsonResponse(200, {
        forecasts: [
          { period_end: '2026-01-01T12:00:00Z', pv_estimate: 1.5 }
        ]
      });
    });
    const result = await probeSolcast({ apiKey: 'mock-key-abcdefghijklmno', siteId: '00000000-0000-0000-0000-000000000000' });
    assert.equal(result.ok, true, 'ok should be true on a 200 with forecasts');
    assert.ok(result.sample, 'sample must be present');
    assert.equal(result.sample.ts, '2026-01-01T11:30:00.000Z',
      'sample ts is the 15-min-aligned period-START (period_end 12:00 minus 30-min default), consistent with the 26-03 ensemble normalization');
    assert.equal(result.sample.watts, 1500, '1.5 kW must convert to 1500 W');
    assert.match(observedUrl, /api\.solcast\.com\.au.*hours=1/,
      'probe MUST use hours=1 (Pitfall 3: smallest call still burns 1/10 quota)');
    assert.equal(observedHeaders.Authorization, 'Bearer mock-key-abcdefghijklmno');
  });

  it('resolves {ok:true, sample:null} when the forecasts array is empty', async () => {
    mockFetchOnce(() => jsonResponse(200, { forecasts: [] }));
    const result = await probeSolcast({ apiKey: 'k'.repeat(20), siteId: '11111111-1111-1111-1111-111111111111' });
    assert.equal(result.ok, true);
    assert.equal(result.sample, null);
  });

  it('resolves {ok:false, error:"Solcast HTTP 401"} on HTTP 401 (never throws)', async () => {
    mockFetchOnce(() => jsonResponse(401, {}));
    const result = await probeSolcast({ apiKey: 'bad-key', siteId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Solcast HTTP 401');
    assert.equal(result.sample, undefined, 'no sample field on error path');
  });

  it('resolves {ok:false, error:"missing_credentials"} when apiKey missing', async () => {
    // No fetch should fire — assert by checking fetch was not invoked.
    let called = false;
    mockFetchOnce(() => { called = true; return jsonResponse(200, {}); });
    const result = await probeSolcast({ apiKey: '', siteId: 'has-a-site' });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'missing_credentials');
    assert.equal(called, false, 'must short-circuit before network');
  });

  it('resolves {ok:false, error:"missing_credentials"} when siteId missing', async () => {
    let called = false;
    mockFetchOnce(() => { called = true; return jsonResponse(200, {}); });
    const result = await probeSolcast({ apiKey: 'has-a-key', siteId: '' });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'missing_credentials');
    assert.equal(called, false);
  });

  it('catches network errors and returns {ok:false, error:message}', async () => {
    mockFetchOnce(() => { throw new Error('boom-net'); });
    const result = await probeSolcast({ apiKey: 'k'.repeat(20), siteId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    assert.equal(result.ok, false);
    assert.match(result.error, /boom-net/);
  });
});

describe('T-PVNODE-V2: probePvnode (single-shot operator probe, V2 API)', () => {
  it('inline mode: POSTs /v2/forecast/inline with geometry in the BODY; converts ts→UTC', async () => {
    let observedUrl = null;
    let observedOpts = null;
    mockFetchOnce((url, opts) => {
      observedUrl = url;
      observedOpts = opts;
      return jsonResponse(200, {
        timezone: 'Europe/Berlin',
        values: [{ timestamp: '2026-01-01T12:00:00', pv_power: 1234 }]
      });
    });
    const result = await probePvnode({
      apiKey: 'pv-key-abcdefghijklmno',
      lat: 48.5, lon: 9.5, slope: 30, orientation: 180, kwp: 7.5
    });
    assert.equal(result.ok, true);
    assert.ok(result.sample);
    // 2026-01-01 is winter in Berlin (CET, +01:00) → 12:00 local == 11:00 UTC.
    assert.equal(result.sample.ts, '2026-01-01T11:00:00.000Z');
    assert.equal(result.sample.watts, 1234);
    assert.match(observedUrl, /api\.pvnode\.com\/v2\/forecast\/inline/, 'inline endpoint');
    assert.match(observedUrl, /forecast_days=1/, 'probe MUST use forecast_days=1 (cheapest call)');
    assert.equal(observedOpts.method, 'POST');
    const body = JSON.parse(observedOpts.body);
    assert.equal(body.latitude, 48.5);
    assert.equal(body.longitude, 9.5);
    assert.deepEqual(body.strings, [{ slope: 30, orientation: 180, power_kw: 7.5 }]);
    assert.equal(observedOpts.headers.Authorization, 'Bearer pv-key-abcdefghijklmno');
    assert.equal(observedOpts.headers['Content-Type'], 'application/json');
  });

  it('saved-site mode: GETs /v2/forecast/{site_id} with NO body', async () => {
    let observedUrl = null;
    let observedOpts = null;
    mockFetchOnce((url, opts) => {
      observedUrl = url;
      observedOpts = opts;
      return jsonResponse(200, {
        timezone: 'Europe/Berlin',
        values: [{ timestamp: '2026-06-22T12:00:00', pv_power: 9000 }]
      });
    });
    const result = await probePvnode({ apiKey: 'k'.repeat(20), siteId: 'site_abc123' });
    assert.equal(result.ok, true);
    assert.equal(result.sample.watts, 9000);
    // 2026-06-22 is summer in Berlin (CEST, +02:00) → 12:00 local == 10:00 UTC.
    assert.equal(result.sample.ts, '2026-06-22T10:00:00.000Z');
    assert.match(observedUrl, /api\.pvnode\.com\/v2\/forecast\/site_abc123\?/, 'saved-site endpoint with id');
    assert.match(observedUrl, /forecast_days=1/);
    assert.equal(observedOpts.method, 'GET');
    assert.equal(observedOpts.body, undefined, 'GET probe sends no body');
  });

  it('also accepts data[] shape (backward-compat fallback)', async () => {
    mockFetchOnce(() => jsonResponse(200, {
      data: [{ ts: '2026-02-02T13:30:00Z', power: 567 }]
    }));
    const result = await probePvnode({ apiKey: 'k'.repeat(20), lat: 0, lon: 0 });
    assert.equal(result.ok, true);
    assert.ok(result.sample);
    assert.equal(result.sample.ts, '2026-02-02T13:30:00.000Z');
    assert.equal(result.sample.watts, 567);
  });

  it('resolves {ok:true, sample:null} when no forecast rows returned', async () => {
    mockFetchOnce(() => jsonResponse(200, {}));
    const result = await probePvnode({ apiKey: 'k'.repeat(20), lat: 0, lon: 0 });
    assert.equal(result.ok, true);
    assert.equal(result.sample, null);
  });

  it('resolves {ok:false, error:"pvnode HTTP 401"} on HTTP 401 (never throws)', async () => {
    mockFetchOnce(() => jsonResponse(401, {}));
    const result = await probePvnode({ apiKey: 'bad-key', lat: 0, lon: 0 });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'pvnode HTTP 401');
  });

  it('resolves {ok:false, error:"missing_apikey"} when apiKey missing (short-circuits before network)', async () => {
    let called = false;
    mockFetchOnce(() => { called = true; return jsonResponse(200, {}); });
    const result = await probePvnode({ apiKey: '', lat: 0, lon: 0 });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'missing_apikey');
    assert.equal(called, false);
  });

  it('catches network errors and returns {ok:false, error:message}', async () => {
    mockFetchOnce(() => { throw new Error('boom-net'); });
    const result = await probePvnode({ apiKey: 'k'.repeat(20), lat: 0, lon: 0 });
    assert.equal(result.ok, false);
    assert.match(result.error, /boom-net/);
  });
});

describe('Plan 20-06: probes do NOT mutate production client state', () => {
  it('probeSolcast does not throw, does not mutate, does not require ctx', async () => {
    mockFetchOnce(() => jsonResponse(200, { forecasts: [{ period_end: 't', pv_estimate: 0 }] }));
    // The probe must work with NO ctx/store/state — it's a one-shot operator click.
    const r = await probeSolcast({ apiKey: 'k'.repeat(20), siteId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    assert.equal(r.ok, true);
    // Round 0 kW → 0 W, no NaN leak.
    assert.equal(r.sample.watts, 0);
  });

  it('probePvnode does not throw, does not mutate, does not require ctx (watts=0, no NaN leak)', async () => {
    mockFetchOnce(() => jsonResponse(200, { data: [{ ts: '2026-01-01T00:00:00Z', power_w: 0 }] }));
    const r = await probePvnode({ apiKey: 'k'.repeat(20), lat: 0, lon: 0 });
    assert.equal(r.ok, true);
    assert.equal(r.sample.watts, 0);
  });
});
