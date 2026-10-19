// Feste Einspeisegrenze (Christin 2026-10-20): 60 % (Solarspitzengesetz ohne
// Smart Meter), 70 % (alte Anlagen), eigener Wert — oder keine. Ab Werk ist
// NICHTS gesetzt: der Betreiber muss sagen, welche Grenze für ihn gilt (oder
// „keine“); bis dahin weist DVhub darauf hin.
//   1. Einstellung → feste Quelle im Begrenzer (kleinste Grenze gilt)
//   2. Victron: Register 2706 (MaxFeedInPower) — im GX gespeichert, gilt auch
//      ohne DVhub; der GX regelt selbst am Netzzähler
//   3. Geräte nur mit Erzeugungsgrenze (SunSpec WMaxLimPct, Fronius):
//      Regelschleife in DVhub
//   4. Überwachung: gemessene Einspeisung gegen die Grenze
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveFeedInCap, installedKwp, enforcementPath, capLoopStep, createExceedMonitor, createFeedInCap,
  FEED_IN_CAP_MODES,
} from '../services/feed-in-cap/index.js';
import { createFeedInLimitArbiter } from '../services/feed-in-limit-arbiter.js';
import { getConfigDefinition, createDefaultConfig } from '../config-model.js';

const plants = (kwp) => ({ userEnergyPricing: { pvPlants: [{ kwp }] } });

test('Ab Werk keine Grenze gesetzt: Modus leer = „nicht angegeben“', () => {
  const d = createDefaultConfig();
  assert.equal(d.feedInCap.mode, '');
  const r = resolveFeedInCap(d);
  assert.equal(r.configured, false);
  assert.equal(r.limitW, null);
});

test('Einstellung: Auswahl ohne Vorgabe, eigener Wert nur bei „eigener“', () => {
  const fields = getConfigDefinition().fields;
  const mode = fields.find((f) => f.path === 'feedInCap.mode');
  assert.ok(mode, 'Feld feedInCap.mode');
  assert.deepEqual(mode.options.map((o) => o.value), FEED_IN_CAP_MODES);
  assert.match(mode.options[0].label, /bitte w/i);
  assert.ok(fields.find((f) => f.path === 'feedInCap.percent').visibleWhenPath);
  assert.ok(fields.find((f) => f.path === 'feedInCap.watts').visibleWhenPath);
});

test('Grenze berechnen: 60 / 70 % der installierten Leistung, eigener Wert, keine', () => {
  assert.equal(installedKwp(plants(10)), 10);
  assert.equal(installedKwp({ forecast: { pv: { totalKwp: 8.5 } } }), 8.5);
  assert.equal(resolveFeedInCap({ ...plants(10), feedInCap: { mode: 'pct60' } }).limitW, 6000);
  assert.equal(resolveFeedInCap({ ...plants(10), feedInCap: { mode: 'pct70' } }).limitW, 7000);
  assert.equal(resolveFeedInCap({ ...plants(29.7), feedInCap: { mode: 'pct', percent: 50 } }).limitW, 14850);
  assert.equal(resolveFeedInCap({ feedInCap: { mode: 'watts', watts: 4600 } }).limitW, 4600);
  const none = resolveFeedInCap({ ...plants(10), feedInCap: { mode: 'none' } });
  assert.equal(none.configured, true);
  assert.equal(none.limitW, null);
});

test('Prozent ohne Anlagengröße oder ungültiger Wert: keine Grenze, Fehler gemeldet', () => {
  assert.equal(resolveFeedInCap({ feedInCap: { mode: 'pct60' } }).error, 'kwp_missing');
  assert.equal(resolveFeedInCap({ ...plants(10), feedInCap: { mode: 'pct', percent: 0 } }).error, 'percent_invalid');
  assert.equal(resolveFeedInCap({ ...plants(10), feedInCap: { mode: 'pct', percent: 120 } }).error, 'percent_invalid');
  assert.equal(resolveFeedInCap({ feedInCap: { mode: 'watts', watts: -5 } }).error, 'watts_invalid');
  assert.equal(resolveFeedInCap({ feedInCap: { mode: 'watts', watts: 0 } }).limitW, 0, '0 W = Nulleinspeisung ist erlaubt');
});

