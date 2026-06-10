import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APPLIANCE_ID_RE,
  readApplianceId,
  sshKeyFingerprint,
  clampTtlMin,
  buildTunnelArgs,
  resolveTunnelBinary,
  createSupportTunnel,
  TTL_MIN_FLOOR,
  TTL_MIN_CEIL,
  TTL_MIN_DEFAULT,
} from '../services/support-tunnel.js';

// --- appliance-id ------------------------------------------------------------

test('APPLIANCE_ID_RE accepts a UUID, rejects junk', () => {
  assert.ok(APPLIANCE_ID_RE.test('a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'));
  assert.ok(APPLIANCE_ID_RE.test('box-01'));
  assert.ok(!APPLIANCE_ID_RE.test('UPPER-CASE'));            // relay requires lowercase
  assert.ok(!APPLIANCE_ID_RE.test('has space'));
  assert.ok(!APPLIANCE_ID_RE.test('a'.repeat(37)));          // > 36 chars
  assert.ok(!APPLIANCE_ID_RE.test(''));
  assert.ok(!APPLIANCE_ID_RE.test('path/traversal'));
});

test('readApplianceId reads + lowercases a valid id, null on absent/malformed', () => {
  const fakeFs = (content) => ({ readFileSync: () => content });
  assert.equal(readApplianceId('/x', fakeFs('A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D\n')),
    'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d');
  assert.equal(readApplianceId('/x', fakeFs('  box-7  ')), 'box-7');
  assert.equal(readApplianceId('/x', fakeFs('not valid id!')), null);
  assert.equal(readApplianceId('/x', { readFileSync: () => { throw new Error('ENOENT'); } }), null);
});

// --- fingerprint -------------------------------------------------------------

test('sshKeyFingerprint matches OpenSSH SHA256 form', () => {
  // Verified against the live relay hostkey fingerprint reported by the peer.
  assert.equal(
    sshKeyFingerprint('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMCBb6vi0LTevujdKl0Vz9y8YvE2uMIjJvYbPZ9WDpyT relay'),
    'SHA256:EYZUu4qfxhtOFgvXmwpVNKc9xsc/h2PHVHeRN6y7tRQ'
  );
  assert.equal(sshKeyFingerprint(''), null);
  assert.equal(sshKeyFingerprint('garbage'), null);
});

// --- TTL clamp ---------------------------------------------------------------

test('clampTtlMin clamps into [floor, ceil] and defaults sanely', () => {
  assert.equal(clampTtlMin(1), TTL_MIN_FLOOR);
  assert.equal(clampTtlMin(99999), TTL_MIN_CEIL);
  assert.equal(clampTtlMin(45), 45);
  assert.equal(clampTtlMin(0), TTL_MIN_DEFAULT);
  assert.equal(clampTtlMin(NaN), TTL_MIN_DEFAULT);
  assert.equal(clampTtlMin(undefined, 30), 30);
});

// --- arg builder -------------------------------------------------------------

const VALID = {
  host: 'support.dvhub.de', port: 47821, user: 'dvhub-support',
  shellPort: 49101, webPort: 49102, keyPath: '/var/lib/dvhub/support/relay_id_ed25519',
  knownHostsPath: '/var/lib/dvhub/support/known_hosts',
};

test('buildTunnelArgs (autossh) produces correct reverse-forward argv', () => {
  const args = buildTunnelArgs(VALID, { binary: 'autossh' });
  assert.deepEqual(args.slice(0, 2), ['-M', '0']);          // autossh monitor off
  assert.ok(args.includes('-N'));
  assert.ok(args.includes('-R'));
  // both reverse forwards present and bound to relay loopback
  assert.ok(args.includes('127.0.0.1:49101:127.0.0.1:22'));
  assert.ok(args.includes('127.0.0.1:49102:127.0.0.1:80'));
  // hardening flags
  assert.ok(args.includes('StrictHostKeyChecking=yes'));
  assert.ok(args.includes('ExitOnForwardFailure=yes'));
  assert.ok(args.includes('BatchMode=yes'));
  assert.ok(args.includes('UserKnownHostsFile=/var/lib/dvhub/support/known_hosts'));
  // dial target last
  assert.equal(args[args.length - 1], 'dvhub-support@support.dvhub.de');
  // key + port
  assert.ok(args.includes('-i'));
  assert.ok(args.includes('/var/lib/dvhub/support/relay_id_ed25519'));
  assert.ok(args.includes('47821'));
});

