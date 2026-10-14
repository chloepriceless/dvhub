// test/optimizer-rules-persistence.test.js — EOS-Plan-Regeln gehören nicht in
// die Config (2026-10-14).
//
// Fehler vorher: Zur Viertelstunde speicherte DVhub die Config samt Plan-Regeln;
// sanitizeScheduleRules (config-model) warf dabei Felder wie optimizer und
// closedLoopHold weg, applyLoadedConfig übernahm die gekürzten Regeln in den
// laufenden Zustand, und die Bereinigung (allowGridCharge=false) löschte darauf
// alle „Akku halten“-Regeln — bis zum nächsten EOS-Plan (~4 min je Viertelstunde).
//
// Jetzt: Plan-Regeln (source 'forecast_optimizer') bleiben im Speicher, werden
// nie in config.json geschrieben, überstehen ein Neuladen der Config und liegen
// für einen Neustart vollständig in optimizer-rules.json.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeConfigInput } from '../config-model.js';
import { sanitizePersistedScheduleRules, mergeLoadedScheduleRules } from '../schedule-runtime.js';
import { createOptimizerRuleStore, readOptimizerRules } from '../services/optimizer/rule-store.js';

const NOW = Date.parse('2026-10-14T17:00:00Z');
const hold = (i) => ({
  id: `opt-${i}`, enabled: true, autoManaged: true, source: 'forecast_optimizer', optimizer: 'eos',
  target: 'gridSetpointW', value: 120, closedLoopHold: true, start: '19:00', end: '19:15',
  slotTs: NOW + i * 900_000, slotEndTs: NOW + (i + 1) * 900_000,
});
const exportRule = { ...hold(9), id: 'opt-exp', value: -3000, closedLoopHold: undefined, closedLoopExport: true, batteryShareW: 2500, chargeReserveW: 400, targetSocPct: 40 };
const manual = { id: 'm1', enabled: true, target: 'gridSetpointW', value: -500, start: '20:00', end: '21:00', source: 'manual' };

// Der Ablauf wie in server.js: speichern (persistConfig) → normalisieren
// (saveConfigFile/loadConfigFile) → neu laden (applyLoadedConfig).
function persistAndReload(liveRules) {
  const saved = normalizeConfigInput({ schedule: { rules: sanitizePersistedScheduleRules(liveRules) } }).persistedConfig;
  return { saved, reloaded: mergeLoadedScheduleRules(liveRules, saved.schedule.rules) };
}

test('Plan-Regeln landen nicht in config.json, Regeln von Hand schon', () => {
  const { saved } = persistAndReload([hold(0), hold(1), exportRule, manual]);
  assert.deepEqual(saved.schedule.rules.map((r) => r.id), ['m1']);
});

test('Neuladen der Config behält die Plan-Regeln samt Kennzeichen', () => {
  const live = [hold(0), hold(1), exportRule, manual];
  const { reloaded } = persistAndReload(live);
  const opt = reloaded.filter((r) => r.source === 'forecast_optimizer');
  assert.equal(opt.length, 3);
  assert.ok(opt.filter((r) => r.id !== 'opt-exp').every((r) => r.optimizer === 'eos' && r.closedLoopHold === true));
  const exp = opt.find((r) => r.id === 'opt-exp');
  assert.deepEqual([exp.closedLoopExport, exp.batteryShareW, exp.chargeReserveW, exp.targetSocPct], [true, 2500, 400, 40]);
  assert.equal(reloaded.filter((r) => r.id === 'm1').length, 1);
});

test('Plan-Regeln aus einer alten config.json werden beim Laden verworfen (nicht verdoppelt)', () => {
  // So sahen sie nach dem alten Speichern aus: ohne optimizer/closedLoopHold.
  const stale = { id: 'opt-old', enabled: true, autoManaged: true, source: 'forecast_optimizer', target: 'gridSetpointW', value: 120, slotTs: NOW, slotEndTs: NOW + 900_000 };
  const cfgRules = normalizeConfigInput({ schedule: { rules: [stale, manual] } }).persistedConfig.schedule.rules;
  assert.deepEqual(cfgRules.map((r) => r.id), ['m1']);
  assert.deepEqual(mergeLoadedScheduleRules([], cfgRules).map((r) => r.id), ['m1']);
});

test('Neuladen ersetzt Regeln von Hand (Bearbeiten in der Oberfläche wirkt weiter)', () => {
  const live = [hold(0), manual];
  const edited = [{ ...manual, value: -800 }, { id: 'm2', enabled: true, target: 'gridSetpointW', value: 0, start: '22:00', end: '23:00', source: 'manual' }];
  const merged = mergeLoadedScheduleRules(live, edited);
  assert.deepEqual(merged.map((r) => r.id), ['opt-0', 'm1', 'm2']);
  assert.equal(merged.find((r) => r.id === 'm1').value, -800);
});

