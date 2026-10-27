// Abrufe der Anbieterpreise (services/tariff-provider): Tibber und LichtBlick
// gegen nachgebaute Antworten. Es geht nie etwas ins Netz.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fetchTibberPrices, TIBBER_API_URL } from '../services/tariff-provider/tibber-client.js';
import { fetchLichtblickPrices, B2C_TOKEN_URL, GRAPH_URL, B2C_CLIENT_ID } from '../services/tariff-provider/lichtblick-client.js';
import { pointsToSlots, localMidnight } from '../services/tariff-provider/common.js';

function jsonResponse(status, body) {
  return { status, ok: status < 400, text: async () => JSON.stringify(body) };
}

function recordingFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
  fn.calls = calls;
  return fn;
}

const quarterPrices = (startIso, n, base) => Array.from({ length: n }, (_, i) => ({
  startsAt: new Date(new Date(startIso).getTime() + i * 900_000).toISOString(),
  total: base + i * 0.001, energy: 0.1, tax: 0.05, currency: 'EUR'
}));

// ── Tibber ────────────────────────────────────────────────────────────────

test('Tibber: Viertelstundenpreise mit Bearer-Token, total in ct/kWh', async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(200, {
    data: { viewer: { homes: [{
      id: 'home-1', appNickname: 'Zuhause',
      currentSubscription: { status: 'running', priceInfo: { today: quarterPrices('2026-11-01T00:00:00+01:00', 4, 0.3012), tomorrow: [] } }
    }] } }
  }));
  const r = await fetchTibberPrices({ token: 'tok-123', fetchImpl });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, TIBBER_API_URL);
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, 'Bearer tok-123');
  const body = JSON.parse(fetchImpl.calls[0].init.body);
  assert.match(body.query, /priceInfo\(resolution: QUARTER_HOURLY\)/);
  assert.equal(r.provider, 'tibber');
  assert.deepEqual(r.account, { homeId: 'home-1', label: 'Zuhause', status: 'running' });
  assert.equal(r.slots.length, 4);
  assert.equal(r.slots[0].ctKwh, 30.12);
  assert.equal(r.slots[0].durationMs, 900_000);
  assert.equal(r.slots[0].ts, Date.parse('2026-10-31T23:00:00Z'));
});

test('Tibber: abgelehnter Schlüssel ist ein Zugangsfehler', async () => {
  for (const reply of [
    jsonResponse(401, { message: 'unauthorized' }),
    jsonResponse(200, { errors: [{ message: 'Context creation failed: invalid token', extensions: { code: 'UNAUTHENTICATED' } }] })
  ]) {
    await assert.rejects(fetchTibberPrices({ token: 'x', fetchImpl: async () => reply }), (e) => e.code === 'auth');
  }
  await assert.rejects(fetchTibberPrices({ token: '', fetchImpl: async () => { throw new Error('darf nicht abfragen'); } }), (e) => e.code === 'auth');
});

test('Tibber: Konto ohne Vertrag (Christins Fall) meldet no_contract statt Preise 0', async () => {
  const noSub = async () => jsonResponse(200, { data: { viewer: { homes: [{ id: 'h', appNickname: null, currentSubscription: null }] } } });
  await assert.rejects(fetchTibberPrices({ token: 't', fetchImpl: noSub }), (e) => e.code === 'no_contract');
  const noHome = async () => jsonResponse(200, { data: { viewer: { homes: [] } } });
  await assert.rejects(fetchTibberPrices({ token: 't', fetchImpl: noHome }), (e) => e.code === 'no_contract');
  // Beendeter Vertrag ohne Preise: kein Fehler, nur leer
  const ended = async () => jsonResponse(200, { data: { viewer: { homes: [{ id: 'h', currentSubscription: { status: 'ended', priceInfo: { today: [], tomorrow: [] } } }] } } });
  const r = await fetchTibberPrices({ token: 't', fetchImpl: ended });
  assert.equal(r.slots.length, 0);
  assert.equal(r.account.status, 'ended');
});

test('Tibber: Zuhause mit Preisen wird gewählt, Home-ID erzwingt ein bestimmtes', async () => {
  const homes = [
    { id: 'alt', currentSubscription: { status: 'ended', priceInfo: { today: [], tomorrow: [] } } },
    { id: 'neu', currentSubscription: { status: 'running', priceInfo: { today: quarterPrices('2026-11-01T00:00:00+01:00', 2, 0.25), tomorrow: [] } } }
  ];
  const fetchImpl = async () => jsonResponse(200, { data: { viewer: { homes } } });
  assert.equal((await fetchTibberPrices({ token: 't', fetchImpl })).account.homeId, 'neu');
  assert.equal((await fetchTibberPrices({ token: 't', homeId: 'alt', fetchImpl })).account.homeId, 'alt');
  await assert.rejects(fetchTibberPrices({ token: 't', homeId: 'gibts-nicht', fetchImpl }), (e) => e.code === 'no_contract');
});

