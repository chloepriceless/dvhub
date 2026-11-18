// Golden-Master Pfad 5 der D.1-Inventur: zfiWrite — Nulleinspeise-Deckel (zeroFeedInTick) und feste
// Einspeisegrenze (feedInCapTick) über SunSpec Model 123 WMaxLimPct / RvrtTms / WMaxLim_Ena und Model 124
// OutWRte, Nachweis D.4(2). Ausgeliefertes Fronius-Profil; die SunSpec-Adressen setzt der Test wie der Scan
// (polling.js). Eingangsfolgen: SoC-Auslöser (Enter erst im 2. gesperrten Takt), Regeln + Rücklese-Drift-Check,
// SoC-Erholung (Exit), Freigabe, Not-Halt (einmal abräumen), Export-Auslöser, Schreibfehler beim Enter,
// Schreibsicherheit, unaufgelöste Adressen, Profil ohne Funktion; feste Grenze: Enter, Regeln, Exit, Sperre.
//
// Frieren: GOLDEN_FREEZE=1 node --test test/gate-golden-zero-feedin.test.js (schreibt
// test/fixtures/gate-golden/zero-feedin.json neu). Nur mit belegtem Grund.

import { test } from 'node:test';

import {
  HOST, fixClock, loadProfileConfig, recordingModbus, baseState, evaluatorRig, recorder, goldenFile,
} from './helpers/gate-golden.js';

const golden = goldenFile('zero-feedin');
const ADDR = { storCtlMod: 40191, outWRte: 40198, wMaxLimPct: 40242, wMaxLimPctRvrtTms: 40244, wMaxLimEna: 40246 };

function froniusRig({ resolved = true, blocked = true, ctx = {}, profile = 'fronius' } = {}) {
  const cfg = loadProfileConfig(profile, { victron: { host: HOST } });
  if (resolved && profile === 'fronius') for (const [k, a] of Object.entries(ADDR)) cfg.controlWrite[k].address = a;
  const state = baseState({ ctrl: { _lastDvFeedIn: blocked ? false : true, _dvBlockReason: blocked ? 'negative_price_protection' : null } });
  return evaluatorRig({ cfg, ctx, state, transport: recordingModbus({ holding: { [ADDR.wMaxLimPct]: 10000 } }) });
}

// Messwerte wie vom Poller frisch gestempelt (feste Uhr).
function feed(rig, { soc = 96, importW = 0, exportW = 0, loadW = 1000, pvW = 3000 } = {}) {
  const now = Date.now();
  Object.assign(rig.state.victron, {
    soc, gridImportW: importW, gridExportW: exportW, selfConsumptionW: loadW, pvTotalW: pvW, pvPowerW: pvW,
    fieldUpdatedAt: { soc: now, selfConsumptionW: now, pvPowerW: now },
  });
  Object.assign(rig.state.meter, { ok: true, updatedAt: now, grid_total_w: importW - exportW });
}
const zfi = (rig, values) => async () => { if (values) feed(rig, values); await rig.ev.zeroFeedInTick(); const z = rig.state.ctrl._zfi || {}; return { cap: z.capActive === true, pct: z.limitPct == null ? null : Number(z.limitPct.toFixed(4)) }; };

test('Pfad 5 Nulleinspeisung: SoC-Auslöser, Regeln mit Drift-Check, SoC-Erholung', async (t) => {
  const advance = fixClock(t);
  const a = froniusRig();
  const r = recorder(a);
  await r.step('Takt 1 gesperrt, SoC 96 %', zfi(a, { soc: 96 }));
  await advance(5000);
  await r.step('Takt 2 → Deckel an', zfi(a, { soc: 96 }));
  await advance(5000);
  await r.step('Takt 3 Export 300 W → Limit runter', zfi(a, { soc: 96, exportW: 300 }));
  await advance(5000);
  await r.step('Takt 4 Bezug 400 W → Limit hoch', zfi(a, { soc: 96, importW: 400 }));
  await advance(5000);
  await r.step('Takt 5 Zähler veraltet → Limit gehalten, neu geschrieben', async () => { a.state.meter.updatedAt = Date.now() - 20_000; await a.ev.zeroFeedInTick(); return { cap: a.state.ctrl._zfi.capActive }; });
  await advance(5000);
  await r.step('Takt 6 SoC 89 % → Deckel aus', zfi(a, { soc: 89 }));
  golden.check('soc_trigger_cycle', r.steps);
});

test('Pfad 5 Nulleinspeisung: Freigabe und Not-Halt räumen den Deckel ab', async (t) => {
  const advance = fixClock(t);
  const a = froniusRig();
  const r = recorder(a);
  await r.step('Takt 1', zfi(a, {}));
  await advance(5000);
  await r.step('Takt 2 → an', zfi(a, {}));
  a.state.ctrl._lastDvFeedIn = true;
  await advance(5000);
  await r.step('Freigabe → Ena 0', zfi(a, {}));
  await r.step('Freigabe, nächster Takt', zfi(a, {}));
  golden.check('release', r.steps);

  const b = froniusRig();
  const r2 = recorder(b);
  await r2.step('Takt 1', zfi(b, {}));
  await advance(5000);
  await r2.step('Takt 2 → an', zfi(b, {}));
  Object.assign(b.state.ctrl, { discretionaryWritesPaused: true, pausedAt: Date.now() });
  await advance(5000);
  await r2.step('Not-Halt → einmal Ena 0', zfi(b, {}));
  await r2.step('Not-Halt, nächster Takt', zfi(b, {}));
  golden.check('nothalt', r2.steps);
});

