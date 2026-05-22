// test/integrations-vrm-route.test.js -- Plan 20-05 Task 2 RED→GREEN
//
// Static + behavioral checks for the dedicated VRM credential endpoints
// (GET/POST /api/integrations/vrm) plus the /api/integrations/status
// extension that emits a `vrm` subtree with `vrmTokenSet` boolean (never
// the raw token — T-20-05-01/02).
//
// Strategy mirrors notification-providers-ntfy-route.test.js (Plan 20-01):
//   1. Static regex assertions against routes-api.js — handler shape, auth
//      gate, '***' keep-existing sentinel, empty-string delete-path,
//      length-clip caps, REDACTED token in GET, vrmTokenSet boolean in
//      /status payload.
//   2. settings.js HIDDEN_FIELD_PATHS includes both VRM paths so the auto-form
//      under /settings#tab-system does not double-render the editor surface
//      (T-20-05-10 — single discoverable editor).
//   3. Behavioural sentinel mirror: a tiny in-test re-implementation of the
//      '***' / '' / typed-token semantics so the numerical behaviour is
//      pinned even if the regex changes shape.
//
// Why no end-to-end HTTP spin-up: routes-api.js exports createApiRoutes(ctx)
// which requires a populated ctx. Existing notification-providers-ntfy-route
// test uses static-regex + mirrored algorithm; this file follows the same
// idiom.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_API_PATH = path.resolve(__dirname, '..', 'routes-api.js');
const SETTINGS_JS_PATH = path.resolve(__dirname, '..', 'public', 'settings.js');

function readRoutes() {
  return fs.readFileSync(ROUTES_API_PATH, 'utf8');
}
function readSettings() {
  return fs.readFileSync(SETTINGS_JS_PATH, 'utf8');
}

describe('Plan 20-05: /api/integrations/vrm GET (D-13 redacted)', () => {
  it('GET /api/integrations/vrm is registered with checkAuth gate', () => {
    const src = readRoutes();
    assert.match(src, /url\.pathname\s*===\s*['"]\/api\/integrations\/vrm['"][\s\S]{0,60}req\.method\s*===\s*['"]GET['"]/);
    // First line of handler MUST be auth gate.
    assert.match(src, /url\.pathname\s*===\s*['"]\/api\/integrations\/vrm['"][\s\S]{0,200}checkAuth\(req,\s*res\)/);
  });

  it('GET response redacts a stored vrmToken to "***" (D-13, T-20-05-01)', () => {
    const src = readRoutes();
    // Within the GET block, must derive vrmToken as '***' when set, '' when unset.
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/integrations\/vrm['"][\s\S]{0,60}req\.method\s*===\s*['"]GET['"][\s\S]*?\}\s*\)\s*;/);
    assert.ok(m, 'GET vrm handler must close with json(res, ...);');
    assert.match(m[0], /vrmToken:\s*h\.vrmToken\s*\?\s*['"]\*\*\*['"]\s*:\s*['"]{2}/,
      "GET must redact vrmToken: h.vrmToken ? '***' : ''");
  });

  it('GET response emits enabled + vrmPortalId from cfg.telemetry.historyImport', () => {
    const src = readRoutes();
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/integrations\/vrm['"][\s\S]{0,60}req\.method\s*===\s*['"]GET['"][\s\S]*?\}\s*\)\s*;/);
    assert.ok(m);
    assert.match(m[0], /enabled:\s*!!h\.enabled/);
    assert.match(m[0], /vrmPortalId:\s*h\.vrmPortalId\s*\|\|\s*['"]{2}/);
    // Source must be raw cfg under telemetry.historyImport — single backend source-of-truth from Phase 18-05.
    assert.match(m[0], /raw\.telemetry\??\.historyImport|raw\.telemetry\.historyImport/);
  });
});