test('Tibber: fremde Währung wird nicht als Euro verrechnet', async () => {
  const fetchImpl = async () => jsonResponse(200, { data: { viewer: { homes: [{ id: 'h', currentSubscription: { status: 'running', priceInfo: {
    today: [{ startsAt: '2026-11-01T00:00:00+01:00', total: 1.2, currency: 'SEK' }], tomorrow: [] } } }] } } });
  await assert.rejects(fetchTibberPrices({ token: 't', fetchImpl }), (e) => e.code === 'format');
});

// ── LichtBlick ────────────────────────────────────────────────────────────

function tmpCache() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-lb-'));
  return { dir, file: path.join(dir, 'sub', 'lichtblick-token.json') };
}

function lichtblickBackend({ points = { today: [], tomorrow: [] }, rejectPassword = false } = {}) {
  let n = 0;
  return recordingFetch((url, init) => {
    if (url === B2C_TOKEN_URL) {
      const form = new URLSearchParams(init.body);
      if (form.get('grant_type') === 'password' && rejectPassword) {
        return jsonResponse(400, { error: 'invalid_grant', error_description: 'AADB2C90225: The username or password provided in the request are invalid.' });
      }
      n += 1;
      return jsonResponse(200, { access_token: `at-${n}`, refresh_token: `rt-${n}`, expires_in: 3600 });
    }
    if (url === GRAPH_URL) {
      const body = JSON.parse(init.body);
      if (body.operationName === 'SelectableContracts') {
        return jsonResponse(200, { data: { b2cCustomer: { id: 1, appSelectableContracts: { contracts: [
          { b2cContractId: 11, productName: 'LichtBlick Gas', category: 'GAS' },
          { b2cContractId: 4711, productName: 'ÖkoStrom Dynamic', category: 'POWER' }
        ] } } } });
      }
      if (body.operationName === 'EnergyPriceCurves') {
        return jsonResponse(200, { data: {
          todayPriceCurves: { energyPriceCurvesResponse: { energyPricesInCents: points.today, averagePriceInCents: null } },
          tomorrowPriceCurves: { energyPriceCurvesResponse: { energyPricesInCents: points.tomorrow, averagePriceInCents: null } }
        } });
      }
    }
    throw new Error(`unerwartet: ${url}`);
  });
}