test('Ablage für den Neustart: vollständig, nur Plan-Regeln, schreibt nur bei Änderung, abgelaufene fallen beim Lesen weg', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opt-rules-'));
  const file = path.join(dir, 'optimizer-rules.json');
  const store = createOptimizerRuleStore({ file });
  const live = [{ ...hold(-1), _wasActive: true }, hold(0), { ...hold(1), enabled: false }, exportRule, manual];
  assert.equal(store.save(live), true);
  assert.equal(store.save(live), false, 'unverändert → kein Schreiben');
  const back = readOptimizerRules(file, NOW + 60_000);
  // hold(-1) ist abgelaufen; der von Hand abgeschaltete Slot bleibt abgeschaltet.
  assert.deepEqual(back.map((r) => r.id), ['opt-0', 'opt-1', 'opt-exp']);
  assert.equal(back.find((r) => r.id === 'opt-1').enabled, false);
  assert.equal(back[0].closedLoopHold, true);
  assert.ok(back.every((r) => !('_wasActive' in r)));
  assert.equal(readOptimizerRules(path.join(dir, 'fehlt.json'), NOW).length, 0);
  fs.writeFileSync(file, '{kaputt');
  assert.equal(readOptimizerRules(file, NOW).length, 0);
});

test('Reihenfolge bleibt: Plan-Regeln vor oder hinter den Regeln von Hand wie zuvor', () => {
  const sma = { id: 'sma-1', source: 'small_market_automation', autoManaged: true, target: 'gridSetpointW', value: -2000, enabled: true };
  // Nach einem Optimizer-Lauf: Plan zuerst.
  assert.deepEqual(mergeLoadedScheduleRules([hold(0), manual, sma], [manual, sma]).map((r) => r.id), ['opt-0', 'm1', 'sma-1']);
  // Nach dem Speichern im Zeitplan (Regeln von Hand zuerst, Automatik dahinter).
  assert.deepEqual(mergeLoadedScheduleRules([manual, sma, hold(0)], [manual, sma]).map((r) => r.id), ['m1', 'sma-1', 'opt-0']);
  // Nur Plan-Regeln im Zustand.
  assert.deepEqual(mergeLoadedScheduleRules([hold(0)], [manual]).map((r) => r.id), ['opt-0', 'm1']);
});

// Audit 2026-10-14, Befund 5: Eine Regel von Hand trägt im Speicher die
// Markierung _wasActive, solange ihr Fenster lief. Lud ein Speichern die Config
// neu, kam die Regel ohne Markierung zurück — fiel das zwischen den letzten
// Durchlauf im Fenster und den ersten danach, wurde sie nie abgeschaltet und
// lief am nächsten Tag wieder.
test('Neuladen behält _wasActive einer unveränderten Regel von Hand — sie wird nach dem Fenster abgeschaltet', async () => {
  const { autoDisableExpiredScheduleRules } = await import('../schedule-runtime.js');
  const live = [{ ...manual, _wasActive: true }];          // lief bis 21:00
  const { reloaded } = persistAndReload(live);
  assert.equal(reloaded[0]._wasActive, true);
  // 21:05 (1265 min): Fenster 20:00–21:00 vorbei → abschalten.
  const after = autoDisableExpiredScheduleRules(reloaded, 21 * 60 + 5);
  assert.equal(after.changed, true);
  assert.equal(after.rules[0].enabled, false);
});

test('Neuladen: eine geänderte Regel gilt als neu und verliert _wasActive', () => {
  const live = [{ ...manual, _wasActive: true }];
  const edited = normalizeConfigInput({ schedule: { rules: [{ ...manual, end: '23:00' }] } }).persistedConfig;
  const reloaded = mergeLoadedScheduleRules(live, edited.schedule.rules);
  assert.equal(reloaded[0].end, '23:00');
  assert.equal('_wasActive' in reloaded[0], false);
});

test('Neuladen: zwei gleiche Regeln — die Markierung geht nur an eine', () => {
  const twin = { target: 'gridSetpointW', value: 0, start: '08:00', end: '09:00', enabled: true };
  const live = [{ ...twin, _wasActive: true }, { ...twin }];
  const { reloaded } = persistAndReload(live);
  assert.deepEqual(reloaded.map((r) => r._wasActive === true), [true, false]);
});