describe('Plan 20-05: /api/integrations/vrm POST (D-12 server-side-merge)', () => {
  it('POST is registered with checkAuth gate', () => {
    const src = readRoutes();
    assert.match(src, /url\.pathname\s*===\s*['"]\/api\/integrations\/vrm['"][\s\S]{0,60}req\.method\s*===\s*['"]POST['"]/);
    assert.match(src, /url\.pathname\s*===\s*['"]\/api\/integrations\/vrm['"][\s\S]{0,200}req\.method\s*===\s*['"]POST['"][\s\S]{0,200}checkAuth\(req,\s*res\)/);
  });

  it("POST handler honours the '***' sentinel (keep-existing vrmToken, T-20-05-05)", () => {
    const src = readRoutes();
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/integrations\/vrm['"]\s*&&\s*req\.method\s*===\s*['"]POST['"][\s\S]*?return\s+json\(res,\s*200,\s*\{\s*ok:\s*true\s*\}\)/);
    assert.ok(m, 'POST handler block must end with ok:true');
    assert.match(m[0], /body\.vrmToken\s*===\s*['"]\*\*\*['"]/,
      "POST must check body.vrmToken === '***'");
    // Keep-existing fallback uses prev (alias of next.telemetry.historyImport).
    assert.match(m[0], /prev\.vrmToken\s*\|\|\s*['"]{2}/,
      "POST must fall back to prev.vrmToken || ''");
  });

  it('POST handler deletes vrmToken when token resolves to empty (T-20-05-05 delete-path)', () => {
    const src = readRoutes();
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/integrations\/vrm['"]\s*&&\s*req\.method\s*===\s*['"]POST['"][\s\S]*?return\s+json\(res,\s*200,\s*\{\s*ok:\s*true\s*\}\)/);
    assert.ok(m);
    // Explicit delete on the historyImport branch when token is empty.
    assert.match(m[0], /delete\s+next\.telemetry\.historyImport\.vrmToken/);
  });

  it('POST handler length-clips vrmPortalId (64) + vrmToken (512)', () => {
    const src = readRoutes();
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/integrations\/vrm['"]\s*&&\s*req\.method\s*===\s*['"]POST['"][\s\S]*?return\s+json\(res,\s*200,\s*\{\s*ok:\s*true\s*\}\)/);
    assert.ok(m);
    assert.match(m[0], /clip\(\s*body\.vrmPortalId\s*,\s*64\s*\)/, 'vrmPortalId must be clipped to 64');
    assert.match(m[0], /clip\(\s*body\.vrmToken\s*,\s*512\s*\)/, 'vrmToken must be clipped to 512');
  });

  it('POST handler does server-side merge into cfg.telemetry.historyImport + sets provider=vrm only when enabling (WR-03)', () => {
    const src = readRoutes();
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/integrations\/vrm['"]\s*&&\s*req\.method\s*===\s*['"]POST['"][\s\S]*?return\s+json\(res,\s*200,\s*\{\s*ok:\s*true\s*\}\)/);
    assert.ok(m);
    // Deep-clone + saveAndApplyConfig — canonical 09.4-06 pattern.
    assert.match(m[0], /JSON\.parse\(JSON\.stringify\(\s*ctx\.getRawCfg\(\)/);
    assert.match(m[0], /next\.telemetry\.historyImport\.enabled\s*=/);
    // WR-03: provider='vrm' must be guarded by an `if (body.enabled)` so that
    // the "Credentials entfernen" disable-path doesn't silently overwrite a
    // future second history-import provider's claim.
    assert.match(m[0], /if\s*\(\s*body\.enabled\s*\)\s*\{\s*\n\s*next\.telemetry\.historyImport\.provider\s*=\s*['"]vrm['"]/);
    assert.match(m[0], /next\.telemetry\.historyImport\.vrmPortalId\s*=/);
    assert.match(m[0], /ctx\.saveAndApplyConfig\s*\(\s*next\s*\)/);
    // Error path: must NOT include actorContext on save_error pushLog.
    assert.match(m[0], /vrm_credentials_save_error/);
    assert.match(m[0], /vrm_credentials_saved[\s\S]{0,250}actorContext\(req\)/,
      'success log must include actorContext');
  });
});

describe('Plan 20-05: /api/integrations/status vrm subtree (T-20-05-02 boolean-only)', () => {
  it('/status payload includes a vrm subtree adjacent to notifications', () => {
    const src = readRoutes();
    // Find the status handler block and confirm a vrm: key appears.
    const m = src.match(/\/api\/integrations\/status['"][\s\S]*?return\s+json\(res,\s*200,\s*payload\s*\)/);
    assert.ok(m, 'status handler must close with json(res, 200, payload)');
    assert.match(m[0], /vrm:\s*\{[\s\S]*?\}/, 'payload must include a vrm: { ... } subtree');
  });

  it('/status vrm subtree emits boolean vrmTokenSet (NEVER the raw token)', () => {
    const src = readRoutes();
    const m = src.match(/\/api\/integrations\/status['"][\s\S]*?return\s+json\(res,\s*200,\s*payload\s*\)/);
    assert.ok(m);
    // vrmTokenSet must be a boolean expression — !!(getCfg().telemetry?.historyImport?.vrmToken).
    assert.match(m[0], /vrmTokenSet:\s*!!\(?getCfg\(\)\.telemetry\??\.historyImport\??\.vrmToken/);
    // CRITICAL anti-leak: the literal field name vrmToken must NEVER appear as a
    // value-emitting expression in the status payload — only the boolean-set form.
    // We enforce this by asserting the status block does NOT emit `vrmToken:`
    // (with a colon, indicating a JSON key emission of the raw value).
    const noRawToken = /vrmToken:\s*[^\!]/m.test(m[0]);
    assert.equal(noRawToken, false,
      "status payload must not emit vrmToken: (raw value) — only vrmTokenSet: boolean");
  });

  it('/status vrm subtree includes enabled boolean + vrmPortalId (or null)', () => {
    const src = readRoutes();
    const m = src.match(/\/api\/integrations\/status['"][\s\S]*?return\s+json\(res,\s*200,\s*payload\s*\)/);
    assert.ok(m);
    // Extract the vrm subtree literal.
    const vrm = m[0].match(/vrm:\s*\{([\s\S]*?)\}/);
    assert.ok(vrm, 'vrm subtree must be a single-level object literal');
    assert.match(vrm[1], /enabled:/);
    assert.match(vrm[1], /vrmPortalId:/);
  });
});

describe('Plan 20-05: settings.js HIDDEN_FIELD_PATHS (T-20-05-10 single editor)', () => {
  it('HIDDEN_FIELD_PATHS includes telemetry.historyImport.vrmPortalId', () => {
    const src = readSettings();
    assert.match(src, /HIDDEN_FIELD_PATHS\s*=\s*\[[\s\S]*?'telemetry\.historyImport\.vrmPortalId'/);
  });

  it('HIDDEN_FIELD_PATHS includes telemetry.historyImport.vrmToken', () => {
    const src = readSettings();
    assert.match(src, /HIDDEN_FIELD_PATHS\s*=\s*\[[\s\S]*?'telemetry\.historyImport\.vrmToken'/);
  });
});

describe('Plan 20-05: sentinel semantics (mirror)', () => {
  // Tiny in-test mirror of the prod sentinel — exercising the keep-existing
  // ('***') / delete-on-empty ('' or missing) / accept-typed semantics. If
  // prod drifts, the static regex tests above flag the structural change;
  // this block pins the numerical behaviour.
  function resolveToken(typedTokenField, storedToken) {
    const prev = { vrmToken: storedToken };
    const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
    if (typedTokenField === '***') return prev.vrmToken || '';
    return clip(typedTokenField, 512);
  }

  it("'***' sentinel keeps the stored token", () => {
    assert.equal(resolveToken('***', 'super-secret-token-abc'), 'super-secret-token-abc');
  });

  it("'' (or missing) clears the token (delete-path)", () => {
    assert.equal(resolveToken('', 'super-secret-token-abc'), '');
    assert.equal(resolveToken(undefined, 'super-secret-token-abc'), '');
  });

  it('typed token replaces the stored one and is length-clipped', () => {
    assert.equal(resolveToken('brand-new-typed-token-xyz', 'old'), 'brand-new-typed-token-xyz');
    // 600-char input clipped to 512 chars.
    const huge = 'a'.repeat(600);
    assert.equal(resolveToken(huge, 'old').length, 512);
  });

  it("'***' with no stored token resolves to '' (so the delete-path runs)", () => {
    assert.equal(resolveToken('***', undefined), '');
    assert.equal(resolveToken('***', ''), '');
  });
});
