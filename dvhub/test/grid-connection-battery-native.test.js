// test/grid-connection-battery-native.test.js — Netzanschluss „Akku zuerst“ für
// Nicht-Victron-Anlagen (Christin 10.11.2026): Liegt der Bezug über der Grenze,
// entlädt zuerst der Akku um den Überschuss; erst wenn er nicht mehr kann (leer,
// Leistungsgrenze, folgt nicht, nicht steuerbar), drosselt DVhub Lasten.
//
// Rein (guardStep) und mit echten Bausteinen: ausgelieferte Herstellerprofile
// (bridge-mqtt, dvhub-mqtt, fronius, deye-lv, victron) über loadConfigFile, der
// echte Schedule-Evaluator, ein MQTT-Transport, der die Writes mitschreibt.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfigFile } from '../config-model.js';
import { createScheduleEvaluator } from '../schedule-eval.js';
import {
  resolveGridConnection, createGuardState, guardStep, createGridConnectionGuard,
  BATTERY_OBEY_MS, RELEASE_MS, HOLD_AFTER_CUT_MS, assistValueW
} from '../services/grid-connection/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r)); };

/** Effektive Config mit einem AUSGELIEFERTEN Herstellerprofil (wie auf der Box). */
function loadProfileConfig(manufacturer, persisted = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-akku-'));
  fs.mkdirSync(path.join(rootDir, 'hersteller'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'hersteller', `${manufacturer}.json`), path.join(rootDir, 'hersteller', `${manufacturer}.json`));
  const configPath = path.join(rootDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ manufacturer, updateChannel: 'dev', victron: { host: '192.0.2.10' }, ...persisted }));
  const loaded = loadConfigFile(configPath);
  if (loaded.manufacturerProfileError) throw new Error(loaded.manufacturerProfileError);
  return loaded.effectiveConfig;
}

const GC_20 = { gridConnection: { limitKw: 20, marginW: 1000 } }; // Ziel 19 000 W

// --- Welche Profile können „Akku zuerst“? -------------------------------------

test('Profile: Victron unverändert, MQTT-Profile nativ, Fronius/Deye nicht steuerbar', () => {
  const v = resolveGridConnection(loadProfileConfig('victron', GC_20));
  assert.equal(v.battery.kind, 'victron');
  assert.equal(v.batterySupported, true);
  assert.equal(v.batteryNative, false);

  for (const m of ['bridge-mqtt', 'dvhub-mqtt']) {
    const r = resolveGridConnection(loadProfileConfig(m, GC_20));
    assert.equal(r.battery.kind, 'native', m);
    assert.equal(r.battery.setpoint, true, m);
    assert.equal(r.battery.discharge, true, m);
    assert.equal(r.batterySupported, true, `${m}: Sollwert-Decke gilt auch hier`);
    assert.equal(r.batteryNative, true, m);
    assert.match(r.battery.text, /Akku zuerst/);
  }
  for (const m of ['fronius', 'deye-lv']) {
    const r = resolveGridConnection(loadProfileConfig(m, GC_20));
    assert.equal(r.battery.kind, 'none', m);
    assert.equal(r.batterySupported, false, m);
    assert.match(r.battery.text, /Akku nicht steuerbar/);
  }
});

test('eigenes Profil: nur Entladegrenze (Modbus mit Adresse) reicht für „Akku zuerst“', () => {
  const r = resolveGridConnection({
    manufacturer: 'eigen', ...GC_20, victron: { transport: 'modbus' },
    controlWrite: { gridSetpointW: { enabled: false }, maxDischargeW: { enabled: true, address: 1234 } }
  });
  assert.equal(r.battery.kind, 'native');
  assert.equal(r.battery.setpoint, false);
  assert.equal(r.battery.discharge, true);
  assert.equal(r.batterySupported, false, 'ohne Netz-Sollwert keine Sollwert-Decke');
  // Modbus ohne Adresse = nicht schreibbar.
  const r2 = resolveGridConnection({
    manufacturer: 'eigen', ...GC_20, victron: { transport: 'modbus' },
    controlWrite: { maxDischargeW: { enabled: true } }
  });
  assert.equal(r2.battery.kind, 'none');
});

// --- Regelkreis (rein) -----------------------------------------------------------

const NATIVE = () => resolveGridConnection({
  manufacturer: 'bridge-mqtt', ...GC_20, victron: { transport: 'mqtt' },
  controlWrite: { gridSetpointW: { enabled: true }, maxDischargeW: { enabled: true } }
});
const WALLBOX = (w = 11000) => ({ id: 'wallbox', kind: 'wallbox', name: 'Wallbox', currentW: w, maxW: 11000, minW: 4140, phases: 3 });
const meas = (importW) => ({ fresh: true, reason: null, importW, phasesW: null, ageMs: 1000 });
const bat = (o = {}) => ({ setpointW: null, chargeW: 0, dischargeW: 0, socOk: true, limit: { value: 0, from: 'readback' }, maxW: 10000, ...o });

test('assistValueW: Überschuss + Regelabstand, auf 100 W aufgerundet, gedeckelt', () => {
  assert.equal(assistValueW({ excessW: 3000, dischargeW: 0, maxW: 10000 }), 3200);
  assert.equal(assistValueW({ excessW: 3050, dischargeW: 1000, maxW: 10000 }), 4300);
  assert.equal(assistValueW({ excessW: 30000, dischargeW: 0, maxW: 10000 }), 10000);
});

