// test/eos-capabilities.test.js -- Erkennung der EOS-Fassung (2026-09-15).
//
// Christin: "können wir die Unterstützung schon einbauen, sodass man beide
// EOS-Versionen unterstützt — sobald Andreas das nach main portiert, switchen
// wir einfach." DVhub soll also erkennen, mit welchem EOS es spricht, und den
// Konfigurationsabgleich danach richten, statt Schlüssel blind zu schreiben.
//
// Drei Fassungen sind unterwegs:
//   dv-fork       — unser Fork (Basis v0.3.0): optimization.interval, KEIN
//                   feedintariff.direct_marketing_enabled
//   upstream-dm   — Maintainer-Branch feat/direct-marketing-battery-grid-export
//                   (= das künftige main): interval + direct_marketing_enabled
//                   + Geräteplanung
//   upstream-main — Upstream-main VOR dem GENETIC-Umbau (Stand 15.09.2026):
//                   optimization.genetic.interval_sec, Intervall auf 3600 s
//                   festgenagelt, kein Direktvermarktungs-Schalter
//   upstream-genetic — Upstream ab #1330 (17.09.2026, in v0.4.0rc1): derselbe
//                   Intervall-Pfad, aber 15 Minuten nativ erlaubt, Geräte als
//                   Abbildung nach device_id, zwei Algorithmen nebeneinander,
//                   keine Preisaufschläge mehr unter elecprice
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  EOS_FLAVOR,
  detectEosCapabilities,
  createEosCapabilityProbe,
} from '../services/optimizer/eos-capabilities.js';

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
const upstreamGeneticConfig = {
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
  it('erkennt unseren Fork: Intervall-Schlüssel ja, Direktvermarktungs-Schalter nein', () => {
    const c = detectEosCapabilities(dvForkConfig, { version: '0.3.0' });
    assert.equal(c.flavor, EOS_FLAVOR.DV_FORK);
    assert.equal(c.version, '0.3.0');
    assert.equal(c.supports.directMarketingFlag, false);
    assert.equal(c.supports.quarterHour, true);
    assert.equal(c.supports.applianceScheduling, false);
    assert.equal(c.intervalSection, 'optimization/interval');
  });

  it('erkennt den Maintainer-Branch: Schalter, Geräteplanung, 15 Minuten', () => {
    const c = detectEosCapabilities(upstreamDmConfig, { version: '0.3.0.dev2609140667381389' });
    assert.equal(c.flavor, EOS_FLAVOR.UPSTREAM_DM);
    assert.equal(c.supports.directMarketingFlag, true);
    assert.equal(c.supports.applianceScheduling, true);
    assert.equal(c.supports.quarterHour, true);
    assert.equal(c.intervalSection, 'optimization/interval');
  });

  it('erkennt heutiges Upstream-main: anderer Intervall-Pfad, keine 15 Minuten', () => {
    const c = detectEosCapabilities(upstreamMainConfig, { version: '0.3.0' });
    assert.equal(c.flavor, EOS_FLAVOR.UPSTREAM_MAIN);
    assert.equal(c.supports.directMarketingFlag, false);
    assert.equal(c.supports.quarterHour, false);
    assert.equal(c.intervalSection, 'optimization/genetic/interval_sec');
  });

  it('unbekannte Antwort → flavor unknown und die vorsichtigen Vorgaben', () => {
    for (const bad of [null, undefined, {}, { irgendwas: 1 }, 'kein Objekt']) {
      const c = detectEosCapabilities(bad, {});
      assert.equal(c.flavor, EOS_FLAVOR.UNKNOWN, `Eingabe ${JSON.stringify(bad)}`);
      assert.equal(c.supports.directMarketingFlag, false, 'im Zweifel nicht schreiben');
      assert.equal(c.intervalSection, 'optimization/interval', 'Pfad wie bisher');
      assert.equal(c.supports.quarterHour, true, 'kein grundloses Herabstufen');
    }
  });

  it('meldet, ob die Geräteliste beschreibbar ist (max_home_appliances)', () => {
    assert.equal(detectEosCapabilities(dvForkConfig, {}).supports.maxHomeAppliances, true);
    assert.equal(detectEosCapabilities(upstreamMainConfig, {}).supports.maxHomeAppliances, false);
  });
  it('erkennt Upstream ab #1330: 15 Minuten ja, Geräte als Abbildung, Algorithmuswahl', () => {
    const caps = detectEosCapabilities(upstreamGeneticConfig, { version: '0.4.0rc1' });
    assert.equal(caps.flavor, EOS_FLAVOR.UPSTREAM_GENETIC);
    assert.equal(caps.intervalSection, 'optimization/genetic/interval_sec');
    assert.equal(caps.supports.quarterHour, true,
      'ab #1330 lässt EOS nur noch {900, 3600} zu — 900 ist erlaubt');
    assert.equal(caps.supports.deviceMap, true);
    assert.equal(caps.supports.algorithmChoice, true);
    assert.equal(caps.supports.directMarketingFlag, true);
    assert.equal(caps.supports.elecPriceCharges, false,
      'charges_kwh/vat_rate sind dort gelöscht');
    assert.equal(caps.version, '0.4.0rc1');
  });

  it('hält upstream-main und upstream-genetic auseinander — sonst 15 Minuten verloren', () => {
    // Beide tragen das Intervall unter genetic. Nähme man nur das als
    // Merkmal, würde v0.4.0rc1 als upstream-main durchgehen und still auf
    // Stundenslots herabgestuft.
    const vorher = detectEosCapabilities(upstreamMainConfig, {});
    const nachher = detectEosCapabilities(upstreamGeneticConfig, {});
    assert.equal(vorher.intervalSection, nachher.intervalSection, 'gleicher Intervall-Pfad');
    assert.equal(vorher.supports.quarterHour, false);
    assert.equal(nachher.supports.quarterHour, true);
    assert.equal(vorher.supports.deviceMap, false);
    assert.equal(nachher.supports.deviceMap, true);
  });

  it('eine leere Geräte-Abbildung bleibt als Abbildung erkennbar', () => {
    // EOS liefert unbelegte Abschnitte als {} aus — ein Array-Test allein
    // würde das mit der alten Listenform verwechseln.
    const caps = detectEosCapabilities({
      ...upstreamGeneticConfig,
      devices: { batteries: {}, inverters: {}, electric_vehicles: {}, home_appliances: {} },
    }, {});
    assert.equal(caps.supports.deviceMap, true);
    assert.equal(caps.flavor, EOS_FLAVOR.UPSTREAM_GENETIC);
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
  const okConfig = { ok: true, data: upstreamDmConfig };
  const okHealth = { ok: true, data: { version: '0.3.0.dev1' } };

  it('fragt Konfiguration und Health einmal ab und liefert die Fähigkeiten', async () => {
    const { probe, calls } = probeWith([okConfig, okHealth]);
    const c = await probe.get('http://eos:8503');
    assert.equal(c.flavor, EOS_FLAVOR.UPSTREAM_DM);
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

  it('EOS nicht erreichbar → unknown, kein Wurf, kein Zwischenspeichern des Fehlers', async () => {
    const { probe, calls } = probeWith([{ ok: false, error: 'ECONNREFUSED' }]);
    const c = await probe.get('http://eos:8503');
    assert.equal(c.flavor, EOS_FLAVOR.UNKNOWN);
    assert.equal(c.reachable, false);
    await probe.get('http://eos:8503');
    assert.ok(calls.length >= 2, 'ein Fehlversuch wird nicht zwischengespeichert');
  });
});
