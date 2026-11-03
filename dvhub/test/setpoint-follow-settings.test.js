// Entlade-Wächter in den Einstellungen (Christin 02.11.2026).
//
// Bisher stand der Wächter nur unter `victron.setpointWatchdog` — ohne Feld in
// der Oberfläche, und wirkungslos, sobald ein Herstellerprofil aktiv ist (also
// immer): applyManufacturerProfile ersetzt victron.* durch das Profil und reicht
// setpointWatchdog nicht durch. Jetzt: herstellerneutraler Pfad
// `monitoring.setpointWatchdog`, Schalter + Schwellen in den Einstellungen, alte
// Werte wandern beim Laden mit.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDefaultConfig, getConfigDefinition, loadConfigFile, saveConfigFile } from '../config-model.js';
import { resolveSetpointFollowOptions, SETPOINT_FOLLOW_DEFAULTS, setpointFollowHeartbeat } from '../services/setpoint-follow-watchdog.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROFILES = path.join(HERE, '..', 'hersteller');

function rigDir(manufacturer = 'victron') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-waechter-cfg-'));
  fs.mkdirSync(path.join(dir, 'hersteller'));
  fs.copyFileSync(path.join(PROFILES, `${manufacturer}.json`), path.join(dir, 'hersteller', `${manufacturer}.json`));
  return path.join(dir, 'config.json');
}

function loadWith(persisted, manufacturer = 'victron') {
  const configPath = rigDir(manufacturer);
  fs.writeFileSync(configPath, JSON.stringify({ manufacturer, updateChannel: 'dev', ...persisted }, null, 2));
  return { configPath, loaded: loadConfigFile(configPath) };
}

const P = 'monitoring.setpointWatchdog';

test('Einstellungen: Schalter „Entlade-Wächter“ sichtbar bei „Meine Anlage“, Schwellen unter „Erweitert“', () => {
  const def = getConfigDefinition();
  const field = (p) => def.fields.find((f) => f.path === p);
  const toggle = field(`${P}.enabled`);
  assert.ok(toggle, 'Feld für den Schalter fehlt');
  assert.equal(toggle.type, 'boolean');
  assert.equal(toggle.label, 'Entlade-Wächter');
  assert.notEqual(toggle.beta, true, 'für alle Kunden, nicht nur Bleeding-Edge');
  // Hilfetext: was, wann, und dass er nur meldet.
  assert.match(toggle.help, /meldet/i);
  assert.match(toggle.help, /Netz/);
  assert.match(toggle.help, /nichts|greift nicht/i);
  assert.match(toggle.help, /Minuten/);

  const plant = def.areas.find((a) => a.id === 'plant');
  assert.ok(plant.groups.includes(toggle.group), 'Schalter direkt sichtbar unter „Meine Anlage“');

  for (const [key, unit] of [['holdMinutes', 'Minuten'], ['minImportW', 'W'], ['minShortfallW', 'W']]) {
    const f = field(`${P}.${key}`);
    assert.ok(f, `Feld ${key} fehlt`);
    assert.equal(f.type, 'number');
    assert.match(f.label, new RegExp(unit));
    assert.ok(plant.advanced.includes(f.group), `${key} unter „Erweitert“`);
    assert.deepEqual(f.visibleWhenPath, { path: `${P}.enabled`, equals: true });
    assert.ok(f.help && f.help.length > 40, `${key}: Hilfetext`);
  }
  assert.equal(field(`${P}.holdMinutes`).default, SETPOINT_FOLLOW_DEFAULTS.holdMs / 60000);
  assert.equal(field(`${P}.minImportW`).default, SETPOINT_FOLLOW_DEFAULTS.minImportW);
  assert.equal(field(`${P}.minShortfallW`).default, SETPOINT_FOLLOW_DEFAULTS.minShortfallW);
});

