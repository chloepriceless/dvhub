// M14 (Sungrow Master/Slave Feldtest 6a4e10d3, 16.11.2026, SH10RT-20):
// Die Negativpreis-Abregelung sperrt die Einspeisung über eine Sequenz
// (feedInLimitW:=0, feedInLimitEnable:=170); die Freigabe schreibt die
// gesicherten Werte zurück. Beim SH10RT-20 scheiterte die Freigabe endlos mit
// `modbus exception 4`, OBWOHL der gesicherte Wert (feedInLimitW=24200) bereits
// wieder am Gerät stand — das Gerät nimmt den Restore an bzw. stellt ihn selbst
// wieder her, meldet aber trotzdem eine Modbus-Ausnahme. Ergebnis: alle 15 s ein
// Fehlversuch, _lastDvFeedIn blieb false, obwohl die Einspeisung frei war.
//
// Fix Teil 1: restore-Write wirft Modbus-Ausnahme → Punkt zurücklesen (FC 3);
//   steht der Zielwert schon am Gerät → Schritt erledigt (Sicherung löschen,
//   kein Throw, Freigabe gilt). Gegenprobe: Zielwert steht NICHT → Fehler bleibt.
// Fix Teil 2: echte Fehlschläge → Backoff (nach 3 nur noch alle 5 min); das
//   Fehler-Log nennt Punkt, Register und Wert.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createScheduleEvaluator } from '../schedule-eval.js';

function makeState() {
  return {
    victron: { soc: 50 },
    ctrl: {},
    schedule: { rules: [], active: {}, lastWrite: {}, manualOverride: {}, config: {}, lastEvalAt: 0 }
  };
}

// Sungrow-naher Aufbau: feedExcessDcPv als Sequenz über die Einspeisegrenze.
// writeSingleImpl darf je Register/Wert werfen (Modbus-Ausnahme simulieren).
// mbRequest liefert den aktuellen Gerätezustand aus `device` (Adresse→RAW-Wort).
function makeSungrowEvaluator({ dvSeqSavedPath, device = {}, writeSingleImpl, readThrow = {}, logs } = {}) {
  const state = makeState();
  const cfg = {
    controlWrite: {
      feedInLimitRatio:  { enabled: true, fc: 6, address: 13087, writeType: 'uint16', scale: 1, offset: 0, verify: true, notAvailableRaw: [65535] },
      feedInLimitW:      { enabled: true, fc: 6, address: 13073, writeType: 'uint16', scale: 1, offset: 0, verify: true },
      feedInLimitEnable: { enabled: true, fc: 6, address: 13086, writeType: 'uint16', scale: 1, offset: 0, verify: true }
    },
    dvControl: {
      enabled: true,
      feedExcessDcPv: {
        enabled: true,
        sequence: {
          '0': [
            { point: 'feedInLimitRatio', value: 0, saveBefore: true, optional: true },
            { point: 'feedInLimitW', value: 0, saveBefore: true },
            { point: 'feedInLimitEnable', value: 170, saveBefore: true }
          ],
          '1': [
            { point: 'feedInLimitRatio', restore: true, optional: true },
            { point: 'feedInLimitW', restore: true },
            { point: 'feedInLimitEnable', restore: true }
          ]
        }
      }
    }
  };
  const transport = {
    type: 'modbus',
    writes: [],
    async mbWriteSingle(req) {
      if (writeSingleImpl) await writeSingleImpl(req, device);
      this.writes.push({ fc: 6, address: req.address, value: req.value });
    },
    async mbWriteMultiple(req) { this.writes.push({ fc: 16, address: req.address, values: req.values }); },
    async mbRequest({ address, quantity }) {
      if (readThrow[address]) throw new Error(readThrow[address]);
      const out = [];
      for (let i = 0; i < (quantity || 1); i++) out.push(device[address + i] ?? 0);
      return out;
    }
  };
  const evaluator = createScheduleEvaluator({
    state, getCfg: () => cfg, transport,
    pushLog: logs ? (type, payload, level) => logs.push({ type, payload, level }) : () => {},
    telemetrySafeWrite: () => {}, persistConfig: async () => {},
    telemetryStore: null, epexNowNext: () => null,
    dvSeqSavedPath
  });
  return { evaluator, state, transport, cfg };
}

