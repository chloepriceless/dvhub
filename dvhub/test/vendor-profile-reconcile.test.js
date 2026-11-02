// T-MANAGED-VENDOR-PROFILES: shipped-Profil-Fixes müssen Bestandsboxen erreichen,
// ohne Operator-Edits zu zerstören. Reconcile-Logik + Drift-Guard fürs Manifest.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

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

// Strix R-0008 (30.10.2026): root gleicht die Profile bei jedem Start ab, der
// Ordner hersteller/ gehört aber dem Dienstbenutzer. Ein Verweis als Profil,
// als <name>.dist oder als ganzer Ordner ließ root die Zieldatei mit dem
// Profilinhalt überschreiben (Container-Test: Opfer 15 → 1570 Bytes).
function symlinkSetup() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-link-')));
  const appH = path.join(tmp, 'app', 'hersteller');
  const cfg = path.join(tmp, 'cfg');
  const outside = path.join(tmp, 'outside');
  fs.mkdirSync(appH, { recursive: true });
  fs.mkdirSync(cfg, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  const NEW = '{"label":"new"}\n';
  fs.writeFileSync(path.join(appH, 'a.json'), NEW);
  fs.writeFileSync(path.join(appH, 'c.json'), NEW);
  fs.writeFileSync(path.join(appH, '.shipped-hashes.json'), JSON.stringify({ profiles: { 'a.json': [sha256(Buffer.from(NEW))], 'c.json': [sha256(Buffer.from(NEW))] } }));
  const victim = path.join(outside, 'opfer');
  fs.writeFileSync(victim, 'unberuehrt\n');
  return { tmp, appDir: path.join(tmp, 'app'), cfg, cfgH: path.join(cfg, 'hersteller'), outside, victim, NEW };
}

test('R-0008: Profil als Verweis → ersetzt, Ziel unberührt', () => {
  const t = symlinkSetup();
  try {
    fs.mkdirSync(t.cfgH);
    fs.symlinkSync(t.victim, path.join(t.cfgH, 'a.json'));
    reconcileVendorProfiles(t.cfg, t.appDir, { log: () => {} });
    assert.equal(fs.readFileSync(t.victim, 'utf8'), 'unberuehrt\n');
    const st = fs.lstatSync(path.join(t.cfgH, 'a.json'));
    assert.ok(st.isFile() && !st.isSymbolicLink());
    assert.equal(fs.readFileSync(path.join(t.cfgH, 'a.json'), 'utf8'), t.NEW);
  } finally { fs.rmSync(t.tmp, { recursive: true, force: true }); }
});

test('R-0008: <name>.dist als Verweis → Ziel unberührt, .dist echte Datei', () => {
  const t = symlinkSetup();
  try {
    fs.mkdirSync(t.cfgH);
    fs.writeFileSync(path.join(t.cfgH, 'c.json'), '{"label":"operator-edit"}\n');
    fs.symlinkSync(t.victim, path.join(t.cfgH, 'c.json.dist'));
    reconcileVendorProfiles(t.cfg, t.appDir, { log: () => {} });
    assert.equal(fs.readFileSync(t.victim, 'utf8'), 'unberuehrt\n');
    const st = fs.lstatSync(path.join(t.cfgH, 'c.json.dist'));
    assert.ok(st.isFile() && !st.isSymbolicLink());
    assert.equal(fs.readFileSync(path.join(t.cfgH, 'c.json.dist'), 'utf8'), t.NEW);
    assert.equal(fs.readFileSync(path.join(t.cfgH, 'c.json'), 'utf8'), '{"label":"operator-edit"}\n', 'Edit bleibt');
  } finally { fs.rmSync(t.tmp, { recursive: true, force: true }); }
});

test('R-0008: hersteller/ als Verweis → eigener Ordner, nichts im Ziel', () => {
  const t = symlinkSetup();
  try {
    fs.symlinkSync(t.outside, t.cfgH);
    reconcileVendorProfiles(t.cfg, t.appDir, { log: () => {} });
    assert.deepEqual(fs.readdirSync(t.outside), ['opfer']);
    const st = fs.lstatSync(t.cfgH);
    assert.ok(st.isDirectory() && !st.isSymbolicLink());
    assert.equal(fs.readFileSync(path.join(t.cfgH, 'a.json'), 'utf8'), t.NEW);
  } finally { fs.rmSync(t.tmp, { recursive: true, force: true }); }
});

