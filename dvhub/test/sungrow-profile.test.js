// Sungrow SH Hybrid (T-0422, Beta): ausgeliefertes hersteller/sungrow.json durch loadConfigFile,
// den echten Poller gegen ein synthetisches Registerbild (Draht-Adressen = Doku − 1), die echte
// Sequenz-Mechanik der Einspeisebegrenzung (saveBefore/restore/optional/verify) und das Beta-Gate.
// Erwartete Werte sind von Hand aus der Sungrow-Doku V1.1.9 gerechnet (Kommentare je Zeile).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPoller } from '../polling.js';
import { createScheduleEvaluator } from '../schedule-eval.js';
import { listManufacturerProfiles } from '../routes-api.js';
import { resolveBatteryLever } from '../services/grid-connection/index.js';
import {
  SUNGROW_HYBRID_MODELS, decodeSungrowString, decodeSungrowInfoBlock, identifySungrow, wire
} from '../services/inverter/sungrow.js';
import { SHIPPED, loadSungrowConfig, sungrowImage, mockSungrow } from './helpers/sungrow-fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function pollerFor(cfg, transport) {
  cfg.epex = { timezone: 'UTC' };
  cfg.userEnergyPricing = {};
  const state = {
    meter: { ok: false, updatedAt: 0, raw: [], grid_l1_w: 0, grid_l2_w: 0, grid_l3_w: 0, grid_total_w: 0, error: null },
    victron: { errors: {}, updatedAt: 0, fieldUpdatedAt: {} },
    ctrl: {},
    dvRegs: new Array(8).fill(0),
    energy: { day: '2026-11-11', importWh: 0, exportWh: 0, costEur: 0, revenueEur: 0, lastTs: 0 }
  };
  const logs = [];
  const poller = createPoller({
    state, getCfg: () => cfg, transport, pushLog: (event, data) => logs.push({ event, data }),
    energyPath: path.join(os.tmpdir(), `sungrow-poll-${process.pid}.json`),
    onPollComplete: () => {}, epexNowNext: () => ({ current: { ct_kwh: 0 } })
  });
  return { state, poller, logs };
}

function evaluatorFor(cfg, transport, device = { vendor: 'sungrow', supported: true, bdcRatedW: 10000 }) {
  const state = {
    victron: { soc: 50, errors: {}, fieldUpdatedAt: {}, device },
    meter: {},
    schedule: { rules: [], active: {}, lastWrite: {}, manualOverride: {}, config: {}, lastEvalAt: 0 },
    ctrl: {}
  };
  const logs = [];
  const evaluator = createScheduleEvaluator({
    state, getCfg: () => cfg, transport, pushLog: (event, data) => logs.push({ event, data }),
    telemetrySafeWrite: () => {}, persistConfig: async () => {}, telemetryStore: null, epexNowNext: () => null
  });
  return { state, evaluator, logs };
}

// --- Profil ------------------------------------------------------------------

test('Profil: Beta, Modbus, Draht-Adresse = Doku − 1 für jeden Punkt', () => {
  const raw = JSON.parse(fs.readFileSync(SHIPPED, 'utf8'));
  assert.equal(raw.beta, true);
  assert.match(raw.label, /Sungrow/);
  assert.match(raw.label, /Beta/);
  const cfg = loadSungrowConfig();
  assert.equal(cfg.victron.transport, 'modbus');
  assert.equal(cfg.victron.port, 502);
  assert.equal(cfg.victron.unitId, 1);
  // Doku-Adresse aus der Sungrow-Tabelle → erwartete Draht-Adresse.
  const expected = {
    'points.soc': [13023, 4], 'points.batteryPowerW': [5214, 4], 'points.pvPowerW': [5017, 4],
    'points.selfConsumptionW': [13008, 4], meter: [5601, 4],
    'controlWrite.feedInLimitRatio': [13088, 6], 'controlWrite.feedInLimitW': [13074, 6],
    'controlWrite.feedInLimitEnable': [13087, 6]
  };
  for (const [p, [doc, fc]] of Object.entries(expected)) {
    const conf = p.split('.').reduce((o, k) => o[k], cfg);
    assert.equal(conf.address, doc - 1, `${p}: Doku ${doc} → Draht ${doc - 1}`);
    assert.equal(conf.fc, fc, `${p}: fc ${fc}`);
    assert.equal(conf.host, '192.0.2.50', `${p}: Adresse der Anlage`);
    assert.match(conf._comment, new RegExp(`Doku ${doc}`), `${p}: Kommentar nennt Doku-Adresse`);
  }
  assert.equal(cfg.meter.fallback.address, 13010 - 1);
  // 32-bit-Punkte mit Sungrow-Wortreihenfolge
  for (const p of ['batteryPowerW', 'pvPowerW', 'selfConsumptionW']) {
    assert.equal(cfg.points[p].wordOrder, 'le', p);
    assert.equal(cfg.points[p].quantity, 2, p);
  }
  assert.equal(cfg.meter.wordOrder, 'le');
});

