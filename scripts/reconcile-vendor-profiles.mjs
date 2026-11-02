#!/usr/bin/env node
// reconcile-vendor-profiles.mjs — hält die AKTIVEN Herstellerprofile in
// $CONFIG_DIR/hersteller/ mit den ausgelieferten Profilen in $APP_DIR/hersteller/
// abgeglichen, OHNE Operator-Edits zu zerstören (T-MANAGED-VENDOR-PROFILES).
//
// Problem, das das löst: create-if-missing (Alt-Verhalten) hat ein vorhandenes
// Profil NIE überschrieben → ein Profil-Bugfix (z. B. der Fronius-WMaxLim-Fix)
// erreichte Bestandsboxen nicht. Jetzt: ein UNVERÄNDERTES Profil (Hash kommt in
// der ausgelieferten Historie .shipped-hashes.json vor) wird mit der neuen
// Version überschrieben; ein vom Operator GEÄNDERTES Profil bleibt stehen und die
// neue Version wird als <name>.dist danebengelegt (+ Warnung).
//
// Aufruf (aus install.sh / post-update.sh): node scripts/reconcile-vendor-profiles.mjs <CONFIG_DIR> <APP_DIR>
// Non-fatal by design: jeder Fehler pro Profil wird geloggt, bricht aber nie ab.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Reine Entscheidungsfunktion — ohne fs, damit unit-testbar.
//   active:   Hash des aktiven Profils in CONFIG_DIR (oder null, wenn nicht vorhanden)
//   shipped:  Hash der ausgelieferten Version in APP_DIR
//   known:    Liste aller je ausgelieferten Hashes dieses Profils (aus dem Manifest)
// Rückgabe: 'create' | 'current' | 'update' | 'user_edited'
export function decideProfileAction({ active, shipped, known }) {
  if (active == null) return 'create';          // fehlt → anlegen
  if (active === shipped) return 'current';      // schon der neueste Stand
  const list = Array.isArray(known) ? known : [];
  if (list.includes(active)) return 'update';    // unveränderte alte Version → überschreiben
  return 'user_edited';                          // fremder Hash → Operator-Edit, nicht überschreiben
}

