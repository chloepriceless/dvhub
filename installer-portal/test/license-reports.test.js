// test/license-reports.test.js — Lizenz und Tagesberichte im Portal:
//  * Anlage ohne Pro-Lizenz: Kopplung erlaubt, aber nur „Lizenz einspielen“.
//  * Lizenzschlüssel wird geprüft und taucht in keiner Portal-Antwort auf.
//  * Angegebene Anlagengröße wird gegen die Lizenz-kWp geprüft.
//  * Tagesberichte (Tagesertrag + DV-Monatserlös) werden gespeichert; ein
//    nachgeholter älterer Tag überschreibt keinen neueren Monatsstand.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

const SERVER = path.join(import.meta.dirname, '..', 'server.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  s.on('error', rej);
});

async function startPortal(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-lic-'));
  const port = await freePort();
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ALLOW_SELF_REGISTER: '1' }, stdio: 'ignore' });
  t.after(() => { proc.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(url + '/api/portal-info')).ok) break; } catch { /* startet */ } await sleep(50); }
  async function call(p, { method = 'GET', body, cookie, headers = {} } = {}) {
    const res = await fetch(url + p, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let j = null; try { j = JSON.parse(text); } catch { /* */ }
    return { status: res.status, j, text, cookie: (res.headers.get('set-cookie') || '').split(';')[0] || null };
  }
  return { call };
}

const AID = 'lic-appliance-01';
const noPro = { proActive: false, status: 'none', maxKwp: null, systemKwp: null, capacityOk: true };
const pro30 = { proActive: true, status: 'active', maxKwp: 30, systemKwp: 29.7, capacityOk: true };

async function pairedAppliance(t, sizeKwp = 35) {
  const p = await startPortal(t);
  const acct = await p.call('/api/account', { method: 'POST', body: { name: 'Solar Meier', password: 'geheim12345' } });
  const cookie = acct.cookie;
  const pr = await p.call('/api/pairings', { method: 'POST', cookie, body: { applianceId: AID, name: 'Musterhof', sizeKwp } });
  assert.equal(pr.status, 201, pr.text);
  const claim = await p.call('/api/pair/claim', { method: 'POST', body: { applianceId: AID, code: pr.j.pairing.code, license: noPro } });
  assert.equal(claim.status, 200, 'Kopplung ohne Lizenz ist erlaubt: ' + claim.text);
  const token = claim.j.applianceToken;
  assert.equal((await p.call(`/api/pairings/${AID}/accept`, { method: 'POST', cookie })).status, 200);
  const poll = (body) => p.call('/api/poll', { method: 'POST', headers: { 'x-appliance-token': token }, body: { applianceId: AID, ...body } });
  const view = async () => (await p.call(`/api/pairings/${AID}`, { cookie })).j.pairing;
  const cmd = (type, args) => p.call(`/api/pairings/${AID}/command`, { method: 'POST', cookie, body: { type, args } });
  return { p, cookie, poll, view, cmd };
}

