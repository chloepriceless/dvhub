// Review Regelung 25.10. (P2): runDvControlSequence/saveBefore sicherte den
// gelesenen Registerwert als `regs[0] * scale + offset` — ohne Vorzeichen
// (int16) und ohne Sentinels. Folgen an den ausgelieferten Profilen:
//   - Victron 2706 MaxFeedInPower ab Werk -1 (= 0xFFFF, unbegrenzt) wurde als
//     6 553 500 W gesichert; das Zurückschreiben warf „int16 range exceeded“,
//     die Anlage blieb dauerhaft auf der Teilvorgabe des Direktvermarkters.
//   - Fronius OutWRte negativ (Kunde lädt aus PV) wurde falsch gesichert; die
//     Freigabe-Sequenz warf jeden Takt, die Sperre blieb stehen.
// Die Tests fahren die ECHTEN Profile (loadConfigFile) und den echten Evaluator.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfigFile } from '../config-model.js';
import { createScheduleEvaluator } from '../schedule-eval.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadProfile(manufacturer) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), `dvhub-seqsave-${manufacturer}-`));
  fs.mkdirSync(path.join(rootDir, 'hersteller'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'hersteller', `${manufacturer}.json`),
    path.join(rootDir, 'hersteller', `${manufacturer}.json`));
  const configPath = path.join(rootDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ manufacturer, victron: { host: '192.0.2.10' } }));
  return loadConfigFile(configPath).effectiveConfig;
}

function harness(cfg, regs, { saved } = {}) {
  const state = {
    victron: { soc: 50 },
    ctrl: saved ? { _dvSeqSaved: { ...saved } } : {},
    schedule: { rules: [], active: {}, lastWrite: {}, manualOverride: {}, config: {}, lastEvalAt: 0 }
  };
  const writes = [];
  const logs = [];
  const transport = {
    type: 'modbus',
    async mbRequest({ address, quantity = 1 }) {
      return Array.from({ length: quantity }, (_, i) => regs[address + i] ?? 0);
    },
    async mbWriteSingle({ address, value }) { writes.push([address, value]); regs[address] = value; },
    async mbWriteMultiple({ address, values }) { writes.push([address, values]); values.forEach((v, i) => { regs[address + i] = v; }); }
  };
  const ev = createScheduleEvaluator({
    state, getCfg: () => cfg, transport,
    pushLog: (e, d) => logs.push({ e, d }),
    telemetrySafeWrite: () => {}, persistConfig: async () => {}, epexNowNext: () => null
  });
  return { ev, state, writes, logs, regs };
}

// ── Victron 2706 (int16, scale 100, rawSentinels [-1]) ─────────────────────

test('Victron 2706 ab Werk -1 (0xFFFF): Teilvorgabe setzen und danach -1 zurückschreiben', async () => {
  const cfg = loadProfile('victron');
  assert.equal(cfg.controlWrite.dvFeedInLimitW.address, 2706);
  const { ev, state, writes } = harness(cfg, { 2706: 0xffff });
  await ev.applyDvFeedInLimit(3000);
  assert.deepEqual(writes, [[2706, 30]]);
  assert.equal(state.ctrl._dvSeqSaved.dvFeedInLimitW, -1, 'Sentinel -1 als Engineering-Wert gesichert');
  await ev.applyDvFeedInLimit(null);
  assert.deepEqual(writes, [[2706, 30], [2706, 0xffff]], 'unbegrenzt (raw 0xFFFF) zurückgeschrieben');
  assert.equal(state.ctrl._dvSeqSaved.dvFeedInLimitW, undefined, 'Sicherung verbraucht');
});

test('Victron 2706 Installateur-Grenze 5000 W (raw 50): Zurückschreiben unverändert raw 50', async () => {
  const cfg = loadProfile('victron');
  const { ev, state, writes } = harness(cfg, { 2706: 50 });
  await ev.applyDvFeedInLimit(3000);
  assert.equal(state.ctrl._dvSeqSaved.dvFeedInLimitW, 5000);
  await ev.applyDvFeedInLimit(null);
  assert.deepEqual(writes, [[2706, 30], [2706, 50]]);
});

test('Victron 2706: alte, falsch gesicherte Sicherung (6 553 500) wird als -1 zurückgeschrieben', async () => {
  const cfg = loadProfile('victron');
  const { ev, state, writes, logs } = harness(cfg, { 2706: 30 }, { saved: { dvFeedInLimitW: 6553500 } });
  await ev.applyDvFeedInLimit(null);
  assert.deepEqual(writes, [[2706, 0xffff]]);
  assert.equal(state.ctrl._dvSeqSaved.dvFeedInLimitW, undefined);
  assert.ok(logs.some((l) => l.e === 'dv_seq_restore_legacy_decoded'), 'Umdeutung wird geloggt');
});

