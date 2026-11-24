// test/eos-horizon-hint.test.js — Hinweis „mit der Preisprognose bis zu ~5 Tage
// vorausplanen“ (DVhub 1.0.11, Christin 12.11.2026): Standards bleiben, der
// Hinweis nennt die Laufzeit auf genau diesem Gerät (gemessene Läufe, linear
// mit dem Steuerzeitraum hochgerechnet). Nur bei Prognose an und DE-LU.
// Nichts wird umgestellt.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { eosHorizonHint, HORIZON_HINT_MAX_H } from '../services/optimizer/eos-horizon-hint.js';
import { createEosRunTrigger } from '../services/optimizer/eos-run-trigger.js';
import { buildRuntimeSnapshot, applyRuntimeEosRun } from '../runtime-state.js';
import { outlookContiguousEndMs } from '../services/optimizer/price-outlook.js';

const H = 3_600_000;
const NOW = Date.parse('2026-11-12T14:00:00Z');
const EOS_ON = { eosProxy: { enabled: true } };
const DE = { epex: { bzn: 'DE-LU', priceSource: 'dvhub' }, optimizer: EOS_ON };
// A7S-ähnlich: 8,5 s bei 34 h Steuerzeitraum → 0,25 s je Stunde.
const RUN = { recentRuns: 8, avgDurationS: 8.5, secPerControlHour: 0.25, avgControlHours: 34 };
const base = { cfg: DE, run: RUN, outlookEndMs: NOW + 130 * H, pvUntilMs: NOW + 150 * H, nowMs: NOW };

test('Hinweis mit Messung: bis 5 Tage (120 h), Laufzeit linear aus den gemessenen Läufen', () => {
  const h = eosHorizonHint(base);
  assert.ok(h);
  assert.equal(h.targetHours, HORIZON_HINT_MAX_H);
  assert.equal(h.estimateS, 30);
  assert.equal(h.currentS, 8.5);
  assert.equal(h.slow, false);
  assert.match(h.text, /bis zu 5 Tage \(120 h\) vorausplanen/);
  assert.match(h.text, /„Bis in die Preisprognose“/);
  assert.match(h.text, /geschätzt 30 s statt 8,5 s/);
  assert.match(h.text, /über 8 Läufe bei im Mittel 34 h Steuerzeitraum/);
  assert.match(h.text, /stellt nichts von selbst um/);
});

test('PV-Prognose kürzer als die Preisprognose: Ziel ist das Ende der PV-Prognose', () => {
  const h = eosHorizonHint({ ...base, pvUntilMs: NOW + 70 * H });
  assert.equal(h.targetHours, 70);
  assert.equal(h.limitedByPv, true);
  assert.equal(h.estimateS, 17.5);
  assert.match(h.text, /bis zu 3 Tage \(70 h\) vorausplanen — so weit reicht hier die PV-Prognose/);
});

// Codex b1afb66c (P2): Ein fest eingestellter Prognosehorizont begrenzt auch
// „bis in die Preisprognose“ (Prognosehorizont − 12 h Schwanz).
test('Fester Prognosehorizont begrenzt das Ziel: 72 h → 60 h, 48 h → kein Hinweis', () => {
  const at = (h) => eosHorizonHint({ ...base, cfg: { ...DE, optimizer: { ...EOS_ON, eosPredictionHours: h } } });
  const h72 = at(72);
  assert.equal(h72.targetHours, 60);
  assert.equal(h72.estimateS, 15);
  assert.match(h72.text, /mehr lässt der eingestellte Prognosehorizont nicht zu/);
  assert.equal(at(48), null, '36 h bringt gegenüber 34 h nichts');
  assert.equal(at(144).targetHours, 120);
  assert.equal(eosHorizonHint(base).targetHours, 120, 'automatisch: bis 120 h');
});

