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

test('Erschöpfung: Zustand wird GEHALTEN, nicht weiter geschrieben, gemeldet', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvbudget-'));
  const savedPath = path.join(dir, 'dv_seq_saved.json');
  const writedayPath = path.join(dir, 'dv_seq_writeday.json');
  const logs = [];
  const device = { 13073: 24200, 13086: 170, 13087: 0xffff };
  const { evaluator, state, transport } = makeEvaluator({ dvSeqSavedPath: savedPath, dvSeqWritedayPath: writedayPath, device, logs });

  // 10 Zyklen = 20 Sequenzen → Budget erschöpft.
  for (let i = 0; i < 10; i++) await cycle(evaluator);
  assert.equal(state.ctrl.dvSeqBudget.count, 20);
  assert.equal(state.ctrl.dvSeqBudget.left, 0);

  // 21. schreibende Sequenz (neue Sperre) wird GEHALTEN: kein Geräte-Write,
  // ok:false, Meldung dv_control_seq_budget, _lastDvFeedIn bleibt unverändert.
  transport.writes.length = 0;
  logs.length = 0;
  const prevFeedIn = state.ctrl._lastDvFeedIn;
  const held = await evaluator.applyControlTarget('feedExcessDcPv', 0, 'negative_price_protection');
  assert.equal(held.ok, false, 'gehaltene Sequenz meldet sich als nicht geschrieben');
  assert.equal(transport.writes.length, 0, 'kein Geräte-Write bei erschöpftem Budget');
  assert.equal(state.ctrl._lastDvFeedIn, prevFeedIn, 'Zustand gehalten (Change-Cache unverändert)');
  assert.ok(logs.some((l) => l.type === 'dv_control_seq_budget'), 'Hold wird gemeldet');
  assert.equal(state.ctrl.dvSeqBudget.count, 20, 'der gehaltene Versuch zählt nicht');
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
