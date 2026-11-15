// test/sungrow-inverter-view.test.js — Leitstand-Kachel „Wechselrichter" (zwei Sungrow-WR, Punkt 4).
// Reine Anzeige-Logik aus public/sungrow-inverter-view.js, geladen wie im Browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

function load() {
  const file = fileURLToPath(new URL('../public/sungrow-inverter-view.js', import.meta.url));
  const sandbox = { window: {}, document: undefined };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: 'sungrow-inverter-view.js' });
  return sandbox.window.DVhubSungrowInverters;
}

const V = load();

test('ohne zweiten WR → Kachel versteckt', () => {
  assert.equal(V.view({}).hidden, true);
  assert.equal(V.view({ sungrowSecond: null }).hidden, true);
});

test('Split-Steuerung: Master- und Slave-Zeile + Summenzeile, Rollen, EMS-Status', () => {
  const status = {
    victron: {
      soc: 60, sungrowMasterSocPct: 80, sungrowMasterBatteryW: -1000, sungrowMasterPvW: 0,
      sungrowSystemBatteryW: -2168, sungrowSystemPvW: 0,
      device: { model: 'SH10RT-20', serial: 'A2351909042', bdcRatedW: 10000, info: { runningStateText: 'Externes EMS' } },
    },
    sungrowSecond: { online: true, strategyCharge: 'soc-balance', strategyDischarge: 'soc-balance', socPct: 20, batteryPowerW: -1168, pvPowerW: 0, bdcRatedW: 10000, runningStateText: 'Externes EMS' },
    sungrowEms: { controlMode: 'external', owns: true, heartbeatTimeoutS: 30, heartbeatWorkingFc: 16, heartbeatSentS: 30, regulateEveryMs: 1000, responseMs: 420, modeBudgetLeft: 18, deviceFallbackAfterS: 31, deviceFallbackCount60s: 1, writesToday: { mode13050: 2, cmd13051: 3, power13052: 5, heartbeat13080: 40 }, decision: { mode: 'forced', command: 'discharge', powerW: 1000, split: { masterW: 1000, slaveW: 1168, strategy: 'soc-balance' } } },
    sungrowEmsSlave: { controlMode: 'external', owns: true, heartbeatWorkingFc: 16, heartbeatSentS: 30, writesToday: { mode13050: 1, cmd13051: 2, power13052: 4, heartbeat13080: 40 }, modeBudgetLeft: 19, decision: { mode: 'forced', command: 'discharge', powerW: 1168 } },
  };
  const vw = V.view(status);
  assert.equal(vw.hidden, false);
  assert.equal(vw.master.role, 'Master – gesteuert');
  assert.equal(vw.master.model, 'SH10RT-20');
  assert.equal(vw.master.serial, 'A2351909042');
  assert.equal(vw.master.soc, '80 %');
  assert.equal(vw.master.battery, '-1000 W');
  assert.equal(vw.master.owns, true);
  assert.equal(vw.master.decision, 'Entladen 1000 W');
  assert.equal(vw.master.heartbeat, '30 s (FC 16)');
  // Punkt 1/2: Aufteilung, Regeltakt, Tages-Schreibzähler in der Kachel.
  assert.equal(vw.master.split, '1000 W/1168 W (soc-balance)');
  assert.equal(vw.master.regulate, '1000 ms · Antwort 420 ms');
  assert.ok(vw.master.writes.indexOf('13050 2 (Rest 18)') >= 0, vw.master.writes);
  assert.equal(vw.master.fallback, '31 s · 1/min');
  assert.equal(vw.slave.role, 'Slave – gesteuert bei Vorgaben');
  assert.equal(vw.slave.soc, '20 %');
  assert.equal(vw.slave.decision, 'Entladen 1168 W');
  assert.ok(vw.slave.writes.indexOf('13052 4') >= 0, vw.slave.writes);
  assert.equal(vw.sum.battery, '-2168 W');
  assert.equal(vw.sum.soc, '60 %');
  // F1: aktiver Modus (hier External EMS), Countdown (bei 3), Grenze je WR.
  assert.equal(vw.mode, 'External EMS (3)');
  assert.equal(vw.master.countdown, '30 s');
  assert.equal(vw.master.limit, 'Lad 10 kW / Entl 10 kW');
  assert.equal(vw.slave.limit, 'Lad 10 kW / Entl 10 kW');
});

test('F1: Dauer-Forced-Split → Modus „Forced-Split (2)", kein Countdown, Slave-Gerätegrenzen als Grenze', () => {
  const status = {
    victron: { soc: 50, sungrowMasterSocPct: 50, sungrowMasterBatteryW: -1200, device: { model: 'SH10RT-20', bdcRatedW: 10000 } },
    sungrowSecond: { online: true, strategyCharge: 'soc-balance', strategyDischarge: 'soc-balance', socPct: 50, batteryPowerW: -1200, bdcRatedW: 10000, maxChargeWDevice: 10600, maxDischargeWDevice: 5000 },
    sungrowEms: { controlMode: 'forced', owns: true, regulateEveryMs: 250, responseMs: 241, decision: { mode: 'forced', command: 'discharge', powerW: 1200, split: { masterW: 600, slaveW: 600, strategy: 'soc-balance' } } },
    sungrowEmsSlave: { controlMode: 'forced', owns: true, regulateEveryMs: 250, responseMs: 238, decision: { mode: 'forced', command: 'discharge', powerW: 600 } },
  };
  const vw = V.view(status);
  assert.equal(vw.mode, 'Forced-Split (2)');
  assert.equal(vw.master.countdown, '–', 'im Forced mode kein Countdown');
  assert.equal(vw.slave.limit, 'Lad 10,6 kW / Entl 5 kW', 'Slave-Gerätegrenzen (33047/33048), deutsches Dezimalzeichen');
  // Christin-Ergänzung: gemessene Rate/Antwortzeit JE WR.
  assert.equal(vw.master.regulate, '250 ms · Antwort 241 ms');
  assert.equal(vw.slave.regulate, '250 ms · Antwort 238 ms');
});

