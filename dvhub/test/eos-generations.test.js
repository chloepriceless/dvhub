// test/eos-generations.test.js — EOS-Generationen einstellbar (DVhub 1.0.10,
// Christin 05.11.2026): „Die Generationen sollten einstellbar sein; 100 nur auf
// Auswahl bzw. für schwache Boxen; bei unseren normalen Installationen bei 200
// bleiben.“ Dazu ein Hinweis, wenn Läufe im Mittel lange dauern — umgestellt
// wird nichts von selbst.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import vm from 'node:vm';
import { getConfigDefinition, normalizeConfigInput } from '../config-model.js';
import { mergeAgainstBase } from '../services/config-base-merge.js';
import { pickGeneticSizing, EOS_DEFAULT_GENERATIONS } from '../services/optimizer/eos-config-sync.js';
import { createEosRunTrigger, EOS_RUN_DURATION_WINDOW } from '../services/optimizer/eos-run-trigger.js';
import { eosSlowRunHint, EOS_SLOW_RUN_HINT_S, EOS_SLOW_RUN_MIN_RUNS } from '../services/optimizer/eos-run-hint.js';
import { loadSettingsPage, makeElement } from './helpers/settings-page.js';

const clone = (v) => JSON.parse(JSON.stringify(v));

test('Standard: 200 Generationen (leer oder 0); 100 und eigene Werte 50–1000 bleiben', () => {
  assert.equal(EOS_DEFAULT_GENERATIONS, 200);
  assert.deepEqual(pickGeneticSizing(900), { generations: 200, individuals: 300 });
  assert.deepEqual(pickGeneticSizing(900, 0), { generations: 200, individuals: 300 });
  assert.deepEqual(pickGeneticSizing(900, ''), { generations: 200, individuals: 300 });
  assert.deepEqual(pickGeneticSizing(900, 100), { generations: 100, individuals: 300 });
  assert.deepEqual(pickGeneticSizing(900, 400), { generations: 400, individuals: 300 });
});

