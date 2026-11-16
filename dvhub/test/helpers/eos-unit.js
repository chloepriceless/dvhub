// test/helpers/eos-unit.js
// Wiederverwendbare Prüfungen für die Fehlerklasse „Native-Install/Umstieg:
// Permission- und Config-Pfad-Fallen" (Tester-Fund 1.0.10, Pi 4B/Debian 13).
//
// Kern des Fehlers: eos-provision.sh schreibt WorkingDirectory=$EOS_DIR (den
// root-eigenen Checkout). EOS sucht seine EOS.config.json u. a. im
// Arbeitsverzeichnis (CWD). Ohne gesetztes EOS_CONFIG_DIR nimmt EOS dort eine
// liegengebliebene Alt-Konfig und scheitert beim Autosave/Migrieren jede Minute
// mit PermissionError. Diese Helfer machen die Gegenmaßnahmen prüfbar, damit
// künftige Provisioning-Änderungen dieselbe Klasse automatisch mitprüfen.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Env-Wert aus einer generierten systemd-Unit lesen (letzte Zeile gewinnt — wie
// systemd mehrere Environment=KEY=… auflöst).
export function unitEnv(unit, key) {
  const re = new RegExp(`^Environment=${key}=(.*)$`, 'mg');
  let m;
  let val = null;
  while ((m = re.exec(unit)) !== null) val = m[1];
  return val;
}

export function unitWorkingDirectory(unit) {
  return (/^WorkingDirectory=(.*)$/m.exec(unit) || [])[1] ?? null;
}

// Kernaussage der Fehlerklasse: EOS bekommt einen BESCHREIBBAREN Config-Ordner,
// der NICHT das (root-eigene) Arbeitsverzeichnis ist, und der Ordner existiert.
// Gibt den Pfad zurück. Schlägt gegen den Stand VOR dem Fix fehl (kein
// EOS_CONFIG_DIR in der Unit).
export function assertWritableConfigDir(unit, { notEqualTo = null } = {}) {
  const cfg = unitEnv(unit, 'EOS_CONFIG_DIR');
  assert.ok(cfg, 'eos.service muss EOS_CONFIG_DIR setzen (sonst CWD-Falle → PermissionError)');
  const wd = unitWorkingDirectory(unit);
  assert.notEqual(cfg, wd, 'EOS_CONFIG_DIR darf nicht das Arbeitsverzeichnis (root-eigener Checkout) sein');
  if (notEqualTo != null) assert.notEqual(cfg, notEqualTo, 'EOS_CONFIG_DIR darf nicht der Checkout sein');
  assert.ok(existsSync(cfg), `EOS_CONFIG_DIR (${cfg}) muss angelegt sein`);
  return cfg;
}

// Nach dem Provisioning darf im Checkout KEINE EOS.config.json liegenbleiben —
// sonst nähme EOS sie beim Start als CWD-Treffer. Schlägt gegen den Stand VOR
// dem Fix fehl (Alt-Datei bleibt liegen).
export function assertNoStrayConfigInCheckout(checkoutDir) {
  assert.ok(
    !existsSync(join(checkoutDir, 'EOS.config.json')),
    'EOS.config.json darf nach dem Provisioning nicht im root-eigenen Checkout liegen',
  );
}
