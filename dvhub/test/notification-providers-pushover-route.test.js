// test/notification-providers-pushover-route.test.js -- Plan 20-03 Task 2
// Static regex assertions for the 3 dedicated Pushover endpoints
// (GET/POST /api/notifications/providers/pushover,
//  POST /api/notifications/providers/pushover/test) — mirrors the
// notification-providers-telegram-route.test.js shape from Plan 20-02.
//
// Strategy: same as the telegram + ntfy route tests — static regex over
// routes-api.js. End-to-end HTTP spin-up requires a populated ctx (cfg,
// saveAndApplyConfig, getRawCfg, runtime references); the established
// pattern in dvhub/test/ is to pin the route registration + handler shape
// via regex assertions instead.
//
// Threat T-20-03-04 specific assertion: the test endpoint MUST hard-code
// `level: 'info'` and NEVER read it from the request body. The operator
// must not be able to escalate a test-send to priority=1 (urgent) and
// bypass their Pushover quiet hours.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_API_PATH = path.resolve(__dirname, '..', 'routes-api.js');

function readRoutes() {
  return fs.readFileSync(ROUTES_API_PATH, 'utf8');
}

describe('Plan 20-03: Pushover dedicated endpoints (static)', () => {
  it('GET /api/notifications/providers/pushover is registered with checkAuth gate', () => {
    const src = readRoutes();
    assert.match(src, /url\.pathname\s*===\s*['"]\/api\/notifications\/providers\/pushover['"][\s\S]{0,60}req\.method\s*===\s*['"]GET['"]/);
    assert.match(src, /url\.pathname\s*===\s*['"]\/api\/notifications\/providers\/pushover['"][\s\S]{0,200}checkAuth\(req,\s*res\)/);
  });

  it('GET response redacts appToken AND userKey to "***" (D-13, T-20-03-01)', () => {
    const src = readRoutes();
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/notifications\/providers\/pushover['"][\s\S]{0,60}req\.method\s*===\s*['"]GET['"][\s\S]*?\}\s*\)\s*;/);
    assert.ok(m, 'GET pushover handler must close with json(res, ...);');
    assert.match(m[0], /appToken:\s*po\.appToken\s*\?\s*['"]\*\*\*['"]\s*:\s*['"]{2}/,
      'GET must redact appToken: po.appToken ? "***" : ""');
    assert.match(m[0], /userKey:\s*po\.userKey\s*\?\s*['"]\*\*\*['"]\s*:\s*['"]{2}/,
      'GET must redact userKey: po.userKey ? "***" : ""');
  });

  it('POST /api/notifications/providers/pushover is registered with checkAuth gate', () => {
    const src = readRoutes();
    assert.match(src, /url\.pathname\s*===\s*['"]\/api\/notifications\/providers\/pushover['"][\s\S]{0,60}req\.method\s*===\s*['"]POST['"]/);
    assert.match(src, /url\.pathname\s*===\s*['"]\/api\/notifications\/providers\/pushover['"][\s\S]{0,200}req\.method\s*===\s*['"]POST['"][\s\S]{0,200}checkAuth\(req,\s*res\)/);
  });

  it("POST handler honours the '***' sentinel for BOTH appToken AND userKey (T-20-03-06)", () => {
    const src = readRoutes();
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/notifications\/providers\/pushover['"]\s*&&\s*req\.method\s*===\s*['"]POST['"][\s\S]*?return\s+json\(res,\s*200,\s*\{\s*ok:\s*true\s*\}\)/);
    assert.ok(m, 'POST handler block must end with ok:true');
    assert.match(m[0], /body\.appToken\s*===\s*['"]\*\*\*['"]/, "POST must check body.appToken === '***'");
    assert.match(m[0], /body\.userKey\s*===\s*['"]\*\*\*['"]/, "POST must check body.userKey === '***'");
    assert.match(m[0], /prev(\.pushover)?\.appToken\s*\|\|\s*['"]{2}/,
      'POST must fall back to prev.appToken (or prev.pushover.appToken) or ""');
    assert.match(m[0], /prev(\.pushover)?\.userKey\s*\|\|\s*['"]{2}/,
      'POST must fall back to prev.userKey (or prev.pushover.userKey) or ""');
  });

  it('POST handler length-clips appToken to 64 + userKey to 64 (T-20-03-05)', () => {
    const src = readRoutes();
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/notifications\/providers\/pushover['"]\s*&&\s*req\.method\s*===\s*['"]POST['"][\s\S]*?return\s+json\(res,\s*200,\s*\{\s*ok:\s*true\s*\}\)/);
    assert.ok(m);
    assert.match(m[0], /clip\(.*appToken.*,\s*64\)/, 'appToken must be clipped to 64');
    assert.match(m[0], /clip\(.*userKey.*,\s*64\)/, 'userKey must be clipped to 64');
  });

  it('POST handler uses server-side merge into cfg.notifications.providers.pushover (D-12)', () => {
    const src = readRoutes();
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/notifications\/providers\/pushover['"]\s*&&\s*req\.method\s*===\s*['"]POST['"][\s\S]*?return\s+json\(res,\s*200,\s*\{\s*ok:\s*true\s*\}\)/);
    assert.ok(m);
    assert.match(m[0], /JSON\.parse\(JSON\.stringify\(\s*ctx\.getRawCfg\(\)/, 'must deep-clone raw cfg');
    assert.match(m[0], /next\.notifications\.providers\.pushover\s*=/,
      'must assign next.notifications.providers.pushover');
    assert.match(m[0], /ctx\.saveAndApplyConfig\s*\(\s*next\s*\)/, 'must call saveAndApplyConfig(next)');
    assert.match(m[0], /pushover_provider_save_error/);
    assert.match(m[0], /pushover_provider_saved[\s\S]{0,200}actorContext\(req\)/,
      'success log must include actorContext');
  });

  it('POST /api/notifications/providers/pushover/test is registered with auth + rate-limit (T-20-03-02, T-20-03-03)', () => {
    const src = readRoutes();
    assert.match(src, /url\.pathname\s*===\s*['"]\/api\/notifications\/providers\/pushover\/test['"][\s\S]{0,60}req\.method\s*===\s*['"]POST['"]/);
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/notifications\/providers\/pushover\/test['"][\s\S]*?\}\s*\}\s*\n/);
    assert.ok(m, 'test endpoint handler must close');
    assert.match(m[0], /checkAuth\(req,\s*res\)/);
    assert.match(m[0], /checkProviderRateLimit\(\s*['"]pushover['"]/);
    assert.match(m[0], /json\(res,\s*429,\s*\{\s*ok:\s*false,\s*error:\s*['"]rate_limited['"]/);
    assert.match(m[0], /createPushoverProvider/);
  });

  it('test endpoint reuses stored creds when body fields are empty (Pitfall 2)', () => {
    const src = readRoutes();
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/notifications\/providers\/pushover\/test['"][\s\S]*?\n  \}\n/);
    assert.ok(m);
    assert.match(m[0], /body\?\.appToken[\s\S]{0,80}stored\.appToken/);
    assert.match(m[0], /body\?\.userKey[\s\S]{0,80}stored\.userKey/);
    assert.match(m[0], /missing_credentials/);
  });

  it('test endpoint sends a real pushover notify() call with iso-timestamped body', () => {
    const src = readRoutes();
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/notifications\/providers\/pushover\/test['"][\s\S]*?\n  \}\n/);
    assert.ok(m);
    assert.match(m[0], /createPushoverProvider\(\s*\{\s*appToken,\s*userKey\s*\}\s*\)/);
    assert.match(m[0], /provider\.notify\(/);
    assert.match(m[0], /new Date\(\)\.toISOString\(\)/);
    assert.match(m[0], /pushLog\(\s*['"]notification_test_send['"][\s\S]{0,200}actorContext\(req\)/);
    assert.match(m[0], /pushLog\(\s*['"]notification_test_send_error['"]/);
  });

  it("test endpoint hard-codes level: 'info' (T-20-03-04 — operator cannot bypass Pushover quiet hours)", () => {
    const src = readRoutes();
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/notifications\/providers\/pushover\/test['"][\s\S]*?\n  \}\n/);
    assert.ok(m, 'pushover /test handler must exist');
    // Backend MUST emit `level: 'info'` as a string literal — never read from body.
    // pushover.js maps level:'critical' → priority:1; everything else → priority:0.
    // A literal `'info'` ensures priority:0 (non-urgent) regardless of what the
    // operator submits.
    assert.match(m[0], /level:\s*['"]info['"]/,
      "must contain literal `level: 'info'` (priority 0, not urgent)");
    // And the handler must NOT contain anything like `level: body.level`.
    assert.doesNotMatch(m[0], /level:\s*body[\s.]/,
      "must NOT read level from request body (T-20-03-04 — escalation guard)");
  });
});

describe('Plan 20-03: endpoint-baseline integrity', () => {
  it('tests/endpoint-baseline.json contains /api/notifications/providers/pushover', () => {
    const baselinePath = path.resolve(__dirname, '..', '..', 'tests', 'endpoint-baseline.json');
    const data = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    const haystack = JSON.stringify(data);
    assert.ok(/\/api\/notifications\/providers\/pushover/.test(haystack),
      'baseline must list /api/notifications/providers/pushover');
  });
});
