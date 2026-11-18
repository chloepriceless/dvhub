// E11 (Lese-Engine, 18.11.2026): SunSpec-Scan auf der eigenen Unit-ID/dem eigenen Port des Lesepunkts statt fest auf
// victron.unitId. SMA: eigene Register auf Unit 3, SunSpec auf Unit 126; LG: SunSpec auf Port 6502/Unit 255; ein
// SunSpec-Zähler hat oft eine eigene Unit (Fronius-Zähler 200). Ein SunSpec-Lesepunkt wird auf genau der Verbindung
// gescannt, von der er gelesen wird: seine effektive host/port/unitId (Standard: victron.*). Schreibziele
// (controlWrite) scannen unverändert auf victron.* — der Schreibpfad bleibt, wie er ist.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createRegisterDevice, createPollerRig } from './helpers/fake-modbus-device.js';

function chain(dev, unitId) {
  const at = dev.setSunspecChain(40000, [{ id: 1, length: 66 }, { id: 103, length: 50 }], { unitId });
  return at[103][0];
}

test('E11: SunSpec-Punkte auf Unit 126 werden dort gescannt und gelesen, SMA-eigene Punkte bleiben auf Unit 3', async () => {
  const dev = createRegisterDevice();
  const b = chain(dev, 126);
  dev.set(b + 14, 3000, { unitId: 126 }).set(b + 15, 0, { unitId: 126 });
  dev.set32(30845, 61, { unitId: 3 }); // SoC (SMA-eigen, U32)
  dev.setWords(900, [0, 0, 0], { unitId: 3 });
  const cfg = {
    victron: { host: '192.0.2.20', port: 502, unitId: 3, timeoutMs: 1000 },
    meter: { fc: 3, address: 900, quantity: 3, unitId: 3 },
    points: {
      soc: { enabled: true, fc: 3, address: 30845, quantity: 2, readType: 'uint32', unitId: 3 },
      pvPowerW: { enabled: true, fc: 3, quantity: 1, unitId: 126, sunspec: { model: 103, offset: 14, sfOffset: 15 } },
    },
  };
  const { state, poller, logs } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.equal(state.victron.soc, 61);
  assert.equal(state.victron.pvPowerW, 3000);
  assert.equal(cfg.points.pvPowerW.address, b + 14);
  const scanReqs = dev.requests.filter((r) => r.address === 40000 || (r.address > 40000 && r.address < b));
  assert.ok(scanReqs.length > 0 && scanReqs.every((r) => r.unitId === 126), 'Scan nur auf Unit 126');
  const ok = logs.find((l) => l.event === 'sunspec_scan_ok');
  assert.equal(ok.data.unitId, 126, 'Log nennt die abweichende Unit');
});

test('E11: eigener Port (LG 6502/Unit 255) wird für Scan und Lesen verwendet', async () => {
  const dev = createRegisterDevice();
  const b = chain(dev, 255);
  dev.set(b + 31, 1200, { unitId: 255 }).set(b + 32, 0, { unitId: 255 }).setWords(900, [0, 0, 0]);
  const cfg = {
    victron: { host: '192.0.2.30', port: 502, unitId: 1, timeoutMs: 1000 },
    meter: { fc: 3, address: 900, quantity: 3, unitId: 1 },
    points: { pvPowerW: { enabled: true, fc: 3, quantity: 1, port: 6502, unitId: 255, sunspec: { model: 103, offset: 31, sfOffset: 32 } } },
  };
  const { state, poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.equal(state.victron.pvPowerW, 1200);
  const sunspecReqs = dev.requests.filter((r) => r.address >= 40000);
  assert.ok(sunspecReqs.every((r) => r.port === 6502 && r.unitId === 255));
});

test('E11: zwei Verbindungen — eine ohne SunSpec blockiert die andere nicht; Neuversuch je Verbindung nach 60 s', async () => {
  const dev = createRegisterDevice();
  const b = chain(dev, 126);
  dev.set(b + 14, 500, { unitId: 126 }).set(b + 15, 0, { unitId: 126 }).setWords(900, [0, 0, 0]);
  const cfg = {
    victron: { host: '192.0.2.20', port: 502, unitId: 3, timeoutMs: 1000 },
    meter: { fc: 3, address: 900, quantity: 3, unitId: 1 },
    points: {
      pvPowerW: { enabled: true, fc: 3, quantity: 1, unitId: 126, sunspec: { model: 103, offset: 14, sfOffset: 15 } },
      batteryPowerW: { enabled: true, fc: 3, quantity: 1, unitId: 127, sunspec: { model: 802, offset: 3 } },
    },
  };
  const { state, poller, logs } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.equal(state.victron.pvPowerW, 500);
  assert.equal(cfg.points.batteryPowerW.address, undefined, 'Unit 127 ohne SunSpec: schläft');
  const err = logs.find((l) => l.event === 'sunspec_scan_error');
  assert.equal(err.data.unitId, 127);
  const before = dev.requests.length;
  await poller.requestPoll();
  assert.equal(dev.requests.filter((r, i) => i >= before && r.unitId === 127).length, 0, 'kein Neuversuch vor 60 s');
});

test('E11: Standard ohne eigene Unit — ein Scan auf victron.unitId wie bisher (Fronius), M160-Basis gemerkt', async () => {
  const dev = createRegisterDevice();
  const at = dev.setSunspecChain(40000, [{ id: 1, length: 66 }, { id: 124, length: 24 }, { id: 160, length: 88 }]);
  dev.set(at[124][0] + 6, 5500).setWords(900, [0, 0, 0]);
  const cfg = {
    victron: { host: '192.0.2.40', port: 502, unitId: 1, timeoutMs: 1000 },
    meter: { fc: 3, address: 900, quantity: 3, unitId: 1 },
    points: { soc: { enabled: true, fc: 3, quantity: 1, scale: 0.01, host: '192.0.2.40', port: 502, unitId: 1, timeoutMs: 1000, sunspec: { model: 124, offset: 6 } } },
  };
  const { state, poller, logs } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.equal(state.victron.soc, 55);
  assert.equal(state.ctrl._sunspecM160.address, at[160][0]);
  const scans = logs.filter((l) => l.event === 'sunspec_scan_ok');
  assert.equal(scans.length, 1);
  assert.deepEqual(Object.keys(scans[0].data).sort(), ['base', 'missing', 'models'], 'Log-Inhalt wie bisher');
});

test('E11: Schreibziel mit eigener Unit scannt weiter auf victron.* (Schreibpfad unverändert)', async () => {
  const dev = createRegisterDevice();
  const at = dev.setSunspecChain(40000, [{ id: 1, length: 66 }, { id: 124, length: 24 }], { unitId: 1 });
  dev.setWords(900, [0, 0, 0]);
  const cfg = {
    victron: { host: '192.0.2.40', port: 502, unitId: 1, timeoutMs: 1000 },
    meter: { fc: 3, address: 900, quantity: 3, unitId: 1 },
    points: {},
    controlWrite: { minSocPct: { enabled: true, unitId: 9, sunspec: { model: 124, offset: 5 } } },
  };
  const { poller } = createPollerRig(cfg, dev);
  await poller.requestPoll();
  assert.equal(cfg.controlWrite.minSocPct.address, at[124][0] + 5);
  assert.equal(cfg.controlWrite.minSocPct.unitId, 9, 'Unit des Schreibziels bleibt unangetastet');
  assert.ok(dev.requests.filter((r) => r.address >= 40000).every((r) => r.unitId === 1));
});
