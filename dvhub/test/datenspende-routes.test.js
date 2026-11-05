// test/datenspende-routes.test.js — /api/datenspende/*: Nonce (CSRF), Einwilligung,
// Schalter, Validierung. Der Dienst ist gestubbt; geprüft wird die Routen-Schicht.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createApiRoutes } from '../routes-api.js';

const LAN_IP = '192.168.4.71';
const API_TOKEN = 'B'.repeat(32);

function mockRes() {
  const c = { status: 0, headers: {}, body: '' };
  return { writeHead(s, h) { c.status = s; Object.assign(c.headers, h); }, end(p) { c.body = p == null ? '' : String(p); }, setHeader() {}, _c: c };
}
function makeReq(p, { method = 'GET', body = null, ip = LAN_IP, token = null } = {}) {
  const buf = body != null ? Buffer.from(JSON.stringify(body)) : null;
  const s = Readable.from(buf ? [buf] : []);
  Object.assign(s, { method, url: p, headers: { host: 'dvhub.test' }, socket: { remoteAddress: ip } });
  if (buf) s.headers['content-type'] = 'application/json';
  if (token) s.headers.authorization = `Bearer ${token}`;
  return s;
}
function setup({ linked = false } = {}) {
  let raw = { apiToken: API_TOKEN, datenspende: { enabled: false } };
  const calls = [];
  const logs = [];
  const ds = {
    linked,
    status() { return { linked: this.linked, enabled: raw.datenspende?.enabled === true, donated: 0 }; },
    async link(args) { calls.push(['link', args]); this.linked = true; return this.status(); },
    unlink() { calls.push(['unlink']); this.linked = false; return this.status(); },
  };
  const ctx = {
    state: {}, pushLog: (event, details) => logs.push({ event, details }), telemetrySafeWrite: () => {}, licenseService: null,
    getCfg: () => ({ ...raw, epex: { enabled: false }, telemetry: { enabled: false }, security: { lanTrust: 'open' }, allowedHosts: [] }),
    getRawCfg: () => raw,
    saveAndApplyConfig: (n) => { raw = n; },
    getAppVersion: () => ({}),
    datenspende: ds,
  };
  const routes = createApiRoutes(ctx);
  const call = async (req) => {
    const res = mockRes();
    await routes.handleRequest(req, res, new URL(req.url, 'http://dvhub.test'));
    let j = null; try { j = JSON.parse(res._c.body); } catch { /* */ }
    return { status: res._c.status, j };
  };
  return { call, calls, ds, logs, raw: () => raw };
}

test('status liefert Nonce; link ohne Nonce (fremde Webseite) → 403', async () => {
  const s = setup();
  const st = await s.call(makeReq('/api/datenspende/status'));
  assert.equal(st.status, 200);
  assert.match(st.j.uiToken, /^[a-f0-9]{32}$/);
  const bad = await s.call(makeReq('/api/datenspende/link', { method: 'POST', body: { username: 'u', password: 'p', consent: true } }));
  assert.equal(bad.status, 403);
  assert.equal(bad.j.error, 'ui_token_required');
  assert.equal(s.calls.length, 0);
});

test('link mit Nonce: Einwilligung wird durchgereicht, Spende eingeschaltet', async () => {
  const s = setup();
  const { j } = await s.call(makeReq('/api/datenspende/status'));
  const r = await s.call(makeReq('/api/datenspende/link', { method: 'POST', body: {
    mode: 'signup', username: 'u', password: 'p', consent: true, household: { zip: '52062' }, uiToken: j.uiToken,
  } }));
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(s.calls[0][1].consent, true);
  assert.equal(s.calls[0][1].household.zip, '52062');
  assert.equal(s.raw().datenspende.enabled, true);
});

test('link: consent muss wörtlich true sein', async () => {
  const s = setup();
  const { j } = await s.call(makeReq('/api/datenspende/status'));
  await s.call(makeReq('/api/datenspende/link', { method: 'POST', body: { username: 'u', password: 'p', consent: 'ja', uiToken: j.uiToken } }));
  assert.equal(s.calls[0][1].consent, false);
});

