// test/multi-gx-floor-handoff.test.js -- Einspeisung aus Akku 2, wenn Akku 1 am
// harten Boden steht (Chrissi 22.10.2026: „entscheidung b richtiger … muss man
// es explizit in den einstellungen aktivieren“).
//
// Kontrakt:
//  - Schalter aus (Standard) → der Boden haelt wie bisher (Sollwert 0).
//  - Schalter an → erst 2704 der Hauptanlage sichern und 0 schreiben; der
//    Einspeise-Sollwert geht erst durch, wenn 2704 = 0 frisch zurueckkommt.
//  - Faellt eine Bedingung weg → sofort wieder Boden; 2704 zurueck erst 3 Punkte
//    ueber dem Boden; die Sicherung uebersteht einen Neustart.
//  - Nie bei unbekanntem/veraltetem/eingefrorenem Ladestand der Hauptanlage.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createFloorHandoff } from '../services/multi-gx/floor-handoff.js';
import { createScheduleEvaluator } from '../schedule-eval.js';
import { createMultiGx } from '../services/multi-gx/index.js';

function memoryStore(initial = null) {
  let value = initial;
  return { load: () => value, save: (v) => { value = { ...v }; }, clear: () => { value = null; }, get: () => value };
}

function makeWorld({ option = true, mainSoc = 4, mainMaxDischargeW = -1, follower = {}, ctrl = {}, store = memoryStore() } = {}) {
  let t = 1_000_000;
  const cfg = {
    updateChannel: 'dev',
    victron: { telemetryMaxAgeMs: 90000 },
    optimizer: { hardFloorSocPct: 5 },
    controlWrite: { maxDischargeW: { enabled: true } },
    multiGx: { enabled: true, host: '192.168.1.20', minSocPct: 10, exportHandoffAtFloor: option }
  };
  const state = {
    victron: { soc: mainSoc, maxDischargeW: mainMaxDischargeW, fieldUpdatedAt: { soc: t, maxDischargeW: t } },
    multiGx: { online: true, socPct: 80, minSocPct: 10, updatedAt: t, ...follower },
    ctrl: { discretionaryWritesPaused: false, forcedOff: false, negativePriceActive: false, ...ctrl },
    schedule: { lastWrite: {} }
  };
  const logs = [];
  const applied = [];
  const handoff = createFloorHandoff({ getCfg: () => cfg, state, pushLog: (e, d) => logs.push([e, d]), now: () => t, store });
  // Attrappe des Schreibpfads: haelt wie der echte Boden jeden Nicht-0-Wert bei soc <= Boden.
  async function apply(target, value, source) {
    let v = value;
    if (target === 'maxDischargeW' && v !== 0 && Number(state.victron.soc) <= cfg.optimizer.hardFloorSocPct) v = 0;
    applied.push({ target, value: v, source });
    state.schedule.lastWrite[target] = { value: v, at: t };
    return { ok: true };
  }
  const advance = (ms) => {
    t += ms;
    state.victron.fieldUpdatedAt.soc = t;
    state.victron.fieldUpdatedAt.maxDischargeW = t;
    state.multiGx.updatedAt = t;
  };
  return { cfg, state, logs, applied, handoff, apply, advance, store, now: () => t };
}

const request = (w, value = -3000) => w.handoff.onFloorHold({ target: 'gridSetpointW', requested: value });

test('Schalter aus: der Boden haelt, nichts wird gesperrt', async () => {
  const w = makeWorld({ option: false });
  assert.equal(request(w), null);
  await w.handoff.maintain(w.apply);
  assert.equal(w.applied.length, 0);
  assert.equal(w.state.multiGxHandoff.phase, 'off');
});

test('an: erst 2704 sichern und 0 schreiben, dann Einspeise-Sollwert durchlassen', async () => {
  const w = makeWorld();
  assert.equal(request(w), null, 'erster Takt: Boden haelt noch');
  assert.equal(w.state.multiGxHandoff.phase, 'arming');
  assert.deepEqual(w.store.get().savedMaxDischargeW, -1, 'Ausgangswert gesichert');
  await w.handoff.maintain(w.apply);
  assert.deepEqual(w.applied, [{ target: 'maxDischargeW', value: 0, source: 'multi_gx_handoff' }]);
  // Hauptanlage meldet 0 zurueck
  w.state.victron.maxDischargeW = 0;
  w.advance(5000);
  assert.equal(request(w), -3000, 'jetzt geht die Einspeisung durch');
  assert.equal(w.state.multiGxHandoff.phase, 'active');
  await w.handoff.maintain(w.apply);
  assert.equal(w.state.multiGxHandoff.mainDischargeBlocked, true);
  assert.equal(w.applied.length, 1, 'keine weiteren 2704-Schreibvorgaenge');
});

