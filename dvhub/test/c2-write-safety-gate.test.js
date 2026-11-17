// C2 (Christin 16.11.2026): Bei ungültiger Konfiguration (kaputtes/fehlendes Herstellerprofil ODER kaputte
// config.json) darf DVhub GAR NICHT mehr an die Hardware schreiben. Heute trägt die wirksame Config dann
// Default-Register (Victron 2716) — ein Write ginge an ein möglicherweise FREMDES Gerät (manufacturer: sungrow,
// Profil kaputt → valid:false, aber gridSetpointW schaltet trotzdem 2716). Fix: hartes Tor + lauter Alarm, kein
// einziger Modbus-Write. Die Anlage bleibt ungeregelt, bis jemand eingreift (gewollt, sicherer).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfigFile } from '../config-model.js';
import { createScheduleEvaluator } from '../schedule-eval.js';
import { createSungrowEms } from '../services/inverter/sungrow.js';
import { loadSungrowConfig, sungrowImage, mockSungrow, sungrowDevice } from './helpers/sungrow-fixture.js';

// --- Teil 1: loadConfigFile markiert die wirksame Config als nicht schreibsicher -----------------------------

test('C2 config-model: kaputtes Sungrow-Profil → valid:false und effectiveConfig.writeSafety.ok === false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2-'));
  fs.mkdirSync(path.join(dir, 'hersteller'), { recursive: true });
  // Kaputtes Herstellerprofil (kein gültiges JSON)
  fs.writeFileSync(path.join(dir, 'hersteller', 'sungrow.json'), '{ das ist kaputt ');
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ manufacturer: 'sungrow', victron: { host: '192.0.2.50' } }));

  const loaded = loadConfigFile(cfgPath);
  assert.equal(loaded.valid, false, 'kaputtes Profil → valid:false');
  assert.ok(loaded.effectiveConfig.writeSafety, 'writeSafety-Marker fehlt');
  assert.equal(loaded.effectiveConfig.writeSafety.ok, false);
  assert.equal(loaded.effectiveConfig.writeSafety.reason, 'manufacturer_profile_error');
  assert.equal(loaded.effectiveConfig.writeSafety.manufacturer, 'sungrow');
});

test('C2 config-model: gültige Config bekommt KEIN writeSafety-Feld (rückwärtskompatibel)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2-ok-'));
  fs.mkdirSync(path.join(dir, 'hersteller'), { recursive: true });
  const shipped = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'hersteller', 'victron.json');
  fs.copyFileSync(shipped, path.join(dir, 'hersteller', 'victron.json'));
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ manufacturer: 'victron', victron: { host: '192.0.2.10' } }));

  const loaded = loadConfigFile(cfgPath);
  assert.equal(loaded.valid, true);
  assert.equal(loaded.effectiveConfig.writeSafety, undefined, 'gültige Config darf kein writeSafety tragen');
});

// --- Teil 2: der Schreib-Chokepoint sperrt bei writeSafety.ok === false ---------------------------------------

function makeTransport() {
  return {
    type: 'modbus',
    writes: [],
    async mbWriteSingle(req) { this.writes.push({ fc: 6, ...req }); },
    async mbWriteMultiple(req) { this.writes.push({ fc: 16, ...req }); }
  };
}

function makeEvaluator(cfg) {
  const state = {
    victron: { soc: 50 },
    ctrl: {},
    schedule: { rules: [], active: {}, lastWrite: {}, manualOverride: {}, config: {}, lastEvalAt: 0 }
  };
  const logs = [];
  const transport = makeTransport();
  const evaluator = createScheduleEvaluator({
    state, getCfg: () => cfg, transport,
    pushLog: (event, details, level) => logs.push({ event, details, level }),
    telemetrySafeWrite: () => {}, persistConfig: async () => {},
    telemetryStore: null, epexNowNext: () => null
  });
  return { evaluator, state, transport, logs };
}

// Wirksame Config bei kaputtem Sungrow-Profil: Victron-Default-Register 2716 + dvControl.enabled, PLUS der
// C2-Marker writeSafety.ok:false (wie ihn loadConfigFile setzt).
function unsafeVictronDefaultCfg() {
  return {
    writeSafety: { ok: false, reason: 'manufacturer_profile_error', manufacturer: 'sungrow' },
    schedule: { controlKeepaliveMs: 5000 },
    controlWrite: {
      gridSetpointW: { enabled: true, fc: 6, address: 2716, writeType: 'int16', scale: 1, offset: 0, keepaliveMs: 5000 }
    },
    dvControl: {
      enabled: true,
      feedExcessDcPv: { enabled: true, fc: 6, address: 2707, writeType: 'uint16', scale: 1, offset: 0 }
    },
    optimizer: { allowGridDischarge: true, allowGridCharge: true }
  };
}

