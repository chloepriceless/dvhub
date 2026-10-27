// test/ev-soc-sources.test.js -- universelle Ladestand-Quellen fuers E-Auto.
//
// Jede Marke soll gehen: neben TeslaMate, Wallbox/evcc, evcc-Fahrzeugtreiber
// und MQTT jetzt auch ein beliebiger HTTP-Endpunkt (JSON + Pfad) und Home
// Assistant (REST, Langzeit-Token). Jede Quelle nennt den Zeitpunkt ihres
// Werts; zu alte Werte gelten als unbekannt.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createVehiclePull, isAllowedVehicleUrl, readJsonPath } from '../services/vehicle-pull/index.js';
import {
  resolveEvSocPct, resolveEvPlugged, resolveEvSocReading, EV_SOC_SOURCES, VEHICLE_SOC_SOURCES
} from '../services/optimizer/ev-soc.js';
import { isRedactedPath } from '../config-redaction.js';
import { createDefaultConfig, getConfigDefinition } from '../config-model.js';

let server = null;
afterEach(async () => { if (server) { await new Promise((r) => server.close(r)); server = null; } });

/** Stub-Endpunkt: handler(req) → { status, body, delayMs, headers } */
function stub(handler) {
  const seen = [];
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      seen.push({ url: req.url, auth: req.headers.authorization || null });
      const out = handler(req) || {};
      setTimeout(() => {
        res.writeHead(out.status || 200, { 'Content-Type': 'application/json', ...(out.headers || {}) });
        res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body ?? {}));
      }, out.delayMs || 0);
    });
    server.listen(0, '127.0.0.1', () => resolve({ base: `http://127.0.0.1:${server.address().port}`, seen }));
  });
}

function pullCtx(opt) {
  const cfg = { optimizer: { evMqttMaxAgeH: 24, ...opt } };
  return { getCfg: () => cfg, pushLog: () => {} };
}

describe('JSON-Pfad', () => {
  it('Punkte und Indizes', () => {
    const doc = { data: { vehicles: [{ soc: 63 }], plugged: 'on' } };
    assert.deepEqual(readJsonPath(doc, 'data.vehicles[0].soc'), { found: true, value: 63 });
    assert.deepEqual(readJsonPath(doc, 'data.vehicles.0.soc'), { found: true, value: 63 });
    assert.deepEqual(readJsonPath(doc, 'data.soc'), { found: false, value: undefined });
    assert.deepEqual(readJsonPath(42, ''), { found: true, value: 42 }, 'leerer Pfad = ganzes Dokument');
    assert.deepEqual(readJsonPath({ a: 1 }, '__proto__.x'), { found: false, value: undefined });
  });
});

describe('Adresse pruefen (SSRF)', () => {
  for (const [url, ok] of [
    ['http://192.168.1.5:8123', true],
    ['http://10.0.0.7/api/soc', true],
    ['http://homeassistant.local:8123', true],
    ['http://127.0.0.1:8123', true],
    ['https://abc.ui.nabu.casa', true],
    ['https://api.example.com/car', true],
    ['http://api.example.com/car', false],          // unverschluesselt ins Internet
    ['http://169.254.169.254/latest/meta-data', false],
    ['https://169.254.169.254/latest/meta-data', false],
    ['http://0.0.0.0:8123', false],
    ['https://user:pass@example.com', false],        // Zugangsdaten nie in der URL
    ['ftp://192.168.1.5/x', false],
    ['file:///etc/passwd', false],
    ['kein url', false],
  ]) {
    it(`${url} → ${ok ? 'erlaubt' : 'abgelehnt'}`, () => assert.equal(isAllowedVehicleUrl(url), ok));
  }
});

