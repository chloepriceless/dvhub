// test/outbound-fetch.test.js — Namensprüfung beim Verbinden (wie ntfy, Gesamt-
// prüfung 1.0.9 Hauptbefund 10) auch für die EPEX-priceApiUrl und den
// Uptime-Kuma-Push (1.0.9-Rest).
//
// Gespeichert wird nur geprüft, ob der Host in Ziffern intern ist; ein NAME
// (127.0.0.1.nip.io, der eigene Hostname → 127.0.1.1) kam durch und fetch
// verband dorthin. services/outbound-fetch.js löst den Namen beim
// Verbindungsaufbau auf (outboundLookup), prüft jede Adresse und verbindet
// genau dorthin — kein zweites Auflösen (DNS-Rebinding).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';

import { createOutboundFetch, outboundFetch } from '../services/outbound-fetch.js';
import { createOutboundLookup } from '../services/host-address.js';

// Kleiner Server auf 127.0.0.1, zählt Anfragen.
async function server(handler) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { hits.push({ method: req.method, url: req.url, body, headers: req.headers }); handler(req, res, body); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, hits, close: () => new Promise((r) => srv.close(r)) };
}

// Auflöser-Stubs: Name → Adressen.
const resolveTo = (address, family = 4) => (_host, _opts, cb) => cb(null, [{ address, family }]);

test('Name, der auf die Box selbst zeigt: nicht verbunden (EOUTBOUNDBLOCKED)', async () => {
  const s = await server((_req, res) => res.end('{}'));
  try {
    const f = createOutboundFetch({ lookup: createOutboundLookup(resolveTo('127.0.0.1')) });
    await assert.rejects(() => f(`http://preise.example:${s.port}/api/zones`), (e) => e.code === 'EOUTBOUNDBLOCKED' || /outbound_address_not_allowed/.test(e.message));
    const g = createOutboundFetch({ lookup: createOutboundLookup(resolveTo('169.254.169.254')) });
    await assert.rejects(() => g(`http://metadaten.example:${s.port}/`), /outbound_address_not_allowed/);
    assert.equal(s.hits.length, 0, 'keine Verbindung zur Box');
  } finally { await s.close(); }
});

test('Name mit einer internen unter mehreren Adressen: gesperrt', async () => {
  const f = createOutboundFetch({ lookup: createOutboundLookup((_h, _o, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }])) });
  await assert.rejects(() => f('http://gemischt.example:9/'), /outbound_address_not_allowed/);
});

test('erlaubtes Ziel: fetch-ähnliche Antwort (ok, status, headers.get, json, text, body.getReader), POST mit Body, keine Umleitung', async () => {
  const s = await server((req, res, body) => {
    if (req.url === '/umleitung') { res.writeHead(302, { location: 'http://127.0.0.1:1/' }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'x-test': 'ja' });
    res.end(JSON.stringify({ ok: true, echo: body, url: req.url }));
  });
  try {
    // Prüfstand: Adresse 127.0.0.1 ohne Prüfung zulassen (nur für den Test).
    const f = createOutboundFetch({ lookup: (_h, opts, cb) => (opts?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4)) });
    const r = await f(`http://preise.example:${s.port}/api/prices?zone=DE-LU`, { headers: { accept: 'application/json' } });
    assert.equal(r.ok, true);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('X-Test'), 'ja');
    assert.deepEqual(await r.json(), { ok: true, echo: '', url: '/api/prices?zone=DE-LU' });
    const p = await f(`http://preise.example:${s.port}/api/backfill`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ zone: 'DE-LU' }) });
    assert.equal(JSON.parse(await p.text()).echo, '{"zone":"DE-LU"}');
    const q = await f(`http://preise.example:${s.port}/strom`);
    const reader = q.body.getReader();
    let n = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.length; }
    assert.ok(n > 0, 'Body als Web-Stream lesbar (readJsonCapped)');
    const u = await f(`http://preise.example:${s.port}/umleitung`);
    assert.equal(u.status, 302, 'Umleitungen werden nicht verfolgt (wie ntfy)');
    assert.equal(u.ok, false);
    assert.equal(s.hits.at(-1).headers.host, `preise.example:${s.port}`, 'Host-Kopf = Name (TLS-SNI/virtuelle Hosts)');
  } finally { await s.close(); }
});

