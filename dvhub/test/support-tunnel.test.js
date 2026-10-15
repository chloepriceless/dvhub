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
  const nowMs = 1_000_000;
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

// --- Portal-Freischaltung + eigener Dienst (2026-10-14) ----------------------

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateRelayPorts, normalizePublicKey, TUNNEL_UNIT } from '../services/support-tunnel.js';

const PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAsaBYifIY6dFAGzDtF28qVa75IHaMRzEx5buoGDhWBN';

function realBox({ ports = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-sup-'));
  fs.writeFileSync(path.join(dir, 'appliance-id'), 'box-01\n');
  const sup = path.join(dir, 'support');
  fs.mkdirSync(sup);
  fs.writeFileSync(path.join(sup, 'relay_id_ed25519'), 'PRIVATE\n', { mode: 0o600 });
  fs.writeFileSync(path.join(sup, 'relay_id_ed25519.pub'), `${PUB} dvhub-appliance-box-01\n`);
  fs.writeFileSync(path.join(sup, 'relay.json'), JSON.stringify({ host: 'support.dvhub.de', port: 47821, user: 'dvhub-support', shellPort: ports?.[0] ?? 0, webPort: ports?.[1] ?? 0 }));
  const logs = [];
  const ctx = { getDataDir: () => dir, getCfg: () => ({}), pushLog: (ev, d) => logs.push({ ev, d }) };
  return { dir, sup, ctx, logs };
}

test('validateRelayPorts: nur ganze, verschiedene Ports im Relay-Bereich', () => {
  assert.deepEqual(validateRelayPorts({ shellPort: 49120, webPort: '49121' }), { shellPort: 49120, webPort: 49121 });
  assert.equal(validateRelayPorts({ shellPort: 48999, webPort: 49001 }), null);
  assert.equal(validateRelayPorts({ shellPort: 49120, webPort: 50000 }), null);
  assert.equal(validateRelayPorts({ shellPort: 49120, webPort: 49120 }), null);
  assert.equal(validateRelayPorts({ shellPort: 49120.5, webPort: 49121 }), null);
  assert.equal(validateRelayPorts({ shellPort: '49120;x', webPort: 49121 }), null);
  assert.equal(validateRelayPorts(null), null);
});

test('normalizePublicKey: genau eine Zeile, erlaubter Typ, Kommentar fällt weg', () => {
  assert.equal(normalizePublicKey(`${PUB} kommentar\n`), PUB);
  assert.equal(normalizePublicKey(`${PUB}\n${PUB}`), null);
  assert.equal(normalizePublicKey('ssh-dss AAAA'), null);
  assert.equal(normalizePublicKey('ssh-ed25519 AAAA"x'), null);
  assert.equal(normalizePublicKey(''), null);
});

test('publicKey liefert Schlüssel und Fingerprint aus der .pub-Datei', () => {
  const { ctx } = realBox();
  const tun = createSupportTunnel(ctx, { unitMode: () => false });
  const k = tun.publicKey();
  assert.equal(k.pubkey, PUB);
  assert.equal(k.fingerprint, sshKeyFingerprint(PUB));
});

test('assignRelayPorts schreibt nur die Ports, Host/Port/Benutzer bleiben; danach provisioned', () => {
  const { sup, ctx, logs } = realBox();
  const tun = createSupportTunnel(ctx, { unitMode: () => false });
  assert.equal(tun.status().provisioned, false);
  assert.deepEqual(tun.assignRelayPorts({ shellPort: 49120, webPort: 49121 }), { ok: true, changed: true });
  const rj = JSON.parse(fs.readFileSync(path.join(sup, 'relay.json'), 'utf8'));
  assert.deepEqual(rj, { host: 'support.dvhub.de', port: 47821, user: 'dvhub-support', shellPort: 49120, webPort: 49121 });
  assert.equal(tun.status().provisioned, true);
  assert.deepEqual(tun.assignRelayPorts({ shellPort: 49120, webPort: 49121 }), { ok: true, changed: false });
  assert.equal(tun.assignRelayPorts({ shellPort: 1, webPort: 2 }).error, 'invalid_ports');
  assert.equal(logs.filter((l) => l.ev === 'support_tunnel_ports_assigned').length, 1);
  assert.deepEqual(fs.readdirSync(sup).filter((f) => f.includes('.tmp')), []);
});

test('Dienst-Modus: Öffnen schreibt den Auftrag und startet die Unit, Schließen stoppt sie', async () => {
  const { sup, ctx, logs } = realBox({ ports: [49120, 49121] });
  const calls = [];
  const nowMs = 1_800_000_000_000;
  const tun = createSupportTunnel(ctx, {
    unitMode: () => true,
    now: () => nowMs,
    sleep: async () => {},
    isAlive: (pid) => pid === 4242,
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
    execFile: (bin, args, opts, cb) => {
      calls.push([bin, ...args]);
      // Wie das Tunnel-Skript: Zustand schreiben bzw. beim Stoppen löschen.
      if (args[2] === 'start') fs.writeFileSync(path.join(sup, 'tunnel-state.json'), JSON.stringify({ pid: 4242, startedAt: nowMs, expiresAt: nowMs + 30 * 60_000 }));
      if (args[2] === 'stop') fs.rmSync(path.join(sup, 'tunnel-state.json'), { force: true });
      cb(null, '', '');
    },
  });
  const r = await tun.open({ ttlMin: 30 }, { ip: '127.0.0.1', via: 'installer_portal' });
  assert.equal(r.ok, true);
  assert.deepEqual(calls[0], ['sudo', '-n', 'systemctl', 'start', TUNNEL_UNIT]);
  const req = JSON.parse(fs.readFileSync(path.join(sup, 'tunnel.json'), 'utf8'));
  assert.equal(req.expiresAt, nowMs + 30 * 60_000);
  assert.equal(fs.statSync(path.join(sup, 'tunnel.json')).mode & 0o777, 0o600);
  const st = tun.status();
  assert.equal(st.open, true);
  assert.equal(st.mode, 'service');
  assert.equal(st.ttlRemainingSec, 1800);
  assert.equal(tun.liteStatus().open, true);
  // Ein neuer DVhub-Prozess (Neustart) sieht den laufenden Tunnel ebenfalls.
  const after = createSupportTunnel(ctx, { unitMode: () => true, now: () => nowMs + 60_000, isAlive: (pid) => pid === 4242 });
  assert.equal(after.status().open, true);
  assert.equal((await tun.open({ ttlMin: 30 })).alreadyOpen, true);
  const c = await tun.close({ ip: '127.0.0.1' });
  assert.equal(c.ok, true);
  assert.deepEqual(calls.at(-1), ['sudo', '-n', 'systemctl', 'stop', TUNNEL_UNIT]);
  assert.equal(fs.existsSync(path.join(sup, 'tunnel.json')), false);
  assert.equal(tun.status().open, false);
  assert.ok(logs.some((l) => l.ev === 'support_tunnel_opened') && logs.some((l) => l.ev === 'support_tunnel_closed'));
});

test('Dienst-Modus: lehnt das Relay ab, meldet open den Fehler aus dem Protokoll', async () => {
  const { sup, ctx } = realBox({ ports: [49120, 49121] });
  const tun = createSupportTunnel(ctx, {
    unitMode: () => true,
    sleep: async () => {},
    isAlive: () => false,
    execFile: (bin, args, opts, cb) => {
      fs.writeFileSync(path.join(sup, 'tunnel.log'), 'Error: remote port forwarding failed for listen port 49120\n');
      cb(null, '', '');
    },
  });
  const r = await tun.open({ ttlMin: 30 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'tunnel_failed');
  assert.match(r.detail, /remote port forwarding failed/);
  assert.match(tun.status().lastError, /remote port forwarding failed/);
});

// 2026-10-15 (Support-Fall): Nach dem Schließen meldete status().lastError die
// Info-Zeile des Tunnel-Skripts („Tunnel: Relay …, Ports …, 3600 s“) als Fehler
// ans Portal. Nur echte Fehlerzeilen zählen.
test('Dienst-Modus: Info-Zeilen des Tunnel-Skripts sind kein lastError', () => {
  const { sup, ctx } = realBox({ ports: [49000, 49001] });
  const tun = createSupportTunnel(ctx, { unitMode: () => true, isAlive: () => false });
  fs.writeFileSync(path.join(sup, 'tunnel.log'), 'Tunnel: Relay dvhub-support@support.dvhub.de:47821, Ports 49000/49001, 3600 s\n');
  assert.equal(tun.status().lastError, null);
  fs.writeFileSync(path.join(sup, 'tunnel.log'), 'Tunnel: Relay dvhub-support@support.dvhub.de:47821, Ports 49000/49001, 3600 s\nTunnel nach Ablauf geschlossen.\n');
  assert.equal(tun.status().lastError, null);
});

test('Dienst-Modus: neben Info-Zeilen bleibt nur die Fehlerzeile', () => {
  const { sup, ctx } = realBox({ ports: [49000, 49001] });
  const tun = createSupportTunnel(ctx, { unitMode: () => true, isAlive: () => false });
  fs.writeFileSync(path.join(sup, 'tunnel.log'), 'Tunnel: Relay dvhub-support@support.dvhub.de:47821, Ports 49000/49001, 3600 s\nError: remote port forwarding failed for listen port 49000\n');
  assert.equal(tun.status().lastError, 'Error: remote port forwarding failed for listen port 49000');
});

test('Dienst-Modus: Zustandsdatei eines toten oder abgelaufenen Tunnels zählt nicht', () => {
  const { sup, ctx } = realBox({ ports: [49120, 49121] });
  const nowMs = 1_800_000_000_000;
  fs.writeFileSync(path.join(sup, 'tunnel-state.json'), JSON.stringify({ pid: 4242, startedAt: nowMs - 10, expiresAt: nowMs - 1 }));
  assert.equal(createSupportTunnel(ctx, { unitMode: () => true, now: () => nowMs, isAlive: () => true }).status().open, false);
  fs.writeFileSync(path.join(sup, 'tunnel-state.json'), JSON.stringify({ pid: 4242, startedAt: nowMs, expiresAt: nowMs + 60_000 }));
  assert.equal(createSupportTunnel(ctx, { unitMode: () => true, now: () => nowMs, isAlive: () => false }).status().open, false);
  assert.equal(createSupportTunnel(ctx, { unitMode: () => true, now: () => nowMs, isAlive: () => true }).status().open, true);
});

test('Dienst-Modus: der Auftrag trägt die wirksamen Relay-Werte (Konfiguration vor relay.json)', async () => {
  const { sup, ctx } = realBox({ ports: [49120, 49121] });
  ctx.getCfg = () => ({ support: { relay: { host: 'relay.test', port: 2222, shellPort: 49130, webPort: 49131 } } });
  const tun = createSupportTunnel(ctx, {
    unitMode: () => true, sleep: async () => {}, isAlive: () => true,
    setTimeout: () => ({ unref() {} }), clearTimeout: () => {},
    execFile: (bin, args, opts, cb) => {
      fs.writeFileSync(path.join(sup, 'tunnel-state.json'), JSON.stringify({ pid: 4242, startedAt: Date.now(), expiresAt: Date.now() + 60_000 }));
      cb(null, '', '');
    },
  });
  assert.equal((await tun.open({ ttlMin: 5 })).ok, true);
  const req = JSON.parse(fs.readFileSync(path.join(sup, 'tunnel.json'), 'utf8'));
  assert.deepEqual([req.host, req.port, req.user, req.shellPort, req.webPort], ['relay.test', 2222, 'dvhub-support', 49130, 49131]);
});

test('tunnelBinaryAvailable: ohne ssh/autossh (Docker-Image) kein Tunnel möglich', async () => {
  const { tunnelBinaryAvailable } = await import('../services/support-tunnel.js');
  assert.equal(tunnelBinaryAvailable({ existsSync: () => false }), false);
  assert.equal(tunnelBinaryAvailable({ existsSync: (p) => p === '/usr/bin/ssh' }), true);
  const { ctx } = realBox();
  assert.equal(createSupportTunnel(ctx, { unitMode: () => false, fs: { ...fs, existsSync: (p) => (p.includes('ssh') && !p.includes('/support/') ? false : fs.existsSync(p)) } }).status().capable, false);
});

// --- Fern-Support im Docker-Container (2026-10-14) ---------------------------

test('buildTunnelArgs: Ziele auf der Box einstellbar (Container-sshd, httpPort), sonst 22/80', () => {
  const base = { host: 'support.dvhub.de', port: 47821, user: 'dvhub-support', shellPort: 49101, webPort: 49102, keyPath: '/k' };
  const dflt = buildTunnelArgs(base);
  assert.ok(dflt.includes('127.0.0.1:49101:127.0.0.1:22'));
  assert.ok(dflt.includes('127.0.0.1:49102:127.0.0.1:80'));
  const ct = buildTunnelArgs({ ...base, localShellPort: 2222, localWebPort: 8080 });
  assert.ok(ct.includes('127.0.0.1:49101:127.0.0.1:2222'));
  assert.ok(ct.includes('127.0.0.1:49102:127.0.0.1:8080'));
});

function containerBox() {
  const box = realBox({ ports: [49101, 49102] });
  fs.writeFileSync(path.join(box.sup, 'sshd_config'), 'ListenAddress 127.0.0.1:2222\n');
  fs.writeFileSync(path.join(box.sup, 'support_authorized_keys'), `${PUB} dvhub-support\n`);
  box.ctx.getCfg = () => ({ httpPort: 8080 });
  return box;
}
const realExists = fs.existsSync;
const withBinaries = { ...fs, existsSync: (p) => (p === '/usr/sbin/sshd' || p === '/usr/bin/autossh' ? true : realExists(p)) };

test('Container: Öffnen startet sshd und Tunnel (Shell → 2222, Web → httpPort), Schließen beendet beide', () => {
  const { ctx } = containerBox();
  const spawned = [];
  const tun = createSupportTunnel(ctx, {
    inContainer: true, unitMode: () => false, fs: withBinaries,
    spawn: (bin, args) => { const pr = fakeProc(); spawned.push({ bin, args, pr }); return pr; },
    setTimeout: () => ({ unref() {} }), clearTimeout: () => {},
  });
  const st0 = tun.status();
  assert.equal(st0.loginUser, 'dvhub');
  assert.equal(st0.shellAvailable, true);
  const r = tun.open({ ttlMin: 30 });
  assert.equal(r.ok, true);
  assert.equal(spawned[0].bin, '/usr/sbin/sshd');
  assert.deepEqual(spawned[0].args.slice(0, 3), ['-D', '-e', '-f']);
  assert.equal(spawned[1].bin, '/usr/bin/autossh');
  assert.ok(spawned[1].args.includes('127.0.0.1:49101:127.0.0.1:2222'));
  assert.ok(spawned[1].args.includes('127.0.0.1:49102:127.0.0.1:8080'));
  tun.close();
  assert.equal(spawned[0].pr.killed, true, 'sshd beendet');
  assert.equal(spawned[1].pr.killed, true, 'Tunnel beendet');
});

test('Container: ohne Support-Schlüssel (Kunde hat Login abgeschaltet) kein sshd, nur Web', () => {
  const { ctx, sup } = containerBox();
  fs.rmSync(path.join(sup, 'support_authorized_keys'));
  const spawned = [];
  const tun = createSupportTunnel(ctx, {
    inContainer: true, unitMode: () => false, fs: withBinaries,
    spawn: (bin) => { spawned.push(bin); return fakeProc(); },
    setTimeout: () => ({ unref() {} }), clearTimeout: () => {},
  });
  assert.equal(tun.status().shellAvailable, false);
  assert.equal(tun.open({ ttlMin: 30 }).ok, true);
  assert.deepEqual(spawned, ['/usr/bin/autossh']);
});

test('Container: bricht der Tunnel unerwartet ab, endet auch der sshd', () => {
  const { ctx } = containerBox();
  const spawned = [];
  const tun = createSupportTunnel(ctx, {
    inContainer: true, unitMode: () => false, fs: withBinaries,
    spawn: () => { const pr = fakeProc(); spawned.push(pr); return pr; },
    setTimeout: () => ({ unref() {} }), clearTimeout: () => {},
  });
  tun.open({ ttlMin: 30 });
  spawned[1].emit('exit', 255, null);
  assert.equal(spawned[0].killed, true);
  assert.equal(tun.status().open, false);
});

test('Nativ: Web-Ziel ist der httpPort der Config, Login-Benutzer dvhub-support', async () => {
  const { sup, ctx } = realBox({ ports: [49120, 49121] });
  ctx.getCfg = () => ({ httpPort: 8081 });
  const tun = createSupportTunnel(ctx, {
    inContainer: false, unitMode: () => true, sleep: async () => {}, isAlive: () => true,
    setTimeout: () => ({ unref() {} }), clearTimeout: () => {},
    execFile: (bin, args, opts, cb) => {
      fs.writeFileSync(path.join(sup, 'tunnel-state.json'), JSON.stringify({ pid: 4242, startedAt: Date.now(), expiresAt: Date.now() + 60_000 }));
      cb(null, '', '');
    },
  });
  assert.equal(tun.status().loginUser, 'dvhub-support');
  await tun.open({ ttlMin: 5 });
  const req = JSON.parse(fs.readFileSync(path.join(sup, 'tunnel.json'), 'utf8'));
  assert.equal(req.localShellPort, 22);
  assert.equal(req.localWebPort, 8081);
});
