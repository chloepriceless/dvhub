// Golden-Master Pfad 1 der D.1-Inventur: applyControlTarget → applyControlTargetCore (Modbus), Nachweis D.4(2).
// „Gleiche Eingänge → gleiche geordnete Folge von Draht-Operationen."
//
// Victron über das AUSGELIEFERTE Profil (loadConfigFile): Netz-Sollwert 2716 (int32, FC16) mit Keepalive und
// Unverändert-Skip, Ladestrom 2705, Mindest-SoC 2901 (Klemme), Entladegrenze 2704 mit Sonderwerten (-1 → 32767,
// 0 bleibt 0), EEG-/Not-Halt-/Schreibsicherheits-Tor, Entlade-Boden bei veraltetem SoC, Schreibfehler, Flaggen-
// Delegation 2707/2708. Fronius/Deye: was über diesen Pfad erreichbar ist (Ablehnung bzw. Sequenz-Delegation).
// Sungrow-EMS läuft über gate-golden-sungrow.test.js.
//
// Frieren: GOLDEN_FREEZE=1 node --test test/gate-golden-control-target.test.js (schreibt
// test/fixtures/gate-golden/control-target.json neu). Nur mit belegtem Grund.

import { test } from 'node:test';

import {
  HOST, fixClock, loadProfileConfig, recordingModbus, baseState, evaluatorRig, recorder, goldenFile, dvOutcome,
} from './helpers/gate-golden.js';

const golden = goldenFile('control-target');

function victron({ persisted = {}, state = {}, transport = {} } = {}) {
  const cfg = loadProfileConfig('victron', { victron: { host: HOST }, ...persisted });
  return evaluatorRig({ cfg, transport: recordingModbus(transport), state: baseState(state) });
}

test('Pfad 1 Victron: Netz-Sollwert 2716 — Write, Unverändert-Skip, Keepalive, Wechsel, EEG-Tor', async (t) => {
  const advance = fixClock(t);
  const rig = victron({ persisted: { optimizer: { allowGridDischarge: true } } });
  const r = recorder(rig);
  const apply = (target, value, source) => () => rig.ev.applyControlTarget(target, value, source);
  await r.step('setpoint -500', apply('gridSetpointW', -500, 'rule:abend'));
  await r.step('setpoint -500 gleich', apply('gridSetpointW', -500, 'rule:abend'));
  await advance(4999);
  await r.step('setpoint -500 nach 4999 ms', apply('gridSetpointW', -500, 'rule:abend'));
  await advance(1);
  await r.step('setpoint -500 Keepalive fällig (5000 ms)', apply('gridSetpointW', -500, 'rule:abend'));
  await r.step('setpoint -1500 Wechsel', apply('gridSetpointW', -1500, 'rule:abend'));
  await r.step('setpoint +800 ohne Netzladen', apply('gridSetpointW', 800, 'rule:laden'));
  await r.step('setpoint 0', apply('gridSetpointW', 0, 'default'));
  await r.step('setpoint -3000 Pflicht-Quelle', apply('gridSetpointW', -3000, 'negative_price_protection'));
  await r.step('setpoint 999999 außerhalb Grenzen', apply('gridSetpointW', 999999, 'api_manual_write'));
  golden.check('victron_setpoint', r.steps);
});

test('Pfad 1 Victron: EEG-Tor ohne Netzentladung, Keepalive aus (2716-Schutz)', async (t) => {
  fixClock(t);
  const rig = victron({ persisted: { optimizer: { allowGridDischarge: false } } });
  const r = recorder(rig);
  await r.step('setpoint -2000 diskretionär', () => rig.ev.applyControlTarget('gridSetpointW', -2000, 'eos_optimization'));
  await r.step('setpoint -2000 Pflicht-Quelle', () => rig.ev.applyControlTarget('gridSetpointW', -2000, 'negative_price_protection'));
  await r.step('setpoint -900 unter Schwelle', () => rig.ev.applyControlTarget('gridSetpointW', -900, 'eos_optimization'));
  golden.check('victron_eeg_gate', r.steps);

  const noKa = victron({ persisted: { schedule: { controlKeepaliveMs: 0 } } });
  const r2 = recorder(noKa);
  await r2.step('setpoint -500 ohne Keepalive', () => noKa.ev.applyControlTarget('gridSetpointW', -500, 'rule:abend'));
  golden.check('victron_volatile_guard', r2.steps);
});

