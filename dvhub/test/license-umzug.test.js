// test/license-umzug.test.js — Lizenz-Umzug sichtbar machen, Kopien nicht
// automatisch binden (Vorfall 04./05.11.2026).
//
// Ein Test-Stack mit kopierter license_state.json band beim Start die Lizenz
// an sich; der Webhook löste die Maschine von Prod (machine_auto_retire). Prod
// (1.0.9) erkannte das im Revalidate (FINGERPRINT_SCOPE_MISMATCH →
// bound_to_other_box) und schaltete Pro still ab, 22 min.
//
//   a) Verliert eine Box ihre Bindung an eine andere Box: Benachrichtigung
//      einmal je Ereignis (ctx.notifyDirect — im Worker-Betrieb notify_direct)
//      und ein Hinweis im Leitstand („Deine Lizenz ist jetzt auf einer anderen
//      Box …“).
//   b) Stammt der Lizenzzustand von einer ANDEREN Box (Machine-File mit
//      fremdem Fingerprint, oder ohne File mit fremder Herkunft), wird nicht
//      automatisch gebunden: „Lizenz von anderer Box übernommen – an diese Box
//      binden?“, Bindung erst per Knopf (activate-node-lock) oder frisch
//      eingegebenem Schlüssel.
//
// fetch ist gestubbt, Schlüssel und Machine-Files mit eigenem Ed25519-Paar.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';

import { createLicenseService } from '../services/license/index.js';

const KP = crypto.generateKeyPairSync('ed25519');
const PUB = KP.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');

