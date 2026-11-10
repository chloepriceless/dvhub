// test/battery-assist-sources.test.js — Akku zuerst für mehrere Quellen
// (Christin 10.11.2026): Nicht nur die Netzanschluss-Grenze, auch eine
// §14a-Dimmung (und später das EOS-Schwellen-Peak-Shaving) lässt zuerst den Akku
// die Last decken. Schnittstelle ctx.batteryAssist: request({source, maxImportW
// | coverW}) / release(source) / status(source); das strengste Ziel (niedrigster
// erlaubter Netzbezug) gewinnt; Rückmeldung der geleisteten Hilfe in W.
// Echte Bausteine: ausgelieferte Profile, echter Schedule-Evaluator, Wächter.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfigFile } from '../config-model.js';
import { createScheduleEvaluator } from '../schedule-eval.js';
import { createGridConnectionGuard, ASSIST_REQUEST_MAX_AGE_MS } from '../services/grid-connection/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r)); };

function loadProfileConfig(manufacturer, persisted = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-assist-src-'));
  fs.mkdirSync(path.join(rootDir, 'hersteller'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'hersteller', `${manufacturer}.json`), path.join(rootDir, 'hersteller', `${manufacturer}.json`));
  const configPath = path.join(rootDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ manufacturer, updateChannel: 'dev', victron: { host: '192.0.2.10' }, ...persisted }));
  const loaded = loadConfigFile(configPath);
  if (loaded.manufacturerProfileError) throw new Error(loaded.manufacturerProfileError);
  return loaded.effectiveConfig;
}

function rig(manufacturer = 'bridge-mqtt', persisted = {}) {
  const cfg = loadProfileConfig(manufacturer, { optimizer: { allowGridCharge: true }, ...persisted });
  let t = Date.now();
  const state = {
    victron: { soc: 60, batteryPowerW: 0, batteryChargeW: 0, batteryDischargeW: 0, maxDischargeW: 0, fieldUpdatedAt: { soc: t, batteryPowerW: t, maxDischargeW: t } },
    meter: { ok: true, updatedAt: t, grid_total_w: -10000 },
    schedule: { rules: [], active: {}, lastWrite: {}, manualOverride: {}, config: { defaultGridSetpointW: null, defaultChargeCurrentA: null, defaultFeedExcessDcPv: 1 }, lastEvalAt: 0 },
    ctrl: { negativePriceActive: false, forcedOff: false }
  };
  const transport = manufacturer === 'victron'
    ? { type: 'modbus', writes: [], async mbWriteSingle(w) { this.writes.push({ fc: 6, ...w }); }, async mbWriteMultiple(w) { this.writes.push({ fc: 16, ...w }); }, async mbRequest() { throw new Error('no read'); } }
    : { type: 'mqtt', writes: [], async mqttWrite(target, value) { this.writes.push({ target, value }); return {}; } };
  const ctx = { getCfg: () => cfg, state, pushLog: () => {} };
  const guard = createGridConnectionGuard(ctx, { now: () => t });
  const evaluator = createScheduleEvaluator({
    state, getCfg: () => cfg, transport, pushLog: () => {}, telemetrySafeWrite: () => {},
    persistConfig: async () => {}, telemetryStore: null, epexNowNext: () => null,
    regenerateSmallMarketAutomationRules: async () => {}, onEvalComplete: () => {}, gridConnection: guard
  });
  ctx.applyControlTarget = evaluator.applyControlTarget;
  const measure = ({ importW, dischargeW = 0, maxDischargeW }) => {
    t += 2000;
    state.meter.grid_total_w = -importW;
    state.meter.updatedAt = t - 500;
    state.victron.batteryPowerW = -dischargeW;
    state.victron.batteryDischargeW = dischargeW;
    state.victron.fieldUpdatedAt.batteryPowerW = t - 500;
    state.victron.fieldUpdatedAt.soc = t - 500;
    if (maxDischargeW !== undefined) { state.victron.maxDischargeW = maxDischargeW; state.victron.fieldUpdatedAt.maxDischargeW = t - 500; }
  };
  const writes = (target = 'maxDischargeW') => transport.writes.filter((w) => w.target === target).map((w) => w.value);
  return { cfg, state, transport, guard, assist: guard.batteryAssist, evaluator, measure, writes, advance: (ms) => { t += ms; } };
}

