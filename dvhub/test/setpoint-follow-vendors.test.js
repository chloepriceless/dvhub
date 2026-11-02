// Entlade-Wächter bei allen Herstellerprofilen (Christin 02.11.2026).
//
// Der Wächter vergleicht Netz-Sollwert, Netzbezug, Akku-Leistung und Ladestand.
// Je Hersteller liefert das Profil davon unterschiedlich viel:
//   • victron       Modbus, alles inkl. aktiver SoC-Grenze (2903) und Entladegrenze (2720/2704)
//   • fronius       Modbus, kein Netz-Sollwert (Steuerung über Model 124) → Wächter ruht
//   • deye-lv       Modbus, kein Netz-Sollwert (TOU-Slots) → Wächter ruht
//   • bridge-mqtt   MQTT (Venus-Topics), Sollwert ja, keine aktive SoC-Grenze
//   • dvhub-mqtt    MQTT (HA/Loxone), Sollwert ja, Mindest-SoC nur, wenn die Quelle ihn liefert
// Victron-Zusatzsignale sind optional: fehlen sie, darf weder ein Fehlalarm
// noch ein Fehler entstehen — und kein Victron-Register auf fremder Hardware
// gelesen werden.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfigFile } from '../config-model.js';
import { createSetpointFollowWatchdog, resolveSetpointFollowOptions } from '../services/setpoint-follow-watchdog.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OPTS = resolveSetpointFollowOptions({});
const T0 = 1_000_000;

function effectiveConfigFor(manufacturer, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-waechter-vendor-'));
  fs.mkdirSync(path.join(dir, 'hersteller'));
  fs.copyFileSync(path.join(HERE, '..', 'hersteller', `${manufacturer}.json`), path.join(dir, 'hersteller', `${manufacturer}.json`));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ manufacturer, updateChannel: 'dev', victron: { host: '192.0.2.10' }, ...extra }));
  const loaded = loadConfigFile(configPath);
  assert.equal(loaded.manufacturerProfileError, null, `${manufacturer}: Profil lädt`);
  return loaded.effectiveConfig;
}

// Welche Felder der Poll-Pfad für dieses Profil überhaupt füllt (points.*.enabled
// bzw. abgeleitete Punkte wie Fronius' m160_battery).
function polledFields(cfg) {
  const fields = Object.entries(cfg.points || {})
    .filter(([, p]) => p?.enabled || p?.derive)
    .map(([name]) => name);
  return new Set(fields);
}

/**
 * Prüfstand: Akku steht bei 70 %, 1,8 kW Netzbezug, DVhub gibt −100 W vor. Nur
 * die Felder, die das Profil pollt, werden gefüllt und gestempelt.
 */
function rig(manufacturer, { cfgExtra = {}, mutateCfg = null, victron = {}, readPoint = null, regs = {}, ownWrite = null } = {}) {
  const cfg = effectiveConfigFor(manufacturer, cfgExtra);
  if (mutateCfg) mutateCfg(cfg);
  const fields = polledFields(cfg);
  const transportType = cfg.victron.transport;
  const sent = [];
  const reads = [];
  const mqttReads = [];
  const base = { gridSetpointW: -100, batteryPowerW: 0, soc: 70, minSocPct: 5, activeSocLimitPct: 10, ...victron };
  const state = {
    meter: { ok: true },
    victron: { gridImportW: 1800, gridExportW: 0, errors: {} },
    schedule: { active: {}, lastWrite: ownWrite ? { maxDischargeW: ownWrite } : {} },
    ctrl: {}
  };
  for (const [k, v] of Object.entries(base)) if (fields.has(k) && v !== undefined) state.victron[k] = v;
  const transport = transportType === 'mqtt'
    ? {
      type: 'mqtt',
      async readPoint(name) {
        mqttReads.push(name);
        if (!readPoint) throw new Error(`MQTT-Wert nicht verfügbar oder veraltet für: ${name}`);
        return readPoint(name);
      }
    }
    : {
      type: 'modbus',
      async mbRequest(conf) {
        reads.push(conf);
        const v = regs[conf.address];
        if (v instanceof Error || v === undefined) throw v || new Error('modbus exception 2');
        return v;
      }
    };
  const watchdog = createSetpointFollowWatchdog({
    state, getCfg: () => cfg, transport, pushLog: () => {},
    notificationService: { sendDirect: (msg) => { sent.push(msg); return Promise.resolve({ sent: 1 }); } }
  });
  async function run(toMs, { stepMs = 5000 } = {}) {
    for (let t = 0; t <= toMs; t += stepMs) {
      const now = T0 + t;
      state.victron.fieldUpdatedAt = {};
      for (const [k, v] of Object.entries(base)) if (fields.has(k) && v !== undefined) state.victron.fieldUpdatedAt[k] = now;
      const result = watchdog.tick(now);
      assert.notEqual(result, undefined);
      await new Promise((r) => setImmediate(r));
    }
  }
  return { cfg, state, sent, reads, mqttReads, run };
}