describe('HTTP-Abruf (beliebiger Endpunkt)', () => {
  it('Ladestand, „angesteckt“ und Zeitpunkt aus JSON-Pfaden; Bearer-Token im Kopf', async () => {
    const { base, seen } = await stub(() => ({ body: { data: { soc: 63.4, plug: 'connected', ts: '2026-10-27T10:00:00Z' } } }));
    const now = Date.parse('2026-10-27T10:05:00Z');
    const pull = createVehiclePull(pullCtx({
      evHttpUrl: `${base}/car`, evHttpToken: 'geheim', evHttpSocPath: 'data.soc', evHttpPluggedPath: 'data.plug', evHttpTimePath: 'data.ts',
    }), { now: () => now });
    await pull.refresh('http');
    const st = pull.getState('http');
    assert.equal(st.socPct, 63.4);
    assert.equal(st.socAt, Date.parse('2026-10-27T10:00:00Z'));
    assert.equal(st.plugged, true);
    assert.equal(st.error, null);
    assert.equal(seen[0].auth, 'Bearer geheim');
  });

  it('ohne Zeit-Pfad: Zeitpunkt des Abrufs', async () => {
    const { base } = await stub(() => ({ body: { soc: 50 } }));
    const now = Date.parse('2026-10-27T10:05:00Z');
    const pull = createVehiclePull(pullCtx({ evHttpUrl: `${base}/car`, evHttpSocPath: 'soc' }), { now: () => now });
    await pull.refresh('http');
    assert.equal(pull.getState('http').socAt, now);
  });

  it('falscher JSON-Pfad: kein Wert, Fehler nennt den Pfad', async () => {
    const { base } = await stub(() => ({ body: { data: { soc: 63 } } }));
    const pull = createVehiclePull(pullCtx({ evHttpUrl: `${base}/car`, evHttpSocPath: 'data.batterie' }));
    await pull.refresh('http');
    const st = pull.getState('http');
    assert.equal(st.socPct, null);
    assert.match(st.error, /Pfad „data\.batterie“/);
  });

  it('Wert ausserhalb 0–100 oder kein JSON: kein Wert', async () => {
    const { base } = await stub((req) => (req.url === '/a' ? { body: { soc: 140 } } : { body: '<html>' }));
    const pull = createVehiclePull(pullCtx({ evHttpUrl: `${base}/a`, evHttpSocPath: 'soc' }));
    await pull.refresh('http');
    assert.equal(pull.getState('http').socPct, null);
    assert.match(pull.getState('http').error, /0.100/);
    const pull2 = createVehiclePull(pullCtx({ evHttpUrl: `${base}/b`, evHttpSocPath: 'soc' }));
    await pull2.refresh('http');
    assert.match(pull2.getState('http').error, /kein JSON/);
  });

  it('veralteter Wert (aelter als „gilt hoechstens“) gilt als unbekannt', async () => {
    const { base } = await stub(() => ({ body: { soc: 70, ts: '2026-10-25T10:00:00Z' } }));
    const now = Date.parse('2026-10-27T10:05:00Z');   // 48 h spaeter, erlaubt 24 h
    const pull = createVehiclePull(pullCtx({ evHttpUrl: `${base}/car`, evHttpSocPath: 'soc', evHttpTimePath: 'ts' }), { now: () => now });
    await pull.refresh('http');
    const st = pull.getState('http');
    assert.equal(st.socPct, null);
    assert.equal(st.socStale, true);
  });

  it('Zeitueberschreitung und Weiterleitung sind Fehler', async () => {
    const { base } = await stub((req) => (req.url === '/slow'
      ? { body: { soc: 1 }, delayMs: 800 }
      : { status: 302, headers: { Location: 'http://169.254.169.254/' } }));
    const slow = createVehiclePull(pullCtx({ evHttpUrl: `${base}/slow`, evHttpSocPath: 'soc', evHttpTimeoutMs: 500 }));
    await slow.refresh('http');
    assert.match(slow.getState('http').error, /Zeitüberschreitung/);
    const redir = createVehiclePull(pullCtx({ evHttpUrl: `${base}/redir`, evHttpSocPath: 'soc' }));
    await redir.refresh('http');
    assert.match(redir.getState('http').error, /Weiterleitung/);
  });

  it('gesperrte Adresse wird gar nicht abgefragt', async () => {
    let called = false;
    const pull = createVehiclePull(pullCtx({ evHttpUrl: 'http://169.254.169.254/x', evHttpSocPath: 'soc' }), { fetch: async () => { called = true; } });
    await pull.refresh('http');
    assert.equal(called, false);
    assert.match(pull.getState('http').error, /Adresse nicht erlaubt/);
  });
});