test('nur Einspeisung, nur gridSetpointW: Laden und andere Ziele bleiben unberuehrt', () => {
  const w = makeWorld();
  assert.equal(request(w, 2000), null);
  assert.equal(w.handoff.onFloorHold({ target: 'chargeCurrentA', requested: -10 }), null);
  assert.equal(w.state.multiGxHandoff.phase, 'off');
});

test('2704 unbekannt oder veraltet: kein Sperren, Boden haelt', () => {
  const w = makeWorld({ mainMaxDischargeW: null });
  assert.equal(request(w), null);
  assert.equal(w.state.multiGxHandoff.phase, 'off');
  const w2 = makeWorld();
  w2.state.victron.fieldUpdatedAt.maxDischargeW = w2.now() - 200000;
  assert.equal(request(w2), null);
  assert.equal(w2.state.multiGxHandoff.phase, 'off');
});

for (const [name, patch, reason] of [
  ['zweite Anlage offline', (w) => { w.state.multiGx.online = false; }, 'follower_offline'],
  ['zweite Anlage veraltet', (w) => { w.state.multiGx.updatedAt = w.now() - 60000; }, 'follower_stale'],
  ['zweite Anlage leer', (w) => { w.state.multiGx.socPct = 11; }, 'follower_empty'],
  ['Not-Halt', (w) => { w.state.ctrl.discretionaryWritesPaused = true; }, 'emergency_stop'],
  ['negativer Preis', (w) => { w.state.ctrl.negativePriceActive = true; }, 'export_blocked'],
  ['Direktvermarkter-Abregelung', (w) => { w.state.ctrl.forcedOff = true; }, 'export_blocked'],
  ['Schalter wieder aus', (w) => { w.cfg.multiGx.exportHandoffAtFloor = false; }, 'disabled'],
]) {
  test(`aktiv, dann ${name}: sofort wieder Boden, Akku 1 bleibt gesperrt bis 3 Punkte ueber dem Boden`, async () => {
    const w = makeWorld();
    request(w); await w.handoff.maintain(w.apply);
    w.state.victron.maxDischargeW = 0; w.advance(5000);
    assert.equal(request(w), -3000);
    patch(w);
    await w.handoff.maintain(w.apply);
    assert.equal(w.state.multiGxHandoff.phase, 'restoring');
    assert.equal(w.state.multiGxHandoff.reason, reason);
    assert.equal(request(w), null, 'Boden haelt wieder');
    // Akku 1 bei 4 % bzw. 7 %: noch nicht zuruecksetzen
    await w.handoff.maintain(w.apply);
    w.state.victron.soc = 7; w.advance(5000);
    await w.handoff.maintain(w.apply);
    assert.equal(w.applied.filter((a) => a.source === 'multi_gx_handoff_restore').length, 0);
    assert.equal(w.state.multiGxHandoff.mainDischargeBlocked, true);
    // 9 % > 5 + 3 → alter Wert zurueck, Datei weg
    w.state.victron.soc = 9; w.advance(5000);
    await w.handoff.maintain(w.apply);
    assert.deepEqual(w.applied.at(-1), { target: 'maxDischargeW', value: -1, source: 'multi_gx_handoff_restore' });
    assert.equal(w.state.multiGxHandoff.phase, 'off');
    assert.equal(w.store.get(), null);
  });
}

test('keine Einspeise-Anfrage mehr (Plan-Ende): nach 20 s beenden', async () => {
  const w = makeWorld();
  request(w); await w.handoff.maintain(w.apply);
  w.state.victron.maxDischargeW = 0; w.advance(5000);
  request(w);
  w.advance(15000); await w.handoff.maintain(w.apply);
  assert.equal(w.state.multiGxHandoff.phase, 'active');
  w.advance(10000); await w.handoff.maintain(w.apply);
  assert.equal(w.state.multiGxHandoff.phase, 'restoring');
  assert.equal(w.state.multiGxHandoff.reason, 'no_export_request');
});

test('Neustart waehrend der Sperre: gesicherter Wert wird zurueckgeschrieben', async () => {
  const store = memoryStore({ savedMaxDischargeW: 4000, at: 1 });
  const w = makeWorld({ store, mainSoc: 30, mainMaxDischargeW: 0 });
  assert.equal(w.state.multiGxHandoff.phase, 'restoring');
  await w.handoff.maintain(w.apply);
  assert.deepEqual(w.applied, [{ target: 'maxDischargeW', value: 4000, source: 'multi_gx_handoff_restore' }]);
  assert.equal(w.state.multiGxHandoff.phase, 'off');
  assert.equal(store.get(), null);
});

