// A24 (Christin 23.11.2026): Messwerte werden beim Erzeuger zusätzlich monoton gestempelt (Poller, MQTT-Eingang,
// Zweit-WR-Begleitdienst, Schreibpfad). Verbraucher, die „frisch?“ oder „kam der Messwert NACH meinem Schreiben?“
// prüfen, rechnen damit — ein Sprung der Wanduhr (±3 h) zwischen Messung/Schreiben und Prüfung ändert das Ergebnis
// nicht. Jeder Erzeuger-/Verbraucher-Test war vor A24 rot (Wanduhr gegen Wanduhr bzw. beim Verbraucher geschätzte
// Empfangszeit); Ausnahme ist der ausgewiesene Rückfall-Wächter für Codex ba9fa22b P2.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import {
  monoNow, stampMono, monoStampOf, monoStampAge, monoDeadlinePassed, stampAfter, clearMonoStamp, createStampAge,
} from '../services/mono-clock.js';
import { victronFieldAgeMs, victronFieldStale } from '../server-utils.js';
import { createMqttTransport } from '../transport-mqtt.js';
import { createPoller } from '../polling.js';
import { createFloorHandoff } from '../services/multi-gx/floor-handoff.js';
import { createSetpointFollowWatchdog, knownDischargeCapW } from '../services/setpoint-follow-watchdog.js';
import { secondInverterTelemetry } from '../services/inverter/sungrow.js';
import { createDvLimitController, ctrlDeadlinePassed, LUOX_WATCHDOG_MS } from '../dv-interface-luox.js';
import { createFeedInCap } from '../services/feed-in-cap/index.js';
import { createFeedInLimitArbiter } from '../services/feed-in-limit-arbiter.js';

const H3 = 3 * 3_600_000;

function clocks(wall0 = 1_800_000_000_000, mono0 = 10_000) {
  const c = { wall: wall0, mono: mono0 };
  c.now = () => c.wall;
  c.monoNow = () => c.mono;
  c.tick = (ms) => { c.wall += ms; c.mono += ms; };
  c.jump = (ms) => { c.wall += ms; };
  return c;
}

// Wanduhr global verstellen (Date.now), die echte monotone Uhr läuft weiter.
async function withWallOffset(offsetMs, fn) {
  const real = Date.now;
  Date.now = () => real() + offsetMs;
  try { return await fn(); } finally { Date.now = real; }
}

// --- Werkzeug (mono-clock.js) --------------------------------------------------------------------------------------

test('stampMono: Marke gilt nur für genau den gestempelten Wanduhr-Wert und nur mit derselben Uhr', () => {
  const c = clocks();
  const box = { at: c.wall };
  assert.equal(stampMono(box, 'at', { clock: c.monoNow }), c.mono);
  assert.equal(monoStampOf(box, 'at', c.monoNow), c.mono);
  assert.equal(monoStampOf(box, 'at', () => c.mono), null, 'andere Uhr (Funktions-Identität) → keine Marke');
  assert.equal(monoStampOf(box, 'at'), null, 'gemeinsame Uhr ≠ eingespielte Uhr');
  c.tick(4000);
  assert.equal(monoStampAge(box, 'at', c.monoNow), 4000);
  box.at = c.wall; // ein anderer Pfad stempelt ohne Marke neu
  assert.equal(monoStampOf(box, 'at', c.monoNow), null, 'Stempel ohne Marke überschrieben → Wanduhr');
  stampMono(box, 'at', { clock: c.monoNow, at: c.mono - 500 });
  assert.equal(monoStampAge(box, 'at', c.monoNow), 500, 'at = früher gemessene Empfangszeit');
  clearMonoStamp(box, 'at');
  assert.equal(monoStampOf(box, 'at', c.monoNow), null);
  delete box.at;
  assert.equal(stampMono(box, 'at', { clock: c.monoNow }), null, 'ohne Wanduhr-Wert keine Marke');
  assert.equal(JSON.stringify({ at: 5 }), JSON.stringify(Object.assign({}, { at: 5 })), 'unsichtbar im JSON');
});

