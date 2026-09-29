// test/input-ha-loxone.test.js — Messwert-Eingang für Home Assistant / Loxone
// (DVhub-MQTT-Schema + HTTP-Push): Gesamtwert-Topics, Frische, toter Zufluss,
// Hausverbrauch aus der Energiebilanz, Push-Parser.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMqttTransport } from '../transport-mqtt.js';
import { createPoller } from '../polling.js';
import { parsePushFields } from '../services/input-push.js';

function dvhubTransport(staleMaxAgeMs = 90000) {
  return createMqttTransport({ host: '', mqtt: { schema: 'dvhub', topicPrefix: 'dvhub', staleMaxAgeMs } });
}

// ── Transport ────────────────────────────────────────────────────────────────

test('Gesamtwerte: grid/total_w vor Phasen, consumption/total_w vor Phasen, pv/total_w als PV', () => {
  const t = dvhubTransport();
  t.ingest('grid_l1', 100);
  t.ingest('grid_total', -2500);
  assert.equal(t.readGrid().total, -2500, 'Gesamtwert hat Vorrang');
  t.ingest('consumption_l1', 300);
  t.ingest('consumption_total', 1800);
  assert.equal(t.getCached('selfConsumptionW'), 1800);
  t.ingest('pv_total', 4200);
  assert.equal(t.getCached('pvPowerW'), 4200, 'pv/total_w füllt pvPowerW, wenn dc_w fehlt');
  t.ingest('battery_soc', 55);
  t.ingest('battery_power', -700);
  assert.equal(t.getCached('soc'), 55);
  assert.equal(t.getCached('batteryPowerW'), -700);
});

test('readGrid: nur Phasen → Summe; nie gesehene Phase = 0; veraltete Phase → alles ungültig', () => {
  const t = dvhubTransport(5000);
  const now = Date.now();
  t.ingest('grid_l1', 500, now);
  assert.deepEqual(t.readGrid(), { total: 500, l1: 500, l2: 0, l3: 0, ts: now });
  t.ingest('grid_l2', 200, now - 10_000); // gesehen, aber veraltet
  assert.equal(t.readGrid(), null, 'veraltete Phase macht die Summe ungültig — nicht still weglassen');
});

test('readGrid: kein Wert oder alles veraltet → null (nicht 0 W)', () => {
  const t = dvhubTransport(5000);
  assert.equal(t.readGrid(), null);
  t.ingest('grid_total', 1234, Date.now() - 60_000);
  assert.equal(t.readGrid(), null);
});

test('ingest: nur im DVhub-Schema, unbekannte Eingänge und Nicht-Zahlen abgelehnt', () => {
  const venus = createMqttTransport({ host: '127.0.0.1', mqtt: { portalId: 'x' } });
  assert.equal(venus.ingest('grid_total', 1), false);
  const t = dvhubTransport();
  assert.equal(t.ingest('gibts_nicht', 1), false);
  assert.equal(t.ingest('grid_total', 'abc'), false);
  assert.equal(t.ingest('grid_total', 7), true);
  assert.equal(t.inputStatus().grid_total.value, 7);
  assert.equal(t.inputStatus().grid_total.topic, 'dvhub/input/grid/total_w');
});

// ── Poller ───────────────────────────────────────────────────────────────────

function makePoller(transport, { gridPositiveMeans = 'feed_in', derive = 'energy_balance' } = {}) {
  const state = {
    meter: { ok: false, updatedAt: 0, raw: [], grid_l1_w: 0, grid_l2_w: 0, grid_l3_w: 0, grid_total_w: 0, error: null },
    victron: { errors: {}, updatedAt: 0 },
    dvRegs: new Array(8).fill(0),
    energy: { day: '2026-09-29', importWh: 0, exportWh: 0, costEur: 0, revenueEur: 0, lastTs: 0 },
  };
  const cfg = {
    pollMs: 500, gridPositiveMeans,
    points: {
      soc: { enabled: true }, batteryPowerW: { enabled: true }, pvPowerW: { enabled: true },
      selfConsumptionW: { enabled: true, ...(derive ? { derive } : {}) },
    },
    epex: { timezone: 'UTC' }, userEnergyPricing: {}, dvControl: {},
  };
  const poller = createPoller({
    state, getCfg: () => cfg, transport, pushLog: () => {},
    energyPath: '/tmp/input-ha-loxone-test.json', onPollComplete: () => {},
    epexNowNext: () => ({ current: { ct_kwh: 0 } }),
  });
  return { state, poller };
}

