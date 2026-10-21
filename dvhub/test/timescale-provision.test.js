// test/timescale-provision.test.js -- apt-Quelle fuer die TimescaleDB-Community-Edition.
// Issue #24 (19.10.2026): Auf Ubuntu 26.04 („resolute“) trug das Skript
// packagecloud.io/…/debian/ resolute ein. Den Pfad gibt es nicht (404), Ubuntu
// liegt unter …/ubuntu/. Die kaputte Quelle blieb stehen, jedes `apt update`
// der Box meldete den Fehler, und DVhub fiel still auf das Apache-Paket zurueck.
// apt, dpkg, psql & Co. sind hier Attrappen; apt-get update kennt nur die
// Pfade, die packagecloud wirklich anbietet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'timescale-provision.sh');

// Was packagecloud.io/timescale/timescaledb anbietet (Stand 21.10.2026, per curl geprueft).
const SERVED = ['debian/ bookworm', 'debian/ trixie', 'ubuntu/ noble', 'ubuntu/ resolute'];

function setup(osRelease, { existingList } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dvhub-tsp-'));
  const bin = join(dir, 'bin');
  execFileSync('mkdir', ['-p', bin]);
  const log = join(dir, 'calls.log');
  const repoList = join(dir, 'timescaledb.list');
  const keyring = join(dir, 'timescale.gpg');
  const osFile = join(dir, 'os-release');
  writeFileSync(keyring, 'key');
  writeFileSync(osFile, osRelease);
  if (existingList) writeFileSync(repoList, existingList);
  const fake = (name, body = '') => {
    const p = join(bin, name);
    writeFileSync(p, `#!/usr/bin/env bash\necho "${name} $*" >> "${log}"\n${body}\n`);
    chmodSync(p, 0o755);
  };
  const served = SERVED.map((s) => `*"timescaledb/${s} "*`).join('|');
  // apt-get update: Fehlerbild von apt 3 (Ubuntu 26.04) fuer einen Pfad ohne Release.
  fake('apt-get', `
if [[ "$1" == update ]]; then
  [[ -f "${repoList}" ]] || exit 0
  line="$(cat "${repoList}")"
  case "$line" in ${served}) exit 0 ;; esac
  url="$(echo "$line" | grep -oE 'https://[^ ]+') $(echo "$line" | awk '{print $(NF-1)}')"
  echo "Err:7 $url Release"
  echo "  404  Not Found [IP: 52.52.223.74 443]"
  echo "Error: The repository '$url Release' does not have a Release file."
  exit 100
fi
exit 0`);
  fake('apt-cache', `
if [[ "$1" == policy && "$2" == timescaledb-2-* && -f "${repoList}" ]]; then
  line="$(cat "${repoList}")"
  case "$line" in ${served}) echo "  Candidate: 2.31.0~ubuntu26.04" ;; *) echo "  Candidate: (none)" ;; esac
fi`);
  fake('dpkg', 'exit 1');
  fake('psql');
  fake('su');
  fake('systemctl');
  fake('pg_lsclusters', 'echo "18  main    5432 online postgres /var/lib/postgresql/18/main"');
  fake('lsb_release', 'exit 1');
  const run = () => execFileSync('bash', [SCRIPT], {
    env: {
      PATH: `${bin}:${process.env.PATH}`, TS_PROVISION_EUID: '0',
      OS_RELEASE: osFile, REPO_LIST: repoList, KEYRING: keyring,
      CONFIG_PATH: join(dir, 'config.json'), DATA_DIR: dir,
    },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
  const list = () => (existsSync(repoList) ? readFileSync(repoList, 'utf8').trim() : null);
  return { run, calls, list, keyring, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const UBUNTU_2604 = 'ID=ubuntu\nID_LIKE=debian\nVERSION_ID="26.04"\nVERSION_CODENAME=resolute\nUBUNTU_CODENAME=resolute\n';
const DEBIAN_13 = 'ID=debian\nVERSION_ID="13"\nVERSION_CODENAME=trixie\n';
const MINT_22 = 'ID=linuxmint\nID_LIKE="ubuntu debian"\nVERSION_CODENAME=xia\nUBUNTU_CODENAME=noble\n';
const RASPI_OS = 'ID=raspbian\nID_LIKE=debian\nVERSION_CODENAME=bookworm\n';
const DEBIAN_FORKY = 'ID=debian\nVERSION_CODENAME=forky\n';

const installed = (calls) => calls.filter((l) => l.startsWith('apt-get install -y timescaledb-2') || l.startsWith('apt-get install -y postgresql-'));

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