test('M14 Teil 1: restore-Write wirft Modbus-Ausnahme, aber Zielwert steht am Gerät → Schritt erledigt, kein Throw, Sicherung geleert', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvm14-'));
  const savedPath = path.join(dir, 'dv_seq_saved.json');
  const logs = [];
  // Gerät vor dem Sperren: Kundeneinspeisegrenze feedInLimitW=24200, enable=170,
  // ratio nicht vorhanden (0xFFFF → optionaler Schritt übersprungen).
  const device = { 13073: 24200, 13086: 170, 13087: 0xffff };
  const { evaluator, state, transport } = makeSungrowEvaluator({
    dvSeqSavedPath: savedPath, device, logs,
    writeSingleImpl: (req, dev) => {
      // SH10RT-20-Quirk: der Restore von feedInLimitW (13073=24200) wird
      // angenommen (Wert steht/kommt zurück ans Gerät), das Gerät meldet aber
      // trotzdem exception 4. Alle anderen Writes nehmen den Wert normal an.
      if (req.address === 13073 && req.value === 24200) {
        dev[13073] = 24200; // Gerät hat den Zielwert
        throw new Error('modbus exception 4');
      }
      dev[req.address] = req.value;
    }
  });

  // Sperren (Negativpreis): sichert 24200/170, schreibt 0 + 170.
  const lock = await evaluator.applyControlTarget('feedExcessDcPv', 0, 'negative_price_protection');
  assert.equal(lock.ok, true);
  const saved = JSON.parse(fs.readFileSync(savedPath, 'utf8'));
  assert.equal(saved.feedInLimitW, 24200, 'Kundenwert gesichert');
  assert.equal(saved.feedInLimitEnable, 170);
  assert.equal(saved.feedInLimitRatio, undefined, 'ratio optional übersprungen (nicht gesichert)');

  // Freigabe: restore von feedInLimitW=24200 wirft exception 4, Rücklesen zeigt
  // 24200 steht → Schritt erledigt. KEIN Throw, Freigabe gilt als erfolgreich.
  transport.writes.length = 0;
  const release = await evaluator.applyControlTarget('feedExcessDcPv', 1, 'negative_price_protection');
  assert.equal(release.ok, true, 'Freigabe gilt trotz Exception als erfolgreich');
  assert.equal(state.ctrl._lastDvFeedIn, true, 'Change-Cache auf frei gesetzt (keine Wiederholung mehr)');

  const after = JSON.parse(fs.readFileSync(savedPath, 'utf8'));
  assert.deepEqual(after, {}, 'Sicherung nach erfolgreichem Restore geleert → keine endlose Wiederholung');

  // Protokoll-Nachweis: der „schon gesetzt“-Pfad wurde geloggt.
  assert.ok(logs.some((l) => l.type === 'dv_seq_restore_already_set'
    && l.payload?.address === 13073), 'dv_seq_restore_already_set mit Register geloggt');

  // Zweiter Freigabe-Takt (unchanged) ist ein No-op — nichts wiederholt sich.
  transport.writes.length = 0;
  const again = await evaluator.applyControlTarget('feedExcessDcPv', 1, 'negative_price_protection');
  assert.equal(again.ok, true);
  assert.equal(again.skipped, true, 'kein erneuter Write — Wiederholung beendet');
});

