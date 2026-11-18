// Golden-Master für das Node-Schreibtor (H-1, Nachweis D.4(2) des VCL-Vertrags):
// „Gleiche Eingänge → gleiche geordnete Folge von Draht-Operationen."
//
// Dieses Netz friert das HEUTIGE Wire-Verhalten des Sungrow-EMS-Pfads (Pfad 1/6 der D.1-Inventur)
// als geordnete Register-Schreibfolge ein. Wird der Schreibpfad später durch submit(GateOp) geleitet
// (Legacy-Modus = bit-gleich), MUSS dieser Golden-Master unverändert bleiben. Jede Abweichung der
// Reihenfolge, Adresse oder des Werts bricht hier — bevor sie am echten Akku auffällt.
//
// Frieren/aktualisieren: GOLDEN_FREEZE=1 node --test dvhub/test/gate-golden-sungrow.test.js
// (druckt die aktuelle Folge als JSON; danach in GOLDEN unten übernehmen).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSungrowEms, wire } from '../services/inverter/sungrow.js';
import { loadSungrowConfig, sungrowImage, mockSungrow, sungrowDevice } from './helpers/sungrow-fixture.js';

const FREEZE = process.env.GOLDEN_FREEZE === '1';

// Register-Namen für eine lesbare, stabile Folge.
const REG = { [wire(13050)]: 'mode', [wire(13051)]: 'cmd', [wire(13052)]: 'power', [wire(13080)]: 'hb', [wire(13074)]: 'feedLimit' };
const nameOf = (a) => REG[a] || `@${a}`;
// Eine Schreiboperation → kompakter, stabiler String in Schreibreihenfolge.
const wireLog = (writes) => writes.map((w) => (w.fc === 16
  ? `${nameOf(w.address)}=[${(w.values || []).join(',')}]`
  : `${nameOf(w.address)}=${w.value}`));

// --- Rigs (gespiegelt aus sungrow-second.test.js, nur exportierte Helfer) ----------------------------
function dualMock(mImage, sImage, slaveHost, opts = {}) {
  const m = mockSungrow(mImage, opts.master || {});
  const s = mockSungrow(sImage, opts.slave || {});
  const pick = (host) => (host === slaveHost ? s : m);
  return {
    type: 'modbus',
    mbRequest: (c) => pick(c.host).mbRequest(c),
    mbWriteSingle: (c) => pick(c.host).mbWriteSingle(c),
    mbWriteMultiple: (c) => pick(c.host).mbWriteMultiple(c),
    master: m, slave: s,
  };
}

function emsRig({ device = sungrowDevice({ bdcRatedW: 3000 }), batteryPowerW = -500, pvPowerW = 0, selfConsumptionW = 500, optimizer = null } = {}) {
  const cfg = loadSungrowConfig({ gridPositiveMeans: 'grid_import', sungrow: { controlMode: 'forced', heartbeatTimeoutS: 30, secondInverter: { host: '192.168.68.83' } }, ...(optimizer ? { optimizer } : {}) });
  const image = sungrowImage();
  const t = mockSungrow(image);
  const clock = 1_000_000;
  const state = {
    victron: { errors: {}, fieldUpdatedAt: { batteryPowerW: clock, pvPowerW: clock, selfConsumptionW: clock }, device, batteryPowerW, pvPowerW, selfConsumptionW },
    meter: { ok: true, updatedAt: clock, grid_total_w: 0 }, ctrl: {},
  };
  const ems = createSungrowEms({ state, getCfg: () => cfg, transport: t, now: () => clock });
  return { ems, t };
}

function splitRig({ masterSoc = 80, slaveSoc = 20, batteryPowerW = -3000, grid = -3000, optimizer = {}, slaveMock = {} } = {}) {
  const slaveHost = '192.168.68.83';
  const cfg = loadSungrowConfig({
    gridPositiveMeans: 'grid_import',
    sungrow: { controlMode: 'forced', heartbeatTimeoutS: 30, secondInverter: { host: slaveHost, aggregateTelemetry: true, control: 'split', maxChargeW: 5000, maxDischargeW: 5000, batteryCapacityWh: 5000 } },
    optimizer: { maxChargeW: 5000, maxDischargeW: 5000, batteryCapacityWh: 10000, hardFloorSocPct: 10, maxSocPct: 100, ...optimizer },
  });
  const mImage = sungrowImage(); const sImage = sungrowImage();
  const t = dualMock(mImage, sImage, slaveHost, { slave: slaveMock });
  const clock = 1_000_000;
  const state = {
    victron: { soc: Math.round((masterSoc + slaveSoc) / 2), sungrowMasterSocPct: masterSoc, batteryPowerW, pvPowerW: 0, selfConsumptionW: 500, errors: {}, fieldUpdatedAt: { batteryPowerW: clock, pvPowerW: clock, selfConsumptionW: clock }, device: sungrowDevice({ bdcRatedW: 10000 }) },
    meter: { ok: true, updatedAt: clock, grid_total_w: grid }, ctrl: {},
    sungrowSecond: { online: true, updatedAt: clock, socPct: slaveSoc, batteryPowerW: 0, pvPowerW: 0, bdcRatedW: 10000 },
  };
  const slaveEms = createSungrowEms({ state, getCfg: () => cfg, transport: t, now: () => clock, statusKey: 'sungrowEmsSlave', connOverride: () => ({ host: slaveHost, port: 502, unitId: 1 }) });
  const ems = createSungrowEms({ state, getCfg: () => cfg, transport: t, now: () => clock, slaveActuator: slaveEms });
  return { ems, t };
}

