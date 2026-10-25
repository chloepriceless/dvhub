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
  assert.match(s, /if env HOME=\/root npm install --omit=dev; then/);
  assert.doesNotMatch(s, /runuser -u "\$SERVICE_USER" -- env HOME=.*npm/);
  assert.doesNotMatch(s, /chown[^\n]*"\$SERVICE_USER:\$SERVICE_USER"[^\n]*(APP_DIR|node_modules)/);
});

test('dvhub-update.sh: npm install als root mit HOME=/root', () => {
  assert.match(read('../../dvhub-update.sh'), /env HOME="\$\{DVHUB_UPDATE_TEST_HOME:-\/root\}" npm install --omit=dev/);
});