// --- Victron (Referenz) -------------------------------------------------------

test('Victron: echter Ausfall wird gemeldet, Entladegrenze über 2720 gelesen', async () => {
  const r = rig('victron', { regs: { 2720: [0xffff, 0xffff] } });
  await r.run(OPTS.holdMs + 30000);
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].event, 'setpoint_not_followed');
  assert.ok(r.reads.length >= 1 && r.reads.every((c) => c.address === 2720));
});

test('Victron: aktive SoC-Grenze (2903) entschuldigt den Stillstand', async () => {
  const r = rig('victron', { victron: { soc: 11, activeSocLimitPct: 10 }, regs: { 2720: [0xffff, 0xffff] } });
  await r.run(OPTS.holdMs * 2);
  assert.equal(r.sent.length, 0);
});

// --- Fronius / Deye: kein Netz-Sollwert → Wächter ruht -----------------------

for (const manufacturer of ['fronius', 'deye-lv']) {
  test(`${manufacturer}: kein Netz-Sollwert im Profil → Wächter ruht, liest nichts, wirft nicht`, async () => {
    const r = rig(manufacturer);
    assert.equal(r.cfg.points.gridSetpointW?.enabled, false, 'Profil liefert keinen Sollwert');
    // Auch ein „hängender“ Sollwert im State (ohne Frische-Stempel) zählt nicht.
    r.state.victron.gridSetpointW = -100;
    await r.run(OPTS.holdMs * 3);
    assert.equal(r.sent.length, 0);
    assert.equal(r.reads.length, 0, 'keine Register-Lesung');
    assert.equal(r.state.victron.setpointFollow ?? null, null);
  });
}

test('fremdes Modbus-Gerät mit Entladegrenze (z. B. Fronius-Profil angepasst): nie Victron-Register 2720 lesen', async () => {
  // Ein angepasstes Profil, das Sollwert und Entladegrenze kennt — die Adresse
  // ist gerätespezifisch, 2720 hat dort eine ganz andere Bedeutung.
  const r = rig('fronius', {
    regs: { 40400: [0x7fff], 2720: [0, 0] },
    mutateCfg: (cfg) => {
      cfg.points.gridSetpointW = { enabled: true };
      cfg.controlWrite.maxDischargeW = { enabled: true, fc: 6, address: 40400, writeType: 'int16', signed: true, scale: 1, offset: 0, host: '192.0.2.10', port: 502, unitId: 1 };
    }
  });
  await r.run(OPTS.holdMs + 30000);
  assert.ok(r.reads.length >= 1, 'Entladegrenze wurde gelesen');
  assert.ok(r.reads.every((c) => c.address === 40400), `gelesen: ${r.reads.map((c) => c.address).join(',')}`);
});

// --- MQTT-Profile -----------------------------------------------------------

