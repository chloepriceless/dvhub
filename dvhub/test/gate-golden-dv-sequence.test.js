// Golden-Master Pfad 2 der D.1-Inventur: runDvControlSequence (Abregel-Sequenzen), Nachweis D.4(2).
// Getrieben über die exportierten Einstiege applyDvVictronControl (Automatik) und applyControlTarget
// (ausdrücklicher Befehl) mit den AUSGELIEFERTEN Profilen:
//   Fronius  feedExcessDcPv: StorCtl_Mod/OutWRte mit Sicherung (saveBefore) und Rückstellung (restore)
//   Deye     dontFeedExcessAcPv: Work-Mode 142 (Sperre = Wert 2 nach Sicherung, Freigabe = Rückstellung)
//   Sungrow  feedExcessDcPv: 13087/13073/31221/13086 mit Rücklesung (verify), optionalen Schritten, Tagesbudget
// Eingangsfolgen (D.4(2)): Sperre/Freigabe, unverändert, Budget erschöpft, Not-Halt mitten im Ablauf, Lesefehler,
// abweichende Rücklesung, Rückstell-Ausnahme mit gesetztem Ziel (M14), Neustart mit Merker, Neustart ohne eigene
// Sperre, Endpunktwechsel (Geräte-Tor).
//
// Frieren: GOLDEN_FREEZE=1 node --test test/gate-golden-dv-sequence.test.js (schreibt
// test/fixtures/gate-golden/dv-sequence.json neu). Nur mit belegtem Grund.

import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

import {
  HOST, fixClock, loadProfileConfig, recordingModbus, baseState, evaluatorRig, recorder, goldenFile, dvOutcome, tempDir,
} from './helpers/gate-golden.js';
import { sungrowDevice } from './helpers/sungrow-fixture.js';

const golden = goldenFile('dv-sequence');
const SG_HOST = '192.0.2.50';                       // passt zu sungrowDevice().endpointKey
const ALIAS = { [HOST]: 'gx', [SG_HOST]: 'sg' };

function froniusCfg() {
  const cfg = loadProfileConfig('fronius', { victron: { host: HOST } });
  cfg.controlWrite.storCtlMod.address = 40191;      // SunSpec-Scan (polling.js) nachgestellt
  cfg.controlWrite.outWRte.address = 40198;
  return cfg;
}
const FRONIUS_REGS = { 40191: 1, 40198: 0xec78 };   // Kundenwerte: StorCtl_Mod 1, OutWRte −50,00 %
const DEYE_REGS = { 142: 1 };                       // Kunden-Work-Mode 1
// Sungrow-Installateurwerte: 13073 = 5000 W, 13086 = 0xAA (an), 13087 = 700 (70 %), 31221 = 0xFFFF (n. v.)
const SUNGROW_REGS = { 13073: 5000, 13086: 0xaa, 13087: 700, 31221: 0xffff };

function rigFor(profile, { transport = {}, state = {}, ctx = {}, cfg } = {}) {
  let c = cfg;
  let holding;
  if (profile === 'fronius') { c ??= froniusCfg(); holding = FRONIUS_REGS; }
  if (profile === 'deye-lv') { c ??= loadProfileConfig('deye-lv', { victron: { host: HOST } }); holding = DEYE_REGS; }
  if (profile === 'sungrow') {
    c ??= loadProfileConfig('sungrow', { updateChannel: 'dev', victron: { host: SG_HOST } });
    holding = SUNGROW_REGS;
    state = { ...state, victron: { device: sungrowDevice(), ...(state.victron || {}) } };
  }
  return evaluatorRig({
    cfg: c, state: baseState(state), ctx,
    transport: recordingModbus({ holding, hostAlias: ALIAS, ...transport }),
  });
}

const dv = (rig, feedIn, opts = {}) => async () => { await rig.ev.applyDvVictronControl(feedIn, opts); return dvOutcome(rig.state); };
const api = (rig, value) => async () => ({ ...(await rig.ev.applyControlTarget('feedExcessDcPv', value, 'api_manual_write')), ...dvOutcome(rig.state) });
const LOCK = { reason: 'negative_price_protection' };
const RELEASE = { reason: 'price_recovered' };

