// LUOX-Kundenportal (services/tariff-provider/luox-client.js) gegen ein
// nachgebautes Portal: Anmeldung mit CSRF, Token-Speicher 0600 gebunden an die
// Zugangsdaten, Refresh mit Rotation, Neu-Anmeldung als Rückfall, nur lesende
// Pfade. Es geht nie etwas ins Netz; alle Daten sind erfunden.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createLuoxPortalClient, extractCsrf, parseSetCookies, jwtExp, assertReadOnlyPath,
  PORTAL_BASE, LOGIN_PAGE_URL, LOGIN_URL, REFRESH_URL
} from '../services/tariff-provider/luox-client.js';

const EMAIL = 'kundin@example.invalid';
const PASSWORD = 'geheim-Passwort-123';

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}
function jwt(exp, extra = {}) {
  return `${b64url({ alg: 'none' })}.${b64url({ exp, iss: 'https://auth.example.invalid', ...extra })}.sig`;
}

function response(status, body, { headers = {}, setCookies = [] } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name) => lower[String(name).toLowerCase()] ?? null,
      getSetCookie: () => setCookies
    },
    text: async () => text,
    arrayBuffer: async () => {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(text);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    }
  };
}

const LOGIN_HTML = '<html><form method="post"><input type="hidden" value="CSRF-FORM-1" id="csrf" style="display:none;">'
  + '<input name="username"></form></html>';

/**
 * Nachgebautes Portal. `clock` liefert die Zeit in s (für exp der Tokens).
 * Merkt sich gültige Access-Tokens und das jeweils letzte Refresh-Token.
 */
function fakePortal({ clock, password = PASSWORD, tokenLifetimeS = 7 * 86400, refreshWorks = true } = {}) {
  const calls = [];
  let n = 0;
  const valid = new Set();
  let currentRefresh = null;
  const issue = () => {
    n += 1;
    const token = jwt(clock() + tokenLifetimeS, { n });
    valid.add(token);
    currentRefresh = `rt-${n}`;
    return { user_id: 4242, token, refresh_token: currentRefresh };
  };
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const method = init.method || 'GET';
    if (url === LOGIN_PAGE_URL && method === 'GET') {
      return response(200, LOGIN_HTML, { setCookies: ['csrftoken=COOKIE-CSRF; Path=/; SameSite=Lax', 'sessionid=sess-1; HttpOnly; Path=/'] });
    }
    if (url === LOGIN_URL && method === 'POST') {
      const body = JSON.parse(init.body);
      const h = init.headers || {};
      if (h['X-CSRFToken'] !== 'CSRF-FORM-1' || !String(h.Cookie || '').includes('csrftoken=COOKIE-CSRF')) {
        return response(403, '<html>CSRF verification failed</html>');
      }
      if (body.username !== EMAIL || body.password !== password) return response(400, { non_field_errors: [`Benutzer ${body.username} unbekannt`] });
      return response(200, issue());
    }
    if (url === REFRESH_URL && method === 'POST') {
      const body = JSON.parse(init.body);
      if (!refreshWorks || body.refresh_token !== currentRefresh) return response(401, { detail: 'invalid refresh token' });
      return response(200, issue());
    }
    if (String(url).startsWith(`${PORTAL_BASE}/api/`) && method === 'GET') {
      const auth = String(init.headers?.Authorization || '');
      const token = auth.replace(/^Bearer /, '');
      const exp = jwtExp(token);
      if (!valid.has(token) || !(exp > clock())) return response(302, '', { headers: { Location: '/login' } });
      const p = String(url).slice(`${PORTAL_BASE}/api/`.length);
      if (p === 'contracts') return response(200, { saas_customer_id: '90000001', consumer_delivering_points: [], producer_delivering_points: [] });
      if (p.startsWith('epex_price/')) return response(200, Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), { headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } });
      return response(500, '<html>Server Error</html>');
    }
    throw new Error(`unerwartet: ${method} ${url}`);
  };
  fn.calls = calls;
  fn.revoke = () => valid.clear();
  return fn;
}

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-luox-'));
  return { dir, file: path.join(dir, 'tariff-provider', 'luox-token.json') };
}

const callsTo = (fetchImpl, url) => fetchImpl.calls.filter((c) => c.url === url);

