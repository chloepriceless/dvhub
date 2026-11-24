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
import { assertWritableConfigDir, assertNoStrayConfigInCheckout, unitEnv } from './helpers/eos-unit.js';

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

// T-0415 (1.0.10): Update von Vanilla-EOS v0.4.0rc3 (Akkudoktor) auf DVhub-EOS
// (Fork chloepriceless/EOS, Git-Tag dvhub-eos-<upstream-version>-dvhub.<N>).
// Die upstream-Version von main (0.3.0.dev…) ist kleiner als 0.4.0rc3 —
// gezählt wird nur „anders als installiert“, nie „älter“.
test('Wechsel Vanilla → DVhub-EOS (anderes Repo, Tag mit Präfix) und zurück', () => {
  const s = setup();
  const fork = join(s.dir, 'fork');
  try {
    git(s.upstream, 'tag', 'v0.4.0rc3', 'v2');
    git(s.dir, 'clone', '-q', s.upstream, fork);
    writeFileSync(join(fork, 'pyproject.toml'), 'v = dvhub-eos\n');
    git(fork, 'commit', '-qam', 'dvhub-eos/main');
    const forkTag = 'dvhub-eos-0.3.0.dev2611110839161148-dvhub.1';
    git(fork, 'tag', forkTag);
    const forkEnv = { EOS_REPO_URL: `file://${fork}` };
    const eosGit = (...a) => execFileSync('git', ['-c', `safe.directory=${s.eosDir}`, '-C', s.eosDir, ...a], { encoding: 'utf8' }).trim();

    assert.equal(s.run('v0.4.0rc3').status, 0);
    mkdirSync(join(s.dir, 'eos-home'), { recursive: true });
    writeFileSync(join(s.dir, 'eos-home', 'EOS.config.json'), '{"general":{"version":"0.4.0rc3"}}');

    const up = s.run(forkTag, forkEnv);
    assert.equal(up.status, 0, up.stderr);
    assert.equal(s.head(), git(fork, 'rev-parse', `${forkTag}^{commit}`));
    assert.equal(s.marker(), `file://${fork}@${forkTag}`);
    assert.equal(eosGit('remote', 'get-url', 'origin'), `file://${fork}`, 'origin zeigt auf den Fork');
    assert.match(up.stdout, /Versionswechsel file:\/\/\S+@v0\.4\.0rc3 -> file:\/\/\S+@dvhub-eos-/);
    assert.match(up.stdout, /venv wird wegen Versionswechsel neu gebaut/);
    const backups = readdirSync(join(s.dir, 'data', 'eos-backups')).filter((n) => n.includes(`data-before-${forkTag}`));
    assert.equal(backups.length, 1, 'EOS-Konfiguration vor dem Wechsel gesichert');

    // Rückweg (Downgrade auf 1.0.9 → Pin wieder rc3): ebenso nur „anders“.
    const back = s.run('v0.4.0rc3');
    assert.equal(back.status, 0, back.stderr);
    assert.equal(s.head(), s.tagSha('v0.4.0rc3'));
    assert.equal(s.marker(), `file://${s.upstream}@v0.4.0rc3`);
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

// ── Fehlerklasse: Native-Install/Umstieg Permission- und Config-Pfad-Fallen ──
// Tester-Fund 1.0.10 (Pi 4B, Debian 13): nach dem Umstieg gehört der Checkout
// root, dort lag eine Alt-EOS.config.json. eos.service startet mit
// WorkingDirectory=<Checkout> als Dienstbenutzer, ohne EOS_CONFIG_DIR → EOS
// nimmt die CWD-Datei und scheitert jede Minute mit PermissionError.
// Diese Tests stellen genau das nach und schlagen gegen den Stand VOR dem Fix
// fehl (kein EOS_CONFIG_DIR in der Unit, Alt-Datei bleibt im Checkout liegen).
test('Umstieg: Alt-Konfig im root-eigenen Checkout wird migriert, Unit setzt beschreibbaren EOS_CONFIG_DIR', () => {
  const s = setup();
  try {
    // 1. Erstinstallation (Checkout entsteht, gehört via faked chown „root").
    assert.equal(s.run('v1').status, 0);
    // 2. Tester-Lage nachstellen: liegengebliebene Alt-Konfig im Checkout (= CWD).
    const stray = join(s.eosDir, 'EOS.config.json');
    const strayBody = '{"general":{"version":"0.0.1-alt"}}';
    writeFileSync(stray, strayBody);
    // 3. Erneute Provisionierung (gleicher Pin → Checkout bleibt, Datei ist untracked).
    assert.equal(s.run('v1').status, 0, 'zweiter Lauf fehlerfrei');
    const unit = readFileSync(join(s.dir, 'eos.service'), 'utf8');
    // (a) Unit setzt EOS_CONFIG_DIR auf ein beschreibbares Dir, NICHT den Checkout.
    const cfgDir = assertWritableConfigDir(unit, { notEqualTo: s.eosDir });
    // (b) Alt-Datei ist aus dem Checkout verschwunden und migriert.
    assertNoStrayConfigInCheckout(s.eosDir);
    assert.ok(existsSync(join(cfgDir, 'EOS.config.json')), 'Alt-Konfig wurde in den Config-Ordner migriert');
    assert.equal(readFileSync(join(cfgDir, 'EOS.config.json'), 'utf8'), strayBody, 'Inhalt unverändert übernommen');
  } finally { s.cleanup(); }
});

test('frische Installation ohne Alt-Konfig: Unit setzt trotzdem beschreibbaren EOS_CONFIG_DIR, Ordner existiert', () => {
  const s = setup();
  try {
    assert.equal(s.run('v1').status, 0);
    const unit = readFileSync(join(s.dir, 'eos.service'), 'utf8');
    assertWritableConfigDir(unit, { notEqualTo: s.eosDir });
    assertNoStrayConfigInCheckout(s.eosDir);
  } finally { s.cleanup(); }
});

test('Standard-Install ohne EOS_HOME: EOS_CONFIG_DIR gesetzt + angelegt, keine App-EOS_DIR', () => {
  const s = setup();
  try {
    // getent fehlt auf dem Test-Host (macOS) → Default /home/dvhub/.config wäre
    // nicht anlegbar; darum den beschreibbaren Pfad explizit vorgeben (so wie ihn
    // ein Betreiber per Env setzen könnte). EOS_HOME leer = Standard-Install.
    const cfg = join(s.dir, 'xdg-cfg', 'net.akkudoktor.eos');
    assert.equal(s.run('v1', { EOS_HOME: '', EOS_CONFIG_DIR: cfg }).status, 0);
    const unit = readFileSync(join(s.dir, 'eos.service'), 'utf8');
    assert.equal(unitEnv(unit, 'EOS_CONFIG_DIR'), cfg, 'übergebener Config-Dir landet in der Unit');
    assert.ok(!/^Environment=EOS_DIR=/m.test(unit), 'ohne EOS_HOME keine App-EOS_DIR-Zeile (zweite Instanz unberührt)');
    assert.ok(existsSync(cfg), 'Config-Dir wurde angelegt');
    assertWritableConfigDir(unit, { notEqualTo: s.eosDir });
  } finally { s.cleanup(); }
});

// A2 (1.0.11): die einmalige Übernahme von Zusatz-Environment-Zeilen aus einer
// alten Unit nach /etc/dvhub/eos.env darf EOS_CONFIG_DIR (und EOS_DIR) NICHT
// mitnehmen. Täte sie es, überschriebe EnvironmentFile die in der Unit frisch
// gesetzte Environment=EOS_CONFIG_DIR-Zeile → der Ordner friert auf dem alten
// Wert ein, und eine zweite Instanz (teilt eos.env) erbte den falschen Ordner.
// ROT gegen den Stand vor A2 (EOS_CONFIG_DIR/EOS_DIR nicht in der Ausschluss-Regex).
test('A2: Zweitlauf friert EOS_CONFIG_DIR/EOS_DIR NICHT in eos.env ein', () => {
  const s = setup();
  const envFile = join(s.dir, 'eos.env');
  try {
    assert.equal(s.run('v1').status, 0, 'erster Lauf (schreibt Unit mit EOS_CONFIG_DIR/EOS_DIR)');
    // Sicherstellen, dass die erste Unit beide Zeilen trägt (EOS_HOME gesetzt → EOS_DIR).
    const unit1 = readFileSync(join(s.dir, 'eos.service'), 'utf8');
    assert.ok(unitEnv(unit1, 'EOS_CONFIG_DIR'), 'Unit setzt EOS_CONFIG_DIR');
    assert.ok(/^Environment=EOS_DIR=/m.test(unit1), 'Unit setzt EOS_DIR (EOS_HOME gesetzt)');
    // Zweiter Lauf: die Übernahme-Logik greift (Unit da, eos.env fehlt noch).
    assert.equal(s.run('v1').status, 0, 'zweiter Lauf');
    const envTxt = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
    assert.ok(!/(^|\n)EOS_CONFIG_DIR=/.test(envTxt), `EOS_CONFIG_DIR darf nicht nach eos.env eingefroren werden:\n${envTxt}`);
    assert.ok(!/(^|\n)EOS_DIR=/.test(envTxt), `EOS_DIR darf nicht nach eos.env eingefroren werden:\n${envTxt}`);
  } finally { s.cleanup(); }
});

// A1 (1.0.11): leichter Nachzieh-Lauf (EOS_CONFIG_FIX_ONLY=1), wie ihn
// post-update.sh für Bestandsboxen entkoppelt startet. Zieht NUR Konfig-Ordner,
// Alt-Konfig-Migration und die Unit (mit EOS_CONFIG_DIR) nach — ohne git/clone/pip.
test('A1 leicht: EOS_CONFIG_FIX_ONLY zieht Unit+Migration nach, ohne git/pip, BACKEND bleibt', () => {
  const s = setup();
  try {
    // Gesunde Bestandsbox herstellen (Checkout + venv), dann die Unit auf den
    // 1.0.10-Stand zurücksetzen: OHNE EOS_CONFIG_DIR, MIT BACKEND=native.
    assert.equal(s.run('v1').status, 0);
    const unitFile = join(s.dir, 'eos.service');
    writeFileSync(unitFile, `[Service]\nWorkingDirectory=${s.eosDir}\nEnvironment=EOS_OPTIMIZATION__GENETIC__BACKEND=native\n`);
    // Alt-Konfig im root-eigenen Checkout = die PermissionError-Falle.
    writeFileSync(join(s.eosDir, 'EOS.config.json'), '{"v":"alt"}');
    // calls.log leeren, um git/pip des leichten Laufs sauber zu messen.
    writeFileSync(join(s.dir, 'calls.log'), '');
    const r = s.run('v1', { EOS_CONFIG_FIX_ONLY: '1' });
    assert.equal(r.status, 0, r.stderr);
    const unit = readFileSync(unitFile, 'utf8');
    const cfgDir = assertWritableConfigDir(unit, { notEqualTo: s.eosDir });
    assertNoStrayConfigInCheckout(s.eosDir);
    assert.equal(existsSync(join(cfgDir, 'EOS.config.json')), true, 'Alt-Konfig migriert');
    assert.equal(unitEnv(unit, 'EOS_OPTIMIZATION__GENETIC__BACKEND'), 'native', 'BACKEND=native bleibt erhalten');
    // leicht: im Fix-Lauf wird das venv-pip NIE aufgerufen (nur im schweren Weg).
    const calls = readFileSync(join(s.dir, 'calls.log'), 'utf8');
    assert.ok(!/(^|\n)pip\b/.test(calls), `kein pip im leichten Lauf:\n${calls}`);
  } finally { s.cleanup(); }
});

// B1 (1.0.11, Folgefall von A2): der leichte fix-only-Lauf wird von post-update.sh
// OHNE EOS_HOME gestartet. Trägt die bestehende Unit einer Haupt-Instanz ein
// Environment=EOS_DIR=<pfad> (EOS_HOME- oder handgesetzter Datenordner) und fehlt
// /etc/dvhub/eos.env, ging die EOS_DIR-Zeile ersatzlos verloren (A2 schließt
// EOS_DIR aus der eos.env-Übernahme aus) → EOS fiele auf Standard-Ordner zurück,
// die alten Daten blieben ungelesen liegen. ROT gegen faf3b8a1, grün mit B1-Fix.
test('B1: fix-only mit leerem EOS_HOME erhält EOS_DIR aus der bestehenden Unit (keine Standard-Ordner)', () => {
  const s = setup();
  try {
    // 1. Haupt-Instanz mit EOS_HOME einrichten → erste Unit trägt EOS_DIR.
    assert.equal(s.run('v1').status, 0);
    const unitFile = join(s.dir, 'eos.service');
    const eosHome = join(s.dir, 'eos-home');
    assert.equal(unitEnv(readFileSync(unitFile, 'utf8'), 'EOS_DIR'), eosHome, 'erste Unit trägt EOS_DIR');
    // 2. Unit auf 1.0.10-Stil zurücksetzen: OHNE EOS_CONFIG_DIR, aber MIT EOS_DIR
    //    (+ BACKEND). eos.env fehlt (Default) — genau die B1-Lage.
    writeFileSync(unitFile, `[Service]\nWorkingDirectory=${s.eosDir}\nEnvironment=EOS_DIR=${eosHome}\nEnvironment=EOS_OPTIMIZATION__GENETIC__BACKEND=native\n`);
    // 3. fix-only-Lauf wie der post-update.sh-Trigger: OHNE EOS_HOME.
    const r = s.run('v1', { EOS_CONFIG_FIX_ONLY: '1', EOS_HOME: '' });
    assert.equal(r.status, 0, r.stderr);
    const unit = readFileSync(unitFile, 'utf8');
    assert.equal(unitEnv(unit, 'EOS_DIR'), eosHome, 'EOS_DIR bleibt in der neu geschriebenen Unit erhalten (B1)');
    assert.equal(unitEnv(unit, 'EOS_CONFIG_DIR'), eosHome, 'EOS_CONFIG_DIR konsistent = EOS_HOME (nicht Standard-Ordner)');
    assert.equal(unitEnv(unit, 'EOS_OPTIMIZATION__GENETIC__BACKEND'), 'native', 'BACKEND bleibt erhalten');
  } finally { s.cleanup(); }
});

// N1 (1.0.11): scheitert das Wegräumen der Alt-Konfig, darf das NICHT still
// passieren (Exit 0, keine Meldung) — sonst bliebe die PermissionError-Falle
// unbemerkt offen. Mindestens eine Warnung nach stderr. ROT gegen den Stand vor N1.
test('N1: scheiterndes mv der Alt-Konfig → Warnung auf stderr, Falle nicht stillschweigend offen', () => {
  const s = setup();
  try {
    assert.equal(s.run('v1').status, 0);
    // Alt-Konfig im Checkout; mv so verbiegen, dass das Verschieben der
    // EOS.config.json scheitert (gezieltes Attrappen-mv im PATH).
    writeFileSync(join(s.eosDir, 'EOS.config.json'), '{"v":"alt"}');
    writeFileSync(join(s.dir, 'bin', 'mv'),
      '#!/usr/bin/env bash\nif [[ "$*" == *EOS.config.json* ]]; then echo "mv blockiert (Test)" >&2; exit 1; fi\nexec /bin/mv "$@"\n');
    chmodSync(join(s.dir, 'bin', 'mv'), 0o755);
    const r = s.run('v1');
    assert.equal(r.status, 0, 'non-fatal: Lauf bricht nicht ab');
    assert.match(r.stderr, /WARNUNG.*EOS\.config\.json.*(verschoben|beiseite)/s, r.stderr);
    assert.match(r.stderr, /Falle bleibt offen/);
    // Alt-Konfig bleibt liegen (konnte nicht weggeräumt werden) — nicht still gelöscht.
    assert.equal(existsSync(join(s.eosDir, 'EOS.config.json')), true, 'Alt-Datei bleibt, da mv scheiterte');
  } finally { s.cleanup(); }
});
