// test/license-sicherheit.test.js — Strix-Funde Lizenz (verifiziert 30.10.2026,
// ~/Projects/strix-runs/lizenz-main_e381/VERIFIKATION.md).
//
//   L-0001  Unsignierte Schlüssel gelten offline unbegrenzt (Signatur nur bei key/…)
//   L-0002  kWp-Deckel fällt auf „unbegrenzt“, wenn das Machine-File fehlt oder
//           die Bindung scheitert — auch ohne root
//   L-0005  Node-Lock ab Werk aus; zweite Box mit gleichem Schlüssel hat Pro;
//           Box A behält Pro, obwohl ihre Maschine längst bei Box B ist
//   L-0006  Lizenzschlüssel an eine über die Config umbiegbare Proxy-Adresse
//
// Randbedingung (Christin, T-0125 „A“): bestehende Lizenzen ohne Bindung
// bleiben gültig; kein ehrlicher Kunde verliert Pro. Keine echte Keygen-API —
// fetch ist gestubbt, Schlüssel und Machine-Files mit eigenem Ed25519-Paar.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { createLicenseService } from '../services/license/index.js';

const DAY = 24 * 60 * 60 * 1000;
const PROXY = 'https://webhook.dvhub.de/v1/license/activate-machine';
const KP = crypto.generateKeyPairSync('ed25519');
const PUB = KP.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');

