// B-1112 Fronius-Pack: shipped hersteller/fronius.json + Scan-Auflösung im Poller
// + Model-124-Abregelung (Akku-Force-Charge, wie evcc) im DV-Steuerpfad. Die Tests
// fahren das ECHTE Profil durch loadConfigFile, den ECHTEN Poller (requestPoll)
// gegen ein synthetisches GEN24-Registerbild und den ECHTEN Evaluator-Sequenzpfad.
//
// NACHHER-Ansatz (2026-07-11): Abregelung NICHT über WMaxLimPct=0 (kappt die ganze
// WR-Wirkleistung, legt Hybrid-Anlagen lahm — der alte, falsche Weg), sondern über
// SunSpec Model 124 wie evcc: 'keine Einspeisung' = StorCtl_Mod:=2 + OutWRte:=-100 %
// (Force-Charge, Überschuss in den Akku), Freigabe = StorCtl_Mod:=0 + OutWRte:=100 %.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfigFile } from '../config-model.js';
import { createPoller } from '../polling.js';
import { createScheduleEvaluator } from '../schedule-eval.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHIPPED_PROFILE = path.join(__dirname, '..', 'hersteller', 'fronius.json');

function loadFroniusEffectiveConfig() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-fronius-'));
  fs.mkdirSync(path.join(rootDir, 'hersteller'), { recursive: true });
  fs.copyFileSync(SHIPPED_PROFILE, path.join(rootDir, 'hersteller', 'fronius.json'));
  const configPath = path.join(rootDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    manufacturer: 'fronius',
    gridPositiveMeans: 'feed_in',
    victron: { host: '192.168.1.60' }
  }));
  return loadConfigFile(configPath);
}

// ── Synthetisches GEN24-Registerbild (float-Modus) ───────────────────────
// Kette @40000: SunS, [1,66], [113,60], [120,26], [123,24], [124,24], Ende.
// → M113-Daten @40072 (W@+20=40092), M124-Daten @40188 (StorCtl_Mod@+3=40191,
//   MinRsvPct@+5=40193, ChaState@+6=40194, OutWRte@+10=40198).
function float32Regs(value) {
  const b = Buffer.alloc(4);
  b.writeFloatBE(value, 0);
  return [b.readUInt16BE(0), b.readUInt16BE(2)];
}

function buildGen24Image() {
  const image = new Map();
  const put = (addr, words) => words.forEach((w, i) => image.set(addr + i, w & 0xffff));
  put(40000, [0x5375, 0x6e53]);
  let cursor = 40002;
  for (const [id, len] of [[1, 66], [113, 60], [120, 26], [123, 24], [124, 24]]) {
    put(cursor, [id, len]);
    put(cursor + 2, new Array(len).fill(0));
    cursor += 2 + len;
  }
  put(cursor, [0xffff, 0]);
  put(40092, float32Regs(7500));   // M113 W = 7,5 kW AC
  put(40194, [5730]);              // M124 ChaState = 57,30 %
  put(40193, [500]);               // M124 MinRsvPct (SF −2) = 5 %
  return image;
}

function makeMockTransport(image) {
  const meterRegs = [
    ...float32Regs(-1234.5), ...float32Regs(-400.1),
    ...float32Regs(-400.2), ...float32Regs(-434.2)
  ];
  return {
    type: 'modbus',
    writes: [],
    async mbRequest(conf) {
      if (Number(conf.unitId) === 200) return meterRegs.slice(0, (conf.quantity ?? 8) * 1);
      const regs = [];
      for (let i = 0; i < (conf.quantity ?? 1); i += 1) {
        const addr = Number(conf.address) + i;
        if (!image.has(addr)) throw new Error(`illegal read @${addr}`);
        regs.push(image.get(addr));
      }
      return regs;
    },
    async mbWriteSingle({ address, value }) { this.writes.push({ fc: 6, address, value }); },
    async mbWriteMultiple({ address, values }) { this.writes.push({ fc: 16, address, values }); }
  };
}

// -100 % @ scale 0.01 → −10000, als int16-Zweierkomplement in ein uint16-Wort.
const OUTWRTE_FORCE_CHARGE_RAW = 65536 - 10000; // 55536

// ── Tests ────────────────────────────────────────────────────────────────

