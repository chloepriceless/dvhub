// test/forecast-providers-route.test.js -- Plan 20-06 Task 3 RED→GREEN
//
// Static + behavioural checks for the 6 new dedicated forecast-provider
// endpoints (GET/POST/probe × 2 providers) PLUS the /api/integrations/status
// extension that adds a `forecastProviders` subtree with booleans only
// (apiKeySet — NEVER the raw apiKey; T-20-06-01).
//
// Strategy mirrors integrations-vrm-route.test.js (Plan 20-05):
//   1. Static regex assertions against routes-api.js — handler shape, auth
//      gate, '***' keep-existing sentinel, delete-on-empty path,
//      length-clip caps, REDACTED apiKey in GET, per-provider rate limit
//      on /probe, status-payload boolean-only contract.
//   2. settings.js HIDDEN_FIELD_PATHS includes both forecast.*.apiKey paths
//      (T-20-06 single discoverable editor).
//   3. Behavioural sentinel mirror exercising the keep-existing /
//      delete-on-empty / accept-typed apiKey semantics.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_API_PATH = path.resolve(__dirname, '..', 'routes-api.js');
const SETTINGS_JS_PATH = path.resolve(__dirname, '..', 'public', 'settings.js');
const BASELINE_PATH = path.resolve(__dirname, '..', '..', 'tests', 'endpoint-baseline.json');

function readRoutes() { return fs.readFileSync(ROUTES_API_PATH, 'utf8'); }
function readSettings() { return fs.readFileSync(SETTINGS_JS_PATH, 'utf8'); }
function readBaseline() { return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')); }

describe('Plan 20-06: /api/forecast/providers/solcast GET (D-13 redacted)', () => {
  it('GET is registered with checkAuth gate', () => {
    const src = readRoutes();
    assert.match(src, /url\.pathname\s*===\s*['"]\/api\/forecast\/providers\/solcast['"][\s\S]{0,60}req\.method\s*===\s*['"]GET['"]/);
    assert.match(src, /url\.pathname\s*===\s*['"]\/api\/forecast\/providers\/solcast['"][\s\S]{0,200}checkAuth\(req,\s*res\)/);
  });

  it('GET response redacts a stored apiKey to "***" (D-13)', () => {
    const src = readRoutes();
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/forecast\/providers\/solcast['"][\s\S]{0,60}req\.method\s*===\s*['"]GET['"][\s\S]*?\}\s*\)\s*;/);
    assert.ok(m, 'GET solcast handler must close with json(res, ...);');
    assert.match(m[0], /apiKey:\s*s\.apiKey\s*\?\s*['"]\*\*\*['"]\s*:\s*['"]{2}/,
      "GET must redact apiKey: s.apiKey ? '***' : ''");
  });

  it('GET response emits siteId in clear (NOT redacted — D-10)', () => {
    const src = readRoutes();
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/forecast\/providers\/solcast['"][\s\S]{0,60}req\.method\s*===\s*['"]GET['"][\s\S]*?\}\s*\)\s*;/);
    assert.ok(m);
    assert.match(m[0], /siteId:\s*s\.siteId\s*\|\|\s*['"]{2}/,
      'siteId must be emitted in clear (not a secret, per D-10)');
    assert.match(m[0], /enabled:\s*!!s\.enabled/);
  });
});

