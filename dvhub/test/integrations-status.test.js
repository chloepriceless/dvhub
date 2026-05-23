// test/integrations-status.test.js -- RED tests for /api/integrations/status (D-06 + D-09)
//
// Wave 0 (plan 09.4-01): the /api/integrations/status handler lives inside the
// big routes-api.js request handler and is awkward to invoke standalone, so
// these tests assert (a) the D-06 providers-array TRANSFORM the Wave-2 route
// edit must satisfy, and (b) the D-09 identity keys as a source-text marker.
//
// The D-09 test FAILS now (RED) — the handler has no victron/mid/luox keys —
// and GREENS when plan 09.4-02 adds them. RED is correct for Wave 0.
//
// Contract under test (from 09.4-RESEARCH.md § Pattern 3 + § Open Question 1):
//   D-06: notifications.providers = [{name,enabled}, ...] — INCLUDES disabled
//   D-09: the /status payload also exposes victron / mid / luox identity objects
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROUTES_API_PATH = join(__dirname, '..', 'routes-api.js');

describe('/api/integrations/status — D-06 providers array', () => {
  it('D-06: providers list includes disabled providers as {name,enabled}', () => {
    // The route edit (plan 09.4-04 Task) must transform the per-provider config
    // object into [{name,enabled}] WITHOUT dropping disabled providers. This
    // test encodes that transform literally so the Wave-2 edit has a concrete
    // green-target — the route handler must produce exactly this shape.
    const cfg = {
      notifications: {
        providers: {
          telegram: { enabled: true },
          ntfy: { enabled: false }
        }
      }
    };

    const providers = Object.entries(cfg.notifications.providers)
      .map(([name, v]) => ({ name, enabled: !!v.enabled }));

    assert.deepEqual(providers, [
      { name: 'telegram', enabled: true },
      { name: 'ntfy', enabled: false }
    ], 'disabled providers are kept, each as {name,enabled}');
  });
});

describe('/api/integrations/status — D-09 identity keys', () => {
  it('D-09: status payload exposes victron/mid/luox identity keys', () => {
    // Contract marker test: slice routes-api.js from the /api/integrations/status
    // HANDLER (not the LAN_SAFE_ENDPOINTS comment) and assert the handler body
    // surfaces victron, mid and luox identity objects. RED now — the handler
    // only emits mqtt/tesla/homeAssistant/loxone/devices/notifications. GREENS
    // when plan 09.4-02 extends the handler with the D-09 identity objects.
    const src = readFileSync(ROUTES_API_PATH, 'utf8');
    const anchor = "if (url.pathname === '/api/integrations/status'";
    const idx = src.indexOf(anchor);
    assert.ok(idx >= 0, 'the /api/integrations/status handler exists in routes-api.js');

    // Window grew 1200 → 2000 → 3000 over Phase 21 (2026-05-23) as the mqtt
    // and tesla blocks gained operator-facing `config` echoes + broker info
    // for the integrations-page drawers. Pure marker test — a bigger window
    // doesn't weaken the contract; the three identity keys still must exist.
    const handlerSlice = src.slice(idx, idx + 3000);
    assert.ok(
      handlerSlice.includes('victron'),
      'D-09: handler exposes a victron identity object (RED until 09.4-02)'
    );
    assert.ok(
      handlerSlice.includes('mid'),
      'D-09: handler exposes a mid identity object (RED until 09.4-02)'
    );
    assert.ok(
      handlerSlice.includes('luox'),
      'D-09: handler exposes a luox identity object (RED until 09.4-02)'
    );
  });
});
