// E6 (Lese-Engine, 18.11.2026): Hauslast aus der Energiebilanz (`derive: 'energy_balance'`) auf Modbus.
// Befund der Lücken-Analyse (Sonde probe-eb.mjs): Takt 1 liefert 2500 W, Takt 2 mit neuen Werten (erwartet 800 W)
// bleibt bei 2500 W stehen — die Bedingung „selfConsumptionW == null“ wird auf Modbus nach dem ersten Takt nie
// wieder wahr, weil bei abgeschaltetem Lastpunkt niemand den Wert zurücksetzt. Für jedes Modbus-Profil ohne
// Lastregister war die Ableitung damit unbrauchbar. Auf MQTT (dvhub-mqtt) setzt readPoint den Wert je Takt neu —
// dort lief sie immer (letzter Test).
import test from 'node:test';
import assert from 'node:assert/strict';

import { createMqttTransport } from '../transport-mqtt.js';
import { createRegisterDevice, createPollerRig } from './helpers/fake-modbus-device.js';

// Registerbild: SoC 100, Akku 101 (s16, + = Laden), PV 102, Netz 200–202 (3×s16, + = Bezug), Last 103 (optional).
function point(address, extra = {}) {
  return { enabled: true, fc: 3, address, quantity: 1, signed: false, scale: 1, offset: 0, unitId: 1, ...extra };
}
function baseCfg({ load = { enabled: false, derive: 'energy_balance' }, battery = true } = {}) {
  return {
    meter: { fc: 3, address: 200, quantity: 3, unitId: 1 },
    points: {
      soc: point(100),
      ...(battery ? { batteryPowerW: point(101, { signed: true }) } : {}),
      pvPowerW: point(102),
      selfConsumptionW: load,
    },
  };
}
function setValues(dev, { pv, battery = 0, grid = [0, 0, 0], load }) {
  dev.set(100, 50).set(101, battery).set(102, pv).setWords(200, grid);
  if (load !== undefined) dev.set(103, load);
}

test('E6: energy_balance folgt auf Modbus jedem Takt (friert nach dem ersten Takt nicht ein)', async () => {
  const dev = createRegisterDevice();
  const { state, poller } = createPollerRig(baseCfg(), dev);

  setValues(dev, { pv: 3000, battery: 500 });
  await poller.requestPoll();
  assert.equal(state.victron.selfConsumptionW, 2500, 'Takt 1: 3000 + 0 − 0 − 500');
  assert.equal(state.victron.selfConsumptionDerived, true);

  setValues(dev, { pv: 1000, battery: 200 });
  await poller.requestPoll();
  assert.equal(state.victron.selfConsumptionW, 800, 'Takt 2: 1000 − 200 — früher blieb 2500 stehen');

  setValues(dev, { pv: 0, battery: -400, grid: [100, 50, 50] });
  await poller.requestPoll();
  assert.equal(state.victron.selfConsumptionW, 600, 'Takt 3: Bezug 200 + Entladen 400');
});

test('E6: Primärableitung ohne Akku-Punkt (PV-Anlage ohne Speicher): Last = PV + Bezug − Einspeisung', async () => {
  const dev = createRegisterDevice();
  const { state, poller } = createPollerRig(baseCfg({ battery: false }), dev);
  setValues(dev, { pv: 4000, grid: [-500, -500, -500] });
  await poller.requestPoll();
  assert.equal(state.victron.selfConsumptionW, 2500, '4000 − 1500 Einspeisung, kein Akku = 0 W');
  setValues(dev, { pv: 1000, grid: [100, 100, 100] });
  await poller.requestPoll();
  assert.equal(state.victron.selfConsumptionW, 1300);
});

test('E6: abgeschalteter Akku-Punkt zählt als „kein Akku“, ein konfigurierter Akku ohne Wert blockiert die Ableitung', async () => {
  const dev = createRegisterDevice();
  const cfg = baseCfg();
  cfg.points.batteryPowerW = { enabled: false };
  const { state, poller } = createPollerRig(cfg, dev);
  setValues(dev, { pv: 2000 });
  await poller.requestPoll();
  assert.equal(state.victron.selfConsumptionW, 2000);

  // Konfigurierter, aber nicht lesbarer Akku: keine Ableitung mit erfundenem 0-W-Akku.
  const dev2 = createRegisterDevice();
  const rig2 = createPollerRig(baseCfg(), dev2);
  dev2.set(100, 50).set(102, 2000).setWords(200, [0, 0, 0]); // 101 (Akku) fehlt
  await rig2.poller.requestPoll();
  assert.equal(rig2.state.victron.selfConsumptionW, undefined);
});