test('Ohne Pro-Lizenz: nur „Lizenz einspielen“; Schlüssel geprüft und nie in der Anzeige', async (t) => {
  const { p, cookie, poll, view, cmd } = await pairedAppliance(t);
  await poll({ license: noPro, status: null });
  const v = await view();
  assert.equal(v.license.proActive, false);
  assert.equal(v.lastStatus, null);
  assert.equal(v.sizeCheck, null, 'ohne Lizenz kein Größenvergleich');
  const tun = await cmd('open_tunnel', { ttlMin: 30 });
  assert.equal(tun.status, 409);
  assert.equal(tun.j.error, 'lizenz_erforderlich');
  assert.equal((await cmd('license_activate', { key: 'kurz' })).j.error, 'lizenzschluessel_ungueltig');
  assert.equal((await cmd('license_activate', { key: 'ab\u0001cdefghij' })).status, 400, 'Steuerzeichen abgewiesen');
  // Aus einer Mail kopiert (Leerzeichen/Zeilenumbruch) → wie in DVhub normalisiert
  const pasted = await cmd('license_activate', { key: 'DVHUB-PRO-\n ZZZZ-9999' });
  assert.equal(pasted.status, 200, pasted.text);
  assert.equal((await poll({ license: noPro, status: null })).j.commands[0].args.key, 'DVHUB-PRO-ZZZZ-9999');
  const KEY = 'DVHUB-PRO-ABCD-1234-EFGH';
  const ok = await cmd('license_activate', { key: KEY });
  assert.equal(ok.status, 200, ok.text);
  const listText = (await p.call('/api/pairings', { cookie })).text + (await p.call(`/api/pairings/${AID}`, { cookie })).text;
  assert.ok(!listText.includes(KEY), 'Lizenzschlüssel darf in keiner Portal-Antwort stehen');
  const got = await poll({ license: noPro, status: null });
  assert.equal(got.j.commands[0].type, 'license_activate');
  assert.equal(got.j.commands[0].args.key, KEY, 'die Anlage bekommt den Schlüssel');
  // Lizenz jetzt aktiv → andere Kommandos wieder erlaubt
  await poll({ license: pro30, status: { soc: 50 } });
  assert.equal((await cmd('updates_check')).status, 200);
});

test('Größenprüfung: angegebene kWp über der Lizenz → Hinweis; passend → ok', async (t) => {
  const { poll, view, p, cookie } = await pairedAppliance(t, 35);
  await poll({ license: pro30, status: { soc: 50 } });
  assert.deepEqual((await view()).sizeCheck, { ok: false, reason: 'size_exceeds_license', sizeKwp: 35, maxKwp: 30 });
  await p.call(`/api/pairings/${AID}/rename`, { method: 'POST', cookie, body: { sizeKwp: 29.7 } });
  assert.deepEqual((await view()).sizeCheck, { ok: true, maxKwp: 30 });
  // Wie der echte Lizenz-Service: Anlage größer als Lizenz → Pro ist gesperrt (proActive false).
  await poll({ license: { ...pro30, proActive: false, capacityOk: false, systemKwp: 40 }, status: null });
  assert.equal((await view()).sizeCheck.reason, 'plant_exceeds_license', 'Hinweis auch (gerade) bei gesperrtem Pro');
});

test('Tagesberichte: gespeichert, Monat nur vorwärts, letzter Tag sichtbar', async (t) => {
  const { poll, view } = await pairedAppliance(t);
  const rep = (day, dv) => ({ day, netEur: 4.2, exportRevenueEur: 5.1, importCostEur: null, exportKwh: 60.5, pvKwh: 80,
    month: { month: day.slice(0, 7), asOf: `${day}T23:59:00.000Z`, dvRevenueEur: dv, exportRevenueEur: dv - 20, marketPremiumEur: 20, exportKwh: 1500, dvRevenueCtKwh: null } });
  await poll({ license: pro30, status: { soc: 50 }, dayReport: rep('2026-09-28', 100) });
  await poll({ license: pro30, status: { soc: 50 }, dayReport: rep('2026-09-29', 120) });
  await poll({ license: pro30, status: { soc: 50 }, dayReport: rep('2026-09-27', 90) }); // nachgeholt
  const v = await view();
  assert.equal(v.lastDay.day, '2026-09-29');
  assert.equal(v.lastDay.netEur, 4.2);
  assert.equal(v.months['2026-09'].dvRevenueEur, 120, 'älterer Nachtrag überschreibt den neueren Monatsstand nicht');
  assert.equal(v.months['2026-09'].asOf, '2026-09-29T23:59:00.000Z');
  assert.equal(v.months['2026-09'].dvRevenueCtKwh, null, 'unbekannt bleibt null, nicht 0 ct/kWh');
  assert.equal(v.lastDay.importCostEur, null);
  // Müll wird ignoriert
  await poll({ license: pro30, status: { soc: 50 }, dayReport: { day: 'gestern', netEur: 'viel' } });
  assert.equal((await view()).lastDay.day, '2026-09-29');
});
