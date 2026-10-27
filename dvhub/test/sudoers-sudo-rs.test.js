// test/sudoers-sudo-rs.test.js — sudoers-Regeln müssen auch unter sudo-rs gelten
// und das IPsec-Hilfsskript prüft Profilnamen selbst (2026-10-18, Feldfall
// BIGGE: Ubuntu 26.04, sudo-rs 0.2.13, IPsec-Regeln übersprungen).
//
// sudo-rs (src/sudoers/tokens.rs, Command::construct): nach Abzug eines
// alleinstehenden `*` am Ende darf kein Argument `*` oder `?` enthalten —
// sonst „wildcards are not allowed in command arguments“ und die Regel fehlt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, readlinkSync, existsSync, symlinkSync, lstatSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createVpnManager, IPSEC_LINK_HELPER } from '../vpn-manager.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function sudoersRules(relPath) {
  const lines = readFileSync(path.join(repoRoot, relPath), 'utf8').split('\n');
  const a = lines.findIndex((l) => l.includes('BEGIN DVHUB SUDOERS'));
  const b = lines.findIndex((l) => l.includes('END DVHUB SUDOERS'));
  return lines.slice(a, b + 1).filter((l) => l.includes('NOPASSWD:'));
}

// Gibt die Argumente zurück, an denen sudo-rs die Regel ablehnen würde.
function sudoRsRejectedArgs(rule) {
  const words = rule.split('NOPASSWD:')[1].trim().split(/\s+/);
  const args = words.slice(1);
  if (args.at(-1) === '*') args.pop();
  return args.filter((arg) => /[*?]/.test(arg));
}

test('sudo-rs-Prüfregel: alleinstehendes * am Ende ok, * oder ? im Argument nicht', () => {
  assert.deepEqual(sudoRsRejectedArgs('u ALL=(root) NOPASSWD: /usr/bin/apt-get update *'), []);
  assert.deepEqual(sudoRsRejectedArgs('u ALL=(root) NOPASSWD: /usr/bin/systemctl reload'), []);
  assert.deepEqual(
    sudoRsRejectedArgs('u ALL=(root) NOPASSWD: /usr/bin/rm -f /etc/ipsec.d/dvhub-[A-Za-z0-9_-]*.conf'),
    ['/etc/ipsec.d/dvhub-[A-Za-z0-9_-]*.conf'],
  );
  assert.deepEqual(sudoRsRejectedArgs('u ALL=(root) NOPASSWD: /usr/bin/ln -sf a* *'), ['a*']);
});

for (const file of ['install.sh', 'post-update.sh']) {
  test(`${file}: keine sudoers-Regel mit Platzhalter mitten im Argument`, () => {
    const rules = sudoersRules(file);
    assert.ok(rules.length > 30, 'sudoers-Block gefunden');
    const bad = rules.filter((r) => sudoRsRejectedArgs(r).length);
    assert.deepEqual(bad, []);
  });
}

test('IPsec-Regeln zeigen nur auf das Hilfsskript (link/unlink), nicht auf ln/rm', () => {
  const rules = sudoersRules('install.sh');
  assert.ok(rules.includes('${SERVICE_USER} ALL=(root) NOPASSWD: ${IPSEC_LINK_PATH} link *'));
  assert.ok(rules.includes('${SERVICE_USER} ALL=(root) NOPASSWD: ${IPSEC_LINK_PATH} unlink *'));
  assert.equal(rules.some((r) => /NOPASSWD: \$\{(LN|RM)_PATH\}/.test(r)), false);
  const install = readFileSync(path.join(repoRoot, 'install.sh'), 'utf8');
  // Installiert über den gemeinsamen HELPERS-Block (Gegenprüfung 25.10.2026).
  assert.ok(install.includes('DVHUB_LIBEXEC="${DVHUB_LIBEXEC:-/usr/local/libexec}"'));
  assert.equal(IPSEC_LINK_HELPER, '/usr/local/libexec/dvhub-ipsec-link');
  assert.ok(install.includes('IPSEC_LINK_PATH="$DVHUB_LIBEXEC/dvhub-ipsec-link"'));
  assert.ok(install.includes('dvhub_install_helper dvhub-ipsec-link.sh "$IPSEC_LINK_PATH"'));
});

// ── Hilfsskript: echte Datei, nur die beiden Pfade auf ein Testverzeichnis umgebogen ──

