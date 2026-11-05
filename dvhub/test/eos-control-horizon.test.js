// test/eos-control-horizon.test.js — Steuerzeitraum-Modus „automatisch“
// (DVhub 1.0.10, Christin 05.11.2026).
//
// Messung ~/Projects/eos-bench/HORIZONT-MESSUNG.md (V3): Steuerzeitraum
// mindestens 6 h und bis zur spätesten Frist eines steuerbaren Verbrauchers
// (Abfahrt E-Auto, Fensterende planbarer Geräte), höchstens so weit, wie echte
// Preise reichen; dahinter bewertet EOS die Restladung über den Schwanz.
// JAHRESRECHNUNG-2026.md: auf 305 Tagen gleichauf mit dem ganzen Preiszeitraum
// bei etwa einem Viertel der Rechenzeit (mit 100 Generationen).

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import http from 'node:http';
import { zoneOffsetMs } from '../tz-fast.js';
import {
  createEosForecastBridge,
  decideControlHorizon,
  collectPlanningDeadlines,
  controlHorizonMode,
  AUTO_CONTROL_MIN_HOURS,
} from '../services/optimizer/eos-forecast-bridge.js';

const Q = 15 * 60_000;
const H = 3_600_000;

function createMockEos() {
  const requests = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let parsed = null;
        if (body) { try { parsed = JSON.parse(body); } catch { parsed = body; } }
        requests.push({ method: req.method, url: req.url, body: parsed });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.method === 'GET' && req.url.startsWith('/v1/measurement/keys')) res.end(JSON.stringify(['battery1-soc-factor', 'ev11-soc-factor']));
        else res.end(JSON.stringify({ ok: true }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, requests, close: () => new Promise((r) => server.close(r)) }));
  });
}

/**
 * Box mit echten Preisen bis jetzt + realHours, PV/Last bis jetzt + 40 h und
 * 20 Tagen Preis-Historie (die Schätzung dahinter funktioniert also).
 */
function env(mock, { realHours = 10, optimizer = {}, state: extraState = {}, devices } = {}) {
  const now = Date.now();
  const q0 = now - (now % Q);
  const realEnd = q0 + realHours * H;
  const pvEnd = q0 + 40 * H;
  const pattern = (ms) => 10 + 8 * Math.sin((((ms + zoneOffsetMs(ms, 'Europe/Berlin')) / Q) % 96 - 30) / 96 * 2 * Math.PI);
  const price = [];
  for (let ms = q0 - 2 * H; ms < realEnd; ms += Q) price.push({ start: new Date(ms).toISOString(), ctKwh: pattern(ms) });
  const pv = [];
  for (let ms = q0; ms < pvEnd; ms += Q) pv.push({ start: new Date(ms).toISOString(), powerW: 1000 });
  const load = [];
  for (let ms = q0 - (q0 % H); ms < pvEnd; ms += H) load.push({ start: new Date(ms).toISOString(), powerW: 500 });
  const history = [];
  for (let ms = q0 - 20 * 86_400_000; ms < q0; ms += Q) history.push({ key: 'price_ct_kwh', ts: new Date(ms), value: pattern(ms), resolution: 900 });
  const state = { victron: { soc: 50 }, optimizer: { eos: { supported: true }, ...extraState } };
  const logs = [];
  const cfg = {
    optimizer: {
      eosProxy: { enabled: true, url: `http://127.0.0.1:${mock.port}` },
      tariff: { feedInMode: 'spot', feedInSpotFactor: 1 },
      timezone: 'Europe/Berlin',
      eosOptimizationIntervalSec: 900,
      ...optimizer,
    },
    userEnergyPricing: { mode: 'fixed', fixedGrossImportCtKwh: 30 },
    ...(devices ? { devices } : {}),
  };
  const ctx = {
    getCfg: () => cfg,
    pushLog: (event, data) => logs.push({ event, data }),
    forecastService: { buildForecastResponse: async () => ({ pv: { slots: pv }, load: { slots: load }, price: { slots: price } }) },
    state,
    telemetryStore: { querySeries: async () => history },
  };
  return { ctx, state, cfg, q0, realEnd, logs };
}

const horizonPut = (mock) => mock.requests.filter((r) => r.method === 'PUT' && r.url.startsWith('/v1/config/optimization/genetic/horizon_hours')).pop()?.body;
const realHoursOf = (e) => Math.floor((e.realEnd - Date.now() - Q) / H);