test('monoDeadlinePassed/stampAfter/createStampAge: Fristen und Reihenfolge monoton, nie gemischt', () => {
  const c = clocks();
  const ctrl = { offUntil: c.wall + 60_000 };
  stampMono(ctrl, 'offUntil', { clock: c.monoNow, wallNow: c.wall });
  c.jump(-H3); c.tick(59_000);
  assert.equal(monoDeadlinePassed(ctrl, 'offUntil', c.monoNow), false);
  c.tick(2000);
  assert.equal(monoDeadlinePassed(ctrl, 'offUntil', c.monoNow), true, 'nach 61 s Laufzeit abgelaufen, trotz Rücksprung');
  assert.equal(monoDeadlinePassed({ offUntil: 1 }, 'offUntil', c.monoNow), null, 'ohne Marke → null (Wanduhr)');
  assert.equal(stampAfter({ wall: 1, mono: 20 }, { wall: 2, mono: 10 }), true, 'beide monoton → monoton');
  assert.equal(stampAfter({ wall: 1, mono: 20 }, { wall: 2, mono: null }), false, 'eine Seite ohne → Wanduhr');
  const sa = createStampAge({ now: c.now, monoNow: c.monoNow });
  // Ein Stempel, den der Verbraucher erst nach einem Rücksprung sieht: geschätzt „jetzt“, mit Erzeugermarke richtig.
  assert.equal(sa.ageMs('x', c.wall + H3), 0);
  assert.equal(sa.ageMs('y', c.wall + H3, c.mono - 20_000), 20_000);
});

// --- Erzeuger: Poller (polling.js) ---------------------------------------------------------------------------------

function pollerRig(transport) {
  const state = {
    meter: { ok: false, updatedAt: 0, raw: [], grid_l1_w: 0, grid_l2_w: 0, grid_l3_w: 0, grid_total_w: 0, error: null },
    victron: { errors: {}, updatedAt: 0, fieldUpdatedAt: {} },
    dvRegs: new Array(8).fill(0),
    energy: { day: '2026-11-23', importWh: 0, exportWh: 0, costEur: 0, revenueEur: 0, lastTs: 0 },
  };
  const cfg = {
    pollMs: 500, gridPositiveMeans: 'grid_import', epex: { timezone: 'UTC' }, userEnergyPricing: {}, dvControl: {},
    points: { soc: { enabled: true }, maxDischargeW: { enabled: true }, batteryPowerW: { enabled: true } },
  };
  let snap = null;
  const poller = createPoller({
    state, getCfg: () => cfg, transport, pushLog: () => {},
    energyPath: path.join(os.tmpdir(), `a24-poll-${process.pid}-${Math.random()}.json`),
    onPollComplete: (s) => { snap = s; },
    epexNowNext: () => ({ current: { ct_kwh: 0 } }),
  });
  return { state, poller, snap: () => snap };
}

test('Poller: Feld-, Empfangs- und Zählerstempel bekommen monotone Marken, unsichtbar im Status/IPC', async () => {
  const received = monoNow() - 7000; // MQTT-Nachricht vor 7 s Laufzeit empfangen
  const withMonoTs = (o, m) => Object.defineProperty(o, 'monoTs', { value: m, enumerable: false });
  const transport = {
    type: 'mqtt',
    readGrid: () => withMonoTs({ total: 100, l1: 100, l2: 0, l3: 0, ts: Date.now() - 7000 }, received),
    readPoint: async (name) => withMonoTs({ mqttValue: name === 'soc' ? 55 : 0, ts: Date.now() - 7000 }, received),
  };
  const r = pollerRig(transport);
  const before = monoNow();
  await r.poller.requestPoll();
  const v = r.state.victron;
  for (const f of ['soc', 'maxDischargeW', 'batteryPowerW']) {
    const m = monoStampOf(v.fieldUpdatedAt, f);
    assert.ok(m != null && m >= before && m <= monoNow(), `${f}: Abfrage monoton gestempelt`);
    assert.equal(monoStampOf(v.fieldSourceAt, f), received, `${f}: Empfang = Marke des MQTT-Eingangs, nicht die Abfrage`);
  }
  assert.ok(monoStampOf(r.state.meter, 'updatedAt') >= before, 'Zählerstempel monoton');
  assert.equal(monoStampOf(r.state.meter, 'sourceAt'), received, 'Empfang des Netzwerts monoton');
  const json = JSON.stringify(r.state) + JSON.stringify(r.snap());
  assert.doesNotMatch(json, /mono/i, 'keine monotonen Werte im Zustand, Status oder IPC-Schnappschuss');
});

