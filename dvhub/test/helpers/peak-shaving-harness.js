// test/helpers/peak-shaving-harness.js — gemeinsamer Prüfstand für Peak Shaving.
//
// Echte Bausteine an der Grenze: das AUSGELIEFERTE hersteller/victron.json über
// loadConfigFile (Profil-Merge wie auf der Box), der echte
// createScheduleEvaluator und ein Modbus-Transport, der nur die Rohwörter
// mitschreibt. Ausgewertet wird, was auf dem Draht landen würde:
//   2716/2717 gridSetpointW  int32 (fc16)
//   2704      maxDischargeW  int16, 10-W-Schritte (0 unskaliert)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfigFile } from '../../config-model.js';
import { createScheduleEvaluator } from '../../schedule-eval.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHIPPED_VICTRON = path.join(__dirname, '..', '..', 'hersteller', 'victron.json');

/** Effektive Config wie auf einer Victron-Box: ausgeliefertes Profil + persistierte Werte. */
export function loadVictronConfig(persisted = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-peak-'));
  fs.mkdirSync(path.join(rootDir, 'hersteller'), { recursive: true });
  fs.copyFileSync(SHIPPED_VICTRON, path.join(rootDir, 'hersteller', 'victron.json'));
  const configPath = path.join(rootDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    manufacturer: 'victron',
    victron: { host: '192.0.2.10' },
    ...persisted
  }));
  const loaded = loadConfigFile(configPath);
  if (loaded.manufacturerProfileError) throw new Error(loaded.manufacturerProfileError);
  return loaded.effectiveConfig;
}

/** Peak Shaving an, Bleeding-Edge-Kanal, Grenze 10 kW, Abstand 300 W → Regelziel 9 700 W. */
export const PEAK_ON = Object.freeze({
  updateChannel: 'dev',
  peakShaving: { enabled: true, gridImportLimitW: 10000, marginW: 300, releaseHysteresisW: 500 }
});

export function makeTelemetryState({
  soc = 50, socAgeMs = 1000, loadW = 3000, loadAgeMs = 1000, pvW = 0, pvAgeMs = 1000,
  importW = 0, exportW = 0, meterOk = true, meterAgeMs = 1000, batteryPowerW = 0,
  maxDischargeW, maxDischargeAgeMs
} = {}) {
  const now = Date.now();
  const fieldUpdatedAt = {};
  if (socAgeMs != null) fieldUpdatedAt.soc = now - socAgeMs;
  if (loadAgeMs != null) fieldUpdatedAt.selfConsumptionW = now - loadAgeMs;
  // PV-Punkte des Victron-Profils (ac_dc): DC-PV + AC-PV L1–L3 werden je Takt gepollt.
  if (pvAgeMs != null) for (const f of ['pvPowerW', 'acPvL1W', 'acPvL2W', 'acPvL3W']) fieldUpdatedAt[f] = now - pvAgeMs;
  if (maxDischargeAgeMs != null) fieldUpdatedAt.maxDischargeW = now - maxDischargeAgeMs;
  return {
    victron: {
      soc,
      selfConsumptionW: loadW,
      pvPowerW: pvW,
      acPvL1W: 0,
      acPvL2W: 0,
      acPvL3W: 0,
      pvTotalW: pvW,
      gridImportW: importW,
      gridExportW: exportW,
      batteryPowerW,
      batteryChargeW: Math.max(0, batteryPowerW),
      batteryDischargeW: Math.max(0, -batteryPowerW),
      ...(maxDischargeW !== undefined ? { maxDischargeW } : {}),
      fieldUpdatedAt
    },
    meter: { ok: meterOk, updatedAt: now - meterAgeMs, grid_total_w: importW - exportW },
    schedule: {
      rules: [], active: {}, lastWrite: {}, manualOverride: {},
      config: { defaultGridSetpointW: null, defaultChargeCurrentA: null, defaultFeedExcessDcPv: 1 },
      lastEvalAt: 0
    },
    ctrl: { negativePriceActive: false, forcedOff: false }
  };
}

/**
 * Modbus-Attrappe mit Registerspeicher wie ein GX: Writes landen im Speicher,
 * Reads liefern ihn zurück. Ein nie belegtes Register antwortet nicht (wirft) —
 * so ist „Rücklesewert unbekannt“ der Normalfall, bis ein Test ihn setzt.
 */
export function makeModbusTransport(registers = {}) {
  return {
    type: 'modbus',
    writes: [],
    reads: [],
    registers: { ...registers },
    async mbRequest({ address, quantity = 1, fc }) {
      this.reads.push({ fc, address, quantity });
      const out = [];
      for (let i = 0; i < quantity; i += 1) {
        const v = this.registers[Number(address) + i];
        if (v === undefined) throw new Error(`no response for register ${Number(address) + i}`);
        out.push(v);
      }
      return out;
    },
    async mbWriteSingle({ address, value }) { this.writes.push({ fc: 6, address, value }); this.registers[address] = value; },
    async mbWriteMultiple({ address, values }) {
      this.writes.push({ fc: 16, address, values });
      values.forEach((v, i) => { this.registers[address + i] = v; });
    }
  };
}

const int32 = ([hi, lo]) => {
  const b = Buffer.alloc(4);
  b.writeUInt16BE(hi, 0);
  b.writeUInt16BE(lo, 2);
  return b.readInt32BE(0);
};

/** Alle geschriebenen Netz-Sollwerte (W), dekodiert aus den 2716-Rohwörtern. */
export function gridSetpointWrites(transport) {
  return transport.writes.filter((w) => w.address === 2716).map((w) => int32(w.values));
}

/** Alle geschriebenen Entladegrenzen (W) auf 2704 (scale 10, 0 unskaliert, 32767 = unbegrenzt). */
export function maxDischargeWrites(transport) {
  return transport.writes.filter((w) => w.address === 2704).map((w) => {
    const raw = w.value > 0x7fff ? w.value - 0x10000 : w.value;
    if (raw === 32767) return -1;
    return raw * 10;
  });
}

export function makeEvaluator({ cfg, state, transport = makeModbusTransport(), price = { ct_kwh: 12 }, extraCtx = {} } = {}) {
  const logs = [];
  const evaluator = createScheduleEvaluator({
    state,
    getCfg: () => cfg,
    transport,
    pushLog: (event, payload) => logs.push({ event, payload: payload || {} }),
    telemetrySafeWrite: () => {},
    persistConfig: async () => {},
    telemetryStore: null,
    epexNowNext: () => (price ? { current: price, next: null } : null),
    regenerateSmallMarketAutomationRules: async () => {},
    onEvalComplete: () => {},
    ...extraCtx
  });
  return { evaluator, logs, transport, state, cfg };
}
