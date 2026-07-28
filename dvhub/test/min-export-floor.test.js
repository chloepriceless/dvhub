import test from 'node:test';
import assert from 'node:assert/strict';

import { createScheduleEvaluator, minExportFloorW } from '../schedule-eval.js';

// Issue #12 (VdwBM, 2026-07-21) — Mindesteinspeisung.
//
// Kontrakt: ein konfigurierbarer Boden hält den gridSetpointW dauerhaft auf
// einer kleinen Einspeisung, damit Lastsprünge nicht sofort Netzbezug erzeugen.
// Der Boden VERSTÄRKT nur; er darf niemals
//   - einen stärkeren Export abschwächen,
//   - ein gewolltes Netzladen (positiver Sollwert) umdrehen,
//   - bei negativem ODER unbekanntem Preis Export erzwingen (fail-safe),
//   - eine Schutzmaßnahme (§51-Abregelung, SoC-Floor, Not-Halt) überschreiben,
//   - den Akku unter den harten SoC-Boden ziehen (T-0075 hat Vorrang).

function makeCtx(overrides = {}) {
  const logs = [];
  const writes = [];

  const state = {
    victron: {
      soc: 50,
      batteryDischargeW: 0,
      batteryChargeW: 0,
      batteryPowerW: 0,
      pvTotalW: 0,
      pvPowerW: 0
    },
    schedule: {
      rules: [],
      active: {},
      lastWrite: {},
      manualOverride: {},
      config: { defaultGridSetpointW: -40, defaultChargeCurrentA: null, defaultFeedExcessDcPv: 1 },
      lastEvalAt: 0
    },
    ctrl: { negativePriceActive: false, forcedOff: false },
    epex: { data: [] }
  };

  const cfg = {
    controlWrite: {
      gridSetpointW: { enabled: true, address: 100 },
      chargeCurrentA: { enabled: false }
    },
    dvControl: { enabled: false, negativePriceProtection: { enabled: true, gridSetpointW: -40 } },
    // allowGridDischarge:true, damit negative Sollwerte das EEG/§14a-Gate passieren.
    optimizer: { enabled: false, allowGridCharge: false, allowGridDischarge: true, hardFloorSocPct: 5 },
    dcExportMode: {},
    schedule: {
      timezone: 'Europe/Berlin',
      manualOverrideTtlMs: 300000,
      controlKeepaliveMs: 0,
      minExportW: 300,
      smallMarketAutomation: { enabled: false }
    }
  };

  let price = { ct_kwh: 12, eur_mwh: 120 };

  const ctx = {
    state,
    getCfg: () => cfg,
    transport: {
      type: 'mqtt',
      mqttWrite: async (target, value) => { writes.push({ target, value }); }
    },
    pushLog: (event, payload) => { logs.push({ event, payload: payload || {} }); },
    telemetrySafeWrite: (fn) => { try { fn?.(); } catch { /* no-op */ } },
    persistConfig: async () => {},
    telemetryStore: null,
    epexNowNext: () => (price === null ? undefined : { current: price, next: null }),
    regenerateSmallMarketAutomationRules: async () => {},
    onEvalComplete: () => {}
  };

  const setPrice = (p) => { price = p; };
  if (typeof overrides.mutate === 'function') overrides.mutate({ state, cfg, ctx, setPrice });

  const evaluator = createScheduleEvaluator(ctx);
  return { evaluator, state, cfg, logs, writes, setPrice };
}

const gridWrites = (writes) => writes.filter((w) => w.target === 'gridSetpointW');
const lastGrid = (writes) => gridWrites(writes).at(-1)?.value;

// --- reine Helper-Funktion ----------------------------------------------------

test('minExportFloorW: positive Watt werden zum negativen Setpoint-Boden', () => {
  assert.equal(minExportFloorW({ schedule: { minExportW: 300 } }), -300);
  assert.equal(minExportFloorW({ schedule: { minExportW: 1250.4 } }), -1250);
});