test('Akku zuerst: Entladegrenze steigt um den Überschuss, Wallbox bleibt, solange der Akku folgen darf', () => {
  const r = NATIVE();
  const st = createGuardState();
  const t0 = 1_000_000;
  let res = guardStep(st, { resolved: r, meas: meas(22000), devices: [WALLBOX()], battery: bat(), now: t0 });
  assert.equal(st.assist.valueW, 3200, 'Überschuss 3 000 W + 200 W Regelabstand');
  assert.equal(st.assist.baseW, 0, 'vorherige Grenze gemerkt');
  assert.ok(res.changed.has('battery_assist'));
  assert.equal(res.events.some((e) => e.type === 'cut'), false, 'erst der Akku');
  assert.ok(res.events.some((e) => e.type === 'assist'));
  // Akku braucht ein paar Sekunden: weiterhin keine Drosselung.
  for (let t = t0 + 2000; t <= t0 + BATTERY_OBEY_MS; t += 2000) {
    res = guardStep(st, { resolved: r, meas: meas(22000), devices: [WALLBOX()], battery: bat({ limit: { value: 3200, from: 'own_write' } }), now: t });
    assert.equal(res.events.some((e) => e.type === 'cut'), false, `t+${t - t0}`);
  }
  assert.equal(st.caps.wallbox, undefined);
});

test('Akku folgt nicht: nach der Befolgungszeit wird die Wallbox gedrosselt', () => {
  const r = NATIVE();
  const st = createGuardState();
  const t0 = 1_000_000;
  guardStep(st, { resolved: r, meas: meas(22000), devices: [WALLBOX()], battery: bat(), now: t0 });
  let cut = null;
  for (let t = t0 + 2000; t <= t0 + BATTERY_OBEY_MS + 6000 && !cut; t += 2000) {
    const res = guardStep(st, { resolved: r, meas: meas(22000), devices: [WALLBOX()], battery: bat({ limit: { value: 3200, from: 'own_write' } }), now: t });
    cut = res.events.find((e) => e.type === 'cut');
  }
  assert.ok(cut, 'Wallbox wird gedrosselt');
  assert.ok(st.caps.wallbox < 11000);
});

test('Akku folgt: Bezug sinkt auf das Ziel, keine Drosselung', () => {
  const r = NATIVE();
  const st = createGuardState();
  const t0 = 1_000_000;
  guardStep(st, { resolved: r, meas: meas(22000), devices: [WALLBOX()], battery: bat(), now: t0 });
  for (let t = t0 + 2000; t <= t0 + 60_000; t += 2000) {
    const res = guardStep(st, { resolved: r, meas: meas(18800), devices: [WALLBOX()], battery: bat({ dischargeW: 3200, limit: { value: 3200, from: 'readback' } }), now: t });
    assert.equal(res.events.some((e) => e.type === 'cut'), false);
  }
  assert.equal(st.assist.valueW, 3200);
});

test('Akku leer / SoC unbekannt: keine Akku-Hilfe, Drosselung wie bisher', () => {
  const r = NATIVE();
  const st = createGuardState();
  const t0 = 1_000_000;
  const b = bat({ socOk: false });
  const ev = [
    ...guardStep(st, { resolved: r, meas: meas(22000), devices: [WALLBOX()], battery: b, now: t0 }).events,
    ...guardStep(st, { resolved: r, meas: meas(22000), devices: [WALLBOX()], battery: b, now: t0 + 2000 }).events
  ];
  assert.equal(st.assist, null);
  assert.ok(ev.some((e) => e.type === 'cut'), 'sofort gedrosselt wie bisher (über der harten Grenze)');
});

test('Akku an seiner Leistungsgrenze: Rest über die Lasten', () => {
  const r = NATIVE();
  const st = createGuardState();
  const t0 = 1_000_000;
  const b = bat({ maxW: 2000 });
  const ev = guardStep(st, { resolved: r, meas: meas(22000), devices: [WALLBOX()], battery: b, now: t0 }).events;
  assert.equal(st.assist.valueW, 2000);
  ev.push(...guardStep(st, { resolved: r, meas: meas(22000), devices: [WALLBOX()], battery: { ...b, limit: { value: 2000, from: 'own_write' } }, now: t0 + 2000 }).events);
  const cut = ev.find((e) => e.type === 'cut');
  assert.ok(cut, 'der Rest (ca. 1 kW) kommt von der Wallbox');
  assert.ok(st.caps.wallbox >= 9000, `nur der Rest: ${st.caps.wallbox}`);
});

test('Überschuss weg: Rampe nach unten, dann alte Entladegrenze zurück', () => {
  const r = NATIVE();
  const st = createGuardState();
  const t0 = 1_000_000;
  guardStep(st, { resolved: r, meas: meas(22000), devices: [], battery: bat(), now: t0 });
  // Last sinkt etwas: Bezug 17 000 W bei 3 200 W Akku → 2 000 W Luft.
  let t;
  for (t = t0 + 2000; t <= t0 + 2000 + RELEASE_MS + 2000 && st.assist.valueW === 3200; t += 2000) {
    guardStep(st, { resolved: r, meas: meas(17000), devices: [], battery: bat({ dischargeW: 3200, limit: { value: 3200, from: 'readback' } }), now: t });
  }
  assert.ok(st.assist && st.assist.valueW < 3200 && st.assist.valueW >= 2000, `Rampe: ${st.assist?.valueW}`);
  // Last weg: ohne Akku-Hilfe läge der Bezug weit unter dem Ziel → zurück auf 0.
  const lowered = st.assist.valueW;
  let res;
  for (let k = 0; k < 40 && st.assist; k += 1) {
    t += 2000;
    res = guardStep(st, { resolved: r, meas: meas(12000), devices: [], battery: bat({ dischargeW: lowered, limit: { value: lowered, from: 'readback' } }), now: t });
  }
  assert.equal(st.assist, null);
  assert.deepEqual(st.assistRestore, { valueW: 0 });
  assert.ok(res.changed.has('battery_assist'));
  assert.ok(t - t0 >= HOLD_AFTER_CUT_MS, 'nicht vor der Haltezeit');
});