test('§14a ohne Netzanschluss-Grenze: der Akku deckt, was über der Vorgabe liegt', async () => {
  const h = rig();
  const r = h.assist.request({ source: 'p14a', maxImportW: 4200 });
  assert.equal(r.ok, true);
  h.measure({ importW: 10000, maxDischargeW: 0 });
  h.guard.tick();
  await settle();
  assert.deepEqual(h.writes(), [6000], '10 000 − 4 200 = 5 800 W + 200 W Regelabstand');
  // Akku folgt: Rückmeldung der geleisteten Hilfe.
  h.measure({ importW: 4000, dischargeW: 6000, maxDischargeW: 6000 });
  h.guard.tick();
  const s = h.assist.status('p14a');
  assert.equal(s.active, true);
  assert.equal(s.targetW, 4200);
  assert.equal(s.helpW, 6000);
  assert.equal(s.kind, 'native');
});

test('mehrere Quellen: das strengste Ziel gewinnt; Freigabe nimmt die Hilfe zurück', async () => {
  const h = rig('bridge-mqtt', { gridConnection: { limitKw: 20, marginW: 1000 } });
  h.assist.request({ source: 'eos-threshold', maxImportW: 8000 });
  h.assist.request({ source: 'p14a', maxImportW: 4200 });
  assert.equal(h.assist.status().targetW, 4200);
  h.measure({ importW: 10000, maxDischargeW: 0 });
  h.guard.tick();
  await settle();
  assert.deepEqual(h.writes(), [6000]);
  h.assist.release('p14a');
  assert.equal(h.assist.status().targetW, 8000, 'jetzt gilt EOS (8 kW)');
  // Akku hilft mit 6 kW, Bezug 4 kW: für 8 kW reicht weniger → Rampe nach unten.
  for (let k = 0; k < 25; k += 1) {
    h.measure({ importW: 4000, dischargeW: 6000, maxDischargeW: 6000 });
    h.guard.tick();
    await settle();
  }
  const last = h.writes().at(-1);
  assert.ok(last < 6000 && last >= 2000, `gesenkt: ${h.writes()}`);
  h.assist.release('eos-threshold');
  for (let k = 0; k < 60; k += 1) {
    h.measure({ importW: 4000, dischargeW: last, maxDischargeW: last });
    h.guard.tick();
    await settle();
  }
  assert.equal(h.writes().at(-1), 0, 'ohne Anforderung (und unter der Netzanschluss-Grenze) zurück auf 0');
  assert.equal(h.assist.status().active, false);
});

test('Netzanschluss und §14a zusammen: die kleinere Grenze gilt', async () => {
  const h = rig('bridge-mqtt', { gridConnection: { limitKw: 20, marginW: 1000 } });
  h.assist.request({ source: 'p14a', maxImportW: 15000 });
  h.measure({ importW: 18000, maxDischargeW: 0 });
  h.guard.tick();
  await settle();
  assert.deepEqual(h.writes(), [3200], '18 000 − 15 000 + 200');
});

test('coverW: Akku übernimmt einen festen Anteil der Last', async () => {
  const h = rig();
  h.assist.request({ source: 'p14a', coverW: 2000 });
  h.measure({ importW: 10000, maxDischargeW: 0 });
  h.guard.tick();
  await settle();
  assert.deepEqual(h.writes(), [2200]);
});