test('Profil: Steuerung nur über Holding-Register, Sollwert nachgebildet, kein restoreDefault', () => {
  const cfg = loadSungrowConfig();
  const gs = cfg.controlWrite.gridSetpointW;
  assert.equal(gs.enabled, true);
  assert.equal(gs.emulate, 'sungrow-ems');
  assert.equal(gs.address, undefined, 'kein eigenes Register für den Sollwert');
  assert.ok(gs.keepaliveMs > 0 && gs.keepaliveMs < gs.sungrowEms.targetMaxAgeMs, 'Auffrischen vor Ablauf');
  for (const p of ['chargeCurrentA', 'minSocPct', 'maxDischargeW']) assert.equal(cfg.controlWrite[p].enabled, false, p);
  for (const [name, conf] of Object.entries(cfg.controlWrite)) {
    if (!conf.enabled || conf.emulate) continue;
    assert.equal(conf.fc, 6, `${name}: FC 6 (Holding)`);
    assert.equal(conf.verify, true, `${name}: mit Rücklesen`);
  }
  const seq = cfg.dvControl.feedExcessDcPv.sequence;
  for (const steps of Object.values(seq)) {
    for (const st of steps) {
      assert.ok(cfg.controlWrite[st.point]?.enabled, `${st.point} existiert und ist an`);
      assert.equal(st.restoreDefault, undefined, 'ohne Sicherung nie eine Grenze abschalten');
    }
  }
  // Sperren: zuerst Grenze 0, zuletzt einschalten (0xAA = 170).
  assert.deepEqual(seq['0'].map((s) => [s.point, s.value]), [['feedInLimitRatio', 0], ['feedInLimitW', 0], ['feedInLimitEnable', 170]]);
  assert.equal(cfg.dvControl.dontFeedExcessAcPv.enabled, false);
  // Netzanschluss „Akku zuerst“ erkennt den nachgebildeten Sollwert als Hebel.
  const lever = resolveBatteryLever(cfg);
  assert.equal(lever.kind, 'native');
  assert.equal(lever.setpoint, true);
});

test('identify kommt nur aus dem Profil: config.json kann das Schreib-Tor nicht abschalten', () => {
  const cfg = loadSungrowConfig({ identify: { kind: 'none', requiredForWrites: false } });
  assert.equal(cfg.identify.kind, 'sungrow');
  assert.equal(cfg.identify.requiredForWrites, true);
});

test('Beta-Gate: Sungrow nur im Bleeding-Edge-Kanal wählbar, aktiv immer sichtbar', () => {
  const cfgPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-sg-gate-')), 'config.json');
  const dir = path.join(path.dirname(cfgPath), 'hersteller');
  fs.mkdirSync(dir);
  for (const f of ['victron.json', 'sungrow.json']) fs.copyFileSync(path.join(__dirname, '..', 'hersteller', f), path.join(dir, f));
  const ctx = (updateChannel, manufacturer = 'victron') => ({ getConfigPath: () => cfgPath, getRawCfg: () => ({ updateChannel, manufacturer }) });
  const values = (c) => listManufacturerProfiles(c).map((o) => o.value);
  assert.ok(!values(ctx('stable')).includes('sungrow'), 'stable: ausgeblendet');
  const dev = listManufacturerProfiles(ctx('dev')).find((o) => o.value === 'sungrow');
  assert.ok(dev, 'dev: sichtbar');
  assert.equal(dev.beta, true);
  assert.match(dev.label, /Beta/);
  assert.ok(values(ctx('stable', 'sungrow')).includes('sungrow'), 'aktives Profil fällt nie aus der Liste');
});

// --- Erkennung -----------------------------------------------------------------