test('Zähler gestört: Akku-Hilfe bleibt stehen (kein Anheben, kein Zurücknehmen)', () => {
  const r = NATIVE();
  const st = createGuardState();
  const t0 = 1_000_000;
  guardStep(st, { resolved: r, meas: meas(22000), devices: [], battery: bat(), now: t0 });
  for (let t = t0 + 2000; t < t0 + 300_000; t += 2000) {
    guardStep(st, { resolved: r, meas: { fresh: false, reason: 'meter_stale' }, devices: [], battery: bat({ dischargeW: 3200 }), now: t });
  }
  assert.equal(st.assist.valueW, 3200);
  assert.equal(st.assistRestore ?? null, null);
  // … aber ist der Akku leer, gibt DVhub die eigene Freigabe zurück.
  guardStep(st, { resolved: r, meas: { fresh: false, reason: 'meter_stale' }, devices: [], battery: bat({ socOk: false }), now: t0 + 302_000 });
  assert.equal(st.assist, null);
  assert.deepEqual(st.assistRestore, { valueW: 0 });
});

test('Grenze ausgetragen: eigene Freigabe wird zurückgenommen', () => {
  const r = NATIVE();
  const st = createGuardState();
  guardStep(st, { resolved: r, meas: meas(22000), devices: [], battery: bat(), now: 1_000_000 });
  const res = guardStep(st, { resolved: { ...r, active: false, reason: 'not_set' }, meas: null, devices: [], battery: bat(), now: 1_002_000 });
  assert.equal(st.assist, null);
  assert.deepEqual(st.assistRestore, { valueW: 0 });
  assert.ok(res.changed.has('battery_assist'));
});

test('nur Netz-Sollwert (Grenze unbekannt): der Akku bekommt seine Chance, dann die Wallbox', () => {
  const r = resolveGridConnection({
    manufacturer: 'eigen', ...GC_20, victron: { transport: 'mqtt' },
    controlWrite: { gridSetpointW: { enabled: true } }
  });
  const st = createGuardState();
  const t0 = 1_000_000;
  const b = bat({ limit: null });
  const ev = [
    ...guardStep(st, { resolved: r, meas: meas(22000), devices: [WALLBOX()], battery: b, now: t0 }).events,
    ...guardStep(st, { resolved: r, meas: meas(22000), devices: [WALLBOX()], battery: b, now: t0 + 2000 }).events
  ];
  assert.equal(ev.some((e) => e.type === 'cut'), false, 'Akku darf zuerst (auch über der harten Grenze)');
  assert.equal(st.assist, null, 'keine Entladegrenze zum Anheben');
  let cut = null;
  for (let t = t0 + 4000; t <= t0 + BATTERY_OBEY_MS + 6000 && !cut; t += 2000) {
    cut = guardStep(st, { resolved: r, meas: meas(22000), devices: [WALLBOX()], battery: b, now: t }).events.find((e) => e.type === 'cut');
  }
  assert.ok(cut);
});

test('Victron unverändert: keine Akku-Hilfe über die Entladegrenze', () => {
  const r = resolveGridConnection({ manufacturer: 'victron', ...GC_20 });
  const st = createGuardState();
  const t0 = 1_000_000;
  const ev = [
    ...guardStep(st, { resolved: r, meas: meas(22000), devices: [WALLBOX()], battery: { setpointW: null, chargeW: 0 }, now: t0 }).events,
    ...guardStep(st, { resolved: r, meas: meas(22000), devices: [WALLBOX()], battery: { setpointW: null, chargeW: 0 }, now: t0 + 2000 }).events
  ];
  assert.equal(st.assist ?? null, null);
  assert.ok(ev.some((e) => e.type === 'cut'), 'sofort gedrosselt wie bisher');
});

// --- Mit echtem Steuerpfad (bridge-mqtt) -------------------------------------------

function mqttTransport() {
  return {
    type: 'mqtt',
    writes: [],
    async mqttWrite(target, value) { this.writes.push({ target, value }); return {}; }
  };
}

