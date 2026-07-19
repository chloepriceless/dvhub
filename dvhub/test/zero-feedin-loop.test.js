// B-1112 Stufe 2 — Zero-Feed-in-Deckel (Christin 2026-07-19): Bei Abregelung
// (Negativpreis/DV) muss die Nulleinspeisung auch bei VOLLEM Akku greifen —
// der WR wird lastfolgend auf die Hauslast gedrosselt (nie auf 0, sonst kein
// Eigenverbrauch), und bei PV-Defizit darf der Akku das Haus stützen
// (OutWRte +100 statt Force-Charge −100). Getestet wird der Tick direkt
// (evaluator.zeroFeedInTick), ohne Timer.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createScheduleEvaluator } from '../schedule-eval.js';

const ADDR = { pct: 40242, rvrt: 40244, ena: 40246, out: 40365 };

function makeState({ soc = 96, socFresh = true, importW = 0, exportW = 0, loadW = 1000, meterOk = true, blocked = true } = {}) {
  return {
    victron: {
      soc,
      gridImportW: importW,
      gridExportW: exportW,
      selfConsumptionW: loadW,
      fieldUpdatedAt: socFresh ? { soc: Date.now() } : {}
    },
    meter: { ok: meterOk, updatedAt: meterOk ? Date.now() : Date.now() - 60000, grid_total_w: importW - exportW },
    ctrl: { _lastDvFeedIn: blocked ? false : true },
    schedule: { rules: [], active: {}, lastWrite: {}, manualOverride: {}, config: {}, lastEvalAt: 0 }
  };
}

function makeTransport() {
  return {
    type: 'modbus',
    writes: [],
    async mbWriteSingle({ address, value }) { this.writes.push({ address, value }); },
    async mbWriteMultiple({ address, values }) { this.writes.push({ address, values }); },
    // Readback (Drift-Diagnose) — liefert den zuletzt geschriebenen pct-Rohwert.
    async mbRequest({ address }) {
      const last = [...this.writes].reverse().find((w) => w.address === address);
      return [last ? last.value : 0];
    }
  };
}

function makeCfg({ zeroFeedInEnabled = true, resolved = true, userCfg = {} } = {}) {
  const addr = (a) => (resolved ? a : null);
  return {
    optimizer: { inverterMaxPowerW: 10000 },
    victron: { telemetryMaxAgeMs: 90000 },
    zeroFeedIn: userCfg,
    controlWrite: {
      outWRte: { enabled: true, fc: 6, address: addr(ADDR.out), writeType: 'int16', scale: 0.01, offset: 0, sunspec: { model: 124, offset: 10 } },
      wMaxLimPct: { enabled: true, fc: 6, address: addr(ADDR.pct), writeType: 'uint16', scale: 0.01, offset: 0, sunspec: { model: 123, offset: 3 } },
      wMaxLimPctRvrtTms: { enabled: true, fc: 6, address: addr(ADDR.rvrt), writeType: 'uint16', scale: 1, offset: 0, sunspec: { model: 123, offset: 5 } },
      wMaxLimEna: { enabled: true, fc: 6, address: addr(ADDR.ena), writeType: 'uint16', scale: 1, offset: 0, sunspec: { model: 123, offset: 7 } }
    },
    dvControl: {
      enabled: true,
      zeroFeedIn: { enabled: zeroFeedInEnabled }
    }
  };
}

function makeHarness(stateOpts = {}, cfgOpts = {}) {
  const state = makeState(stateOpts);
  const cfg = makeCfg(cfgOpts);
  const transport = makeTransport();
  const logs = [];
  const evaluator = createScheduleEvaluator({
    state, getCfg: () => cfg, transport,
    pushLog: (ev, data) => logs.push({ ev, data }),
    telemetrySafeWrite: () => {}, persistConfig: async () => {},
    telemetryStore: null, epexNowNext: () => null
  });
  return { evaluator, state, cfg, transport, logs };
}