test('CSRF aus dem Anmeldeformular: beide Attribut-Reihenfolgen, Django-Feld, fehlend = null', () => {
  assert.equal(extractCsrf('<input value="T1" id="csrf" style="display:none;">'), 'T1');
  assert.equal(extractCsrf('<input id="csrf" type="hidden" value="T2">'), 'T2');
  assert.equal(extractCsrf("<input type='hidden' name='csrfmiddlewaretoken' value='T3'>"), 'T3');
  assert.equal(extractCsrf('<html>login</html>'), null);
  assert.equal(extractCsrf(''), null);
});

test('Set-Cookie: Name=Wert ohne Attribute', () => {
  const r = response(200, '', { setCookies: ['csrftoken=abc; Path=/; SameSite=Lax', 'sessionid=xyz; HttpOnly'] });
  assert.deepEqual([...parseSetCookies(r.headers)], [['csrftoken', 'abc'], ['sessionid', 'xyz']]);
  // Ohne getSetCookie (ältere fetch-Nachbauten): eine zusammengefügte Kopfzeile
  const legacy = { get: (n) => (n === 'set-cookie' ? 'csrftoken=a1; Path=/, sessionid=s1; HttpOnly' : null) };
  assert.deepEqual([...parseSetCookies(legacy)], [['csrftoken', 'a1'], ['sessionid', 's1']]);
});

test('JWT-Ablauf: exp aus dem Token, Müll = null', () => {
  assert.equal(jwtExp(jwt(1234567890)), 1234567890);
  assert.equal(jwtExp('abc'), null);
  assert.equal(jwtExp(''), null);
  assert.equal(jwtExp('a.b.c'), null);
  assert.equal(jwtExp(`${b64url({})}.${b64url({ sub: 'x' })}.s`), null);
});

test('Nur lesende Portal-Pfade: Schreib-, Konto- und Kündigungs-Endpunkte sind gesperrt', () => {
  for (const ok of [
    'contracts', 'config', 'epex_price_today/',
    'products/C90000001-1/2026-11-11/2026-11-11',
    'energy_data/P90000001-1/prod/other_then_LGS/day/2026-11-10/2026-11-10/',
    'energy_data/C90000001-1/slp/LGS/month/2026-10-01/2026-10-31/',
    'epex_price/P90000001-1/2026-11-01/2026-11-10/producer/',
    'get_plant_details/P90000001-1'
  ]) assert.doesNotThrow(() => assertReadOnlyPath(ok), ok);
  for (const bad of [
    'edit_contract_data/', 'edit_bill_data/', 'edit_bank_data/', 'new_password/', 'new_username/',
    'terminate_contract/', 'create_control_resource/', 'update_control_resource/', 'logout/', 'login/',
    'refresh_token/', 'contracts/../logout/', 'products/C1/2026-11-11/2026-11-11/../../edit_bank_data/',
    'energy_data/P1/prod/other_then_LGS/day/2026-11-10/2026-11-10/?x=1', '/contracts', 'https://evil.invalid/contracts'
  ]) assert.throws(() => assertReadOnlyPath(bad), /nicht freigegeben/, bad);
});