function rig(manufacturer = 'bridge-mqtt', { persisted = {}, assistPath = null } = {}) {
  const cfg = loadProfileConfig(manufacturer, { ...GC_20, optimizer: { allowGridCharge: true }, ...persisted });
  let t = Date.now();
  const at = () => t - 1000;
  const state = {
    victron: {
      soc: 60, batteryPowerW: 0, batteryChargeW: 0, batteryDischargeW: 0, maxDischargeW: 0,
      fieldUpdatedAt: { soc: at(), batteryPowerW: at(), maxDischargeW: at() }
    },
    meter: { ok: true, updatedAt: at(), grid_total_w: -22000 },
    schedule: { rules: [], active: {}, lastWrite: {}, manualOverride: {}, config: { defaultGridSetpointW: null, defaultChargeCurrentA: null, defaultFeedExcessDcPv: 1 }, lastEvalAt: 0 },
    ctrl: { negativePriceActive: false, forcedOff: false }
  };
  const logs = [];
  const transport = mqttTransport();
  const ctx = { getCfg: () => cfg, state, pushLog: (event, payload) => logs.push({ event, payload: payload || {} }), gridConnectionAssistPath: assistPath };
  const guard = createGridConnectionGuard(ctx, { now: () => t });
  const evaluator = createScheduleEvaluator({
    state, getCfg: () => cfg, transport, pushLog: ctx.pushLog, telemetrySafeWrite: () => {},
    persistConfig: async () => {}, telemetryStore: null, epexNowNext: () => null,
    regenerateSmallMarketAutomationRules: async () => {}, onEvalComplete: () => {}, gridConnection: guard
  });
  ctx.applyControlTarget = evaluator.applyControlTarget;
  const measure = ({ importW, dischargeW = 0, maxDischargeW }) => {
    t += 2000;
    const now = t - 500;
    state.meter.grid_total_w = -importW; // ab Werk zählt der Zähler Einspeisung positiv
    state.meter.updatedAt = now;
    state.victron.batteryPowerW = -dischargeW;
    state.victron.batteryDischargeW = dischargeW;
    state.victron.fieldUpdatedAt.batteryPowerW = now;
    state.victron.fieldUpdatedAt.soc = now;
    if (maxDischargeW !== undefined) { state.victron.maxDischargeW = maxDischargeW; state.victron.fieldUpdatedAt.maxDischargeW = now; }
  };
  const writes = (target = 'maxDischargeW') => transport.writes.filter((w) => w.target === target).map((w) => w.value);
  return { cfg, state, logs, transport, guard, evaluator, measure, writes, now: () => t, advance: (ms) => { t += ms; } };
}

test('bridge-mqtt: Akku-Hilfe schreibt die Entladegrenze und stellt sie danach wieder her', async () => {
  const h = rig();
  h.measure({ importW: 22000, maxDischargeW: 0 });
  h.guard.tick();
  await settle();
  assert.deepEqual(h.writes(), [3200]);
  assert.equal(h.state.schedule.lastWrite.maxDischargeW.source, 'grid_connection_assist');
  const s = h.guard.summary();
  assert.equal(s.battery.kind, 'native');
  assert.equal(s.assist.valueW, 3200);
  assert.match(s.text, /Akku/);
  // Akku folgt, dann fällt die Last weg.
  h.measure({ importW: 18800, dischargeW: 3200, maxDischargeW: 3200 });
  h.guard.tick();
  for (let k = 0; k < 60; k += 1) {
    h.measure({ importW: 9000, dischargeW: 3200, maxDischargeW: 3200 });
    h.guard.tick();
    await settle();
  }
  assert.deepEqual(h.writes(), [3200, 0], 'zurück auf die vorherige Sperre (0)');
  assert.equal(h.state.schedule.lastWrite.maxDischargeW.source, 'grid_connection_restore');
  assert.equal(h.guard.summary().assist, null);
});

test('bridge-mqtt: Hand-Vorgabe während der Akku-Hilfe wird nur so weit wie nötig angehoben und danach wiederhergestellt', async () => {
  const h = rig();
  h.measure({ importW: 22000, maxDischargeW: 0 });
  h.guard.tick();
  await settle();
  // Jemand setzt „Entladung sperren“ (0) — die Grenze verlangt aber 3 200 W.
  const r = await h.evaluator.applyControlTarget('maxDischargeW', 0, 'api_manual_write');
  assert.equal(r.ok, true);
  assert.deepEqual(h.writes(), [3200], 'unverändert gehalten (0 wird auf 3 200 W angehoben)');
  assert.ok(h.logs.some((l) => l.event === 'grid_connection_discharge_floor'));
  // Eine Vorgabe ÜBER der Hilfe gilt sofort und beendet die Hilfe ohne Rückschreiben.
  await h.evaluator.applyControlTarget('maxDischargeW', 6000, 'api_manual_write');
  for (let k = 0; k < 60; k += 1) {
    h.measure({ importW: 9000, dischargeW: 0, maxDischargeW: 6000 });
    h.guard.tick();
    await settle();
  }
  assert.deepEqual(h.writes(), [3200, 6000], 'die neuere Vorgabe bleibt stehen');
});

test('bridge-mqtt: Hand-Sperre während der Hilfe wird nach der Spitze zurückgeschrieben', async () => {
  const h = rig();
  h.state.victron.maxDischargeW = 5000; // vorher: 5 kW Deckel
  h.measure({ importW: 26000, dischargeW: 5000, maxDischargeW: 5000 });
  h.guard.tick();
  await settle();
  // Bedarf 5 000 + 7 000 + 200 W, gedeckelt auf die Wechselrichter-Nennleistung (10 kW).
  assert.deepEqual(h.writes(), [10000]);
  await h.evaluator.applyControlTarget('maxDischargeW', 0, 'api_manual_write');
  for (let k = 0; k < 60; k += 1) {
    h.measure({ importW: 5000, dischargeW: 10000, maxDischargeW: 10000 });
    h.guard.tick();
    await settle();
  }
  assert.equal(h.writes().at(-1), 0, 'der jüngste Wunsch (Sperre) gilt nach der Spitze');
});

