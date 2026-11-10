// test/dv-teilsequenz-nothalt.test.js — Codex 56e41b93 (P1): bricht eine
// Sperr-Sequenz nach dem ersten Schritt ab (Write verworfen, weil der Not-Halt
// dazwischen kam, oder Zeitüberschreitung), stand das geänderte Register ohne
// Spur da: _dvPartialBlock blieb aus, der Not-Halt sah keine eigene Sperre
// (emergency_stop_idle) und stellte z. B. Fronius StorCtl_Mod nie zurück.
// Jetzt zählt jede teilweise geschriebene Sperr-Sequenz als eigene Teil-Sperre.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfigFile } from '../config-model.js';
import { createScheduleEvaluator } from '../schedule-eval.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function setup(failAddress) {
  // Erst nach der Ausgangslage (Freigabe) scheitern lassen: fail.address setzt der Test.
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-teilseq-'));
  fs.mkdirSync(path.join(rootDir, 'hersteller'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'hersteller', 'fronius.json'), path.join(rootDir, 'hersteller', 'fronius.json'));
  const configPath = path.join(rootDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ manufacturer: 'fronius', victron: { host: '192.0.2.10' } }));
  const cfg = loadConfigFile(configPath).effectiveConfig;
  cfg.controlWrite.storCtlMod.address = 40191;
  cfg.controlWrite.outWRte.address = 40198;
  const regs = { 40191: 1, 40198: 0xec78 };
  const writes = [];
  const fail = { address: null, later: failAddress };
  const transport = {
    type: 'modbus',
    async mbRequest({ address, quantity = 1 }) { return Array.from({ length: quantity }, (_, i) => regs[address + i] ?? 0); },
    async mbWriteSingle({ address, value }) {
      if (address === fail.address) throw new Error('modbus write verworfen (Not-Halt seit dem Einreihen)');
      writes.push([address, value]); regs[address] = value;
    },
    async mbWriteMultiple({ address, values }) { writes.push([address, values]); }
  };
  const state = { victron: { soc: 50 }, ctrl: {}, schedule: { rules: [], active: {}, lastWrite: {}, manualOverride: {}, config: {}, lastEvalAt: 0 } };
  const ev = createScheduleEvaluator({
    state, getCfg: () => cfg, transport, dvSeqSavedPath: path.join(rootDir, 'dv_seq_saved.json'),
    pushLog: () => {}, telemetrySafeWrite: () => {}, persistConfig: async () => {}, epexNowNext: () => null,
    regenerateSmallMarketAutomationRules: async () => {}
  });
  return { ev, state, writes, regs, fail, cleanup: () => fs.rmSync(rootDir, { recursive: true, force: true }) };
}

test('Sperr-Sequenz nach Schritt 1 abgebrochen → Teil-Sperre, die Freigabe stellt StorCtl_Mod zurück', async () => {
  const s = setup(40198);                               // OutWRte scheitert
  try {
    await s.ev.applyDvVictronControl(true, { explicit: true });   // Ausgangslage wie im Befund: _lastDvFeedIn = true
    assert.equal(s.state.ctrl._lastDvFeedIn, true);
    s.regs[40191] = 1; s.regs[40198] = 0xec78;                    // Kundenwerte
    s.fail.address = s.fail.later;
    await s.ev.applyDvVictronControl(false);
    assert.deepEqual(s.writes.filter(([a]) => a === 40191).at(-1), [40191, 2], 'Schritt 1 steht am Gerät');
    assert.equal(s.state.ctrl._lastDvFeedIn, true, 'Cache bleibt (Sperre nicht vollständig)');
    assert.equal(s.state.ctrl._dvPartialBlock, true, 'als eigene Teil-Sperre erkannt');
    // Freigabe (z. B. die eine Rücknahme im Not-Halt) schreibt den gesicherten Wert zurück.
    s.fail.address = null;
    s.writes.length = 0;
    await s.ev.applyDvVictronControl(true);
    assert.deepEqual(s.writes.find(([a]) => a === 40191), [40191, 1]);
    assert.equal(s.state.ctrl._dvPartialBlock, false);
  } finally { s.cleanup(); }
});

test('Sperr-Sequenz scheitert schon am ersten Schritt → keine Teil-Sperre', async () => {
  const s = setup(40191);
  try {
    await s.ev.applyDvVictronControl(true, { explicit: true });
    s.fail.address = s.fail.later;
    await s.ev.applyDvVictronControl(false);
    assert.equal(s.state.ctrl._lastDvFeedIn, true);
    assert.notEqual(s.state.ctrl._dvPartialBlock, true);
  } finally { s.cleanup(); }
});
