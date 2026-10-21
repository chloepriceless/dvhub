// test/multi-gx-flow-split.test.js -- Energiefluss-Aufteilung mit zweiter GX am
// selben Anschluss (Chrissi 21.10.2026: „kannst die Akkus dort getrennt
// aufzeigen“). Akku 2 ist eine eigene Groesse: PV = direkt + Akku 1 + Akku 2 +
// Netz und Last = PV direkt + Netz direkt + Akku 1 + Akku 2 muessen aufgehen.
// Ohne zweite Anlage rechnet alles bitgenau wie vorher.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPoller } from '../polling.js';
import { createMqttTransport } from '../transport-mqtt.js';

function makePoller({ gridW, pvW, batteryW, consumptionW, multiGx }) {
  const t = createMqttTransport({ host: '', mqtt: { schema: 'dvhub', topicPrefix: 'dvhub', staleMaxAgeMs: 90000 } });
  t.ingest('grid_total', gridW);
  t.ingest('pv_total', pvW);
  t.ingest('battery_power', batteryW);
  t.ingest('battery_soc', 50);
  t.ingest('consumption_total', consumptionW);
  const state = {
    meter: { ok: false, updatedAt: 0, raw: [], grid_l1_w: 0, grid_l2_w: 0, grid_l3_w: 0, grid_total_w: 0, error: null },
    victron: { errors: {}, updatedAt: 0 },
    dvRegs: new Array(8).fill(0),
    energy: { day: '2026-10-21', importWh: 0, exportWh: 0, costEur: 0, revenueEur: 0, lastTs: 0 },
    multiGx: multiGx ? { ...multiGx, updatedAt: Date.now() } : undefined,
  };
  const cfg = {
    pollMs: 500, gridPositiveMeans: 'grid_import', updateChannel: 'dev',
    points: { soc: { enabled: true }, batteryPowerW: { enabled: true }, pvPowerW: { enabled: true }, selfConsumptionW: { enabled: true } },
    epex: { timezone: 'UTC' }, userEnergyPricing: {}, dvControl: {},
    multiGx: { enabled: true, host: '10.0.0.6', batteryCapacityWh: 64000, maxChargeW: 10000, maxDischargeW: 10000 },
  };
  const poller = createPoller({
    state, getCfg: () => cfg, transport: t, pushLog: () => {},
    energyPath: '/tmp/multi-gx-flow-split-test.json', onPollComplete: () => {},
    epexNowNext: () => ({ current: { ct_kwh: 0 } }),
  });
  return { state, poller };
}

const near = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 1e-6, `${msg}: ${actual} != ${expected}`);

// Bilanz je Knoten: jede Quelle und jede Senke wird vollstaendig verteilt.
function assertBalanced(v, { pvW, importW, exportW, loadW, c1, d1, c2, d2 }) {
  near(v.solarDirectUseW + v.solarToBatteryW + v.secondSolarToBatteryW + v.solarToGridW, pvW, 'PV');
  near(v.solarDirectUseW + v.gridDirectUseW + v.batteryDirectUseW + v.secondBatteryDirectUseW, loadW, 'Last');
  near(v.gridDirectUseW + v.gridToBatteryW + v.secondGridToBatteryW, importW, 'Bezug');
  near(v.solarToGridW + v.batteryToGridW + v.secondBatteryToGridW, exportW, 'Einspeisung');
  near(v.solarToBatteryW + v.gridToBatteryW, c1, 'Akku 1 laden');
  near(v.batteryDirectUseW + v.batteryToGridW, d1, 'Akku 1 entladen');
  near(v.secondSolarToBatteryW + v.secondGridToBatteryW, c2, 'Akku 2 laden');
  near(v.secondBatteryDirectUseW + v.secondBatteryToGridW, d2, 'Akku 2 entladen');
}

test('PV laedt beide Akkus: Aufteilung nach Ladeleistung, PV-Bilanz geht auf', async () => {
  // Haus 1000 W, Akku 1 +2000 W, Akku 2 +1500 W, PV 5000 W → 500 W Einspeisung.
  // Gemessen wird Haus + Akku 2 (haengt hinter dem Zaehler): 2500 W.
  const { state, poller } = makePoller({
    gridW: -500, pvW: 5000, batteryW: 2000, consumptionW: 2500,
    multiGx: { enabled: true, online: true, batteryPowerW: 1500, socPct: 70 },
  });
  await poller.requestPoll();
  const v = state.victron;
  assert.equal(v.selfConsumptionW, 1000);
  assert.equal(v.batteryChargeW, 2000);
  assert.equal(v.secondBatteryChargeW, 1500);
  assert.equal(v.secondBatteryDischargeW, 0);
  assert.equal(v.secondBatterySocPct, 70);
  near(v.solarToBatteryW, 2000, 'PV → Akku 1');
  near(v.secondSolarToBatteryW, 1500, 'PV → Akku 2');
  near(v.solarToGridW, 500, 'PV → Netz');
  near(v.solarDirectUseW, 1000, 'PV direkt');
  assertBalanced(v, { pvW: 5000, importW: 0, exportW: 500, loadW: 1000, c1: 2000, d1: 0, c2: 1500, d2: 0 });
});

