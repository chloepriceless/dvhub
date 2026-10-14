// test/settings-save-roundtrip.test.js — Prüftest „nichts angefasst, nichts
// verändert“ für die Einstellungsseite (2026-10-14).
//
// Eine Konfiguration läuft durch denselben Weg wie im Browser: Antwort von
// GET /api/config laden (loadConfigPayloadState), JEDES Formularfeld so
// befüllen, wie die Seite es zeichnet (createConfigInput mit
// buildFieldRenderModel), dann mit der echten Speicherfunktion auslesen
// (collectConfigFromForm). Was dabei herauskommt, muss — nach der
// Normalisierung des Servers — der Ausgangskonfiguration entsprechen.
//
// So gingen die Befunde des Audits vom 14.10. verloren (PV-Geometrie,
// §14a-Modul-3 eines Preis-Zeitraums): ein Editor, der ein Feld nicht
// zurückschickt. Der Ersatz-Browser unten verhält sich an den Stellen wie
// ein echter, an denen Werte verloren gehen: ein Auswahlfeld mit unbekanntem
// Wert liefert '', ein Zahlenfeld mit Text liefert ''.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { getConfigDefinition, normalizeConfigInput } from '../config-model.js';
import { loadSettingsPage } from './helpers/settings-page.js';

const clone = (v) => JSON.parse(JSON.stringify(v));

/** Laden → alle Felder zeichnen → Speichern auslesen. Liefert die zu speichernde Config. */
function roundTrip(rawConfig) {
  const { context, inputs } = loadSettingsPage();
  const normalized = normalizeConfigInput(clone(rawConfig));
  context.__payload = { config: clone(rawConfig), effectiveConfig: normalized.effectiveConfig, definition: getConfigDefinition(), meta: {} };
  vm.runInContext('loadConfigPayloadState(__payload)', context);
  const hidden = vm.runInContext('HIDDEN_FIELD_PATHS', context);
  for (const field of context.__payload.definition.fields) {
    if (field.type === 'array' || field.type === 'json' || hidden.includes(field.path)) continue;
    const model = context.buildFieldRenderModel(field);
    const input = context.createConfigInput(field, model.value, model.inherited);
    inputs.set(input.id, input);
  }
  return JSON.parse(JSON.stringify(vm.runInContext('collectConfigFromForm()', context)));
}

/** Pfade, an denen sich zwei (normalisierte) Configs unterscheiden. */
function diffPaths(a, b, prefix = '') {
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (isObj(a) && isObj(b)) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((k) => diffPaths(a[k], b[k], prefix ? `${prefix}.${k}` : k));
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [prefix];
}

function assertUnchanged(rawConfig) {
  const before = normalizeConfigInput(clone(rawConfig)).persistedConfig;
  const after = normalizeConfigInput(roundTrip(rawConfig)).persistedConfig;
  assert.deepEqual(diffPaths(before, after), [], 'Speichern ohne Änderung hat diese Pfade verändert');
}

// Eine dicht befüllte Konfiguration: jeder Editor mit allen Feldern, die der
// Server kennt — auch denen ohne eigenes Eingabefeld.
function richConfig() {
  const base = JSON.parse(fs.readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  return {
    ...base,
    schedule: {
      ...base.schedule,
      rules: [{ id: 'm1', enabled: true, target: 'gridSetpointW', start: '10:00', end: '11:00', value: -500, source: 'manual' }],
      defaultGridSetpointW: -100,
    },
    userEnergyPricing: {
      ...(base.userEnergyPricing || {}),
      mode: 'fixed',
      fixedGrossImportCtKwh: 30,
      periods: [{
        id: 'p1', label: '2026', startDate: '2026-01-01', endDate: '2026-12-31', mode: 'fixed', fixedGrossImportCtKwh: 26.9,
        usesParagraph14aModule3: true,
        module3Windows: { window1: { enabled: true, label: 'NT', start: '00:00', end: '06:00', priceCtKwh: 12.3 } },
        costs: { pvCtKwh: 8 },
      }],
      pvPlants: [{ kwp: 9.8, commissionedAt: '2021-04-15', tiltDeg: 30, azimuthDeg: 200, skyObstructionConfig: 'H', shadingConfig: 'S' }],
    },
    optimizer: { ...(base.optimizer || {}), batteryStages: [{ id: 's1', label: 'Start', startDate: '2024-01-01', capacityWh: 10000 }] },
    forecast: {
      ...(base.forecast || {}),
      pv: { ...(base.forecast?.pv || {}), configLevel: 'detailed', strings: [{ label: 'Süd', kwp: 9, tiltDeg: 35, azimuthDeg: 180 }] },
    },
  };
}

describe('Einstellungen speichern ohne Änderung verändert nichts', () => {
  it('config.example.json', () => {
    assertUnchanged(JSON.parse(fs.readFileSync(new URL('../config.example.json', import.meta.url), 'utf8')));
  });

  it('dicht befüllte Konfiguration (alle Editoren, auch Felder ohne Eingabefeld)', () => {
    assertUnchanged(richConfig());
  });

  // Lokal gegen eine echte Konfiguration: DVHUB_ROUNDTRIP_CONFIG=/pfad/config.json
  it('echte Konfiguration (nur mit DVHUB_ROUNDTRIP_CONFIG)', { skip: !process.env.DVHUB_ROUNDTRIP_CONFIG }, () => {
    assertUnchanged(JSON.parse(fs.readFileSync(process.env.DVHUB_ROUNDTRIP_CONFIG, 'utf8')));
  });
});

describe('Felder ohne gespeicherten Wert zeigen den Standard des Codes', () => {
  function shown(pathName, rawConfig = {}) {
    const { context } = loadSettingsPage();
    const normalized = normalizeConfigInput(clone(rawConfig));
    context.__payload = { config: clone(rawConfig), effectiveConfig: normalized.effectiveConfig, definition: getConfigDefinition(), meta: {} };
    vm.runInContext('loadConfigPayloadState(__payload)', context);
    const field = context.__payload.definition.fields.find((f) => f.path === pathName);
    const input = context.createConfigInput(field, ...Object.values((({ value, inherited }) => ({ value, inherited }))(context.buildFieldRenderModel(field))));
    return field.type === 'boolean' ? input.checked : input.value;
  }

  // support-tunnel.js: localUser.enabled !== false (Standard an)
  it('Support-Login-User: an', () => assert.equal(shown('support.localUser.enabled'), true));
  // eos-config-sync.js / eos-forecast-bridge.js: feedInMode || 'fixed'
  it('Einspeisung: fester Tarif', () => assert.equal(shown('optimizer.tariff.feedInMode'), 'fixed'));
  // config-model Standards: engine 'milp'
  it('Börsenautomatik-Rechenweg: MILP', () => assert.equal(shown('schedule.smallMarketAutomation.engine'), 'milp'));
});
