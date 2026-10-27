// test/privileged-helpers-sudoers.test.js -- sudoers nativ und im Container
// zeigen für apt, setcap, fuser, OpenVPN und WireGuard nur noch auf die
// root-eigenen Hilfsskripte (Gegenprüfung 25.10.2026, P2).
//
// Früher: `/usr/bin/apt-get update *`, `/usr/bin/apt-get upgrade *`,
// `/usr/bin/apt list *`, `/usr/sbin/setcap *`, `/usr/bin/fuser *`,
// `openvpn --config *`, `wg-quick up|down *` (Docker: …/profiles/*). Mit dem
// Platzhalter am Ende durfte der Dienstbenutzer beliebige Argumente als root
// übergeben.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

function block(file, name) {
  const s = read(file);
  const a = s.indexOf(`# BEGIN DVHUB ${name}`);
  const b = s.indexOf(`# END DVHUB ${name}`);
  assert.ok(a >= 0 && b > a, `Block ${name} in ${file}`);
  return s.slice(a, b);
}
const rules = (file) => block(file, 'SUDOERS').split('\n').filter((l) => l.startsWith('${SERVICE_USER} ALL='));
const cmd = (rule) => rule.split('NOPASSWD:')[1].trim();

// Regeln mit * am Ende, die bewusst bleiben: nur lesend bzw. an strongSwan
// (ipsec ist ein eigenes Thema, nicht Teil dieser Härtung).
const KEPT_WILDCARDS = [
  '${SYSTEMCTL_PATH} show ${SERVICE_NAME}.service *',
  '${IPSEC_PATH} up *', '${IPSEC_PATH} down *', '${IPSEC_PATH} status *',
  '${IP_PATH} link show *', '${IP_PATH} addr show *',
];

for (const file of ['install.sh', 'post-update.sh']) {
  test(`${file}: keine Regel mehr auf apt-get/apt/setcap/fuser/openvpn/wg-quick/wg/pkill openvpn`, () => {
    const bad = rules(file).filter((r) => /\/usr\/bin\/apt(-get)? |\/usr\/sbin\/setcap|\/usr\/bin\/fuser|\$\{(OPENVPN|WG_QUICK|WG)_PATH\}|-x openvpn/.test(r));
    assert.deepEqual(bad, []);
  });

  test(`${file}: Platzhalter am Ende nur auf Hilfsskripten (oder bewusst lesend)`, () => {
    const wild = rules(file).map(cmd).filter((c) => c.endsWith(' *'));
    const unexpected = wild.filter((c) => !/^\$\{[A-Z_]+_(HELPER|LINK|REDIRECT)_PATH\} /.test(c) && !KEPT_WILDCARDS.includes(c));
    assert.deepEqual(unexpected, []);
  });

  test(`${file}: Hilfsskript-Regeln mit festen Aktionen`, () => {
    const c = rules(file).map(cmd);
    for (const want of [
      '${APT_HELPER_PATH} refresh', '${APT_HELPER_PATH} list-upgradable', '${APT_HELPER_PATH} upgrade-all',
      '${APT_HELPER_PATH} upgrade-security', '${APT_HELPER_PATH} lock-held', '${SETCAP_HELPER_PATH} node',
      '${VPN_HELPER_PATH} openvpn up *', '${VPN_HELPER_PATH} openvpn down', '${VPN_HELPER_PATH} openvpn status',
      '${VPN_HELPER_PATH} wireguard up *', '${VPN_HELPER_PATH} wireguard down *', '${VPN_HELPER_PATH} wireguard status',
    ]) assert.ok(c.includes(want), want);
  });
}

test('HELPERS-Block: in install.sh und post-update.sh byte-gleich', () => {
  assert.equal(block('install.sh', 'HELPERS'), block('post-update.sh', 'HELPERS'));
});