test('2704 liest schon 0: nicht als gesperrt werten — DVhub schreibt die 0 selbst, zurueck kommt unbegrenzt', async () => {
  // Ob die GX „unbegrenzt“ als 0 meldet, ist ungeprueft; eine gelesene 0 darf
  // die Einspeisung deshalb nicht sofort freigeben.
  const w = makeWorld({ mainMaxDischargeW: 0 });
  assert.equal(request(w), null);
  assert.equal(w.store.get().savedMaxDischargeW, -1);
  w.advance(5000);
  assert.equal(request(w), null, 'ohne eigenes Schreiben kein Durchlassen');
  await w.handoff.maintain(w.apply);
  assert.deepEqual(w.applied, [{ target: 'maxDischargeW', value: 0, source: 'multi_gx_handoff' }]);
  w.advance(5000);
  assert.equal(request(w), -3000);
  w.cfg.multiGx.exportHandoffAtFloor = false;
  w.state.victron.soc = 20; w.advance(5000);
  await w.handoff.maintain(w.apply);
  assert.deepEqual(w.applied.at(-1), { target: 'maxDischargeW', value: -1, source: 'multi_gx_handoff_restore' });
  assert.equal(w.state.multiGxHandoff.phase, 'off');
});

test('Schreiben der Sperre scheitert: kein Durchlassen, neuer Versuch nach 10 s', async () => {
  const w = makeWorld();
  request(w);
  let fail = true;
  const apply = async (target, value, source) => {
    w.applied.push({ target, value, source });
    return fail ? { ok: false, error: 'timeout' } : { ok: true };
  };
  await w.handoff.maintain(apply);
  w.state.victron.maxDischargeW = 0; w.advance(5000);
  assert.equal(request(w), null, 'Sperre nicht bestaetigt geschrieben');
  await w.handoff.maintain(apply);
  assert.equal(w.applied.length, 1, 'erst nach 10 s erneut');
  fail = false; w.advance(5000);
  await w.handoff.maintain(apply);
  assert.equal(w.applied.length, 2);
  w.advance(5000);
  assert.equal(request(w), -3000);
});

test('Profil Victron: 2704 wird mit 10-W-Skala und Sonderwerten zurueckgelesen', async () => {
  const fs = await import('node:fs');
  const profile = JSON.parse(fs.readFileSync(new URL('../hersteller/victron.json', import.meta.url), 'utf8'));
  const point = profile.points.maxDischargeW;
  const write = profile.controlWrite.maxDischargeW;
  assert.equal(point.enabled, true);
  assert.equal(point.address, 2704);
  assert.equal(point.signed, true);
  assert.equal(point.scale, write.scale, 'gleiche Skala wie beim Schreiben');
  assert.deepEqual(point.rawSentinels, [-1, 0], 'wie in test/max-discharge-scale.test.js');
  assert.deepEqual(point.rawSentinelMap, write.rawSentinelMap);
});

// --- Einbindung in den Entlade-Boden (schedule-eval applyControlTarget) ---

function evaluatorWorld({ option = true, soc = 4, socFresh = true } = {}) {
  const writes = [];
  const logs = [];
  const now = Date.now();
  const state = {
    victron: { soc, maxDischargeW: -1, fieldUpdatedAt: { soc: socFresh ? now : now - 600000, maxDischargeW: now } },
    multiGx: { online: true, socPct: 80, minSocPct: 10, updatedAt: now },
    schedule: { rules: [], active: {}, lastWrite: {}, manualOverride: {}, config: {}, lastEvalAt: 0 },
    ctrl: { negativePriceActive: false, forcedOff: false },
    epex: { data: [] }
  };
  const cfg = {
    updateChannel: 'dev',
    controlWrite: { gridSetpointW: { enabled: true, address: 2700 }, maxDischargeW: { enabled: true, address: 2704 } },
    dvControl: { enabled: false },
    optimizer: { enabled: false, allowGridDischarge: true, hardFloorSocPct: 5 },
    victron: { telemetryMaxAgeMs: 90000 },
    dcExportMode: {},
    schedule: { timezone: 'Europe/Berlin', controlKeepaliveMs: 0, smallMarketAutomation: { enabled: false } },
    multiGx: { enabled: true, host: '192.168.1.20', minSocPct: 10, exportHandoffAtFloor: option }
  };
  const ctx = {
    state, getCfg: () => cfg,
    transport: { type: 'mqtt', mqttWrite: async (target, value) => { writes.push({ target, value }); } },
    pushLog: (event, payload) => logs.push({ event, payload }),
    telemetrySafeWrite: () => {}, persistConfig: async () => {}, telemetryStore: null,
    epexNowNext: () => ({ current: { ct_kwh: 20, eur_mwh: 200 }, next: null }),
    regenerateSmallMarketAutomationRules: async () => {}, onEvalComplete: () => {},
    floorHandoffStore: memoryStore()
  };
  const ev = createScheduleEvaluator(ctx);
  return { ev, state, cfg, writes, logs };
}

