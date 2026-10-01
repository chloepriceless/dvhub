// test/eos-capabilities.test.js -- antwortet ein EOS 0.4?
//
// DVhub unterstützt nur noch EOS 0.4 (Upstream ab #1330, DV-EOS-Tag
// dvhub-v0.4.0rc1.x). Ältere Fassungen werden noch erkannt, aber als
// `supported: false` gemeldet — der Abgleich schreibt dann nichts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  EOS_FLAVOR,
  EOS_UNSUPPORTED_REASON,
  detectEosCapabilities,
  createEosCapabilityProbe,
} from '../services/optimizer/eos-capabilities.js';

// Ältere Fassungen, nur noch zur Erkennung.
const dvForkConfig = {
  optimization: { interval: 900, hours: 48, genetic: { individuals: 300, generations: 400 } },
  feedintariff: { provider: 'FeedInTariffImport' },
  devices: { batteries: [], inverters: [], max_home_appliances: 0 },
};
const upstreamDmConfig = {
  optimization: { interval: 3600, hours: 48, genetic: { individuals: 300, generations: 400 } },
  feedintariff: { provider: null, direct_marketing_enabled: false },
  devices: { batteries: null, inverters: null, max_home_appliances: null, home_appliances: null },
};
const upstreamMainConfig = {
  optimization: { hours: 48, genetic: { individuals: 300, generations: 400, interval_sec: 3600 } },
  feedintariff: { provider: null },
  devices: { batteries: null, inverters: null },
};

// Nachgebildet aus GET /v1/config einer echten v0.4.0rc1-Instanz
// (ARM64-Testbox, 21.09.2026).
const eos04Config = {
  optimization: {
    algorithm: 'GENETIC',
    algorithms: ['GENETIC', 'GENETIC0'],
    genetic: { individuals: 300, generations: 400, interval_sec: 3600, horizon_hours: 48 },
    genetic0: {},
    keys: [],
  },
  feedintariff: { provider: null, direct_marketing_enabled: true },
  devices: {
    batteries: { battery1: { device_id: 'battery1' } },
    inverters: { inverter1: { device_id: 'inverter1' } },
    electric_vehicles: {},
    home_appliances: {},
    max_home_appliances: 0,
  },
  elecprice: { provider: 'ElecPriceImport', providers: [] },
};

describe('detectEosCapabilities', () => {
  it('EOS 0.4 → supported', () => {
    const c = detectEosCapabilities(eos04Config, { version: '0.4.0rc1' });
    assert.equal(c.flavor, EOS_FLAVOR.UPSTREAM_GENETIC);
    assert.equal(c.reachable, true);
    assert.equal(c.supported, true);
    assert.equal(c.reason, null);
    assert.equal(c.version, '0.4.0rc1');
  });

  it('eine leere Geräte-Abbildung bleibt als 0.4 erkennbar', () => {
    const c = detectEosCapabilities({
      ...eos04Config,
      devices: { batteries: {}, inverters: {}, electric_vehicles: {}, home_appliances: {} },
    }, {});
    assert.equal(c.flavor, EOS_FLAVOR.UPSTREAM_GENETIC);
    assert.equal(c.supported, true);
  });

  for (const [name, cfg, flavor] of [
    ['unser 0.3-Fork', dvForkConfig, EOS_FLAVOR.DV_FORK],
    ['Maintainer-Branch', upstreamDmConfig, EOS_FLAVOR.UPSTREAM_DM],
    ['Upstream-main vor #1330', upstreamMainConfig, EOS_FLAVOR.UPSTREAM_MAIN],
  ]) {
    it(`${name} → erreichbar, aber nicht unterstützt`, () => {
      const c = detectEosCapabilities(cfg, { version: '0.3.0' });
      assert.equal(c.flavor, flavor);
      assert.equal(c.reachable, true);
      assert.equal(c.supported, false);
      assert.equal(c.reason, EOS_UNSUPPORTED_REASON);
      assert.match(c.reason, /EOS 0\.4/);
    });
  }

  it('genetic-Intervall mit Direktvermarktung, aber Geräte als Liste → nicht unterstützt', () => {
    const c = detectEosCapabilities({
      ...eos04Config,
      devices: { batteries: [], inverters: [], electric_vehicles: [], home_appliances: [] },
    }, {});
    assert.equal(c.flavor, EOS_FLAVOR.UPSTREAM_GENETIC);
    assert.equal(c.supported, false, 'ohne Geräte-Abbildung kein 0.4');
  });

  it('erreichbar, aber unbekannte Antwort → nicht unterstützt', () => {
    for (const bad of [{}, { irgendwas: 1 }]) {
      const c = detectEosCapabilities(bad, {});
      assert.equal(c.flavor, EOS_FLAVOR.UNKNOWN);
      assert.equal(c.reachable, true);
      assert.equal(c.supported, false);
    }
  });

  it('keine Antwort → nicht erreichbar, supported offen', () => {
    for (const bad of [null, undefined, 'kein Objekt']) {
      const c = detectEosCapabilities(bad, {});
      assert.equal(c.flavor, EOS_FLAVOR.UNKNOWN);
      assert.equal(c.reachable, false);
      assert.equal(c.supported, null);
      assert.equal(c.reason, null);
    }
  });
});