function rig() {
  const root = mkdtempSync(path.join(tmpdir(), 'dvhub-ipsec-link-'));
  const profiles = path.join(root, 'profiles');
  const ipsecD = path.join(root, 'ipsec.d');
  mkdirSync(profiles);
  mkdirSync(ipsecD);
  const src = readFileSync(path.join(repoRoot, 'dvhub-ipsec-link.sh'), 'utf8');
  const patched = src
    .replace('PROFILES_DIR=/etc/dvhub/vpn/profiles', `PROFILES_DIR=${profiles}`)
    .replace('IPSEC_D=/etc/ipsec.d', `IPSEC_D=${ipsecD}`);
  assert.notEqual(patched, src);
  const script = path.join(root, 'ipsec-link.sh');
  writeFileSync(script, patched);
  const profile = (name, files) => {
    mkdirSync(path.join(profiles, name));
    for (const [f, body] of Object.entries(files)) writeFileSync(path.join(profiles, name, f), body);
  };
  const run = (...args) => spawnSync('bash', [script, ...args], { encoding: 'utf8' });
  return { profiles, ipsecD, profile, run };
}

const CONF = 'conn dv\n  right=vpn.example.com\n  authby=secret\n';

test('Hilfsskript link: conf + secrets werden nach ipsec.d verlinkt, unlink entfernt beide', () => {
  const r = rig();
  r.profile('luox', { 'ipsec.conf': CONF, 'ipsec.secrets': ': PSK "x"\n' });
  assert.equal(r.run('link', 'luox').status, 0);
  assert.equal(readlinkSync(path.join(r.ipsecD, 'dvhub-luox.conf')), path.join(r.profiles, 'luox', 'ipsec.conf'));
  assert.equal(readlinkSync(path.join(r.ipsecD, 'dvhub-luox.secrets')), path.join(r.profiles, 'luox', 'ipsec.secrets'));
  assert.equal(r.run('unlink', 'luox').status, 0);
  assert.equal(existsSync(path.join(r.ipsecD, 'dvhub-luox.conf')), false);
  assert.equal(existsSync(path.join(r.ipsecD, 'dvhub-luox.secrets')), false);
});

test('Hilfsskript link ohne secrets: alter secrets-Verweis verschwindet', () => {
  const r = rig();
  r.profile('p1', { 'ipsec.conf': CONF });
  symlinkSync('/nirgends', path.join(r.ipsecD, 'dvhub-p1.secrets'));
  assert.equal(r.run('link', 'p1').status, 0);
  assert.ok(lstatSync(path.join(r.ipsecD, 'dvhub-p1.conf')).isSymbolicLink());
  assert.equal(existsSync(path.join(r.ipsecD, 'dvhub-p1.secrets')), false);
});

test('Hilfsskript lehnt Pfad-Tricks, fremde Verweise und Root-Skripte ab', () => {
  const r = rig();
  for (const name of ['../x', 'a/b', 'a*', '', 'x'.repeat(65)]) {
    const res = r.run('link', name);
    assert.equal(res.status, 2, `Name ${JSON.stringify(name)}`);
    assert.equal(res.stderr, 'dvhub-ipsec-link: ungültiger Profilname\n');
  }
  assert.equal(r.run('copy', 'p').status, 2);
  assert.equal(r.run('link').status, 2);
  // Profilordner als Verweis auf einen anderen Ordner
  r.profile('echt', { 'ipsec.conf': CONF });
  symlinkSync(path.join(r.profiles, 'echt'), path.join(r.profiles, 'umweg'));
  assert.equal(r.run('link', 'umweg').status, 1);
  // ipsec.conf als Verweis
  mkdirSync(path.join(r.profiles, 'lnk'));
  symlinkSync(path.join(r.profiles, 'echt', 'ipsec.conf'), path.join(r.profiles, 'lnk', 'ipsec.conf'));
  assert.equal(r.run('link', 'lnk').status, 1);
  // leftupdown führt strongSwan als root aus
  r.profile('updown', { 'ipsec.conf': `${CONF}  leftupdown=/tmp/x.sh\n` });
  const res = r.run('link', 'updown');
  assert.equal(res.status, 1);
  assert.match(res.stderr, /leftupdown/);
  assert.deepEqual(execFileSync('ls', [r.ipsecD], { encoding: 'utf8' }).trim(), '');
});

// ── vpn-manager ruft das Hilfsskript statt ln/rm ──