test('buildTunnelArgs (ssh) omits the autossh -M 0', () => {
  const args = buildTunnelArgs(VALID, { binary: 'ssh' });
  assert.ok(!(args[0] === '-M'));
  assert.equal(args[0], '-N');
});

test('buildTunnelArgs throws on missing/invalid fields', () => {
  assert.throws(() => buildTunnelArgs({ ...VALID, host: '' }), /host/);
  assert.throws(() => buildTunnelArgs({ ...VALID, shellPort: 0 }), /shellPort/);
  assert.throws(() => buildTunnelArgs({ ...VALID, keyPath: '' }), /keyPath/);
  assert.throws(() => buildTunnelArgs({ ...VALID, port: -1 }), /port/);
});

test('resolveTunnelBinary prefers autossh when present, else ssh', () => {
  assert.deepEqual(resolveTunnelBinary({ existsSync: () => true }), { binary: 'autossh', bin: '/usr/bin/autossh' });
  assert.deepEqual(resolveTunnelBinary({ existsSync: () => false }), { binary: 'ssh', bin: 'ssh' });
});

// --- manager lifecycle (injected spawn/fs/timers) ----------------------------

function makeCtx(overrides = {}) {
  const logs = [];
  const cfg = {
    support: {
      relay: { host: 'support.dvhub.de', port: 47821, user: 'dvhub-support', shellPort: 49101, webPort: 49102 },
      tunnel: { autoCloseMin: 60 },
      localUser: { enabled: true },
    },
  };
  return {
    logs,
    ctx: {
      getCfg: () => cfg,
      getDataDir: () => '/var/lib/dvhub',
      pushLog: (ev, data, actor) => logs.push({ ev, data, actor }),
      ...overrides,
    },
    cfg,
  };
}

function fakeProc() {
  const handlers = {};
  return {
    killed: false,
    stderr: { on: () => {} },
    on(ev, cb) { handlers[ev] = cb; return this; },
    kill() { this.killed = true; return true; },
    emit(ev, ...a) { handlers[ev]?.(...a); },
  };
}

test('open refuses when not provisioned (no appliance-id)', () => {
  const { ctx } = makeCtx();
  const tun = createSupportTunnel(ctx, {
    fs: { existsSync: () => true, readFileSync: () => { throw new Error('ENOENT'); } },
    spawn: () => { throw new Error('should not spawn'); },
  });
  const r = tun.open({ ttlMin: 30 }, 'tester');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'not_provisioned');
  assert.equal(tun.status().open, false);
});

test('open spawns tunnel, status reflects open, close tears down', () => {
  const { ctx, logs } = makeCtx();
  let spawned = null;
  const proc = fakeProc();
  let nowMs = 1_000_000;
  const tun = createSupportTunnel(ctx, {
    fs: { existsSync: () => true, readFileSync: () => 'box-01' },
    spawn: (bin, args) => { spawned = { bin, args }; return proc; },
    now: () => nowMs,
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
  });

  const r = tun.open({ ttlMin: 30 }, 'christin');
  assert.equal(r.ok, true);
  assert.ok(spawned, 'spawn was called');
  assert.ok(spawned.args.includes('-R'));
  const st = tun.status();
  assert.equal(st.open, true);
  assert.equal(st.openedBy, 'christin');
  assert.equal(st.relay.shellPort, 49101);
  assert.ok(logs.some((l) => l.ev === 'support_tunnel_opened'));

  const c = tun.close('christin');
  assert.equal(c.ok, true);
  assert.equal(proc.killed, true);
  assert.equal(tun.status().open, false);
  assert.ok(logs.some((l) => l.ev === 'support_tunnel_closed'));
});

