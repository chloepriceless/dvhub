// Entscheidung Chrissi 25.10.: Beim DVhub-Start darf die Freigabe-Sequenz nur
// eine Sperre aufheben, die DVhub SELBST gesetzt hat — keine restoreDefaults
// über die eigenen Einstellungen der Kunden. Vorher schrieb der erste Eval nach
// jedem Neustart (Change-Cache _lastDvFeedIn leer) die Freigabe-Sequenz: Deye
// Work-Mode 0 über einen Kunden-Modus 1, Fronius StorCtl_Mod 0 / OutWRte +100
// über die Kundenwerte aus Solar.web.
// Beweis der eigenen Sperre nach einem Neustart = die persistierte Sicherung
// dv_seq_saved.json (saveBefore beim Sperren, beim Freigeben verbraucht).
// _lastDvFeedIn und control_state.json tragen dafür nichts (nicht persistiert
// bzw. nur der Not-Halt).
// ECHTE Profile (loadConfigFile), echter Evaluator, echte Persistenzdatei.
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
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), `dvhub-bootrel-${manufacturer}-`));
  fs.mkdirSync(path.join(rootDir, 'hersteller'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'hersteller', `${manufacturer}.json`),
    path.join(rootDir, 'hersteller', `${manufacturer}.json`));
  const configPath = path.join(rootDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ manufacturer, victron: { host: '192.0.2.10' } }));
  const cfg = loadConfigFile(configPath).effectiveConfig;
  if (manufacturer === 'fronius') {
    cfg.controlWrite.storCtlMod.address = 40191;   // wie nach dem SunSpec-Scan
    cfg.controlWrite.outWRte.address = 40198;
  }
  return { cfg, savedPath: path.join(rootDir, 'dv_seq_saved.json') };
}

// Ein frisch gestarteter Evaluator: leerer Zustand, Sicherung nur aus der Datei.
function boot({ cfg, savedPath }, regs, logs = []) {
  const state = {
    victron: { soc: 50 },
    ctrl: {},
    schedule: { rules: [], active: {}, lastWrite: {}, manualOverride: {}, config: {}, lastEvalAt: 0 }
  };
  const writes = [];
  const transport = {
    type: 'modbus',
    async mbRequest({ address, quantity = 1 }) { return Array.from({ length: quantity }, (_, i) => regs[address + i] ?? 0); },
    async mbWriteSingle({ address, value }) { writes.push([address, value]); regs[address] = value; },
    async mbWriteMultiple({ address, values }) { writes.push([address, values]); }
  };
  const ev = createScheduleEvaluator({
    state, getCfg: () => cfg, transport, dvSeqSavedPath: savedPath,
    pushLog: (e, d) => logs.push({ e, d }),
    telemetrySafeWrite: () => {}, persistConfig: async () => {}, epexNowNext: () => null,
    regenerateSmallMarketAutomationRules: async () => {}
  });
  return { ev, state, writes, logs };
}

const readSaved = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {});

// ── ohne eigene Sperre: nichts schreiben ───────────────────────────────────

test('Fronius-Start ohne Sicherung: Kundenwerte StorCtl_Mod 1 / OutWRte -50 % bleiben unberührt', async () => {
  const prof = loadProfile('fronius');
  const regs = { 40191: 1, 40198: 0xec78 };
  const { ev, state, writes, logs } = boot(prof, regs);
  await ev.applyDvVictronControl(true);
  assert.deepEqual(writes, [], 'kein restoreDefault über die Kundenwerte');
  assert.equal(state.ctrl._lastDvFeedIn, true, 'interner Zustand steht trotzdem');
  assert.ok(logs.some((l) => l.e === 'dv_release_skipped_no_own_block'));
  // Spätere Übergänge funktionieren: Sperren sichert die Kundenwerte, Freigabe stellt sie her.
  await ev.applyDvVictronControl(false);
  assert.deepEqual(writes, [[40191, 2], [40198, 55536]]);
  await ev.applyDvVictronControl(true);
  assert.deepEqual(writes.slice(2), [[40191, 1], [40198, 0xec78]]);
});

test('Deye-Start ohne Sicherung: Kunden-Work-Mode 1 bleibt 1', async () => {
  const prof = loadProfile('deye-lv');
  const addr = prof.cfg.controlWrite.workMode.address;
  const regs = { [addr]: 1 };
  const { ev, state, writes } = boot(prof, regs);
  await ev.applyDvVictronControl(true);
  assert.deepEqual(writes, []);
  assert.equal(regs[addr], 1);
  assert.equal(state.ctrl._lastDvFeedIn, true);
});

