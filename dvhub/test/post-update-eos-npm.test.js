// test/post-update-eos-npm.test.js -- zwei Entscheidungen aus post-update.sh,
// getestet am ECHTEN Block (aus dem Skript ausgeschnitten), mit Attrappen für
// systemctl/systemd-run/npm.
//
// Review 25.10.2026:
//  P1: nach einem Update ohne eos-venv/ (früher vom Stash weggeräumt) meldete
//      post-update.sh "EOS: OK", weil nur Marker, Checkout und Unit geprüft
//      wurden. Jetzt gehört ein ausführbares $EOS_VENV/bin/python dazu.
//  P2: der npm-Marker muss vor einem npm install ungültig werden und erst nach
//      einem erfolgreichen Lauf wieder stehen.
//  Außerdem: Laufzeitordner im Repo-Ordner sind in .gitignore (sonst zählen sie
//  als untracked und stören jedes git-basierte Update).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = readFileSync(join(ROOT, 'post-update.sh'), 'utf8');

function block(startMarker, endMarker) {
  const from = SCRIPT.indexOf(startMarker);
  const to = SCRIPT.indexOf(endMarker, from);
  if (from < 0 || to < 0) throw new Error(`Block ${startMarker} in post-update.sh nicht gefunden — Test anpassen`);
  return SCRIPT.slice(from, to);
}

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'dvhub-pu-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const log = join(dir, 'calls.log');
  const fake = (name, body = '') => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\necho "${name} $*" >> "${log}"\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  const run = (sh, env = {}) => spawnSync('bash', ['-c', `set -euo pipefail\n${sh}`], {
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, ...env }, encoding: 'utf8',
  });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);
  return { dir, fake, run, calls, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const EOS_BLOCK = block('EOS_DIR="$INSTALL_DIR/eos"', '# ── 11.');

function eosCase({ venvPython, configDir = true, nativeMarker = 'https://x/eos.git@v1 ok akkudoktoreos_native-0.2.0-cp311-abi3-manylinux2014_aarch64.manylinux_2_17_aarch64.whl\n' }) {
  const s = sandbox();
  const inst = join(s.dir, 'opt');
  const data = join(s.dir, 'data');
  mkdirSync(join(inst, 'eos', '.git'), { recursive: true });
  mkdirSync(data);
  writeFileSync(join(inst, 'eos-provision.sh'), '');
  writeFileSync(join(inst, 'eos-version.env'), 'EOS_REPO_URL=https://x/eos.git\nEOS_PIN=v1\n');
  writeFileSync(join(data, '.eos-provisioned'), 'https://x/eos.git@v1\n');
  if (nativeMarker !== null) writeFileSync(join(data, '.eos-native'), nativeMarker);
  const unit = join(s.dir, 'eos.service');
  // configDir=true: gesunde Box MIT dem 1.0.11-Fix (Unit setzt EOS_CONFIG_DIR).
  // false: 1.0.10-Bestandsbox ohne den Fix (A1-Falle).
  writeFileSync(unit, configDir ? '[Unit]\nEnvironment=EOS_CONFIG_DIR=/var/lib/dvhub/cfg\n' : '[Unit]\n');
  if (venvPython) {
    mkdirSync(join(inst, 'eos-venv', 'bin'), { recursive: true });
    writeFileSync(join(inst, 'eos-venv', 'bin', 'python'), '#!/bin/sh\n');
    chmodSync(join(inst, 'eos-venv', 'bin', 'python'), 0o755);
  }
  s.fake('systemctl', '[[ "$1" == is-active ]] && exit 1; exit 0');
  s.fake('systemd-run');
  const r = s.run(`INSTALL_DIR='${inst}'\nDATA_DIR='${data}'\nSERVICE_USER=dvhub\nEOS_UNIT_PATH='${unit}'\n${EOS_BLOCK}`);
  return { s, r };
}

test('EOS-Schnellweg: Marker, Checkout und Unit stimmen, venv fehlt → Neu-Provisionierung statt "OK"', () => {
  const { s, r } = eosCase({ venvPython: false });
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /EOS: OK/);
    assert.ok(s.calls().some((l) => l.startsWith('systemd-run') && l.includes('eos-provision.sh')), s.calls().join('\n'));
  } finally { s.cleanup(); }
});

