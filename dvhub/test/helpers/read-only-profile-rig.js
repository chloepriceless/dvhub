// Prüfstand für mitgelieferte Nur-Lese-Herstellerprofile (`"readOnly": true` in hersteller/<id>.json).
// Echter Ladeweg (loadConfigFile) wie auf einer Box: das Profil liegt neben der mitgelieferten victron.json.
// Echter Evaluator (createScheduleEvaluator) für alle Schreibwege, echtes Hersteller-Dropdown (Beta-Gate).
// Das Dekodieren läuft über createRegisterDevice/createPollerRig (fake-modbus-device.js). Kein Netzwerk.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfigFile } from '../../config-model.js';
import { createScheduleEvaluator } from '../../schedule-eval.js';
import { listManufacturerProfiles } from '../../routes-api.js';

const HERSTELLER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'hersteller');

// Anlagenadresse aus TEST-NET-1 (RFC 5737): nie ein echtes Gerät.
export const TEST_HOST = '192.0.2.71';

export function readShippedProfile(id) {
  return JSON.parse(fs.readFileSync(path.join(HERSTELLER, `${id}.json`), 'utf8'));
}

// config.json mit `manufacturer: id`. Der Betreiber hat „Aktive Anlagensteuerung“ und den Negativpreis-Schutz an —
// das Lese-Profil darf trotzdem nichts tun. `editProfile` ändert eine Kopie (nur für Gegenproben).
export function setupProfile(id, { config = {}, editProfile = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dvhub-${id}-`));
  fs.mkdirSync(path.join(dir, 'hersteller'));
  const profile = readShippedProfile(id);
  if (editProfile) editProfile(profile);
  fs.writeFileSync(path.join(dir, 'hersteller', `${id}.json`), JSON.stringify(profile, null, 2));
  fs.copyFileSync(path.join(HERSTELLER, 'victron.json'), path.join(dir, 'hersteller', 'victron.json'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    manufacturer: id,
    gridPositiveMeans: 'grid_import',
    victron: { host: TEST_HOST },
    dvControl: { enabled: true, negativePriceProtection: { enabled: true } },
    ...config
  }));
  return configPath;
}

export function loadProfile(id, opts) {
  return loadConfigFile(setupProfile(id, opts));
}

// Alle eingeschalteten Schreibziele und Abregel-Flags der wirksamen Config.
export function writeTargets(cfg) {
  const out = [];
  for (const [k, v] of Object.entries(cfg.controlWrite || {})) if (v?.enabled) out.push(`controlWrite.${k}`);
  for (const k of ['feedExcessDcPv', 'dontFeedExcessAcPv', 'zeroFeedIn']) {
    if (cfg.dvControl?.[k] !== undefined) out.push(`dvControl.${k}`);
  }
  return out;
}

// Treibt jeden Schreibweg des echten Evaluators: Sollwerte (Netz-Sollwert als Einspeisung, damit die Netzladesperre
// ihn nicht vorher abweist), Abregelung, Negativpreis, zwei Zeitplan-Takte. Der Transport liest überall 0 und zählt
// jeden Write — ein Lesefehler darf einen Write nicht verdecken.
export async function evaluatorWrites(cfg) {
  const state = {
    victron: { soc: 63 },
    meter: { ok: true, grid_total_w: -3000, updatedAt: Date.now() },
    ctrl: {},
    schedule: { rules: [], active: {}, lastWrite: {}, manualOverride: {}, config: {}, lastEvalAt: 0 },
  };
  const writes = [];
  const transport = {
    type: 'modbus',
    async mbRequest({ quantity = 1 }) { return Array.from({ length: quantity }, () => 0); },
    async mbWriteSingle({ address, value }) { writes.push([address, value]); },
    async mbWriteMultiple({ address, values }) { writes.push([address, values]); },
  };
  const ev = createScheduleEvaluator({
    state, getCfg: () => cfg, transport,
    pushLog: () => {}, telemetrySafeWrite: () => {}, persistConfig: async () => {},
    epexNowNext: () => ({ current: { ct_kwh: -5 } }),
    regenerateSmallMarketAutomationRules: async () => {},
  });
  await ev.applyControlTarget('gridSetpointW', -500, 'eos_optimization');
  await ev.applyControlTarget('gridSetpointW', -800, 'api');
  await ev.applyControlTarget('maxDischargeW', 0, 'eos_optimization');
  await ev.applyControlTarget('minSocPct', 20, 'eos_optimization');
  await ev.applyControlTarget('chargeCurrentA', 10, 'api');
  await ev.applyControlTarget('feedExcessDcPv', 0, 'negative_price_protection');
  await ev.applyDvVictronControl(false, { reason: 'negative_price_protection' });
  await ev.evaluateSchedule();
  await ev.evaluateSchedule();
  return writes;
}

// Gegenprobe zum Draht-Test: dasselbe Profil OHNE readOnly und mit je einem Schreibziel — der Prüfstand muss die
// Writes sehen, sonst bewiese „kein Write“ nichts.
export function writableVariant(profile) {
  delete profile.readOnly;
  profile.controlWrite = { gridSetpointW: { enabled: true, fc: 16, address: 1111, writeType: 'int16', scale: 1, offset: 0 } };
  profile.dvControl = { enabled: true, feedExcessDcPv: { enabled: true, fc: 16, address: 40010, writeType: 'uint16' } };
}

// Hersteller-Dropdown wie die Einstellungsseite es bekommt.
export function dropdown(configPath, updateChannel, manufacturer = 'victron') {
  return listManufacturerProfiles({
    getConfigPath: () => configPath,
    getRawCfg: () => ({ updateChannel, manufacturer }),
  });
}

// Gelesene Register als sortierte, eindeutige Liste „fc:unit:adresse×menge“.
export function readSet(requests) {
  return [...new Set(requests.map((r) => `${r.fc}:${r.unitId}:${r.address}x${r.quantity}`))].sort();
}
