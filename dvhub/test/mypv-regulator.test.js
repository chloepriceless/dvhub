// my-PV-Heizstab: Regler (decideMypvSetpoint), Modbus-Anbindung und Takt.
// Die Regelfälle spiegeln die Tests des Ohmpilot-Übersetzers (test_controller.py),
// der so an einer echten Fronius-Anlage mit AC THOR und Wattpilot läuft —
// gleiche Eingaben, gleiche Sollwerte (dort Regelintervall 1 s).
import test from 'node:test';
import assert from 'node:assert/strict';

import { decideMypvSetpoint, carStateFromCharger, createMypvRegulator } from '../services/devices/mypv-regulator.js';
import { createMypvClient, parseMypvRegisters } from '../services/devices/mypv.js';
import { validateSchedulableDevice } from '../services/devices/schedulable.js';

const NOW = 1_000_000;
const plan = (o = {}) => ({ maxPowerW: 9000, intervalS: 1, pauseWhileEvCharging: true, ...o });
// grid wie im Original: negativ = Einspeisung
const live = ({ grid = 0, battery = 0, heater = 0, soc = null, age = 0, car = null, deviceOff } = {}) => ({
  exportW: grid < 0 ? -grid : 0, importW: grid > 0 ? grid : 0, dischargeW: battery > 0 ? battery : 0,
  heaterPowerW: heater, socPct: soc, dataAgeMs: age, car, deviceOff
});
const sp = (p, l, prev = 0) => decideMypvSetpoint(p, l, prev, NOW).powerW;

test('Überschuss minus Reserve, nach oben langsam', () => {
  const d = decideMypvSetpoint(plan(), live({ grid: -5000 }), 0, NOW);
  assert.equal(d.surplusW, 4000);
  assert.equal(d.powerW, 300);
  assert.equal(sp(plan({ intervalS: 5 }), live({ grid: -5000 })), 1200);
});

test('Gleichgewicht: Einspeisung = Reserve hält die Leistung', () => {
  assert.equal(sp(plan(), live({ grid: -1000, heater: 3000 }), 3000), 3000);
});

test('Wolke: zügig herunter; Netzbezug: sofort', () => {
  assert.equal(sp(plan(), live({ grid: -200, heater: 3000 }), 3000), 2520);
  assert.equal(sp(plan(), live({ grid: 500, heater: 3000 }), 3000), 1500);
  assert.equal(sp(plan(), live({ grid: 2500, heater: 1000 }), 1000), 0);
});

test('Akku-Entladung wird nicht verheizt', () => {
  const d = decideMypvSetpoint(plan(), live({ grid: -1500, battery: 800, heater: 1000 }), 1000, NOW);
  assert.equal(d.surplusW, 700);
  assert.equal(d.powerW, 820);
});

test('nie über der Höchstleistung, kleiner Überschuss startet nicht', () => {
  assert.equal(sp(plan({ maxPowerW: 3000 }), live({ grid: -20000, heater: 3000 }), 3000), 3000);
  assert.equal(sp(plan(), live({ grid: -1100 })), 0);
});

test('veraltete oder fehlende Messwerte: aus', () => {
  assert.equal(sp(plan(), live({ grid: -5000, age: 30_000 }), 2000), 0);
  assert.equal(sp(plan(), { ...live({ grid: -5000 }), dataAgeMs: null }, 2000), 0);
});

test('Auto wartet auf den Ladestart: Stab aus, mit Zeitlimit wieder frei', () => {
  const waiting = { state: 'waiting', sinceMs: NOW - 600_000 };
  const d = decideMypvSetpoint(plan(), live({ grid: -8000, car: waiting }), 4000, NOW);
  assert.equal(d.powerW, 0);
  assert.equal(d.blockedByCar, true);
  const freed = decideMypvSetpoint(plan({ carWaitTimeoutMin: 5 }), live({ grid: -8000, car: waiting }), 0, NOW);
  assert.ok(freed.powerW > 0 && !freed.blockedByCar);
});

test('Auto lädt: erst warten, dann bekommt der Stab den Rest', () => {
  assert.equal(sp(plan(), live({ grid: -3000, car: { state: 'charging', sinceMs: NOW - 10_000 } })), 0);
  assert.equal(sp(plan(), live({ grid: -3000, car: { state: 'charging', sinceMs: NOW - 120_000 } })), 300);
});

