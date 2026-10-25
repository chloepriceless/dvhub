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

function harness({ loadW, soc = 97, exportW = 0, importW = 0, victron = {} }) {
  const cfg = froniusCfg();
  assert.equal(cfg.dvControl.zeroFeedIn.enabled, true, 'Profil liefert den Zero-Feed-in-Deckel');
  const state = {
    victron: { soc, gridImportW: importW, gridExportW: exportW, selfConsumptionW: loadW, fieldUpdatedAt: { soc: Date.now() }, ...victron },
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

test('Hauslast unbekannt (null), SoC-Auslöser: kein Enter, kein WMaxLimPct-Write', async () => {
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

// Gegenprüfung ec006d66 (P3): Auf Fronius ist die Hauslast abgeleitet
// (pv_plus_grid, ohne eigenen Zeitstempel). Scheitert das Lesen der PV, rechnet
// der Poller die Last aus der alten PV weiter — sie ist dann NICHT bekannt.
test('Fronius: abgeleitete Hauslast bei PV-Lesefehler gilt als unbekannt (SoC-Auslöser: kein Enter)', async () => {
  const { ev, state, writes } = harness({ loadW: 1500, victron: { errors: { pvPowerW: 'timeout' }, pvPowerW: 3000, pvTotalW: 3000 } });
  await ev.zeroFeedInTick();
  await ev.zeroFeedInTick();
  assert.deepEqual(pctWrites(writes), []);
  assert.equal(state.ctrl._zfi.capActive, false);
});

test('Fronius: abgeleitete Hauslast bei veralteter PV gilt als unbekannt', async () => {
  const old = Date.now() - 10 * 60000;
  const { ev, state, writes } = harness({ loadW: 1500, victron: { pvPowerW: 3000, pvTotalW: 3000 } });
  state.victron.fieldUpdatedAt.pvPowerW = old;
  await ev.zeroFeedInTick();
  await ev.zeroFeedInTick();
  assert.deepEqual(pctWrites(writes), []);
});

test('Fronius: frische PV → abgeleitete Hauslast bekannt, Start unverändert (1500 − 50) / 10 000', async () => {
  const { ev, state, writes } = harness({ loadW: 1500, victron: { pvPowerW: 3000, pvTotalW: 3000 } });
  state.victron.fieldUpdatedAt.pvPowerW = Date.now();
  await ev.zeroFeedInTick();
  await ev.zeroFeedInTick();
  assert.deepEqual(pctWrites(writes), [1450]);
});

// Gegenprüfung ec006d66 (P3): Export trotz Sperre heißt, der Akku nimmt nichts
// mehr — dann muss der Deckel auch ohne bekannte Hauslast greifen (Pflicht-
// Abregelung), Start bei 1 %, der Regler fährt auf die Hauslast hoch.
test('Hauslast unbekannt, aber Export trotz Sperre: Enter mit 1 % statt weiter einzuspeisen', async () => {
  const { ev, state, writes } = harness({ loadW: null, soc: 50, exportW: 2000 });
  for (let i = 0; i < 3; i += 1) await ev.zeroFeedInTick();
  assert.equal(state.ctrl._zfi.capActive, true);
  assert.deepEqual(pctWrites(writes), [100]);
});

// Gegenprüfung b0f20458 (P2): Ein über den EXPORT eingeschalteter Deckel
// (SoC unter der Schwelle, Akku nimmt trotzdem nichts — BMS-Derating) fiel im
// nächsten Takt über den SoC-Exit (soc <= Schwelle − Hysterese) wieder ab;
// danach speiste die Anlage drei Takte ein und der Deckel ging erneut an —
// ein Dauer-Takten mit OutWRte ±100 während der Pflicht-Abregelung.
test('Export-Auslöser unter der SoC-Hysterese: Deckel bleibt an, solange die Sperre gilt', async () => {
  const { ev, state, writes } = harness({ loadW: 800, soc: 50, exportW: 2000 });
  for (let i = 0; i < 3; i += 1) await ev.zeroFeedInTick();
  assert.equal(state.ctrl._zfi.capActive, true);
  const n = writes.length;
  state.victron.gridExportW = 300;              // Deckel wirkt, Rest-Export sinkt
  for (let i = 0; i < 6; i += 1) await ev.zeroFeedInTick();
  assert.equal(state.ctrl._zfi.capActive, true, 'kein soc_recovered-Exit für einen Export-Deckel');
  const later = writes.slice(n);
  assert.ok(!later.some((w) => w.address === ADDR.ena && w.value === 0), `Ena nie 0: ${JSON.stringify(later)}`);
  assert.ok(!later.some((w) => w.address === ADDR.out && w.value === 55536), 'kein Rückfall auf Force-Charge');
});

test('Export-Deckel: Limit 100 % und kein Export über 6 Takte → zurück auf Force-Charge', async () => {
  const { ev, state, writes, logs } = harness({ loadW: 800, soc: 50, exportW: 2000 });
  for (let i = 0; i < 3; i += 1) await ev.zeroFeedInTick();
  state.victron.gridExportW = 0;
  state.victron.gridImportW = 20000;            // viel Bezug → Regler fährt auf 100 %
  for (let i = 0; i < 12 && state.ctrl._zfi.capActive; i += 1) await ev.zeroFeedInTick();
  assert.equal(state.ctrl._zfi.capActive, false);
  assert.ok(logs.some((l) => l.e === 'zero_feedin_cap_off' && l.d.reason === 'export_cleared'));
  assert.deepEqual(writes.slice(-2), [{ address: ADDR.out, value: 55536 }, { address: ADDR.ena, value: 0 }]);
});

test('SoC-Deckel: SoC-Exit unverändert (Schwelle − Hysterese)', async () => {
  const { ev, state, logs } = harness({ loadW: 1000, soc: 97 });
  await ev.zeroFeedInTick();
  await ev.zeroFeedInTick();
  assert.equal(state.ctrl._zfi.capActive, true);
  state.victron.soc = 89;
  await ev.zeroFeedInTick();
  assert.equal(state.ctrl._zfi.capActive, false);
  assert.ok(logs.some((l) => l.e === 'zero_feedin_cap_off' && l.d.reason === 'soc_recovered'));
});