test('Standard: Wächter an, Schwellen aus den Wächter-Standards', () => {
  assert.equal(createDefaultConfig().monitoring.setpointWatchdog.enabled, true);
  const opts = resolveSetpointFollowOptions(createDefaultConfig());
  assert.equal(opts.enabled, true);
  assert.equal(opts.holdMs, SETPOINT_FOLLOW_DEFAULTS.holdMs);
  assert.equal(opts.minImportW, SETPOINT_FOLLOW_DEFAULTS.minImportW);
});

test('neuer Pfad: Minuten → holdMs, Schalter AUS wirkt auch mit aktivem Herstellerprofil', () => {
  for (const manufacturer of ['victron', 'fronius', 'deye-lv', 'bridge-mqtt', 'dvhub-mqtt']) {
    const { loaded } = loadWith({ monitoring: { setpointWatchdog: { enabled: false, holdMinutes: 15, minImportW: 400, minShortfallW: 700 } } }, manufacturer);
    const opts = resolveSetpointFollowOptions(loaded.effectiveConfig);
    assert.equal(opts.enabled, false, manufacturer);
    assert.equal(opts.holdMs, 15 * 60000, manufacturer);
    assert.equal(opts.minImportW, 400, manufacturer);
    assert.equal(opts.minShortfallW, 700, manufacturer);
  }
});

test('Bestand: alter Pfad victron.setpointWatchdog wandert beim Laden nach monitoring — nichts geht verloren', () => {
  const { loaded } = loadWith({
    victron: { host: '192.0.2.10', setpointWatchdog: { enabled: false, holdMs: 900000, minImportW: 450, minShortfallW: 800, idleW: 200 } }
  });
  assert.deepEqual(loaded.persistedConfig.monitoring.setpointWatchdog, {
    enabled: false, holdMinutes: 15, minImportW: 450, minShortfallW: 800, idleW: 200
  });
  assert.equal(loaded.rawConfig.victron.setpointWatchdog, undefined, 'alter Pfad aufgeräumt');
  assert.equal(loaded.rawConfig.victron.host, '192.0.2.10');
  // Vorher: das Profil warf victron.setpointWatchdog weg, der Schalter AUS wirkte nie.
  const opts = resolveSetpointFollowOptions(loaded.effectiveConfig);
  assert.equal(opts.enabled, false);
  assert.equal(opts.holdMs, 900000);
  assert.equal(opts.minImportW, 450);
  assert.equal(opts.minShortfallW, 800);
  assert.equal(opts.idleW, 200);
});

test('Bestand: ist der neue Pfad schon gesetzt, gewinnt er; fehlende Schlüssel kommen vom alten', () => {
  const { loaded } = loadWith({
    victron: { setpointWatchdog: { enabled: false, holdMs: 900000, minImportW: 450 } },
    monitoring: { setpointWatchdog: { enabled: true, holdMinutes: 20 } }
  });
  assert.deepEqual(loaded.persistedConfig.monitoring.setpointWatchdog, { enabled: true, holdMinutes: 20, minImportW: 450 });
});

test('Speichern und Laden: Schalter und Schwellen bleiben stehen (Rundreise über config.json)', () => {
  const { configPath, loaded } = loadWith({ victron: { setpointWatchdog: { enabled: false } } });
  // Wie die Oberfläche: den geladenen Rohstand ändern und speichern.
  const next = JSON.parse(JSON.stringify(loaded.rawConfig));
  next.monitoring.setpointWatchdog = { ...next.monitoring.setpointWatchdog, holdMinutes: 12, minShortfallW: 600 };
  const saved = saveConfigFile(configPath, next);
  const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(onDisk.monitoring.setpointWatchdog, { enabled: false, holdMinutes: 12, minShortfallW: 600 });
  assert.equal(onDisk.victron?.setpointWatchdog, undefined);
  const opts = resolveSetpointFollowOptions(saved.effectiveConfig);
  assert.equal(opts.enabled, false);
  assert.equal(opts.holdMs, 12 * 60000);
  assert.equal(opts.minShortfallW, 600);
  // Wieder einschalten.
  next.monitoring.setpointWatchdog.enabled = true;
  assert.equal(resolveSetpointFollowOptions(saveConfigFile(configPath, next).effectiveConfig).enabled, true);
});

