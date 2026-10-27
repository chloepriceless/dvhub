// test/post-update-start-budget.test.js -- post-update.sh läuft als
// ExecStartPre bei jedem Dienststart (TimeoutStartSec=120). Gegenprüfung
// 25.10.2026: lief es darüber (npm install, apt-get update für fehlende
// VPN-Pakete, chown -R über die venvs), scheiterte der Start trotz '-', und
// Restart=always wiederholte dieselbe langsame Arbeit — eine Schleife.
// Jetzt: langsame Schritte entkoppelt (systemd-run) oder mit Zeitgrenze aus
// einem gemeinsamen Budget; was nicht fertig wird, setzt der nächste Start fort.
// Getestet an den echten Blöcken aus post-update.sh, mit Attrappen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = readFileSync(join(ROOT, 'post-update.sh'), 'utf8');

function block(startMarker, endMarker) {
  const from = SCRIPT.indexOf(startMarker);
  const to = SCRIPT.indexOf(endMarker, from);
  if (from < 0 || to < 0) throw new Error(`Block ${startMarker} in post-update.sh nicht gefunden`);
  return SCRIPT.slice(from, to);
}
const BUDGET = () => block('# ── Startzeit-Budget ──', '# ── Ende Startzeit-Budget ──');

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'dvhub-pu-budget-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const log = join(dir, 'calls.log');
  const fake = (name, body = '') => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\nprintf '%s\\n' "${name} $*" >> "${log}"\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  // systemd-run: Optionen weg, Befehl synchron ausführen (Attrappe).
  const systemdRunExec = () => fake('systemd-run', 'while [[ $1 == --* ]]; do case $1 in --unit|--description) shift 2 ;; *) shift ;; esac; done; "$@" >/dev/null 2>&1; exit 0');
  fake('sleep');
  const run = (sh, env = {}) => spawnSync('bash', ['-c', `set -euo pipefail\n${sh}`], {
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, ...env }, encoding: 'utf8',
  });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);
  return { dir, bin, fake, systemdRunExec, run, calls, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('Budget: Zeitgrenze = Rest des Budgets; aufgebraucht → 124, Befehl läuft nicht', () => {
  const s = sandbox();
  try {
    s.fake('timeout', 'shift 3; exec "$@"');
    s.fake('schritt');
    let r = s.run(`${BUDGET()}\nSECONDS=70\npu_bounded 30 schritt a\necho rc=$?`, { DVHUB_START_BUDGET_S: '90' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(s.calls().some((l) => /^timeout -k 5 (19|20) schritt a$/.test(l)), s.calls().join('\n'));
    r = s.run(`${BUDGET()}\nSECONDS=89\nrc=0; pu_bounded 30 schritt b || rc=$?\necho rc=$rc`, { DVHUB_START_BUDGET_S: '90' });
    assert.match(r.stdout, /rc=124/);
    assert.match(r.stderr, /Startzeit aufgebraucht/);
    assert.ok(!s.calls().includes('schritt b'));
  } finally { s.cleanup(); }
});

const PKG_BLOCK = () => block('NEEDED_PKGS=""', '# ── 2.');

test('Fehlende VPN-Pakete: apt läuft entkoppelt in eigener Unit, nicht im Start', () => {
  const s = sandbox();
  try {
    s.fake('dpkg', '[[ "$2" == openvpn || "$2" == wireguard-tools ]] && exit 1; exit 0');
    s.fake('systemctl', 'exit 3');
    s.fake('systemd-run');
    s.fake('apt-get');
    const r = s.run(`DATA_DIR='${s.dir}'\n${PKG_BLOCK()}`);
    assert.equal(r.status, 0, r.stderr);
    const c = s.calls();
    assert.ok(c.some((l) => l.startsWith('systemd-run') && l.includes('--unit dvhub-vpn-packages')), c.join('\n'));
    assert.ok(!c.some((l) => l.startsWith('apt-get')), 'kein apt-get im Start selbst');
    assert.match(r.stdout, /im Hintergrund gestartet/);
  } finally { s.cleanup(); }
});

test('Fehlende VPN-Pakete: die Unit ruft apt mit Sperr-Wartezeit, WireGuard ohne Recommends', () => {
  const s = sandbox();
  try {
    s.fake('dpkg', '[[ "$2" == openvpn || "$2" == wireguard-tools ]] && exit 1; exit 0');
    s.fake('systemctl', 'exit 3');
    s.systemdRunExec();
    s.fake('apt-get');
    const r = s.run(`DATA_DIR='${s.dir}'\n${PKG_BLOCK()}`);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(s.calls().filter((l) => l.startsWith('apt-get')), [
      'apt-get -o DPkg::Lock::Timeout=300 update -qq',
      'apt-get -o DPkg::Lock::Timeout=300 install -y openvpn',
      'apt-get -o DPkg::Lock::Timeout=300 install -y --no-install-recommends wireguard-tools',
    ]);
  } finally { s.cleanup(); }
});

test('Pakete-Unit läuft noch → kein zweiter Start', () => {
  const s = sandbox();
  try {
    s.fake('dpkg', 'exit 1');
    s.fake('systemctl', '[[ "$1 $3" == "is-active dvhub-vpn-packages.service" ]] && exit 0; exit 3');
    s.fake('systemd-run');
    const r = s.run(`DATA_DIR='${s.dir}'\n${PKG_BLOCK()}`);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!s.calls().some((l) => l.startsWith('systemd-run')));
    assert.match(r.stdout, /läuft bereits/);
  } finally { s.cleanup(); }
});

const NPM_BLOCK = () => block('if [[ -f "$APP_DIR/package.json" ]]; then\n  cd "$APP_DIR"', '# ── 7.');

function npmRig(s) {
  const inst = join(s.dir, 'opt');
  const app = join(inst, 'dvhub');
  mkdirSync(join(app, 'node_modules'), { recursive: true });
  writeFileSync(join(app, 'package.json'), '{}');
  writeFileSync(join(app, 'package-lock.json'), '{"lockfileVersion":3}');
  writeFileSync(join(inst, '.npm-install-hash'), 'veraltet\n');
  const hash = execFileSync('sha256sum', [join(app, 'package-lock.json')], { encoding: 'utf8' }).split(' ')[0];
  const flag = join(s.dir, 'npm-restart');
  const sh = (budget = 90) => `${BUDGET()}\nINSTALL_DIR='${inst}'\nAPP_DIR='${app}'\nDATA_DIR='${s.dir}'\nSERVICE_NAME=dvhub\nNPM_RESTART_FLAG='${flag}'\nNPM_LOCK='${join(s.dir, 'lock')}'\nPU_BUDGET_S=${budget}\n${NPM_BLOCK()}`;
  return { inst, app, hash, flag, sh, marker: () => (existsSync(join(inst, '.npm-install-hash')) ? readFileSync(join(inst, '.npm-install-hash'), 'utf8').trim() : null) };
}

test('npm: entkoppelte Unit, fertig innerhalb der Wartezeit → Marker, kein Neustart-Merker', () => {
  const s = sandbox();
  try {
    const n = npmRig(s);
    s.fake('npm');
    s.fake('systemctl', 'exit 3');   // Unit nach dem (synchronen) Lauf nicht mehr aktiv
    s.systemdRunExec();
    const r = s.run(n.sh());
    assert.equal(r.status, 0, r.stderr);
    const c = s.calls();
    assert.ok(c.some((l) => l.startsWith('systemd-run') && l.includes('--unit dvhub-npm-install')), c.join('\n'));
    assert.ok(c.includes('npm install --omit=dev'));
    assert.equal(n.marker(), n.hash);
    assert.ok(!existsSync(n.flag));
    assert.match(r.stdout, /npm install: OK/);
  } finally { s.cleanup(); }
});

test('npm: Unit läuft über die Wartezeit → Start geht weiter, Merker für den Neustart danach', () => {
  const s = sandbox();
  try {
    const n = npmRig(s);
    s.fake('npm');
    s.fake('systemctl', '[[ "$1" == is-active ]] && [[ -e "${NPM_RUNNING:-/nonexistent}" ]] && exit 0; exit 3');
    s.fake('systemd-run', `touch "${join(s.dir, 'running')}"`);
    const r = s.run(n.sh(40), { NPM_RUNNING: join(s.dir, 'running') });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!s.calls().includes('npm install --omit=dev'), 'npm nicht im Start selbst');
    assert.ok(existsSync(n.flag), 'Merker: Unit startet DVhub nach Erfolg neu');
    assert.equal(n.marker(), null, 'Marker erst nach Erfolg');
    assert.match(r.stdout, /im Hintergrund weiter/);
    assert.ok(s.calls().filter((l) => l === 'sleep 2').length <= 8, 'Wartezeit begrenzt');
  } finally { s.cleanup(); }
});

test('npm-Unit-Skript: nach Erfolg Marker, bei gesetztem Merker Neustart von DVhub; Fehlschlag ohne beides', () => {
  const s = sandbox();
  try {
    const n = npmRig(s);
    const script = NPM_BLOCK().match(/NPM_SCRIPT='([\s\S]*?)'\n/)[1];
    s.fake('systemctl');
    s.fake('npm', 'exit "${NPM_RC:-0}"');
    const runUnit = (env) => spawnSync('bash', ['-c', script, 'dvhub-npm-install', n.app, n.hash, join(n.inst, '.npm-install-hash'), n.flag, join(s.dir, 'lock'), 'dvhub.service'], {
      env: { PATH: `${s.bin}:${process.env.PATH}`, ...env }, encoding: 'utf8',
    });
    writeFileSync(n.flag, '');
    let r = runUnit({ NPM_RC: '1' });
    assert.notEqual(r.status, 0);
    assert.equal(n.marker(), null);
    assert.ok(!s.calls().some((l) => l.startsWith('systemctl restart')));
    r = runUnit({});
    assert.equal(r.status, 0, r.stderr);
    assert.equal(n.marker(), n.hash);
    assert.ok(s.calls().includes('systemctl restart --no-block dvhub.service'));
    assert.ok(!existsSync(n.flag));
  } finally { s.cleanup(); }
});

test('Langsame Teilschritte im Start laufen mit Zeitgrenze', () => {
  for (const needle of [
    'pu_bounded 20 env SERVICE_NAME="$SERVICE_NAME" DATA_DIR="$DATA_DIR" NODE_BIN="$NODE_BIN"',
    'pu_bounded 20 node "$INSTALL_DIR/scripts/reconcile-vendor-profiles.mjs"',
    'pu_bounded 30 openssl req',
    'pu_bounded 30 env SERVICE_USER="$SERVICE_USER" DATA_DIR="$DATA_DIR" CONFIG_PATH="$CONFIG_PATH" \\\n         bash "$INSTALL_DIR/support-provision.sh"',
    'pu_bounded 30 bash "$INSTALL_DIR/pg-write-tuning.sh"',
    'pu_bounded 20 env DB_NAME=dvhub bash "$INSTALL_DIR/timescale-provision.sh" --check',
    'dvhub_root_own_install_dir "$INSTALL_DIR" 30',
  ]) assert.ok(SCRIPT.includes(needle), needle);
  // Kein apt-get und kein npm install mehr direkt im Start (nur in den Units bzw. begrenzt).
  const start = SCRIPT.slice(0, SCRIPT.indexOf('# ── 7.'));
  const direct = start.split('\n').filter((l) => /^\s*(apt-get|npm install|env HOME=\/root npm)/.test(l));
  assert.deepEqual(direct, []);
});

// ── Rechte-Block: nur, was nicht passt; mit Zeitgrenze fortsetzbar ──
function ownBlock() {
  const a = SCRIPT.indexOf('# BEGIN DVHUB INSTALL-DIR OWNERSHIP');
  const b = SCRIPT.indexOf('# END DVHUB INSTALL-DIR OWNERSHIP');
  return SCRIPT.slice(a, b);
}

test('Rechte-Block: Zeitgrenze erreicht → kein Marker; nächster Lauf setzt fort und setzt ihn', () => {
  const s = sandbox();
  try {
    const inst = join(s.dir, 'opt');
    mkdirSync(join(inst, 'eos-venv', 'lib'), { recursive: true });
    writeFileSync(join(inst, 'eos-venv', 'lib', 'x.py'), '');
    writeFileSync(join(inst, 'post-update.sh'), '#\n');
    s.fake('chown'); s.fake('chmod');
    s.fake('timeout', '[[ -e "${TIMEOUT_HIT:-/nonexistent}" ]] && exit 124; shift 3; exec "$@"');
    const sh = `${ownBlock()}\ndvhub_root_own_install_dir '${inst}' 30 || echo RC=$?`;
    const env = { GIT_CONFIG_SYSTEM: join(s.dir, 'gitconfig'), TIMEOUT_HIT: join(s.dir, 'hit') };
    writeFileSync(join(s.dir, 'hit'), '');
    let r = s.run(sh, env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /RC=1/);
    assert.match(r.stderr, /Zeitgrenze/);
    assert.ok(!existsSync(join(inst, '.root-owned-rev')));
    rmSync(join(s.dir, 'hit'));
    r = s.run(sh, env);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(inst, '.root-owned-rev'), 'utf8').trim(), 'nogit');
    const c = s.calls().filter((l) => /^ch(own|mod) /.test(l));
    assert.ok(c.every((l) => !/ -R /.test(l)), `kein chown/chmod -R: ${c.join('\n')}`);
    assert.ok(c.some((l) => l.startsWith('chown -h 0:0 ') && l.includes(join(inst, 'eos-venv', 'lib', 'x.py'))), c.join('\n'));
  } finally { s.cleanup(); }
});
