// Integration 1.0.12 (Merge fix/fehler-von-heute → release/1.0.12-test):
// Im feedExcessDcPv-Chokepoint müssen main's M14 DV_RELEASE_BACKOFF (Freigabe-
// Drosselung) und die Branch-Fixes C1 (ein Schreibweg), A10 (Pflicht-Sperre)
// und A11 (dvFeedInUnchanged, Teil-Block-Ausnahme) KOEXISTIEREN. Dieser Test
// nagelt die Grenzen der Verwebung fest, damit kein späterer Umbau einen der
// drei Mechanismen still aushebelt.
//
//  - A10 steht VOR dem Schreibweg: eine Handfreigabe gegen eine Pflicht-Sperre
//    wird abgelehnt, egal wie der Backoff steht.
//  - Der Backoff drosselt NUR die automatische Freigabe (feedIn=true, !explicit);
//    eine Sperre (feedIn=false) schreibt bei jedem echten Fehler scharf weiter.
//  - Ein ausdrücklicher Befehl (explicit, Chokepoint-Handfreigabe) umgeht den
//    Backoff — und A11 lässt ihn trotz gleichem Change-Cache durch, solange eine
//    Teil-Sperre steht.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createScheduleEvaluator } from '../schedule-eval.js';

function makeEvaluator(cfg, ctrl = {}) {
  const transport = {
    type: 'modbus',
    writes: [],
    fail: false,
    async mbWriteSingle({ address, value }) {
      if (this.fail) { const e = new Error('modbus exception 4'); throw e; }
      this.writes.push({ address, value });
    },
    async mbWriteMultiple({ address, values }) { this.writes.push({ address, values }); }
  };
  const state = {
    victron: { soc: 50 },
    ctrl,
    schedule: { rules: [], active: {}, lastWrite: {}, manualOverride: {}, config: {}, lastEvalAt: 0 }
  };
  const logs = [];
  const evaluator = createScheduleEvaluator({
    state, getCfg: () => cfg, transport,
    pushLog: (event, details) => logs.push({ event, details }),
    telemetrySafeWrite: () => {}, persistConfig: async () => {},
    telemetryStore: null, epexNowNext: () => null
  });
  return { evaluator, state, transport, logs };
}

// Victron-Direktregister 2707 (keine Sequenz) — der kanonische ein-Schreibweg.
function victronCfg() {
  return {
    controlWrite: {},
    dvControl: { enabled: true, feedExcessDcPv: { enabled: true, fc: 6, address: 2707 } }
  };
}

test('A10 schlägt Backoff: eine Handfreigabe gegen eine Pflicht-Sperre wird am Chokepoint abgelehnt (kein Write)', async () => {
  // Pflicht-Sperre aktiv (Negativpreis) + schon engagierter Backoff → trotzdem
  // darf eine nicht-mandatorische Handfreigabe nicht durch.
  const { evaluator, transport } = makeEvaluator(victronCfg(), {
    negativePriceActive: true,
    _dvReleaseBackoff: { feedExcessDcPv: { fails: 9, nextAt: 0, lastError: 'x' } }
  });
  const res = await evaluator.applyControlTarget('feedExcessDcPv', 1, 'api_manual_write');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'feed_in_blocked_negative_price_protection');
  assert.deepEqual(transport.writes, [], 'A10 greift VOR dem Schreibweg — kein Hardware-Write');
});

test('A10 weicht einer mandatorischen Quelle: der §51-Sperrpfad selbst darf schreiben', async () => {
  const { evaluator, transport } = makeEvaluator(victronCfg(), { negativePriceActive: true });
  // Die Sperre (feedIn=0) über eine mandatorische Quelle läuft durch.
  const res = await evaluator.applyControlTarget('feedExcessDcPv', 0, 'negative_price_protection');
  assert.equal(res.ok, true);
  assert.deepEqual(transport.writes, [{ address: 2707, value: 0 }]);
});

test('Backoff drosselt NUR die automatische Freigabe — eine Pflicht-Sperre schreibt scharf weiter', async () => {
  const { evaluator, state, transport } = makeEvaluator(victronCfg());
  transport.fail = true;
  // Drei automatische Freigaben scheitern echt → Backoff rastet ein.
  for (let i = 0; i < 3; i++) {
    await evaluator.applyDvVictronControl(true, { reason: 'control_disabled_release' });
  }
  const bk = state.ctrl._dvReleaseBackoff.feedExcessDcPv;
  assert.equal(bk.fails, 3, 'drei Fehlschläge gezählt');
  assert.ok(bk.nextAt > Date.now(), 'Backoff-Fenster offen');
  // Vierte automatische Freigabe im Fenster: still gehalten, KEIN Schreibversuch.
  transport.fail = false;
  transport.writes.length = 0;
  await evaluator.applyDvVictronControl(true, { reason: 'control_disabled_release' });
  assert.equal(state.ctrl.dvControl.feedExcessDcPv.backoff, true, 'automatische Freigabe gedrosselt');
  assert.deepEqual(transport.writes, [], 'kein Write während des Backoff-Fensters');
  // Eine Sperre (feedIn=false) wird NIE gedrosselt — sie muss scharf schreiben.
  await evaluator.applyDvVictronControl(false, { reason: 'negative_price_protection' });
  assert.deepEqual(transport.writes, [{ address: 2707, value: 0 }], 'Sperre schreibt trotz offenem Backoff');
});

test('Ausdrücklicher Befehl umgeht den Backoff, A11 lässt die Freigabe trotz Teil-Block + gleichem Cache durch', async () => {
  const { evaluator, state, transport } = makeEvaluator(victronCfg(), {
    // Backoff voll engagiert, Change-Cache steht bereits auf "freigegeben",
    // und eine Teil-Sperre hängt (A11-Ausnahme).
    _dvReleaseBackoff: { feedExcessDcPv: { fails: 9, nextAt: Date.now() + 300000, lastError: 'x' } },
    _lastDvFeedIn: true,
    _dvPartialBlock: true
  });
  const res = await evaluator.applyControlTarget('feedExcessDcPv', 1, 'api_manual_write');
  assert.equal(res.ok, true, 'explicit umgeht den Backoff');
  assert.deepEqual(transport.writes, [{ address: 2707, value: 1 }], 'A11: Teil-Block erzwingt den Freigabe-Write');
  assert.equal(state.ctrl._dvReleaseBackoff.feedExcessDcPv.fails, 0, 'erfolgreicher Write setzt den Backoff zurück');
});