test('bridge-mqtt: Not-Halt nimmt die eigene Freigabe einmal zurück, danach schweigt der Regelkreis', async () => {
  const h = rig();
  h.measure({ importW: 22000, maxDischargeW: 0 });
  h.guard.tick();
  await settle();
  assert.deepEqual(h.writes(), [3200]);
  h.state.ctrl.discretionaryWritesPaused = true;
  for (let k = 0; k < 5; k += 1) {
    h.measure({ importW: 25000, maxDischargeW: 3200 });
    h.guard.tick();
    await settle();
  }
  assert.deepEqual(h.writes(), [3200, 0], 'genau ein Rückschreiben');
  // Das Not-Halt-Tor lässt sonst nichts durch — auch kein „Zurückschreiben“ nach oben.
  const r = await h.evaluator.applyControlTarget('maxDischargeW', 8000, 'grid_connection_restore');
  assert.equal(r.blocked, true);
  assert.equal(h.guard.summary().paused, true);
});

test('bridge-mqtt: Netz-Sollwert (EOS „Akku halten“ 40 kW) wird auf das Ziel gedeckelt', async () => {
  const h = rig();
  await h.evaluator.applyControlTarget('gridSetpointW', 40000, 'eos_grid_hold');
  assert.deepEqual(h.writes('gridSetpointW'), [19000]);
});

test('Neustart während der Akku-Hilfe: der Merker schreibt die alte Grenze zurück', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-assist-'));
  const p = path.join(dir, 'grid_connection_assist.json');
  fs.writeFileSync(p, JSON.stringify({ valueW: 3200, baseW: 0, since: Date.now() - 60_000 }));
  const h = rig('bridge-mqtt', { assistPath: p });
  h.measure({ importW: 5000, maxDischargeW: 3200 });
  h.state.schedule.lastWrite.maxDischargeW = { value: 3200, source: 'grid_connection_assist', at: Date.now() - 60_000 };
  h.guard.tick();
  await settle();
  assert.deepEqual(h.writes(), [0]);
  assert.equal(fs.existsSync(p), false, 'Merker gelöscht');
  // Merker wird bei einer neuen Hilfe angelegt.
  h.measure({ importW: 22000, maxDischargeW: 0 });
  h.guard.tick();
  await settle();
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).valueW, 3200);
});

test('Fronius und Deye: keine Akku-Writes, Kachel sagt „Akku nicht steuerbar“', async () => {
  for (const m of ['fronius', 'deye-lv']) {
    const h = rig(m);
    h.measure({ importW: 22000 });
    h.guard.tick();
    h.measure({ importW: 22000 });
    h.guard.tick();
    await settle();
    assert.deepEqual(h.transport.writes, [], m);
    const s = h.guard.summary();
    assert.equal(s.battery.kind, 'none', m);
    assert.match(s.battery.text, /Akku nicht steuerbar/, m);
  }
});

test('Victron: der Wächter schreibt keine Entladegrenze (Verhalten unverändert)', async () => {
  const h = rig('victron');
  h.measure({ importW: 22000, maxDischargeW: 0 });
  h.guard.tick();
  h.measure({ importW: 22000, maxDischargeW: 0 });
  h.guard.tick();
  await settle();
  assert.deepEqual(h.writes(), []);
  assert.equal(h.guard.summary().battery.kind, 'victron');
});

test('Akku auf L1, Überlast auf L2: keine sinnlose Anhebung, die Last wird gedrosselt', () => {
  const r = resolveGridConnection({
    manufacturer: 'bridge-mqtt', gridConnection: { limitKw: 40, marginW: 1000, phaseLimitA: 32, batteryPhases: 'L1' },
    victron: { transport: 'mqtt' }, controlWrite: { gridSetpointW: { enabled: true }, maxDischargeW: { enabled: true } }
  });
  const st = createGuardState();
  const m = { fresh: true, reason: null, importW: 15000, phasesW: [3000, 9000, 3000], ageMs: 1000 };
  const ev = [
    ...guardStep(st, { resolved: r, meas: m, devices: [WALLBOX()], battery: bat(), now: 1_000_000 }).events,
    ...guardStep(st, { resolved: r, meas: m, devices: [WALLBOX()], battery: bat(), now: 1_002_000 }).events
  ];
  assert.equal(st.assist, null, 'der Akku entlastet L2 nicht');
  assert.ok(ev.some((e) => e.type === 'cut'));
});

// --- Codex-Gegenprüfung 4deab6d6 ------------------------------------------------

test('Codex 4deab6d6 P1: Akku-Hilfe endet nicht im selben Zug, in dem Lasten frei werden', () => {
  const r = NATIVE();
  const st = createGuardState();
  const t0 = 1_000_000;
  st.assist = { valueW: 5000, baseW: 0, since: t0 - 600_000, raisedAt: t0 - 600_000, seq: 0, roomSince: null, lowerSince: null };
  st.caps.wallbox = 0; st.capAt.wallbox = t0 - 600_000; st.cutFrom = { wallbox: 11000 }; st.lastCutAt = t0 - 600_000;
  st.ceilingW = r.targetW;
  const log = [];
  for (let t = t0; t <= t0 + 240_000; t += 2000) {
    const res = guardStep(st, { resolved: r, meas: meas(12000), devices: [WALLBOX(0)], battery: bat({ dischargeW: 5000, limit: { value: 5000, from: 'readback' } }), now: t });
    log.push({ t, types: res.events.map((e) => e.type), capped: st.caps.wallbox != null });
  }
  const endIdx = log.findIndex((l) => l.types.includes('assist_end'));
  for (const l of log) {
    assert.ok(!(l.types.includes('assist_end') && l.types.some((x) => x === 'release' || x === 'raise')), `t+${l.t - t0}: beides in einem Zug`);
  }
  if (endIdx >= 0) {
    // Solange eine Last gedrosselt ist, hilft der Akku weiter …
    assert.equal(log[endIdx - 1]?.capped ?? false, false, 'Akku-Hilfe endete, obwohl noch eine Last gedrosselt war');
    // … und nach dem Ende gibt der Wächter erst mit frischen Werten wieder frei.
    const after = log.slice(endIdx + 1).filter((l) => l.t - log[endIdx].t < HOLD_AFTER_CUT_MS);
    assert.ok(after.every((l) => !l.types.some((x) => x === 'release' || x === 'raise')));
  }
});

