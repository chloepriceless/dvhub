// Prüfstand für die mitgelieferten Nur-Lese-Herstellerprofile (`"readOnly": true`): dieselben Bausteine wie in den
// Deye-Tests (deye-hp3/deye-lp1-profile.test.js), hier einmal für die Profile E3/DC, Solis, SOFAR und FoxESS.
//   setupProfile   echtes hersteller/<id>.json neben der mitgelieferten victron.json, config.json wie auf einer Box
//                  (Betreiber hat „Aktive Anlagensteuerung“ und Negativpreis-Schutz an)
//   writeTargets   alle Schreib- und Abregel-Ziele der effektiven Config
//   wireWrites     jeder Schreibweg des echten Evaluators gegen einen Transport, der jeden Write zählt
//   pollProfile    ein Takt des echten Pollers gegen ein Schein-Gerät (fake-modbus-device.js)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createScheduleEvaluator } from '../../schedule-eval.js';
import { createPollerRig } from './fake-modbus-device.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const HERSTELLER_DIR = path.join(HERE, '..', '..', 'hersteller');

export function shippedProfile(id) {
  return JSON.parse(fs.readFileSync(path.join(HERSTELLER_DIR, `${id}.json`), 'utf8'));
}

// Wie auf einer Box: das Profil liegt neben der mitgelieferten victron.json. `editProfile` ändert eine Kopie (nur für
// die Gegenprobe im Draht-Test und für Mutationsproben).
export function setupProfile(id, { config = {}, editProfile = null, host = '192.0.2.71' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dvhub-${id}-`));
  fs.mkdirSync(path.join(dir, 'hersteller'));
  const profile = shippedProfile(id);
  if (editProfile) editProfile(profile);
  fs.writeFileSync(path.join(dir, 'hersteller', `${id}.json`), JSON.stringify(profile, null, 2));
  fs.copyFileSync(path.join(HERSTELLER_DIR, 'victron.json'), path.join(dir, 'hersteller', 'victron.json'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    manufacturer: id,
    gridPositiveMeans: 'grid_import',
    victron: { host },
    dvControl: { enabled: true, negativePriceProtection: { enabled: true } },
    ...config
  }));
  return configPath;
}

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
export async function wireWrites(cfg) {
  const state = {
    victron: { soc: 55 },
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

// Profil-Kopie ohne readOnly und mit je einem Schreib- und Abregel-Ziel — die Gegenprobe zeigt, dass der Prüfstand
// Writes überhaupt sieht.
export function withWriteTargets(profile) {
  delete profile.readOnly;
  profile.controlWrite = { gridSetpointW: { enabled: true, fc: 16, address: 1111, writeType: 'int16', scale: 1, offset: 0 } };
  profile.dvControl = { enabled: true, feedExcessDcPv: { enabled: true, fc: 16, address: 40010, writeType: 'uint16' } };
}

// Ein Takt des echten Pollers gegen das Schein-Gerät; Lesefehler stehen in state.victron.errors bzw. state.meter.error.
export async function pollProfile(cfg, device) {
  const logs = [];
  const { state, poller } = createPollerRig(cfg, device, { logs });
  await poller.requestPoll();
  return { state, logs };
}

// Gelesene Register (je Startadresse einmal), sortiert — für „liest genau die Profilregister“.
export const readAddresses = (device) => [...new Set(device.requests.map((r) => r.address))].sort((a, b) => a - b);
