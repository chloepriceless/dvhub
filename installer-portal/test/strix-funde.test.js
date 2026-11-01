// installer-portal/test/strix-funde.test.js — die vier bestätigten Strix-Funde
// (Verifikation 30.10.2026) gegen den ECHTEN Portal-Prozess:
//   F1  Passkey anlegen / 2FA einrichten nur mit Bestätigung (Passwort bzw. 2FA-Code)
//   F2  Abmelden beendet die Sitzung serverseitig; „Überall abmelden“
//   F3  Kopplungsdaten mit Größengrenze, nur ausgegebene Befehle, Drossel pro Anlage
//   F4  Fehlerprotokoll wird beim Entkoppeln gelöscht und erst nach Freigabe gezeigt

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { totp } from '../totp.js';
import { makeAuthenticator } from './fake-auth.js';

const SERVER = path.join(import.meta.dirname, '..', 'server.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  s.on('error', rej);
});

// Startet ein Portal. Mit opts.dataDir läuft es auf einem vorhandenen
// Datenverzeichnis (Neustart-Test); stop() beendet nur den Prozess.
async function startPortal(t, env = {}, opts = {}) {
  const dataDir = opts.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'portal-strix-'));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ALLOW_SELF_REGISTER: '1', WEBAUTHN_ORIGIN: url, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  const stop = async () => { if (proc.exitCode === null && proc.signalCode === null) { proc.kill('SIGKILL'); await new Promise((r) => proc.once('exit', r)); } };
  t.after(async () => { await stop(); if (!opts.dataDir) fs.rmSync(dataDir, { recursive: true, force: true }); });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url + '/api/portal-info')).ok) break; } catch { /* startet noch */ }
    await sleep(50);
  }
  async function call(p, { method = 'GET', body, cookie, headers = {} } = {}) {
    const res = await fetch(url + p, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), origin: url, ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let j = null; try { j = JSON.parse(text); } catch { /* kein JSON */ }
    const m = /portal_session=([^;]*)/.exec(res.headers.get('set-cookie') || '');
    return { status: res.status, j, text, cookie: m && m[1] ? `portal_session=${m[1]}` : null };
  }
  return { url, dataDir, call, stop, log: () => log };
}

const PW = 'geheim12345';
async function account(p, name = 'Solar Meier') {
  const r = await p.call('/api/account', { method: 'POST', body: { name, password: PW } });
  assert.equal(r.status, 201, r.text);
  return { name, cookie: r.cookie };
}
const login = (p, name, extra = {}) => p.call('/api/login', { method: 'POST', body: { name, password: PW, ...extra } });

// 2FA einschalten. Der Aktivierungs-Code ist der des VORIGEN Zeitschritts, damit
// der aktuelle und der nächste Code für die Bestätigungen im Test frei bleiben.
async function enableTotp(p, acct) {
  const setup = await p.call('/api/totp/setup', { method: 'POST', cookie: acct.cookie, body: { password: PW } });
  assert.equal(setup.status, 200, setup.text);
  const en = await p.call('/api/totp/enable', { method: 'POST', cookie: acct.cookie, body: { code: totp(setup.j.secret, Date.now() - 30_000) } });
  assert.equal(en.status, 200, en.text);
  acct.cookie = en.cookie;
  return setup.j.secret;
}

// Passkey über die API anlegen (Bestätigung im begin). Aktualisiert acct.cookie.
async function addPasskey(p, acct, confirm, label = 'Laptop') {
  const auth = makeAuthenticator('127.0.0.1');
  const b = await p.call('/api/passkey/register-begin', { method: 'POST', cookie: acct.cookie, body: confirm });
  if (b.status !== 200) return { begin: b };
  const c = auth.create(p.url, b.j.challenge);
  const f = await p.call('/api/passkey/register-finish', { method: 'POST', cookie: acct.cookie, body: {
    label, attestationObject: c.response.attestationObject, clientDataJSON: c.response.clientDataJSON,
  } });
  if (f.cookie) acct.cookie = f.cookie;
  return { begin: b, finish: f, auth };
}

// ── F1 ─────────────────────────────────────────────────────────────────────

