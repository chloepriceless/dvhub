// test/emergency-stop-devices.test.js — Not-Halt an Wallbox, Heizstab und
// Netzanschluss-Wächter (Christin 06.11.2026, wörtlich):
//   „nothalt heißt hier für DVhub ja nur – bitte mach keine dummen dinge – hör
//   mal alle steuerungen auf – also wenn heizstab gerade gesteuert wird oder das
//   e-auto dann soll diese 0w gesendet werden – war das manuell schon gestartet
//   außerhalb von dvhub dann soll auch keine 0 geschickt werden – nur die
//   Steuersignale von dvhub sollten ausgeschaltet werden“
//
// Also: Beim Aktivieren EINMAL 0 W / „aus“ nur an Geräte, deren aktuellen
// Zustand DVhub selbst gesetzt hat. Danach keinerlei Writes — auch nicht vom
// Netzanschluss-Wächter. Nach dem Aufheben übernimmt die normale Steuerung,
// vorgemerkte Modi (evcc) gehen nicht verloren.

import test from 'node:test';
import assert from 'node:assert/strict';

import { setEmergencyStop } from '../services/control-commands.js';
import { createEosEvccBridge } from '../services/optimizer/eos-evcc-bridge.js';
import { createMypvRegulator } from '../services/devices/mypv-regulator.js';
import { createEosDeviceBridge } from '../services/optimizer/eos-device-bridge.js';
import { createGridConnectionGuard } from '../services/grid-connection/index.js';
import { createEvccAdapter } from '../services/wallbox/adapters.js';

// --- Not-Halt-Kommando ---------------------------------------------------------

function stopCtx({ wallbox = { ok: true }, heater = { ok: true }, devices = { ok: true } } = {}) {
  const logs = [];
  const calls = { wallbox: 0, heater: 0, devices: 0, setpoint: [] };
  const ctx = {
    state: { ctrl: {} },
    pushLog: (event, data) => logs.push({ event, data }),
    persistControlState: () => {},
    applyControlTarget: async (t, v, s) => { calls.setpoint.push([t, v, s]); return { ok: true }; },
    eosEvccBridge: { emergencyStop: async () => { calls.wallbox += 1; return wallbox; } },
    mypvRegulator: { emergencyStop: async () => { calls.heater += 1; return heater; } },
    eosDeviceBridge: { emergencyStop: async () => { calls.devices += 1; return devices; } },
  };
  return { ctx, logs, calls };
}

test('Not-Halt an: Netz-Sollwert 0 und EINMAL Wallbox, Heizstab, Geräte neutralisieren', async () => {
  const { ctx, calls } = stopCtx();
  const r = await setEmergencyStop(ctx, { on: true });
  assert.equal(r.paused, true);
  assert.deepEqual(calls.setpoint, [['gridSetpointW', 0, 'emergency_stop']]);
  assert.deepEqual([calls.wallbox, calls.heater, calls.devices], [1, 1, 1]);
  await setEmergencyStop(ctx, { on: true }); // schon aktiv
  assert.deepEqual([calls.wallbox, calls.heater, calls.devices], [1, 1, 1], 'kein zweites Mal');
});

test('Neutralisierung scheitert: geloggt, Not-Halt bleibt aktiv, kein Wiederholen', async () => {
  const { ctx, logs, calls } = stopCtx({ wallbox: { ok: false, error: 'evcc nicht erreichbar' } });
  const r = await setEmergencyStop(ctx, { on: true });
  assert.equal(r.paused, true);
  assert.equal(ctx.state.ctrl.discretionaryWritesPaused, true);
  const fail = logs.find((l) => l.event === 'emergency_stop_neutralize_failed' && l.data.target === 'wallbox');
  assert.ok(fail, 'Fehlschlag geloggt');
  assert.equal(calls.wallbox, 1);
});

// --- Wallbox (EOS-evcc-Brücke) -------------------------------------------------