test('Poller: HA/Loxone-Gesamtwerte landen im Zustand (feed_in-Konvention invertiert)', async () => {
  const t = dvhubTransport();
  t.ingest('grid_total', -1500); // 1,5 kW Einspeisung
  t.ingest('pv_total', 5000);
  t.ingest('battery_power', 1000);
  t.ingest('battery_soc', 64);
  t.ingest('consumption_total', 2500);
  const { state, poller } = makePoller(t);
  await poller.requestPoll();
  assert.equal(state.meter.ok, true);
  assert.equal(state.meter.grid_total_w, 1500, 'feed_in: Einspeisung positiv');
  assert.equal(state.meter.grid_l1_w, null, 'nur Gesamtwert geliefert → keine erfundenen Phasen');
  assert.equal(state.victron.gridExportW, 1500);
  assert.equal(state.victron.soc, 64);
  assert.equal(state.victron.pvTotalW, 5000);
  assert.equal(state.victron.batteryPowerW, 1000);
  assert.equal(state.victron.selfConsumptionW, 2500, 'gemessener Verbrauch hat Vorrang vor der Ableitung');
});

test('Poller: toter Zufluss → Zähler ungültig (nicht 0 W „ok“), Backoff läuft', async () => {
  const t = dvhubTransport(5000);
  t.ingest('grid_total', -1500, Date.now() - 60_000); // veraltet
  const { state, poller } = makePoller(t, { derive: null });
  await poller.requestPoll();
  assert.equal(state.meter.ok, false);
  assert.match(state.meter.error, /Netzwerte fehlen oder sind veraltet/);
  assert.equal(state.meter.consecutiveErrors, 1);
});

test('Poller: ohne Verbrauch → Hausverbrauch aus Energiebilanz (PV + Bezug − Einspeisung − Batterie)', async () => {
  const t = dvhubTransport();
  t.ingest('grid_total', 800);     // 800 W Bezug
  t.ingest('pv_total', 3000);
  t.ingest('battery_power', 1500); // lädt mit 1,5 kW
  t.ingest('battery_soc', 40);
  const { state, poller } = makePoller(t, { gridPositiveMeans: 'grid_import' });
  await poller.requestPoll();
  assert.equal(state.victron.selfConsumptionW, 2300, '3000 + 800 − 0 − 1500');
  assert.equal(state.victron.selfConsumptionDerived, true);
  assert.equal(state.victron.errors.selfConsumptionW, undefined);
});

test('Poller: ohne derive-Profil bleibt der Verbrauch leer (keine Ableitung für andere Profile)', async () => {
  const t = dvhubTransport();
  t.ingest('grid_total', 800);
  t.ingest('pv_total', 3000);
  t.ingest('battery_power', 1500);
  t.ingest('battery_soc', 40);
  const { state, poller } = makePoller(t, { derive: null });
  await poller.requestPoll();
  assert.notEqual(state.victron.selfConsumptionW, 2300);
  assert.ok(state.victron.errors.selfConsumptionW);
});

// ── Push-Parser ──────────────────────────────────────────────────────────────

test('parsePushFields: Zahlen (auch Komma), Grenzen, unbekannte Felder als Fehler', () => {
  const r = parsePushFields({ grid_w: '-1200', soc_pct: '55,5', pv_w: 4000, load_w: 'abc', soc2: 1, battery_w: 2e7 });
  assert.deepEqual(r.values.map((v) => [v.field, v.input, v.value]), [
    ['grid_w', 'grid_total', -1200], ['soc_pct', 'battery_soc', 55.5], ['pv_w', 'pv_total', 4000],
  ]);
  assert.deepEqual(r.errors.sort(), ['battery_w: außerhalb -1000000…1000000', 'load_w: keine Zahl', 'soc2: unbekanntes Feld'].sort());
  assert.deepEqual(parsePushFields({ soc_pct: 101 }).errors, ['soc_pct: außerhalb 0…100']);
});