describe('Home Assistant (REST)', () => {
  const haHandler = (req) => {
    if (req.headers.authorization !== 'Bearer ha-token') return { status: 401, body: { message: 'Unauthorized' } };
    if (req.url === '/api/states/sensor.auto_soc') return { body: { entity_id: 'sensor.auto_soc', state: '57', last_updated: '2026-10-27T09:00:00+00:00', last_reported: '2026-10-27T10:00:00+00:00' } };
    if (req.url === '/api/states/binary_sensor.auto_plug') return { body: { state: 'off', last_updated: '2026-10-27T08:00:00+00:00' } };
    if (req.url === '/api/states/sensor.weg') return { body: { state: 'unavailable', last_updated: '2026-10-27T10:00:00+00:00' } };
    return { status: 404, body: { message: 'Entity not found.' } };
  };

  it('Ladestand + „angesteckt“ aus Entitaeten, Zeitpunkt = last_reported', async () => {
    const { base } = await stub(haHandler);
    const now = Date.parse('2026-10-27T10:05:00Z');
    const pull = createVehiclePull(pullCtx({ evHaUrl: base, evHaToken: 'ha-token', evHaSocEntity: 'sensor.auto_soc', evHaPluggedEntity: 'binary_sensor.auto_plug' }), { now: () => now });
    await pull.refresh('homeassistant');
    const st = pull.getState('homeassistant');
    assert.equal(st.socPct, 57);
    assert.equal(st.socAt, Date.parse('2026-10-27T10:00:00Z'));
    assert.equal(st.plugged, false);
  });

  it('„unavailable“, unbekannte Entitaet, falsches Token: kein Wert, Fehler sichtbar', async () => {
    const { base } = await stub(haHandler);
    const a = createVehiclePull(pullCtx({ evHaUrl: base, evHaToken: 'ha-token', evHaSocEntity: 'sensor.weg' }));
    await a.refresh('homeassistant');
    assert.equal(a.getState('homeassistant').socPct, null);
    assert.match(a.getState('homeassistant').error, /unavailable/);
    const b = createVehiclePull(pullCtx({ evHaUrl: base, evHaToken: 'ha-token', evHaSocEntity: 'sensor.gibtsnicht' }));
    await b.refresh('homeassistant');
    assert.match(b.getState('homeassistant').error, /HTTP 404/);
    const c = createVehiclePull(pullCtx({ evHaUrl: base, evHaToken: 'falsch', evHaSocEntity: 'sensor.auto_soc' }));
    await c.refresh('homeassistant');
    assert.match(c.getState('homeassistant').error, /HTTP 401/);
  });

  it('Entitaets-ID wird geprueft (kein Pfad-Trick)', async () => {
    let called = false;
    const pull = createVehiclePull(pullCtx({ evHaUrl: 'http://127.0.0.1:1', evHaToken: 't', evHaSocEntity: '../config' }), { fetch: async () => { called = true; } });
    await pull.refresh('homeassistant');
    assert.equal(called, false);
    assert.match(pull.getState('homeassistant').error, /Entität/);
  });
});