test('Start ohne Sicherung, erster Eval sperrt: Sperre läuft normal', async () => {
  const prof = loadProfile('deye-lv');
  const addr = prof.cfg.controlWrite.workMode.address;
  const { ev, writes } = boot(prof, { [addr]: 1 });
  await ev.applyDvVictronControl(false);
  assert.deepEqual(writes, [[addr, 2]]);
  assert.deepEqual(readSaved(prof.savedPath), { workMode: 1 });
});

// ── mit eigener Sperre (Absturz während der Sperre): exakt zurückschreiben ──

test('Fronius-Start mit persistierter eigener Sperre: exakte Wiederherstellung, Sicherung verbraucht', async () => {
  const prof = loadProfile('fronius');
  // Vor dem Absturz: DVhub hat gesperrt und die Kundenwerte gesichert.
  const first = boot(prof, { 40191: 1, 40198: 0xec78 });
  await first.ev.applyDvVictronControl(false);
  assert.deepEqual(readSaved(prof.savedPath), { storCtlMod: 1, outWRte: -50 });
  // Neustart: neuer Evaluator, Gerät steht noch auf der Sperre.
  const regs = { 40191: 2, 40198: 55536 };
  const { ev, state, writes } = boot(prof, regs);
  await ev.applyDvVictronControl(true);
  assert.deepEqual(writes, [[40191, 1], [40198, 0xec78]]);
  assert.equal(state.ctrl._lastDvFeedIn, true);
  assert.deepEqual(readSaved(prof.savedPath), {});
});

test('Deye-Start mit persistierter eigener Sperre: Work-Mode 1 zurück', async () => {
  const prof = loadProfile('deye-lv');
  const addr = prof.cfg.controlWrite.workMode.address;
  fs.writeFileSync(prof.savedPath, JSON.stringify({ workMode: 1 }));
  const { ev, writes } = boot(prof, { [addr]: 2 });
  await ev.applyDvVictronControl(true);
  assert.deepEqual(writes, [[addr, 1]]);
  assert.deepEqual(readSaved(prof.savedPath), {});
});

test('Absturz mitten in der Sperre (nur StorCtl_Mod gesichert): nur der eigene Wert, kein Default für OutWRte', async () => {
  const prof = loadProfile('fronius');
  fs.writeFileSync(prof.savedPath, JSON.stringify({ storCtlMod: 1 }));
  const { ev, writes } = boot(prof, { 40191: 2, 40198: 0xec78 });
  await ev.applyDvVictronControl(true);
  assert.deepEqual(writes, [[40191, 1]], 'OutWRte stand nie unter DVhub-Sperre → nicht anfassen');
});

test('fehlgeschlagene Wiederherstellung beim Start wird im nächsten Takt wiederholt', async () => {
  const prof = loadProfile('deye-lv');
  const addr = prof.cfg.controlWrite.workMode.address;
  fs.writeFileSync(prof.savedPath, JSON.stringify({ workMode: 1 }));
  let fail = true;
  const writes = [];
  const transport = {
    type: 'modbus',
    async mbRequest() { return [2]; },
    async mbWriteSingle({ address, value }) { if (fail) throw new Error('timeout'); writes.push([address, value]); }
  };
  const state = { victron: { soc: 50 }, ctrl: {}, schedule: { rules: [], active: {}, lastWrite: {}, manualOverride: {}, config: {}, lastEvalAt: 0 } };
  const ev = createScheduleEvaluator({
    state, getCfg: () => prof.cfg, transport, dvSeqSavedPath: prof.savedPath,
    pushLog: () => {}, telemetrySafeWrite: () => {}, persistConfig: async () => {}, epexNowNext: () => null
  });
  await ev.applyDvVictronControl(true);
  assert.equal(state.ctrl._lastDvFeedIn, undefined, 'Fehlschlag setzt den Change-Cache nicht (T-0076)');
  fail = false;
  await ev.applyDvVictronControl(true);
  assert.deepEqual(writes, [[addr, 1]], 'Sicherung blieb erhalten → zweiter Versuch stellt her');
  assert.equal(state.ctrl._lastDvFeedIn, true);
});

// ── Victron (Direkt-Register 2707/2708, keine Sequenz): unverändert ─────────

test('Victron-Start: Freigabe 2707:=1 / 2708:=0 wie bisher (GH #10, keine Sicherung vorhanden)', async () => {
  const prof = loadProfile('victron');
  const { ev, writes } = boot(prof, {});
  await ev.applyDvVictronControl(true);
  assert.deepEqual(writes, [[2707, 1], [2708, 0]]);
});