function wallbox({ enabled = true, type = 'evcc', plan = 1, override = null } = {}) {
  const calls = [];
  const box = { mode: 'pv' };
  let paused = false;
  const mk = (bc) => ({
    type, isConfigured: () => true,
    charge: async (a) => { calls.push(['charge', a]); box.mode = 'now'; return { ok: true }; },
    stop: async () => { calls.push(['stop', type === 'evcc' ? bc.stopMode : null]); box.mode = type === 'evcc' ? bc.stopMode : 'stopped'; return { ok: true }; },
    release: async () => { calls.push(['release']); return { ok: true }; },
    status: async () => ({ ok: true, connected: true, raw: { mode: box.mode } }),
    dvhubState: async () => ({ known: true, active: box.mode === 'now' }),
  });
  const cfg = { optimizer: { eosOptimizeEv: enabled, evEvccControl: enabled, evMaxChargeW: 11000, evStopMode: 'pv' }, wallbox: { type } };
  const t = Date.now();
  const bridge = createEosEvccBridge({
    getCfg: () => cfg,
    getSolution: async () => ({ slotMinutes: 15, rows: [{ ts_utc: new Date(Math.floor(t / 900000) * 900000).toISOString(), evChargeFactor: plan }] }),
    getCharger: (_c, bc) => mk(bc),
    isPaused: () => paused,
    loadOverride: () => override,
    now: () => t,
  });
  return { bridge, calls, box, setPaused: (v) => { paused = v; } };
}

test('Wallbox: DVhub lässt laden → Not-Halt schickt genau einmal „aus“, danach nichts mehr', async () => {
  const w = wallbox();
  await w.bridge.tick();
  assert.deepEqual(w.calls.at(-1), ['charge', 16]);
  w.setPaused(true);
  const r = await w.bridge.emergencyStop();
  assert.equal(r.ok, true);
  assert.deepEqual(w.calls.at(-1), ['stop', 'off'], 'evcc auf „aus“');
  const n = w.calls.length;
  // Jemand startet die Ladung an der Wallbox von Hand: DVhub stoppt sie nicht.
  w.box.mode = 'now';
  await w.bridge.tick();
  await w.bridge.apply();
  assert.equal(w.calls.length, n, 'im Not-Halt keine Writes');
});

test('Wallbox: Ladung manuell gestartet (evcc-Modus nicht mehr DVhubs) → kein Befehl', async () => {
  const w = wallbox();
  await w.bridge.tick();
  w.box.mode = 'minpv'; // in der evcc-App umgestellt
  w.setPaused(true);
  const n = w.calls.length;
  const r = await w.bridge.emergencyStop();
  assert.equal(r.skipped, 'not_dvhub_state');
  assert.equal(w.calls.length, n);
});

test('Wallbox: DVhub hat nichts vorgegeben bzw. selbst gestoppt → kein Befehl', async () => {
  const idle = wallbox({ enabled: false });
  idle.setPaused(true);
  assert.equal((await idle.bridge.emergencyStop()).skipped, 'not_controlled');
  assert.equal(idle.calls.length, 0);
  const stopped = wallbox({ plan: 0 }); // Plan: nicht laden → DVhub hat gestoppt
  await stopped.bridge.tick();
  const n = stopped.calls.length;
  stopped.setPaused(true);
  assert.equal((await stopped.bridge.emergencyStop()).skipped, 'not_charging');
  assert.equal(stopped.calls.length, n);
});

test('Wallbox direkt (OpenEVSE): DVhub lädt → einmal stop()', async () => {
  const w = wallbox({ type: 'openevse' });
  await w.bridge.tick();
  w.setPaused(true);
  await w.bridge.emergencyStop();
  assert.equal(w.calls.at(-1)[0], 'stop');
});

test('„Laden stoppen“ hält im Not-Halt nicht mehr gegen eine Handladung', async () => {
  const w = wallbox();
  await w.bridge.setOverride({ kind: 'stop' });
  assert.deepEqual(w.calls.at(-1), ['stop', 'off']);
  w.setPaused(true);
  w.box.mode = 'now';
  const n = w.calls.length;
  await w.bridge.tick();
  assert.equal(w.calls.length, n);
});


