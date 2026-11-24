// Golden-Master Pfad 3 der D.1-Inventur: applyDvVictronControl mit den Victron-Direktregistern 2707
// (OvervoltageFeedIn, 1 = einspeisen) und 2708 (PreventFeedback, 1 = sperren), Nachweis D.4(2).
// Ausgeliefertes Victron-Profil (loadConfigFile). Eingangsfolgen: Sperre/Freigabe, unverändert, Start-Freigabe
// (Direktregister kennen keinen Merker), Steuerung aus (nur Freigabe), Teil-Sperre bei Schreibfehler und die eine
// Freigabe im Not-Halt, Not-Halt-Sperre, Schreibsicherheit, Rücklese-Prüfung (controlWriteVerify) mit Treffer und
// Abweichung, Freigabe-Backoff nach drei Fehlschlägen.
//
// Frieren: GOLDEN_FREEZE=1 node --test test/gate-golden-dv-victron.test.js (schreibt
// test/fixtures/gate-golden/dv-victron.json neu). Nur mit belegtem Grund.

import { test } from 'node:test';

import {
  HOST, fixClock, loadProfileConfig, recordingModbus, baseState, evaluatorRig, recorder, goldenFile, dvOutcome,
} from './helpers/gate-golden.js';

const golden = goldenFile('dv-victron');

function rig({ persisted = {}, state = {}, transport = {} } = {}) {
  const cfg = loadProfileConfig('victron', { victron: { host: HOST }, ...persisted });
  return evaluatorRig({ cfg, transport: recordingModbus({ holding: { 2707: 1, 2708: 0 }, ...transport }), state: baseState(state) });
}
const dv = (r, feedIn, opts = {}) => async () => { await r.ev.applyDvVictronControl(feedIn, opts); return dvOutcome(r.state); };

test('Pfad 3 Victron: Sperre/Freigabe 2707/2708, unverändert, Start-Freigabe', async (t) => {
  fixClock(t);
  const a = rig();
  const r = recorder(a);
  await r.step('Start-Freigabe (Cache leer)', dv(a, true, { reason: 'price_recovered' }));
  await r.step('Sperre (§51)', dv(a, false, { reason: 'negative_price_protection' }));
  await r.step('Sperre gleich', dv(a, false, { reason: 'negative_price_protection' }));
  await r.step('Sperre DV (forcedOff)', dv(a, false, { reason: 'dv_forced_off' }));
  await r.step('Freigabe', dv(a, true, { reason: 'price_recovered' }));
  golden.check('cycle', r.steps);
});

test('Pfad 3 Victron: Steuerung aus — nie sperren, nur freigeben', async (t) => {
  fixClock(t);
  const a = rig({ persisted: { dvControl: { enabled: false } } });
  const r = recorder(a);
  await r.step('Sperre bei dvControl.enabled=false', dv(a, false, { reason: 'negative_price_protection' }));
  await r.step('Freigabe bei dvControl.enabled=false', dv(a, true, { reason: 'control_disabled_release' }));
  golden.check('control_disabled', r.steps);
});

test('Pfad 3 Victron: Teil-Sperre (2708 scheitert), Not-Halt, eine Freigabe, Schreibsicherheit', async (t) => {
  fixClock(t);
  const a = rig({ transport: { failWrite: { 2708: { msg: 'timeout', times: 1 } } } });
  const r = recorder(a);
  await r.step('Sperre, 2708 Zeitüberschreitung', dv(a, false, { reason: 'negative_price_protection' }));
  Object.assign(a.state.ctrl, { discretionaryWritesPaused: true, pausedAt: Date.now() });
  await r.step('Sperre im Not-Halt', dv(a, false, { reason: 'negative_price_protection' }));
  await r.step('Freigabe im Not-Halt (emergency_stop_release)', dv(a, true, { reason: 'emergency_stop_release' }));
  await r.step('Freigabe erneut', dv(a, true, { reason: 'emergency_stop_release' }));
  golden.check('partial_nothalt', r.steps);

  const u = rig();
  u.cfg.writeSafety = { ok: false, reason: 'manufacturer_profile_error', manufacturer: 'victron' };
  const r2 = recorder(u);
  await r2.step('Sperre bei writeSafety.ok=false', dv(u, false, { reason: 'negative_price_protection' }));
  await r2.step('Freigabe bei writeSafety.ok=false', dv(u, true, { reason: 'price_recovered' }));
  golden.check('write_safety', r2.steps);
});

test('Pfad 3 Victron: Freigabe scheitert dreimal → Backoff 5 min, ausdrücklicher Befehl umgeht ihn', async (t) => {
  const advance = fixClock(t);
  const a = rig({ transport: { failWrite: { 2707: { msg: 'timeout', skip: 1, times: 3 } } } });
  const r = recorder(a);
  await r.step('Sperre', dv(a, false, { reason: 'negative_price_protection' }));
  for (let i = 1; i <= 4; i += 1) await r.step(`Freigabe Versuch ${i}`, dv(a, true, { reason: 'price_recovered' }));
  await advance(5 * 60_000);
  await r.step('Freigabe nach Backoff-Fenster', dv(a, true, { reason: 'price_recovered' }));
  golden.check('release_backoff', r.steps);

  const b = rig({ transport: { failWrite: { 2707: { msg: 'timeout', skip: 1, times: 3 } } } });
  const r2 = recorder(b);
  await r2.step('Sperre', dv(b, false, { reason: 'negative_price_protection' }));
  for (let i = 1; i <= 3; i += 1) await r2.step(`Freigabe Versuch ${i}`, dv(b, true, { reason: 'price_recovered' }));
  await r2.step('Freigabe ausdrücklich im Backoff', dv(b, true, { explicit: true, reason: 'api_manual_write' }));
  golden.check('release_backoff_explicit', r2.steps);
});

test('Pfad 3 Victron: Rücklese-Prüfung (controlWriteVerify) — bestätigt und abweichend', async (t) => {
  const advance = fixClock(t, ['Date', 'setTimeout']);
  const verify = { schedule: { controlWriteVerify: { enabled: true, delayMs: 1000, minIntervalMs: 1000 } } };
  const ok = rig({ persisted: verify });
  const r = recorder(ok);
  await r.step('Sperre', dv(ok, false, { reason: 'negative_price_protection' }));
  await r.step('Prüfung nach 1 s', async () => { await advance(1000); return {}; });
  golden.check('verify_match', r.steps);

  const bad = rig({ persisted: verify, transport: { ignoreWrite: [2708] } });
  const r2 = recorder(bad);
  await r2.step('Sperre, Gerät verwirft 2708', dv(bad, false, { reason: 'negative_price_protection' }));
  await r2.step('Prüfung nach 1 s', async () => { await advance(1000); return {}; });
  golden.check('verify_mismatch', r2.steps);
});
