// Zweiter Sungrow-WR im Master/Slave-Parallelbetrieb (T-0422, zwei WR): NUR LESEND. Steuerung geht laut
// Sungrow-Doku V1.1.11 (Energy-Management, Note) nur an den Master — hier geprüft: der Begleitdienst liest den
// zweiten WR aus und schreibt NIE; nur mit aggregateTelemetry zählt der Master-Regler beide WR zusammen.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSungrowEms, resolveSecondInverter, secondInverterTelemetry, wire, EMS_CMD, EMS_MODE,
  sungrowSecondView, sungrowSystemTelemetry, sungrowSystemSoc, sungrowSocFloor
} from '../services/inverter/sungrow.js';
import { createSungrowSecond } from '../services/inverter/sungrow-second.js';
import { buildVictronSnapshot } from '../runtime-state.js';
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
  assert.deepEqual(secondInverterTelemetry({ sungrowSecond: s }, cfgAgg, { nowMs: 1000, maxAgeMs: 20000 }),
    { batteryPowerW: -500, pvPowerW: 2000, socPct: 55, bdcRatedW: 3000 });
  // offline → null
  assert.equal(secondInverterTelemetry({ sungrowSecond: { ...s, online: false } }, cfgAgg, { nowMs: 1000 }), null);
  // veraltet → null
  assert.equal(secondInverterTelemetry({ sungrowSecond: s }, cfgAgg, { nowMs: 1000 + 25000, maxAgeMs: 20000 }), null);
  // fehlender Einzelwert bleibt null, die anderen zählen
  assert.deepEqual(secondInverterTelemetry({ sungrowSecond: { ...s, batteryPowerW: null } }, cfgAgg, { nowMs: 1000 }),
    { batteryPowerW: null, pvPowerW: 2000, socPct: 55, bdcRatedW: 3000 });
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
// batteryPowerW in state.victron ist der SYSTEM-Wert (der Poller hat PV/Akku schon aggregiert); der Regler
// zählt NICHT noch einmal dazu, er nutzt vom zweiten WR nur die BDC-Nennleistung für die System-Leistungsgrenze.
function emsRig({ device = sungrowDevice({ bdcRatedW: 3000 }), batteryPowerW = -500, second = null, aggregateTelemetry = false } = {}) {
  const secondInverter = { host: '192.168.68.83', aggregateTelemetry };
  const cfg = loadSungrowConfig({ gridPositiveMeans: 'grid_import', sungrow: { controlMode: 'forced', heartbeatTimeoutS: 30, secondInverter } });
  const image = sungrowImage();
  const t = mockSungrow(image);
  const clock = 1_000_000;
  const now = () => clock;
  const state = {
    victron: {
      errors: {}, fieldUpdatedAt: { batteryPowerW: clock, pvPowerW: clock, selfConsumptionW: clock },
      device, batteryPowerW, pvPowerW: 0, selfConsumptionW: 500
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
  const online = sungrowSecondView({ sungrowSecond: { online: true, host: '192.168.68.83', socPct: 61, batteryPowerW: 2300, pvPowerW: 0, bdcRatedW: 5000 } }, cfg);
  assert.deepEqual(online, { online: true, aggregate: true, socPct: 61, batteryPowerW: 2300, pvPowerW: 0, bdcRatedW: 5000, runningState: null, runningStateText: null });
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