test('Poller: Transport ohne monotone Empfangszeit → keine Empfangsmarke (Verbraucher bleiben bei der Wanduhr)', async () => {
  const transport = {
    type: 'mqtt',
    readGrid: () => ({ total: 100, l1: 100, l2: 0, l3: 0, ts: Date.now() }),
    readPoint: async () => ({ mqttValue: 1, ts: Date.now() }),
  };
  const r = pollerRig(transport);
  await r.poller.requestPoll();
  assert.equal(monoStampOf(r.state.victron.fieldSourceAt, 'soc'), null);
  assert.ok(monoStampOf(r.state.victron.fieldUpdatedAt, 'soc') != null, 'Abfrage selbst bleibt gestempelt');
});

// --- Verbraucher: Feldfrische (server-utils victronFieldAgeMs/Stale) ------------------------------------------------

test('Feldfrische: Sprung vorwärts (+3 h) — ein eben gelesener SoC bleibt frisch', () => {
  const state = { victron: { fieldUpdatedAt: { soc: Date.now() } } };
  stampMono(state.victron.fieldUpdatedAt, 'soc');
  const later = Date.now() + H3; // Prüfung nach dem Sprung
  assert.ok(victronFieldAgeMs(state, 'soc', later) < 1000, 'Alter ≈ 0 statt 3 h');
  assert.equal(victronFieldStale(state, 'soc', 90_000, later), false);
});

test('Feldfrische: Rücksprung (−3 h) — ein stehender SoC veraltet nach maxAgeMs Laufzeit', () => {
  const state = { victron: { fieldUpdatedAt: { soc: Date.now() + H3 } } }; // vor dem Rücksprung gestempelt
  stampMono(state.victron.fieldUpdatedAt, 'soc', { at: monoNow() - 120_000 }); // vor 120 s Laufzeit gelesen
  assert.ok(victronFieldAgeMs(state, 'soc') >= 120_000);
  assert.equal(victronFieldStale(state, 'soc', 90_000), true, 'stale statt „in der Zukunft = frisch“');
  // Ohne Marke wie bisher (Wanduhr).
  assert.equal(victronFieldStale({ victron: { fieldUpdatedAt: { soc: Date.now() + H3 } } }, 'soc', 90_000), false);
});

// --- Verbraucher: MQTT-Zwischenspeicher (transport-mqtt.js) --------------------------------------------------------

function mqttTransport(staleMaxAgeMs) {
  return createMqttTransport({ host: 'gx', mqtt: { portalId: 'p1', staleMaxAgeMs } }, { connectFn: () => ({ on() {}, end() {} }) });
}
const venusMsg = (t, topic, v) => t._onMessage(topic, Buffer.from(JSON.stringify({ value: v })), { retain: false });
const SOC_TOPIC = 'N/p1/system/0/Dc/Battery/Soc';

test('MQTT: Sprung vorwärts (+3 h) — ein eben empfangener Wert bleibt frisch', async () => {
  const t = mqttTransport(90_000);
  venusMsg(t, SOC_TOPIC, 61);
  await withWallOffset(H3, () => {
    assert.equal(t.getCached('soc'), 61, 'nicht veraltet nach dem Sprung');
  });
});

test('MQTT: Rücksprung (−3 h) — ein stehender Wert veraltet nach staleMaxAgeMs Laufzeit', async () => {
  const t = mqttTransport(30);
  venusMsg(t, SOC_TOPIC, 61);
  await withWallOffset(-H3, async () => {
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(t.getCached('soc'), null, 'nach 60 ms Laufzeit veraltet, obwohl die Wanduhr 3 h zurück steht');
  });
});

test('MQTT: Rücklese-Prüfung — ein vor dem Schreiben empfangener Wert gilt nach einem Rücksprung nicht als Bestätigung', async () => {
  const t = mqttTransport(90_000);
  venusMsg(t, 'N/p1/settings/0/Settings/CGwacs/AcPowerSetPoint', -500); // alter Wert, vor dem Write
  const sentWall = Date.now();
  const sentMono = monoNow() + 0.001;
  await withWallOffset(-H3, async () => {
    // Wanduhr-Vergleich allein: der alte Wert (ts vor dem Sprung) liegt „nach“ einem Write-Stempel aus der Zeit danach.
    await assert.rejects(t.readPointSince('gridSetpointW', sentWall - H3, sentMono), /Kein Nach-Write-Wert/);
  });
  venusMsg(t, 'N/p1/settings/0/Settings/CGwacs/AcPowerSetPoint', -800); // Echo nach dem Write
  const res = await t.readPointSince('gridSetpointW', sentWall, sentMono);
  assert.equal(res.mqttValue, -800);
  assert.ok(Number.isFinite(res.monoTs) && !Object.keys(res).includes('monoTs'), 'monoTs nicht aufzählbar');
});

