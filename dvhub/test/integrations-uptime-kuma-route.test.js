// test/integrations-uptime-kuma-route.test.js -- Plan 20-04 Task 2
// Static regex assertions for the 3 dedicated Uptime-Kuma endpoints
// (GET/POST /api/integrations/uptime-kuma,
//  POST /api/integrations/uptime-kuma/test) — mirrors the
// notification-providers-pushover-route.test.js shape from Plan 20-03.
//
// KRITISCH: This plan writes to cfg.monitoring.* — NEVER
// cfg.notifications.providers.uptime-kuma (Pitfall 1 — Phase 09.4 gap-closure
// already cleaned this up once). The test-push uses a direct SSRF-guarded
// fetch via kumaPushOnce — NEVER ctx.monitoringAlertPush (Pitfall 5 — that
// would no-op when the URL is unsaved and the operator wants to test a
// freshly-typed value).
//
// Strategy: static regex over routes-api.js (same convention as the ntfy,
// telegram, and pushover route tests). End-to-end HTTP spin-up requires a
// populated ctx; pinning route registration + handler shape via regex covers
// the structural contract.

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

describe('Plan 20-04: Uptime-Kuma dedicated endpoints (static)', () => {
  it('isAllowedHeartbeatUrl helper is defined in routes-api.js (SSRF guard, T-20-04-01)', () => {
    const src = readRoutes();
    assert.match(src, /function isAllowedHeartbeatUrl\s*\(/,
      'must define isAllowedHeartbeatUrl (copied verbatim from server.js:1426-1441)');
    // The guard MUST reject http: (https-only) and the four RFC1918 prefixes.
    assert.match(src, /u\.protocol\s*!==\s*['"]https:['"]/, 'must reject non-https');
    assert.match(src, /localhost|127\.0\.0\.1|::1/, 'must reject loopback');
    assert.match(src, /parts\[0\]\s*===\s*10/, 'must reject 10.0.0.0/8');
    assert.match(src, /parts\[0\]\s*===\s*172\s*&&\s*parts\[1\]\s*>=\s*16/, 'must reject 172.16/12');
    assert.match(src, /parts\[0\]\s*===\s*192\s*&&\s*parts\[1\]\s*===\s*168/, 'must reject 192.168/16');
    assert.match(src, /parts\[0\]\s*===\s*169\s*&&\s*parts\[1\]\s*===\s*254/, 'must reject 169.254/16 link-local');
  });

  it('kumaPushOnce helper is defined and uses HMAC-signed fetch (T-20-04-04)', () => {
    const src = readRoutes();
    assert.match(src, /async function kumaPushOnce\s*\(\s*\{\s*pushUrl/,
      'must define async kumaPushOnce({ pushUrl, msg, signingKey, hostname, appVersion, status })');
    const m = src.match(/async function kumaPushOnce[\s\S]*?\n\s{2}\}\n/);
    assert.ok(m, 'kumaPushOnce must close cleanly');
    // Calls isAllowedHeartbeatUrl up front.
    assert.match(m[0], /isAllowedHeartbeatUrl\s*\(\s*pushUrl\s*\)/,
      'must SSRF-guard the pushUrl before fetch (defence-in-depth at test path)');
    assert.match(m[0], /invalid_url/, 'must return invalid_url on SSRF rejection');
    // HMAC-SHA256 signature shape, mirrors server.js:1475-1496.
    assert.match(m[0], /crypto\.createHmac\(\s*['"]sha256['"]\s*,\s*signingKey\s*\)/,
      'must sign with HMAC-SHA256 (createHmac)');
    assert.match(m[0], /x-dvhub-signature/, 'must send x-dvhub-signature header');
    assert.match(m[0], /AbortSignal\.timeout\(\s*10000\s*\)/, 'must bound the fetch at 10s');
    // The Kuma push query string shape.
    assert.match(m[0], /status=['"`]?\s*\+\s*kumaStatus|kumaStatus\s*\+\s*['"`]?&msg=|status=\$\{kumaStatus\}/,
      'must emit ?status=...&msg=...&ping= query string');
    assert.match(m[0], /encodeURIComponent\(\s*msg\s*\)/, 'must encodeURIComponent(msg)');
  });

  it('GET /api/integrations/uptime-kuma is registered with checkAuth gate', () => {
    const src = readRoutes();
    assert.match(src, /url\.pathname\s*===\s*['"]\/api\/integrations\/uptime-kuma['"][\s\S]{0,60}req\.method\s*===\s*['"]GET['"]/);
    assert.match(src, /url\.pathname\s*===\s*['"]\/api\/integrations\/uptime-kuma['"][\s\S]{0,200}checkAuth\(req,\s*res\)/);
  });

  it('GET reads cfg.monitoring.* (NOT cfg.notifications.providers.uptime-kuma — Pitfall 1)', () => {
    const src = readRoutes();
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/integrations\/uptime-kuma['"][\s\S]{0,60}req\.method\s*===\s*['"]GET['"][\s\S]*?\}\s*\)\s*;/);
    assert.ok(m, 'GET kuma handler must close with json(res, ...);');
    assert.match(m[0], /raw\.monitoring|mon(itoring)?\s*=\s*raw\.monitoring/,
      'GET must read from raw.monitoring (the canonical Kuma branch)');
    assert.match(m[0], /pushUrl:\s*mon\.pushUrl/, 'must emit pushUrl from monitoring.pushUrl (clear, not redacted)');
    assert.match(m[0], /pushIntervalSec/, 'must emit pushIntervalSec');
    // Default fallback for interval when unset.
    assert.match(m[0], /240/, 'must default interval to 240');
  });

  it('POST /api/integrations/uptime-kuma is registered with checkAuth gate', () => {
    const src = readRoutes();
    assert.match(src, /url\.pathname\s*===\s*['"]\/api\/integrations\/uptime-kuma['"][\s\S]{0,60}req\.method\s*===\s*['"]POST['"]/);
    assert.match(src, /url\.pathname\s*===\s*['"]\/api\/integrations\/uptime-kuma['"][\s\S]{0,200}req\.method\s*===\s*['"]POST['"][\s\S]{0,200}checkAuth\(req,\s*res\)/);
  });

  it('POST writes to next.monitoring.* (NOT next.notifications.providers.uptime-kuma — Pitfall 1, T-20-04-05)', () => {
    const src = readRoutes();
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/integrations\/uptime-kuma['"]\s*&&\s*req\.method\s*===\s*['"]POST['"][\s\S]*?return\s+json\(res,\s*200,\s*\{\s*ok:\s*true\s*\}\)/);
    assert.ok(m, 'POST handler block must end with ok:true');
    assert.match(m[0], /JSON\.parse\(JSON\.stringify\(\s*ctx\.getRawCfg\(\)/, 'must deep-clone raw cfg');
    assert.match(m[0], /next\.monitoring\.pushUrl\s*=/,
      'must assign next.monitoring.pushUrl (Pitfall 1 — NOT next.notifications.providers)');
    assert.match(m[0], /next\.monitoring\.pushIntervalSec\s*=/,
      'must assign next.monitoring.pushIntervalSec');
    assert.match(m[0], /next\.monitoring\.enabled\s*=/,
      'must assign next.monitoring.enabled');
    assert.match(m[0], /ctx\.saveAndApplyConfig\s*\(\s*next\s*\)/,
      'must call saveAndApplyConfig (also triggers startMonitoringHeartbeat reload)');
    assert.match(m[0], /uptime_kuma_save_error/);
    assert.match(m[0], /uptime_kuma_saved[\s\S]{0,200}actorContext\(req\)/,
      'success log must include actorContext');
  });

  it('POST clamps pushIntervalSec to [30, 600] server-side (T-20-04-07)', () => {
    const src = readRoutes();
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/integrations\/uptime-kuma['"]\s*&&\s*req\.method\s*===\s*['"]POST['"][\s\S]*?return\s+json\(res,\s*200,\s*\{\s*ok:\s*true\s*\}\)/);
    assert.ok(m);
    assert.match(m[0], /Math\.max\(\s*30\s*,\s*Math\.min\(\s*600/,
      'must clamp pushIntervalSec via Math.max(30, Math.min(600, ...))');
  });

  it('POST applies SSRF guard at save-time (defence in depth — T-20-04-01)', () => {
    const src = readRoutes();
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/integrations\/uptime-kuma['"]\s*&&\s*req\.method\s*===\s*['"]POST['"][\s\S]*?return\s+json\(res,\s*200,\s*\{\s*ok:\s*true\s*\}\)/);
    assert.ok(m);
    assert.match(m[0], /isAllowedHeartbeatUrl\s*\(\s*pushUrl\s*\)/,
      'POST must reject SSRF-prohibited URLs before persisting');
    assert.match(m[0], /invalid_url/, 'POST must surface invalid_url on SSRF rejection');
  });

  it('POST length-clips pushUrl to 512 chars', () => {
    const src = readRoutes();
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/integrations\/uptime-kuma['"]\s*&&\s*req\.method\s*===\s*['"]POST['"][\s\S]*?return\s+json\(res,\s*200,\s*\{\s*ok:\s*true\s*\}\)/);
    assert.ok(m);
    assert.match(m[0], /clip\(.*pushUrl.*,\s*512\)/, 'pushUrl must be clipped to 512 chars');
  });

  it('POST /api/integrations/uptime-kuma/test is registered with auth + rate-limit (T-20-04-03)', () => {
    const src = readRoutes();
    assert.match(src, /url\.pathname\s*===\s*['"]\/api\/integrations\/uptime-kuma\/test['"][\s\S]{0,60}req\.method\s*===\s*['"]POST['"]/);
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/integrations\/uptime-kuma\/test['"][\s\S]*?\n {2}\}\n/);
    assert.ok(m, 'test endpoint handler must close');
    assert.match(m[0], /checkAuth\(req,\s*res\)/);
    assert.match(m[0], /checkProviderRateLimit\(\s*['"]uptime-kuma['"]/,
      'test endpoint must use checkProviderRateLimit("uptime-kuma", pushUrl)');
    assert.match(m[0], /json\(res,\s*429,\s*\{\s*ok:\s*false,\s*error:\s*['"]rate_limited['"]/);
  });

  it('test endpoint prefers form pushUrl, falls back to stored (Pitfall 2/5, T-20-04-06)', () => {
    const src = readRoutes();
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/integrations\/uptime-kuma\/test['"][\s\S]*?\n {2}\}\n/);
    assert.ok(m);
    // Body pushUrl trumps stored — operator's unsaved URL must work.
    assert.match(m[0], /body\??\.?pushUrl[\s\S]{0,80}stored\.pushUrl/,
      'must fall back from body.pushUrl to stored.pushUrl');
    assert.match(m[0], /kuma_no_push_url/, 'must return kuma_no_push_url when both are empty');
  });

  it('test endpoint calls kumaPushOnce (NOT ctx.monitoringAlertPush — Pitfall 5)', () => {
    const src = readRoutes();
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/integrations\/uptime-kuma\/test['"][\s\S]*?\n {2}\}\n/);
    assert.ok(m);
    assert.match(m[0], /kumaPushOnce\s*\(\s*\{/,
      'test endpoint must invoke kumaPushOnce (direct SSRF-guarded fetch with current form URL)');
    // Pitfall 5: must NOT INVOKE ctx.monitoringAlertPush. Allow comments that
    // explain why — strip comments before checking (regex would otherwise
    // match the documentation text we WANT in the source).
    const code = m[0].replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(code, /ctx\.monitoringAlertPush\s*\(/,
      "must NOT call ctx.monitoringAlertPush() — it no-ops when pushUrl isn't yet saved (Pitfall 5)");
    assert.match(m[0], /new Date\(\)\.toISOString\(\)/, 'test-push message must include iso timestamp');
    assert.match(m[0], /pushLog\(\s*['"]kuma_test_push['"]/, 'must pushLog("kuma_test_push", ...)');
  });

  it("routes-api.js does NOT WRITE next.notifications.providers['uptime-kuma'] anywhere (Pitfall 1 — T-20-04-05 strict guard)", () => {
    const src = readRoutes();
    // Strip comments — legitimate prose in `//` and `/* */` blocks references
    // the dead branch by name for context (Phase 09.4 gap-closure history).
    const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // Bare-property write: `next.notifications.providers.uptime-kuma = ...`.
    // (Won't actually be valid JS — `uptime-kuma` is not a valid identifier —
    // but a typo could still appear; guard anyway.)
    assert.doesNotMatch(code, /next\.notifications\.providers\.uptime-kuma\s*=/,
      'routes-api.js must never WRITE next.notifications.providers.uptime-kuma');
    // Bracket-property WRITE only — the existing `delete next.notifications.providers["uptime-kuma"]`
    // at the legacy ntfy POST is a Phase 09.4 cleanup scrub, NOT a write, and
    // is intentional (it prevents a stale provider object from spawning a 2nd
    // heartbeat). The strict guard targets assignment, not deletion.
    assert.doesNotMatch(code, /next\.notifications\.providers\[\s*['"]uptime-kuma['"]\s*\]\s*=/,
      "routes-api.js must never WRITE next.notifications.providers['uptime-kuma'] (assignment) — Pitfall 1");
  });
});

describe('Plan 20-04: endpoint-baseline integrity', () => {
  it('tests/endpoint-baseline.json contains /api/integrations/uptime-kuma', () => {
    const baselinePath = path.resolve(__dirname, '..', '..', 'tests', 'endpoint-baseline.json');
    const data = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    const haystack = JSON.stringify(data);
    assert.ok(/\/api\/integrations\/uptime-kuma/.test(haystack),
      'baseline must list /api/integrations/uptime-kuma');
  });
});
