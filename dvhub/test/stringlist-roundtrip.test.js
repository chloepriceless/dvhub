// test/stringlist-roundtrip.test.js — Adress-/Namenslisten überleben das Speichern
//
// Gefunden beim Prod-Test am 29.07.2026, BEVOR jemand die Felder benutzt hat:
// die neuen Listenfelder (allowedHosts, security.lanCidrs, corsAllowedOrigins,
// modbusAllowedClients, …) kamen als Array in die GUI, wurden serverseitig aber
// vom String()-Fallback in sanitizeRawConfig zu "a,b" plattgemacht.
//
// Warum das gefährlich ist und nicht bloß unschön: JEDE auswertende Stelle
// fragt `Array.isArray(...)` und behandelt „kein Array" wie „Liste leer" —
// und „Liste leer" heißt überall ALLES ERLAUBT:
//   • isHostAllowed()          → list.length === 0 ⇒ jeder Host akzeptiert
//   • resolveCorsAllowedOrigin → leer ⇒ (hier zwar restriktiv, aber inkonsistent)
//   • isAllowedModbusClient()  → leer ⇒ Rückfall auf „RFC1918 erlaubt"
//   • isLocalNetworkRequest()  → leere lanCidrs ⇒ Standard-Privatnetze
// Eine gespeicherte Zugangsbeschränkung wäre also still zur offenen Tür
// geworden — der schlimmste Fehlermodus, weil die GUI weiter die Liste anzeigt.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { saveConfigFile, loadConfigFile, getConfigDefinition } from '../config-model.js';

function freshBox() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-stringlist-'));
  fs.cpSync(new URL('../hersteller/', import.meta.url), path.join(rootDir, 'hersteller'), { recursive: true });
  const configPath = path.join(rootDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ manufacturer: 'victron', victron: { host: '10.0.0.5' } }));
  return configPath;
}

function saveAndReload(configPath, mutate) {
  const next = JSON.parse(JSON.stringify(loadConfigFile(configPath).persistedConfig));
  mutate(next);
  saveConfigFile(configPath, next);
  return loadConfigFile(configPath).effectiveConfig;
}

test('Listen bleiben nach dem Speichern Listen', () => {
  const configPath = freshBox();
  const eff = saveAndReload(configPath, (c) => {
    c.allowedHosts = ['dvhub.local', '192.168.20.66'];
    c.security.lanCidrs = ['192.168.20.0/24', '10.0.5.0/24'];
    c.security.trustedClientIps = ['192.168.20.31'];
    c.trustedProxyIps = ['192.168.20.1'];
    c.modbusAllowedClients = ['192.168.20.31'];
  });
  assert.deepEqual(eff.allowedHosts, ['dvhub.local', '192.168.20.66']);
  assert.deepEqual(eff.security.lanCidrs, ['192.168.20.0/24', '10.0.5.0/24']);
  assert.deepEqual(eff.security.trustedClientIps, ['192.168.20.31']);
  assert.deepEqual(eff.trustedProxyIps, ['192.168.20.1']);
  assert.deepEqual(eff.modbusAllowedClients, ['192.168.20.31']);
});

test('eine geleerte Liste ist die LEERE LISTE, nicht der leere Text', () => {
  const configPath = freshBox();
  const eff = saveAndReload(configPath, (c) => {
    c.allowedHosts = [];
    c.modbusAllowedClients = [];
  });
  assert.ok(Array.isArray(eff.allowedHosts), 'allowedHosts muss ein Array bleiben');
  assert.equal(eff.allowedHosts.length, 0);
  assert.ok(Array.isArray(eff.modbusAllowedClients));
});

test('Textform wird zerlegt (ein API-Aufruf darf beides schicken)', () => {
  const configPath = freshBox();
  const eff = saveAndReload(configPath, (c) => {
    c.corsAllowedOrigins = 'https://a.local, https://b.local';
    c.allowedHosts = 'dvhub.local;192.168.20.66';
  });
  assert.deepEqual(eff.corsAllowedOrigins, ['https://a.local', 'https://b.local']);
  assert.deepEqual(eff.allowedHosts, ['dvhub.local', '192.168.20.66']);
});

test('Leerraum und Leereinträge fliegen raus', () => {
  const configPath = freshBox();
  const eff = saveAndReload(configPath, (c) => {
    c.allowedHosts = ['  dvhub.local  ', '', '   ', 'zweite.local'];
  });
  assert.deepEqual(eff.allowedHosts, ['dvhub.local', 'zweite.local']);
});

// Wächter: ein künftiges Listenfeld darf nicht wieder im String-Fallback landen.
test('jedes stringList-Feld überlebt einen Speicher-Rundlauf', () => {
  const listFields = getConfigDefinition().fields.filter((f) => f.path && f.type === 'stringList');
  assert.ok(listFields.length >= 6, 'es gibt überhaupt Listenfelder');
  const configPath = freshBox();
  const setPath = (obj, p, v) => {
    const parts = p.split('.');
    let node = obj;
    for (const part of parts.slice(0, -1)) {
      if (!node[part] || typeof node[part] !== 'object') node[part] = {};
      node = node[part];
    }
    node[parts[parts.length - 1]] = v;
  };
  const getPath = (obj, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), obj);

  const eff = saveAndReload(configPath, (c) => {
    for (const f of listFields) setPath(c, f.path, ['probe-eins', 'probe-zwei']);
  });
  for (const f of listFields) {
    const value = getPath(eff, f.path);
    assert.ok(Array.isArray(value), `${f.path}: nach dem Speichern kein Array mehr (${JSON.stringify(value)})`);
    assert.deepEqual(value, ['probe-eins', 'probe-zwei'], `${f.path}: Inhalt verändert`);
  }
});