test('shipped fronius.json loads: modbus, scan-Punkte, Model-124-Abregelung statt WMaxLim', () => {
  const loaded = loadFroniusEffectiveConfig();
  assert.equal(loaded.manufacturerProfileError, null);
  const cfg = loaded.effectiveConfig;
  assert.equal(cfg.victron.transport, 'modbus');
  assert.equal(cfg.victron.unitId, 1);
  // Scan-Punkte tragen sunspec-Deklaration und KEINE feste Adresse.
  assert.deepEqual(cfg.points.soc.sunspec, { model: 124, offset: 6 });
  assert.equal(cfg.points.soc.address, undefined);
  assert.equal(cfg.points.pvPowerW.readType, 'float32');
  // Kein Setpoint-Dialekt (Victron-exklusiv), keine minSoc-Writes in Beta.
  assert.equal(cfg.controlWrite.gridSetpointW.enabled, false);
  assert.equal(cfg.controlWrite.minSocPct.enabled, false);
  // Model-124-Steuerpunkte (wie evcc): StorCtl_Mod + OutWRte aktiv, ChaGriSet aus.
  assert.equal(cfg.controlWrite.storCtlMod.enabled, true);
  assert.deepEqual(cfg.controlWrite.storCtlMod.sunspec, { model: 124, offset: 3 });
  assert.equal(cfg.controlWrite.outWRte.enabled, true);
  assert.deepEqual(cfg.controlWrite.outWRte.sunspec, { model: 124, offset: 10 });
  assert.equal(cfg.controlWrite.outWRte.signed, true);
  assert.equal(cfg.controlWrite.outWRte.scale, 0.01);
  assert.equal(cfg.controlWrite.chaGriSet.enabled, false);
  // Der falsche WMaxLim-Weg ist GANZ entfernt (kein Register mehr, das die
  // Gesamt-Wirkleistung kappen könnte).
  assert.equal(cfg.controlWrite.wMaxLimPct, undefined);
  assert.equal(cfg.controlWrite.wMaxLimEna, undefined);
  // Abregelung ist JETZT aktiv (über feedExcessDcPv, DC-gekoppelt), AC-Pfad aus.
  assert.equal(cfg.dvControl.enabled, true);
  assert.equal(cfg.dvControl.feedExcessDcPv.enabled, true);
  assert.equal(cfg.dvControl.dontFeedExcessAcPv.enabled, false);
  assert.equal(cfg.dvControl.negativePriceProtection.enabled, true);
  // Sequenz: sperren (0) = StorCtl_Mod:=2 dann OutWRte:=-100, jeweils mit
  // saveBefore (Kundenwerte sichern); freigeben (1) = restore der gesicherten
  // Kundenwerte, Fallback restoreDefault 0/+100 (save/restore, Feldtest 554bbdfd).
  const seq = cfg.dvControl.feedExcessDcPv.sequence;
  assert.deepEqual(seq['0'].map((s) => s.point), ['storCtlMod', 'outWRte']);
  assert.deepEqual(seq['0'].map((s) => s.value), [2, -100]);
  assert.deepEqual(seq['0'].map((s) => s.saveBefore), [true, true]);
  assert.deepEqual(seq['1'].map((s) => s.point), ['storCtlMod', 'outWRte']);
  assert.deepEqual(seq['1'].map((s) => s.restore), [true, true]);
  assert.deepEqual(seq['1'].map((s) => s.restoreDefault), [0, 100]);
  // Meter: Float32-Block @ Unit 200, host fällt auf die Anlagenadresse zurück.
  assert.equal(cfg.meter.readType, 'float32');
  assert.equal(cfg.meter.unitId, 200);
  assert.equal(cfg.meter.host, '192.168.1.60');
  // Kalibriert am GEN24 Symo 2026-07-18: M213 W_total @ abs 40097 (nicht 40090 —
  // die alte @sim-assumption landete mitten in den Spannungsregistern).
  assert.equal(cfg.meter.address, 40097);
  // Hauslast kommt als Ableitung (kein Register-Read): derive-Flag am Punkt.
  assert.equal(cfg.points.selfConsumptionW.enabled, false);
  assert.equal(cfg.points.selfConsumptionW.derive, 'pv_plus_grid');
});