test('EOS-Schnellweg: alles vorhanden → OK, keine Provisionierung', () => {
  const { s, r } = eosCase({ venvPython: true });
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /EOS: OK/);
    assert.ok(!s.calls().some((l) => l.startsWith('systemd-run')));
  } finally { s.cleanup(); }
});

// A1 (1.0.11): Bestandsbox 1.0.10→1.0.11 — EOS gesund und aktuell (Pin
// unverändert, Rust-Kern ok), aber die Unit stammt noch von VOR dem
// EOS_CONFIG_DIR-Fix. Der Schnellweg meldete bisher „EOS: OK" und rief
// eos-provision.sh NIE auf → die PermissionError-Falle lief weiter. Jetzt muss der
// leichte Konfig-Fix entkoppelt angestoßen werden (ROT gegen den Stand vor A1).
test('A1: aktuell, aber Unit OHNE EOS_CONFIG_DIR (1.0.10-Falle) → leichter Konfig-Fix entkoppelt (EOS_CONFIG_FIX_ONLY=1), nicht still OK', () => {
  const { s, r } = eosCase({ venvPython: true, configDir: false });
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /EOS: OK/);
    const run = s.calls().find((l) => l.startsWith('systemd-run') && l.includes('eos-provision.sh'));
    assert.ok(run, `erwartet: entkoppelter Konfig-Fix.\n${s.calls().join('\n')}`);
    assert.match(run, /--setenv=EOS_CONFIG_FIX_ONLY=1/);
    assert.ok(!/--setenv=EOS_NATIVE_ONLY=1/.test(run), 'kein Kern-Nachzug, nur der leichte Konfig-Fix');
    assert.match(r.stdout, /ohne git\/pip/);
  } finally { s.cleanup(); }
});

test('A1 idempotent: Unit MIT EOS_CONFIG_DIR → OK, kein erneuter Konfig-Fix', () => {
  const { s, r } = eosCase({ venvPython: true, configDir: true });
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /EOS: OK/);
    assert.ok(!s.calls().some((l) => l.startsWith('systemd-run')), 'Fix bereits angewandt — kein erneuter Lauf');
  } finally { s.cleanup(); }
});

// T-0415 (1.0.10): Rust-Kern. EOS ist aktuell, aber der Kern fehlt (kein
// Marker, alter Stand im Marker) oder scheiterte → NUR den Kern nachziehen
// (EOS_NATIVE_ONLY=1), nicht still „OK“. „unsupported“ (keine Wheels für die
// Plattform) und „none“ (eigener Stand) sind erledigt.
for (const [name, marker, retry] of [
  ['kein Marker', null, true],
  ['Kern gescheitert', 'https://x/eos.git@v1 failed Rauchtest gescheitert (rc=1)\n', true],
  ['Marker eines anderen Stands', 'https://x/eos.git@v0 ok a.whl\n', true],
  ['keine Plattform', 'https://x/eos.git@v1 unsupported linux-armv6l\n', false],
  ['eigener Stand', 'https://x/eos.git@v1 none eigener-Stand\n', false],
]) {
  test(`EOS-Schnellweg, Rust-Kern: ${name} → ${retry ? 'nur Kern nachziehen' : 'OK'}`, () => {
    const { s, r } = eosCase({ venvPython: true, nativeMarker: marker });
    try {
      assert.equal(r.status, 0, r.stderr);
      const run = s.calls().find((l) => l.startsWith('systemd-run') && l.includes('eos-provision.sh'));
      if (retry) {
        assert.doesNotMatch(r.stdout, /EOS: OK/);
        assert.ok(run, s.calls().join('\n'));
        assert.match(run, /--setenv=EOS_NATIVE_ONLY=1/);
        assert.match(r.stdout, /Rust-Kern fehlt oder scheiterte/);
      } else {
        assert.match(r.stdout, /EOS: OK/);
        assert.equal(run, undefined);
      }
    } finally { s.cleanup(); }
  });
}