test('Pfad 1 Victron: Ladestrom 2705, Mindest-SoC 2901, Entladegrenze 2704 mit Sonderwerten', async (t) => {
  fixClock(t);
  const rig = victron();
  const r = recorder(rig);
  const apply = (target, value, source = 'api_manual_write') => () => rig.ev.applyControlTarget(target, value, source);
  await r.step('chargeCurrentA 30', apply('chargeCurrentA', 30));
  await r.step('chargeCurrentA 30 gleich', apply('chargeCurrentA', 30));
  await r.step('chargeCurrentA -1', apply('chargeCurrentA', -1));
  await r.step('minSocPct 20', apply('minSocPct', 20));
  await r.step('minSocPct 3 → Klemme auf hardFloor', apply('minSocPct', 3));
  await r.step('maxDischargeW -1 (unbegrenzt)', apply('maxDischargeW', -1));
  await r.step('maxDischargeW 0 (Sperre)', apply('maxDischargeW', 0));
  await r.step('maxDischargeW 4000', apply('maxDischargeW', 4000));
  await r.step('maxDischargeW 4004 (Raster 10 W)', apply('maxDischargeW', 4004));
  await r.step('dvFeedInLimitW 3049 (abwärts runden)', apply('dvFeedInLimitW', 3049));
  golden.check('victron_targets', r.steps);
});

test('Pfad 1 Victron: Entlade-Boden bei veraltetem SoC und am harten Boden', async (t) => {
  fixClock(t);
  const stale = victron({ persisted: { optimizer: { allowGridDischarge: true } }, state: { soc: 60, socFresh: false } });
  const r = recorder(stale);
  await r.step('setpoint -1500 SoC veraltet', () => stale.ev.applyControlTarget('gridSetpointW', -1500, 'rule:abend'));
  await r.step('maxDischargeW 4000 SoC veraltet', () => stale.ev.applyControlTarget('maxDischargeW', 4000, 'rule:abend'));
  await r.step('chargeCurrentA 20 SoC veraltet (kein Entladen)', () => stale.ev.applyControlTarget('chargeCurrentA', 20, 'rule:abend'));
  golden.check('victron_floor_stale', r.steps);

  const floor = victron({ persisted: { optimizer: { allowGridDischarge: true, hardFloorSocPct: 10 } }, state: { soc: 9 } });
  const r2 = recorder(floor);
  await r2.step('setpoint -1500 SoC 9 % ≤ Boden 10 %', () => floor.ev.applyControlTarget('gridSetpointW', -1500, 'rule:abend'));
  await r2.step('setpoint +0 SoC 9 %', () => floor.ev.applyControlTarget('gridSetpointW', 0, 'rule:abend'));
  golden.check('victron_floor_hard', r2.steps);
});

test('Pfad 1 Victron: Not-Halt, Schreibsicherheit (ungültiges Profil), Schreibfehler mit Wiederholung', async (t) => {
  fixClock(t);
  const halt = victron({ state: { ctrl: { discretionaryWritesPaused: true, pausedAt: Date.now() } } });
  const r = recorder(halt);
  await r.step('setpoint -500 im Not-Halt', () => halt.ev.applyControlTarget('gridSetpointW', -500, 'rule:abend'));
  await r.step('setpoint -500 Pflicht im Not-Halt', () => halt.ev.applyControlTarget('gridSetpointW', -500, 'negative_price_protection'));
  await r.step('maxDischargeW 0 Peak-Shaving-Rücknahme (einmal)', () => halt.ev.applyControlTarget('maxDischargeW', 0, 'peak_shaving_restore'));
  await r.step('maxDischargeW 0 Peak-Shaving-Rücknahme (zweites Mal)', () => halt.ev.applyControlTarget('maxDischargeW', 0, 'peak_shaving_restore'));
  golden.check('victron_nothalt', r.steps);

  const unsafe = victron();
  unsafe.cfg.writeSafety = { ok: false, reason: 'manufacturer_profile_error', manufacturer: 'victron' };
  const r2 = recorder(unsafe);
  await r2.step('setpoint -500 bei writeSafety.ok=false', () => unsafe.ev.applyControlTarget('gridSetpointW', -500, 'rule:abend'));
  await r2.step('feedExcessDcPv 0 bei writeSafety.ok=false', () => unsafe.ev.applyControlTarget('feedExcessDcPv', 0, 'negative_price_protection'));
  golden.check('victron_write_safety', r2.steps);

  const err = victron({ persisted: { optimizer: { allowGridDischarge: true } }, transport: { failWrite: { 2716: { msg: 'timeout', times: 1 } } } });
  const r3 = recorder(err);
  await r3.step('setpoint -700 Zeitüberschreitung', () => err.ev.applyControlTarget('gridSetpointW', -700, 'rule:abend'));
  await r3.step('setpoint -700 erneut (kein Unverändert-Skip nach Fehler)', () => err.ev.applyControlTarget('gridSetpointW', -700, 'rule:abend'));
  golden.check('victron_write_error', r3.steps);
});

