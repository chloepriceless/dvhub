// test/dvcontrol-operator-settings.test.js
//
// Christin, 29.07.2026 — zwei Symptome, eine Ursache:
//   1. „Ich sehe nicht, wie ich die Abregelung von -40 auf -100 W setze."
//   2. „Der Schalter für die DV-Steuerung lässt sich nicht einschalten."
//
// Ursache: `dvControl` stand komplett in MANUFACTURER_MANAGED_PATHS. Der ganze
// Teilbaum wurde beim Laden aus config.json GELÖSCHT und danach durch den
// Profil-Block ERSETZT. Damit waren die beiden Betreiber-Entscheidungen darin
// (`enabled` und der Puffer des Negativpreis-Schutzes) unerreichbar: Speichern
// blieb wirkungslos, und das im Profil stehende `gridSetpointW: -40` gewann in
// schedule-eval.js gegen den eingestellten Default Grid Setpoint.
//
// Diese Tests halten die Trennlinie fest: Register-Verdrahtung gehört dem
// Herstellerprofil, die beiden Schalter/Werte dem Betreiber.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { loadConfigFile } from '../config-model.js';

const PROFILE = {
  victron: { transport: 'modbus', port: 502, unitId: 100, timeoutMs: 1000 },
  dvControl: {
    enabled: true,
    feedExcessDcPv: { enabled: true, fc: 6, address: 2707, writeType: 'uint16', signed: false, scale: 1, offset: 0 },
    dontFeedExcessAcPv: { enabled: true, fc: 6, address: 2708, writeType: 'uint16', signed: false, scale: 1, offset: 0 },
    negativePriceProtection: { enabled: true }
  }
};

function loadWith(persisted, profile = PROFILE) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-dvcontrol-'));
  const configPath = path.join(rootDir, 'config.json');
  fs.mkdirSync(path.join(rootDir, 'hersteller'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'hersteller', 'victron.json'), JSON.stringify(profile, null, 2));
  fs.writeFileSync(configPath, JSON.stringify({ manufacturer: 'victron', ...persisted }, null, 2));
  return loadConfigFile(configPath);
}

test('DV-Schalter: ein gespeichertes AUS überlebt die Profil-Anwendung', () => {
  const loaded = loadWith({ dvControl: { enabled: false } });
  assert.equal(loaded.effectiveConfig.dvControl.enabled, false);
  assert.equal(loaded.persistedConfig.dvControl.enabled, false, 'und bleibt in config.json stehen (wird nicht gestrippt)');
});

test('DV-Schalter: ohne gespeicherten Wert gilt weiter der Profil-Default', () => {
  const loaded = loadWith({});
  assert.equal(loaded.effectiveConfig.dvControl.enabled, true);
});

test('Negativpreis-Puffer: ein gespeicherter Wert schlägt den Profil-Wert', () => {
  const profile = JSON.parse(JSON.stringify(PROFILE));
  profile.dvControl.negativePriceProtection.gridSetpointW = -40;
  const loaded = loadWith({
    dvControl: { negativePriceProtection: { gridSetpointW: -100 } }
  }, profile);
  assert.equal(loaded.effectiveConfig.dvControl.negativePriceProtection.gridSetpointW, -100);
  assert.equal(loaded.effectiveConfig.dvControl.negativePriceProtection.enabled, true,
    'nicht gesetzte Nachbarfelder kommen weiter aus dem Profil');
});

test('Register-Verdrahtung bleibt dem Herstellerprofil vorbehalten', () => {
  const loaded = loadWith({
    dvControl: {
      enabled: true,
      feedExcessDcPv: { address: 9999, fc: 16 },
      dontFeedExcessAcPv: { address: 9998 }
    }
  });
  assert.equal(loaded.effectiveConfig.dvControl.feedExcessDcPv.address, 2707);
  assert.equal(loaded.effectiveConfig.dvControl.feedExcessDcPv.fc, 6);
  assert.equal(loaded.effectiveConfig.dvControl.dontFeedExcessAcPv.address, 2708);
  assert.equal(loaded.rawConfig.dvControl?.feedExcessDcPv, undefined,
    'und wird weiterhin aus dem gespeicherten Stand entfernt');
  assert.ok(
    loaded.warnings.some((w) => String(w).includes('dvControl.feedExcessDcPv')),
    'mit Hinweis, dass der Eintrag ignoriert wurde'
  );
});

// Der eigentliche Auslöser: solange ein ausgeliefertes Profil den Schlüssel
// setzt, greift in schedule-eval.js `npp.gridSetpointW ?? defaultGridSetpointW`
// niemals auf den eingestellten Default zurück.
test('Kein ausgeliefertes Herstellerprofil nagelt gridSetpointW mehr fest', () => {
  const dir = fileURLToPath(new URL('../hersteller/', import.meta.url));
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const profile = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const pinned = profile?.dvControl?.negativePriceProtection?.gridSetpointW;
    assert.equal(pinned, undefined, `${file} setzt gridSetpointW (${pinned}) und übersteuert den Default Grid Setpoint`);
  }
});

// Anzeige-Hälfte desselben Befunds: der Schalter stand auf AUS, obwohl die
// Funktion lief — die GUI zeigte '' (=unchecked) statt des wirksamen Werts.
test('Settings-GUI zeigt bei Schaltern ohne gespeicherten Wert den wirksamen Zustand', () => {
  const source = fs.readFileSync(fileURLToPath(new URL('../public/settings.js', import.meta.url)), 'utf8');
  const stub = () => {};
  const sandbox = {
    console,
    window: { DVhubCommon: { escapeHtml: (v) => String(v ?? '') }, addEventListener: stub, setTimeout: stub },
    document: { getElementById: () => null, createElement: () => ({ appendChild: stub, setAttribute: stub, style: {}, classList: { add: stub, remove: stub } }), addEventListener: stub },
    setTimeout: stub,
    location: {},
    localStorage: { getItem: () => null, setItem: stub }
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  try { vm.runInContext(source, sandbox); } catch { /* Bootstrap braucht einen Browser; die Funktionen stehen trotzdem */ }

  const render = sandbox.renderFieldValueFromConfigs;
  assert.equal(typeof render, 'function');
  const field = { path: 'dvControl.enabled', type: 'boolean' };

  const on = render(field, { draftConfig: {}, effectiveConfig: { dvControl: { enabled: true } } });
  assert.equal(on.value, true, 'wirksam AN ⇒ Haken gesetzt');
  assert.equal(on.inherited, null);
  const off = render(field, { draftConfig: {}, effectiveConfig: { dvControl: { enabled: false } } });
  assert.equal(off.value, false, 'wirksam AUS ⇒ kein Haken');
  assert.equal(
    render(field, { draftConfig: { dvControl: { enabled: false } }, effectiveConfig: { dvControl: { enabled: true } } }).value,
    false,
    'ein gespeicherter Wert schlägt den wirksamen'
  );
});
