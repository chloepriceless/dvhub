// test/ortsnetz.test.js — Ortsnetz-Auslastung (www.ortsnetz-auslastung.de):
// Payload nach den Regeln des Projekts, Versand alle 5 min nur mit Opt-in,
// Antwort (Ampel + Speicherempfehlung) im Status. Seit 05.11.2026 ohne eigene
// Modbus-Verbindung: nur die zentralen Netzwerte (state.victron.gridVoltage,
// services/grid-voltage.js) mit Frische-Prüfung.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as ortsnetzModule from '../services/ortsnetz/index.js';
import { buildPayload, createOrtsnetz, ORTSNETZ_API_URL } from '../services/ortsnetz/index.js';

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

test('keine eigene Modbus-Leseverbindung mehr (zentrale Werte statt readVictronGrid)', () => {
  assert.equal(ortsnetzModule.readVictronGrid, undefined);
  assert.equal(ortsnetzModule.VICTRON_GRID_REGS, undefined);
});

const freshGv = (over = {}) => ({ l1: 237.6, l2: 236.8, l3: 236.5, frequencyHz: 50.04, updatedAt: NOW - 20_000, source: 'victron_modbus', unitId: 100, error: null, ...over });
function ctxWith({ ortsnetz = {}, cfg = {}, gridVoltage = freshGv() } = {}) {
  const logs = [];
  return {
    logs,
    ctx: {
      state: { victron: { gridVoltage } },
      getCfg: () => ({ manufacturer: 'victron', victron: { host: 'gx', port: 502, unitId: 100 }, forecast: { location: { latitude: 48.1, longitude: 9.4 } }, ortsnetz: { enabled: true, ...ortsnetz }, ...cfg }),
      pushLog: (e, d) => logs.push([e, d]),
      getAppVersion: () => ({ version: '1.0.6' }),
      licenseService: { getState: () => ({ system_kwp: 29.7 }) },
      forecastService: { buildForecastResponse: async () => ({ dailyTotals: { today: { pvKwh: 60.26 } } }) },
    },
  };
}

