// test/npm-cache-update.test.js — npm-Cache und Besitz von node_modules.
// 2026-10-15: Update über die Oberfläche scheiterte an root-eigenen Einträgen im
// npm-Cache des Dienstbenutzers (EACCES). Damals lief npm deshalb als
// Dienstbenutzer. Seit der Rechte-Härtung (Review 25.10.2026) gehören
// /opt/dvhub und node_modules root, und JEDES npm install läuft als root mit
// HOME=/root — post-update.sh genauso wie das Update aus der Oberfläche
// (dvhub-update npm-install). Der Cache des Dienstbenutzers wird nicht mehr benutzt.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

test('dvhub/.npmrc lenkt npm auf einen eigenen Cache (gilt auch für älteren Update-Code)', () => {
  assert.match(read('../.npmrc'), /^cache=\$\{HOME\}\/\.cache\/dvhub-npm$/m);
});

test('post-update.sh: npm als root mit HOME=/root, kein chown von APP_DIR/node_modules an den Dienstbenutzer', () => {
  const s = read('../../post-update.sh');
  // Entkoppelt in eigener Unit, ohne systemd-run im Vordergrund mit Zeitgrenze
  // (Gegenprüfung 25.10.2026) — beide als root mit HOME=/root.
  assert.match(s, /\nHOME=\/root npm install --omit=dev --ignore-scripts --no-audit --no-fund \|\| exit 1\n/);
  assert.match(s, /elif pu_bounded 75 env HOME=\/root npm install --omit=dev --ignore-scripts --no-audit --no-fund; then/);
  assert.doesNotMatch(s, /runuser -u "\$SERVICE_USER" -- env HOME=.*npm/);
  assert.doesNotMatch(s, /chown[^\n]*"\$SERVICE_USER:\$SERVICE_USER"[^\n]*(APP_DIR|node_modules)/);
});

test('dvhub-update.sh: npm install als root mit HOME=/root', () => {
  assert.match(read('../../dvhub-update.sh'), /env HOME="\$\{DVHUB_UPDATE_TEST_HOME:-\/root\}" npm install --omit=dev --ignore-scripts --no-audit --no-fund$/m);
});

// Strix R-0004 (30.10.2026): npm läuft als root. Ohne --ignore-scripts führte
// jedes Paket mit Install-Skript (preinstall/postinstall) bei jedem Update
// Code als root aus. Heute hat keines eines (0/211) — das Skript-Verbot hält
// das so, auch für künftige Abhängigkeiten.
test('R-0004: jedes npm install als root ohne Lifecycle-Skripte', () => {
  for (const f of ['../../install.sh', '../../post-update.sh', '../../dvhub-update.sh']) {
    const s = read(f);
    const calls = s.split('\n').filter((l) => /\bnpm (install|ci) --/.test(l) && !/^\s*#/.test(l) && !/echo /.test(l));
    assert.ok(calls.length > 0, f);
    for (const l of calls) assert.match(l, /--ignore-scripts/, `${f}: ${l.trim()}`);
  }
});

test('R-0004: kein Paket im Lockfile braucht ein Install-Skript', () => {
  const lock = JSON.parse(read('../package-lock.json'));
  const withScripts = Object.entries(lock.packages || {}).filter(([, v]) => v.hasInstallScript).map(([k]) => k);
  assert.deepEqual(withScripts, [], 'Paket mit Install-Skript: mit --ignore-scripts prüfen, ob es ohne läuft');
});