test('minExportFloorW: 0/leer/ungültig = aus (null)', () => {
  assert.equal(minExportFloorW({ schedule: { minExportW: 0 } }), null);
  assert.equal(minExportFloorW({ schedule: {} }), null);
  assert.equal(minExportFloorW({}), null);
  assert.equal(minExportFloorW(undefined), null);
  assert.equal(minExportFloorW({ schedule: { minExportW: 'abc' } }), null);
  // Negative Eingabe wäre eine Vorzeichen-Verwechslung des Bedieners und würde,
  // naiv negiert, Netzbezug erzwingen → wird als "aus" behandelt, nicht gedreht.
  assert.equal(minExportFloorW({ schedule: { minExportW: -300 } }), null);
});

// --- Grundverhalten -----------------------------------------------------------

test('Default (0) = aus: Sollwert 0 bleibt 0', async () => {
  const { evaluator, writes } = makeCtx({ mutate: ({ cfg }) => { cfg.schedule.minExportW = 0; } });
  await evaluator.applyControlTarget('gridSetpointW', 0, 'rule:test');
  assert.equal(lastGrid(writes), 0);
});

test('Sollwert 0 wird auf die Mindesteinspeisung angehoben', async () => {
  const { evaluator, writes, logs } = makeCtx();
  await evaluator.applyControlTarget('gridSetpointW', 0, 'rule:test');
  assert.equal(lastGrid(writes), -300);
  const log = logs.find((l) => l.event === 'min_export_floor');
  assert.ok(log, 'min_export_floor wird protokolliert');
  assert.equal(log.payload.requested, 0);
  assert.equal(log.payload.floorW, -300);
});

test('schwächerer Export (-100) wird auf den Boden verstärkt', async () => {
  const { evaluator, writes } = makeCtx();
  await evaluator.applyControlTarget('gridSetpointW', -100, 'rule:test');
  assert.equal(lastGrid(writes), -300);
});

test('stärkerer Export (-3000) bleibt unangetastet', async () => {
  const { evaluator, writes } = makeCtx();
  await evaluator.applyControlTarget('gridSetpointW', -3000, 'eos_optimization');
  assert.equal(lastGrid(writes), -3000);
});

test('gewolltes Netzladen (positiver Sollwert) wird NICHT in Export gedreht', async () => {
  const { evaluator, writes } = makeCtx({
    mutate: ({ cfg }) => { cfg.optimizer.allowGridCharge = true; }
  });
  await evaluator.applyControlTarget('gridSetpointW', 2000, 'eos_optimization');
  assert.equal(lastGrid(writes), 2000);
});

// --- Preis-Gates (fail-safe) --------------------------------------------------

test('negativer Preis: kein erzwungener Export', async () => {
  const { evaluator, writes, setPrice } = makeCtx();
  setPrice({ ct_kwh: -2.5, eur_mwh: -25 });
  await evaluator.applyControlTarget('gridSetpointW', 0, 'rule:test');
  assert.equal(lastGrid(writes), 0);
});

test('UNBEKANNTER Preis: kein erzwungener Export (fail-safe, nicht fail-open)', async () => {
  const { evaluator, writes, setPrice } = makeCtx();
  setPrice(null); // epexNowNext() liefert undefined — Feed-Ausfall
  await evaluator.applyControlTarget('gridSetpointW', 0, 'rule:test');
  assert.equal(lastGrid(writes), 0);
});

test('Preis 0,0 ct gilt als "nicht negativ" — Boden greift', async () => {
  const { evaluator, writes, setPrice } = makeCtx();
  setPrice({ ct_kwh: 0, eur_mwh: 0 });
  await evaluator.applyControlTarget('gridSetpointW', 0, 'rule:test');
  assert.equal(lastGrid(writes), -300);
});

test('kaputter Preis-Datensatz (ct_kwh nicht numerisch) = unbekannt, kein Export', async () => {
  const { evaluator, writes, setPrice } = makeCtx();
  setPrice({ ct_kwh: 'n/a' });
  await evaluator.applyControlTarget('gridSetpointW', 0, 'rule:test');
  assert.equal(lastGrid(writes), 0);
});

test('epexNowNext wirft: unbekannt statt Absturz', async () => {
  const { evaluator, writes } = makeCtx({
    mutate: ({ ctx }) => { ctx.epexNowNext = () => { throw new Error('feed down'); }; }
  });
  await evaluator.applyControlTarget('gridSetpointW', 0, 'rule:test');
  assert.equal(lastGrid(writes), 0);
});

