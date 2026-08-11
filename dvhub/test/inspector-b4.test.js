// test/inspector-b4.test.js — Phase 19 Plan 19-05 (GREEN after plan 19-05 lands).
//
// Behavior contract for the B4 EOS-Output inspector:
//   - getEos calls eosAdapter.isAvailable() first
//   - on false → returns {available:false, reason:'eos_off'} WITHOUT pushForecast/pullSchedule
//   - on missing adapter → returns {available:false, reason:'adapter_unavailable'}
//   - on isAvailable throw → treated as unavailable
//   - on true → calls both pushForecast + pullSchedule (in parallel via Promise.all)
//   - returns the production envelope (available, window, push, pull, meta.timeoutMs)
//   - push.ok / pull.ok / errors surface correctly
//   - server.js wires a second adapter with timeoutMs:5000 (static-source check —
//     Pitfall 7 / Open Question 2 in 19-RESEARCH)
//
// Mocks mirror the REAL services/optimizer/eos-adapter.js interface verbatim:
//   - pushForecast → { ok: boolean, error?: string }
//   - pullSchedule → Array<{ts,endTs,powerW,confidence}> | null  (NOT {ok,data})
//   - isAvailable  → boolean
// Plan 19-05's first-draft test scaffold described pullSchedule as
// {ok,data?,error?}; the live impl returns an array (eos-adapter.js:169-187).
// Tests use the live shape so the inspector body works against production AND
// the test mocks identically — [Rule 1 - Bug] auto-fix per gsd executor rules.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInspector } from '../services/forecast/inspector.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = path.resolve(__dirname, '..', 'server.js');

function makeCtx() {
  return { state: { forecast: {} }, getCfg: () => ({}), pushLog: () => {} };
}

// Mock matches REAL adapter shape:
//   pushForecast → {ok, error?}
//   pullSchedule → Array | null
function makeEosStub({ available = true, pushOk = true, pullOk = true, pullData = null } = {}) {
  let availCalls = 0, pushCalls = 0, pullCalls = 0;
  return {
    isAvailable: async () => { availCalls++; return available; },
    pushForecast: async () => {
      pushCalls++;
      return pushOk ? { ok: true } : { ok: false, error: 'mock_push_err' };
    },
    pullSchedule: async () => {
      pullCalls++;
      return pullOk ? (pullData || []) : null;
    },
    _counts: () => ({ availCalls, pushCalls, pullCalls }),
  };
}

function makeForecastService(payload) {
  return { buildForecastResponse: async () => payload };
}

test('B4 getEos returns available:false reason:eos_off when isAvailable=false (no push/pull)', async () => {
  const eosAdapter = makeEosStub({ available: false });
  const forecastService = makeForecastService({ pv: { slots: [] }, load: { slots: [] }, price: { slots: [] } });
  const inspector = createInspector(makeCtx(), { eosAdapter, forecastService });
  const out = await inspector.getEos({ from: 'a', to: 'b' });
  assert.equal(out.available, false);
  assert.equal(out.reason, 'eos_off');
  const counts = eosAdapter._counts();
  assert.equal(counts.pushCalls, 0, 'pushForecast must NOT fire when eos is unavailable');
  assert.equal(counts.pullCalls, 0, 'pullSchedule must NOT fire when eos is unavailable');
});

test('B4 getEos returns adapter_unavailable when no adapter is wired', async () => {
  const inspector = createInspector(makeCtx(), { eosAdapter: null, forecastService: makeForecastService({}) });
  const out = await inspector.getEos({ from: 'a', to: 'b' });
  assert.equal(out.available, false);
  assert.equal(out.reason, 'adapter_unavailable');
});

