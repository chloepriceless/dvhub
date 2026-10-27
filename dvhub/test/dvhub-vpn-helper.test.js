// test/dvhub-vpn-helper.test.js -- root-eigener VPN-Einstieg dvhub-vpn.sh.
// Gegenprüfung 25.10.2026 (P2): `openvpn --config *` und `wg-quick up|down *`
// in den sudoers ließen den Dienstbenutzer beliebige Argumente als root
// übergeben (--script-security 2 --up …, PreUp eines beliebigen Pfads). Jetzt
// nimmt das Hilfsskript nur einen Profilnamen, liest das Profil als
// Dienstbenutzer in einen root-eigenen Ordner, prüft die Kopie und startet nur
// sie. openvpn, wg-quick, wg, pkill und setpriv sind hier Attrappen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSecureConfig } from '../vpn-manager.js';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dvhub-vpn.sh');

const OVPN = [
  'client', 'dev tun', 'proto udp', 'remote vpn.example.com 1194', 'resolv-retry infinite', 'nobind',
  'persist-key', 'persist-tun', 'remote-cert-tls server', 'cipher AES-256-GCM', 'verb 3',
  'ca ca.crt', 'cert client.crt', 'key client.key', 'tls-auth ta.key 1', '',
].join('\n');

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'dvhub-vpnh-'));
  const cfg = join(dir, 'etc');
  const profiles = join(cfg, 'vpn', 'profiles');
  const run = join(dir, 'run');
  const bin = join(dir, 'bin');
  const log = join(dir, 'calls.log');
  mkdirSync(profiles, { recursive: true });
  mkdirSync(bin);
  const fake = (name, body = '') => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\nprintf '%s\\n' "${name} $*" >> "${log}"\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  // setpriv: Optionen bis "--" verwerfen, dann den Befehl ausführen.
  fake('setpriv', 'while [[ $# -gt 0 && $1 != -- ]]; do shift; done; shift; exec "$@"');
  fake('openvpn', `cp "$2/client.conf" "${dir}/started.conf" 2>/dev/null; ls "$2/f" > "${dir}/started.files" 2>/dev/null; exit 0`);
  fake('wg-quick', `cp "$2" "${dir}/wg-started.conf" 2>/dev/null; exit 0`);
  fake('wg', 'exit 0');
  fake('pkill', 'exit "${PKILL_RC:-0}"');
  const profile = (name, files) => {
    const p = join(profiles, name);
    mkdirSync(p, { recursive: true });
    for (const [f, c] of Object.entries(files)) writeFileSync(join(p, f), c);
    return p;
  };
  const runH = (args, env = {}) => spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH}`, DVHUB_HELPER_TEST_CONFIG_DIR: cfg, DVHUB_HELPER_TEST_RUN_DIR: run,
      DVHUB_HELPER_TEST_SERVICE_USER: userInfo().username, DVHUB_HELPER_TEST_EUID: '0', ...env,
    },
  });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);
  const started = () => calls().filter((l) => /^(openvpn|wg-quick|wg) /.test(l));
  return { dir, cfg, profiles, run, profile, runH, calls, started, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const certs = { 'ca.crt': 'CA\n', 'client.crt': 'CERT\n', 'client.key': 'KEY\n', 'ta.key': 'TA\n' };

test('ohne root: Abbruch, nichts gestartet', () => {
  const s = setup();
  try {
    s.profile('dv', { 'client.ovpn': OVPN, ...certs });
    const r = s.runH(['openvpn', 'up', 'dv'], { DVHUB_HELPER_TEST_EUID: '1000' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /root/);
    assert.deepEqual(s.started(), []);
  } finally { s.cleanup(); }
});

test('ungültige Aufrufe → Exit 2, nichts gestartet', () => {
  const s = setup();
  try {
    s.profile('dv', { 'client.ovpn': OVPN, 'wg0.conf': '[Interface]\n', ...certs });
    for (const args of [[], ['openvpn'], ['openvpn', 'up'], ['openvpn', '--config', '/tmp/x.ovpn'],
      ['openvpn', 'up', '../dv'], ['openvpn', 'up', 'a/b'], ['openvpn', 'up', 'a b'], ['openvpn', 'up', ''],
      ['openvpn', 'up', 'dv', 'evil.conf'], ['openvpn', 'up', 'dv', '../client.ovpn'], ['openvpn', 'up', 'dv', '.x.ovpn'],
      ['openvpn', 'up', 'dv', 'client.ovpn', '--script-security', '2'], ['openvpn', 'down', 'dv'], ['openvpn', 'status', '1'],
      ['openvpn', 'up', 'x'.repeat(65)], ['wireguard', 'up', 'dv', 'wg0.ovpn'], ['wireguard', 'status', 'wg1'],
      ['wireguard', 'down'], ['ipsec', 'up', 'dv'], ['apt-get', 'update']]) {
      const r = s.runH(args);
      assert.equal(r.status, 2, `${JSON.stringify(args)} → ${r.status} ${r.stderr}`);
    }
    assert.deepEqual(s.started(), []);
  } finally { s.cleanup(); }
});

test('OpenVPN up: genau die feste Befehlszeile, geprüfte Kopie, Dateien als Dienstbenutzer gelesen', () => {
  const s = setup();
  try {
    s.profile('dv', { 'client.ovpn': OVPN, ...certs });
    const r = s.runH(['openvpn', 'up', 'dv']);
    assert.equal(r.status, 0, r.stderr);
    const stage = join(s.run, 'openvpn');
    assert.deepEqual(s.started(), [`openvpn --cd ${stage} --config client.conf --script-security 0 --writepid ${join(s.run, 'openvpn.pid')}`]);
    const conf = readFileSync(join(s.dir, 'started.conf'), 'utf8');
    assert.match(conf, /^ca f\/ca\.crt$/m);
    assert.match(conf, /^tls-auth f\/ta\.key 1$/m);
    assert.match(conf, /^remote vpn\.example\.com 1194$/m);
    assert.deepEqual(readFileSync(join(s.dir, 'started.files'), 'utf8').trim().split('\n').sort(), ['ca.crt', 'client.crt', 'client.key', 'ta.key']);
    assert.ok(s.calls().filter((l) => l.startsWith('setpriv ')).length >= 5, 'Profil und Dateien über setpriv gelesen');
    assert.ok(s.calls().every((l) => !l.startsWith('setpriv ') || l.includes(`--reuid=${userInfo().username}`)));
  } finally { s.cleanup(); }
});

test('OpenVPN up: eigener Dateiname, absoluter Pfad im Profilordner und eingebettete Blöcke', () => {
  const s = setup();
  try {
    const p = s.profile('luox', { 'anbieter.ovpn': `client\nremote h 1194\nca ${join(s.profiles, 'luox', 'ca.crt')}\n<cert>\nup /bin/sh\n</cert>\n<connection>\nremote h2 443\nproto tcp-client\n</connection>\n`, 'ca.crt': 'CA\n' });
    void p;
    const r = s.runH(['openvpn', 'up', 'luox', 'anbieter.ovpn']);
    assert.equal(r.status, 0, r.stderr);
    const conf = readFileSync(join(s.dir, 'started.conf'), 'utf8');
    assert.match(conf, /^ca f\/ca\.crt$/m, 'absoluter Pfad im Profil → Kopie');
    assert.match(conf, /^<cert>\nup \/bin\/sh\n<\/cert>$/m, 'Blockinhalt sind Daten');
  } finally { s.cleanup(); }
});

test('OpenVPN: DVhubs eigenes gespeichertes Profil (buildSecureConfig) besteht die Prüfung', () => {
  const s = setup();
  try {
    const accessServer = [
      '# OVPN_ACCESS_SERVER_PROFILE=x', 'setenv FORWARD_COMPATIBLE 1', 'client', 'server-poll-timeout 4', 'nobind',
      'remote vpn.example.com 1194 udp', 'remote vpn.example.com 443 tcp', 'dev tun', 'dev-type tun',
      'remote-cert-tls server', 'tls-version-min 1.2', 'reneg-sec 604800', 'tun-mtu 1420', 'auth-user-pass',
      'verb 3', 'push-peer-info', 'setenv opt block-outside-dns', 'key-direction 1', 'data-ciphers AES-256-GCM:AES-128-GCM',
      'comp-lzo no', 'pull-filter ignore "route-ipv6"', 'verify-x509-name "C=DE, CN=dv" subject', 'keepalive 10 60',
      '<ca>', '-----BEGIN CERTIFICATE-----', 'x', '-----END CERTIFICATE-----', '</ca>',
      '<tls-crypt>', 'k', '</tls-crypt>', '',
    ].join('\n');
    s.profile('direktvermarkter', { 'client.ovpn': buildSecureConfig(accessServer) });
    const r = s.runH(['openvpn', 'up', 'direktvermarkter']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(join(s.dir, 'started.conf'), 'utf8'), /^script-security 0$/m);
  } finally { s.cleanup(); }
});

// Was OpenVPN als root ausführen, laden oder schreiben könnte — und Zeilen,
// die OpenVPN anders liest als eine einfache Prüfung.
const REFUSED = {
  // validateOvpnConfig (vpn-manager.js DANGEROUS_DIRECTIVES)
  up: 'up /tmp/x.sh', down: 'down /tmp/x.sh', 'route-up': 'route-up /tmp/x', 'route-pre-down': 'route-pre-down /tmp/x',
  ipchange: 'ipchange /tmp/x', 'client-connect': 'client-connect /tmp/x', 'client-disconnect': 'client-disconnect /tmp/x',
  'learn-address': 'learn-address /tmp/x', 'tls-verify': 'tls-verify /tmp/x', 'auth-user-pass-verify': 'auth-user-pass-verify /tmp/x via-env',
  'management-external-key': 'management-external-key', plugin: 'plugin /tmp/x.so', 'script-security 2': 'script-security 2',
  iproute: 'iproute /tmp/x', 'tls-crypt-v2-verify': 'tls-crypt-v2-verify /tmp/x', management: 'management 0.0.0.0 7505',
  'management-client-auth': 'management-client-auth', 'management-client-user': 'management-client-user root',
  'management-client-group': 'management-client-group root',
  // zusätzlich
  config: 'config /tmp/other.conf',
  writepid: 'writepid /etc/x', cd: 'cd /', chroot: 'chroot /', daemon: 'daemon', 'tmp-dir': 'tmp-dir /etc',
  'tls-export-cert': 'tls-export-cert /etc', engine: 'engine dynamic', providers: 'providers legacy', 'dev-node': 'dev-node /dev/sda',
  'pkcs11-providers': 'pkcs11-providers /tmp/x.so', 'replay-persist': 'replay-persist /etc/x',
  'doppelstrich': '--up /tmp/x.sh', 'setenv opt': 'setenv opt up /tmp/x.sh', 'setenv opt quoted': 'setenv "opt" up /tmp/x.sh',
  'quoted name': '"up" /tmp/x.sh', 'inline up': '<up>\n/tmp/x.sh\n</up>', 'unknown tag': '<script>\nx\n</script>',
  'ca outside': 'ca /etc/shadow', 'ca traversal': 'ca ../../shadow', 'ca subdir': 'ca sub/ca.crt', 'auth file outside': 'auth-user-pass /root/pw',
  'crl dir': 'crl-verify crl dir', 'ca quoted': 'ca "ca.crt"', 'socks auth outside': 'socks-proxy h 1080 /etc/shadow',
  'long line': `setenv X ${'A'.repeat(250)}up /tmp/x.sh`, 'nested connection': '<connection>\n<connection>\nremote h\n</connection>\n</connection>',
  'connection smuggle': '<connection>\n<ca>\n</connection>\nup /tmp/x.sh\n</ca>\n</connection>', 'open block': '<ca>\nx',
  'uppercase': 'UP /tmp/x.sh',
};

test('OpenVPN: gefährliche oder mehrdeutige Zeilen → Exit 3, openvpn nicht gestartet', () => {
  const s = setup();
  try {
    for (const [label, line] of Object.entries(REFUSED)) {
      s.profile('dv', { 'client.ovpn': `client\nremote h 1194\n${line}\n`, 'ca.crt': 'CA\n', crl: 'C\n' });
      const r = s.runH(['openvpn', 'up', 'dv']);
      assert.equal(r.status, 3, `${label}: ${r.status} ${r.stderr}`);
      assert.match(r.stderr, /Profil abgelehnt/, label);
    }
    assert.deepEqual(s.started(), []);
  } finally { s.cleanup(); }
});

test('OpenVPN: NUL-Bytes, Verweise und fehlende Dateien → Exit 3', () => {
  const s = setup();
  try {
    const p = s.profile('dv', { 'client.ovpn': 'client\nremote h 1194\nca ca.crt\n' });
    // Verweis statt Datei (z. B. auf /etc/shadow)
    symlinkSync('/etc/hosts', join(p, 'ca.crt'));
    assert.equal(s.runH(['openvpn', 'up', 'dv']).status, 3, 'ca.crt ist ein Verweis');
    rmSync(join(p, 'ca.crt'));
    assert.equal(s.runH(['openvpn', 'up', 'dv']).status, 3, 'ca.crt fehlt');
    writeFileSync(join(p, 'ca.crt'), 'CA\n');
    writeFileSync(join(p, 'client.ovpn'), 'client\nremote h 1194\0\nup /tmp/x\n');
    assert.equal(s.runH(['openvpn', 'up', 'dv']).status, 3, 'NUL-Byte');
    rmSync(join(p, 'client.ovpn'));
    symlinkSync(join(s.dir, 'fremd.ovpn'), join(p, 'client.ovpn'));
    writeFileSync(join(s.dir, 'fremd.ovpn'), 'client\nremote h 1194\n');
    assert.equal(s.runH(['openvpn', 'up', 'dv']).status, 3, 'client.ovpn ist ein Verweis');
    // Profilordner als Verweis
    symlinkSync(p, join(s.profiles, 'link'));
    assert.equal(s.runH(['openvpn', 'up', 'link']).status, 3, 'Profilordner ist ein Verweis');
    assert.equal(s.runH(['openvpn', 'up', 'fehlt']).status, 3, 'Profil fehlt');
    assert.deepEqual(s.started(), []);
  } finally { s.cleanup(); }
});

test('OpenVPN check: prüft nur, startet nichts', () => {
  const s = setup();
  try {
    s.profile('dv', { 'client.ovpn': OVPN, ...certs });
    const r = s.runH(['openvpn', 'check', 'dv']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /OK/);
    assert.deepEqual(s.started(), []);
  } finally { s.cleanup(); }
});

test('OpenVPN down/status: ohne PID-Datei pkill genau auf openvpn', () => {
  const s = setup();
  try {
    assert.equal(s.runH(['openvpn', 'down']).status, 0);
    assert.equal(s.runH(['openvpn', 'status']).status, 0);
    assert.equal(s.runH(['openvpn', 'status'], { PKILL_RC: '1' }).status, 1);
    assert.deepEqual(s.calls().filter((l) => l.startsWith('pkill')), ['pkill -TERM -x openvpn', 'pkill -0 -x openvpn', 'pkill -0 -x openvpn']);
  } finally { s.cleanup(); }
});

const WG = '[Interface]\nPrivateKey = abc\nAddress = 10.0.0.2/32\n# PostUp = nur ein Kommentar\n\n[Peer]\nPublicKey = def\nEndpoint = vpn.example.com:51820\nAllowedIPs = 10.0.0.0/24\n';

test('WireGuard up/down/status: geprüfte Kopie als wg0.conf, feste Befehle', () => {
  const s = setup();
  try {
    s.profile('dv', { 'wg0.conf': WG });
    const staged = join(s.run, 'wireguard', 'wg0.conf');
    assert.equal(s.runH(['wireguard', 'up', 'dv']).status, 0);
    assert.equal(readFileSync(join(s.dir, 'wg-started.conf'), 'utf8'), WG);
    assert.equal(s.runH(['wireguard', 'status']).status, 0);
    assert.equal(s.runH(['wireguard', 'down', 'dv']).status, 0);
    rmSync(join(s.run, 'wireguard'), { recursive: true });
    assert.equal(s.runH(['wireguard', 'down', 'dv']).status, 0, 'ohne Kopie vom Start: Profil neu prüfen');
    assert.deepEqual(s.started(), [`wg-quick up ${staged}`, 'wg show wg0 latest-handshakes', `wg-quick down ${staged}`, `wg-quick down ${staged}`]);
  } finally { s.cleanup(); }
});

test('WireGuard: Hooks und SaveConfig in jeder Schreibweise → Exit 3', () => {
  const s = setup();
  try {
    for (const line of ['PreUp = id', 'postup=id', '  PREDOWN =id', 'PostDown\t= id', 'SaveConfig = true', 'saveconfig=true']) {
      s.profile('dv', { 'wg0.conf': WG.replace('[Peer]', `${line}\n[Peer]`) });
      const r = s.runH(['wireguard', 'up', 'dv']);
      assert.equal(r.status, 3, `${line}: ${r.status} ${r.stderr}`);
    }
    assert.deepEqual(s.started(), []);
  } finally { s.cleanup(); }
});

test('OpenVPN: eingebetteter <peer-fingerprint>-Block ist erlaubt (Daten, Gegenprüfung 71dbf940)', () => {
  const s = setup();
  try {
    s.profile('dv', { 'client.ovpn': 'client\nremote h 1194\n<peer-fingerprint>\nAB:CD:EF\n</peer-fingerprint>\n' });
    const r = s.runH(['openvpn', 'check', 'dv']);
    assert.equal(r.status, 0, r.stderr);
  } finally { s.cleanup(); }
});

// Realtest auf Prod .60 (27.10.): das Profil des Direktvermarkters enthält
// `log-append /var/log/openvpn.log` und wurde abgelehnt — die DV-Verbindung wäre
// ausgefallen. Protokoll-Direktiven werden in der geprüften Kopie weggelassen
// (OpenVPN als root soll keine Datei an einem Profilpfad schreiben), statt das
// ganze Profil abzulehnen; das Protokoll läuft über DVhub wie bisher.
test('OpenVPN: log/log-append/status werden weggelassen, Profil läuft weiter', () => {
  const s = setup();
  try {
    s.profile('dv', { 'client.ovpn': 'client\ndev tun\nproto udp\nremote h 1194\nlog-append /var/log/openvpn.log\nlog /etc/cron.d/x\nstatus /etc/x 10\nscript-security 0\nverb 3\n<ca>\nCA\n</ca>\n' });
    const chk = s.runH(['openvpn', 'check', 'dv']);
    assert.equal(chk.status, 0, chk.stderr);
    assert.match(chk.stderr, /log-append/, 'Hinweis nennt die weggelassene Direktive');
    const r = s.runH(['openvpn', 'up', 'dv']);
    assert.equal(r.status, 0, r.stderr);
    const conf = readFileSync(join(s.dir, 'started.conf'), 'utf8');
    assert.doesNotMatch(conf, /^(log|log-append|status)\b/m);
    assert.match(conf, /^remote h 1194$/m);
  } finally { s.cleanup(); }
});
