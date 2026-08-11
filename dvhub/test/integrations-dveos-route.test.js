// test/integrations-dveos-route.test.js — editable EOS endpoint (2026-07-17)
// Static regex assertions for POST /api/integrations/dveos — mirrors the
// integrations-uptime-kuma-route.test.js shape. The drawer may point DVhub at
// ANY EOS instance (DV-EOS fork or vanilla), so the POST must enforce the same
// SSRF rule as the /api/config save-guard (B2): http only to RFC1918/loopback,
// https to any host — the adapter fetches this URL server-side and relays
// responses.

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

function postHandlerBlock(src) {
  return src.match(
    /url\.pathname\s*===\s*['"]\/api\/integrations\/dveos['"]\s*&&\s*req\.method\s*===\s*['"]POST['"][\s\S]*?return\s+json\(res,\s*200,\s*\{\s*ok:\s*true\s*,\s*url:\s*candidate\s*\}\)/
  );
}

describe('editable EOS endpoint: POST /api/integrations/dveos (static)', () => {
  it('GET /api/integrations/dveos stays registered with checkAuth gate', () => {
    const src = readRoutes();
    assert.match(src, /url\.pathname\s*===\s*['"]\/api\/integrations\/dveos['"]\s*&&\s*req\.method\s*===\s*['"]GET['"]/);
  });

  it('POST /api/integrations/dveos is registered with checkAuth gate', () => {
    const src = readRoutes();
    assert.match(src, /url\.pathname\s*===\s*['"]\/api\/integrations\/dveos['"]\s*&&\s*req\.method\s*===\s*['"]POST['"][\s\S]{0,120}checkAuth\(req,\s*res\)/);
  });

  it('POST enforces the B2 SSRF rule (https any host, http only RFC1918/loopback)', () => {
    const src = readRoutes();
    const m = postHandlerBlock(src);
    assert.ok(m, 'POST dveos handler block must close with ok:true + url');
    assert.match(m[0], /eu\.protocol\s*===\s*['"]https:['"]/, 'https to any host must stay allowed');
    assert.match(m[0], /eu\.protocol\s*===\s*['"]http:['"]\s*&&\s*\(isRfc1918OrLoopback\(eu\.hostname\)\s*\|\|\s*eu\.hostname\s*===\s*['"]localhost['"]\)/,
      'http must be limited to RFC1918/loopback/localhost');
    assert.match(m[0], /invalid_eos_proxy_url/,
      'rejection must reuse the invalid_eos_proxy_url error code from the /api/config guard');
  });

  it('POST normalises the URL (trim, trailing slashes, length cap)', () => {
    const src = readRoutes();
    const m = postHandlerBlock(src);
    assert.ok(m);
    assert.match(m[0], /\.trim\(\)\.replace\(\/\\\/\+\$\/,\s*''\)\.slice\(0,\s*512\)/,
      'must trim, strip trailing slashes and cap at 512 chars');
  });

  it('POST deep-clones raw cfg and writes ONLY optimizer.eosProxy.url via saveAndApplyConfig', () => {
    const src = readRoutes();
    const m = postHandlerBlock(src);
    assert.ok(m);
    assert.match(m[0], /JSON\.parse\(JSON\.stringify\(\s*ctx\.getRawCfg\(\)/, 'must deep-clone raw cfg (POST /api/config replaces — server-side merge required)');
    assert.match(m[0], /next\.optimizer\.eosProxy\.url\s*=\s*candidate/, 'must assign next.optimizer.eosProxy.url');
    assert.doesNotMatch(m[0], /next\.optimizer\.eosProxy\.enabled\s*=/, 'must NOT flip eosProxy.enabled — URL-only endpoint');
    assert.match(m[0], /ctx\.saveAndApplyConfig\s*\(\s*next\s*\)/, 'must persist via saveAndApplyConfig');
  });

  it('POST audit-logs success with actorContext and failure distinctly', () => {
    const src = readRoutes();
    const m = postHandlerBlock(src);
    assert.ok(m);
    assert.match(m[0], /dveos_url_save_error/);
    assert.match(m[0], /dveos_url_saved[\s\S]{0,120}actorContext\(req\)/, 'success log must include actorContext');
  });

  it('frontend: drawer wires #dveos-save to the POST endpoint with an editable input', () => {
    const js = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'integrations.js'), 'utf8');
    assert.match(js, /closest\(\s*['"]#dveos-save['"]\s*\)/, 'click delegation for #dveos-save');
    assert.match(js, /apiFetch\(\s*['"]\/api\/integrations\/dveos['"]\s*,\s*\{\s*[\s\S]{0,80}method:\s*['"]POST['"]/,
      'save must POST /api/integrations/dveos');
    const html = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'integrations.html'), 'utf8');
    assert.match(html, /id="dveos-url-input"/, 'drawer must contain the editable URL input');
    assert.match(html, /id="dveos-save"/, 'drawer must contain the save button');
  });
});
