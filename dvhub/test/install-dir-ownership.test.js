// test/install-dir-ownership.test.js -- /opt/dvhub gehört root (Review 25.10.2026, P1).
// root führt daraus bei jedem Dienststart post-update.sh, node-runtime-
// provision.sh, scripts/reconcile-vendor-profiles.mjs, die libexec-Kopien und
// die Provisionierung (pip -e, build-go.sh) aus. Gehörte der Ordner dem
// Dienstbenutzer (früher chown -R), könnte der sie vorher ändern.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

function ownershipBlock(file) {
  const s = read(file);
  const a = s.indexOf('# BEGIN DVHUB INSTALL-DIR OWNERSHIP');
  const b = s.indexOf('# END DVHUB INSTALL-DIR OWNERSHIP');
  assert.ok(a >= 0 && b > a, `Block in ${file}`);
  return s.slice(a, b);
}

test('kein chown des Programmordners an den Dienstbenutzer (install.sh, post-update.sh, Provisionierung)', () => {
  for (const f of ['install.sh', 'post-update.sh']) {
    const s = read(f);
    assert.doesNotMatch(s, /chown -R "\$SERVICE_USER:\$SERVICE_USER"[^\n]*"\$INSTALL_DIR"/, f);
  }
  assert.doesNotMatch(read('eos-provision.sh'), /chown -R "\$SERVICE_USER:\$SERVICE_USER" "\$EOS_VENV"/);
  assert.doesNotMatch(read('forecast-provision.sh'), /chown -R "\$SERVICE_USER:\$SERVICE_USER" "\$VENV_DIR"/);
});

test('sudoers: keine Regel auf eine Datei im Programmordner; Update nur über dvhub-update', () => {
  const s = read('post-update.sh');
  const blk = s.slice(s.indexOf('BEGIN DVHUB SUDOERS'), s.indexOf('END DVHUB SUDOERS'));
  const rules = blk.split('\n').filter((l) => l.startsWith('${SERVICE_USER} ALL='));
  assert.deepEqual(rules.filter((l) => l.includes('${INSTALL_DIR}')), []);
  assert.ok(rules.some((l) => l.endsWith('${UPDATE_HELPER_PATH} post-update')));
});

test('post-update.sh: Rechte-Schritt vor dem ersten Skript aus dem Programmordner; Untergrenzen-Marke vorhanden', () => {
  const s = read('post-update.sh');
  const call = s.indexOf('dvhub_root_own_install_dir "$INSTALL_DIR"');
  const firstExec = Math.min(...['bash "$INSTALL_DIR/', 'node "$INSTALL_DIR/', 'install -o root -g root -m 0755 "$INSTALL_DIR/']
    .map((n) => s.indexOf(n)).filter((i) => i >= 0));
  assert.ok(call > 0 && call < firstExec, `Aufruf ${call} vor erster Ausführung ${firstExec}`);
  assert.match(s, /DVHUB_ROOT_OWNED_INSTALL/, 'dvhub-update prüft diese Marke als Untergrenze');
  const i = read('install.sh');
  const iCall = i.indexOf('\ndvhub_root_own_install_dir "$INSTALL_DIR"');
  assert.ok(iCall > 0 && iCall < i.indexOf('npm install --omit=dev') && iCall < i.indexOf('( install_forecast )'));
});

test('Docker: Programmcode und reconcile-Skript gehören nicht dvhub', () => {
  const d = read('Dockerfile');
  assert.doesNotMatch(d, /COPY [^\n]*--chown=dvhub/);
});

function runBlock(dir, extra = {}) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const log = join(dir, 'calls.log');
  for (const name of ['chown', 'chmod']) {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\necho "${name} $*" >> "${log}"\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const inst = join(dir, 'opt');
  const sh = `set -euo pipefail\n${ownershipBlock('post-update.sh')}\ndvhub_root_own_install_dir '${inst}'\n`;
  const r = spawnSync('bash', ['-c', sh], {
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, GIT_CONFIG_SYSTEM: join(dir, 'gitconfig-system'), ...extra },
  });
  return { r, calls: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [], inst };
}

test('Rechte-Block: fremder Besitz → chown -R 0:0 + chmod go-w,a+rX, Marker, systemweites safe.directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dvhub-own-'));
  try {
    const inst = join(dir, 'opt');
    mkdirSync(join(inst, 'dvhub'), { recursive: true });
    execFileSync('git', ['init', '-q', inst]);
    writeFileSync(join(inst, 'post-update.sh'), '#\n');
    const { r, calls } = runBlock(dir);
    assert.equal(r.status, 0, r.stderr);
    // Der Testlauf gehört nicht root → der Block muss umstellen.
    assert.deepEqual(calls, [`chown -R 0:0 ${inst}`, `chmod -R go-w,a+rX ${inst}`]);
    assert.equal(readFileSync(join(inst, '.root-owned-rev'), 'utf8').trim(), 'nogit');
    assert.match(readFileSync(join(dir, 'gitconfig-system'), 'utf8'), new RegExp(`directory = ${inst.replace(/[/.]/g, '\\$&')}`));
    // Zweiter Lauf: safe.directory nicht doppelt.
    runBlock(dir);
    assert.equal(readFileSync(join(dir, 'gitconfig-system'), 'utf8').split('directory =').length - 1, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
