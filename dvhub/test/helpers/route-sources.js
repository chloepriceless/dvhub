// test/helpers/route-sources.js — Quelltext aller Routen-Dateien (routes-api.js
// und routes/*.js) für Tests, die die Form eines Handlers per Regex prüfen.
// Seit routes-api.js in Bereichs-Module aufgeteilt wird (2026-10-15), steht
// ein Handler nicht mehr zwingend in routes-api.js.
import fs from 'node:fs';
import path from 'node:path';

const DVHUB_DIR = path.resolve(import.meta.dirname, '..', '..');

export function readRouteSources() {
  const files = [path.join(DVHUB_DIR, 'routes-api.js')];
  const dir = path.join(DVHUB_DIR, 'routes');
  for (const f of fs.readdirSync(dir).sort()) if (f.endsWith('.js')) files.push(path.join(dir, f));
  return files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
}
