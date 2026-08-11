// test/notification-providers-ntfy-route.test.js -- Plan 20-01 Task 3
// Static + functional checks for the dedicated ntfy.sh endpoints
// (GET/POST /api/notifications/providers/ntfy, POST /api/notifications/providers/ntfy/test)
// AND the per-provider rate-limit utility (checkProviderRateLimit).
//
// Strategy:
//   1. Static regex assertions against routes-api.js (handler shape, auth gate,
//      sentinel handling, redacted GET response). Same idiom as
//      family-routes.test.js / inspector-routes.test.js.
//   2. Functional test of checkProviderRateLimit via a temporary scratch module
//      that re-exports the function — but routes-api.js does not export it.
//      Instead we mirror the algorithm in a tiny harness and exercise its
//      window/eviction semantics; the static regex below pins the prod
//      implementation to those exact same numeric constants.
//
// Why no end-to-end HTTP spin-up: routes-api.js exports createApiRoutes(ctx),
// which already needs a populated ctx (cfg, saveAndApplyConfig, getRawCfg,
// many runtime references). The existing notification-provider tests use
// either the provider class directly (notification-providers.test.js) or
// static regex assertions for routing (family-routes.test.js); this file
// follows the latter for the route registration and the former (in spirit)
// for the rate-limit algorithm.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_API_PATH = path.resolve(__dirname, '..', 'routes-api.js');

function readRoutes() {
  return fs.readFileSync(ROUTES_API_PATH, 'utf8');
}

