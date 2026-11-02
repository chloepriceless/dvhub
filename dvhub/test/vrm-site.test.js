// test/vrm-site.test.js — GH #32 (stefan-12): VRM-Backfill scheiterte mit
// „HTTP 404“, weil die Hex-Portal-ID (VRM-ID) direkt in
// /v2/installations/<idSite>/… landete. Die VRM-API erwartet dort die
// numerische Site-ID (idSite). Jetzt: Feld nimmt beides; eine Portal-ID wird
// über /v2/users/me → /v2/users/{id}/installations (identifier → idSite)
// aufgelöst und zwischengespeichert.
//
// Antwortformen laut offizieller Doku (vrm-api-docs.victronenergy.com,
// InfoMeCommand.yaml / InstallationsCommand.yaml) und am 02.11.2026 an einem
// echten Konto bestätigt: users/me → { success, user: { id, … } },
// installations → { success, records: [{ idSite (int), identifier (12 hex), … }] }.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyVrmInstallationRef, resolveVrmSiteId, VrmSiteResolveError,
} from '../vrm-site.js';

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

// fetch-Stub: Pfad → Antwort; zeichnet URL + Header auf.
function fakeVrm(routes) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, url, headers: opts.headers || {} });
    const r = routes[u.pathname];
    if (!r) return jsonResponse(404, { success: false, errors: 'not found' });
    if (r.throw) throw r.throw;
    return jsonResponse(r.status ?? 200, r.body);
  };
  return { fetchImpl, calls };
}

const ACCOUNT = {
  '/v2/users/me': { body: { success: true, user: { id: 4711, name: 'x', email: 'x@y', country: 'DE', accessLevel: 1 } } },
  '/v2/users/4711/installations': {
    body: {
      success: true,
      records: [
        { idSite: 111111, identifier: 'aaaaaaaaaaaa', name: 'Nachbar' },
        { idSite: 123456, identifier: 'a1b2c3d4e5f6', name: 'Zuhause' },
        { idSite: 222222, identifier: 'bbbbbbbbbbbb', name: 'Ferienhaus' },
      ],
    },
  },
};

test('classifyVrmInstallationRef: Zahl = Site-ID, Hex = Portal-ID', () => {
  assert.deepEqual(classifyVrmInstallationRef('123456'), { kind: 'site', value: '123456' });
  assert.deepEqual(classifyVrmInstallationRef(' 123456 '), { kind: 'site', value: '123456' });
  assert.deepEqual(classifyVrmInstallationRef(123456), { kind: 'site', value: '123456' });
  assert.deepEqual(classifyVrmInstallationRef('a1b2c3d4e5f6'), { kind: 'portal', value: 'a1b2c3d4e5f6' });
  assert.deepEqual(classifyVrmInstallationRef('A1B2C3D4E5F6'), { kind: 'portal', value: 'A1B2C3D4E5F6' });
  // 12 Ziffern sind eine MAC-artige Portal-ID, keine Site-ID.
  assert.equal(classifyVrmInstallationRef('123456789012').kind, 'portal');
  assert.equal(classifyVrmInstallationRef('').kind, 'empty');
  assert.equal(classifyVrmInstallationRef(null).kind, 'empty');
  assert.equal(classifyVrmInstallationRef('abc/../x').kind, 'invalid');
});

test('Site-ID (Zahl) wird unverändert genutzt — kein Netzaufruf (bestehende Konfigurationen)', async () => {
  const { fetchImpl, calls } = fakeVrm(ACCOUNT);
  const siteId = await resolveVrmSiteId({ ref: '123456', token: 'tok-a', fetchImpl, cache: new Map() });
  assert.equal(siteId, '123456');
  assert.equal(calls.length, 0);
});

test('Portal-ID wird über users/me → installations zur Site-ID aufgelöst (Groß/klein egal)', async () => {
  const { fetchImpl, calls } = fakeVrm(ACCOUNT);
  const cache = new Map();
  const siteId = await resolveVrmSiteId({ ref: 'A1B2C3D4E5F6', token: 'tok-b', fetchImpl, cache });
  assert.equal(siteId, '123456');
  assert.deepEqual(calls.map((c) => c.path), ['/v2/users/me', '/v2/users/4711/installations']);
  assert.equal(calls[0].url.startsWith('https://vrmapi.victronenergy.com/v2/users/me'), true);
  assert.equal(calls[0].headers['x-authorization'], 'Token tok-b');
  // Zwischengespeichert: zweiter Aufruf ohne Netz.
  assert.equal(await resolveVrmSiteId({ ref: 'a1b2c3d4e5f6', token: 'tok-b', fetchImpl, cache }), '123456');
  assert.equal(calls.length, 2);
  // Der Cache-Schlüssel enthält das Token nicht im Klartext.
  assert.equal([...cache.keys()].some((k) => k.includes('tok-b')), false);
});