for (const profile of ['fronius', 'deye-lv', 'sungrow']) {
  test(`Pfad 2 ${profile}: Sperre, unverändert, Freigabe, erneute Sperre (Sicherung erneuert)`, async (t) => {
    fixClock(t);
    const rig = rigFor(profile);
    const r = recorder(rig);
    await r.step('Sperre (§51)', dv(rig, false, LOCK));
    await r.step('Sperre gleich', dv(rig, false, LOCK));
    await r.step('Freigabe automatisch', dv(rig, true, RELEASE));
    await r.step('Freigabe gleich', dv(rig, true, RELEASE));
    await r.step('Sperre erneut', dv(rig, false, LOCK));
    await r.step('Freigabe per API (ausdrücklich)', api(rig, 1));
    golden.check(`${profile}_cycle`, { steps: r.steps, regs: Object.fromEntries(rig.transport.regs) });
  });

  test(`Pfad 2 ${profile}: Neustart ohne eigene Sperre und Neustart mit Merker (dv_seq_saved.json)`, async (t) => {
    fixClock(t);
    const dir = tempDir(t, `seq-${profile}`);
    const savedPath = path.join(dir, 'dv_seq_saved.json');
    const merker = { dvSeqSavedPath: savedPath, dvSeqWritedayPath: path.join(dir, 'dv_seq_writeday.json') };
    const fresh = rigFor(profile, { ctx: merker });
    const r = recorder(fresh);
    await r.step('Start-Freigabe ohne Sicherung', dv(fresh, true, RELEASE));
    await r.step('Sperre (legt Sicherung an)', dv(fresh, false, LOCK));
    const saved = JSON.parse(fs.readFileSync(savedPath, 'utf8'));
    // „Neustart": frischer Zustand, dieselbe Sicherung und dasselbe Gerät (Register stehen gesperrt).
    const again = rigFor(profile, { ctx: merker });
    again.transport.regs.clear();
    for (const [a, v] of fresh.transport.regs) again.transport.regs.set(a, v);
    const r2 = recorder(again);
    await r2.step('Start-Freigabe mit eigener Sicherung', dv(again, true, RELEASE));
    golden.check(`${profile}_restart`, { before: r.steps, saved, after: r2.steps, savedAfter: JSON.parse(fs.readFileSync(savedPath, 'utf8')) });
  });

  test(`Pfad 2 ${profile}: Lesefehler beim Sichern und Endpunkt-/Geräte-Tor`, async (t) => {
    fixClock(t);
    const firstSave = { fronius: 40191, 'deye-lv': 142, sungrow: 13073 }[profile];
    const rig = rigFor(profile, { transport: { failRead: { [firstSave]: { msg: 'timeout', times: 1 } } } });
    const r = recorder(rig);
    await r.step('Sperre mit Lese-Zeitüberschreitung', dv(rig, false, LOCK));
    await r.step('Sperre erneut (nächster Takt)', dv(rig, false, LOCK));
    const unsafe = rigFor(profile);
    unsafe.cfg.writeSafety = { ok: false, reason: 'manufacturer_profile_error', manufacturer: profile };
    const r2 = recorder(unsafe);
    await r2.step('Sperre bei writeSafety.ok=false', dv(unsafe, false, LOCK));
    golden.check(`${profile}_errors`, { readError: r.steps, writeSafety: r2.steps });
  });
}

test('Pfad 2 fronius: Not-Halt mitten in der Sperr-Sequenz → Teil-Sperre, eine Freigabe im Not-Halt', async (t) => {
  fixClock(t);
  const rig = rigFor('fronius');
  const r = recorder(rig);
  rig.transport.failWrite[40198] = { msg: 'modbus write verworfen (Not-Halt seit dem Einreihen)', times: 1 };
  await r.step('Sperre, Schritt 2 verworfen', dv(rig, false, LOCK));
  Object.assign(rig.state.ctrl, { discretionaryWritesPaused: true, pausedAt: Date.now() });
  await r.step('Sperre im Not-Halt', dv(rig, false, LOCK));
  await r.step('Freigabe im Not-Halt ohne Not-Halt-Grund', dv(rig, true, RELEASE));
  await r.step('Freigabe im Not-Halt (emergency_stop_release)', dv(rig, true, { reason: 'emergency_stop_release' }));
  await r.step('zweite Freigabe im Not-Halt', dv(rig, true, { reason: 'emergency_stop_release' }));
  golden.check('fronius_nothalt_mid_sequence', { steps: r.steps, regs: Object.fromEntries(rig.transport.regs) });
});

