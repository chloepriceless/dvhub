// test/beta-graduation-r110.test.js — Einfrier-Wächter und Schreib-Verifikation
// verlassen die Beta (Christin 05.11.2026, Ziel 1.0.10): im stabilen Kanal
// sichtbar und einstellbar, ab Werk AUS, bestehende Einstellungen bleiben.
//
// Einfrier-Wächter AUS ⇒ die reine Erkennung (victron.freezeSuspect, 1.0.9)
// läuft weiter und schützt den Netzstrom-Zähler. Wächter AN ⇒ nur der Wächter
// meldet (victron.freeze + ein Alarm), kein zusätzlicher Verdacht.
import test from 'node:test';
import assert from 'node:assert/strict';

import { BETA_FEATURES, betaFeatureForPath } from '../beta-features.js';
import { createDefaultConfig, getConfigDefinition, normalizeConfigInput, CONTROL_WRITE_VERIFY_DEFAULT_ENABLED } from '../config-model.js';
import { resolveControlWriteVerify } from '../schedule-eval.js';
import { createFreezeWatchdog, resolveFreezeOptions } from '../services/telemetry-freeze-watchdog.js';

const effective = (raw) => normalizeConfigInput({ manufacturer: 'victron', ...raw }).effectiveConfig;
const fieldsUnder = (prefix) => getConfigDefinition().fields.filter((f) => f.path === prefix || f.path.startsWith(`${prefix}.`));

test('beide Funktionen sind nicht mehr als Beta registriert', () => {
  assert.equal(Object.hasOwn(BETA_FEATURES, 'freezeWatchdog'), false);
  assert.equal(Object.hasOwn(BETA_FEATURES, 'controlWriteVerify'), false);
  assert.equal(betaFeatureForPath('victron.freezeWatchdog.enabled'), null);
  assert.equal(betaFeatureForPath('schedule.controlWriteVerify.enabled'), null);
});

test('Einstellungen: Felder ohne Beta-Kennzeichen, im stabilen Kanal sichtbar', () => {
  for (const prefix of ['victron.freezeWatchdog', 'schedule.controlWriteVerify']) {
    const fields = fieldsUnder(prefix);
    assert.ok(fields.length > 1, prefix);
    for (const f of fields) {
      assert.notEqual(f.beta, true, `${f.path} ohne beta`);
      assert.doesNotMatch(String(f.groupLabel || ''), /Beta/i, `${f.path}: Gruppentitel`);
      assert.doesNotMatch(`${f.groupDescription || ''} ${f.help || ''}`, /Bleeding-Edge|Feldtest/i, `${f.path}: Texte`);
    }
  }
});

test('Einfrier-Waechter: ab Werk AUS, eingeschaltet wirkt er auch im stabilen Kanal', () => {
  const def = resolveFreezeOptions(effective({}));
  assert.equal(def.enabled, false, 'ab Werk aus');
  const on = resolveFreezeOptions(effective({ updateChannel: 'stable', victron: { freezeWatchdog: { enabled: true } } }));
  assert.equal(on.enabled, true, 'bestehende Einstellung AN gilt jetzt auch im stabilen Kanal');
});

test('Schreib-Verifikation: Standard an genau einer Stelle, eingeschaltet wirkt sie im stabilen Kanal', () => {
  assert.equal(typeof CONTROL_WRITE_VERIFY_DEFAULT_ENABLED, 'boolean');
  assert.equal(CONTROL_WRITE_VERIFY_DEFAULT_ENABLED, false, 'vorerst AUS (Christin entscheidet)');
  assert.equal(createDefaultConfig().schedule.controlWriteVerify.enabled, CONTROL_WRITE_VERIFY_DEFAULT_ENABLED);
  assert.equal(resolveControlWriteVerify(effective({})).enabled, CONTROL_WRITE_VERIFY_DEFAULT_ENABLED);
  assert.equal(resolveControlWriteVerify(effective({ updateChannel: 'stable', schedule: { controlWriteVerify: { enabled: true } } })).enabled, true);
  // Der Hilfetext nennt den Standard aus derselben Konstante.
  const help = fieldsUnder('schedule.controlWriteVerify.enabled')[0].help;
  assert.match(help, CONTROL_WRITE_VERIFY_DEFAULT_ENABLED ? /Standard AN/ : /Standard AUS/);
});

function rig(enabled) {
  const state = {
    meter: { ok: true, updatedAt: 0, grid_total_w: -1000, error: null },
    victron: { soc: 60, batteryPowerW: 2000, pvTotalW: 3000, fieldUpdatedAt: {} }
  };
  const logs = [];
  const notifications = [];
  let dropCount = 0;
  const cfg = effective({ updateChannel: 'stable', victron: { freezeWatchdog: { enabled, freezeMs: 60000, minSamples: 10, reconnectMs: 60000 } }, optimizer: { batteryCapacityWh: 60000 } });
  const wd = createFreezeWatchdog({
    state,
    getCfg: () => cfg,
    transport: { type: 'modbus', dropConnections: () => { dropCount += 1; return 1; } },
    pushLog: (event, details, level) => logs.push({ event, details, level }),
    notificationService: { sendDirect: async (msg) => { notifications.push(msg); return { sent: 1 }; } },
    monitoringAlertPush: () => Promise.resolve()
  });
  const poll = (i, frozen) => {
    const now = 1_000_000 + i * 1000;
    state.meter.ok = true;
    state.meter.updatedAt = now;
    state.meter.grid_total_w = frozen ? -1000 : -1000 - i;
    state.victron.batteryPowerW = frozen ? 2000 : 2000 + i;
    state.victron.pvTotalW = frozen ? 3000 : 3000 + i;
    state.victron.fieldUpdatedAt = { soc: now, batteryPowerW: now, pvPowerW: now };
    wd.tick(now);
  };
  return { state, logs, notifications, poll, dropped: () => dropCount };
}

test('Waechter AUS (ab Werk): reine Erkennung meldet den Verdacht, keine Eingriffe', () => {
  const h = rig(false);
  for (let i = 0; i < 20; i += 1) h.poll(i, false);
  for (let i = 20; i < 200; i += 1) h.poll(i, true);
  assert.equal(h.state.victron.freeze, null);
  assert.equal(h.state.victron.freezeSuspect?.active, true);
  assert.equal(h.dropped(), 0);
  assert.equal(h.logs.filter((l) => l.event === 'telemetry_freeze_suspected').length, 1);
  assert.equal(h.logs.filter((l) => l.level === 'critical').length, 0);
});

test('Waechter AN im stabilen Kanal: nur der Waechter meldet, kein doppelter Verdacht', () => {
  const h = rig(true);
  for (let i = 0; i < 20; i += 1) h.poll(i, false);
  for (let i = 20; i < 200; i += 1) h.poll(i, true);
  assert.equal(h.state.victron.freeze?.active, true);
  assert.equal(h.state.victron.freezeSuspect, null, 'kein zweites Kennzeichen');
  assert.equal(h.logs.filter((l) => l.event === 'telemetry_freeze_detected').length, 1, 'ein Alarm');
  assert.equal(h.logs.filter((l) => l.event === 'telemetry_freeze_suspected').length, 0, 'kein zusaetzlicher Verdacht');
});