test('Codex 4deab6d6 P1: einphasiger Akku — Zurücknehmen rechnet je Phase', () => {
  const r = resolveGridConnection({
    manufacturer: 'bridge-mqtt', gridConnection: { limitKw: 40, marginW: 1000, phaseLimitA: 32, batteryPhases: 'L1' },
    victron: { transport: 'mqtt' }, controlWrite: { gridSetpointW: { enabled: true }, maxDischargeW: { enabled: true } }
  });
  const st = createGuardState();
  const t0 = 1_000_000;
  st.assist = { valueW: 2400, baseW: 0, since: t0 - 600_000, raisedAt: t0 - 600_000, seq: 0, roomSince: null, lowerSince: null };
  st.ceilingW = r.targetW;
  const m = { fresh: true, reason: null, importW: 9800, phasesW: [5800, 2000, 2000], ageMs: 1000 };
  for (let t = t0; t <= t0 + 240_000; t += 2000) {
    guardStep(st, { resolved: r, meas: m, devices: [], battery: bat({ dischargeW: 2200, limit: { value: 2400, from: 'readback' } }), now: t });
  }
  // Ohne die 2,2 kW stünde L1 bei 8,0 kW über seiner Grenze (7,36 kW): die Hilfe
  // bleibt, höchstens in Stufen gesenkt, so dass L1 unter seinem Ziel bleibt.
  assert.ok(st.assist, `Hilfe bleibt: ${JSON.stringify(st.assist)}`);
  const l1 = 5800 + (2200 - Math.min(st.assist.valueW, 2200));
  assert.ok(l1 <= r.phaseTargetsW[0], `L1 danach ${l1} W`);
});

test('Codex 4deab6d6 P2: nach dem Neustart bleibt die gemerkte Grenze davor der Rückkehrwert', () => {
  const r = NATIVE();
  const st = createGuardState();
  st.assistRestore = { valueW: 0 };
  guardStep(st, { resolved: r, meas: meas(21000), devices: [], battery: bat({ dischargeW: 3200, limit: { value: 3200, from: 'readback' } }), now: 1_000_000 });
  assert.ok(st.assist, 'Hilfe läuft weiter');
  assert.equal(st.assist.baseW, 0, 'nicht die angehobene 3,2 kW als „Wert davor“');
  assert.equal(st.assistRestore, null);
});

test('Codex 4deab6d6 P2: eine Vorgabe über der Hilfe zählt erst, wenn sie geschrieben ist', () => {
  const r = NATIVE();
  const st = createGuardState();
  const t0 = 1_000_000;
  guardStep(st, { resolved: r, meas: meas(22000), devices: [], battery: bat(), now: t0 });
  const ours = { value: 3200, source: 'grid_connection_assist' };
  const req = { requestedW: 6000, source: 'api_manual_write', seq: 1, clamped: false };
  // Write noch unterwegs: lastWrite zeigt noch DVhubs Wert.
  guardStep(st, { resolved: r, meas: meas(18800), devices: [], battery: bat({ dischargeW: 3200, limit: { value: 3200, from: 'own_write' }, request: req, lastWrite: ours }), now: t0 + 2000 });
  assert.ok(st.assist, 'noch nicht übernommen');
  guardStep(st, { resolved: r, meas: meas(18800), devices: [], battery: bat({ dischargeW: 3200, limit: { value: 6000, from: 'own_write' }, request: req, lastWrite: { value: 6000, source: 'api_manual_write' } }), now: t0 + 4000 });
  assert.equal(st.assist, null);
  assert.equal(st.assistRestore, null, 'die neuere Vorgabe bleibt stehen');
  // Gleicher Wert wie die Hilfe: der Evaluator überspringt den Write — trotzdem gilt der Wunsch.
  const st2 = createGuardState();
  guardStep(st2, { resolved: r, meas: meas(22000), devices: [], battery: bat(), now: t0 });
  guardStep(st2, { resolved: r, meas: meas(18800), devices: [], battery: bat({ dischargeW: 3200, request: { requestedW: 3200, source: 'api_manual_write', seq: 1, clamped: false }, lastWrite: ours }), now: t0 + 2000 });
  assert.equal(st2.assist, null);
  assert.equal(st2.assistRestore, null);
});

test('Codex 4deab6d6 P2: Not-Halt direkt nach einer Hand-Sperre schreibt die Sperre zurück', async () => {
  const h = rig();
  h.measure({ importW: 21000, dischargeW: 1000, maxDischargeW: 1000 });
  h.guard.tick();
  await settle();
  assert.deepEqual(h.writes(), [3200], '1 000 W + 2 000 W Überschuss + 200 W');
  await h.evaluator.applyControlTarget('maxDischargeW', 0, 'api_manual_write');
  h.state.ctrl.discretionaryWritesPaused = true;
  h.measure({ importW: 22000, dischargeW: 3200, maxDischargeW: 3200 });
  h.guard.tick();
  await settle();
  assert.deepEqual(h.writes(), [3200, 0], 'der jüngste Wunsch (0), nicht die 1 kW davor');
});