test('Auto fertig oder nicht da blockiert nicht; Vorrang abschaltbar', () => {
  for (const state of ['idle', 'complete']) assert.equal(sp(plan(), live({ grid: -5000, car: { state, sinceMs: NOW } })), 300);
  assert.equal(sp(plan({ pauseWhileEvCharging: false }), live({ grid: -5000, car: { state: 'waiting', sinceMs: NOW } })), 300);
});

test('Mindest-Akkustand, Gerät aus, Mindestleistung', () => {
  assert.equal(sp(plan({ minSocPct: 80 }), live({ grid: -5000, soc: 50 })), 0);
  assert.equal(sp(plan(), live({ grid: -6000, deviceOff: true }), 2000), 0);
  assert.equal(sp(plan({ minPowerW: 500 }), live({ grid: -5000 })), 0, '300 W liegt unter 500 W Mindestleistung');
});

test('Auto-Zustand aus der Wallbox', () => {
  assert.equal(carStateFromCharger({ connected: true, charging: true }).state, 'charging');
  assert.equal(carStateFromCharger({ connected: true, charging: false, carState: 'waiting' }).state, 'waiting');
  assert.equal(carStateFromCharger({ connected: true, charging: false }).state, 'complete', 'unbekannt → blockiert nicht');
  assert.equal(carStateFromCharger({ connected: false, charging: false }).state, 'idle');
  assert.equal(carStateFromCharger(null), null);
});

test('Modbus-Anbindung: Register lesen und Leistung schreiben', async () => {
  const calls = [];
  const transport = {
    async mbRequest(req) { calls.push(['read', req.address, req.quantity, req.unitId]); return req.address === 1000 ? [2450, 512, 0, 9] : [2, ...Array(10).fill(0), 1]; },
    async mbWriteSingle(req) { calls.push(['write', req.address, req.value]); return {}; }
  };
  const c = createMypvClient({ host: '192.0.2.20', port: 502, unit: 1 }, { transport });
  const m = await c.read();
  assert.deepEqual([m.powerW, m.tempC, m.statusText, m.ctrlMode, m.deviceOn], [2450, 51.2, 'Betrieb', 2, true]);
  assert.equal(await c.writePower(3100.4), 3100);
  assert.deepEqual(calls.at(-1), ['write', 1000, 3100]);
  assert.equal(parseMypvRegisters([0, 0, 0, 201]).statusText, 'Fehler');
});

test('Gerät mit Endpunkt my-PV: Adresse Pflicht, Port/Unit mit Vorgaben', () => {
  const ok = validateSchedulableDevice({ id: 'heizstab', name: 'Heizstab', kind: 'modulating', plan: { maxPowerW: 3000, exportReserveW: 500 }, endpoint: { type: 'mypv', host: '192.0.2.20' } });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.device.endpoint, { type: 'mypv', host: '192.0.2.20', port: 502, unit: 1 });
  assert.equal(ok.device.plan.exportReserveW, 500);
  assert.equal(validateSchedulableDevice({ id: 'h', name: 'H', kind: 'modulating', plan: { maxPowerW: 3000 }, endpoint: { type: 'mypv' } }).ok, false);
  assert.equal(validateSchedulableDevice({ id: 'h', name: 'H', kind: 'deferrable', plan: { energyWh: 1000, durationH: 1 }, endpoint: { type: 'mypv', host: '192.0.2.20' } }).ok, false, 'nur modulierend');
});

function setup({ paused = false, devices, exportW = 5000 } = {}) {
  let t = NOW;
  const writes = [];
  const state = { meter: { ok: true, updatedAt: NOW }, victron: { gridExportW: exportW, gridImportW: 0, batteryDischargeW: 0, soc: 60 }, ctrl: { discretionaryWritesPaused: paused }, optimizer: {} };
  const cfg = { devices: devices || [{ id: 'heizstab', name: 'Heizstab', kind: 'modulating', schedulable: true, plan: { maxPowerW: 9000, intervalS: 5 }, endpoint: { type: 'mypv', host: '192.0.2.20' } }] };
  const reg = createMypvRegulator({
    getCfg: () => cfg, state, now: () => t,
    createClient: () => ({ read: async () => ({ powerW: 0, tempC: 45, statusText: 'Betrieb', ctrlMode: 2, deviceOn: true }), writePower: async (w) => { writes.push(w); return w; }, close() {} })
  });
  return { reg, writes, state, cfg, advance: (ms) => { t += ms; state.meter.updatedAt = t; } };
}

