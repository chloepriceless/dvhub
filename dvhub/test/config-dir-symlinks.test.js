// test/config-dir-symlinks.test.js -- root folgt im Konfigurationsordner keinem
// Verweis (Strix R-0001/R-0006, 30.10.2026).
//
// /etc/dvhub gehört dem Dienstbenutzer, post-update.sh läuft aber bei jedem
// Start als root darin. Vorher:
//   R-0001  tls/x.pem → /usr/local/libexec/dvhub-update: `chown dvhub tls/*`
//           (ohne -h) gab den Update-Helfer an dvhub — über dessen sudo-Regel
//           wurde daraus root. tls/key.pem → <datei>: openssl schrieb den
//           privaten Schlüssel durch den Verweis in die fremde Datei.
//   R-0006  vpn → /usr/local/libexec: root setzte dort chmod 700 und legte
//           profiles/ an.
// Der Test führt den echten Abschnitt „3. Verzeichnisse“ bis „4. TLS“ aus
// post-update.sh aus (openssl/chown als Attrappen, die aufschreiben, was sie
// täten) und prüft, dass nichts außerhalb des Konfigurationsordners berührt wird.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

function block(file) {
  const s = read(file);
  const a = s.indexOf('# BEGIN DVHUB CONFIG DIRS');
  const b = s.indexOf('# END DVHUB CONFIG DIRS');
  return a >= 0 && b > a ? s.slice(a, b) : '';
}

function section() {
  const s = read('post-update.sh');
  const a = s.indexOf('# ── 3. Verzeichnisse ──');
  const b = s.indexOf('# ── 5. Sudoers');
  assert.ok(a > 0 && b > a, 'Abschnitt 3–4 in post-update.sh');
  return s.slice(a, b);
}

function setup() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-cfgdir-')));
  const cfg = path.join(dir, 'etc-dvhub');
  const outside = path.join(dir, 'libexec');
  const bin = path.join(dir, 'bin');
  for (const d of [cfg, outside, bin]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(outside, 'dvhub-update'), '#!/bin/sh\necho helfer\n');
  fs.writeFileSync(path.join(outside, 'opfer'), 'unberuehrt\n');
  fs.chmodSync(outside, 0o755);
  // Attrappen: chown schreibt auf, worauf es (nach Verweisen) wirken würde.
  fs.writeFileSync(path.join(bin, 'chown'), `#!/usr/bin/env bash
noderef=0
for a in "$@"; do case "$a" in -h|-R|-hR|-Rh) [[ "$a" == *h* ]] && noderef=1;; esac; done
for a in "\${@:2}"; do
  case "$a" in -*) continue;; esac
  if [[ $noderef -eq 1 ]]; then p="$a"; else p="$(cd -P "$(dirname "$a")" 2>/dev/null && pwd)/$(basename "$a")"; [[ -L "$a" ]] && p="$(readlink "$a")"; fi
  printf '%s\\n' "$p" >> "${dir}/chown.log"
done
exit 0
`);
  fs.writeFileSync(path.join(bin, 'openssl'), `#!/usr/bin/env bash
while [[ $# -gt 0 ]]; do
  case "$1" in
    -keyout) printf -- '-----BEGIN PRIVATE KEY-----\\n' > "$2"; shift 2;;
    -out) printf -- '-----BEGIN CERTIFICATE-----\\n' > "$2"; shift 2;;
    *) shift;;
  esac
done
exit 0
`);
  // runuser: prüft als Dienstbenutzer — hier als Testbenutzer (ohne root).
  fs.writeFileSync(path.join(bin, 'runuser'), `#!/usr/bin/env bash
[[ "$1" == -u ]] && shift 2
[[ "$1" == -- ]] && shift
exec "$@"
`);
  fs.chmodSync(path.join(bin, 'chown'), 0o755);
  fs.chmodSync(path.join(bin, 'openssl'), 0o755);
  fs.chmodSync(path.join(bin, 'runuser'), 0o755);
  return { dir, cfg, outside, bin };
}

function run(t, prelude = '') {
  const script = `set -euo pipefail
pu_bounded() { shift; "$@"; }
SERVICE_USER=dvhub
CONFIG_DIR='${t.cfg}'
APP_DIR='${t.dir}/keine-app'
INSTALL_DIR='${t.dir}/keine-app'
${block('post-update.sh')}
${prelude}
${section()}
`;
  return spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: `${t.bin}:${process.env.PATH}`, HOME: t.dir } });
}