test('Nach dem Aufheben mit EOS-Plan: Wallbox lädt wieder nach Plan', async () => {
  const w = wallbox();
  await w.bridge.tick();
  w.setPaused(true);
  await w.bridge.emergencyStop();
  w.setPaused(false);
  await w.bridge.tick();
  assert.deepEqual(w.calls.at(-1), ['charge', 16]);
});

// --- Heizstab (my-PV) -----------------------------------------------------------

function heater() {
  const NOW = 1_700_000_000_000;
  let t = NOW;
  const writes = [];
  const state = { meter: { ok: true, updatedAt: NOW }, victron: { gridExportW: 9000, gridImportW: 0, batteryDischargeW: 0, soc: 60 }, ctrl: {}, optimizer: {} };
  const cfg = { devices: [{ id: 'heizstab', name: 'Heizstab', kind: 'modulating', schedulable: true, plan: { maxPowerW: 9000, intervalS: 5 }, endpoint: { type: 'mypv', host: '192.0.2.20' } }] };
  const reg = createMypvRegulator({
    getCfg: () => cfg, state, now: () => t,
    createClient: () => ({ read: async () => ({ powerW: 0, deviceOn: true }), writePower: async (w) => { writes.push(w); return w; }, close() {} })
  });
  const step = async (n = 1) => { for (let i = 0; i < n; i += 1) { await reg.tick(); t += 5000; state.meter.updatedAt = t; } };
  return { reg, writes, state, step };
}

test('Heizstab: DVhub gibt Leistung vor → Not-Halt schickt genau einmal 0 W, danach nichts', async () => {
  const h = heater();
  await h.step(4);
  assert.ok(h.writes.at(-1) > 0);
  h.state.ctrl.discretionaryWritesPaused = true;
  await h.reg.emergencyStop();
  assert.equal(h.writes.at(-1), 0);
  const n = h.writes.length;
  await h.step(3);
  assert.equal(h.writes.length, n, 'im Not-Halt keine Writes');
  // Danach: Regelung startet bei 0 und fährt wieder hoch.
  h.state.ctrl.discretionaryWritesPaused = false;
  await h.step(2);
  assert.ok(h.writes.length > n);
});

test('Heizstab: DVhubs Vorgabe ist 0 (Gerät läuft ggf. von selbst) → kein Befehl', async () => {
  const h = heater();
  h.state.victron.gridExportW = 0; // kein Überschuss → DVhub gibt 0 vor
  await h.step(2);
  assert.equal(h.writes.at(-1), 0);
  const n = h.writes.length;
  h.state.ctrl.discretionaryWritesPaused = true;
  const r = await h.reg.emergencyStop();
  assert.equal(h.writes.length, n);
  assert.equal(r.ok, true);
});

// --- Heizstab über die Geräte-Brücke (Shelly/MQTT) -----------------------------

function fakeActuator() {
  const calls = [];
  return {
    calls,
    apply: async (device, command) => { calls.push({ id: device.id, ...command }); return { ok: true }; },
    commandKey: (device, command) => (device.kind === 'modulating' ? `p:${Math.round(command.powerW || 0)}` : `o:${command.on ? 1 : 0}`),
  };
}
const elwa = { id: 'elwa', name: 'Elwa', schedulable: true, kind: 'modulating', plan: { maxPowerW: 3000, minPowerW: 100 }, endpoint: { type: 'mqtt_publish', powerTopic: 't' } };