// Der echte Startpfad: erster evaluateSchedule bei positivem Preis.
test('Fronius: erster evaluateSchedule nach dem Start schreibt ohne Sicherung nichts auf StorCtl_Mod/OutWRte', async () => {
  const prof = loadProfile('fronius');
  const regs = { 40191: 1, 40198: 0xec78 };
  const { ev, state, writes } = boot(prof, regs);
  state.schedule.config = { defaultFeedExcessDcPv: 1 };
  // epexNowNext liefert im Harness null → kein Negativpreis.
  await ev.evaluateSchedule();
  assert.deepEqual(writes.filter(([a]) => a === 40191 || a === 40198), []);
  assert.equal(state.ctrl._lastDvFeedIn, true);
});

// ── Review e9b64f0d (P2): eine Sperre gibt es nur mit gesicherter Datei ─────
// Scheitert das Schreiben von dv_seq_saved.json, darf die Sperre nicht aufs Gerät:
// sonst fände der Start nach einem Neustart keine eigene Sperre und ließe sie
// (Fronius Zwangsladen −100 %, Deye Zero-Export) tagelang stehen.
test('Sicherung nicht speicherbar: Sperre wird nicht geschrieben und im nächsten Takt wiederholt', async () => {
  const prof = loadProfile('fronius');
  const blocker = path.join(path.dirname(prof.savedPath), 'datei-statt-ordner');
  fs.writeFileSync(blocker, 'x');
  const unwritable = { ...prof, savedPath: path.join(blocker, 'dv_seq_saved.json') };
  const regs = { 40191: 1, 40198: 0xec78 };
  const { ev, state, writes, logs } = boot(unwritable, regs);
  await ev.applyDvVictronControl(false);
  assert.deepEqual(writes, [], 'ohne gespeicherte Sicherung keine Sperre aufs Gerät');
  assert.equal(state.ctrl._lastDvFeedIn, undefined, 'Fehlschlag → nächster Takt versucht es erneut');
  assert.ok(logs.some((l) => l.e === 'dv_seq_saved_persist_error'));
  assert.deepEqual(state.ctrl._dvSeqSaved || {}, {}, 'keine halbe Sicherung im Speicher');
  // Datenverzeichnis wieder schreibbar: derselbe Evaluator sperrt jetzt mit Sicherung.
  fs.rmSync(blocker); fs.mkdirSync(blocker);
  await ev.applyDvVictronControl(false);
  assert.deepEqual(writes, [[40191, 2], [40198, 55536]]);
  assert.deepEqual(readSaved(unwritable.savedPath), { storCtlMod: 1, outWRte: -50 });
});

// Gegenprüfung 396b3d46: die Regel „keine Sperre ohne gespeicherte Sicherung“ gilt
// nur für die Sperr-Sequenzen. Die Einspeisegrenze des Direktvermarkters (2706)
// wird auch bei kaputter Platte geschrieben — sonst würde aus 60 % ein Totalstopp.
test('Einspeisegrenze 2706 wird trotz nicht speicherbarer Sicherung geschrieben', async () => {
  const prof = loadProfile('victron');
  const blocker = path.join(path.dirname(prof.savedPath), 'datei-statt-ordner');
  fs.writeFileSync(blocker, 'x');
  const unwritable = { ...prof, savedPath: path.join(blocker, 'dv_seq_saved.json') };
  const { ev, writes } = boot(unwritable, { 2706: 0xffff });
  await ev.applyDvFeedInLimit(6000);
  assert.deepEqual(writes, [[2706, 60]]);
});

test('Lesefehler mitten im Vorab-Lesen hinterlässt keine halbe Sicherung', async () => {
  const prof = loadProfile('fronius');
  const state = { victron: { soc: 50 }, ctrl: {}, schedule: { rules: [], active: {}, lastWrite: {}, manualOverride: {}, config: {}, lastEvalAt: 0 } };
  const writes = [];
  let failOutWRte = true;
  const transport = {
    type: 'modbus',
    async mbRequest({ address }) { if (address === 40198 && failOutWRte) throw new Error('timeout'); return [address === 40191 ? 1 : 0xec78]; },
    async mbWriteSingle({ address, value }) { writes.push([address, value]); }
  };
  const ev = createScheduleEvaluator({
    state, getCfg: () => prof.cfg, transport, dvSeqSavedPath: prof.savedPath,
    pushLog: () => {}, telemetrySafeWrite: () => {}, persistConfig: async () => {}, epexNowNext: () => null
  });
  await ev.applyDvVictronControl(false);
  assert.deepEqual(writes, []);
  assert.deepEqual(state.ctrl._dvSeqSaved || {}, {}, 'StorCtl_Mod nicht halb gesichert');
  failOutWRte = false;
  await ev.applyDvVictronControl(false);
  assert.deepEqual(readSaved(prof.savedPath), { storCtlMod: 1, outWRte: -50 });
});