// --- Szenario-Matrix: je Szenario die geordnete Draht-Folge ------------------------------------------
async function capture() {
  const out = {};

  // Einzel-WR
  let r = emsRig();
  await r.ems.applySetpoint(-6000, 'rule:abend');                 // Entladen, auf Master-BDC 3000 geklemmt
  out.single_discharge_limit = wireLog(r.t.writes);

  r = emsRig({ device: sungrowDevice({ bdcRatedW: 10000 }), batteryPowerW: -500, optimizer: { allowGridCharge: true, maxChargeW: 10000 } });
  await r.ems.applySetpoint(4000, 'rule:netzladen');             // Netzladen erlaubt → echter Lade-Befehl
  out.single_charge_gridcharge = wireLog(r.t.writes);

  r = emsRig();
  await r.ems.applySetpoint(0, 'rule:halten');                   // Sollwert 0 (Netz auf null regeln)
  out.single_setpoint_zero = wireLog(r.t.writes);

  // Zwei WR (Split)
  r = splitRig({ masterSoc: 80, slaveSoc: 20 });
  await r.ems.applySetpoint(-3000, 'rule:abend');               // soc-balance: Master 2889 / Slave 111
  out.split_discharge_balanced_master = wireLog(r.t.master.writes);
  out.split_discharge_balanced_slave = wireLog(r.t.slave.writes);

  r = splitRig({ masterSoc: 9, slaveSoc: 15 });
  await r.ems.applySetpoint(-3000, 'rule:abend');               // Master unter Boden → Stopp, Slave übernimmt
  out.split_master_floor_master = wireLog(r.t.master.writes);
  out.split_master_floor_slave = wireLog(r.t.slave.writes);

  r = splitRig({ masterSoc: 80, slaveSoc: 20, slaveMock: { failReadAt: wire(13050) } });
  await r.ems.applySetpoint(-3000, 'rule:abend');               // Slave-Lesefehler → Fallback, Master steuert weiter
  out.split_slave_fallback_master = wireLog(r.t.master.writes);
  out.split_slave_fallback_slave = wireLog(r.t.slave.writes);

  return out;
}

// Eingefrorener Stand vom 17.11. (DVhub a36d89b0 + Bug-1-Fix; cmd 170=0xAA Laden, 187=0xBB Entladen, mode 2=Forced).
// Aktualisieren NUR mit belegtem Grund (z. B. Legacy-Tor beweisbar bit-gleich): GOLDEN_FREEZE=1 neu abnehmen.
const GOLDEN = {
  single_discharge_limit: ['power=3000', 'cmd=187', 'mode=2'],
  single_charge_gridcharge: ['power=2300', 'cmd=170', 'mode=2'],
  single_setpoint_zero: ['power=500', 'cmd=187', 'mode=2'],
  split_discharge_balanced_master: ['power=2889', 'cmd=187', 'mode=2'],
  split_discharge_balanced_slave: ['power=111', 'cmd=187', 'mode=2'],
  split_master_floor_master: ['mode=2'],
  split_master_floor_slave: ['power=3000', 'cmd=187', 'mode=2'],
  split_slave_fallback_master: ['power=3000', 'cmd=187', 'mode=2'],
  split_slave_fallback_slave: [],
};

test('H-1 Golden-Master: Sungrow-EMS-Draht-Befehle unverändert (D.4(2))', async () => {
  const got = await capture();
  if (FREEZE) {
    // eslint-disable-next-line no-console
    console.error('GOLDEN_SNAPSHOT=' + JSON.stringify(got, null, 2));
  }
  assert.deepEqual(got, GOLDEN, 'Draht-Folge weicht vom eingefrorenen Stand ab — Verhaltensänderung im Schreibpfad!');
});