// Gegenprüfung zu ad70a264 (P2): der Ordner wurde nur per Name geprüft — tauschte
// der Dienstbenutzer hersteller/ zwischen Prüfung und Schreiben gegen einen
// Verweis, legte root die Datei im Ziel an. Jetzt zählt die Inode des
// Arbeitsordners (chdir + dev/ino).
test('R-0008: hersteller/ wird mitten im Lauf gegen einen Verweis getauscht → nichts im Ziel', () => {
  const t = symlinkSetup();
  const realOpen = fs.openSync;
  let swapped = false;
  fs.openSync = function patched(p, flags, mode) {
    if (!swapped && String(p).includes('.neu-')) {
      swapped = true;
      fs.renameSync(t.cfgH, `${t.cfgH}.alt`);
      fs.symlinkSync(t.outside, t.cfgH);
    }
    return realOpen.call(fs, p, flags, mode);
  };
  try {
    fs.mkdirSync(t.cfgH);
    reconcileVendorProfiles(t.cfg, t.appDir, { log: () => {} });
    assert.ok(swapped, 'Tausch ausgelöst');
    assert.deepEqual(fs.readdirSync(t.outside), ['opfer'], 'nichts im Ziel des Verweises');
    assert.equal(fs.readFileSync(path.join(`${t.cfgH}.alt`, 'a.json'), 'utf8'), t.NEW, 'im ursprünglichen Ordner geschrieben');
  } finally {
    fs.openSync = realOpen;
    fs.rmSync(t.tmp, { recursive: true, force: true });
  }
});

// Gegenprüfung 1c0105a0 (P3): Tausch genau zwischen Prüfung und chdir — die
// dev/ino-Prüfung im Arbeitsordner muss greifen (vorher ohne Test).
test('R-0008: Tausch zwischen Prüfung und chdir → Abbruch, nichts im Ziel', async () => {
  const { inRealDir } = await import('../../scripts/reconcile-vendor-profiles.mjs');
  const t = symlinkSetup();
  const realChdir = process.chdir;
  let swapped = false;
  process.chdir = function patched(d) {
    if (!swapped && d === t.cfgH) {
      swapped = true;
      fs.renameSync(t.cfgH, `${t.cfgH}.alt`);
      fs.symlinkSync(t.outside, t.cfgH);
    }
    return realChdir.call(process, d);
  };
  try {
    fs.mkdirSync(t.cfgH);
    let ran = false;
    assert.throws(() => inRealDir(t.cfgH, () => { ran = true; fs.writeFileSync('a.json', 'x'); }), /ersetzt/);
    assert.ok(swapped);
    assert.equal(ran, false);
    assert.deepEqual(fs.readdirSync(t.outside), ['opfer']);
  } finally {
    process.chdir = realChdir;
    fs.rmSync(t.tmp, { recursive: true, force: true });
  }
});

test('CLI läuft auch über einen Verweis auf den Skriptordner (Paket-Box: /opt/dvhub/scripts → current/scripts)', () => {
  // Gegenprüfung bf393d9f (P2): argv[1] behält den Verweis, import.meta.url zeigt
  // aufs Ziel — der alte Stringvergleich ließ den Abgleich still ausfallen.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-link-'));
  try {
    const realScripts = path.join(tmp, 'releases', '1.0.9', 'scripts');
    fs.mkdirSync(realScripts, { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', '..', 'scripts', 'reconcile-vendor-profiles.mjs'), path.join(realScripts, 'reconcile-vendor-profiles.mjs'));
    fs.symlinkSync(path.join('releases', '1.0.9', 'scripts'), path.join(tmp, 'scripts'));
    const appDir = path.join(tmp, 'app');
    const cfgDir = path.join(tmp, 'cfg');
    fs.mkdirSync(path.join(appDir, 'hersteller'), { recursive: true });
    fs.mkdirSync(path.join(cfgDir, 'hersteller'), { recursive: true });
    fs.writeFileSync(path.join(appDir, 'hersteller', 'a.json'), '{"label":"neu"}\n');
    execFileSync(process.execPath, [path.join(tmp, 'scripts', 'reconcile-vendor-profiles.mjs'), cfgDir, appDir], { stdio: 'pipe' });
    assert.equal(fs.readFileSync(path.join(cfgDir, 'hersteller', 'a.json'), 'utf8'), '{"label":"neu"}\n');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