test('Erkennung: Typcode-Tabelle, Seriennummer, Nennleistungen', async () => {
  assert.equal(SUNGROW_HYBRID_MODELS.get(0xe03).model, 'SH10RT');
  assert.equal(SUNGROW_HYBRID_MODELS.get(0xe28).model, 'SH25T');
  assert.equal(SUNGROW_HYBRID_MODELS.get(0xd0f).phases, 1);
  assert.equal(SUNGROW_HYBRID_MODELS.size, 33, '5 SH-RS + 2 SH-RS groß + 16 SH-RT + 8 SH-T + 2 MG-RL');
  // Doku 4.7: 121212001 als UTF-8, Rest 0x00
  assert.equal(decodeSungrowString([0x3132, 0x3132, 0x3132, 0x3030, 0x3100, 0, 0, 0, 0, 0]), '121212001');
  const t = mockSungrow(sungrowImage());
  const id = await identifySungrow((q) => t.mbRequest(q));
  assert.deepEqual(
    { model: id.model, supported: id.supported, serial: id.serial, nominalW: id.nominalW, bdcRatedW: id.bdcRatedW, typeCodeHex: id.typeCodeHex },
    { model: 'SH10RT', supported: true, serial: 'A2231234567', nominalW: 10000, bdcRatedW: 10000, typeCodeHex: '0xE03' });
  assert.deepEqual(t.reads.map((r) => [r.fc, r.address]), [[4, 4999], [4, 4989], [4, 5627]]);
  // String-WR (SG, Typcode nicht in der Hybrid-Tabelle) → erkannt, aber nicht unterstützt.
  const sg = mockSungrow(sungrowImage({ input: { [wire(5000)]: 0x0270 } }));
  const idSg = await identifySungrow((q) => sg.mbRequest(q));
  assert.equal(idSg.supported, false);
  assert.equal(idSg.model, null);
});

test('Infoblock 13000–13045: Tageswerte, SoH, Temperatur mit Vorzeichen', () => {
  const regs = new Array(46).fill(0);
  regs[0] = 0x4000; regs[2] = 123; regs[24] = 985; regs[25] = 0x10000 - 25; regs[36] = 72; regs[45] = 0xffff;
  const info = decodeSungrowInfoBlock(regs);
  assert.equal(info.runningStateText, 'Externes EMS');
  assert.equal(info.dailyPvKwh, 12.3);
  assert.equal(info.sohPct, 98.5);
  assert.equal(info.batteryTempC, -2.5);
  assert.equal(info.dailyImportKwh, 7.2);
  assert.equal(info.dailyExportKwh, null, '0xFFFF = kein Wert');
  assert.equal(decodeSungrowInfoBlock(regs.slice(0, 40)), null);
});

// --- Poller ----------------------------------------------------------------------

test('Poller: SoC 0,1 %, Akku S32 LE mit Vorzeichenwechsel, PV U32 LE, Last, Zähler 4×S32', async () => {
  const cfg = loadSungrowConfig({ gridPositiveMeans: 'grid_import' });
  const t = mockSungrow(sungrowImage());
  const { state, poller, logs } = pollerFor(cfg, t);
  await poller.requestPoll();
  assert.equal(state.victron.soc, 57.3);
  assert.equal(state.victron.batteryPowerW, 1500, 'Sungrow −1500 (Laden) → DVhub +1500');
  assert.equal(state.victron.pvPowerW, 70000, 'niederwertiges Wort zuerst: [0x1170, 0x0001] = 70 000');
  assert.equal(state.victron.selfConsumptionW, 850);
  assert.equal(state.meter.ok, true);
  assert.equal(state.meter.grid_total_w, -2300, 'Bezug positiv → 2,3 kW Einspeisung = −2300');
  assert.deepEqual([state.meter.grid_l1_w, state.meter.grid_l2_w, state.meter.grid_l3_w], [-800, -700, -800]);
  // Erkennung + Infoblock im selben Takt
  assert.equal(state.victron.device.model, 'SH10RT');
  assert.equal(state.victron.device.supported, true);
  assert.equal(state.victron.device.info.sohPct, 98.5);
  assert.ok(logs.some((l) => l.event === 'inverter_identified'));
  // Nur Input-Register zyklisch gelesen — kein FC 3 (Holding) im Poll.
  assert.deepEqual(t.reads.filter((r) => r.fc !== 4), []);
});

test('Poller: feed_in-Konvention (Standard) dreht den Zähler wie bei Victron', async () => {
  const cfg = loadSungrowConfig();
  const { state, poller } = pollerFor(cfg, mockSungrow(sungrowImage()));
  await poller.requestPoll();
  assert.equal(state.meter.grid_total_w, 2300);
  assert.equal(state.meter.grid_l2_w, 700);
});