test('nicht kodierbare Sicherung ohne restoreDefault: einmal loggen, nicht ewig werfen', async () => {
  const cfg = loadProfile('victron');
  const { ev, state, writes, logs } = harness(cfg, { 2706: 30 }, { saved: { dvFeedInLimitW: 1e12 } });
  await ev.applyDvFeedInLimit(null);           // darf nicht werfen
  assert.deepEqual(writes, [], 'kein Ersatzwert vorhanden → kein Write');
  assert.equal(state.ctrl._dvSeqSaved.dvFeedInLimitW, undefined, 'kaputte Sicherung verworfen');
  assert.ok(logs.some((l) => l.e === 'dv_seq_restore_invalid'));
  await ev.applyDvFeedInLimit(null);           // zweiter Lauf: kein Fehler mehr
});

// ── Fronius OutWRte (int16, scale 0.01) / StorCtl_Mod (uint16) ─────────────

function froniusCfg() {
  const cfg = loadProfile('fronius');
  cfg.controlWrite.storCtlMod.address = 40191;   // wie nach dem SunSpec-Scan
  cfg.controlWrite.outWRte.address = 40198;
  return cfg;
}

test('Fronius OutWRte negativ (-50 %, raw 0xEC78): Freigabe stellt genau den Kundenwert her', async () => {
  const cfg = froniusCfg();
  const { ev, state, writes } = harness(cfg, { 40191: 1, 40198: 0xec78 });
  await ev.applyDvVictronControl(false);
  assert.equal(state.ctrl._lastDvFeedIn, false);
  assert.equal(state.ctrl._dvSeqSaved.outWRte, -50);
  await ev.applyDvVictronControl(true);
  assert.equal(state.ctrl._lastDvFeedIn, true, 'Freigabe erfolgreich');
  assert.deepEqual(writes.slice(2), [[40191, 1], [40198, 0xec78]]);
});

test('Fronius OutWRte positiv (+75 %, raw 7500): Verhalten unverändert', async () => {
  const cfg = froniusCfg();
  const { ev, state, writes } = harness(cfg, { 40191: 0, 40198: 7500 });
  await ev.applyDvVictronControl(false);
  assert.deepEqual(writes, [[40191, 2], [40198, 55536]]);
  await ev.applyDvVictronControl(true);
  assert.equal(state.ctrl._lastDvFeedIn, true);
  assert.deepEqual(writes.slice(2), [[40191, 0], [40198, 7500]]);
});

test('Fronius: alte Sicherung 555.36 (= raw 55536 vorzeichenlos) wird als -100 % zurückgeschrieben', async () => {
  const cfg = froniusCfg();
  const { ev, state, writes } = harness(cfg, { 40191: 2, 40198: 55536 },
    { saved: { storCtlMod: 0, outWRte: 555.36 } });
  state.ctrl._lastDvFeedIn = false;
  await ev.applyDvVictronControl(true);
  assert.equal(state.ctrl._lastDvFeedIn, true);
  assert.deepEqual(writes, [[40191, 0], [40198, 55536]]);
});

test('Fronius: nicht kodierbare Sicherung fällt auf restoreDefault (+100 %) zurück statt jeden Takt zu werfen', async () => {
  const cfg = froniusCfg();
  const { ev, state, writes, logs } = harness(cfg, { 40191: 2, 40198: 55536 },
    { saved: { storCtlMod: 0, outWRte: 1e9 } });
  state.ctrl._lastDvFeedIn = false;
  await ev.applyDvVictronControl(true);
  assert.equal(state.ctrl._lastDvFeedIn, true);
  assert.deepEqual(writes, [[40191, 0], [40198, 10000]]);
  assert.ok(logs.some((l) => l.e === 'dv_seq_restore_invalid' && l.d.point === 'outWRte' && l.d.fallback === 100));
});

// ── Deye Work-Mode (uint16): unverändert ───────────────────────────────────

test('Deye Work-Mode 1 (Zero-Export-to-Load): sichern und unverändert zurückschreiben', async () => {
  const cfg = loadProfile('deye-lv');
  const addr = cfg.controlWrite.workMode.address;
  const { ev, state, writes } = harness(cfg, { [addr]: 1 });
  state.ctrl._lastDvFeedIn = true;         // läuft frei
  await ev.applyDvVictronControl(false);   // sperren → Zero-Export-to-CT (2)
  await ev.applyDvVictronControl(true);    // freigeben → Kundenmodus 1
  const vals = writes.filter(([a]) => a === addr).map(([, v]) => v);
  assert.deepEqual(vals, [2, 1], `Work-Mode-Writes ${JSON.stringify(writes)}`);
  assert.equal(state.ctrl._dvSeqSaved.workMode, undefined);
});
