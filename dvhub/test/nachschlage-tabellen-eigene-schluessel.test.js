// Weitere Nachschlage-Tabellen nur mit eigenen Schlüsseln (Christin 21.11.2026, A8, Suche im Repo).
//
// Gleiches Muster wie die Preset-Tabellen (preset-tabellen-eigene-schluessel.test.js): `TABELLE[eingabe]` mit Eingabe
// aus MQTT-Topic, HTTP-Push, Konfiguration oder HTTP-Pfad traf über den Prototyp eine Funktion bzw. Object.prototype.
// Bis 8f0f1346: MQTT-Befehl „constructor“ ging als Akku-Sollwert an applyManualControlWrite, Push-Feld „toString“ wurde
// als Wert ohne Eingang angenommen, TeslaMate-Topic „…/constructor“ warf TypeError, Benachrichtigungs-Anbieter
// „constructor“ wurde als Fabrik aufgerufen, pvnode-Plan „constructor“ ergab NaN als Abfragetakt, LUOX-Server
// „constructor“ eine Funktion als Adresse, EOS-Import „…/import/constructor“ einen Eintrag mit Funktion als Spalte.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createMqttCommandSubscriber } from '../services/mqtt/command-subscriber.js';
import { parsePushFields } from '../services/input-push.js';
import { createTeslamateSubscriber } from '../services/mqtt/teslamate.js';
import { createProviderFromConfig, hasNotificationProvider } from '../services/notifications/index.js';
import { resolvePvnodePlan, pvnodePlanFor, PVNODE_PLANS, DEFAULT_PVNODE_PLAN } from '../services/forecast/pvnode-plans.js';
import { createLumenazaPartnerClient, PARTNER_HOSTS } from '../services/tariff-provider/luox-partner-client.js';
import { createEosRemoteFacade } from '../services/optimizer/eos-remote.js';

// Schlüssel, die jede gewöhnliche Tabelle über Object.prototype „kennt“.
const PROTO_KEYS = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf', 'toLocaleString'];

describe('MQTT-Befehle: NUMERIC_TARGETS', () => {
  afterEach(() => { delete process.env.DVHUB_READ_ONLY; });

  it('<prefix>/cmd/constructor u. a. → unbekannter Befehl, kein Schreibaufruf', async () => {
    const manual = []; const logs = [];
    const ctx = {
      getCfg: () => ({ mqtt: { topicPrefix: 'dvhub', haDiscovery: { enabled: true } } }),
      pushLog: (event, data) => logs.push({ event, data }),
      applyManualControlWrite: async (o) => { manual.push(o); return { ok: true }; },
    };
    const sub = createMqttCommandSubscriber({ subscribe() {}, publish() {} }, ctx);
    for (const k of PROTO_KEYS) await sub._handleMessage(`dvhub/cmd/${k}`, Buffer.from('25'));
    assert.deepEqual(manual, [], 'kein applyManualControlWrite');
    const rejected = logs.filter((l) => l.event === 'mqtt_command_rejected');
    assert.equal(rejected.length, PROTO_KEYS.length, JSON.stringify(logs));
    for (const l of rejected) assert.equal(l.data.error, 'unknown_command');
    // Gültiger Befehl unverändert.
    await sub._handleMessage('dvhub/cmd/min_soc_pct', Buffer.from('25'));
    assert.deepEqual(manual.map((m) => [m.target, m.value]), [['minSocPct', 25]]);
  });
});

describe('HTTP-Push: PUSH_FIELDS', () => {
  it('Prototyp-Felder → „unbekanntes Feld“, kein Wert', () => {
    const body = JSON.parse('{"__proto__":"5","constructor":"5","toString":"1","valueOf":"2","hasOwnProperty":"3"}');
    const { values, errors } = parsePushFields(body);
    assert.deepEqual(values, []);
    assert.equal(errors.length, 5, JSON.stringify(errors));
    for (const e of errors) assert.match(e, /unbekanntes Feld/);
    // Gültiges Feld unverändert.
    assert.deepEqual(parsePushFields({ soc_pct: '55' }).values, [{ field: 'soc_pct', input: 'battery_soc', value: 55 }]);
  });
});

describe('TeslaMate: TOPIC_MAP', () => {
  it('Topic …/constructor, …/toString, …/__proto__ → still verworfen, kein TypeError, Zustand unverändert', async () => {
    const handlers = [];
    const hub = { subscribe: (t, fn) => handlers.push(fn), get connected() { return true; } };
    const ctx = {
      state: {},
      getCfg: () => ({ integrations: { tesla: { enabled: true, teslamateCarId: 2, name: 'Tesla', snapshotIntervalSec: 300 } } }),
      pushLog: () => {},
      db: { query: () => Promise.resolve({ rows: [] }) },
    };
    const sub = createTeslamateSubscriber(hub, ctx);
    await sub.start();
    assert.ok(handlers.length >= 1);
    const before = JSON.stringify(sub.getState());
    for (const k of PROTO_KEYS) {
      for (const fn of handlers) assert.doesNotThrow(() => fn(`teslamate/cars/2/${k}`, Buffer.from('85')), k);
    }
    assert.equal(JSON.stringify(sub.getState()), before);
    for (const fn of handlers) fn('teslamate/cars/2/battery_level', Buffer.from('85'));
    assert.equal(sub.getState().batteryLevel, 85, 'gültiges Topic unverändert');
  });
});

