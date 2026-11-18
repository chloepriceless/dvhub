// Golden-Master Pfad 4 der D.1-Inventur: applyDvFeedInLimit (LUOX-Teilvorgabe, Victron 2706 MaxFeedInPower),
// Nachweis D.4(2). Ausgeliefertes Victron-Profil: int16, scale 100, Sonderwert -1 (= keine Grenze), abwärts
// gerundet (obere Grenze). Eingangsfolgen: erste Grenze (Sicherung des Installateurwerts), Wechsel, Rundung,
// Rücknahme (gesicherter Wert, auch der Sonderwert -1), Rücknahme ohne Sicherung, Lesefehler, Neustart mit
// Merker, Not-Halt (Pfad selbst ohne Not-Halt-Prüfung — die sitzt im Begrenzer davor), Schreibsicherheit,
// Profil ohne 2706 (Fronius).
//
// Frieren: GOLDEN_FREEZE=1 node --test test/gate-golden-feedin-limit.test.js (schreibt
// test/fixtures/gate-golden/feedin-limit.json neu). Nur mit belegtem Grund.

import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

import {
  HOST, fixClock, loadProfileConfig, recordingModbus, baseState, evaluatorRig, recorder, goldenFile, tempDir,
} from './helpers/gate-golden.js';

const golden = goldenFile('feedin-limit');

function rig({ holding = { 2706: 0xffff }, transport = {}, state = {}, ctx = {}, profile = 'victron' } = {}) {
  const cfg = loadProfileConfig(profile, { victron: { host: HOST } });
  return evaluatorRig({ cfg, ctx, transport: recordingModbus({ holding, ...transport }), state: baseState(state) });
}
const limit = (a, w) => async () => { await a.ev.applyDvFeedInLimit(w); return { saved: a.state.ctrl._dvSeqSaved?.dvFeedInLimitW ?? null }; };

test('Pfad 4 Victron 2706: Grenze setzen, wechseln, runden, zurücknehmen (Installateurwert -1)', async (t) => {
  fixClock(t);
  const a = rig();
  const r = recorder(a);
  await r.step('Grenze 3000 W (sichert -1)', limit(a, 3000));
  await r.step('Grenze 2500 W', limit(a, 2500));
  await r.step('Grenze 2549 W (abwärts auf 100 W)', limit(a, 2549));
  await r.step('Grenze 0 W', limit(a, 0));
  await r.step('Grenze -500 W (auf 0 geklemmt)', limit(a, -500));
  await r.step('Rücknahme (null)', limit(a, null));
  await r.step('Rücknahme ohne Sicherung', limit(a, null));
  golden.check('victron_cycle', { steps: r.steps, reg2706: a.transport.regs.get(2706) });

  const b = rig({ holding: { 2706: 46 } });
  const r2 = recorder(b);
  await r2.step('Grenze 3000 W (Installateur 4600 W)', limit(b, 3000));
  await r2.step('Rücknahme', limit(b, null));
  golden.check('victron_installer_value', { steps: r2.steps, reg2706: b.transport.regs.get(2706) });
});

test('Pfad 4 Victron 2706: Lesefehler, Not-Halt, Schreibsicherheit, Profil ohne 2706', async (t) => {
  fixClock(t);
  const a = rig({ transport: { failRead: { 2706: { msg: 'timeout', times: 1 } } } });
  const r = recorder(a);
  await r.step('Grenze 3000 W, Lesefehler', limit(a, 3000));
  await r.step('Grenze 3000 W, nächster Takt', limit(a, 3000));
  golden.check('victron_read_error', r.steps);

  const h = rig({ state: { ctrl: { discretionaryWritesPaused: true, pausedAt: Date.now() } } });
  const r2 = recorder(h);
  await r2.step('Grenze 3000 W im Not-Halt (Pfad ohne eigene Prüfung)', limit(h, 3000));
  golden.check('victron_nothalt', r2.steps);

  const u = rig();
  u.cfg.writeSafety = { ok: false, reason: 'manufacturer_profile_error', manufacturer: 'victron' };
  const r3 = recorder(u);
  await r3.step('Grenze 3000 W bei writeSafety.ok=false', limit(u, 3000));
  golden.check('victron_write_safety', r3.steps);

  const f = rig({ profile: 'fronius', holding: {} });
  const r4 = recorder(f);
  await r4.step('Fronius Grenze 3000 W (kein 2706)', limit(f, 3000));
  golden.check('fronius_no_point', r4.steps);
});

test('Pfad 4 Victron 2706: Neustart mit Merker stellt den Installateurwert zurück', async (t) => {
  fixClock(t);
  const dir = tempDir(t, 'feedin');
  const savedPath = path.join(dir, 'dv_seq_saved.json');
  const a = rig({ holding: { 2706: 46 }, ctx: { dvSeqSavedPath: savedPath } });
  const r = recorder(a);
  await r.step('Grenze 3000 W', limit(a, 3000));
  const saved = JSON.parse(fs.readFileSync(savedPath, 'utf8'));
  const b = rig({ holding: { 2706: 30 }, ctx: { dvSeqSavedPath: savedPath } });
  const r2 = recorder(b);
  await r2.step('nach Neustart: Rücknahme', limit(b, null));
  golden.check('victron_restart', { before: r.steps, saved, after: r2.steps, savedAfter: JSON.parse(fs.readFileSync(savedPath, 'utf8')) });
});
