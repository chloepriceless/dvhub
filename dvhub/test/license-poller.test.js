import test from 'node:test';
import assert from 'node:assert/strict';
// Wave 0 scaffold — tests skipped until services/license/index.js exists (Phase 17 Plan 02+).
// DO NOT import createLicenseService here yet — that would fail the suite at collection time.

// R-5 + Pitfall 4 — see VALIDATION.md §Wave 0 Requirements
// Pattern source: services/forecast/weather-fetch.js:139-145 (verified overlap-guard under test)

test.skip('24h setInterval schedule fires once per 24h with timer injection', async () => {
  // TODO: implement in Plan 02/03/04 — see 17-RESEARCH.md §Pitfall 4
  // Inject ctx.timers = { setInterval: fakeSetInterval, setTimeout: fakeSetTimeout, clearInterval: ... }
  // Advance virtual clock 24h, assert fetch called once (after first 30s + 24h cycle)
  assert.ok(true);
});

test.skip('first validate runs 30s after boot, not immediately', async () => {
  // TODO: implement in Plan 02/03/04 — see 17-CONTEXT.md D-11
  // start() schedules setTimeout(fn, 30_000), NOT immediate fetch — boot must not block on Keygen
  assert.ok(true);
});

test.skip('overlap-guard early-returns when a previous revalidate is in flight', async () => {
  // TODO: implement in Plan 02/03/04 — see 17-RESEARCH.md §Pitfall 4
  // Start a long-running revalidate; trigger setInterval tick while first is still pending
  // Second invocation must early-return without calling fetch a second time (running flag set)
  assert.ok(true);
});