test('Weg zur Grenze: Victron-Begrenzer, sonst Regelschleife, sonst nicht möglich', () => {
  const victron = { controlWrite: { dvFeedInLimitW: { enabled: true, address: 2706 } } };
  const fronius = { controlWrite: { wMaxLimPct: { enabled: true, address: 40232 }, wMaxLimEna: { enabled: true, address: 40236 } } };
  assert.equal(enforcementPath(victron, 'modbus'), 'native');
  assert.equal(enforcementPath(fronius, 'modbus'), 'loop');
  assert.equal(enforcementPath(fronius, 'mqtt'), 'unsupported');
  assert.equal(enforcementPath({ controlWrite: {} }, 'modbus'), 'unsupported');
});

// ── 3. Regelschleife (5-s-Takt) ──
const REF = 10000;
test('Schleife: über der Grenze sofort drosseln, nie auf 0', () => {
  const st = {};
  const a = capLoopStep(st, { exportW: 7500, limitW: 6000, refW: REF, pvW: 9000, meterFresh: true });
  assert.equal(a.write, true);
  assert.equal(a.ena, 1);
  assert.equal(st.capActive, true);
  // Ziel = Grenze − Abstand (180 W): 9000 − (7500 − 5820) = 7320 W → 73,2 %
  assert.equal(Math.round(a.limitPct * 10) / 10, 73.2);
  const b = capLoopStep(st, { exportW: 20000, limitW: 0, refW: REF, pvW: 100, meterFresh: true });
  assert.ok(b.limitPct >= 1, 'nie 0 %: sonst steht der Wechselrichter und das Haus zieht Netzstrom');
});

test('Schleife: unter der Grenze nichts tun; aktiv nachregeln; langsam wieder hoch; dann aus', () => {
  const st = {};
  assert.equal(capLoopStep(st, { exportW: 3000, limitW: 6000, refW: REF, pvW: 5000, meterFresh: true }).write, false);
  capLoopStep(st, { exportW: 6500, limitW: 6000, refW: REF, pvW: 9000, meterFresh: true });
  const p1 = st.limitPct;
  capLoopStep(st, { exportW: 6200, limitW: 6000, refW: REF, pvW: 9000, meterFresh: true });
  assert.ok(st.limitPct < p1, 'noch drüber → weiter runter');
  const p2 = st.limitPct;
  capLoopStep(st, { exportW: 4000, limitW: 6000, refW: REF, pvW: 9000, meterFresh: true });
  assert.ok(st.limitPct > p2, 'deutlich drunter → hoch');
  assert.ok(st.limitPct - p2 < (100 * (5820 - 4000)) / REF, 'hoch langsamer als runter');
  const actions = [];
  for (let i = 0; i < 40; i++) actions.push(capLoopStep(st, { exportW: 1000, limitW: 6000, refW: REF, pvW: 2000, meterFresh: true }));
  assert.equal(st.capActive, false);
  assert.equal(actions.filter((a) => a.ena === 0).length, 1, 'genau einmal Drosselung aus');
  assert.equal(actions.at(-1).write, false);
});

test('Schleife: Zähler veraltet → Wert halten und weiter schreiben (Rückfallfenster)', () => {
  const st = {};
  capLoopStep(st, { exportW: 7000, limitW: 6000, refW: REF, pvW: 8000, meterFresh: true });
  const held = st.limitPct;
  const a = capLoopStep(st, { exportW: 0, limitW: 6000, refW: REF, pvW: 0, meterFresh: false });
  assert.equal(a.write, true);
  assert.equal(a.limitPct, held);
});

