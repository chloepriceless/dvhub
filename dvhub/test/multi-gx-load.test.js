// test/multi-gx-load.test.js -- Hausverbrauch mit zweiter GX am selben Anschluss
// (Codex-Gegenpruefung Runde 2, 21.10.2026). Die zweite Anlage haengt hinter dem
// Zaehler der Hauptanlage; was ihr Akku laedt oder ins Hausnetz schiebt, steckt
// im gemessenen Verbrauch. Ohne Korrektur zaehlte der Export ihre Entladung als
// zusaetzlichen PV-Ueberschuss, und die Lastprognose lernte ihren Akku mit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPoller } from '../polling.js';
import { createMqttTransport } from '../transport-mqtt.js';

function makePoller({ multiGx = { enabled: true, online: true, batteryPowerW: -1700, socPct: 70 }, channel = 'dev' } = {}) {
  const t = createMqttTransport({ host: '', mqtt: { schema: 'dvhub', topicPrefix: 'dvhub', staleMaxAgeMs: 90000 } });
  t.ingest('grid_total', 0);
  t.ingest('pv_total', 0);
  t.ingest('battery_power', -2300);
  t.ingest('battery_soc', 50);
  t.ingest('consumption_total', 2500); // gemessen: 4,2 kW Haus − 1,7 kW aus der zweiten Anlage
  const state = {
    meter: { ok: false, updatedAt: 0, raw: [], grid_l1_w: 0, grid_l2_w: 0, grid_l3_w: 0, grid_total_w: 0, error: null },
    victron: { errors: {}, updatedAt: 0 },
    dvRegs: new Array(8).fill(0),
    energy: { day: '2026-10-21', importWh: 0, exportWh: 0, costEur: 0, revenueEur: 0, lastTs: 0 },
    multiGx: multiGx ? { ...multiGx, updatedAt: Date.now() } : undefined,
  };
  const cfg = {
    pollMs: 500, gridPositiveMeans: 'grid_import', updateChannel: channel,
    points: { soc: { enabled: true }, batteryPowerW: { enabled: true }, pvPowerW: { enabled: true }, selfConsumptionW: { enabled: true } },
    epex: { timezone: 'UTC' }, userEnergyPricing: {}, dvControl: {},
    multiGx: { enabled: true, host: '10.0.0.6', batteryCapacityWh: 64000, maxChargeW: 10000, maxDischargeW: 10000 },
  };
  const poller = createPoller({
    state, getCfg: () => cfg, transport: t, pushLog: () => {},
    energyPath: '/tmp/multi-gx-load-test.json', onPollComplete: () => {},
    epexNowNext: () => ({ current: { ct_kwh: 0 } }),
  });
  return { state, poller, t };
}

test('Entladung der zweiten Anlage wird dem Hausverbrauch wieder zugerechnet', async () => {
  const { state, poller } = makePoller();
  await poller.requestPoll();
  assert.equal(state.victron.selfConsumptionW, 4200);
  assert.equal(state.victron.selfConsumptionMeasuredW, 2500);
});

test('zweiter Abruf: kein doppelter Abzug', async () => {
  const { state, poller } = makePoller();
  await poller.requestPoll();
  await poller.requestPoll();
  assert.equal(state.victron.selfConsumptionW, 4200);
});

test('zweite Anlage laedt aus dem Hausnetz: das ist kein Hausverbrauch', async () => {
  const { state, poller } = makePoller({ multiGx: { enabled: true, online: true, batteryPowerW: 1000, socPct: 40 } });
  await poller.requestPoll();
  assert.equal(state.victron.selfConsumptionW, 1500);
});

test('zweite Anlage offline, aus oder Stable-Kanal: Verbrauch wie gemessen', async () => {
  for (const opts of [{ multiGx: { enabled: true, online: false, batteryPowerW: null } }, { multiGx: null }, { channel: 'stable' }]) {
    const { state, poller } = makePoller(opts);
    await poller.requestPoll();
    assert.equal(state.victron.selfConsumptionW, 2500, JSON.stringify(opts));
  }
});
