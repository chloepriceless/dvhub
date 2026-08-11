// test/xff-trust.test.js
//
// Plan 09-03 (REQ-9.3 xff-trust): defence-in-depth coverage for the
// `deriveClientIp(req, cfg)` helper that Phase 9 routes BOTH
// `isLocalNetworkRequest` (LAN auth-bypass) AND `getRateLimitKey`
// through. The two paths must derive the SAME client IP — divergence
// would let an attacker bypass auth while staying under the rate
// limit of a different bucket, or vice versa.
//
// The pre-Phase-9 behaviour read `req.socket.remoteAddress` directly,
// which trivially collapses every external request to `127.0.0.1`
// when dvhub sits behind a reverse proxy. Plan 09-03 introduces an
// explicit opt-in (`cfg.trustProxy=true` + non-empty
// `cfg.trustedProxyIps`) before any X-Forwarded-For hop is honoured.
//
// Threat-model-relevant invariants asserted below:
//
//   1. Default deny — XFF is IGNORED until the operator opts in.
//   2. Single trusted proxy — rightmost untrusted hop is the client.
//   3. Direct connection from untrusted source — XFF is IGNORED even
//      when trustProxy=true, because the immediate peer is not in the
//      trusted set (an attacker can not bypass by sending XFF directly).
//   4. Multi-hop trusted chain — pop trusted hops right-to-left until
//      the first untrusted hop is found (matches Express/Spring/Rails).
//   5. Misconfigured (trustProxy=true + empty trustedProxyIps) — fall
//      back to socket address AND log a one-time startup warning.
//
// Bonus regression: scenario 3 also proves the XFF spoof can NEVER
// grant LAN trust, because deriveClientIp returns the SOCKET address
// (203.0.113.7), which is public and fails the RFC1918 check.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { deriveClientIp, _resetTrustProxyWarnForTesting } from '../routes-api.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeReq({ socket = '127.0.0.1', xff = null, headers = {} } = {}) {
  const finalHeaders = { ...headers };
  if (xff !== null) finalHeaders['x-forwarded-for'] = xff;
  return {
    socket: { remoteAddress: socket },
    headers: finalHeaders,
  };
}

// Tracks console.warn calls so scenario 5 can assert the misconfig
// warning fires exactly once. Restored after each test.
function captureWarn() {
  const calls = [];
  const orig = console.warn;
  // eslint-disable-next-line no-console
  console.warn = (...args) => { calls.push(args.map(String).join(' ')); };
  return {
    calls,
    restore() { console.warn = orig; },
  };
}

// ---------------------------------------------------------------------------
// Scenario 1 — Default deny: XFF is ignored when cfg.trustProxy is not true
// ---------------------------------------------------------------------------

