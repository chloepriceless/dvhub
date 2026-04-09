import test from 'node:test';
import assert from 'node:assert/strict';

// We import createVpnManager to test its internal validation and state logic.
// Since the actual OpenVPN process can't run in tests, we test the parts
// that are testable without spawning processes.
import { createVpnManager } from '../vpn-manager.js';

function makeCtx() {
  const logs = [];
  const state = {};
  return {
    state,
    getCfg: () => ({
      vpn: {
        enabled: true,
        protocol: 'openvpn',
        autoConnect: false,
        profileName: 'test-profile',
        watchdog: {
          enabled: false,
          intervalMs: 10000,
          failThreshold: 3,
          maxBackoffMs: 120000
        }
      }
    }),
    pushLog: (event, details) => logs.push({ event, ...details }),
    logs
  };
}

test('createVpnManager initialises state.vpn with disconnected status', () => {
  const ctx = makeCtx();
  const mgr = createVpnManager(ctx);

  assert.equal(ctx.state.vpn.status, 'disconnected');
  assert.equal(ctx.state.vpn.enabled, false);
  assert.equal(ctx.state.vpn.protocol, 'openvpn');
  assert.equal(ctx.state.vpn.tunIp, null);
  assert.equal(ctx.state.vpn.reconnectAttempts, 0);
  assert.equal(ctx.state.vpn.watchdogOk, false);
  assert.equal(ctx.state.vpn.profileName, null);
});

test('getStatus returns a copy of state.vpn', () => {
  const ctx = makeCtx();
  const mgr = createVpnManager(ctx);

  const status = mgr.getStatus();
  assert.equal(status.status, 'disconnected');
  // Modifying returned object must not affect internal state
  status.status = 'hacked';
  assert.equal(ctx.state.vpn.status, 'disconnected');
});

test('validateConfig rejects .ovpn missing remote directive', () => {
  const ctx = makeCtx();
  const mgr = createVpnManager(ctx);

  const result = mgr.validateConfig(`
client
proto udp
<ca>
-----BEGIN CERTIFICATE-----
test
-----END CERTIFICATE-----
</ca>
`);

  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('remote')));
});

test('validateConfig accepts minimal valid .ovpn', () => {
  const ctx = makeCtx();
  const mgr = createVpnManager(ctx);

  const result = mgr.validateConfig(`
client
remote vpn.example.com 1194
proto udp
<ca>
-----BEGIN CERTIFICATE-----
test
-----END CERTIFICATE-----
</ca>
<cert>
-----BEGIN CERTIFICATE-----
test
-----END CERTIFICATE-----
</cert>
<key>
-----BEGIN PRIVATE KEY-----
test
-----END PRIVATE KEY-----
</key>
`);

  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test('validateConfig blocks dangerous directives', () => {
  const ctx = makeCtx();
  const mgr = createVpnManager(ctx);

  const dangerous = [
    'up /tmp/evil.sh',
    'down /tmp/evil.sh',
    'route-up /tmp/evil.sh',
    'route-pre-down /tmp/evil.sh',
    'client-connect /tmp/evil.sh',
    'plugin /tmp/evil.so',
    'script-security 3'
  ];

  for (const directive of dangerous) {
    const result = mgr.validateConfig(`
client
remote vpn.example.com 1194
${directive}
<ca>test</ca>
`);
    assert.equal(result.valid, false, `Should block: ${directive}`);
    assert.ok(result.errors.some(e => e.includes('Blocked dangerous directive')),
      `Should have blocked directive error for: ${directive}`);
  }
});

test('validateConfig allows comments and blank lines', () => {
  const ctx = makeCtx();
  const mgr = createVpnManager(ctx);

  const result = mgr.validateConfig(`
# This is a comment
; Another comment

client
remote vpn.example.com 1194

<ca>test</ca>
<cert>test</cert>
<key>test</key>
`);

  assert.equal(result.valid, true);
});

test('validateConfig reports missing CA certificate', () => {
  const ctx = makeCtx();
  const mgr = createVpnManager(ctx);

  const result = mgr.validateConfig(`
client
remote vpn.example.com 1194
`);

  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('CA certificate')));
});