test('Anmeldung wie das Portal: CSRF aus /login, Cookie + X-CSRFToken + Referer, Token-Speicher 0600 ohne Klartext', async () => {
  const { dir, file } = tmpDir();
  try {
    const t = Date.parse('2026-11-11T12:00:00Z');
    const fetchImpl = fakePortal({ clock: () => Math.floor(t / 1000) });
    const client = createLuoxPortalClient({ email: EMAIL, password: PASSWORD, cacheFile: file, fetchImpl, now: () => t });
    const contracts = await client.getJson('contracts');
    assert.equal(contracts.saas_customer_id, '90000001');

    const login = callsTo(fetchImpl, LOGIN_URL)[0];
    assert.equal(login.init.method, 'POST');
    assert.equal(login.init.headers['X-CSRFToken'], 'CSRF-FORM-1');
    assert.equal(login.init.headers.Referer, LOGIN_PAGE_URL);
    assert.match(login.init.headers.Cookie, /csrftoken=COOKIE-CSRF/);
    assert.match(login.init.headers.Cookie, /sessionid=sess-1/);
    assert.ok(login.init.signal, 'Zeitgrenze am Anmelde-Aufruf');

    const get = fetchImpl.calls.find((c) => c.url === `${PORTAL_BASE}/api/contracts`);
    assert.match(get.init.headers.Authorization, /^Bearer /);
    assert.equal(get.init.redirect, 'manual', 'Umleitung auf /login wird als Ablehnung erkannt, nicht verfolgt');
    assert.ok(get.init.signal, 'Zeitgrenze am Abruf');

    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode, 0o600);
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(!raw.includes(PASSWORD), 'Passwort steht nicht im Speicher');
    assert.ok(!raw.includes(EMAIL), 'E-Mail steht nicht im Klartext im Speicher');
    const stored = JSON.parse(raw);
    assert.equal(stored.refreshToken, 'rt-1');
    assert.equal(stored.userId, 4242);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['luox-token.json'], 'keine Temp-Datei übrig');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Zweiter Abruf ohne Anmeldung; kurz vor Ablauf Refresh mit Rotation (altes Paar ersetzt)', async () => {
  const { dir, file } = tmpDir();
  try {
    let t = Date.parse('2026-11-11T12:00:00Z');
    const clock = () => Math.floor(t / 1000);
    const fetchImpl = fakePortal({ clock, tokenLifetimeS: 3600 });
    const make = () => createLuoxPortalClient({ email: EMAIL, password: PASSWORD, cacheFile: file, fetchImpl, now: () => t });
    await make().getJson('contracts');
    t += 10 * 60_000;
    await make().getJson('contracts');
    assert.equal(callsTo(fetchImpl, LOGIN_URL).length, 1, 'gültiges Token aus dem Speicher');
    assert.equal(callsTo(fetchImpl, REFRESH_URL).length, 0);

    t += 50 * 60_000; // weniger als 10 min Restlaufzeit
    await make().getJson('contracts');
    const refresh = callsTo(fetchImpl, REFRESH_URL);
    assert.equal(refresh.length, 1);
    const body = JSON.parse(refresh[0].init.body);
    assert.equal(body.refresh_token, 'rt-1');
    assert.ok(body.token, 'altes Access-Token geht mit (wie das Portal)');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(stored.refreshToken, 'rt-2', 'rotiertes Paar gespeichert');
    assert.equal(callsTo(fetchImpl, LOGIN_URL).length, 1, 'kein Passwort-Login für den Refresh');

    // Nächster Refresh benutzt das neue Paar, nicht das alte
    t += 60 * 60_000;
    await make().getJson('contracts');
    assert.equal(JSON.parse(callsTo(fetchImpl, REFRESH_URL)[1].init.body).refresh_token, 'rt-2');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Refresh abgelehnt: einmal mit Passwort neu anmelden', async () => {
  const { dir, file } = tmpDir();
  try {
    let t = Date.parse('2026-11-11T12:00:00Z');
    const fetchImpl = fakePortal({ clock: () => Math.floor(t / 1000), tokenLifetimeS: 3600, refreshWorks: false });
    const make = () => createLuoxPortalClient({ email: EMAIL, password: PASSWORD, cacheFile: file, fetchImpl, now: () => t });
    await make().getJson('contracts');
    t += 2 * 3600_000;
    await make().getJson('contracts');
    assert.equal(callsTo(fetchImpl, REFRESH_URL).length, 1);
    assert.equal(callsTo(fetchImpl, LOGIN_URL).length, 2, 'Rückfall: Neu-Anmeldung');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).refreshToken, 'rt-2');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Vom Portal abgelehntes Token (Umleitung auf /login): einmal erneuern und wiederholen', async () => {
  const { dir, file } = tmpDir();
  try {
    const t = Date.parse('2026-11-11T12:00:00Z');
    const fetchImpl = fakePortal({ clock: () => Math.floor(t / 1000) });
    const client = createLuoxPortalClient({ email: EMAIL, password: PASSWORD, cacheFile: file, fetchImpl, now: () => t });
    await client.getJson('contracts');
    fetchImpl.revoke();
    const again = await client.getJson('contracts');
    assert.equal(again.saas_customer_id, '90000001');
    assert.equal(callsTo(fetchImpl, REFRESH_URL).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Speicher gilt nur mit demselben Passwort; falsches Passwort = auth, ohne Daten', async () => {
  const { dir, file } = tmpDir();
  try {
    const t = Date.parse('2026-11-11T12:00:00Z');
    const fetchImpl = fakePortal({ clock: () => Math.floor(t / 1000) });
    await createLuoxPortalClient({ email: EMAIL, password: PASSWORD, cacheFile: file, fetchImpl, now: () => t }).getJson('contracts');
    const before = fetchImpl.calls.length;
    await assert.rejects(
      createLuoxPortalClient({ email: EMAIL, password: 'falsch', cacheFile: file, fetchImpl, now: () => t }).getJson('contracts'),
      (e) => e.code === 'auth' && !e.message.includes('falsch') && !e.message.includes(EMAIL)
    );
    const after = fetchImpl.calls.slice(before);
    assert.ok(!after.some((c) => c.url === `${PORTAL_BASE}/api/contracts`), 'kein Datenabruf mit dem gespeicherten Token');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Gesperrter Pfad geht nicht ins Netz', async () => {
  const fetchImpl = async () => { throw new Error('darf nicht abfragen'); };
  const client = createLuoxPortalClient({ email: EMAIL, password: PASSWORD, fetchImpl });
  await assert.rejects(client.getJson('edit_bank_data/'), /nicht freigegeben/);
  await assert.rejects(client.getBinary('terminate_contract/'), /nicht freigegeben/);
});

test('Zeitüberschreitung und Netzfehler = network, ohne Zugangsdaten in der Meldung', async () => {
  const err = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const fetchImpl = async () => { throw err; };
  await assert.rejects(
    createLuoxPortalClient({ email: EMAIL, password: PASSWORD, fetchImpl }).getJson('contracts'),
    (e) => e.code === 'network' && !e.message.includes(PASSWORD)
  );
});

test('Fehlendes CSRF-Feld = format; Portal-Fehler 500 = api', async () => {
  const noCsrf = async (url) => (url === LOGIN_PAGE_URL ? response(200, '<html>neu gestaltet</html>') : response(500, ''));
  await assert.rejects(createLuoxPortalClient({ email: EMAIL, password: PASSWORD, fetchImpl: noCsrf }).getJson('contracts'), (e) => e.code === 'format');
  const t = Date.parse('2026-11-11T12:00:00Z');
  const fetchImpl = fakePortal({ clock: () => Math.floor(t / 1000) });
  await assert.rejects(
    createLuoxPortalClient({ email: EMAIL, password: PASSWORD, fetchImpl, now: () => t }).getJson('get_plant_details/P90000001-1'),
    (e) => e.code === 'api' && /500/.test(e.message)
  );
});

test('Fehlermeldungen enthalten weder Token noch Antwort-Text mit Kundendaten', async () => {
  const t = Date.parse('2026-11-11T12:00:00Z');
  const fetchImpl = fakePortal({ clock: () => Math.floor(t / 1000), password: 'anders' });
  await assert.rejects(
    createLuoxPortalClient({ email: EMAIL, password: PASSWORD, fetchImpl, now: () => t }).getJson('contracts'),
    (e) => e.code === 'auth' && !e.message.includes(EMAIL) && !e.message.includes('unbekannt')
  );
});

test('Binärabruf (Abrechnungs-XLSX) liefert einen Buffer', async () => {
  const t = Date.parse('2026-11-11T12:00:00Z');
  const fetchImpl = fakePortal({ clock: () => Math.floor(t / 1000) });
  const buf = await createLuoxPortalClient({ email: EMAIL, password: PASSWORD, fetchImpl, now: () => t })
    .getBinary('epex_price/P90000001-1/2026-11-01/2026-11-10/producer/');
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.readUInt32LE(0), 0x04034b50);
});

test('Gleichzeitige Abrufe mit abgelaufenem Token: nur ein Refresh (Rotation verträgt keinen zweiten)', async () => {
  const { dir, file } = tmpDir();
  try {
    let t = Date.parse('2026-11-11T12:00:00Z');
    const fetchImpl = fakePortal({ clock: () => Math.floor(t / 1000), tokenLifetimeS: 3600 });
    const make = () => createLuoxPortalClient({ email: EMAIL, password: PASSWORD, cacheFile: file, fetchImpl, now: () => t });
    await make().getJson('contracts');
    t += 2 * 3600_000;
    await Promise.all([make().getJson('contracts'), make().getJson('contracts'), make().getJson('contracts')]);
    assert.equal(callsTo(fetchImpl, REFRESH_URL).length, 1);
    assert.equal(callsTo(fetchImpl, LOGIN_URL).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Ohne Zugangsdaten kein Abruf', async () => {
  const fetchImpl = async () => { throw new Error('darf nicht abfragen'); };
  await assert.rejects(createLuoxPortalClient({ email: '', password: 'x', fetchImpl }).getJson('contracts'), (e) => e.code === 'auth');
  await assert.rejects(createLuoxPortalClient({ email: EMAIL, password: '', fetchImpl }).getJson('contracts'), (e) => e.code === 'auth');
});