test('Poller: „nicht verfügbar“-Rohwerte werden null, nicht 6553,5 % oder 2 147 483 647 W', async () => {
  const cfg = loadSungrowConfig({ gridPositiveMeans: 'grid_import' });
  const t = mockSungrow(sungrowImage({ input: {
    [wire(13023)]: 0xffff, [wire(5214)]: 0xffff, [wire(5214) + 1]: 0x7fff
  } }));
  const { state, poller } = pollerFor(cfg, t);
  await poller.requestPoll();
  assert.equal(state.victron.soc, null);
  assert.equal(state.victron.batteryPowerW, null);
});

test('Zähler: Gesamt nicht verfügbar → Summe der Phasen; Phase fehlt → null', async () => {
  const cfg = loadSungrowConfig({ gridPositiveMeans: 'grid_import' });
  const na = [0xffff, 0x7fff];
  const img = sungrowImage({ input: { [wire(5601)]: na[0], [wire(5601) + 1]: na[1] } });
  const { state, poller } = pollerFor(cfg, mockSungrow(img));
  await poller.requestPoll();
  assert.equal(state.meter.ok, true);
  assert.equal(state.meter.grid_total_w, -2300, '−800 − 700 − 800');
  // Einphasiger Zähler: Gesamt da, Phasen „kein Wert“
  const img2 = sungrowImage();
  for (const doc of [5603, 5605, 5607]) { img2.input.set(wire(doc), na[0]); img2.input.set(wire(doc) + 1, na[1]); }
  const r2 = pollerFor(loadSungrowConfig({ gridPositiveMeans: 'grid_import' }), mockSungrow(img2));
  await r2.poller.requestPoll();
  assert.equal(r2.state.meter.grid_total_w, -2300);
  assert.deepEqual([r2.state.meter.grid_l1_w, r2.state.meter.grid_l2_w, r2.state.meter.grid_l3_w], [null, null, null]);
});

test('Zähler: alte Firmware ohne Block 5601 → Ersatz 13010 (Einspeisung positiv, scale −1)', async () => {
  const cfg = loadSungrowConfig({ gridPositiveMeans: 'grid_import' });
  const drop = Array.from({ length: 8 }, (_, i) => wire(5601) + i);
  const t = mockSungrow(sungrowImage({ dropInput: drop }));
  const { state, poller, logs } = pollerFor(cfg, t);
  await poller.requestPoll();
  assert.equal(state.meter.ok, true);
  assert.equal(state.meter.grid_total_w, -2300, '+2300 Einspeisung → −2300 bei Bezug positiv');
  assert.equal(state.meter.grid_l1_w, null);
  assert.equal(state.meter.source, 'fallback');
  assert.equal(logs.filter((l) => l.event === 'meter_fallback_active').length, 1);
  // Nächster Takt: Block wird nicht erneut versucht (stündlich), nur das Ersatzregister.
  t.reads.length = 0;
  await poller.requestPoll();
  assert.ok(!t.reads.some((r) => r.address === wire(5601)), 'Block nicht jede Runde neu');
  assert.ok(t.reads.some((r) => r.address === wire(13010)));
});

test('Zähler: andere Lesefehler bleiben Fehler (kein stiller Ersatz)', async () => {
  const cfg = loadSungrowConfig();
  const t = mockSungrow(sungrowImage());
  const orig = t.mbRequest.bind(t);
  t.mbRequest = async (conf) => { if (conf.address === wire(5601)) throw new Error('modbus timeout'); return orig(conf); };
  const { state, poller } = pollerFor(cfg, t);
  await poller.requestPoll();
  assert.equal(state.meter.ok, false);
  assert.match(state.meter.error, /timeout/);
});

test('Poller: Typcode eines String-WR → device.supported false', async () => {
  const cfg = loadSungrowConfig();
  const { state, poller, logs } = pollerFor(cfg, mockSungrow(sungrowImage({ input: { [wire(5000)]: 0x0270 } })));
  await poller.requestPoll();
  assert.equal(state.victron.device.supported, false);
  assert.ok(logs.some((l) => l.event === 'inverter_not_supported'));
});

// --- Abregelung (Einspeisebegrenzung) ---------------------------------------------