test('beide Akkus speisen ein: Einspeisung und Hausversorgung anteilig nach Entladeleistung', async () => {
  // Haus 3000 W, Akku 1 −3000 W, Akku 2 −2000 W, keine PV → 2000 W Einspeisung.
  // Gemessen: Haus − Akku 2 = 1000 W.
  const { state, poller } = makePoller({
    gridW: -2000, pvW: 0, batteryW: -3000, consumptionW: 1000,
    multiGx: { enabled: true, online: true, batteryPowerW: -2000, socPct: 55 },
  });
  await poller.requestPoll();
  const v = state.victron;
  assert.equal(v.selfConsumptionW, 3000);
  assert.equal(v.secondBatteryDischargeW, 2000);
  assert.equal(v.secondBatteryChargeW, 0);
  near(v.batteryToGridW, 1200, 'Akku 1 → Netz');
  near(v.secondBatteryToGridW, 800, 'Akku 2 → Netz');
  near(v.batteryDirectUseW, 1800, 'Akku 1 → Haus');
  near(v.secondBatteryDirectUseW, 1200, 'Akku 2 → Haus');
  near(v.solarToGridW, 0, 'PV → Netz');
  assertBalanced(v, { pvW: 0, importW: 0, exportW: 2000, loadW: 3000, c1: 0, d1: 3000, c2: 0, d2: 2000 });
});

test('Netzladung beider Akkus: Bezug anteilig auf beide, Rest direkt ins Haus', async () => {
  // Haus 500 W, Akku 1 +2000 W, Akku 2 +1500 W aus dem Netz: 4000 W Bezug.
  const { state, poller } = makePoller({
    gridW: 4000, pvW: 0, batteryW: 2000, consumptionW: 2000,
    multiGx: { enabled: true, online: true, batteryPowerW: 1500, socPct: 30 },
  });
  await poller.requestPoll();
  const v = state.victron;
  assert.equal(v.selfConsumptionW, 500);
  near(v.gridToBatteryW, 2000, 'Netz → Akku 1');
  near(v.secondGridToBatteryW, 1500, 'Netz → Akku 2');
  near(v.gridDirectUseW, 500, 'Netz direkt');
  assertBalanced(v, { pvW: 0, importW: 4000, exportW: 0, loadW: 500, c1: 2000, d1: 0, c2: 1500, d2: 0 });
});

test('Akku 2 entlaedt ins Haus, Akku 1 laedt aus PV', async () => {
  // Haus 2500 W, PV 3000 W, Akku 1 +2000 W, Akku 2 −1500 W → Bilanz 0 W am Zaehler.
  // Gemessen: 2500 − 1500 = 1000 W.
  const { state, poller } = makePoller({
    gridW: 0, pvW: 3000, batteryW: 2000, consumptionW: 1000,
    multiGx: { enabled: true, online: true, batteryPowerW: -1500, socPct: 80 },
  });
  await poller.requestPoll();
  const v = state.victron;
  assert.equal(v.selfConsumptionW, 2500);
  near(v.solarToBatteryW, 2000, 'PV → Akku 1');
  near(v.secondSolarToBatteryW, 0, 'PV → Akku 2');
  near(v.secondBatteryDirectUseW, 1500, 'Akku 2 → Haus');
  near(v.solarDirectUseW, 1000, 'PV direkt');
  assertBalanced(v, { pvW: 3000, importW: 0, exportW: 0, loadW: 2500, c1: 2000, d1: 0, c2: 0, d2: 1500 });
});

