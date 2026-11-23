// test/timescale-provision.test.js -- apt-Quelle fuer die TimescaleDB-Community-Edition.
// Issue #24 (19.10.2026): Auf Ubuntu 26.04 („resolute“) trug das Skript
// packagecloud.io/…/debian/ resolute ein. Den Pfad gibt es nicht (404), Ubuntu
// liegt unter …/ubuntu/. Die kaputte Quelle blieb stehen, jedes `apt update`
// der Box meldete den Fehler, und DVhub fiel still auf das Apache-Paket zurueck.
// apt, dpkg, psql & Co. sind hier Attrappen; apt-get update kennt nur die
// Pfade, die packagecloud wirklich anbietet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'timescale-provision.sh');

// Was packagecloud.io/timescale/timescaledb anbietet (Stand 21.10.2026, per curl geprueft).
const SERVED = ['debian/ bookworm', 'debian/ trixie', 'ubuntu/ noble', 'ubuntu/ resolute'];

function setup(osRelease, { existingList, transient = false, extHave = '', alterFails = false, apacheInstalled = false, tslInstallFails = false, downloadFails = false, tslPartial = false, apacheReinstallFails = false, offlineAfterDownload = false, staleDeb = false, leftoverApacheDeb = false, pgBuilds = null, extraEnv = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dvhub-tsp-'));
  const bin = join(dir, 'bin');
  execFileSync('mkdir', ['-p', bin]);
  const log = join(dir, 'calls.log');
  const pkgDb = join(dir, 'installed-packages');
  writeFileSync(pkgDb, apacheInstalled ? 'postgresql-18-timescaledb\n' : '');
  const repoList = join(dir, 'timescaledb.list');
  const keyring = join(dir, 'timescale.gpg');
  const osFile = join(dir, 'os-release');
  writeFileSync(keyring, 'key');
  writeFileSync(osFile, osRelease);
  if (existingList) writeFileSync(repoList, existingList);
  execFileSync('mkdir', ['-p', join(dir, 'postgresql', '18', 'main', 'conf.d')]);
  const debCache = join(dir, 'deb-cache');
  if (staleDeb) {
    // Rest eines gescheiterten Laufs: ältere Fassung im eigenen Download-Ordner.
    execFileSync('mkdir', ['-p', debCache]);
    writeFileSync(join(debCache, 'timescaledb-2-postgresql-18_2.30.0~ubuntu26.04_arm64.deb'), '');
  }
  if (leftoverApacheDeb) {
    // Abgebrochener Lauf: Apache war schon gesichert und entfernt.
    execFileSync('mkdir', ['-p', debCache]);
    writeFileSync(join(debCache, 'postgresql-18-timescaledb_2.31.0_arm64.deb'), '');
  }
  const fake = (name, body = '') => {
    const p = join(bin, name);
    writeFileSync(p, `#!/usr/bin/env bash\necho "${name} $*" >> "${log}"\n${body}\n`);
    chmodSync(p, 0o755);
  };
  const served = SERVED.map((s) => `*"timescaledb/${s} "*`).join('|');
  // apt-get update: Fehlerbild von apt 3 (Ubuntu 26.04) fuer einen Pfad ohne Release.
  // Ohne LC_ALL=C antwortet apt in der Sprache der Box (hier deutsch).
  // transient: packagecloud kurz nicht erreichbar (503) — die Quelle ist trotzdem richtig.
  fake('apt-get', `
if [[ "$1" == update ]]; then
  [[ -f "${repoList}" ]] || exit 0
  line="$(cat "${repoList}")"
  url="$(echo "$line" | grep -oE 'https://[^ ]+') $(echo "$line" | awk '{print $(NF-1)}')"
  err=Fehl; [[ "$LC_ALL" == C ]] && err=Err
  if ${transient ? 'true' : 'false'}; then
    echo "$err:7 $url InRelease"
    echo "  503  Service Unavailable [IP: 52.52.223.74 443]"
    echo "W: Failed to fetch $url/InRelease  503  Service Unavailable"
    exit 100
  fi
  case "$line" in ${served}) exit 0 ;; esac
  echo "$err:7 $url Release"
  echo "  404  Not Found [IP: 52.52.223.74 443]"
  if [[ "$LC_ALL" == C ]]; then
    echo "Error: The repository '$url Release' does not have a Release file."
  else
    echo "Fehler: Das Depot »$url Release« enthält keine Release-Datei."
  fi
  exit 100
fi
# -o Dir::Cache::archives=<ordner> → Paketordner dieses Aufrufs.
arch=/var/cache/apt/archives; prev=
for a in "$@"; do [[ "$prev" == -o && "$a" == Dir::Cache::archives=* ]] && arch="\${a#*=}"; prev="$a"; done
pkgs_of() { local p= a; for a in "$@"; do if [[ "$p" == -o ]]; then p=; continue; fi; p="$a"; case "$a" in install|-y|-qq|-o|--*) ;; *) echo "\${a%%=*}" ;; esac; done; }
if [[ "$1" == install && " $* " == *" --download-only "* ]]; then
  ls "$arch" 2>/dev/null | grep '[.]deb$' | sed 's/^/vorher-im-ordner /' >> "${log}"
fi
if [[ "$1" == install && " $* " == *" --download-only "* && " $* " != *" timescaledb-2-postgresql-"* ]]; then
  for p in $(pkgs_of "$@"); do : > "$arch/\${p}_2.31.0_arm64.deb"; done
fi
if [[ "$1" == install && " $* " == *" timescaledb-2-postgresql-"* ]]; then
  ${pgBuilds ? (pgBuilds.ok
    ? `if [[ " $* " != *" timescaledb-2-postgresql-18=${pgBuilds.ok} "* ]]; then echo "E: Unable to satisfy dependencies. Reached two conflicting assignments:"; exit 100; fi`
    : `if [[ " $* " == *" timescaledb-2-postgresql-18="* ]]; then echo "E: Version nicht erwartet"; exit 100; fi`) : ''}
  if [[ " $* " == *" --download-only "* ]]; then
    ${downloadFails ? 'exit 100' : ''}
    # apt legt alles ab, was es auflöst — auch Abhängigkeiten (timescaledb-tools).
    for p in $(pkgs_of "$@") timescaledb-tools; do : > "$arch/\${p}_2.31.0_arm64.deb"; done
    exit 0
  fi
  ${tslPartial ? `echo timescaledb-2-loader-postgresql-18 >> "${pkgDb}"; exit 100` : ''}
  ${tslInstallFails ? 'exit 100' : ':'}
fi
if [[ "$1" == install && " $* " != *" --download-only "* && " $* " == *" postgresql-18-timescaledb "* ]]; then
  ${apacheReinstallFails ? 'exit 100' : ':'}
fi
# Netz weg nach den Downloads: installierbar nur, was samt Abhängigkeit im Paketordner liegt.
if ${offlineAfterDownload ? 'true' : 'false'} && [[ "$1" == install && " $* " != *" --download-only "* ]]; then
  need="$(pkgs_of "$@")"; [[ "$need" == *timescaledb-2-* ]] && need="$need timescaledb-tools"
  for p in $need; do ls "$arch/\${p}"_*.deb >/dev/null 2>&1 || { echo "E: Fehlschlag beim Holen von $p (offline)"; exit 100; }; done
fi
if [[ "$1" == install && " $* " != *" --download-only "* ]]; then
  for a in $(pkgs_of "$@"); do case "$a" in *-) sed -i.bak "/^\${a%-}$/d" "${pkgDb}" ;; *) echo "$a" >> "${pkgDb}" ;; esac; done
fi
if [[ "$1" == remove ]]; then for a in "$@"; do sed -i.bak "/^$a$/d" "${pkgDb}"; done; fi
exit 0`);
  // apt-cache policy im Format von apt 2.6 bis 3.2 (im Container geprüft): Versionszeile
  // "     <version> <Pin-Priorität>", darunter die Quelle; pins = { version: Priorität }.
  fake('apt-cache', `
if [[ "$1" == policy && "$2" == timescaledb-2-* && -f "${repoList}" ]]; then
  line="$(cat "${repoList}")"
  inst="Installiert"; kand="Installationskandidat"; tab="Versionstabelle"; keine="(keine)"
  [[ "$LC_ALL" == C ]] && { inst=Installed; kand=Candidate; tab="Version table"; keine="(none)"; }
  case "$line" in
    ${served})
      echo "$2:"; echo "  $inst: $keine"
      echo "  $kand: ${pgBuilds ? (pgBuilds.candidate || pgBuilds.versions[0][0]) : '2.31.0~ubuntu26.04'}"
      ${pgBuilds ? `echo "  $tab:"
${pgBuilds.versions.map(([v]) => `      echo "     ${v} ${pgBuilds.pins?.[v] ?? 500}"; echo "        500 https://packagecloud.io/timescale/timescaledb/ubuntu resolute/main arm64 Packages"`).join('\n')}` : ':'}
      ;;
    *) echo "  $kand: $keine" ;;
  esac
fi
${pgBuilds ? `
if [[ "$1" == madison ]]; then
${pgBuilds.versions.map(([v]) => `  echo " $2 | ${v} | https://packagecloud.io/timescale/timescaledb/ubuntu resolute/main arm64 Packages"`).join('\n')}
fi
if [[ "$1" == show ]]; then
  case "$2" in
${pgBuilds.versions.map(([v, pg]) => `    *=${v}) echo "Package: \${2%%=*}"; echo "Version: ${v}"; if [[ "$2" == timescaledb-2-postgresql-* ]]; then echo "Depends: timescaledb-2-loader-postgresql-18 (>= ${v.split('~')[0]}~), postgresql-18 (>= ${pg}), libc6 (>= 2.38)"; else echo "Depends: postgresql-18 (>= ${pg}), libc6 (>= 2.38)"; fi ;;`).join('\n')}
  esac
fi` : ''}`);
  // Installierte PostgreSQL-Version (dpkg-query) und Versionsvergleich (dpkg --compare-versions).
  fake('dpkg-query', pgBuilds ? `[[ " $* " == *" postgresql-18 "* ]] && { echo -n "${pgBuilds.pgVersion}"; exit 0; }\nexit 1` : 'exit 1');
  fake('dpkg', `[[ "$1" == -s ]] && grep -qx "$2" "${pkgDb}" && exit 0
if [[ "$1" == --compare-versions && "$3" == ge ]]; then [[ "$(printf '%s\\n%s\\n' "$2" "$4" | sort -V | tail -n1)" == "$2" ]] && exit 0; exit 1; fi
if [[ "$1" == --compare-versions && "$3" == le ]]; then [[ "$(printf '%s\\n%s\\n' "$2" "$4" | sort -V | tail -n1)" == "$4" ]] && exit 0; exit 1; fi
exit 1`);
  fake('psql');
  // su: Katalog/Lade-Proben beantworten. extHave = Version im Katalog vor dem
  // Lauf ('' = Erweiterung fehlt); CREATE/ALTER setzen sie auf 2.31.0.
  const extFile = join(dir, 'ext');
  writeFileSync(extFile, extHave);
  fake('su', `
cmd="$3"
case "$cmd" in
  *"CREATE EXTENSION"*) echo -n 2.31.0 > "${extFile}" ;;
  *"ALTER EXTENSION"*) ${alterFails ? 'echo "ERROR:  kaputt" >&2; exit 1' : `echo -n 2.31.0 > "${extFile}"`} ;;
  *"FROM pg_extension WHERE extname"*) cat "${extFile}"; echo ;;
  *"default_version FROM pg_available"*) echo "2.31.0" ;;
  # Lizenz erst nach der Installation (vorher Apache) → kein Schnell-Skip.
  *"current_setting('timescaledb.license')"*) grep -Eq "^apt-get install -y (-o Dir::Cache::archives=[^ ]+ )?timescaledb-2" "${log}" && echo "timescale" || echo "apache" ;;
esac
exit 0`);
  fake('systemctl');
  fake('pg_lsclusters', 'echo "18  main    5432 online postgres /var/lib/postgresql/18/main"');
  fake('lsb_release', 'exit 1');
  const env = () => ({
      PATH: `${bin}:${process.env.PATH}`, TS_PROVISION_EUID: '0', LANG: 'de_DE.UTF-8',
      PG_ETC: join(dir, 'postgresql'), TS_DEB_CACHE: join(dir, 'deb-cache'),
      OS_RELEASE: osFile, REPO_LIST: repoList, KEYRING: keyring,
      CONFIG_PATH: join(dir, 'config.json'), DATA_DIR: dir, ...extraEnv,
  });
  const run = () => execFileSync('bash', [SCRIPT], {
    env: {
      PATH: `${bin}:${process.env.PATH}`, TS_PROVISION_EUID: '0', LANG: 'de_DE.UTF-8',
      PG_ETC: join(dir, 'postgresql'), TS_DEB_CACHE: join(dir, 'deb-cache'),
      OS_RELEASE: osFile, REPO_LIST: repoList, KEYRING: keyring,
      CONFIG_PATH: join(dir, 'config.json'), DATA_DIR: dir, ...extraEnv,
    },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
  const list = () => (existsSync(repoList) ? readFileSync(repoList, 'utf8').trim() : null);
  const sql = () => calls().filter((l) => l.startsWith('su ')).join('\n');
  const pkgs = () => readFileSync(pkgDb, 'utf8').split('\n').filter((l) => l.includes('timescaledb'));
  const runStatus = () => { try { run(); return 0; } catch (e) { return e.status; } };
  return { run, env, runStatus, calls, list, keyring, sql, dir, pkgs, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const UBUNTU_2604 = 'ID=ubuntu\nID_LIKE=debian\nVERSION_ID="26.04"\nVERSION_CODENAME=resolute\nUBUNTU_CODENAME=resolute\n';
const DEBIAN_13 = 'ID=debian\nVERSION_ID="13"\nVERSION_CODENAME=trixie\n';
const MINT_22 = 'ID=linuxmint\nID_LIKE="ubuntu debian"\nVERSION_CODENAME=xia\nUBUNTU_CODENAME=noble\n';
const RASPI_OS = 'ID=raspbian\nID_LIKE=debian\nVERSION_CODENAME=bookworm\n';
const DEBIAN_FORKY = 'ID=debian\nVERSION_CODENAME=forky\n';

// Installationsaufrufe ohne die Paketordner-Option (die prüft ein eigener Test).
const stripArch = (l) => l.replace(/ -o Dir::Cache::archives=\S+/, '');
const installed = (calls) => calls.map(stripArch).filter((l) => l.startsWith('apt-get install -y timescaledb-2') || l.startsWith('apt-get install -y postgresql-'));

test('Ubuntu 26.04: Quelle unter ubuntu/ resolute, Community-Paket fuer PG 18', () => {
  const s = setup(UBUNTU_2604);
  try {
    s.run();
    assert.equal(s.list(), `deb [signed-by=${s.keyring}] https://packagecloud.io/timescale/timescaledb/ubuntu/ resolute main`);
    assert.deepEqual(installed(s.calls()), ['apt-get install -y timescaledb-2-loader-postgresql-18 timescaledb-2-postgresql-18']);
  } finally { s.cleanup(); }
});

test('Box aus Issue #24: falsche Quelle debian/ resolute wird ersetzt', () => {
  const s = setup(UBUNTU_2604, {
    existingList: 'deb [signed-by=/usr/share/keyrings/timescale.gpg] https://packagecloud.io/timescale/timescaledb/debian/ resolute main\n',
  });
  try {
    s.run();
    assert.match(s.list(), /timescaledb\/ubuntu\/ resolute main$/);
    assert.deepEqual(installed(s.calls()), ['apt-get install -y timescaledb-2-loader-postgresql-18 timescaledb-2-postgresql-18']);
  } finally { s.cleanup(); }
});

test('Debian 13 bleibt bei debian/ trixie', () => {
  const s = setup(DEBIAN_13);
  try {
    s.run();
    assert.match(s.list(), /timescaledb\/debian\/ trixie main$/);
  } finally { s.cleanup(); }
});

test('Ubuntu-Ableger (Mint) nimmt den Ubuntu-Namen, Raspberry Pi OS den Debian-Pfad', () => {
  const mint = setup(MINT_22);
  const raspi = setup(RASPI_OS);
  try {
    mint.run();
    raspi.run();
    assert.match(mint.list(), /timescaledb\/ubuntu\/ noble main$/);
    assert.match(raspi.list(), /timescaledb\/debian\/ bookworm main$/);
  } finally { mint.cleanup(); raspi.cleanup(); }
});

test('passende Quelle in anderem Format bleibt unangetastet', () => {
  const own = 'deb https://packagecloud.io/timescale/timescaledb/debian/ trixie main';
  const s = setup(DEBIAN_13, { existingList: `${own}\n` });
  try {
    s.run();
    assert.equal(s.list(), own);
    assert.ok(!s.calls().includes('apt-get update'), 'nichts geaendert → kein apt update');
  } finally { s.cleanup(); }
});

test('Distribution ohne Pakete bei packagecloud: Quelle wieder raus, Apache-Fallback', () => {
  const s = setup(DEBIAN_FORKY);
  try {
    s.run();
    assert.equal(s.list(), null, 'keine kaputte Quelle zuruecklassen');
    const c = s.calls();
    assert.equal(c.filter((l) => l === 'apt-get update').length, 2, 'nach dem Entfernen apt-Listen neu laden');
    assert.deepEqual(installed(c), ['apt-get install -y postgresql-18-timescaledb']);
  } finally { s.cleanup(); }
});

test('packagecloud kurz nicht erreichbar (503): richtige Quelle bleibt stehen', () => {
  const s = setup(UBUNTU_2604, { transient: true });
  try {
    s.run();
    assert.match(s.list() || '', /timescaledb\/ubuntu\/ resolute main$/);
  } finally { s.cleanup(); }
});

// Feldfall 21.10.2026: Erweiterung 2.25.1 (Apache) im Katalog, Community 2.31.0
// installiert. CREATE EXTENSION scheiterte dort als erste Anweisung, das ALTER
// kam nie. Echt in ubuntu:26.04 nachgestellt; hier nur die Reihenfolge.
test('Erweiterung vorhanden: ALTER statt CREATE, als erste Anweisung (-X), danach Neustart', () => {
  const s = setup(UBUNTU_2604, { extHave: '2.25.1' });
  try {
    s.run();
    const c = s.calls();
    const sqlLines = c.filter((l) => l.startsWith('su '));
    assert.ok(!sqlLines.some((l) => l.includes('CREATE EXTENSION')), 'kein CREATE bei vorhandener Erweiterung');
    const iAlter = c.findIndex((l) => l.includes('ALTER EXTENSION timescaledb UPDATE'));
    assert.ok(iAlter >= 0, 'ALTER laeuft');
    assert.match(c[iAlter], /psql -X -v ON_ERROR_STOP=1 -q -d dvhub -c 'ALTER EXTENSION timescaledb UPDATE'/);
    assert.ok(c.slice(iAlter).some((l) => l === 'systemctl restart postgresql'), 'Postgres-Neustart nach dem ALTER');
    assert.ok(c.some((l) => l.includes('timescaledb.disable_load=on') && l.includes('DELETE FROM ONLY') === false), 'Katalog ohne Loader gelesen');
  } finally { s.cleanup(); }
});

test('Erweiterung fehlt: CREATE wie bisher, kein ALTER', () => {
  const s = setup(UBUNTU_2604);
  try {
    s.run();
    assert.match(s.sql(), /CREATE EXTENSION IF NOT EXISTS timescaledb/);
    assert.doesNotMatch(s.sql(), /ALTER EXTENSION/);
  } finally { s.cleanup(); }
});

test('ALTER scheitert: Exit 1 mit Hinweis, Fehler im Protokoll statt /dev/null', () => {
  const s = setup(UBUNTU_2604, { extHave: '2.25.1', alterFails: true });
  try {
    assert.throws(() => s.run(), (e) => e.status === 1 && /FEHLER: TimescaleDB: ALTER EXTENSION/.test(e.stderr));
    const log = readFileSync(join(s.dir, 'timescale-provision.log'), 'utf8');
    assert.match(log, /ERROR: {2}kaputt/);
    assert.match(log, /FEHLER: ALTER EXTENSION/);
  } finally { s.cleanup(); }
});

// Review 25.10.2026 (P2): das Apache-Paket wurde entfernt, BEVOR feststand, dass
// sich die Community-Edition installieren laesst (Netz weg → Box ohne Bibliothek
// zur Katalog-Version). Jetzt: erst Community UND das installierte Apache-Paket
// herunterladen, dann tauschen; scheitert die Installation, kommt Apache aus dem
// Paket-Cache zurueck. Kein Verlass auf Conflicts/Replaces der Fremdpakete.
const isRemove = (l) => l.startsWith('apt-get remove');
const isDl = (l) => l.startsWith('apt-get install -y --download-only');

test('Apache→Community: Download scheitert → nichts entfernt, nichts installiert', () => {
  const s = setup(UBUNTU_2604, { apacheInstalled: true, downloadFails: true });
  try {
    s.run();
    const c = s.calls();
    assert.ok(!c.some(isRemove), c.join(' | '));
    assert.ok(!c.some((l) => /^apt-get install -y (?!--download-only)\S*timescaledb-2/.test(l)), 'kein Installationsversuch');
    assert.deepEqual(s.pkgs(), ['postgresql-18-timescaledb']);
  } finally { s.cleanup(); }
});

test('Apache→Community: Installation scheitert nach dem Entfernen → Apache wieder da', () => {
  const s = setup(UBUNTU_2604, { apacheInstalled: true, tslInstallFails: true });
  try {
    s.run();
    const c = s.calls();
    const iDlApache = c.findIndex((l) => isDl(l) && l.includes('postgresql-18-timescaledb') && l.includes('--reinstall'));
    const iRemove = c.findIndex(isRemove);
    assert.ok(iDlApache >= 0 && iDlApache < iRemove, `Apache vor dem Entfernen im Cache: ${c.join(' | ')}`);
    assert.ok(s.pkgs().includes('postgresql-18-timescaledb'), `Apache wieder installiert: ${s.pkgs()}`);
  } finally { s.cleanup(); }
});

test('Apache→Community: Reihenfolge Download → Entfernen → Installation', () => {
  const s = setup(UBUNTU_2604, { apacheInstalled: true });
  try {
    s.run();
    const c = s.calls();
    const iDl = c.findIndex((l) => isDl(l) && l.includes('timescaledb-2-postgresql-18'));
    const iRemove = c.findIndex(isRemove);
    const iInst = c.map(stripArch).indexOf('apt-get install -y timescaledb-2-loader-postgresql-18 timescaledb-2-postgresql-18');
    assert.ok(iDl >= 0 && iDl < iRemove && iRemove < iInst, c.join(' | '));
    assert.deepEqual(s.pkgs().sort(), ['timescaledb-2-loader-postgresql-18', 'timescaledb-2-postgresql-18']);
  } finally { s.cleanup(); }
});

// Gegenprüfung zu 5d51b339.
test('Community halb installiert (Loader da, Paket nicht) → Loader weg, dann Apache zurück', () => {
  const s = setup(UBUNTU_2604, { apacheInstalled: true, tslPartial: true });
  try {
    s.runStatus();
    const c = s.calls();
    const iRmTsl = c.findIndex((l) => isRemove(l) && l.includes('timescaledb-2-loader-postgresql-18'));
    const iApache = c.map(stripArch).findIndex((l) => /^apt-get install -y (?!--download-only)\S*postgresql-18-timescaledb(_\S*\.deb)?$/.test(l));
    assert.ok(iRmTsl >= 0 && iRmTsl < iApache, c.join(' | '));
    assert.deepEqual(s.pkgs(), ['postgresql-18-timescaledb']);
  } finally { s.cleanup(); }
});

test('Apache nach dem Entfernen nicht wieder installierbar → sichtbarer Fehler, Preload-Eintrag weg (Postgres startet)', () => {
  const s = setup(UBUNTU_2604, { apacheInstalled: true, tslInstallFails: true, apacheReinstallFails: true });
  try {
    const dropin = join(s.dir, 'postgresql', '18', 'main', 'conf.d', 'timescaledb.conf');
    writeFileSync(dropin, "shared_preload_libraries = 'timescaledb'\n");
    assert.equal(s.runStatus(), 1, 'kein stilles exit 0');
    assert.equal(existsSync(dropin), false, 'ohne Bibliothek darf kein Preload-Eintrag bleiben');
  } finally { s.cleanup(); }
});

test('Pakete in einen eigenen Ordner herunterladen (ein dpkg-Hook wie docker-clean leert den apt-Cache)', () => {
  const s = setup(UBUNTU_2604, { apacheInstalled: true });
  try {
    s.run();
    const dls = s.calls().filter(isDl);
    assert.ok(dls.length >= 2 && dls.every((l) => l.includes(`-o Dir::Cache::archives=${join(s.dir, 'deb-cache')}`)), dls.join(' | '));
  } finally { s.cleanup(); }
});

// Gegenprüfung 7c1761b8 (P2): die Installation fand die geladenen Pakete nicht —
// apt legte beim Download ALLES (auch Abhängigkeiten) in den eigenen Ordner,
// die Installation suchte aber im Standard-Cache. Ohne Netz scheiterte sie und
// fiel auf Apache zurück, obwohl alles da war.
test('Apache→Community ohne Netz nach dem Download: Installation aus dem eigenen Paketordner', () => {
  const s = setup(UBUNTU_2604, { apacheInstalled: true, offlineAfterDownload: true });
  try {
    s.run();
    const inst = s.calls().filter((l) => l.startsWith('apt-get install -y') && !l.includes('--download-only') && l.includes('timescaledb'));
    assert.ok(inst.length >= 1 && inst.every((l) => l.includes(`-o Dir::Cache::archives=${join(s.dir, 'deb-cache')}`)), inst.join(' | '));
    assert.deepEqual(s.pkgs().sort(), ['timescaledb-2-loader-postgresql-18', 'timescaledb-2-postgresql-18'], 'Community installiert, nicht zurück auf Apache');
  } finally { s.cleanup(); }
});

// Gegenprüfung 7c1761b8 (P3): Reste eines gescheiterten Laufs im Paketordner
// konnten eine ältere Fassung installieren (geratener Dateiname). Jetzt wird
// per Paketname installiert; apt nimmt aus dem Ordner nur die Kandidaten-Fassung.
test('Reste eines früheren Laufs im Paketordner: Installation per Paketname, nie per Datei', () => {
  const s = setup(UBUNTU_2604, { apacheInstalled: true, staleDeb: true });
  try {
    s.run();
    const inst = s.calls().filter((l) => l.startsWith('apt-get install') && !l.includes('--download-only'));
    assert.ok(inst.length >= 1 && inst.every((l) => !/\.deb\b/.test(l)), inst.join(' | '));
  } finally { s.cleanup(); }
});

// Gegenprüfung d867a370 (P3): das Leeren des Paketordners zu Beginn nahm einem
// abgebrochenen Lauf (Apache schon entfernt) den Rückweg ohne Netz.
test('Abgebrochener Lauf, Apache entfernt, jetzt ohne Netz: Apache aus dem Paketordner zurück', () => {
  const s = setup(UBUNTU_2604, { downloadFails: true, offlineAfterDownload: true, leftoverApacheDeb: true });
  try {
    s.runStatus();
    assert.ok(s.pkgs().includes('postgresql-18-timescaledb'), `Apache wieder da: ${s.pkgs()}`);
  } finally { s.cleanup(); }
});

test('Attrappe: Lizenzprobe sieht die Community-Installation (mit Paketordner-Option)', () => {
  const s = setup(UBUNTU_2604);
  try {
    s.run();
    assert.match(s.sql(), /timescaledb\.license/);
    assert.ok(s.calls().some((l) => /^apt-get install -y -o Dir::Cache::archives=\S+ timescaledb-2/.test(l)));
  } finally { s.cleanup(); }
});

// CI rot 19.11.2026: packagecloud liefert je Version einen Bau pro PostgreSQL-Minor. apt nimmt den höchsten
// (…-1807, verlangt postgresql-18 >= 18.7); Ubuntu 26.04 hatte 18.6 → nicht installierbar → DVhub fiel ohne Not
// auf Apache zurück. Jetzt wählt das Skript den neuesten Bau, den die installierte PostgreSQL-Version erfüllt.
const PG_BUILDS = [['2.32.1~ubuntu26.04-1807', '18.7'], ['2.32.1~ubuntu26.04-1806', '18.6'], ['2.31.2~ubuntu26.04-1807', '18.7'], ['2.31.2~ubuntu26.04-1806', '18.6']];

test('PostgreSQL 18.6 installiert: nimmt den Bau für 18.6 (…-1806), kein Apache-Rückfall', () => {
  const s = setup(UBUNTU_2604, { pgBuilds: { pgVersion: '18.6-0ubuntu0.26.04.1', ok: '2.32.1~ubuntu26.04-1806', versions: PG_BUILDS } });
  try {
    const out = s.run();
    assert.deepEqual(installed(s.calls()), ['apt-get install -y timescaledb-2-loader-postgresql-18=2.32.1~ubuntu26.04-1806 timescaledb-2-postgresql-18=2.32.1~ubuntu26.04-1806']);
    assert.deepEqual(s.pkgs().sort(), ['timescaledb-2-loader-postgresql-18', 'timescaledb-2-postgresql-18']);
    assert.match(out, /passend zur installierten PostgreSQL-Version: 2\.32\.1~ubuntu26\.04-1806/);
  } finally { s.cleanup(); }
});

test('PostgreSQL 18.7 installiert: der apt-Kandidat (…-1807) passt → Paketname ohne Version, apt wählt wie immer', () => {
  const s = setup(UBUNTU_2604, { pgBuilds: { pgVersion: '18.7-0ubuntu0.26.04.1', ok: '', versions: PG_BUILDS } });
  try {
    s.run();
    assert.deepEqual(installed(s.calls()), ['apt-get install -y timescaledb-2-loader-postgresql-18 timescaledb-2-postgresql-18']);
  } finally { s.cleanup(); }
});

// Codex 684697ca: Hat der Betreiber TimescaleDB per apt auf eine geprüfte Version festgelegt (Pin), ist sie der
// apt-Kandidat. Eine ausdrückliche neuere Version überginge den Pin — darum nie über den Kandidaten hinaus.
test('Pin des Betreibers auf 2.31.2 (Kandidat …-1807), PostgreSQL 18.6: nimmt 2.31.2-1806, nie 2.32.1', () => {
  const s = setup(UBUNTU_2604, { pgBuilds: { pgVersion: '18.6-0ubuntu0.26.04.1', candidate: '2.31.2~ubuntu26.04-1807', ok: '2.31.2~ubuntu26.04-1806', versions: PG_BUILDS } });
  try {
    s.run();
    assert.deepEqual(installed(s.calls()), ['apt-get install -y timescaledb-2-loader-postgresql-18=2.31.2~ubuntu26.04-1806 timescaledb-2-postgresql-18=2.31.2~ubuntu26.04-1806']);
  } finally { s.cleanup(); }
});

test('Pin des Betreibers auf 2.31.2-1806, der Kandidat passt → Paketname ohne Version (apt hält den Pin)', () => {
  const s = setup(UBUNTU_2604, { pgBuilds: { pgVersion: '18.6-0ubuntu0.26.04.1', candidate: '2.31.2~ubuntu26.04-1806', ok: '', versions: PG_BUILDS } });
  try {
    s.run();
    assert.deepEqual(installed(s.calls()), ['apt-get install -y timescaledb-2-loader-postgresql-18 timescaledb-2-postgresql-18']);
  } finally { s.cleanup(); }
});

test('Kein Bau passt (PostgreSQL 18.5): wie bisher Paketname ohne Version, danach Apache-Rückfall', () => {
  const s = setup(UBUNTU_2604, { pgBuilds: { pgVersion: '18.5-0ubuntu0.26.04.1', ok: 'keiner', versions: PG_BUILDS } });
  try {
    s.run();
    assert.deepEqual(installed(s.calls()), ['apt-get install -y postgresql-18-timescaledb']);
  } finally { s.cleanup(); }
});

// Codex 711c4e3e: Sperrt der Betreiber einen Bau mit Pin-Priority -1, installiert apt ihn trotzdem, sobald man ihn
// ausdrücklich verlangt (`paket=version`; im Container mit apt 2.6.1, 2.8.3, 3.0.3 und 3.2.0 geprüft). In
// `apt-cache policy` steht er mit der negativen Priorität in der Versionstabelle — der Rückfall lässt ihn aus.
const PIN_1806 = { '2.32.1~ubuntu26.04-1806': -1 };

test('Bau 2.32.1-1806 per Pin-Priority -1 gesperrt, PostgreSQL 18.6: nimmt 2.31.2-1806, nie den gesperrten Bau', () => {
  const s = setup(UBUNTU_2604, { pgBuilds: { pgVersion: '18.6-0ubuntu0.26.04.1', ok: '2.31.2~ubuntu26.04-1806', versions: PG_BUILDS, pins: PIN_1806 } });
  try {
    s.run();
    assert.deepEqual(installed(s.calls()), ['apt-get install -y timescaledb-2-loader-postgresql-18=2.31.2~ubuntu26.04-1806 timescaledb-2-postgresql-18=2.31.2~ubuntu26.04-1806']);
  } finally { s.cleanup(); }
});

// Dieselbe Auswahl steht in pkg-maintain.sh (Wartung ohne Aufsicht) und im CI-Lauf. Die Funktion wird aus jeder
// Kopie herausgelöst und gegen dieselben Attrappen gefahren; weicht eine Kopie ab, wird ihr Test rot.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TS_PKG_SPEC_COPIES = ['timescale-provision.sh', 'pkg-maintain.sh', 'scripts/ci/timescale-native-e2e.sh'];
const PC_SRC = '        500 https://packagecloud.io/timescale/timescaledb/ubuntu resolute/main arm64 Packages';

function tsPkgSpec(file, policy, pgVersion = '18.6-0ubuntu0.26.04.1') {
  const lines = readFileSync(join(REPO, file), 'utf8').split('\n');
  const start = lines.findIndex((l) => /^\s*ts_pkg_spec\(\) \{$/.test(l));
  assert.ok(start >= 0, `${file}: ts_pkg_spec fehlt`);
  const indent = lines[start].match(/^\s*/)[0];
  const end = lines.findIndex((l, i) => i > start && l === `${indent}}`);
  assert.ok(end > start, `${file}: Ende von ts_pkg_spec nicht gefunden`);
  const fn = lines.slice(start, end + 1).join('\n');
  const dir = mkdtempSync(join(tmpdir(), 'dvhub-tsspec-'));
  try {
    const bin = join(dir, 'bin');
    execFileSync('mkdir', ['-p', bin]);
    const fake = (name, body) => { writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
    writeFileSync(join(dir, 'policy'), policy);
    fake('apt-cache', `
case "$1" in
  policy) cat "${join(dir, 'policy')}" ;;
  madison)
${PG_BUILDS.map(([v]) => `    echo " $2 | ${v} | https://packagecloud.io/timescale/timescaledb/ubuntu resolute/main arm64 Packages"`).join('\n')}
    ;;
  show)
    case "$2" in
${PG_BUILDS.map(([v, pg]) => `      *=${v}) echo "Package: \${2%%=*}"; echo "Version: ${v}"; echo "Depends: postgresql-18 (>= ${pg}), libc6 (>= 2.38)" ;;`).join('\n')}
    esac ;;
esac`);
    fake('dpkg-query', `[[ " $* " == *" postgresql-18 "* ]] && { echo -n "${pgVersion}"; exit 0; }\nexit 1`);
    fake('dpkg', `[[ "$1" == --compare-versions ]] || exit 1
hi="$(printf '%s\\n%s\\n' "$2" "$4" | sort -V | tail -n1)"
case "$3" in ge) [[ "$hi" == "$2" ]] ;; le) [[ "$hi" == "$4" ]] ;; *) exit 1 ;; esac`);
    return execFileSync('bash', ['-c', `set -euo pipefail\nPG_VER=18\n${fn}\nts_pkg_spec timescaledb-2-postgresql-18`], {
      env: { PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const policyOf = ({ installed = '(none)', pins = {}, star = '' } = {}) => [
  'timescaledb-2-postgresql-18:', `  Installed: ${installed}`, '  Candidate: 2.32.1~ubuntu26.04-1807', '  Version table:',
  ...PG_BUILDS.flatMap(([v]) => [`${v === star ? ' *** ' : '     '}${v} ${pins[v] ?? 500}`, PC_SRC, ...(v === star ? ['        100 /var/lib/dpkg/status'] : [])]),
].join('\n');

for (const file of TS_PKG_SPEC_COPIES) {
  test(`${file}: ts_pkg_spec lässt einen per Pin-Priority -1 gesperrten Bau aus (Codex 711c4e3e)`, () => {
    assert.equal(tsPkgSpec(file, policyOf()), 'timescaledb-2-postgresql-18=2.32.1~ubuntu26.04-1806');
    assert.equal(tsPkgSpec(file, policyOf({ pins: PIN_1806 })), 'timescaledb-2-postgresql-18=2.31.2~ubuntu26.04-1806');
  });

  // Ist der gesperrte Bau schon installiert, ändert ihn auszuwählen nichts; ihn auszulassen hieße, apt ein
  // Downgrade abzuverlangen, das `apt-get -y` ablehnt — und mit ihm den ganzen Aufruf (Loader, Toolkit).
  test(`${file}: ts_pkg_spec behält den installierten Bau, auch wenn er gesperrt ist`, () => {
    const policy = policyOf({ installed: '2.32.1~ubuntu26.04-1806', pins: PIN_1806, star: '2.32.1~ubuntu26.04-1806' });
    assert.equal(tsPkgSpec(file, policy), 'timescaledb-2-postgresql-18=2.32.1~ubuntu26.04-1806');
  });
}

// S12 a1 (23.11.2026, Kundenfall 12-GB-Platte): Der Apache-Rückfall endete mit
// write_status ok — still. Jetzt steht er mit Grund in timescale-status.json
// (provision.result 'apache'); DVhub zeigt daraus den roten Hinweis „Datenbank
// ohne Kompression“. PKG_MAINTAIN_EUID=0 lässt pkg-maintain.sh (Statusdatei) hier laufen.
const statusOf = (s) => JSON.parse(readFileSync(join(s.dir, 'timescale-status.json'), 'utf8'));

test('Apache-Rückfall (keine Pakete für die Distribution) steht mit Grund in der Statusdatei', () => {
  const s = setup(DEBIAN_FORKY, { extraEnv: { PKG_MAINTAIN_EUID: '0' } });
  try {
    s.run();
    const st = statusOf(s);
    assert.equal(st.edition, 'apache');
    assert.equal(st.provision.result, 'apache');
    assert.match(st.provision.error, /Community-Edition nicht installiert: packagecloud hat keine TimescaleDB-Pakete fuer debian forky/);
  } finally { s.cleanup(); }
});

test('Apache-Rückfall nach gescheitertem Download: Grund „nicht herunterladbar“, Warnung auf stderr', () => {
  const s = setup(UBUNTU_2604, { apacheInstalled: true, downloadFails: true, extraEnv: { PKG_MAINTAIN_EUID: '0' } });
  try {
    const r = spawnSync('bash', [SCRIPT], { env: s.env(), encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /TimescaleDB laeuft in der Apache-Edition \(Community-Paket nicht herunterladbar\)/);
    assert.equal(statusOf(s).provision.result, 'apache');
    assert.match(statusOf(s).provision.error, /Community-Paket nicht herunterladbar/);
  } finally { s.cleanup(); }
});

test('Community erfolgreich: provision ok, kein Apache-Vermerk', () => {
  const s = setup(UBUNTU_2604, { extraEnv: { PKG_MAINTAIN_EUID: '0' } });
  try {
    s.run();
    const st = statusOf(s);
    assert.equal(st.edition, 'timescale');
    assert.equal(st.provision.result, 'ok');
  } finally { s.cleanup(); }
});

test('pkg-maintain: alter Apache-Vermerk verschwindet, sobald Community läuft', () => {
  const s = setup(UBUNTU_2604, { extraEnv: { PKG_MAINTAIN_EUID: '0' } });
  try {
    s.run();
    const f = join(s.dir, 'timescale-status.json');
    writeFileSync(f, JSON.stringify({ ...statusOf(s), provision: { at: '2026-11-20T00:00:00Z', result: 'apache', error: 'alt' } }));
    const r = spawnSync('bash', [join(dirname(SCRIPT), 'pkg-maintain.sh')], { env: { ...s.env(), PKG_MAINTAIN_STATUS_ONLY: '1' }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(statusOf(s).provision, null);
  } finally { s.cleanup(); }
});