test('LichtBlick: Anmeldung wie die App, Strom-Vertrag, Preise heute und morgen', async () => {
  const { dir, file } = tmpCache();
  try {
    const now = () => Date.parse('2026-11-01T14:00:00Z');
    const fetchImpl = lichtblickBackend({ points: {
      today: [
        { time: '2026-11-01T00:00:00+01:00', valueInCents: 31.5 },
        { time: '2026-11-01T00:15:00+01:00', valueInCents: 30.25 },
        { time: '0001-01-01T00:00:00Z', valueInCents: 0 } // Platzhalter des Backends
      ],
      tomorrow: [{ time: '2026-11-02T00:00:00+01:00', valueInCents: 28 }]
    } });
    const r = await fetchLichtblickPrices({ email: 'Kunde@Example.de', password: 'geheim', cacheFile: file, fetchImpl, now });

    const login = fetchImpl.calls[0];
    assert.equal(login.url, B2C_TOKEN_URL);
    const form = new URLSearchParams(login.init.body);
    assert.equal(form.get('grant_type'), 'password');
    assert.equal(form.get('client_id'), B2C_CLIENT_ID);
    assert.equal(form.get('username'), 'Kunde@Example.de');
    assert.match(form.get('scope'), /offline_access/);

    const graph = fetchImpl.calls.filter((c) => c.url === GRAPH_URL);
    assert.equal(graph[0].init.headers['apollographql-client-name'], 'lichtblick-app-android');
    assert.equal(graph[0].init.headers.Authorization, 'Bearer at-1');
    const curves = JSON.parse(graph[1].init.body);
    assert.equal(curves.variables.contractId, 4711, 'Strom-Vertrag, nicht Gas');
    assert.equal(curves.variables.startToday, '2026-11-01T00:00:00+01:00');
    assert.equal(curves.variables.endTomorrow, '2026-11-03T00:00:00+01:00');

    assert.deepEqual(r.account, { contractId: 4711, label: 'ÖkoStrom Dynamic' });
    assert.deepEqual(r.slots.map((s) => [new Date(s.ts).toISOString(), s.ctKwh]), [
      ['2026-10-31T23:00:00.000Z', 31.5],
      ['2026-10-31T23:15:00.000Z', 30.25],
      ['2026-11-01T23:00:00.000Z', 28]
    ]);

    // Zwischenspeicher: nur für den Besitzer lesbar, ohne Passwort im Klartext
    const raw = fs.readFileSync(file, 'utf8');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(raw.includes('geheim'), false);
    assert.equal(raw.includes('Kunde@Example.de'), false);
    assert.equal(JSON.parse(raw).contractId, 4711);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('LichtBlick: zweiter Abruf ohne Anmeldung, nach Ablauf per Refresh-Token', async () => {
  const { dir, file } = tmpCache();
  try {
    let t = Date.parse('2026-11-01T14:00:00Z');
    const now = () => t;
    const fetchImpl = lichtblickBackend();
    await fetchLichtblickPrices({ email: 'a@b.de', password: 'pw', cacheFile: file, fetchImpl, now });
    const tokenCalls = () => fetchImpl.calls.filter((c) => c.url === B2C_TOKEN_URL).map((c) => new URLSearchParams(c.init.body).get('grant_type'));
    assert.deepEqual(tokenCalls(), ['password']);

    t += 10 * 60_000;
    await fetchLichtblickPrices({ email: 'a@b.de', password: 'pw', cacheFile: file, fetchImpl, now });
    assert.deepEqual(tokenCalls(), ['password'], 'gültiges Token wird wiederverwendet');
    assert.equal(fetchImpl.calls.filter((c) => c.url === GRAPH_URL && JSON.parse(c.init.body).operationName === 'SelectableContracts').length, 1,
      'Vertragsnummer kommt aus dem Zwischenspeicher');

    t += 2 * 60 * 60_000;
    await fetchLichtblickPrices({ email: 'a@b.de', password: 'pw', cacheFile: file, fetchImpl, now });
    assert.deepEqual(tokenCalls(), ['password', 'refresh_token']);
    const refreshCall = fetchImpl.calls.filter((c) => c.url === B2C_TOKEN_URL)[1];
    assert.equal(new URLSearchParams(refreshCall.init.body).get('refresh_token'), 'rt-1');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).refreshToken, 'rt-2', 'rotierter Refresh-Token gespeichert');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('LichtBlick: Zwischenspeicher gilt nur mit demselben Passwort', async () => {
  const { dir, file } = tmpCache();
  try {
    const now = () => Date.parse('2026-11-01T14:00:00Z');
    const ok = lichtblickBackend();
    await fetchLichtblickPrices({ email: 'a@b.de', password: 'richtig', cacheFile: file, fetchImpl: ok, now });
    const wrong = lichtblickBackend({ rejectPassword: true });
    await assert.rejects(
      fetchLichtblickPrices({ email: 'a@b.de', password: 'falsch', cacheFile: file, fetchImpl: wrong, now }),
      (e) => e.code === 'auth'
    );
    assert.equal(wrong.calls.filter((c) => c.url === GRAPH_URL).length, 0, 'mit falschem Passwort keine Daten aus dem gespeicherten Token');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('LichtBlick: Konto ohne Strom-Vertrag', async () => {
  const fetchImpl = recordingFetch((url) => (url === B2C_TOKEN_URL
    ? jsonResponse(200, { access_token: 'a', refresh_token: 'r', expires_in: 3600 })
    : jsonResponse(200, { data: { b2cCustomer: { appSelectableContracts: { contracts: [{ b2cContractId: 1, category: 'GAS' }] } } } })));
  await assert.rejects(fetchLichtblickPrices({ email: 'a@b.de', password: 'p', fetchImpl }), (e) => e.code === 'no_contract');
});

test('LichtBlick: abgelehntes Token wird einmal erneuert', async () => {
  let graphCalls = 0;
  const fetchImpl = recordingFetch((url, init) => {
    if (url === B2C_TOKEN_URL) return jsonResponse(200, { access_token: `a${fetchImpl.calls.length}`, refresh_token: 'r', expires_in: 3600 });
    graphCalls += 1;
    if (graphCalls === 1) return jsonResponse(401, { errors: [{ message: 'expired', extensions: { code: 'UNAUTHENTICATED' } }] });
    const body = JSON.parse(init.body);
    return jsonResponse(200, { data: body.operationName === 'EnergyPriceCurves' ? { todayPriceCurves: null, tomorrowPriceCurves: null } : {} });
  });
  const r = await fetchLichtblickPrices({ email: 'a@b.de', password: 'p', contractId: 5, fetchImpl });
  assert.equal(r.slots.length, 0);
  assert.equal(fetchImpl.calls.filter((c) => c.url === B2C_TOKEN_URL).length, 2);
});

// ── gemeinsame Helfer ─────────────────────────────────────────────────────

test('pointsToSlots: Dauer aus dem Abstand, Stundenwerte bleiben Stunden', () => {
  const h = pointsToSlots([
    { ts: '2026-11-01T01:00:00Z', ctKwh: 2 },
    { ts: '2026-11-01T00:00:00Z', ctKwh: 1 }
  ]);
  assert.deepEqual(h.map((s) => s.durationMs), [3_600_000, 3_600_000]);
  assert.equal(h[0].ctKwh, 1, 'sortiert');
  assert.deepEqual(pointsToSlots([{ ts: '2026-11-01T00:00:00Z', ctKwh: 5 }]).map((s) => s.durationMs), [900_000]);
});

test('localMidnight: Zeitumstellung (25-Stunden-Tag) mit richtigem Versatz', () => {
  assert.equal(localMidnight('2026-10-25').iso, '2026-10-25T00:00:00+02:00');
  assert.equal(localMidnight('2026-10-26').iso, '2026-10-26T00:00:00+01:00');
  assert.equal(localMidnight('2026-10-26').ms - localMidnight('2026-10-25').ms, 25 * 3_600_000);
});