test('open is idempotent while already open', () => {
  const { ctx } = makeCtx();
  const tun = createSupportTunnel(ctx, {
    fs: { existsSync: () => true, readFileSync: () => 'box-01' },
    spawn: () => fakeProc(),
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
  });
  tun.open({ ttlMin: 30 }, 'a');
  const r2 = tun.open({ ttlMin: 30 }, 'b');
  assert.equal(r2.ok, true);
  assert.equal(r2.alreadyOpen, true);
});

test('unexpected process exit clears open state + audits', () => {
  const { ctx, logs } = makeCtx();
  const proc = fakeProc();
  const tun = createSupportTunnel(ctx, {
    fs: { existsSync: () => true, readFileSync: () => 'box-01' },
    spawn: () => proc,
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
  });
  tun.open({ ttlMin: 30 }, 'christin');
  assert.equal(tun.status().open, true);
  proc.emit('exit', 1, null); // relay rejected forward / fatal
  assert.equal(tun.status().open, false);
  const closed = logs.find((l) => l.ev === 'support_tunnel_closed');
  assert.ok(closed && closed.data.unexpected === true);
});

// --- Review 2026-06-10 (B7): uiToken CSRF-nonce -------------------------------

test('B7: status() issues a uiToken; consumeUiToken accepts it exactly once', () => {
  const { ctx } = makeCtx();
  const tun = createSupportTunnel(ctx, {
    fs: { existsSync: () => false, readFileSync: () => { throw new Error('ENOENT'); } },
  });
  const tok = tun.status().uiToken;
  assert.ok(typeof tok === 'string' && tok.length === 32, 'hex token expected');
  assert.equal(tun.consumeUiToken(tok), true, 'first consume succeeds');
  assert.equal(tun.consumeUiToken(tok), false, 'one-time: second consume fails');
});

test('B7: consumeUiToken rejects wrong/garbage candidates without consuming', () => {
  const { ctx } = makeCtx();
  const tun = createSupportTunnel(ctx, {
    fs: { existsSync: () => false, readFileSync: () => { throw new Error('ENOENT'); } },
  });
  const tok = tun.status().uiToken;
  assert.equal(tun.consumeUiToken('deadbeef'.repeat(4)), false, 'wrong token rejected');
  assert.equal(tun.consumeUiToken(''), false);
  assert.equal(tun.consumeUiToken(null), false);
  assert.equal(tun.consumeUiToken(tok), true, 'real token still valid after failed attempts');
});

test('B7: uiToken expires after 10 min and status() re-issues a fresh one', () => {
  const { ctx } = makeCtx();
  let nowMs = 1_000_000;
  const tun = createSupportTunnel(ctx, {
    fs: { existsSync: () => false, readFileSync: () => { throw new Error('ENOENT'); } },
    now: () => nowMs,
  });
  const tok1 = tun.status().uiToken;
  nowMs += 11 * 60 * 1000; // beyond TTL
  assert.equal(tun.consumeUiToken(tok1), false, 'expired token rejected');
  const tok2 = tun.status().uiToken;
  assert.notEqual(tok2, tok1, 'fresh token re-issued after expiry');
  assert.equal(tun.consumeUiToken(tok2), true);
});

test('B7: liteStatus exposes only in-memory fields and NO uiToken', () => {
  const { ctx } = makeCtx();
  const tun = createSupportTunnel(ctx, {
    fs: { existsSync: () => false, readFileSync: () => { throw new Error('ENOENT'); } },
  });
  const ls = tun.liteStatus();
  assert.deepEqual(Object.keys(ls).sort(), ['expiresAt', 'open', 'ttlRemainingSec']);
  assert.equal(ls.open, false);
  assert.ok(!('uiToken' in ls), 'liteStatus must never leak the nonce');
});