describe('ev-soc.js: dieselbe Aufloesung fuer alle Quellen', () => {
  const NOW = Date.parse('2026-10-27T10:05:00Z');
  const pullState = (kind, st) => ({ getState: (k) => (k === kind ? { configured: true, ...st } : { configured: false, socPct: null, plugged: null }) });

  it('neue Quellen stehen in der Auswahl; die Fahrzeug-Quellen sind markennneutral', () => {
    assert.ok(EV_SOC_SOURCES.includes('http'));
    assert.ok(EV_SOC_SOURCES.includes('homeassistant'));
    assert.deepEqual([...VEHICLE_SOC_SOURCES].sort(), ['evccvehicle', 'homeassistant', 'http', 'mqtt', 'teslamate']);
  });

  it('evSocSource http / homeassistant waehlt genau diese Quelle', () => {
    const ctx = { getCfg: () => ({ optimizer: { evSocSource: 'http' } }), vehiclePull: pullState('http', { socPct: 61, socAt: NOW - 60_000 }) };
    assert.deepEqual(resolveEvSocPct(ctx), { pct: 61, source: 'http' });
    const ha = { getCfg: () => ({ optimizer: { evSocSource: 'homeassistant' } }), vehiclePull: pullState('homeassistant', { socPct: 44, socAt: NOW - 60_000 }) };
    assert.deepEqual(resolveEvSocPct(ha), { pct: 44, source: 'homeassistant' });
  });

  it('auto ohne andere Quelle: HTTP springt ein; Lesung nennt den Zeitpunkt', () => {
    const ctx = { getCfg: () => ({ optimizer: { evSocSource: 'auto' } }), vehiclePull: pullState('http', { socPct: 61, socAt: NOW - 60_000 }) };
    assert.deepEqual(resolveEvSocPct(ctx), { pct: 61, source: 'http' });
    assert.deepEqual(resolveEvSocReading(ctx, NOW), { pct: 61, source: 'http', atMs: NOW - 60_000 });
  });

  it('„angesteckt“ aus HTTP/HA, wenn weder Wallbox noch evcc noch MQTT es sagen', () => {
    const ctx = { getCfg: () => ({ optimizer: {} }), vehiclePull: pullState('homeassistant', { plugged: true }) };
    assert.equal(resolveEvPlugged(ctx), true);
    const viaHttp = { getCfg: () => ({ optimizer: {} }), vehiclePull: pullState('http', { plugged: false }) };
    assert.equal(resolveEvPlugged(viaHttp), false);
    const evccWins = { ...ctx, evccIntegration: { getLoadpoints: () => [{ id: 1, connected: false }] } };
    assert.equal(resolveEvPlugged(evccWins), false, 'die Wallbox geht vor');
  });
});

describe('Einstellungen + Geheimnisse', () => {
  it('Tokens werden beim Export/GET geschwaerzt', () => {
    assert.equal(isRedactedPath('optimizer.evHttpToken'), true);
    assert.equal(isRedactedPath('optimizer.evHaToken'), true);
  });

  it('jedes neue Feld hat ein Bedienelement in den Einstellungen', () => {
    const fields = new Map(getConfigDefinition().fields.filter((f) => f.path).map((f) => [f.path, f]));
    const opt = createDefaultConfig().optimizer;
    for (const key of ['evHttpUrl', 'evHttpToken', 'evHttpSocPath', 'evHttpPluggedPath', 'evHttpTimePath', 'evHttpIntervalSec', 'evHttpTimeoutMs',
      'evHaUrl', 'evHaToken', 'evHaSocEntity', 'evHaPluggedEntity', 'evHaIntervalSec']) {
      assert.ok(key in opt, `optimizer.${key} fehlt in den Vorgaben`);
      assert.ok(fields.has(`optimizer.${key}`), `optimizer.${key} hat kein Feld`);
    }
    assert.equal(fields.get('optimizer.evHttpToken').type, 'password');
    assert.equal(fields.get('optimizer.evHaToken').type, 'password');
    const src = fields.get('optimizer.evSocSource').options.map((o) => o.value);
    assert.ok(src.includes('http') && src.includes('homeassistant'));
  });
});
