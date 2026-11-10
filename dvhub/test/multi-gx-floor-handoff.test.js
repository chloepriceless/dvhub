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

function makeWorld({ option = true, mainSoc = 4, mainMaxDischargeW = -1, follower = {}, ctrl = {}, store = memoryStore(), deviceEcho = true, deps = {}, transport = 'mqtt' } = {}) {
  let t = 1_000_000;
  const cfg = {
    updateChannel: 'dev',
    victron: { telemetryMaxAgeMs: 90000 },
    optimizer: { hardFloorSocPct: 5 },
    schedule: { evaluateMs: 5000 },           // Prod-Vorgabe
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
  const handoff = createFloorHandoff({ getCfg: () => cfg, state, pushLog: (e, d) => logs.push([e, d]), now: () => t, store, transportType: () => transport, ...deps });
  // Attrappe des Schreibpfads: haelt wie der echte Boden jeden Nicht-0-Wert bei soc <= Boden.
  async function apply(target, value, source) {
    let v = value;
    if (target === 'maxDischargeW' && v !== 0 && Number(state.victron.soc) <= cfg.optimizer.hardFloorSocPct) v = 0;
    // wie der echte Schreibpfad: unveraenderter Wert ohne Nachfuehren → uebersprungen
    if (state.schedule.lastWrite[target] && Number(state.schedule.lastWrite[target].value) === v) return { ok: true, skipped: true };
    applied.push({ target, value: v, source });
    state.schedule.lastWrite[target] = { value: v, at: t };
    if (target === 'maxDischargeW' && deviceEcho) state.victron.maxDischargeW = v; // GX uebernimmt, meldet beim naechsten Poll
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

const request = (w, value = -3000, source = 'rule:eos') => w.handoff.onFloorHold({ target: 'gridSetpointW', requested: value, source });

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
    assert.equal(w.state.multiGxHandoff.phase, 'restoring', 'erst nach Rueckmeldung der GX fertig');
    w.advance(5000);
    await w.handoff.maintain(w.apply);
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
  w.advance(5000);
  await w.handoff.maintain(w.apply);
  assert.equal(w.state.multiGxHandoff.phase, 'off');
  assert.equal(store.get(), null);
});

// Modbus: 2704 zeigt „unbegrenzt“ (−1 W) als 0 — 2720 (int32, W) entscheidet
// (wie Peak Shaving und Entlade-Waechter; Codex db0b6c2d P1). reg2720 in der
// Attrappe: Zahl, 'unsupported' (alter GX) oder 'error'.
function modbusWorld({ reg2720 = -1, ...opts } = {}) {
  const box = { reg2720, reads: 0 };
  const w = makeWorld({
    transport: 'modbus', ...opts,
    deps: {
      readExactMaxDischargeW: async () => {
        box.reads += 1;
        if (box.reg2720 === 'unsupported') return { unsupported: true };
        if (box.reg2720 === 'error') throw new Error('timeout');
        return { value: box.reg2720 };
      },
      ...(opts.deps || {})
    }
  });
  w.reg = box;
  return w;
}

test('Modbus: 2704 und 2720 lesen 0 → Sperre des Betreibers, keine Uebergabe', async () => {
  const w = modbusWorld({ mainMaxDischargeW: 0, reg2720: 0 });
  assert.equal(request(w), null, 'erst 2720 lesen');
  w.advance(5000); await w.handoff.maintain(w.apply);
  assert.equal(request(w), null);
  await w.handoff.maintain(w.apply);
  assert.equal(w.state.multiGxHandoff.phase, 'off');
  assert.equal(w.applied.length, 0);
  assert.equal(w.store.get(), null);
  assert.ok(w.logs.some(([e, d]) => e === 'multi_gx_handoff_skipped' && d.reason === 'max_discharge_locked'));
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

// --- Codex-Gegenpruefung 22.10.2026 ---

test('Codex P1: Ruecklesen von vor dem Schreiben bestaetigt die Sperre nicht', async () => {
  const w = makeWorld({ mainMaxDischargeW: 5000 });
  request(w);
  await w.handoff.maintain(w.apply);          // schreibt 0 zum Zeitpunkt t
  assert.equal(request(w), null, 'Messwert stammt nicht von nach dem Schreiben');
  w.advance(5000);                            // neuer Poll nach dem Schreiben
  assert.equal(request(w), -3000);
});

test('Codex P2: Sperre an der GX geaendert → DVhub schreibt die 0 wirklich neu', async () => {
  const w = makeWorld();
  request(w); await w.handoff.maintain(w.apply);
  w.state.victron.maxDischargeW = 0; w.advance(5000);
  assert.equal(request(w), -3000);
  // jemand stellt an der GX 5000 W ein
  w.state.victron.maxDischargeW = 5000; w.advance(5000);
  assert.equal(request(w), null, 'Boden haelt wieder');
  w.advance(10000);
  await w.handoff.maintain(w.apply);
  assert.equal(w.applied.filter((a) => a.target === 'maxDischargeW' && a.value === 0).length, 2, 'zweites echtes Schreiben');
  w.state.victron.maxDischargeW = 0; w.advance(5000);
  assert.equal(request(w), -3000);
});

test('Codex P2: Wert, den DVhub nicht zurueckschreiben kann (> 30 kW), wird nicht gesperrt', async () => {
  const w = makeWorld({ mainMaxDischargeW: 50000 });
  assert.equal(request(w), null);
  await w.handoff.maintain(w.apply);
  assert.equal(w.state.multiGxHandoff.phase, 'off');
  assert.equal(w.applied.length, 0);
  assert.equal(w.store.get(), null);
  assert.ok(w.logs.some(([e, d]) => e === 'multi_gx_handoff_skipped' && d.reason === 'saved_value_not_restorable'));
});

test('Codex P2: Auswertung alle 30 s — die Uebergabe startet trotzdem', async () => {
  const w = makeWorld();
  w.cfg.schedule = { evaluateMs: 30000 };
  for (let i = 0; i < 3; i++) {
    w.advance(30000);
    await w.handoff.maintain(w.apply);        // wie evaluateSchedule: maintain vor der Anfrage
    if (i === 1) w.state.victron.maxDischargeW = 0;
    request(w);
  }
  assert.equal(w.state.multiGxHandoff.phase, 'active');
});

// --- Codex-Gegenpruefung 22.10.2026, Runde 2 ---

test('Codex R2 P1: MQTT-Cache von vor dem Schreiben bestaetigt die Sperre nicht', async () => {
  const w = makeWorld({ mainMaxDischargeW: 5000, deviceEcho: false });
  request(w);
  await w.handoff.maintain(w.apply);
  // Poll nach dem Schreiben, aber die Nachricht der GX ist alt (Befehl verloren, Cache 0 von frueher)
  w.state.victron.maxDischargeW = 0;
  w.advance(5000);
  w.state.victron.fieldSourceAt = { maxDischargeW: w.now() - 60000 };
  assert.equal(request(w), null, 'alte Nachricht zaehlt nicht');
  w.state.victron.fieldSourceAt = { maxDischargeW: w.now() };
  assert.equal(request(w), -3000);
});

test('Codex R2 P2: Zurueckschreiben ohne Rueckmeldung — Sicherung bleibt, neuer Versuch mit wachsendem Abstand', async () => {
  const w = makeWorld({ deviceEcho: false });
  request(w); await w.handoff.maintain(w.apply);
  w.state.victron.maxDischargeW = 0; w.advance(5000);
  request(w);
  w.cfg.multiGx.exportHandoffAtFloor = false;
  w.state.victron.soc = 20;
  const restores = () => w.applied.filter((a) => a.source === 'multi_gx_handoff_restore').length;
  for (let i = 0; i < 12; i++) { w.advance(5000); await w.handoff.maintain(w.apply); }  // 60 s, GX bleibt bei 0
  assert.equal(w.state.multiGxHandoff.phase, 'restoring');
  assert.deepEqual(w.store.get().savedMaxDischargeW, -1, 'Sicherung noch da');
  assert.ok(restores() >= 2 && restores() <= 4, `wenige Versuche, nicht jeden Takt (${restores()})`);
  w.state.victron.maxDischargeW = -1; w.advance(5000);           // GX meldet den alten Wert
  await w.handoff.maintain(w.apply);
  assert.equal(w.state.multiGxHandoff.phase, 'off');
  assert.equal(w.store.get(), null);
});

test('Codex R2 P2: ueber MQTT bleibt eine gesetzte Sperre 0 erhalten', () => {
  const store = memoryStore();
  const t = 1_000_000;
  const cfg = { updateChannel: 'dev', victron: { telemetryMaxAgeMs: 90000 }, optimizer: { hardFloorSocPct: 5 }, schedule: { evaluateMs: 5000 },
    controlWrite: { maxDischargeW: { enabled: true } }, multiGx: { enabled: true, host: 'x', minSocPct: 10, exportHandoffAtFloor: true } };
  const state = {
    victron: { soc: 4, maxDischargeW: 0, fieldUpdatedAt: { soc: t, maxDischargeW: t } },
    multiGx: { online: true, socPct: 80, minSocPct: 10, updatedAt: t }, ctrl: {}, schedule: { lastWrite: {} }
  };
  const h = createFloorHandoff({ getCfg: () => cfg, state, now: () => t, store, transportType: () => 'mqtt' });
  h.onFloorHold({ target: 'gridSetpointW', requested: -3000, source: 'rule:eos' });
  assert.equal(store.get().savedMaxDischargeW, 0);
});

// --- Codex-Gegenpruefung 22.10.2026, Runde 3 ---

test('Codex R3 P1: erneut am Boden waehrend des Zurueckschreibens — alte 0 gibt nichts frei', async () => {
  const w = makeWorld({ deviceEcho: false });
  request(w); await w.handoff.maintain(w.apply);
  w.state.victron.maxDischargeW = 0; w.advance(5000);
  assert.equal(request(w), -3000);
  w.cfg.multiGx.exportHandoffAtFloor = false;
  w.state.victron.soc = 9;
  await w.handoff.maintain(w.apply);          // restoring
  w.advance(5000);
  await w.handoff.maintain(w.apply);          // schreibt -1, GX meldet noch die alte 0
  assert.equal(w.applied.at(-1).source, 'multi_gx_handoff_restore');
  w.cfg.multiGx.exportHandoffAtFloor = true;
  w.state.victron.soc = 4; w.advance(1000);   // wieder am Boden, Messwert 0 aus der Zeit vor dem Zurueckschreiben
  w.state.victron.fieldSourceAt = { maxDischargeW: w.now() - 4000 };
  assert.equal(request(w), null, 'arming, Boden haelt');
  assert.equal(request(w), null, 'ohne neues Sperren keine Freigabe');
  await w.handoff.maintain(w.apply);
  assert.deepEqual(w.applied.at(-1), { target: 'maxDischargeW', value: 0, source: 'multi_gx_handoff' }, 'neu gesperrt');
});

test('Codex R3 P2: nach Neustart mit gesicherter Sperre gilt Akku 1 fuer die Aufteilung als gesperrt', async () => {
  const store = memoryStore({ savedMaxDischargeW: -1, at: 1 });
  const w = makeWorld({ store, mainSoc: 6, mainMaxDischargeW: 0 });
  await w.handoff.maintain(w.apply);
  assert.equal(w.state.multiGxHandoff.phase, 'restoring');
  assert.equal(w.state.multiGxHandoff.mainDischargeBlocked, true);
  assert.equal(request(w), null, 'Einspeisung erst nach neuem Sperren');
});

// --- Codex-Gegenpruefung 22.10.2026, Runde 4 ---

test('Codex R4: nur geplante Akku-Einspeisung ab 1 kW — kein DC-PV-Export, Puffer, Preisschutz', () => {
  for (const [source, value] of [['dc_export_mode', -3000], ['default', -3000], ['negative_price_protection', -3000],
    ['sell_price_floor', -3000], ['rule:eos', -300], ['manual_override_soc_floor', -3000]]) {
    const w = makeWorld();
    assert.equal(request(w, value, source), null, `${source} ${value}`);
    assert.equal(w.state.multiGxHandoff.phase, 'off', `${source} ${value}`);
  }
  for (const source of ['rule:eos', 'manual_override', 'manual_override_persistent', 'api_manual_write']) {
    const w = makeWorld();
    request(w, -1000, source);
    assert.equal(w.state.multiGxHandoff.phase, 'arming', source);
  }
});

// --- Codex-Gegenpruefung 22.10.2026, Runde 5 ---

test('Codex R5: harter Boden 99 % — Zurueckschreiben bleibt erreichbar', async () => {
  const w = makeWorld({ mainSoc: 99 });
  w.cfg.optimizer.hardFloorSocPct = 99;
  request(w); await w.handoff.maintain(w.apply);
  w.state.victron.maxDischargeW = 0; w.advance(5000);
  assert.equal(request(w), -3000);
  w.cfg.multiGx.exportHandoffAtFloor = false;
  w.state.victron.soc = 100; w.advance(5000);
  await w.handoff.maintain(w.apply);
  w.advance(5000); await w.handoff.maintain(w.apply);
  assert.equal(w.state.multiGxHandoff.phase, 'off');
});

test('Codex R5: Puffer macht aus 0 W keine Uebergabe', () => {
  const w = makeWorld();
  assert.equal(w.handoff.onFloorHold({ target: 'gridSetpointW', requested: -1500, original: 0, source: 'rule:eos' }), null);
  assert.equal(w.state.multiGxHandoff.phase, 'off');
});

// --- Einbindung in den Entlade-Boden (schedule-eval applyControlTarget) ---

function evaluatorWorld({ option = true, soc = 4, socFresh = true, ctxExtra = {} } = {}) {
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
    floorHandoffStore: memoryStore(),
    ...ctxExtra
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
  w.state.victron.fieldUpdatedAt.maxDischargeW = Date.now() + 1000; // Poll nach dem Schreiben
  await w.ev.applyControlTarget('gridSetpointW', -3000, 'rule:eos');
  assert.deepEqual(w.writes.at(-1), { target: 'gridSetpointW', value: -3000 });
});

// Seit 1.0.10 (Not-Halt-Regel Christin 06.11.2026: eigene Steuersignale EINMAL
// zuruecknehmen, danach keine Writes): das Not-Halt-Tor laesst nur noch den einen,
// von der Uebergabe angemeldeten Rueckschreibwert durch — kein Dauer-Durchlass
// fuer multi_gx_handoff_restore mehr (vorher Codex R4).
test('Not-Halt-Tor: nur der eine angemeldete Rueckschreibwert geht durch, sonst nichts', async () => {
  const w = evaluatorWorld();
  w.state.ctrl.discretionaryWritesPaused = true;
  const restore = await w.ev.applyControlTarget('maxDischargeW', -1, 'multi_gx_handoff_restore');
  assert.equal(restore.blocked, true, 'normales Zurueckschreiben wartet bis nach dem Not-Halt');
  const stopNoAnnounce = await w.ev.applyControlTarget('maxDischargeW', -1, 'multi_gx_handoff_stop');
  assert.equal(stopNoAnnounce.blocked, true, 'ohne Anmeldung durch die Uebergabe kein Durchlass');
  const lock = await w.ev.applyControlTarget('maxDischargeW', 0, 'multi_gx_handoff');
  assert.equal(lock.blocked, true, 'Sperren bleibt im Not-Halt blockiert');
  const other = await w.ev.applyControlTarget('gridSetpointW', -1, 'multi_gx_handoff_stop');
  assert.equal(other.blocked, true, 'nur maxDischargeW');
});

test('Codex R5: Einspeise-Puffer -1500 W macht aus einer 0-W-Regel keine Uebergabe (echter Evaluator)', async () => {
  const w = evaluatorWorld();
  w.cfg.schedule.defaultGridSetpointW = -1500;
  await w.ev.applyControlTarget('gridSetpointW', 0, 'rule:eigenverbrauch');
  await w.ev.floorHandoff.maintain(w.ev.applyControlTarget);
  assert.equal(w.state.multiGxHandoff.phase, 'off');
  assert.ok(!w.writes.some((x) => x.target === 'maxDischargeW'));
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

test('Codex R5: Einspeisegrenze greift, Akku 1 gesperrt laedt → Akku 2 entlaedt nicht in Akku 1', async () => {
  const regs = { 843: 80, 842: 0, 2901: 100, 820: 0, 821: 0, 822: 0 };
  const transport = {
    async mbRequest(req) { return Array.from({ length: req.quantity || 1 }, (_, i) => regs[req.address + i] ?? 0); },
    async mbWriteMultiple() { return {}; }
  };
  const cfg = {
    updateChannel: 'dev', gridPositiveMeans: 'grid_import',
    optimizer: { batteryCapacityWh: 10000, maxSocPct: 100, maxDischargeW: 5000 },
    multiGx: { enabled: true, host: 'x', port: 502, unitId: 100, batteryCapacityWh: 10000, maxChargeW: 10000, maxDischargeW: 10000, minSocPct: 10, rampWPerS: 5000, deadbandW: 0 }
  };
  let t = 0;
  // Sollwert −10 kW, Netz exportiert nur 6 kW (Grenze), Akku 1 laedt 3 kW
  const state = {
    victron: { soc: 4, batteryPowerW: 3000, minSocPct: 0, errors: {}, gridSetpointW: -10000, fieldUpdatedAt: {} },
    meter: { ok: true, grid_total_w: -6000 }, ctrl: {},
    multiGxHandoff: { phase: 'active', mainDischargeBlocked: true }
  };
  const mgx = createMultiGx({ getCfg: () => cfg, state, pushLog: () => {} }, { transport, now: () => t });
  for (let i = 0; i < 4; i++) { t += 5000; await mgx.tick(); }
  assert.ok(state.multiGx.desiredBatteryW >= 0, `kein Entladen in Akku 1 (${state.multiGx.desiredBatteryW})`);
});

test('Poller: bei MQTT gilt der Zeitstempel der Nachricht, bei Modbus der Poll', async () => {
  const { createPoller } = await import('../polling.js');
  const os = await import('node:os');
  const path = await import('node:path');
  const msgTs = Date.now() - 120000;
  const cfg = { pollMs: 500, epex: { timezone: 'UTC' }, userEnergyPricing: {}, victron: {}, meter: { fc: 4, address: 820, quantity: 3 },
    points: { maxDischargeW: { enabled: true, fc: 4, address: 2704, quantity: 1, signed: true, scale: 10, rawSentinels: [-1, 0] } } };
  const state = {
    meter: { ok: false, updatedAt: 0, raw: [], grid_l1_w: 0, grid_l2_w: 0, grid_l3_w: 0, grid_total_w: 0, error: null },
    victron: { errors: {}, updatedAt: 0, fieldUpdatedAt: {} }, dvRegs: new Array(8).fill(0),
    energy: { day: '2026-10-22', importWh: 0, exportWh: 0, costEur: 0, revenueEur: 0, lastTs: 0 }
  };
  const transport = {
    type: 'mqtt',
    async readPoint() { return { mqttValue: 0, ts: msgTs }; },
    async readMeter() { return { total: 0, l1: 0, l2: 0, l3: 0, ts: msgTs }; },
    async mbRequest() { return [0, 0, 0]; }
  };
  const poller = createPoller({ state, getCfg: () => cfg, transport, pushLog: () => {},
    energyPath: path.join(os.tmpdir(), 'mgx-handoff-poll-test.json'), onPollComplete: () => {}, epexNowNext: () => ({ current: { ct_kwh: 0 } }) });
  await poller.requestPoll();
  assert.equal(state.victron.maxDischargeW, 0);
  assert.equal(state.victron.fieldSourceAt.maxDischargeW, msgTs, 'Nachricht, nicht Poll');
  assert.ok(state.victron.fieldUpdatedAt.maxDischargeW > msgTs);
});

// --- Wechselwirkungen mit release/1.0.10 (Merge 10.11.2026) ---
//
// Not-Halt (Christin 06.11.2026): DVhubs eigene Steuersignale EINMAL
// zuruecknehmen, danach keine Writes, kein Wiederholen. Die Sperre 2704 = 0 ist
// so ein Signal: im Not-Halt schreibt die Uebergabe den gesicherten Wert genau
// einmal zurueck — sobald der Entlade-Boden (T-0075) das zulaesst, sonst haelt
// er ihn ohnehin auf 0. Danach still; nach dem Not-Halt laeuft das normale
// Zurueckschreiben weiter.

function activeWorld(opts = {}) {
  const w = makeWorld(opts);
  request(w); return w;
}
async function makeActive(w) {
  await w.handoff.maintain(w.apply);
  w.state.victron.maxDischargeW = 0; w.advance(5000);
  assert.equal(request(w), -3000);
}

// Christin 10.11.2026 („als ob die Kiste aus ist“, Koordination 10.11.): die
// eine Rücknahme fällt beim EINTRITT. Lässt der T-0075-Boden sie dann nicht zu
// (Ladestand am harten Boden), schreibt DVhub im Not-Halt gar nicht — Akku 1
// bleibt gesperrt (entlädt nicht unter den Boden, sicher), und das normale
// Zurückschreiben nach dem Not-Halt nimmt die Sperre zurück.
test('Not-Halt am Boden: kein Write im ganzen Not-Halt (auch nicht, wenn der Ladestand steigt), danach normal zurueck', async () => {
  const w = activeWorld({ deviceEcho: false });
  await makeActive(w);
  w.state.ctrl.discretionaryWritesPaused = true;
  await w.handoff.maintain(w.apply);
  assert.equal(w.state.multiGxHandoff.phase, 'restoring');
  assert.equal(w.state.multiGxHandoff.reason, 'emergency_stop');
  assert.equal(w.applied.length, 1, 'am Boden (4 %): nichts — der Boden hielte 2704 ohnehin auf 0');
  assert.ok(w.logs.some(([e]) => e === 'multi_gx_handoff_stop_deferred'), 'aufgeschoben wird protokolliert');
  for (let i = 0; i < 40; i++) { w.state.victron.soc = 20; w.advance(30000); await w.handoff.maintain(w.apply); }
  assert.equal(w.applied.length, 1, 'auch über dem Boden: kein spaeterer Write mitten im Not-Halt');
  assert.equal(w.state.multiGxHandoff.phase, 'restoring', 'Sicherung bleibt bis nach dem Not-Halt');
  w.state.ctrl.discretionaryWritesPaused = false; w.advance(5000);
  await w.handoff.maintain(w.apply);
  assert.deepEqual(w.applied.at(-1), { target: 'maxDischargeW', value: -1, source: 'multi_gx_handoff_restore' }, 'nach dem Not-Halt normal zurueck');
});

test('Not-Halt ueber dem Boden: Sperre beim Eintritt einmal zuruecknehmen, danach keine Writes; Rueckmeldung beendet', async () => {
  const w = activeWorld({ deviceEcho: false });
  await makeActive(w);
  w.state.victron.soc = 6; w.advance(5000);
  w.state.ctrl.discretionaryWritesPaused = true;
  await w.handoff.maintain(w.apply);
  assert.deepEqual(w.applied.at(-1), { target: 'maxDischargeW', value: -1, source: 'multi_gx_handoff_stop' }, 'einmal zurueck, nicht erst 3 Punkte ueber dem Boden');
  for (let i = 0; i < 40; i++) { w.state.victron.soc = 20; w.advance(30000); await w.handoff.maintain(w.apply); }
  assert.equal(w.applied.length, 2, 'GX meldet nichts zurueck: trotzdem kein zweiter Versuch im Not-Halt');
  assert.equal(w.state.multiGxHandoff.phase, 'restoring', 'Sicherung bleibt bis zur Rueckmeldung');
  w.state.victron.maxDischargeW = -1; w.advance(5000);
  await w.handoff.maintain(w.apply);
  assert.equal(w.state.multiGxHandoff.phase, 'off', 'Rueckmeldung im Not-Halt beendet sauber (nur lesen)');
  assert.equal(w.store.get(), null);
  assert.equal(w.applied.length, 2);
});

test('Not-Halt: Rueckmeldung bleibt aus → nach dem Not-Halt normales Zurueckschreiben', async () => {
  const w = activeWorld({ deviceEcho: false });
  await makeActive(w);
  w.state.victron.soc = 20;
  w.state.ctrl.discretionaryWritesPaused = true;
  await w.handoff.maintain(w.apply);
  assert.equal(w.applied.filter((a) => a.source === 'multi_gx_handoff_stop').length, 1);
  w.advance(5000); await w.handoff.maintain(w.apply);
  assert.equal(w.applied.length, 2);
  w.state.ctrl.discretionaryWritesPaused = false; w.advance(5000);
  await w.handoff.maintain(w.apply);
  assert.deepEqual(w.applied.at(-1), { target: 'maxDischargeW', value: -1, source: 'multi_gx_handoff_restore' });
});

test('Not-Halt vor dem ersten Sperren: nichts zu neutralisieren, kein Write, Sicherung weg', async () => {
  const w = activeWorld();
  assert.equal(w.state.multiGxHandoff.phase, 'arming');
  w.state.ctrl.discretionaryWritesPaused = true;
  w.state.victron.soc = 20;
  await w.handoff.maintain(w.apply);
  assert.equal(w.applied.length, 0);
  assert.equal(w.state.multiGxHandoff.phase, 'off');
  assert.equal(w.store.get(), null);
});

test('Not-Halt im echten Steuerpfad: genau ein Write durch das Tor, danach nichts', async () => {
  const w = evaluatorWorld();
  await w.ev.applyControlTarget('gridSetpointW', -3000, 'rule:eos');
  await w.ev.floorHandoff.maintain(w.ev.applyControlTarget);
  w.state.victron.maxDischargeW = 0;
  w.state.victron.fieldUpdatedAt.maxDischargeW = Date.now() + 1000;
  await w.ev.applyControlTarget('gridSetpointW', -3000, 'rule:eos');
  assert.equal(w.state.multiGxHandoff.phase, 'active');
  w.state.ctrl.discretionaryWritesPaused = true;
  w.state.victron.soc = 30; w.state.victron.fieldUpdatedAt.soc = Date.now();
  const before = w.writes.length;
  await w.ev.floorHandoff.maintain(w.ev.applyControlTarget);
  assert.deepEqual(w.writes.slice(before), [{ target: 'maxDischargeW', value: -1 }]);
  await w.ev.floorHandoff.maintain(w.ev.applyControlTarget);
  await w.ev.floorHandoff.maintain(w.ev.applyControlTarget);
  assert.equal(w.writes.length, before + 1, 'keine weiteren Writes im Not-Halt');
  assert.ok(!w.logs.some((l) => l.event === 'control_write_blocked_nothalt' && l.payload.source === 'multi_gx_handoff_stop'));
});

// Netzanschluss-Waechter / Akku-Hilfe: braucht der Anschluss den Akku (Lasten
// gekuerzt, §14a fordert Akku-Hilfe an), darf DVhub Akku 1 nicht sperren — und
// eine stehende Sperre nimmt DVhub dann ohne die 3-Punkte-Schwelle zurueck,
// sobald der Entlade-Boden es zulaesst.

test('Netzanschluss braucht den Akku: keine neue Sperre', () => {
  const w = makeWorld({ deps: { batteryNeeded: () => true } });
  assert.equal(request(w), null);
  assert.equal(w.state.multiGxHandoff.phase, 'off');
});

test('Netzanschluss braucht den Akku waehrend der Uebergabe: sofort Boden, Sperre zurueck ueber dem Boden', async () => {
  let need = false;
  const w = activeWorld({ deps: { batteryNeeded: () => need } });
  await makeActive(w);
  need = true;
  await w.handoff.maintain(w.apply);
  assert.equal(w.state.multiGxHandoff.phase, 'restoring');
  assert.equal(w.state.multiGxHandoff.reason, 'grid_needs_battery');
  assert.equal(request(w), null, 'Boden haelt wieder');
  assert.equal(w.applied.filter((a) => a.source === 'multi_gx_handoff_restore').length, 0, 'am Boden noch nicht');
  w.state.victron.soc = 6; w.advance(5000);
  await w.handoff.maintain(w.apply);
  assert.deepEqual(w.applied.at(-1), { target: 'maxDischargeW', value: -1, source: 'multi_gx_handoff_restore' }, '6 % reicht, nicht erst 9 %');
});

test('ohne Bedarf am Netzanschluss bleibt die 3-Punkte-Schwelle', async () => {
  const w = activeWorld({ deps: { batteryNeeded: () => false } });
  await makeActive(w);
  w.cfg.multiGx.exportHandoffAtFloor = false;
  w.state.victron.soc = 6;
  await w.handoff.maintain(w.apply); w.advance(5000); await w.handoff.maintain(w.apply);
  assert.equal(w.applied.filter((a) => a.source === 'multi_gx_handoff_restore').length, 0);
});

test('Steuerpfad: Lasten vom Netzanschluss gekuerzt oder §14a-Akku-Hilfe angefordert → keine Sperre', async () => {
  for (const summary of [
    { enabled: true, active: true, paused: false, caps: [{ id: 'wallbox', capW: 0 }], assistSources: [] },
    { enabled: true, active: false, paused: false, assistOnly: true, caps: [], assistSources: ['p14a'] }
  ]) {
    const w = evaluatorWorld({ ctxExtra: { gridConnection: { summary: () => summary, batteryCeilingW: () => null, dischargeFloorW: () => null } } });
    await w.ev.applyControlTarget('gridSetpointW', -3000, 'rule:eos');
    await w.ev.floorHandoff.maintain(w.ev.applyControlTarget);
    assert.equal(w.state.multiGxHandoff.phase, 'off', JSON.stringify(summary));
    assert.ok(!w.writes.some((x) => x.target === 'maxDischargeW'));
  }
  // Gegenprobe: Waechter aktiv, aber nichts gekuerzt → Uebergabe wie gehabt
  const w = evaluatorWorld({ ctxExtra: { gridConnection: { summary: () => ({ enabled: true, active: true, paused: false, caps: [], assistSources: [] }), batteryCeilingW: () => null, dischargeFloorW: () => null } } });
  await w.ev.applyControlTarget('gridSetpointW', -3000, 'rule:eos');
  assert.equal(w.state.multiGxHandoff.phase, 'arming');
});

// Andere Schreiber von 2704: Peak Shaving hebt eine Sperre auf; der
// Netzanschluss hebt bei Nicht-Victron die Entladegrenze an (Akku zuerst).

test('Peak Shaving hat die Sperre gerade aufgehoben: keine Uebergabe (sonst sicherte DVhub seinen eigenen Freigabewert)', () => {
  const w = makeWorld({ mainMaxDischargeW: 2000, ctrl: { _peakShaving: { discharge: { phase: 'lifted', liftedW: 2000 } } } });
  assert.equal(request(w), null);
  assert.equal(w.state.multiGxHandoff.phase, 'off');
  assert.equal(w.store.get(), null);
});

test('nur Victron: bei anderen Herstellern keine Sperre ueber die Entladegrenze', () => {
  const w = makeWorld();
  w.cfg.manufacturer = 'fronius';
  assert.equal(request(w), null);
  assert.equal(w.state.multiGxHandoff.phase, 'off');
  const v = makeWorld();
  v.cfg.manufacturer = 'victron';
  request(v);
  assert.equal(v.state.multiGxHandoff.phase, 'arming');
});

// --- Codex db0b6c2d (Merge 1.0.10) ---

test('Codex db0b6c2d P1: Modbus-Werkseinstellung (2704 liest 0, 2720 −1) → Uebergabe, gesichert wird −1', async () => {
  const w = modbusWorld({ mainMaxDischargeW: 0, reg2720: -1 });
  assert.equal(request(w), null);
  w.advance(5000); await w.handoff.maintain(w.apply);
  assert.equal(request(w), null, 'jetzt arming');
  assert.equal(w.state.multiGxHandoff.phase, 'arming');
  assert.equal(w.store.get().savedMaxDischargeW, -1);
  w.advance(5000); await w.handoff.maintain(w.apply);        // schreibt 0
  assert.deepEqual(w.applied.at(-1), { target: 'maxDischargeW', value: 0, source: 'multi_gx_handoff' });
  assert.equal(request(w), null, '2720 noch von vor dem Schreiben');
  w.reg.reg2720 = 0;
  w.advance(5000); await w.handoff.maintain(w.apply);
  assert.equal(request(w), -3000);
});

test('Codex db0b6c2d P1: waehrend der Uebergabe an der GX auf unbegrenzt gestellt (2704 bleibt 0) → Boden haelt', async () => {
  const w = modbusWorld({ mainMaxDischargeW: 5000, reg2720: 5000 });
  request(w);
  w.advance(5000); await w.handoff.maintain(w.apply);        // schreibt 0
  w.reg.reg2720 = 0; w.state.victron.maxDischargeW = 0;
  w.advance(5000); await w.handoff.maintain(w.apply);
  assert.equal(request(w), -3000);
  w.reg.reg2720 = -1;                                         // 2704 zeigt weiter 0
  w.advance(5000); await w.handoff.maintain(w.apply);
  assert.equal(request(w), null, 'nicht mehr gesperrt: keine Einspeisung unter dem Boden');
  w.advance(10000); await w.handoff.maintain(w.apply);
  assert.equal(w.applied.filter((a) => a.value === 0 && a.source === 'multi_gx_handoff').length, 2, 'DVhub sperrt neu');
});

test('Codex db0b6c2d P1: 2720 nicht lesbar (Fehler) → Sperre gilt nicht; alter GX ohne 2720 → keine Uebergabe', async () => {
  const w = modbusWorld({ mainMaxDischargeW: 5000, reg2720: 5000 });
  request(w);
  w.advance(5000); await w.handoff.maintain(w.apply);
  w.reg.reg2720 = 'error'; w.state.victron.maxDischargeW = 0;
  w.advance(100000); await w.handoff.maintain(w.apply);
  assert.equal(request(w), null, 'veraltete 2720-Lesung bestaetigt nichts');
  const old = modbusWorld({ mainMaxDischargeW: 5000, reg2720: 'unsupported' });
  request(old);
  await old.handoff.maintain(old.apply);
  assert.equal(old.state.multiGxHandoff.phase, 'off', 'nie gesperrt → Sicherung verworfen (Codex d7f58676 P2)');
  assert.equal(old.store.get(), null);
  assert.ok(old.logs.some(([e, d]) => e === 'multi_gx_handoff' && d.reason === 'max_discharge_not_verifiable'));
  assert.equal(old.applied.length, 0, 'kein Write');
  assert.equal(request(old), null);
  assert.equal(old.state.multiGxHandoff.phase, 'off', 'kein neuer Anlauf');
});

test('Codex d7f58676 P1: aktive Uebergabe, GX auf unbegrenzt, 2720-Lesung scheitert → sofort Boden', async () => {
  const w = modbusWorld({ mainMaxDischargeW: 5000, reg2720: 5000 });
  request(w);
  w.advance(5000); await w.handoff.maintain(w.apply);
  w.reg.reg2720 = 0; w.state.victron.maxDischargeW = 0;
  w.advance(5000); await w.handoff.maintain(w.apply);
  assert.equal(request(w), -3000);
  w.reg.reg2720 = 'error';                                    // GX steht inzwischen auf −1, 2704 zeigt 0
  w.advance(5000); await w.handoff.maintain(w.apply);
  assert.equal(request(w), null, 'alte Bestaetigung gilt nach einem Lesefehler nicht');
});

test('Codex d7f58676 P2: alter GX ohne 2720 — spaeter gesenkte Grenze des Betreibers bleibt', async () => {
  const w = modbusWorld({ mainMaxDischargeW: 5000, reg2720: 'unsupported' });
  request(w);
  await w.handoff.maintain(w.apply);
  w.state.victron.maxDischargeW = 2000;                       // Betreiber senkt die Grenze
  for (let i = 0; i < 6; i++) { w.state.victron.soc = 30; w.advance(30000); await w.handoff.maintain(w.apply); }
  assert.equal(w.applied.length, 0, 'kein Zurueckschreiben von 5000 W');
});

test('Codex db0b6c2d P1: Messwert von vor dem letzten Schreiben (Peak Shaving setzt gerade 0) wird nicht gesichert', () => {
  const w = makeWorld({ mainMaxDischargeW: 2000 });
  // Peak Shaving hat eben 0 zurueckgeschrieben, der Poll zeigt noch seine Freigabe
  w.state.schedule.lastWrite.maxDischargeW = { value: 0, at: w.now(), source: 'peak_shaving_restore' };
  assert.equal(request(w), null);
  assert.equal(w.state.multiGxHandoff.phase, 'off');
  assert.equal(w.store.get(), null);
  w.state.victron.maxDischargeW = 0; w.advance(5000);
  request(w);
  assert.equal(w.store.get()?.savedMaxDischargeW ?? null, 0, 'neuer Messwert (MQTT, eindeutig 0) — nicht 2000');
});

test('Codex db0b6c2d P2: dauerhafte Handvorgabe unter manualOverrideMinSocPct sperrt Akku 1 nicht', () => {
  for (const source of ['api_manual_write', 'manual_override_persistent']) {
    const w = makeWorld();
    w.state.schedule.manualOverride = { gridSetpointW: { value: -3000, persistent: true } };
    assert.equal(request(w, -3000, source), null, source);
    assert.equal(w.state.multiGxHandoff.phase, 'off', source);
  }
  // Gegenprobe: befristete Handvorgabe bleibt erlaubt
  const w = makeWorld();
  w.state.schedule.manualOverride = { gridSetpointW: { value: -3000 } };
  request(w, -3000, 'api_manual_write');
  assert.equal(w.state.multiGxHandoff.phase, 'arming');
});

test('Codex db0b6c2d P1, echter Steuerpfad über Modbus: 2720 entscheidet, ausgeliefertes Victron-Profil', async () => {
  const { loadVictronConfig, makeTelemetryState, makeEvaluator, makeModbusTransport, maxDischargeWrites } = await import('./helpers/peak-shaving-harness.js');
  const cfg = loadVictronConfig({
    updateChannel: 'dev',
    optimizer: { allowGridDischarge: true, hardFloorSocPct: 5 },
    multiGx: { enabled: true, host: '192.0.2.20', minSocPct: 10, exportHandoffAtFloor: true }
  });
  const state = makeTelemetryState({ soc: 4, maxDischargeW: 0, maxDischargeAgeMs: 1000 });
  state.multiGx = { online: true, socPct: 80, minSocPct: 10, updatedAt: Date.now() };
  const transport = makeModbusTransport({ 2704: 0, 2720: 0xffff, 2721: 0xffff, 2700: 0 });
  const { evaluator } = makeEvaluator({ cfg, state, transport, extraCtx: { floorHandoffStore: memoryStore() } });
  const h = evaluator.floorHandoff;
  await evaluator.applyControlTarget('gridSetpointW', -3000, 'rule:eos');
  await h.maintain(evaluator.applyControlTarget);
  assert.ok(transport.reads.some((r) => r.address === 2720 && r.quantity === 2 && r.fc === 3), '2720 gelesen');
  await evaluator.applyControlTarget('gridSetpointW', -3000, 'rule:eos');
  assert.equal(state.multiGxHandoff.phase, 'arming');
  assert.equal(state.multiGxHandoff.savedMaxDischargeW, -1, 'Werkseinstellung unbegrenzt erkannt');
  await h.maintain(evaluator.applyControlTarget);
  assert.deepEqual(maxDischargeWrites(transport), [0], 'Akku 1 gesperrt');
  // GX uebernimmt: 2720 = 0, Poll von 2704 danach
  transport.registers[2720] = 0; transport.registers[2721] = 0;
  await new Promise((r) => setTimeout(r, 5));
  state.victron.maxDischargeW = 0; state.victron.fieldUpdatedAt.maxDischargeW = Date.now();
  await h.maintain(evaluator.applyControlTarget);
  await evaluator.applyControlTarget('gridSetpointW', -3000, 'rule:eos');
  assert.equal(state.multiGxHandoff.phase, 'active');
});
