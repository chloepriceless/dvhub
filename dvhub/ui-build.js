// ui-build.js -- Build-Kennung der ausgelieferten Oberfläche (T-0423, 11.11.2026).
//
// Die offene Seite (besonders die Home-Screen-Webapp) vergleicht diese Kennung
// mit der beim Laden gesehenen und lädt nach einem Update neu
// (public/build-watch.js). Sie steckt als Kopfzeile X-DVhub-Build an jeder
// JSON-Antwort (routes-api.js json()), so reicht der vorhandene Status-Poll.
//
// Grundlage: Versionsangabe (v1.0.10+<commit>, ändert sich mit jedem Commit,
// Paket und Image) UND der Inhalt von public/ — damit erkennt die Seite auch
// einen Teststand, der bei gleichem Commit andere Dateien ausliefert (Image
// aus einem Arbeitsstand). Inhalt statt Änderungszeit: gleiche Dateien geben
// auf jeder Box und nach jedem Neustart dieselbe Kennung, ein Neustart allein
// lädt also nichts neu. Nach außen nur ein Hash — die Version steht ohnehin
// in /health, die Dateien sind frei abrufbar.
//
// Einmal beim Start berechnet (~9 MB, wenige zehn ms); eine Änderung an den
// Dateien ohne Neustart zählt erst mit dem Neustart, den jedes Update macht.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function listFiles(dir, rel = '') {
  let entries;
  try {
    entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(dir, r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

export function computeUiBuildId({ appDir, versionLabel }) {
  const hash = crypto.createHash('sha256');
  hash.update(`dvhub-ui\0${String(versionLabel || '')}\0`);
  const publicDir = path.join(appDir, 'public');
  const files = listFiles(publicDir).sort();
  for (const rel of files) {
    let content;
    try {
      content = fs.readFileSync(path.join(publicDir, rel));
    } catch {
      continue;
    }
    hash.update(`${rel}\0${content.length}\0`);
    hash.update(content);
  }
  return hash.digest('hex').slice(0, 12);
}
