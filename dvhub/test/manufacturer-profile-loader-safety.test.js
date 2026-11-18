// Profil-Loader ohne Victron-Rückfall (E1/E2, Bericht 2026-11-18-hersteller-lesend-luecken.md §2 S1–S3):
//   E1 — die gültigen `manufacturer`-Werte sind die Profile in hersteller/. Ein vorhandenes Profil lädt als es
//        selbst; eine ID ohne Datei endet in „Profil fehlt" (writeSafety gesperrt), nie still als victron.
// Echter Ladeweg (loadConfigFile) gegen ein temporäres Verzeichnis; der Evaluator-Teil zählt echte Draht-Writes.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfigFile, saveConfigFile } from '../config-model.js';
import { listManufacturerProfiles } from '../routes-api.js';
import { createScheduleEvaluator } from '../schedule-eval.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHIPPED_VICTRON = fs.readFileSync(path.join(HERE, '..', 'hersteller', 'victron.json'), 'utf8');

// Wie auf einer echten Box liegt die mitgelieferte victron.json immer daneben — genau dann wurde eine unbekannte
// ID früher still zum Victron-Profil (S1). `profiles` kann sie überschreiben.
function setup({ manufacturer, profiles = {}, config = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-loader-safety-'));
  fs.mkdirSync(path.join(dir, 'hersteller'));
  for (const [id, content] of Object.entries({ victron: SHIPPED_VICTRON, ...profiles })) {
    const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    fs.writeFileSync(path.join(dir, 'hersteller', `${id}.json`), text);
  }
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ manufacturer, victron: { host: '192.0.2.40' }, ...config }, null, 2));
  return { dir, configPath };
}

// Kleines Lese-Profil eines fremden Modbus-Geräts — nur meter/points.
const READ_PROFILE = {
  label: 'Testgerät nur lesend',
  victron: { transport: 'modbus', port: 1502, unitId: 7, timeoutMs: 1500 },
  meter: { fc: 3, address: 30000, quantity: 3, timeoutMs: 1200 },
  points: {
    soc: { enabled: true, fc: 3, address: 31000, quantity: 1, signed: false, scale: 1, offset: 0 },
    batteryPowerW: { enabled: true, fc: 3, address: 31001, quantity: 1, signed: true, scale: 1, offset: 0 },
  },
};

// --- E1: ID = Profildatei ---------------------------------------------------------------------------------

test('E1: eine unbekannte, aber vorhandene Profil-ID lädt als sie selbst (kein Rückfall auf victron)', () => {
  const { configPath } = setup({
    manufacturer: 'acme-hybrid',
    profiles: { 'acme-hybrid': { ...READ_PROFILE, controlWrite: {}, dvControl: { enabled: false } } },
  });
  const loaded = loadConfigFile(configPath);
  assert.equal(loaded.persistedConfig.manufacturer, 'acme-hybrid');
  assert.equal(loaded.valid, true);
  assert.equal(loaded.manufacturerProfileError, null);
  assert.equal(loaded.effectiveConfig.writeSafety, undefined);
  assert.ok(loaded.manufacturerProfilePath.endsWith(path.join('hersteller', 'acme-hybrid.json')));
  assert.equal(loaded.effectiveConfig.meter.address, 30000, 'Zähler aus dem eigenen Profil, nicht Victron 820');
  assert.equal(loaded.effectiveConfig.meter.unitId, 7);
  assert.ok(!loaded.warnings.some((w) => /^manufacturer:/.test(w)), `keine manufacturer-Warnung: ${loaded.warnings}`);
});

test('E1: Speichern behält eine vorhandene Profil-ID in config.json (wird nicht auf victron zurückgesetzt)', () => {
  const { configPath } = setup({ manufacturer: 'victron', profiles: { 'acme-hybrid': READ_PROFILE } });
  const saved = saveConfigFile(configPath, { manufacturer: 'acme-hybrid', victron: { host: '192.0.2.40' } });
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).manufacturer, 'acme-hybrid');
  assert.equal(saved.persistedConfig.manufacturer, 'acme-hybrid');
  assert.equal(saved.valid, true);
});