for (const manufacturer of ['bridge-mqtt', 'dvhub-mqtt']) {
  test(`${manufacturer}: echter Ausfall wird gemeldet, ohne aktive SoC-Grenze und ohne Modbus`, async () => {
    const r = rig(manufacturer, { readPoint: (name) => ({ mqttValue: name === 'maxDischargeW' ? -1 : null }) });
    assert.equal(r.cfg.points.activeSocLimitPct, undefined, 'Profil kennt keine aktive SoC-Grenze');
    await r.run(OPTS.holdMs + 30000);
    assert.equal(r.sent.length, 1);
    assert.equal(r.sent[0].event, 'setpoint_not_followed');
    assert.ok(r.mqttReads.length >= 1 && r.mqttReads.every((n) => n === 'maxDischargeW'));
  });

  test(`${manufacturer}: Entladegrenze 0 über MQTT entschuldigt (eindeutig, kein eigener Write nötig)`, async () => {
    const r = rig(manufacturer, { readPoint: () => ({ mqttValue: 0 }) });
    await r.run(OPTS.holdMs * 2);
    assert.equal(r.sent.length, 0);
  });

  test(`${manufacturer}: Entladegrenze nicht lesbar → kein Fehler, Wächter urteilt ohne sie`, async () => {
    const r = rig(manufacturer, { readPoint: null });
    await r.run(OPTS.holdMs + 30000);
    assert.equal(r.sent.length, 1);
  });

  test(`${manufacturer}: Sollwert kommt nicht an (Topic fehlt) → Wächter ruht`, async () => {
    const r = rig(manufacturer, { victron: { gridSetpointW: undefined } });
    await r.run(OPTS.holdMs * 3);
    assert.equal(r.sent.length, 0);
  });

  test(`${manufacturer}: Mindest-SoC nicht gemeldet → DVhubs Untergrenze Sicherheit gilt, kein Fehlalarm`, async () => {
    // Akku steht bei 18 %, die Anlage hält eine eigene Reserve von 20 % und
    // meldet sie nicht. DVhub kennt nur optimizer.hardFloorSocPct = 20.
    const r = rig(manufacturer, {
      cfgExtra: { optimizer: { hardFloorSocPct: 20 } },
      victron: { soc: 18, minSocPct: undefined },
      readPoint: () => ({ mqttValue: -1 })
    });
    await r.run(OPTS.holdMs * 2);
    assert.equal(r.sent.length, 0);
    // Gegenprobe: weit über der Untergrenze bleibt der echte Alarm.
    const g = rig(manufacturer, {
      cfgExtra: { optimizer: { hardFloorSocPct: 20 } },
      victron: { soc: 60, minSocPct: undefined },
      readPoint: () => ({ mqttValue: -1 })
    });
    await g.run(OPTS.holdMs + 30000);
    assert.equal(g.sent.length, 1);
  });
}

test('Schalter AUS (neuer Pfad) wirkt bei jedem Hersteller', async () => {
  for (const manufacturer of ['victron', 'bridge-mqtt', 'dvhub-mqtt']) {
    const r = rig(manufacturer, {
      cfgExtra: { monitoring: { setpointWatchdog: { enabled: false } } },
      regs: { 2720: [0xffff, 0xffff] },
      readPoint: () => ({ mqttValue: -1 })
    });
    await r.run(OPTS.holdMs * 2);
    assert.equal(r.sent.length, 0, manufacturer);
    assert.equal(r.reads.length + r.mqttReads.length, 0, `${manufacturer}: ausgeschaltet liest nichts`);
  }
});

// --- Gegenprüfung 57e65bac ----------------------------------------------------

test('fremdes Modbus-Gerät: Entladegrenze 0 aus dem Poll-Punkt ist eindeutig — kein Fehlalarm ohne eigenen 0-Write', async () => {
  // Angepasstes Profil: Sollwert und Entladegrenze werden gepollt, geschrieben
  // wird die Grenze nicht. Die 0-Mehrdeutigkeit (−1 → 0) gibt es nur am Victron-GX.
  const r = rig('fronius', {
    victron: { maxDischargeW: 0 },
    mutateCfg: (cfg) => {
      cfg.points.gridSetpointW = { enabled: true };
      cfg.points.maxDischargeW = { enabled: true, fc: 3, address: 40400, quantity: 1, signed: true, scale: 1, offset: 0 };
    }
  });
  await r.run(OPTS.holdMs * 2);
  assert.equal(r.sent.length, 0);
});

test('Victron: 2704-0 aus dem Poll-Punkt bleibt ohne eigenen 0-Write mehrdeutig (Gegenprobe)', async () => {
  const r = rig('victron', {
    victron: { maxDischargeW: 0 },
    mutateCfg: (cfg) => { cfg.points.maxDischargeW = { enabled: true, fc: 4, address: 2704, quantity: 1, signed: true, scale: 1, offset: 0 }; },
    regs: { 2720: [0xffff, 0xffff] }
  });
  await r.run(OPTS.holdMs + 30000);
  assert.equal(r.sent.length, 1);
});

test('kurze Dauer bei langsamem Poll-Takt (60 s): Alarm kommt trotzdem — Fenster mindestens sechs Abfragen', async () => {
  const r = rig('victron', {
    cfgExtra: { meterPollMs: 60000, monitoring: { setpointWatchdog: { holdMinutes: 1 } } },
    regs: { 2720: [0xffff, 0xffff] }
  });
  await r.run(30 * 60000, { stepMs: 60000 });
  assert.equal(r.sent.length, 1, 'Alarm');
  // nicht vor sechs Abfragen
  const early = rig('victron', {
    cfgExtra: { meterPollMs: 60000, monitoring: { setpointWatchdog: { holdMinutes: 1 } } },
    regs: { 2720: [0xffff, 0xffff] }
  });
  await early.run(5 * 60000, { stepMs: 60000 });
  assert.equal(early.sent.length, 0, 'nicht schon nach 5 Minuten');
});