// --- Verbraucher: Übergabe am Entlade-Boden (multi-gx/floor-handoff.js) — Neufassung von ba9fa22b ---------------------

function memoryStore() {
  let value = null;
  return { load: () => value, save: (v) => { value = { ...v }; }, clear: () => { value = null; } };
}

function handoffWorld(c, { transport = 'mqtt', deviceEcho = true, soc = 4 } = {}) {
  const cfg = {
    updateChannel: 'dev', victron: { telemetryMaxAgeMs: 90000 }, optimizer: { hardFloorSocPct: 5 },
    schedule: { evaluateMs: 5000 }, controlWrite: { maxDischargeW: { enabled: true } },
    multiGx: { enabled: true, host: '192.168.1.20', minSocPct: 10, exportHandoffAtFloor: true },
  };
  const state = {
    victron: { soc, maxDischargeW: -1, fieldUpdatedAt: {}, fieldSourceAt: {} },
    multiGx: { online: true, socPct: 80, minSocPct: 10, updatedAt: c.wall },
    ctrl: { discretionaryWritesPaused: false, forcedOff: false, negativePriceActive: false },
    schedule: { lastWrite: {} },
  };
  const stamp = (box, key, wall, at) => { box[key] = wall; stampMono(box, key, { clock: c.monoNow, at }); };
  // Poller: Abfrage jetzt; MQTT-Empfang der Entladegrenze (receivedMono) wie der echte Transport.
  const poll = ({ receivedWall = c.wall, receivedMono = c.mono } = {}) => {
    const v = state.victron;
    stamp(v.fieldUpdatedAt, 'soc', c.wall);
    stamp(v.fieldUpdatedAt, 'maxDischargeW', c.wall);
    if (transport === 'mqtt') stamp(v.fieldSourceAt, 'maxDischargeW', receivedWall, receivedMono);
    state.multiGx.updatedAt = c.wall;
  };
  const applied = [];
  async function apply(target, value, source) {
    if (state.schedule.lastWrite[target] && Number(state.schedule.lastWrite[target].value) === value) return { ok: true, skipped: true };
    applied.push({ target, value, source });
    state.schedule.lastWrite[target] = { value, at: c.wall };
    stampMono(state.schedule.lastWrite[target], 'at', { clock: c.monoNow });
    if (target === 'maxDischargeW' && deviceEcho) state.victron.maxDischargeW = value;
    return { ok: true };
  }
  const logs = [];
  const handoff = createFloorHandoff({ getCfg: () => cfg, state, pushLog: (e, d) => logs.push([e, d]), now: c.now, monoNow: c.monoNow, store: memoryStore(), transportType: () => transport });
  const request = () => handoff.onFloorHold({ target: 'gridSetpointW', requested: -3000, source: 'rule:eos' });
  poll();
  return { cfg, state, poll, apply, applied, handoff, request, logs };
}

// Codex 4fd0803c (P1): ein zwischengespeicherter 0-Wert, empfangen VOR dem Sperr-Write; dann springt die Uhr zurück und
// DVhub schreibt die Sperre, die nicht ankommt. Wanduhr: Empfang „nach“ dem Write → Sperre bestätigt, Akku 1 entlädt
// unter den Boden. Monoton: Empfang davor → keine Bestätigung, der Boden hält.
test('Übergabe: 0-Wert vor dem Sperr-Write empfangen, Rücksprung, Sperre nicht angekommen → keine Bestätigung', async () => {
  const c = clocks();
  const w = handoffWorld(c, { deviceEcho: false });
  assert.equal(w.request(), null);
  assert.equal(w.state.multiGxHandoff.phase, 'arming');
  c.tick(1000);
  w.state.victron.maxDischargeW = 0;
  w.poll(); // MQTT-Cache: 0 empfangen (alter Stand der GX)
  const zeroWall = c.wall; const zeroMono = c.mono;
  c.jump(-3_600_000); c.tick(1000);
  await w.handoff.maintain(w.apply); // Sperr-Write (Wanduhr jetzt kleiner als der Empfang des 0-Werts)
  assert.deepEqual(w.applied.map((a) => a.value), [0]);
  for (let i = 0; i < 4; i += 1) {
    c.tick(5000);
    w.poll({ receivedWall: zeroWall, receivedMono: zeroMono }); // Poller liest weiter den Cache-Eintrag
    assert.equal(w.request(), null, 'Boden hält');
    assert.equal(w.state.multiGxHandoff.mainDischargeBlocked, false);
    await w.handoff.maintain(w.apply);
  }
  assert.equal(w.state.multiGxHandoff.phase, 'arming');
});