function isLink(p) { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } }

function chowned(t) {
  try { return fs.readFileSync(path.join(t.dir, 'chown.log'), 'utf8').trim().split('\n').filter(Boolean); } catch { return []; }
}

test('BEGIN/END DVHUB CONFIG DIRS: in install.sh und post-update.sh vorhanden und gleich', () => {
  const pu = block('post-update.sh');
  assert.ok(pu.includes('dvhub_cfg_cd()'), 'Block in post-update.sh');
  assert.equal(block('install.sh'), pu);
});

// Gesamtprüfung 03.11.2026 (Befund 8): Verweise in tls/ werden nicht mehr
// gelöscht (certbot: cert.pem → /etc/letsencrypt/live/…). Sicher bleibt es,
// weil root nie DURCH sie schreibt oder chownt: das Paar entsteht im
// root-eigenen Zwischenordner, und harte Verweise ersetzen nur fehlende
// Einträge; ein vorhandener Verweis verhindert das Erzeugen ganz.
test('R-0001: Verweise in tls/ lenken weder chown noch openssl nach außen und bleiben stehen', () => {
  const t = setup();
  try {
    fs.mkdirSync(path.join(t.cfg, 'tls'));
    fs.symlinkSync(path.join(t.outside, 'dvhub-update'), path.join(t.cfg, 'tls', 'x.pem'));
    fs.symlinkSync(path.join(t.outside, 'opfer'), path.join(t.cfg, 'tls', 'key.pem'));
    const r = run(t);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(t.outside, 'opfer'), 'utf8'), 'unberuehrt\n', 'openssl schrieb durch tls/key.pem');
    assert.equal(fs.readFileSync(path.join(t.outside, 'dvhub-update'), 'utf8'), '#!/bin/sh\necho helfer\n');
    for (const p of chowned(t)) assert.ok(!p.startsWith(t.outside), `chown wirkte auf ${p}`);
    assert.equal(fs.readlinkSync(path.join(t.cfg, 'tls', 'x.pem')), path.join(t.outside, 'dvhub-update'), 'x.pem bleibt');
    assert.equal(fs.readlinkSync(path.join(t.cfg, 'tls', 'key.pem')), path.join(t.outside, 'opfer'), 'key.pem bleibt');
    assert.ok(!fs.existsSync(path.join(t.cfg, 'tls', 'cert.pem')) && !isLink(path.join(t.cfg, 'tls', 'cert.pem')), 'kein Paar neben einem eigenen Schlüssel');
    assert.match(r.stderr, /key\.pem ist ein Verweis, cert\.pem fehlt/);
    assert.deepEqual(fs.readdirSync(path.join(t.cfg, 'tls')).sort(), ['key.pem', 'x.pem'], 'kein Zwischenordner übrig');
  } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('R-0001: fremder Verweis in tls/ (nicht cert/key) → Paar wird trotzdem als echte Dateien erzeugt, Ziel unberührt', () => {
  const t = setup();
  try {
    fs.mkdirSync(path.join(t.cfg, 'tls'));
    fs.symlinkSync(path.join(t.outside, 'dvhub-update'), path.join(t.cfg, 'tls', 'x.pem'));
    const r = run(t);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /TLS Zertifikat: neu erzeugt/);
    for (const p of chowned(t)) assert.ok(!p.startsWith(t.outside), `chown wirkte auf ${p}`);
    for (const f of ['key.pem', 'cert.pem']) {
      const st = fs.lstatSync(path.join(t.cfg, 'tls', f));
      assert.ok(st.isFile() && !st.isSymbolicLink(), `${f} ist eine echte Datei`);
    }
    assert.match(fs.readFileSync(path.join(t.cfg, 'tls', 'key.pem'), 'utf8'), /PRIVATE KEY/);
    assert.equal(fs.statSync(path.join(t.cfg, 'tls', 'key.pem')).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(path.join(t.outside, 'dvhub-update'), 'utf8'), '#!/bin/sh\necho helfer\n');
    assert.deepEqual(fs.readdirSync(path.join(t.cfg, 'tls')).sort(), ['cert.pem', 'key.pem', 'x.pem']);
  } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

// certbot-Einrichtung: beide als Verweis auf reguläre Dateien des
// Dienstbenutzers bzw. von root. Vorher still durch ein selbstsigniertes Paar
// ersetzt.
test('TLS: certbot-Verweise (cert.pem und key.pem) bleiben, kein selbstsigniertes Paar, keine Warnung', () => {
  const t = setup();
  try {
    const live = path.join(t.outside, 'live', 'box');
    fs.mkdirSync(live, { recursive: true });
    fs.writeFileSync(path.join(live, 'fullchain.pem'), 'CERTBOT-CERT\n');
    fs.writeFileSync(path.join(live, 'privkey.pem'), 'CERTBOT-KEY\n');
    fs.mkdirSync(path.join(t.cfg, 'tls'));
    fs.symlinkSync(path.join(live, 'fullchain.pem'), path.join(t.cfg, 'tls', 'cert.pem'));
    fs.symlinkSync(path.join(live, 'privkey.pem'), path.join(t.cfg, 'tls', 'key.pem'));
    const r = run(t, `SERVICE_USER="$(id -un)"`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /TLS Zertifikat: OK/);
    assert.doesNotMatch(r.stderr, /tls/);
    assert.equal(fs.readlinkSync(path.join(t.cfg, 'tls', 'cert.pem')), path.join(live, 'fullchain.pem'));
    assert.equal(fs.readlinkSync(path.join(t.cfg, 'tls', 'key.pem')), path.join(live, 'privkey.pem'));
    assert.equal(fs.readFileSync(path.join(live, 'fullchain.pem'), 'utf8'), 'CERTBOT-CERT\n');
    assert.equal(fs.readFileSync(path.join(live, 'privkey.pem'), 'utf8'), 'CERTBOT-KEY\n');
    assert.deepEqual(chowned(t), []);
  } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('TLS: nur der Schlüssel als Verweis, Zertifikat als Datei → beide bleiben (HTTPS nicht ohne Schlüssel)', () => {
  const t = setup();
  try {
    fs.writeFileSync(path.join(t.outside, 'privkey.pem'), 'KEY\n');
    fs.mkdirSync(path.join(t.cfg, 'tls'));
    fs.writeFileSync(path.join(t.cfg, 'tls', 'cert.pem'), 'EIGENES');
    fs.symlinkSync(path.join(t.outside, 'privkey.pem'), path.join(t.cfg, 'tls', 'key.pem'));
    const r = run(t, `SERVICE_USER="$(id -un)"`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /TLS Zertifikat: OK/);
    assert.doesNotMatch(r.stderr, /ohne key\.pem|Verweis/);
    assert.equal(fs.readlinkSync(path.join(t.cfg, 'tls', 'key.pem')), path.join(t.outside, 'privkey.pem'));
    assert.equal(fs.readFileSync(path.join(t.cfg, 'tls', 'cert.pem'), 'utf8'), 'EIGENES');
  } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('TLS: Verweis ins Leere oder auf keine reguläre Datei → Warnung, Verweis bleibt, nichts erzeugt', () => {
  const t = setup();
  try {
    fs.mkdirSync(path.join(t.cfg, 'tls'));
    fs.symlinkSync(path.join(t.outside, 'gibt-es-nicht.pem'), path.join(t.cfg, 'tls', 'cert.pem'));
    fs.symlinkSync(t.outside, path.join(t.cfg, 'tls', 'key.pem'));
    const r = run(t, `SERVICE_USER="$(id -un)"`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /TLS Zertifikat: OK/);
    assert.match(r.stderr, /cert\.pem verweist auf .*gibt-es-nicht\.pem.*keine reguläre Datei/);
    assert.match(r.stderr, /key\.pem verweist auf .*keine reguläre Datei/);
    assert.equal(fs.readlinkSync(path.join(t.cfg, 'tls', 'cert.pem')), path.join(t.outside, 'gibt-es-nicht.pem'));
    assert.ok(!fs.existsSync(path.join(t.outside, 'gibt-es-nicht.pem')), 'nichts durch den Verweis angelegt');
    assert.deepEqual(fs.readdirSync(t.outside).sort(), ['dvhub-update', 'opfer']);
  } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

// Gegenprüfung e35b8c2a (P2): certbot legt privkey.pem 0600 root an — das
// Ziel ist eine reguläre root-Datei, der Dienstbenutzer kann sie aber nicht
// lesen; HTTPS bliebe aus, und das Protokoll sagte „OK“.
test('TLS: Verweis auf eine Datei, die der Dienstbenutzer nicht lesen kann → Warnung mit Hinweis', { skip: process.getuid() === 0 && 'als root ist alles lesbar' }, () => {
  const t = setup();
  try {
    const live = path.join(t.outside, 'live');
    fs.mkdirSync(live);
    fs.writeFileSync(path.join(live, 'fullchain.pem'), 'CERT\n');
    fs.writeFileSync(path.join(live, 'privkey.pem'), 'KEY\n', { mode: 0o000 });
    fs.mkdirSync(path.join(t.cfg, 'tls'));
    fs.symlinkSync(path.join(live, 'fullchain.pem'), path.join(t.cfg, 'tls', 'cert.pem'));
    fs.symlinkSync(path.join(live, 'privkey.pem'), path.join(t.cfg, 'tls', 'key.pem'));
    const r = run(t, `SERVICE_USER="$(id -un)"`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /key\.pem: Ziel für \S+ nicht lesbar/);
    assert.doesNotMatch(r.stderr, /cert\.pem: Ziel/);
    assert.equal(fs.readlinkSync(path.join(t.cfg, 'tls', 'key.pem')), path.join(live, 'privkey.pem'), 'Verweis bleibt');
  } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('TLS: Verweis auf eine Datei, die weder root noch dem Dienstbenutzer gehört → Warnung', () => {
  const t = setup();
  try {
    fs.mkdirSync(path.join(t.cfg, 'tls'));
    fs.writeFileSync(path.join(t.cfg, 'tls', 'cert.pem'), 'EIGENES');
    fs.symlinkSync(path.join(t.outside, 'opfer'), path.join(t.cfg, 'tls', 'key.pem'));
    // Dienstbenutzer „dvhub“ gibt es hier nicht; opfer gehört dem Testbenutzer.
    const r = run(t);
    assert.equal(r.status, 0, r.stderr);
    if (process.getuid() !== 0) assert.match(r.stderr, /key\.pem verweist auf .*opfer.*keine reguläre Datei von root oder dvhub/);
    assert.equal(fs.readlinkSync(path.join(t.cfg, 'tls', 'key.pem')), path.join(t.outside, 'opfer'));
    assert.equal(fs.readFileSync(path.join(t.outside, 'opfer'), 'utf8'), 'unberuehrt\n');
  } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('R-0001: tls selbst als Verweis → eigener Ordner, nichts im Ziel', () => {
  const t = setup();
  try {
    fs.symlinkSync(t.outside, path.join(t.cfg, 'tls'));
    const r = run(t);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(fs.readdirSync(t.outside).sort(), ['dvhub-update', 'opfer']);
    for (const p of chowned(t)) assert.ok(!p.startsWith(t.outside), `chown wirkte auf ${p}`);
    const st = fs.lstatSync(path.join(t.cfg, 'tls'));
    assert.ok(st.isDirectory() && !st.isSymbolicLink());
    assert.ok(fs.lstatSync(path.join(t.cfg, 'tls', 'cert.pem')).isFile());
  } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('R-0001: vorhandenes Zertifikat bleibt, wie es ist', () => {
  const t = setup();
  try {
    fs.mkdirSync(path.join(t.cfg, 'tls'));
    fs.writeFileSync(path.join(t.cfg, 'tls', 'cert.pem'), 'ALT');
    fs.writeFileSync(path.join(t.cfg, 'tls', 'key.pem'), 'ALTKEY');
    const r = run(t);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /TLS Zertifikat: OK/);
    assert.equal(fs.readFileSync(path.join(t.cfg, 'tls', 'cert.pem'), 'utf8'), 'ALT');
  } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('R-0006: vpn als Verweis → kein chmod/mkdir im Ziel, eigener Ordner mit 0700', () => {
  const t = setup();
  try {
    fs.symlinkSync(t.outside, path.join(t.cfg, 'vpn'));
    const r = run(t);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.statSync(t.outside).mode & 0o777, 0o755, 'Ziel des Verweises behält seine Rechte');
    assert.ok(!fs.existsSync(path.join(t.outside, 'profiles')), 'kein profiles/ im Ziel');
    const vpn = fs.lstatSync(path.join(t.cfg, 'vpn'));
    assert.ok(vpn.isDirectory() && !vpn.isSymbolicLink());
    assert.equal(vpn.mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(t.cfg, 'vpn', 'profiles')).mode & 0o777, 0o700);
  } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('R-0006: vpn/profiles als Verweis → ersetzt, Ziel unberührt', () => {
  const t = setup();
  try {
    fs.mkdirSync(path.join(t.cfg, 'vpn'));
    fs.symlinkSync(t.outside, path.join(t.cfg, 'vpn', 'profiles'));
    const r = run(t);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.statSync(t.outside).mode & 0o777, 0o755);
    const p = fs.lstatSync(path.join(t.cfg, 'vpn', 'profiles'));
    assert.ok(p.isDirectory() && !p.isSymbolicLink());
    assert.equal(p.mode & 0o777, 0o700);
  } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('install.sh: TLS und VPN-Ordner über dieselben Helfer, kein chown/chmod durch Verweise', () => {
  const s = read('install.sh');
  const tail = s.slice(s.indexOf('echo "[6/7] Config-Pfad und Rechte vorbereiten"'), s.indexOf('# PostgreSQL: Datenbank und User'));
  assert.match(tail, /dvhub_tls_selfsigned "\$CONFIG_DIR" "\$SERVICE_USER"/);
  assert.match(tail, /dvhub_cfg_dir "\$CONFIG_DIR" 700 vpn profiles/);
  assert.doesNotMatch(tail, /openssl req/);
  assert.doesNotMatch(tail, /chmod 700 "\$CONFIG_DIR\/vpn/);
  const pu = section();
  assert.doesNotMatch(pu, /chown "\$SERVICE_USER:\$SERVICE_USER" "\$CONFIG_DIR\/tls\/"\*/);
  assert.doesNotMatch(pu, /chmod 700 "\$CONFIG_DIR\/vpn/);
});

// Strix T-0003 (30.10.2026): install.sh kopierte config.json mit 0644 aus der
// Vorlage; der Ordner ist 0750 dvhub:dvhub, also las die Gruppe dvhub (darin
// der Support-Login dvhub-support) apiToken und Zugangsdaten. Die App selbst
// speichert mit 0600 — Bestandsboxen heilen jetzt beim nächsten Start.
function step7(t, cfgPath) {
  const s = read('post-update.sh');
  const a = s.indexOf('# ── 7. Berechtigungen ──');
  const b = s.indexOf('# ── 8. systemd Service');
  assert.ok(a > 0 && b > a, 'Schritt 7 in post-update.sh');
  const script = `set -euo pipefail
SERVICE_USER='${os.userInfo().username}'
CONFIG_DIR='${t.cfg}'
CONFIG_PATH='${cfgPath}'
${block('post-update.sh')}
${s.slice(a, b)}
`;
  return spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: `${t.bin}:${process.env.PATH}`, HOME: t.dir } });
}

test('T-0003: post-update.sh setzt config.json auf 0600', () => {
  const t = setup();
  try {
    const p = path.join(t.cfg, 'config.json');
    fs.writeFileSync(p, '{"apiToken":"geheim"}\n', { mode: 0o644 });
    fs.chmodSync(p, 0o644);
    const r = step7(t, p);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('T-0003: config.json als Verweis → Ziel bleibt unberührt, Start läuft weiter', () => {
  const t = setup();
  try {
    const victim = path.join(t.outside, 'opfer');
    fs.chmodSync(victim, 0o644);
    const p = path.join(t.cfg, 'config.json');
    fs.symlinkSync(victim, p);
    const r = step7(t, p);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.statSync(victim).mode & 0o777, 0o644);
    assert.match(r.stderr, /Verweis/);
  } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

function installConfigStep(t, env) {
  const s = read('install.sh');
  const a = s.indexOf('# config.json anlegen (aus der Vorlage) bzw. ergänzen.');
  const b = s.indexOf('# Herstellerprofile abgleichen (T-MANAGED-VENDOR-PROFILES)');
  assert.ok(a > 0 && b > a, 'Abschnitt in install.sh');
  const app = path.join(t.dir, 'app');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'config.example.json'), '{"httpPort":80}\n');
  const script = `set -euo pipefail\nCONFIG_PATH='${env.CONFIG_PATH}'\nAPP_DIR='${app}'\nUPDATE_CHANNEL=stable\nSUPPORT_LOCAL_USER=1\nSERVICE_USER='${os.userInfo().username}'\n${s.slice(a, b)}`;
  return spawnSync('bash', ['-c', script], { encoding: 'utf8' });
}

test('T-0003: install.sh legt config.json aus der Vorlage mit 0600 an und ergänzt sie', () => {
  const t = setup();
  try {
    const p = path.join(t.cfg, 'config.json');
    const r = installConfigStep(t, { CONFIG_PATH: p });
    assert.equal(r.status, 0, r.stderr);
    const c = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(c.httpPort, 80);
    assert.equal(c.updateChannel, 'stable');
    assert.ok(String(c.apiToken).length >= 16);
    assert.equal(fs.statSync(p).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(t.cfg).filter((f) => f.includes('.neu-')), [], 'keine Zwischendatei übrig');
  } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

// Gegenprüfung 0923ac3d (P2): install.sh prüfte -L und schrieb danach in einem
// zweiten Schritt — ein Verweis zwischen beidem ließ root hindurchschreiben.
test('T-0003: install.sh schreibt nie durch einen Verweis config.json', () => {
  const t = setup();
  try {
    const victim = path.join(t.outside, 'opfer');
    const p = path.join(t.cfg, 'config.json');
    fs.symlinkSync(victim, p);
    const r = installConfigStep(t, { CONFIG_PATH: p });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /ist ein Verweis/);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'unberuehrt\n');
  } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

// Gegenprüfung d5655361 (P3) / 2b43209c (P2): ein vorhandenes Zertifikat
// bleibt stehen — ein eigener Schlüssel darf anders heißen (tlsKeyPath) und
// wird nicht überschrieben. Seit Befund 8 (03.11.2026) bleibt auch ein
// Verweis key.pem stehen (Warnung, wenn sein Ziel nicht passt; Test oben).
test('TLS: Zertifikat ohne key.pem → Meldung, Zertifikat und anders benannter Schlüssel bleiben', () => {
  const t = setup();
  try {
    fs.mkdirSync(path.join(t.cfg, 'tls'));
    fs.writeFileSync(path.join(t.cfg, 'tls', 'cert.pem'), 'EIGENES');
    fs.writeFileSync(path.join(t.cfg, 'tls', 'mein.key'), 'EIGENER-SCHLUESSEL');
    const r = run(t);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /cert\.pem ohne key\.pem/);
    assert.match(r.stdout, /TLS Zertifikat: OK/);
    assert.equal(fs.readFileSync(path.join(t.cfg, 'tls', 'cert.pem'), 'utf8'), 'EIGENES');
    assert.equal(fs.readFileSync(path.join(t.cfg, 'tls', 'mein.key'), 'utf8'), 'EIGENER-SCHLUESSEL');
  } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

// Gegenprüfung d5655361 (P3): eos-provision.sh legte eos.env als root auch
// durch einen ins Leere zeigenden Verweis an.
test('eos.env: Verweis an seiner Stelle wird nicht beschrieben', () => {
  const t = setup();
  try {
    const s = read('eos-provision.sh');
    const a = s.indexOf('# /etc/dvhub gehört dem Dienstbenutzer (Gegenprüfung d5655361, P3)');
    const b = s.indexOf('cat <<UNIT >"$EOS_UNIT_FILE"');
    assert.ok(a > 0 && b > a);
    const unit = path.join(t.dir, 'eos.service');
    fs.writeFileSync(unit, '[Service]\nEnvironment=MEIN_WERT=1\n');
    const env = path.join(t.cfg, 'eos.env');
    const target = path.join(t.outside, 'neu-angelegt');
    fs.symlinkSync(target, env);
    let r = spawnSync('bash', ['-c', `set -euo pipefail\nEOS_SERVICE_NAME=dvhub-eos\nEOS_UNIT_FILE='${unit}'\nEOS_ENV_FILE='${env}'\n${s.slice(a, b)}`], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(target), false, 'kein Ziel angelegt');
    fs.unlinkSync(env);
    r = spawnSync('bash', ['-c', `set -euo pipefail\nEOS_SERVICE_NAME=dvhub-eos\nEOS_UNIT_FILE='${unit}'\nEOS_ENV_FILE='${env}'\n${s.slice(a, b)}`], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(fs.readFileSync(env, 'utf8'), /MEIN_WERT=1/);
  } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});
