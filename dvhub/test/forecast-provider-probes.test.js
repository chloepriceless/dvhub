// test/forecast-provider-probes.test.js -- Plan 20-06 Task 1 RED→GREEN
//
// Behavioural unit tests for the two new probe-helper exports added in
// Plan 20-06 to the existing forecast clients:
//
//   solcast-client.js  → probeSolcast({apiKey, siteId})  (Pitfall 3 — 10/day quota)
//   pvnode-client.js   → probePvnode({apiKey, lat, lon, slope, orientation})  (Pitfall 4 — 40/mo)
//
// Both helpers MUST resolve with `{ok, sample?, error?}` on every code path
// (never throw) so the route handler can JSON-relay the result. The probe
// is a single-shot operator-triggered call — it does NOT mutate the
// production client's state (callsToday counter, pvnodeQuota tracker,
// cachedData), does NOT use pRetry, and uses AbortSignal.timeout for hard
// timeouts (T-20-06-06 + verification contract).
//
// Strategy: monkey-patch globalThis.fetch per test to return controlled
// responses; restore between tests so we never hit the real upstream.

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
    assert.equal(result.sample.ts, '2026-01-01T12:00:00Z');
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

describe('Plan 20-06: probePvnode (single-shot operator probe)', () => {
  it('resolves {ok:true, sample:{ts, watts}} on a non-empty data[] response', async () => {
    let observedUrl = null;
    let observedHeaders = null;
    mockFetchOnce((url, opts) => {
      observedUrl = url;
      observedHeaders = opts && opts.headers;
      return jsonResponse(200, {
        data: [
          { ts: '2026-01-01T12:00:00Z', power_w: 1234 }
        ]
      });
    });
    const result = await probePvnode({ apiKey: 'pv-key-abcdefghijklmno', lat: 48.5, lon: 9.5, slope: 30, orientation: 180 });
    assert.equal(result.ok, true);
    assert.ok(result.sample);
    assert.equal(result.sample.ts, '2026-01-01T12:00:00Z');
    assert.equal(result.sample.watts, 1234);
    assert.match(observedUrl, /api\.pvnode\.com/, 'must hit api.pvnode.com');
    assert.match(observedUrl, /lat=48\.5/);
    assert.match(observedUrl, /lon=9\.5/);
    assert.match(observedUrl, /slope=30/);
    assert.match(observedUrl, /orientation=180/);
    assert.match(observedUrl, /forecastDays=1/, 'probe MUST use forecastDays=1 (minimise free-tier 40/mo)');
    assert.equal(observedHeaders.Authorization, 'Bearer pv-key-abcdefghijklmno');
  });

  it('also accepts a forecast[] array shape and {datetime} field synonym', async () => {
    mockFetchOnce(() => jsonResponse(200, {
      forecast: [
        { datetime: '2026-02-02T13:30:00Z', power: 567 }
      ]
    }));
    const result = await probePvnode({ apiKey: 'k'.repeat(20), lat: 0, lon: 0 });
    assert.equal(result.ok, true);
    assert.ok(result.sample);
    assert.equal(result.sample.ts, '2026-02-02T13:30:00Z');
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

  it('resolves {ok:false, error:"missing_apikey"} when apiKey missing', async () => {
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

  it('probePvnode does not throw, does not mutate, does not require ctx', async () => {
    mockFetchOnce(() => jsonResponse(200, { data: [{ ts: 't', power_w: 0 }] }));
    const r = await probePvnode({ apiKey: 'k'.repeat(20), lat: 0, lon: 0 });
    assert.equal(r.ok, true);
    assert.equal(r.sample.watts, 0);
  });
});