test('Übergabe: Sperre vor einem Rücksprung geschrieben, Echo danach → bestätigt wie ohne Sprung', async () => {
  const c = clocks();
  const w = handoffWorld(c);
  w.request(); await w.handoff.maintain(w.apply); // schreibt 0, GX übernimmt
  c.jump(-3_600_000); c.tick(5000);
  w.state.victron.maxDischargeW = 0;
  w.poll(); // Echo nach dem Write empfangen (Wanduhr nach dem Sprung kleiner als der Write)
  assert.equal(w.request(), -3000, 'Übergabe läuft');
  assert.equal(w.state.multiGxHandoff.phase, 'active');
});

test('Übergabe (Modbus): Sperre vor einem Rücksprung geschrieben, 2704/2720 danach gelesen → bestätigt', async () => {
  const c = clocks();
  const w = handoffWorld(c, { transport: 'modbus' });
  let exactValue = -1;
  const handoff = createFloorHandoff({
    getCfg: () => w.cfg, state: w.state, now: c.now, monoNow: c.monoNow, store: memoryStore(), transportType: () => 'modbus',
    readExactMaxDischargeW: async () => ({ value: exactValue }),
  });
  const req = () => handoff.onFloorHold({ target: 'gridSetpointW', requested: -3000, source: 'rule:eos' });
  w.state.victron.maxDischargeW = 1000; w.poll();
  req(); await handoff.maintain(w.apply);
  assert.equal(w.state.multiGxHandoff.phase, 'arming');
  c.jump(-3_600_000); c.tick(5000);
  exactValue = 0; w.state.victron.maxDischargeW = 0; w.poll();
  await handoff.maintain(w.apply); // liest 2720 = 0 nach dem Write
  assert.equal(req(), -3000);
  assert.equal(w.state.multiGxHandoff.phase, 'active');
});

test('Übergabe: Zurückschreiben vor einem Rücksprung, Rückmeldung danach → beendet wie ohne Sprung', async () => {
  const c = clocks();
  const w = handoffWorld(c);
  w.request(); await w.handoff.maintain(w.apply);
  w.state.victron.maxDischargeW = 0; c.tick(5000); w.poll();
  assert.equal(w.request(), -3000);
  // Keine Anfrage mehr, Akku 1 wieder voll genug: zurückschreiben.
  w.state.victron.soc = 50;
  c.tick(25_000); w.poll();
  await w.handoff.maintain(w.apply);
  assert.equal(w.state.multiGxHandoff.phase, 'restoring');
  assert.deepEqual(w.applied.map((a) => a.value), [0, -1]);
  c.jump(-3_600_000); c.tick(5000); w.poll(); // GX meldet −1 nach dem Zurückschreiben
  await w.handoff.maintain(w.apply);
  assert.equal(w.state.multiGxHandoff.phase, 'off', 'Rückmeldung zählt, Sicherung erledigt');
  assert.deepEqual(w.applied.map((a) => a.value), [0, -1], 'kein zweites Zurückschreiben');
});

test('Übergabe: fremder Write der Entladegrenze vor einem Rücksprung, Messwert danach → Übergabe startet', async () => {
  const c = clocks();
  const w = handoffWorld(c);
  w.state.schedule.lastWrite.maxDischargeW = { value: -1, at: c.wall, source: 'peak_shaving' };
  stampMono(w.state.schedule.lastWrite.maxDischargeW, 'at', { clock: c.monoNow });
  c.jump(-3_600_000); c.tick(5000); w.poll();
  assert.equal(w.request(), null);
  assert.equal(w.state.multiGxHandoff.phase, 'arming', 'Messwert nach dem Write erkannt');
});

// --- Verbraucher: Entlade-Wächter (setpoint-follow-watchdog.js) — Neufassung von ba9fa22b -----------------------------