test('F1: Passkey anlegen nur mit Passwort — ein gestohlenes Cookie allein reicht nicht', async (t) => {
  const p = await startPortal(t);
  const a = await account(p);
  const stolen = a.cookie;
  const none = await p.call('/api/passkey/register-begin', { method: 'POST', cookie: stolen });
  assert.equal(none.status, 403, none.text);
  assert.equal(none.j.error, 'bestaetigung_noetig');
  assert.equal(none.j.need, 'password');
  assert.equal(none.j.challenge, undefined, 'ohne Bestätigung keine Challenge');
  const wrong = await p.call('/api/passkey/register-begin', { method: 'POST', cookie: stolen, body: { password: 'falsch-falsch' } });
  assert.equal(wrong.status, 403, wrong.text);
  assert.equal(wrong.j.error, 'passwort_falsch');
  assert.equal((await p.call('/api/me', { cookie: stolen })).j.passkeys.length, 0);
});

test('F1: nach dem Anlegen sind andere Sitzungen beendet, Hinweis „neuer Passkey“ sichtbar und geloggt', async (t) => {
  const p = await startPortal(t);
  const a = await account(p);
  const other = await login(p, a.name);
  assert.equal(other.status, 200);
  const r = await addPasskey(p, a, { password: PW }, 'MacBook');
  assert.equal(r.finish.status, 201, r.finish.text);
  assert.ok(r.finish.cookie, 'eigene Sitzung bekommt ein neues Cookie');
  assert.equal((await p.call('/api/me', { cookie: other.cookie })).status, 401, 'zweites Gerät ist abgemeldet');
  const me = await p.call('/api/me', { cookie: a.cookie });
  assert.equal(me.status, 200, me.text);
  assert.equal(me.j.passkeys.length, 1);
  const ev = (me.j.securityEvents || []).find((e) => e.type === 'passkey_added');
  assert.ok(ev, `Sicherheitsereignis fehlt: ${me.text}`);
  assert.equal(ev.label, 'MacBook');
  assert.ok(Date.parse(ev.at) > Date.now() - 60_000);
  assert.match(p.log(), /passkey_added/);
});

test('F1: mit aktiver 2FA braucht der Passkey den 2FA-Code (Passwort allein reicht nicht)', async (t) => {
  const p = await startPortal(t);
  const a = await account(p);
  const secret = await enableTotp(p, a);
  const pwOnly = await p.call('/api/passkey/register-begin', { method: 'POST', cookie: a.cookie, body: { password: PW } });
  assert.equal(pwOnly.status, 403, pwOnly.text);
  assert.equal(pwOnly.j.need, 'code');
  const r = await addPasskey(p, a, { code: totp(secret) });
  assert.equal(r.begin.status, 200, r.begin.text);
  assert.equal(r.finish.status, 201, r.finish.text);
  // Derselbe Code ist verbraucht (Replay-Schutz wie beim Login).
  const again = await p.call('/api/passkey/register-begin', { method: 'POST', cookie: a.cookie, body: { code: totp(secret) } });
  assert.equal(again.status, 403, again.text);
  assert.equal(again.j.error, 'totp_bereits_benutzt');
});

test('F1: 2FA einrichten nur mit Passwort', async (t) => {
  const p = await startPortal(t);
  const a = await account(p);
  const none = await p.call('/api/totp/setup', { method: 'POST', cookie: a.cookie });
  assert.equal(none.status, 403, none.text);
  assert.equal(none.j.error, 'bestaetigung_noetig');
  assert.equal(none.j.secret, undefined);
  const wrong = await p.call('/api/totp/setup', { method: 'POST', cookie: a.cookie, body: { password: 'falsch-falsch' } });
  assert.equal(wrong.status, 403);
  const ok = await p.call('/api/totp/setup', { method: 'POST', cookie: a.cookie, body: { password: PW } });
  assert.equal(ok.status, 200, ok.text);
  assert.ok(ok.j.secret);
});

test('F1: falsche Bestätigungen werden pro Konto gedrosselt', async (t) => {
  const p = await startPortal(t);
  const a = await account(p);
  let last;
  for (let i = 0; i < 6; i++) last = await p.call('/api/passkey/register-begin', { method: 'POST', cookie: a.cookie, body: { password: `falsch-${i}-xx` } });
  assert.equal(last.status, 429, last.text);
  const right = await p.call('/api/passkey/register-begin', { method: 'POST', cookie: a.cookie, body: { password: PW } });
  assert.equal(right.status, 429, 'auch das richtige Passwort wartet die Sperre ab');
});

// ── F2 ─────────────────────────────────────────────────────────────────────

