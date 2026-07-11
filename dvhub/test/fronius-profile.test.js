// B-1112 Fronius-Pack Stufe 1: shipped hersteller/fronius.json + Scan-Auflösung
// im Poller + WMaxLim-Abregelungs-Sequenz im DV-Steuerpfad. Die Tests fahren
// das ECHTE Profil durch loadConfigFile, den ECHTEN Poller (requestPoll) gegen
// ein synthetisches GEN24-Registerbild und den ECHTEN Evaluator-Sequenzpfad.
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
// → M113-Daten @40072 (W@+20=40092), M123-Daten @40162 (Pct@+3=40165,
//   Ena@+7=40169), M124-Daten @40188 (MinRsvPct@+5=40193, ChaState@+6=40194).
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

// ── Tests ────────────────────────────────────────────────────────────────

test('shipped fronius.json loads: modbus transport, scan-based points, WMaxLim sequence', () => {
  const loaded = loadFroniusEffectiveConfig();
  assert.equal(loaded.manufacturerProfileError, null);
  const cfg = loaded.effectiveConfig;
  assert.equal(cfg.victron.transport, 'modbus');
  assert.equal(cfg.victron.unitId, 1);
  // Scan-Punkte tragen sunspec-Deklaration und KEINE feste Adresse.
  assert.deepEqual(cfg.points.soc.sunspec, { model: 124, offset: 6 });
  assert.equal(cfg.points.soc.address, undefined);
  assert.equal(cfg.points.pvPowerW.readType, 'float32');
  // Kein Setpoint-Dialekt, keine aktiven Batterie-Writes in Stufe 1.
  assert.equal(cfg.controlWrite.gridSetpointW.enabled, false);
  assert.equal(cfg.controlWrite.minSocPct.enabled, false);
  // 2026-07-11 (Vinzent82-Feldtest): DV-Abregelung in Stufe 1 deaktiviert —
  // WMaxLimPct=0 legt Hybrid-Anlagen lahm (Haus am Netz). Die Sequenz-DEFINITION
  // bleibt als Referenz für den späteren korrekten Regler (B-1103) erhalten,
  // ist aber inaktiv geschaltet. Auch die MinRsvPct-Anzeige ist aus (0xFFFF).
  assert.equal(cfg.dvControl.dontFeedExcessAcPv.enabled, false);
  assert.equal(cfg.dvControl.negativePriceProtection.enabled, false);
  assert.equal(cfg.points.minSocPct.enabled, false);
  // Sequenz-Definition weiterhin vorhanden: sperren = Pct dann Ena, freigeben = nur Ena.
  const seq = cfg.dvControl.dontFeedExcessAcPv.sequence;
  assert.deepEqual(seq['1'].map((s) => s.point), ['wMaxLimPct', 'wMaxLimEna']);
  assert.deepEqual(seq['0'].map((s) => s.point), ['wMaxLimEna']);
  // Meter: Float32-Block @ Unit 200, host fällt auf die Anlagenadresse zurück.
  assert.equal(cfg.meter.readType, 'float32');
  assert.equal(cfg.meter.unitId, 200);
  assert.equal(cfg.meter.host, '192.168.1.60');
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
  assert.equal(cfg.controlWrite.wMaxLimPct.address, 40165);
  assert.equal(cfg.controlWrite.wMaxLimEna.address, 40169);
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
});

test('WMaxLim sequence MECHANIK (falls via B-1103 reaktiviert): block = Pct:=0 then Ena:=1, release = Ena:=0', async () => {
  const loaded = loadFroniusEffectiveConfig();
  const cfg = loaded.effectiveConfig;
  // Das ausgelieferte Profil hat die Abregelung deaktiviert (Vinzent82-Fix);
  // dieser Test prüft nur die Sequenz-MECHANIK, daher hier bewusst reaktiviert.
  cfg.dvControl.dontFeedExcessAcPv.enabled = true;
  // Adressen wie nach erfolgtem Scan.
  cfg.controlWrite.wMaxLimPct.address = 40165;
  cfg.controlWrite.wMaxLimEna.address = 40169;

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

  // Sperren (feedIn=false → dontFeedExcessAcPv val=1).
  await evaluator.applyDvVictronControl(false);
  assert.deepEqual(transport.writes, [
    { fc: 6, address: 40165, value: 0 },
    { fc: 6, address: 40169, value: 1 }
  ]);
  assert.equal(state.ctrl.dvControl.dontFeedExcessAcPv.ok, true);
  assert.equal(state.ctrl._lastDvFeedIn, false);

  // Freigeben (feedIn=true → val=0): nur Ena:=0.
  transport.writes.length = 0;
  await evaluator.applyDvVictronControl(true);
  assert.deepEqual(transport.writes, [{ fc: 6, address: 40169, value: 0 }]);
  assert.equal(state.ctrl._lastDvFeedIn, true);
});

test('sequence on UNRESOLVED sunspec point fails safely and is retried (no change-cache poisoning)', async () => {
  const loaded = loadFroniusEffectiveConfig();
  const cfg = loaded.effectiveConfig; // Adressen NICHT aufgelöst (kein Scan)
  // Mechanik-Test → Abregelung im Test reaktivieren (im Profil deaktiviert, s.o.).
  cfg.dvControl.dontFeedExcessAcPv.enabled = true;

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
  assert.equal(state.ctrl.dvControl.dontFeedExcessAcPv.ok, false);
  // T-0076: Fehlschlag darf den Change-Cache nicht setzen — nächster Zyklus versucht erneut.
  assert.equal(state.ctrl._lastDvFeedIn, undefined);

  // applyControlTarget lehnt unaufgelöste sunspec-Targets mit klarem Grund ab.
  const res = await evaluator.applyControlTarget('wMaxLimEna', 1, 'test');
  assert.equal(res.ok, false);
  assert.match(res.error, /sunspec address not resolved/);
});

test('shipped profile: DV curtailment is DISABLED → no WMaxLim write can lame the inverter (Vinzent82-Fix)', async () => {
  const loaded = loadFroniusEffectiveConfig();
  const cfg = loaded.effectiveConfig; // AUSGELIEFERTES Profil, unverändert
  // Adressen gesetzt, damit ein etwaiger Write NICHT bloß am fehlenden Scan scheitert.
  cfg.controlWrite.wMaxLimPct.address = 40165;
  cfg.controlWrite.wMaxLimEna.address = 40169;

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

  // Sperr-Anforderung (feedIn=false): mit deaktivierter Abregelung darf NICHTS
  // auf die Hardware gehen — sonst würde WMaxLimPct=0 die Anlage lahmlegen.
  await evaluator.applyDvVictronControl(false);
  assert.equal(transport.writes.length, 0, 'disabled DV curtailment must not write WMaxLim');
});
