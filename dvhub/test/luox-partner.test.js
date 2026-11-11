// Offizielle Lumenaza-Partner-API (services/tariff-provider/luox-partner-client.js):
// OAuth2 Client Credentials, nur lesende Endpunkte, Antworten aus den
// Beispielen der OpenAPI-Spezifikation (test/fixtures/lumenaza-partner).
// Vorbereitet: Christin hat noch keine Partner-Zugangsdaten — es geht nie
// etwas ins Netz.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createLumenazaPartnerClient, PARTNER_HOSTS } from '../services/tariff-provider/luox-partner-client.js';

const FIX = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'lumenaza-partner', 'responses.json'), 'utf8'));
const CLIENT_ID = 'partner-client-id';
const CLIENT_SECRET = 'partner-client-secret-xyz';

function response(status, body) {
  const text = JSON.stringify(body);
  return { status, ok: status < 400, headers: { get: () => 'application/json' }, text: async () => text };
}

function fakePartner({ host = PARTNER_HOSTS.prod, rejectFirstGet = false, tokenStatus = 200 } = {}) {
  const calls = [];
  let tokens = 0;
  let gets = 0;
  const fn = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u, init });
    assert.equal(`${u.protocol}//${u.host}`, host, 'richtiger Server');
    if (u.pathname === '/oauth2/token/') {
      assert.equal(init.method, 'POST');
      if (tokenStatus !== 200) return response(tokenStatus, FIX.token['401']);
      tokens += 1;
      return response(200, { ...FIX.token['200'], access_token: `tok-${tokens}` });
    }
    assert.equal(init.method || 'GET', 'GET', 'außer dem Token nur GET');
    gets += 1;
    if (rejectFirstGet && gets === 1) return response(401, { detail: 'Authentication credentials were not provided.' });
    const p = u.pathname;
    if (p === '/v3/prices/epex_day_ahead/') return response(200, FIX.epex_day_ahead['200']);
    if (p.endsWith('/feed/')) return response(200, FIX.producer_feed['200']);
    if (p.endsWith('/forecast/')) return response(200, FIX.producer_forecast['200']);
    if (p.endsWith('/live_data/quality/')) return response(200, FIX.producer_live_data_quality['200']);
    if (p.endsWith('/outage_energy/')) return response(200, FIX.producer_outage_energy['200']);
    if (p.endsWith('/plant_data/')) return response(200, FIX.producer_plant_data['200']);
    if (p.endsWith('/supply/')) return response(200, FIX.consumer_supply['200']);
    return response(404, { detail: 'Not found.' });
  };
  fn.calls = calls;
  return fn;
}

test('Token per Client Credentials (Formular, nur Lese-Scope), danach Bearer; Token wird wiederverwendet', async () => {
  let t = Date.parse('2026-11-11T12:00:00Z');
  const fetchImpl = fakePartner();
  const c = createLumenazaPartnerClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetchImpl, now: () => t });
  await c.epexDayAhead({ from: '2024-06-15T00:00:00Z', to: '2024-06-16T00:00:00Z' });
  await c.epexDayAhead({ from: '2024-06-15T00:00:00Z', to: '2024-06-16T00:00:00Z' });
  const tokenCalls = fetchImpl.calls.filter((x) => x.url.pathname === '/oauth2/token/');
  assert.equal(tokenCalls.length, 1);
  const form = new URLSearchParams(tokenCalls[0].init.body);
  assert.equal(tokenCalls[0].init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(form.get('grant_type'), 'client_credentials');
  assert.equal(form.get('client_id'), CLIENT_ID);
  assert.equal(form.get('client_secret'), CLIENT_SECRET);
  assert.equal(form.get('scope'), 'read');
  const get = fetchImpl.calls.find((x) => x.url.pathname === '/v3/prices/epex_day_ahead/');
  assert.equal(get.init.headers.Authorization, 'Bearer tok-1');
  assert.ok(get.init.signal, 'Zeitgrenze');
  // Nach Ablauf (3600 s − Puffer) neues Token
  t += 3600_000;
  await c.epexDayAhead({ from: '2024-06-15T00:00:00Z', to: '2024-06-16T00:00:00Z' });
  assert.equal(fetchImpl.calls.filter((x) => x.url.pathname === '/oauth2/token/').length, 2);
});

test('EPEX Day-Ahead: from/to (UTC) + aggregation_type=raw, Zeilen in DVhub-Form', async () => {
  const fetchImpl = fakePartner();
  const c = createLumenazaPartnerClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetchImpl });
  const rows = await c.epexDayAhead({ from: '2024-06-15T00:00:00Z', to: '2024-06-16T00:00:00Z' });
  const get = fetchImpl.calls.find((x) => x.url.pathname === '/v3/prices/epex_day_ahead/');
  assert.equal(get.url.searchParams.get('from'), '2024-06-15T00:00:00Z');
  assert.equal(get.url.searchParams.get('to'), '2024-06-16T00:00:00Z');
  assert.equal(get.url.searchParams.get('aggregation_type'), 'raw');
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0], { ts: Date.parse('2024-06-15T00:00:00Z'), durationMs: 3600_000, eurMwh: 68.42, ctKwh: 6.842 });
  assert.equal(rows[3].ctKwh, -0.42);
});