test('settings: Einschalten braucht Nonce + Verknüpfung; Ausschalten geht immer', async () => {
  const s = setup();
  const noNonce = await s.call(makeReq('/api/datenspende/settings', { method: 'POST', body: { enabled: true } }));
  assert.equal(noNonce.status, 403);
  const { j } = await s.call(makeReq('/api/datenspende/status'));
  const notLinked = await s.call(makeReq('/api/datenspende/settings', { method: 'POST', body: { enabled: true, uiToken: j.uiToken } }));
  assert.equal(notLinked.status, 409);
  s.ds.linked = true;
  const on = await s.call(makeReq('/api/datenspende/settings', { method: 'POST', body: { enabled: true, uiToken: j.uiToken } }));
  assert.equal(on.status, 200);
  assert.equal(s.raw().datenspende.enabled, true);
  const off = await s.call(makeReq('/api/datenspende/settings', { method: 'POST', body: { enabled: false } }));
  assert.equal(off.status, 200, 'Ausschalten ohne Nonce (Not-Aus)');
  assert.equal(s.raw().datenspende.enabled, false);
});

test('settings: Quellen/Intervall validiert und zusammengeführt', async () => {
  const s = setup({ linked: true });
  const { j } = await s.call(makeReq('/api/datenspende/status'));
  const r = await s.call(makeReq('/api/datenspende/settings', { method: 'POST', body: { sources: { pv: false }, intervalSec: 30, uiToken: j.uiToken } }));
  assert.equal(r.status, 200);
  const r2 = await s.call(makeReq('/api/datenspende/settings', { method: 'POST', body: { sources: { devices: false }, uiToken: j.uiToken } }));
  assert.equal(r2.status, 200);
  assert.deepEqual(s.raw().datenspende.sources, { pv: false, devices: false });
  assert.equal(s.raw().datenspende.intervalSec, 30);
  assert.equal((await s.call(makeReq('/api/datenspende/settings', { method: 'POST', body: { intervalSec: 1, uiToken: j.uiToken } }))).status, 400);
  assert.equal((await s.call(makeReq('/api/datenspende/settings', { method: 'POST', body: { sources: { hack: true }, uiToken: j.uiToken } }))).status, 400);
});

test('unlink braucht Nonce und schaltet aus', async () => {
  const s = setup({ linked: true });
  assert.equal((await s.call(makeReq('/api/datenspende/unlink', { method: 'POST', body: {} }))).status, 403);
  const { j } = await s.call(makeReq('/api/datenspende/status'));
  const r = await s.call(makeReq('/api/datenspende/unlink', { method: 'POST', body: { uiToken: j.uiToken } }));
  assert.equal(r.status, 200);
  assert.deepEqual(s.calls.at(-1), ['unlink']);
  assert.equal(s.raw().datenspende.enabled, false);
});

test('Bearer-Token ersetzt den Nonce (Skripte/API)', async () => {
  const s = setup({ linked: true });
  const r = await s.call(makeReq('/api/datenspende/settings', { method: 'POST', token: API_TOKEN, body: { enabled: true } }));
  assert.equal(r.status, 200);
});

test('settings: Ausschalten verwirft eine laufende Einrichtung (cancelPendingLink)', async () => {
  const s = setup({ linked: true });
  let cancelled = 0;
  s.ds.cancelPendingLink = () => { cancelled++; };
  await s.call(makeReq('/api/datenspende/settings', { method: 'POST', body: { enabled: false } }));
  assert.equal(cancelled, 1);
});

test('link mode=apikey ruft linkApiKey (mit Nonce), Einwilligung wörtlich', async () => {
  const s = setup();
  s.ds.linkApiKey = async (a) => { s.calls.push(['linkApiKey', a]); s.ds.linked = true; return s.ds.status(); };
  const { j } = await s.call(makeReq('/api/datenspende/status'));
  const r = await s.call(makeReq('/api/datenspende/link', { method: 'POST', body: { mode: 'apikey', apiKey: 'K'.repeat(40), consent: true, uiToken: j.uiToken } }));
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.deepEqual(s.calls.at(-1), ['linkApiKey', { apiKey: 'K'.repeat(40), consent: true }]);
  assert.equal(s.raw().datenspende.enabled, true);
});

test('backfill: Start braucht Nonce, Stopp nicht; ungültige Aktion 400', async () => {
  const s = setup({ linked: true });
  s.ds.startBackfill = () => { s.calls.push(['start']); return s.ds.status(); };
  s.ds.stopBackfill = () => { s.calls.push(['stop']); return s.ds.status(); };
  assert.equal((await s.call(makeReq('/api/datenspende/backfill', { method: 'POST', body: { action: 'start' } }))).status, 403);
  const { j } = await s.call(makeReq('/api/datenspende/status'));
  assert.equal((await s.call(makeReq('/api/datenspende/backfill', { method: 'POST', body: { action: 'start', uiToken: j.uiToken } }))).status, 200);
  assert.equal((await s.call(makeReq('/api/datenspende/backfill', { method: 'POST', body: { action: 'stop' } }))).status, 200);
  assert.equal((await s.call(makeReq('/api/datenspende/backfill', { method: 'POST', body: { action: 'x' } }))).status, 400);
  assert.deepEqual(s.calls.map((c) => c[0]), ['start', 'stop']);
});

