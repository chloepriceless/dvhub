// test/privileged-helpers-callers.test.js -- die JS-Aufrufer gehen für apt,
// fuser, setcap, OpenVPN und WireGuard nur noch über die root-eigenen
// Hilfsskripte (Gegenprüfung 25.10.2026, P2). Aufgezeichnete Prozessaufrufe
// statt sudo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAdminRoutes } from '../routes/admin-routes.js';
import { createVpnManager, VPN_HELPER, OPENVPN_PID_FILE } from '../vpn-manager.js';
import { APT_HELPER, SETCAP_HELPER } from '../routes/admin-routes.js';

test('Pfade der Hilfsskripte und der PID-Datei (root-eigen, nicht /tmp)', () => {
  assert.equal(APT_HELPER, '/usr/local/libexec/dvhub-apt');
  assert.equal(SETCAP_HELPER, '/usr/local/libexec/dvhub-setcap');
  assert.equal(VPN_HELPER, '/usr/local/libexec/dvhub-vpn');
  assert.equal(OPENVPN_PID_FILE, '/run/dvhub-vpn/openvpn.pid');
});

function adminHarness({ ambient = '' } = {}) {
  const calls = [];
  const responses = [];
  const execFileAsync = async (cmd, args = []) => {
    calls.push([cmd, ...args].join(' '));
    const a = args.join(' ');
    if (a.endsWith('list-upgradable')) {
      return { stdout: 'Listing...\nopenssl/stable-security 3.0.17 arm64 [upgradable from: 3.0.16]\n', stderr: '' };
    }
    if (a.endsWith('lock-held')) { const e = new Error('keine Sperre'); e.code = 1; throw e; }
    if (/upgrade-(all|security)$/.test(a)) return { stdout: 'Setting up openssl (3.0.17) ...\n', stderr: '' };
    if (cmd === 'systemctl') return { stdout: `${ambient}\n`, stderr: '' };
    return { stdout: '', stderr: '' };
  };
  const handle = createAdminRoutes({
    ctx: { getServiceActionsEnabled: () => true },
    getCfg: () => ({}), pushLog: () => {},
    json: (res, code, payload) => { responses.push({ code, payload }); },
    checkAuth: () => true, execFileAsync,
  });
  const call = async (method, pathname, body) => {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    req.method = method; req.headers = {};
    await handle(req, {}, new URL(`http://x${pathname}`));
    return responses.at(-1);
  };
  return { calls, call };
}

const sudoCalls = (calls) => calls.filter((c) => c.startsWith('sudo '));

test('Paket-Prüfung: refresh + list-upgradable über dvhub-apt', async () => {
  const h = adminHarness();
  const r = await h.call('GET', '/api/admin/system/updates/check');
  assert.equal(r.code, 200);
  assert.equal(r.payload.totalCount, 1);
  assert.equal(r.payload.securityCount, 1);
  assert.deepEqual(sudoCalls(h.calls), [`sudo -n ${APT_HELPER} refresh`, `sudo -n ${APT_HELPER} list-upgradable`]);
});

test('Sicherheits-Updates: Sperre prüfen, upgrade-security, setcap nur ohne Ambient-Recht', async () => {
  const h = adminHarness();
  const r = await h.call('POST', '/api/admin/system/updates/apply', { securityOnly: true });
  assert.equal(r.code, 200);
  assert.equal(r.payload.upgraded, 1);
  assert.deepEqual(sudoCalls(h.calls), [`sudo -n ${APT_HELPER} lock-held`, `sudo -n ${APT_HELPER} upgrade-security`, `sudo -n ${SETCAP_HELPER} node`]);
});

test('Alle Updates mit Ambient-Recht in der Unit: upgrade-all, kein setcap', async () => {
  const h = adminHarness({ ambient: 'cap_net_bind_service' });
  const r = await h.call('POST', '/api/admin/system/updates/apply', {});
  assert.equal(r.code, 200);
  assert.deepEqual(sudoCalls(h.calls), [`sudo -n ${APT_HELPER} lock-held`, `sudo -n ${APT_HELPER} upgrade-all`]);
});

