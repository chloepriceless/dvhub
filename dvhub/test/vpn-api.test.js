import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRuntimeSnapshot, buildWebStatusResponse } from '../runtime-state.js';
import { validateWireGuardConfig, validateIPSecConfig, sanitizeProfileName } from '../vpn-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VPN_MANAGER_PATH = path.resolve(__dirname, '..', 'vpn-manager.js');
const ROUTES_API_PATH = path.resolve(__dirname, '..', 'routes-api.js');

function readSource(p) {
  return fs.readFileSync(p, 'utf8');
}

test('buildRuntimeSnapshot includes vpn field when provided', () => {
  const vpn = {
    enabled: true,
    status: 'connected',
    protocol: 'openvpn',
    tunIp: '10.8.0.2',
    remoteIp: '1.2.3.4',
    upSince: '2026-04-01T12:00:00.000Z',
    uptimeSeconds: 3600,
    bytesSent: 1024,
    bytesReceived: 2048,
    reconnectAttempts: 0,
    lastError: null,
    certExpiry: '2027-03-15T12:00:00.000Z',
    certDaysRemaining: 347,
    watchdogOk: true,
    profileName: 'direktvermarkter'
  };

  const snapshot = buildRuntimeSnapshot({ vpn });

  assert.ok(snapshot.vpn, 'vpn field should exist');
  assert.equal(snapshot.vpn.status, 'connected');
  assert.equal(snapshot.vpn.tunIp, '10.8.0.2');
  assert.equal(snapshot.vpn.protocol, 'openvpn');
  assert.equal(snapshot.vpn.uptimeSeconds, 3600);
  assert.equal(snapshot.vpn.profileName, 'direktvermarkter');
  assert.equal(snapshot.vpn.certDaysRemaining, 347);
  assert.equal(snapshot.vpn.watchdogOk, true);
});

test('buildRuntimeSnapshot vpn is null when not provided', () => {
  const snapshot = buildRuntimeSnapshot({});
  assert.equal(snapshot.vpn, null);
});

test('buildWebStatusResponse includes vpn from snapshot', () => {
  const vpn = {
    enabled: true,
    status: 'disconnected',
    protocol: 'openvpn',
    tunIp: null,
    reconnectAttempts: 2,
    lastError: 'timeout',
    watchdogOk: false,
    profileName: 'test'
  };

  const response = buildWebStatusResponse({
    snapshot: { vpn }
  });

  assert.ok(response.vpn, 'vpn field should be in web status response');
  assert.equal(response.vpn.status, 'disconnected');
  assert.equal(response.vpn.reconnectAttempts, 2);
  assert.equal(response.vpn.lastError, 'timeout');
  assert.equal(response.vpn.profileName, 'test');
});

test('buildWebStatusResponse vpn is null when snapshot has no vpn', () => {
  const response = buildWebStatusResponse({ snapshot: {} });
  assert.equal(response.vpn, null);
});

test('vpn snapshot strips non-VPN fields', () => {
  const vpn = {
    enabled: true,
    status: 'connected',
    tunIp: '10.8.0.2',
    secretInternalField: 'should-not-appear',
    _privateKey: 'should-not-appear'
  };

  const snapshot = buildRuntimeSnapshot({ vpn });
  assert.equal(snapshot.vpn.secretInternalField, undefined);
  assert.equal(snapshot.vpn._privateKey, undefined);
  assert.equal(snapshot.vpn.status, 'connected');
});

// ──────────────────────────────────────────────────────────────────────────
// Plan 24-01 Wave-0 regression sentinel for the VPN-Config-Upload-RCE audit.
//
// The 24-01 read-only audit concluded "RCE WIDERLEGT (im Code aktiv
// gegengehärtet)" — see .planning/phases/24-security-defaults/24-01-AUDIT.md.
// These file-level regex assertions (same style as family-routes.test.js)
// nail the three dangerous-directive blocklists + sanitizeProfileName + the
// Top-Level /api/ checkAuth gate so a future refactor cannot SILENTLY remove
// the hardening without turning a test RED. They deliberately assert against
// the SOURCE TEXT (the blocklist constants are module-private), not behaviour
// alone, so even an accidental constant rename/deletion trips the sentinel.
// ──────────────────────────────────────────────────────────────────────────