test('M14 Teil 1 Gegenprobe: restore wirft Modbus-Ausnahme UND Zielwert steht NICHT am Gerät → Fehler bleibt (Sicherung bleibt, Retry scharf)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvm14-'));
  const savedPath = path.join(dir, 'dv_seq_saved.json');
  const device = { 13073: 24200, 13086: 170, 13087: 0xffff };
  const { evaluator, state } = makeSungrowEvaluator({
    dvSeqSavedPath: savedPath, device,
    writeSingleImpl: (req, dev) => {
      // feedInLimitW-Restore scheitert ECHT: Exception UND Gerät bleibt bei 0.
      if (req.address === 13073 && req.value === 24200) {
        dev[13073] = 0; // Zielwert steht NICHT am Gerät
        throw new Error('modbus exception 4');
      }
      dev[req.address] = req.value;
    }
  });

  await evaluator.applyControlTarget('feedExcessDcPv', 0, 'negative_price_protection');
  const release = await evaluator.applyControlTarget('feedExcessDcPv', 1, 'negative_price_protection');
  assert.equal(release.ok, false, 'echter Fehlschlag bleibt ehrlich ok:false');
  assert.match(String(release.error), /exception 4/);
  assert.notEqual(state.ctrl._lastDvFeedIn, true, 'Change-Cache NICHT auf frei → nächster Takt versucht die Freigabe erneut');
  const after = JSON.parse(fs.readFileSync(savedPath, 'utf8'));
  assert.equal(after.feedInLimitW, 24200, 'Sicherung bleibt stehen (Freigabe noch offen)');
});

test('M14 Teil 1: Timeout (keine Modbus-Ausnahme) wird NICHT als erledigt gewertet — Gerätezustand unbekannt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvm14-'));
  const savedPath = path.join(dir, 'dv_seq_saved.json');
  // Gerät STÜNDE auf 24200 — aber ein Timeout darf nicht als Erfolg zählen.
  const device = { 13073: 24200, 13086: 170, 13087: 0xffff };
  const { evaluator, state } = makeSungrowEvaluator({
    dvSeqSavedPath: savedPath, device,
    writeSingleImpl: (req, dev) => {
      if (req.address === 13073 && req.value === 24200) throw new Error('modbus timeout');
      dev[req.address] = req.value;
    }
  });
  await evaluator.applyControlTarget('feedExcessDcPv', 0, 'negative_price_protection');
  const release = await evaluator.applyControlTarget('feedExcessDcPv', 1, 'negative_price_protection');
  assert.equal(release.ok, false, 'Timeout bleibt ein echter Fehler');
  assert.match(String(release.error), /timeout/);
  assert.notEqual(state.ctrl._lastDvFeedIn, true, 'Timeout gilt nicht als Freigabe → nächster Takt versucht erneut');
});

test('M14 Teil 2: Fehler-Log nennt Punkt, Register und Wert (statt nur feedExcessDcPv)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvm14-'));
  const savedPath = path.join(dir, 'dv_seq_saved.json');
  const logs = [];
  const device = { 13073: 24200, 13086: 170, 13087: 0xffff };
  const { evaluator } = makeSungrowEvaluator({
    dvSeqSavedPath: savedPath, device, logs,
    writeSingleImpl: (req, dev) => {
      if (req.address === 13073 && req.value === 24200) { dev[13073] = 0; throw new Error('modbus exception 4'); }
      dev[req.address] = req.value;
    }
  });
  await evaluator.applyControlTarget('feedExcessDcPv', 0, 'negative_price_protection');
  logs.length = 0;
  await evaluator.applyControlTarget('feedExcessDcPv', 1, 'negative_price_protection');
  const errLog = logs.find((l) => l.type === 'dv_victron_write_error');
  assert.ok(errLog, 'Fehler-Log vorhanden');
  assert.equal(errLog.payload.point, 'feedInLimitW', 'nennt den konkreten Sequenz-Punkt');
  assert.equal(errLog.payload.address, 13073, 'nennt das Register');
  assert.equal(errLog.payload.value, 24200, 'nennt den Wert');
});

