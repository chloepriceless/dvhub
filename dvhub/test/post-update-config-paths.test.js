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
const HEAD = SCRIPT.slice(SCRIPT.indexOf('set -euo pipefail') + 'set -euo pipefail'.length, SCRIPT.indexOf('if [[ "${EUID}" -ne 0 ]]'));

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

// Gegenprüfung a2ff2a85 (P2): install.sh --dir /srv/app schreibt /srv/app in die
// Unit, setzt aber kein INSTALL_DIR. post-update.sh fiel auf /opt/dvhub zurück,
// schrieb ExecStart/ExecStartPre auf /opt/dvhub um und installierte die
// Hilfsskripte von dort — der nächste Start lief ins Leere.
test('Programmordner = Ort des Skripts, wenn INSTALL_DIR fehlt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dvhub-pu-dir-'));
  try {
    const app = join(dir, 'srv app');
    spawnSync('mkdir', ['-p', app]);
    writeFileSync(join(app, 'post-update.sh'), `#!/usr/bin/env bash\nset -euo pipefail\n${HEAD}\necho "$INSTALL_DIR|$APP_DIR"\n`);
    const r = spawnSync('bash', [join(app, 'post-update.sh')], { encoding: 'utf8', env: { PATH: process.env.PATH, PU_UNIT_FILE: join(dir, 'none') } });
    assert.equal(r.status, 0, r.stderr);
    const real = spawnSync('bash', ['-c', `cd "${app}" && pwd -P`], { encoding: 'utf8' }).stdout.trim();
    assert.ok([`${app}|${app}/dvhub`, `${real}|${real}/dvhub`].includes(r.stdout.trim()), r.stdout);
    const r2 = spawnSync('bash', [join(app, 'post-update.sh')], { encoding: 'utf8', env: { PATH: process.env.PATH, PU_UNIT_FILE: join(dir, 'none'), INSTALL_DIR: '/x' } });
    assert.equal(r2.stdout.trim(), '/x|/x/dvhub', 'ausdrücklich gesetzt gewinnt');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Update aus der Oberfläche: dvhub-update übergibt Programmordner und Dienstnamen an post-update.sh', () => {
  const upd = readFileSync(join(ROOT, 'dvhub-update.sh'), 'utf8');
  assert.match(upd, /^SERVICE_NAME="@SERVICE_NAME@"$/m);
  assert.match(upd, /exec env INSTALL_DIR="\$INSTALL_DIR" SERVICE_NAME="\$SERVICE_NAME" bash "\$INSTALL_DIR\/post-update\.sh"/);
  const helpers = SCRIPT.slice(SCRIPT.indexOf('# BEGIN DVHUB HELPERS'), SCRIPT.indexOf('# END DVHUB HELPERS'));
  assert.ok(helpers.includes('-e "s|^SERVICE_NAME=\\"@SERVICE_NAME@\\"\\$|SERVICE_NAME=\\"${SERVICE_NAME}\\"|"'), 'HELPERS-Block trägt den Dienstnamen ein');
});

test('Unit-Werte: systemctl show (mit Drop-ins) vor der Unit-Datei', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dvhub-pu-show-'));
  try {
    const bin = join(dir, 'bin');
    spawnSync('mkdir', ['-p', bin]);
    writeFileSync(join(bin, 'systemctl'), '#!/usr/bin/env bash\n[[ "$1 $2 $3 $4" == "show -p Environment --value" && "$5" == dvhub2.service ]] && echo "NODE_ENV=production DV_APP_CONFIG=/drop/in/config.json DV_DATA_DIR=/drop/data"\nexit 0\n');
    spawnSync('chmod', ['755', join(bin, 'systemctl')]);
    const r = spawnSync('bash', ['-c', `set -euo pipefail\n${HEAD}\necho "$CONFIG_DIR|$DATA_DIR"`], {
      encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, SERVICE_NAME: 'dvhub2', PU_UNIT_FILE: join(dir, 'none') },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), '/drop/in|/drop/data');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Gegenprüfung 963dd115 (P2): als ExecStartPre kennt post-update.sh den Dienst
// nur aus DV_SERVICE_NAME (z. B. dvhub2.service); mit „dvhub“ als Rückfall trug
// jeder Start den falschen Namen in dvhub-update und die sudoers-Regeln ein.
test('Dienstname aus DV_SERVICE_NAME der Unit', () => {
  const r = spawnSync('bash', ['-c', `set -euo pipefail\n${HEAD}\necho "$SERVICE_NAME"`], {
    encoding: 'utf8', env: { PATH: process.env.PATH, DV_SERVICE_NAME: 'dvhub2.service', PU_UNIT_FILE: '/nonexistent' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'dvhub2');
  const r2 = spawnSync('bash', ['-c', `set -euo pipefail\n${HEAD}\necho "$SERVICE_NAME"`], {
    encoding: 'utf8', env: { PATH: process.env.PATH, PU_UNIT_FILE: '/nonexistent' },
  });
  assert.equal(r2.stdout.trim(), 'dvhub');
});
