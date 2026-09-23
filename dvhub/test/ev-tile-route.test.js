// test/ev-tile-route.test.js -- /api/ev (Leitstand-Kachel E-Auto).
// Statische Pruefung wie integrations-vrm-route.test.js: routes-api.js braucht
// fuer einen echten HTTP-Lauf einen voll bestueckten ctx.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.resolve(__dirname, '..', 'routes-api.js'), 'utf8');
const block = (method) => {
  const m = src.match(new RegExp(`url\\.pathname === '/api/ev' && req\\.method === '${method}'[\\s\\S]*?\\n    \\}\\n`));
  assert.ok(m, `${method} /api/ev fehlt`);
  return m[0];
};

describe('/api/ev', () => {
  it('GET und POST verlangen Auth', () => {
    assert.match(block('GET'), /^[^\n]*\n\s*if \(!checkAuth\(req, res\)\) return;/);
    assert.match(block('POST'), /^[^\n]*\n\s*if \(!checkAuth\(req, res\)\) return;/);
  });

  it('POST fasst nur optimizer an — nie evcc oder wallbox (anders als /api/integrations/evcc)', () => {
    const b = block('POST');
    assert.doesNotMatch(b, /next\.evcc|next\.wallbox/);
    assert.match(b, /Object\.assign\(next\.optimizer, patch\)/);
    assert.match(b, /parseEvDeparturePatch\(body\.departure\)/);
  });

  it('GET liefert Plan aus dem EOS-Inspector, nur wenn das Auto mitplant', () => {
    assert.match(block('GET'), /opt\.eosOptimizeEv === true && ctx\.inspector\?\.getEos/);
  });

  it('Kachel ist im Leitstand eingebunden', () => {
    const html = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'index.html'), 'utf8');
    assert.match(html, /id="evTile"/);
    assert.match(html, /<script src="\/ev-tile\.js/);
  });
});
