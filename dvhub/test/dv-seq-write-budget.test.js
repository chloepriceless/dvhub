// M14b: Schreibbudget für den dvControl-Einspeise-Sequenzpfad (13074/13087/13088/
// 31222). Eigener persistierter Tages-Zähler (dv_seq_writeday.json), getrennt vom
// 13050-EMS-Budget. Eine SCHREIBENDE Sequenz (ein Abregel-Wechsel) = 1. Bei
// Erschöpfung (≥ 20/Tag) wird der Zustand GEHALTEN — nicht weiter geschrieben —
// und gemeldet (dv_control_seq_budget). Der Zähler überlebt einen Neustart.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createScheduleEvaluator } from '../schedule-eval.js';

function makeEvaluator({ dvSeqSavedPath, dvSeqWritedayPath, device, logs }) {
  const state = { victron: { soc: 50 }, ctrl: {}, schedule: { rules: [], active: {}, lastWrite: {}, manualOverride: {}, config: {}, lastEvalAt: 0 }, log: [] };
  const cfg = {
    controlWrite: {
      feedInLimitRatio:  { enabled: true, fc: 6, address: 13087, writeType: 'uint16', scale: 1, offset: 0, verify: true, notAvailableRaw: [65535] },
      feedInLimitW:      { enabled: true, fc: 6, address: 13073, writeType: 'uint16', scale: 1, offset: 0, verify: true },
      feedInLimitEnable: { enabled: true, fc: 6, address: 13086, writeType: 'uint16', scale: 1, offset: 0, verify: true },
    },
    dvControl: {
      enabled: true,
      feedExcessDcPv: {
        enabled: true,
        sequence: {
          '0': [
            { point: 'feedInLimitRatio', value: 0, saveBefore: true, optional: true },
            { point: 'feedInLimitW', value: 0, saveBefore: true },
            { point: 'feedInLimitEnable', value: 170, saveBefore: true },
          ],
          '1': [
            { point: 'feedInLimitRatio', restore: true, optional: true },
            { point: 'feedInLimitW', restore: true },
            { point: 'feedInLimitEnable', restore: true },
          ],
        },
      },
    },
  };
  const transport = {
    type: 'modbus', writes: [],
    async mbWriteSingle(req) { device[req.address] = req.value; this.writes.push({ address: req.address, value: req.value }); },
    async mbWriteMultiple(req) { this.writes.push({ address: req.address, values: req.values }); },
    async mbRequest({ address, quantity }) { const out = []; for (let i = 0; i < (quantity || 1); i++) out.push(device[address + i] ?? 0); return out; },
  };
  const evaluator = createScheduleEvaluator({
    state, getCfg: () => cfg, transport,
    pushLog: (type, payload, level) => { logs.push({ type, payload, level }); state.log.push({ ts: new Date().toISOString(), event: type, ...payload }); },
    telemetrySafeWrite: () => {}, persistConfig: async () => {}, telemetryStore: null, epexNowNext: () => null,
    dvSeqSavedPath, dvSeqWritedayPath,
  });
  return { evaluator, state, transport };
}

// Ein On/Off-Zyklus = zwei schreibende Sequenzen (Sperre + Freigabe).
async function cycle(evaluator) {
  await evaluator.applyControlTarget('feedExcessDcPv', 0, 'negative_price_protection');
  await evaluator.applyControlTarget('feedExcessDcPv', 1, 'negative_price_protection');
}

test('Zähler persistiert je Tag und zählt nur schreibende Sequenzen', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvbudget-'));
  const savedPath = path.join(dir, 'dv_seq_saved.json');
  const writedayPath = path.join(dir, 'dv_seq_writeday.json');
  const logs = [];
  const device = { 13073: 24200, 13086: 170, 13087: 0xffff };
  const { evaluator, state } = makeEvaluator({ dvSeqSavedPath: savedPath, dvSeqWritedayPath: writedayPath, device, logs });

  await cycle(evaluator); // 2 Sequenzen
  assert.equal(state.ctrl.dvSeqBudget.count, 2);
  assert.equal(state.ctrl.dvSeqBudget.left, 18);
  const persisted = JSON.parse(fs.readFileSync(writedayPath, 'utf8'));
  assert.equal(persisted.count, 2, 'Zähler auf die Platte geschrieben');

  // Ein No-op (gleicher Wert, unchanged) zählt NICHT.
  await evaluator.applyControlTarget('feedExcessDcPv', 1, 'negative_price_protection');
  assert.equal(state.ctrl.dvSeqBudget.count, 2, 'unchanged schreibt nicht → zählt nicht');
});

test('Neustart setzt den Tageszähler nicht zurück (lädt aus der Datei)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvbudget-'));
  const savedPath = path.join(dir, 'dv_seq_saved.json');
  const writedayPath = path.join(dir, 'dv_seq_writeday.json');
  const device = { 13073: 24200, 13086: 170, 13087: 0xffff };

  const a = makeEvaluator({ dvSeqSavedPath: savedPath, dvSeqWritedayPath: writedayPath, device, logs: [] });
  await cycle(a.evaluator);
  assert.equal(a.state.ctrl.dvSeqBudget.count, 2);

  // „Neustart": zweite Instanz mit demselben Pfad, frischer Gerätezustand.
  const device2 = { 13073: 24200, 13086: 170, 13087: 0xffff };
  const b = makeEvaluator({ dvSeqSavedPath: path.join(dir, 'saved2.json'), dvSeqWritedayPath: writedayPath, device: device2, logs: [] });
  assert.equal(b.state.ctrl.dvSeqBudget.count, 2, 'Zähler aus der Datei übernommen');
  await cycle(b.evaluator);
  assert.equal(b.state.ctrl.dvSeqBudget.count, 4, 'läuft beim selben Tagesschlüssel weiter');
});