test('Entlade-Boden ohne Schalter: Einspeise-Sollwert am Boden wird 0 (unveraendert)', async () => {
  const w = evaluatorWorld({ option: false });
  await w.ev.applyControlTarget('gridSetpointW', -3000, 'rule:eos');
  assert.deepEqual(w.writes, [{ target: 'gridSetpointW', value: 0 }]);
  assert.ok(w.logs.some((l) => l.event === 'control_discharge_floor' && l.payload.reason === 'below_hard_floor'));
});

test('Entlade-Boden mit Schalter: erst Sperre, dann Einspeisung aus Akku 2', async () => {
  const w = evaluatorWorld();
  await w.ev.applyControlTarget('gridSetpointW', -3000, 'rule:eos');
  assert.deepEqual(w.writes, [{ target: 'gridSetpointW', value: 0 }], 'vor der Sperre haelt der Boden');
  await w.ev.floorHandoff.maintain(w.ev.applyControlTarget);
  assert.deepEqual(w.writes.at(-1), { target: 'maxDischargeW', value: 0 }, 'Akku 1 gesperrt');
  w.state.victron.maxDischargeW = 0;
  w.state.victron.fieldUpdatedAt.maxDischargeW = Date.now();
  await w.ev.applyControlTarget('gridSetpointW', -3000, 'rule:eos');
  assert.deepEqual(w.writes.at(-1), { target: 'gridSetpointW', value: -3000 });
});

test('Entlade-Boden mit Schalter, aber Ladestand veraltet: Boden haelt, keine Sperre', async () => {
  const w = evaluatorWorld({ socFresh: false });
  await w.ev.applyControlTarget('gridSetpointW', -3000, 'rule:eos');
  await w.ev.floorHandoff.maintain(w.ev.applyControlTarget);
  assert.deepEqual(w.writes, [{ target: 'gridSetpointW', value: 0 }]);
  assert.equal(w.state.multiGxHandoff.phase, 'off');
});

// --- Seite der zweiten Anlage (multi-gx/index.js) ---

test('zweite Anlage: Akku 1 gesperrt → sie traegt den ganzen Einspeisebedarf', async () => {
  const regs = { 843: 80, 842: 0, 2901: 100, 820: 0, 821: 0, 822: 0 };
  const writesMgx = [];
  const transport = {
    async mbRequest(req) { return Array.from({ length: req.quantity || 1 }, (_, i) => regs[req.address + i] ?? 0); },
    async mbWriteMultiple(req) { writesMgx.push(req); return {}; }
  };
  const cfg = {
    updateChannel: 'dev', gridPositiveMeans: 'grid_import',
    optimizer: { batteryCapacityWh: 10000, maxSocPct: 100, maxDischargeW: 5000 },
    multiGx: { enabled: true, host: '192.168.1.20', port: 502, unitId: 100, batteryCapacityWh: 10000,
      maxChargeW: 10000, maxDischargeW: 10000, minSocPct: 10, rampWPerS: 5000, deadbandW: 0 }
  };
  let t = 0;
  const state = {
    // Akku 1 bei 4 %, Mindest-SoC 0 (Victron), gesperrt: keine Akkuleistung;
    // Sollwert −3000, das Netz bezieht 500 W (Hauslast) → Bedarf 3500 W.
    victron: { soc: 4, batteryPowerW: 0, minSocPct: 0, errors: {}, gridSetpointW: -3000, fieldUpdatedAt: {} },
    meter: { ok: true, grid_total_w: 500 },
    ctrl: {},
    multiGxHandoff: { phase: 'active', mainDischargeBlocked: true }
  };
  const mgx = createMultiGx({ getCfg: () => cfg, state, pushLog: () => {} }, { transport, now: () => t });
  for (let i = 0; i < 8; i++) { t += 5000; await mgx.tick(); }
  assert.equal(state.multiGx.desiredBatteryW, -3500, 'ganzer Bedarf, nicht nur ein Anteil');
  assert.equal(state.multiGx.mainDischargeBlocked, true);
  assert.equal(state.multiGx.handoff, 'active');

  // Gegenprobe ohne Sperre: Akku 1 gilt nicht als leer (4 % > Mindest-SoC 0 + 1),
  // das Netz bezieht nur 500 W → kein ungedeckter Bedarf fuer die zweite Anlage.
  state.multiGxHandoff = { phase: 'off', mainDischargeBlocked: false };
  for (let i = 0; i < 8; i++) { t += 5000; await mgx.tick(); }
  assert.ok(state.multiGx.desiredBatteryW > -3500, `ohne Sperre kein voller Bedarf (${state.multiGx.desiredBatteryW})`);
});