function vpnRig(profileName, configProfile) {
  const profilesDir = mkdtempSync(path.join(tmpdir(), 'dvhub-ipsec-vpn-'));
  mkdirSync(path.join(profilesDir, configProfile));
  const cfgPath = path.join(profilesDir, configProfile, 'ipsec.conf');
  writeFileSync(cfgPath, CONF);
  const calls = [];
  const execFileAsync = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === 'ipsec' && args[1] === 'status') return { stdout: 'dv{1}: INSTALLED, TUNNEL', stderr: '' };
    return { stdout: '', stderr: '' };
  };
  const state = {};
  const mgr = createVpnManager({
    state, profilesDir, execFileAsync, pushLog: () => {},
    getCfg: () => ({ vpn: { enabled: true, protocol: 'ipsec', profileName, configPath: cfgPath } }),
  });
  return { mgr, state, calls, profilesDir };
}

// Codex 2026-10-18: vpn.configPath darf auf ein anderes Profil zeigen — das
// verlinkte früher die Regel `ln -sf …/profiles/*/ipsec.conf` auch.
test('vpn-manager: configPath auf ein anderes Profil → link <profil> <quelle>', async () => {
  const { mgr, state, calls } = vpnRig('luox', 'alt-profil');
  await mgr.start();
  assert.equal(state.vpn.status, 'connected');
  assert.deepEqual(calls.find((c) => c.includes('link')), ['sudo', '-n', IPSEC_LINK_HELPER, 'link', 'luox', 'alt-profil']);
  await mgr.close();
});

test('vpn-manager: configPath außerhalb der Profile → Fehler, kein sudo-Aufruf', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dvhub-ipsec-out-'));
  writeFileSync(path.join(dir, 'ipsec.conf'), CONF);
  const calls = [];
  const state = {};
  const mgr = createVpnManager({
    state, profilesDir: mkdtempSync(path.join(tmpdir(), 'dvhub-ipsec-p-')), pushLog: () => {},
    execFileAsync: async (cmd, args) => { calls.push([cmd, ...args]); return { stdout: '', stderr: '' }; },
    getCfg: () => ({ vpn: { enabled: true, protocol: 'ipsec', profileName: 'luox', configPath: path.join(dir, 'ipsec.conf') } }),
  });
  await mgr.start();
  assert.equal(state.vpn.status, 'error');
  assert.match(state.vpn.lastError, /muss unter .* liegen/);
  assert.equal(calls.some((c) => c.includes('link')), false);
  await mgr.close();
});

test('Hilfsskript link mit Quellprofil: Verweis heißt nach dem Profil, Ziel ist die Quelle', () => {
  const r = rig();
  r.profile('alt', { 'ipsec.conf': CONF });
  assert.equal(r.run('link', 'luox', 'alt').status, 0);
  assert.equal(readlinkSync(path.join(r.ipsecD, 'dvhub-luox.conf')), path.join(r.profiles, 'alt', 'ipsec.conf'));
  assert.equal(r.run('link', 'luox', '../alt').status, 2);
  assert.equal(r.run('unlink', 'luox', 'alt').status, 2, 'unlink nimmt keine Quelle');
});

test('vpn-manager: IPsec-Start/-Stopp gehen über sudo -n <Hilfsskript> link/unlink', async () => {
  const { profilesDir } = vpnRig('x', 'x');
  const dir = path.join(profilesDir, 'luox');
  mkdirSync(dir);
  const cfgPath = path.join(dir, 'ipsec.conf');
  writeFileSync(cfgPath, CONF);
  const calls = [];
  const execFileAsync = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === 'ipsec' && args[1] === 'status') return { stdout: 'dv{1}: INSTALLED, TUNNEL', stderr: '' };
    return { stdout: '', stderr: '' };
  };
  const state = {};
  const mgr = createVpnManager({
    state,
    getCfg: () => ({ vpn: { enabled: true, protocol: 'ipsec', profileName: 'luox', configPath: cfgPath } }),
    pushLog: () => {},
    execFileAsync,
    profilesDir,
  });
  await mgr.start();
  assert.equal(state.vpn.status, 'connected');
  const sudo = calls.filter((c) => c[0] === 'sudo').map((c) => c.slice(1).join(' '));
  assert.deepEqual(sudo.slice(0, 3), [`-n ${IPSEC_LINK_HELPER} link luox`, 'ipsec reload', 'ipsec up dv']);
  calls.length = 0;
  await mgr.close();
  const stopSudo = calls.filter((c) => c[0] === 'sudo').map((c) => c.slice(1).join(' '));
  assert.deepEqual(stopSudo, ['ipsec down dv', `-n ${IPSEC_LINK_HELPER} unlink luox`, 'ipsec reload']);
  assert.equal(calls.some((c) => c.includes('ln') || c.includes('rm')), false);
});