function loadManifest(appHersteller) {
  try {
    const raw = fs.readFileSync(path.join(appHersteller, '.shipped-hashes.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed.profiles === 'object' && parsed.profiles) || {};
  } catch { return {}; }
}

// Strix R-0008 (30.10.2026): root gleicht bei jedem Start ab, $CONFIG_DIR/
// hersteller/ gehört aber dem Dienstbenutzer. copyFileSync folgte einem
// Verweis (Profil, <name>.dist oder der ganze Ordner) und überschrieb die
// Zieldatei als root. Jetzt: Ordner per lstat prüfen (Verweis → echter
// Ordner), hineinwechseln und dev/ino des Arbeitsordners mit dem geprüften
// Ordner vergleichen — danach gelten nur relative Namen, ein späterer Tausch
// des Ordners gegen einen Verweis wirkt nicht mehr (Gegenprüfung ad70a264).
// Aktive Profile mit O_NOFOLLOW lesen (Verweis = fehlt → neu anlegen),
// schreiben als neue Datei (O_EXCL|O_NOFOLLOW) + rename — rename ersetzt
// einen Verweis, statt ihm zu folgen.
const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_NONBLOCK } = fs.constants;

export function ensureRealDir(dir, log = () => {}) {
  let st = null;
  try { st = fs.lstatSync(dir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (st?.isSymbolicLink()) {
    log(`  ⚠ ${dir} war ein Verweis — durch einen eigenen Ordner ersetzt`);
    fs.unlinkSync(dir);
    st = null;
  }
  if (!st) fs.mkdirSync(dir);
  else if (!st.isDirectory()) throw new Error(`${dir} ist kein Ordner`);
}

/**
 * Führt fn() mit dem echten Ordner `dir` als Arbeitsordner aus (nur relative
 * Namen benutzen!) und stellt den vorherigen Arbeitsordner wieder her.
 */
export function inRealDir(dir, fn, log = () => {}, { create = true } = {}) {
  // create:false (nur anzeigen): nichts anlegen und keinen Verweis ersetzen —
  // ein Verweis oder fehlender Ordner wird abgelehnt (Gegenprüfung 1c0105a0).
  if (create) ensureRealDir(dir, log);
  const checked = fs.lstatSync(dir);
  if (checked.isSymbolicLink() || !checked.isDirectory()) {
    throw new Error(create ? `${dir} wurde während des Abgleichs ersetzt` : `${dir} ist kein eigener Ordner (Verweis?)`);
  }
  // Der Aufrufer-Ordner kann gelöscht oder unlesbar sein — dann nach / zurück,
  // ohne das Ergebnis von fn() zu verdecken.
  let prev = '/';
  try { prev = process.cwd(); } catch { /* gelöscht */ }
  process.chdir(dir);
  try {
    const here = fs.statSync('.');
    if (here.dev !== checked.dev || here.ino !== checked.ino) throw new Error(`${dir} wurde während des Abgleichs ersetzt`);
    return fn();
  } finally {
    try { process.chdir(prev); } catch { try { process.chdir('/'); } catch { /* bleibt */ } }
  }
}

/** Datei lesen, ohne einem Verweis zu folgen; null wenn sie fehlt oder ein Verweis ist. */
export function readNoFollow(file) {
  let fd;
  try { fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK); }
  catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ELOOP') return null;
    throw e;
  }
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('keine Datei');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

/** Als neue Datei schreiben und per rename einsetzen (name relativ zum Arbeitsordner). */
export function writeNoFollow(name, data) {
  const tmp = `.${name}.neu-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const fd = fs.openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644);
  try { fs.writeFileSync(fd, data); } finally { fs.closeSync(fd); }
  try { fs.renameSync(tmp, name); }
  catch (e) { try { fs.unlinkSync(tmp); } catch { /* schon weg */ } throw e; }
}

export function reconcileVendorProfiles(configDir, appDir, { log = console.log } = {}) {
  const appHersteller = path.resolve(appDir, 'hersteller');
  if (!fs.existsSync(appHersteller)) return { actions: [] };
  fs.mkdirSync(configDir, { recursive: true });
  const manifest = loadManifest(appHersteller);
  const actions = [];

  inRealDir(path.resolve(configDir, 'hersteller'), () => {
    for (const file of fs.readdirSync(appHersteller)) {
      if (!file.endsWith('.json') || file.startsWith('.')) continue; // .shipped-hashes.json überspringen
      let shippedBuf, shipped, active = null;
      try { shippedBuf = fs.readFileSync(path.join(appHersteller, file)); shipped = sha256(shippedBuf); }
      catch (e) { log(`  [reconcile] ${file}: shipped nicht lesbar (${e.message})`); continue; }
      try {
        const buf = readNoFollow(file);
        active = buf ? sha256(buf) : null;
      } catch (e) { log(`  [reconcile] ${file}: aktiv nicht lesbar (${e.message}) — übersprungen`); continue; }

      const action = decideProfileAction({ active, shipped, known: manifest[file] });
      try {
        if (action === 'create') {
          writeNoFollow(file, shippedBuf);
          log(`  Herstellerprofil angelegt: ${file}`);
        } else if (action === 'update') {
          writeNoFollow(file, shippedBuf);
          log(`  Herstellerprofil aktualisiert (unverändert → neue Version): ${file}`);
        } else if (action === 'user_edited') {
          writeNoFollow(`${file}.dist`, shippedBuf);
          log(`  ⚠ Herstellerprofil ${file} lokal geändert — neue Version liegt als ${file}.dist bereit (nicht überschrieben).`);
        } // 'current' → nichts tun
        actions.push({ file, action });
      } catch (e) {
        log(`  [reconcile] ${file}: Aktion '${action}' fehlgeschlagen (${e.message})`);
      }
    }
  }, log);
  return { actions };
}

// CLI. Über realpath verglichen: auf Paket-Boxen ist /opt/dvhub/scripts ein
// Verweis auf current/scripts — argv[1] behält den Verweis, import.meta.url
// zeigt aufs Ziel; der alte Stringvergleich ließ den Abgleich dort still
// ausfallen (Gegenprüfung bf393d9f, P2).
function invokedDirectly() {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}
if (invokedDirectly()) {
  const [, , configDir, appDir] = process.argv;
  if (!configDir || !appDir) {
    console.error('usage: reconcile-vendor-profiles.mjs <CONFIG_DIR> <APP_DIR>');
    process.exit(2);
  }
  try { reconcileVendorProfiles(configDir, appDir); }
  catch (e) { console.error(`[reconcile] abgebrochen: ${e.message}`); /* non-fatal */ }
}