// Die Formeln von vor dem 21.10.2026, unveraendert abgeschrieben.
function legacySplit(v) {
  const loadW = Math.max(0, Number(v.selfConsumptionW || 0));
  const pvTotalW = Math.max(0, Number(v.pvTotalW || 0));
  const gridImportW = Math.max(0, Number(v.gridImportW || 0));
  const gridExportW = Math.max(0, Number(v.gridExportW || 0));
  const batteryChargeW = Math.max(0, Number(v.batteryChargeW || 0));
  const batteryDischargeW = Math.max(0, Number(v.batteryDischargeW || 0));
  const solarToBatteryW = Math.max(0, Math.min(pvTotalW, batteryChargeW));
  const gridToBatteryW = Math.max(0, batteryChargeW - solarToBatteryW);
  const batteryToGridW = Math.max(0, Math.min(batteryDischargeW, gridExportW));
  const batteryDirectUseW = Math.max(0, batteryDischargeW - batteryToGridW);
  const gridDirectUseW = Math.max(0, gridImportW - gridToBatteryW);
  const solarToGridW = Math.max(0, gridExportW - batteryToGridW);
  const solarDirectUseW = Math.max(0, Math.min(pvTotalW, Math.max(0, loadW - gridDirectUseW - batteryDirectUseW)));
  return { solarDirectUseW, solarToBatteryW, solarToGridW, gridDirectUseW, gridToBatteryW, batteryDirectUseW, batteryToGridW };
}

test('ohne zweite Anlage (aus, offline, veraltet): Aufteilung bitgenau wie bisher, Akku-2-Felder null', async () => {
  const cases = [
    { gridW: 77.7, pvW: 3333.3, batteryW: -1234.5, consumptionW: 4000.1 },
    { gridW: -812.25, pvW: 6123.4, batteryW: 2711.9, consumptionW: 2599.25 },
    { gridW: 2100.3, pvW: 0, batteryW: 1700.1, consumptionW: 400.2 },
    { gridW: -1999.9, pvW: 0, batteryW: -3100.7, consumptionW: 1100.8 },
  ];
  const followers = [
    undefined,
    { enabled: true, online: false, batteryPowerW: 1500, socPct: 40 },
    { enabled: true, online: true, batteryPowerW: null, socPct: 40 },
  ];
  for (const c of cases) {
    for (const multiGx of followers) {
      const { state, poller } = makePoller({ ...c, multiGx });
      await poller.requestPoll();
      const v = state.victron;
      const expected = legacySplit(v);
      for (const [k, val] of Object.entries(expected)) {
        assert.equal(v[k], val, `${k} ${JSON.stringify({ c, multiGx })}`);
      }
      for (const k of ['secondBatteryChargeW', 'secondBatteryDischargeW', 'secondSolarToBatteryW', 'secondGridToBatteryW',
        'secondBatteryToGridW', 'secondBatteryDirectUseW', 'secondBatterySocPct']) {
        assert.equal(v[k], null, `${k} ${JSON.stringify({ c, multiGx })}`);
      }
    }
  }
});

test('veralteter Wert der zweiten Anlage (> 20 s): keine Akku-2-Felder', async () => {
  const { state, poller } = makePoller({
    gridW: -500, pvW: 5000, batteryW: 2000, consumptionW: 2500,
    multiGx: { enabled: true, online: true, batteryPowerW: 1500, socPct: 70 },
  });
  state.multiGx.updatedAt = Date.now() - 60000;
  await poller.requestPoll();
  assert.equal(state.victron.secondBatteryChargeW, null);
  assert.equal(state.victron.secondBatterySocPct, null);
  assert.equal(state.victron.selfConsumptionW, 2500);
});

test('zweite Anlage eingebunden, aber ruhig: Akku-2-Felder 0 statt null, Ladestand gesetzt', async () => {
  const { state, poller } = makePoller({
    gridW: 300, pvW: 0, batteryW: 0, consumptionW: 300,
    multiGx: { enabled: true, online: true, batteryPowerW: 0, socPct: 64 },
  });
  await poller.requestPoll();
  const v = state.victron;
  assert.equal(v.secondBatteryChargeW, 0);
  assert.equal(v.secondBatteryDischargeW, 0);
  assert.equal(v.secondBatteryDirectUseW, 0);
  assert.equal(v.secondBatterySocPct, 64);
});

test('Laufzeit-Schnappschuss traegt die Akku-2-Felder zur Weboberflaeche', async () => {
  const { buildVictronSnapshot } = await import('../runtime-state.js');
  const fields = {
    secondBatteryChargeW: 1500, secondBatteryDischargeW: 0, secondSolarToBatteryW: 1500, secondGridToBatteryW: 0,
    secondBatteryToGridW: 0, secondBatteryDirectUseW: 0, secondBatterySocPct: 70,
  };
  const snap = buildVictronSnapshot({ ...fields, errors: {} });
  for (const [k, val] of Object.entries(fields)) assert.equal(snap[k], val, k);
});
