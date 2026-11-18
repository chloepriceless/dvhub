// E14 (Lese-Engine, 18.11.2026): Kleinigkeiten im Lesepfad.
//  (a) wordOrder: der Schreibpfad (schedule-eval normWordOrder) liest swap/swapped als „Low-Wort zuerst“, der
//      Lesepfad las dieselbe Schreibweise als High-Wort zuerst — ein Profil hätte mit einer Schreibweise je Richtung
//      verschiedene Werte gesehen.
//  (b) applyVictronDefaults zwang die acPv*-Adressen (808–810 bzw. acPvSource-Block) und die pvCoupling-Wirkung auf
//      JEDES Profil. Ein Fremdprofil mit eigenem acPvL1W hätte Register 808 am fremden Gerät gelesen, und
//      pvCoupling „Nur AC“ schaltete bei Fronius/Sungrow/Deye die PV ganz ab. Das gilt jetzt nur für das
//      Victron-Datenmodell: Profil victron oder MQTT-Transport (dort adressiert die Adresse nichts, und die Punktnamen
//      sind das Venus/DVhub-Schema, für das pvCoupling gedacht ist).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfigFile } from '../config-model.js';
import { createRegisterDevice, createPollerRig } from './helpers/fake-modbus-device.js';

// ── (a) Wortreihenfolge ─────────────────────────────────────────────────────────────────────────────────────────

test('E14a: wordOrder swap/swapped liest Low-Wort zuerst (int32, uint32, float32) wie der Schreibpfad', async () => {
  const dev = createRegisterDevice();
  dev.set32(10, -123456, { wordOrder: 'le' });
  dev.set32(20, 3000000, { wordOrder: 'le' });
  dev.setFloat32(30, 1234.5, { wordOrder: 'le' });
  dev.set(40, 50);
  const p = (address, extra) => ({ enabled: true, fc: 3, address, quantity: 2, scale: 1, offset: 0, unitId: 1, ...extra });
  const cfg = {
    meter: { fc: 3, address: 300, quantity: 3, unitId: 1 },
    points: {
      soc: { enabled: true, fc: 3, address: 40, quantity: 1, unitId: 1 },
      batteryPowerW: p(10, { readType: 'int32', wordOrder: 'swap' }),
      pvPowerW: p(20, { readType: 'uint32', wordOrder: 'swapped' }),
      selfConsumptionW: p(30, { readType: 'float32', wordOrder: 'SWAPPED' }),
    },
  };
  dev.setWords(300, [0, 0, 0]);
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.equal(state.victron.batteryPowerW, -123456);
  assert.equal(state.victron.pvPowerW, 3000000);
  assert.equal(state.victron.selfConsumptionW, 1234.5);
});

test('E14a: Bestandsschreibweisen unverändert (be, le, little, lsw, fehlend)', async () => {
  const dev = createRegisterDevice();
  dev.set32(10, 70000, { wordOrder: 'be' }).set32(20, 70000, { wordOrder: 'le' }).set32(30, 70000, { wordOrder: 'le' });
  dev.set32(40, 70000, { wordOrder: 'le' }).set32(50, 70000, { wordOrder: 'be' }).setWords(300, [0, 0, 0]);
  const p = (address, wordOrder) => ({ enabled: true, fc: 3, address, quantity: 2, readType: 'uint32', unitId: 1, ...(wordOrder ? { wordOrder } : {}) });
  const cfg = {
    meter: { fc: 3, address: 300, quantity: 3, unitId: 1 },
    points: { soc: p(10, 'be'), batteryPowerW: p(20, 'le'), pvPowerW: p(30, 'little'), selfConsumptionW: p(40, 'lsw'), minSocPct: p(50) },
  };
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  for (const f of ['soc', 'batteryPowerW', 'pvPowerW', 'selfConsumptionW', 'minSocPct']) assert.equal(state.victron[f], 70000, f);
});

