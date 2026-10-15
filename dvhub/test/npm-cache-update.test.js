// test/npm-cache-update.test.js — Update über die Oberfläche scheiterte an
// root-eigenen Einträgen im npm-Cache des Dienstbenutzers (alte Prod .66,
// 2026-10-15: EACCES, Rollback). Nachgestellt in node:22-slim: ohne .npmrc
// Exit 243 (EACCES), mit .npmrc Exit 0.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

test('dvhub/.npmrc lenkt npm auf einen eigenen Cache (gilt auch für älteren Update-Code)', () => {
  assert.match(read('../.npmrc'), /^cache=\$\{HOME\}\/\.cache\/dvhub-npm$/m);
});

test('post-update.sh ruft npm als Dienstbenutzer auf und repariert alte Cache-Rechte', () => {
  const s = read('../../post-update.sh');
  assert.match(s, /NPM_AS=\(runuser -u "\$SERVICE_USER" -- env HOME=/);
  assert.match(s, /if "\$\{NPM_AS\[@\]\}" install --omit=dev; then/);
  assert.match(s, /chown -R "\$SERVICE_USER:\$SERVICE_USER" "\$d"/);
});