test('F2: Abmelden beendet genau diese Sitzung serverseitig, andere Geräte bleiben', async (t) => {
  const p = await startPortal(t);
  const a = await account(p);
  const laptop = (await login(p, a.name)).cookie;
  const handy = (await login(p, a.name)).cookie;
  const out = await p.call('/api/logout', { method: 'POST', cookie: laptop });
  assert.equal(out.status, 200);
  assert.equal((await p.call('/api/me', { cookie: laptop })).status, 401, 'Kopie des abgemeldeten Cookies ist wertlos');
  assert.equal((await p.call('/api/me', { cookie: handy })).status, 200, 'anderes Gerät bleibt angemeldet');
});

test('F2: Abmeldung überlebt einen Neustart des Portals', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-strix-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const p1 = await startPortal(t, {}, { dataDir });
  const a = await account(p1);
  const keep = (await login(p1, a.name)).cookie;
  assert.equal((await p1.call('/api/logout', { method: 'POST', cookie: a.cookie })).status, 200);
  await p1.stop();
  const p2 = await startPortal(t, {}, { dataDir });
  assert.equal((await p2.call('/api/me', { cookie: a.cookie })).status, 401);
  assert.equal((await p2.call('/api/me', { cookie: keep })).status, 200);
});

test('F2: „Überall abmelden“ beendet alle Sitzungen des Kontos', async (t) => {
  const p = await startPortal(t);
  const a = await account(p);
  const handy = (await login(p, a.name)).cookie;
  const other = await account(p, 'Andere GmbH');
  const all = await p.call('/api/logout-all', { method: 'POST', cookie: a.cookie });
  assert.equal(all.status, 200, all.text);
  assert.equal((await p.call('/api/me', { cookie: a.cookie })).status, 401);
  assert.equal((await p.call('/api/me', { cookie: handy })).status, 401);
  assert.equal((await p.call('/api/me', { cookie: other.cookie })).status, 200, 'fremde Konten unberührt');
  const again = await login(p, a.name);
  assert.equal((await p.call('/api/me', { cookie: again.cookie })).status, 200, 'neu anmelden geht');
});

// ── F3 + F4: gekoppelte Anlage ─────────────────────────────────────────────

const AID = '0b3c8e2a-1111-4222-8333-944455556666';
const AID2 = '0b3c8e2a-1111-4222-8333-944455557777';

async function pair(p, cookie, aid = AID, extra = {}) {
  const np = await p.call('/api/pairings', { method: 'POST', cookie, body: { applianceId: aid, customer: 'Kunde Mueller', ...extra } });
  assert.equal(np.status, 201, np.text);
  const cl = await p.call('/api/pair/claim', { method: 'POST', body: { applianceId: aid, code: np.j.pairing.code } });
  assert.equal(cl.status, 200, cl.text);
  assert.equal((await p.call(`/api/pairings/${aid}/accept`, { method: 'POST', cookie })).status, 200);
  const token = cl.j.applianceToken;
  const box = (route, body) => p.call(route, { method: 'POST', headers: { 'x-appliance-token': token }, body: { applianceId: aid, ...body } });
  return { token, poll: (body = {}) => box('/api/poll', body), result: (results) => box('/api/command-result', { results }), release: () => box('/api/pair/release', {}) };
}
const errs = (n = 5) => Array.from({ length: n }, (_, i) => ({ id: i + 1, ts: new Date().toISOString(), type: 'modbus_error', msg: 'Kunde Mueller: Modbus timeout' }));
const errFile = (p, aid = AID) => path.join(p.dataDir, 'errors', `${aid}.jsonl`);

test('F3: übergroßer Status wird gekürzt gespeichert', async (t) => {
  const p = await startPortal(t);
  const a = await account(p);
  const box = await pair(p, a.cookie);
  const r = await box.poll({ status: { blob: 'A'.repeat(200_000) } });
  assert.equal(r.status, 200, r.text);
  const v = (await p.call(`/api/pairings/${AID}`, { cookie: a.cookie })).j.pairing;
  assert.equal(v.lastStatus.truncated, true, JSON.stringify(v.lastStatus).slice(0, 200));
  assert.ok(v.lastStatus.bytes > 64 * 1024);
  assert.ok(fs.statSync(path.join(p.dataDir, 'pairings.json')).size < 64 * 1024, 'pairings.json bleibt klein');
  await box.poll({ status: { soc: 55, pvTotalW: 1200 } });
  assert.deepEqual((await p.call(`/api/pairings/${AID}`, { cookie: a.cookie })).j.pairing.lastStatus, { soc: 55, pvTotalW: 1200 });
});