test('tick: sendet an die API, merkt Ampel + Empfehlung; Standort aus der Prognose', async () => {
  const sent = [];
  const fetchImpl = async (url, opts) => { sent.push({ url, body: JSON.parse(opts.body) }); return { status: 202, json: async () => ({ accepted: true, status: { l1: 'green', l2: 'green', l3: 'yellow', overall: 'yellow' }, storage_recommendation: 'charge' }) }; };
  const { ctx } = ctxWith();
  const on = createOrtsnetz(ctx, { fetchImpl, now: () => NOW });
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

test('tick: aus → nichts; keine Spannungswerte bzw. veraltet → nicht senden; 403 → Standort gesperrt', async () => {
  let posts = 0;
  const fetchImpl = async () => { posts++; return { status: 403, json: async () => ({}) }; };
  const off = createOrtsnetz(ctxWith({ ortsnetz: { enabled: false } }).ctx, { fetchImpl, now: () => NOW });
  assert.deepEqual(await off.tick(), { skipped: 'disabled' });
  const none = createOrtsnetz(ctxWith({ gridVoltage: null }).ctx, { fetchImpl, now: () => NOW });
  assert.deepEqual(await none.tick(), { skipped: 'voltage_unavailable' });
  assert.equal(none.status().lastSkip, 'voltage_unavailable');
  assert.equal(none.status().source, 'voltage_unavailable');
  const stale = createOrtsnetz(ctxWith({ gridVoltage: freshGv({ updatedAt: NOW - 3 * 60_000 }) }).ctx, { fetchImpl, now: () => NOW });
  assert.deepEqual(await stale.tick(), { skipped: 'voltage_stale' });
  const notFound = createOrtsnetz(ctxWith({ gridVoltage: { l1: null, l2: null, l3: null, error: 'grid_meter_not_found' } }).ctx, { fetchImpl, now: () => NOW });
  assert.deepEqual(await notFound.tick(), { skipped: 'voltage_unavailable' });
  assert.equal(notFound.status().lastError, 'grid_meter_not_found', 'Grund aus dem zentralen Leser sichtbar');
  assert.equal(posts, 0);
  const blocked = createOrtsnetz(ctxWith().ctx, { fetchImpl, now: () => NOW });
  await blocked.tick();
  assert.equal(blocked.status().lastError, 'standort_gesperrt');
});

test('Standort: eigene Angabe vor Prognose-Standort; PV-Prognose nur stündlich, abschaltbar', async () => {
  let forecastCalls = 0;
  const { ctx } = ctxWith({ ortsnetz: { latitude: 50.5, longitude: 8.5 } });
  ctx.forecastService = { buildForecastResponse: async () => { forecastCalls++; return { dailyTotals: { today: { pvKwh: 10 } } }; } };
  const bodies = [];
  let t = NOW;
  ctx.state = { victron: { get gridVoltage() { return freshGv({ updatedAt: t - 10_000 }); } } };
  const on = createOrtsnetz(ctx, { now: () => t, fetchImpl: async (u, o) => { bodies.push(JSON.parse(o.body)); return { status: 202, json: async () => ({}) }; } });
  await on.tick(); t += 5 * 60_000; await on.tick();
  assert.equal(bodies[0].latitude, 50.5);
  assert.equal(forecastCalls, 1, 'Prognose gecacht');
  t += 61 * 60_000; await on.tick();
  assert.equal(forecastCalls, 2);
  const { ctx: c2 } = ctxWith({ ortsnetz: { sendPvForecast: false } });
  const b2 = [];
  await createOrtsnetz(c2, { now: () => NOW, fetchImpl: async (u, o) => { b2.push(JSON.parse(o.body)); return { status: 202, json: async () => ({}) }; } }).tick();
  assert.equal(b2[0].pv_forecast_kwh, undefined);
});

test('läuft mit jeder Quelle, die Spannungen liefert (MQTT, SPiNE); Modell nach Quelle, Gültigkeitsregeln bleiben', async () => {
  const bodies = [];
  const fetchImpl = async (u, o) => { bodies.push(JSON.parse(o.body)); return { status: 202, json: async () => ({}) }; };
  for (const [source, model] of [['victron_mqtt', 'Victron GX Netzzähler'], ['spine_http', 'SPiNE EnergyLink']]) {
    const on = createOrtsnetz(ctxWith({ gridVoltage: freshGv({ source, unitId: null }) }).ctx, { fetchImpl, now: () => NOW });
    assert.deepEqual(await on.tick(), { ok: true });
    assert.match(bodies.at(-1).smartmeter_model, new RegExp(model));
    assert.equal(on.status().source, source);
  }
  const low = createOrtsnetz(ctxWith({ gridVoltage: freshGv({ l2: 140 }) }).ctx, { fetchImpl, now: () => NOW });
  assert.deepEqual(await low.tick(), { skipped: 'voltage_out_of_range' });
  const oneP = createOrtsnetz(ctxWith({ gridVoltage: freshGv({ l3: null }) }).ctx, { fetchImpl, now: () => NOW });
  assert.deepEqual(await oneP.tick(), { skipped: 'voltage_missing' });
  const n = bodies.length;
  const badF = createOrtsnetz(ctxWith({ gridVoltage: freshGv({ frequencyHz: 57 }) }).ctx, { fetchImpl, now: () => NOW });
  await badF.tick();
  assert.equal(bodies.length, n + 1);
  assert.equal(bodies.at(-1).grid_frequency_hz, undefined, 'Frequenz nur 45–55 Hz');
  assert.equal(badF.status().lastMeasurement.l1, 237.6);
});

// Codex-Gegenprüfung a95ee2ae (2× P2).
test('observed_at = Messzeit der zentralen Werte, nicht der Sendezeitpunkt', async () => {
  const bodies = [];
  const fetchImpl = async (u, o) => { bodies.push(JSON.parse(o.body)); return { status: 202, json: async () => ({}) }; };
  const on = createOrtsnetz(ctxWith({ gridVoltage: freshGv({ updatedAt: Date.parse('2026-10-01T07:58:01.400Z') }) }).ctx, { fetchImpl, now: () => NOW });
  await on.tick();
  assert.equal(bodies[0].observed_at, '2026-10-01T07:58:01Z');
});

test('Web-Prozess (Runtime-Worker-Betrieb): Werte aus dem Worker-Snapshot (send-now)', async () => {
  const bodies = [];
  const fetchImpl = async (u, o) => { bodies.push(JSON.parse(o.body)); return { status: 202, json: async () => ({}) }; };
  const { ctx } = ctxWith({ gridVoltage: undefined });
  ctx.state = { victron: {} }; // Web-Prozess: Poller läuft im Worker
  ctx.getCachedRuntimeStatusPayload = () => ({ victron: { gridVoltage: freshGv() } });
  const on = createOrtsnetz(ctx, { fetchImpl, now: () => NOW });
  assert.deepEqual(await on.tick(), { ok: true });
  assert.equal(bodies[0].l1_v, 237.6);
});