describe('24-01 regression: vpn-manager dangerous-directive blocklists (static)', () => {
  it('WG_DANGEROUS_DIRECTIVES exists and carries all four WireGuard up/down hooks', () => {
    const src = readSource(VPN_MANAGER_PATH);
    const match = src.match(/const\s+WG_DANGEROUS_DIRECTIVES\s*=\s*new Set\(\[([\s\S]*?)\]\s*\)/);
    assert.ok(match, 'WG_DANGEROUS_DIRECTIVES declaration must exist');
    const body = match[1];
    for (const directive of ['PostUp', 'PreUp', 'PostDown', 'PreDown']) {
      assert.match(body, new RegExp(`'${directive}'`), `WG blocklist must include ${directive}`);
    }
  });

  it('IPSEC_DANGEROUS_KEYS exists and carries leftupdown/rightupdown/include', () => {
    const src = readSource(VPN_MANAGER_PATH);
    const match = src.match(/const\s+IPSEC_DANGEROUS_KEYS\s*=\s*new Set\(\[([\s\S]*?)\]\s*\)/);
    assert.ok(match, 'IPSEC_DANGEROUS_KEYS declaration must exist');
    const body = match[1];
    for (const key of ['leftupdown', 'rightupdown', 'include']) {
      assert.match(body, new RegExp(`'${key}'`), `IPSec blocklist must include ${key}`);
    }
  });

  it('DANGEROUS_DIRECTIVES (OpenVPN) exists and blocks the core RCE directives', () => {
    const src = readSource(VPN_MANAGER_PATH);
    const match = src.match(/const\s+DANGEROUS_DIRECTIVES\s*=\s*new Set\(\[([\s\S]*?)\]\s*\)/);
    assert.ok(match, 'DANGEROUS_DIRECTIVES declaration must exist');
    const body = match[1];
    // The literal-array members the OpenVPN parser refuses outright.
    for (const directive of ['up', 'down', 'script-security', 'plugin']) {
      assert.match(body, new RegExp(`'${directive}'`), `OpenVPN blocklist must include ${directive}`);
    }
    // The management* family is added imperatively after the literal array.
    assert.match(src, /DANGEROUS_DIRECTIVES\.add\(\s*'management'\s*\)/,
      'OpenVPN blocklist must add the privileged management interface');
  });

  it('sanitizeProfileName is exported and strips to a tight [A-Za-z0-9_-] class', () => {
    const src = readSource(VPN_MANAGER_PATH);
    assert.match(src, /export function sanitizeProfileName\s*\(/,
      'sanitizeProfileName must stay exported for sudo-boundary reuse');
    assert.match(src, /replace\(\s*\/\[\^a-zA-Z0-9_-\]\/g/,
      'sanitizeProfileName must keep the tight character-class strip');
  });
});

describe('24-01 regression: routes-api Top-Level /api/ checkAuth gating (static)', () => {
  it('every /api/ path runs checkRateLimit + checkAuth BEFORE the route table', () => {
    const src = readSource(ROUTES_API_PATH);
    // The Top-Level gate block: startsWith('/api/') guard that calls checkAuth.
    const gate = src.match(
      /if\s*\(\s*url\.pathname\.startsWith\('\/api\/'\)[\s\S]{0,120}?\)\s*\{[\s\S]{0,200}?checkAuth\(req,\s*res\)/
    );
    assert.ok(gate, 'Top-Level /api/ gate must call checkAuth before route dispatch');
    assert.match(src, /url\.pathname\.startsWith\('\/api\/'\)/,
      'gate predicate startsWith(\'/api/\') must be present');
  });

  it('the VPN upload route exists and is NOT marked LAN-safe (no bypass)', () => {
    const src = readSource(ROUTES_API_PATH);
    assert.match(src, /url\.pathname === '\/api\/vpn\/config\/upload'/,
      'the VPN config upload route must exist');

    // It must NOT appear inside the LAN_SAFE_ENDPOINTS allowlist — privileged
    // root-capable VPN apply must stay behind the standard Bearer gate for
    // external callers (the lanTrust:'open' LAN bypass is a 24-02 decision,
    // tracked in the audit, not an extra per-endpoint bypass here).
    const lanSafe = src.match(/const\s+LAN_SAFE_ENDPOINTS\s*=\s*new Set\(\[([\s\S]*?)\]\s*\)/);
    assert.ok(lanSafe, 'LAN_SAFE_ENDPOINTS declaration must exist');
    assert.doesNotMatch(lanSafe[1], /'\/api\/vpn\/config\/upload'/,
      'the VPN upload route must NOT be in the LAN-safe allowlist');
  });
});

describe('24-01 regression: blocklist enforcement (behaviour)', () => {
  it('rejects a WireGuard config carrying a PostUp shell hook', () => {
    const malicious = [
      '[Interface]',
      'PrivateKey = AAAA',
      'Address = 10.0.0.2/24',
      'PostUp = /bin/sh -c id',
      '[Peer]',
      'PublicKey = BBBB',
      'Endpoint = 198.51.100.1:51820'
    ].join('\n');
    const result = validateWireGuardConfig(malicious);
    assert.equal(result.valid, false, 'a PostUp hook must invalidate the WG config');
    assert.ok(
      result.errors.some(e => /PostUp/.test(e)),
      'the validation error must name the blocked PostUp directive'
    );
  });

  it('rejects an IPSec config carrying a leftupdown script hook', () => {
    const malicious = [
      'conn dvhub',
      '  right = 198.51.100.1',
      '  leftupdown = /bin/sh -c id'
    ].join('\n');
    const result = validateIPSecConfig(malicious);
    assert.equal(result.valid, false, 'a leftupdown hook must invalidate the IPSec config');
    assert.ok(
      result.errors.some(e => /leftupdown/.test(e)),
      'the validation error must name the blocked leftupdown directive'
    );
  });

  it('sanitizeProfileName neutralises path-traversal / shell metacharacters', () => {
    assert.equal(sanitizeProfileName('../../etc/passwd'), 'etcpasswd');
    assert.equal(sanitizeProfileName('a; rm -rf /'), 'arm-rf');
    assert.equal(sanitizeProfileName('valid_Name-1'), 'valid_Name-1');
    // Empty-after-strip falls back to the safe default (never an empty path).
    assert.equal(sanitizeProfileName('@@@'), '');
  });
});
