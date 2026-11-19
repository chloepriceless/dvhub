// test/pvnode-404-m23.test.js — M23 (Feld 19.11.2026): nach dem Update stand beim
// Start rot „pvnode_error pvnode_http_404“ im Systemprotokoll.
//
// Ursache (am Code und an der API geprüft): DVhub ruft je nach Einstellung
// GET /v2/forecast/{site_id} (Site-ID eingetragen) oder POST /v2/forecast/inline.
// Beide Wege stehen unverändert in api.pvnode.com/openapi.json (2.0.0, 19.11.).
// Ohne gültigen Schlüssel antwortet pvnode 401/403, nicht 404 — ein 404 heißt:
// Schlüssel gültig, aber die eingetragene Site-ID gibt es (für diesen Schlüssel)
// nicht. Das ist eine Einstellung der Anlage, kein Programmfehler. Bisher:
// drei Wiederholungen (1 + 2 + 4 s) bei einem Fehler, der bleibt, und bei jeder
// Aktualisierung erneut rot.
// Jetzt: 404 ohne Wiederholung, eine Warnung je Episode mit Hinweis, was zu
// prüfen ist; nach einem Erfolg (oder geänderter Site-ID) wieder neu.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPvnodeClient, probePvnode } from '../services/forecast/pvnode-client.js';

function withFetch(handler, fn) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => { calls.push({ url: String(url), method: opts?.method }); return handler(String(url), calls.length); };
  return Promise.resolve(fn(calls)).finally(() => { globalThis.fetch = realFetch; });
}

const notFound = () => ({ ok: false, status: 404, json: async () => ({ detail: 'Not Found' }) });
const okBody = () => ({ ok: true, status: 200, json: async () => ({ timezone: 'UTC', values: [{ timestamp: '2026-11-19T12:00:00Z', pv_power: 1000 }] }) });

function client(cfg, logs) {
  return createPvnodeClient({ getCfg: () => cfg, pushLog: (event, data, level) => logs.push({ event, data, level }) }, {});
}

test('404 (Site-ID unbekannt): keine Wiederholungen, eine Warnung je Episode mit Hinweis, kein roter pvnode_error', async () => {
  const cfg = { forecast: { pvnode: { apiKey: 'k', siteId: 'site-geloescht', plan: 'plus' } } };
  const logs = [];
  await withFetch(() => notFound(), async (calls) => {
    const c = client(cfg, logs);
    assert.equal(await c.fetchForecast(), null);
    assert.equal(calls.length, 1, '404 bleibt — nicht wiederholen');
    assert.match(calls[0].url, /\/v2\/forecast\/site-geloescht\?/);
    await c.fetchForecast();
    await c.fetchForecast();
  });
  const warn = logs.filter((l) => l.event === 'pvnode_site_not_found');
  assert.equal(warn.length, 1, 'einmal je Episode');
  assert.equal(warn[0].level, 'warn');
  assert.match(warn[0].data.hint, /Site-ID/);
  assert.equal(logs.filter((l) => l.event === 'pvnode_error').length, 0, 'kein roter Fehler für eine Einstellungssache');
});

test('404: nach Erfolg oder geänderter Site-ID wird ein neuer 404 wieder gemeldet', async () => {
  const cfg = { forecast: { pvnode: { apiKey: 'k', siteId: 'a', plan: 'plus' } } };
  const logs = [];
  let mode = 'nf';
  await withFetch(() => (mode === 'nf' ? notFound() : okBody()), async () => {
    const c = client(cfg, logs);
    await c.fetchForecast();
    cfg.forecast.pvnode.siteId = 'b';
    await c.fetchForecast();
    assert.equal(logs.filter((l) => l.event === 'pvnode_site_not_found').length, 2, 'andere Site-ID → neue Episode');
    mode = 'ok';
    assert.ok((await c.fetchForecast()).length > 0);
    assert.equal(logs.filter((l) => l.event === 'pvnode_ok').length, 1);
  });
});

test('Probe-Anfrage in den Einstellungen nennt beim 404 die Site-ID als Ursache', async () => {
  await withFetch(() => notFound(), async () => {
    const r = await probePvnode({ apiKey: 'k', siteId: 'x' });
    assert.equal(r.ok, false);
    assert.match(r.error, /404/);
    assert.match(r.error, /Site-ID/);
  });
});