// ── 4. Überwachung ──
test('Überwachung: erst nach 60 s über Grenze + Toleranz eine Meldung, Ende nach 30 s darunter', () => {
  let t = 0;
  const m = createExceedMonitor({ now: () => t });
  const obs = (w) => m.observe({ exportW: w, limitW: 6000 });
  assert.equal(obs(6100).event, undefined, 'innerhalb der Toleranz (120 W)');
  for (t = 0; t < 55_000; t += 5000) assert.equal(obs(6500).event, undefined);
  t = 60_000;
  assert.equal(obs(6800).event, 'exceeded');
  t = 65_000;
  assert.equal(obs(6800).event, undefined, 'nur einmal je Überschreitung');
  t = 70_000; obs(5000);
  t = 100_000;
  assert.equal(obs(5000).event, 'recovered');
  const s = m.status();
  assert.equal(s.episodes, 1);
  assert.equal(s.lastEpisode.maxW, 6800);
});

// ── Dienst ──
function svcSetup(cfg) {
  const writes = [];
  const arbiter = createFeedInLimitArbiter({ applyLimit: async (w) => { writes.push(w); } });
  const warnings = new Map();
  const state = { victron: { gridExportW: 0 }, meter: { ok: true, updatedAt: Date.now() }, ctrl: {} };
  const svc = createFeedInCap({ getCfg: () => cfg.current, state, feedInLimit: arbiter, pushLog: () => {} }, {
    getTransport: () => ({ type: 'modbus' }),
    setWarning: (id, msg) => { if (msg == null) warnings.delete(id); else warnings.set(id, msg); },
  });
  return { svc, writes, warnings, arbiter, state };
}

test('Dienst: nicht angegeben → Hinweis, kein Schreiben; „keine“ → Hinweis weg, kein Schreiben', async () => {
  const cfg = { current: { manufacturer: 'victron', ...plants(10), controlWrite: { dvFeedInLimitW: { enabled: true } }, feedInCap: { mode: '' } } };
  const { svc, writes, warnings } = svcSetup(cfg);
  await svc.tick();
  assert.ok(warnings.has('feed_in_cap_unset'));
  assert.deepEqual(writes, []);
  cfg.current = { ...cfg.current, feedInCap: { mode: 'none' } };
  await svc.tick();
  assert.equal(warnings.has('feed_in_cap_unset'), false);
  assert.deepEqual(writes, []);
});

test('Dienst Victron: 60 % → 6000 W in den Begrenzer; Direktvermarkter darf nur tiefer; „keine“ → zurück', async () => {
  const cfg = { current: { manufacturer: 'victron', ...plants(10), controlWrite: { dvFeedInLimitW: { enabled: true } }, feedInCap: { mode: 'pct60' } } };
  const { svc, writes, arbiter } = svcSetup(cfg);
  await svc.tick();
  assert.deepEqual(writes, [6000]);
  await arbiter.set('dv', 1000);
  await arbiter.set('dv', null);
  assert.deepEqual(writes, [6000, 1000, 6000], 'nach der DV-Vorgabe gilt wieder die feste Grenze, nicht „unbegrenzt“');
  await svc.tick();
  assert.equal(writes.length, 3, 'unverändert → nicht neu schreiben');
  cfg.current = { ...cfg.current, feedInCap: { mode: 'none' } };
  await svc.tick();
  assert.deepEqual(writes, [6000, 1000, 6000, null], 'null = Wert von vor DVhub zurückschreiben');
  assert.equal(svc.status().path, 'native');
});

test('Dienst: Einspeisung zu hoch → Warnung, wieder darunter → Warnung weg', async () => {
  let t = 0;
  const cfg = { current: { manufacturer: 'victron', ...plants(10), controlWrite: { dvFeedInLimitW: { enabled: true } }, feedInCap: { mode: 'pct60' } } };
  const writes = [];
  const warnings = new Map();
  const state = { victron: { gridExportW: 7000 }, meter: { ok: true, updatedAt: 0 }, ctrl: {} };
  const arbiter = createFeedInLimitArbiter({ applyLimit: async (w) => { writes.push(w); } });
  const svc = createFeedInCap({ getCfg: () => cfg.current, state, feedInLimit: arbiter, pushLog: () => {} }, {
    getTransport: () => ({ type: 'modbus' }), now: () => t,
    setWarning: (id, msg) => { if (msg == null) warnings.delete(id); else warnings.set(id, msg); },
  });
  for (t = 0; t <= 60_000; t += 5000) { state.meter.updatedAt = t; await svc.tick(); }
  assert.match(warnings.get('feed_in_cap_exceeded') || '', /7000 W.*6000 W/);
  state.victron.gridExportW = 2000;
  for (; t <= 100_000; t += 5000) { state.meter.updatedAt = t; await svc.tick(); }
  assert.equal(warnings.has('feed_in_cap_exceeded'), false);
});