test('poller resolves sunspec addresses via device scan and reads SoC + float meter', async () => {
  const loaded = loadFroniusEffectiveConfig();
  const cfg = loaded.effectiveConfig;
  cfg.pollMs = 500;
  cfg.epex = { timezone: 'UTC' };
  cfg.userEnergyPricing = {};

  const state = {
    meter: { ok: false, updatedAt: 0, raw: [], grid_l1_w: 0, grid_l2_w: 0, grid_l3_w: 0, grid_total_w: 0, error: null },
    victron: { errors: {}, updatedAt: 0, fieldUpdatedAt: {} },
    dvRegs: new Array(8).fill(0),
    energy: { day: '2026-07-10', importWh: 0, exportWh: 0, costEur: 0, revenueEur: 0, lastTs: 0 }
  };
  const transport = makeMockTransport(buildGen24Image());
  const logs = [];
  const poller = createPoller({
    state,
    getCfg: () => cfg,
    transport,
    pushLog: (event, payload) => logs.push({ event, payload }),
    energyPath: path.join(os.tmpdir(), 'fronius-poll-test.json'),
    onPollComplete: () => {},
    epexNowNext: () => ({ current: { ct_kwh: 0 } })
  });

  await poller.requestPoll();

  // Scan hat die effektive Config in-place aufgelöst.
  const scanLog = logs.find((l) => l.event === 'sunspec_scan_ok');
  assert.ok(scanLog, `sunspec_scan_ok expected, got: ${logs.map((l) => l.event).join(',')}`);
  assert.equal(scanLog.payload.base, 40000);
  assert.equal(cfg.points.soc.address, 40194);
  // Model-124-Steuerpunkte sind jetzt die aufgelösten Ziele.
  assert.equal(cfg.controlWrite.storCtlMod.address, 40191);
  assert.equal(cfg.controlWrite.outWRte.address, 40198);
  assert.deepEqual(scanLog.payload.missing, []);

  // Telemetrie: SoC über scale 0.01, AC-W als Float32, Meter-Block dekodiert.
  assert.equal(state.victron.soc, 57.3);
  // minSocPct-Anzeige ist deaktiviert (2026-07-11, reale GEN24 liefert 0xFFFF) →
  // der Poller liest MinRsvPct nicht mehr, der Wert bleibt ungesetzt.
  assert.equal(state.victron.minSocPct, undefined);
  assert.equal(state.victron.pvPowerW, 7500);
  // feed_in-Konvention: Meter meldet Einspeisung positiv → sign −1.
  assert.equal(state.meter.ok, true);
  assert.equal(state.meter.grid_total_w, 1235); // round(-(-1234.5)) = 1235
  assert.equal(state.meter.grid_l1_w, 400);
  // Hauslast-Ableitung (derive 'pv_plus_grid'): Last = WR-AC + Bezug − Einspeisung
  // = 7500 + 0 − 1235 = 6265 W. Verifiziert am GEN24 Symo 2026-07-18 gegen die
  // Solar API (P_Load 1332,9 W vs. abgeleitet 1332 W an der Kundenanlage).
  assert.equal(state.victron.selfConsumptionW, 6265);
  assert.equal(state.victron.solarDirectUseW, 6265);
  assert.equal(state.victron.solarToGridW, 1235);
});

test('Model-124-Sequenz: sperren = StorCtl_Mod:=2 dann OutWRte:=-100, freigeben = restore der Kundenwerte', async () => {
  const loaded = loadFroniusEffectiveConfig();
  const cfg = loaded.effectiveConfig; // AUSGELIEFERTES Profil (Abregelung aktiv)
  // Adressen wie nach erfolgtem Scan.
  cfg.controlWrite.storCtlMod.address = 40191;
  cfg.controlWrite.outWRte.address = 40198;

  const state = {
    victron: { soc: 50 },
    schedule: { rules: [], active: {}, lastWrite: {}, manualOverride: {}, config: {}, lastEvalAt: 0 },
    ctrl: {}
  };
  const transport = makeMockTransport(buildGen24Image());
  const logs = [];
  const evaluator = createScheduleEvaluator({
    state,
    getCfg: () => cfg,
    transport,
    pushLog: (event, payload) => logs.push({ event, payload }),
    telemetrySafeWrite: () => {},
    persistConfig: async () => {},
    telemetryStore: null,
    epexNowNext: () => null
  });

  // Sperren (feedIn=false → feedExcessDcPv val=0): Force-Charge.
  await evaluator.applyDvVictronControl(false);
  assert.deepEqual(transport.writes, [
    { fc: 6, address: 40191, value: 2 },                       // StorCtl_Mod = 2 (Entlade-Control an)
    { fc: 6, address: 40198, value: OUTWRTE_FORCE_CHARGE_RAW } // OutWRte = -100 % (Laden)
  ]);
  assert.equal(state.ctrl.dvControl.feedExcessDcPv.ok, true);
  assert.equal(state.ctrl._lastDvFeedIn, false);

  // Freigeben (feedIn=true → val=1): stellt die beim Sperren via saveBefore
  // gesicherten KUNDENWERTE wieder her (Mock-Image: beide Register = 0) —
  // NICHT die pauschalen restoreDefaults 0/+100 (save/restore, 554bbdfd).
  transport.writes.length = 0;
  await evaluator.applyDvVictronControl(true);
  assert.deepEqual(transport.writes, [
    { fc: 6, address: 40191, value: 0 },  // StorCtl_Mod: Kundenwert 0 restauriert
    { fc: 6, address: 40198, value: 0 }   // OutWRte: Kundenwert 0 % restauriert (raw 0)
  ]);
  assert.equal(state.ctrl._lastDvFeedIn, true);
});