test('Takt: schreibt in jedem Takt, merkt die Energie, Status für die Oberfläche', async () => {
  const s = setup();
  // Prüfen, wie planbare Geräte in der Config erkannt werden.
  const { loadSchedulableDevices } = await import('../services/devices/schedulable.js');
  assert.equal(loadSchedulableDevices(s.cfg).devices.length, 1, 'Testgerät wird als planbares Gerät erkannt');
  await s.reg.tick();
  s.advance(5000); await s.reg.tick();
  assert.equal(s.writes.length, 2, 'auch ohne Änderung schreiben (Power Timeout am Gerät)');
  assert.ok(s.writes[1] > s.writes[0], 'fährt hoch');
  const st = s.reg.getStatus().heizstab;
  assert.equal(st.tempC, 45);
  assert.match(st.reason, /Überschuss/);
  assert.ok(s.state.optimizer.heaterEnergyToday.heizstab.wh >= 0);
});

test('Not-Halt: kein Schreiben; Gerät entfernt: einmal 0 W', async () => {
  const p = setup({ paused: true });
  const { loadSchedulableDevices } = await import('../services/devices/schedulable.js');
  assert.equal(loadSchedulableDevices(p.cfg).devices.length, 1);
  await p.reg.tick();
  assert.equal(p.writes.length, 0);
  const s = setup();
  await s.reg.tick();
  s.cfg.devices = [];
  s.advance(5000); await s.reg.tick();
  assert.equal(s.writes.at(-1), 0);
});

// ── Fable R2 P2-8: Beenden von DVhub (Update, systemctl restart) ──
test('Beenden: 0 W nur an Heizstäbe mit eigener Vorgabe > 0 — nicht im Not-Halt, nicht ohne Vorgabe', async () => {
  // eigene Vorgabe > 0: beim Beenden aus (zusätzlich greift der Power Timeout)
  const own = setup();
  await own.reg.tick();
  assert.ok(own.writes.at(-1) > 0);
  const n = own.writes.length;
  await own.reg.stop();
  assert.deepEqual(own.writes.slice(n), [0]);

  // DVhub gibt 0 W vor (kein Überschuss): der Stab läuft höchstens von selbst — nichts senden
  const idle = setup({ exportW: 0 });
  await idle.reg.tick();
  const m = idle.writes.length;
  await idle.reg.stop();
  assert.deepEqual(idle.writes.slice(m), [], 'ohne eigene Vorgabe kein Befehl');

  // Not-Halt: nach dem Eintritt keine Writes mehr — auch nicht beim Beenden
  const halted = setup();
  await halted.reg.tick();
  halted.state.ctrl.discretionaryWritesPaused = true;
  const k = halted.writes.length;
  await halted.reg.stop();
  assert.deepEqual(halted.writes.slice(k), [], 'im Not-Halt kein Write beim Beenden');
});

test('Beenden im Lese-Modus: kein Write', async () => {
  const s = setup();
  await s.reg.tick();
  const n = s.writes.length;
  process.env.DVHUB_READ_ONLY = '1';
  try { await s.reg.stop(); } finally { delete process.env.DVHUB_READ_ONLY; }
  assert.deepEqual(s.writes.slice(n), []);
});

test('Gerät entfernt ohne eigene Vorgabe: kein 0-W-Befehl (manuell Gestartetes nie anfassen)', async () => {
  const s = setup({ exportW: 0 });
  await s.reg.tick();
  const n = s.writes.length;
  s.cfg.devices = [];
  s.advance(5000); await s.reg.tick();
  assert.deepEqual(s.writes.slice(n), []);
});

// Fable R2 P3-8: im Not-Halt läuft das Lesen weiter (Leistung/Temperatur frieren nicht ein)
test('Not-Halt: Messwerte des Heizstabs werden weiter gelesen, nichts geschrieben', async () => {
  const p = setup({ paused: true });
  await p.reg.tick();
  assert.equal(p.writes.length, 0);
  assert.equal(p.reg.getStatus().heizstab?.tempC, 45);
});