test('Pfad 2 sungrow: Budget erschöpft — Sperre und ausdrücklicher Befehl schreiben, Automatik-Freigabe hält', async (t) => {
  fixClock(t);
  const dir = tempDir(t, 'budget');
  const writedayPath = path.join(dir, 'dv_seq_writeday.json');
  fs.writeFileSync(writedayPath, JSON.stringify({ key: new Date().toDateString(), count: 20 }));
  const rig = rigFor('sungrow', { ctx: { dvSeqWritedayPath: writedayPath } });
  const r = recorder(rig);
  await r.step('Sperre bei leerem Budget', dv(rig, false, LOCK));
  await r.step('Automatik-Freigabe bei leerem Budget', dv(rig, true, RELEASE));
  await r.step('Freigabe per API bei leerem Budget', api(rig, 1));
  golden.check('sungrow_budget_exhausted', { steps: r.steps, budget: rig.state.ctrl.dvSeqBudget.count });
});

test('Pfad 2 fronius: Budget erschöpft (feedExcessDcPv zählt)', async (t) => {
  fixClock(t);
  const dir = tempDir(t, 'budget-fr');
  const writedayPath = path.join(dir, 'dv_seq_writeday.json');
  fs.writeFileSync(writedayPath, JSON.stringify({ key: new Date().toDateString(), count: 19 }));
  const rig = rigFor('fronius', { ctx: { dvSeqWritedayPath: writedayPath } });
  const r = recorder(rig);
  await r.step('Sperre (letzte Sequenz im Budget)', dv(rig, false, LOCK));
  await r.step('Automatik-Freigabe bei leerem Budget', dv(rig, true, RELEASE));
  golden.check('fronius_budget_exhausted', r.steps);
});

test('Pfad 2 sungrow: abweichende Rücklesung, Rückstell-Ausnahme mit gesetztem Ziel, unklare Rücklesung, alte Firmware', async (t) => {
  fixClock(t);
  // Gerät verwirft 13073 still: Rücklesung zeigt weiter 5000 → Sequenz bricht nach Schritt 2 ab.
  const ignore = rigFor('sungrow', { transport: { ignoreWrite: [13073] } });
  const r1 = recorder(ignore);
  await r1.step('Sperre, 13073 wird verworfen', dv(ignore, false, LOCK));
  await r1.step('Freigabe der Teil-Sperre', dv(ignore, true, RELEASE));

  // M14: Rückstell-Write mit Ausnahme 4, Wert steht aber am Gerät → erledigt.
  const m14 = rigFor('sungrow');
  const r2 = recorder(m14);
  await r2.step('Sperre', dv(m14, false, LOCK));
  m14.transport.failWrite[13086] = { msg: 'modbus exception 4', apply: true, times: 1 };
  await r2.step('Freigabe, 13086 mit Ausnahme 4 (Wert übernommen)', dv(m14, true, RELEASE));

  // #820: Rücklesung 13087 wirft zweimal Ausnahme 4 → unbestätigt, Sequenz läuft weiter.
  const inc = rigFor('sungrow', { transport: { failRead: { 13087: { msg: 'modbus exception 4', skip: 1, times: 2 } } } });
  const r3 = recorder(inc);
  await r3.step('Sperre, Rücklesung 13087 unklar', dv(inc, false, LOCK));

  // Alte Firmware: 13087 unbekannt (Ausnahme 2) → optionaler Schritt fällt weg.
  const old = rigFor('sungrow', { transport: { failRead: { 13087: 'modbus exception 2' }, failWrite: { 13087: 'modbus exception 2' } } });
  const r4 = recorder(old);
  await r4.step('Sperre ohne 13087', dv(old, false, LOCK));
  await r4.step('Freigabe ohne 13087', dv(old, true, RELEASE));

  // Endpunktwechsel: erkannt wurde an einer anderen Adresse → Geräte-Tor zu.
  const moved = rigFor('sungrow', { state: { victron: { device: sungrowDevice({ endpointKey: '192.0.2.99:502:1' }) } } });
  const r5 = recorder(moved);
  await r5.step('Sperre nach Endpunktwechsel', dv(moved, false, LOCK));

  golden.check('sungrow_device_faults', {
    readbackMismatch: r1.steps, restoreAlreadySet: r2.steps, verifyInconclusive: r3.steps,
    oldFirmware: r4.steps, endpointChanged: r5.steps,
  });
});
