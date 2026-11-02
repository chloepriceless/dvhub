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
test('R-0004: jedes npm install in den Shell-Skripten ohne Lifecycle-Skripte', async () => {
  // Gegenprüfung f5ea8f2d (P3): alle versionierten *.sh, jede Form
  // (npm install, npm i, npm ci, npm --prefix … install), auch nach `;`/`&&`.
  const { execFileSync } = await import('node:child_process');
  const root = new URL('../../', import.meta.url);
  const files = execFileSync('git', ['ls-files', '*.sh', '**/*.sh'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.ok(files.includes('post-update.sh') && files.includes('dvhub-update.sh'), files.join(' '));
  const NPM_INSTALL = /\bnpm\b(?:\s+--?[\w-]+(?:[ =](?:"[^"]*"|\S+))?)*\s+(?:install|i|ci)\b/;
  let seen = 0;
  for (const f of files) {
    const lines = fs.readFileSync(new URL(f, root), 'utf8').split('\n');
    for (const l of lines) {
      const code = l.replace(/^\s+/, '');
      if (code.startsWith('#') || /^echo\b/.test(code) || /--description\b/.test(code)) continue;
      if (!NPM_INSTALL.test(code)) continue;
      seen += 1;
      assert.match(code, /--ignore-scripts/, `${f}: ${code}`);
    }
  }
  assert.ok(seen >= 5, `npm-install-Aufrufe gefunden: ${seen}`);
});

test('R-0004: der Wächter erkennt auch abweichende Schreibweisen', () => {
  const NPM_INSTALL = /\bnpm\b(?:\s+--?[\w-]+(?:[ =](?:"[^"]*"|\S+))?)*\s+(?:install|i|ci)\b/;
  for (const l of ['HOME=/root npm install || exit 1', 'npm --prefix "$APP_DIR" install --omit=dev', 'cd x; npm ci', 'npm i']) {
    assert.ok(NPM_INSTALL.test(l), l);
  }
});

test('R-0004: kein Paket im Lockfile braucht ein Install-Skript', () => {
  const lock = JSON.parse(read('../package-lock.json'));
  const withScripts = Object.entries(lock.packages || {}).filter(([, v]) => v.hasInstallScript).map(([k]) => k);
  assert.deepEqual(withScripts, [], 'Paket mit Install-Skript: mit --ignore-scripts prüfen, ob es ohne läuft');
});