test('Anderes Token → neu auflösen (Cache je Konto)', async () => {
  const { fetchImpl, calls } = fakeVrm(ACCOUNT);
  const cache = new Map();
  await resolveVrmSiteId({ ref: 'a1b2c3d4e5f6', token: 'tok-1', fetchImpl, cache });
  await resolveVrmSiteId({ ref: 'a1b2c3d4e5f6', token: 'tok-2', fetchImpl, cache });
  assert.equal(calls.length, 4);
});

test('Portal-ID nicht im Konto → klare Meldung mit Anzahl der Anlagen', async () => {
  const { fetchImpl } = fakeVrm(ACCOUNT);
  await assert.rejects(
    resolveVrmSiteId({ ref: 'deadbeef0000', token: 'tok-c', fetchImpl, cache: new Map() }),
    (e) => {
      assert.ok(e instanceof VrmSiteResolveError);
      assert.equal(e.code, 'not_in_account');
      assert.match(e.message, /deadbeef0000/);
      assert.match(e.message, /nicht/);
      assert.match(e.message, /3 Anlagen/);
      return true;
    }
  );
});

test('Fehlschlag wird nicht zwischengespeichert', async () => {
  const routes = { ...ACCOUNT, '/v2/users/me': { status: 503, body: { success: false } } };
  const { fetchImpl, calls } = fakeVrm(routes);
  const cache = new Map();
  await assert.rejects(resolveVrmSiteId({ ref: 'a1b2c3d4e5f6', token: 'tok-d', fetchImpl, cache }));
  routes['/v2/users/me'] = ACCOUNT['/v2/users/me'];
  assert.equal(await resolveVrmSiteId({ ref: 'a1b2c3d4e5f6', token: 'tok-d', fetchImpl, cache }), '123456');
  assert.equal(calls.length, 3);
});

test('Gleiche Portal-ID bei zwei verschiedenen Site-IDs → mehrdeutig, kein Raten', async () => {
  const routes = {
    ...ACCOUNT,
    '/v2/users/4711/installations': { body: { success: true, records: [
      { idSite: 1, identifier: 'a1b2c3d4e5f6' }, { idSite: 2, identifier: 'A1B2C3D4E5F6' },
    ] } },
  };
  const { fetchImpl } = fakeVrm(routes);
  await assert.rejects(resolveVrmSiteId({ ref: 'a1b2c3d4e5f6', token: 'tok-e', fetchImpl, cache: new Map() }),
    (e) => e.code === 'ambiguous' && /Site-ID/.test(e.message));
});

test('Token ungültig (401) → verständliche Meldung', async () => {
  const { fetchImpl } = fakeVrm({ '/v2/users/me': { status: 401, body: { success: false, errors: 'x', error_code: null } } });
  await assert.rejects(resolveVrmSiteId({ ref: 'a1b2c3d4e5f6', token: 'tok-f', fetchImpl, cache: new Map() }),
    (e) => e.code === 'auth' && /Token/.test(e.message) && /401/.test(e.message));
});

test('Netzfehler → Grund (z. B. ENOTFOUND) in der Meldung', async () => {
  const err = new TypeError('fetch failed');
  err.cause = { code: 'ENOTFOUND' };
  const { fetchImpl } = fakeVrm({ '/v2/users/me': { throw: err } });
  await assert.rejects(resolveVrmSiteId({ ref: 'a1b2c3d4e5f6', token: 'tok-g', fetchImpl, cache: new Map() }),
    (e) => e.code === 'network' && /ENOTFOUND/.test(e.message));
});

test('Leeres Feld / fehlendes Token → klare Meldung ohne Netzaufruf', async () => {
  const { fetchImpl, calls } = fakeVrm(ACCOUNT);
  await assert.rejects(resolveVrmSiteId({ ref: '', token: 'tok', fetchImpl, cache: new Map() }), (e) => e.code === 'missing');
  await assert.rejects(resolveVrmSiteId({ ref: 'a1b2c3d4e5f6', token: '', fetchImpl, cache: new Map() }), (e) => e.code === 'missing');
  assert.equal(calls.length, 0);
});
