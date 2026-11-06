// test/grid-connection-config.test.js — Einstellung „Netzanschluss maximal (kW)“
// unter Netz & Recht: stabil (kein Beta), ab Werk leer = aus, mit Sicherheits-
// abstand, Phasengrenze, Rückschalt-Abstand, Grundlast und Reihenfolge.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDefaultConfig, getConfigDefinition, loadConfigFile, saveConfigFile } from '../config-model.js';
import { betaFeatureForPath } from '../beta-features.js';
import { resolveGridConnection, GRID_CONNECTION_DEFAULTS } from '../services/grid-connection/index.js';

test('ab Werk: Netzanschluss leer = aus', () => {
  const d = createDefaultConfig();
  assert.deepEqual(d.gridConnection, { ...GRID_CONNECTION_DEFAULTS });
  assert.equal(d.gridConnection.limitKw, null);
  assert.equal(resolveGridConnection(d).active, false);
});

test('Einstellungsfelder: eigene Gruppe in „Netz & Recht“, NICHT beta, nicht unter „Erweitert“', () => {
  const def = getConfigDefinition();
  const fields = def.fields.filter((f) => String(f.path || '').startsWith('gridConnection.'));
  const byPath = Object.fromEntries(fields.map((f) => [f.path, f]));
  assert.deepEqual(Object.keys(byPath).sort(), [
    'gridConnection.baseLoadW', 'gridConnection.batteryPhases', 'gridConnection.limitKw', 'gridConnection.marginW',
    'gridConnection.order', 'gridConnection.phaseLimitA', 'gridConnection.releaseHysteresisW'
  ]);
  for (const f of fields) {
    assert.notEqual(f.beta, true, f.path);
    assert.equal(betaFeatureForPath(f.path), null, `${f.path}: kein Beta-Pfad`);
    assert.equal(f.group, 'gridConnection', f.path);
    assert.ok(typeof f.label === 'string' && f.label.length > 3, f.path);
    assert.ok(typeof f.help === 'string' && f.help.length > 20, f.path);
  }
  assert.equal(byPath['gridConnection.limitKw'].label, 'Netzanschluss maximal (kW)');
  assert.equal(byPath['gridConnection.limitKw'].type, 'number');
  assert.equal(byPath['gridConnection.limitKw'].empty, 'null');
  assert.equal(byPath['gridConnection.order'].type, 'select');
  const area = def.areas.find((a) => a.id === 'grid');
  assert.ok(area.groups.includes('gridConnection'), 'sichtbar, nicht nur unter Erweitert');
  assert.equal(area.advanced.includes('gridConnection'), false);
});

test('Speichern und Laden: 29 kW bleiben 29 kW (Christins Prod)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-gc-'));
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, JSON.stringify({ manufacturer: 'victron', victron: { host: '192.0.2.10' } }));
  const loaded = loadConfigFile(p);
  const next = { ...loaded.rawConfig, gridConnection: { ...loaded.rawConfig.gridConnection, limitKw: 29, phaseLimitA: 50 } };
  saveConfigFile(p, next);
  const again = loadConfigFile(p);
  assert.equal(again.effectiveConfig.gridConnection.limitKw, 29);
  assert.equal(again.effectiveConfig.gridConnection.phaseLimitA, 50);
  assert.equal(resolveGridConnection(again.effectiveConfig).targetW, 28000);
});
