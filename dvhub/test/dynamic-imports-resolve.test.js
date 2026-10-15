// test/dynamic-imports-resolve.test.js — jeder relative dynamische Import im
// Backend (`await import('./…')`) zeigt auf eine vorhandene Datei.
//
// Statische Importe prüft schon das Laden der Module; dynamische scheitern
// erst, wenn der Zweig läuft. 2026-10-15: Beim Herauslösen von
// routes/notification-routes.js blieben die Provider-Importe auf
// './services/…' stehen (jetzt relativ zu routes/) — Test-Versand gab 500.
// ESLint prüft solche Pfade nicht (Codex-Review fand es).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const DVHUB_DIR = path.resolve(import.meta.dirname, '..');
const SKIP = new Set(['node_modules', 'public', 'test', 'python', '.git']);

function* backendFiles(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* backendFiles(p);
    else if (/\.m?js$/.test(e.name)) yield p;
  }
}

export function relativeDynamicImports(src) {
  return [...src.matchAll(/import\(\s*['"`](\.{1,2}\/[^'"`$]+)['"`]\s*\)/g)].map((m) => m[1]);
}

test('Muster erkennt relative dynamische Importe, keine Pakete oder Bausteine', () => {
  const src = "await import('./a.js'); await import(\"../b/c.js\"); await import('node:fs'); await import('pg'); await import(`./x/${n}.js`)";
  assert.deepEqual(relativeDynamicImports(src), ['./a.js', '../b/c.js']);
});

test('alle relativen dynamischen Importe im Backend sind auflösbar', () => {
  const missing = [];
  let count = 0;
  for (const file of backendFiles(DVHUB_DIR)) {
    for (const spec of relativeDynamicImports(fs.readFileSync(file, 'utf8'))) {
      count++;
      if (!fs.existsSync(path.resolve(path.dirname(file), spec))) missing.push(`${path.relative(DVHUB_DIR, file)} → ${spec}`);
    }
  }
  assert.ok(count > 0, 'keine dynamischen Importe gefunden — Muster kaputt?');
  assert.deepEqual(missing, []);
});
