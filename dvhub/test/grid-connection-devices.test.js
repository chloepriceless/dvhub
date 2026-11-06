// test/grid-connection-devices.test.js — die Grenzen des Netzanschluss-Wächters
// kommen an den Geräten an, und mit §14a gilt je Gerät die kleinste:
//   Wallbox   eos-evcc-bridge getGridCapW (server.js: wallboxGridCapW)
//   EEBUS     paragraph14a → eebus.applyConsumptionShares
//   Heizstab  my-PV-Regler (getCapW)

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { createParagraph14aService } from '../services/paragraph14a/index.js';
import { createMypvRegulator } from '../services/devices/mypv-regulator.js';
import { wallboxGridCapW } from '../services/grid-connection/index.js';

function p14aSetup({ gcEebus = {}, p14aLimitW = null } = {}) {
  const cfg = { gridPositiveMeans: 'grid_import', optimizer: { maxChargeW: 10000 }, paragraph14a: {} };
  const state = { ctrl: {}, victron: {}, meter: { grid_total_w: 1000 } };
  if (p14aLimitW != null) state.ctrl.eebusConsumptionLimitW = p14aLimitW;
  const applied = [];
  const ctx = {
    state, getCfg: () => cfg, pushLog: () => {},
    eebus: {
      consumptionDevices: () => [{ id: 'eebus:hp', kind: 'waermepumpe', maxW: 3000, powerW: 2500 }],
      applyConsumptionShares: (shares, until) => applied.push({ shares, until }),
    },
    gridConnection: { eebusCaps: () => gcEebus },
  };
  const svc = createParagraph14aService(ctx, { setInterval: () => 0, clearInterval: () => {} });
  return { svc, applied };
}

test('EEBUS: Netzanschluss-Grenze kommt auch ohne §14a-Vorgabe an', () => {
  const s = p14aSetup({ gcEebus: { 'eebus:hp': 1500 } });
  s.svc.update();
  assert.deepEqual(s.applied.at(-1).shares, { 'eebus:hp': 1500 });
});

test('EEBUS: kleinste gilt — §14a-Anteil 3 000 W, Netzanschluss 1 500 W → 1 500 W', () => {
  const s = p14aSetup({ gcEebus: { 'eebus:hp': 1500 }, p14aLimitW: 7560 });
  s.svc.update();
  assert.equal(s.applied.at(-1).shares['eebus:hp'], 1500);
});

test('EEBUS: ohne Netzanschluss-Grenze bleibt der §14a-Anteil', () => {
  const s = p14aSetup({ p14aLimitW: 7560 });
  s.svc.update();
  assert.equal(s.applied.at(-1).shares['eebus:hp'], 3000);
});

test('Wallbox: kleinste gilt aus §14a-Anteil und Netzanschluss', () => {
  assert.equal(wallboxGridCapW(null, null), null);
  assert.equal(wallboxGridCapW(4500, null), 4500);
  assert.equal(wallboxGridCapW(null, 6000), 6000);
  assert.equal(wallboxGridCapW(4500, 0), 0);
});

test('server.js: die EOS-Brücke fragt die zusammengeführte Wallbox-Grenze ab', () => {
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(src, /getGridCapW: \(\) => wallboxGridCapW\(/);
});

test('Heizstab: der my-PV-Regler hält die Netzanschluss-Grenze ein', async () => {
  const NOW = 1_700_000_000_000;
  let t = NOW;
  const writes = [];
  const state = { meter: { ok: true, updatedAt: NOW }, victron: { gridExportW: 9000, gridImportW: 0, batteryDischargeW: 0, soc: 60 }, ctrl: {}, optimizer: {} };
  const cfg = { devices: [{ id: 'heizstab', name: 'Heizstab', kind: 'modulating', schedulable: true, plan: { maxPowerW: 9000, intervalS: 5 }, endpoint: { type: 'mypv', host: '192.0.2.20' } }] };
  let capW = null;
  const reg = createMypvRegulator({
    getCfg: () => cfg, state, now: () => t,
    getCapW: (id) => (id === 'heizstab' ? capW : null),
    createClient: () => ({ read: async () => ({ powerW: 0, deviceOn: true }), writePower: async (w) => { writes.push(w); return w; }, close() {} })
  });
  for (let i = 0; i < 6; i += 1) { await reg.tick(); t += 5000; state.meter.updatedAt = t; }
  assert.ok(writes.at(-1) > 1000, 'fährt mit Überschuss hoch');
  capW = 500;
  await reg.tick();
  assert.equal(writes.at(-1), 500, 'gedeckelt auf die Netzanschluss-Grenze');
  assert.match(reg.getStatus().heizstab.reason, /Netzanschluss/);
  capW = 0;
  t += 5000; state.meter.updatedAt = t;
  await reg.tick();
  assert.equal(writes.at(-1), 0, 'aus');
});