test('M14 Teil 2: Backoff — nach 3 echten Freigabe-Fehlschlägen nur noch alle 5 min (Automatik-Pfad)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvm14-'));
  const savedPath = path.join(dir, 'dv_seq_saved.json');
  const device = { 13073: 24200, 13086: 170, 13087: 0xffff };
  const { evaluator, state, transport } = makeSungrowEvaluator({
    dvSeqSavedPath: savedPath, device,
    writeSingleImpl: (req, dev) => {
      if (req.address === 13073 && req.value === 24200) { dev[13073] = 0; throw new Error('modbus exception 4'); }
      dev[req.address] = req.value;
    }
  });
  await evaluator.applyControlTarget('feedExcessDcPv', 0, 'negative_price_protection');

  // Automatik-Freigabe (explicit:false) über den exportierten Aktuator.
  const release = () => evaluator.applyDvVictronControl(true, { reason: 'negative_price_protection' });
  await release(); // Fehlschlag 1
  await release(); // Fehlschlag 2
  await release(); // Fehlschlag 3 → ab jetzt Backoff
  const bk = state.ctrl._dvReleaseBackoff.feedExcessDcPv;
  assert.equal(bk.fails, 3);
  assert.ok(bk.nextAt > Date.now(), 'Backoff-Fenster gesetzt (~5 min)');
  assert.ok(bk.nextAt - Date.now() > 4 * 60_000, 'Fenster ~5 min');

  // Vierter Takt innerhalb des Fensters: KEIN Geräte-Write, nur Backoff-Ergebnis.
  const writesBefore = transport.writes.length;
  await release();
  assert.equal(transport.writes.length, writesBefore, 'im Backoff-Fenster kein neuer Geräte-Write');
  assert.equal(state.ctrl.dvControl.feedExcessDcPv.backoff, true, 'Ergebnis als backoff markiert');
});

test('M14 Teil 2: eine SPERRE (feedIn=false, Negativpreis) wird NIE gedrosselt — Backoff gilt nur für die Freigabe', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvm14-'));
  const savedPath = path.join(dir, 'dv_seq_saved.json');
  const device = { 13073: 24200, 13086: 170, 13087: 0xffff };
  let blockAttempts = 0;
  const { evaluator, state } = makeSungrowEvaluator({
    dvSeqSavedPath: savedPath, device,
    writeSingleImpl: (req, dev) => {
      // Jede Sperre (feedInLimitW:=0) scheitert echt — Versuch VOR dem Wurf zählen.
      if (req.address === 13073 && req.value === 0) { blockAttempts += 1; throw new Error('modbus exception 4'); }
      dev[req.address] = req.value;
    }
  });
  // Mehrere Sperr-Takte hintereinander müssen alle einen Geräte-Write versuchen.
  for (let i = 0; i < 5; i++) {
    state.ctrl._lastDvFeedIn = true; // Change-Cache „frei“ erzwingen → Sperre wird erneut versucht
    const before = blockAttempts;
    await evaluator.applyDvVictronControl(false, { reason: 'negative_price_protection' });
    assert.ok(blockAttempts > before, `Sperr-Takt ${i} versucht einen Geräte-Write (kein Backoff)`);
  }
});

