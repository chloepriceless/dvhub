// T-MANAGED-VENDOR-PROFILES: shipped-Profil-Fixes müssen Bestandsboxen erreichen,
// ohne Operator-Edits zu zerstören. Reconcile-Logik + Drift-Guard fürs Manifest.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decideProfileAction, reconcileVendorProfiles, sha256 } from '../../scripts/reconcile-vendor-profiles.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HERSTELLER = path.join(__dirname, '..', 'hersteller');

test('decideProfileAction: create when active missing', () => {
  assert.equal(decideProfileAction({ active: null, shipped: 'a', known: ['a'] }), 'create');
});
test('decideProfileAction: current when active == shipped', () => {
  assert.equal(decideProfileAction({ active: 'x', shipped: 'x', known: ['x'] }), 'current');
});
test('decideProfileAction: update when active is a known older shipped version', () => {
  assert.equal(decideProfileAction({ active: 'old', shipped: 'new', known: ['old', 'new'] }), 'update');
});
test('decideProfileAction: user_edited when active hash is unknown', () => {
  assert.equal(decideProfileAction({ active: 'edited', shipped: 'new', known: ['old', 'new'] }), 'user_edited');
  assert.equal(decideProfileAction({ active: 'edited', shipped: 'new', known: [] }), 'user_edited');
});

test('reconcile e2e: create / update-unchanged / preserve-edited (.dist) / skip-current', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-'));
  const appH = path.join(tmp, 'app', 'hersteller');
  const cfgH = path.join(tmp, 'cfg', 'hersteller');
  fs.mkdirSync(appH, { recursive: true });
  fs.mkdirSync(cfgH, { recursive: true });

  const OLD = '{"label":"old"}\n';
  const NEW = '{"label":"new"}\n';
  const EDIT = '{"label":"operator-edit"}\n';
  // shipped (neue Versionen)
  fs.writeFileSync(path.join(appH, 'a.json'), NEW); // wird bei fehlend angelegt
  fs.writeFileSync(path.join(appH, 'b.json'), NEW); // aktiv = alte bekannte Version → update
  fs.writeFileSync(path.join(appH, 'c.json'), NEW); // aktiv = editiert → .dist
  fs.writeFileSync(path.join(appH, 'd.json'), NEW); // aktiv = neue Version → current
  // manifest: known-Hashes
  fs.writeFileSync(path.join(appH, '.shipped-hashes.json'), JSON.stringify({
    profiles: {
      'b.json': [sha256(Buffer.from(OLD)), sha256(Buffer.from(NEW))],
      'c.json': [sha256(Buffer.from(OLD)), sha256(Buffer.from(NEW))],
      'd.json': [sha256(Buffer.from(NEW))]
    }
  }));
  // aktive Profile
  fs.writeFileSync(path.join(cfgH, 'b.json'), OLD);   // unveränderte alte Version
  fs.writeFileSync(path.join(cfgH, 'c.json'), EDIT);  // Operator-Edit
  fs.writeFileSync(path.join(cfgH, 'd.json'), NEW);   // bereits neu

  const logs = [];
  const { actions } = reconcileVendorProfiles(path.join(tmp, 'cfg'), path.join(tmp, 'app'), { log: (m) => logs.push(m) });
  const byFile = Object.fromEntries(actions.map((a) => [a.file, a.action]));

  assert.equal(byFile['a.json'], 'create');
  assert.equal(byFile['b.json'], 'update');
  assert.equal(byFile['c.json'], 'user_edited');
  assert.equal(byFile['d.json'], 'current');

  // Effekte auf der Platte:
  assert.equal(fs.readFileSync(path.join(cfgH, 'a.json'), 'utf8'), NEW, 'a angelegt');
  assert.equal(fs.readFileSync(path.join(cfgH, 'b.json'), 'utf8'), NEW, 'b auf neue Version aktualisiert');
  assert.equal(fs.readFileSync(path.join(cfgH, 'c.json'), 'utf8'), EDIT, 'c-Edit UNANGETASTET');
  assert.equal(fs.readFileSync(path.join(cfgH, 'c.json.dist'), 'utf8'), NEW, 'c.json.dist mit neuer Version');
  assert.ok(!fs.existsSync(path.join(cfgH, 'd.json.dist')), 'kein .dist für aktuelles Profil');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('DRIFT-GUARD: aktueller Hash jedes ausgelieferten Profils steht im Manifest', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(HERSTELLER, '.shipped-hashes.json'), 'utf8')).profiles;
  for (const file of fs.readdirSync(HERSTELLER)) {
    if (!file.endsWith('.json') || file.startsWith('.')) continue;
    const cur = sha256(fs.readFileSync(path.join(HERSTELLER, file)));
    assert.ok(
      Array.isArray(manifest[file]) && manifest[file].includes(cur),
      `${file}: aktueller Hash ${cur.slice(0, 12)} fehlt im Manifest — nach jeder Profil-Änderung "node scripts/gen-vendor-profile-hashes.mjs" laufen lassen`
    );
  }
});