test('F1a: Master zeigt die GELESENEN Gerätegrenzen (33047/33048), nicht die BDC-Nennleistung (Grenzen = Gerätewerte)', () => {
  const status = {
    victron: { soc: 50, sungrowMasterSocPct: 50, device: { model: 'SH10RT-20', bdcRatedW: 10000, maxChargeWDevice: 10600, maxDischargeWDevice: 10000 } },
    sungrowSecond: { online: true, strategyCharge: 'soc-balance', strategyDischarge: 'soc-balance', socPct: 50, bdcRatedW: 10000, maxChargeWDevice: 10000, maxDischargeWDevice: 10000 },
    sungrowEms: { controlMode: 'forced', owns: true, decision: { mode: 'forced', command: 'discharge', powerW: 1000 } },
  };
  const vw = V.view(status);
  // Laden 10,6 kW (33047) ≠ Entladen 10,0 kW (33048) — der Master hängt NICHT mehr auf BDC fest.
  assert.equal(vw.master.limit, 'Lad 10,6 kW / Entl 10 kW');
});

test('F1a: Countdown nur im echten Modus 3 — Modus 0 (Eigenverbrauch) zeigt „—" trotz External-Konfiguration', () => {
  // Feld: External konfiguriert, aber am Gerät Modus 0 (Besitz abgegeben / Self) → es lief fälschlich „30 s".
  const idle = V.view({
    victron: { soc: 60, device: { model: 'SH10RT-20', bdcRatedW: 10000 } },
    sungrowSecond: { online: true, strategyCharge: 'soc-balance', strategyDischarge: 'soc-balance', bdcRatedW: 10000 },
    sungrowEms: { controlMode: 'external', owns: false, heartbeatTimeoutS: 30, heartbeatSentS: 30, decision: { mode: 'self' } },
  });
  assert.equal(idle.master.countdown, '–', 'Modus 0 → kein Countdown');
  // Gerät meldet Modus 0, obwohl DVhub (noch) besitzt → ebenfalls „—".
  const devSelf = V.view({
    victron: { soc: 60, device: { model: 'SH10RT-20', bdcRatedW: 10000 } },
    sungrowSecond: { online: true, strategyCharge: 'soc-balance', strategyDischarge: 'soc-balance', bdcRatedW: 10000 },
    sungrowEms: { controlMode: 'external', owns: true, heartbeatTimeoutS: 30, heartbeatSentS: 30, device: { mode: 0 }, decision: { mode: 'forced', command: 'discharge', powerW: 1000 } },
  });
  assert.equal(devSelf.master.countdown, '–', 'Gerät in Modus 0 → kein Countdown');
});

test('F1: Leerlauf (Eigenverbrauch) ohne Besitz → Modus „Eigenverbrauch (0)"', () => {
  const vw = V.view({ victron: { soc: 50, device: {} }, sungrowSecond: { online: true, strategyCharge: 'soc-balance', strategyDischarge: 'soc-balance' }, sungrowEms: { controlMode: 'forced', owns: false, decision: { mode: 'self' } } });
  assert.equal(vw.mode, 'Eigenverbrauch (0)');
});

test('self-only: Slave „gelesen", offline → Nicht erreichbar, kein EMS', () => {
  const status = {
    victron: { soc: 60, device: { model: 'SH10RT-20', bdcRatedW: 10000 } },
    sungrowSecond: { online: false, strategyCharge: 'master-only', strategyDischarge: 'master-only', bdcRatedW: 10000 },
    sungrowEms: { controlMode: 'forced', owns: false, decision: { mode: 'self' } },
  };
  const vw = V.view(status);
  assert.equal(vw.slave.role, 'Slave – gelesen');
  assert.equal(vw.slave.online, false);
  assert.equal(vw.slave.decision, '–');          // self-only → kein Slave-EMS
  assert.equal(vw.master.heartbeat, 'Forced mode');
});

test('Punkt 6: render benennt den Akku bei zwei WR als „Sungrow (Master + Slave)", sonst „Victron"', () => {
  const els = {};
  const el = (id) => (els[id] || (els[id] = { id, textContent: '', hidden: false }));
  const doc = { getElementById: (id) => el(id) };
  // Mit zweitem WR → Sungrow-Name, Kachel sichtbar.
  V.render({ sungrowSecond: { online: true, strategyCharge: 'soc-balance', strategyDischarge: 'soc-balance' }, victron: { device: {} }, sungrowEms: { owns: false, decision: { mode: 'self' } } }, doc);
  assert.equal(els.batSourceName.textContent, 'Sungrow (Master + Slave)');
  assert.equal(els.sungrowWrCard.hidden, false);
  // Ohne zweiten WR → zurück auf Victron, Kachel versteckt.
  V.render({}, doc);
  assert.equal(els.batSourceName.textContent, 'Victron');
  assert.equal(els.sungrowWrCard.hidden, true);
});