test('EOS: neuer Stand → volle Provisionierung (EOS_NATIVE_ONLY=0)', () => {
  const s = sandbox();
  const inst = join(s.dir, 'opt');
  const data = join(s.dir, 'data');
  try {
    mkdirSync(join(inst, 'eos', '.git'), { recursive: true });
    mkdirSync(join(inst, 'eos-venv', 'bin'), { recursive: true });
    mkdirSync(data);
    writeFileSync(join(inst, 'eos-provision.sh'), '');
    writeFileSync(join(inst, 'eos-version.env'), 'EOS_REPO_URL=https://x/eos.git\nEOS_PIN=v2\n');
    writeFileSync(join(data, '.eos-provisioned'), 'https://x/eos.git@v1\n');
    writeFileSync(join(data, '.eos-native'), 'https://x/eos.git@v1 failed x\n');
    const unit = join(s.dir, 'eos.service');
    writeFileSync(unit, '[Unit]\n');
    s.fake('systemctl', '[[ "$1" == is-active ]] && exit 1; exit 0');
    s.fake('systemd-run');
    const r = s.run(`INSTALL_DIR='${inst}'\nDATA_DIR='${data}'\nSERVICE_USER=dvhub\nEOS_UNIT_PATH='${unit}'\n${EOS_BLOCK}`);
    assert.equal(r.status, 0, r.stderr);
    const run = s.calls().find((l) => l.startsWith('systemd-run'));
    assert.match(run, /--setenv=EOS_NATIVE_ONLY=0/);
    assert.match(r.stdout, /neue Version angefordert/);
  } finally { s.cleanup(); }
});

const NPM_BLOCK = block('if [[ -f "$APP_DIR/package.json" ]]; then\n  cd "$APP_DIR"', '# ── 7.');
const BUDGET_BLOCK = block('# ── Startzeit-Budget ──', '# ── Ende Startzeit-Budget ──');

function npmCase({ npmOk, marker }) {
  const s = sandbox();
  const inst = join(s.dir, 'opt');
  const app = join(inst, 'dvhub');
  mkdirSync(join(app, 'node_modules'), { recursive: true });
  writeFileSync(join(app, 'package.json'), '{}');
  writeFileSync(join(app, 'package-lock.json'), '{"lockfileVersion":3}');
  if (marker) writeFileSync(join(inst, '.npm-install-hash'), `${marker}\n`);
  // npm prüft, ob der Marker während des Laufs noch steht (darf er nicht).
  s.fake('npm', `[[ -e "${join(inst, '.npm-install-hash')}" ]] && echo "MARKER_DURING_INSTALL" >> "${join(s.dir, 'calls.log')}"\n${npmOk ? 'exit 0' : 'exit 1'}`);
  s.fake('chown'); s.fake('runuser', 'shift 2; exec "$@"'); s.fake('getent', `echo "dvhub:x:1:1::${s.dir}:/bin/sh"`);
  s.fake('id', 'exit 0');
  // Ohne startbare Unit (systemd-run scheitert): npm im Vordergrund, begrenzt.
  s.fake('systemd-run', 'exit 1'); s.fake('systemctl', 'exit 3');
  const r = s.run(`${BUDGET_BLOCK}\nINSTALL_DIR='${inst}'\nAPP_DIR='${app}'\nDATA_DIR='${s.dir}'\nSERVICE_NAME=dvhub\nNPM_RESTART_FLAG='${join(s.dir, 'flag')}'\nSERVICE_USER=dvhub\n${NPM_BLOCK}`);
  const markerNow = existsSync(join(inst, '.npm-install-hash')) ? readFileSync(join(inst, '.npm-install-hash'), 'utf8').trim() : null;
  const hash = execFileSync('sha256sum', [join(app, 'package-lock.json')], { encoding: 'utf8' }).split(' ')[0];
  return { s, r, markerNow, hash };
}