test('F3: Ergebnisse nur für ausgegebene Befehle, höchstens 50 behalten', async (t) => {
  const p = await startPortal(t, { APPLIANCE_RATE_PER_MIN: '1000' });
  const a = await account(p);
  const box = await pair(p, a.cookie);
  const fake = Array.from({ length: 200 }, (_, i) => ({ id: `frei-${i}`, ok: true, result: { x: 'y'.repeat(200) } }));
  assert.equal((await box.result(fake)).status, 200);
  let v = (await p.call(`/api/pairings/${AID}`, { cookie: a.cookie })).j.pairing;
  assert.deepEqual(v.results, {}, 'frei gewählte IDs werden verworfen');
  const issued = [];
  for (let i = 0; i < 55; i++) {
    const c = await p.call(`/api/pairings/${AID}/command`, { method: 'POST', cookie: a.cookie, body: { type: 'updates_check' } });
    assert.equal(c.status, 200, c.text);
    const pl = await box.poll();
    assert.deepEqual(pl.j.commands.map((x) => x.id), [c.j.commandId]);
    issued.push(c.j.commandId);
  }
  // Ein noch nicht abgeholter Befehl darf ebenfalls kein Ergebnis bekommen.
  const queued = (await p.call(`/api/pairings/${AID}/command`, { method: 'POST', cookie: a.cookie, body: { type: 'updates_check' } })).j.commandId;
  assert.equal((await box.result([...issued, queued].map((id) => ({ id, ok: true, status: 200, result: { ok: true } })))).status, 200);
  v = (await p.call(`/api/pairings/${AID}`, { cookie: a.cookie })).j.pairing;
  const ids = Object.keys(v.results);
  assert.equal(ids.length, 50, `genau 50 behalten, nicht ${ids.length}`);
  assert.deepEqual(ids.sort(), issued.slice(-50).sort(), 'die neuesten 50');
  assert.ok(!ids.includes(queued));
  // Ein riesiges Einzelergebnis wird gekürzt gespeichert.
  assert.deepEqual((await box.poll()).j.commands.map((x) => x.id), [queued]);
  await box.result([{ id: queued, ok: true, status: 200, result: { blob: 'z'.repeat(100_000) } }]);
  v = (await p.call(`/api/pairings/${AID}`, { cookie: a.cookie })).j.pairing;
  assert.equal(v.results[queued].result.truncated, true);
  assert.equal(Object.keys(v.results).length, 50);
});

test('F3: Drossel pro Anlage, nicht pro IP — andere Box hinter derselben IP läuft weiter', async (t) => {
  const p = await startPortal(t);
  const a = await account(p);
  const box1 = await pair(p, a.cookie, AID);
  const box2 = await pair(p, a.cookie, AID2);
  const codes = {};
  for (let i = 0; i < 40; i++) { const s = (await box1.poll()).status; codes[s] = (codes[s] || 0) + 1; }
  assert.ok(codes[429] >= 5, `Dauerfeuer wird gebremst: ${JSON.stringify(codes)}`);
  assert.ok(codes[200] >= 20, `normaler Takt bleibt möglich: ${JSON.stringify(codes)}`);
  assert.equal((await box2.poll()).status, 200, 'zweite Anlage (gleiche IP) unberührt');
  const rc = {};
  for (let i = 0; i < 40; i++) { const s = (await box1.result([])).status; rc[s] = (rc[s] || 0) + 1; }
  assert.ok(rc[429] >= 5, `command-result gedrosselt: ${JSON.stringify(rc)}`);
  assert.equal((await box2.result([])).status, 200);
});

test('F3: Anfragen mit falschem Token verbrauchen nicht das Kontingent der echten Anlage', async (t) => {
  const p = await startPortal(t);
  const a = await account(p);
  const box = await pair(p, a.cookie);
  for (let i = 0; i < 40; i++) {
    await p.call('/api/poll', { method: 'POST', headers: { 'x-appliance-token': 'f'.repeat(64) }, body: { applianceId: AID } });
  }
  assert.equal((await box.poll()).status, 200);
});

