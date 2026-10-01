// test/ortsnetz.test.js — Ortsnetz-Auslastung (www.ortsnetz-auslastung.de):
// Payload nach den Regeln des Projekts, Victron-Netzzähler-Register, Versand
// alle 5 min nur mit Opt-in, Antwort (Ampel + Speicherempfehlung) im Status.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPayload, readVictronGrid, createOrtsnetz, ORTSNETZ_API_URL, VICTRON_GRID_REGS } from '../services/ortsnetz/index.js';

const NOW = Date.parse('2026-10-01T08:00:00.123Z');
const base = { nowMs: NOW, latitude: 48.125611, longitude: 9.432794, l1: 237.6, l2: 236.8, l3: 236.5 };

test('buildPayload: Pflichtfelder, Rundung, optionale Felder nur gültig', () => {
  const r = buildPayload({ ...base, frequencyHz: 50.04, plantKwp: 29.7, pvForecastKwh: 60.26, model: 'Victron GX Netzzähler', version: 'dvhub-1.0.6' });
  assert.deepEqual(r.payload, {
    observed_at: '2026-10-01T08:00:00Z', latitude: 48.125611, longitude: 9.432794,
    l1_v: 237.6, l2_v: 236.8, l3_v: 236.5, grid_frequency_hz: 50.04, plant_capacity_kwp: 29.7,
    pv_forecast_kwh: 60.26, smartmeter_model: 'Victron GX Netzzähler', integration_version: 'dvhub-1.0.6',
  });
  const noFreq = buildPayload({ ...base, frequencyHz: 61, plantKwp: 0, pvForecastKwh: null });
  assert.equal(noFreq.payload.grid_frequency_hz, undefined, 'Frequenz nur 45–55 Hz');
  assert.equal(noFreq.payload.plant_capacity_kwp, undefined);
  assert.equal(noFreq.payload.pv_forecast_kwh, undefined);
});

test('buildPayload: Spannung außerhalb 150–300 V oder fehlend → nicht senden; ohne Standort → nicht senden', () => {
  assert.deepEqual(buildPayload({ ...base, l2: 120 }), { ok: false, reason: 'voltage_out_of_range' });
  assert.deepEqual(buildPayload({ ...base, l3: null }), { ok: false, reason: 'voltage_missing' });
  assert.deepEqual(buildPayload({ ...base, latitude: null }), { ok: false, reason: 'location_missing' });
  assert.deepEqual(buildPayload({ ...base, longitude: 200 }), { ok: false, reason: 'location_missing' });
});

test('readVictronGrid: Register 2616/2618/2620 ×0,1 V, 2644 ×0,01 Hz; 0xFFFF = nicht verfügbar', async () => {
  const calls = [];
  const mb = async (req) => {
    calls.push([req.unitId, req.address, req.quantity, req.fc]);
    return req.address === VICTRON_GRID_REGS.l1 ? [2376, 21, 2368, 65515, 0xffff] : [5004];
  };
  const r = await readVictronGrid(mb, { host: 'gx', port: 502, unitId: 100 });
  assert.deepEqual(r, { l1: 237.6, l2: 236.8, l3: null, frequencyHz: 50.04 });
  assert.deepEqual(calls, [[100, 2616, 5, 3], [100, 2644, 1, 3]]);
});

function ctxWith({ ortsnetz = {}, cfg = {} } = {}) {
  const logs = [];
  return {
    logs,
    ctx: {
      getCfg: () => ({ manufacturer: 'victron', victron: { host: 'gx', port: 502, unitId: 100 }, forecast: { location: { latitude: 48.1, longitude: 9.4 } }, ortsnetz: { enabled: true, ...ortsnetz }, ...cfg }),
      pushLog: (e, d) => logs.push([e, d]),
      getAppVersion: () => ({ version: '1.0.6' }),
      licenseService: { getState: () => ({ system_kwp: 29.7 }) },
      forecastService: { buildForecastResponse: async () => ({ dailyTotals: { today: { pvKwh: 60.26 } } }) },
    },
  };
}
const modbus = { type: 'modbus', mbRequest: async (req) => (req.address === 2616 ? [2376, 0, 2368, 0, 2365] : [5004]) };

