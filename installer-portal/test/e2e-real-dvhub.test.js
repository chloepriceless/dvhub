// installer-portal/test/e2e-real-dvhub.test.js — echtes End-to-End:
// ECHTER DVhub-Prozess (dvhub/server.js, Boot-Rezept aus .claude/skills/verify)
// ↔ ECHTER Portal-Prozess (installer-portal/server.js), alles über HTTP.
//
// Deckt beide Kopplungswege ab:
//   Pull (NAT):  Code im Portal → Kunde koppelt in DVhub → Freigabe → Poll →
//                Kommandos (inkl. Freigabe-Gate Tunnel) → Schalter aus →
//                Trennen gibt die Anlage im Portal frei.
//   Push:        Portal registriert Zertifikat bei DVhub → Kunde bestätigt
//                Code → Portal-Login per Signatur → Status → Tunnel-Gate →
//                Widerruf sperrt sofort.
//
// DVhub bootet ohne Postgres/EOS/Hardware (Telemetrie „store DISABLED“).
// Poll-Takt per DV_INSTALLER_POLL_MS auf 400 ms verkürzt.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const APPLIANCE_ID = 'e2e-real-appliance-01';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

async function call(url, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, j, text, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

async function waitFor(fn, { timeoutMs = 15000, stepMs = 150, what = 'Bedingung' } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    last = await fn();
    if (last) return last;
    await sleep(stepMs);
  }
  throw new Error(`Timeout: ${what}`);
}

function startProc(args, env, logFile) {
  const out = fs.openSync(logFile, 'w');
  return spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ['ignore', out, out] });
}