test('Pfad 1 Victron: Einspeise-Flagge 2707/2708 läuft über den einen DV-Schreibweg', async (t) => {
  fixClock(t);
  const rig = victron();
  const r = recorder(rig);
  const dv = (value, source) => async () => ({ ...(await rig.ev.applyControlTarget('feedExcessDcPv', value, source)), ...dvOutcome(rig.state) });
  await r.step('feedExcessDcPv 0 (§51)', dv(0, 'negative_price_protection'));
  await r.step('feedExcessDcPv 0 gleich', dv(0, 'negative_price_protection'));
  rig.state.ctrl.negativePriceActive = true;
  await r.step('feedExcessDcPv 1 Hand bei aktiver §51-Sperre', dv(1, 'api_manual_write'));
  rig.state.ctrl.negativePriceActive = false;
  await r.step('feedExcessDcPv 1 Hand', dv(1, 'api_manual_write'));
  golden.check('victron_feed_flag', r.steps);
});

test('Pfad 1 Fronius/Deye: Netz-Sollwert nicht schreibbar, Flagge delegiert an die Sequenz', async (t) => {
  fixClock(t);
  const cfg = loadProfileConfig('fronius', { victron: { host: HOST } });
  cfg.controlWrite.storCtlMod.address = 40191;   // SunSpec-Scan (polling.js) nachgestellt
  cfg.controlWrite.outWRte.address = 40198;
  const fr = evaluatorRig({ cfg, transport: recordingModbus({ holding: { 40191: 1, 40198: 0xec78 } }), state: baseState() });
  const r = recorder(fr);
  await r.step('fronius setpoint -500', () => fr.ev.applyControlTarget('gridSetpointW', -500, 'rule:abend'));
  await r.step('fronius maxDischargeW 0', () => fr.ev.applyControlTarget('maxDischargeW', 0, 'rule:abend'));
  await r.step('fronius feedExcessDcPv 0 (§51)', async () => ({ ...(await fr.ev.applyControlTarget('feedExcessDcPv', 0, 'negative_price_protection')), ...dvOutcome(fr.state) }));
  await r.step('fronius feedExcessDcPv 1 Hand', async () => ({ ...(await fr.ev.applyControlTarget('feedExcessDcPv', 1, 'api_manual_write')), ...dvOutcome(fr.state) }));
  golden.check('fronius_reachable', r.steps);

  const unresolved = loadProfileConfig('fronius', { victron: { host: HOST } });
  const fu = evaluatorRig({ cfg: unresolved, transport: recordingModbus(), state: baseState() });
  const r2 = recorder(fu);
  await r2.step('fronius wMaxLimPct ohne SunSpec-Scan', () => fu.ev.applyControlTarget('wMaxLimPct', 50, 'api_manual_write'));
  golden.check('fronius_unresolved', r2.steps);

  const dcfg = loadProfileConfig('deye-lv', { victron: { host: HOST } });
  const de = evaluatorRig({ cfg: dcfg, transport: recordingModbus({ holding: { 142: 1 } }), state: baseState() });
  const r3 = recorder(de);
  await r3.step('deye setpoint -500', () => de.ev.applyControlTarget('gridSetpointW', -500, 'rule:abend'));
  await r3.step('deye feedExcessDcPv 0', () => de.ev.applyControlTarget('feedExcessDcPv', 0, 'negative_price_protection'));
  await r3.step('deye workMode 2 direkt', () => de.ev.applyControlTarget('workMode', 2, 'api_manual_write'));
  // Sequenz-Flagge ohne eigenes Register (nur feedExcessDcPv delegiert): bis 18.11.2026 ging sie über den generischen
  // Einzelregister-Zweig auf Register 0 (W6 @0=1); seither abgelehnt (fix(control), kein Write ohne gültige Adresse,
  // test/control-target-address-guard.test.js) — der einzige neu eingefrorene Schritt dieser Datei.
  await r3.step('deye dontFeedExcessAcPv 1 direkt', () => de.ev.applyControlTarget('dontFeedExcessAcPv', 1, 'api_manual_write'));
  golden.check('deye_reachable', r3.steps);
});
