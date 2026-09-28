// test/datenspende-client.test.js — Protokoll-Client COMSYS-Datenspende.
// Referenz: github.com/COMSYS/Datenspende custom_components/powercollect/api.py

import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {
  columnarPayload, classifyError, createDatenspendeClient,
  DatenspendeConnError, DatenspendeServerError, DatenspendeRequestError,
  DatenspendeAuthError, DatenspendeDuplicateError,
} from '../services/datenspende/client.js';

// fetch-Stub: zeichnet Aufrufe auf, antwortet aus einer Tabelle "METHOD path" → {status, body}.
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const path = new URL(url).pathname;
    const key = `${opts.method} ${path}`;
    calls.push({ key, url, headers: opts.headers || {}, body: opts.body });
    const r = typeof routes[key] === 'function' ? routes[key](opts) : routes[key];
    if (!r) return new Response(JSON.stringify({ error: 'not_found', message: key }), { status: 404 });
    if (r.throw) throw r.throw;
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status });
  };
  return { fetchImpl, calls };
}

test('columnarPayload: Sekunden-Offsets je Zähler, fehlende Werte als null, Spalten gleich lang', () => {
  const p = columnarPayload([
    { meter_id: 'm1', timestamp: '2026-09-28T12:00:00Z', power: 100, energy: 1.5 },
    { meter_id: 'm2', timestamp: '2026-09-28T12:00:00Z', power: -50 },
    { meter_id: 'm1', timestamp: '2026-09-28T12:00:10Z', power: 110 },
    { meter_id: 'm1', timestamp: '2026-09-28T12:00:20Z', energy: 1.6 },
  ]);
  assert.equal(p.t0, '2026-09-28T12:00:00Z');
  const m1 = p.meters.find((m) => m.id === 'm1');
  assert.deepEqual(m1.dt, [0, 10, 20]);
  assert.deepEqual(m1.power, [100, 110, null]);
  assert.deepEqual(m1.energy, [1.5, null, 1.6]);
  const m2 = p.meters.find((m) => m.id === 'm2');
  assert.deepEqual(m2, { id: 'm2', dt: [0], power: [-50] });
});

test('classifyError: Einteilung wie in der HA-Integration', () => {
  assert.ok(classifyError(409, { error: 'duplicate_entry' }) instanceof DatenspendeDuplicateError);
  assert.ok(classifyError(400, { error: 'bad_request' }) instanceof DatenspendeRequestError);
  assert.ok(classifyError(409, { error: 'taken_username' }) instanceof DatenspendeAuthError);
  assert.ok(classifyError(401, { error: 'invalid_credentials' }) instanceof DatenspendeAuthError);
  assert.ok(classifyError(403, {}) instanceof DatenspendeAuthError);
  const rl = classifyError(429, {});
  assert.ok(rl instanceof DatenspendeConnError && !(rl instanceof DatenspendeServerError), '429 = später erneut');
  assert.ok(classifyError(503, null) instanceof DatenspendeServerError);
  assert.ok(classifyError(500, { error: 'internal_server_error' }) instanceof DatenspendeServerError);
  assert.ok(classifyError(418, {}) instanceof DatenspendeRequestError, 'Unbekanntes blockiert nie die Warteschlange');
  assert.equal(classifyError(409, { error: 'taken_username' }).code, 'taken_username');
});

test('Einrichtung: sign-up → Haushalt → Client → API-Key mit den richtigen Pfaden/Headern', async () => {
  const { fetchImpl, calls } = fakeFetch({
    'POST /api/v1/web/auth/sign-up/username': { status: 201, body: { token: 'TOK', user: { id: 'U1' } } },
    'POST /api/v1/web/households': { status: 201, body: { id: 'H1' } },
    'POST /api/v1/web/clients': { status: 201, body: { id: 'C1' } },
    'POST /api/v1/web/auth/api-key/create': { status: 201, body: { key: 'KEY' } },
    'POST /api/v1/web/auth/sign-out': { status: 200, body: {} },
  });
  const c = createDatenspendeClient({ baseUrl: 'https://ds.test/', fetchImpl });
  const a = await c.signUp({ username: 'u', password: 'p', consent: true, email: 'e@x' });
  assert.deepEqual(a, { token: 'TOK', userId: 'U1' });
  assert.deepEqual(JSON.parse(calls[0].body), { username: 'u', password: 'p', consent: true, email: 'e@x' });
  assert.equal(await c.createHousehold('TOK', { userId: 'U1', name: 'H', zip: '52062' }), 'H1');
  assert.equal(calls[1].headers.authorization, 'Bearer TOK');
  assert.deepEqual(JSON.parse(calls[1].body), { userId: 'U1', name: 'H', zip: '52062' });
  assert.equal(await c.createClient('TOK', { householdId: 'H1', name: 'DVhub', type: 'dvhub' }), 'C1');
  assert.deepEqual(JSON.parse(calls[2].body), { householdId: 'H1', type: 'dvhub', name: 'DVhub' });
  assert.equal(await c.createApiKey('TOK', { clientId: 'C1', name: 'DVhub API-Key' }), 'KEY');
  await c.signOut('TOK');
  assert.equal(calls.at(-1).key, 'POST /api/v1/web/auth/sign-out');
});

test('signUp ohne Einwilligung wird gar nicht erst gesendet', async () => {
  const { fetchImpl, calls } = fakeFetch({});
  const c = createDatenspendeClient({ fetchImpl });
  await assert.rejects(c.signUp({ username: 'u', password: 'p', consent: false }), /Einwilligung/);
  assert.equal(calls.length, 0);
});

test('submitBatch: x-api-key, gzip ab 1 KB, Antwort accepted/unknownMeters', async () => {
  let received = null;
  const { fetchImpl, calls } = fakeFetch({
    'POST /api/v1/clients/C1/meters/batch': (opts) => {
      received = opts;
      return { status: 201, body: { accepted: 42, unknownMeters: ['m9'] } };
    },
  });
  const c = createDatenspendeClient({ fetchImpl });
  const readings = Array.from({ length: 200 }, (_, i) => ({
    meter_id: 'm1', timestamp: new Date(Date.parse('2026-09-28T12:00:00Z') + i * 10_000).toISOString().replace('.000Z', 'Z'), power: i,
  }));
  const r = await c.submitBatch('KEY', 'C1', readings);
  assert.deepEqual(r, { accepted: 42, unknownMeters: ['m9'] });
  assert.equal(calls[0].headers['x-api-key'], 'KEY');
  assert.equal(received.headers['content-encoding'], 'gzip');
  const decoded = JSON.parse(zlib.gunzipSync(received.body).toString('utf8'));
  assert.equal(decoded.meters[0].dt.length, 200);
  // kleine Batches: ungepackt
  await c.submitBatch('KEY', 'C1', readings.slice(0, 1));
  assert.equal(calls[1].headers['content-encoding'], undefined);
});

test('Netzwerkfehler → DatenspendeConnError (Werte bleiben in der Warteschlange)', async () => {
  const c = createDatenspendeClient({ fetchImpl: async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }); } });
  await assert.rejects(c.submitBatch('KEY', 'C1', [{ meter_id: 'm', timestamp: '2026-09-28T12:00:00Z', power: 1 }]),
    (e) => e instanceof DatenspendeConnError && /ENOTFOUND/.test(e.message));
});