test('Geräte-Brücke: Heizstab mit DVhub-Vorgabe > 0 → einmal 0 W; danach im Not-Halt nichts', async () => {
  const act = fakeActuator();
  const state = { ctrl: {}, optimizer: {}, victron: { solarToGridW: 2500, gridImportW: 0, batteryDischargeW: 0 } };
  const b = createEosDeviceBridge({ getCfg: () => ({ devices: [elwa] }), getSolution: async () => ({ rows: [] }), actuator: act, state });
  await b.tick();
  assert.ok(act.calls.at(-1).powerW > 0);
  state.ctrl.discretionaryWritesPaused = true;
  await b.emergencyStop();
  assert.deepEqual(act.calls.at(-1), { id: 'elwa', powerW: 0 });
  const n = act.calls.length;
  await b.tick();
  assert.equal(act.calls.length, n);
  state.ctrl.discretionaryWritesPaused = false;
  await b.tick();
  assert.ok(act.calls.length > n, 'danach regelt sie wieder (Befehl neu geschickt)');
});

test('Geräte-Brücke: Heizstab-Vorgabe 0 → kein Befehl', async () => {
  const act = fakeActuator();
  const state = { ctrl: {}, optimizer: {}, victron: { solarToGridW: 0, gridImportW: 500, batteryDischargeW: 0 } };
  const b = createEosDeviceBridge({ getCfg: () => ({ devices: [elwa] }), getSolution: async () => ({ rows: [] }), actuator: act, state });
  await b.tick();
  const n = act.calls.length;
  state.ctrl.discretionaryWritesPaused = true;
  await b.emergencyStop();
  assert.equal(act.calls.length, n);
});

// --- Netzanschluss-Wächter ------------------------------------------------------

test('Netzanschluss-Wächter bricht den Not-Halt nicht durch: keine Grenzen, kein Befehl', () => {
  const cfg = { gridConnection: { limitKw: 29 }, optimizer: { eosOptimizeEv: true, evEvccControl: true, evMaxChargeW: 11000 }, wallbox: { type: 'evcc' } };
  const state = { meter: { ok: true, updatedAt: Date.now(), grid_total_w: -32000 }, victron: {}, schedule: {}, ctrl: { discretionaryWritesPaused: true } };
  let applies = 0;
  const ctx = {
    getCfg: () => cfg, state, pushLog: () => {},
    evccIntegration: { getStatus: () => ({ loadpoints: [{ chargePowerW: 11000 }] }) },
    eosEvccBridge: { apply: async () => { applies += 1; } },
  };
  const guard = createGridConnectionGuard(ctx);
  guard.tick(); guard.tick();
  assert.equal(applies, 0);
  assert.equal(guard.capW('wallbox'), null);
  assert.deepEqual(guard.eebusCaps(), {});
  assert.match(guard.summary().text, /Not-Halt/);
  state.ctrl.discretionaryWritesPaused = false;
  guard.tick();
  assert.equal(guard.capW('wallbox'), 7000, 'nach dem Aufheben regelt er wieder (32 − 28 = 4 kW weniger)');
});

// --- Codex 45b7c40b ---------------------------------------------------------------

test('Codex P1: Geräte-Brücke — ein laufender Takt schreibt nach der Neutralisierung nicht wieder Leistung', async () => {
  const act = fakeActuator();
  const state = { ctrl: {}, optimizer: {}, victron: { solarToGridW: 3000, gridImportW: 0, batteryDischargeW: 0 } };
  let gate = null;
  const heaterEv = { ...elwa, plan: { ...elwa.plan, pauseWhileEvCharging: true } };
  const b = createEosDeviceBridge({
    getCfg: () => ({ devices: [heaterEv] }), getSolution: async () => ({ rows: [] }), actuator: act, state,
    isEvCharging: async () => { if (gate) await gate; return false; },
  });
  await b.tick();
  assert.ok(act.calls.at(-1).powerW > 0);
  let release;
  gate = new Promise((r) => { release = r; });
  const inflight = b.tick({ force: true });
  await new Promise((r) => setImmediate(r));
  state.ctrl.discretionaryWritesPaused = true;
  const stopP = b.emergencyStop();
  release();
  await inflight;
  await stopP;
  assert.equal(act.calls.at(-1).powerW, 0, 'zuletzt 0 W');
});

