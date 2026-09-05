import test from 'node:test';
import assert from 'node:assert/strict';

import { createHistoryRuntime } from '../history-runtime.js';

// Regression guard for the 2026-09-05 prod stall: view='all' loaded the whole
// history in ONE materialized query (~1M rows for ~45k slots), which pushed a
// 2 GiB LXC into swap-thrash and, under --max-old-space-size=400, dies with a
// V8 heap OOM. Jahr/Alle must read the materialized store in calendar-month
// chunks so peak memory tracks the largest month, never the span.
//
// The fake store records every {start,end} range it is asked for. The
// assertions are about the SHAPE of the requests, not the numbers: no single
// request may span more than one Berlin calendar month, the chunks must tile
// the View-Range contiguously, and the result order must be chronological.
//
// Written red-first: against the pre-fix history-runtime.js (public/main
// 29a7bac7) the 'all' case issues exactly one request spanning 2015→next year
// and this file fails; with the chunked loader it passes.

const BERLIN = 'Europe/Berlin';
const berlinMonth = (iso) => new Intl.DateTimeFormat('en-CA', {
  timeZone: BERLIN, year: 'numeric', month: '2-digit'
}).format(new Date(iso));

// A range [start, end) lies within one calendar month if its first and its
// last instant fall in the same Berlin month.
function spansSingleMonth({ start, end }) {
  const lastInstant = new Date(new Date(end).getTime() - 60_000).toISOString();
  return berlinMonth(start) === berlinMonth(lastInstant);
}

function createRecordingStore({ slotsPerRange = 1 } = {}) {
  const requests = [];
  return {
    requests,
    listMaterializedEnergySlots({ start, end, sourceKinds }) {
      requests.push({ start, end, sourceKinds });
      // One tiny slot at the start of each requested range keeps the pipeline
      // non-empty (so no raw fallback fires) and lets us check result order.
      const out = [];
      for (let i = 0; i < slotsPerRange; i += 1) {
        out.push({
          ts: new Date(new Date(start).getTime() + i * 900_000).toISOString(),
          importKwh: 0.1, exportKwh: 0, gridKwh: 0.1, pvKwh: 0, pvAcKwh: 0,
          batteryKwh: 0, batteryChargeKwh: 0, batteryDischargeKwh: 0, loadKwh: 0.1,
          solarDirectUseKwh: 0, solarToBatteryKwh: 0, solarToGridKwh: 0,
          gridDirectUseKwh: 0.1, gridToBatteryKwh: 0, batteryDirectUseKwh: 0, batteryToGridKwh: 0,
          selfConsumptionKwh: 0, sourceKind: 'vrm_import', sourceKinds: ['vrm_import'],
          estimated: false, incomplete: false,
          estimatedSeriesCount: 0, incompleteSeriesCount: 0,
          estimatedSeriesKeys: [], incompleteSeriesKeys: []
        });
      }
      return out;
    },
    // Present so the raw-fallback branch exists; must NOT be hit while the
    // materialized store returns rows.
    listAggregatedEnergySlots() {
      throw new Error('raw fallback must not run while materialized rows exist');
    },
    listPriceSlots() { return []; }
  };
}

function makeRuntime(store) {
  return createHistoryRuntime({
    store,
    getPricingConfig: () => ({}),
    getCurrentDate: () => '2026-09-05'
  });
}

test("view='all' reads the materialized store in calendar-month chunks, never one span", async () => {
  const store = createRecordingStore();
  const runtime = makeRuntime(store);

  await runtime.getSummary({ view: 'all', date: '2026-09-05' });

  const reqs = store.requests;
  assert.ok(reqs.length > 1, `expected many month-sized requests, got ${reqs.length}`);
  for (const r of reqs) {
    assert.ok(spansSingleMonth(r), `request spans more than one month: ${r.start} → ${r.end}`);
  }
});

test("view='year' reads twelve month chunks that tile the year without gaps or overlap", async () => {
  const store = createRecordingStore();
  const runtime = makeRuntime(store);

  await runtime.getSummary({ view: 'year', date: '2026-03-09' });

  const reqs = store.requests;
  assert.equal(reqs.length, 12);
  for (const r of reqs) assert.ok(spansSingleMonth(r), `${r.start} → ${r.end}`);
  // Contiguous: each chunk starts exactly where the previous one ended.
  for (let i = 1; i < reqs.length; i += 1) {
    assert.equal(reqs[i].start, reqs[i - 1].end, `gap/overlap between chunk ${i - 1} and ${i}`);
  }
  // Covers the whole Berlin year 2026: first chunk starts at 2026-01-01 Berlin,
  // last chunk ends at 2027-01-01 Berlin.
  assert.equal(berlinMonth(reqs[0].start), '2026-01');
  assert.equal(berlinMonth(new Date(new Date(reqs[11].end).getTime() - 60_000).toISOString()), '2026-12');
});

test('chunked results come back in chronological order', async () => {
  const store = createRecordingStore({ slotsPerRange: 2 });
  const runtime = makeRuntime(store);

  // Ask the summary for something that exposes per-slot order: the series.
  const summary = await runtime.getSummary({ view: 'year', date: '2026-03-09' });
  const ts = (summary.series?.financial || []).map((p) => p.ts).filter(Boolean);
  const sorted = [...ts].sort();
  assert.deepEqual(ts, sorted);
});

test('raw fallback runs ONCE over the whole range only when every chunk is empty', async () => {
  const fallbackRanges = [];
  const store = {
    listMaterializedEnergySlots() { return []; },
    listAggregatedEnergySlots({ start, end }) { fallbackRanges.push({ start, end }); return []; },
    listPriceSlots() { return []; }
  };
  const runtime = makeRuntime(store);

  await runtime.getSummary({ view: 'year', date: '2026-03-09' });

  // Whole-range semantics preserved: not one fallback per empty month (that
  // would be 12+), but a single fallback spanning the View-Range — identical to
  // the single-query path this replaced. The fallback splits at "today" into a
  // history and a live part, so at most two calls, together covering the year.
  assert.ok(fallbackRanges.length >= 1 && fallbackRanges.length <= 2, `got ${fallbackRanges.length} fallback calls`);
  assert.equal(berlinMonth(fallbackRanges[0].start), '2026-01');
  const last = fallbackRanges[fallbackRanges.length - 1];
  assert.equal(berlinMonth(new Date(new Date(last.end).getTime() - 60_000).toISOString()), '2026-12');
});
