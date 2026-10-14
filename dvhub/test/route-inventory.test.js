// test/route-inventory.test.js — Sicherheitsnetz für das Aufteilen von
// routes-api.js (2026-10-15).
//
// Liest jede `if (…)`-Bedingung mit `url.pathname` aus routes-api.js und
// routes/*.js und bildet daraus einen Schlüssel aus Methoden und Pfaden
// (z. B. "POST /api/config|/api/config/import"). Gegen die festgehaltene
// Liste (test/fixtures/route-inventory.json) gilt:
//   - keine Route fällt weg (beim Verschieben vergessen),
//   - keine Route steht doppelt (alt und neu zugleich).
// Neue Routen sind erlaubt und werden gemeldet; die Liste neu schreiben mit
//   DVHUB_ROUTE_INVENTORY_WRITE=1 node --test test/route-inventory.test.js
//
// Ob ein verschobener Block auch AUFGERUFEN wird, prüfen die Routen-Tests der
// einzelnen Bereiche (sie gehen über createApiRoutes().handleRequest).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const DVHUB_DIR = path.resolve(import.meta.dirname, '..');
const BASELINE = path.join(DVHUB_DIR, 'test', 'fixtures', 'route-inventory.json');

function routeSources() {
  const files = [path.join(DVHUB_DIR, 'routes-api.js')];
  const dir = path.join(DVHUB_DIR, 'routes');
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).sort()) if (f.endsWith('.js')) files.push(path.join(dir, f));
  }
  return files;
}

/** Bedingungen `if ( … )` mit ausgeglichenen Klammern. */
function* ifConditions(src) {
  const re = /\bif\s*\(/g;
  while (re.exec(src)) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      i++;
    }
    yield src.slice(re.lastIndex, i - 1);
  }
}

export function routeKeys(src) {
  const keys = [];
  for (const cond of ifConditions(src)) {
    if (!cond.includes('url.pathname')) continue;
    const paths = [
      ...[...cond.matchAll(/url\.pathname\s*===\s*'([^']+)'/g)].map((m) => m[1]),
      ...[...cond.matchAll(/url\.pathname\.startsWith\('([^']+)'\)/g)].map((m) => `${m[1]}*`),
    ];
    if (!paths.length) continue;
    const methods = [...cond.matchAll(/req\.method\s*(===|!==)\s*'([A-Z]+)'/g)].map((m) => (m[1] === '!==' ? `!${m[2]}` : m[2]));
    keys.push(`${methods.length ? methods.join('|') : '*'} ${paths.join('|')}`);
  }
  return keys;
}

function currentKeys() {
  return routeSources().flatMap((f) => routeKeys(fs.readFileSync(f, 'utf8'))).sort();
}

const count = (list) => list.reduce((m, k) => m.set(k, (m.get(k) || 0) + 1), new Map());

test('Routen-Inventur: keine Route fällt weg, keine steht doppelt', () => {
  const now = currentKeys();
  if (process.env.DVHUB_ROUTE_INVENTORY_WRITE === '1') {
    fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
    fs.writeFileSync(BASELINE, `${JSON.stringify({ routes: now }, null, 2)}\n`);
  }
  const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8')).routes;
  const nowCount = count(now);
  const baseCount = count(base);
  const dropped = [...baseCount].filter(([k, n]) => (nowCount.get(k) || 0) < n).map(([k]) => k);
  const doubled = [...nowCount].filter(([k, n]) => n > (baseCount.get(k) || 1)).map(([k]) => k);
  assert.deepEqual(dropped, [], 'Routen fehlen (beim Verschieben vergessen?)');
  assert.deepEqual(doubled, [], 'Routen stehen doppelt (alt und neu zugleich?)');
  const added = [...nowCount.keys()].filter((k) => !baseCount.has(k));
  if (added.length) console.log(`route-inventory: neu (${added.length}): ${added.join(', ')}`);
});

test('Routen-Inventur erkennt Pfade, Methoden und Präfixe', () => {
  const src = `
    if (url.pathname === '/api/a' && req.method === 'GET') return x;
    if ((url.pathname === '/api/b' || url.pathname === '/api/c') && req.method === 'POST') {}
    if (url.pathname.startsWith('/api/') && req.method !== 'GET') {}
    if (other === 1) {}`;
  assert.deepEqual(routeKeys(src), ['GET /api/a', 'POST /api/b|/api/c', '!GET /api/*']);
});