test('Zeitlimit über signal bricht ab', async () => {
  const s = await server(() => { /* antwortet nie */ });
  try {
    const f = createOutboundFetch({ lookup: (_h, opts, cb) => (opts?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4)) });
    await assert.rejects(() => f(`http://langsam.example:${s.port}/`, { signal: AbortSignal.timeout(100) }));
  } finally { await s.close(); }
});

const allowLocal = (_h, opts, cb) => (opts?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4));

test('Codex 52880aea P2: ohne signal greift eine Standard-Frist (Kopf und Body), sonst hinge der Preis-Nachimport', async () => {
  const s = await server(() => { /* antwortet nie */ });
  const body = await server((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"a":'); /* Body bleibt offen */ });
  try {
    const f = createOutboundFetch({ lookup: allowLocal, timeoutMs: 150 });
    const t0 = Date.now();
    await assert.rejects(() => f(`http://langsam.example:${s.port}/`));
    const r = await f(`http://langsam.example:${body.port}/`);
    await assert.rejects(() => r.json());
    assert.ok(Date.now() - t0 < 3000, 'beide nach der Frist abgebrochen');
    const src = fs.readFileSync(new URL('../services/outbound-fetch.js', import.meta.url), 'utf8');
    assert.match(src, /timeoutMs = DEFAULT_TIMEOUT_MS/);
  } finally { await s.close(); await body.close(); }
});

test('Codex 52880aea P2: gzip/deflate/br werden entpackt (json, text, body)', async () => {
  const zlib = await import('node:zlib');
  const payload = JSON.stringify({ data: [{ ts: 1, price: 42 }], pad: 'x'.repeat(2000) });
  const enc = { gzip: zlib.gzipSync, deflate: zlib.deflateSync, br: zlib.brotliCompressSync };
  const s = await server((req, res) => {
    const kind = req.url.slice(1);
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': kind });
    res.end(enc[kind](Buffer.from(payload)));
  });
  try {
    const f = createOutboundFetch({ lookup: allowLocal });
    for (const kind of Object.keys(enc)) {
      assert.equal((await (await f(`http://preise.example:${s.port}/${kind}`)).json()).data[0].price, 42, kind);
      const r = await f(`http://preise.example:${s.port}/${kind}`);
      const reader = r.body.getReader();
      const parts = [];
      for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(Buffer.from(value)); }
      assert.equal(Buffer.concat(parts).toString('utf8'), payload, `${kind}: body entpackt`);
    }
  } finally { await s.close(); }
});

test('Codex 5b41e32e P1: kaputte gzip-Antwort, Body ungelesen (Kuma, non-2xx): kein unbehandelter Fehler, späteres Lesen scheitert sauber', async () => {
  const uncaught = [];
  const onUncaught = (e) => uncaught.push(e);
  process.on('uncaughtException', onUncaught);
  const s = await server((_req, res) => { res.writeHead(502, { 'content-encoding': 'gzip' }); res.end(Buffer.from('kein gzip, sondern Müll')); });
  try {
    const f = createOutboundFetch({ lookup: allowLocal });
    const r = await f(`http://kaputt.example:${s.port}/`);
    assert.equal(r.status, 502);
    await new Promise((res) => setTimeout(res, 100));
    await assert.rejects(() => r.text());
    assert.deepEqual(uncaught, [], 'kein Absturz durch den Entpacker');
  } finally { process.off('uncaughtException', onUncaught); await s.close(); }
});

test('Codex 5b41e32e P2: Abbruch des entpackten Bodys schließt die Verbindung (readJsonCapped-Abbruch)', async () => {
  const zlib = await import('node:zlib');
  let closedAt = null;
  const s = await server((req, res) => {
    res.writeHead(200, { 'content-encoding': 'gzip' });
    const gz = zlib.createGzip();
    gz.pipe(res);
    const tick = setInterval(() => { gz.write(Buffer.alloc(64 * 1024, 97)); gz.flush(); }, 20);
    res.on('close', () => { clearInterval(tick); closedAt = Date.now(); });
  });
  try {
    const f = createOutboundFetch({ lookup: allowLocal, timeoutMs: 10_000 });
    const r = await f(`http://gross.example:${s.port}/`);
    const reader = r.body.getReader();
    await reader.read();
    const t0 = Date.now();
    await reader.cancel();
    for (let i = 0; i < 50 && closedAt == null; i += 1) await new Promise((res) => setTimeout(res, 20));
    assert.ok(closedAt != null && closedAt - t0 < 1000, 'Verbindung nach dem Abbruch zu, nicht erst nach der Frist');
  } finally { await s.close(); }
});

test('nur http/https; Standard-Abruf prüft mit outboundLookup', async () => {
  await assert.rejects(() => outboundFetch('file:///etc/passwd'), /unsupported_protocol/);
  const src = fs.readFileSync(new URL('../services/outbound-fetch.js', import.meta.url), 'utf8');
  assert.match(src, /lookup = outboundLookup/);
  assert.match(src, /agent: false/);
});

// ── Aufrufstellen ────────────────────────────────────────────────────────────

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('EPEX-Abruf (epex-fetch.js) holt dvhub.online/priceApiUrl über den geprüften Abruf', async () => {
  const { createEpexFetcher } = await import('../epex-fetch.js');
  const seen = { outbound: [], global: [] };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { seen.global.push(String(url)); return { ok: false, status: 503, json: async () => ({}) }; };
  try {
    const state = { epex: { ok: false, data: [] } };
    const ctx = {
      state, pushLog: () => {},
      getCfg: () => ({ epex: { enabled: true, bzn: 'DE-LU', timezone: 'Europe/Berlin', priceApiUrl: 'https://preise.example', priceSource: 'dvhub' } }),
      outboundFetch: async (url) => { seen.outbound.push(String(url)); return { ok: false, status: 503, json: async () => ({}) }; },
    };
    await createEpexFetcher(ctx).fetchEpexDay();
  } finally { globalThis.fetch = realFetch; }
  assert.ok(seen.outbound.some((u) => u.startsWith('https://preise.example/api/prices')), JSON.stringify(seen));
  assert.ok(!seen.global.some((u) => u.includes('preise.example')), 'priceApiUrl nie über das ungeprüfte fetch');
  assert.match(read('epex-fetch.js'), /ctx\.outboundFetch \|\| outboundFetch/);
});

test('EPEX-Routen (zones, gaps, backfill) holen priceApiUrl über den geprüften Abruf', () => {
  const src = read('routes-api.js');
  for (const p of ['/api/epex/zones', '/api/epex/gaps', '/api/epex/backfill']) {
    const block = new RegExp(`url\\.pathname === '${p.replace(/\//g, '\\/')}'[\\s\\S]*?\\n {4}\\}\\n`).exec(src)?.[0] || '';
    assert.ok(block, p);
    assert.match(block, /priceFetch\(`\$\{baseUrl\}/, `${p}: priceFetch statt fetch`);
    assert.doesNotMatch(block, /[^.a-zA-Z]fetch\(`\$\{baseUrl\}/, `${p}: kein ungeprüftes fetch`);
  }
  assert.match(src, /const priceFetch = \(\.\.\.a\) => \(ctx\.outboundFetch \|\| outboundFetch\)\(\.\.\.a\)/);
});

test('Uptime-Kuma: Herzschlag (server.js) und Test-Push (routes-api.js) über den geprüften Abruf', () => {
  const server = read('server.js');
  const hb = /const sendHeartbeat = async[\s\S]*?\n {4}\};/.exec(server)?.[0] || '';
  assert.match(hb, /await outboundFetch\(pushUrl \+ sep/);
  const routes = read('routes-api.js');
  const once = /async function kumaPushOnce[\s\S]*?\n\s{2}\}\n/.exec(routes)?.[0] || '';
  assert.match(once, /await \(ctx\.outboundFetch \|\| outboundFetch\)\(pushUrl \+ sep/);
});

test('Preis-Nachimport (history-import.js) und zentrale Marktwerte holen priceApiUrl über den geprüften Abruf', () => {
  const hi = read('history-import.js');
  const range = /async function fetchDvhubApiRange[\s\S]*?\n\}/.exec(hi)?.[0] || '';
  assert.match(range, /priceFetchImpl\(url/);
  assert.match(hi, /priceFetchImpl = outboundFetch/);
  const mv = read('energy-charts-market-values.js');
  assert.match(mv, /fetchCentralSolarMarketValues\(\{ year, baseUrl: centralBaseUrl, fetchImpl: centralFetchImpl \}\)/);
  assert.match(mv, /centralFetchImpl = outboundFetch/);
});