// E-Auto bei EOS angemeldet, Abfahrt (einmalig) zu einem festen Zeitpunkt.
const evOptimizer = (departureMs) => ({
  eosOptimizeEv: true,
  evDepartureEnabled: true,
  evDepartureOnce: new Date(departureMs).toISOString(),
  evTargetMode: 'percent',
  evTargetValue: 80,
});
const evRegistered = { eosEv: { register: true, mode: 'plugged' } };

// ── Reine Entscheidung ──────────────────────────────────────────────────────

test('controlHorizonMode: Standard ganzer Preiszeitraum, feste Grenze, automatisch', () => {
  assert.equal(controlHorizonMode({}), 'full');
  assert.equal(controlHorizonMode({ optimizer: { eosControlHorizonMaxHours: 0 } }), 'full');
  assert.equal(controlHorizonMode({ optimizer: { eosControlHorizonMaxHours: 12 } }), 'cap');
  assert.equal(controlHorizonMode({ optimizer: { eosControlHorizonMaxHours: 'auto' } }), 'auto');
  assert.equal(AUTO_CONTROL_MIN_HOURS, 6);
});

test('decideControlHorizon: ganzer Preiszeitraum und feste Grenze bleiben, wie sie sind', () => {
  const w = Date.parse('2026-11-05T09:00:00Z');
  const ev = [{ kind: 'ev', atMs: w + 20 * H }];
  assert.deepEqual(decideControlHorizon({ realHours: 14, mode: 'full', deadlines: ev, windowStartMs: w }).hours, 14);
  assert.deepEqual(decideControlHorizon({ realHours: 12, mode: 'cap', deadlines: [], windowStartMs: w }).hours, 12);
  assert.equal(decideControlHorizon({ realHours: null, mode: 'full', windowStartMs: w }).hours, null);
});

test('decideControlHorizon automatisch: mindestens 6 h, bis zur spätesten Frist, höchstens bis zu den echten Preisen', () => {
  const w = Date.parse('2026-11-05T16:00:00Z');
  // Ohne Frist: 6 h.
  let d = decideControlHorizon({ realHours: 31, mode: 'auto', deadlines: [], windowStartMs: w });
  assert.equal(d.hours, 6);
  assert.equal(d.reason, 'min');
  // Frist vor 6 h: weiter 6 h.
  d = decideControlHorizon({ realHours: 31, mode: 'auto', deadlines: [{ kind: 'appliance', id: 'appl_dw', atMs: w + 3 * H }], windowStartMs: w });
  assert.equal(d.hours, 6);
  // Abfahrt in 14 h 20 min: 15 h (aufgerundet — das Ende liegt nie vor der Frist).
  d = decideControlHorizon({ realHours: 31, mode: 'auto', deadlines: [{ kind: 'ev', atMs: w + 14 * H + 20 * 60_000 }, { kind: 'appliance', id: 'appl_dw', atMs: w + 8 * H }], windowStartMs: w });
  assert.equal(d.hours, 15);
  assert.equal(d.reason, 'deadline');
  assert.deepEqual(d.deadline, { kind: 'ev', at: new Date(w + 14 * H + 20 * 60_000).toISOString() });
  // Spätere Gerätefrist gewinnt.
  d = decideControlHorizon({ realHours: 31, mode: 'auto', deadlines: [{ kind: 'ev', atMs: w + 9 * H }, { kind: 'appliance', id: 'appl_dw', atMs: w + 11 * H }], windowStartMs: w });
  assert.equal(d.hours, 11);
  assert.equal(d.deadline.kind, 'appliance');
  // Frist hinter den echten Preisen: höchstens die echten Preise.
  d = decideControlHorizon({ realHours: 7, mode: 'auto', deadlines: [{ kind: 'ev', atMs: w + 15 * H }], windowStartMs: w });
  assert.equal(d.hours, 7);
  assert.equal(d.reason, 'prices');
  // Echte Preise kürzer als 6 h: die echten Preise.
  d = decideControlHorizon({ realHours: 4, mode: 'auto', deadlines: [], windowStartMs: w });
  assert.equal(d.hours, 4);
  // Vergangene Fristen zählen nicht.
  d = decideControlHorizon({ realHours: 31, mode: 'auto', deadlines: [{ kind: 'ev', atMs: w - H }], windowStartMs: w });
  assert.equal(d.hours, 6);
});