describe('Plan 20-06: /api/forecast/providers/solcast POST (D-12 server-side-merge)', () => {
  it('POST is registered with checkAuth gate', () => {
    const src = readRoutes();
    assert.match(src, /url\.pathname\s*===\s*['"]\/api\/forecast\/providers\/solcast['"][\s\S]{0,60}req\.method\s*===\s*['"]POST['"]/);
    assert.match(src, /url\.pathname\s*===\s*['"]\/api\/forecast\/providers\/solcast['"][\s\S]{0,200}req\.method\s*===\s*['"]POST['"][\s\S]{0,200}checkAuth\(req,\s*res\)/);
  });

  it("POST handler honours the '***' sentinel (keep-existing apiKey, T-20-06-07)", () => {
    const src = readRoutes();
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/forecast\/providers\/solcast['"]\s*&&\s*req\.method\s*===\s*['"]POST['"][\s\S]*?return\s+json\(res,\s*200,\s*\{\s*ok:\s*true\s*\}\)/);
    assert.ok(m, 'POST solcast handler block must end with ok:true');
    assert.match(m[0], /body\.apiKey\s*===\s*['"]\*\*\*['"]/,
      "POST must check body.apiKey === '***'");
    assert.match(m[0], /prev\.apiKey\s*\|\|\s*['"]{2}/,
      "POST must fall back to prev.apiKey || ''");
  });

  it('POST handler deletes apiKey when token resolves to empty (T-20-06-07 delete-path)', () => {
    const src = readRoutes();
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/forecast\/providers\/solcast['"]\s*&&\s*req\.method\s*===\s*['"]POST['"][\s\S]*?return\s+json\(res,\s*200,\s*\{\s*ok:\s*true\s*\}\)/);
    assert.ok(m);
    assert.match(m[0], /delete\s+next\.forecast\.solcast\.apiKey/);
  });

  it('POST handler length-clips apiKey (256) + siteId (64)', () => {
    const src = readRoutes();
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/forecast\/providers\/solcast['"]\s*&&\s*req\.method\s*===\s*['"]POST['"][\s\S]*?return\s+json\(res,\s*200,\s*\{\s*ok:\s*true\s*\}\)/);
    assert.ok(m);
    assert.match(m[0], /clip\(\s*body\.apiKey\s*,\s*256\s*\)/, 'apiKey must be clipped to 256');
    assert.match(m[0], /clip\(\s*body\.siteId\s*,\s*64\s*\)/, 'siteId must be clipped to 64');
  });

  it('POST handler does server-side merge into cfg.forecast.solcast.*', () => {
    const src = readRoutes();
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/forecast\/providers\/solcast['"]\s*&&\s*req\.method\s*===\s*['"]POST['"][\s\S]*?return\s+json\(res,\s*200,\s*\{\s*ok:\s*true\s*\}\)/);
    assert.ok(m);
    assert.match(m[0], /JSON\.parse\(JSON\.stringify\(\s*ctx\.getRawCfg\(\)/);
    assert.match(m[0], /next\.forecast\.solcast\.enabled\s*=/);
    assert.match(m[0], /next\.forecast\.solcast\.siteId\s*=/);
    assert.match(m[0], /ctx\.saveAndApplyConfig\s*\(\s*next\s*\)/);
    assert.match(m[0], /solcast_save_error/);
    assert.match(m[0], /solcast_saved[\s\S]{0,250}actorContext\(req\)/,
      'success log must include actorContext');
  });
});

describe('Plan 20-06: /api/forecast/providers/solcast/probe POST', () => {
  it('Probe endpoint is registered with checkAuth gate', () => {
    const src = readRoutes();
    assert.match(src, /url\.pathname\s*===\s*['"]\/api\/forecast\/providers\/solcast\/probe['"][\s\S]{0,60}req\.method\s*===\s*['"]POST['"]/);
    assert.match(src, /url\.pathname\s*===\s*['"]\/api\/forecast\/providers\/solcast\/probe['"][\s\S]{0,200}checkAuth\(req,\s*res\)/);
  });

  it('Probe endpoint enforces per-provider rate-limit (5/min, T-20-06-03)', () => {
    const src = readRoutes();
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/forecast\/providers\/solcast\/probe['"][\s\S]*?return\s+json\(res,\s*(\d+|result\.ok\s*\?\s*200\s*:\s*502)/);
    assert.ok(m, 'probe handler must end with a json response');
    assert.match(m[0], /checkProviderRateLimit\(['"]solcast['"]/,
      "probe must call checkProviderRateLimit('solcast', apiKey)");
    assert.match(m[0], /rate_limited/);
  });

  it('Probe endpoint imports + calls probeSolcast helper from solcast-client', () => {
    const src = readRoutes();
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/forecast\/providers\/solcast\/probe['"][\s\S]*?\)\s*;\s*\}/);
    assert.ok(m);
    assert.match(m[0], /probeSolcast/);
    assert.match(m[0], /solcast-client/);
  });

  it("Probe endpoint resolves apiKey from body, falls back to stored ('***' semantics)", () => {
    const src = readRoutes();
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/forecast\/providers\/solcast\/probe['"][\s\S]*?probeSolcast/);
    assert.ok(m);
    // Must reject when no creds.
    assert.match(m[0], /missing_credentials/);
  });
});

describe('Plan 20-06: /api/forecast/providers/pvnode GET/POST', () => {
  it('GET is registered with checkAuth gate', () => {
    const src = readRoutes();
    assert.match(src, /url\.pathname\s*===\s*['"]\/api\/forecast\/providers\/pvnode['"][\s\S]{0,60}req\.method\s*===\s*['"]GET['"]/);
    assert.match(src, /url\.pathname\s*===\s*['"]\/api\/forecast\/providers\/pvnode['"][\s\S]{0,200}checkAuth\(req,\s*res\)/);
  });

  it('GET response redacts apiKey to "***" and emits nowcastEnabled', () => {
    const src = readRoutes();
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/forecast\/providers\/pvnode['"][\s\S]{0,60}req\.method\s*===\s*['"]GET['"][\s\S]*?\}\s*\)\s*;/);
    assert.ok(m);
    assert.match(m[0], /apiKey:\s*p\.apiKey\s*\?\s*['"]\*\*\*['"]\s*:\s*['"]{2}/);
    assert.match(m[0], /nowcastEnabled:\s*!!p\.nowcastEnabled/);
  });

  it('POST handler does server-side merge into cfg.forecast.pvnode.*', () => {
    const src = readRoutes();
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/forecast\/providers\/pvnode['"]\s*&&\s*req\.method\s*===\s*['"]POST['"][\s\S]*?return\s+json\(res,\s*200,\s*\{\s*ok:\s*true\s*\}\)/);
    assert.ok(m);
    assert.match(m[0], /body\.apiKey\s*===\s*['"]\*\*\*['"]/);
    assert.match(m[0], /prev\.apiKey\s*\|\|\s*['"]{2}/);
    assert.match(m[0], /delete\s+next\.forecast\.pvnode\.apiKey/);
    assert.match(m[0], /clip\(\s*body\.apiKey\s*,\s*256\s*\)/);
    assert.match(m[0], /next\.forecast\.pvnode\.nowcastEnabled\s*=/);
    assert.match(m[0], /pvnode_saved[\s\S]{0,250}actorContext\(req\)/);
  });

  it('Probe endpoint enforces per-provider rate-limit + imports probePvnode', () => {
    const src = readRoutes();
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/forecast\/providers\/pvnode\/probe['"][\s\S]*?probePvnode/);
    assert.ok(m);
    assert.match(m[0], /checkProviderRateLimit\(['"]pvnode['"]/);
    assert.match(m[0], /rate_limited/);
    assert.match(m[0], /pvnode-client/);
  });

  it('Probe endpoint reads lat/lon/slope/orientation from cfg before calling probePvnode', () => {
    const src = readRoutes();
    const m = src.match(/url\.pathname\s*===\s*['"]\/api\/forecast\/providers\/pvnode\/probe['"][\s\S]*?probePvnode\([\s\S]*?\)/);
    assert.ok(m);
    // Must read from cfg.forecast.location.* (schema is `latitude`, not `lat`).
    assert.match(m[0], /forecast(\?\.|\.)location/);
  });
});

describe('Plan 20-06: /api/integrations/status forecastProviders subtree (T-20-06-01 boolean-only)', () => {
  it('/status payload includes forecastProviders subtree', () => {
    const src = readRoutes();
    const m = src.match(/\/api\/integrations\/status['"][\s\S]*?return\s+json\(res,\s*200,\s*payload\s*\)/);
    assert.ok(m);
    assert.match(m[0], /forecastProviders:\s*\{[\s\S]*?\}/);
  });

  it('forecastProviders subtree contains solcast + pvnode sub-objects with apiKeySet booleans', () => {
    const src = readRoutes();
    const m = src.match(/\/api\/integrations\/status['"][\s\S]*?return\s+json\(res,\s*200,\s*payload\s*\)/);
    assert.ok(m);
    const fp = m[0].match(/forecastProviders:\s*\{([\s\S]*?)\n\s*\}\s*\n/);
    assert.ok(fp, 'forecastProviders subtree must close with a brace');
    assert.match(fp[1], /solcast:\s*\{[\s\S]*?apiKeySet:/);
    assert.match(fp[1], /pvnode:\s*\{[\s\S]*?apiKeySet:/);
  });

  it('forecastProviders subtree NEVER emits raw apiKey/siteId values', () => {
    const src = readRoutes();
    const m = src.match(/\/api\/integrations\/status['"][\s\S]*?return\s+json\(res,\s*200,\s*payload\s*\)/);
    assert.ok(m);
    const fp = m[0].match(/forecastProviders:\s*\{([\s\S]*?)\n\s*\}\s*\n/);
    assert.ok(fp);
    // Anti-leak: only key:boolean expressions (must NOT have `apiKey:` as a
    // value-emitting key alone — only `apiKeySet:`).
    const hasRawApiKey = /apiKey:\s*[^\!S]/.test(fp[1]);
    assert.equal(hasRawApiKey, false,
      'status payload must not emit raw apiKey: (only apiKeySet:boolean is allowed)');
  });
});

describe('Plan 20-06: settings.js HIDDEN_FIELD_PATHS (single-editor T-20-06)', () => {
  it('HIDDEN_FIELD_PATHS includes forecast.solcast.apiKey', () => {
    const src = readSettings();
    assert.match(src, /HIDDEN_FIELD_PATHS\s*=\s*\[[\s\S]*?'forecast\.solcast\.apiKey'/);
  });

  it('HIDDEN_FIELD_PATHS includes forecast.pvnode.apiKey', () => {
    const src = readSettings();
    assert.match(src, /HIDDEN_FIELD_PATHS\s*=\s*\[[\s\S]*?'forecast\.pvnode\.apiKey'/);
  });
});

describe('Plan 20-06: endpoint-baseline.json contains new forecast-provider URLs', () => {
  it('includes /api/forecast/providers/solcast', () => {
    const b = readBaseline();
    assert.ok(b.urls.includes('/api/forecast/providers/solcast'),
      'baseline must list /api/forecast/providers/solcast');
  });

  it('includes /api/forecast/providers/solcast/probe', () => {
    const b = readBaseline();
    assert.ok(b.urls.includes('/api/forecast/providers/solcast/probe'),
      'baseline must list /api/forecast/providers/solcast/probe');
  });

  it('includes /api/forecast/providers/pvnode', () => {
    const b = readBaseline();
    assert.ok(b.urls.includes('/api/forecast/providers/pvnode'),
      'baseline must list /api/forecast/providers/pvnode');
  });

  it('includes /api/forecast/providers/pvnode/probe', () => {
    const b = readBaseline();
    assert.ok(b.urls.includes('/api/forecast/providers/pvnode/probe'),
      'baseline must list /api/forecast/providers/pvnode/probe');
  });
});

describe('Plan 20-06: sentinel semantics (mirror)', () => {
  // Tiny in-test mirror of the prod sentinel — exercising the keep-existing
  // ('***') / delete-on-empty ('' or missing) / accept-typed semantics for
  // the forecast.{solcast,pvnode}.apiKey path. If prod drifts, the static
  // regex tests above flag structural change; this pins numerical behaviour.
  function resolveApiKey(typedField, storedApiKey) {
    const prev = { apiKey: storedApiKey };
    const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
    if (typedField === '***') return prev.apiKey || '';
    return clip(typedField, 256);
  }

  it("'***' sentinel keeps the stored apiKey", () => {
    assert.equal(resolveApiKey('***', 'super-secret-key-abc'), 'super-secret-key-abc');
  });

  it("'' (or missing) clears the apiKey (delete-path)", () => {
    assert.equal(resolveApiKey('', 'stored-xyz'), '');
    assert.equal(resolveApiKey(undefined, 'stored-xyz'), '');
  });

  it('typed apiKey replaces the stored one and is length-clipped to 256', () => {
    const huge = 'a'.repeat(400);
    assert.equal(resolveApiKey(huge, 'old').length, 256);
  });

  it("'***' with no stored apiKey resolves to '' (so the delete-path runs)", () => {
    assert.equal(resolveApiKey('***', undefined), '');
    assert.equal(resolveApiKey('***', ''), '');
  });
});