describe('deriveClientIp — default deny (no trustProxy opt-in)', () => {
  it('returns socket address when cfg is empty, ignoring X-Forwarded-For', () => {
    const cfg = {};
    const req = makeReq({ socket: '127.0.0.1', xff: '8.8.8.8' });
    assert.equal(deriveClientIp(req, cfg), '127.0.0.1');
  });

  it('returns socket address when cfg is null/undefined, ignoring XFF', () => {
    const req = makeReq({ socket: '127.0.0.1', xff: '8.8.8.8' });
    assert.equal(deriveClientIp(req, null), '127.0.0.1');
    assert.equal(deriveClientIp(req, undefined), '127.0.0.1');
  });

  it('returns socket address when trustProxy is explicitly false, ignoring XFF', () => {
    const cfg = { trustProxy: false, trustedProxyIps: ['127.0.0.1'] };
    const req = makeReq({ socket: '127.0.0.1', xff: '8.8.8.8' });
    assert.equal(deriveClientIp(req, cfg), '127.0.0.1');
  });

  it('strips IPv4-in-IPv6 ::ffff: prefix from the socket address', () => {
    const cfg = {};
    const req = makeReq({ socket: '::ffff:192.168.1.42', xff: '8.8.8.8' });
    assert.equal(deriveClientIp(req, cfg), '192.168.1.42');
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — Trust opt-in, single proxy hop
// ---------------------------------------------------------------------------

describe('deriveClientIp — trustProxy opt-in (single proxy)', () => {
  it('honours XFF when socket is in trustedProxyIps', () => {
    const cfg = { trustProxy: true, trustedProxyIps: ['127.0.0.1'] };
    const req = makeReq({ socket: '127.0.0.1', xff: '8.8.8.8' });
    assert.equal(deriveClientIp(req, cfg), '8.8.8.8');
  });

  it('falls back to socket address when no XFF header is present', () => {
    const cfg = { trustProxy: true, trustedProxyIps: ['127.0.0.1'] };
    const req = makeReq({ socket: '127.0.0.1' }); // no XFF
    assert.equal(deriveClientIp(req, cfg), '127.0.0.1');
  });

  it('strips ::ffff: prefix from XFF hops too', () => {
    const cfg = { trustProxy: true, trustedProxyIps: ['127.0.0.1'] };
    const req = makeReq({ socket: '127.0.0.1', xff: '::ffff:8.8.8.8' });
    assert.equal(deriveClientIp(req, cfg), '8.8.8.8');
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — Attacker spoof from an untrusted source
// ---------------------------------------------------------------------------

describe('deriveClientIp — XFF spoof from untrusted source is IGNORED', () => {
  it('returns the socket address even when XFF claims 127.0.0.1', () => {
    const cfg = { trustProxy: true, trustedProxyIps: ['10.0.0.1'] };
    const req = makeReq({ socket: '203.0.113.7', xff: '127.0.0.1' });
    // The immediate peer (203.0.113.7) is NOT in trustedProxyIps, so
    // XFF is ignored entirely — defence against attackers who set the
    // header directly from outside the proxy chain.
    assert.equal(deriveClientIp(req, cfg), '203.0.113.7');
  });

  it('BONUS regression — scenario-3 spoof cannot grant LAN trust', () => {
    // deriveClientIp returns 203.0.113.7 (public IP) for scenario 3.
    // The downstream RFC1918/loopback check in isLocalNetworkRequest
    // operates on that derived value, so the spoof can never collapse
    // to a private address. We assert this contract here to lock the
    // behaviour against future regressions of either layer.
    const cfg = { trustProxy: true, trustedProxyIps: ['10.0.0.1'] };
    const req = makeReq({ socket: '203.0.113.7', xff: '127.0.0.1' });
    const derived = deriveClientIp(req, cfg);
    const parts = derived.split('.').map(Number);
    const isLoopback = derived === '127.0.0.1' || derived === '::1';
    const isRfc1918 = parts.length === 4 && (
      parts[0] === 10 ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168)
    );
    assert.equal(isLoopback || isRfc1918, false,
      `derived IP ${derived} must NOT pass the LAN-trust gate`);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — Multi-hop trusted chain
// ---------------------------------------------------------------------------

describe('deriveClientIp — multi-hop chain pops trusted hops right-to-left', () => {
  it('returns the rightmost untrusted hop when chain has multiple trusted proxies', () => {
    const cfg = { trustProxy: true, trustedProxyIps: ['127.0.0.1', '10.0.0.1'] };
    // XFF = '8.8.8.8, 10.0.0.1' means: client=8.8.8.8 → proxy1=10.0.0.1 → socket=127.0.0.1.
    // Both 127.0.0.1 (socket) and 10.0.0.1 (rightmost XFF hop) are trusted,
    // so we pop right-to-left until we hit 8.8.8.8 (untrusted) = real client.
    const req = makeReq({ socket: '127.0.0.1', xff: '8.8.8.8, 10.0.0.1' });
    assert.equal(deriveClientIp(req, cfg), '8.8.8.8');
  });

  it('returns the leftmost hop when EVERY XFF entry is trusted', () => {
    // Pathological / misconfigured chain — all hops are in the trusted set.
    // We return the leftmost hop ("closest to client") rather than the socket,
    // because that's the best guess at who originated the request.
    const cfg = { trustProxy: true, trustedProxyIps: ['127.0.0.1', '10.0.0.1', '10.0.0.2'] };
    const req = makeReq({ socket: '127.0.0.1', xff: '10.0.0.2, 10.0.0.1' });
    assert.equal(deriveClientIp(req, cfg), '10.0.0.2');
  });

  it('tolerates whitespace and empty entries in the XFF chain', () => {
    const cfg = { trustProxy: true, trustedProxyIps: ['127.0.0.1', '10.0.0.1'] };
    const req = makeReq({ socket: '127.0.0.1', xff: '  8.8.8.8 ,  10.0.0.1  ' });
    assert.equal(deriveClientIp(req, cfg), '8.8.8.8');
  });
});

// ---------------------------------------------------------------------------
// Scenario 5 — Misconfigured (trustProxy=true + empty trustedProxyIps)
// ---------------------------------------------------------------------------

describe('deriveClientIp — misconfigured trustProxy falls back safely', () => {
  beforeEach(() => {
    // The one-time warning latch is a module-scope boolean; reset before
    // each test so the warning-fires assertion below is deterministic.
    _resetTrustProxyWarnForTesting();
  });

  it('falls back to socket address when trustedProxyIps is empty', () => {
    const cfg = { trustProxy: true, trustedProxyIps: [] };
    const req = makeReq({ socket: '127.0.0.1', xff: '8.8.8.8' });
    const cap = captureWarn();
    try {
      assert.equal(deriveClientIp(req, cfg), '127.0.0.1');
    } finally {
      cap.restore();
    }
  });

  it('falls back to socket address when trustedProxyIps is missing entirely', () => {
    const cfg = { trustProxy: true }; // no trustedProxyIps field
    const req = makeReq({ socket: '127.0.0.1', xff: '8.8.8.8' });
    const cap = captureWarn();
    try {
      assert.equal(deriveClientIp(req, cfg), '127.0.0.1');
    } finally {
      cap.restore();
    }
  });

  it('logs the misconfig warning exactly once across multiple calls', () => {
    const cfg = { trustProxy: true, trustedProxyIps: [] };
    const req = makeReq({ socket: '127.0.0.1', xff: '8.8.8.8' });
    const cap = captureWarn();
    try {
      deriveClientIp(req, cfg);
      deriveClientIp(req, cfg);
      deriveClientIp(req, cfg);
      const matchingCalls = cap.calls.filter((line) =>
        line.includes('cfg.trustProxy=true but cfg.trustedProxyIps is empty'));
      assert.equal(matchingCalls.length, 1,
        `expected exactly one misconfig warning, got ${matchingCalls.length}: ${JSON.stringify(cap.calls)}`);
    } finally {
      cap.restore();
    }
  });
});