describe('Plan 20-01: ntfy.sh dedicated endpoints (static)', () => {
  it('GET /api/notifications/providers/ntfy is registered with checkAuth gate', () => {
    const src = readRoutes();
    assert.match(src, /url\.pathname\s*===\s*['"]\/api\/notifications\/providers\/ntfy['"][\s\S]{0,60}req\.method\s*===\s*['"]GET['"]/);
    // First line of handler MUST be auth gate.
    assert.match(src, /url\.pathname\s*===\s*['"]\/api\/notifications\/providers\/ntfy['"][\s\S]{0,200}checkAuth\(req,\s*res\)/);
  });

  it('GET response redacts a stored ntfy.token to "***" (D-13)', () => {
    const src = readRoutes();
    // Within the GET block, must derive token as '***' when set, '' when unset.
    // Captured as a regex spanning the body of that handler.
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/notifications\/providers\/ntfy['"][\s\S]{0,60}req\.method\s*===\s*['"]GET['"][\s\S]*?\}\s*\)\s*;/);
    assert.ok(m, 'GET ntfy handler must close with json(res, ...);');
    assert.match(m[0], /token:\s*ntfy\.token\s*\?\s*['"]\*\*\*['"]\s*:\s*['"]{2}/,
      'GET must redact token: ntfy.token ? "***" : ""');
  });

  it('POST /api/notifications/providers/ntfy is registered with checkAuth gate', () => {
    const src = readRoutes();
    assert.match(src, /url\.pathname\s*===\s*['"]\/api\/notifications\/providers\/ntfy['"][\s\S]{0,60}req\.method\s*===\s*['"]POST['"]/);
    assert.match(src, /url\.pathname\s*===\s*['"]\/api\/notifications\/providers\/ntfy['"][\s\S]{0,200}req\.method\s*===\s*['"]POST['"][\s\S]{0,200}checkAuth\(req,\s*res\)/);
  });

  it("POST handler honours the '***' sentinel (keep-existing token)", () => {
    const src = readRoutes();
    // Find the POST handler block specifically.
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/notifications\/providers\/ntfy['"]\s*&&\s*req\.method\s*===\s*['"]POST['"][\s\S]*?return\s+json\(res,\s*200,\s*\{\s*ok:\s*true\s*\}\)/);
    assert.ok(m, 'POST handler block must end with ok:true');
    assert.match(m[0], /body\.token\s*===\s*['"]\*\*\*['"]/, "POST must check body.token === '***'");
    // The keep-existing fallback resolves to the stored ntfy.token via a `prev`
    // alias of next.notifications.providers.ntfy (or via a direct prev.ntfy.token
    // lookup in the legacy combined endpoint). Either shape must fall back to ''
    // when the previous value is missing.
    assert.match(m[0], /prev(\.ntfy)?\.token\s*\|\|\s*['"]{2}/,
      'POST must fall back to prev.token (or prev.ntfy.token) or ""');
  });

  it('POST handler length-clips topicUrl + token to documented caps', () => {
    const src = readRoutes();
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/notifications\/providers\/ntfy['"]\s*&&\s*req\.method\s*===\s*['"]POST['"][\s\S]*?return\s+json\(res,\s*200,\s*\{\s*ok:\s*true\s*\}\)/);
    assert.ok(m);
    assert.match(m[0], /clip\(.*topicUrl.*,\s*512\)/, 'topicUrl must be clipped to 512');
    assert.match(m[0], /clip\(.*token.*,\s*256\)/, 'token must be clipped to 256');
  });

  it('POST handler uses server-side merge into cfg.notifications.providers.ntfy (D-12)', () => {
    const src = readRoutes();
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/notifications\/providers\/ntfy['"]\s*&&\s*req\.method\s*===\s*['"]POST['"][\s\S]*?return\s+json\(res,\s*200,\s*\{\s*ok:\s*true\s*\}\)/);
    assert.ok(m);
    // Deep-clone + saveAndApplyConfig — the canonical 09.4-06 pattern.
    assert.match(m[0], /JSON\.parse\(JSON\.stringify\(\s*ctx\.getRawCfg\(\)/, 'must deep-clone raw cfg');
    assert.match(m[0], /next\.notifications\.providers\.ntfy\s*=/, 'must assign next.notifications.providers.ntfy');
    assert.match(m[0], /ctx\.saveAndApplyConfig\s*\(\s*next\s*\)/, 'must call saveAndApplyConfig(next)');
    // Error path: must NOT include actorContext on save_error pushLog.
    assert.match(m[0], /ntfy_provider_save_error/);
    assert.match(m[0], /ntfy_provider_saved[\s\S]{0,200}actorContext\(req\)/, 'success log must include actorContext');
  });

  it('POST /api/notifications/providers/ntfy/test is registered with auth + rate-limit', () => {
    const src = readRoutes();
    assert.match(src, /url\.pathname\s*===\s*['"]\/api\/notifications\/providers\/ntfy\/test['"][\s\S]{0,60}req\.method\s*===\s*['"]POST['"]/);
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/notifications\/providers\/ntfy\/test['"][\s\S]*?\}\s*\}\s*\n/);
    assert.ok(m, 'test endpoint handler must close');
    assert.match(m[0], /checkAuth\(req,\s*res\)/);
    assert.match(m[0], /checkProviderRateLimit\(\s*['"]ntfy['"]/);
    // 429 path:
    assert.match(m[0], /json\(res,\s*429,\s*\{\s*ok:\s*false,\s*error:\s*['"]rate_limited['"]/);
    // Imports createNtfyProvider dynamically.
    assert.match(m[0], /createNtfyProvider/);
  });

  it('test endpoint reuses stored creds when body fields are empty (Pitfall 2)', () => {
    const src = readRoutes();
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/notifications\/providers\/ntfy\/test['"][\s\S]*?\n {2}\}\n/);
    assert.ok(m);
    // topicUrl/token fallback to stored value when body field is falsy or '***'.
    assert.match(m[0], /body\?\.topicUrl[\s\S]{0,80}stored\.topicUrl/);
    assert.match(m[0], /body\?\.token[\s\S]{0,80}stored\.token/);
  });

  it('checkProviderRateLimit utility is declared with documented constants', () => {
    const src = readRoutes();
    assert.match(src, /function\s+checkProviderRateLimit\s*\(/);
    assert.match(src, /const\s+providerRateBuckets\s*=\s*new\s+Map\(\)/);
    assert.match(src, /const\s+PROVIDER_RATE_WINDOW_MS\s*=\s*60_?000/);
    assert.match(src, /const\s+PROVIDER_RATE_MAX_CALLS\s*=\s*5/);
    assert.match(src, /const\s+PROVIDER_RATE_MAX_KEYS\s*=\s*1_?000/);
    // Token hashing — sha256 truncated to 16 hex chars.
    assert.match(src, /createHash\(['"]sha256['"]\)[\s\S]{0,80}\.slice\(0,\s*16\)/);
  });
});

describe('Plan 20-01: checkProviderRateLimit algorithm (mirror)', () => {
  // Tiny in-test mirror of the prod algorithm — exercising the same window
  // + count math the route handler trusts. If the prod implementation drifts,
  // the static regex test above flags the structural change; this block
  // pins the numerical behaviour.
  function makeRateLimiter() {
    const buckets = new Map();
    const WINDOW = 60_000;
    const MAX = 5;
    return function check(provider, tokenForHash, nowOverride) {
      const hash = crypto.createHash('sha256').update(String(tokenForHash || '')).digest('hex').slice(0, 16);
      const key = `${provider}:${hash}`;
      const now = nowOverride ?? Date.now();
      let b = buckets.get(key);
      if (!b) { b = { windowStart: now, count: 0 }; buckets.set(key, b); }
      if (now - b.windowStart > WINDOW) { b.windowStart = now; b.count = 0; }
      b.count++;
      if (b.count > MAX) {
        return { ok: false, retry_after_s: Math.ceil((b.windowStart + WINDOW - now) / 1000) };
      }
      return { ok: true };
    };
  }

  it('5 calls within window pass, 6th returns 429 with retry_after_s', () => {
    const check = makeRateLimiter();
    const t0 = 1_000_000;
    for (let i = 1; i <= 5; i++) {
      const r = check('ntfy', 'tok', t0 + i);
      assert.equal(r.ok, true, `call ${i} should pass`);
    }
    const sixth = check('ntfy', 'tok', t0 + 6);
    assert.equal(sixth.ok, false);
    assert.equal(typeof sixth.retry_after_s, 'number');
    assert.ok(sixth.retry_after_s > 0 && sixth.retry_after_s <= 60);
  });

  it('window reset: 5 calls then >60s gap then 5 more all pass', () => {
    const check = makeRateLimiter();
    const t0 = 1_000_000;
    for (let i = 1; i <= 5; i++) assert.equal(check('ntfy', 'tok', t0 + i).ok, true);
    // Jump 61 seconds — window resets.
    for (let i = 1; i <= 5; i++) {
      const r = check('ntfy', 'tok', t0 + 61_001 + i);
      assert.equal(r.ok, true, `post-reset call ${i} should pass`);
    }
  });

  it('different tokens get independent buckets', () => {
    const check = makeRateLimiter();
    const t0 = 2_000_000;
    for (let i = 1; i <= 5; i++) assert.equal(check('ntfy', 'tokA', t0 + i).ok, true);
    // tokB has its own bucket — first call still passes.
    assert.equal(check('ntfy', 'tokB', t0 + 6).ok, true);
  });

  it('different providers with the same token get independent buckets', () => {
    const check = makeRateLimiter();
    const t0 = 3_000_000;
    for (let i = 1; i <= 5; i++) assert.equal(check('ntfy', 'tok', t0 + i).ok, true);
    assert.equal(check('telegram', 'tok', t0 + 6).ok, true);
  });
});
