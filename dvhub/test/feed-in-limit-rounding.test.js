// Review Regelung 25.10. (P3): toRawForWrite rundete auch Einspeisegrenzen
// kaufmännisch. Victron 2706 zählt in 100-W-Schritten — aus 4250 W wurden
// raw 43 = 4300 W, also bis zu einem halben Schritt ÜBER der zulässigen Grenze.
// Eine obere Grenze wird jetzt zur sicheren Seite (abwärts) gerundet; alle
// anderen Punkte runden unverändert. ECHTES Victron-Profil, echter Evaluator.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfigFile } from '../config-model.js';
import { createScheduleEvaluator } from '../schedule-eval.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function victronCfg() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-limround-'));
  fs.mkdirSync(path.join(rootDir, 'hersteller'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'hersteller', 'victron.json'), path.join(rootDir, 'hersteller', 'victron.json'));
  const configPath = path.join(rootDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ manufacturer: 'victron', victron: { host: '192.0.2.10' } }));
  return loadConfigFile(configPath).effectiveConfig;
}

function harness(cfg) {
  const state = {
    victron: { soc: 50, fieldUpdatedAt: { soc: Date.now() } },
    ctrl: {},
    schedule: { rules: [], active: {}, lastWrite: {}, manualOverride: {}, config: {}, lastEvalAt: 0 }
  };
  const writes = [];
  const regs = { 2706: 0xffff };
  const transport = {
    type: 'modbus',
    async mbRequest({ address }) { return [regs[address] ?? 0]; },
    async mbWriteSingle({ address, value }) { writes.push([address, value]); regs[address] = value; },
    async mbWriteMultiple({ address, values }) { writes.push([address, values]); }
  };
  const ev = createScheduleEvaluator({
    state, getCfg: () => cfg, transport, pushLog: () => {},
    telemetrySafeWrite: () => {}, persistConfig: async () => {}, epexNowNext: () => ({ current: { ct_kwh: 10 } })
  });
  return { ev, writes };
}

test('Einspeisegrenze 2706 wird abwärts gerundet: nie über der Vorgabe', async () => {
  const cases = [[4250, 42], [4299, 42], [4200, 42], [4201, 42], [99, 0], [0, 0], [12345, 123]];
  for (const [limitW, raw] of cases) {
    const { ev, writes } = harness(victronCfg());
    await ev.applyDvFeedInLimit(limitW);
    assert.deepEqual(writes, [[2706, raw]], `${limitW} W → raw ${raw} (≤ ${limitW} W)`);
  }
});

test('andere Punkte runden unverändert kaufmännisch (2704 MaxDischargePower, Ladestrom)', async () => {
  const cfg = victronCfg();
  const { ev, writes } = harness(cfg);
  const r1 = await ev.applyControlTarget('maxDischargeW', 4255, 'test');
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.deepEqual(writes.at(-1), [2704, 426], '4255 W / 10 → 426 (wie bisher)');
  const scaleA = Number(cfg.controlWrite.chargeCurrentA.scale ?? 1);
  const r2 = await ev.applyControlTarget('chargeCurrentA', 10.5 * scaleA, 'test');
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.deepEqual(writes.at(-1), [cfg.controlWrite.chargeCurrentA.address, 11], 'x.5 → aufgerundet wie bisher');
});
