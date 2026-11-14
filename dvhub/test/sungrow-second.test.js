// Zweiter Sungrow-WR im Master/Slave-Parallelbetrieb (T-0422, zwei WR): NUR LESEND. Steuerung geht laut
// Sungrow-Doku V1.1.11 (Energy-Management, Note) nur an den Master — hier geprüft: der Begleitdienst liest den
// zweiten WR aus und schreibt NIE; nur mit aggregateTelemetry zählt der Master-Regler beide WR zusammen.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSungrowEms, resolveSecondInverter, secondInverterTelemetry, wire, EMS_CMD, EMS_MODE
} from '../services/inverter/sungrow.js';
import { createSungrowSecond } from '../services/inverter/sungrow-second.js';
import { loadSungrowConfig, sungrowImage, mockSungrow, sungrowDevice } from './helpers/sungrow-fixture.js';

const POWER = wire(13052);
const CMD = wire(13051);
const MODE = wire(13050);

// --- resolveSecondInverter (rein) ------------------------------------------------

test('resolveSecondInverter: ohne host nicht aktiv, Standardwerte', () => {
  assert.equal(resolveSecondInverter({}).enabled, false);
  assert.equal(resolveSecondInverter({ sungrow: { secondInverter: {} } }).enabled, false);
  const c = resolveSecondInverter({ sungrow: { secondInverter: { host: ' 192.168.68.83 ' } } });
  assert.deepEqual([c.enabled, c.host, c.port, c.unitId, c.timeoutMs, c.aggregateTelemetry], [true, '192.168.68.83', 502, 1, 1500, false]);
  const o = resolveSecondInverter({ sungrow: { secondInverter: { host: 'x', port: 1502, unitId: 3, timeoutMs: 800, aggregateTelemetry: true } } });
  assert.deepEqual([o.port, o.unitId, o.timeoutMs, o.aggregateTelemetry], [1502, 3, 800, true]);
});

// --- secondInverterTelemetry (rein) ----------------------------------------------

const cfgAgg = { sungrow: { secondInverter: { host: '192.168.68.83', aggregateTelemetry: true } } };
const cfgNoAgg = { sungrow: { secondInverter: { host: '192.168.68.83' } } };

test('secondInverterTelemetry: null ohne aggregateTelemetry, auch wenn Werte da sind', () => {
  const state = { sungrowSecond: { online: true, updatedAt: 1000, batteryPowerW: -500, pvPowerW: 2000, bdcRatedW: 3000 } };
  assert.equal(secondInverterTelemetry(state, cfgNoAgg, { nowMs: 1000 }), null);
});

test('secondInverterTelemetry: Werte nur online + frisch', () => {
  const s = { online: true, updatedAt: 1000, batteryPowerW: -500, pvPowerW: 2000, bdcRatedW: 3000 };
  assert.deepEqual(secondInverterTelemetry({ sungrowSecond: s }, cfgAgg, { nowMs: 1000, maxAgeMs: 20000 }),
    { batteryPowerW: -500, pvPowerW: 2000, bdcRatedW: 3000 });
  // offline → null
  assert.equal(secondInverterTelemetry({ sungrowSecond: { ...s, online: false } }, cfgAgg, { nowMs: 1000 }), null);
  // veraltet → null
  assert.equal(secondInverterTelemetry({ sungrowSecond: s }, cfgAgg, { nowMs: 1000 + 25000, maxAgeMs: 20000 }), null);
  // fehlender Einzelwert bleibt null, die anderen zählen
  assert.deepEqual(secondInverterTelemetry({ sungrowSecond: { ...s, batteryPowerW: null } }, cfgAgg, { nowMs: 1000 }),
    { batteryPowerW: null, pvPowerW: 2000, bdcRatedW: 3000 });
});

// --- Begleitdienst (Poller), NUR LESEND ------------------------------------------

function pollerRig({ host = '192.168.68.83', aggregateTelemetry = false, transport } = {}) {
  const cfg = { sungrow: { secondInverter: host ? { host, aggregateTelemetry } : {} } };
  const state = {};
  const logs = [];
  const clock = 2_000_000;
  const sec = createSungrowSecond(
    { state, getCfg: () => cfg, pushLog: (event, data, level) => logs.push({ event, data, level }) },
    { transport, now: () => clock }
  );
  return { state, logs, sec, cfg };
}

test('Begleitdienst: liest den zweiten WR aus (PV, Akku −scale, SoC, BDC) und schreibt NIE', async () => {
  const image = sungrowImage(); // SH10RT-Abbild: 5214 = −1500 (Laden), 5017 = 70 000 W, 13023 = 57,3 %, 5628 = 10 kW
  const t = mockSungrow(image);
  const r = pollerRig({ transport: t });
  await r.sec.tick();
  const s = r.state.sungrowSecond;
  assert.equal(s.enabled, true);
  assert.equal(s.online, true);
  assert.equal(s.host, '192.168.68.83');
  // Sungrow 5214 = −1500 (negativ = Laden); DVhub-Vorzeichen (+ = Laden) → +1500.
  assert.equal(s.batteryPowerW, 1500);
  assert.equal(s.pvPowerW, 70000);
  assert.equal(s.socPct, 57.3);
  assert.equal(s.bdcRatedW, 10000);
  // Entscheidend: kein einziger Schreibzugriff.
  assert.deepEqual(t.writes, []);
  // Nur FC-4-Lesen.
  assert.ok(t.reads.every((x) => x.fc === 4));
});

