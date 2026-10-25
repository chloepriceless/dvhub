// Review Regelung 25.10. (P3): Der Zero-Feed-in-Deckel (Fronius, Model 123
// WMaxLimPct) startete mit limitPct = max(0, …). Fehlte die Hauslast
// (selfConsumptionW null → 0), schrieb er WMaxLimPct 0 % — laut
// hersteller/fronius.json NIE erlaubt (legt den ganzen Hybrid-WR still, das
// Haus zieht Netzstrom). Jetzt: mindestens 1 % wie capLoopStep, und ohne
// bekannte Hauslast kein Enter. ECHTES Fronius-Profil, echter Evaluator.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfigFile } from '../config-model.js';
import { createScheduleEvaluator } from '../schedule-eval.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADDR = { pct: 40242, rvrt: 40244, ena: 40246, out: 40198, stor: 40191 };

function froniusCfg() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-zfimin-'));
  fs.mkdirSync(path.join(rootDir, 'hersteller'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'hersteller', 'fronius.json'), path.join(rootDir, 'hersteller', 'fronius.json'));
  const configPath = path.join(rootDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ manufacturer: 'fronius', victron: { host: '192.0.2.10' } }));
  const cfg = loadConfigFile(configPath).effectiveConfig;
  // Adressen wie nach dem SunSpec-Scan.
  cfg.controlWrite.wMaxLimPct.address = ADDR.pct;
  cfg.controlWrite.wMaxLimPctRvrtTms.address = ADDR.rvrt;
  cfg.controlWrite.wMaxLimEna.address = ADDR.ena;
  cfg.controlWrite.outWRte.address = ADDR.out;
  cfg.controlWrite.storCtlMod.address = ADDR.stor;
  cfg.optimizer = { ...cfg.optimizer, inverterMaxPowerW: 10000 };
  return cfg;
}

function harness({ loadW, soc = 97, exportW = 0, importW = 0 }) {
  const cfg = froniusCfg();
  assert.equal(cfg.dvControl.zeroFeedIn.enabled, true, 'Profil liefert den Zero-Feed-in-Deckel');
  const state = {
    victron: { soc, gridImportW: importW, gridExportW: exportW, selfConsumptionW: loadW, fieldUpdatedAt: { soc: Date.now() } },
    meter: { ok: true, updatedAt: Date.now() },
    ctrl: { _lastDvFeedIn: false },
    schedule: { rules: [], active: {}, lastWrite: {}, manualOverride: {}, config: {}, lastEvalAt: 0 }
  };
  const writes = [];
  const logs = [];
  const transport = {
    type: 'modbus',
    async mbWriteSingle({ address, value }) { writes.push({ address, value }); },
    async mbWriteMultiple({ address, values }) { writes.push({ address, values }); },
    async mbRequest({ address }) {
      const last = [...writes].reverse().find((w) => w.address === address);
      return [last ? last.value : 0];
    }
  };
  const ev = createScheduleEvaluator({
    state, getCfg: () => cfg, transport, pushLog: (e, d) => logs.push({ e, d }),
    telemetrySafeWrite: () => {}, persistConfig: async () => {}, telemetryStore: null, epexNowNext: () => null
  });
  return { ev, state, writes, logs };
}

const pctWrites = (writes) => writes.filter((w) => w.address === ADDR.pct).map((w) => w.value);

test('Hauslast unbekannt (null): kein Enter, kein WMaxLimPct-Write', async () => {
  const { ev, state, writes } = harness({ loadW: null });
  await ev.zeroFeedInTick();
  await ev.zeroFeedInTick();
  assert.deepEqual(pctWrites(writes), [], `Writes ${JSON.stringify(writes)}`);
  assert.equal(state.ctrl._zfi.capActive, false);
});

test('Hauslast 0 W gemessen: Enter mit 1 % (raw 100), nie 0 %', async () => {
  const { ev, state, writes } = harness({ loadW: 0 });
  await ev.zeroFeedInTick();
  await ev.zeroFeedInTick();
  assert.equal(state.ctrl._zfi.capActive, true);
  assert.deepEqual(pctWrites(writes), [100]);
});

test('Regler bei aktivem Deckel und hohem Export: bleibt bei 1 %, schreibt nie 0 %', async () => {
  const { ev, state, writes } = harness({ loadW: 1000 });
  await ev.zeroFeedInTick();
  await ev.zeroFeedInTick();
  assert.deepEqual(pctWrites(writes), [950], 'Start wie bisher: (1000 − 50) / 10 000 = 9,5 %');
  state.victron.gridExportW = 5000;            // trotz Deckel 5 kW Export
  for (let i = 0; i < 4; i += 1) await ev.zeroFeedInTick();
  const pct = pctWrites(writes);
  assert.ok(pct.every((v) => v >= 100), `nie unter 1 %: ${JSON.stringify(pct)}`);
  assert.equal(pct.at(-1), 100);
});