// Codex b1afb66c (P2): Reichweite lückenlos ab dem Ende der festen Preise.
test('outlookContiguousEndMs: endet an der ersten fehlenden Stunde, null ohne erste', () => {
  const t0 = Date.parse('2026-11-12T23:00:00Z');
  const hours = [0, 1, 2, 4, 5].map((i) => ({ ms: t0 + i * H }));
  assert.equal(outlookContiguousEndMs({ hours }, t0), t0 + 3 * H);
  assert.equal(outlookContiguousEndMs({ hours }, t0 + 30 * 60_000), t0 + 3 * H, 'Viertelstunde in der Stunde');
  assert.equal(outlookContiguousEndMs({ hours }, t0 + 3 * H), null);
  assert.equal(outlookContiguousEndMs(null, t0), null);
});

// Codex b1afb66c (P2): Im getrennten Betrieb pusht der Runtime-Prozess; die
// PV-Grenze (und die Zeile unter dem EOS-Fahrplan) muss in den Web-Prozess.
test('Runtime-Schnappschuss trägt den Preisschwanz mit, auch ohne Läufe', () => {
  const tail = { used: true, status: 'live', lookahead: { until: 'u', pvUntil: '2026-11-15T00:00:00.000Z', limitedBy: 'pv' }, at: 5 };
  const snap = buildRuntimeSnapshot({ eosRun: null, eosPriceTail: tail });
  assert.equal(snap.eosPriceTail.lookahead.pvUntil, '2026-11-15T00:00:00.000Z');
  const state = { optimizer: {} };
  applyRuntimeEosRun(state, snap);
  assert.equal(state.optimizer.eosPriceTail.lookahead.limitedBy, 'pv');
  applyRuntimeEosRun(state, buildRuntimeSnapshot({ eosPriceTail: null }));
  assert.equal(state.optimizer.eosPriceTail, null, 'kein Schwanz mehr → auch im Web-Prozess');
  assert.ok(!('eosPriceTail' in buildRuntimeSnapshot({})), 'ohne Angabe bleibt der Stand');
});

test('Bringt nichts (PV-Prognose kaum länger als der Steuerzeitraum): kein Hinweis', () => {
  assert.equal(eosHorizonHint({ ...base, pvUntilMs: NOW + 40 * H }), null);
});

test('Langsames Gerät (Python-EOS): Schätzung über 10 min → Warnung, beim Standard bleiben', () => {
  const h = eosHorizonHint({ ...base, run: { recentRuns: 5, secPerControlHour: 6, avgControlHours: 34 } });
  assert.equal(h.estimateS, 720);
  assert.equal(h.slow, true);
  assert.match(h.text, /geschätzt 12 min statt 3 min/);
  assert.match(h.text, /zu lang — besser beim Standard bleiben/);
});

test('Noch nicht genug gemessen: Hinweis ohne Zahl, mit Verweis auf die Messung', () => {
  for (const run of [null, { recentRuns: 2, secPerControlHour: 0.25, avgControlHours: 34 }, { recentRuns: 8, avgDurationS: 9 }]) {
    const h = eosHorizonHint({ ...base, run, controlHours: 34 });
    assert.ok(h);
    assert.equal(h.estimateS, null);
    assert.match(h.text, /sobald einige Läufe gemessen sind/);
  }
});

test('Kein Hinweis: EOS aus, Prognose aus, andere Zone, Öffentlich (automatisch), EOS nach eigenem Takt, schon „bis in die Preisprognose“, keine Prognose', () => {
  const none = [
    // EOS gar nicht eingeschaltet (Verify 12.11.2026: der Hinweis stand sonst
    // auch auf Boxen ohne EOS in den Einstellungen).
    { cfg: { epex: { bzn: 'DE-LU', priceSource: 'dvhub' } } },
    { cfg: { epex: { bzn: 'DE-LU', priceSource: 'dvhub' }, optimizer: { eosProxy: { enabled: false } } } },
    { cfg: { epex: { bzn: 'DE-LU', priceOutlook: 'off' }, optimizer: EOS_ON } },
    { cfg: { epex: { bzn: 'AT' }, optimizer: EOS_ON } },
    { cfg: { epex: { bzn: 'DE-LU', priceSource: 'public' }, optimizer: EOS_ON } },
    { cfg: { epex: { bzn: 'DE-LU', priceSource: 'dvhub' }, optimizer: { ...EOS_ON, eosStartAfterPreviousRun: true } } },
    { controlMode: 'forecast' },
    { outlookEndMs: null },
    { outlookEndMs: NOW - H },
  ];
  for (const o of none) assert.equal(eosHorizonHint({ ...base, ...o }), null, JSON.stringify(o));
  // „Öffentlich“ mit eingeschalteter Prognose: Hinweis kommt.
  assert.ok(eosHorizonHint({ ...base, cfg: { epex: { bzn: 'DE-LU', priceSource: 'public', priceOutlook: 'on' }, optimizer: EOS_ON } }));
});