// M14b-Fix (16.11.): Bei erschöpftem Budget wird NUR die automatische Wieder-
// Freigabe gehalten. Eine Sperre (§51/Negativpreis/DV, feedIn=false, explicit=false)
// und ein ausdrücklicher Befehl (explicit) schreiben IMMER — sonst speiste die
// Anlage nach 20 Sequenzen trotz Negativpreis/DV weiter ein. Der automatische
// Eval-Pfad läuft über applyDvVictronControl(feedIn, { reason }) (explicit=false);
// applyControlTarget(...) ist dagegen immer ein ausdrücklicher Befehl (explicit=true).

test('Erschöpfung: automatische Wieder-Freigabe wird GEHALTEN (sichere Richtung: bleibt gesperrt)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvbudget-'));
  const logs = [];
  const device = { 13073: 24200, 13086: 170, 13087: 0xffff };
  const { evaluator, state, transport } = makeEvaluator({
    dvSeqSavedPath: path.join(dir, 'dv_seq_saved.json'),
    dvSeqWritedayPath: path.join(dir, 'dv_seq_writeday.json'), device, logs });

  for (let i = 0; i < 10; i++) await cycle(evaluator); // 20 Sequenzen → erschöpft
  assert.equal(state.ctrl.dvSeqBudget.left, 0);

  // Automatische Sperre (ausgenommen) setzt den Zustand auf „gesperrt".
  await evaluator.applyDvVictronControl(false, { reason: 'negative_price_protection' });
  assert.equal(state.ctrl._lastDvFeedIn, false, 'Sperre wirkt');

  // Automatische Wieder-Freigabe (explicit=false, feedIn=true) wird gehalten.
  transport.writes.length = 0; logs.length = 0;
  await evaluator.applyDvVictronControl(true, { reason: 'price_recovered' });
  assert.equal(transport.writes.length, 0, 'automatische Freigabe schreibt nicht bei leerem Budget');
  assert.equal(state.ctrl._lastDvFeedIn, false, 'bleibt gesperrt — Zustand gehalten');
  assert.ok(logs.some((l) => l.type === 'dv_control_seq_budget'), 'Hold wird gemeldet');
});

test('Erschöpfung: eine Sperre (§51/Negativpreis) schreibt TROTZDEM — kein Compliance-Loch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvbudget-'));
  const device = { 13073: 24200, 13086: 170, 13087: 0xffff };
  const { evaluator, state, transport } = makeEvaluator({
    dvSeqSavedPath: path.join(dir, 'dv_seq_saved.json'),
    dvSeqWritedayPath: path.join(dir, 'dv_seq_writeday.json'), device, logs: [] });

  for (let i = 0; i < 10; i++) await cycle(evaluator); // erschöpft, endet freigegeben (_lastDvFeedIn=true)
  assert.equal(state.ctrl.dvSeqBudget.left, 0);

  transport.writes.length = 0;
  await evaluator.applyDvVictronControl(false, { reason: 'negative_price_protection' });
  assert.ok(transport.writes.some((w) => w.address === 13073 && w.value === 0), 'Sperre schreibt die Einspeisegrenze trotz leerem Budget');
  assert.equal(state.ctrl._lastDvFeedIn, false, 'Anlage ist gesperrt (speist nicht gegen den Negativpreis)');
});

test('Erschöpfung: ausdrücklicher Befehl (API) schreibt TROTZDEM', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvbudget-'));
  const device = { 13073: 24200, 13086: 170, 13087: 0xffff };
  const { evaluator, state, transport } = makeEvaluator({
    dvSeqSavedPath: path.join(dir, 'dv_seq_saved.json'),
    dvSeqWritedayPath: path.join(dir, 'dv_seq_writeday.json'), device, logs: [] });

  for (let i = 0; i < 10; i++) await cycle(evaluator); // erschöpft, _lastDvFeedIn=true
  assert.equal(state.ctrl.dvSeqBudget.left, 0);

  // Ausdrücklicher Befehl geht über applyControlTarget (explicit=true) → ausgenommen.
  transport.writes.length = 0;
  const r = await evaluator.applyControlTarget('feedExcessDcPv', 0, 'api_manual_write');
  assert.equal(r.ok, true, 'ausdrücklicher Befehl wird nicht gehalten');
  assert.ok(transport.writes.some((w) => w.address === 13073 && w.value === 0), 'ausdrücklicher Befehl schreibt trotz leerem Budget');
});

test('Freigabe/Sperre im Budget schreiben normal, bis es erschöpft ist', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvbudget-'));
  const savedPath = path.join(dir, 'dv_seq_saved.json');
  const writedayPath = path.join(dir, 'dv_seq_writeday.json');
  const device = { 13073: 24200, 13086: 170, 13087: 0xffff };
  const { evaluator, state, transport } = makeEvaluator({ dvSeqSavedPath: savedPath, dvSeqWritedayPath: writedayPath, device, logs: [] });

  const lock = await evaluator.applyControlTarget('feedExcessDcPv', 0, 'negative_price_protection');
  assert.equal(lock.ok, true);
  assert.ok(transport.writes.some((w) => w.address === 13073 && w.value === 0), 'Sperre schreibt im Budget normal');
  assert.equal(state.ctrl.dvSeqBudget.count, 1);
});
