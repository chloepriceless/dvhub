// test/peak-shaving-config.test.js — Peak Shaving (GitHub #28): Einstellungen,
// Beta-Gate und Auflösung der wirksamen Werte.
//
// Vertrag: ab Werk AUS. Ohne Bleeding-Edge-Kanal wirkungslos, auch wenn
// `enabled: true` in der config.json steht. Ohne gültige Grenze oder bei einem
// anderen Hersteller als Victron regelt DVhub nichts — der Grund steht im Status.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createDefaultConfig, getConfigDefinition } from '../config-model.js';
import { BETA_FEATURES, betaFeatureForPath } from '../beta-features.js';
import { resolvePeakShaving, peakShavingStatusText } from '../services/peak-shaving/index.js';

const dev = (peakShaving, extra = {}) => ({ updateChannel: 'dev', manufacturer: 'victron', peakShaving, ...extra });

test('Vorgabe: Peak Shaving ist ab Werk aus und ohne Grenze', () => {
  const d = createDefaultConfig();
  assert.deepEqual(d.peakShaving, {
    enabled: false, gridImportLimitW: null, marginW: 300, releaseHysteresisW: 500, minSocPct: null
  });
  const r = resolvePeakShaving(d);
  assert.equal(r.enabled, false);
  assert.equal(r.active, false);
  assert.equal(r.reason, 'disabled');
});

test('Beta-Gate: als Laufzeit-Feature registriert, Pfad peakShaving', () => {
  assert.equal(BETA_FEATURES.peakShaving?.gate, 'runtime');
  assert.deepEqual(BETA_FEATURES.peakShaving.paths, ['peakShaving']);
  assert.equal(betaFeatureForPath('peakShaving.gridImportLimitW'), 'peakShaving');
});

test('stable-Kanal: enabled:true mit Grenze bleibt wirkungslos', () => {
  const r = resolvePeakShaving({ manufacturer: 'victron', peakShaving: { enabled: true, gridImportLimitW: 30000 } });
  assert.equal(r.enabled, false);
  assert.equal(r.active, false);
  assert.equal(r.reason, 'beta_gate_closed');
});

test('dev-Kanal + Victron + Grenze: aktiv, Ziel = Grenze − Abstand', () => {
  const r = resolvePeakShaving(dev({ enabled: true, gridImportLimitW: 30000, marginW: 500 }));
  assert.equal(r.enabled, true);
  assert.equal(r.active, true);
  assert.equal(r.limitW, 30000);
  assert.equal(r.marginW, 500);
  assert.equal(r.targetW, 29500);
  assert.equal(r.releaseHysteresisW, 500);
  assert.equal(r.reason, null);
});

test('Hersteller fehlt in der Config = Victron (Standard)', () => {
  const r = resolvePeakShaving({ updateChannel: 'dev', peakShaving: { enabled: true, gridImportLimitW: 30000 } });
  assert.equal(r.active, true);
});

test('fehlende/ungültige Grenze: an, aber nicht aktiv (limit_missing)', () => {
  for (const limit of [null, undefined, '', 0, -5, 'abc', 999]) {
    const r = resolvePeakShaving(dev({ enabled: true, gridImportLimitW: limit }));
    assert.equal(r.enabled, true, String(limit));
    assert.equal(r.active, false, String(limit));
    assert.equal(r.reason, 'limit_missing', String(limit));
  }
});

test('anderer Hersteller: nur Anzeige, keine Regelung (manufacturer_unsupported)', () => {
  for (const m of ['fronius', 'deye-lv', 'bridge-mqtt', 'dvhub-mqtt']) {
    const r = resolvePeakShaving(dev({ enabled: true, gridImportLimitW: 30000 }, { manufacturer: m }));
    assert.equal(r.enabled, true, m);
    assert.equal(r.supported, false, m);
    assert.equal(r.active, false, m);
    assert.equal(r.reason, 'manufacturer_unsupported', m);
    assert.match(peakShavingStatusText(r), /Victron/);
  }
});

test('Abstand: höchstens die Hälfte der Grenze, nie negativ', () => {
  assert.equal(resolvePeakShaving(dev({ enabled: true, gridImportLimitW: 2000, marginW: 5000 })).targetW, 1000);
  assert.equal(resolvePeakShaving(dev({ enabled: true, gridImportLimitW: 2000, marginW: -100 })).targetW, 2000);
  // fehlender Abstand → Vorgabe 300 W
  assert.equal(resolvePeakShaving(dev({ enabled: true, gridImportLimitW: 20000 })).targetW, 19700);
});

test('Einstellungsfelder: eigene Gruppe in „Netz & Recht“, beta, deutsch, mit Grenzen', () => {
  const def = getConfigDefinition();
  const fields = def.fields.filter((f) => String(f.path || '').startsWith('peakShaving.'));
  const byPath = Object.fromEntries(fields.map((f) => [f.path, f]));
  assert.deepEqual(Object.keys(byPath).sort(), [
    'peakShaving.enabled', 'peakShaving.gridImportLimitW', 'peakShaving.marginW',
    'peakShaving.minSocPct', 'peakShaving.releaseHysteresisW'
  ]);
  for (const f of fields) {
    assert.equal(f.beta, true, f.path);
    assert.equal(f.group, 'peakShaving', f.path);
    assert.ok(typeof f.label === 'string' && f.label.length > 3, f.path);
    assert.ok(typeof f.help === 'string' && f.help.length > 20, f.path);
    if (f.path !== 'peakShaving.enabled') {
      assert.deepEqual(f.visibleWhenPath, { path: 'peakShaving.enabled', equals: true }, f.path);
      assert.equal(f.type, 'number', f.path);
      assert.ok(Number.isFinite(f.min) && Number.isFinite(f.max), `${f.path}: min/max`);
    }
  }
  assert.equal(byPath['peakShaving.enabled'].type, 'boolean');
  assert.equal(byPath['peakShaving.gridImportLimitW'].min, 1000);
  const area = def.areas.find((a) => a.groups.includes('peakShaving') || a.advanced.includes('peakShaving'));
  assert.equal(area?.id, 'grid');
});