// GH #31: Der gescheiterte Schritt und die Server-Meldung gehen in Log und
// Antwort — Passwort, Anmelde-Schlüssel und API-Key nie.
test('#31 link scheitert → Log + Antwort mit Schritt, Status, Server-Meldung, ohne Geheimnisse', async () => {
  const s = setup();
  const err = Object.assign(new Error('400 bad_request: Invalid input format: null (pw hunter22, key S3CR3T-XYZ)'), {
    name: 'DatenspendeRequestError', code: 'bad_request', status: 400, step: 'households',
    serverMessage: 'Invalid input format: null (pw hunter22, key S3CR3T-XYZ)',
  });
  s.ds.link = async () => { throw err; };
  const { j } = await s.call(makeReq('/api/datenspende/status'));
  const r = await s.call(makeReq('/api/datenspende/link', { method: 'POST', body: {
    mode: 'signup', username: 'u', password: 'hunter22', secret: 'S3CR3T-XYZ', consent: true, uiToken: j.uiToken,
  } }));
  assert.equal(r.status, 400);
  assert.equal(r.j.error, 'bad_request');
  assert.equal(r.j.step, 'households');
  assert.equal(r.j.stepLabel, 'Haushalt anlegen');
  assert.match(r.j.detail, /Invalid input format: null/);
  const fail = s.logs.find((l) => l.event === 'datenspende_link_failed');
  assert.ok(fail, 'datenspende_link_failed geloggt');
  assert.equal(fail.details.error, 'bad_request');
  assert.equal(fail.details.step, 'households');
  assert.equal(fail.details.status, 400);
  assert.match(fail.details.detail, /Invalid input format: null/);
  const all = JSON.stringify([r.j, fail]);
  assert.equal(all.includes('hunter22'), false, 'Passwort nie in Log/Antwort');
  assert.equal(all.includes('S3CR3T-XYZ'), false, 'Anmelde-Schlüssel nie in Log/Antwort');
});

test('#31 Verbindungsfehler → Grund (reason) im Log', async () => {
  const s = setup();
  s.ds.link = async () => { throw Object.assign(new Error('Verbindungsfehler: ENOTFOUND'), { name: 'DatenspendeConnError', code: 'connection_error', reason: 'ENOTFOUND', step: 'sign-up' }); };
  const { j } = await s.call(makeReq('/api/datenspende/status'));
  const r = await s.call(makeReq('/api/datenspende/link', { method: 'POST', body: { username: 'u', password: 'p', consent: true, uiToken: j.uiToken } }));
  assert.equal(r.status, 502);
  const fail = s.logs.find((l) => l.event === 'datenspende_link_failed');
  assert.equal(fail.details.reason, 'ENOTFOUND');
  assert.equal(fail.details.step, 'sign-up');
});