test('F4: Entfernen der Kopplung löscht das Fehlerprotokoll; neuer Installateur sieht nichts', async (t) => {
  const p = await startPortal(t);
  const a = await account(p, 'inst-a');
  const box = await pair(p, a.cookie);
  await box.poll({ status: {}, errors: errs() });
  assert.equal((await p.call(`/api/pairings/${AID}/errors`, { cookie: a.cookie })).j.errors.length, 5);
  assert.equal((await p.call(`/api/pairings/${AID}`, { method: 'DELETE', cookie: a.cookie })).status, 200);
  assert.equal(fs.existsSync(errFile(p)), false, 'Fehlerdatei gelöscht');
  const b = await account(p, 'inst-b');
  const nb = await p.call('/api/pairings', { method: 'POST', cookie: b.cookie, body: { applianceId: AID } });
  assert.equal(nb.status, 201);
  const eb = await p.call(`/api/pairings/${AID}/errors`, { cookie: b.cookie });
  assert.equal(eb.status, 200, eb.text);
  assert.equal(eb.j.errors.length, 0);
});

test('F4: Trennen durch den Kunden löscht das Fehlerprotokoll', async (t) => {
  const p = await startPortal(t);
  const a = await account(p);
  const box = await pair(p, a.cookie);
  await box.poll({ status: {}, errors: errs() });
  assert.ok(fs.existsSync(errFile(p)));
  assert.equal((await box.release()).status, 200);
  assert.equal(fs.existsSync(errFile(p)), false);
});

test('F4: Übernahme durch ein anderes Konto (verwaiste Freigabe) löscht das Protokoll, auch Altbestand', async (t) => {
  const p = await startPortal(t);
  const a = await account(p, 'inst-a');
  const box = await pair(p, a.cookie);
  await box.poll({ status: {}, errors: errs() });
  const file = path.join(p.dataDir, 'pairings.json');
  const all = JSON.parse(fs.readFileSync(file, 'utf8'));
  all[AID].lastSeenAt = new Date(Date.now() - 8 * 86400_000).toISOString();
  fs.writeFileSync(file, JSON.stringify(all));
  const b = await account(p, 'inst-b');
  assert.equal((await p.call('/api/pairings', { method: 'POST', cookie: b.cookie, body: { applianceId: AID } })).status, 201);
  assert.equal(fs.existsSync(errFile(p)), false, 'Wechsel zu anderem Konto löscht');
  // Verwaiste Datei ohne Kopplung (Altbestand vor dem Fix) fällt beim Anlegen weg.
  fs.writeFileSync(errFile(p, AID2), JSON.stringify(errs(1)[0]) + '\n');
  assert.equal((await p.call('/api/pairings', { method: 'POST', cookie: b.cookie, body: { applianceId: AID2 } })).status, 201);
  assert.equal(fs.existsSync(errFile(p, AID2)), false);
});

test('F4: eigenes Neu-Koppeln behält das Protokoll, gezeigt wird es erst nach Freigabe', async (t) => {
  const p = await startPortal(t);
  const a = await account(p);
  const box = await pair(p, a.cookie);
  await box.poll({ status: {}, errors: errs() });
  const np = await p.call('/api/pairings', { method: 'POST', cookie: a.cookie, body: { applianceId: AID, replace: true } });
  assert.equal(np.status, 201, np.text);
  assert.ok(fs.existsSync(errFile(p)), 'eigenes Neu-Koppeln behält die Datei');
  const waiting = await p.call(`/api/pairings/${AID}/errors`, { cookie: a.cookie });
  assert.equal(waiting.status, 200);
  assert.equal(waiting.j.errors.length, 0, 'vor der Freigabe nichts zeigen');
  const cl = await p.call('/api/pair/claim', { method: 'POST', body: { applianceId: AID, code: np.j.pairing.code } });
  assert.equal(cl.status, 200);
  assert.equal((await p.call(`/api/pairings/${AID}/accept`, { method: 'POST', cookie: a.cookie })).status, 200);
  assert.equal((await p.call(`/api/pairings/${AID}/errors`, { cookie: a.cookie })).j.errors.length, 5);
});

test('F4: Admin-Umverteilung behält das Protokoll', async (t) => {
  const p = await startPortal(t, { ADMIN_SETUP_TOKEN: 'setup-0123456789' });
  const adm = await p.call('/api/account', { method: 'POST', body: { name: 'admin', password: PW, setupToken: 'setup-0123456789' } });
  assert.equal(adm.status, 201, adm.text);
  const a = await account(p, 'inst-a');
  const b = await account(p, 'inst-b');
  const box = await pair(p, a.cookie);
  await box.poll({ status: {}, errors: errs() });
  const r = await p.call('/api/admin/reassign', { method: 'POST', cookie: adm.cookie, body: { applianceId: AID, toAccount: 'inst-b' } });
  assert.equal(r.status, 200, r.text);
  assert.equal((await p.call(`/api/pairings/${AID}/errors`, { cookie: b.cookie })).j.errors.length, 5);
});
