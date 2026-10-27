// test/eos-provision-git.test.js -- EOS-Checkout: Pin, Sicherung, Austausch.
// Review 25.10.2026:
//  P2: root (systemd-run) durfte im Checkout des Dienstbenutzers kein git
//      ausführen (safe.directory). Die Sicherung lokaler Änderungen lief darum
//      ins Leere, und `rm -rf $EOS_DIR` kam, bevor feststand, dass der neue
//      Klon gelingt.
//  P3: ein nicht vorhandener EOS_PIN installierte still den upstream-HEAD und
//      trug ihn als Pin ein.
// GIT_TEST_ASSUME_DIFFERENT_OWNER=1 lässt git so tun, als gehöre der Checkout
// einem anderen Benutzer — genau die Lage von root im dvhub-eigenen Ordner.
// python3/pip/systemctl sind Attrappen; das "Upstream-Repo" ist ein lokales.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'eos-provision.sh');
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'dvhub-eosprov-'));
  const upstream = join(dir, 'upstream');
  mkdirSync(upstream);
  git(upstream, 'init', '-q', '-b', 'main');
  writeFileSync(join(upstream, 'pyproject.toml'), 'v = 1\n');
  git(upstream, 'add', '.'); git(upstream, 'commit', '-qm', 'one'); git(upstream, 'tag', 'v1');
  writeFileSync(join(upstream, 'pyproject.toml'), 'v = 2\n');
  git(upstream, 'commit', '-qam', 'two'); git(upstream, 'tag', 'v2');
  writeFileSync(join(upstream, 'pyproject.toml'), 'v = 3 (HEAD, kein Release)\n');
  git(upstream, 'commit', '-qam', 'three');

  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const log = join(dir, 'calls.log');
  const fake = (name, body = '') => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\necho "${name} $*" >> "${log}"\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  fake('python3', `if [[ "$1" == -m && "$2" == venv ]]; then
  mkdir -p "$3/bin"
  printf '#!/usr/bin/env bash\\necho "pip $*" >> "${log}"\\n[[ -e "${dir}/pip-fails" ]] && exit 1\\nexit 0\\n' > "$3/bin/pip"
  printf '#!/usr/bin/env bash\\necho 0\\n' > "$3/bin/python"
  chmod +x "$3/bin/pip" "$3/bin/python"
fi
exit 0`);
  fake('systemctl'); fake('chown'); fake('timedatectl', 'echo Europe/Berlin');
  // Zeitstempel-Ordner: jeder Aufruf eine neue Sekunde (sonst fielen zwei
  // Versuche in denselben Ordner).
  writeFileSync(join(bin, 'date'), `#!/usr/bin/env bash
if [[ "$1" == "+%Y%m%d-%H%M%S" && -n "\${DATE_FIXED:-}" ]]; then echo "$DATE_FIXED"; exit 0; fi
if [[ "$1" == "+%Y%m%d-%H%M%S" ]]; then n=$(( $(cat "${dir}/date-n" 2>/dev/null || echo 0) + 1 )); echo $n > "${dir}/date-n"; printf '20261025-%06d\\n' $n; exit 0; fi
exec /bin/date "$@"
`);
  chmodSync(join(bin, 'date'), 0o755);
  const install = join(dir, 'opt');
  mkdirSync(install);
  const env = (pin) => ({
    PATH: `${bin}:${process.env.PATH}`, ...GIT_ENV, HOME: dir,
    GIT_TEST_ASSUME_DIFFERENT_OWNER: '1',
    EOS_PROVISION_EUID: '0', INSTALL_DIR: install, DATA_DIR: join(dir, 'data'),
    EOS_REPO_URL: `file://${upstream}`, EOS_PIN: pin, EOS_HOME: join(dir, 'eos-home'),
    EOS_ENV_FILE: join(dir, 'eos.env'), EOS_UNIT_FILE: join(dir, 'eos.service'),
  });
  const run = (pin, extra = {}) => spawnSync('bash', [SCRIPT], { env: { ...env(pin), ...extra }, encoding: 'utf8' });
  const eosDir = join(install, 'eos');
  const head = () => execFileSync('git', ['-c', `safe.directory=${eosDir}`, '-C', eosDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const marker = () => (existsSync(join(dir, 'data', '.eos-provisioned')) ? readFileSync(join(dir, 'data', '.eos-provisioned'), 'utf8').trim() : null);
  return {
    dir, upstream, install, eosDir, run, head, marker,
    tagSha: (t) => git(upstream, 'rev-parse', `${t}^{commit}`),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('frische Installation: genau der gepinnte Tag, Marker gesetzt', () => {
  const s = setup();
  try {
    const r = s.run('v1');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(s.head(), s.tagSha('v1'));
    assert.equal(s.marker(), `file://${s.upstream}@v1`);
    // Review 25.10.2026 (P1): Checkout und venv gehören root, nicht dem Dienst.
    const calls = readFileSync(join(s.dir, 'calls.log'), 'utf8');
    assert.match(calls, new RegExp(`^chown -R 0:0 ${s.eosDir}$`, 'm'));
    assert.doesNotMatch(calls, new RegExp(`^chown -R dvhub\\S* ${s.install}/eos`, 'm'), 'EOS-Daten (EOS_HOME) dürfen dem Dienst gehören, Code nicht');
  } finally { s.cleanup(); }
});

test('P3: unbekannter Pin bricht ab — kein upstream-HEAD, kein Marker', () => {
  const s = setup();
  try {
    const r = s.run('v9.9.9');
    assert.notEqual(r.status, 0, 'muss fehlschlagen');
    assert.equal(s.marker(), null, 'kein Pin eingetragen');
    assert.equal(existsSync(join(s.eosDir, 'pyproject.toml')), false, 'kein Checkout von HEAD');
  } finally { s.cleanup(); }
});

test('P2: unbekannter neuer Pin lässt den vorhandenen Checkout stehen', () => {
  const s = setup();
  try {
    assert.equal(s.run('v1').status, 0);
    const r = s.run('v9.9.9');
    assert.notEqual(r.status, 0);
    assert.equal(s.head(), s.tagSha('v1'), 'alter Stand bleibt');
    assert.equal(s.marker(), `file://${s.upstream}@v1`, 'Marker unverändert');
    assert.deepEqual(readdirSync(s.install).filter((n) => n.startsWith('.eos-')), [], 'kein Klon-Rest');
  } finally { s.cleanup(); }
});

test('P2: lokale Änderungen werden vor dem Versionswechsel gesichert (git läuft trotz fremdem Besitzer)', () => {
  const s = setup();
  try {
    assert.equal(s.run('v1').status, 0);
    writeFileSync(join(s.eosDir, 'pyproject.toml'), 'v = 1 + lokaler Patch\n');
    const r = s.run('v2');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(s.head(), s.tagSha('v2'));
    const backups = join(s.dir, 'data', 'eos-backups');
    const patchDirs = readdirSync(backups).filter((n) => existsSync(join(backups, n, 'local-changes.patch')));
    assert.equal(patchDirs.length, 1, `Sicherung angelegt (${readdirSync(backups)})`);
    assert.match(readFileSync(join(backups, patchDirs[0], 'local-changes.patch'), 'utf8'), /lokaler Patch/);
  } finally { s.cleanup(); }
});

test('Commit-SHA als Pin funktioniert weiter', () => {
  const s = setup();
  try {
    const sha = s.tagSha('v2');
    const r = s.run(sha);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(s.head(), sha);
  } finally { s.cleanup(); }
});

// Gegenprüfung zu 282737f4: ein unbekannter Pin scheitert bei JEDEM Dienststart
// erneut — die Daten-Sicherung vor dem Versionswechsel darf darum erst laufen,
// wenn der neue Stand geholt ist, und je Pin nur einmal.
test('unbekannter Pin: keine Daten-Sicherung, auch nicht nach mehreren Versuchen', () => {
  const s = setup();
  try {
    assert.equal(s.run('v1').status, 0);
    mkdirSync(join(s.dir, 'eos-home'), { recursive: true });
    writeFileSync(join(s.dir, 'eos-home', 'measurements.db'), 'x'.repeat(1000));
    for (let i = 0; i < 3; i++) assert.notEqual(s.run('v9.9.9').status, 0);
    const backups = join(s.dir, 'data', 'eos-backups');
    assert.deepEqual(existsSync(backups) ? readdirSync(backups) : [], []);
  } finally { s.cleanup(); }
});

test('Daten-Sicherung vor einem Versionswechsel nur einmal je Pin', () => {
  const s = setup();
  try {
    assert.equal(s.run('v1').status, 0);
    mkdirSync(join(s.dir, 'eos-home'), { recursive: true });
    writeFileSync(join(s.dir, 'eos-home', 'measurements.db'), 'daten');
    // pip scheitert beim ersten Versuch → Marker bleibt alt → zweiter Versuch.
    writeFileSync(join(s.dir, 'pip-fails'), '');
    assert.notEqual(s.run('v2').status, 0);
    rmSync(join(s.dir, 'pip-fails'));
    assert.equal(s.run('v2').status, 0);
    const backups = readdirSync(join(s.dir, 'data', 'eos-backups')).filter((n) => n.includes('data-before-v2'));
    assert.equal(backups.length, 1, String(backups));
    assert.equal(readFileSync(join(s.dir, 'data', 'eos-backups', backups[0], 'measurements.db'), 'utf8'), 'daten');
  } finally { s.cleanup(); }
});

test('git status im Checkout scheitert → Checkout bleibt, keine Neu-Klon-Ersetzung', () => {
  const s = setup();
  try {
    assert.equal(s.run('v1').status, 0);
    writeFileSync(join(s.eosDir, 'pyproject.toml'), 'lokaler Patch\n');
    // Index unlesbar machen: git status scheitert, fetch geht noch.
    writeFileSync(join(s.eosDir, '.git', 'index'), 'kaputt');
    const r = s.run('v2');
    assert.notEqual(r.status, 0, 'muss abbrechen statt den Ordner zu ersetzen');
    assert.equal(readFileSync(join(s.eosDir, 'pyproject.toml'), 'utf8'), 'lokaler Patch\n');
  } finally { s.cleanup(); }
});

test('lokale Änderungen + unbekannter Pin: keine neue Sicherung je Versuch', () => {
  const s = setup();
  try {
    assert.equal(s.run('v1').status, 0);
    writeFileSync(join(s.eosDir, 'pyproject.toml'), 'lokaler Patch\n');
    for (let i = 0; i < 3; i++) assert.notEqual(s.run('v9.9.9').status, 0);
    const backups = join(s.dir, 'data', 'eos-backups');
    assert.deepEqual(existsSync(backups) ? readdirSync(backups) : [], []);
    assert.equal(readFileSync(join(s.eosDir, 'pyproject.toml'), 'utf8'), 'lokaler Patch\n', 'Patch bleibt stehen');
  } finally { s.cleanup(); }
});

// Gegenprüfung zu 62dd5121.
test('Sicherung scheitert (Ziel nicht beschreibbar) → Abbruch, Patch bleibt im Checkout', () => {
  const s = setup();
  try {
    assert.equal(s.run('v1').status, 0);
    writeFileSync(join(s.eosDir, 'pyproject.toml'), 'lokaler Patch\n');
    const ro = join(s.dir, 'ro');
    mkdirSync(ro); chmodSync(ro, 0o555);
    const r = s.run('v2', { EOS_BACKUP_ROOT: join(ro, 'eos-backups') });
    chmodSync(ro, 0o755);
    assert.notEqual(r.status, 0, 'muss abbrechen');
    assert.equal(readFileSync(join(s.eosDir, 'pyproject.toml'), 'utf8'), 'lokaler Patch\n');
    assert.equal(s.head(), s.tagSha('v1'));
  } finally { s.cleanup(); }
});

test('untracked und vorgemerkte (staged) Änderungen landen in der Sicherung', () => {
  const s = setup();
  try {
    assert.equal(s.run('v1').status, 0);
    writeFileSync(join(s.eosDir, 'eigene.py'), 'untracked\n');
    writeFileSync(join(s.eosDir, 'pyproject.toml'), 'staged Patch\n');
    execFileSync('git', ['-C', s.eosDir, 'add', 'pyproject.toml']);
    assert.equal(s.run('v2').status, 0);
    const root = join(s.dir, 'data', 'eos-backups');
    const d = readdirSync(root).find((n) => existsSync(join(root, n, 'local-changes.patch')));
    assert.ok(d, String(readdirSync(root)));
    assert.match(readFileSync(join(root, d, 'local-changes.patch'), 'utf8'), /staged Patch/);
    assert.equal(readFileSync(join(root, d, 'files', 'eigene.py'), 'utf8'), 'untracked\n');
  } finally { s.cleanup(); }
});

test('Daten-Sicherung: abgebrochene Kopie zählt nicht; Rückweg v2→v1→v2 sichert erneut', () => {
  const s = setup();
  try {
    assert.equal(s.run('v1').status, 0);
    mkdirSync(join(s.dir, 'eos-home'), { recursive: true });
    writeFileSync(join(s.dir, 'eos-home', 'measurements.db'), 'daten');
    // halbe Kopie eines früheren Versuchs
    const root = join(s.dir, 'data', 'eos-backups');
    mkdirSync(join(root, '20261024-000000-data-before-v2.partial'), { recursive: true });
    assert.equal(s.run('v2').status, 0);
    assert.equal(s.run('v1').status, 0);
    writeFileSync(join(s.dir, 'eos-home', 'measurements.db'), 'neuere daten');
    assert.equal(s.run('v2').status, 0);
    const done = readdirSync(root).filter((n) => !n.endsWith('.partial') && /data-before/.test(n));
    assert.equal(done.length, 3, String(done));
    assert.ok(done.some((n) => readFileSync(join(root, n, 'measurements.db'), 'utf8') === 'neuere daten'));
    // Gegenprüfung 3c860448 (P3): die halbe Kopie eines abgebrochenen Laufs bleibt nicht liegen.
    assert.deepEqual(readdirSync(root).filter((n) => n.endsWith('.partial')), []);
  } finally { s.cleanup(); }
});

// ── Gegenprüfung 3c860448 ──
// P2: die Daten-Sicherung lief erst NACH dem Umstellen des Checkouts. Scheiterte
// sie (SD-Karte voll), endete das Skript mit „alter Stand läuft weiter“ — der
// Checkout war aber schon neu, das venv alt; der nächste Start lief mit neuem
// Code und ohne Sicherung in die Migration.
test('Daten-Sicherung scheitert → Checkout bleibt auf dem alten Stand', () => {
  const s = setup();
  try {
    assert.equal(s.run('v1').status, 0);
    mkdirSync(join(s.dir, 'eos-home'), { recursive: true });
    writeFileSync(join(s.dir, 'eos-home', 'measurements.db'), 'daten');
    const ro = join(s.dir, 'ro');
    mkdirSync(ro); chmodSync(ro, 0o555);
    const r = s.run('v2', { EOS_BACKUP_ROOT: join(ro, 'eos-backups') });
    chmodSync(ro, 0o755);
    assert.notEqual(r.status, 0);
    assert.equal(s.head(), s.tagSha('v1'), 'Checkout nicht umgestellt');
    assert.equal(s.marker(), `file://${s.upstream}@v1`);
  } finally { s.cleanup(); }
});

// P3: Dateinamen mit Umlauten (git quotet sie) ließen jede spätere Sicherung scheitern.
test('untracked Datei mit Umlaut im Namen wird gesichert, Update läuft durch', () => {
  const s = setup();
  try {
    assert.equal(s.run('v1').status, 0);
    writeFileSync(join(s.eosDir, 'größe.py'), 'x\n');
    const r = s.run('v2');
    assert.equal(r.status, 0, r.stderr);
    const root = join(s.dir, 'data', 'eos-backups');
    const d = readdirSync(root).find((n) => existsSync(join(root, n, 'files')));
    assert.ok(d && existsSync(join(root, d, 'files', 'größe.py')), String(readdirSync(root)));
  } finally { s.cleanup(); }
});

// P3: Untracked Datei blockiert den Checkout → Neu-Klon → zweite Sicherung in
// derselben Sekunde überschrieb den Patch mit einem leeren.
test('zweite Sicherung im selben Lauf überschreibt den Patch nicht', () => {
  const s = setup();
  try {
    assert.equal(s.run('v1').status, 0);
    writeFileSync(join(s.upstream, 'neu.py'), 'upstream\n');
    git(s.upstream, 'add', 'neu.py'); git(s.upstream, 'commit', '-qm', 'neu'); git(s.upstream, 'tag', 'v4');
    writeFileSync(join(s.eosDir, 'pyproject.toml'), 'lokaler Patch\n');
    writeFileSync(join(s.eosDir, 'neu.py'), 'lokal, im Weg\n');
    const r = s.run('v4', { DATE_FIXED: '20261025-120000' });
    assert.equal(r.status, 0, r.stderr);
    const patch = readFileSync(join(s.dir, 'data', 'eos-backups', '20261025-120000', 'local-changes.patch'), 'utf8');
    assert.match(patch, /lokaler Patch/);
    assert.equal(readFileSync(join(s.dir, 'data', 'eos-backups', '20261025-120000', 'files', 'neu.py'), 'utf8'), 'lokal, im Weg\n');
  } finally { s.cleanup(); }
});