test('collectPlanningDeadlines: Abfahrt nur, wenn das Auto bei EOS angemeldet ist; Geräte nur, solange sie heute nicht gelaufen sind', () => {
  const now = Date.parse('2026-11-05T09:00:00Z'); // 10:00 Ortszeit
  const dep = now + 20 * H;
  const dw = { id: 'dishwasher', name: 'GS', schedulable: true, kind: 'deferrable', plan: { energyWh: 1200, durationH: 2, deadline: '18:00', earliestStart: '08:00' }, endpoint: { type: 'shelly', shellyDeviceId: 's1' } };
  const cfg = { optimizer: evOptimizer(dep), devices: [dw] };
  let list = collectPlanningDeadlines(cfg, { optimizer: evRegistered }, now);
  assert.deepEqual(list.map((d) => d.kind).sort(), ['appliance', 'ev']);
  assert.equal(list.find((d) => d.kind === 'ev').atMs, dep);
  assert.equal(list.find((d) => d.kind === 'appliance').atMs, Date.parse('2026-11-05T17:00:00Z'));
  // Nicht angemeldet (nicht angesteckt, keine Vorplanung): keine Abfahrt.
  list = collectPlanningDeadlines(cfg, { optimizer: { eosEv: { register: false } } }, now);
  assert.deepEqual(list.map((d) => d.kind), ['appliance']);
  // Gerät heute schon gelaufen: keine Frist mehr.
  list = collectPlanningDeadlines(cfg, { optimizer: { ...evRegistered, applianceCyclesToday: { appl_dishwasher: 1 } } }, now);
  assert.deepEqual(list.map((d) => d.kind), ['ev']);
  // Auto wird nicht mitoptimiert: keine Abfahrt, auch wenn ein alter Stand „angemeldet“ sagt.
  list = collectPlanningDeadlines({ optimizer: { ...evOptimizer(dep), eosOptimizeEv: false } }, { optimizer: evRegistered }, now);
  assert.deepEqual(list, []);
});

// ── Über den Push an EOS ────────────────────────────────────────────────────

test('Push, automatisch ohne Frist: Steuerzeitraum 6 h statt der echten Preise', async () => {
  const mock = await createMockEos();
  try {
    const e = env(mock, { realHours: 30, optimizer: { eosControlHorizonMaxHours: 'auto' } });
    await createEosForecastBridge(e.ctx).push();
    assert.equal(horizonPut(mock), 6);
    assert.equal(e.state.optimizer.eosControlHorizonH, 6);
    assert.equal(e.state.optimizer.eosControl.mode, 'auto');
    assert.equal(e.state.optimizer.eosControl.reason, 'min');
    assert.equal(e.state.optimizer.eosControl.realHours, realHoursOf(e));
  } finally { await mock.close(); }
});

test('Push, automatisch mit Abfahrt in den echten Preisen: Steuerzeitraum bis zur Abfahrt; Lauf darf rechnen', async () => {
  const mock = await createMockEos();
  try {
    const now = Date.now();
    const q0 = now - (now % Q);
    const dep = q0 + 13 * H + 40 * 60_000;
    const e = env(mock, { realHours: 30, optimizer: { eosControlHorizonMaxHours: 'auto', ...evOptimizer(dep) }, state: evRegistered });
    const bridge = createEosForecastBridge(e.ctx);
    assert.deepEqual(await bridge.prepareRun(), { ok: true, pushed: true });
    assert.equal(horizonPut(mock), 14);
    assert.equal(e.state.optimizer.eosControl.reason, 'deadline');
    assert.equal(e.state.optimizer.eosControl.deadline.kind, 'ev');
    assert.equal(e.state.optimizer.eosControl.estimatedFrom, null, 'nur echte Preise im Steuerzeitraum');
    assert.ok(e.logs.some((l) => l.event === 'eos_control_horizon' && l.data.hours === 14 && l.data.reason === 'deadline'));
  } finally { await mock.close(); }
});

test('Push, Standard (ganzer Preiszeitraum): unverändert die echten Preise', async () => {
  const mock = await createMockEos();
  try {
    const e = env(mock, { realHours: 30 });
    await createEosForecastBridge(e.ctx).push();
    assert.equal(horizonPut(mock), realHoursOf(e));
    assert.equal(e.state.optimizer.eosControl.mode, 'full');
  } finally { await mock.close(); }
});