function mintKey(payload = { license: { id: 'lic-1' }, policy: { id: 'pol-pro' } }) {
  const sd = `key/${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  return `${sd}.${crypto.sign(null, Buffer.from(sd), KP.privateKey).toString('base64')}`;
}
const KEY = mintKey();

function mintMachineFile(fingerprint, { licenseId = 'lic-1' } = {}) {
  const dataset = { data: { type: 'machines', id: 'm1', attributes: { fingerprint } }, included: [{ type: 'licenses', id: licenseId }], meta: {} };
  const enc = Buffer.from(JSON.stringify(dataset)).toString('base64');
  const sig = crypto.sign(null, Buffer.from(`machine/${enc}`), KP.privateKey).toString('base64');
  return `-----BEGIN MACHINE FILE-----\n${Buffer.from(JSON.stringify({ enc, sig, alg: 'base64+ed25519' })).toString('base64')}\n-----END MACHINE FILE-----\n`;
}

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const validateBody = ({ valid = true, code = 'VALID' } = {}) => ({
  meta: { valid, code, ts: new Date().toISOString() },
  data: { id: 'lic-1', type: 'licenses', attributes: { status: 'ACTIVE', expiry: null, metadata: {} } },
});

/**
 * Box im Wegwerf-Ordner. `notifyDirect: false` = ohne ctx.notifyDirect
 * (Altaufrufer); sonst werden die Meldungen in `notes` gesammelt.
 */
function box({ applianceId = 'box-a', persisted = null, notifyDirect = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lic-umzug-'));
  if (applianceId) fs.writeFileSync(path.join(dir, 'appliance-id'), `${applianceId}\n`);
  if (persisted) fs.writeFileSync(path.join(dir, 'license_state.json'), JSON.stringify(persisted));
  const logs = [];
  const notes = [];
  const config = { licensing: { keygenAccount: 'acct' }, userEnergyPricing: { pvPlants: [{ kwp: 30 }] } };
  const make = () => {
    const state = {};
    const svc = createLicenseService({
      state, appDir: dir, getCfg: () => config, pushLog: (type, data) => logs.push({ type, data }), accountPublicKey: PUB,
      ...(notifyDirect ? { notifyDirect: async (msg) => { notes.push(msg); return { sent: 1 }; } } : {}),
    });
    svc.loadStateFromDisk();
    return { svc, state };
  };
  const b = { dir, logs, notes, config, make, ...make() };
  b.restart = () => Object.assign(b, make());
  b.disk = () => JSON.parse(fs.readFileSync(path.join(dir, 'license_state.json'), 'utf8'));
  return b;
}

async function withServers({ scope = 'VALID', proxy }, fn) {
  const real = globalThis.fetch;
  const calls = { validate: 0, scoped: 0, proxy: [] };
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    if (String(url).includes('/licenses/actions/validate-key')) {
      if (body?.meta?.scope?.fingerprint) {
        calls.scoped += 1;
        return json(200, validateBody({ valid: scope === 'VALID', code: scope }));
      }
      calls.validate += 1;
      return json(200, validateBody());
    }
    calls.proxy.push(body);
    const [status, out] = proxy ? proxy(body) : [503, { ok: false, code: 'upstream_keygen' }];
    return json(status, out);
  };
  try { await fn(calls); } finally { globalThis.fetch = real; }
}

const okProxy = (body) => [200, { ok: true, machineFile: mintMachineFile(body.applianceId), machineId: `m-${body.applianceId}` }];
const boundA = () => ({ status: 'active', license_key: KEY, license_id: 'lic-1', machine_id: 'm-box-a', machine_file: mintMachineFile('box-a'), appliance_id: 'box-a' });
const res403 = () => ({ code: 0, body: '', writeHead(c) { this.code = c; }, end(b) { this.body = b; } });

// ─────────────────────────── a) Bindung an eine andere Box verloren ──────────

test('a) Bindung verloren: genau eine Benachrichtigung (Warnung) je Ereignis, Pro aus', async () => {
  const b = box({ persisted: boundA() });
  assert.equal(b.svc.isProActive(), true);
  await withServers({ scope: 'FINGERPRINT_SCOPE_MISMATCH', proxy: okProxy }, async (calls) => {
    await b.svc.revalidateLicense();
    await b.svc.revalidateLicense();
    await b.svc.revalidateLicense();
    assert.equal(calls.proxy.length, 0, 'nicht automatisch zurückholen');
  });
  assert.equal(b.svc.isProActive(), false);
  assert.equal(b.notes.length, 1, `einmal je Ereignis, nicht je Prüfung (${b.notes.length}×)`);
  const n = b.notes[0];
  assert.equal(n.level, 'warning');
  assert.equal(n.event, 'license_moved');
  assert.match(n.title, /Lizenz/);
  assert.match(n.body, /andere(n)? Box/);
  assert.match(n.body, /An diese Box binden/);
  // Neustart: kein zweites Mal.
  b.restart();
  await withServers({ scope: 'FINGERPRINT_SCOPE_MISMATCH', proxy: okProxy }, async () => { await b.svc.revalidateLicense(); });
  assert.equal(b.notes.length, 1, 'auch nach Neustart nicht erneut');
});

test('a) Zeitpunkt des Verlusts steht im Zustand und übersteht den Neustart', async () => {
  const b = box({ persisted: boundA() });
  const before = Date.now();
  await withServers({ scope: 'FINGERPRINT_SCOPE_MISMATCH', proxy: okProxy }, async () => { await b.svc.revalidateLicense(); });
  const s = b.svc.getState();
  assert.equal(s.binding.block, 'bound_to_other_box');
  assert.ok(Date.parse(s.binding.lost_at) >= before - 1000, JSON.stringify(s.binding));
  b.restart();
  assert.equal(b.svc.getState().binding.lost_at, s.binding.lost_at);
  assert.equal(b.svc.isProActive(), false);
});

test('a) zurückgeholt und wieder verloren: neues Ereignis, neue Benachrichtigung', async () => {
  const b = box({ persisted: boundA() });
  await withServers({ scope: 'FINGERPRINT_SCOPE_MISMATCH', proxy: okProxy }, async () => { await b.svc.revalidateLicense(); });
  assert.equal(b.notes.length, 1);
  await withServers({ proxy: okProxy }, async () => { assert.equal((await b.svc.activateNodeLock()).ok, true); });
  assert.equal(b.svc.isProActive(), true);
  assert.equal(b.svc.getState().binding.lost_at, null, 'nach dem Zurückholen kein Verlust mehr vermerkt');
  await withServers({ scope: 'FINGERPRINT_SCOPE_MISMATCH', proxy: okProxy }, async () => { await b.svc.revalidateLicense(); });
  assert.equal(b.notes.length, 2);
});

test('a) gebundene Box mit passender Maschine (Prod im Normalbetrieb): keine Meldung, kein Hinweis', async () => {
  const b = box({ persisted: boundA() });
  await withServers({ scope: 'VALID', proxy: okProxy }, async (calls) => {
    await b.svc.revalidateLicense();
    assert.equal(calls.proxy.length, 0);
  });
  assert.equal(b.notes.length, 0);
  assert.equal(b.svc.isProActive(), true);
  assert.equal(b.svc.getBindingNotice(), null);
});

test('a) Benachrichtigung scheitert: Revalidate läuft durch, Fehler im Protokoll', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lic-umzug-'));
  fs.writeFileSync(path.join(dir, 'appliance-id'), 'box-a\n');
  fs.writeFileSync(path.join(dir, 'license_state.json'), JSON.stringify(boundA()));
  const logs = [];
  const svc = createLicenseService({
    state: {}, appDir: dir, getCfg: () => ({ licensing: { keygenAccount: 'acct' } }), pushLog: (type, data) => logs.push({ type, data }), accountPublicKey: PUB,
    notifyDirect: async () => { throw new Error('worker weg'); },
  });
  svc.loadStateFromDisk();
  await withServers({ scope: 'FINGERPRINT_SCOPE_MISMATCH', proxy: okProxy }, async () => { await svc.revalidateLicense(); });
  await new Promise((r) => setImmediate(r));
  assert.equal(svc.isProActive(), false);
  assert.ok(logs.some((l) => l.type === 'license_notify_error'), JSON.stringify(logs.map((l) => l.type)));
});

test('a) ohne ctx.notifyDirect (Altaufrufer): kein Absturz, Hinweis bleibt', async () => {
  const b = box({ persisted: boundA(), notifyDirect: false });
  await withServers({ scope: 'FINGERPRINT_SCOPE_MISMATCH', proxy: okProxy }, async () => { await b.svc.revalidateLicense(); });
  assert.equal(b.svc.getBindingNotice()?.kind, 'moved');
});

test('a) getBindingNotice für den Leitstand: moved mit Zeitpunkt; ohne Krypto (3-s-Abfrage)', async () => {
  const b = box({ persisted: boundA() });
  await withServers({ scope: 'FINGERPRINT_SCOPE_MISMATCH', proxy: okProxy }, async () => { await b.svc.revalidateLicense(); });
  const n = b.svc.getBindingNotice();
  assert.equal(n.kind, 'moved');
  assert.equal(n.since, b.svc.getState().binding.lost_at);
  const src = fs.readFileSync(new URL('../services/license/index.js', import.meta.url), 'utf8');
  const fn = /function getBindingNotice\(\) \{[\s\S]*?\n {2}\}/.exec(src)?.[0] || '';
  assert.ok(fn, 'getBindingNotice gefunden');
  assert.doesNotMatch(fn, /verifyKeygen|machineBinding\(|readApplianceId/, 'nur gespeicherte Felder lesen');
});

test('a) server.js: Lizenzdienst bekommt ctx.notifyDirect (Worker-Betrieb: notify_direct), /api/status trägt licenseBinding', () => {
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const block = /const licenseService = createLicenseService\(\{[\s\S]*?\}\);/.exec(src)?.[0] || '';
  assert.match(block, /notifyDirect/, 'createLicenseService({ … notifyDirect … })');
  const payload = /function buildCurrentStatusPayload[\s\S]*?\n\}/.exec(src)?.[0] || '';
  assert.match(payload, /licenseBinding:\s*ctx\.licenseService\?\.getBindingNotice\?\.\(\)/);
});

// ─────────────────────────── b) Zustand von einer anderen Box ────────────────

test('b) kopierter Zustand mit Machine-File einer anderen Box: „übernommen“, kein Pro, keine Bindung beim Revalidate', async () => {
  const b = box({ applianceId: 'box-test', persisted: boundA() });
  assert.equal(b.svc.isProActive(), false);
  assert.equal(b.svc.getStatus(), 'active', 'Schlüssel und Status bleiben');
  assert.equal(b.svc.getState().binding.block, 'adopted_from_other_box');
  assert.equal(b.svc.getState().binding.state, 'blocked');
  await withServers({ proxy: okProxy }, async (calls) => {
    await b.svc.revalidateLicense();
    await b.svc.revalidateLicense();
    assert.equal(calls.proxy.length, 0, 'die andere Box behält ihre Lizenz (kein machine_auto_retire)');
  });
  assert.equal(b.svc.isProActive(), false);
  assert.equal(b.notes.length, 0, 'keine Verlust-Meldung — diese Box hat nichts verloren');
  const res = res403();
  b.svc.requirePro({}, res, 'eos');
  assert.equal(JSON.parse(res.body).reason, 'adopted_from_other_box');
  assert.equal(b.svc.getBindingNotice()?.kind, 'adopted');
});

test('b) übernommen bleibt übernommen — auch nach Revalidate (gespeichert) und Neustart', async () => {
  const b = box({ applianceId: 'box-test', persisted: boundA() });
  await withServers({ proxy: okProxy }, async () => { await b.svc.revalidateLicense(); });
  const disk = b.disk();
  assert.equal(disk.machine_file, null);
  assert.equal(disk.bind_block, 'adopted_from_other_box');
  b.restart();
  await withServers({ proxy: okProxy }, async (calls) => {
    await b.svc.revalidateLicense();
    assert.equal(calls.proxy.length, 0);
  });
  assert.equal(b.svc.isProActive(), false);
  assert.equal(b.svc.getState().binding.block, 'adopted_from_other_box');
});

test('b) „An diese Box binden“ (activate-node-lock) übernimmt die Lizenz: Pro an, Hinweis weg', async () => {
  const b = box({ applianceId: 'box-test', persisted: boundA() });
  await withServers({ proxy: okProxy }, async (calls) => {
    const r = await b.svc.activateNodeLock();
    assert.equal(r.ok, true);
    assert.equal(calls.proxy[0].applianceId, 'box-test');
  });
  assert.equal(b.svc.isProActive(), true);
  assert.equal(b.svc.getState().binding.state, 'bound');
  assert.equal(b.svc.getBindingNotice(), null);
  assert.equal(b.disk().appliance_id, 'box-test', 'Zustand gehört jetzt dieser Box');
  b.restart();
  assert.equal(b.svc.isProActive(), true);
});

test('b) Kopie OHNE Machine-File, aber mit Herkunft einer anderen Box: ebenso „übernommen“, keine Bindung', async () => {
  const persisted = { status: 'active', license_key: KEY, license_id: 'lic-1', machine_file: null, machine_id: null, appliance_id: 'box-a', last_check_ok_at: new Date().toISOString() };
  const b = box({ applianceId: 'box-test', persisted });
  assert.equal(b.svc.getState().binding.block, 'adopted_from_other_box');
  assert.equal(b.svc.isProActive(), false);
  await withServers({ proxy: okProxy }, async (calls) => {
    await b.svc.revalidateLicense();
    assert.equal(calls.proxy.length, 0);
  });
  assert.equal(b.svc.isProActive(), false);
});

test('b) appliance-id erst nach dem Laden da (Docker/Provisionierung): Revalidate bindet die Kopie trotzdem nicht', async () => {
  const b = box({ applianceId: null, persisted: boundA() });
  fs.writeFileSync(path.join(b.dir, 'appliance-id'), 'box-test\n');
  await withServers({ proxy: okProxy }, async (calls) => {
    await b.svc.revalidateLicense();
    assert.equal(calls.proxy.length, 0, 'fremdes File → nicht neu binden');
  });
  assert.equal(b.svc.getState().binding.block, 'adopted_from_other_box');
  assert.equal(b.svc.isProActive(), false);
});

test('b) appliance-id erst nach dem Laden da, Kopie ohne File: Herkunft bleibt erhalten, keine Bindung', async () => {
  const persisted = { status: 'active', license_key: KEY, license_id: 'lic-1', appliance_id: 'box-a', last_check_ok_at: new Date().toISOString() };
  const b = box({ applianceId: null, persisted });
  fs.writeFileSync(path.join(b.dir, 'appliance-id'), 'box-test\n');
  await withServers({ proxy: okProxy }, async (calls) => {
    await b.svc.revalidateLicense();   // speichert vor dem Abgleich — darf die Herkunft nicht überschreiben
    assert.equal(calls.proxy.length, 0);
  });
  assert.equal(b.svc.getState().binding.block, 'adopted_from_other_box');
});

test('b) frisch eingegebener Schlüssel auf der Kopie bindet automatisch (T-LICENSE-AUTOBIND bleibt)', async () => {
  const b = box({ applianceId: 'box-test', persisted: boundA() });
  await withServers({ proxy: okProxy }, async (calls) => {
    const r = await b.svc.activateLicense(KEY);
    assert.equal(r.status, 'active');
    assert.equal(r.nodeLock?.ok, true, JSON.stringify(r));
    assert.equal(calls.proxy.length, 1);
  });
  assert.equal(b.svc.isProActive(), true);
  assert.equal(b.svc.getBindingNotice(), null);
});

test('b) frisch eingegebener Schlüssel, Bindung scheitert am Netz: Box gilt als eigene (Pro wie heute), nächste Prüfung bindet', async () => {
  const b = box({ applianceId: 'box-test', persisted: boundA() });
  await withServers({ proxy: () => [503, { ok: false, code: 'upstream_keygen' }] }, async () => {
    const r = await b.svc.activateLicense(KEY);
    assert.equal(r.nodeLock?.ok, false);
  });
  assert.equal(b.svc.getState().binding.block, null, 'ausdrücklich hier eingegeben → nicht „übernommen“');
  assert.equal(b.disk().appliance_id, 'box-test');
  await withServers({ proxy: okProxy }, async (calls) => {
    await b.svc.revalidateLicense();
    assert.equal(calls.proxy.length, 1, 'eigener Zustand ohne File → automatisch binden');
  });
  assert.equal(b.svc.isProActive(), true);
});

test('b) neuer Schlüssel ohne Machine-File auf frischer Box bindet automatisch (wie heute)', async () => {
  const b = box({ applianceId: 'box-new' });
  await withServers({ proxy: okProxy }, async (calls) => {
    const r = await b.svc.activateLicense(KEY);
    assert.equal(r.nodeLock?.ok, true);
    assert.equal(calls.proxy.length, 1);
  });
  assert.equal(b.svc.isProActive(), true);
  assert.equal(b.disk().appliance_id, 'box-new');
});

test('b) eigener Zustand ohne File (Bindung scheiterte früher): Revalidate bindet weiter automatisch', async () => {
  const persisted = { status: 'active', license_key: KEY, license_id: 'lic-1', appliance_id: 'box-a', last_check_ok_at: new Date().toISOString() };
  const b = box({ applianceId: 'box-a', persisted });
  await withServers({ proxy: okProxy }, async (calls) => {
    await b.svc.revalidateLicense();
    assert.equal(calls.proxy.length, 1);
  });
  assert.equal(b.svc.isProActive(), true);
});

test('b) Bestandszustand von 1.0.9 (ohne Herkunft): Kunde merkt nichts — gebunden bleibt gebunden, ohne File wird gebunden', async () => {
  const withFile = box({ persisted: { status: 'active', license_key: KEY, license_id: 'lic-1', machine_id: 'm-box-a', machine_file: mintMachineFile('box-a') } });
  assert.equal(withFile.svc.isProActive(), true);
  await withServers({ scope: 'VALID', proxy: okProxy }, async (calls) => {
    await withFile.svc.revalidateLicense();
    assert.equal(calls.proxy.length, 0);
  });
  assert.equal(withFile.svc.isProActive(), true);
  assert.equal(withFile.disk().appliance_id, 'box-a', 'beim ersten Speichern als eigene Box vermerkt');
  const noFile = box({ persisted: { status: 'active', license_key: KEY, license_id: 'lic-1', last_check_ok_at: new Date().toISOString() } });
  assert.equal(noFile.svc.isProActive(), true);
  await withServers({ proxy: okProxy }, async (calls) => {
    await noFile.svc.revalidateLicense();
    assert.equal(calls.proxy.length, 1, 'ohne Herkunft nicht unterscheidbar → wie bisher binden');
  });
  assert.equal(noFile.svc.isProActive(), true);
});

test('b) Geräte-Tausch (appliance-id wandert mit): eigener Zustand, nichts ändert sich', async () => {
  const b = box({ applianceId: 'box-a', persisted: boundA() });
  assert.equal(b.svc.isProActive(), true);
  assert.equal(b.svc.getBindingNotice(), null);
});

test('b) Herkunft ist keine Sperre für ein gültiges, an DIESE Box gebundenes File', async () => {
  const p = { ...boundA(), machine_file: mintMachineFile('box-b'), appliance_id: 'box-a' };
  const b = box({ applianceId: 'box-b', persisted: p });
  assert.equal(b.svc.isProActive(), true, 'das signierte File zählt');
  await withServers({ scope: 'VALID', proxy: okProxy }, async () => { await b.svc.revalidateLicense(); });
  assert.equal(b.disk().appliance_id, 'box-b');
});

// ─────────────────────────── Oberfläche ──────────────────────────────────────

function loadPublic(file, extra = {}) {
  const src = fs.readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
  const sandbox = { console, window: {}, document: undefined, ...extra };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.runInNewContext(src, sandbox, { filename: file });
  return { src, sandbox };
}

test('Leitstand: Hinweis „Deine Lizenz ist jetzt auf einer anderen Box …“ bzw. „übernommen – an diese Box binden?“', () => {
  const { sandbox } = loadPublic('license-banner.js');
  const { licenseBannerText } = sandbox.DVhubLicenseBanner;
  assert.match(licenseBannerText({ kind: 'moved', since: '2026-11-05T07:19:00Z' }), /^Deine Lizenz ist jetzt auf einer anderen Box/);
  assert.match(licenseBannerText({ kind: 'moved' }), /An diese Box binden/);
  assert.match(licenseBannerText({ kind: 'adopted' }), /^Lizenz von anderer Box übernommen – an diese Box binden\?/);
  assert.match(licenseBannerText({ kind: 'slot_taken' }), /andere(n)? Box/);
  assert.equal(licenseBannerText(null), null);
  assert.equal(licenseBannerText({ kind: 'unbekannt' }), null);
});

test('Leitstand: index.html lädt license-banner.js, app.js zeigt status.licenseBinding', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<script src="\/license-banner\.js\?v=\d{8}-[a-z0-9-]+"><\/script>/);
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /DVhubLicenseBanner[\s\S]{0,80}render\(status\.licenseBinding\)/);
});

test('Einstellungen: Text für den übernommenen Zustand, Binden-Knopf sichtbar', () => {
  const src = fs.readFileSync(new URL('../public/settings.js', import.meta.url), 'utf8');
  const sandbox = { console, window: { DVhubCommon: { escapeHtml: (v) => String(v ?? '') }, addEventListener() {}, setTimeout() {} } };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(src, sandbox, { filename: 'settings.js' });
  const { licenseBindingMessage } = sandbox.DVhubSettingsLicense;
  const adopted = licenseBindingMessage({ status: 'active', binding: { state: 'blocked', block: 'adopted_from_other_box' } });
  assert.match(adopted, /^Lizenz von anderer Box übernommen – an diese Box binden\?/);
  const moved = licenseBindingMessage({ status: 'active', binding: { state: 'blocked', block: 'bound_to_other_box' } });
  assert.match(moved, /^Deine Lizenz ist jetzt auf einer anderen Box/);
});

// ─────────────────────────── Codex 59b67ea2 ──────────────────────────────────

test('Codex 59b67ea2 P2: frischer Schlüssel verwirft ein fremdes File (appliance-id kam erst nach dem Laden) — Netzfehler sperrt danach nicht', async () => {
  const b = box({ applianceId: null, persisted: boundA() });
  fs.writeFileSync(path.join(b.dir, 'appliance-id'), 'box-test\n');
  await withServers({ proxy: () => [503, { ok: false, code: 'upstream_keygen' }] }, async () => {
    const r = await b.svc.activateLicense(KEY);
    assert.equal(r.nodeLock?.ok, false);
  });
  assert.equal(b.state.license.machine_file, null, 'fremdes File beim ausdrücklichen Übernehmen verworfen');
  await withServers({ proxy: okProxy }, async (calls) => {
    await b.svc.revalidateLicense();
    assert.equal(calls.proxy.length, 1, 'nächste Prüfung bindet, statt „übernommen“ zu sperren');
  });
  assert.equal(b.svc.getState().binding.block, null);
  assert.equal(b.svc.isProActive(), true);
});

test('Codex 59b67ea2 P3: zwei gleichzeitige Prüfungen melden einen Umzug nur einmal', async () => {
  const b = box({ persisted: boundA() });
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    if (String(url).includes('validate-key')) {
      if (body?.meta?.scope?.fingerprint) {
        await new Promise((r) => setTimeout(r, 20));
        return json(200, validateBody({ valid: false, code: 'FINGERPRINT_SCOPE_MISMATCH' }));
      }
      return json(200, validateBody());
    }
    return json(503, { ok: false });
  };
  try {
    await Promise.all([b.svc.revalidateLicense(), b.svc.revalidateLicense()]);
  } finally { globalThis.fetch = real; }
  await new Promise((r) => setImmediate(r));
  assert.equal(b.notes.length, 1, `eine Meldung je Umzug (${b.notes.length}×)`);
  assert.equal(b.svc.getState().binding.block, 'bound_to_other_box');
});