// Enter braucht blockedStreak >= 2 (Race-Schutz gegen die Freigabe-Sequenz) —
// zwei Ticks fahren den Deckel hoch.
async function tickUntilEnter(evaluator) {
  await evaluator.zeroFeedInTick();
  await evaluator.zeroFeedInTick();
}

test('no-op: Profil ohne zeroFeedIn-Feature schreibt nichts', async () => {
  const { evaluator, transport } = makeHarness({}, { zeroFeedInEnabled: false });
  await tickUntilEnter(evaluator);
  assert.deepEqual(transport.writes, []);
});

test('no-op: ohne aktive Sperre (feedIn=true) schreibt nichts', async () => {
  const { evaluator, transport } = makeHarness({ blocked: false });
  await tickUntilEnter(evaluator);
  assert.deepEqual(transport.writes, []);
});

test('no-op: SunSpec-Scan noch nicht aufgelöst (address null) schreibt nichts', async () => {
  const { evaluator, transport } = makeHarness({}, { resolved: false });
  await tickUntilEnter(evaluator);
  assert.deepEqual(transport.writes, []);
});

test('Enter bei SoC >= Schwelle: Akku-Freigabe + RvrtTms + Limit=Hauslast + Ena', async () => {
  const { evaluator, state, transport, logs } = makeHarness({ soc: 96, loadW: 1000 });
  await tickUntilEnter(evaluator);
  // Reihenfolge: OutWRte=+100 % (raw 10000, Akku darf mithelfen) → RvrtTms=300 →
  // WMaxLimPct=(1000−50)/10000 = 9,5 % (raw 950) → Ena=1.
  assert.deepEqual(transport.writes.slice(0, 4), [
    { address: ADDR.out, value: 10000 },
    { address: ADDR.rvrt, value: 300 },
    { address: ADDR.pct, value: 950 },
    { address: ADDR.ena, value: 1 }
  ]);
  assert.equal(state.ctrl._zfi.capActive, true);
  assert.equal(logs.some((l) => l.ev === 'zero_feedin_cap_on' && l.data.trigger === 'soc'), true);
});

test('kein Enter im ersten blocked-Tick (Race-Schutz blockedStreak)', async () => {
  const { evaluator, transport } = makeHarness({ soc: 96 });
  await evaluator.zeroFeedInTick();
  assert.deepEqual(transport.writes, []);
});

test('kein Enter bei stale/fehlendem SoC (nie gepollt != frisch)', async () => {
  const { evaluator, transport } = makeHarness({ soc: 96, socFresh: false });
  await tickUntilEnter(evaluator);
  assert.deepEqual(transport.writes, []);
});

test('Export-Trigger: Enter auch unter der SoC-Schwelle nach 3 Export-Ticks', async () => {
  const { evaluator, state, transport, logs } = makeHarness({ soc: 80, exportW: 300, loadW: 800 });
  await evaluator.zeroFeedInTick();
  await evaluator.zeroFeedInTick();
  assert.deepEqual(transport.writes, []); // Streak 2 < 3
  await evaluator.zeroFeedInTick();
  assert.equal(state.ctrl._zfi.capActive, true);
  assert.equal(logs.some((l) => l.ev === 'zero_feedin_cap_on' && l.data.trigger === 'export'), true);
});

test('Regelung: Export über Deadband senkt das Limit, Bezug hebt es', async () => {
  const { evaluator, state, transport } = makeHarness({ soc: 96, loadW: 1000 });
  await tickUntilEnter(evaluator);
  const startPct = state.ctrl._zfi.limitPct; // 9.5

  // Export 500 W (err = 50 − (−500) = 550 > Deadband) → Limit sinkt um 0,7·550/10000·100 = 3,85 %.
  state.victron.gridExportW = 500;
  state.victron.gridImportW = 0;
  await evaluator.zeroFeedInTick();
  assert.ok(state.ctrl._zfi.limitPct < startPct - 3.8 && state.ctrl._zfi.limitPct > startPct - 3.9);

  // Bezug 400 W (err = 50 − 400 = −350) → Limit steigt um 2,45 %.
  const afterDrop = state.ctrl._zfi.limitPct;
  state.victron.gridExportW = 0;
  state.victron.gridImportW = 400;
  await evaluator.zeroFeedInTick();
  assert.ok(state.ctrl._zfi.limitPct > afterDrop + 2.4 && state.ctrl._zfi.limitPct < afterDrop + 2.5);

  // Jeder aktive Tick refresht pct + ena (RvrtTms-Fenster / Re-Assert).
  const last2 = transport.writes.slice(-2);
  assert.equal(last2[0].address, ADDR.pct);
  assert.deepEqual(last2[1], { address: ADDR.ena, value: 1 });
});

