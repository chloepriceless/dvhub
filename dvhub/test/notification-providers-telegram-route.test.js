// test/notification-providers-telegram-route.test.js -- Plan 20-02 Task 2
// Static regex assertions for the 3 dedicated Telegram endpoints
// (GET/POST /api/notifications/providers/telegram,
//  POST /api/notifications/providers/telegram/test) — mirrors the
// notification-providers-ntfy-route.test.js shape from Plan 20-01.
//
// Strategy: same as the ntfy route test — static regex over routes-api.js.
// End-to-end HTTP spin-up requires a populated ctx (cfg, saveAndApplyConfig,
// getRawCfg, runtime references); the established pattern in dvhub/test/ is
// to pin the route registration + handler shape via regex assertions instead.

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

describe('Plan 20-02: Telegram dedicated endpoints (static)', () => {
  it('GET /api/notifications/providers/telegram is registered with checkAuth gate', () => {
    const src = readRoutes();
    assert.match(src, /url\.pathname\s*===\s*['"]\/api\/notifications\/providers\/telegram['"][\s\S]{0,60}req\.method\s*===\s*['"]GET['"]/);
    // First line of handler MUST be the auth gate.
    assert.match(src, /url\.pathname\s*===\s*['"]\/api\/notifications\/providers\/telegram['"][\s\S]{0,200}checkAuth\(req,\s*res\)/);
  });

  it('GET response redacts botToken AND chatId to "***" (D-13, Pitfall 9)', () => {
    const src = readRoutes();
    // Find the GET handler block and assert both fields use the
    // either-if-set-to-*** idiom.
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/notifications\/providers\/telegram['"][\s\S]{0,60}req\.method\s*===\s*['"]GET['"][\s\S]*?\}\s*\)\s*;/);
    assert.ok(m, 'GET telegram handler must close with json(res, ...);');
    assert.match(m[0], /botToken:\s*tg\.botToken\s*\?\s*['"]\*\*\*['"]\s*:\s*['"]{2}/,
      'GET must redact botToken: tg.botToken ? "***" : ""');
    assert.match(m[0], /chatId:\s*tg\.chatId\s*\?\s*['"]\*\*\*['"]\s*:\s*['"]{2}/,
      'GET must redact chatId: tg.chatId ? "***" : ""');
  });

  it('POST /api/notifications/providers/telegram is registered with checkAuth gate', () => {
    const src = readRoutes();
    assert.match(src, /url\.pathname\s*===\s*['"]\/api\/notifications\/providers\/telegram['"][\s\S]{0,60}req\.method\s*===\s*['"]POST['"]/);
    assert.match(src, /url\.pathname\s*===\s*['"]\/api\/notifications\/providers\/telegram['"][\s\S]{0,200}req\.method\s*===\s*['"]POST['"][\s\S]{0,200}checkAuth\(req,\s*res\)/);
  });

  it("POST handler honours the '***' sentinel for BOTH botToken AND chatId", () => {
    const src = readRoutes();
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/notifications\/providers\/telegram['"]\s*&&\s*req\.method\s*===\s*['"]POST['"][\s\S]*?return\s+json\(res,\s*200,\s*\{\s*ok:\s*true\s*\}\)/);
    assert.ok(m, 'POST handler block must end with ok:true');
    assert.match(m[0], /body\.botToken\s*===\s*['"]\*\*\*['"]/, "POST must check body.botToken === '***'");
    assert.match(m[0], /body\.chatId\s*===\s*['"]\*\*\*['"]/, "POST must check body.chatId === '***'");
    // The keep-existing fallback resolves through a `prev` alias.
    assert.match(m[0], /prev(\.telegram)?\.botToken\s*\|\|\s*['"]{2}/,
      'POST must fall back to prev.botToken (or prev.telegram.botToken) or ""');
    assert.match(m[0], /prev(\.telegram)?\.chatId\s*\|\|\s*['"]{2}/,
      'POST must fall back to prev.chatId (or prev.telegram.chatId) or ""');
  });

  it('POST handler length-clips botToken to 256 + chatId to 64', () => {
    const src = readRoutes();
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/notifications\/providers\/telegram['"]\s*&&\s*req\.method\s*===\s*['"]POST['"][\s\S]*?return\s+json\(res,\s*200,\s*\{\s*ok:\s*true\s*\}\)/);
    assert.ok(m);
    assert.match(m[0], /clip\(.*botToken.*,\s*256\)/, 'botToken must be clipped to 256');
    assert.match(m[0], /clip\(.*chatId.*,\s*64\)/, 'chatId must be clipped to 64');
  });

  it('POST handler uses server-side merge into cfg.notifications.providers.telegram (D-12)', () => {
    const src = readRoutes();
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/notifications\/providers\/telegram['"]\s*&&\s*req\.method\s*===\s*['"]POST['"][\s\S]*?return\s+json\(res,\s*200,\s*\{\s*ok:\s*true\s*\}\)/);
    assert.ok(m);
    // Deep-clone + saveAndApplyConfig — the canonical 09.4-06 pattern.
    assert.match(m[0], /JSON\.parse\(JSON\.stringify\(\s*ctx\.getRawCfg\(\)/, 'must deep-clone raw cfg');
    assert.match(m[0], /next\.notifications\.providers\.telegram\s*=/,
      'must assign next.notifications.providers.telegram');
    assert.match(m[0], /ctx\.saveAndApplyConfig\s*\(\s*next\s*\)/, 'must call saveAndApplyConfig(next)');
    // pushLog conventions: error variant has NO actorContext, success variant DOES.
    assert.match(m[0], /telegram_provider_save_error/);
    assert.match(m[0], /telegram_provider_saved[\s\S]{0,200}actorContext\(req\)/,
      'success log must include actorContext');
  });

  it('POST /api/notifications/providers/telegram/test is registered with auth + rate-limit', () => {
    const src = readRoutes();
    assert.match(src, /url\.pathname\s*===\s*['"]\/api\/notifications\/providers\/telegram\/test['"][\s\S]{0,60}req\.method\s*===\s*['"]POST['"]/);
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/notifications\/providers\/telegram\/test['"][\s\S]*?\}\s*\}\s*\n/);
    assert.ok(m, 'test endpoint handler must close');
    assert.match(m[0], /checkAuth\(req,\s*res\)/);
    assert.match(m[0], /checkProviderRateLimit\(\s*['"]telegram['"]/);
    // 429 path:
    assert.match(m[0], /json\(res,\s*429,\s*\{\s*ok:\s*false,\s*error:\s*['"]rate_limited['"]/);
    // Imports createTelegramProvider dynamically.
    assert.match(m[0], /createTelegramProvider/);
  });

  it('test endpoint reuses stored creds when body fields are empty (Pitfall 2)', () => {
    const src = readRoutes();
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/notifications\/providers\/telegram\/test['"][\s\S]*?\n  \}\n/);
    assert.ok(m);
    // botToken/chatId fallback to stored value when body field is falsy or '***'.
    assert.match(m[0], /body\?\.botToken[\s\S]{0,80}stored\.botToken/);
    assert.match(m[0], /body\?\.chatId[\s\S]{0,80}stored\.chatId/);
    // Missing-credentials guard returns 400.
    assert.match(m[0], /missing_credentials/);
  });

  it('test endpoint sends a real telegram notify() call with iso-timestamped body', () => {
    const src = readRoutes();
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/notifications\/providers\/telegram\/test['"][\s\S]*?\n  \}\n/);
    assert.ok(m);
    assert.match(m[0], /createTelegramProvider\(\s*\{\s*botToken,\s*chatId\s*\}\s*\)/);
    assert.match(m[0], /provider\.notify\(/);
    assert.match(m[0], /new Date\(\)\.toISOString\(\)/);
    // Success pushLog with actorContext; error pushLog without.
    assert.match(m[0], /pushLog\(\s*['"]notification_test_send['"][\s\S]{0,200}actorContext\(req\)/);
    assert.match(m[0], /pushLog\(\s*['"]notification_test_send_error['"]/);
  });
});

describe('Plan 20-02: endpoint-baseline integrity', () => {
  it('tests/endpoint-baseline.json contains /api/notifications/providers/telegram', () => {
    const baselinePath = path.resolve(__dirname, '..', '..', 'tests', 'endpoint-baseline.json');
    const data = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    const haystack = JSON.stringify(data);
    assert.ok(/\/api\/notifications\/providers\/telegram/.test(haystack),
      'baseline must list /api/notifications/providers/telegram');
  });
});