// ── WireGuard validation tests ──

test('validateConfig accepts valid WireGuard config', () => {
  const ctx = makeCtx();
  ctx.getCfg = () => ({
    vpn: { enabled: true, protocol: 'wireguard', profileName: 'test-wg' }
  });
  const mgr = createVpnManager(ctx);

  const result = mgr.validateConfig(`
[Interface]
PrivateKey = cFake0PrivateKeyBase64Data1234567890ABCDE=
Address = 10.0.0.2/24
DNS = 1.1.1.1

[Peer]
PublicKey = cFake0PublicKeyBase64Data12345678901234567=
Endpoint = vpn.example.com:51820
AllowedIPs = 0.0.0.0/0
`);

  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test('validateConfig rejects WireGuard config missing [Peer]', () => {
  const ctx = makeCtx();
  ctx.getCfg = () => ({
    vpn: { enabled: true, protocol: 'wireguard', profileName: 'test-wg' }
  });
  const mgr = createVpnManager(ctx);

  const result = mgr.validateConfig(`
[Interface]
PrivateKey = cFake0PrivateKeyBase64Data1234567890ABCDE=
Address = 10.0.0.2/24
`);

  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('[Peer]')));
});

test('validateConfig rejects WireGuard config missing PrivateKey', () => {
  const ctx = makeCtx();
  ctx.getCfg = () => ({
    vpn: { enabled: true, protocol: 'wireguard', profileName: 'test-wg' }
  });
  const mgr = createVpnManager(ctx);

  const result = mgr.validateConfig(`
[Interface]
Address = 10.0.0.2/24

[Peer]
PublicKey = cFake0PublicKeyBase64Data12345678901234567=
Endpoint = vpn.example.com:51820
`);

  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('PrivateKey')));
});

test('validateConfig rejects WireGuard config missing Endpoint', () => {
  const ctx = makeCtx();
  ctx.getCfg = () => ({
    vpn: { enabled: true, protocol: 'wireguard', profileName: 'test-wg' }
  });
  const mgr = createVpnManager(ctx);

  const result = mgr.validateConfig(`
[Interface]
PrivateKey = cFake0PrivateKeyBase64Data1234567890ABCDE=
Address = 10.0.0.2/24

[Peer]
PublicKey = cFake0PublicKeyBase64Data12345678901234567=
AllowedIPs = 0.0.0.0/0
`);

  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('Endpoint')));
});

test('validateConfig allows WireGuard comments and blanks', () => {
  const ctx = makeCtx();
  ctx.getCfg = () => ({
    vpn: { enabled: true, protocol: 'wireguard', profileName: 'test-wg' }
  });
  const mgr = createVpnManager(ctx);

  const result = mgr.validateConfig(`
# WireGuard config
[Interface]
PrivateKey = cFake0PrivateKeyBase64Data1234567890ABCDE=
Address = 10.0.0.2/24

# Peer section
[Peer]
PublicKey = cFake0PublicKeyBase64Data12345678901234567=
Endpoint = vpn.example.com:51820
AllowedIPs = 0.0.0.0/0
`);

  assert.equal(result.valid, true);
});

// ── IPSec validation tests ──

test('validateConfig accepts valid IPSec config', () => {
  const ctx = makeCtx();
  ctx.getCfg = () => ({
    vpn: { enabled: true, protocol: 'ipsec', profileName: 'test-ipsec' }
  });
  const mgr = createVpnManager(ctx);

  const result = mgr.validateConfig(`
config setup
  charondebug="ike 2, knl 2"

conn direktvermarkter
  left=%defaultroute
  right=vpn.example.com
  rightsubnet=10.0.0.0/24
  authby=secret
  auto=start
`);

  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.connections, ['direktvermarkter']);
});