test('Codex P1: my-PV — erster Leistungs-Befehl noch unterwegs, dann Not-Halt → danach 0 W', async () => {
  const NOW = 1_700_000_000_000;
  const writes = [];
  let gate = null;
  const state = { meter: { ok: true, updatedAt: NOW }, victron: { gridExportW: 9000, gridImportW: 0, batteryDischargeW: 0, soc: 60 }, ctrl: {}, optimizer: {} };
  const cfg = { devices: [{ id: 'heizstab', name: 'Heizstab', kind: 'modulating', schedulable: true, plan: { maxPowerW: 9000, intervalS: 5 }, endpoint: { type: 'mypv', host: '192.0.2.20' } }] };
  const reg = createMypvRegulator({
    getCfg: () => cfg, state, now: () => NOW,
    createClient: () => ({ read: async () => ({ powerW: 0, deviceOn: true }), writePower: async (w) => { if (gate && w > 0) await gate; writes.push(w); return w; }, close() {} })
  });
  let release;
  gate = new Promise((r) => { release = r; });
  const tickP = reg.tick();
  await new Promise((r) => setImmediate(r));
  state.ctrl.discretionaryWritesPaused = true;
  const stopP = reg.emergencyStop();
  release();
  await tickP;
  await stopP;
  assert.ok(writes.some((w) => w > 0), 'positiver Befehl kam an');
  assert.equal(writes.at(-1), 0, 'danach 0 W');
});

test('Codex P2: my-PV — Neutralisierung richtet sich nach dem zuletzt ERFOLGREICH geschriebenen Wert', async () => {
  const NOW = 1_700_000_000_000;
  let t = NOW;
  const writes = [];
  let fail = false;
  const state = { meter: { ok: true, updatedAt: NOW }, victron: { gridExportW: 9000, gridImportW: 0, batteryDischargeW: 0, soc: 60 }, ctrl: {}, optimizer: {} };
  const cfg = { devices: [{ id: 'heizstab', name: 'Heizstab', kind: 'modulating', schedulable: true, plan: { maxPowerW: 9000, intervalS: 5 }, endpoint: { type: 'mypv', host: '192.0.2.20' } }] };
  const reg = createMypvRegulator({
    getCfg: () => cfg, state, now: () => t,
    createClient: () => ({ read: async () => ({ powerW: 0, deviceOn: true }), writePower: async (w) => { if (fail) throw new Error('timeout'); writes.push(w); return w; }, close() {} })
  });
  for (let i = 0; i < 4; i += 1) { await reg.tick(); t += 5000; state.meter.updatedAt = t; }
  assert.ok(writes.at(-1) > 0);
  state.victron.gridExportW = 0; state.victron.gridImportW = 500; // Regler will sofort 0 …
  fail = true;                    // … aber der Write scheitert
  await reg.tick(); t += 5000; state.meter.updatedAt = t;
  fail = false;
  state.ctrl.discretionaryWritesPaused = true;
  await reg.emergencyStop();
  assert.equal(writes.at(-1), 0, 'der positive Befehl wird zurückgenommen');
});

test('Codex P2: evcc — Besitz wird mit FRISCHEM Zustand geprüft (Cache sagt „now“, evcc steht auf „minpv“)', async () => {
  const lp = { id: 1, mode: 'now', connected: true, charging: true };
  let real = 'now';
  const calls = [];
  const evcc = {
    getStatus: () => ({ url: 'http://evcc.local:7070' }),
    getLoadpoints: () => [{ ...lp }],
    refresh: async () => { lp.mode = real; return true; },
    setMaxCurrent: async (id, a) => { calls.push(['maxcurrent', id, a]); return { ok: true }; },
    setMode: async (id, m) => { calls.push(['mode', id, m]); lp.mode = m; real = m; return { ok: true }; },
  };
  const cfg = { evcc: { url: 'http://evcc.local:7070' }, wallbox: { type: 'evcc' }, optimizer: { eosOptimizeEv: true, evEvccControl: true, evMaxChargeW: 11000, evStopMode: 'pv' } };
  let paused = false;
  const t = Date.now();
  const bridge = createEosEvccBridge({
    getCfg: () => cfg,
    getSolution: async () => ({ slotMinutes: 15, rows: [{ ts_utc: new Date(Math.floor(t / 900000) * 900000).toISOString(), evChargeFactor: 1 }] }),
    getCharger: (_c, bc) => createEvccAdapter(evcc, () => bc.loadpoint, () => bc.stopMode),
    isPaused: () => paused, now: () => t,
  });
  await bridge.tick();
  real = 'minpv'; // in der evcc-App umgestellt, DVhubs Cache weiß es noch nicht
  paused = true;
  const n = calls.length;
  const r = await bridge.emergencyStop();
  assert.equal(r.skipped, 'not_dvhub_state');
  assert.equal(calls.length, n);
});