test('Codex 4deab6d6 P2: gescheitertes Zurückschreiben überschreibt keine neuere Vorgabe', async () => {
  const h = rig();
  h.measure({ importW: 22000, maxDischargeW: 0 });
  h.guard.tick();
  await settle();
  assert.deepEqual(h.writes(), [3200]);
  // Zurückschreiben scheitert (Broker weg) …
  const orig = h.transport.mqttWrite;
  h.transport.mqttWrite = async () => { throw new Error('broker weg'); };
  for (let k = 0; k < 40; k += 1) {
    h.measure({ importW: 9000, dischargeW: 3200, maxDischargeW: 3200 });
    h.guard.tick();
    await settle();
  }
  assert.equal(h.guard.summary().assist, null);
  h.transport.mqttWrite = orig;
  // … dann setzt jemand 6 kW von Hand.
  await h.evaluator.applyControlTarget('maxDischargeW', 6000, 'api_manual_write');
  for (let k = 0; k < 20; k += 1) {
    h.measure({ importW: 9000, dischargeW: 0, maxDischargeW: 6000 });
    h.guard.tick();
    await settle();
  }
  assert.deepEqual(h.writes(), [3200, 6000], 'kein Rückschreiben über die neuere Vorgabe');
});

// --- Codex-Gegenprüfung 7ea58e63 ------------------------------------------------

test('Codex 7ea58e63 P2: Teil-Entlastung der eigenen Phase zählt, auch wenn sie nicht ganz reicht', () => {
  const r = resolveGridConnection({
    manufacturer: 'bridge-mqtt', gridConnection: { limitKw: 40, marginW: 1000, phaseLimitA: 32, batteryPhases: 'L1' },
    victron: { transport: 'mqtt' }, controlWrite: { gridSetpointW: { enabled: true }, maxDischargeW: { enabled: true } }
  });
  const st = createGuardState();
  const m = { fresh: true, reason: null, importW: 15000, phasesW: [9000, 3000, 3000], ageMs: 1000 };
  const b = bat({ maxW: 1000 });
  guardStep(st, { resolved: r, meas: m, devices: [WALLBOX()], battery: b, now: 1_000_000 });
  assert.ok(st.assist && st.assist.valueW === 1000, `Akku hilft auf L1 mit allem, was er hat: ${JSON.stringify(st.assist)}`);
  guardStep(st, { resolved: r, meas: m, devices: [WALLBOX()], battery: { ...b, limit: { value: 1000, from: 'own_write' } }, now: 1_002_000 });
  // L1 9 000 − 1 000 Akku − Ziel ≈ 7 027 → ≈ 973 W auf L1 = ≈ 2,9 kW dreiphasig von der Wallbox.
  assert.ok(st.caps.wallbox >= 7500, `nur der Rest von der Wallbox: ${st.caps.wallbox}`);
});

test('Codex 7ea58e63 P2: neue Spitze nach gescheitertem Zurückschreiben übernimmt keinen überholten Rückkehrwert', async () => {
  const h = rig();
  h.measure({ importW: 22000, maxDischargeW: 0 });
  h.guard.tick();
  await settle();
  const orig = h.transport.mqttWrite;
  h.transport.mqttWrite = async () => { throw new Error('broker weg'); };
  for (let k = 0; k < 40 && h.guard.summary().assist; k += 1) {
    h.measure({ importW: 9000, dischargeW: 3200, maxDischargeW: 3200 });
    h.guard.tick();
    await settle();
  }
  h.transport.mqttWrite = orig;
  await h.evaluator.applyControlTarget('maxDischargeW', 6000, 'api_manual_write');
  // Sofort die nächste Spitze, noch vor dem nächsten Rückschreib-Versuch.
  h.measure({ importW: 30000, dischargeW: 6000, maxDischargeW: 6000 });
  h.guard.tick();
  await settle();
  assert.equal(h.guard.summary().assist?.baseW, 6000, 'Rückkehrwert ist die neuere Vorgabe');
});

test('Codex 7ea58e63 P2: Not-Halt ohne Rückschreiben löscht den Merker', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-assist-'));
  const p = path.join(dir, 'grid_connection_assist.json');
  const h = rig('bridge-mqtt', { assistPath: p });
  h.measure({ importW: 22000, maxDischargeW: 0 });
  h.guard.tick();
  await settle();
  assert.equal(fs.existsSync(p), true);
  await h.evaluator.applyControlTarget('maxDischargeW', 6000, 'api_manual_write');
  h.state.ctrl.discretionaryWritesPaused = true;
  h.guard.tick();
  await settle();
  assert.deepEqual(h.writes(), [3200, 6000]);
  assert.equal(fs.existsSync(p), false, 'kein überholter Rückkehrwert für den nächsten Start');
});