test('Einstellungen: Steuerzeitraum „automatisch“ ist wählbar und wird gespeichert', async () => {
  const { getConfigDefinition, normalizeConfigInput } = await import('../config-model.js');
  const ctrl = getConfigDefinition().fields.find((f) => f.path === 'optimizer.eosControlHorizonMaxHours');
  const auto = ctrl.options.find((o) => o.value === 'auto');
  assert.ok(auto, 'Auswahl „automatisch“');
  assert.match(auto.label, /automatisch/i);
  assert.match(auto.label, /6 h/);
  assert.match(auto.label, /Frist/);
  assert.equal(ctrl.options[0].value, 0, 'der bisherige Standard bleibt Standard');
  assert.match(ctrl.help, /automatisch/i);
  const ok = normalizeConfigInput({ optimizer: { eosControlHorizonMaxHours: 'auto' } });
  assert.equal(ok.rawConfig.optimizer.eosControlHorizonMaxHours, 'auto');
});

// ── E-Auto-Frist hinter den echten Preisen (Christin 05.11.2026) ────────────
// Steckt das Auto vor ~13 Uhr an, enden die echten Preise um Mitternacht; EOS
// verlangte das Ladeziel dann schon dort (genetic.py `_ev_deadline_slot`:
// Frist hinter dem Steuerzeitraum → Ziel am Ende des Steuerzeitraums) und lud
// teuer am Abend. Jetzt reicht der Steuerzeitraum in diesem Fall bis zur
// Abfahrt in die geschätzten Preise — gekennzeichnet (eosControl.estimatedFrom).
// Ohne Auto-Frist bleibt es dabei: Schätzwerte nie im Steuerzeitraum.

test('E-Auto-Frist hinter den echten Preisen: Steuerzeitraum bis zur Abfahrt, ab Ende der echten Preise geschätzt; Lauf darf rechnen', async () => {
  for (const mode of [undefined, 'auto']) {
    const mock = await createMockEos();
    try {
      const now = Date.now();
      const q0 = now - (now % Q);
      const dep = q0 + 16 * H + 20 * 60_000;
      const optimizer = { ...evOptimizer(dep), ...(mode ? { eosControlHorizonMaxHours: mode } : {}) };
      const e = env(mock, { realHours: 10, optimizer, state: evRegistered });
      assert.deepEqual(await createEosForecastBridge(e.ctx).prepareRun(), { ok: true, pushed: true }, `Modus ${mode || 'Standard'}`);
      assert.equal(horizonPut(mock), 17, 'bis zur Abfahrt (aufgerundet)');
      const c = e.state.optimizer.eosControl;
      assert.equal(c.reason, 'ev_deadline');
      assert.equal(c.realHours, realHoursOf(e));
      assert.equal(c.estimatedFrom, new Date(e.realEnd).toISOString());
      assert.equal(c.deadline.kind, 'ev');
      assert.equal(c.deadline.at, new Date(dep).toISOString());
      assert.equal(c.deadlineCovered, true);
      assert.ok(e.logs.some((l) => l.event === 'eos_control_horizon' && l.data.reason === 'ev_deadline' && l.data.estimatedFrom === c.estimatedFrom));
    } finally { await mock.close(); }
  }
});

test('E-Auto-Frist: ohne angemeldetes Auto, mit Abfahrt in den echten Preisen oder ohne Schätzung bleibt der Steuerzeitraum bei den echten Preisen', async () => {
  const now = Date.now();
  const q0 = now - (now % Q);
  const cases = [
    { name: 'nicht angemeldet', realHours: 10, dep: q0 + 16 * H, state: { eosEv: { register: false } } },
    { name: 'Abfahrt in den echten Preisen', realHours: 30, dep: q0 + 16 * H, state: evRegistered },
    { name: 'keine Schätzung (keine Historie)', realHours: 10, dep: q0 + 16 * H, state: evRegistered, noHistory: true },
  ];
  for (const c of cases) {
    const mock = await createMockEos();
    try {
      const e = env(mock, { realHours: c.realHours, optimizer: evOptimizer(c.dep), state: c.state });
      if (c.noHistory) e.ctx.telemetryStore = { querySeries: async () => [] };
      assert.deepEqual(await createEosForecastBridge(e.ctx).prepareRun(), { ok: true, pushed: true }, c.name);
      assert.equal(horizonPut(mock), realHoursOf(e), c.name);
      assert.equal(e.state.optimizer.eosControl.estimatedFrom, null, c.name);
      assert.notEqual(e.state.optimizer.eosControl.reason, 'ev_deadline', c.name);
    } finally { await mock.close(); }
  }
});

