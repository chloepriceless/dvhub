// Zweiter Sungrow-WR im Master/Slave-Parallelbetrieb (T-0422, zwei WR): NUR LESEND. Steuerung geht laut
// Sungrow-Doku V1.1.11 (Energy-Management, Note) nur an den Master — hier geprüft: der Begleitdienst liest den
// zweiten WR aus und schreibt NIE; nur mit aggregateTelemetry zählt der Master-Regler beide WR zusammen.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSungrowEms, resolveSecondInverter, secondInverterTelemetry, wire, EMS_CMD, EMS_MODE,
  sungrowSecondView, sungrowSystemTelemetry, sungrowSystemSoc, sungrowSocFloor, sungrowReserveWh, sungrowHeadroomWh, splitSungrowPower,
  splitStrategyShares, SPLIT_STRATEGIES, isSungrowEmergencyCharge, sungrowDischargeFloorPct, sungrowChargeCeilPct,
  sungrowRealSocPct, sungrowSocFloorBufferPct, sungrowConfiguredRegulateMs, resolveSungrowControl
} from '../services/inverter/sungrow.js';
import { createSungrowSecond } from '../services/inverter/sungrow-second.js';
import { createModbusHealth } from '../services/inverter/modbus-health.js';
import { buildVictronSnapshot } from '../runtime-state.js';
import { planningCfg, planningMinSocPct } from '../services/multi-gx/planning.js';
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
  const s = { online: true, updatedAt: 1000, batteryPowerW: -500, pvPowerW: 2000, socPct: 55, bdcRatedW: 3000 };
  const extra = { maxChargeWDevice: null, maxDischargeWDevice: null, minSocPctDevice: null, maxSocPctDevice: null, emergencyCharge: false };
  assert.deepEqual(secondInverterTelemetry({ sungrowSecond: s }, cfgAgg, { nowMs: 1000, maxAgeMs: 20000 }),
    { batteryPowerW: -500, pvPowerW: 2000, socPct: 55, bdcRatedW: 3000, ...extra });
  // offline → null
  assert.equal(secondInverterTelemetry({ sungrowSecond: { ...s, online: false } }, cfgAgg, { nowMs: 1000 }), null);
  // veraltet → null
  assert.equal(secondInverterTelemetry({ sungrowSecond: s }, cfgAgg, { nowMs: 1000 + 25000, maxAgeMs: 20000 }), null);
  // fehlender Einzelwert bleibt null, die anderen zählen
  assert.deepEqual(secondInverterTelemetry({ sungrowSecond: { ...s, batteryPowerW: null } }, cfgAgg, { nowMs: 1000 }),
    { batteryPowerW: null, pvPowerW: 2000, socPct: 55, bdcRatedW: 3000, ...extra });
  // Notladung (0x4001): batteryPowerW NICHT dem Regler zurechnen (null), Flag gesetzt (Aufgabe 2)
  assert.deepEqual(secondInverterTelemetry({ sungrowSecond: { ...s, runningState: 0x4001 } }, cfgAgg, { nowMs: 1000 }),
    { batteryPowerW: null, pvPowerW: 2000, socPct: 55, bdcRatedW: 3000, ...extra, emergencyCharge: true });
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
  // Gerätegrenzen 33047/48/49 (Holding, FC 3) werden als GUI-Vorschlag mitgelesen (×10).
  assert.equal(s.maxChargeWDevice, image.holding.get(wire(33047)) * 10);
  assert.equal(s.maxDischargeWDevice, image.holding.get(wire(33048)) * 10);
  assert.equal(s.batteryCapacityLimitWh, image.holding.get(wire(33049)) * 10);
  // N3 (Feld 15.11.): Live-Telemetrie je Takt sind nur noch DREI FC-4-Anfragen — Akku (5214+2), PV (5017+2) und der
  // Zustands-/SoC-Block (13000+46, liefert runningState UND SoC in EINER Anfrage statt zwei Einzel-Lesungen).
  const fc4 = t.reads.filter((x) => x.fc === 4);
  for (const want of [[wire(5017), 2], [wire(5214), 2], [wire(13000), 46]]) {
    assert.ok(fc4.some((x) => x.address === want[0] && x.quantity === want[1]), `Live-Block ${want[0]}+${want[1]}`);
  }
  // KEINE FC-4-Einzel-Lesung von SoC (13023) oder runningState (13000, Menge 1) mehr — die kommen aus dem Block.
  assert.ok(!fc4.some((x) => x.address === wire(13023)), 'SoC nicht mehr einzeln');
  assert.ok(!fc4.some((x) => x.address === wire(13000) && x.quantity === 1), 'runningState nicht mehr einzeln');
  // bdc (5628) und Kapazität (5639) sind die einzigen zusätzlichen FC-4-Einzel-Lesungen — im langsamen Config-Takt.
  const liveOrConfig = new Set([wire(5017), wire(5214), wire(13000), wire(5628), wire(5639)]);
  assert.ok(fc4.every((x) => liveOrConfig.has(x.address)), 'keine anderen FC-4-Lesungen');
  // FC 3 nur für Geräte-/Grenzwerte (nie ein Write): Grenzen-Block 33047+3, SoC-Grenzen-Block 13057+4; dieser fehlt im
  // Abbild → Modbus-Ausnahme → Rückfall auf Einzellesen 13058/13059 (Probe + per-Verbindung-Fallback, N3).
  const fc3 = t.reads.filter((x) => x.fc === 3);
  assert.ok(fc3.some((x) => x.address === wire(33047) && x.quantity === 3), 'Grenzen als EIN FC-3-Block');
  assert.ok(fc3.some((x) => x.address === wire(13057) && x.quantity === 4), 'SoC-Grenzen als EIN FC-3-Block (Probe)');
  assert.ok(fc3.some((x) => x.address === wire(13058) && x.quantity === 1), 'Max-SoC einzeln nach Block-Ausnahme');
  assert.ok(fc3.some((x) => x.address === wire(13059) && x.quantity === 1), 'Min-SoC einzeln nach Block-Ausnahme');
  assert.deepEqual(t.writes, []);
});