for (const apiToken of ['e2e-api-token-0123456789abcdef', '']) {
test(`E2E echter DVhub ↔ echtes Portal (${apiToken ? 'mit' : 'OHNE'} apiToken): Pull + Push inkl. Schutzmechanismen`, { timeout: 120_000 }, async (t) => {
  const rig = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-e2e-real-'));
  fs.mkdirSync(path.join(rig, 'etc', 'hersteller'), { recursive: true });
  fs.mkdirSync(path.join(rig, 'data'));
  fs.mkdirSync(path.join(rig, 'portal'));
  fs.writeFileSync(path.join(rig, 'data', 'appliance-id'), APPLIANCE_ID);
  fs.copyFileSync(path.join(ROOT, 'dvhub', 'hersteller', 'victron.json'), path.join(rig, 'etc', 'hersteller', 'victron.json'));
  const dvPort = await freePort();
  const portalPort = await freePort();
  fs.writeFileSync(path.join(rig, 'etc', 'config.json'), JSON.stringify({
    manufacturer: 'victron', httpPort: dvPort, httpsPort: 0,
    apiToken,
    victron: { host: '127.0.0.1' },
  }));

  const dvProc = startProc([path.join(ROOT, 'dvhub', 'server.js')], {
    DV_APP_CONFIG: path.join(rig, 'etc', 'config.json'),
    DV_DATA_DIR: path.join(rig, 'data'),
    DV_INSTALLER_POLL_MS: '400',
    NODE_ENV: 'test',
  }, path.join(rig, 'dvhub.log'));
  const portalProc = startProc([path.join(ROOT, 'installer-portal', 'server.js')], {
    PORT: String(portalPort), DATA_DIR: path.join(rig, 'portal'),
  }, path.join(rig, 'portal.log'));
  t.after(() => {
    dvProc.kill('SIGKILL');
    portalProc.kill('SIGKILL');
    if (!process.env.KEEP_RIG) fs.rmSync(rig, { recursive: true, force: true });
    else console.log('Rig:', rig);
  });

  const dv = (p) => `http://127.0.0.1:${dvPort}${p}`;
  const pv = (p) => `http://127.0.0.1:${portalPort}${p}`;
  await waitFor(async () => { try { return (await fetch(dv('/healthz'))).ok; } catch { return false; } },
    { timeoutMs: 30000, what: 'DVhub bootet' });
  await waitFor(async () => { try { return (await fetch(pv('/'))).ok; } catch { return false; } },
    { what: 'Portal bootet' });
  // Kunden-Aktionen wie aus der eigenen UI: CSRF-Nonce aus GET /settings mitschicken.
  const custPost = async (p, body) => {
    const n = await call(dv('/api/installer/settings'));
    return call(dv(p), { method: 'POST', body: { ...body, uiToken: n.j.uiToken } });
  };

  // ── 0) Ab Werk: Portal aus, WAN-Register gesperrt ──────────────────────────
  const s0 = await call(dv('/api/installer/settings'));
  assert.equal(s0.status, 200, s0.text);
  assert.deepEqual([s0.j.enabled, s0.j.allowTunnel, s0.j.allowUpdates], [false, false, false]);
  const list0 = await call(dv('/api/installer/list'));
  assert.equal(list0.j.applianceId, APPLIANCE_ID, 'Appliance-ID auch bei ausgeschaltetem Portal sichtbar');

  // ── 1) Portal-Konto ────────────────────────────────────────────────────────
  const acct = await call(pv('/api/account'), { method: 'POST', body: { name: 'Solar Meier', company: 'SM GmbH', password: 'test1234ab' } });
  assert.equal(acct.status, 201, acct.text);
  const cookie = acct.cookie;
  // Path-Traversal-Name landet NICHT außerhalb eines eigenen Key-Verzeichnisses
  const evil = await call(pv('/api/account'), { method: 'POST', body: { name: '../keys/x', password: 'test1234ab' } });
  assert.equal(evil.status, 201);
  const keyDirs = fs.readdirSync(path.join(rig, 'portal', 'keys'));
  assert.ok(keyDirs.every((d) => /^acct-[a-f0-9]{16}$/.test(d)), `nur opake Key-Ordner: ${keyDirs}`);

  // Kaputter Host-Header darf das Portal nicht abschießen
  const rawResp = await new Promise((resolve) => {
    const sock = net.connect(portalPort, '127.0.0.1', () => sock.write('GET /api/me HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n'));
    let buf = '';
    sock.on('data', (d) => { buf += d; });
    sock.on('end', () => resolve(buf));
    sock.on('error', () => resolve(buf));
  });
  assert.match(rawResp, /^HTTP\/1\.1 (400|401) /, rawResp.slice(0, 80));
  assert.ok((await fetch(pv('/'))).ok, 'Portal lebt nach kaputtem Host-Header');

  // SSRF: Anlagen-URL mit Pfad/Query wird abgewiesen
  for (const u of [`${dv('')}/api/admin/service/restart?`, `${dv('')}/x`, `http://user:pw@127.0.0.1:${dvPort}`, 'file:///etc/passwd']) {
    const r = await call(pv('/api/appliances'), { method: 'POST', cookie, body: { url: u } });
    assert.equal(r.status, 400, `${u} → ${r.text}`);
  }

  // ════════════════ PULL-MODELL ════════════════
  const pr = await call(pv('/api/pairings'), { method: 'POST', cookie, body: { applianceId: APPLIANCE_ID } });
  assert.equal(pr.status, 201, pr.text);
  const code = pr.j.pairing.code;

  // Fremder Installateur darf die laufende Kopplung nicht überschreiben
  const other = await call(pv('/api/account'), { method: 'POST', body: { name: 'Konkurrenz', password: 'test1234ab' } });
  const steal = await call(pv('/api/pairings'), { method: 'POST', cookie: other.cookie, body: { applianceId: APPLIANCE_ID } });
  assert.equal(steal.status, 409, steal.text);

  // Falscher Code → Fehlversuch; Kunde koppelt dann mit richtigem Code
  const wrongCode = code === '000000' ? '000001' : '000000';
  // CSRF: ohne Nonce (fremde Webseite) keine Kopplung
  const csrf = await call(dv('/api/installer/client/pair'), { method: 'POST', body: { portalUrl: pv(''), pairingCode: code } });
  assert.equal(csrf.status, 403, csrf.text);
  assert.equal(csrf.j.error, 'ui_token_required');
  const bad = await custPost('/api/installer/client/pair', { portalUrl: pv(''), pairingCode: wrongCode });
  assert.equal(bad.status, 403, bad.text);
  assert.equal(bad.j.error, 'pairing_code_mismatch');
  const claim = await custPost('/api/installer/client/pair', { portalUrl: pv(''), pairingCode: code, name: 'Testhof' });
  assert.equal(claim.status, 200, claim.text);
  assert.equal(claim.j.status, 'requested');
  const s1 = await call(dv('/api/installer/settings'));
  assert.equal(s1.j.enabled, true, 'Kopplung starten schaltet den Portal-Zugang ein');

  // Freigabe → Poll kommt mit Live-Status an
  const acc = await call(pv(`/api/pairings/${APPLIANCE_ID}/accept`), { method: 'POST', cookie });
  assert.equal(acc.status, 200, acc.text);
  const seen = await waitFor(async () => {
    const r = await call(pv(`/api/pairings/${APPLIANCE_ID}`), { cookie });
    return r.j?.pairing?.seenAt ? r.j.pairing : null;
  }, { what: 'erster Poll nach Freigabe' });
  assert.ok(seen.lastStatus && 'soc' in seen.lastStatus, JSON.stringify(seen.lastStatus));
  const cst = await call(dv('/api/installer/client/status'));
  assert.equal(cst.j.paired, true);
  assert.equal(cst.j.approved, true);

  // Kommando ohne Kunden-Freigabe: Tunnel öffnen wird abgewiesen
  const q1 = await call(pv(`/api/pairings/${APPLIANCE_ID}/command`), { method: 'POST', cookie, body: { type: 'open_tunnel', args: { ttlMin: 15 } } });
  const r1 = await waitFor(async () => {
    const r = await call(pv(`/api/pairings/${APPLIANCE_ID}`), { cookie });
    return r.j.pairing.results[q1.j.commandId] || null;
  }, { what: 'Ergebnis open_tunnel' });
  assert.equal(r1.ok, false);
  assert.equal(r1.result.error, 'tunnel_not_permitted');

  // Tunnel schließen läuft immer — echt gegen die Loopback-Route der Anlage
  const q2 = await call(pv(`/api/pairings/${APPLIANCE_ID}/command`), { method: 'POST', cookie, body: { type: 'close_tunnel' } });
  const r2 = await waitFor(async () => {
    const r = await call(pv(`/api/pairings/${APPLIANCE_ID}`), { cookie });
    return r.j.pairing.results[q2.j.commandId] || null;
  }, { what: 'Ergebnis close_tunnel' });
  assert.notEqual(r2.status, 401, `Loopback-Auth muss greifen: ${JSON.stringify(r2)}`);
  assert.notEqual(r2.status, 0, `Loopback erreichbar: ${JSON.stringify(r2)}`);

  // Mit Kunden-Freigabe: open_tunnel erreicht die echte Tunnel-Route. Im Rig
  // ist kein Relay provisioniert → 409 — aber eben NICHT 403 (Auth/Nonce).
  const allow = await custPost('/api/installer/settings', { allowTunnel: true });
  assert.equal(allow.status, 200, allow.text);
  const q3 = await call(pv(`/api/pairings/${APPLIANCE_ID}/command`), { method: 'POST', cookie, body: { type: 'open_tunnel', args: { ttlMin: 5 } } });
  const r3 = await waitFor(async () => {
    const r = await call(pv(`/api/pairings/${APPLIANCE_ID}`), { cookie });
    return r.j.pairing.results[q3.j.commandId] || null;
  }, { what: 'Ergebnis open_tunnel mit Freigabe' });
  assert.notEqual(r3.status, 403, `Tunnel-Route muss Auth akzeptieren: ${JSON.stringify(r3)}`);
  assert.notEqual(r3.result?.error, 'tunnel_not_permitted');
  const deny = await call(dv('/api/installer/settings'), { method: 'POST', body: { allowTunnel: false } });
  assert.equal(deny.status, 200, 'Ausschalten geht ohne Nonce');

  // Schalter aus → Anlage meldet sich nicht mehr
  const off = await call(dv('/api/installer/settings'), { method: 'POST', body: { enabled: false } });
  assert.equal(off.status, 200, off.text);
  await sleep(600); // evtl. laufenden Poll auslaufen lassen
  const before = (await call(pv(`/api/pairings/${APPLIANCE_ID}`), { cookie })).j.pairing.seenAt;
  await sleep(1500);
  const after = (await call(pv(`/api/pairings/${APPLIANCE_ID}`), { cookie })).j.pairing.seenAt;
  assert.equal(after, before, 'kein Poll bei ausgeschaltetem Portal');

  // Wieder an → Polls laufen weiter; dann Trennen → Portal gibt Anlage frei
  await custPost('/api/installer/settings', { enabled: true });
  await waitFor(async () => (await call(pv(`/api/pairings/${APPLIANCE_ID}`), { cookie })).j.pairing.seenAt !== after,
    { what: 'Poll nach Wieder-Einschalten' });
  const disc = await call(dv('/api/installer/client/disconnect'), { method: 'POST' });
  assert.equal(disc.status, 200);
  await waitFor(async () => (await call(pv(`/api/pairings/${APPLIANCE_ID}`), { cookie })).status === 404,
    { what: 'Portal löscht Kopplung nach Trennen' });
  assert.equal((await call(dv('/api/installer/client/status'))).j.paired, false);

  // ════════════════ PUSH-MODELL ════════════════
  const ap = await call(pv('/api/appliances'), { method: 'POST', cookie, body: { url: dv(''), name: 'Testhof direkt' } });
  assert.equal(ap.status, 201, ap.text);
  const apId = ap.j.appliance.id;
  const { installerId, pairingCode } = ap.j.appliance;
  assert.match(pairingCode, /^\d{6}$/);

  // Vor der Bestätigung durch den Kunden: kein Login möglich
  const early = await call(pv(`/api/appliances/${apId}/try-pair`), { method: 'POST', cookie });
  assert.equal(early.j.paired, false);

  const conf = await custPost('/api/installer/confirm', { installerId, pairingCode });
  assert.equal(conf.status, 200, conf.text);
  const tp = await call(pv(`/api/appliances/${apId}/try-pair`), { method: 'POST', cookie });
  assert.equal(tp.j.paired, true, tp.text);

  const st = await call(pv(`/api/appliances/${apId}/status`), { cookie });
  assert.equal(st.status, 200, st.text);
  assert.ok(st.j.compact, 'kompakter Status über Signatur-Session');

  // Historie: Query-Parameter müssen bis DVhub durchkommen. view=month ist in
  // DVhub eine Pro-Ansicht → ohne Lizenz 403 pro_required; ginge der Parameter
  // verloren, käme die Tagesansicht (hier 503, kein Telemetrie-Store im Rig).
  const hist = await call(pv(`/api/appliances/${apId}/history?view=month&date=2026-08-01`), { cookie });
  assert.equal(hist.status, 403, `view=month muss ankommen: ${hist.text}`);
  assert.equal(hist.j.error, 'pro_required');
  const histDay = await call(pv(`/api/appliances/${apId}/history`), { cookie });
  assert.notEqual(histDay.status, 403, histDay.text);

  const tOpen = await call(pv(`/api/appliances/${apId}/tunnel/open`), { method: 'POST', cookie, body: { ttlMin: 15 } });
  assert.equal(tOpen.status, 403, tOpen.text);
  assert.equal(tOpen.j.error, 'tunnel_not_permitted');
  const uApply = await call(pv(`/api/appliances/${apId}/updates/apply`), { method: 'POST', cookie, body: {} });
  assert.equal(uApply.status, 403, uApply.text);
  assert.equal(uApply.j.error, 'updates_not_permitted');

  // Widerruf durch den Kunden → Portal kommt sofort nicht mehr rein
  const rev = await call(dv('/api/installer/revoke'), { method: 'POST', body: { installerId } });
  assert.equal(rev.status, 200, rev.text);
  const st2 = await call(pv(`/api/appliances/${apId}/status`), { cookie });
  assert.equal(st2.status, 403, `nach Widerruf gesperrt: ${st2.text}`);
  assert.equal(st2.j.error, 'zugang_vom_kunden_widerrufen');

  // Schalter aus → WAN-Register liefert 503
  await call(dv('/api/installer/settings'), { method: 'POST', body: { enabled: false } });
  const ap2 = await call(pv('/api/appliances'), { method: 'POST', cookie, body: { url: dv('') } });
  assert.equal(ap2.status, 502);
  assert.equal(ap2.j.error, 'installer_portal_disabled');

  // Allgemeines Settings-Speichern (veralteter Entwurf mit Portal AN) darf den
  // ausgeschalteten Fernzugang NICHT wieder einschalten.
  const cfgNow = await call(dv('/api/config'));
  assert.equal(cfgNow.status, 200, cfgNow.text);
  const stale = { ...cfgNow.j.config, installerPortal: { enabled: true, allowTunnel: true, allowUpdates: true } };
  const save = await call(dv('/api/config'), { method: 'POST', body: { config: stale } });
  assert.equal(save.status, 200, save.text);
  const sEnd = await call(dv('/api/installer/settings'));
  assert.deepEqual([sEnd.j.enabled, sEnd.j.allowTunnel, sEnd.j.allowUpdates], [false, false, false]);
});
}
