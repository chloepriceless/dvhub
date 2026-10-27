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

function eosCase({ venvPython }) {
  const s = sandbox();
  const inst = join(s.dir, 'opt');
  const data = join(s.dir, 'data');
  mkdirSync(join(inst, 'eos', '.git'), { recursive: true });
  mkdirSync(data);
  writeFileSync(join(inst, 'eos-provision.sh'), '');
  writeFileSync(join(inst, 'eos-version.env'), 'EOS_REPO_URL=https://x/eos.git\nEOS_PIN=v1\n');
  writeFileSync(join(data, '.eos-provisioned'), 'https://x/eos.git@v1\n');
  const unit = join(s.dir, 'eos.service');
  writeFileSync(unit, '[Unit]\n');
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