function mintKey(payload = { license: { id: 'lic-1' }, policy: { id: 'pol-pro' } }) {
  const sd = `key/${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  return `${sd}.${crypto.sign(null, Buffer.from(sd), KP.privateKey).toString('base64')}`;
}
const KEY = mintKey();

function mintMachineFile(fingerprint, { licenseId = 'lic-1', maxKwp = null, expiry = null } = {}) {
  const license = { type: 'licenses', id: licenseId };
  if (maxKwp != null) license.attributes = { metadata: { maxKwp } };
  const dataset = { data: { type: 'machines', id: 'm1', attributes: { fingerprint, expiry } }, included: [license], meta: { expiry } };
  const enc = Buffer.from(JSON.stringify(dataset)).toString('base64');
  const sig = crypto.sign(null, Buffer.from(`machine/${enc}`), KP.privateKey).toString('base64');
  return `-----BEGIN MACHINE FILE-----\n${Buffer.from(JSON.stringify({ enc, sig, alg: 'base64+ed25519' })).toString('base64')}\n-----END MACHINE FILE-----\n`;
}

function box({ applianceId = 'box-a', kwp = 30, persisted = null, cfg = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lic-sec-'));
  if (applianceId) fs.writeFileSync(path.join(dir, 'appliance-id'), `${applianceId}\n`);
  if (persisted) fs.writeFileSync(path.join(dir, 'license_state.json'), JSON.stringify(persisted));
  const logs = [];
  const config = { licensing: { keygenAccount: 'acct' }, userEnergyPricing: { pvPlants: [{ kwp }] }, ...cfg };
  const make = () => {
    const state = {};
    const svc = createLicenseService({ state, appDir: dir, getCfg: () => config, pushLog: (type, data) => logs.push({ type, data }), accountPublicKey: PUB });
    svc.loadStateFromDisk();
    return { svc, state };
  };
  return { dir, logs, config, make, ...make() };
}

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function validateBody({ valid = true, code = 'VALID', maxKwp = null, id = 'lic-1' } = {}) {
  return {
    meta: { valid, code, ts: new Date().toISOString() },
    data: { id, type: 'licenses', attributes: { status: 'ACTIVE', expiry: null, metadata: maxKwp == null ? {} : { maxKwp } } },
  };
}

/**
 * Gestubbte Gegenstellen: Keygen validate-key (mit/ohne scope.fingerprint) und
 * der Aktivierungs-Proxy. `proxy(body)` liefert [status, json].
 */
async function withServers({ maxKwp = null, scope = 'VALID', proxy }, fn) {
  const real = globalThis.fetch;
  const calls = { validate: 0, scoped: 0, proxy: [], urls: [] };
  globalThis.fetch = async (url, init = {}) => {
    calls.urls.push({ url: String(url), redirect: init.redirect });
    const body = init.body ? JSON.parse(init.body) : null;
    if (String(url).includes('/licenses/actions/validate-key')) {
      if (body?.meta?.scope?.fingerprint) {
        calls.scoped += 1;
        if (scope instanceof Error) throw scope;
        return json(200, validateBody({ valid: scope === 'VALID', code: scope, maxKwp }));
      }
      calls.validate += 1;
      return json(200, validateBody({ maxKwp }));
    }
    calls.proxy.push({ url: String(url), body });
    const [status, out] = proxy ? proxy(body) : [503, { ok: false, code: 'upstream_keygen' }];
    return json(status, out);
  };
  try { await fn(calls); } finally { globalThis.fetch = real; }
}

const okProxy = (maxKwp = null) => (body) => [200, { ok: true, machineFile: mintMachineFile(body.applianceId, { maxKwp }), machineId: `m-${body.applianceId}` }];
const slotTaken = () => [409, { ok: false, code: 'machine_slot_taken', boundFingerprint: 'box-a', boundSince: new Date(Date.now() - 3600_000).toISOString() }];
const res403 = () => ({ code: 0, body: '', writeHead(c) { this.code = c; }, end(b) { this.body = b; } });

// ---------------------------------------------------------------- L-0001

test('L-0001: erfundener unsignierter Schlüssel ohne Online-Prüfung schaltet Pro nicht frei', () => {
  const b = box({ persisted: { status: 'active', license_key: 'DVHB-0000-0000-0000-0000', license_id: 'lic-x' } });
  assert.equal(b.svc.isProActive(), false, 'ohne erfolgreiche Online-Prüfung kein Pro');
  const res = res403();
  assert.equal(b.svc.requirePro({}, res, 'eos'), false);
  assert.equal(JSON.parse(res.body).reason, 'license_unverified_offline');
  assert.equal(b.svc.getState().effective_status, 'unverified_offline');
});

test('L-0001: unsignierter Schlüssel gilt 14 Tage nach der letzten Online-Prüfung weiter (Offline-Kulanz)', () => {
  const recent = box({ persisted: { status: 'active', license_key: 'DVHB-LEGACY-AAAA', license_id: 'lic-x', last_check_ok_at: new Date(Date.now() - 3 * DAY).toISOString() } });
  assert.equal(recent.svc.isProActive(), true, 'Bestandskunde offline seit 3 Tagen behält Pro');
  const stale = box({ persisted: { status: 'active', license_key: 'DVHB-LEGACY-AAAA', license_id: 'lic-x', last_check_ok_at: new Date(Date.now() - 15 * DAY).toISOString() } });
  assert.equal(stale.svc.isProActive(), false, 'nach 14 Tagen ohne Online-Prüfung ist Schluss');
  assert.equal(stale.svc.getStatus(), 'active', 'Schlüssel und Status bleiben — die nächste Online-Prüfung schaltet wieder frei');
});

test('L-0001: in die Zukunft gestellte letzte Prüfung zählt nicht', () => {
  const b = box({ persisted: { status: 'active', license_key: 'DVHB-LEGACY-AAAA', license_id: 'lic-x', last_check_ok_at: new Date(Date.now() + 365 * DAY).toISOString() } });
  assert.equal(b.svc.isProActive(), false);
});

test('L-0001: signierter Schlüssel braucht keine Online-Prüfung (offline unverändert)', () => {
  const b = box({ persisted: { status: 'active', license_key: KEY, license_id: 'lic-1' } });
  assert.equal(b.svc.isProActive(), true);
});

test('L-0001: erfolgreiche Online-Prüfung schaltet einen veralteten unsignierten Schlüssel wieder frei (live)', async () => {
  const b = box({ persisted: { status: 'active', license_key: 'DVHB-LEGACY-AAAA', license_id: 'lic-1', last_check_ok_at: new Date(Date.now() - 20 * DAY).toISOString() } });
  const seen = [];
  b.svc.onProActiveChange((v) => seen.push(v));
  assert.equal(b.svc.isProActive(), false);
  await withServers({ proxy: okProxy() }, async () => { await b.svc.revalidateLicense(); });
  assert.equal(b.svc.isProActive(), true);
  assert.deepEqual(seen, [true], 'DV-Schnittstelle und EOS starten ohne Neustart');
});

// ---------------------------------------------------------------- L-0002

test('L-0002: Deckel kommt auch aus validate-key — scheitert die Bindung, bleibt er trotzdem', async () => {
  const b = box({ kwp: 95 });
  await withServers({ maxKwp: 40, proxy: () => [503, { ok: false, code: 'upstream_keygen' }] }, async () => {
    const r = await b.svc.activateLicense(KEY);
    assert.equal(r.status, 'active');
    assert.equal(r.nodeLock.ok, false);
  });
  assert.equal(b.state.license.max_kwp, 40, 'nicht still unbegrenzt');
  assert.equal(b.svc.isProActive(), false, '95 kWp passen nicht in Pro S');
  assert.equal(b.svc.getState().binding.state, 'unbound');
  assert.equal(b.svc.getState().binding.error, 'upstream_keygen', 'Hinweis für die Oberfläche');
});

test('L-0002: Machine-File gelöscht, machine_id bleibt → Revalidate bindet neu, Deckel bleibt', async () => {
  const b = box({ kwp: 95, persisted: { status: 'active', license_key: KEY, license_id: 'lic-1', machine_id: 'm-box-a', machine_file: null } });
  await withServers({ maxKwp: 40, proxy: okProxy(40) }, async (calls) => {
    await b.svc.revalidateLicense();
    assert.equal(calls.proxy.length, 1, 'fehlendes File → neu binden, auch wenn machine_id noch da ist');
  });
  assert.equal(b.state.license.max_kwp, 40);
  assert.equal(b.svc.isProActive(), false);
  assert.equal(b.svc.getState().binding.state, 'bound');
});

test('L-0002: Müll statt Machine-File → File verworfen, Neu-Binden beim nächsten Revalidate', async () => {
  const b = box({ kwp: 95, persisted: { status: 'active', license_key: KEY, license_id: 'lic-1', machine_id: 'm-box-a', machine_file: '-----BEGIN MACHINE FILE-----\nbXVlbGw=\n-----END MACHINE FILE-----' } });
  await withServers({ maxKwp: 40, proxy: okProxy(40) }, async (calls) => {
    await b.svc.revalidateLicense();
    assert.equal(calls.proxy.length, 1);
  });
  assert.equal(b.state.license.max_kwp, 40);
});

test('L-0002: Neu-Binden wird bei jedem Revalidate versucht, nicht nur einmal pro Prozesslauf', async () => {
  const b = box({ persisted: { status: 'active', license_key: KEY, license_id: 'lic-1', last_check_ok_at: new Date().toISOString() } });
  await withServers({ proxy: () => [503, { ok: false, code: 'upstream_keygen' }] }, async (calls) => {
    await b.svc.revalidateLicense();
    await b.svc.revalidateLicense();
    assert.equal(calls.proxy.length, 2);
  });
  assert.equal(b.svc.isProActive(), true, 'Bestandslizenz ohne Bindung bleibt gültig (T-0125 A)');
});

test('L-0002: es gilt die kleinere Grenze aus Machine-File und Online-Antwort', async () => {
  const b = box({ kwp: 60, persisted: { status: 'active', license_key: KEY, license_id: 'lic-1', machine_id: 'm-box-a', machine_file: mintMachineFile('box-a', { maxKwp: 70 }) } });
  assert.equal(b.state.license.max_kwp, 70);
  await withServers({ maxKwp: 40, proxy: okProxy(40) }, async () => { await b.svc.revalidateLicense(); });
  assert.equal(b.state.license.max_kwp, 40);
});

test('L-0002: Tarif-Wechsel (online größer als im File) holt ein frisches Machine-File', async () => {
  const b = box({ kwp: 60, persisted: { status: 'active', license_key: KEY, license_id: 'lic-1', machine_id: 'm-box-a', machine_file: mintMachineFile('box-a', { maxKwp: 40 }) } });
  assert.equal(b.svc.isProActive(), false);
  await withServers({ maxKwp: 70, proxy: okProxy(70) }, async (calls) => {
    await b.svc.revalidateLicense();
    assert.equal(calls.proxy.length, 1, 'gleiche Maschine, idempotent neu ausgecheckt');
  });
  assert.equal(b.state.license.max_kwp, 70);
  assert.equal(b.svc.isProActive(), true);
});

test('L-0002: Altlizenz ohne maxKwp bleibt unbegrenzt (Bestandsschutz)', async () => {
  const b = box({ kwp: 200 });
  await withServers({ maxKwp: null, proxy: okProxy(null) }, async () => { await b.svc.activateLicense(KEY); });
  assert.equal(b.state.license.max_kwp, null);
  assert.equal(b.svc.isProActive(), true);
});

// ---------------------------------------------------------------- L-0005

test('L-0005: zweite Box mit gleichem Schlüssel (Slot belegt) bekommt kein Pro — auch nach Neustart', async () => {
  const b = box({ applianceId: 'box-b' });
  await withServers({ proxy: slotTaken }, async () => {
    const r = await b.svc.activateLicense(KEY);
    assert.equal(r.status, 'active');
    assert.equal(r.nodeLock.error, 'machine_slot_taken');
  });
  assert.equal(b.svc.isProActive(), false);
  const res = res403();
  b.svc.requirePro({}, res, 'eos');
  assert.equal(JSON.parse(res.body).reason, 'machine_slot_taken');
  const again = b.make();
  assert.equal(again.svc.isProActive(), false, 'Sperre übersteht den Neustart');
  assert.equal(again.svc.getState().binding.state, 'blocked');
});

test('L-0005: nach „Slot belegt“ kein automatisches Übernehmen; „An diese Box binden“ gibt Pro zurück', async () => {
  const b = box({ applianceId: 'box-b' });
  await withServers({ proxy: slotTaken }, async (calls) => {
    await b.svc.activateLicense(KEY);
    await b.svc.revalidateLicense();
    assert.equal(calls.proxy.length, 1, 'Revalidate nimmt der anderen Box die Lizenz nicht still weg');
  });
  await withServers({ proxy: okProxy() }, async () => {
    const r = await b.svc.activateNodeLock();
    assert.equal(r.ok, true);
  });
  assert.equal(b.svc.isProActive(), true);
  assert.equal(b.svc.getState().binding.state, 'bound');
});

test('L-0005: kopierter Zustand mit Machine-File einer anderen Box → kein Pro, Schlüssel bleibt erhalten', () => {
  const b = box({ applianceId: 'box-b', persisted: { status: 'active', license_key: KEY, license_id: 'lic-1', machine_id: 'm-box-a', machine_file: mintMachineFile('box-a') } });
  assert.equal(b.svc.isProActive(), false);
  assert.equal(b.svc.getStatus(), 'active');
  assert.ok(b.state.license.license_key, 'Kunde muss den Schlüssel nicht neu eingeben');
  assert.equal(b.svc.getState().binding.block, 'bound_to_other_box');
});

test('L-0005: Box A merkt online, dass ihre Maschine an eine andere Box ging (scope.fingerprint)', async () => {
  const b = box({ persisted: { status: 'active', license_key: KEY, license_id: 'lic-1', machine_id: 'm-box-a', machine_file: mintMachineFile('box-a') } });
  assert.equal(b.svc.isProActive(), true);
  await withServers({ scope: 'FINGERPRINT_SCOPE_MISMATCH', proxy: okProxy() }, async (calls) => {
    await b.svc.revalidateLicense();
    assert.equal(calls.scoped, 1);
    assert.equal(calls.proxy.length, 0, 'nicht automatisch zurückholen (kein Hin und Her)');
  });
  assert.equal(b.svc.isProActive(), false);
  assert.equal(b.svc.getState().binding.block, 'bound_to_other_box');
});

test('L-0005: gebundene Box mit passender Maschine → Pro bleibt, kein Proxy-Aufruf', async () => {
  const b = box({ persisted: { status: 'active', license_key: KEY, license_id: 'lic-1', machine_id: 'm-box-a', machine_file: mintMachineFile('box-a') } });
  await withServers({ scope: 'VALID', proxy: okProxy() }, async (calls) => {
    await b.svc.revalidateLicense();
    assert.equal(calls.scoped, 1);
    assert.equal(calls.proxy.length, 0);
  });
  assert.equal(b.svc.isProActive(), true);
});

test('L-0005: Maschine in Keygen gelöscht (NO_MACHINE) → automatisch neu binden', async () => {
  const b = box({ persisted: { status: 'active', license_key: KEY, license_id: 'lic-1', machine_id: 'm-box-a', machine_file: mintMachineFile('box-a') } });
  await withServers({ scope: 'NO_MACHINE', proxy: okProxy() }, async (calls) => {
    await b.svc.revalidateLicense();
    assert.equal(calls.proxy.length, 1);
  });
  assert.equal(b.svc.isProActive(), true);
});

test('L-0005: Scope-Prüfung nicht erreichbar → nichts ändert sich', async () => {
  const b = box({ persisted: { status: 'active', license_key: KEY, license_id: 'lic-1', machine_id: 'm-box-a', machine_file: mintMachineFile('box-a') } });
  await withServers({ scope: new TypeError('fetch failed'), proxy: okProxy() }, async (calls) => {
    await b.svc.revalidateLicense();
    assert.equal(calls.proxy.length, 0);
  });
  assert.equal(b.svc.isProActive(), true);
  assert.equal(b.svc.getState().binding.state, 'bound');
});

test('L-0005: Bestandslizenz ohne Bindung, Bindung scheitert am Netz → Pro bleibt (T-0125 A)', async () => {
  const b = box({ persisted: { status: 'active', license_key: KEY, license_id: 'lic-1', last_check_ok_at: new Date().toISOString() } });
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('validate-key')) return json(200, validateBody());
    throw new TypeError('fetch failed');
  };
  try { await b.svc.revalidateLicense(); } finally { globalThis.fetch = real; }
  assert.equal(b.svc.isProActive(), true);
});

// ---------------------------------------------------------------- L-0006

test('L-0006: Proxy-Adresse aus der Config wird nicht verwendet — Schlüssel geht nur an webhook.dvhub.de', async () => {
  const b = box({ cfg: { licensing: { keygenAccount: 'acct', activationProxyUrl: 'https://evil.example.net/steal' } } });
  b.state.license.status = 'active';
  b.state.license.license_key = KEY;
  await withServers({ proxy: okProxy() }, async (calls) => {
    await b.svc.activateNodeLock();
    assert.equal(calls.proxy.length, 1);
    assert.equal(calls.proxy[0].url, PROXY);
    const proxyCall = calls.urls.find((c) => c.url === PROXY);
    assert.equal(proxyCall.redirect, 'error', 'keine Weiterleitung des Schlüssels an einen anderen Host');
    assert.ok(!calls.urls.some((c) => c.url.includes('evil.example.net')));
  });
});

test('L-0005: Aktivierung mit belegtem Slot startet DV/EOS nicht kurz an und wieder aus', async () => {
  const b = box({ applianceId: 'box-b' });
  const seen = [];
  b.svc.onProActiveChange((v) => seen.push(v));
  await withServers({ proxy: slotTaken }, async () => { await b.svc.activateLicense(KEY); });
  assert.deepEqual(seen, [], 'kein Wechsel: vorher ohne Pro, nachher ohne Pro');
  await withServers({ proxy: okProxy() }, async () => { await b.svc.activateNodeLock(); });
  assert.deepEqual(seen, [true], 'Binden schaltet live frei');
});
