// epex-price-source.test.js — verifies the user-selectable price source
// (epex.priceSource) routing added 2026-06-17:
//   'dvhub'  → dvhub.online primary + Energy-Charts silent fallback
//   'public' → Energy-Charts directly, dvhub.online skipped
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createEpexFetcher } from '../epex-fetch.js';

function makeCtx(priceSource) {
  const recorded = [];
  const state = { epex: { ok: false, data: [], updatedAt: 0 } };
  const cfg = {
    epex: {
      enabled: true,
      bzn: 'DE-LU',
      timezone: 'Europe/Berlin',
      priceSource,
      priceApiUrl: 'https://dvhub.online'
    }
  };
  const ctx = {
    state,
    getCfg: () => cfg,
    pushLog: () => {},
    telemetrySafeWrite: (fn) => { try { fn(); } catch { /* ignore */ } },
    telemetryStore: { writeSamples: () => {} },
    healthTracker: { recordSample: () => {} },
    publishRuntimeSnapshot: () => {}
  };
  return { ctx, recorded, state };
}

describe('epex price source selection (epex.priceSource)', () => {
  const realFetch = globalThis.fetch;
  let recorded;

  function installFetch(rec) {
    globalThis.fetch = async (url) => {
      const u = String(url);
      rec.push(u);
      if (u.includes('dvhub.online') && u.includes('/api/prices')) {
        // dvhub returns one valid slot for "now" so it survives the day filter
        return { ok: true, json: async () => ({ data: [{ ts: new Date().toISOString(), price: 100 }] }) };
      }
      if (u.includes('energy-charts.info')) {
        return { ok: true, json: async () => ({ unix_seconds: [Math.floor(Date.now() / 1000)], price: [50] }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
  }

  beforeEach(() => { recorded = []; });
  afterEach(() => { globalThis.fetch = realFetch; });

  it("priceSource='public' fetches Energy-Charts and never hits dvhub.online", async () => {
    const { ctx, recorded: rec } = makeCtx('public');
    installFetch(rec);
    await createEpexFetcher(ctx).fetchEpexDay();
    assert.ok(rec.some((u) => u.includes('energy-charts.info')), 'Energy-Charts must be queried');
    assert.ok(!rec.some((u) => u.includes('dvhub.online')), 'dvhub.online must be skipped in public mode');
  });

  it("priceSource='dvhub' queries dvhub.online first", async () => {
    const { ctx, recorded: rec } = makeCtx('dvhub');
    installFetch(rec);
    await createEpexFetcher(ctx).fetchEpexDay();
    assert.ok(rec.length > 0, 'a fetch must occur');
    assert.ok(rec[0].includes('dvhub.online'), 'dvhub mode must try dvhub.online first');
  });

  it('unset priceSource defaults to dvhub (backward compatible)', async () => {
    const { ctx, recorded: rec } = makeCtx(undefined);
    installFetch(rec);
    await createEpexFetcher(ctx).fetchEpexDay();
    assert.ok(rec[0].includes('dvhub.online'), 'unset source must behave like dvhub');
  });
});