// GH #31: Kontext-Hilfe zum „Anmelde-Schlüssel“ und Schritt in der Fehlermeldung.
test('#31 Oberfläche: Hilfe zum Anmelde-Schlüssel, Schritt in der Fehlermeldung', async () => {
  const fs = await import('node:fs');
  const html = fs.readFileSync(new URL('../public/settings.html', import.meta.url), 'utf8');
  const m = html.match(/<input id="dsSecret"[^>]*>\s*<small id="dsSecretHelp"[^>]*>([\s\S]*?)<\/small>/);
  assert.ok(m, 'Hilfe-Text direkt unter dem Feld dsSecret');
  assert.match(m[1], /neue[sn]? Konto/);
  assert.match(m[1], /leer lassen/);
  // Gegenprüfung 9190f2f8 (P2): Text war durch ein sed-„&“ verdoppelt/zerrissen.
  assert.equal((m[1].match(/leer lassen/g) || []).length, 1, 'Wendung nur einmal');
  assert.equal((m[1].match(/API-Key/g) || []).length, 1, 'Satz nur einmal');
  assert.doesNotMatch(m[1], /(^|[^&])(mdash|bdquo|ldquo);/, 'jede Entität mit &');
  const js = fs.readFileSync(new URL('../public/tools.js', import.meta.url), 'utf8');
  // Am Aufrufort verankert (Gegenprüfung b2c42fbd): die Definition allein zählt nicht.
  assert.match(js, /setText\('dsResult',[^\n]*datenspendeFailureText\(r, hints\)/);
  // Der Schlüssel zählt nur beim Anlegen (api.py sendet secret nur bei sign-up).
  assert.match(js, /for \(const id of \['dsSecret', 'dsSecretHelp'\]\)[^\n]*hidden = mode !== 'signup'/);
});

// Gegenprüfung 9190f2f8 (P3): fester Hinweis verdeckte Grund/Server-Meldung.
test('#31 Oberfläche: fester Hinweis + Details (Grund, Server-Meldung) zusammen', async () => {
  const fs = await import('node:fs');
  const js = fs.readFileSync(new URL('../public/tools.js', import.meta.url), 'utf8');
  const m = js.match(/function datenspendeFailureText\(r, hints\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'tools.js definiert datenspendeFailureText(r, hints)');
  const fn = new Function(`${m[0]}; return datenspendeFailureText;`)();
  const hints = { connection_error: 'Projekt-Server nicht erreichbar — Internetverbindung prüfen.' };
  const t = fn({ status: 502, j: { error: 'connection_error', step: 'sign-in', stepLabel: 'Anmelden', detail: 'Verbindungsfehler: ENOTFOUND' } }, hints);
  assert.match(t, /Schritt „Anmelden“/);
  assert.match(t, /nicht erreichbar/);
  assert.match(t, /ENOTFOUND/);
  const u = fn({ status: 400, j: { error: 'bad_request', stepLabel: 'Haushalt anlegen', detail: '400 bad_request: Invalid input format: null' } }, hints);
  assert.match(u, /Haushalt anlegen/);
  assert.match(u, /Invalid input format: null/);
  assert.equal((u.match(/Invalid input format/g) || []).length, 1, 'Detail nicht doppelt');
  assert.match(fn({ status: 500, j: {} }, hints), /500/);
});

// 05.11.2026: Netzspannung je Phase als eigene, abwählbare Quelle.
test('settings: Quelle gridVoltage (Netzspannung) abwählbar; Oberfläche nennt Spannung', async () => {
  const s = setup({ linked: true });
  const { j } = await s.call(makeReq('/api/datenspende/status'));
  const r = await s.call(makeReq('/api/datenspende/settings', { method: 'POST', body: { sources: { gridVoltage: false }, uiToken: j.uiToken } }));
  assert.equal(r.status, 200);
  assert.deepEqual(s.raw().datenspende.sources, { gridVoltage: false });
  const fs = await import('node:fs');
  const js = fs.readFileSync(new URL('../public/tools.js', import.meta.url), 'utf8');
  assert.match(js, /gridVoltage: 'Netzspannung \(L1–L3\)'/);
  assert.match(js, /p\.voltage != null/, 'Vorschau zeigt Spannungen in V');
  const html = fs.readFileSync(new URL('../public/settings.html', import.meta.url), 'utf8');
  assert.match(html, /Leistungswerte \(W\) und die Netzspannung je Phase \(V\)/);
  const { createDefaultConfig } = await import('../config-model.js');
  assert.equal(createDefaultConfig().datenspende.sources.gridVoltage, true);
});

test('#31 settings: clientType nur bekannte Portal-Typen (dvhub kennt der Server nicht)', async () => {
  const s = setup({ linked: true });
  const { j } = await s.call(makeReq('/api/datenspende/status'));
  const bad = await s.call(makeReq('/api/datenspende/settings', { method: 'POST', body: { clientType: 'dvhub', uiToken: j.uiToken } }));
  assert.equal(bad.status, 400);
  const ok = await s.call(makeReq('/api/datenspende/settings', { method: 'POST', body: { clientType: 'victron', uiToken: j.uiToken } }));
  assert.equal(ok.status, 200);
  assert.equal(s.raw().datenspende.clientType, 'victron');
});

test('#31 Config: Standard-Client-Typ victron, gespeichertes dvhub wird beim Laden gehoben', async () => {
  const { createDefaultConfig, normalizeConfigInput } = await import('../config-model.js');
  assert.equal(createDefaultConfig().datenspende.clientType, 'victron');
  const n = normalizeConfigInput({ datenspende: { enabled: true, clientType: 'dvhub' } });
  assert.equal(n.rawConfig.datenspende.clientType, 'victron', 'Rohwert gehoben → wird so gespeichert');
  assert.equal(n.effectiveConfig.datenspende.clientType, 'victron');
  assert.equal(n.rawConfig.datenspende.enabled, true, 'Rest unverändert');
  assert.equal(normalizeConfigInput({ datenspende: { clientType: 'home_assistant' } }).rawConfig.datenspende.clientType, 'home_assistant');
});

// GH #31: Portal-Schlüssel als erster, empfohlener Weg; Hilfetexte.
// Die Seite schreibt Umlaute als HTML-Entitäten — für die Prüfung auflösen.
const ENT = { auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', bdquo: '„', ldquo: '“', rsquo: '’', rarr: '→', mdash: '—', nbsp: ' ', amp: '&' };
const decodeHtml = (t) => t.replace(/&([a-zA-Z]+);/g, (m, n) => ENT[n] ?? m);
test('#31 Oberfläche: „Schlüssel aus dem Datenportal“ zuerst und empfohlen, mit Link und Schritten', async () => {
  const fs = await import('node:fs');
  const html = decodeHtml(fs.readFileSync(new URL('../public/settings.html', import.meta.url), 'utf8'));
  const sel = html.match(/<select id="dsMode"[^>]*>([\s\S]*?)<\/select>/);
  assert.ok(sel);
  const opts = [...sel[1].matchAll(/<option value="([a-z]+)">([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]);
  assert.equal(opts[0][0], 'apikey', 'Portal-Schlüssel ist die erste Option');
  assert.match(opts[0][1], /Datenportal/);
  assert.match(opts[0][1], /empfohlen/);
  const help = html.match(/<small id="dsApiKeyHelp"[^>]*>([\s\S]*?)<\/small>/);
  assert.ok(help, 'Hilfe zum Portal-Schlüssel');
  assert.match(help[1], /href="https:\/\/datenspende\.comsys\.rwth-aachen\.de\/portal\/"/);
  assert.match(help[1], /Victron/);
  assert.match(help[1], /Schlüssel erzeugen/);
  assert.match(html, /id="dsHouseholdRow"/, 'Haushalt-Zeile ausblendbar (im Portal angelegt)');
  const js = fs.readFileSync(new URL('../public/tools.js', import.meta.url), 'utf8');
  assert.match(js, /dsEl\('dsHouseholdRow'\)\.hidden = apikey/);
  assert.match(js, /dsEl\('dsApiKeyHelp'\)\.hidden = !apikey/);
});

test('#31 Hilfetexte: E-Mail freiwillig/ein Konto je E-Mail, mehrere Anlagen in EIN Konto, leere Haushalte im Portal löschen', async () => {
  const fs = await import('node:fs');
  const html = decodeHtml(fs.readFileSync(new URL('../public/settings.html', import.meta.url), 'utf8'));
  const email = html.match(/<small id="dsEmailHelp"[^>]*>([\s\S]*?)<\/small>/);
  assert.ok(email);
  assert.match(email[1], /freiwillig/);
  assert.match(email[1], /nur ein Konto/);
  const multi = html.match(/<small id="dsMultiHelp"[^>]*>([\s\S]*?)<\/small>/);
  assert.ok(multi);
  assert.match(multi[1], /EIN Konto/);
  assert.match(multi[1], /Vorhandenes Konto verwenden/);
  assert.match(multi[1], /Haushalt/);
  assert.match(html, /leere[nr]? Haushalt[\s\S]{0,200}Datenportal[\s\S]{0,40}löschen/);
  const js = fs.readFileSync(new URL('../public/tools.js', import.meta.url), 'utf8');
  const hint = js.match(/taken_email: '([^']*)'/);
  assert.ok(hint);
  assert.match(hint[1], /nur ein Konto/);
  assert.match(hint[1], /Vorhandenes Konto verwenden/);
  // Nach Haushalt angelegt, aber Client/Schlüssel gescheitert: Hinweis auf den leeren Haushalt.
  const m = js.match(/function datenspendeFailureText\(r, hints\) \{[\s\S]*?\n\}/);
  const fn = new Function(`${m[0]}; return datenspendeFailureText;`)();
  const t = fn({ status: 400, j: { error: 'bad_request', step: 'clients', stepLabel: 'Client anlegen', detail: '400 bad_request: Invalid input format: null' } }, {});
  assert.match(t, /leere[nr]? Haushalt/);
  assert.match(t, /Datenportal/);
  assert.doesNotMatch(fn({ status: 401, j: { error: 'invalid_credentials', step: 'sign-in', stepLabel: 'Anmelden' } }, {}), /Haushalt/);
});