test('ungültige Werte fallen auf den Standard zurück (mit Warnung), leere Felder ohne', () => {
  const { loaded } = loadWith({ monitoring: { setpointWatchdog: { holdMinutes: 0.2, minImportW: '', minShortfallW: 'abc' } } });
  const opts = resolveSetpointFollowOptions(loaded.effectiveConfig);
  assert.equal(opts.holdMs, SETPOINT_FOLLOW_DEFAULTS.holdMs);
  assert.equal(opts.minImportW, SETPOINT_FOLLOW_DEFAULTS.minImportW);
  assert.equal(opts.minShortfallW, SETPOINT_FOLLOW_DEFAULTS.minShortfallW);
  assert.ok(loaded.warnings.some((w) => w.startsWith(`${P}.holdMinutes`)));
  assert.ok(loaded.warnings.some((w) => w.startsWith(`${P}.minShortfallW`)));
  assert.ok(!loaded.warnings.some((w) => w.startsWith(`${P}.minImportW`)));
});

test('Rückfall: wer den Wächter direkt mit altem Pfad aufruft, wird weiter bedient', () => {
  assert.equal(resolveSetpointFollowOptions({ victron: { setpointWatchdog: { enabled: false } } }).enabled, false);
  assert.equal(resolveSetpointFollowOptions({ victron: { setpointWatchdog: { holdMs: 300000 } } }).holdMs, 300000);
  // Neuer Pfad schlägt alten, Minuten schlagen Millisekunden.
  const both = resolveSetpointFollowOptions({
    victron: { setpointWatchdog: { enabled: false, holdMs: 300000 } },
    monitoring: { setpointWatchdog: { enabled: true, holdMinutes: 7 } }
  });
  assert.equal(both.enabled, true);
  assert.equal(both.holdMs, 7 * 60000);
});

test('Uptime-Kuma-Puls bleibt während eines Wächter-Alarms auf down (Gegenprüfung d3420a0c)', () => {
  assert.deepEqual(setpointFollowHeartbeat({ victron: { soc: 50, setpointFollow: null } }, 'DVhub OK'), { status: 'up', msg: 'DVhub OK' });
  const hb = setpointFollowHeartbeat({ victron: { soc: 50, setpointFollow: { active: true, since: '2026-11-02T10:00:00.000Z' } } }, 'DVhub OK');
  assert.equal(hb.status, 'down');
  assert.match(hb.msg, /entlädt nicht/);
});

// Gesamtprüfung Release 1.0.9: Einfrier-Wächter und Kreuzprobe melden „down“
// ebenfalls nur einmal — der nächste Puls stellte den Monitor wieder auf „up“.
test('Uptime-Kuma-Puls bleibt auch bei Einfrier- und Kreuzprobe-Alarm auf down', () => {
  const frozen = setpointFollowHeartbeat({ victron: { soc: 50, freeze: { active: true, reasons: ['identical_values'], since: '2026-11-03T10:00:00.000Z' } } }, 'DVhub OK');
  assert.equal(frozen.status, 'down');
  assert.match(frozen.msg, /eingefroren/);
  const mismatch = setpointFollowHeartbeat({ victron: { soc: 50, sourceMismatch: { active: true, since: '2026-11-03T10:00:00.000Z', fields: ['soc'] } } }, 'DVhub OK');
  assert.equal(mismatch.status, 'down');
  assert.match(mismatch.msg, /widersprüchlich/);
  // Der reine Einfrier-Verdacht (Stable-Kanal, kein Alarm) bleibt „up“.
  assert.equal(setpointFollowHeartbeat({ victron: { soc: 50, freezeSuspect: { active: true } } }, 'DVhub OK').status, 'up');
  // Mehrere Alarme: alle in einer Meldung.
  const both = setpointFollowHeartbeat({ victron: { soc: 50, freeze: { active: true }, setpointFollow: { active: true, since: 'x' } } }, 'DVhub OK');
  assert.match(both.msg, /entlädt nicht/);
  assert.match(both.msg, /eingefroren/);
});