test('NEU1: Vorrang-Register 13088 liest 0xFFFF (Begrenzung war aus), wird aber zum Sperren verpflichtend auf 0 geschrieben; Freigabe lässt die Quote unangetastet und stellt das Enable zurück', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvm14-'));
  const savedPath = path.join(dir, 'dv_seq_saved.json');
  // Vor dem Sperren ist die Einspeisebegrenzung AUS → enable=85 (0x55),
  // Quote 13088 liest 0xFFFF (ohne aktive Begrenzung kein gültiger Wert).
  const device = { 13073: 7000, 13086: 85, 13087: 0xffff };
  const { evaluator, transport } = makeSungrowEvaluator({
    dvSeqSavedPath: savedPath, device,
    writeSingleImpl: (req, dev) => { dev[req.address] = req.value; } // Writes spiegeln ins Gerät (Verify ok)
  });

  // Sperren: Quote 0xFFFF → NICHT gesichert, aber feedInLimitRatio MUSS auf 0
  // (Vorrang vor 13074), sonst würde 100 % trotz Watt=0 die Einspeisung freigeben.
  const lock = await evaluator.applyControlTarget('feedExcessDcPv', 0, 'negative_price_protection');
  assert.equal(lock.ok, true);
  assert.ok(transport.writes.some((w) => w.address === 13087 && w.value === 0),
    'Vorrang-Quote 13088 wird trotz 0xFFFF-Lesung verpflichtend auf 0 geschrieben');
  const saved = JSON.parse(fs.readFileSync(savedPath, 'utf8'));
  assert.equal(saved.feedInLimitRatio, undefined, '0xFFFF wird nicht als Ist-Wert gesichert');
  assert.equal(saved.feedInLimitEnable, 85, 'Kunden-Enable (aus) gesichert');

  // Freigeben: Quote nicht gesichert → KEIN Write (Prinzip „ohne Sicherung nie
  // eine Grenze anfassen/abschalten"); das zurückgestellte Enable=85 schaltet die
  // Begrenzung wieder aus → Einspeisung frei, die Quote 0 ist dann wirkungslos.
  transport.writes.length = 0;
  const release = await evaluator.applyControlTarget('feedExcessDcPv', 1, 'negative_price_protection');
  assert.equal(release.ok, true);
  assert.ok(!transport.writes.some((w) => w.address === 13087),
    'ungespeicherte Quote wird bei der Freigabe NICHT geschrieben');
  assert.ok(transport.writes.some((w) => w.address === 13086 && w.value === 85),
    'Kunden-Enable (aus) zurückgestellt → Begrenzung wieder abgeschaltet');
});

test('NEU1: fehlt 13088 wirklich (alte Firmware, Exception 2) → Schritt übersprungen, Sperre und Freigabe laufen trotzdem durch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvm14-'));
  const savedPath = path.join(dir, 'dv_seq_saved.json');
  const logs = [];
  const device = { 13073: 24200, 13086: 170 };
  const { evaluator, transport } = makeSungrowEvaluator({
    dvSeqSavedPath: savedPath, device, logs,
    // Lesen UND Schreiben von 13087 (Quote) werfen Exception 2 (Register fehlt).
    readThrow: { 13087: 'modbus exception 2' },
    writeSingleImpl: (req, dev) => {
      if (req.address === 13087) throw new Error('modbus exception 2');
      dev[req.address] = req.value;
    }
  });

  const lock = await evaluator.applyControlTarget('feedExcessDcPv', 0, 'negative_price_protection');
  assert.equal(lock.ok, true, 'Sperre läuft ohne das fehlende Register durch');
  assert.ok(!transport.writes.some((w) => w.address === 13087), 'kein Write auf das fehlende Register');
  assert.ok(transport.writes.some((w) => w.address === 13073 && w.value === 0), 'Watt-Grenze auf 0 gesetzt');

  transport.writes.length = 0;
  const release = await evaluator.applyControlTarget('feedExcessDcPv', 1, 'negative_price_protection');
  assert.equal(release.ok, true, 'Freigabe läuft trotz fehlendem Register durch (nicht gekippt)');
  assert.ok(!transport.writes.some((w) => w.address === 13087), 'fehlendes Register bei Freigabe nicht geschrieben');
  assert.ok(transport.writes.some((w) => w.address === 13073 && w.value === 24200), 'Watt-Grenze zurückgestellt');
});

