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

export function reconcileVendorProfiles(configDir, appDir, { log = console.log } = {}) {
  const appHersteller = path.join(appDir, 'hersteller');
  const cfgHersteller = path.join(configDir, 'hersteller');
  if (!fs.existsSync(appHersteller)) return { actions: [] };
  fs.mkdirSync(cfgHersteller, { recursive: true });
  const manifest = loadManifest(appHersteller);
  const actions = [];

  for (const file of fs.readdirSync(appHersteller)) {
    if (!file.endsWith('.json') || file.startsWith('.')) continue; // .shipped-hashes.json überspringen
    const src = path.join(appHersteller, file);
    const dst = path.join(cfgHersteller, file);
    let shipped, active = null;
    try { shipped = sha256(fs.readFileSync(src)); }
    catch (e) { log(`  [reconcile] ${file}: shipped nicht lesbar (${e.message})`); continue; }
    try { active = fs.existsSync(dst) ? sha256(fs.readFileSync(dst)) : null; }
    catch (e) { log(`  [reconcile] ${file}: aktiv nicht lesbar (${e.message})`); active = null; }

    const action = decideProfileAction({ active, shipped, known: manifest[file] });
    try {
      if (action === 'create') {
        fs.copyFileSync(src, dst);
        log(`  Herstellerprofil angelegt: ${file}`);
      } else if (action === 'update') {
        fs.copyFileSync(src, dst);
        log(`  Herstellerprofil aktualisiert (unverändert → neue Version): ${file}`);
      } else if (action === 'user_edited') {
        fs.copyFileSync(src, `${dst}.dist`);
        log(`  ⚠ Herstellerprofil ${file} lokal geändert — neue Version liegt als ${file}.dist bereit (nicht überschrieben).`);
      } // 'current' → nichts tun
      actions.push({ file, action });
    } catch (e) {
      log(`  [reconcile] ${file}: Aktion '${action}' fehlgeschlagen (${e.message})`);
    }
  }
  return { actions };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , configDir, appDir] = process.argv;
  if (!configDir || !appDir) {
    console.error('usage: reconcile-vendor-profiles.mjs <CONFIG_DIR> <APP_DIR>');
    process.exit(2);
  }
  try { reconcileVendorProfiles(configDir, appDir); }
  catch (e) { console.error(`[reconcile] abgebrochen: ${e.message}`); /* non-fatal */ }
}