describe('createEosCapabilityProbe', () => {
  function probeWith(responses, ttlMs = 60_000) {
    const calls = [];
    let i = 0;
    const request = async (baseUrl, method, path) => {
      calls.push(`${method} ${path}`);
      const r = responses[Math.min(i++, responses.length - 1)];
      return r;
    };
    return { probe: createEosCapabilityProbe({ request, ttlMs }), calls };
  }
  const okConfig = { ok: true, data: eos04Config };
  const okHealth = { ok: true, data: { version: '0.4.0rc1' } };

  it('fragt Konfiguration und Health einmal ab und liefert die Fähigkeiten', async () => {
    const { probe, calls } = probeWith([okConfig, okHealth]);
    const c = await probe.get('http://eos:8503');
    assert.equal(c.supported, true);
    assert.equal(c.version, '0.4.0rc1');
    assert.deepEqual(calls, ['GET /v1/config', 'GET /v1/health']);
  });

  it('merkt sich das Ergebnis bis zum Ablauf der Frist', async () => {
    const { probe, calls } = probeWith([okConfig, okHealth]);
    await probe.get('http://eos:8503');
    await probe.get('http://eos:8503');
    assert.equal(calls.length, 2, 'zweiter Aufruf kommt aus dem Zwischenspeicher');
    probe.reset();
    await probe.get('http://eos:8503');
    assert.equal(calls.length, 4, 'nach reset wird erneut gefragt');
  });

  it('andere Adresse → neue Erkennung', async () => {
    const { probe, calls } = probeWith([okConfig, okHealth]);
    await probe.get('http://eos-a:8503');
    await probe.get('http://eos-b:8505');
    assert.equal(calls.length, 4);
  });

  it('EOS nicht erreichbar → reachable false, kein Wurf, kein Zwischenspeichern des Fehlers', async () => {
    const { probe, calls } = probeWith([{ ok: false, error: 'ECONNREFUSED' }]);
    const c = await probe.get('http://eos:8503');
    assert.equal(c.flavor, EOS_FLAVOR.UNKNOWN);
    assert.equal(c.reachable, false);
    assert.equal(c.supported, null);
    await probe.get('http://eos:8503');
    assert.ok(calls.length >= 2, 'ein Fehlversuch wird nicht zwischengespeichert');
  });

  it('Timeout nach Erkennung einer alten Fassung → bleibt nicht unterstützt', async () => {
    const { probe } = probeWith([{ ok: true, data: dvForkConfig }, okHealth, { ok: false, error: 'EOS timeout' }], 0);
    assert.equal((await probe.get('http://eos:8503')).supported, false);
    const c = await probe.get('http://eos:8503');
    assert.equal(c.reachable, true);
    assert.equal(c.supported, false);
  });
});
