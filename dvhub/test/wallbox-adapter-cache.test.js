// Wallbox-Adapter halten Zustand (Nexblue-Lebenszeichen, EM2GO-Modus, SmartEVSE-Modus,
// EEBUS-LPC-Grenze, Schreib-Entprellung). server.js baute bis 20.10. für jeden Befehl und
// jede Statusabfrage einen neuen Adapter — der Zustand ging verloren (Codex-Review 20.10.).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createWallboxAdapterCache } from '../services/wallbox/adapter-cache.js';

test('gleicher Typ + gleiche Einstellungen → derselbe Adapter; Einstellung geändert → neuer', () => {
  let cfg = { keba: { host: '1.2.3.4' }, nexblue: { host: '5.6.7.8' } };
  let built = 0;
  const cache = createWallboxAdapterCache((type) => ({ type, n: ++built }), (type) => cfg[type]);
  const a = cache.get('keba');
  assert.equal(cache.get('keba'), a);
  assert.notEqual(cache.get('nexblue'), a);
  cfg = { ...cfg, keba: { host: '1.2.3.9' } };
  const b = cache.get('keba');
  assert.notEqual(b, a);
  assert.equal(cache.get('keba'), b);
  assert.equal(built, 3);
  assert.equal(cache.get(''), null);
});

test('server.js nutzt den Cache für directWallboxAdapter', () => {
  const src = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(src, /createWallboxAdapterCache\(buildWallboxAdapter,/);
  assert.match(src, /function directWallboxAdapter\(type\) \{\n {2}return wallboxAdapterCache\.get\(type\);/);
});