test('NEU1: optionaler Schritt mit gültigem Ist-Wert, aber Schreiben wirft Exception 2 → Schritt übersprungen (Sequenz kippt nicht), protokolliert', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvm14-'));
  const savedPath = path.join(dir, 'dv_seq_saved.json');
  const logs = [];
  // Quote lesbar (700), aber das Gerät verweigert den Schreibzugriff mit Exception 2.
  const device = { 13073: 24200, 13086: 170, 13087: 700 };
  const { evaluator, transport } = makeSungrowEvaluator({
    dvSeqSavedPath: savedPath, device, logs,
    writeSingleImpl: (req, dev) => {
      if (req.address === 13087) throw new Error('modbus exception 2');
      dev[req.address] = req.value;
    }
  });
  const lock = await evaluator.applyControlTarget('feedExcessDcPv', 0, 'negative_price_protection');
  assert.equal(lock.ok, true, 'Sperre kippt nicht am verweigerten optionalen Schreiben');
  assert.ok(transport.writes.some((w) => w.address === 13073 && w.value === 0), 'Watt-Grenze trotzdem auf 0');
  assert.ok(logs.some((l) => l.type === 'dv_seq_optional_write_skipped' && l.payload?.address === 13087),
    'verweigerter optionaler Write wird protokolliert');
});

test('NEU1: 13088 vorhanden (1000) → regulär gesichert, auf 0 gesperrt, verifiziert und auf 1000 zurückgestellt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvm14-'));
  const savedPath = path.join(dir, 'dv_seq_saved.json');
  const device = { 13073: 24200, 13086: 170, 13087: 1000 };
  const { evaluator, transport } = makeSungrowEvaluator({
    dvSeqSavedPath: savedPath, device,
    writeSingleImpl: (req, dev) => { dev[req.address] = req.value; }
  });
  await evaluator.applyControlTarget('feedExcessDcPv', 0, 'negative_price_protection');
  const saved = JSON.parse(fs.readFileSync(savedPath, 'utf8'));
  assert.equal(saved.feedInLimitRatio, 1000, 'vorhandene Quote regulär gesichert');
  transport.writes.length = 0;
  await evaluator.applyControlTarget('feedExcessDcPv', 1, 'negative_price_protection');
  assert.ok(transport.writes.some((w) => w.address === 13087 && w.value === 1000), 'gesicherte Quote 1000 zurückgestellt');
});

test('M14 Folgefehler: Fix räumt den fälschlich „gesperrt"-Zustand auf → eine NEUE Sperre schreibt wieder (kein _lastDvFeedIn===feedIn-Hänger)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvm14-'));
  const savedPath = path.join(dir, 'dv_seq_saved.json');
  // SH10RT-20-Quirk nur beim Restore (24200), Sperr-Writes (0) gehen durch.
  const device = { 13073: 24200, 13086: 170, 13087: 0xffff };
  const { evaluator, state, transport } = makeSungrowEvaluator({
    dvSeqSavedPath: savedPath, device,
    writeSingleImpl: (req, dev) => {
      if (req.address === 13073 && req.value === 24200) { dev[13073] = 24200; throw new Error('modbus exception 4'); }
      dev[req.address] = req.value;
    }
  });

  // 1) Sperre (Negativpreis) → _lastDvFeedIn=false.
  await evaluator.applyControlTarget('feedExcessDcPv', 0, 'negative_price_protection');
  assert.equal(state.ctrl._lastDvFeedIn, false);

  // 2) Freigabe: Restore wirft exception 4, Rücklesen zeigt 24200 → erledigt.
  //    OHNE Fix bliebe _lastDvFeedIn=false und die Box könnte nie wieder sperren.
  const release = await evaluator.applyControlTarget('feedExcessDcPv', 1, 'negative_price_protection');
  assert.equal(release.ok, true);
  assert.equal(state.ctrl._lastDvFeedIn, true, 'Zustand sauber auf frei — nicht mehr fälschlich gesperrt');

  // 3) NEUE Sperre muss jetzt wieder einen Geräte-Write auslösen (nicht am
  //    _lastDvFeedIn===feedIn-early-return hängen bleiben).
  transport.writes.length = 0;
  const block2 = await evaluator.applyControlTarget('feedExcessDcPv', 0, 'negative_price_protection');
  assert.equal(block2.ok, true);
  assert.ok(transport.writes.some((w) => w.address === 13073 && w.value === 0),
    'neue Sperre schreibt feedInLimitW:=0 ans Gerät (Abregelung wieder möglich)');
  assert.equal(state.ctrl._lastDvFeedIn, false);
});
