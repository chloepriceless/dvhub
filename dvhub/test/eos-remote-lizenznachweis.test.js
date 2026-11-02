// test/eos-remote-lizenznachweis.test.js — Strix L-0006 (Geschwister-Weg):
// Im Fernbetrieb schickt DVhub Lizenzschlüssel und Machine-File an den
// Rechendienst. Die Adresse ist eine normale Einstellung — ohne Prüfung ginge
// der Nachweis an jeden https-Host, den jemand per /api/config einträgt.
// Jetzt: nur https, kein internes Ziel, nur Hosts unter dvhub.de (oder per
// Umgebungsvariable auf der Box freigegeben), keine Weiterleitung.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createEosRemoteFacade, isTrustedProofEndpoint } from '../services/optimizer/eos-remote.js';
import { setEosRemoteFacadeUrl } from '../services/optimizer/eos-adapter.js';

const closers = [];
afterEach(async () => {
  while (closers.length) await closers.pop()();
  setEosRemoteFacadeUrl(null);
});

const PROOF = { licenseKey: 'key/abc.sig', machineFile: '-----BEGIN MACHINE FILE-----\nx\n-----END MACHINE FILE-----' };

async function runWith(endpoint) {
  const sent = [];
  const cfg = { timeZone: 'Europe/Berlin', optimizer: { eosProxy: { enabled: true, mode: 'remote', url: 'http://127.0.0.1:8503', remote: { endpoint, token: '', jobTimeoutMs: 10_000 } } } };
  const state = { optimizer: {} };
  const facade = createEosRemoteFacade({
    getCfg: () => cfg,
    getLicenceProof: () => PROOF,
    saveToken: async () => {},
    state,
    fetchImpl: async (url, init = {}) => {
      sent.push({ url: String(url), redirect: init.redirect });
      return { status: 503, headers: { get: () => null }, json: async () => ({ error: { code: 'down' } }) };
    },
  });
  const url = await facade.start();
  closers.push(() => facade.stop());
  const r = await fetch(`${url}/v1/optimize`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  await r.text();
  return { sent, state };
}

describe('EOS-Fernbetrieb: Lizenznachweis nur an vertrauenswürdige Dienst-Adressen', () => {
  for (const bad of [
    'https://evil.example.net',
    'http://eos.dvhub.de',
    'https://192.168.1.20',
    'https://[::1]:8443',
    'https://127.0.0.1',
    'https://eos.dvhub.de.evil.example.net',
    'https://evildvhub.de',
    'https://user:pw@eos.dvhub.de',
  ]) {
    it(`kein Nachweis an ${bad}`, async () => {
      assert.equal(isTrustedProofEndpoint(bad, []), false);
      const { sent, state } = await runWith(bad);
      assert.equal(sent.length, 0, 'kein einziger Aufruf mit Lizenz');
      assert.equal(state.optimizer.eosRemote?.lastError?.code, 'endpoint_not_trusted');
    });
  }

  it('Dienst unter dvhub.de bekommt den Nachweis, ohne Weiterleitung', async () => {
    assert.equal(isTrustedProofEndpoint('https://eos.dvhub.de', []), true);
    const { sent } = await runWith('https://eos.dvhub.de');
    assert.ok(sent.length >= 1);
    assert.ok(sent.every((s) => s.url.startsWith('https://eos.dvhub.de/')));
    assert.ok(sent.every((s) => s.redirect === 'error'));
  });

  it('weitere Hosts nur über die Umgebung der Box (nicht über die Config)', () => {
    assert.equal(isTrustedProofEndpoint('https://eos-test.example.org', ['eos-test.example.org']), true);
    assert.equal(isTrustedProofEndpoint('https://192.168.1.20', ['192.168.1.20']), false, 'intern bleibt verboten');
  });
});

// Gegenprüfung zu 23c3962c (P2): auch der Diagnose-Abruf trägt das Token der
// Box — er darf ebenfalls nur an eine vertrauenswürdige Adresse gehen.
describe('EOS-Fernbetrieb: kein Aufruf mit Token an nicht vertrauenswürdige Adressen', () => {
  it('Diagnose-Abruf an fremde Adresse schickt nichts', async () => {
    const sent = [];
    const cfg = { optimizer: { eosProxy: { enabled: true, mode: 'remote', remote: { endpoint: 'https://evil.example.net', token: 'dves_echt', tokenEndpoint: '' } } } };
    const state = { optimizer: { eosRemote: { lastJobId: 'job_1' } } };
    const facade = createEosRemoteFacade({
      getCfg: () => cfg, getLicenceProof: () => PROOF, saveToken: async () => {}, state,
      fetchImpl: async (url, init = {}) => { sent.push({ url: String(url), auth: init.headers?.Authorization }); return { status: 200, headers: { get: () => null }, json: async () => ({}) }; },
    });
    await assert.rejects(() => facade.fetchDebugBundle('job_1'));
    assert.equal(sent.length, 0);
  });
});

describe('EOS-Fernbetrieb: Token des Diagnose-Abrufs nur an seine eigene Adresse', () => {
  it('tokenEndpoint a.dvhub.de, endpoint b.dvhub.de → null, kein Aufruf', async () => {
    const sent = [];
    const cfg = { optimizer: { eosProxy: { enabled: true, mode: 'remote', remote: { endpoint: 'https://b.dvhub.de', token: 'dves_echt', tokenEndpoint: 'https://a.dvhub.de' } } } };
    const facade = createEosRemoteFacade({
      getCfg: () => cfg, getLicenceProof: () => PROOF, saveToken: async () => {}, state: { optimizer: { eosRemote: { lastJobId: 'job_1' } } },
      fetchImpl: async (url) => { sent.push(String(url)); return { status: 200, headers: { get: () => null }, json: async () => ({ bundle: {} }) }; },
    });
    assert.equal(await facade.fetchDebugBundle(), null);
    assert.equal(sent.length, 0);
  });
});