test('Victron: Anforderung wirkt über die Decke des positiven Netz-Sollwerts', async () => {
  const h = rig('victron');
  h.assist.request({ source: 'p14a', maxImportW: 4200 });
  assert.equal(h.guard.batteryCeilingW(), 4200);
  await h.evaluator.applyControlTarget('gridSetpointW', 10000, 'eos_grid_hold');
  const sp = h.transport.writes.filter((w) => w.address === 2716).map((w) => { const b = Buffer.alloc(4); b.writeUInt16BE(w.values[0], 0); b.writeUInt16BE(w.values[1], 2); return b.readInt32BE(0); });
  assert.deepEqual(sp, [4200]);
  assert.equal(h.assist.status('p14a').kind, 'victron');
  h.assist.release('p14a');
  assert.equal(h.guard.batteryCeilingW(), null, 'ohne Grenze und Anforderung keine Decke');
});

test('Not-Halt: keine Akku-Hilfe, Anforderungen werden abgelehnt', async () => {
  const h = rig();
  h.state.ctrl.discretionaryWritesPaused = true;
  const r = h.assist.request({ source: 'p14a', maxImportW: 4200 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'emergency_stop');
  h.measure({ importW: 10000, maxDischargeW: 0 });
  h.guard.tick();
  await settle();
  assert.deepEqual(h.writes(), []);
  assert.equal(h.assist.status('p14a').active, false);
});

test('Profil ohne steuerbaren Akku: Anforderung abgelehnt (die Quelle drosselt selbst)', () => {
  const h = rig('deye-lv');
  const r = h.assist.request({ source: 'p14a', maxImportW: 4200 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'battery_not_steerable');
  assert.equal(h.assist.status('p14a').kind, 'none');
});

test('Anforderung verfällt ohne Erneuerung; ungültige Anfragen werden abgelehnt', async () => {
  const h = rig();
  assert.equal(h.assist.request({ source: '', maxImportW: 4200 }).ok, false);
  assert.equal(h.assist.request({ source: 'p14a' }).ok, false);
  assert.equal(h.assist.request({ source: 'p14a', maxImportW: -5 }).ok, false);
  assert.equal(h.assist.request({ source: 'grid-connection', maxImportW: 4000 }).ok, false, 'grid-connection ist intern');
  h.assist.request({ source: 'p14a', maxImportW: 4200 });
  h.advance(ASSIST_REQUEST_MAX_AGE_MS + 1000);
  assert.equal(h.assist.status().targetW, null, 'abgelaufen');
});

// --- Codex-Gegenprüfung 7a44bb81 ------------------------------------------------

const sp2716 = (h) => h.transport.writes.filter((w) => w.address === 2716).map((w) => { const b = Buffer.alloc(4); b.writeUInt16BE(w.values[0], 0); b.writeUInt16BE(w.values[1], 2); return b.readInt32BE(0); });

test('Codex 7a44bb81 P2: helpW meldet gemessene Hilfe, nicht den gescheiterten Befehl', async () => {
  const h = rig('victron');
  h.assist.request({ source: 'p14a', maxImportW: 4200 });
  h.measure({ importW: 10000 });
  h.guard.tick();
  h.transport.mbWriteMultiple = async () => { throw new Error('GX weg'); };
  const r = await h.evaluator.applyControlTarget('gridSetpointW', 10000, 'eos_grid_hold');
  assert.equal(r.ok, false);
  h.measure({ importW: 10000 });
  h.guard.tick();
  assert.equal(h.assist.status('p14a').helpW, 0);
});

test('Codex 7a44bb81 P2/P2: Victron coverW — Zähler wird gelesen, Ziel bleibt stabil', async () => {
  const h = rig('victron');
  h.assist.request({ source: 'p14a', coverW: 2000 });
  h.measure({ importW: 10000 });
  h.guard.tick();
  assert.equal(h.guard.batteryCeilingW(), 8000, 'Decke aus coverW');
  await h.evaluator.applyControlTarget('gridSetpointW', 10000, 'eos_grid_hold');
  assert.deepEqual(sp2716(h), [8000]);
  for (let k = 0; k < 5; k += 1) {
    h.measure({ importW: 8000, dischargeW: 2000 }); // der Multi deckt 2 kW
    h.guard.tick();
  }
  assert.equal(h.guard.batteryCeilingW(), 8000, 'nicht schrittweise tiefer');
  assert.equal(h.assist.status('p14a').helpW, 2000);
});

test('Codex 7a44bb81 P2: erste Decke schickt den laufenden Sollwert sofort neu', async () => {
  const h = rig('victron');
  await h.evaluator.applyControlTarget('gridSetpointW', 10000, 'eos_grid_hold');
  assert.deepEqual(sp2716(h), [10000]);
  h.assist.request({ source: 'p14a', maxImportW: 4200 });
  await settle();
  assert.deepEqual(sp2716(h), [10000, 4200]);
});

test('Codex 7a44bb81 P2: coverW-Hilfe bleibt bei Zählerfehler stehen', async () => {
  const h = rig();
  h.assist.request({ source: 'p14a', coverW: 2000 });
  h.measure({ importW: 10000, maxDischargeW: 0 });
  h.guard.tick();
  await settle();
  assert.deepEqual(h.writes(), [2200]);
  for (let k = 0; k < 5; k += 1) {
    h.measure({ importW: 8000, dischargeW: 2000, maxDischargeW: 2200 });
    h.state.meter.ok = false;
    h.guard.tick();
    await settle();
  }
  assert.deepEqual(h.writes(), [2200], 'kein Rückschreiben ohne Messung');
});

// --- Codex deefd37f: keine Phantom-Hilfe ------------------------------------------

test('Codex deefd37f P2: Bezug schon unter dem angefragten Sollwert (Akku voll) — keine gutgeschriebene Hilfe', async () => {
  const h = rig('victron');
  h.assist.request({ source: 'p14a', coverW: 2000 });
  h.measure({ importW: 10000 });
  h.guard.tick();
  assert.equal(h.guard.batteryCeilingW(), 8000);
  await h.evaluator.applyControlTarget('gridSetpointW', 20000, 'rule:eos-grid-charge');
  assert.deepEqual(sp2716(h), [8000]);
  for (let k = 0; k < 4; k += 1) {
    h.measure({ importW: 10000 }); // Akku voll: nichts geändert
    h.guard.tick();
  }
  assert.equal(h.assist.status('p14a').helpW, 0, 'der Akku gibt nichts ab');
  assert.equal(h.guard.batteryCeilingW(), 8000, 'Decke steigt nicht');
});

// --- Vertrag mit services/paragraph14a (feat/p14a-bedarf, 0fc9c779 ff.) ---------
// Genau deren Aufrufform: request({ source: 'p14a', coverW, untilMs }) je Takt,
// Antwort { ok, acceptedW }, coverW 0 = Freigabe (auch im Not-Halt; bei ok:false
// wiederholt §14a). coverW ist die GESAMTE Abgabe des Akkus (laufende Entladung
// eingerechnet), untilMs der Ablauf der Vorgabe (null = keiner bekannt).

test('Vertrag §14a: Anforderung, Rückmeldung, Freigabe mit coverW 0', async () => {
  const h = rig();
  const res = h.assist.request({ source: 'p14a', coverW: 4200, untilMs: null });
  assert.equal(res.ok, true);
  assert.equal(res.acceptedW, 4200);
  h.measure({ importW: 10000, maxDischargeW: 0 });
  h.guard.tick();
  await settle();
  assert.deepEqual(h.writes(), [4400], 'Akku gibt insgesamt 4,2 kW ab (+ Regelabstand)');
  // Akku liefert; §14a fragt im nächsten Takt dieselbe Gesamt-Abgabe an — stabil.
  for (let k = 0; k < 5; k += 1) {
    h.measure({ importW: 5800, dischargeW: 4200, maxDischargeW: 4400 });
    h.assist.request({ source: 'p14a', coverW: 4200, untilMs: null });
    h.guard.tick();
    await settle();
  }
  assert.deepEqual(h.writes(), [4400]);
  assert.equal(h.assist.status('p14a').helpW, 4200);
  const rel = h.assist.request({ source: 'p14a', coverW: 0, untilMs: null });
  assert.deepEqual(rel, { ok: true, acceptedW: 0 });
  assert.equal(h.assist.status('p14a').active, false);
  assert.deepEqual(h.assist.status().sources, []);
});

test('Vertrag §14a: Leistung über der Akku-Grenze wird nur teilweise zugesagt', () => {
  const h = rig('bridge-mqtt', { optimizer: { allowGridCharge: true, inverterMaxPowerW: 5000 } });
  const res = h.assist.request({ source: 'p14a', coverW: 8000, untilMs: null });
  assert.equal(res.ok, true);
  assert.equal(res.acceptedW, 5000);
});

test('Vertrag §14a: untilMs ersetzt die feste Frist', () => {
  const h = rig();
  h.assist.request({ source: 'p14a', coverW: 4200, untilMs: Date.now() + 10 * 60_000 });
  h.advance(ASSIST_REQUEST_MAX_AGE_MS + 60_000);
  assert.equal(h.assist.status('p14a').active, true, 'gilt bis untilMs, nicht nur 2 min');
  h.advance(10 * 60_000);
  assert.equal(h.assist.status('p14a').active, false, 'nach untilMs verfallen');
  // Abgelaufen schon beim Aufruf: abgelehnt.
  const old = h.assist.request({ source: 'p14a', coverW: 4200, untilMs: 1 });
  assert.equal(old.ok, false);
  assert.equal(old.reason, 'expired');
});

test('Vertrag §14a: Not-Halt und nicht steuerbarer Akku — Anforderung nein, Freigabe ja', () => {
  const h = rig();
  h.state.ctrl.discretionaryWritesPaused = true;
  assert.equal(h.assist.request({ source: 'p14a', coverW: 4200, untilMs: null }).ok, false);
  assert.deepEqual(h.assist.request({ source: 'p14a', coverW: 0, untilMs: null }), { ok: true, acceptedW: 0 });
  const d = rig('deye-lv');
  const r = d.assist.request({ source: 'p14a', coverW: 4200, untilMs: null });
  assert.equal(r.ok, false);
  assert.equal(r.acceptedW, 0);
  assert.deepEqual(d.assist.request({ source: 'p14a', coverW: 0, untilMs: null }), { ok: true, acceptedW: 0 });
});

test('Vertrag §14a: die bisherige Form (maxImportW, release) gilt weiter', () => {
  const h = rig();
  assert.equal(h.assist.request({ source: 'eos-threshold', maxImportW: 8000 }).ok, true);
  assert.equal(h.assist.status().targetW, 8000);
  assert.equal(h.assist.release('eos-threshold').ok, true);
  assert.equal(h.assist.status().targetW, null);
});

test('Leitstand: Kachel erscheint auch ohne Netzanschluss-Grenze, wenn §14a Akku-Hilfe anfordert', async () => {
  const h = rig();
  assert.equal(h.guard.summary(), null, 'ohne Grenze und Anforderung keine Kachel');
  h.assist.request({ source: 'p14a', coverW: 4200, untilMs: null });
  h.measure({ importW: 10000, maxDischargeW: 0 });
  h.guard.tick();
  await settle();
  const s = h.guard.summary();
  assert.ok(s, 'Kachel da');
  assert.equal(s.assistOnly, true);
  assert.deepEqual(s.assistSources, ['p14a']);
  assert.equal(s.assist.valueW, 4400);
  assert.match(s.text, /§14a/);
});