test('Push-Modus ohne Broker: init verbindet nicht, Schreiben ist kein Fehler', async () => {
  let connects = 0;
  const events = [];
  const t = createMqttTransport(
    { host: '', mqtt: { schema: 'dvhub', topicPrefix: 'dvhub' } },
    { connectFn: () => { connects++; throw new Error('darf nicht verbinden'); }, onEvent: (e) => events.push(e) }
  );
  await t.init();
  assert.equal(connects, 0);
  assert.equal(t.brokerMode, 'push-only');
  assert.deepEqual(events, ['mqtt_push_only']);
  assert.equal((await t.mqttWrite('gridSetpointW', -500)).pushOnly, true);
  // Mit Standard-Broker (MQTT-Integration an) wird verbunden
  const t2 = createMqttTransport({ host: '', mqtt: { schema: 'dvhub' } }, { defaultBroker: 'mqtt://127.0.0.1:1', connectFn: () => { connects++; throw new Error('x'); } });
  assert.equal(t2.brokerMode, 'hub');
  await assert.rejects(t2.init());
  assert.equal(connects, 1);
});

test('Energiebilanz: PV ausgefallen (veraltet) → kein frisch gestempelter Verbrauch', async () => {
  const t = dvhubTransport(5000);
  const now = Date.now();
  t.ingest('grid_total', 800, now);
  t.ingest('battery_power', 1500, now);
  t.ingest('battery_soc', 40, now);
  t.ingest('pv_total', 3000, now - 60_000); // PV kommt nicht mehr
  const { state, poller } = makePoller(t, { gridPositiveMeans: 'grid_import' });
  await poller.requestPoll();
  assert.ok(state.victron.errors.pvPowerW, 'PV als Fehler markiert');
  assert.notEqual(state.victron.selfConsumptionDerived, true, 'keine Ableitung aus veralteter PV');
  assert.ok(state.victron.errors.selfConsumptionW, 'Verbrauch bleibt als fehlend markiert');
});

test('Integrations-Broker mitbenutzt: dessen Zugangsdaten werden übernommen, eigene haben Vorrang', async () => {
  const seen = [];
  const fake = (url, opts) => { seen.push({ url, ...opts }); throw new Error('stop'); };
  const t = createMqttTransport({ host: '', mqtt: { schema: 'dvhub' } },
    { defaultBroker: 'mqtt://broker.lan:1883', defaultBrokerAuth: { username: 'hub', password: 'hubpw' }, connectFn: fake });
  await assert.rejects(t.init());
  assert.deepEqual([seen[0].url, seen[0].username, seen[0].password], ['mqtt://broker.lan:1883', 'hub', 'hubpw']);
  const t2 = createMqttTransport({ host: '', mqtt: { schema: 'dvhub', username: 'eigen', password: 'eigenpw' } },
    { defaultBroker: 'mqtt://broker.lan:1883', defaultBrokerAuth: { username: 'hub', password: 'hubpw' }, connectFn: fake });
  await assert.rejects(t2.init());
  assert.deepEqual([seen[1].username, seen[1].password], ['eigen', 'eigenpw']);
  // eigener Broker: Hub-Zugangsdaten werden NICHT an fremde Broker weitergereicht
  const t3 = createMqttTransport({ host: '', mqtt: { schema: 'dvhub', broker: 'mqtt://anderer:1883' } },
    { defaultBroker: 'mqtt://broker.lan:1883', defaultBrokerAuth: { username: 'hub', password: 'hubpw' }, connectFn: fake });
  await assert.rejects(t3.init());
  assert.equal(seen[2].username, undefined);
});
