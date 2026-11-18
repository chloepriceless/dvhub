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

// Erwartet werden WÖRTLICHE Draht-Adressen (nicht über wire() hergeleitet), damit auch ein Adress-Versatz im
// Produktionscode auffällt (Codex-Review 667f431d). Sungrow-Doku-Adresse − 1: 13049 = Modus (13050),
// 13050 = Befehl (13051, 170 = 0xAA Laden, 187 = 0xBB Entladen, 204 = 0xCC Stopp), 13051 = Leistung W (13052).
// Format je Write: `<Gerät>:<Draht-Adresse>=<Wert>` bzw. `=[w1,w2]` bei FC 16; M = Master/Einzel-WR, S = Slave.
const entry = (dev, w) => (w.fc === 16
  ? `${dev}:${w.address}=[${(w.values || []).join(',')}]`
  : `${dev}:${w.address}=${w.value}`);

// Ein Fake-Transport für ein oder zwei Geräte; ALLE Writes landen in EINEM Protokoll in Draht-Reihenfolge,
// damit auch die Reihenfolge über die Geräte hinweg eingefroren ist (Codex-Review 667f431d).
function sharedMock(mImage, sImage = null, slaveHost = null, opts = {}) {
  const m = mockSungrow(mImage, opts.master || {});
  const s = sImage ? mockSungrow(sImage, opts.slave || {}) : null;
  const log = [];
  const pick = (host) => (s && host === slaveHost ? ['S', s] : ['M', m]);
  const recorded = (method) => async (c) => {
    const [dev, mock] = pick(c.host);
    try {
      return await mock[method](c);
    } finally {
      log.push(entry(dev, mock.writes[mock.writes.length - 1]));
    }
  };
  return {
    type: 'modbus',
    mbRequest: (c) => pick(c.host)[1].mbRequest(c),
    mbWriteSingle: recorded('mbWriteSingle'),
    mbWriteMultiple: recorded('mbWriteMultiple'),
    log,
  };
}

// --- Rigs (Aufbau wie in schedule-eval.js, nur exportierte Helfer) --------------------------------------
function emsRig({ device = sungrowDevice({ bdcRatedW: 3000 }), batteryPowerW = -500, pvPowerW = 0, selfConsumptionW = 500, optimizer = null } = {}) {
  const cfg = loadSungrowConfig({ gridPositiveMeans: 'grid_import', sungrow: { controlMode: 'forced', heartbeatTimeoutS: 30, secondInverter: { host: '192.168.68.83' } }, ...(optimizer ? { optimizer } : {}) });
  const image = sungrowImage();
  const t = sharedMock(image);
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
  const t = sharedMock(mImage, sImage, slaveHost, { slave: slaveMock });
  const clock = 1_000_000;
  const state = {
    victron: { soc: Math.round((masterSoc + slaveSoc) / 2), sungrowMasterSocPct: masterSoc, batteryPowerW, pvPowerW: 0, selfConsumptionW: 500, errors: {}, fieldUpdatedAt: { batteryPowerW: clock, pvPowerW: clock, selfConsumptionW: clock }, device: sungrowDevice({ bdcRatedW: 10000 }) },
    meter: { ok: true, updatedAt: clock, grid_total_w: grid }, ctrl: {},
    sungrowSecond: { online: true, updatedAt: clock, socPct: slaveSoc, batteryPowerW: 0, pvPowerW: 0, bdcRatedW: 10000 },
  };
  const slaveEms = createSungrowEms({ state, getCfg: () => cfg, transport: t, now: () => clock, statusKey: 'sungrowEmsSlave', isSlave: true, connOverride: () => ({ host: slaveHost, port: 502, unitId: 1 }) });
  const ems = createSungrowEms({ state, getCfg: () => cfg, transport: t, now: () => clock, slaveActuator: slaveEms });
  return { ems, t };
}

// --- Szenario-Matrix: je Szenario die geordnete Draht-Folge ------------------------------------------
async function capture() {
  const out = {};

  // Einzel-WR
  let r = emsRig();
  await r.ems.applySetpoint(-6000, 'rule:abend');                 // Entladen, auf Master-BDC 3000 geklemmt
  out.single_discharge_limit = r.t.log;

  r = emsRig({ device: sungrowDevice({ bdcRatedW: 10000 }), batteryPowerW: -500, optimizer: { allowGridCharge: true, maxChargeW: 10000 } });
  await r.ems.applySetpoint(4000, 'rule:netzladen');             // Netzladen erlaubt → echter Lade-Befehl
  out.single_charge_gridcharge = r.t.log;

  r = emsRig();
  await r.ems.applySetpoint(0, 'rule:halten');                   // Sollwert 0 (Netz auf null regeln)
  out.single_setpoint_zero = r.t.log;

  // Zwei WR (Split)
  r = splitRig({ masterSoc: 80, slaveSoc: 20 });
  await r.ems.applySetpoint(-3000, 'rule:abend');               // soc-balance: Master 2889 / Slave 111
  out.split_discharge_balanced = r.t.log;

  r = splitRig({ masterSoc: 9, slaveSoc: 15 });
  await r.ems.applySetpoint(-3000, 'rule:abend');               // Master unter Boden → Stopp, Slave übernimmt
  out.split_master_floor = r.t.log;

  r = splitRig({ masterSoc: 80, slaveSoc: 20, slaveMock: { failReadAt: wire(13050) } });
  await r.ems.applySetpoint(-3000, 'rule:abend');               // Slave-Lesefehler → Fallback, Master steuert weiter
  out.split_slave_fallback = r.t.log;

  return out;
}

// Eingefrorener Stand (feat/vcl-tor 610ea402: origin/main b9bd2f5c + Runden-Fix VÄ-12), neu abgenommen am 18.11.
// mit wörtlichen Adressen, gemeinsamem Protokoll und Slave wie in der Produktion (isSlave: kein Modus-Write).
// Aktualisieren NUR mit belegtem Grund (z. B. Legacy-Tor beweisbar bit-gleich): GOLDEN_FREEZE=1 neu abnehmen.
const GOLDEN = {
  single_discharge_limit: ['M:13051=3000', 'M:13050=187', 'M:13049=2'],
  single_charge_gridcharge: ['M:13051=2300', 'M:13050=170', 'M:13049=2'],
  single_setpoint_zero: ['M:13051=500', 'M:13050=187', 'M:13049=2'],
  // Slave zuerst, dann Master; der Slave schreibt nie 13050 (folgt dem Master-Modus).
  split_discharge_balanced: ['S:13051=111', 'S:13050=187', 'M:13051=2889', 'M:13050=187', 'M:13049=2'],
  split_master_floor: ['S:13051=3000', 'S:13050=187', 'M:13049=2'],
  split_slave_fallback: ['M:13051=3000', 'M:13050=187', 'M:13049=2'],
};

test('H-1 Golden-Master: Sungrow-EMS-Draht-Befehle unverändert (D.4(2))', async () => {
  const got = await capture();
  if (FREEZE) {
    // eslint-disable-next-line no-console
    console.error('GOLDEN_SNAPSHOT=' + JSON.stringify(got, null, 2));
  }
  assert.deepEqual(got, GOLDEN, 'Draht-Folge weicht vom eingefrorenen Stand ab — Verhaltensänderung im Schreibpfad!');
});