test('C2 Chokepoint: gridSetpointW an Victron-2716 wird bei writeSafety.ok:false NICHT geschrieben + Alarm', async () => {
  const { evaluator, transport, logs } = makeEvaluator(unsafeVictronDefaultCfg());
  const res = await evaluator.applyControlTarget('gridSetpointW', -2000, 'eos_optimization');
  assert.equal(res.ok, false, 'Write muss abgelehnt werden');
  assert.match(String(res.error), /config_unsafe/);
  assert.equal(transport.writes.length, 0, 'keine einzige Modbus-Anfrage bei kaputtem Profil');
  const alarm = logs.find((l) => l.event === 'control_write_blocked_config_unsafe');
  assert.ok(alarm, 'lauter Alarm fehlt');
  assert.equal(alarm.level, 'error');
  assert.equal(alarm.details.reason, 'manufacturer_profile_error');
});

test('C2 Chokepoint: auch die DV-Abregelung (applyDvVictronControl) schreibt nichts', async () => {
  const { evaluator, transport, logs } = makeEvaluator(unsafeVictronDefaultCfg());
  // feedExcessDcPv geht über applyDvVictronControl — eigener Schreibweg, umgeht deviceWriteGate.
  const res = await evaluator.applyControlTarget('feedExcessDcPv', 0, 'negative_price_protection');
  assert.equal(res.ok, false);
  assert.equal(transport.writes.length, 0, 'DV-Abregelung darf bei kaputtem Profil nichts schreiben');
  assert.ok(logs.some((l) => l.event === 'control_write_blocked_config_unsafe'));
});

test('C2 Chokepoint: ohne writeSafety-Feld schreibt der Chokepoint wie bisher (rückwärtskompatibel)', async () => {
  const cfg = unsafeVictronDefaultCfg();
  delete cfg.writeSafety; // gültige Config
  const { evaluator, transport } = makeEvaluator(cfg);
  const res = await evaluator.applyControlTarget('gridSetpointW', -2000, 'eos_optimization');
  assert.equal(res.ok, true, 'gültige Config schreibt normal');
  assert.equal(transport.writes.length, 1);
  assert.equal(transport.writes[0].address, 2716);
});

test('C2 Alarm: wird nur EINMAL je Grund gemeldet (keine Log-Flut je Runde)', async () => {
  const { evaluator, logs } = makeEvaluator(unsafeVictronDefaultCfg());
  await evaluator.applyControlTarget('gridSetpointW', -2000, 'eos_optimization');
  await evaluator.applyControlTarget('gridSetpointW', -2000, 'eos_optimization');
  await evaluator.applyControlTarget('gridSetpointW', -1500, 'eos_optimization');
  const alarms = logs.filter((l) => l.event === 'control_write_blocked_config_unsafe');
  assert.equal(alarms.length, 1, 'Alarm nur einmal je Grund');
});

// --- Teil 3: der Sungrow-Aktuator (writeReg) ist ebenfalls erfasst (Verteidigung in der Tiefe) ---------------
// Szenario: EMS ist mit GÜLTIGER Config scharf; danach wird das Profil ungültig (z. B. Heißneuladen). Der nächste
// Aktuator-Write darf das Gerät NICHT mehr anfassen.

test('C2 Sungrow-Aktuator: wird die Config ungültig, schreibt writeReg nichts mehr + Alarm', async () => {
  const cfg = loadSungrowConfig({ gridPositiveMeans: 'grid_import', sungrow: { controlMode: 'forced', heartbeatTimeoutS: 30 } });
  const image = sungrowImage({});
  const t = mockSungrow(image, {});
  const clock = 1_000_000;
  const state = { victron: { errors: {}, fieldUpdatedAt: { batteryPowerW: clock, pvPowerW: clock, selfConsumptionW: clock }, device: sungrowDevice(), batteryPowerW: -500, pvPowerW: 0, selfConsumptionW: 500, soc: 50 }, meter: { ok: true, updatedAt: clock, grid_total_w: 0 }, ctrl: {} };
  const logs = [];
  const ems = createSungrowEms({ state, getCfg: () => cfg, transport: t, pushLog: (event, data, level) => logs.push({ event, data, level }), now: () => clock });

  const armed = await ems.applySetpoint(-5000, 'rule:abend');
  assert.equal(armed.ok, true, JSON.stringify(armed));
  assert.equal(state.ctrl.sungrowEms.owns, true);

  // Profil wird ungültig
  cfg.writeSafety = { ok: false, reason: 'manufacturer_profile_error', manufacturer: 'sungrow' };
  t.writes.length = 0;
  const res = await ems.applySetpoint(-3000, 'rule:abend');
  assert.notEqual(res.ok, true, 'Aktuator-Write muss bei ungültiger Config scheitern');
  assert.equal(t.writes.length, 0, 'keine einzige Sungrow-Modbus-Anfrage bei ungültiger Config');
  assert.ok(logs.some((l) => l.event === 'sungrow_write_blocked_config_unsafe' && l.level === 'error'), 'lauter Alarm fehlt');
});
