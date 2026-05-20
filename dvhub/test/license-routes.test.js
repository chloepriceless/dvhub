import test from 'node:test';
import assert from 'node:assert/strict';
// Wave 0 scaffold — tests skipped until services/license/index.js exists (Phase 17 Plan 02+).
// DO NOT import createLicenseService here yet — that would fail the suite at collection time.

// R-1, R-5, R-6 — see VALIDATION.md §Wave 0 Requirements
// Pattern source: test/smoke-phase05.test.js:807-823 (createApiRoutes + handleRequest)
// Pattern source: test/family-api.test.js:13-128 (mockCtx)

test.skip('POST /api/license/activate persists state and returns 200 ok:true on VALID', async () => {
  // TODO: implement in Plan 02/03/04 — see 17-PATTERNS.md §4 NEW endpoints
  // mock fetch -> VALID, handleRequest(POST /api/license/activate body:{key:'DVHB-AAAA'})
  // -> 200, body.ok=true, body.status='active'; license_state.json written
  assert.ok(true);
});

test.skip('POST /api/license/activate returns 422 ok:false on NOT_FOUND', async () => {
  // TODO: implement in Plan 02/03/04 — see 17-PATTERNS.md §Pitfall 1 (HTTP 200 + meta.code mapping)
  // mock fetch -> NOT_FOUND -> route emits 422 (not 200, not 500), body.ok=false, body.status='invalid'
  assert.ok(true);
});

test.skip('POST /api/license/activate rejects empty key with 400', async () => {
  // TODO: implement in Plan 02/03/04 — see 17-PATTERNS.md §Input Sanitization
  // body:{key:''} -> 400, body.error='empty_key', fetch NOT called
  assert.ok(true);
});

test.skip('GET /api/license/state returns masked fingerprint, never full key', async () => {
  // TODO: implement in Plan 02/03/04 — see 17-CONTEXT.md D-19
  // Pre-state: license_state.json contains license_key=full 'DVHB-XXXX-XXXX-XXXX-AAAA'
  // GET /api/license/state response body MUST NOT contain the full key; only key_fingerprint='DVHB-…AAAA'
  assert.ok(true);
});

test.skip('POST /api/license/revalidate triggers same code path as poller', async () => {
  // TODO: implement in Plan 02/03/04 — see 17-CONTEXT.md D-11
  // POST /api/license/revalidate {} -> 200, body.ok=true; underlying svc.revalidateLicense() called once
  assert.ok(true);
});

test.skip('POST /api/license/remove resets status to none', async () => {
  // TODO: implement in Plan 02/03/04 — see 17-SPEC.md R-1 (Lizenz entfernen)
  // POST /api/license/remove {} -> 200, body.ok=true; subsequent GET /api/license/state -> status='none'
  assert.ok(true);
});

test.skip('GET /api/family/status returns 403 pro_required when license !== active', async () => {
  // TODO: implement in Plan 02/03/04 — see 17-PATTERNS.md §Two-gate pattern
  // state.license.status='none' -> requirePro returns false -> 403 body:{error:'pro_required', feature:'family-dashboard'}
  assert.ok(true);
});

test.skip('GET /api/family/status returns 200 when license === active', async () => {
  // TODO: implement in Plan 02/03/04
  // state.license.status='active' -> requirePro returns true -> handler runs -> 200
  assert.ok(true);
});

test.skip('GET /api/family/presence returns 403 pro_required when license !== active', async () => {
  // TODO: implement in Plan 02/03/04 — see 17-PATTERNS.md (all 7 /api/family/* handlers)
  assert.ok(true);
});

test.skip('GET /api/family/tile-history returns 403 pro_required when license !== active', async () => {
  // TODO: implement in Plan 02/03/04
  assert.ok(true);
});

test.skip('GET /api/family/tesla-history returns 403 pro_required when license !== active', async () => {
  // TODO: implement in Plan 02/03/04
  assert.ok(true);
});

test.skip('GET /family page returns 403 pro_required when license !== active', async () => {
  // TODO: implement in Plan 02/03/04 — see 17-CONTEXT.md D-08 (static-file serving for family.html/.js/.css)
  // GET /family.html with no license -> 403 pro_required (not the static file)
  assert.ok(true);
});