test('E14a: Zähler int32 und float32 mit wordOrder swap lesen Low-Wort zuerst (auch das Ersatzregister)', async () => {
  const dev = createRegisterDevice();
  // int32-Block [Summe, L1, L2, L3], Low-Wort zuerst.
  [1500, 500, 400, 600].forEach((w, i) => dev.set32(100 + i * 2, w, { wordOrder: 'le' }));
  const { state, poller } = createPollerRig({ meter: { fc: 3, address: 100, quantity: 8, readType: 'int32', wordOrder: 'swap', unitId: 1 } }, dev);
  await poller.requestPoll();
  assert.equal(state.meter.ok, true, state.meter.error);
  assert.equal(state.meter.grid_total_w, 1500);
  assert.equal(state.meter.grid_l3_w, 600);

  const dev2 = createRegisterDevice();
  [-2500.5, -800, -900, -800.5].forEach((w, i) => dev2.setFloat32(200 + i * 2, w, { wordOrder: 'le' }));
  const rig2 = createPollerRig({ meter: { fc: 3, address: 200, quantity: 8, readType: 'float32', wordOrder: 'swapped', unitId: 1 } }, dev2);
  await rig2.poller.requestPoll();
  assert.equal(rig2.state.meter.ok, true, rig2.state.meter.error);
  assert.equal(rig2.state.meter.grid_total_w, Math.round(-2500.5));

  // Ersatzregister: Block meldet keinen Wert (Exception 2) → fallback mit eigener wordOrder swap.
  const dev3 = createRegisterDevice();
  dev3.set32(13009, 1200, { wordOrder: 'le' });
  const rig3 = createPollerRig({ meter: { fc: 3, address: 100, quantity: 8, readType: 'int32', unitId: 1, fallback: { fc: 3, address: 13009, scale: -1, wordOrder: 'swap' } } }, dev3);
  await rig3.poller.requestPoll();
  assert.equal(rig3.state.meter.ok, true, rig3.state.meter.error);
  assert.equal(rig3.state.meter.grid_total_w, -1200, 'Einspeisung 1200 W (scale −1) aus Low-Wort-zuerst');
});

// ── (b) acPv*-Adressen und pvCoupling nur im Victron-Datenmodell ────────────────────────────────────────────────

function effectiveWith(profileId, profile, config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-e14-'));
  try {
    fs.mkdirSync(path.join(dir, 'hersteller'));
    if (profile) fs.writeFileSync(path.join(dir, 'hersteller', `${profileId}.json`), JSON.stringify(profile));
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ manufacturer: profileId, victron: { host: '192.0.2.5' }, ...config }));
    return loadConfigFile(path.join(dir, 'config.json'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const FOREIGN = {
  readOnly: true,
  victron: { transport: 'modbus', port: 502, unitId: 1, timeoutMs: 2000 },
  meter: { fc: 3, address: 1000, quantity: 1 },
  points: {
    pvPowerW: { enabled: true, fc: 3, address: 2000, quantity: 1 },
    acPvL1W: { enabled: true, fc: 3, address: 5001, quantity: 1 },
    acPvL2W: { enabled: true, fc: 3, address: 5002, quantity: 1 },
    acPvL3W: { enabled: true, fc: 3, address: 5003, quantity: 1 },
    acPv2L1W: { enabled: true, fc: 3, address: 6001, quantity: 1 },
  },
};

test('E14b: Fremdprofil behält eigene acPv*-Adressen (kein 808 am fremden Gerät), auch mit acPvSource', () => {
  for (const acPvSource of [undefined, 'grid', 'genset']) {
    const { effectiveConfig: c } = effectiveWith('fremd-ro', FOREIGN, { victron: { host: '192.0.2.5', ...(acPvSource ? { acPvSource } : {}) } });
    assert.equal(c.points.acPvL1W.address, 5001, `acPvSource=${acPvSource}`);
    assert.equal(c.points.acPvL2W.address, 5002);
    assert.equal(c.points.acPvL3W.address, 5003);
    assert.equal(c.points.acPv2L1W.address, 6001);
    assert.equal(c.points.acPv2L1W.enabled, true, 'acPvSource2 schaltet fremde Punkte nicht ab');
  }
});

test('E14b: pvCoupling wirkt bei Fremdprofilen nicht (PV bleibt gelesen)', () => {
  const ac = effectiveWith('fremd-ro', FOREIGN, { pvCoupling: 'ac' }).effectiveConfig;
  assert.equal(ac.points.pvPowerW.enabled, true, '„Nur AC“ schaltet die PV des Fremdgeräts nicht ab');
  const dc = effectiveWith('fremd-ro', FOREIGN, { pvCoupling: 'dc' }).effectiveConfig;
  assert.equal(dc.points.acPvL1W.enabled, true);
});

test('E14b: Victron-Profil und MQTT-Profile behalten die Victron-Wirkung (808/811, pvCoupling)', () => {
  const victron = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'hersteller', 'victron.json'), 'utf8'));
  const v = effectiveWith('victron', victron, { pvCoupling: 'ac', victron: { host: '192.0.2.5', acPvSource: 'grid' } }).effectiveConfig;
  assert.equal(v.points.acPvL1W.address, 811);
  assert.equal(v.points.pvPowerW.enabled, false);

  const mqttProfile = {
    victron: { transport: 'mqtt', mqtt: { broker: '', portalId: 'dvhub' } },
    points: { pvPowerW: { enabled: true }, acPvL1W: { enabled: true }, acPvL2W: { enabled: true }, acPvL3W: { enabled: true } },
  };
  const m = effectiveWith('mqtt-x', mqttProfile, { pvCoupling: 'dc' }).effectiveConfig;
  assert.equal(m.points.acPvL1W.enabled, false, 'pvCoupling dc schaltet AC-PV auf MQTT weiter ab');
  assert.equal(m.points.acPvL1W.address, 808, 'Adresse wie bisher (auf MQTT ohne Wirkung)');
});