test('E-Auto-Frist: feste Grenze bleibt fest; reicht der Prognosehorizont nicht bis zur Abfahrt, so weit er reicht', async () => {
  const now = Date.now();
  const q0 = now - (now % Q);
  const dep = q0 + 16 * H + 20 * 60_000;
  let mock = await createMockEos();
  try {
    const e = env(mock, { realHours: 10, optimizer: { ...evOptimizer(dep), eosControlHorizonMaxHours: 6 }, state: evRegistered });
    await createEosForecastBridge(e.ctx).push();
    assert.equal(horizonPut(mock), 6);
    assert.equal(e.state.optimizer.eosControl.estimatedFrom, null);
  } finally { await mock.close(); }
  mock = await createMockEos();
  try {
    // Prognosehorizont 24 h → Steuerzeitraum höchstens 12 h (12 h Schwanz bleiben).
    const e = env(mock, { realHours: 10, optimizer: { ...evOptimizer(dep), eosPredictionHours: 24 }, state: evRegistered });
    assert.deepEqual(await createEosForecastBridge(e.ctx).prepareRun(), { ok: true, pushed: true });
    assert.equal(horizonPut(mock), 12);
    assert.equal(e.state.optimizer.eosControl.reason, 'ev_deadline');
    assert.equal(e.state.optimizer.eosControl.deadlineCovered, false);
  } finally { await mock.close(); }
});

test('E-Auto-Frist: Preis-Import gescheitert → kein Lauf (wie ohne Frist)', async () => {
  const mock = await createMockEos();
  try {
    const now = Date.now();
    const q0 = now - (now % Q);
    const e = env(mock, { realHours: 10, optimizer: evOptimizer(q0 + 16 * H), state: evRegistered });
    // ElecPriceImport scheitert: Mock ersetzt die Antwort.
    const bridge = createEosForecastBridge({ ...e.ctx, getCfg: () => ({ ...e.cfg, optimizer: { ...e.cfg.optimizer, eosProxy: { enabled: true, url: `http://127.0.0.1:1` } } }) });
    const res = await bridge.prepareRun();
    assert.equal(res.ok, false);
  } finally { await mock.close(); }
});

// Der Plan eines Laufs merkt sich, mit welchem Steuerzeitraum er gerechnet
// wurde — Leitstand (Kennzeichnung) und Regel-Umsetzung (keine Akku-Regeln
// aus geschätzten Slots) lesen das.
test('Lauf-Auslöser: Steuerzeitraum des Laufs (nach der Vorbereitung gelesen) wird mit dem Plan abgelegt', async () => {
  const { createEosRunTrigger } = await import('../services/optimizer/eos-run-trigger.js');
  let nowMs = Date.parse('2026-11-05T10:00:02Z');
  const state = { optimizer: {} };
  let control = { hours: 9, estimatedFrom: null };
  let fail = false;
  const trigger = createEosRunTrigger({
    isActive: () => true,
    getIntervalSec: () => 900,
    getSlotSec: () => 900,
    getHorizonHours: () => control.hours,
    getControlInfo: () => control,
    prepareRun: async () => { control = { hours: 17, estimatedFrom: '2026-11-05T23:00:00.000Z', reason: 'ev_deadline' }; return { ok: true, pushed: true }; },
    collectSoc: async () => ({ soc: { battery1: 50 } }),
    postOptimize: async () => { nowMs += 90_000; return fail ? { ok: false, error: 'boom' } : { ok: true, data: { start_solution: [1], start_solution_datetime: new Date(nowMs).toISOString() } }; },
    state,
    now: () => nowMs,
    setTimer: () => ({}),
    clearTimer: () => {},
  });
  await trigger.trigger();
  const pc = state.optimizer.eosRun.lastPlanControl;
  assert.equal(pc.hours, 17);
  assert.equal(pc.estimatedFrom, '2026-11-05T23:00:00.000Z');
  assert.equal(pc.runStartedAt, Date.parse('2026-11-05T10:00:02Z'));
  assert.equal(pc.runDoneAt, nowMs);
  // Ein gescheiterter Lauf ändert den Plan nicht — die Angabe bleibt.
  fail = true;
  nowMs += 300_000;
  await trigger.trigger();
  assert.equal(state.optimizer.eosRun.lastPlanControl, pc);
});