test('Begleitdienst: ohne host keine einzige Anfrage', async () => {
  const t = mockSungrow(sungrowImage());
  const r = pollerRig({ host: null, transport: t });
  await r.sec.tick();
  assert.equal(r.state.sungrowSecond.enabled, false);
  assert.deepEqual(t.reads, []);
  assert.deepEqual(t.writes, []);
});

test('Begleitdienst: drei Lesefehler in Folge → offline, keine Werte', async () => {
  let calls = 0;
  const t = { type: 'modbus', reads: [], writes: [], async mbRequest() { calls += 1; throw new Error('modbus timeout'); } };
  const r = pollerRig({ transport: t });
  await r.sec.tick();
  // Solange nicht als online bestätigt, zeigt die Anzeige offline (online !== true) — aber das Offline-Ereignis
  // (Log) fällt erst nach drei Fehlversuchen in Folge, damit ein einzelner Aussetzer nicht flattert.
  assert.equal(r.state.sungrowSecond.online, false);
  assert.ok(!r.logs.some((l) => l.event === 'sungrow_second_offline'));
  await r.sec.tick();
  assert.ok(!r.logs.some((l) => l.event === 'sungrow_second_offline'));
  await r.sec.tick();
  assert.equal(r.state.sungrowSecond.online, false);
  assert.equal(r.state.sungrowSecond.batteryPowerW, null);
  assert.ok(r.logs.some((l) => l.event === 'sungrow_second_offline'));
  assert.ok(calls >= 3);
});

// --- Aggregation im Master-Regler ------------------------------------------------

// Eigenes Rig für den Aktuator mit zweitem WR (Forced mode, damit kein Herzschlag die Writes verschiebt).
function emsRig({ device = sungrowDevice({ bdcRatedW: 3000 }), second = null, aggregateTelemetry = false } = {}) {
  const secondInverter = { host: '192.168.68.83', aggregateTelemetry };
  const cfg = loadSungrowConfig({ gridPositiveMeans: 'grid_import', sungrow: { controlMode: 'forced', heartbeatTimeoutS: 30, secondInverter } });
  const image = sungrowImage();
  const t = mockSungrow(image);
  const clock = 1_000_000;
  const now = () => clock;
  const state = {
    victron: {
      errors: {}, fieldUpdatedAt: { batteryPowerW: clock, pvPowerW: clock, selfConsumptionW: clock },
      device, batteryPowerW: -500, pvPowerW: 0, selfConsumptionW: 500
    },
    meter: { ok: true, updatedAt: clock, grid_total_w: 0 },
    ctrl: {},
    ...(second ? { sungrowSecond: { online: true, updatedAt: clock, ...second } } : {})
  };
  const ems = createSungrowEms({ state, getCfg: () => cfg, transport: t, now });
  return { ems, t, state };
}

test('Regler ohne zweiten WR: Entladen auf die Master-Leistungsgrenze (3 kW) begrenzt', async () => {
  // P = −500 + 0,7·(−6000−0) = −4700 → auf Master-BDC 3000 begrenzt.
  const r = emsRig();
  await r.ems.applySetpoint(-6000, 'rule:abend');
  const pw = r.t.writes.find((w) => w.address === POWER);
  assert.equal(pw.value, 3000);
  assert.ok(r.t.writes.some((w) => w.address === CMD && w.value === EMS_CMD.DISCHARGE));
  assert.ok(r.t.writes.some((w) => w.address === MODE && w.value === EMS_MODE.FORCED));
});

test('Regler mit zweitem WR (aggregateTelemetry): System-Akku + System-Grenze → 5,2 kW', async () => {
  // batteryW = −500 (Master) + −500 (zweiter) = −1000; P = −1000 + 0,7·(−6000) = −5200.
  // Grenze = Master-BDC 3000 + zweiter-BDC 3000 = 6000 → 5200 passt durch.
  const r = emsRig({ second: { batteryPowerW: -500, pvPowerW: 0, bdcRatedW: 3000 }, aggregateTelemetry: true });
  await r.ems.applySetpoint(-6000, 'rule:abend');
  const pw = r.t.writes.find((w) => w.address === POWER);
  assert.equal(pw.value, 5200);
});

test('Regler mit zweitem WR, aber aggregateTelemetry AUS: unverändert wie Master allein (3 kW)', async () => {
  const r = emsRig({ second: { batteryPowerW: -500, pvPowerW: 0, bdcRatedW: 3000 }, aggregateTelemetry: false });
  await r.ems.applySetpoint(-6000, 'rule:abend');
  const pw = r.t.writes.find((w) => w.address === POWER);
  assert.equal(pw.value, 3000);
});

test('Regler: zweiter WR offline → keine Aggregation, Master allein (3 kW)', async () => {
  const r = emsRig({ second: { online: false, batteryPowerW: -500, bdcRatedW: 3000 }, aggregateTelemetry: true });
  // online:false im second-Objekt überschreibt das Rig-Default online:true.
  r.state.sungrowSecond.online = false;
  await r.ems.applySetpoint(-6000, 'rule:abend');
  const pw = r.t.writes.find((w) => w.address === POWER);
  assert.equal(pw.value, 3000);
});
