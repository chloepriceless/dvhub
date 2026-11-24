// A11 / FIX 2 (Christin 17.11.2026): C1 lenkte den feedExcessDcPv-Direktregister-
// Write vom generischen Einzelregister-Pfad (der maybeScheduleWriteVerify rief)
// auf den dv_control-Pfad (applyDvVictronControl) um — der plante KEIN Rücklese-
// Verify mehr. Folge: bei aktivem schedule.controlWriteVerify.enabled fehlte die
// Read-after-Write-Prüfung für die Victron-Direktregister 2707/2708.
// Jetzt zieht applyDvVictronControl das Verify für beide Direktregister nach —
// aber NUR hinter dem Flag (Standard AUS → kein zusätzlicher Read).
import test from 'node:test';
import assert from 'node:assert/strict';

import { createScheduleEvaluator } from '../schedule-eval.js';

function makeTransport() {
  return {
    type: 'modbus',
    writes: [],
    reads: [],
    regs: { 2707: 0, 2708: 0 },
    // Rücklese-Wert pro Adresse überschreibbar (für den Mismatch-Fall).
    readOverride: {},
    async mbWriteSingle({ address, value }) { this.writes.push({ address, value }); this.regs[address] = value; },
    async mbWriteMultiple({ address, values }) { this.writes.push({ address, values }); },
    async mbRequest({ address, quantity = 1 }) {
      this.reads.push({ address, quantity });
      return Array.from({ length: quantity }, (_, i) => {
        const a = address + i;
        return (a in this.readOverride) ? this.readOverride[a] : (this.regs[a] ?? 0);
      });
    }
  };
}

function cfgBoth(verify) {
  return {
    controlWrite: {},
    dvControl: {
      enabled: true,
      feedExcessDcPv: { enabled: true, fc: 6, address: 2707, writeType: 'uint16' },
      dontFeedExcessAcPv: { enabled: true, fc: 6, address: 2708, writeType: 'uint16' }
    },
    schedule: verify ? { controlWriteVerify: { enabled: true, delayMs: 1, minIntervalMs: 1 } } : {}
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

const flush = (ms = 40) => new Promise((r) => setTimeout(r, ms));

test('FIX 2: Flag AN → feedExcessDcPv-Direktwrite plant ein Rücklese-Verify (match → bestätigt, kein Neu-Write)', async () => {
  const { evaluator, transport, logs } = makeEvaluator(cfgBoth(true), { _lastDvFeedIn: true });
  // Sperre (feedIn=0): 2707 := 0, 2708 := 1.
  const res = await evaluator.applyControlTarget('feedExcessDcPv', 0, 'rule');
  assert.equal(res.ok, true);
  await flush();

  const reads2707 = transport.reads.filter((r) => r.address === 2707);
  assert.equal(reads2707.length >= 1, true, 'ein Rücklese-Read auf 2707');
  assert.ok(logs.some((l) => l.event === 'control_write_verified'), 'als bestätigt geloggt');
  assert.ok(logs.every((l) => l.event !== 'control_write_unconfirmed'), 'kein Mismatch');
});

test('FIX 2: Flag AN → Mismatch verwirft den lastWrite (nächster Assert schreibt neu) und loggt unconfirmed', async () => {
  const { evaluator, state, transport, logs } = makeEvaluator(cfgBoth(true), { _lastDvFeedIn: true });
  // Das Gerät nimmt die Sperre NICHT an: 2707 bleibt 1 beim Rücklesen.
  transport.readOverride[2707] = 1;
  const res = await evaluator.applyControlTarget('feedExcessDcPv', 0, 'rule');
  assert.equal(res.ok, true);
  await flush();

  assert.ok(logs.some((l) => l.event === 'control_write_unconfirmed'), 'Mismatch geloggt');
  assert.equal(state.schedule.lastWrite.feedExcessDcPv, undefined, 'lastWrite verworfen → Short-Circuit greift nicht, Neu-Write folgt');
});

test('FIX 2: Flag AN → auch 2708 (dontFeedExcessAcPv) wird zurückgelesen', async () => {
  const { evaluator, transport } = makeEvaluator(cfgBoth(true), { _lastDvFeedIn: true });
  await evaluator.applyControlTarget('feedExcessDcPv', 0, 'rule'); // 2708 := 1
  await flush();
  assert.equal(transport.reads.some((r) => r.address === 2708), true, 'Rücklese-Read auf 2708');
});

test('FIX 2: Flag AUS (Standard) → KEIN zusätzlicher Read, kein Verhalten geändert', async () => {
  const { evaluator, state, transport } = makeEvaluator(cfgBoth(false), { _lastDvFeedIn: true });
  const res = await evaluator.applyControlTarget('feedExcessDcPv', 0, 'rule');
  assert.equal(res.ok, true);
  assert.equal(res.writeType, 'dv_control');
  await flush();
  assert.equal(transport.reads.length, 0, 'keine Rücklese-Reads, wenn das Flag aus ist');
  // Schlanker lastWrite-Eintrag wie bisher (Chokepoint), kein Verify-Overhead.
  assert.equal(state.schedule.lastWrite.feedExcessDcPv?.value, 0);
});