test('validateConfig rejects IPSec config without conn section', () => {
  const ctx = makeCtx();
  ctx.getCfg = () => ({
    vpn: { enabled: true, protocol: 'ipsec', profileName: 'test-ipsec' }
  });
  const mgr = createVpnManager(ctx);

  const result = mgr.validateConfig(`
config setup
  charondebug="ike 2"
`);

  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('conn section')));
});

test('validateConfig rejects IPSec config missing right endpoint', () => {
  const ctx = makeCtx();
  ctx.getCfg = () => ({
    vpn: { enabled: true, protocol: 'ipsec', profileName: 'test-ipsec' }
  });
  const mgr = createVpnManager(ctx);

  const result = mgr.validateConfig(`
conn myconn
  left=%defaultroute
  authby=secret
`);

  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('right')));
});

test('validateConfig skips %default in IPSec config', () => {
  const ctx = makeCtx();
  ctx.getCfg = () => ({
    vpn: { enabled: true, protocol: 'ipsec', profileName: 'test-ipsec' }
  });
  const mgr = createVpnManager(ctx);

  const result = mgr.validateConfig(`
conn %default
  ikelifetime=60m
  keylife=20m

conn dv-tunnel
  right=10.0.0.1
  rightsubnet=10.0.0.0/24
`);

  assert.equal(result.valid, true);
  assert.deepEqual(result.connections, ['dv-tunnel']);
});

test('validateConfig accepts IPSec config with rightid', () => {
  const ctx = makeCtx();
  ctx.getCfg = () => ({
    vpn: { enabled: true, protocol: 'ipsec', profileName: 'test-ipsec' }
  });
  const mgr = createVpnManager(ctx);

  const result = mgr.validateConfig(`
conn cert-tunnel
  left=%defaultroute
  rightid=@vpn.example.com
  authby=rsasig
`);

  assert.equal(result.valid, true);
});

// ── import tests ──

test('importConfig rejects invalid config', async () => {
  const ctx = makeCtx();
  const mgr = createVpnManager(ctx);

  const result = await mgr.importConfig('invalid content');
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
});

test('startTunnel sets error when config file missing (openvpn)', async () => {
  const ctx = makeCtx();
  ctx.getCfg = () => ({
    vpn: {
      enabled: true,
      protocol: 'openvpn',
      autoConnect: true,
      profileName: 'nonexistent-profile',
      configPath: '/tmp/dvhub-test-nonexistent-vpn.ovpn',
      watchdog: { enabled: false }
    }
  });

  const mgr = createVpnManager(ctx);
  await mgr.start();

  assert.equal(ctx.state.vpn.status, 'error');
  assert.ok(ctx.state.vpn.lastError.includes('not found'));
  assert.ok(ctx.logs.some(l => l.event === 'vpn_start_error'));
});

test('startTunnel sets error when config file missing (wireguard)', async () => {
  const ctx = makeCtx();
  ctx.getCfg = () => ({
    vpn: {
      enabled: true,
      protocol: 'wireguard',
      autoConnect: true,
      profileName: 'nonexistent-wg',
      configPath: '/tmp/dvhub-test-nonexistent-wg.conf',
      watchdog: { enabled: false }
    }
  });

  const mgr = createVpnManager(ctx);
  await mgr.start();

  assert.equal(ctx.state.vpn.status, 'error');
  assert.ok(ctx.state.vpn.lastError.includes('not found'));
  assert.ok(ctx.logs.some(l => l.event === 'vpn_start_error'));
});

test('startTunnel sets error when config file missing (ipsec)', async () => {
  const ctx = makeCtx();
  ctx.getCfg = () => ({
    vpn: {
      enabled: true,
      protocol: 'ipsec',
      autoConnect: true,
      profileName: 'nonexistent-ipsec',
      configPath: '/tmp/dvhub-test-nonexistent-ipsec.conf',
      watchdog: { enabled: false }
    }
  });

  const mgr = createVpnManager(ctx);
  await mgr.start();

  assert.equal(ctx.state.vpn.status, 'error');
  assert.ok(ctx.state.vpn.lastError.includes('not found'));
  assert.ok(ctx.logs.some(l => l.event === 'vpn_start_error'));
});