const SF_WALL0 = 1_800_000_000_000;
function sfSetup({ cfg = {}, transport = null, withMono = true } = {}) {
  const sent = [];
  const c = { wall: SF_WALL0, mono: 50_000 };
  const monoFn = () => c.mono;
  const state = {
    meter: { ok: true },
    victron: { gridSetpointW: -100, gridImportW: 1800, gridExportW: 0, batteryPowerW: 0, soc: 70, minSocPct: 5, fieldUpdatedAt: {} },
    ctrl: {}, schedule: { lastWrite: {} },
  };
  const watchdog = createSetpointFollowWatchdog({
    state, getCfg: () => cfg, pushLog: () => {}, transport, ...(withMono ? { monoNow: monoFn } : {}),
    notificationService: { sendDirect: (msg) => { sent.push(msg); return Promise.resolve({ sent: 1 }); } },
  });
  const poll = () => {
    for (const f of ['gridSetpointW', 'batteryPowerW', 'soc']) {
      state.victron.fieldUpdatedAt[f] = c.wall;
      stampMono(state.victron.fieldUpdatedAt, f, { clock: monoFn });
    }
    watchdog.tick(c.wall, c.mono);
  };
  return { state, watchdog, sent, c, monoFn, poll };
}
const SF_CFG = { manufacturer: 'victron', victron: { host: 'gx' }, controlWrite: { maxDischargeW: { enabled: true, address: 2704 } } };

// Codex 4fd0803c (P2): eine monoton frische eigene Lesung der Sperre gilt auch nach einem Sprung über 90 s hinaus.
test('Wächter: Rücksprung > 90 s — frische eigene Lesung „gesperrt“ entschuldigt weiter', async () => {
  const transport = { type: 'modbus', async mbRequest(a) { return a.quantity === 2 ? [0, 0] : [0]; } }; // 2720 = 0 W
  const s = sfSetup({ cfg: SF_CFG, transport, withMono: false });
  s.poll();
  await new Promise((r) => setImmediate(r));
  const n = s.watchdog._state().window.length;
  s.c.wall -= 3_600_000; s.c.mono += 5000;
  s.poll();
  assert.equal(s.watchdog._state().window.length, n, 'Sperre entschuldigt: kein neuer auffälliger Punkt');
});

test('Wächter: Sprung vorwärts (+3 h) — frische eigene Lesung „gesperrt“ entschuldigt weiter', async () => {
  const transport = { type: 'modbus', async mbRequest(a) { return a.quantity === 2 ? [0, 0] : [0]; } };
  const s = sfSetup({ cfg: SF_CFG, transport });
  s.poll();
  await new Promise((r) => setImmediate(r));
  const n = s.watchdog._state().window.length;
  s.c.wall += H3; s.c.mono += 5000;
  s.poll();
  assert.equal(s.watchdog._state().window.length, n);
});

// Codex ba9fa22b (P2): nach einem Rücksprung darf die ältere eigene Lesung (gesperrt) eine NEUERE eindeutige Rücklesung
// von Peak Shaving (freigegeben, −1) nicht überstimmen — die Reihenfolge rechnet monoton mit. Wächter gegen den
// Rückfall von ba9fa22b (vor A24 grün, weil die eigene Lesung dort nach dem Sprung schon als veraltet galt).
test('Wächter: Rücksprung — neuere Rücklesung von Peak Shaving geht der älteren eigenen Lesung vor', () => {
  const c = clocks();
  const state = { victron: {}, ctrl: { _peakShaving: {} }, schedule: { lastWrite: {} } };
  const own = { value: 0, at: c.wall, mono: c.mono, error: null, ambiguousZero: false };
  c.jump(-3_600_000); c.tick(10_000);
  const rb = { value: -1, at: c.wall, tick: 1, error: null, ambiguousZero: false };
  stampMono(rb, 'at', { clock: c.monoNow });
  state.ctrl._peakShaving.readback = rb;
  c.tick(5000);
  assert.equal(knownDischargeCapW(state, SF_CFG, c.wall, own, { monoMs: c.mono, clock: c.monoNow }), -1);
  // Umgekehrt: eigene Lesung neuer als die von Peak Shaving → eigene gilt.
  const own2 = { value: 0, at: c.wall, mono: c.mono, error: null, ambiguousZero: false };
  assert.equal(knownDischargeCapW(state, SF_CFG, c.wall, own2, { monoMs: c.mono, clock: c.monoNow }), 0);
});

test('Wächter: Rücksprung — stehende Messwerte veralten nach maxAgeMs Laufzeit, auch wenn der Stempel erst danach gesehen wird', () => {
  const s = sfSetup();
  // Der Poller hat vor 70 s Laufzeit zuletzt gelesen; danach sprang die Uhr zurück. Der Wächter sieht die Stempel neu.
  for (const f of ['gridSetpointW', 'batteryPowerW', 'soc']) {
    s.state.victron.fieldUpdatedAt[f] = s.c.wall;
    stampMono(s.state.victron.fieldUpdatedAt, f, { clock: s.monoFn, at: s.c.mono - 70_000 });
  }
  s.c.wall -= 3_600_000;
  s.watchdog.tick(s.c.wall, s.c.mono);
  assert.equal(s.watchdog._state().window.length, 0, 'kein Punkt aus 70 s alten Werten');
});