test('Codex b7f23382 P2: Restleistung unter 100 W wird noch genutzt, bevor eine Last pausiert', () => {
  const r = NATIVE();
  const st = createGuardState();
  const b = bat({ dischargeW: 9950, limit: { value: 9950, from: 'readback' }, maxW: 10000 });
  const m = meas(19050); // 50 W über dem Ziel
  const ev = [
    ...guardStep(st, { resolved: r, meas: m, devices: [WALLBOX(4140)], battery: b, now: 1_000_000 }).events,
    ...guardStep(st, { resolved: r, meas: m, devices: [WALLBOX(4140)], battery: b, now: 1_002_000 }).events
  ];
  assert.equal(st.assist?.valueW, 10000);
  assert.equal(ev.some((e) => e.type === 'cut'), false, 'Wallbox läuft weiter');
});

// Fable R1 P2-7 (10.11.2026): Neustart mit angehobener Entladegrenze direkt in
// den Not-Halt (gespeichert oder control_state.json unlesbar). Nach dem
// Neustart fehlt DVhubs letzter eigener Write — das Tor verlangte ihn als Beleg
// für „steht höher“ und blockte die eine Rücknahme. Beleg ist jetzt auch der
// Merker der Akku-Hilfe oder eine frische Rücklesung.
test('Fable R1 P2-7: Neustart im Not-Halt mit Merker — die Entladegrenze geht einmal zurück (Rücklesung frisch)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-assist-'));
  const p = path.join(dir, 'grid_connection_assist.json');
  fs.writeFileSync(p, JSON.stringify({ valueW: 5000, baseW: 0, since: Date.now() - 60_000 }));
  const h = rig('bridge-mqtt', { assistPath: p });
  h.state.ctrl.discretionaryWritesPaused = true;
  h.measure({ importW: 5000, maxDischargeW: 5000 });
  assert.equal(h.state.schedule.lastWrite?.maxDischargeW ?? null, null, 'nach dem Neustart kein eigener Write');
  for (let k = 0; k < 3; k += 1) { h.guard.tick(); await settle(); }
  assert.deepEqual(h.writes(), [0], 'genau eine Rücknahme');
  assert.equal(fs.existsSync(p), false, 'Merker gelöscht');
});

test('Fable R1 P2-7: Neustart im Not-Halt mit Merker, ohne Rücklesung — der Merker reicht als Beleg', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-assist-'));
  const p = path.join(dir, 'grid_connection_assist.json');
  fs.writeFileSync(p, JSON.stringify({ valueW: 5000, baseW: 0, since: Date.now() - 60_000 }));
  const h = rig('bridge-mqtt', { assistPath: p });
  h.state.ctrl.discretionaryWritesPaused = true;
  h.measure({ importW: 5000 });
  delete h.state.victron.fieldUpdatedAt.maxDischargeW; // keine Rücklesung
  delete h.state.victron.maxDischargeW;
  for (let k = 0; k < 3; k += 1) { h.guard.tick(); await settle(); }
  assert.deepEqual(h.writes(), [0]);
  // Nichts anderes kommt durch: kein höherer Wert, keine zweite Rücknahme.
  const r = await h.evaluator.applyControlTarget('maxDischargeW', 0, 'grid_connection_restore');
  assert.equal(r.blocked, true);
});

test('Codex 9cbcf92f P1: Neustart im Not-Halt, frische Rücklesung steht schon tiefer → der Merker hebt nicht an', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-assist-'));
  const p = path.join(dir, 'grid_connection_assist.json');
  fs.writeFileSync(p, JSON.stringify({ valueW: 5000, baseW: 3000, since: Date.now() - 60_000 }));
  const h = rig('bridge-mqtt', { assistPath: p });
  h.state.ctrl.discretionaryWritesPaused = true;
  h.measure({ importW: 5000, maxDischargeW: 0 }); // jemand hat inzwischen gesperrt
  for (let k = 0; k < 3; k += 1) { h.guard.tick(); await settle(); }
  assert.deepEqual(h.writes(), [], 'kein Anheben auf 3 000 W im Not-Halt');
});

test('Codex d15440d1 P2: Neustart im Not-Halt, Rückkehrwert steht schon im Gerät → erledigt ohne Write, Merker weg', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-assist-'));
  const p = path.join(dir, 'grid_connection_assist.json');
  fs.writeFileSync(p, JSON.stringify({ valueW: 5000, baseW: 0, since: Date.now() - 60_000 }));
  const h = rig('bridge-mqtt', { assistPath: p });
  h.state.ctrl.discretionaryWritesPaused = true;
  h.measure({ importW: 5000, maxDischargeW: 0 });
  for (let k = 0; k < 3; k += 1) { h.guard.tick(); await settle(); }
  assert.deepEqual(h.writes(), [], 'kein Write');
  assert.equal(fs.existsSync(p), false, 'Merker gelöscht');
  assert.equal(h.guard.persistedRestoreW(), null);
});

test('Codex a83e8bc9 P2: Rücklesung „nicht verfügbar“ (null) gilt nicht als 0 W — die Rücknahme wird geschrieben', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-assist-'));
  const p = path.join(dir, 'grid_connection_assist.json');
  fs.writeFileSync(p, JSON.stringify({ valueW: 5000, baseW: 0, since: Date.now() - 60_000 }));
  const h = rig('bridge-mqtt', { assistPath: p });
  h.state.ctrl.discretionaryWritesPaused = true;
  h.measure({ importW: 5000 });
  h.state.victron.maxDischargeW = null; // frisch abgefragt, Wert nicht verfügbar
  h.state.victron.fieldUpdatedAt.maxDischargeW = Date.now();
  for (let k = 0; k < 3; k += 1) { h.guard.tick(); await settle(); }
  assert.deepEqual(h.writes(), [0]);
});