test('Regelung: innerhalb Deadband bleibt das Limit stehen, Writes refreshen trotzdem', async () => {
  const { evaluator, state, transport } = makeHarness({ soc: 96, loadW: 1000, importW: 60 });
  await tickUntilEnter(evaluator);
  const pct = state.ctrl._zfi.limitPct;
  const n = transport.writes.length;
  await evaluator.zeroFeedInTick(); // err = 50−60 = −10, |err| < 50
  assert.equal(state.ctrl._zfi.limitPct, pct);
  assert.equal(transport.writes.length, n + 2); // pct + ena
});

test('Meter-Ausfall im Deckel: Limit friert ein, Failsafe-Refresh läuft weiter', async () => {
  const { evaluator, state, transport } = makeHarness({ soc: 96, loadW: 1000 });
  await tickUntilEnter(evaluator);
  const pct = state.ctrl._zfi.limitPct;
  state.meter.ok = false;
  state.victron.gridExportW = 2000; // dürfte NICHT mehr einfließen (stale)
  const n = transport.writes.length;
  await evaluator.zeroFeedInTick();
  assert.equal(state.ctrl._zfi.limitPct, pct);
  assert.equal(transport.writes.length, n + 2);
});

test('Exit bei SoC <= Schwelle − Hysterese: Force-Charge zurück, Deckel aus', async () => {
  const { evaluator, state, transport, logs } = makeHarness({ soc: 96, loadW: 1000 });
  await tickUntilEnter(evaluator);
  state.victron.soc = 90; // 95 − 5
  state.victron.fieldUpdatedAt.soc = Date.now();
  await evaluator.zeroFeedInTick();
  // Reihenfolge: erst OutWRte=−100 % (raw 55536, Force-Charge scharf), dann Ena=0.
  assert.deepEqual(transport.writes.slice(-2), [
    { address: ADDR.out, value: 55536 },
    { address: ADDR.ena, value: 0 }
  ]);
  assert.equal(state.ctrl._zfi.capActive, false);
  assert.equal(logs.some((l) => l.ev === 'zero_feedin_cap_off' && l.data.reason === 'soc_recovered'), true);
});

test('Freigabe (feedIn=true): nur Ena=0, OutWRte bleibt der restore-Sequenz überlassen', async () => {
  const { evaluator, state, transport, logs } = makeHarness({ soc: 96, loadW: 1000 });
  await tickUntilEnter(evaluator);
  state.ctrl._lastDvFeedIn = true; // Freigabe-Sequenz ist gelaufen
  const n = transport.writes.length;
  await evaluator.zeroFeedInTick();
  assert.deepEqual(transport.writes.slice(n), [{ address: ADDR.ena, value: 0 }]);
  assert.equal(state.ctrl._zfi.capActive, false);
  assert.equal(logs.some((l) => l.ev === 'zero_feedin_cap_off' && l.data.reason === 'feedin_restored'), true);
});

test('einstellbare Schwelle: socThresholdPct 90 greift bei SoC 91', async () => {
  const { evaluator, state } = makeHarness(
    { soc: 91, loadW: 1000 },
    { userCfg: { socThresholdPct: 90 } }
  );
  await tickUntilEnter(evaluator);
  assert.equal(state.ctrl._zfi.capActive, true);
});