// --- Verbraucher: Zweit-WR (sungrow.js secondInverterTelemetry) ----------------------------------------------------

function secondState(c) {
  const state = { sungrowSecond: { online: true, updatedAt: c.wall, batteryPowerW: -500, pvPowerW: 2000, bdcRatedW: 3000 } };
  stampMono(state.sungrowSecond, 'updatedAt', { clock: c.monoNow });
  return state;
}
const CFG_AGG = { sungrow: { secondInverter: { enabled: true, host: '192.168.68.83', aggregateTelemetry: true } } };

test('Zweit-WR: Rücksprung — stehende Slave-Werte veralten nach 20 s Laufzeit', () => {
  const c = clocks();
  const state = secondState(c);
  c.jump(-H3); c.tick(21_000);
  assert.equal(secondInverterTelemetry(state, CFG_AGG, { nowMs: c.wall, maxAgeMs: 20_000, monoNow: c.monoNow }), null);
});

test('Zweit-WR: Sprung vorwärts (+3 h) — eben gelesene Slave-Werte bleiben frisch', () => {
  const c = clocks();
  const state = secondState(c);
  c.jump(H3); c.tick(1000);
  const t = secondInverterTelemetry(state, CFG_AGG, { nowMs: c.wall, maxAgeMs: 20_000, monoNow: c.monoNow });
  assert.equal(t?.batteryPowerW, -500);
});

// --- Verbraucher: Nulleinspeisung meterFresh (schedule-eval) und Einspeisegrenze meterFresh -------------------------

test('Einspeisegrenze: Zählerstempel erst nach einem Rücksprung gesehen — Alter vom Erzeuger, nicht „jetzt“', () => {
  const c = clocks();
  const cfg = { manufacturer: 'victron', userEnergyPricing: { pvPlants: [{ kwp: 10 }] }, controlWrite: { dvFeedInLimitW: { enabled: true, address: 2706, host: 'gx', port: 502, unitId: 100 } }, feedInCap: { mode: 'pct60' } };
  const state = { victron: { gridExportW: 7000 }, meter: { ok: true, updatedAt: c.wall }, ctrl: {} };
  stampMono(state.meter, 'updatedAt', { clock: c.monoNow, at: c.mono - 20_000 }); // vor 20 s Laufzeit gelesen
  c.jump(-H3);
  const s = createFeedInCap({ getCfg: () => cfg, state, feedInLimit: createFeedInLimitArbiter({ applyLimit: async () => {} }), pushLog: () => {} },
    { getTransport: () => null, now: c.now, monoNow: c.monoNow, setWarning: () => {} });
  assert.equal(s.meterFresh(), false, '20 s alt → nicht frisch');
});

// --- Verbraucher: DV-Lease (server.js offUntil, LUOX dvLimitUntil) -------------------------------------------------

test('DV-Lease: Rücksprung — offUntil läuft nach der Restzeit ab, nicht erst um die Sprungweite später', () => {
  const c = clocks();
  const ctrl = { forcedOff: true, offUntil: c.wall + 600_000 };
  stampMono(ctrl, 'offUntil', { clock: c.monoNow, wallNow: c.wall });
  c.jump(-H3); c.tick(601_000);
  assert.equal(ctrlDeadlinePassed(ctrl, 'offUntil', c.wall, c.monoNow), true);
  // Sprung vorwärts: die Frist des Direktvermarkters gilt weiter.
  const ctrl2 = { forcedOff: true, offUntil: c.wall + 600_000 };
  stampMono(ctrl2, 'offUntil', { clock: c.monoNow, wallNow: c.wall });
  c.jump(H3); c.tick(1000);
  assert.equal(ctrlDeadlinePassed(ctrl2, 'offUntil', c.wall, c.monoNow), false);
  // Ohne Marke wie bisher (Wanduhr).
  assert.equal(ctrlDeadlinePassed({ offUntil: c.wall + 1 }, 'offUntil', c.wall, c.monoNow), false);
});