test('Lauf-Auslöser misst je Lauf den Steuerzeitraum: Sekunden je Stunde über die letzten Läufe', async () => {
  let nowMs = Date.parse('2026-11-12T10:00:02Z');
  const state = { optimizer: {} };
  const runs = [[6, 3], [12, 34], [9, 30]]; // [Sekunden, Stunden]
  let horizon = null;
  const trigger = createEosRunTrigger({
    isActive: () => true,
    getIntervalSec: () => 900,
    getSlotSec: () => 900,
    getHorizonHours: () => horizon,
    collectSoc: async () => ({ soc: { battery1: 50 } }),
    postOptimize: async () => { nowMs += runs.shift()[0] * 1000; return { ok: true, data: { start_solution: [1], start_solution_datetime: new Date(nowMs).toISOString() } }; },
    state,
    now: () => nowMs,
    setTimer: () => ({}),
    clearTimer: () => {},
  });
  for (const h of [null, 34, 30]) { horizon = h; await trigger.trigger(); nowMs += 120_000; }
  const r = state.optimizer.eosRun;
  // Lauf ohne bekannten Steuerzeitraum zählt nur für die mittlere Dauer.
  assert.equal(r.recentRuns, 3);
  assert.equal(r.secPerControlHour, Math.round(21 / 64 * 10_000) / 10_000);
  assert.equal(r.avgControlHours, 32);
  // Reist im Runtime-Schnappschuss mit (getrennter Web-Prozess).
  const snap = buildRuntimeSnapshot({ eosRun: r });
  assert.equal(snap.eosRun.secPerControlHour, r.secPerControlHour);
  assert.equal(snap.eosRun.avgControlHours, 32);
});

test('Leitstand: Zeile unter dem EOS-Fahrplan, Text vom Server, Warnung bei zu lang', () => {
  const dir = path.resolve(import.meta.dirname, '../public');
  const src = fs.readFileSync(path.join(dir, 'leitstand-charts.js'), 'utf8');
  const sandbox = {
    console, Date, Math, Number, JSON, Intl, Set, Map,
    document: { readyState: 'loading', addEventListener() {}, getElementById: () => null },
    window: {},
    setInterval() {},
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(src, sandbox, { filename: 'leitstand-charts.js' });
  const { eosHorizonHintText } = sandbox.window.DVhubLeitstand;
  assert.deepEqual({ ...eosHorizonHintText(null) }, { text: '', warn: false });
  assert.deepEqual({ ...eosHorizonHintText({ text: 'x', slow: true }) }, { text: 'x', warn: true });
  assert.match(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), /id="eosHorizonHint"/);
  assert.match(src, /renderEosHorizonHint\(eos\);/);
});

test('Einstellungen: Hinweis unter Steuerzeitraum und Prognosehorizont, geladen aus /api/price/outlook', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../public/settings.js'), 'utf8');
  assert.match(src, /apiFetch\('\/api\/price\/outlook'\)/);
  assert.match(src, /path === 'optimizer\.eosControlHorizonMaxHours'\) return \{ text: eosHorizonHint\.text/);
  assert.match(src, /path === 'optimizer\.eosPredictionHours'/);
  assert.match(src, /loadEosHorizonHint\(\);/);
  // Codex b1afb66c (P3): nach dem Speichern neu laden, nicht den alten Hinweis zeigen.
  assert.match(src, /renderSettingsShell\(\);\n {2}loadEosHorizonHint\(\);\n {2}return true;/);
  assert.match(src, /if \(definition && changed\) renderSettingsShell\(\);/);
});