// --- Vorrang von Schutzmaßnahmen ---------------------------------------------

test('aktive Negativpreis-Abregelung: Boden bleibt aus', async () => {
  const { evaluator, writes } = makeCtx({
    mutate: ({ state }) => { state.ctrl.negativePriceActive = true; }
  });
  await evaluator.applyControlTarget('gridSetpointW', 0, 'rule:test');
  assert.equal(lastGrid(writes), 0);
});

test('Pflicht-Quelle §51 (negative_price_protection) wird nicht angehoben', async () => {
  const { evaluator, writes } = makeCtx();
  await evaluator.applyControlTarget('gridSetpointW', 0, 'negative_price_protection');
  assert.equal(lastGrid(writes), 0);
});

test('Pflicht-Quelle SoC-Floor (manual_override_soc_floor) wird nicht angehoben', async () => {
  const { evaluator, writes } = makeCtx();
  await evaluator.applyControlTarget('gridSetpointW', 0, 'manual_override_soc_floor');
  assert.equal(lastGrid(writes), 0);
});

test('sell_price_floor hält bewusst auf dem Default — Boden bleibt aus', async () => {
  const { evaluator, writes } = makeCtx();
  await evaluator.applyControlTarget('gridSetpointW', 0, 'sell_price_floor');
  assert.equal(lastGrid(writes), 0);
});

test('Not-Halt: diskretionärer Write bleibt geblockt, der Boden hebelt ihn nicht aus', async () => {
  const { evaluator, writes, state } = makeCtx({
    mutate: ({ state: s }) => { s.ctrl.discretionaryWritesPaused = true; }
  });
  const res = await evaluator.applyControlTarget('gridSetpointW', 0, 'rule:test');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'emergency_stop_active');
  assert.equal(gridWrites(writes).length, 0);
  assert.equal(state.ctrl.discretionaryWritesPaused, true);
});

test('T-0075 hat Vorrang: bei SoC am harten Boden wird auf 0 gehalten', async () => {
  const { evaluator, writes, logs } = makeCtx({
    mutate: ({ state }) => { state.victron.soc = 4; }
  });
  await evaluator.applyControlTarget('gridSetpointW', 0, 'rule:test');
  assert.equal(lastGrid(writes), 0, 'kein Export unter dem harten SoC-Boden');
  const floorLog = logs.find((l) => l.event === 'control_discharge_floor');
  assert.ok(floorLog, 'der Entlade-Boden meldet sich');
  assert.equal(floorLog.payload.reason, 'below_hard_floor');
});

test('T-0075 hat Vorrang: unbekannter SoC hält ebenfalls auf 0', async () => {
  const { evaluator, writes } = makeCtx({
    mutate: ({ state }) => { state.victron.soc = null; }
  });
  await evaluator.applyControlTarget('gridSetpointW', 0, 'rule:test');
  assert.equal(lastGrid(writes), 0);
});

// --- Protokoll-Hygiene --------------------------------------------------------

test('Log ist gedrosselt: gleiche Quelle + gleicher Boden meldet sich nur einmal', async () => {
  const { evaluator, logs } = makeCtx();
  await evaluator.applyControlTarget('gridSetpointW', 0, 'rule:test');
  await evaluator.applyControlTarget('gridSetpointW', -50, 'rule:test');
  await evaluator.applyControlTarget('gridSetpointW', -120, 'rule:test');
  assert.equal(logs.filter((l) => l.event === 'min_export_floor').length, 1);
});

test('geänderter Boden meldet sich erneut', async () => {
  const { evaluator, cfg, logs } = makeCtx();
  await evaluator.applyControlTarget('gridSetpointW', 0, 'rule:test');
  cfg.schedule.minExportW = 500;
  await evaluator.applyControlTarget('gridSetpointW', 0, 'rule:test');
  const entries = logs.filter((l) => l.event === 'min_export_floor');
  assert.equal(entries.length, 2);
  assert.equal(entries.at(-1).payload.floorW, -500);
});