test('LUOX: Teilvorgabe endet 15 min nach dem letzten Watchdog-Schreiben Laufzeit, trotz Rücksprung', () => {
  const c = clocks();
  const calls = [];
  const state = { ctrl: { forcedOff: false, offUntil: 0 } };
  const dv = createDvLimitController({
    state, getCfg: () => ({ dvInterface: { profile: 'luox' }, optimizer: { inverterMaxPowerW: 10000 }, controlWrite: { dvFeedInLimitW: { enabled: true } }, userEnergyPricing: { pvPlants: [{ kwp: 10 }] } }),
    setForcedOff: () => {}, clearForcedOff: () => {}, applyDvFeedInLimit: async (w) => { calls.push(w); },
    now: c.now, monoNow: c.monoNow,
  });
  const r = dv.setDvLimitPct(50, 'luox');
  assert.equal(r.mode, 'limit');
  dv.watchdogRefresh();
  c.jump(-H3); c.tick(LUOX_WATCHDOG_MS + 1000);
  dv.expireIfNeeded();
  assert.equal(state.ctrl.dvLimitPct, null, 'Teilvorgabe nach 15 min Laufzeit aufgehoben');
});

// --- Verbraucher: Nulleinspeisung (schedule-eval zeroFeedInTick, meterFresh) -----------------------------------------

async function zeroFeedInRig({ meterMonoAgoMs = 0 } = {}) {
  const fs = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { loadConfigFile } = await import('../config-model.js');
  const { createScheduleEvaluator } = await import('../schedule-eval.js');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-a24-zfi-'));
  fs.mkdirSync(path.join(rootDir, 'hersteller'), { recursive: true });
  fs.copyFileSync(path.join(here, '..', 'hersteller', 'fronius.json'), path.join(rootDir, 'hersteller', 'fronius.json'));
  const configPath = path.join(rootDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ manufacturer: 'fronius', victron: { host: '192.0.2.10' } }));
  const cfg = loadConfigFile(configPath).effectiveConfig;
  Object.assign(cfg.controlWrite.wMaxLimPct, { address: 40242 });
  Object.assign(cfg.controlWrite.wMaxLimPctRvrtTms, { address: 40244 });
  Object.assign(cfg.controlWrite.wMaxLimEna, { address: 40246 });
  Object.assign(cfg.controlWrite.outWRte, { address: 40198 });
  Object.assign(cfg.controlWrite.storCtlMod, { address: 40191 });
  cfg.optimizer = { ...cfg.optimizer, inverterMaxPowerW: 10000 };
  const state = {
    victron: { soc: 97, gridImportW: 0, gridExportW: 0, selfConsumptionW: 0, fieldUpdatedAt: { soc: Date.now() } },
    meter: { ok: true, updatedAt: Date.now() },
    ctrl: { _lastDvFeedIn: false },
    schedule: { rules: [], active: {}, lastWrite: {}, manualOverride: {}, config: {}, lastEvalAt: 0 },
  };
  stampMono(state.victron.fieldUpdatedAt, 'soc');
  stampMono(state.meter, 'updatedAt', { at: monoNow() - meterMonoAgoMs });
  const writes = [];
  const transport = {
    type: 'modbus',
    async mbWriteSingle({ address, value }) { writes.push({ address, value }); },
    async mbWriteMultiple({ address, values }) { writes.push({ address, values }); },
    async mbRequest({ address }) { const last = [...writes].reverse().find((x) => x.address === address); return [last ? last.value : 0]; },
  };
  const ev = createScheduleEvaluator({
    state, getCfg: () => cfg, transport, pushLog: () => {},
    telemetrySafeWrite: () => {}, persistConfig: async () => {}, telemetryStore: null, epexNowNext: () => null,
  });
  return { ev, state, pct: () => writes.filter((x) => x.address === 40242).map((x) => x.value) };
}

test('Nulleinspeisung: Sprung vorwärts (+3 h) — ein eben gelesener Zählerwert gilt als frisch, der Deckel greift', async () => {
  const r = await zeroFeedInRig();
  await withWallOffset(H3, async () => { await r.ev.zeroFeedInTick(); await r.ev.zeroFeedInTick(); });
  assert.equal(r.state.ctrl._zfi.capActive, true);
  assert.deepEqual(r.pct(), [100]);
});

test('Nulleinspeisung: Rücksprung (−3 h) — ein 20 s alter Zählerwert gilt nicht als frisch (kein Deckel aus alten Daten)', async () => {
  const r = await zeroFeedInRig({ meterMonoAgoMs: 20_000 });
  await withWallOffset(-H3, async () => {
    await r.ev.zeroFeedInTick(); await r.ev.zeroFeedInTick();
  });
  assert.equal(r.state.ctrl._zfi.capActive, false);
  assert.deepEqual(r.pct(), []);
});