test('E6: gemessene Last hat Vorrang; Lesefehler → Ableitung; danach wieder gemessen', async () => {
  const dev = createRegisterDevice();
  const { state, poller } = createPollerRig(baseCfg({ load: point(103, { derive: 'energy_balance' }) }), dev);

  setValues(dev, { pv: 3000, battery: 500, load: 1234 });
  await poller.requestPoll();
  assert.equal(state.victron.selfConsumptionW, 1234, 'Register gewinnt');
  assert.ok(!state.victron.selfConsumptionDerived);

  // Register 103 antwortet nicht mehr.
  dev.mbRequest = ((orig) => async (conf) => {
    if (conf.address === 103) throw new Error('modbus exception 2');
    return orig(conf);
  })(dev.mbRequest);
  setValues(dev, { pv: 1000, battery: 200 });
  await poller.requestPoll();
  assert.equal(state.victron.selfConsumptionW, 800, 'Rückfall auf die Bilanz');
  assert.equal(state.victron.selfConsumptionDerived, true);
  assert.equal(state.victron.errors.selfConsumptionW, undefined);

  setValues(dev, { pv: 1500, battery: 200 });
  await poller.requestPoll();
  assert.equal(state.victron.selfConsumptionW, 1300, 'Rückfall läuft weiter (zweiter Fehlertakt)');
});

test('E6: fällt ein Eingang aus, bleibt der letzte Wert ohne frischen Stempel (kein erfundener Verbrauch)', async () => {
  const dev = createRegisterDevice();
  const { state, poller } = createPollerRig(baseCfg(), dev);
  setValues(dev, { pv: 3000, battery: 500 });
  await poller.requestPoll();
  const stamp = state.victron.fieldUpdatedAt.selfConsumptionW;
  assert.ok(stamp > 0);

  await new Promise((r) => setTimeout(r, 5));
  dev.mbRequest = ((orig) => async (conf) => {
    if (conf.address === 102) throw new Error('timeout');
    return orig(conf);
  })(dev.mbRequest);
  await poller.requestPoll();
  assert.ok(state.victron.errors.pvPowerW);
  assert.equal(state.victron.fieldUpdatedAt.selfConsumptionW, stamp, 'kein frischer Stempel bei PV-Lesefehler');
});

test('E6: Lastpunkt mit pollEveryMs — übersprungener Takt behält den gemessenen Wert (keine Ableitung drüber)', async () => {
  const dev = createRegisterDevice();
  const { state, poller } = createPollerRig(baseCfg({ load: point(103, { derive: 'energy_balance', pollEveryMs: 60000 }) }), dev);
  setValues(dev, { pv: 3000, battery: 500, load: 1234 });
  await poller.requestPoll();
  assert.equal(state.victron.selfConsumptionW, 1234);
  setValues(dev, { pv: 1000, battery: 200, load: 999 });
  await poller.requestPoll();
  assert.equal(state.victron.selfConsumptionW, 1234, 'Register erst nach 60 s wieder gelesen, Messwert bleibt');
});

// Codex 09829a9f (P2): seit die Ableitung jeden Takt läuft, darf sie keinen veralteten Eingang als frische Last
// stempeln. Ein Eingang mit Lesefehler (gehaltener Wert) blockiert die Ableitung; der Stempel der Last ist der des
// ältesten Eingangs (Akku per pollEveryMs gedrosselt), nicht „jetzt“.
test('E6/Codex: abgeleitete Last trägt das Alter des ältesten Eingangs (Akku per pollEveryMs gedrosselt)', async () => {
  const dev = createRegisterDevice();
  const cfg = baseCfg();
  cfg.points.batteryPowerW.pollEveryMs = 60000;
  const { state, poller } = createPollerRig(cfg, dev);
  setValues(dev, { pv: 3000, battery: 500 });
  await poller.requestPoll();
  const batteryAt = state.victron.fieldUpdatedAt.batteryPowerW;
  assert.ok(batteryAt > 0);
  await new Promise((r) => setTimeout(r, 15));
  setValues(dev, { pv: 1000, battery: 200 });
  await poller.requestPoll();
  assert.equal(state.victron.fieldUpdatedAt.batteryPowerW, batteryAt, 'Akku in Takt 2 nicht gelesen');
  assert.equal(state.victron.selfConsumptionW, 500, '1000 − gehaltene 500');
  assert.equal(state.victron.fieldUpdatedAt.selfConsumptionW, batteryAt, 'Last so alt wie der Akkuwert, nicht frisch');
});