test('E1: ID ohne Profildatei → Zustand „Profil fehlt": writeSafety.ok=false, ID bleibt stehen', () => {
  const { configPath } = setup({ manufacturer: 'acme-missing' });
  const loaded = loadConfigFile(configPath);
  const cfg = loaded.effectiveConfig;
  assert.equal(loaded.persistedConfig.manufacturer, 'acme-missing', 'bleibt die gewählte ID, nicht victron');
  assert.equal(loaded.valid, false);
  assert.deepEqual(cfg.writeSafety, { ok: false, reason: 'manufacturer_profile_error', manufacturer: 'acme-missing' });
});

test('E1: eine ID mit Pfadtrenner lädt keine Datei außerhalb von hersteller/ und sperrt die Writes', () => {
  // hersteller/../outside.json = <dir>/outside.json — läge der Loader dort, wäre es ein gültiges Profil.
  const { dir, configPath } = setup({ manufacturer: '../outside' });
  fs.writeFileSync(path.join(dir, 'outside.json'), JSON.stringify(READ_PROFILE));
  const loaded = loadConfigFile(configPath);
  assert.equal(loaded.valid, false);
  assert.equal(loaded.manufacturerProfile, null);
  assert.equal(loaded.manufacturerProfilePath, null);
  assert.equal(loaded.effectiveConfig.writeSafety.ok, false);
  assert.ok(loaded.warnings.some((w) => /^manufacturer: not a valid profile id/.test(w)));
});

test('E1: Groß-/Leerzeichen in der ID werden normalisiert (" Fronius " lädt fronius.json)', () => {
  const fronius = fs.readFileSync(path.join(HERE, '..', 'hersteller', 'fronius.json'), 'utf8');
  const { configPath } = setup({ manufacturer: ' Fronius ', profiles: { fronius } });
  const loaded = loadConfigFile(configPath);
  assert.equal(loaded.persistedConfig.manufacturer, 'fronius');
  assert.equal(loaded.valid, true);
});

test('E1: das Auswahlfeld bietet nur IDs an, die der Loader lädt', () => {
  const { dir, configPath } = setup({ manufacturer: 'victron', profiles: { 'acme-hybrid': READ_PROFILE } });
  fs.writeFileSync(path.join(dir, 'hersteller', 'Foo Bar.json'), JSON.stringify(READ_PROFILE));
  fs.writeFileSync(path.join(dir, 'hersteller', 'UPPER.json'), JSON.stringify(READ_PROFILE));
  const ids = listManufacturerProfiles({ getConfigPath: () => configPath, getRawCfg: () => ({ manufacturer: 'victron' }) })
    .map((o) => o.value).sort();
  assert.deepEqual(ids, ['acme-hybrid', 'victron']);
});

// --- Draht: der echte Evaluator schreibt mit diesen Configs keinen einzigen Modbus-Write -------------------

function bootEvaluator(cfg) {
  const state = {
    victron: { soc: 50 },
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
    // Negativer Preis: der §51-/Negativpreis-Pfad will abregeln.
    epexNowNext: () => ({ current: { ct_kwh: -5 } }),
    regenerateSmallMarketAutomationRules: async () => {},
  });
  return { ev, writes };
}

async function driveAllWritePaths(ev) {
  await ev.applyControlTarget('gridSetpointW', 500, 'eos_optimization');
  await ev.applyControlTarget('maxDischargeW', 0, 'eos_optimization');
  await ev.applyControlTarget('minSocPct', 20, 'eos_optimization');
  await ev.applyControlTarget('feedExcessDcPv', 0, 'negative_price_protection');
  await ev.applyDvVictronControl(false, { reason: 'negative_price_protection' });
  await ev.evaluateSchedule();
  await ev.evaluateSchedule();
}

test('Draht: ID ohne Profildatei → kein einziger Modbus-Write', async () => {
  const { configPath } = setup({ manufacturer: 'acme-missing' });
  const { ev, writes } = bootEvaluator(loadConfigFile(configPath).effectiveConfig);
  await driveAllWritePaths(ev);
  assert.deepEqual(writes, []);
});
