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
    // Seit 2026-09-26 delegiert die Route an die geteilte Primitive
    // applyEvConfigPatch (services/control-commands.js), die auch die
    // MQTT-Steuerung nutzt. Die optimizer-Logik wird dort geprüft.
    assert.match(b, /applyEvConfigPatch\(ctx,/);
    const cc = fs.readFileSync(path.resolve(__dirname, '..', 'services', 'control-commands.js'), 'utf8');
    assert.match(cc, /Object\.assign\(next\.optimizer, patch\)/);
    assert.match(cc, /parseEvDeparturePatch\(body\.departure\)/);
    assert.doesNotMatch(cc, /next\.evcc|next\.wallbox/);
  });

  it('GET liefert Plan aus dem EOS-Inspector, nur wenn das Auto mitplant', () => {
    assert.match(block('GET'), /opt\.eosOptimizeEv === true && ctx\.inspector\?\.getEos/);
  });

  it('Kachel ist im Leitstand eingebunden', () => {
    const html = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'index.html'), 'utf8');
    assert.match(html, /id="evTile"/);
    assert.match(html, /<script src="\/ev-tile\.js/);
  });

  it('Kachel steckt auch im E-Auto-Panel der Family-Ansicht (ein Markup in ev-tile.js)', () => {
    const pub = path.resolve(__dirname, '..', 'public');
    const fam = fs.readFileSync(path.join(pub, 'family.html'), 'utf8');
    assert.match(fam, /id="p-evtile"/);
    assert.match(fam, /<script src="\/ev-tile\.js/);
    assert.match(fam, /href="\/ev-tile\.css/);
    assert.ok(fam.indexOf('<script src="/ev-tile.js') < fam.indexOf('<script src="/family.js'), 'ev-tile.js vor family.js');
    const js = fs.readFileSync(path.join(pub, 'ev-tile.js'), 'utf8');
    assert.match(js, /id=\\"evOptimize\\"/, 'Markup lebt in ev-tile.js');
    assert.match(fs.readFileSync(path.join(pub, 'family.js'), 'utf8'), /DVhubEvTile\.mount/);
  });
});