test('npm-Marker: während npm install ungültig, nach Fehlschlag weg (nächster Start repariert)', () => {
  const { s, r, markerNow } = npmCase({ npmOk: false, marker: 'veraltet' });
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!s.calls().includes('MARKER_DURING_INSTALL'), 'Marker darf während des Laufs nicht stehen');
    assert.equal(markerNow, null);
  } finally { s.cleanup(); }
});

test('npm-Marker: nach Erfolg = Lockfile-Hash', () => {
  const { s, r, markerNow, hash } = npmCase({ npmOk: true, marker: 'veraltet' });
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!s.calls().includes('MARKER_DURING_INSTALL'));
    assert.equal(markerNow, hash);
  } finally { s.cleanup(); }
});

test('.gitignore: Laufzeitordner im Repo-Ordner gelten nicht als untracked', () => {
  const paths = ['eos/pyproject.toml', 'eos-venv/bin/python', 'forecast-venv/bin/python3', 'bin/dvhub-eebus',
    '.npm-install-hash', 'ml-models/x.bin'];
  const out = spawnSync('git', ['-C', ROOT, 'check-ignore', '--no-index', ...paths], { encoding: 'utf8' });
  const ignored = out.stdout.trim().split('\n').filter(Boolean);
  assert.deepEqual(ignored.sort(), [...paths].sort());
});

// ── local-native: Motor-Entscheidung im EOS-Schnellweg (engine-Marker) ──────
// Deckt Codex-P2 #1 (Fallback-Box darf nicht bei jedem Start neu provisionieren)
// und die native Schnellweg-Erkennung ab. Arch-agnostisch: alle drei Binär-Pins.
const SHA = 'a'.repeat(64);
function eosNativeCase({ mode = 'local-native', optin = true, engineMarker, binExists = true, unitNative = true, binPin = true }) {
  const s = sandbox();
  const inst = join(s.dir, 'opt');
  const data = join(s.dir, 'data');
  mkdirSync(join(inst, 'eos', '.git'), { recursive: true });
  mkdirSync(join(inst, 'bin'), { recursive: true });
  mkdirSync(data);
  writeFileSync(join(inst, 'eos-provision.sh'), '');
  const pins = ['EOS_REPO_URL=https://x/eos.git', 'EOS_PIN=v1'];
  if (binPin) for (const a of ['X86_64', 'AARCH64', 'ARMV7L']) pins.push(`EOS_NATIVE_BIN_${a}=dvhub-optimize-x`, `EOS_NATIVE_BIN_${a}_SHA256=${SHA}`);
  writeFileSync(join(inst, 'eos-version.env'), pins.join('\n') + '\n');
  writeFileSync(join(data, '.eos-provisioned'), 'https://x/eos.git@v1\n');
  writeFileSync(join(data, '.eos-native'), 'https://x/eos.git@v1 ok akkudoktoreos_native-...whl\n');
  if (engineMarker) writeFileSync(join(data, '.eos-native-engine'), engineMarker);
  if (binExists) { writeFileSync(join(inst, 'bin', 'dvhub-optimize'), '#!/bin/sh\n'); chmodSync(join(inst, 'bin', 'dvhub-optimize'), 0o755); }
  // venv vorhanden (für den Python-Schnellweg im Fallback-Fall)
  mkdirSync(join(inst, 'eos-venv', 'bin'), { recursive: true });
  writeFileSync(join(inst, 'eos-venv', 'bin', 'python'), '#!/bin/sh\n'); chmodSync(join(inst, 'eos-venv', 'bin', 'python'), 0o755);
  const unit = join(s.dir, 'eos.service');
  writeFileSync(unit, unitNative ? '[Service]\nExecStart=/opt/bin/dvhub-optimize serve --listen 127.0.0.1:8503\n' : '[Unit]\nEnvironment=EOS_CONFIG_DIR=/var/lib/dvhub/cfg\n');
  const cfg = join(s.dir, 'config.json');
  writeFileSync(cfg, JSON.stringify({ optimizer: { eosProxy: { mode } } }));
  const optinMarker = join(s.dir, 'optin'); if (optin) writeFileSync(optinMarker, '');
  s.fake('systemctl', '[[ "$1" == is-active ]] && exit 1; exit 0');
  s.fake('systemd-run');
  const r = s.run(`INSTALL_DIR='${inst}'\nDATA_DIR='${data}'\nSERVICE_USER=dvhub\nEOS_UNIT_PATH='${unit}'\nCONFIG_PATH='${cfg}'\nEOS_NATIVE_OPTIN_MARKER='${optinMarker}'\n${EOS_BLOCK}`);
  return { s, r };
}
const sig = `dvhub-optimize-x:${SHA.slice(0, 12)}`;