test('Einstellungen: Auswahl 200 (Standard) / 100 (schwache Hardware) und eigener Wert', () => {
  const f = getConfigDefinition().fields.find((x) => x.path === 'optimizer.eosGeneticGenerations');
  assert.equal(f.type, 'number', 'der gespeicherte Wert bleibt eine Zahl — eigene Werte gehen nicht verloren');
  assert.deepEqual(f.presets.map((p) => p.value), [200, 100]);
  assert.match(f.presets[0].label, /^200 \(Standard\)$/);
  assert.equal(f.presets[0].standard, true);
  assert.match(f.presets[1].label, /^100 \(schwache Hardware, z\. B\. A55-Boards/);
  assert.match(f.presets[1].label, /¼ Rechenzeit/);
  assert.match(f.help, /Standard 200/);
  assert.doesNotMatch(f.help, /400/);
  assert.match(f.help, /automatisch/);
  // eigener Wert in vernünftigem Bereich; ein alter Wert bleibt erhalten
  assert.equal(normalizeConfigInput({ optimizer: { eosGeneticGenerations: 350 } }).rawConfig.optimizer.eosGeneticGenerations, 350);
  assert.equal(normalizeConfigInput({ optimizer: { eosGeneticGenerations: 5000 } }).rawConfig.optimizer.eosGeneticGenerations, undefined);
});

// Einstellungsseite: Feld zeichnen, Auswahl ändern, speichern wie im Browser.
function renderGenerations(stored) {
  const { context, inputs } = loadSettingsPage();
  const raw = stored === undefined ? {} : { optimizer: { eosGeneticGenerations: stored } };
  const normalized = normalizeConfigInput(clone(raw));
  context.__payload = { config: clone(raw), effectiveConfig: normalized.effectiveConfig, definition: getConfigDefinition(), meta: {} };
  vm.runInContext('loadConfigPayloadState(__payload)', context);
  const field = context.__payload.definition.fields.find((f) => f.path === 'optimizer.eosGeneticGenerations');
  const model = context.buildFieldRenderModel(field);
  const el = context.createConfigInput(field, model.value, model.inherited);
  const select = el.children.find((c) => c.tagName === 'SELECT');
  const input = el.children.find((c) => c.tagName === 'INPUT');
  if (input) inputs.set(input.id, input);
  const save = () => {
    const sent = clone(vm.runInContext('collectConfigFromForm()', context));
    return { sent, saved: normalizeConfigInput(mergeAgainstBase(sent, clone(raw), clone(raw))) };
  };
  return { el, select, input, save };
}

test('Einstellungsseite: Auswahl zeigt den gespeicherten Wert, „eigener Wert“ öffnet das Zahlenfeld', () => {
  assert.ok(makeElement); // Ersatz-Browser aus dem Helfer
  let r = renderGenerations(undefined);
  assert.ok(r.select && r.input, 'Auswahl und Zahlenfeld');
  assert.deepEqual(r.select.children.map((o) => o.value), ['200', '100', 'custom']);
  assert.equal(r.select.value, '200');
  assert.equal(r.input.hidden, true);
  r = renderGenerations(200);
  assert.equal(r.select.value, '200');
  r = renderGenerations(100);
  assert.equal(r.select.value, '100');
  r = renderGenerations(350);
  assert.equal(r.select.value, 'custom');
  assert.equal(r.input.hidden, false);
  assert.equal(r.input.value, '350');
});

test('Einstellungsseite: 100 wählen speichert 100, zurück auf 200 (Standard) löscht den Wert, eigener Wert wird gespeichert', () => {
  let r = renderGenerations(undefined);
  r.select.value = '100';
  r.select.fire('change');
  assert.equal(r.input.value, '100');
  let { sent, saved } = r.save();
  assert.equal(sent.optimizer.eosGeneticGenerations, 100);
  assert.equal(saved.rawConfig.optimizer.eosGeneticGenerations, 100);

  r = renderGenerations(100);
  r.select.value = '200';
  r.select.fire('change');
  ({ saved } = r.save());
  assert.equal(saved.rawConfig.optimizer?.eosGeneticGenerations, undefined, 'Standard = kein gespeicherter Wert');
  assert.equal(pickGeneticSizing(900, saved.rawConfig.optimizer?.eosGeneticGenerations).generations, 200);

  r = renderGenerations(100);
  r.select.value = 'custom';
  r.select.fire('change');
  assert.equal(r.input.hidden, false);
  r.input.value = '250';
  ({ saved } = r.save());
  assert.equal(saved.rawConfig.optimizer.eosGeneticGenerations, 250);
});

// ── Laufdauer und Hinweis ───────────────────────────────────────────────────

test('Lauf-Auslöser: mittlere Dauer der letzten Läufe', async () => {
  let nowMs = Date.parse('2026-11-05T10:00:02Z');
  const state = { optimizer: {} };
  const durations = [];
  const trigger = createEosRunTrigger({
    isActive: () => true,
    getIntervalSec: () => 900,
    getSlotSec: () => 900,
    getHorizonHours: () => 6,
    collectSoc: async () => ({ soc: { battery1: 50 } }),
    postOptimize: async () => { nowMs += durations.shift() * 1000; return { ok: true, data: { start_solution: [1], start_solution_datetime: new Date(nowMs).toISOString() } }; },
    state,
    now: () => nowMs,
    setTimer: () => ({}),
    clearTimer: () => {},
  });
  durations.push(600, 900, 1200);
  for (let i = 0; i < 3; i += 1) { await trigger.trigger(); nowMs += 120_000; }
  assert.equal(state.optimizer.eosRun.avgDurationS, 900);
  assert.equal(state.optimizer.eosRun.recentRuns, 3);
  // Gescheiterte Läufe zählen nicht mit; nur die letzten EOS_RUN_DURATION_WINDOW.
  const many = Array.from({ length: EOS_RUN_DURATION_WINDOW }, () => 60);
  durations.push(...many);
  for (let i = 0; i < many.length; i += 1) { await trigger.trigger(); nowMs += 120_000; }
  assert.equal(state.optimizer.eosRun.avgDurationS, 60);
  assert.equal(state.optimizer.eosRun.recentRuns, EOS_RUN_DURATION_WINDOW);
});

test('Hinweis: erst ab genug langen Läufen, schlägt nur vor, was noch nicht eingestellt ist', () => {
  const slow = { avgDurationS: EOS_SLOW_RUN_HINT_S + 60, recentRuns: EOS_SLOW_RUN_MIN_RUNS };
  assert.equal(EOS_SLOW_RUN_HINT_S, 600);
  assert.equal(eosSlowRunHint({ ...slow, recentRuns: EOS_SLOW_RUN_MIN_RUNS - 1 }, {}), null, 'zu wenige Läufe');
  assert.equal(eosSlowRunHint({ avgDurationS: EOS_SLOW_RUN_HINT_S - 1, recentRuns: 8 }, {}), null, 'schnell genug');
  let h = eosSlowRunHint(slow, {});
  assert.match(h.text, /im Mittel 11 min/);
  assert.match(h.text, /100 Generationen/);
  assert.match(h.text, /„automatisch“/);
  assert.deepEqual(h.suggest, { generations: 100, controlHorizon: 'auto' });
  h = eosSlowRunHint(slow, { optimizer: { eosGeneticGenerations: 100 } });
  assert.deepEqual(h.suggest, { controlHorizon: 'auto' });
  assert.doesNotMatch(h.text, /100 Generationen/);
  h = eosSlowRunHint(slow, { optimizer: { eosControlHorizonMaxHours: 'auto' } });
  assert.deepEqual(h.suggest, { generations: 100 });
  assert.equal(eosSlowRunHint(slow, { optimizer: { eosGeneticGenerations: 100, eosControlHorizonMaxHours: 'auto' } }), null, 'nichts mehr vorzuschlagen');
  // Fernbetrieb seit 1.0.10 aus: ein gespeichertes 'remote' rechnet lokal — der Hinweis gilt wie dort.
  assert.deepEqual(eosSlowRunHint(slow, { optimizer: { eosProxy: { enabled: true, mode: 'remote' } } })?.suggest,
    eosSlowRunHint(slow, { optimizer: {} })?.suggest);
  assert.notEqual(eosSlowRunHint(slow, { optimizer: { eosProxy: { enabled: true, mode: 'remote' } } }), null);
});

// Codex-Gegenprüfung 57608a1e (P2): „automatisch“ ist nicht kürzer als eine
// feste Grenze — bei 6 h würde eine Abfahrt in 20 h den Lauf verlängern. Den
// Steuerzeitraum nur vorschlagen, wo er heute der ganze Preiszeitraum ist.
test('Hinweis: feste Grenze → kein Vorschlag „automatisch“', () => {
  const slow = { avgDurationS: 900, recentRuns: 8 };
  for (const cap of [6, 12, 24]) {
    const h = eosSlowRunHint(slow, { optimizer: { eosControlHorizonMaxHours: cap } });
    assert.deepEqual(h.suggest, { generations: 100 }, `Grenze ${cap} h`);
    assert.doesNotMatch(h.text, /automatisch/);
    assert.equal(eosSlowRunHint(slow, { optimizer: { eosControlHorizonMaxHours: cap, eosGeneticGenerations: 100 } }), null);
  }
});

// Codex-Gegenprüfung 57608a1e (P2): Getrennter Betrieb
// (DVHUB_ENABLE_RUNTIME_WORKER=1) — die Läufe laufen im Runtime-Prozess,
// /api/eos/plan im Web-Prozess. Laufdauer und Steuerzeitraum des Plans reisen
// im Runtime-Schnappschuss mit.
test('Runtime-Schnappschuss: eosRun reist mit und landet im Web-Prozess', async () => {
  const { buildRuntimeSnapshot, applyRuntimeEosRun } = await import('../runtime-state.js');
  const eosRun = { inFlight: false, avgDurationS: 700, recentRuns: 5, lastDurationS: 650, lastDoneAt: 1000, lastPlanControl: { hours: 17, estimatedFrom: '2026-11-05T23:00:00.000Z', runStartedAt: 1, runDoneAt: 2 } };
  const snap = buildRuntimeSnapshot({ eosRun });
  assert.deepEqual(snap.eosRun, { avgDurationS: 700, recentRuns: 5, lastDurationS: 650, lastDoneAt: 1000, lastPlanControl: eosRun.lastPlanControl });
  assert.equal(buildRuntimeSnapshot({}).eosRun, null);
  const state = { optimizer: { eosRun: { inFlight: true } } };
  applyRuntimeEosRun(state, snap);
  assert.equal(state.optimizer.eosRun.avgDurationS, 700);
  assert.equal(state.optimizer.eosRun.lastPlanControl.hours, 17);
  assert.equal(state.optimizer.eosRun.inFlight, true, 'Web-eigene Felder bleiben');
  applyRuntimeEosRun(state, { eosRun: null });
  assert.equal(state.optimizer.eosRun.avgDurationS, 700, 'ohne Angabe bleibt der letzte Stand');
});