test('B4 getEos calls pushForecast AND pullSchedule when isAvailable=true', async () => {
  const eosAdapter = makeEosStub({
    available: true,
    pullData: [
      { ts: Date.parse('2026-05-20T10:00:00Z'), endTs: Date.parse('2026-05-20T10:15:00Z'), powerW: 3200, confidence: 0.7 },
      { ts: Date.parse('2026-05-20T10:15:00Z'), endTs: Date.parse('2026-05-20T10:30:00Z'), powerW: 0, confidence: 0.7 },
    ],
  });
  const forecastService = makeForecastService({
    pv: { slots: [{ start: '2026-05-20T10:00:00Z', powerW: 5000 }, { start: '2026-05-20T10:15:00Z', powerW: 4800 }, { start: '2026-05-20T10:30:00Z', powerW: 4500 }] },
    load: { slots: [{ start: '2026-05-20T10:00:00Z', powerW: 800 }, { start: '2026-05-20T10:15:00Z', powerW: 850 }] },
    price: { slots: [{ start: '2026-05-20T10:00:00Z', ctKwh: 12 }, { start: '2026-05-20T10:15:00Z', ctKwh: 12 }, { start: '2026-05-20T10:30:00Z', ctKwh: 13 }, { start: '2026-05-20T10:45:00Z', ctKwh: 13 }] },
  });
  const inspector = createInspector(makeCtx(), { eosAdapter, forecastService });
  const out = await inspector.getEos({ from: 'a', to: 'b' });
  assert.equal(out.available, true);
  const counts = eosAdapter._counts();
  assert.equal(counts.pushCalls, 1);
  assert.equal(counts.pullCalls, 1);
  assert.equal(out.push.ok, true);
  assert.equal(out.pull.ok, true);
  assert.equal(out.pull.slots.length, 2);
  assert.equal(out.pull.slots[0].planPowerW, 3200);
  assert.equal(out.push.payloadSummary.pvSlotCount, 3);
  assert.equal(out.push.payloadSummary.loadSlotCount, 2);
  assert.equal(out.push.payloadSummary.priceSlotCount, 4);
  assert.equal(out.meta.timeoutMs, 5000);
});

test('B4 getEos surfaces pushForecast failure as push.ok=false but still attempts pullSchedule', async () => {
  const eosAdapter = makeEosStub({ available: true, pushOk: false, pullData: [] });
  const forecastService = makeForecastService({ pv: { slots: [] }, load: { slots: [] }, price: { slots: [] } });
  const inspector = createInspector(makeCtx(), { eosAdapter, forecastService });
  const out = await inspector.getEos({ from: 'a', to: 'b' });
  assert.equal(out.available, true);
  assert.equal(out.push.ok, false);
  assert.equal(out.push.error, 'mock_push_err');
  assert.equal(out.pull.ok, true, 'pull should be attempted in parallel even when push fails');
});

test('B4 getEos treats isAvailable() throw as unavailable (DoS-safe)', async () => {
  const eosAdapter = {
    isAvailable: async () => { throw new Error('connection refused'); },
    pushForecast: async () => ({ ok: true }),
    pullSchedule: async () => [],
  };
  const forecastService = makeForecastService({});
  const inspector = createInspector(makeCtx(), { eosAdapter, forecastService });
  const out = await inspector.getEos({ from: 'a', to: 'b' });
  assert.equal(out.available, false);
  assert.equal(out.reason, 'eos_off');
});

test('B4 — server.js wires a second EOS adapter with timeoutMs:5000 (static-source check)', () => {
  const src = fs.readFileSync(SERVER_SRC, 'utf8');
  // The dedicated Inspector EOS adapter (5s timeout, per RESEARCH §Pitfall 7).
  // The original 30s adapter inside services/optimizer/index.js stays untouched.
  assert.match(src, /createEosAdapter[A-Za-z_0-9]*\([^)]*\{\s*timeoutMs:\s*5000\s*\}/,
    'server.js must instantiate a second EOS adapter with timeoutMs:5000 for the Inspector read path');
});

// --- T-RESERVE-VISIBILITY: reserve-Feld im getEos-Envelope -------------------
// Die Übernacht-Reserve-Gates (systemd-Env der eos.service) reisen read-only im
// Inspector-Envelope mit. Auf Hosts ohne Drop-in-Verzeichnis (CI, dev) muss das
// Feld existieren und ehrlich available:false melden — nie fehlen/raten.
test('T-RESERVE: getEos-Envelope trägt reserve (available:false ohne Drop-in-Verzeichnis ok)', async () => {
  const eosAdapter = makeEosStub({ available: true, pullData: [] });
  const forecastService = makeForecastService({ pv: { slots: [] }, load: { slots: [] }, price: { slots: [] } });
  const inspector = createInspector(makeCtx(), { eosAdapter, forecastService });
  const out = await inspector.getEos({ from: 'a', to: 'b' });
  assert.ok(out.reserve, 'reserve-Feld muss im Envelope sein');
  assert.equal(typeof out.reserve.available, 'boolean');
  if (out.reserve.available) {
    assert.ok(out.reserve.gates, 'available:true → gates vorhanden');
    assert.equal(typeof out.reserve.gates.waterfall, 'boolean');
  } else {
    assert.ok(out.reserve.reason, 'available:false → reason vorhanden');
  }
});