test('local-native: Motor-Marker native + Binär + Unit → OK, keine Provisionierung', () => {
  const { s, r } = eosNativeCase({ engineMarker: `native https://x/eos.git@v1 ${sig}\n` });
  try {
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /nativer Optimierer aktuell/);
    assert.ok(!s.calls().some((c) => c.startsWith('systemd-run')), 'keine (Neu-)Provisionierung');
  } finally { s.cleanup(); }
});

test('local-native Fallback vermerkt → kein Churn: OK, keine Neu-Provisionierung (Codex-P2 #1)', () => {
  const { s, r } = eosNativeCase({ engineMarker: `fallback https://x/eos.git@v1 ${sig}\n`, unitNative: false });
  try {
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(!s.calls().some((c) => c.startsWith('systemd-run')), 'Fallback ist abgeschlossen — kein teurer Neuversuch');
  } finally { s.cleanup(); }
});

test('local-native gewünscht, aber noch kein Motor-Marker → Provisionierung angestoßen', () => {
  const { s, r } = eosNativeCase({ engineMarker: null });
  try {
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(s.calls().some((c) => c.startsWith('systemd-run')), 'Motorwechsel → Neu-Provisionierung');
  } finally { s.cleanup(); }
});

test('local-native, aber anderer Binär-Pin als der Marker → Neu-Provisionierung (Codex-P2 #2)', () => {
  const { s, r } = eosNativeCase({ engineMarker: `native https://x/eos.git@v1 dvhub-optimize-x:${'b'.repeat(12)}\n` });
  try {
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(s.calls().some((c) => c.startsWith('systemd-run')), 'neuer Binär-Pin → neu provisionieren');
  } finally { s.cleanup(); }
});

test('Rückweg: mode=local, aber Motor-Marker noch native → Neu-Provisionierung (stellt Python her)', () => {
  const { s, r } = eosNativeCase({ mode: 'local', engineMarker: `native https://x/eos.git@v1 ${sig}\n` });
  try {
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(s.calls().some((c) => c.startsWith('systemd-run')), 'Motorwechsel native→python');
  } finally { s.cleanup(); }
});

test('mode=local-native ohne Opt-in → kein nativer Wunsch, Python-Schnellweg (kein Churn)', () => {
  const { s, r } = eosNativeCase({ optin: false, engineMarker: null, unitNative: false });
  try {
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /EOS: OK \(aktuell/);
    assert.ok(!s.calls().some((c) => c.startsWith('systemd-run')), 'ohne Opt-in bleibt alles Python, kein Churn');
  } finally { s.cleanup(); }
});

test('local-native gewünscht, aber kein Binär-Pin für diese Arch → Python, kein Churn (Codex-P2 #1)', () => {
  // ohne Pin: DESIRED_NATIVE=0, kein Motor-Marker → settled, Python-Schnellweg
  const { s, r } = eosNativeCase({ binPin: false, engineMarker: null, unitNative: false });
  try {
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /EOS: OK \(aktuell/);
    assert.ok(!s.calls().some((c) => c.startsWith('systemd-run')), 'kein Pin → kein teurer Neuversuch je Start');
  } finally { s.cleanup(); }
});