test('Dienst: Prozent ohne kWp oder Gerät ohne Begrenzer → klarer Hinweis', async () => {
  const cfg = { current: { manufacturer: 'victron', controlWrite: { dvFeedInLimitW: { enabled: true } }, feedInCap: { mode: 'pct60' } } };
  const { svc, warnings, writes } = svcSetup(cfg);
  await svc.tick();
  assert.match(warnings.get('feed_in_cap_config'), /kWp/);
  assert.deepEqual(writes, []);
  cfg.current = { manufacturer: 'deye-lv', ...plants(10), controlWrite: {}, feedInCap: { mode: 'pct60' } };
  await svc.tick();
  assert.match(warnings.get('feed_in_cap_config'), /Wechselrichter/);
});

// ── Befunde aus der Codex-Gegenprüfung 2026-10-20 ──
test('Victron über MQTT: Begrenzer-Register nur per Modbus schreibbar → nicht möglich, nicht „native“', () => {
  const victron = { controlWrite: { dvFeedInLimitW: { enabled: true, address: 2706 } } };
  assert.equal(enforcementPath(victron, 'mqtt'), 'unsupported');
});

test('Schleife bei 0 W (Nulleinspeisung): steigt der Hausverbrauch (Netzbezug), geht die Drosselung wieder hoch', () => {
  const st = {};
  capLoopStep(st, { exportW: 3000, importW: 0, limitW: 0, refW: REF, pvW: 4000, meterFresh: true });
  for (let i = 0; i < 5; i++) capLoopStep(st, { exportW: 2000, importW: 0, limitW: 0, refW: REF, pvW: 3000, meterFresh: true });
  const low = st.limitPct;
  capLoopStep(st, { exportW: 0, importW: 1500, limitW: 0, refW: REF, pvW: 500, meterFresh: true });
  assert.ok(st.limitPct > low, 'Bezug → mehr Erzeugung erlauben');
});

test('Leeres Feld „Einspeisegrenze (W)“ bleibt leer (= ungültig), nicht 0 W', () => {
  const fields = getConfigDefinition().fields;
  assert.equal(fields.find((f) => f.path === 'feedInCap.watts').empty, 'null');
  assert.equal(fields.find((f) => f.path === 'feedInCap.percent').empty, 'null');
  assert.equal(resolveFeedInCap({ feedInCap: { mode: 'watts', watts: null } }).error, 'watts_invalid');
});

test('Überwachung: Grenze aufgehoben während einer Überschreitung → Meldung endet, Warnung weg', async () => {
  let t = 0;
  const cfg = { current: { manufacturer: 'victron', ...plants(10), controlWrite: { dvFeedInLimitW: { enabled: true } }, feedInCap: { mode: 'pct60' } } };
  const warnings = new Map();
  const state = { victron: { gridExportW: 7000 }, meter: { ok: true, updatedAt: 0 }, ctrl: {} };
  const arbiter = createFeedInLimitArbiter({ applyLimit: async () => {} });
  const svc = createFeedInCap({ getCfg: () => cfg.current, state, feedInLimit: arbiter, pushLog: () => {} }, {
    getTransport: () => ({ type: 'modbus' }), now: () => t,
    setWarning: (id, msg) => { if (msg == null) warnings.delete(id); else warnings.set(id, msg); },
  });
  for (t = 0; t <= 60_000; t += 5000) { state.meter.updatedAt = t; await svc.tick(); }
  assert.ok(warnings.has('feed_in_cap_exceeded'));
  cfg.current = { ...cfg.current, feedInCap: { mode: 'none' } };
  t += 5000; state.meter.updatedAt = t; await svc.tick();
  assert.equal(warnings.has('feed_in_cap_exceeded'), false);
  assert.equal(svc.status().monitor.exceeding, false);
});