test('HELPERS-Block: installiert alle Hilfsskripte root-eigen mit eingetragenen Werten', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dvhub-helpers-'));
  try {
    const inst = join(dir, 'opt');
    const libexec = join(dir, 'libexec');
    const bin = join(dir, 'bin');
    mkdirSync(inst); mkdirSync(bin);
    for (const f of ['dvhub-ipsec-link.sh', 'dvhub-modbus-redirect.sh', 'dvhub-update.sh', 'dvhub-apt.sh', 'dvhub-setcap.sh', 'dvhub-vpn.sh']) {
      copyFileSync(join(ROOT, f), join(inst, f));
    }
    const log = join(dir, 'calls.log');
    // chown/install -o root brauchen root: Attrappen, die nur aufschreiben.
    writeFileSync(join(bin, 'chown'), `#!/usr/bin/env bash\necho "chown $*" >> "${log}"\n`);
    writeFileSync(join(bin, 'install'), `#!/usr/bin/env bash\nfor a; do d="$a"; done; mkdir -p "$d"\n`);
    chmodSync(join(bin, 'chown'), 0o755); chmodSync(join(bin, 'install'), 0o755);
    const sh = `set -euo pipefail\nINSTALL_DIR='${inst}' CONFIG_DIR=/etc/dvhub-x SERVICE_USER=svc SERVICE_NAME=dvhub2\n${block('post-update.sh', 'HELPERS')}\ndvhub_install_helpers\n`;
    const r = spawnSync('bash', ['-c', sh], { encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, DVHUB_LIBEXEC: libexec } });
    assert.equal(r.status, 0, r.stderr);
    for (const h of ['dvhub-ipsec-link', 'dvhub-modbus-redirect', 'dvhub-update', 'dvhub-apt', 'dvhub-setcap', 'dvhub-vpn']) {
      assert.ok(existsSync(join(libexec, h)), h);
      assert.ok(readFileSync(log, 'utf8').includes(`chown root:root ${join(libexec, h)}.`), `${h} root-eigen vor dem Umbenennen`);
    }
    const vpn = readFileSync(join(libexec, 'dvhub-vpn'), 'utf8');
    assert.match(vpn, /^INSTALLED="1"$/m);
    assert.match(vpn, /^CONFIG_DIR="\/etc\/dvhub-x"$/m);
    assert.match(vpn, /^SERVICE_USER="svc"$/m);
    assert.match(readFileSync(join(libexec, 'dvhub-apt'), 'utf8'), /^INSTALLED="1"$/m);
    assert.match(readFileSync(join(libexec, 'dvhub-setcap'), 'utf8'), /^INSTALLED="1"$/m);
    assert.match(readFileSync(join(libexec, 'dvhub-update'), 'utf8'), new RegExp(`^INSTALL_DIR="${inst.replace(/[/.]/g, '\\$&')}"$`, 'm'));
    assert.match(readFileSync(join(libexec, 'dvhub-update'), 'utf8'), /^SERVICE_NAME="dvhub2"$/m);
    assert.equal(read('dvhub-ipsec-link.sh'), readFileSync(join(libexec, 'dvhub-ipsec-link'), 'utf8'), 'ohne Platzhalter unverändert');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Container ──
const dockerRules = () => [...read('Dockerfile').matchAll(/'(dvhub ALL=\(root\) NOPASSWD: [^']+)'/g)].map((m) => m[1]);

test('Dockerfile: keine Regel mehr auf openvpn, wg-quick, wg oder pkill; Platzhalter nur auf Hilfsskripten', () => {
  const r = dockerRules();
  assert.ok(r.length >= 6, 'sudoers-Zeilen gefunden');
  assert.deepEqual(r.filter((l) => /\/usr\/sbin\/openvpn|wg-quick|\/usr\/bin\/wg |pkill|apt|setcap|fuser/.test(l)), []);
  assert.deepEqual(r.filter((l) => l.endsWith(' *') && !/NOPASSWD: \/usr\/local\/libexec\/dvhub-[a-z-]+ /.test(l)), []);
  for (const want of ['openvpn up *', 'openvpn down', 'openvpn status', 'wireguard up *', 'wireguard down *', 'wireguard status']) {
    assert.ok(r.includes(`dvhub ALL=(root) NOPASSWD: /usr/local/libexec/dvhub-vpn ${want}`), want);
  }
});

test('Dockerfile: dvhub-vpn wird mit eingetragenen Werten installiert, bash ist im Abbild', () => {
  const d = read('Dockerfile');
  assert.match(d, /COPY --chmod=0755 dvhub-vpn\.sh \/usr\/local\/libexec\/dvhub-vpn/);
  assert.match(d, /apk add --no-cache [^\n]*\bbash\b/);
  assert.match(read('.dockerignore'), /^!dvhub-vpn\.sh$/m, 'im Build-Kontext');
  // Die sed-Ausdrücke aus dem Dockerfile auf das Skript anwenden.
  const m = d.match(/RUN sed -i ((?:-e '[^']+' \\?\s*)+)\/usr\/local\/libexec\/dvhub-vpn/);
  assert.ok(m, 'sed-Aufruf für dvhub-vpn im Dockerfile');
  const exprs = [...m[1].matchAll(/-e '([^']+)'/g)].map((x) => x[1]);
  const dir = mkdtempSync(join(tmpdir(), 'dvhub-docker-sed-'));
  try {
    const f = join(dir, 'dvhub-vpn');
    copyFileSync(join(ROOT, 'dvhub-vpn.sh'), f);
    execFileSync('sed', [...exprs.flatMap((e) => ['-e', e]), '-i.bak', f]);
    const out = readFileSync(f, 'utf8');
    assert.match(out, /^INSTALLED="1"$/m);
    assert.match(out, /^CONFIG_DIR="\/etc\/dvhub"$/m);
    assert.match(out, /^SERVICE_USER="dvhub"$/m);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