test('Abregelung: sichert Quote/Wert/Schalter, schreibt 0 % · 0 W · an, liest jeden Write zurück', async () => {
  const cfg = loadSungrowConfig();
  const img = sungrowImage();
  const t = mockSungrow(img);
  const { state, evaluator } = evaluatorFor(cfg, t);
  await evaluator.applyDvVictronControl(false, { reason: 'negative_price_protection' });
  assert.equal(state.ctrl._lastDvFeedIn, false);
  assert.deepEqual(t.writes, [
    { fc: 6, address: wire(13088), value: 0 },
    { fc: 6, address: wire(13074), value: 0 },
    { fc: 6, address: wire(13087), value: 0xaa }
  ]);
  assert.deepEqual(state.ctrl._dvSeqSaved, { feedInLimitRatio: 700, feedInLimitW: 5000, feedInLimitEnable: 0xaa });
  // Je Write ein FC-3-Rücklesen derselben Adresse (nach dem Sichern).
  const fc3 = t.reads.filter((r) => r.fc === 3).map((r) => r.address);
  assert.deepEqual(fc3, [wire(13088), wire(13074), wire(13087), wire(13088), wire(13074), wire(13087)]);

  // Freigabe: genau die gesicherten Werte zurück.
  t.writes.length = 0;
  await evaluator.applyDvVictronControl(true);
  assert.deepEqual(t.writes, [
    { fc: 6, address: wire(13088), value: 700 },
    { fc: 6, address: wire(13074), value: 5000 },
    { fc: 6, address: wire(13087), value: 0xaa }
  ]);
  assert.deepEqual(state.ctrl._dvSeqSaved, {});
});

test('Abregelung: ohne Register 13088 (alte Firmware) wird nur der optionale Schritt übersprungen', async () => {
  const cfg = loadSungrowConfig();
  for (const img of [sungrowImage({ dropHolding: [wire(13088)] }), sungrowImage({ holding: { [wire(13088)]: 0xffff } })]) {
    const t = mockSungrow(img);
    const { state, evaluator } = evaluatorFor(cfg, t);
    await evaluator.applyDvVictronControl(false, { reason: 'dv_forced_off' });
    assert.equal(state.ctrl._lastDvFeedIn, false);
    assert.deepEqual(t.writes.map((w) => w.address), [wire(13074), wire(13087)]);
    assert.equal(state.ctrl._dvSeqSaved.feedInLimitRatio, undefined);
    t.writes.length = 0;
    await evaluator.applyDvVictronControl(true);
    assert.deepEqual(t.writes.map((w) => [w.address, w.value]), [[wire(13074), 5000], [wire(13087), 0xaa]]);
  }
});

test('Abregelung: Rücklesen weicht ab → Sperre gilt als gescheitert, nächster Takt versucht erneut', async () => {
  const cfg = loadSungrowConfig();
  // Installateur hatte die Begrenzung AUS (0x55); das Gerät übernimmt den Schalter-Write nicht.
  const img = sungrowImage({ holding: { [wire(13087)]: 0x55 } });
  const t = mockSungrow(img, { ignoreWriteAt: wire(13087) });
  const { state, evaluator, logs } = evaluatorFor(cfg, t);
  await evaluator.applyDvVictronControl(false, { reason: 'dv_forced_off' });
  assert.notEqual(state.ctrl._lastDvFeedIn, false, 'nicht als gesperrt gemerkt');
  assert.equal(state.ctrl._dvPartialBlock, true, 'Teil-Sperre (Not-Halt gibt sie frei)');
  assert.equal(state.ctrl.dvControl.feedExcessDcPv.ok, false);
  assert.match(state.ctrl.dvControl.feedExcessDcPv.error, /Rücklesung feedInLimitEnable weicht ab/);
  assert.ok(logs.some((l) => l.event === 'dv_seq_readback_mismatch'));
  // Nächster Takt: derselbe Block wird erneut geschrieben (Cache nicht vorgerückt).
  t.writes.length = 0;
  await evaluator.applyDvVictronControl(false, { reason: 'dv_forced_off' });
  assert.ok(t.writes.some((w) => w.address === wire(13087) && w.value === 0xaa));
});

test('Geräte-Tor: ohne erkanntes bzw. mit nicht unterstütztem Gerät kein einziger Write', async () => {
  const cfg = loadSungrowConfig();
  for (const device of [null, { vendor: 'sungrow', supported: false }]) {
    const t = mockSungrow(sungrowImage());
    const { state, evaluator } = evaluatorFor(cfg, t, device);
    await evaluator.applyDvVictronControl(false, { reason: 'dv_forced_off' });
    assert.deepEqual(t.writes, []);
    assert.notEqual(state.ctrl._lastDvFeedIn, false);
    const res = await evaluator.applyControlTarget('gridSetpointW', -40, 'default');
    assert.equal(res.ok, false);
    assert.match(res.error, /device_not_(identified|supported)/);
    assert.deepEqual(t.writes, []);
  }
});