test('Erzeuger: Einspeisung, Prognose, Datenqualität, Ausfallarbeit, Anlagendaten; Verbraucher: Bezug (verschachtelte Liste)', async () => {
  const fetchImpl = fakePartner();
  const c = createLumenazaPartnerClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetchImpl });
  const range = { userId: 'u-1', contractId: 'P90000001-1', start: '2024-06-26T00:00:00Z', end: '2024-06-27T00:00:00Z' };
  const feed = await c.producerFeed(range);
  assert.deepEqual(feed, [{ ts: Date.parse('2024-06-26T00:00:00Z'), durationMs: 900_000, wh: 1000 }]);
  const feedCall = fetchImpl.calls.find((x) => x.url.pathname.endsWith('/feed/'));
  assert.equal(feedCall.url.pathname, '/v3/producers/u-1/contracts/P90000001-1/feed/');
  assert.equal(feedCall.url.searchParams.get('aggregation_type'), 'raw');
  assert.equal(feedCall.url.searchParams.get('start'), '2024-06-26T00:00:00Z');
  assert.equal(feedCall.url.searchParams.get('end'), '2024-06-27T00:00:00Z');
  assert.deepEqual(await c.producerForecast(range), [{ ts: Date.parse('2024-06-26T00:00:00Z'), durationMs: 900_000, wh: 500 }]);
  assert.deepEqual(await c.producerOutageEnergy(range), [{ ts: Date.parse('2024-06-26T00:00:00Z'), durationMs: 900_000, wh: 1000 }]);
  const quality = await c.producerLiveDataQuality(range);
  assert.equal(quality[0].coverage, 0.98);
  const plant = await c.producerPlantData(range);
  assert.equal(plant.capacity, 5000);
  assert.equal(plant.production_type, 'solar');
  const supply = await c.consumerSupply({ ...range, contractId: 'C90000001-1' });
  assert.equal(supply.length, 2, 'Liste in der Liste wird flach');
  assert.deepEqual(supply[1], { ts: Date.parse('2024-06-01T01:00:00Z'), durationMs: 3600_000, wh: 1200 });
  const supplyCall = fetchImpl.calls.find((x) => x.url.pathname.endsWith('/supply/'));
  assert.equal(supplyCall.url.pathname, '/v3/consumers/u-1/contracts/C90000001-1/supply/');
});

test('Pfad-Teile werden kodiert (kein Ausbruch aus dem Pfad)', async () => {
  const fetchImpl = fakePartner();
  const c = createLumenazaPartnerClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetchImpl });
  await c.producerPlantData({ userId: '../../oauth2', contractId: 'P1/../x' }).catch(() => {});
  const call = fetchImpl.calls.find((x) => x.url.pathname.includes('plant_data'));
  assert.ok(call.url.pathname.startsWith('/v3/producers/'), call.url.pathname);
  assert.ok(!call.url.pathname.includes('/../'));
});

test('Testserver wählbar', async () => {
  const fetchImpl = fakePartner({ host: PARTNER_HOSTS.test });
  const c = createLumenazaPartnerClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, environment: 'test', fetchImpl });
  assert.equal((await c.epexDayAhead({ from: '2024-06-15T00:00:00Z', to: '2024-06-16T00:00:00Z' })).length, 4);
});

test('401 beim Abruf: einmal neues Token holen und wiederholen', async () => {
  const fetchImpl = fakePartner({ rejectFirstGet: true });
  const c = createLumenazaPartnerClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetchImpl });
  const rows = await c.epexDayAhead({ from: '2024-06-15T00:00:00Z', to: '2024-06-16T00:00:00Z' });
  assert.equal(rows.length, 4);
  assert.equal(fetchImpl.calls.filter((x) => x.url.pathname === '/oauth2/token/').length, 2);
});

test('Abgelehnte Zugangsdaten = auth ohne Geheimnis in der Meldung; fehlende = auth ohne Abruf', async () => {
  const fetchImpl = fakePartner({ tokenStatus: 401 });
  const c = createLumenazaPartnerClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetchImpl });
  await assert.rejects(c.epexDayAhead({ from: 'a', to: 'b' }), (e) => e.code === 'auth' && !e.message.includes(CLIENT_SECRET));
  const none = createLumenazaPartnerClient({ clientId: '', clientSecret: '', fetchImpl: async () => { throw new Error('darf nicht abfragen'); } });
  await assert.rejects(none.epexDayAhead({ from: 'a', to: 'b' }), (e) => e.code === 'auth');
});

test('Fehlerantwort 400 (Vertrag liefert noch nicht) = api mit Hinweis', async () => {
  const fetchImpl = async (url) => (String(url).includes('/oauth2/token/')
    ? response(200, FIX.token['200'])
    : response(400, FIX.producer_feed['400']));
  const c = createLumenazaPartnerClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetchImpl });
  await assert.rejects(c.producerFeed({ userId: 'u', contractId: 'P1', start: 'a', end: 'b' }),
    (e) => e.code === 'api' && /delivery start/.test(e.message));
});