test('sequence on UNRESOLVED sunspec point fails safely and is retried (no change-cache poisoning)', async () => {
  const loaded = loadFroniusEffectiveConfig();
  const cfg = loaded.effectiveConfig; // Adressen NICHT aufgelöst (kein Scan)

  const state = {
    victron: { soc: 50 },
    schedule: { rules: [], active: {}, lastWrite: {}, manualOverride: {}, config: {}, lastEvalAt: 0 },
    ctrl: {}
  };
  const transport = makeMockTransport(buildGen24Image());
  const evaluator = createScheduleEvaluator({
    state,
    getCfg: () => cfg,
    transport,
    pushLog: () => {},
    telemetrySafeWrite: () => {},
    persistConfig: async () => {},
    telemetryStore: null,
    epexNowNext: () => null
  });

  await evaluator.applyDvVictronControl(false);
  assert.equal(transport.writes.length, 0, 'no hardware write with unresolved addresses');
  assert.equal(state.ctrl.dvControl.feedExcessDcPv.ok, false);
  // T-0076: Fehlschlag darf den Change-Cache nicht setzen — nächster Zyklus versucht erneut.
  assert.equal(state.ctrl._lastDvFeedIn, undefined);

  // applyControlTarget lehnt unaufgelöste sunspec-Targets mit klarem Grund ab.
  const res = await evaluator.applyControlTarget('storCtlMod', 2, 'test');
  assert.equal(res.ok, false);
  assert.match(res.error, /sunspec address not resolved/);
});

test('Vinzent82-Anti-Regression: Abregelung fährt den Akku (Force-Charge), NIE die WR-Gesamtleistung', async () => {
  const loaded = loadFroniusEffectiveConfig();
  const cfg = loaded.effectiveConfig; // AUSGELIEFERTES Profil, unverändert
  cfg.controlWrite.storCtlMod.address = 40191;
  cfg.controlWrite.outWRte.address = 40198;

  // Es darf gar kein WMaxLim-Register mehr im Profil existieren.
  assert.equal(cfg.controlWrite.wMaxLimPct, undefined);
  assert.equal(cfg.controlWrite.wMaxLimEna, undefined);

  const state = {
    victron: { soc: 50 },
    schedule: { rules: [], active: {}, lastWrite: {}, manualOverride: {}, config: {}, lastEvalAt: 0 },
    ctrl: {}
  };
  const transport = makeMockTransport(buildGen24Image());
  const evaluator = createScheduleEvaluator({
    state,
    getCfg: () => cfg,
    transport,
    pushLog: () => {},
    telemetrySafeWrite: () => {},
    persistConfig: async () => {},
    telemetryStore: null,
    epexNowNext: () => null
  });

  // Sperr-Anforderung: Überschuss wird in den Akku gezwungen (OutWRte NEGATIV),
  // das Haus bleibt aus PV+Akku versorgt — NICHT die Gesamt-Wirkleistung gekappt.
  await evaluator.applyDvVictronControl(false);
  const outWrite = transport.writes.find((w) => w.address === 40198);
  assert.ok(outWrite, 'OutWRte wird geschrieben');
  assert.ok(outWrite.value > 32767, 'OutWRte-Wert ist ein negatives int16 (Force-Charge), kein Leistungslimit');
});