// ── VPN ──
function vpnHarness({ protocol, file, profile = 'dv', cfgPathOverride, watchdog = false } = {}) {
  const profilesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-vpn-callers-'));
  const fname = file || (protocol === 'wireguard' ? 'wg0.conf' : 'client.ovpn');
  fs.mkdirSync(path.join(profilesDir, profile), { recursive: true });
  const cfgPath = cfgPathOverride || path.join(profilesDir, profile, fname);
  fs.writeFileSync(path.join(profilesDir, profile, fname), protocol === 'wireguard'
    ? '[Interface]\nPrivateKey = a\nAddress = 10.0.0.2/32\n[Peer]\nPublicKey = b\nEndpoint = h:1\n'
    : 'client\nremote h 1194\n<ca>\nx\n</ca>\n');
  const calls = [];
  const spawned = [];
  const spawn = (cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = (sig) => { spawned.at(-1).killed.push(sig); setImmediate(() => child.emit('exit', 0, sig)); };
    spawned.push({ argv: [cmd, ...args], killed: [] });
    setImmediate(() => child.stdout.emit('data', Buffer.from('Initialization Sequence Completed\n')));
    return child;
  };
  const state = {};
  const mgr = createVpnManager({
    state, pushLog: () => {}, spawn, profilesDir,
    execFileAsync: async (cmd, args) => { calls.push([cmd, ...args]); return { stdout: '', stderr: '' }; },
    interfaceExists: () => true,
    getCfg: () => ({ vpn: { enabled: true, protocol, profileName: profile, configPath: cfgPath, watchdog: { enabled: watchdog, intervalMs: 5 } } }),
  });
  const sudo = () => calls.filter((c) => c[0] === 'sudo').map((c) => c.slice(1).join(' '));
  return { mgr, state, calls, spawned, sudo, cleanup: () => fs.rmSync(profilesDir, { recursive: true, force: true }) };
}

test('OpenVPN: Start über sudo -n dvhub-vpn openvpn up <profil>, Stopp über openvpn down', async () => {
  const h = vpnHarness({ protocol: 'openvpn' });
  try {
    await h.mgr.start();
    assert.deepEqual(h.spawned.map((s) => s.argv), [['sudo', '-n', VPN_HELPER, 'openvpn', 'up', 'dv']]);
    assert.equal(h.state.vpn.status, 'connected');
    await h.mgr.stop();
    assert.ok(h.sudo().includes(`-n ${VPN_HELPER} openvpn down`), h.sudo().join('\n'));
    assert.deepEqual(h.sudo().filter((c) => /openvpn --config|pkill|wg-quick/.test(c)), []);
  } finally { await h.mgr.close(); h.cleanup(); }
});

test('OpenVPN: eigener Dateiname im Profil wird als zweites Argument übergeben', async () => {
  const h = vpnHarness({ protocol: 'openvpn', file: 'anbieter.ovpn' });
  try {
    await h.mgr.start();
    assert.deepEqual(h.spawned[0].argv, ['sudo', '-n', VPN_HELPER, 'openvpn', 'up', 'dv', 'anbieter.ovpn']);
  } finally { await h.mgr.close(); h.cleanup(); }
});

test('OpenVPN: Profil außerhalb des Profilordners → Fehler, kein sudo', async () => {
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-vpn-out-')), 'client.ovpn');
  fs.writeFileSync(outside, 'client\nremote h 1194\n');
  const h = vpnHarness({ protocol: 'openvpn', cfgPathOverride: outside });
  try {
    await h.mgr.start();
    assert.equal(h.state.vpn.status, 'error');
    assert.match(h.state.vpn.lastError, /Profilordner|profiles/);
    assert.deepEqual(h.spawned, []);
    assert.deepEqual(h.sudo(), []);
  } finally { await h.mgr.close(); h.cleanup(); fs.rmSync(path.dirname(outside), { recursive: true, force: true }); }
});

test('WireGuard: up/status/down über dvhub-vpn wireguard …', async () => {
  const h = vpnHarness({ protocol: 'wireguard', watchdog: true });
  try {
    await h.mgr.start();
    assert.equal(h.state.vpn.status, 'connected');
    await new Promise((r) => setTimeout(r, 40));
    await h.mgr.stop();
    const s = h.sudo();
    assert.equal(s[0], `-n ${VPN_HELPER} wireguard up dv`);
    assert.ok(s.includes(`-n ${VPN_HELPER} wireguard status`), s.join('\n'));
    assert.ok(s.includes(`-n ${VPN_HELPER} wireguard down dv`), s.join('\n'));
    assert.deepEqual(s.filter((c) => /wg-quick|wg show/.test(c)), []);
  } finally { await h.mgr.close(); h.cleanup(); }
});
