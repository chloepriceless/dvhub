// A11 / FIX 1 (Christin 17.11.2026): nach einer Teil-Sperre (2707 geschrieben,
// 2708 gescheitert) bleibt _lastDvFeedIn=true und _dvPartialBlock=true. Eine
// spätere Handfreigabe (feedIn=1) über den Chokepoint (applyControlTarget) traf
// den Früh-Skip `_lastDvFeedIn === feedIn` → er gab fälschlich „unchanged"
// zurück, OHNE applyDvVictronControl zu rufen: 2707 blieb sperrend, die PV
// abgeregelt. Der Skip hatte nicht die Teil-Block-Ausnahme, die
// applyDvVictronControl kennt. Beide Stellen teilen jetzt EIN Prädikat
// (dvFeedInUnchanged), das die Ausnahme enthält.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createScheduleEvaluator } from '../schedule-eval.js';

function makeTransport() {
  return {
    type: 'modbus',
    writes: [],
    failAddress: null,
    async mbWriteSingle({ address, value }) {
      if (address === this.failAddress) throw new Error('modbus write verworfen (2708)');
      this.writes.push({ address, value });
    },
    async mbWriteMultiple({ address, values }) { this.writes.push({ address, values }); }
  };
}

// Victron-Direktregister: 2707 (feedExcessDcPv) UND 2708 (dontFeedExcessAcPv).
function victronBothCfg() {
  return {
    controlWrite: {},
    dvControl: {
      enabled: true,
      feedExcessDcPv: { enabled: true, fc: 6, address: 2707, writeType: 'uint16' },
      dontFeedExcessAcPv: { enabled: true, fc: 6, address: 2708, writeType: 'uint16' }
    }
  };
}

function makeEvaluator(cfg, ctrl = {}) {
  const state = {
    victron: { soc: 50 }, ctrl,
    schedule: { rules: [], active: {}, lastWrite: {}, manualOverride: {}, config: {}, lastEvalAt: 0 }
  };
  const logs = [];
  const transport = makeTransport();
  const evaluator = createScheduleEvaluator({
    state, getCfg: () => cfg, transport,
    pushLog: (event, details) => logs.push({ event, details }),
    telemetrySafeWrite: () => {}, persistConfig: async () => {},
    telemetryStore: null, epexNowNext: () => null
  });
  return { evaluator, state, transport, logs };
}

test('FIX 1: Handfreigabe nach Teil-Block gibt 2707 wieder frei (nicht fälschlich „unchanged")', async () => {
  const { evaluator, state, transport } = makeEvaluator(victronBothCfg());

  // 1) Ausgangslage: vollständige Freigabe → _lastDvFeedIn=true, kein Teil-Block.
  await evaluator.applyDvVictronControl(true, { explicit: true });
  assert.equal(state.ctrl._lastDvFeedIn, true);
  assert.equal(state.ctrl._dvPartialBlock, false);

  // 2) Sperre, bei der 2708 scheitert → Teil-Block. 2707 steht auf 0 (sperrend),
  //    _lastDvFeedIn bleibt true (Write nicht vollständig), _dvPartialBlock=true.
  transport.failAddress = 2708;
  const block = await evaluator.applyControlTarget('feedExcessDcPv', 0, 'rule');
  assert.equal(block.ok, true);
  assert.deepEqual(transport.writes.filter((w) => w.address === 2707).at(-1), { address: 2707, value: 0 }, '2707 sperrt');
  assert.equal(state.ctrl._lastDvFeedIn, true, 'Cache bleibt (Sperre nicht vollständig)');
  assert.equal(state.ctrl._dvPartialBlock, true, 'als eigene Teil-Sperre erkannt');

  // 3) Handfreigabe (feedIn=1) über den Chokepoint. 2708 geht wieder.
  transport.failAddress = null;
  transport.writes.length = 0;
  const release = await evaluator.applyControlTarget('feedExcessDcPv', 1, 'api_manual_write');

  // Kern des Fehlers: darf NICHT „unchanged" sein, muss 2707 wieder freigeben.
  assert.notEqual(release.skipped, true, 'die Freigabe darf nicht als unchanged übersprungen werden');
  assert.deepEqual(transport.writes.find((w) => w.address === 2707), { address: 2707, value: 1 }, '2707 wieder freigegeben');
  assert.equal(state.ctrl._lastDvFeedIn, true);
  assert.equal(state.ctrl._dvPartialBlock, false, 'Teil-Block aufgelöst');
});

test('FIX 1: echte Wiederholung ohne Teil-Block bleibt ein gehaltener No-op', async () => {
  // Gegenprobe: ohne Teil-Block greift der Skip weiterhin (kein zweiter Write).
  const { evaluator, transport } = makeEvaluator(victronBothCfg(), { _lastDvFeedIn: true, _dvPartialBlock: false });
  const res = await evaluator.applyControlTarget('feedExcessDcPv', 1, 'api_manual_write');
  assert.equal(res.skipped, true, 'unverändert → gehalten');
  assert.equal(transport.writes.length, 0, 'kein Write');
});