test('Pfad 5 Nulleinspeisung: Export-Auslöser unter der SoC-Schwelle und Export-Exit', async (t) => {
  const advance = fixClock(t);
  const a = froniusRig();
  const r = recorder(a);
  for (let i = 1; i <= 4; i += 1) {
    await r.step(`Takt ${i} SoC 50 %, Export 500 W`, zfi(a, { soc: 50, exportW: 500 }));
    await advance(5000);
  }
  for (let i = 1; i <= 3; i += 1) {
    await r.step(`Export-Deckel, SoC fällt auf ${50 - i * 2} %`, zfi(a, { soc: 50 - i * 2, importW: 50 }));
    await advance(5000);
  }
  golden.check('export_trigger', r.steps);
});

test('Pfad 5 Nulleinspeisung: Schreibfehler, Schreibsicherheit, unaufgelöst, Profil ohne Funktion', async (t) => {
  const advance = fixClock(t);
  const a = froniusRig();
  a.transport.failWrite[ADDR.wMaxLimPct] = { msg: 'timeout', times: 1 };
  const r = recorder(a);
  await r.step('Takt 1', zfi(a, {}));
  await advance(5000);
  await r.step('Takt 2 → Enter, WMaxLimPct scheitert', zfi(a, {}));
  await advance(5000);
  await r.step('Takt 3 → Enter erneut', zfi(a, {}));
  golden.check('write_error', r.steps);

  const u = froniusRig();
  u.cfg.writeSafety = { ok: false, reason: 'manufacturer_profile_error', manufacturer: 'fronius' };
  const r2 = recorder(u);
  await r2.step('Takt 1', zfi(u, {}));
  await r2.step('Takt 2', zfi(u, {}));
  golden.check('write_safety', r2.steps);

  const n = froniusRig({ resolved: false });
  const r3 = recorder(n);
  await r3.step('Takt 1 unaufgelöst', zfi(n, {}));
  await r3.step('Takt 2 unaufgelöst', zfi(n, {}));
  golden.check('unresolved', r3.steps);

  const v = froniusRig({ profile: 'victron' });
  const r4 = recorder(v);
  await r4.step('Victron Takt 1', zfi(v, {}));
  await r4.step('Victron Takt 2', zfi(v, {}));
  golden.check('victron_noop', r4.steps);
});

test('Pfad 5 feste Einspeisegrenze (feedInCapTick): Enter, Regeln, Exit, Sperre übernimmt', async (t) => {
  const advance = fixClock(t);
  let limitW = 6000;
  const a = froniusRig({ blocked: false, ctx: { feedInCap: { limitForLoop: () => limitW } } });
  const r = recorder(a);
  const fic = (values) => async () => { feed(a, values); await a.ev.feedInCapTick(); const f = a.state.ctrl._fic || {}; return { cap: f.capActive === true, pct: f.limitPct == null ? null : Number(f.limitPct.toFixed(4)) }; };
  await r.step('Export 5000 W < Grenze', fic({ soc: 50, exportW: 5000, pvW: 8000 }));
  await advance(5000);
  await r.step('Export 7000 W > Grenze → Enter', fic({ soc: 50, exportW: 7000, pvW: 9000 }));
  await advance(5000);
  await r.step('Export 6200 W → Limit runter', fic({ soc: 50, exportW: 6200, pvW: 8000 }));
  await advance(5000);
  await r.step('Export 4000 W → Limit hoch', fic({ soc: 50, exportW: 4000, pvW: 6000 }));
  a.state.ctrl._lastDvFeedIn = false;
  await advance(5000);
  await r.step('Sperre aktiv → eigener Zustand weg, keine Writes', fic({ soc: 50, exportW: 0, pvW: 6000 }));
  a.state.ctrl._lastDvFeedIn = true;
  await advance(5000);
  await r.step('wieder frei, Export 7000 W → Enter', fic({ soc: 50, exportW: 7000, pvW: 9000 }));
  limitW = null;
  await advance(5000);
  await r.step('Grenze entfällt → Ena 0', fic({ soc: 50, exportW: 7000, pvW: 9000 }));
  golden.check('feed_in_cap', r.steps);

  const b = froniusRig({ blocked: false, ctx: { feedInCap: { limitForLoop: () => 6000 } } });
  const r2 = recorder(b);
  const fic2 = (values) => async () => { feed(b, values); await b.ev.feedInCapTick(); return { cap: b.state.ctrl._fic?.capActive === true }; };
  await r2.step('Enter', fic2({ soc: 50, exportW: 7000, pvW: 9000 }));
  Object.assign(b.state.ctrl, { discretionaryWritesPaused: true, pausedAt: Date.now() });
  await advance(5000);
  await r2.step('Not-Halt → einmal Ena 0', fic2({ soc: 50, exportW: 7000, pvW: 9000 }));
  await r2.step('Not-Halt, nächster Takt', fic2({ soc: 50, exportW: 7000, pvW: 9000 }));
  golden.check('feed_in_cap_nothalt', r2.steps);
});