test('Codex P2: evcc — neutralisiert wird der Ladepunkt des letzten Befehls, nicht ein inzwischen anders eingestellter', async () => {
  const lps = { 1: 'pv', 2: 'now' };
  const calls = [];
  const evcc = {
    getStatus: () => ({ url: 'http://evcc.local:7070' }),
    getLoadpoints: () => [{ id: 1, mode: lps[1], connected: true }, { id: 2, mode: lps[2], connected: true }],
    refresh: async () => true,
    setMaxCurrent: async (id, a) => { calls.push(['maxcurrent', id, a]); return { ok: true }; },
    setMode: async (id, m) => { calls.push(['mode', id, m]); lps[id] = m; return { ok: true }; },
  };
  const cfg = { evcc: { url: 'http://evcc.local:7070' }, wallbox: { type: 'evcc' }, optimizer: { eosOptimizeEv: true, evEvccControl: true, evEvccLoadpoint: 1, evMaxChargeW: 11000, evStopMode: 'pv' } };
  let paused = false;
  const t = Date.now();
  const bridge = createEosEvccBridge({
    getCfg: () => cfg,
    getSolution: async () => ({ slotMinutes: 15, rows: [{ ts_utc: new Date(Math.floor(t / 900000) * 900000).toISOString(), evChargeFactor: 1 }] }),
    getCharger: (_c, bc) => createEvccAdapter(evcc, () => bc.loadpoint, () => bc.stopMode),
    isPaused: () => paused, now: () => t,
  });
  await bridge.tick();
  assert.equal(lps[1], 'now');
  cfg.optimizer.evEvccLoadpoint = 2; // umgestellt, Ladepunkt 2 lädt von Hand
  paused = true;
  await bridge.emergencyStop();
  assert.equal(lps[1], 'off', 'DVhubs Ladepunkt 1 aus');
  assert.equal(lps[2], 'now', 'Handladung an Ladepunkt 2 unberührt');
});


// --- Codex 148df991 ---------------------------------------------------------------

test('Codex P1: my-PV — positiver Befehl ohne Quittung (Zeitüberschreitung) zählt als angekommen → Not-Halt schickt 0 W', async () => {
  const NOW = 1_700_000_000_000;
  const writes = [];
  const state = { meter: { ok: true, updatedAt: NOW }, victron: { gridExportW: 9000, gridImportW: 0, batteryDischargeW: 0, soc: 60 }, ctrl: {}, optimizer: {} };
  const cfg = { devices: [{ id: 'heizstab', name: 'Heizstab', kind: 'modulating', schedulable: true, plan: { maxPowerW: 9000, intervalS: 5 }, endpoint: { type: 'mypv', host: '192.0.2.20' } }] };
  const reg = createMypvRegulator({
    getCfg: () => cfg, state, now: () => NOW,
    createClient: () => ({
      read: async () => ({ powerW: 0, deviceOn: true }),
      writePower: async (w) => { writes.push(w); if (w > 0) throw new Error('timeout'); return w; },
      close() {}
    })
  });
  await reg.tick();
  assert.ok(writes.at(-1) > 0, 'Befehl ging raus, Quittung fehlt');
  state.ctrl.discretionaryWritesPaused = true;
  await reg.emergencyStop();
  assert.equal(writes.at(-1), 0);
});

