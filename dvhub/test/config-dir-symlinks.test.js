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
  fs.chmodSync(path.join(bin, 'chown'), 0o755);
  fs.chmodSync(path.join(bin, 'openssl'), 0o755);
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

function chowned(t) {
  try { return fs.readFileSync(path.join(t.dir, 'chown.log'), 'utf8').trim().split('\n').filter(Boolean); } catch { return []; }
}

test('BEGIN/END DVHUB CONFIG DIRS: in install.sh und post-update.sh vorhanden und gleich', () => {
  const pu = block('post-update.sh');
  assert.ok(pu.includes('dvhub_cfg_cd()'), 'Block in post-update.sh');
  assert.equal(block('install.sh'), pu);
});

test('R-0001: Verweise in tls/ lenken weder chown noch openssl nach außen', () => {
  const t = setup();
  try {
    fs.mkdirSync(path.join(t.cfg, 'tls'));
    fs.symlinkSync(path.join(t.outside, 'dvhub-update'), path.join(t.cfg, 'tls', 'x.pem'));
    fs.symlinkSync(path.join(t.outside, 'opfer'), path.join(t.cfg, 'tls', 'key.pem'));
    const r = run(t);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(t.outside, 'opfer'), 'utf8'), 'unberuehrt\n', 'openssl schrieb durch tls/key.pem');
    for (const p of chowned(t)) assert.ok(!p.startsWith(t.outside), `chown wirkte auf ${p}`);
    for (const f of ['key.pem', 'cert.pem']) {
      const st = fs.lstatSync(path.join(t.cfg, 'tls', f));
      assert.ok(st.isFile() && !st.isSymbolicLink(), `${f} ist eine echte Datei`);
    }
    assert.match(fs.readFileSync(path.join(t.cfg, 'tls', 'key.pem'), 'utf8'), /PRIVATE KEY/);
    assert.equal(fs.statSync(path.join(t.cfg, 'tls', 'key.pem')).mode & 0o777, 0o600);
    assert.ok(!fs.existsSync(path.join(t.cfg, 'tls', 'x.pem')), 'Verweis x.pem entfernt');
    assert.deepEqual(fs.readdirSync(path.join(t.cfg, 'tls')).sort(), ['cert.pem', 'key.pem'], 'kein Zwischenordner übrig');
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

test('T-0003: install.sh setzt config.json nach dem Schreiben auf 0600', () => {
  const s = read('install.sh');
  const iWrite = s.indexOf("if (changed) fs.writeFileSync(p, JSON.stringify(c, null, 2) + '\\n');");
  const iSecure = s.indexOf('dvhub_cfg_secure_file "$CONFIG_PATH" "$SERVICE_USER"');
  assert.ok(iWrite > 0, 'Schreibstelle gefunden');
  assert.ok(iSecure > iWrite, 'Rechte nach dem letzten Schreiben gesetzt');
});