test('tick: sendet an die API, merkt Ampel + Empfehlung; Standort aus der Prognose', async () => {
  const sent = [];
  const fetchImpl = async (url, opts) => { sent.push({ url, body: JSON.parse(opts.body) }); return { status: 202, json: async () => ({ accepted: true, status: { l1: 'green', l2: 'green', l3: 'yellow', overall: 'yellow' }, storage_recommendation: 'charge' }) }; };
  const { ctx } = ctxWith();
  const on = createOrtsnetz(ctx, { getTransport: () => modbus, fetchImpl, now: () => NOW });
  assert.deepEqual(await on.tick(), { ok: true });
  assert.equal(sent[0].url, ORTSNETZ_API_URL);
  assert.deepEqual([sent[0].body.latitude, sent[0].body.longitude, sent[0].body.l3_v, sent[0].body.grid_frequency_hz], [48.1, 9.4, 236.5, 50.04]);
  assert.equal(sent[0].body.plant_capacity_kwp, 29.7);
  assert.equal(sent[0].body.pv_forecast_kwh, 60.26);
  assert.equal(sent[0].body.integration_version, 'dvhub-1.0.6');
  const st = on.status();
  assert.equal(st.lastResponse.status.overall, 'yellow');
  assert.equal(st.lastResponse.storageRecommendation, 'charge');
  assert.equal(st.location.source, 'forecast');
  assert.equal(st.sentCount, 1);
});

test('tick: aus → nichts; MQTT-Anlage → Quelle nicht unterstützt; 403 → Standort gesperrt', async () => {
  let posts = 0;
  const fetchImpl = async () => { posts++; return { status: 403, json: async () => ({}) }; };
  const off = createOrtsnetz(ctxWith({ ortsnetz: { enabled: false } }).ctx, { getTransport: () => modbus, fetchImpl });
  assert.deepEqual(await off.tick(), { skipped: 'disabled' });
  const mqtt = createOrtsnetz(ctxWith().ctx, { getTransport: () => ({ type: 'mqtt' }), fetchImpl });
  assert.deepEqual(await mqtt.tick(), { skipped: 'source_unsupported' });
  assert.equal(posts, 0);
  const blocked = createOrtsnetz(ctxWith().ctx, { getTransport: () => modbus, fetchImpl, now: () => NOW });
  await blocked.tick();
  assert.equal(blocked.status().lastError, 'standort_gesperrt');
});

test('Standort: eigene Angabe vor Prognose-Standort; PV-Prognose nur stündlich, abschaltbar', async () => {
  let forecastCalls = 0;
  const { ctx } = ctxWith({ ortsnetz: { latitude: 50.5, longitude: 8.5 } });
  ctx.forecastService = { buildForecastResponse: async () => { forecastCalls++; return { dailyTotals: { today: { pvKwh: 10 } } }; } };
  const bodies = [];
  let t = NOW;
  const on = createOrtsnetz(ctx, { getTransport: () => modbus, now: () => t, fetchImpl: async (u, o) => { bodies.push(JSON.parse(o.body)); return { status: 202, json: async () => ({}) }; } });
  await on.tick(); t += 5 * 60_000; await on.tick();
  assert.equal(bodies[0].latitude, 50.5);
  assert.equal(forecastCalls, 1, 'Prognose gecacht');
  t += 61 * 60_000; await on.tick();
  assert.equal(forecastCalls, 2);
  const { ctx: c2 } = ctxWith({ ortsnetz: { sendPvForecast: false } });
  const b2 = [];
  await createOrtsnetz(c2, { getTransport: () => modbus, now: () => NOW, fetchImpl: async (u, o) => { b2.push(JSON.parse(o.body)); return { status: 202, json: async () => ({}) }; } }).tick();
  assert.equal(b2[0].pv_forecast_kwh, undefined);
});