test('Begleitdienst: Geräte-/Grenzwerte im langsamen Takt gecacht — zweiter Takt liest sie NICHT neu', async () => {
  const image = sungrowImage();
  const t = mockSungrow(image);
  const r = pollerRig({ transport: t }); // fester Takt (now konstant) → innerhalb SUNGROW_SECOND_CONFIG_EVERY_MS
  await r.sec.tick();
  const fc3First = t.reads.filter((x) => x.fc === 3).length;
  assert.ok(fc3First > 0, 'erster Takt liest die Grenzwerte');
  const beforeSecond = t.reads.length;
  await r.sec.tick();
  const fc3Second = t.reads.filter((x) => x.fc === 3).length;
  assert.equal(fc3Second, fc3First, 'zweiter Takt liest KEINE weiteren FC-3-Grenzwerte (gecacht)');
  // Der zweite Takt macht nur noch die 3 Live-FC-4-Blöcke.
  assert.equal(t.reads.length - beforeSecond, 3, 'zweiter Takt: nur die 3 Live-Anfragen');
  // Gecachte Grenzwerte bleiben in der Anzeige.
  assert.equal(r.state.sungrowSecond.maxChargeWDevice, image.holding.get(wire(33047)) * 10);
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
// batteryPowerW in state.victron ist der SYSTEM-Wert (der Poller hat PV/Akku schon aggregiert); der Regler
// zählt NICHT noch einmal dazu, er nutzt vom zweiten WR nur die BDC-Nennleistung für die System-Leistungsgrenze.
function emsRig({ device = sungrowDevice({ bdcRatedW: 3000 }), batteryPowerW = -500, second = null, aggregateTelemetry = false, optimizer = null, secondPowers = null, extra = null, pvPowerW = 0, selfConsumptionW = 500, modbusHealth = null } = {}) {
  const secondInverter = { host: '192.168.68.83', aggregateTelemetry, ...(secondPowers || {}) };
  const cfg = loadSungrowConfig({ gridPositiveMeans: 'grid_import', sungrow: { controlMode: 'forced', heartbeatTimeoutS: 30, secondInverter }, ...(optimizer ? { optimizer } : {}), ...(extra || {}) });
  const image = sungrowImage();
  const t = mockSungrow(image);
  const clock = 1_000_000;
  const now = () => clock;
  const state = {
    victron: {
      errors: {}, fieldUpdatedAt: { batteryPowerW: clock, pvPowerW: clock, selfConsumptionW: clock },
      device, batteryPowerW, pvPowerW, selfConsumptionW
    },
    meter: { ok: true, updatedAt: clock, grid_total_w: 0 },
    ctrl: {},
    ...(second ? { sungrowSecond: { online: true, updatedAt: clock, ...second } } : {})
  };
  const ems = createSungrowEms({ state, getCfg: () => cfg, transport: t, now, modbusHealth });
  return { ems, t, state, image };
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

test('M2: Besitz-Merker verloren, Master in DVhubs EIGENEM Modus 2 → NICHT fremd, DVhub übernimmt wieder', async () => {
  // Feld 16.11.: nach einem Lesefehler löschte DVhub owns, schrieb die Rückgabe aber nicht durch. Danach hielt es
  // seinen eigenen Modus 2 für fremd (sungrow_foreign_ems_mode) und schrieb nichts mehr → Master ~10 min fest.
  const r = emsRig({ batteryPowerW: -500 });
  await r.ems.applySetpoint(-6000, 'rule:abend');          // DVhub tritt Modus 2 an → owns + lastMasterWrite gesetzt
  assert.equal(r.ems._st.owns, true);
  assert.ok(r.ems._st.lastMasterWrite && r.ems._st.lastMasterWrite.mode === EMS_MODE.FORCED);
  // Besitz-Merker geht verloren (owns weg), das Gerät steht aber noch in DVhubs Modus 2.
  r.ems._st.owns = false; r.ems._st.ownMode = null; r.ems._st.dev = null; // frisch vom Gerät lesen
  const writesBefore = r.t.writes.length;
  const res = await r.ems.applySetpoint(-1000, 'rule:abend'); // andere (kleinere) Leistung → neue Vorgabe
  assert.equal(res.ok, true, 'kein foreign-Abbruch — DVhub erkennt den eigenen Modus 2 wieder');
  assert.notEqual(res.error, 'sungrow_foreign_ems_mode');
  assert.ok(r.t.writes.length > writesBefore, 'DVhub schreibt wieder (übernimmt), statt hängen zu bleiben');
  assert.equal(r.ems._st.owns, true, 'Besitz zurückgenommen');
});

test('M2: fremder Modus 2 (NICHT DVhubs letzter Write) bleibt fremd → kein Übersteuern', async () => {
  const r = emsRig({ batteryPowerW: -500 });
  // Gerät steht real in Modus 2 mit FREMDEM Befehl (anderes System), DVhub hat nichts geschrieben.
  r.image.holding.set(wire(13050), EMS_MODE.FORCED);
  r.image.holding.set(wire(13051), EMS_CMD.CHARGE);
  r.image.holding.set(wire(13052), 1234);
  r.ems._st.dev = null; r.ems._st.lastMasterWrite = null;
  r.ems._st.owns = false; r.ems._st.ownMode = null;
  const res = await r.ems.applySetpoint(-4000, 'rule:abend');
  // Ohne passenden eigenen Write ist Modus 2 fremd → foreign, DVhub übersteuert NICHT (kein claim).
  assert.ok(res.ok === false || res.error === 'sungrow_foreign_ems_mode' || res.skipped === true, JSON.stringify(res));
  assert.notEqual(r.ems._st.owns, true, 'DVhub beansprucht den fremden Modus 2 NICHT');
});

test('N5: sungrowConfiguredRegulateMs — Master-Takt, Slave getrennt bzw. geerbt, 0 = Auto', () => {
  // Kein Wert → Auto (0).
  assert.equal(sungrowConfiguredRegulateMs({}), 0);
  assert.equal(sungrowConfiguredRegulateMs({}, { isSlave: true }), 0);
  // Master 5 s gesetzt.
  const m = { sungrow: { regulateEveryMs: 5000 } };
  assert.equal(sungrowConfiguredRegulateMs(m), 5000);
  // Slave erbt den Master-Takt, wenn kein eigener gesetzt ist.
  assert.equal(sungrowConfiguredRegulateMs(m, { isSlave: true }), 5000);
  // Slave mit eigenem Takt (1 s) — unabhängig vom Master.
  const s = { sungrow: { regulateEveryMs: 5000, secondInverter: { regulateEveryMs: 1000 } } };
  assert.equal(sungrowConfiguredRegulateMs(s), 5000, 'Master bleibt 5 s');
  assert.equal(sungrowConfiguredRegulateMs(s, { isSlave: true }), 1000, 'Slave 1 s');
});

test('N5: Master-Status trägt Modbus-Gesundheit + gewählten Takt', async () => {
  const r = emsRig({ batteryPowerW: -500 });
  await r.ems.applySetpoint(-6000, 'rule:abend');
  const st = r.ems.status();
  assert.ok(st.health && st.health.totalRequests > 0, 'Modbus-Anfragen gezählt');
  assert.equal(st.health.errors24h, 0, 'keine Fehler am Mock');
  assert.equal(st.regulateConfiguredMs, 0, 'kein fester Takt gesetzt → Auto (0)');
  assert.ok(Number.isFinite(st.regulateEveryMs), 'wirksamer Takt ist eine Zahl');
});

test('M7b: Master-EMS zählt in den GETEILTEN Modbus-Health (Poll + EMS gemeinsam)', async () => {
  const shared = createModbusHealth();
  // Vorab einen „Poll" simulieren (wie der Poller über denselben ctx.sungrowMasterHealth).
  const pollTx = shared.wrap({ type: 'modbus', async mbRequest() { return [0]; }, async mbWriteSingle() {}, async mbWriteMultiple() {} });
  await pollTx.mbRequest({ address: 1 });
  const pollOnly = shared.snapshot().totalRequests;
  assert.equal(pollOnly, 1);
  // Der Master-EMS nutzt denselben Zähler → seine Anfragen kommen dazu.
  const r = emsRig({ batteryPowerW: -500, modbusHealth: shared });
  await r.ems.applySetpoint(-6000, 'rule:abend');
  assert.ok(r.ems.status().health.totalRequests > pollOnly, 'EMS zählt in denselben Zähler (Poll + EMS)');
});

test('M2: forceRelease — Modus 0 + 0xCC, UNABHÄNGIG vom Besitz-Merker', async () => {
  const r = emsRig({ batteryPowerW: -500 });
  await r.ems.applySetpoint(-6000, 'rule:abend');          // Modus 2, owns
  r.ems._st.owns = false; r.ems._st.ownMode = null;        // Merker verloren
  const out = await r.ems.forceRelease('manual_release');
  assert.equal(out.ok, true);
  assert.equal(out.device.mode, EMS_MODE.SELF);
  assert.equal(out.device.cmd, EMS_CMD.STOP);
  assert.equal(r.ems._st.owns, false);
  assert.equal(r.ems._st.target, null);
  assert.equal(r.ems._st.lastMasterWrite, null);
});

test('Regler mit zweitem WR: Systemakku kommt aus state.victron (nicht doppelt summiert), System-Grenze', async () => {
  // Der Poller hat batteryPowerW bereits auf die Systemsumme −1000 gesetzt. P = −1000 + 0,7·(−6000) = −5200.
  // Der Regler darf den zweiten Akku NICHT nochmal addieren (−1000, nicht −2000). Grenze = 3000+3000 = 6000.
  const r = emsRig({ batteryPowerW: -1000, second: { batteryPowerW: -500, pvPowerW: 0, socPct: 50, bdcRatedW: 3000 }, aggregateTelemetry: true });
  await r.ems.applySetpoint(-6000, 'rule:abend');
  const pw = r.t.writes.find((w) => w.address === POWER);
  assert.equal(pw.value, 5200);
});

test('Regler-Doppelzählung: Kundenfall batteryPowerW −2168 → Regler-Eingang −2168 (nicht −4336)', async () => {
  // Poller hat Master-Akku 0 + Slave −2168 = −2168 in state.victron.batteryPowerW gelegt. Netz −56.
  // P = −2168 + 0,7·(−6000−(−56)) = −2168 − 4160,8 = −6328,8 → 6330 W (Grenze 3000+10000 = 13000 bindet nicht).
  // Mit fälschlicher Doppelzählung (−4336) wäre P = −8496,8 → 8500 W. Die 6330 belegen: kein Doppelzählen.
  const r = emsRig({ batteryPowerW: -2168, second: { batteryPowerW: -2168, pvPowerW: 0, socPct: 40, bdcRatedW: 10000 }, aggregateTelemetry: true });
  r.state.meter.grid_total_w = -56;
  await r.ems.applySetpoint(-6000, 'rule:abend');
  const pw = r.t.writes.find((w) => w.address === POWER);
  assert.equal(pw.value, 6330);
});

test('Regler mit zweitem WR, aber aggregateTelemetry AUS: unverändert wie Master allein (3 kW)', async () => {
  const r = emsRig({ second: { batteryPowerW: -500, pvPowerW: 0, bdcRatedW: 3000 }, aggregateTelemetry: false });
  await r.ems.applySetpoint(-6000, 'rule:abend');
  const pw = r.t.writes.find((w) => w.address === POWER);
  assert.equal(pw.value, 3000);
});

test('Regler: zweiter WR offline → keine System-Grenze, Master allein (3 kW)', async () => {
  const r = emsRig({ second: { online: false, batteryPowerW: -500, bdcRatedW: 3000 }, aggregateTelemetry: true });
  r.state.sungrowSecond.online = false;
  await r.ems.applySetpoint(-6000, 'rule:abend');
  const pw = r.t.writes.find((w) => w.address === POWER);
  assert.equal(pw.value, 3000);
});

// --- Anzeige: sanitierte Slave-Zusammenfassung (ohne LAN-IP) -----------------------

test('sungrowSecondView: ohne Konfiguration null', () => {
  assert.equal(sungrowSecondView({ sungrowSecond: { online: true } }, {}), null);
});

test('sungrowSecondView: online → Werte, OHNE host/LAN-IP; offline → Werte null, online:false', () => {
  const cfg = { sungrow: { secondInverter: { host: '192.168.68.83', aggregateTelemetry: true } } };
  const health = { totalRequests: 100, requestsPerSec: 0.6, responseMs: 240, errors24h: 1, lastError: { message: 'modbus timeout', kind: 'timeout', at: 5 } };
  const online = sungrowSecondView({ sungrowSecond: { online: true, host: '192.168.68.83', socPct: 61, batteryPowerW: 2300, pvPowerW: 0, bdcRatedW: 5000, batteryCapacitySuggestionWh: 9600, maxChargeWDevice: 10000, maxDischargeWDevice: 10000, batteryCapacityLimitWh: 10000, minSocPctDevice: 10, maxSocPctDevice: 95, health, tickMs: 5000 } }, cfg);
  assert.deepEqual(online, { online: true, reason: null, aggregate: true, strategyCharge: 'soc-balance', strategyDischarge: 'soc-balance', socPct: 61, batteryPowerW: 2300, pvPowerW: 0, bdcRatedW: 5000, batteryCapacitySuggestionWh: 9600, maxChargeWDevice: 10000, maxDischargeWDevice: 10000, batteryCapacityLimitWh: 10000, minSocPctDevice: 10, maxSocPctDevice: 95, runningState: null, runningStateText: null, emergencyCharge: false, health, tickMs: 5000 });
  // Modbus-Gesundheit wird durchgereicht (N5); keine LAN-IP enthalten.
  // Keine LAN-IP / kein host in der Statusausgabe.
  assert.ok(!('host' in online));
  const off = sungrowSecondView({ sungrowSecond: { online: false, host: '192.168.68.83', socPct: 61 } }, cfg);
  assert.deepEqual([off.online, off.socPct, off.batteryPowerW], [false, null, null]);
  assert.ok(!('host' in off));
});

// --- System-SoC und SoC-Boden (rein) ----------------------------------------------

test('sungrowSystemSoc: kapazitätsgewichtet, ohne Kapazität einfaches Mittel, Einzelfälle', () => {
  // 10 kWh @ 80 % + 10 kWh @ 40 % = 60 %.
  assert.equal(sungrowSystemSoc(80, 40, { masterCapacityWh: 10000, secondCapacityWh: 10000 }), 60);
  // Ungleiche Kapazität: 15 kWh @ 80 % + 5 kWh @ 40 % = (12000+2000)/20000·... = 70 %.
  assert.equal(sungrowSystemSoc(80, 40, { masterCapacityWh: 15000, secondCapacityWh: 5000 }), 70);
  // Ohne Kapazitäten: einfaches Mittel.
  assert.equal(sungrowSystemSoc(80, 40), 60);
  // Nur einer bekannt → dieser; keiner → null.
  assert.equal(sungrowSystemSoc(55, null), 55);
  assert.equal(sungrowSystemSoc(null, null), null);
});

test('sungrowSocFloor: niedrigerer der beiden (schützt den schwächeren Akku)', () => {
  assert.equal(sungrowSocFloor(80, 12), 12);
  assert.equal(sungrowSocFloor(12, 80), 12);
  assert.equal(sungrowSocFloor(55, null), 55);
  assert.equal(sungrowSocFloor(null, null), null);
});

// --- Kanonische System-Telemetrie (sungrowSystemTelemetry, rein) -------------------

test('sungrowSystemTelemetry: ohne zweiten WR null (keine Aggregation)', () => {
  assert.equal(sungrowSystemTelemetry({ batteryPowerW: 0, pvPowerW: 0, soc: 50 }, null), null);
});

test('sungrowSystemTelemetry: Akku/PV/SoC = Master + Slave, Master-Rohwerte erhalten, SoC-Boden = Minimum', () => {
  // Kundenfall: Master-Akku 0 / PV 0 / SoC 80 ; Slave −2168 / PV 0 / SoC 40 (je 10 kWh).
  const out = sungrowSystemTelemetry(
    { batteryPowerW: 0, pvPowerW: 0, pvTotalW: 0, soc: 80 },
    { batteryPowerW: -2168, pvPowerW: 0, socPct: 40, bdcRatedW: 10000 },
    { masterCapacityWh: 10000, secondCapacityWh: 10000 }
  );
  assert.equal(out.batteryPowerW, -2168);           // Systemakku
  assert.equal(out.sungrowMasterBatteryW, 0);       // Master-Rohwert bleibt
  assert.equal(out.soc, 60);                         // (80+40)/2 gewichtet gleich = 60
  assert.equal(out.sungrowMasterSocPct, 80);
  assert.equal(out.socFloorPct, 40);                // niedrigerer SoC für den Boden
});

test('sungrowSystemTelemetry: fehlende Slave-Teilwerte zählen nicht dazu, pvTotalW folgt pvPowerW', () => {
  const out = sungrowSystemTelemetry(
    { batteryPowerW: -500, pvPowerW: 1200, pvTotalW: 1200, soc: 50 },
    { batteryPowerW: -800, pvPowerW: 1500, socPct: 55, bdcRatedW: 10000 }
  );
  assert.equal(out.batteryPowerW, -1300);
  assert.equal(out.pvPowerW, 2700);
  assert.equal(out.pvTotalW, 2700);
  assert.equal(out.soc, 52.5);                      // (50+55)/2 (keine Kapazitäten)
  assert.equal(out.socFloorPct, 50);
});

// --- Poller-Anwendung (Kundenfall): kanonische Werte + Hauslast-Korrektur ----------

// Spiegelt die zwei Poller-Blöcke (polling.js): kanonische System-Telemetrie + System-Hauslast.
function applyPollerBlocks(state, cfg) {
  const c = resolveSecondInverter(cfg);
  if (!c.enabled) return;
  const second = secondInverterTelemetry(state, cfg, {});
  const sysT = sungrowSystemTelemetry(state.victron, second, {
    masterCapacityWh: Number(cfg.optimizer?.batteryCapacityWh) || 0,
    secondCapacityWh: Number(cfg.sungrow?.secondInverter?.batteryCapacityWh) || 0,
  });
  if (sysT) {
    if (sysT.batteryPowerW != null) { state.victron.sungrowMasterBatteryW = sysT.sungrowMasterBatteryW; state.victron.batteryPowerW = sysT.batteryPowerW; }
    if (sysT.pvPowerW != null) { state.victron.sungrowMasterPvW = sysT.sungrowMasterPvW; state.victron.pvPowerW = sysT.pvPowerW; state.victron.pvTotalW = sysT.pvTotalW; }
    if (sysT.soc != null) { state.victron.sungrowMasterSocPct = sysT.sungrowMasterSocPct; state.victron.soc = sysT.soc; }
    if (sysT.socFloorPct != null) state.victron.socFloorPct = sysT.socFloorPct;
  }
  if (second && !state.victron.errors?.selfConsumptionW && state.victron.selfConsumptionW != null) {
    const sPv = second.pvPowerW ?? 0; const sBat = second.batteryPowerW ?? 0;
    state.victron.sungrowMasterLoadW = Number(state.victron.selfConsumptionW);
    state.victron.selfConsumptionW = Number(Math.max(0, Number(state.victron.selfConsumptionW) + sPv - sBat).toFixed(3));
  }
}

test('Poller (Kundenfall): Master-Akku 0 / Slave −2168 / Last 2091 / Netz −56 → System-Akku −2168, Last 2091', () => {
  const cfg = { sungrow: { secondInverter: { host: '192.168.68.83', aggregateTelemetry: true, batteryCapacityWh: 10000 } }, optimizer: { batteryCapacityWh: 10000 } };
  const state = {
    victron: { batteryPowerW: 0, pvPowerW: 0, pvTotalW: 0, soc: 80, selfConsumptionW: -77, errors: {}, fieldUpdatedAt: {} },
    sungrowSecond: { online: true, updatedAt: Date.now(), host: '192.168.68.83', socPct: 40, batteryPowerW: -2168, pvPowerW: 0, bdcRatedW: 10000 }
  };
  applyPollerBlocks(state, cfg);
  assert.equal(state.victron.batteryPowerW, -2168);     // Systemakku (nicht Master 0)
  assert.equal(state.victron.sungrowMasterBatteryW, 0);
  // Master-Last roh −77 → System-Last = max(0, −77 + 0 − (−2168)) = 2091.
  assert.equal(state.victron.selfConsumptionW, 2091);
  assert.equal(state.victron.sungrowMasterLoadW, -77);
  assert.equal(state.victron.socFloorPct, 40);          // SoC-Boden nutzt den niedrigeren (Slave 40)
  assert.equal(state.victron.soc, 60);                  // System-SoC
});

test('Poller: aggregateTelemetry AUS → Master-Werte unverändert, kein System-Feld', () => {
  const cfg = { sungrow: { secondInverter: { host: '192.168.68.83' } } };
  const state = {
    victron: { batteryPowerW: 0, pvPowerW: 0, pvTotalW: 0, soc: 80, selfConsumptionW: 0, errors: {}, fieldUpdatedAt: {} },
    sungrowSecond: { online: true, updatedAt: Date.now(), host: '192.168.68.83', socPct: 40, batteryPowerW: -2168, pvPowerW: 0, bdcRatedW: 10000 }
  };
  applyPollerBlocks(state, cfg);
  assert.equal(state.victron.batteryPowerW, 0);          // unverändert
  assert.equal(state.victron.selfConsumptionW, 0);
  assert.equal(state.victron.socFloorPct, undefined);
});

// --- Status-Sichtbarkeit: Felder überleben den IPC-Snapshot ------------------------

test('Status: sungrowSecond + System-Summen überstehen buildVictronSnapshot (sichtbar in /api/status)', () => {
  const victron = {
    soc: 50, fieldUpdatedAt: { soc: Date.now() },
    selfConsumptionW: 2300, sungrowMasterLoadW: 0,
    sungrowSystemPvW: 3500, sungrowSystemBatteryW: -2800, sungrowSystemLoadW: 2300,
    sungrowSecond: { online: true, aggregate: true, socPct: 61, batteryPowerW: -2300, pvPowerW: 0, bdcRatedW: 5000 }
  };
  const snap = buildVictronSnapshot(victron);
  assert.equal(snap.sungrowSystemLoadW, 2300);
  assert.equal(snap.sungrowSystemBatteryW, -2800);
  assert.equal(snap.sungrowMasterLoadW, 0);
  assert.deepEqual(snap.sungrowSecond, victron.sungrowSecond);
  assert.ok(!('host' in snap.sungrowSecond));
});

// --- Punkt 6a: Kontroll-Lesefehler getrennt melden + Retry -------------------------

function readFailRig({ failReads = 0, sleep = () => Promise.resolve() } = {}) {
  const cfg = loadSungrowConfig({ gridPositiveMeans: 'grid_import', sungrow: { controlMode: 'forced', heartbeatTimeoutS: 30 } });
  const image = sungrowImage();
  const base = mockSungrow(image);
  let fails = failReads;
  const EMS = wire(13050);
  const transport = {
    type: 'modbus', reads: [], writes: [],
    async mbRequest(conf) {
      if (Number(conf.fc) === 3 && Number(conf.address) === EMS && fails > 0) { fails -= 1; throw new Error('modbus exception 4 (slave device failure)'); }
      return base.mbRequest(conf);
    },
    mbWriteSingle: (a) => base.mbWriteSingle(a),
    mbWriteMultiple: (a) => base.mbWriteMultiple(a),
  };
  const clock = 1_000_000;
  const state = {
    victron: { soc: 60, batteryPowerW: -500, pvPowerW: 0, selfConsumptionW: 500, errors: {}, fieldUpdatedAt: { batteryPowerW: clock, pvPowerW: clock, selfConsumptionW: clock }, device: sungrowDevice() },
    meter: { ok: true, updatedAt: clock, grid_total_w: 0 }, ctrl: {},
  };
  const logs = [];
  const ems = createSungrowEms({ state, getCfg: () => cfg, transport, pushLog: (event, data, level) => logs.push({ event, data, level }), now: () => clock, sleep });
  return { ems, transport, logs };
}

test('6a: exc4 beim Kontroll-Lesen → einmal neu lesen (Retry erfolgreich, kein Fehler-Event)', async () => {
  const r = readFailRig({ failReads: 1 });
  const res = await r.ems.applySetpoint(4000, 'rule:netzladen');
  assert.equal(res.ok, true);                       // zweiter Leseversuch gelang
  assert.ok(!r.logs.some((l) => l.event === 'sungrow_ems_read_error'));
});

test('6a: dauerhafter Kontroll-Lesefehler → sungrow_ems_read_error (warn) + readError, kein Write', async () => {
  const r = readFailRig({ failReads: 3 });            // alle Versuche scheitern (N2: bis zu 2 Retries → 3 Versuche)
  const res = await r.ems.applySetpoint(4000, 'rule:netzladen');
  assert.equal(res.ok, false);
  assert.equal(res.readError, true);
  const ev = r.logs.find((l) => l.event === 'sungrow_ems_read_error');
  assert.ok(ev && ev.level === 'warn');
  assert.deepEqual(r.transport.writes, []);          // nichts geschrieben
});

// --- Herzschlag 13080 nicht übernommen: sicher scheitern (a/c/d/e, Feldtest 851e973e) ---------------

const MODEA = wire(13050), CMDA = wire(13051), HBA = wire(13080);

// Modbus-Mock, der das WR-Verhalten bei 13080 nachbildet: beim Eintritt in Modus 3 setzt der WR 13080 selbst
// auf 600; unseren Schreibwert übernimmt er je nach `accept`: 'never' nie, 'mode3' per FC 06 nur in Modus 3,
// 'fc16' nur per FC 16 (Write Multiple).
function hbMock(image, { accept = 'never' } = {}) {
  const base = mockSungrow(image);
  const setHb = (v, viaFc) => {
    const mode = image.holding.get(MODEA);
    if (accept === 'mode3' && viaFc === 6 && mode === EMS_MODE.EXTERNAL) image.holding.set(HBA, v);
    else if (accept === 'fc16' && viaFc === 16) image.holding.set(HBA, v);
    // sonst ignoriert (bleibt 600)
  };
  return {
    type: 'modbus', reads: [], writes: [],
    async mbRequest(conf) { this.reads.push({ fc: Number(conf.fc), address: Number(conf.address) }); return base.mbRequest(conf); },
    async mbWriteSingle({ address, value }) {
      const v = value & 0xffff;
      this.writes.push({ fc: 6, address, value: v });
      if (address === MODEA && v === EMS_MODE.EXTERNAL) { image.holding.set(HBA, 600); image.holding.set(MODEA, v); return { addr: address, value: v }; }
      if (address === HBA) { setHb(v, 6); return { addr: address, value: v }; }
      image.holding.set(address, v);
      return { addr: address, value: v };
    },
    async mbWriteMultiple({ address, values }) {
      const v = Number(values?.[0]) & 0xffff;
      this.writes.push({ fc: 16, address, value: v });
      if (address === HBA) { setHb(v, 16); return {}; }
      image.holding.set(address, v);
      return {};
    },
  };
}

function extRig(mock, sungrowExtra = {}) {
  const cfg = loadSungrowConfig({ gridPositiveMeans: 'grid_import', sungrow: { controlMode: 'external', heartbeatTimeoutS: 30, ...sungrowExtra } });
  let clock = 1_000_000;
  const state = {
    victron: { soc: 60, batteryPowerW: 0, pvPowerW: 0, selfConsumptionW: 2100, errors: {}, fieldUpdatedAt: { batteryPowerW: clock, pvPowerW: clock, selfConsumptionW: clock }, device: sungrowDevice() },
    meter: { ok: true, updatedAt: clock, grid_total_w: 2100 }, ctrl: {},
  };
  const logs = [];
  const ems = createSungrowEms({ state, getCfg: () => cfg, transport: mock, pushLog: (event, data, level) => logs.push({ event, data, level }), now: () => clock });
  return {
    ems, state, logs, mock, cfg,
    // Uhr vorstellen und dabei die Telemetrie frisch halten (wie der laufende Poller), damit die Regelentscheidung
    // nicht allein durch Veraltung auf Self kippt.
    advance: (ms) => {
      clock += ms;
      state.victron.fieldUpdatedAt = { batteryPowerW: clock, pvPowerW: clock, selfConsumptionW: clock };
      state.meter.updatedAt = clock;
    },
  };
}

test('Herzschlag (a/d/e): WR übernimmt 13080 nie → sofort in Self-consumption, owns false, Ziel verworfen, Event', async () => {
  const image = sungrowImage();
  const r = extRig(hbMock(image, { accept: 'never' }));
  const res = await r.ems.applySetpoint(1000, 'api_manual_write'); // forced discharge, External EMS
  assert.equal(res.ok, false);
  assert.equal(res.readError, true);                 // kein control_write_error beim Aufrufer
  // (a) sofort neutralisiert: Modus 0 (Self), Befehl Stop.
  assert.equal(image.holding.get(MODEA), EMS_MODE.SELF);
  assert.equal(image.holding.get(CMDA), EMS_CMD.STOP);
  // (d) External EMS für diese Verbindung als nicht übernommen gemerkt + Event.
  assert.ok(r.logs.some((l) => l.event === 'sungrow_ems_heartbeat_unsupported'));
  // owns false, Ziel verworfen (b): kein Weiterfahren im nächsten Takt.
  assert.equal(r.state.ctrl.sungrowEms.owns, false);
  assert.equal(r.state.ctrl.sungrowEms.target, null);
  // (e) nach dem Fehler steht der WR in Self-consumption (Akku deckt die Last autonom) — kein forced Stop.
  const tick = await r.ems.tick();
  assert.ok(tick.ok === true || tick.idle === true);
  assert.ok(!r.mock.writes.some((w) => w.address === MODEA && w.value === EMS_MODE.EXTERNAL && r.mock.writes.indexOf(w) > 6));
});

test('Herzschlag (c): WR nimmt 13080 nur in Modus 3 an → heartbeatAfterMode (Standard) gelingt', async () => {
  const image = sungrowImage();
  const r = extRig(hbMock(image, { accept: 'mode3' }));
  const res = await r.ems.applySetpoint(1000, 'api_manual_write');
  assert.equal(res.ok, true);                         // Herzschlag nach dem Moduswechsel übernommen
  assert.equal(image.holding.get(HBA), 30);           // unser Wert steht
  assert.equal(image.holding.get(MODEA), EMS_MODE.EXTERNAL);
  assert.equal(r.state.ctrl.sungrowEms.owns, true);
  // Reihenfolge: Modus 3 VOR dem Herzschlag geschrieben.
  const idxMode = r.mock.writes.findIndex((w) => w.address === MODEA && w.value === EMS_MODE.EXTERNAL);
  const idxHb = r.mock.writes.findIndex((w) => w.address === HBA && w.value === 30);
  assert.ok(idxMode >= 0 && idxHb > idxMode, 'Herzschlag nach dem Moduswechsel');
});

test('Herzschlag (c-Gegenprobe): alte Reihenfolge (heartbeatAfterMode=false) scheitert bei mode3-Annahme', async () => {
  const image = sungrowImage();
  const cfg = loadSungrowConfig({ gridPositiveMeans: 'grid_import', sungrow: { controlMode: 'external', heartbeatTimeoutS: 30, heartbeatAfterMode: false } });
  const clock = 1_000_000;
  const state = {
    victron: { soc: 60, batteryPowerW: 0, pvPowerW: 0, selfConsumptionW: 2100, errors: {}, fieldUpdatedAt: { batteryPowerW: clock, pvPowerW: clock, selfConsumptionW: clock }, device: sungrowDevice() },
    meter: { ok: true, updatedAt: clock, grid_total_w: 2100 }, ctrl: {},
  };
  const logs = [];
  const ems = createSungrowEms({ state, getCfg: () => cfg, transport: hbMock(image, { accept: 'mode3' }), pushLog: (e, d, l) => logs.push({ event: e, level: l }), now: () => clock });
  const res = await ems.applySetpoint(1000, 'api_manual_write');
  assert.equal(res.ok, false);                        // Herzschlag vor dem Moduswechsel → nicht angenommen → Abbruch
  assert.ok(logs.some((l) => l.event === 'sungrow_ems_heartbeat_unsupported'));
});

// --- Punkt 1 (Feldtest 2cc50b5c): FC-16-Fallback, Gerätewert-Opt-in, Anzeige, lösbare Sperre ----------

test('1a: WR nimmt 13080 nur per FC 16 an → Auto-Fallback gelingt, workingFc=16', async () => {
  const image = sungrowImage();
  const r = extRig(hbMock(image, { accept: 'fc16' }));
  const res = await r.ems.applySetpoint(1000, 'api_manual_write');
  assert.equal(res.ok, true);                          // FC 06 scheiterte, FC 16 übernahm
  assert.equal(image.holding.get(HBA), 30);
  assert.equal(r.state.ctrl.sungrowEms.heartbeatWorkingFc, 16);
  assert.equal(r.state.ctrl.sungrowEms.owns, true);
  // Es wurde sowohl per FC 06 (ignoriert) als auch per FC 16 (übernommen) auf 13080 geschrieben.
  assert.ok(r.mock.writes.some((w) => w.address === HBA && w.fc === 6));
  assert.ok(r.mock.writes.some((w) => w.address === HBA && w.fc === 16 && w.value === 30));
});

test('1a: feste Schreibfunktion sungrow.heartbeatWriteFc=16 → direkt FC 16, kein FC-06-Versuch', async () => {
  const image = sungrowImage();
  const r = extRig(hbMock(image, { accept: 'fc16' }), { heartbeatWriteFc: 16 });
  const res = await r.ems.applySetpoint(1000, 'api_manual_write');
  assert.equal(res.ok, true);
  assert.ok(!r.mock.writes.some((w) => w.address === HBA && w.fc === 6));
  assert.ok(r.mock.writes.some((w) => w.address === HBA && w.fc === 16));
});

test('1b: WR übernimmt keinen Wert, acceptDeviceHeartbeatS=600 → mit Gerätewert fahren (Opt-in), owns bleibt', async () => {
  const image = sungrowImage();
  const r = extRig(hbMock(image, { accept: 'never' }), { acceptDeviceHeartbeatS: 600 });
  const res = await r.ems.applySetpoint(1000, 'api_manual_write');
  assert.equal(res.ok, true);                          // kein sicheres Scheitern — mit 600 s gefahren
  assert.equal(r.state.ctrl.sungrowEms.heartbeatDeviceManaged, true);
  assert.equal(r.state.ctrl.sungrowEms.heartbeatSentS, 600);
  assert.equal(r.state.ctrl.sungrowEms.owns, true);
  assert.ok(r.logs.some((l) => l.event === 'sungrow_ems_heartbeat_device_managed'));
});

test('1b: Gerätewert über der Grenze → kein Opt-in, sicher scheitern', async () => {
  const image = sungrowImage();
  const r = extRig(hbMock(image, { accept: 'never' }), { acceptDeviceHeartbeatS: 300 }); // 600 > 300
  const res = await r.ems.applySetpoint(1000, 'api_manual_write');
  assert.equal(res.ok, false);
  assert.ok(r.logs.some((l) => l.event === 'sungrow_ems_heartbeat_unsupported'));
});

test('1c: Anzeige nach Abbruch zeigt Self-consumption, nicht den alten forced-Befehl', async () => {
  const image = sungrowImage();
  const r = extRig(hbMock(image, { accept: 'never' }));
  await r.ems.applySetpoint(1000, 'api_manual_write');
  const s = r.state.ctrl.sungrowEms;
  assert.equal(s.decision.mode, 'self');
  assert.equal(s.decision.reason, 'heartbeat_mismatch');
  assert.equal(s.owns, false);
  // device stammt aus der Rücklesung der Neutralisierung → Self (Modus 0), nicht der forced-Discharge-Stand.
  assert.ok(s.device == null || s.device.mode === EMS_MODE.SELF);
});

test('1d: Sperre löst sich ohne Neustart, wenn die Herzschlag-Einstellung geändert wird', async () => {
  const image = sungrowImage();
  const r = extRig(hbMock(image, { accept: 'fc16' })); // FC 06 scheitert zunächst
  // Erst FC 06 erzwingen → scheitert, Sperre.
  r.cfg.sungrow.heartbeatWriteFc = 6;
  const no = await r.ems.applySetpoint(1000, 'api_manual_write');
  assert.equal(no.ok, false);
  assert.equal(r.state.ctrl.sungrowEms.heartbeatSupported, false);
  // Einstellung ändern (auf Auto) → Sperre zurückgesetzt, nächster Versuch gelingt per FC 16.
  r.cfg.sungrow.heartbeatWriteFc = undefined;
  r.advance(1000);
  const yes = await r.ems.applySetpoint(1000, 'api_manual_write');
  assert.equal(yes.ok, true);
  assert.equal(r.state.ctrl.sungrowEms.heartbeatWorkingFc, 16);
  assert.ok(r.logs.some((l) => l.event === 'sungrow_ems_heartbeat_config_changed'));
});

// --- Punkt 2: Anlagendaten je WR — getrennte Lade-/Entlade-Grenzen + EOS-Summen -----------------------

test('Punkt 2: Entlade-Grenze = Summe der WR-Entladeleistungen (Master 5 + Slave 5 = 10 kW)', async () => {
  const r = emsRig({
    device: sungrowDevice({ bdcRatedW: 10000 }), batteryPowerW: 0, aggregateTelemetry: true,
    optimizer: { maxChargeW: 5000, maxDischargeW: 5000 },
    secondPowers: { maxChargeW: 5000, maxDischargeW: 5000, batteryCapacityWh: 5000 },
    second: { batteryPowerW: 0, pvPowerW: 0, socPct: 50, bdcRatedW: 10000 },
  });
  await r.ems.applySetpoint(-20000, 'rule:abend');
  const pw = r.t.writes.find((w) => w.address === POWER);
  assert.equal(pw.value, 10000); // min(BDC-Summe 20000, Entlade-Summe 10000)
});

test('Punkt 2: Slave offline → nur Master-Anteil der Entlade-Grenze (5 kW)', async () => {
  const r = emsRig({
    device: sungrowDevice({ bdcRatedW: 10000 }), batteryPowerW: 0, aggregateTelemetry: true,
    optimizer: { maxChargeW: 5000, maxDischargeW: 5000 },
    secondPowers: { maxChargeW: 5000, maxDischargeW: 5000 },
    second: { batteryPowerW: 0, pvPowerW: 0, socPct: 50, bdcRatedW: 10000 },
  });
  r.state.sungrowSecond.online = false;             // Slave nicht einbezogen
  await r.ems.applySetpoint(-20000, 'rule:abend');
  const pw = r.t.writes.find((w) => w.address === POWER);
  assert.equal(pw.value, 5000);                     // nur Master-Entladeleistung
});

test('Punkt 2: planningCfg summiert Kapazität und Leistung für EOS (10/5 kWh je 5 kW → 15 kWh/10 kW)', () => {
  const cfg = {
    manufacturer: 'sungrow',
    optimizer: { batteryCapacityWh: 10000, maxChargeW: 5000, maxDischargeW: 5000 },
    sungrow: { secondInverter: { host: '192.168.68.83', aggregateTelemetry: true, batteryCapacityWh: 5000, maxChargeW: 5000, maxDischargeW: 5000 } },
  };
  const ctx = { getCfg: () => cfg, state: { victron: { soc: 60 }, sungrowSecond: { online: true, updatedAt: Date.now(), socPct: 40, batteryPowerW: 0, pvPowerW: 0, bdcRatedW: 10000 } } };
  const p = planningCfg(ctx, cfg);
  assert.equal(p.optimizer.batteryCapacityWh, 15000);
  assert.equal(p.optimizer.maxChargeW, 10000);
  assert.equal(p.optimizer.maxDischargeW, 10000);
});

test('Punkt 2: planningCfg ohne Aggregation/Slave offline → unverändert (nur Master)', () => {
  const cfg = {
    manufacturer: 'sungrow',
    optimizer: { batteryCapacityWh: 10000, maxChargeW: 5000, maxDischargeW: 5000 },
    sungrow: { secondInverter: { host: '192.168.68.83', aggregateTelemetry: true, batteryCapacityWh: 5000 } },
  };
  const ctx = { getCfg: () => cfg, state: { victron: { soc: 60 }, sungrowSecond: { online: false, updatedAt: Date.now() } } };
  assert.equal(planningCfg(ctx, cfg), cfg); // dasselbe Objekt, keine Summe
});

test('Aufgabe 4: EOS bekommt die GERÄTEWERTE beider WR (battery_max_charge ≈ 21200, inverter = Summe 20000)', () => {
  // Feld 15.11.: Slave-Konfig leer → EOS bekam 10600 (nur Master) statt 21200. Jetzt: Gerätewerte beider WR, Feld
  // nur als Übersteuerung. BDC 11 kW (deckelt NICHT): je WR Laden 10600 (33047), Entladen 10000 (33048).
  const cfg = {
    manufacturer: 'sungrow',
    optimizer: { batteryCapacityWh: 10000 }, // maxChargeW/maxDischargeW LEER → Gerätewert zieht
    sungrow: { secondInverter: { host: '192.168.68.83', aggregateTelemetry: true } },
  };
  const ctx = { getCfg: () => cfg, state: {
    victron: { soc: 60, device: { vendor: 'sungrow', bdcRatedW: 11000, maxChargeWDevice: 10600, maxDischargeWDevice: 10000, batteryCapacityLimitWh: 10000 } },
    sungrowSecond: { online: true, updatedAt: Date.now(), socPct: 40, batteryPowerW: 0, pvPowerW: 0, bdcRatedW: 11000, maxChargeWDevice: 10600, maxDischargeWDevice: 10000, batteryCapacityLimitWh: 10000 },
  } };
  const p = planningCfg(ctx, cfg);
  assert.equal(p.optimizer.maxChargeW, 21200);          // 10600 + 10600 (≈ Feld-Erwartung 21200)
  assert.equal(p.optimizer.maxDischargeW, 20000);       // 10000 + 10000
  assert.equal(p.system.power.inverterMaxPowerW, 20000); // Summe der WR-Nennleistungen (Entladeseite), nicht maxPowerW
  assert.equal(p.optimizer.batteryCapacityWh, 20000);   // Feld 10000 (Master) + Slave-Kapazität 10000
});

test('Aufgabe 4: Feld übersteuert strenger (gesetzter Wert < Gerätewert gewinnt)', () => {
  const cfg = {
    manufacturer: 'sungrow',
    optimizer: { batteryCapacityWh: 10000, maxChargeW: 8000 }, // strenger als 33047
    sungrow: { secondInverter: { host: '192.168.68.83', aggregateTelemetry: true, maxChargeW: 7000 } },
  };
  const ctx = { getCfg: () => cfg, state: {
    victron: { soc: 60, device: { vendor: 'sungrow', bdcRatedW: 11000, maxChargeWDevice: 10600, maxDischargeWDevice: 10000 } },
    sungrowSecond: { online: true, updatedAt: Date.now(), socPct: 40, batteryPowerW: 0, pvPowerW: 0, bdcRatedW: 11000, maxChargeWDevice: 10600, maxDischargeWDevice: 10000 },
  } };
  const p = planningCfg(ctx, cfg);
  assert.equal(p.optimizer.maxChargeW, 15000); // min(8000,10600,11000)=8000 + min(7000,10600,11000)=7000
});

test('Aufgabe 4 + M1: Min-SoC an EOS = effektiver Entlade-Boden inkl. Puffer = max(hartem Boden, 13059 beider WR + Puffer)', () => {
  const cfg = {
    manufacturer: 'sungrow', optimizer: { hardFloorSocPct: 5 },
    sungrow: { secondInverter: { host: '192.168.68.83', aggregateTelemetry: true } },
  };
  const ctx = { getCfg: () => cfg, state: {
    victron: { soc: 60, device: { vendor: 'sungrow', minSocPctDevice: 10 } },
    sungrowSecond: { online: true, updatedAt: Date.now(), socPct: 40, batteryPowerW: 0, pvPowerW: 0, bdcRatedW: 11000, minSocPctDevice: 12 },
  } };
  // M1 (Christin 16.11.): EOS bekommt denselben Boden wie der Aktuator — geräteMin real + Puffer (Default 1).
  // max(5, 10+1, 12+1) = 13.
  assert.equal(planningMinSocPct(ctx, 5), 13);
  // Puffer kundeneinstellbar: 0 → roher Geräte-Boden max(5,10,12)=12; 3 → max(5,13,15)=15.
  assert.equal(planningMinSocPct({ ...ctx, getCfg: () => ({ ...cfg, sungrow: { ...cfg.sungrow, socFloorBufferPct: 0 } }) }, 5), 12);
  assert.equal(planningMinSocPct({ ...ctx, getCfg: () => ({ ...cfg, sungrow: { ...cfg.sungrow, socFloorBufferPct: 3 } }) }, 5), 15);
});

test('Aufgabe 4: Einzel-Master ohne Slave, aber mit Gerätewert → Master-Gerätewert an EOS', () => {
  const cfg = { manufacturer: 'sungrow', optimizer: { batteryCapacityWh: 10000 } };
  const ctx = { getCfg: () => cfg, state: { victron: { soc: 60, device: { vendor: 'sungrow', bdcRatedW: 11000, maxChargeWDevice: 10600, maxDischargeWDevice: 10000 } } } };
  const p = planningCfg(ctx, cfg);
  assert.equal(p.optimizer.maxChargeW, 10600);
  assert.equal(p.optimizer.maxDischargeW, 10000);
});

// --- M1: fensterrelativer SoC → echter SoC + Notladungs-Puffer (rein) ----------------

test('M1: sungrowRealSocPct — real = min + gemeldet×(max−min)/100, ohne Fenster unverändert', () => {
  // Feldbox Min 10 / Max 100: real = 10 + 0,9×gemeldet.
  assert.equal(sungrowRealSocPct(0, 10, 100), 10);      // gemeldet 0 % = real = Geräte-Untergrenze
  assert.equal(sungrowRealSocPct(100, 10, 100), 100);   // gemeldet 100 % = real = Obergrenze
  assert.ok(Math.abs(sungrowRealSocPct(0.8, 10, 100) - 10.72) < 1e-9);
  assert.ok(Math.abs(sungrowRealSocPct(2.2, 10, 100) - 11.98) < 1e-9);
  assert.equal(sungrowRealSocPct(50, 20, 80), 50);      // Fenster 20–80: 20 + 0,6×50 = 50
  // Ohne gültiges Fenster bleibt der gemeldete Wert (geklemmt).
  assert.equal(sungrowRealSocPct(57, null, null), 57);
  assert.equal(sungrowRealSocPct(57, 10, 10), 57);      // max ≤ min → keine Umrechnung
  assert.equal(sungrowRealSocPct(null, 10, 100), null); // kein SoC → null
});

test('M1: sungrowDischargeFloorPct — effektiver Boden = max(hardFloor, geräteMin + Puffer)', () => {
  assert.equal(sungrowDischargeFloorPct(0, 10, 1), 11);   // Feld: hardFloor 0, geräteMin 10, Puffer 1 → 11
  assert.equal(sungrowDischargeFloorPct(15, 10, 1), 15);  // hoher hardFloor gewinnt
  assert.equal(sungrowDischargeFloorPct(0, 10, 0), 10);   // Puffer 0 → roher Geräte-Boden
  assert.equal(sungrowDischargeFloorPct(5, null, 1), 5);  // kein Gerätewert → nur hardFloor, kein Puffer
  assert.equal(sungrowDischargeFloorPct(null, null, 1), 0); // nichts bekannt → 0
});

test('M1: sungrowSocFloorBufferPct — Default 1, kundeneinstellbar, geklemmt [0,50]', () => {
  assert.equal(sungrowSocFloorBufferPct({}), 1);
  assert.equal(sungrowSocFloorBufferPct({ sungrow: { socFloorBufferPct: 0 } }), 0);
  assert.equal(sungrowSocFloorBufferPct({ sungrow: { socFloorBufferPct: 3 } }), 3);
  assert.equal(sungrowSocFloorBufferPct({ sungrow: { socFloorBufferPct: 99 } }), 50);
  assert.equal(sungrowSocFloorBufferPct({ sungrow: { socFloorBufferPct: -2 } }), 1); // ungültig → Default
});

test('Punkt 2: SoC-Reserve/Headroom je WR (SoC 80/20, Kapazität 10/5 kWh, Boden 10 %)', () => {
  // Reserve = (SoC − Boden)/100 × Kapazität; Headroom = (max − SoC)/100 × Kapazität.
  assert.equal(sungrowReserveWh(80, 10000, 10), 7000);
  assert.equal(sungrowReserveWh(20, 5000, 10), 500);
  assert.equal(sungrowReserveWh(5, 10000, 10), 0);     // unter dem Boden → 0
  assert.equal(sungrowReserveWh(null, 10000), null);
  assert.equal(sungrowHeadroomWh(80, 10000, 100), 2000);
  assert.equal(sungrowHeadroomWh(20, 5000, 100), 4000);
});

// --- Punkt 3: Split-Steuerung — Vorgabe auf BEIDE WR, sicher scheitern ---------------------------------

test('splitSungrowPower (rein): nach Gewicht, an die Grenze geklemmt, Überlauf zum anderen', () => {
  // Entladen 5600, Master-Reserve 7000 / Slave-Reserve 500, je max 5000 → Master 5000 (an der Grenze), Slave 600.
  assert.deepEqual(splitSungrowPower({ command: 'discharge', powerW: 5600 }, { maxW: 5000, weight: 7000 }, { maxW: 5000, weight: 500 }), { masterW: 5000, slaveW: 600 });
  // 3000 auf 5/5 bei Reserve 7000/500 → Master 2800, Slave 200.
  assert.deepEqual(splitSungrowPower({ command: 'discharge', powerW: 3000 }, { maxW: 5000, weight: 7000 }, { maxW: 5000, weight: 500 }), { masterW: 2800, slaveW: 200 });
  // Ein WR an der Grenze (Master max 1000) → Rest auf den Slave.
  assert.deepEqual(splitSungrowPower({ command: 'discharge', powerW: 3000 }, { maxW: 1000, weight: 5000 }, { maxW: 5000, weight: 5000 }), { masterW: 1000, slaveW: 2000 });
  // Ohne Slave → alles auf den Master (bis zu dessen Grenze).
  assert.deepEqual(splitSungrowPower({ command: 'discharge', powerW: 3000 }, { maxW: 5000, weight: 5000 }, null), { masterW: 3000, slaveW: 0 });
});

const SPOWER = wire(13052), SMODE = wire(13050), SCMD = wire(13051);

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

function splitRig({ masterSoc = 80, slaveSoc = 20, batteryPowerW = -3000, grid = -3000, setpoint = -3000, controlMode = 'forced', optimizer = {}, secondPowers = {}, slaveMock = {} } = {}) {
  const slaveHost = '192.168.68.83';
  const cfg = loadSungrowConfig({
    gridPositiveMeans: 'grid_import',
    sungrow: { controlMode, heartbeatTimeoutS: 30, secondInverter: { host: slaveHost, aggregateTelemetry: true, control: 'split', maxChargeW: 5000, maxDischargeW: 5000, batteryCapacityWh: 5000, ...secondPowers } },
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
  const logs = [];
  const slaveEms = createSungrowEms({ state, getCfg: () => cfg, transport: t, now: () => clock, statusKey: 'sungrowEmsSlave', connOverride: () => ({ host: slaveHost, port: 502, unitId: 1 }) });
  const ems = createSungrowEms({ state, getCfg: () => cfg, transport: t, now: () => clock, pushLog: (e, d, l) => logs.push({ event: e, data: d, level: l }), slaveActuator: slaveEms });
  return { ems, slaveEms, t, state, cfg, mImage, sImage, logs, setpoint };
}

// M12 (Feld 16.11.): echter Slave-EMS (isSlave) mit einem Abbild im Zustand Modus 2 + 0xCC (wie nach Freigabe/Neustart).
function slaveEmsRig({ mode = EMS_MODE.FORCED, cmd = EMS_CMD.STOP, power = 0 } = {}) {
  const image = sungrowImage({ holding: { [wire(13050)]: mode, [wire(13051)]: cmd, [wire(13052)]: power } });
  const t = mockSungrow(image);
  const cfg = loadSungrowConfig({ gridPositiveMeans: 'grid_import', sungrow: { controlMode: 'forced', heartbeatTimeoutS: 30, secondInverter: { host: '192.168.68.83' } } });
  const state = { victron: { device: sungrowDevice() }, ctrl: {} };
  const ems = createSungrowEms({ state, getCfg: () => cfg, transport: t, now: () => 1_000_000, isSlave: true });
  return { ems, t, image, state, cfg };
}

test('M12: Slave im von DVhub geführten Zustand (Modus 2 + 0xCC) → Besitz übernommen, auch ohne Write', async () => {
  const r = slaveEmsRig({ mode: EMS_MODE.FORCED, cmd: EMS_CMD.STOP, power: 0 });
  assert.equal(r.ems._st.owns, false, 'vorher Besitz nein');
  const res = await r.ems.applyDirectCommand({ mode: 'forced', command: 'stop', powerW: 0, reason: 'floor' });
  assert.equal(res.ok, true);
  assert.equal(res.unchanged, true, 'kein Write (schon im Zielzustand)');
  assert.equal(r.ems._st.owns, true, 'Besitz übernommen');
  assert.equal(r.ems._st.ownMode, EMS_MODE.FORCED);
  assert.deepEqual(r.t.writes, [], 'kein Write ausgelöst');
});

test('M12: Slave bei Rückzug (self-Vorgabe) übernimmt NICHT den Besitz', async () => {
  const r = slaveEmsRig({ mode: EMS_MODE.SELF, cmd: EMS_CMD.STOP, power: 0 });
  await r.ems.applyDirectCommand({ mode: 'self', command: 'stop', powerW: 0 });
  assert.notEqual(r.ems._st.owns, true, 'kein Besitz bei Rückzug');
});

test('M12: echter fremder Zustand am Slave (VPP, Modus 4) bleibt fremd, kein Besitz', async () => {
  const r = slaveEmsRig({ mode: EMS_MODE.VPP, cmd: EMS_CMD.STOP, power: 0 });
  const res = await r.ems.applyDirectCommand({ mode: 'forced', command: 'stop', powerW: 0 });
  assert.equal(res.ok, false);
  assert.equal(res.foreign, true, 'VPP am Slave ist fremd');
  assert.notEqual(r.ems._st.owns, true);
});

test('Split: Entladen 3 kW bei SoC 80/20 → Master 2889 (Angleich), Slave 111, beide forced discharge', async () => {
  // soc-balance Angleich (Aufgabe 6): Referenz = min(80,20)−5 = 15. Gewicht = (SoC − Ref)×Kapazität. Master
  // 65·10000 = 650000, Slave (20−15)·5000 = 25000 → 26:1 → 3000·650000/675000 = 2889 auf den volleren Master, 111
  // auf den Slave. Der vollere WR entlädt deutlich mehr und die SoC nähern sich an — beide WR bleiben aktiv.
  const r = splitRig({ masterSoc: 80, slaveSoc: 20 });
  const res = await r.ems.applySetpoint(r.setpoint, 'rule:abend');
  assert.equal(res.ok, true);
  assert.equal(r.mImage.holding.get(SPOWER), 2889);
  assert.equal(r.sImage.holding.get(SPOWER), 111);
  assert.equal(r.mImage.holding.get(SMODE), EMS_MODE.FORCED);
  assert.equal(r.sImage.holding.get(SMODE), EMS_MODE.FORCED);
  assert.equal(r.mImage.holding.get(SCMD), EMS_CMD.DISCHARGE);
  assert.equal(r.sImage.holding.get(SCMD), EMS_CMD.DISCHARGE);
});

test('M1 (Feld 16.11., kritisch): gemeldet 0,8/2,2 % bei Fenster 10–100 → Slave entlädt (nicht beide gesperrt)', async () => {
  // Feld-Bug in b6c19495: der gemeldete SoC (0,8/2,2 %) wurde mit den REALEN Grenzen (Boden 11) verglichen → beide
  // WR < Boden → split 0/0, kein Entladen, obwohl Sungrow real ~10,7/12 % hält und noch Energie freigibt → Notladung.
  // Fix (M1): vor dem Vergleich in echten SoC umrechnen. Puffer 0 → Boden 10 (Gerät). Seit M28 (Entlade-Marge 1
  // Prozentpunkt, Christin 19.11.) bekommt ein WR unter Boden + 1 keinen Entlade-Anteil: Master real 10,72 (< 11 →
  // gesperrt), Slave real 11,98 (≥ 11 → entlädt den vollen System-Anteil 3000 W). Ohne Umrechnung lägen beide
  // gemeldet (0,8/2,2) unter dem Boden → split 0/0 (der alte Bug).
  const r = splitRig({ masterSoc: 0.8, slaveSoc: 2.2, optimizer: { hardFloorSocPct: 0 } });
  r.cfg.sungrow.socFloorBufferPct = 0;
  r.state.victron.device = { ...r.state.victron.device, minSocPctDevice: 10, maxSocPctDevice: 100 };
  r.state.sungrowSecond = { ...r.state.sungrowSecond, minSocPctDevice: 10, maxSocPctDevice: 100 };
  const res = await r.ems.applySetpoint(r.setpoint, 'rule:abend');
  assert.equal(res.ok, true);
  // Slave entlädt (real 11,98 ≥ Boden 10 + Marge 1), Master gesperrt (real 10,72 < 11) → Stopp.
  assert.equal(r.sImage.holding.get(SPOWER), 3000);
  assert.equal(r.sImage.holding.get(SCMD), EMS_CMD.DISCHARGE);
  assert.equal(r.mImage.holding.get(SCMD), EMS_CMD.STOP, 'Master am Boden → Stopp, nicht Entladen');
  // Entscheidend: NICHT beide gesperrt (der alte Bug).
  assert.ok(r.sImage.holding.get(SPOWER) > 0, 'Slave entlädt — nicht split 0/0');
});

test('Split: ein WR an der Grenze → der andere übernimmt', async () => {
  const r = splitRig({ masterSoc: 80, slaveSoc: 20, optimizer: { maxDischargeW: 1000 } }); // Master nur 1000 W
  await r.ems.applySetpoint(r.setpoint, 'rule:abend'); // System-Entladung 3000
  assert.equal(r.mImage.holding.get(SPOWER), 1000);     // Master an der Grenze
  assert.equal(r.sImage.holding.get(SPOWER), 2000);     // Slave übernimmt den Rest
});

test('Split: Slave offline → nur Master (voller Anteil), kein Slave-Write', async () => {
  const r = splitRig({ masterSoc: 80, slaveSoc: 20 });
  r.state.sungrowSecond.online = false;                 // Slave nicht einbezogen → kein Split
  await r.ems.applySetpoint(r.setpoint, 'rule:abend');
  assert.equal(r.mImage.holding.get(SPOWER), 3000);     // voller System-Anteil auf den Master
  assert.deepEqual(r.t.slave.writes, []);               // nichts an den Slave geschrieben
});

test('Aufgabe 3 (C6): Slave-Lesefehler (modbus exception 4) → Master steuert weiter, KEIN Modus 0 bei beiden', async () => {
  // Feld 15.11.: ein einmaliges „EMS-Register lesen fehlgeschlagen: modbus exception 4" warf beide WR auf Modus 0
  // (~20 s Ausfall). Jetzt: Slave-Anteil auf den Master, der Master steuert weiter. Slave-EMS-Block (wire 13050).
  const r = splitRig({ masterSoc: 80, slaveSoc: 20, slaveMock: { failReadAt: wire(13050) } });
  const res = await r.ems.applySetpoint(r.setpoint, 'rule:abend');
  assert.equal(res.ok, true, 'Master steuert weiter (ok)');
  assert.equal(res.slaveFellBack, true, 'Slave-Anteil auf den Master verlagert');
  // Master steht in Forced (NICHT Modus 0/Self) und entlädt den vollen System-Anteil.
  assert.equal(r.mImage.holding.get(SMODE), EMS_MODE.FORCED);
  assert.notEqual(r.mImage.holding.get(SMODE), EMS_MODE.SELF);
  assert.equal(r.mImage.holding.get(SCMD), EMS_CMD.DISCHARGE);
  assert.equal(r.mImage.holding.get(SPOWER), 3000); // voller System-Anteil (bis Master-Grenze)
  // Es gibt ein Fallback-Log, aber KEIN split_aborted.
  assert.ok(r.logs.some((l) => l.event === 'sungrow_ems_split_slave_fallback'));
  assert.ok(!r.logs.some((l) => l.event === 'sungrow_ems_split_aborted'));
});

test('N4/Aufgabe 5: zweiter Takt mit gleicher Entscheidung → KEINE neuen 13051/13052-Writes (je WR gedrosselt)', async () => {
  // Feld 15.11.: der Slave schrieb per forceAll JEDEN Takt 13051+13052 (Master 13052 jeden Takt). Jetzt: nur bei
  // Befehlswechsel (13051) bzw. Änderung > stepW (13052). Zweiter Sollwert −3001 rundet auf dieselbe Leistung
  // (3000) → identische Entscheidung → kein Write an beiden WR.
  const r = splitRig({ masterSoc: 60, slaveSoc: 40 });
  await r.ems.applySetpoint(-3000, 'rule:abend');
  const cnt = (mock) => mock.writes.filter((w) => w.address === SCMD || w.address === SPOWER).length;
  const mAfter1 = cnt(r.t.master); const sAfter1 = cnt(r.t.slave);
  assert.ok(sAfter1 > 0 && mAfter1 > 0, 'erster Takt schreibt beide WR');
  await r.ems.applySetpoint(-3071, 'rule:abend'); // ≈3050: Änderung 50 W < stepW 100 → kein Write (stepW-Toleranz je WR)
  assert.equal(cnt(r.t.master), mAfter1, 'Master: kein neuer 13051/13052-Write');
  assert.equal(cnt(r.t.slave), sAfter1, 'Slave: kein neuer 13051/13052-Write');
});

test('N4/Aufgabe 5: split_write-Log nur bei echtem Write (nicht bei gleichbleibendem Zustand)', async () => {
  const r = splitRig({ masterSoc: 60, slaveSoc: 40 });
  await r.ems.applySetpoint(-3000, 'rule:abend');
  const logs1 = r.logs.filter((l) => l.event === 'sungrow_ems_split_write').length;
  await r.ems.applySetpoint(-3071, 'rule:abend'); // Änderung < stepW → kein Write → kein Log
  assert.equal(r.logs.filter((l) => l.event === 'sungrow_ems_split_write').length, logs1);
});

test('N1 (gefährlich): Master unter Boden (9 %), Slave darüber (15 %) → NUR Master 0, Slave entlädt weiter (nicht beide 0xCC)', async () => {
  // Feld 15.11. 13:49: Master 9,8 % → discharge_floor → BEIDE 0xCC, obwohl der Slave 14,4 % hatte → 4,8 kW Hauslast
  // aus dem Netz, Slave-Reserve ungenutzt. Ursache: stepForced prüfte den Boden NUR am Master-SoC. Jetzt: Boden je
  // WR im Split-Gate, der System-Regler stoppt NICHT mehr am Master-SoC.
  const r = splitRig({ masterSoc: 9, slaveSoc: 15 }); // hardFloorSocPct 10 → Master unter Boden, Slave darüber
  const res = await r.ems.applySetpoint(r.setpoint, 'rule:abend');
  assert.equal(res.ok, true);
  assert.equal(r.mImage.holding.get(SCMD), EMS_CMD.STOP);       // Master am Boden → 0xCC
  assert.equal(r.sImage.holding.get(SCMD), EMS_CMD.DISCHARGE);  // Slave entlädt weiter
  assert.equal(r.sImage.holding.get(SPOWER), 3000);             // Slave übernimmt den vollen Anteil
});

test('N1 (umgekehrt): Slave unter Boden, Master darüber → NUR Slave 0, Master entlädt weiter (kein Entladen unter Grenze)', async () => {
  const r = splitRig({ masterSoc: 15, slaveSoc: 9 });
  const res = await r.ems.applySetpoint(r.setpoint, 'rule:abend');
  assert.equal(res.ok, true);
  assert.equal(r.sImage.holding.get(SCMD), EMS_CMD.STOP);       // Slave am Boden → 0xCC (keine Notladung provoziert)
  assert.equal(r.mImage.holding.get(SCMD), EMS_CMD.DISCHARGE);
  assert.equal(r.mImage.holding.get(SPOWER), 3000);
});

test('N1: BEIDE unter Boden → beide 0xCC (Stopp), keiner entlädt', async () => {
  const r = splitRig({ masterSoc: 8, slaveSoc: 9 });
  await r.ems.applySetpoint(r.setpoint, 'rule:abend');
  assert.equal(r.mImage.holding.get(SCMD), EMS_CMD.STOP);
  assert.equal(r.sImage.holding.get(SCMD), EMS_CMD.STOP);
});

test('N2: transienter modbus timeout am Slave → bis zu 2× wiederholt → Split gelingt (kein Master-only, kein Modus 0)', async () => {
  // 'modbus timeout' ist jetzt retryable (N2). failReadOnce feuert EINMAL → der Retry gelingt → normaler Split.
  const r = splitRig({ masterSoc: 60, slaveSoc: 40, slaveMock: { failReadOnce: wire(13050) } });
  const res = await r.ems.applySetpoint(r.setpoint, 'rule:abend');
  assert.equal(res.ok, true);
  assert.notEqual(res.slaveFellBack, true);                     // kein Fallback nötig — Retry hat's getragen
  assert.equal(r.sImage.holding.get(SCMD), EMS_CMD.DISCHARGE);  // Slave normal gesteuert
});

test('4b: Netzanschluss-Grenze deckelt das Netzladen am Aktuator (gridConnection.limitKw)', async () => {
  // allowGridCharge an, großer positiver Sollwert (Netzladen) → Akku-Ladung ≤ Anschlussgrenze (3 kW).
  const r = emsRig({
    batteryPowerW: 0, pvPowerW: 0, selfConsumptionW: 0,
    optimizer: { allowGridCharge: true, maxChargeW: 10000, maxDischargeW: 10000 },
    extra: { gridConnection: { limitKw: 3 } },
    device: sungrowDevice({ bdcRatedW: 20000 }),
  });
  await r.ems.applySetpoint(10000, 'rule:netzladen'); // will 10 kW Netzbezug → Laden
  const pw = r.t.writes.find((w) => w.address === POWER);
  assert.ok(pw && pw.value <= 3000, `Ladung ${pw?.value} ≤ 3000 (Anschlussgrenze)`);
  assert.ok(r.t.writes.some((w) => w.address === CMD && w.value === EMS_CMD.CHARGE));
});

test('Aufgabe 2: Slave in Notladung → aus dem Split, Master bekommt alles, kein Lade-/Entladebefehl an den Slave', async () => {
  const r = splitRig({ masterSoc: 80, slaveSoc: 10 });
  r.state.sungrowSecond.emergencyCharge = true;         // Slave lädt eigenmächtig (0x4001) → nicht steuerbar
  const res = await r.ems.applySetpoint(r.setpoint, 'rule:abend');
  assert.equal(res.ok, true);
  assert.equal(r.mImage.holding.get(SPOWER), 3000);     // voller System-Anteil auf den steuerbaren Master
  // Kein Lade-/Entladebefehl (0xAA/0xBB) an den Slave — er bleibt bei sich (höchstens 0xCC best effort).
  const slaveCmdWrites = r.t.slave.writes.filter((w) => w.address === SCMD && [EMS_CMD.CHARGE, EMS_CMD.DISCHARGE].includes(w.value));
  assert.deepEqual(slaveCmdWrites, []);
});

test('Split: Not-Halt → beide zurück in Self-consumption', async () => {
  const r = splitRig({ masterSoc: 80, slaveSoc: 20 });
  await r.ems.applySetpoint(r.setpoint, 'rule:abend');   // beide forced discharge
  r.state.ctrl.discretionaryWritesPaused = true;
  r.state.ctrl.pausedAt = 42;
  await r.ems.emergencyStop();
  assert.equal(r.mImage.holding.get(SMODE), EMS_MODE.SELF);
  assert.equal(r.sImage.holding.get(SMODE), EMS_MODE.SELF);
});

test('Split (External EMS): Herzschlag am Slave scheitert → C6 Master-only (Master steuert weiter, Slave in Self)', async () => {
  // Slave ignoriert 13080-Writes (bleibt 20) → Herzschlag-Rücklesung weicht ab → applyDirectCommand scheitert.
  // Aufgabe 3/C6: NICHT beide auf Modus 0 — der Master ist sicher steuerbar und läuft weiter (External EMS), der
  // Slave wird sicher in Self zurückgezogen. Modus 0 (beide) nur bei MASTER-Fehler.
  const r = splitRig({ masterSoc: 80, slaveSoc: 20, controlMode: 'external', slaveMock: { ignoreWriteAt: HBA } });
  const res = await r.ems.applySetpoint(r.setpoint, 'rule:abend');
  assert.equal(res.ok, true);
  assert.equal(res.slaveFellBack, true);
  assert.equal(r.mImage.holding.get(SMODE), EMS_MODE.EXTERNAL); // Master steuert weiter (nicht Self)
  assert.equal(r.sImage.holding.get(SMODE), EMS_MODE.SELF);     // Slave sicher zurückgezogen
  assert.ok(r.logs.some((l) => l.event === 'sungrow_ems_split_slave_fallback'));
  assert.ok(!r.logs.some((l) => l.event === 'sungrow_ems_split_aborted'));
});

// --- Punkt 3: Keepalive + Geräte-Rückfall (Feldtest 12c8122e) -----------------------------------------

const POWER13052 = wire(13052);

test('3a: deviceManaged → Lebenszeichen (13052 neu) im Keepalive-Takt, auch ohne Sollwert-Änderung', async () => {
  const image = sungrowImage();
  const r = extRig(hbMock(image, { accept: 'never' }), { acceptDeviceHeartbeatS: 600 });
  await r.ems.applySetpoint(1000, 'api_manual_write'); // External EMS, deviceManaged (13080 nicht beschreibbar)
  assert.equal(r.state.ctrl.sungrowEms.heartbeatDeviceManaged, true);
  r.mock.writes.length = 0;
  r.advance(11000); // > Keepalive-Takt (max 10 s)
  await r.ems.tick();
  assert.ok(r.mock.writes.some((w) => w.address === POWER13052 && w.fc === 6), 'Leistung als Lebenszeichen neu geschrieben');
});

test('3a: keepaliveRegister=13052 → Lebenszeichen per Leistung (nicht 13080)', async () => {
  const image = sungrowImage();
  const r = extRig(hbMock(image, { accept: 'mode3' }), { keepaliveRegister: '13052' });
  await r.ems.applySetpoint(1000, 'api_manual_write');
  r.mock.writes.length = 0;
  r.advance(11000);
  await r.ems.tick();
  assert.ok(r.mock.writes.some((w) => w.address === POWER13052));
  assert.ok(!r.mock.writes.some((w) => w.address === HBA), 'kein 13080-Lebenszeichen bei keepaliveRegister 13052');
});

test('3b: Geräte-Rückfall (WR steht in Self trotz Besitz) → sungrow_ems_device_fallback mit afterS', async () => {
  const image = sungrowImage();
  const r = extRig(hbMock(image, { accept: 'never' }), { acceptDeviceHeartbeatS: 600 });
  await r.ems.applySetpoint(1000, 'api_manual_write');
  image.holding.set(MODEA, EMS_MODE.SELF); // WR fällt von selbst zurück
  r.advance(30000);
  await r.ems.tick();
  const ev = r.logs.find((l) => l.event === 'sungrow_ems_device_fallback');
  assert.ok(ev, 'Rückfall gemeldet');
  assert.ok(ev.data.afterS >= 30, `afterS gemessen: ${ev.data.afterS}`);
});

test('3c: Neueintritt nach Rückfall erst nach 10 s (kein sofortiger Wiedereintritt)', async () => {
  const image = sungrowImage();
  const r = extRig(hbMock(image, { accept: 'never' }), { acceptDeviceHeartbeatS: 600 });
  await r.ems.applySetpoint(1000, 'api_manual_write'); // External, Eintritt bestätigt
  image.holding.set(MODEA, EMS_MODE.SELF);             // WR fällt von selbst zurück
  r.advance(1000);
  await r.ems.applySetpoint(1100, 'api_manual_write'); // frischer (geänderter) Sollwert erkennt den Rückfall
  assert.ok(r.logs.some((l) => l.event === 'sungrow_ems_device_fallback'), 'Rückfall erkannt');
  image.holding.set(MODEA, EMS_MODE.SELF);
  r.mock.writes.length = 0;
  r.advance(5000);                                     // < 10 s seit Rückfall
  const res = await r.ems.applySetpoint(1200, 'api_manual_write');
  assert.equal(res.error, 'fallback_reentry_wait');
  assert.ok(!r.mock.writes.some((w) => w.address === MODEA && w.value === EMS_MODE.EXTERNAL), 'kein Wiedereintritt < 10 s');
  r.mock.writes.length = 0;
  r.advance(6000);                                     // jetzt > 10 s seit Rückfall
  await r.ems.applySetpoint(1300, 'api_manual_write');
  assert.ok(r.mock.writes.some((w) => w.address === MODEA && w.value === EMS_MODE.EXTERNAL), 'Wiedereintritt nach 10 s');
});

test('3c: >3 Rückfälle/min → DVhub steuert vorerst nicht (Self, Warnung)', async () => {
  const image = sungrowImage();
  const r = extRig(hbMock(image, { accept: 'never' }), { acceptDeviceHeartbeatS: 600 });
  await r.ems.applySetpoint(1000, 'api_manual_write');
  // Vier echte Rückfall→Wiedereintritt-Zyklen in < 60 s: je Rückfall erkennen (wait), nach 10 s wieder eintreten,
  // dann erneut von Hand in Self zwingen. So zählt jeder Rückfall genau einmal.
  for (let i = 0; i < 4; i += 1) {
    image.holding.set(MODEA, EMS_MODE.SELF); // Gerät fällt von selbst zurück
    r.advance(1000);
    const res = await r.ems.applySetpoint(1000 + i * 20 + 1, 'api_manual_write'); // geänderter Sollwert → Rückfall i erkannt
    if (res.error === 'device_fallback_rate') break;
    r.advance(11000);
    await r.ems.applySetpoint(1000 + i * 20 + 2, 'api_manual_write'); // > 10 s → Wiedereintritt (External)
  }
  assert.ok(r.logs.some((l) => l.event === 'sungrow_ems_device_fallback_rate'), 'Raten-Warnung');
  assert.equal(r.state.ctrl.sungrowEms.decision.reason, 'device_fallback_rate');
  // Abkühlung: innerhalb der nächsten Minute KEIN Wiedereintritt (Mode-Register 13050 nicht weiter thrashen).
  r.mock.writes.length = 0;
  r.advance(30000);
  const res = await r.ems.applySetpoint(1500, 'api_manual_write');
  assert.equal(res.error, 'device_fallback_rate');
  assert.ok(!r.mock.writes.some((w) => w.address === MODEA && w.value === EMS_MODE.EXTERNAL), 'kein Wiedereintritt in der Abkühlung');
});

// --- Aufteilungs-Strategien (Punkt 1, splitStrategyShares, rein) -----------------
test('Strategie soc-balance (Standard): Entladen → mehr nutzbare Reserve bekommt mehr', () => {
  // Master SoC 80 %, Slave 20 %, gleiche Kapazität/Grenze → Master (mehr Reserve) bekommt mehr.
  const s = splitStrategyShares('soc-balance', {
    powerW: 4000, charge: false, masterMax: 5000, slaveMax: 5000,
    masterSoc: 80, slaveSoc: 20, masterCapacityWh: 5000, slaveCapacityWh: 5000, floorSocPct: 5, minPowerW: 50,
  });
  assert.equal(s.masterW + s.slaveW, 4000);
  assert.ok(s.masterW > s.slaveW, `master ${s.masterW} > slave ${s.slaveW}`);
  assert.equal(s.slaveUncommanded, false);
});

test('soc-balance verfeinert: Grundaufteilung nach Kapazität bei gleichem SoC (60/40-Kapazität → 60/40-Leistung)', () => {
  // Gleicher SoC → kein Gegensteuern, nur die kapazitäts-proportionale Grundaufteilung.
  const s = splitStrategyShares('soc-balance', { powerW: 3000, charge: true, masterMax: 5000, slaveMax: 5000, masterSoc: 50, slaveSoc: 50, masterCapacityWh: 6000, slaveCapacityWh: 4000, minPowerW: 50 });
  assert.deepEqual([s.masterW, s.slaveW], [1800, 1200]); // 60/40
});

test('soc-balance (Angleich, Aufgabe 6): KEIN Totband mehr — auch kleine Differenz (60 vs 50) gleicht aus', () => {
  // Entladen, gleiche Kapazität: Referenz = min(60,50)−5 = 45 → Gewicht 15·5000 vs 5·5000 = 3:1 → Master (voller)
  // bekommt deutlich mehr (früher: Totband 10 → 50/50, das glich im Feld NICHTS aus). 3000·3/4 = 2250.
  const s = splitStrategyShares('soc-balance', { powerW: 3000, charge: false, masterMax: 5000, slaveMax: 5000, masterSoc: 60, slaveSoc: 50, masterCapacityWh: 5000, slaveCapacityWh: 5000, minPowerW: 50 });
  assert.equal(s.masterW + s.slaveW, 3000);
  assert.ok(s.masterW > s.slaveW, `Master (voller) ${s.masterW} > Slave ${s.slaveW}`);
  assert.deepEqual([s.masterW, s.slaveW], [2250, 750]);
});

// --- Aufgabe 6 (MUSS): SoC-Angleich in BEIDE Richtungen + Grenzen-Übernahme -------------------------
test('Aufgabe 6: Entladen SoC 10/15 → der vollere WR (15 %) bekommt mehr', () => {
  const s = splitStrategyShares('soc-balance', {
    powerW: 2000, charge: false, masterMax: 5000, slaveMax: 5000,
    masterSoc: 10, slaveSoc: 15, masterCapacityWh: 10000, slaveCapacityWh: 10000,
    masterFloorPct: 5, slaveFloorPct: 5, minPowerW: 50,
  });
  assert.equal(s.masterW + s.slaveW, 2000);
  assert.ok(s.slaveW > s.masterW, `Slave (voller, 15 %) ${s.slaveW} > Master (10 %) ${s.masterW}`);
});

test('Aufgabe 6: Laden SoC 10/15 → der leerere WR (10 %) bekommt mehr', () => {
  const s = splitStrategyShares('soc-balance', {
    powerW: 2000, charge: true, masterMax: 5000, slaveMax: 5000,
    masterSoc: 10, slaveSoc: 15, masterCapacityWh: 10000, slaveCapacityWh: 10000,
    masterCeilPct: 100, slaveCeilPct: 100, minPowerW: 50,
  });
  assert.equal(s.masterW + s.slaveW, 2000);
  assert.ok(s.masterW > s.slaveW, `Master (leerer, 10 %) ${s.masterW} > Slave (15 %) ${s.slaveW}`);
});

test('Aufgabe 6 (Feld-Befund): Laden SoC 9,2/14,4 → Master (leerer) deutlich mehr (nicht 50/50)', () => {
  // Der Feld-Split war ≈50/50 (1543/1557) — soc-balance glich NICHTS aus (Totband). Jetzt: leererer Master mehr.
  const s = splitStrategyShares('soc-balance', {
    powerW: 3100, charge: true, masterMax: 10000, slaveMax: 10000,
    masterSoc: 9.2, slaveSoc: 14.4, masterCapacityWh: 10000, slaveCapacityWh: 10000, minPowerW: 50,
  });
  assert.equal(s.masterW + s.slaveW, 3100);
  assert.ok(s.masterW - s.slaveW > 500, `Master ${s.masterW} deutlich > Slave ${s.slaveW} (nicht 50/50)`);
});

// --- Aufgabe 1 (MUSS): je WR an SEINER Grenze → 0 W, der andere übernimmt ----------------------------
test('Aufgabe 1: Entladen — Master an seinem Min-SoC (10 %) → 0 W, Slave übernimmt den Rest', () => {
  const s = splitStrategyShares('soc-balance', {
    powerW: 3000, charge: false, masterMax: 5000, slaveMax: 5000,
    masterSoc: 10, slaveSoc: 50, masterCapacityWh: 10000, slaveCapacityWh: 10000,
    masterFloorPct: 10, slaveFloorPct: 10, minPowerW: 50,
  });
  assert.equal(s.masterW, 0, 'Master am Boden → kein Entladen');
  assert.equal(s.slaveW, 3000, 'Slave übernimmt (bis zu seiner Grenze)');
});

test('Aufgabe 1: Laden — Slave an seinem Max-SoC (95 %) → 0 W, Master übernimmt den Rest', () => {
  const s = splitStrategyShares('soc-balance', {
    powerW: 3000, charge: true, masterMax: 5000, slaveMax: 5000,
    masterSoc: 50, slaveSoc: 95, masterCapacityWh: 10000, slaveCapacityWh: 10000,
    masterCeilPct: 100, slaveCeilPct: 95, minPowerW: 50,
  });
  assert.equal(s.slaveW, 0, 'Slave an der Decke → kein Laden');
  assert.equal(s.masterW, 3000, 'Master übernimmt');
});

test('Aufgabe 1: Entladen — BEIDE am Boden → kein Entladen (0/0), keiner unter Grenze', () => {
  const s = splitStrategyShares('soc-balance', {
    powerW: 3000, charge: false, masterMax: 5000, slaveMax: 5000,
    masterSoc: 10, slaveSoc: 10, masterFloorPct: 10, slaveFloorPct: 10, minPowerW: 50,
  });
  assert.deepEqual([s.masterW, s.slaveW], [0, 0]);
});

test('Aufgabe 1: wirksame Grenzen — Entlade-Boden = max(hardFloor, 13059), Lade-Decke = min(maxSoc, 13058)', () => {
  assert.equal(sungrowDischargeFloorPct(5, 10), 10);   // Gerät strenger
  assert.equal(sungrowDischargeFloorPct(15, 10), 15);  // harter Boden strenger
  assert.equal(sungrowDischargeFloorPct(5, null), 5);  // kein Gerätewert → nur harter Boden
  assert.equal(sungrowChargeCeilPct(100, 95), 95);     // Gerät strenger
  assert.equal(sungrowChargeCeilPct(90, 95), 90);      // Konfig strenger
  assert.equal(sungrowChargeCeilPct(100, null), 100);  // kein Gerätewert → nur Konfig
});

// --- M28 (MUSS): leerer WR behält seinen Anteil nicht, der andere springt ein --------------------------
// Feldbeleg 12:28: Entladen 1200 W, Split Master 416 / Slave 784. Master real 10,6 % (Grenze 10 %) lieferte 0 W,
// Slave lieferte 790 W, Netz +552 W statt −40 W, 15 s stabil. Die Überlauf-Regel griff nur nach SoC (≤ Grenze).
test('M28 Marge: WR < 1 Prozentpunkt über seiner Entladegrenze → kein Entlade-Anteil, der andere bekommt alles', () => {
  const field = {
    powerW: 1200, charge: false, masterMax: 5000, slaveMax: 5000, masterSoc: 10.6, slaveSoc: 14.9,
    masterCapacityWh: 9600, slaveCapacityWh: 9690, masterFloorPct: 10, slaveFloorPct: 10, minPowerW: 50,
  };
  // Ohne Marge (alter Stand): der Master gilt mit 0,6 Punkten über der Grenze als lieferfähig → ≈ 416/784.
  const old = splitStrategyShares('soc-balance', field);
  assert.ok(old.masterW > 300, `ohne Marge bekommt der Master noch ${old.masterW} W`);
  // Mit Marge 1 Prozentpunkt: Master 0, Slave den vollen Bedarf.
  const s = splitStrategyShares('soc-balance', { ...field, dischargeMarginPct: 1 });
  assert.deepEqual([s.masterW, s.slaveW], [0, 1200]);
  assert.equal(s.masterOut, 'soc', 'Grund: SoC-Grenze (inkl. Marge)');
  // Genau 1 Punkt darüber zählt wieder als lieferfähig.
  const edge = splitStrategyShares('soc-balance', { ...field, masterSoc: 11, dischargeMarginPct: 1 });
  assert.ok(edge.masterW > 0, `bei 11 % (genau +1) wieder ein Anteil: ${edge.masterW}`);
});

test('M28 Marge: Laden bleibt erlaubt — die Marge gilt nur beim Entladen', () => {
  const s = splitStrategyShares('soc-balance', {
    powerW: 1200, charge: true, masterMax: 5000, slaveMax: 5000, masterSoc: 10.6, slaveSoc: 14.9,
    masterCapacityWh: 9600, slaveCapacityWh: 9690, masterFloorPct: 10, slaveFloorPct: 10,
    masterCeilPct: 100, slaveCeilPct: 100, minPowerW: 50, dischargeMarginPct: 1,
  });
  assert.ok(s.masterW > 0 && s.masterW > s.slaveW, `Master (leerer) lädt mehr: ${s.masterW}/${s.slaveW}`);
  assert.equal(s.masterOut, null);
});

test('M28 liefert nicht: masterStalled → Slave bekommt den vollen Bedarf; beide hängen → normale Aufteilung', () => {
  const base = {
    powerW: 1200, charge: false, masterMax: 5000, slaveMax: 5000, masterSoc: 30, slaveSoc: 40,
    masterCapacityWh: 10000, slaveCapacityWh: 10000, masterFloorPct: 10, slaveFloorPct: 10, minPowerW: 50,
  };
  const s = splitStrategyShares('soc-balance', { ...base, masterStalled: true });
  assert.deepEqual([s.masterW, s.slaveW], [0, 1200]);
  assert.equal(s.masterOut, 'stalled');
  const s2 = splitStrategyShares('soc-balance', { ...base, slaveStalled: true });
  assert.deepEqual([s2.masterW, s2.slaveW], [1200, 0]);
  assert.equal(s2.slaveOut, 'stalled');
  // Beide liefern nicht: umverteilen bringt nichts → normale Aufteilung, keiner ausgeschlossen.
  const both = splitStrategyShares('soc-balance', { ...base, masterStalled: true, slaveStalled: true });
  const normal = splitStrategyShares('soc-balance', base);
  assert.deepEqual([both.masterW, both.slaveW], [normal.masterW, normal.slaveW]);
  assert.deepEqual([both.masterOut, both.slaveOut], [null, null]);
  // Der andere kann nicht (an seiner Grenze) → der hängende WR behält seinen Anteil (sonst bekäme keiner etwas).
  const otherFull = splitStrategyShares('soc-balance', { ...base, masterStalled: true, slaveSoc: 10 });
  assert.equal(otherFull.masterW, 1200);
});

// --- Aufgabe 2 (MUSS): Notladung (runningState 0x4001) -----------------------------------------------
test('Aufgabe 2: isSungrowEmergencyCharge erkennt nur 0x4001', () => {
  assert.equal(isSungrowEmergencyCharge(0x4001), true);
  assert.equal(isSungrowEmergencyCharge(16385), true);
  assert.equal(isSungrowEmergencyCharge(0x0000), false);
  assert.equal(isSungrowEmergencyCharge(0x4000), false); // Externes EMS, keine Notladung
  assert.equal(isSungrowEmergencyCharge(null), false);
});

test('soc-balance verfeinert: Laden steuert zum LEEREREN WR gegen (Richtung oberes Ende)', () => {
  // Master 85 % (voller), Slave 55 % (leerer), Laden → mehr Ladeleistung auf den Slave, damit der Master nicht
  // zuerst ans obere Limit kommt.
  const s = splitStrategyShares('soc-balance', { powerW: 3000, charge: true, masterMax: 5000, slaveMax: 5000, masterSoc: 85, slaveSoc: 55, masterCapacityWh: 5000, slaveCapacityWh: 5000, minPowerW: 50 });
  assert.ok(s.slaveW > s.masterW, `Slave (leerer) ${s.slaveW} > Master ${s.masterW}`);
  assert.equal(s.masterW + s.slaveW, 3000);
});

test('soc-balance verfeinert: Entladen steuert zum VOLLEREN WR gegen (Symmetrie am Boden)', () => {
  // Master 15 % (nahe Boden), Slave 45 % (voller), Entladen → mehr auf den Slave, damit der Master nicht zuerst
  // auf den Boden fällt.
  const s = splitStrategyShares('soc-balance', { powerW: 3000, charge: false, masterMax: 5000, slaveMax: 5000, masterSoc: 15, slaveSoc: 45, masterCapacityWh: 5000, slaveCapacityWh: 5000, floorSocPct: 10, minPowerW: 50 });
  assert.ok(s.slaveW > s.masterW, `Slave (voller) ${s.slaveW} > Master (nahe Boden) ${s.masterW}`);
});

test('soc-balance verfeinert: Überlauf über eine WR-Grenze geht an den anderen', () => {
  // Starkes Gegensteuern zum Master (voll, Entladen), aber Master-Grenze nur 1000 → Rest an den Slave.
  const s = splitStrategyShares('soc-balance', { powerW: 4000, charge: false, masterMax: 1000, slaveMax: 5000, masterSoc: 90, slaveSoc: 20, masterCapacityWh: 5000, slaveCapacityWh: 5000, floorSocPct: 5, minPowerW: 50 });
  assert.equal(s.masterW, 1000, 'Master an der Grenze');
  assert.equal(s.slaveW, 3000, 'Slave übernimmt den Überlauf');
});

test('Strategie master-only: Slave nicht gesteuert (Modus 0), Master bekommt alles (an Grenze)', () => {
  const s = splitStrategyShares('master-only', { powerW: 4000, charge: true, masterMax: 3000, slaveMax: 5000, minPowerW: 50 });
  assert.deepEqual([s.masterW, s.slaveW, s.slaveUncommanded], [3000, 0, true]);
});

test('Strategie ratio: fester Master-Anteil', () => {
  const s = splitStrategyShares('ratio', { powerW: 4000, charge: true, masterMax: 5000, slaveMax: 5000, ratioMasterPct: 70, minPowerW: 50 });
  assert.deepEqual([s.masterW, s.slaveW], [2800, 1200]);
});

test('Strategie by-capacity: im Verhältnis der Akku-Kapazitäten', () => {
  const s = splitStrategyShares('by-capacity', { powerW: 3000, charge: true, masterMax: 9000, slaveMax: 9000, masterCapacityWh: 9600, slaveCapacityWh: 9690, maxSocPct: 100, masterSoc: 50, slaveSoc: 50, minPowerW: 50 });
  assert.equal(s.masterW + s.slaveW, 3000);
  assert.ok(Math.abs(s.masterW - 1493) <= 1, `master ~1493: ${s.masterW}`); // 3000*9600/19290
});

test('Strategie by-power: im Verhältnis der Leistungsgrenzen', () => {
  const s = splitStrategyShares('by-power', { powerW: 3000, charge: true, masterMax: 2000, slaveMax: 4000, minPowerW: 50 });
  assert.deepEqual([s.masterW, s.slaveW], [1000, 2000]);
});

test('Strategie priority-master: Master zuerst voll, Rest an den Slave', () => {
  const s = splitStrategyShares('priority-master', { powerW: 5000, charge: true, masterMax: 3000, slaveMax: 5000, minPowerW: 50 });
  assert.deepEqual([s.masterW, s.slaveW], [3000, 2000]);
});

test('Strategie priority-slave: Slave zuerst voll, Rest an den Master', () => {
  const s = splitStrategyShares('priority-slave', { powerW: 5000, charge: true, masterMax: 5000, slaveMax: 3000, minPowerW: 50 });
  assert.deepEqual([s.masterW, s.slaveW], [2000, 3000]);
});

test('Split: Überlauf — ein WR an der Grenze, der andere übernimmt den Rest; Summe bleibt die Vorgabe', () => {
  const s = splitStrategyShares('ratio', { powerW: 4000, charge: true, masterMax: 1000, slaveMax: 5000, ratioMasterPct: 80, minPowerW: 50 });
  assert.equal(s.masterW, 1000);           // an die Master-Grenze geklemmt
  assert.equal(s.masterW + s.slaveW, 4000); // Rest an den Slave
});

test('Split: Anteil < minPowerW wird dem anderen WR zugeschlagen (keine Leistung verloren)', () => {
  const s = splitStrategyShares('ratio', { powerW: 2000, charge: true, masterMax: 5000, slaveMax: 5000, ratioMasterPct: 1, minPowerW: 50 });
  // 1 % = 20 W < 50 W → dem Slave zugeschlagen.
  assert.deepEqual([s.masterW, s.slaveW], [0, 2000]);
});

test('Split: Slave offline (slaveMax 0) → alles an den Master', () => {
  const s = splitStrategyShares('soc-balance', { powerW: 4000, charge: false, masterMax: 5000, slaveMax: 0, masterSoc: 50, masterCapacityWh: 5000, minPowerW: 50 });
  assert.deepEqual([s.masterW, s.slaveW, s.slaveUncommanded], [4000, 0, false]);
});

test('resolveSecondInverter: Strategien + Rückwärtskompatibilität zum alten control-Feld', () => {
  assert.equal(SPLIT_STRATEGIES.length, 7);
  // Standard ohne Angabe: soc-balance, Entladen erbt Laden.
  const d = resolveSecondInverter({ sungrow: { secondInverter: { host: 'x' } } });
  assert.deepEqual([d.strategyCharge, d.strategyDischarge, d.ratioMasterPct], ['soc-balance', 'soc-balance', 50]);
  // Alt: control self-only → master-only; split → soc-balance.
  assert.equal(resolveSecondInverter({ sungrow: { secondInverter: { host: 'x', control: 'self-only' } } }).strategyCharge, 'master-only');
  assert.equal(resolveSecondInverter({ sungrow: { secondInverter: { host: 'x', control: 'split' } } }).strategyCharge, 'soc-balance');
  // Entladen erbt Laden, wenn nicht gesetzt; eigener Wert gewinnt.
  const e = resolveSecondInverter({ sungrow: { secondInverter: { host: 'x', strategyCharge: 'by-power' } } });
  assert.deepEqual([e.strategyCharge, e.strategyDischarge], ['by-power', 'by-power']);
  const f = resolveSecondInverter({ sungrow: { secondInverter: { host: 'x', strategyCharge: 'by-power', strategyDischarge: 'ratio', ratioMasterPct: 150 } } });
  assert.deepEqual([f.strategyCharge, f.strategyDischarge, f.ratioMasterPct], ['by-power', 'ratio', 100]); // ratioMasterPct geklemmt
});

// Befund 4 (Fable-Review 16.11.): Der feste Default controlMode='external' hatte die
// Zwei-WR-Automatik maskiert. 'auto' (neuer Default) lässt resolveSungrowControl entscheiden.
test('Befund 4: zwei WR ohne ausdrücklichen controlMode → Forced-Split; ein WR → External EMS', () => {
  assert.equal(resolveSungrowControl({ sungrow: { secondInverter: { host: '203.0.113.83' } } }).mode, 'forced', 'zwei WR, Default → forced');
  assert.equal(resolveSungrowControl({ sungrow: { controlMode: 'auto', secondInverter: { host: '203.0.113.83' } } }).mode, 'forced', 'zwei WR, auto → forced');
  assert.equal(resolveSungrowControl({ sungrow: {} }).mode, 'external', 'ein WR → external');
  assert.equal(resolveSungrowControl({ sungrow: { controlMode: 'auto' } }).mode, 'external', 'ein WR, auto → external');
  // Ausdrückliche Wahl gewinnt immer.
  assert.equal(resolveSungrowControl({ sungrow: { controlMode: 'external', secondInverter: { host: 'x' } } }).mode, 'external', 'explizit external gewinnt');
  assert.equal(resolveSungrowControl({ sungrow: { controlMode: 'forced' } }).mode, 'forced', 'explizit forced gewinnt');
});

// Befund 2 (Fable-Review 16.11., Repro belegt): Fällt der Slave im Split aus, übernimmt der
// Master dessen Anteil — darf dabei aber seinen eigenen SoC-Boden NICHT unterschreiten.
test('Befund 2: Slave-Fehler im Split entlädt den Master NICHT unter seinen SoC-Boden', async () => {
  const SLAVE_HOST = '192.168.68.83';
  const secondInverter = { host: SLAVE_HOST, aggregateTelemetry: true, strategyCharge: 'soc-balance', strategyDischarge: 'soc-balance', maxChargeW: 5000, maxDischargeW: 5000, batteryCapacityWh: 10000 };
  // Harter Boden 20 %, Master 15 % (UNTER dem Boden), Slave 60 %. Sollwert 0, Haus zieht 3 kW → Regler will entladen.
  const cfg = loadSungrowConfig({ gridPositiveMeans: 'grid_import', sungrow: { controlMode: 'forced', heartbeatTimeoutS: 30, secondInverter }, optimizer: { maxChargeW: 5000, maxDischargeW: 5000, batteryCapacityWh: 10000, hardFloorSocPct: 20 } });
  const masterImage = sungrowImage(); const slaveImage = sungrowImage();
  const masterT = mockSungrow(masterImage);
  const slaveT = mockSungrow(slaveImage, { failReadAt: wire(13050) }); // Slave-Lesefehler (modbus exc 4)
  const clock = 1_000_000; const now = () => clock;
  const state = { victron: { errors: {}, fieldUpdatedAt: { batteryPowerW: clock, pvPowerW: clock, selfConsumptionW: clock }, device: sungrowDevice({ bdcRatedW: 10000 }), batteryPowerW: 0, pvPowerW: 0, selfConsumptionW: 3000, soc: 37.5, sungrowMasterSocPct: 15 },
    meter: { ok: true, updatedAt: clock, grid_total_w: 3000 }, ctrl: {},
    sungrowSecond: { online: true, updatedAt: clock, host: SLAVE_HOST, aggregate: true, batteryPowerW: 0, pvPowerW: 0, socPct: 60, bdcRatedW: 10000 } };
  const slaveEms = createSungrowEms({ state, getCfg: () => cfg, transport: slaveT, pushLog: () => {}, now, sleep: async () => {}, statusKey: 'sungrowEmsSlave', isSlave: true, connOverride: () => ({ host: SLAVE_HOST, port: 502, unitId: 1, timeoutMs: 1500 }) });
  const ems = createSungrowEms({ state, getCfg: () => cfg, transport: masterT, pushLog: () => {}, now, sleep: async () => {}, slaveActuator: slaveEms });
  const res = await ems.applySetpoint(0, 'rule:eigenverbrauch');
  assert.equal(res.ok, true);
  assert.equal(res.slaveFellBack, true, 'Slave-Fehler → Fallback auf Master-only');
  assert.equal(res.masterW, 0, 'Master unter seinem Boden (15% < 20%) → entlädt NICHT, auch im Fallback');
  assert.equal(masterImage.holding.get(CMD), 0xcc, 'Master-Befehl = STOPP (0xCC)');
});