test('E6/Codex: AC-PV-Lesefehler mit gehaltenem Wert blockiert die Ableitung (kein frischer Verbrauch aus Altwert)', async () => {
  const dev = createRegisterDevice();
  const cfg = baseCfg();
  cfg.points.acPvL1W = point(104);
  const { state, poller } = createPollerRig(cfg, dev);
  setValues(dev, { pv: 3000, battery: 500 });
  dev.set(104, 700);
  await poller.requestPoll();
  assert.equal(state.victron.selfConsumptionW, 3200, '3000 + 700 − 500');
  const stamp = state.victron.fieldUpdatedAt.selfConsumptionW;

  await new Promise((r) => setTimeout(r, 15));
  dev.mbRequest = ((orig) => async (conf) => {
    if (conf.address === 104) throw new Error('timeout');
    return orig(conf);
  })(dev.mbRequest);
  setValues(dev, { pv: 1000, battery: 200 });
  await poller.requestPoll();
  assert.ok(state.victron.errors.acPvL1W);
  assert.equal(state.victron.acPvL1W, 700, 'pollPoint hält den alten AC-PV-Wert');
  assert.equal(state.victron.selfConsumptionW, 3200, 'keine Ableitung mit dem gehaltenen AC-PV-Wert');
  assert.equal(state.victron.fieldUpdatedAt.selfConsumptionW, stamp, 'kein frischer Stempel');
});

// Codex 1bce7fc9 (P2): fällt die Ableitung aus (Eingang fehlerhaft), darf die gehaltene, abgeleitete Last nicht als
// gemessen gelten — sonst rechnet eine pollEveryMs-Pause des Lastpunkts nach der Erholung nicht neu.
test('E6/Codex: Lastpunkt mit pollEveryMs — nach AC-PV-Ausfall und Erholung wird innerhalb der Pause neu abgeleitet', async () => {
  const dev = createRegisterDevice();
  const cfg = baseCfg({ load: point(103, { derive: 'energy_balance', pollEveryMs: 60000 }) });
  cfg.points.acPvL1W = point(104);
  const { state, poller } = createPollerRig(cfg, dev);
  let failAcPv = false;
  dev.mbRequest = ((orig) => async (conf) => {
    if (conf.address === 103) throw new Error('modbus exception 2'); // Lastregister liefert nie
    if (conf.address === 104 && failAcPv) throw new Error('timeout');
    return orig(conf);
  })(dev.mbRequest);

  setValues(dev, { pv: 3000, battery: 500 });
  dev.set(104, 700);
  await poller.requestPoll();
  assert.equal(state.victron.selfConsumptionW, 3200, 'Takt 1: Rückfall auf die Bilanz');

  failAcPv = true; // Takt 2: Lastpunkt pausiert (pollEveryMs), AC-PV fällt aus → keine Ableitung
  await poller.requestPoll();
  assert.equal(state.victron.selfConsumptionW, 3200);
  assert.equal(state.victron.selfConsumptionDerived, true, 'gehaltener Wert bleibt als abgeleitet markiert');

  failAcPv = false; // Takt 3: AC-PV erholt, neue Werte, Lastpunkt weiter in der Pause
  setValues(dev, { pv: 1000, battery: 200 });
  await poller.requestPoll();
  assert.equal(state.victron.selfConsumptionW, 1500, '1000 + 700 − 200 — nicht die gehaltenen 3200');
});

test('dvhub-mqtt (ausgeliefert): energy_balance auf MQTT folgt jedem Takt — war vom Modbus-Befund nicht betroffen', async () => {
  const t = createMqttTransport({ host: '', mqtt: { schema: 'dvhub', topicPrefix: 'dvhub', staleMaxAgeMs: 90000 } });
  const cfg = {
    points: {
      soc: { enabled: true }, batteryPowerW: { enabled: true }, pvPowerW: { enabled: true },
      selfConsumptionW: { enabled: true, derive: 'energy_balance' },
    },
  };
  const { state, poller } = createPollerRig(cfg, t);
  t.ingest('grid_total', 800); t.ingest('pv_total', 3000); t.ingest('battery_power', 1500); t.ingest('battery_soc', 40);
  await poller.requestPoll();
  assert.equal(state.victron.selfConsumptionW, 2300);
  t.ingest('grid_total', 0); t.ingest('pv_total', 1000); t.ingest('battery_power', 200);
  await poller.requestPoll();
  assert.equal(state.victron.selfConsumptionW, 800);
  t.ingest('consumption_total', 4321);
  await poller.requestPoll();
  assert.equal(state.victron.selfConsumptionW, 4321, 'gelieferter Verbrauch gewinnt wieder');
});
