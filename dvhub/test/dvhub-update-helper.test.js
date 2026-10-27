// test/dvhub-update-helper.test.js -- root-eigener Update-Einstieg dvhub-update.sh.
// Review 25.10.2026 (P1): /opt/dvhub gehört root; das Update aus der Oberfläche
// ändert dort nur noch über dieses Skript (feste Befehle, geprüfte Argumente).
// Echte git-Repos im Temp-Ordner, npm ist eine Attrappe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dvhub-update.sh');
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'dvhub-upd-'));
  const up = join(dir, 'upstream');
  mkdirSync(join(up, 'dvhub'), { recursive: true });
  git(up, 'init', '-q', '-b', 'main');
  writeFileSync(join(up, 'post-update.sh'), '#!/bin/bash\n# alter Stand, chown -R dvhub\n');
  writeFileSync(join(up, 'dvhub', 'package.json'), '{"version":"1.0.0"}\n');
  writeFileSync(join(up, 'dvhub', 'package-lock.json'), '{"lockfileVersion":3,"v":1}\n');
  git(up, 'add', '.'); git(up, 'commit', '-qm', 'alt'); git(up, 'tag', 'v1.0.0');
  const oldSha = git(up, 'rev-parse', 'HEAD');
  writeFileSync(join(up, 'post-update.sh'), '#!/bin/bash\n# DVHUB_ROOT_OWNED_INSTALL\n');
  writeFileSync(join(up, 'dvhub', 'package.json'), '{"version":"1.1.0"}\n');
  git(up, 'commit', '-qam', 'neu'); git(up, 'tag', 'v1.1.0');
  const newSha = git(up, 'rev-parse', 'HEAD');
  const inst = join(dir, 'opt');
  execFileSync('git', ['clone', '-q', up, inst]);
  git(inst, 'checkout', '-q', '--detach', 'v1.1.0');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'npm'), `#!/usr/bin/env bash\n[[ -e "${dir}/npm-fails" ]] && exit 1\necho "npm $* HOME=$HOME" >> "${dir}/npm.log"\n`);
  chmodSync(join(bin, 'npm'), 0o755);
  const run = (...args) => spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, ...GIT_ENV, DVHUB_UPDATE_TEST_INSTALL_DIR: inst, DVHUB_UPDATE_TEST_EUID: '0', DVHUB_UPDATE_TEST_HOME: dir },
  });
  const runEnv = (extra, ...args) => spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, ...GIT_ENV, DVHUB_UPDATE_TEST_INSTALL_DIR: inst, DVHUB_UPDATE_TEST_EUID: '0', DVHUB_UPDATE_TEST_HOME: dir, ...extra },
  });
  return { dir, up, inst, oldSha, newSha, run, runEnv, head: () => git(inst, 'rev-parse', 'HEAD'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('ohne root: Abbruch', () => {
  const s = setup();
  try {
    const r = spawnSync('bash', [SCRIPT, 'fetch'], { encoding: 'utf8', env: { PATH: process.env.PATH, DVHUB_UPDATE_TEST_INSTALL_DIR: s.inst, DVHUB_UPDATE_TEST_EUID: '1000' } });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /root/);
  } finally { s.cleanup(); }
});

test('unbekannte Aktion, zu viele Argumente, ungültige Tags/Commits → Exit 2', () => {
  const s = setup();
  try {
    for (const args of [['rm'], [], ['fetch', '--all'], ['checkout-tag'], ['checkout-tag', '--orphan'],
      ['checkout-tag', 'v1.1.0;id'], ['checkout-tag', '../v1.1.0'], ['checkout-commit', 'HEAD~1'],
      ['checkout-commit', '--detach'], ['checkout-tag', 'v1.1.0', '--force'], ['post-update', 'x']]) {
      const r = s.run(...args);
      assert.equal(r.status, 2, `${args.join(' ')} → ${r.status} ${r.stderr}`);
    }
    assert.equal(s.head(), s.newSha, 'nichts verändert');
  } finally { s.cleanup(); }
});

test('Untergrenze: Stand ohne DVHUB_ROOT_OWNED_INSTALL wird nicht ausgecheckt (Tag und Commit)', () => {
  const s = setup();
  try {
    assert.equal(s.run('checkout-tag', 'v1.0.0').status, 3);
    assert.equal(s.run('checkout-commit', s.oldSha).status, 3);
    assert.equal(s.head(), s.newSha);
  } finally { s.cleanup(); }
});

test('gültige Ziele: Tag, Commit, origin/main', () => {
  const s = setup();
  try {
    assert.equal(s.run('checkout-commit', s.newSha.slice(0, 7)).status, 0);
    assert.equal(s.head(), s.newSha);
    const t = s.run('checkout-tag', 'v1.1.0');
    assert.equal(t.status, 0, t.stderr);
    const m = s.run('checkout-main');
    assert.equal(m.status, 0, m.stderr);
    assert.equal(git(s.inst, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  } finally { s.cleanup(); }
});

test('fetch holt neue Tags; Hooks im Repo laufen als root nicht', () => {
  const s = setup();
  try {
    writeFileSync(join(s.up, 'post-update.sh'), '#!/bin/bash\n# DVHUB_ROOT_OWNED_INSTALL v2\n');
    git(s.up, 'commit', '-qam', 'v2'); git(s.up, 'tag', 'v1.2.0');
    const hook = join(s.inst, '.git', 'hooks', 'post-checkout');
    writeFileSync(hook, `#!/bin/sh\ntouch "${s.dir}/hook-ran"\n`);
    chmodSync(hook, 0o755);
    assert.equal(s.run('fetch').status, 0);
    const r = s.run('checkout-tag', 'v1.2.0');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(join(s.dir, 'hook-ran')), false);
  } finally { s.cleanup(); }
});

test('stash: nur versionierte Änderungen, Laufzeitordner bleiben; stash-pop holt sie zurück', () => {
  const s = setup();
  try {
    writeFileSync(join(s.inst, 'post-update.sh'), '#!/bin/bash\n# DVHUB_ROOT_OWNED_INSTALL lokal geändert\n');
    mkdirSync(join(s.inst, 'eos-venv', 'bin'), { recursive: true });
    writeFileSync(join(s.inst, 'eos-venv', 'bin', 'python'), 'x');
    const r = s.run('stash');
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(readFileSync(join(s.inst, 'post-update.sh'), 'utf8'), /lokal/);
    assert.ok(existsSync(join(s.inst, 'eos-venv', 'bin', 'python')), 'eos-venv bleibt');
    assert.match(s.run('stash').stdout, /No local changes/);
    assert.equal(s.run('stash-pop').status, 0);
    assert.match(readFileSync(join(s.inst, 'post-update.sh'), 'utf8'), /lokal/);
  } finally { s.cleanup(); }
});

test('npm-install: Marker vorher weg, nach Erfolg = Lockfile-Hash, HOME von root', () => {
  const s = setup();
  try {
    const marker = join(s.inst, '.npm-install-hash');
    writeFileSync(marker, 'alt\n');
    writeFileSync(join(s.dir, 'npm-fails'), '');
    assert.notEqual(s.run('npm-install').status, 0);
    assert.equal(existsSync(marker), false, 'nach Abbruch kein Marker');
    rmSync(join(s.dir, 'npm-fails'));
    assert.equal(s.run('npm-install').status, 0);
    const want = execFileSync('sha256sum', [join(s.inst, 'dvhub', 'package-lock.json')], { encoding: 'utf8' }).split(' ')[0];
    assert.equal(readFileSync(marker, 'utf8').trim(), want);
    assert.match(readFileSync(join(s.dir, 'npm.log'), 'utf8'), /^npm install --omit=dev HOME=/m);
  } finally { s.cleanup(); }
});

// ── Gegenprüfung 948b0e6a (P3) / c784e6a1 (P2) ──
// Der execFile-Timeout der Oberfläche beendete nur sudo; npm lief weiter und
// stieß mit dem Rückweg (checkout-commit + zweites npm-install) zusammen. Und
// die Hintergrund-Unit dvhub-npm-install aus post-update.sh konnte parallel zu
// einem Update aus der Oberfläche npm ausführen. Jetzt: npm mit eigener
// Zeitgrenze, TERM an den Einstieg beendet npm mit, und eine gemeinsame Sperre
// (flock) für alle ändernden Schritte.
function lockRig(s, { busy = false } = {}) {
  const bin = join(s.dir, 'bin');
  // flock-Attrappe: belegt, solange die Datei "busy" existiert.
  writeFileSync(join(bin, 'flock'), `#!/usr/bin/env bash\necho "flock $*" >> "${s.dir}/flock.log"\n[[ -e "${s.dir}/busy" ]] && exit 1\nexit 0\n`);
  chmodSync(join(bin, 'flock'), 0o755);
  writeFileSync(join(bin, 'timeout'), `#!/usr/bin/env bash\necho "timeout $*" >> "${s.dir}/timeout.log"\nshift 3\nexec "$@"\n`);
  chmodSync(join(bin, 'timeout'), 0o755);
  if (busy) writeFileSync(join(s.dir, 'busy'), '');
  const env = { DVHUB_UPDATE_TEST_LOCK: join(s.dir, 'update.lock'), DVHUB_UPDATE_TEST_RESTART_FLAG: join(s.dir, 'npm-restart') };
  return env;
}

test('Sperre belegt (npm im Hintergrund): ändernde Schritte → Exit 4, nichts geändert; Neustart-Merker der Hintergrund-Unit weg', () => {
  const s = setup();
  try {
    const env = lockRig(s, { busy: true });
    writeFileSync(env.DVHUB_UPDATE_TEST_RESTART_FLAG, '');
    for (const args of [['npm-install'], ['checkout-tag', 'v1.1.0'], ['checkout-commit', s.newSha], ['checkout-main'], ['fetch'], ['stash'], ['stash-pop']]) {
      const r = s.runEnv(env, ...args);
      assert.equal(r.status, 4, `${args.join(' ')} → ${r.status} ${r.stderr}`);
      assert.match(r.stderr, /läuft bereits/);
    }
    assert.equal(existsSync(join(s.dir, 'npm.log')), false, 'npm nicht gestartet');
    assert.equal(existsSync(env.DVHUB_UPDATE_TEST_RESTART_FLAG), false, 'Hintergrund-Unit startet DVhub nicht mitten im Update neu');
    assert.match(readFileSync(join(s.dir, 'flock.log'), 'utf8'), /-w \d+ 9/);
  } finally { s.cleanup(); }
});

test('npm-install: eigene Zeitgrenze unter der der Oberfläche (10 min)', () => {
  const s = setup();
  try {
    const env = lockRig(s);
    assert.equal(s.runEnv(env, 'npm-install').status, 0);
    const t = readFileSync(join(s.dir, 'timeout.log'), 'utf8').trim();
    const m = t.match(/^timeout -k (\d+) (\d+) env HOME=\S+ npm install --omit=dev$/);
    assert.ok(m, t);
    assert.ok(Number(m[1]) + Number(m[2]) + 120 < 600, 'Sperr-Wartezeit + npm + Nachlauf < 10 min');
  } finally { s.cleanup(); }
});

test('TERM an den Einstieg (Timeout der Oberfläche) beendet npm mit', async () => {
  const s = setup();
  try {
    const env = lockRig(s);
    const bin = join(s.dir, 'bin');
    writeFileSync(join(bin, 'npm'), `#!/usr/bin/env bash\necho $$ > "${s.dir}/npm.pid"\nexec sleep 30\n`);
    chmodSync(join(bin, 'npm'), 0o755);
    const { spawn } = await import('node:child_process');
    const child = spawn('bash', [SCRIPT, 'npm-install'], {
      env: { PATH: `${bin}:${process.env.PATH}`, ...GIT_ENV, DVHUB_UPDATE_TEST_INSTALL_DIR: s.inst, DVHUB_UPDATE_TEST_EUID: '0', DVHUB_UPDATE_TEST_HOME: s.dir, ...env },
      stdio: 'ignore',
    });
    const pidFile = join(s.dir, 'npm.pid');
    for (let i = 0; i < 50 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 100));
    const npmPid = Number(readFileSync(pidFile, 'utf8'));
    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r));
    let alive = true;
    for (let i = 0; i < 30 && alive; i++) {
      try { process.kill(npmPid, 0); await new Promise((r) => setTimeout(r, 100)); } catch { alive = false; }
    }
    if (alive) process.kill(npmPid, 'SIGKILL');
    assert.equal(alive, false, 'npm läuft nach dem Abbruch nicht weiter');
    assert.equal(existsSync(join(s.inst, '.npm-install-hash')), false, 'kein Marker');
  } finally { s.cleanup(); }
});
