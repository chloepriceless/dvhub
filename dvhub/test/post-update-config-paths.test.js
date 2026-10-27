// test/post-update-config-paths.test.js -- post-update.sh nimmt Konfigurations-
// und Datenordner aus der Unit (Gegenprüfung 71dbf940, P2).
// install.sh --config /srv/dvhub/config.json trägt CONFIG_DIR=/srv/dvhub in
// dvhub-vpn ein und setzt Environment=DV_APP_CONFIG=… in der Unit. post-update.sh
// fiel dagegen auf /etc/dvhub zurück (die Unit setzt kein CONFIG_DIR, sudo aus
// der Oberfläche leert die Umgebung) und schrieb das bei jedem Start wieder in
// dvhub-vpn — der Tunnel fand sein Profil nicht mehr.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = readFileSync(join(ROOT, 'post-update.sh'), 'utf8');
const HEAD = SCRIPT.slice(SCRIPT.indexOf('INSTALL_DIR="${INSTALL_DIR:-/opt/dvhub}"'), SCRIPT.indexOf('if [[ "${EUID}" -ne 0 ]]'));

function paths(env, unitText) {
  const dir = mkdtempSync(join(tmpdir(), 'dvhub-pu-paths-'));
  try {
    const unit = join(dir, 'dvhub.service');
    if (unitText) writeFileSync(unit, unitText);
    const r = spawnSync('bash', ['-c', `set -euo pipefail\n${HEAD}\necho "$CONFIG_DIR|$CONFIG_PATH|$DATA_DIR"`], {
      encoding: 'utf8', env: { PATH: process.env.PATH, PU_UNIT_FILE: unit, ...env },
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const UNIT = '[Service]\nEnvironment=NODE_ENV=production\nEnvironment=DV_APP_CONFIG=/srv/dvhub/config.json\nEnvironment=DV_DATA_DIR=/srv/data\n';

test('ExecStartPre: Pfade aus der Umgebung der Unit', () => {
  assert.equal(paths({ DV_APP_CONFIG: '/srv/dvhub/config.json', DV_DATA_DIR: '/srv/data' }), '/srv/dvhub|/srv/dvhub/config.json|/srv/data');
});

test('Update aus der Oberfläche (sudo, leere Umgebung): Pfade aus der Unit-Datei', () => {
  assert.equal(paths({}, UNIT), '/srv/dvhub|/srv/dvhub/config.json|/srv/data');
});

test('ohne Angaben: Standardpfade; ausdrücklich gesetzte Werte gewinnen', () => {
  assert.equal(paths({}), '/etc/dvhub|/etc/dvhub/config.json|/var/lib/dvhub');
  assert.equal(paths({ CONFIG_DIR: '/x', DATA_DIR: '/d' }, UNIT), '/x|/x/config.json|/d');
});