describe('Benachrichtigungen: PROVIDER_FACTORIES', () => {
  it('Prototyp-Namen und Nicht-Texte sind kein Anbieter', () => {
    for (const bad of [...PROTO_KEYS, ['ntfy'], 7, null]) {
      assert.equal(hasNotificationProvider(bad), false, String(bad));
      assert.equal(createProviderFromConfig(bad, { enabled: true }), null, String(bad));
    }
    for (const ok of ['telegram', 'pushover', 'ntfy']) assert.equal(hasNotificationProvider(ok), true, ok);
  });
});

describe('pvnode: PVNODE_PLANS', () => {
  it('Plan „constructor“/„__proto__“ → Free mit endlichem Abfragetakt und Kontingent (nie NaN)', () => {
    for (const bad of ['constructor', '__proto__', 'Constructor', 'toString', 'hasOwnProperty']) {
      const p = resolvePvnodePlan({ forecast: { pvnode: { plan: bad } } });
      assert.equal(p.key, DEFAULT_PVNODE_PLAN, bad);
      assert.ok(Number.isFinite(p.fetchIntervalMs) && p.fetchIntervalMs >= 15 * 60 * 1000, `${bad}: ${p.fetchIntervalMs}`);
      assert.equal(p.monthlyQuota, PVNODE_PLANS.free.monthlyQuota);
      assert.equal(p.nowcast, false);
      assert.equal(pvnodePlanFor(bad), PVNODE_PLANS.free, `pvnodePlanFor(${bad})`);
    }
    assert.equal(pvnodePlanFor(['plus']), PVNODE_PLANS.free, 'Nicht-Text → Free');
    assert.equal(pvnodePlanFor(undefined), PVNODE_PLANS.free);
    assert.equal(pvnodePlanFor('plus'), PVNODE_PLANS.plus);
    assert.equal(resolvePvnodePlan({ forecast: { pvnode: { plan: 'Plus' } } }).key, 'plus', 'Groß-/Kleinschreibung wie bisher egal');
  });
});

describe('LUOX-Partner: PARTNER_HOSTS', () => {
  it('environment „constructor“ u. a. → Produktionsserver, nie eine Funktion als Adresse', async () => {
    for (const bad of [...PROTO_KEYS, ['test'], 3]) {
      const seen = [];
      const fetchImpl = async (url) => { seen.push(String(url)); return { ok: false, status: 401, json: async () => ({}), text: async () => '' }; };
      const client = createLumenazaPartnerClient({ clientId: 'a', clientSecret: 'b', environment: bad, fetchImpl });
      await client.epexDayAhead({ from: '2026-11-21T00:00:00Z', to: '2026-11-22T00:00:00Z' }).catch(() => {});
      assert.ok(seen.length >= 1, `Anfrage bei ${String(bad)}`);
      for (const u of seen) assert.ok(u.startsWith(`${PARTNER_HOSTS.prod}/`), `${String(bad)} → ${u}`);
    }
  });
});

describe('EOS-Fernbetrieb: PROVIDER_COLUMNS', () => {
  const closers = [];
  afterEach(async () => { while (closers.length) await closers.pop()(); });

  it('PUT /v1/prediction/import/constructor u. a. → 404, kein Eintrag', async () => {
    const cfg = { timeZone: 'Europe/Berlin', optimizer: { eosProxy: { enabled: true, mode: 'remote', url: 'http://127.0.0.1:8503', remote: { endpoint: 'http://127.0.0.1:9', token: '' } } } };
    const facade = createEosRemoteFacade({ getCfg: () => cfg, getLicenceProof: () => null, saveToken: async () => {}, state: { optimizer: {} }, pushLog: () => {}, eosVersion: 'v0.4.0rc3', proofEndpointTrusted: () => true });
    const url = await facade.start();
    closers.push(() => facade.stop());
    const body = { data: {}, dtypes: {}, tz: 'Europe/Berlin', datetime_columns: [] };
    for (const k of PROTO_KEYS) {
      const r = await fetch(`${url}/v1/prediction/import/${encodeURIComponent(k)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      await r.text();
      assert.equal(r.status, 404, k);
    }
    assert.deepEqual(facade.snapshot().providers, [], 'kein Prognose-Eintrag angelegt');
    const ok = await fetch(`${url}/v1/prediction/import/PVForecastImport`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    await ok.text();
    assert.equal(ok.status, 200, 'gültiger Anbieter unverändert');
  });
});
