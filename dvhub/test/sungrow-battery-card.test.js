// test/sungrow-battery-card.test.js — Akku-Kachel für zwei Sungrow-WR (M9, Feld 16.11.).
// Reine Anzeige-Logik (computeSungrowBatteryView), geladen wie im Dashboard. Prüft: echter System-SoC groß +
// gemeldeter klein, Grid-Setpoint aus der richtigen Quelle, wirksame Grenze real, je WR eine Zeile.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

function loadDashboard() {
  const appPath = fileURLToPath(new URL('../public/app.js', import.meta.url));
  const source = fs.readFileSync(appPath, 'utf8');
  const sandbox = {
    console, Date, Math, Number, JSON, Intl, Set, Map, globalThis: {},
    window: { DVhubCommon: { apiFetch: async () => ({ ok: true, json: async () => ({}) }) }, addEventListener() {}, setInterval() {}, clearInterval() {} },
    setInterval() {}, clearInterval() {},
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: 'app.js' });
  return sandbox.DVhubDashboard || sandbox.window.DVhubDashboard;
}

const D = loadDashboard();

test('M9: ohne zweiten Sungrow-WR → isSungrow false (generische Kachel)', () => {
  assert.equal(D.computeSungrowBatteryView({}).isSungrow, false);
  assert.equal(D.computeSungrowBatteryView({ victron: { soc: 50 } }).isSungrow, false);
});

test('M9: echter System-SoC groß + gemeldeter klein, Grid-Setpoint aus EMS-Target, wirksame Grenze, je WR', () => {
  const status = {
    victron: {
      soc: 1, sungrowMasterSocPct: 0.8, batteryPowerW: 0, sungrowMasterBatteryW: 0, emergencyCharge: false,
      device: { minSocPctDevice: 10, maxSocPctDevice: 100, maxDischargeWDevice: 10000, bdcRatedW: 10000 },
    },
    sungrowSecond: { online: true, socPct: 2.2, batteryPowerW: -500, minSocPctDevice: 10, maxSocPctDevice: 100, maxDischargeWDevice: 10000, bdcRatedW: 10000, emergencyCharge: false },
    energyBalance: { battery: { socPct: 10.9, minSocPct: 11 } },
    sungrowEms: { target: { setpointW: 1990, source: 'eos' }, decision: { command: 'discharge', powerW: 1990, split: { masterW: 0, slaveW: 1990 } } },
  };
  const v = D.computeSungrowBatteryView(status);
  assert.equal(v.isSungrow, true);
  // Groß = echter System-SoC (10,9), nicht der gemeldete (1).
  assert.match(v.socBig, /10,9/);
  assert.match(v.socReported, /Sungrow-Anzeige/);
  assert.match(v.socReported, /1 %/);
  // Grid-Setpoint aus ctrl.sungrowEms.target (nicht victron.gridSetpointW).
  assert.equal(v.gridSetpoint, '1990 W (EOS)');
  // Wirksame Grenze real (Gerät 10 % + Puffer → 11 %).
  assert.match(v.minSoc, /11 %/);
  assert.match(v.minSoc, /Gerät 10 % \+ Puffer/);
  // Marken.
  assert.match(v.marks, /Geräte-Untergrenze 10 %/);
  assert.match(v.marks, /DVhub-Boden 11 %/);
  // Je WR echter SoC: Master real 10+0,8×0,9=10,72 → „10,7"; Slave real 10+2,2×0,9=11,98 → „12".
  assert.match(v.master, /SoC 10,7 %/);
  assert.match(v.slave, /SoC 12 %/);
  assert.match(v.slave, /entlädt 500 W/);
  assert.match(v.slave, /Anteil 1990 W/);
  // Max Entladung = Summe (10+10 kW).
  assert.match(v.maxDischarge, /20 kW/);
});

test('M24: Minimum-SoC „10 % (Gerät)", wenn der Puffer 0 ist; mit Puffer „(Gerät 10 % + Puffer 1 %)"', () => {
  const st = (minSocPct, socFloorBufferPct) => ({
    victron: { soc: 30, device: { minSocPctDevice: 10, maxSocPctDevice: 100 } },
    sungrowSecond: { online: false },
    energyBalance: { battery: { socPct: 37, minSocPct } },
    sungrowEms: { socFloorBufferPct, decision: {} },
  });
  assert.equal(D.computeSungrowBatteryView(st(10, 0)).minSoc, '10 % (Gerät)');
  assert.equal(D.computeSungrowBatteryView(st(11, 1)).minSoc, '11 % (Gerät 10 % + Puffer 1 %)');
  // Harter Boden höher als Gerät + Puffer → das ist DVhubs Boden, nicht „Gerät + Puffer".
  assert.equal(D.computeSungrowBatteryView(st(15, 0)).minSoc, '15 % (DVhub-Boden, Gerät 10 %)');
});

test('Codex 2c6c70d0 P2: höhere Geräte-Untergrenze des Slave zählt mit (wie in der EOS-Planung)', () => {
  const st = (minSocPct, socFloorBufferPct, slave = { online: true, aggregate: true, minSocPctDevice: 12, maxSocPctDevice: 100, socPct: 20 }) => ({
    victron: { soc: 30, device: { minSocPctDevice: 10, maxSocPctDevice: 100 } },
    sungrowSecond: slave,
    energyBalance: { battery: { socPct: 37, minSocPct } },
    sungrowEms: { socFloorBufferPct, decision: {} },
  });
  assert.equal(D.computeSungrowBatteryView(st(12, 0)).minSoc, '12 % (Gerät)');
  assert.equal(D.computeSungrowBatteryView(st(13, 1)).minSoc, '13 % (Gerät 12 % + Puffer 1 %)');
  // Slave nicht erreichbar → zählt nicht (die Planung nimmt ihn dann auch nicht).
  assert.equal(D.computeSungrowBatteryView(st(10, 0, { online: false })).minSoc, '10 % (Gerät)');
});

test('M9: Grid-Setpoint fällt auf schedule.active, wenn kein EMS-Target; Slave offline → „Nicht erreichbar"', () => {
  const status = {
    victron: { soc: 50, device: { minSocPctDevice: 10, maxSocPctDevice: 100 } },
    sungrowSecond: { online: false, socPct: null },
    energyBalance: { battery: { socPct: 47, minSocPct: 11 } },
    schedule: { active: { gridSetpointW: { value: -40, source: 'default' } } },
    sungrowEms: { decision: {} },
  };
  const v = D.computeSungrowBatteryView(status);
  assert.equal(v.gridSetpoint, '-40 W (Standard)');
  assert.equal(v.slave, 'Nicht erreichbar');
});
