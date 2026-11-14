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
    sungrowSecond: { online: true, control: 'split', socPct: 20, batteryPowerW: -1168, pvPowerW: 0, bdcRatedW: 10000, runningStateText: 'Externes EMS' },
    sungrowEms: { controlMode: 'external', owns: true, heartbeatTimeoutS: 30, heartbeatWorkingFc: 16, heartbeatSentS: 30, decision: { mode: 'forced', command: 'discharge', powerW: 1000 } },
    sungrowEmsSlave: { controlMode: 'external', owns: true, heartbeatWorkingFc: 16, heartbeatSentS: 30, decision: { mode: 'forced', command: 'discharge', powerW: 1168 } },
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
  assert.equal(vw.slave.role, 'Slave – gesteuert bei Vorgaben');
  assert.equal(vw.slave.soc, '20 %');
  assert.equal(vw.slave.decision, 'Entladen 1168 W');
  assert.equal(vw.sum.battery, '-2168 W');
  assert.equal(vw.sum.soc, '60 %');
});

test('self-only: Slave „gelesen", offline → Nicht erreichbar, kein EMS', () => {
  const status = {
    victron: { soc: 60, device: { model: 'SH10RT-20', bdcRatedW: 10000 } },
    sungrowSecond: { online: false, control: 'self-only', bdcRatedW: 10000 },
    sungrowEms: { controlMode: 'forced', owns: false, decision: { mode: 'self' } },
  };
  const vw = V.view(status);
  assert.equal(vw.slave.role, 'Slave – gelesen');
  assert.equal(vw.slave.online, false);
  assert.equal(vw.slave.decision, '–');          // self-only → kein Slave-EMS
  assert.equal(vw.master.heartbeat, 'Forced mode');
});
