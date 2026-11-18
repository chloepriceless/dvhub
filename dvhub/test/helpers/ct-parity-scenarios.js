// test/helpers/ct-parity-scenarios.js — Szenarien des Paritätsnachweises für Pfad 1 der D.1-Inventur
// (applyControlTargetCore: Victron Modbus 2716/2705/2704/2901 …, MQTT-Brücke Venus, DVhub-Schema mit Broker und ohne
// Broker = HTTP-Abholung), H-1 Phase 3b, VCL-Vertrag v6 D.2/D.4(2). Gefahren von test/gate-control-target-parity.test.js
// (Not-Halt-Richtlinie ab Werk) und test/helpers/dv-parity-policy-flip.mjs (Richtlinie umgeschaltet, Kind-Prozess) über
// den Prüfstand test/helpers/dv-parity-rig.js (alter Weg ↔ echtes Tor, wahlweise gegen die Originaldatei).
//
// MQTT läuft über den ECHTEN Transport (createMqttTransport, wie server.js) mit einer Broker-Attrappe an der
// connectFn-Naht: Draht = CONNECT/SUB/PUB-Protokoll samt Transport-Ereignissen; `calls` = jeder mqttWrite-Aufruf, der
// die Lese-Modus-Prüfung passiert hat (auch ohne Broker, wo nichts auf den Draht geht). Die Abholung für Loxone
// (GET /api/integration/loxone) läuft über den echten Routen-Handler.

import assert from 'node:assert/strict';

import { HOST, loadProfileConfig, baseState } from './gate-golden.js';
import { sungrowDevice } from './sungrow-fixture.js';
import { parityModbus } from './dv-parity-rig.js';
import { makeTelemetryState } from './peak-shaving-harness.js';
import { createMqttTransport } from '../../transport-mqtt.js';
import { createApiRoutes } from '../../routes-api.js';
import { setEmergencyStop } from '../../services/control-commands.js';
import { createGridConnectionGuard } from '../../services/grid-connection/index.js';
import { endpointKeyOf } from '../../services/inverter/sungrow.js';
import { isReadOnlyMode } from '../../read-only-guard.js';

const SG_HOST = '192.0.2.50';                       // passt zu sungrowDevice().endpointKey
const ALIAS = { [HOST]: 'gx', [SG_HOST]: 'sg' };
// Victron-GX: 2704 Entladegrenze 0, 2705 Ladestrom, 2716/2717 Netz-Sollwert, 2901 Mindest-SoC 10,0 %, 2720/2721
// Entladegrenze als int32 (W, Venus ≥ 3.50), 2706 ab Werk -1, Einspeisung frei.
const VICTRON_REGS = { 2704: 0, 2705: 0, 2716: 0, 2717: 0, 2720: 0, 2721: 0, 2901: 100, 2706: 0xffff, 2707: 1, 2708: 0 };
const VERIFY = { controlWriteVerify: { enabled: true, delayMs: 1000, minIntervalMs: 1000 } };
const PEAK_ON = { updateChannel: 'dev', peakShaving: { enabled: true, gridImportLimitW: 10000, marginW: 300, releaseHysteresisW: 500 } };

const set = (r, target, value, source) => () => r.ev.applyControlTarget(target, value, source);
// ctx als Funktion: bekommt je Seite eine eigene Box (rig.data), über die das Szenario Eingänge zur Laufzeit stellt.
const ctxOf = (ctx, box) => (typeof ctx === 'function' ? ctx(box) : ctx);

/** Victron über das ausgelieferte Profil; je Seite eine eigene Attrappe (Szenarien ändern failWrite zur Laufzeit). */
function victronSetup({ persisted = {}, transport = {}, state = {}, ctx = {}, data = {}, cfgPatch = null, telemetryState = null } = {}) {
  return (onWrite) => {
    const cfg = loadProfileConfig('victron', { victron: { host: HOST }, ...persisted });
    cfgPatch?.(cfg);
    const box = structuredClone(data);
    return {
      cfg,
      transport: parityModbus({ holding: VICTRON_REGS, hostAlias: ALIAS, ...structuredClone(transport) }, onWrite),
      state: () => (telemetryState ? { ...makeTelemetryState(telemetryState), log: [] } : baseState(state)),
      ctx: ctxOf(ctx, box),
      data: box,
    };
  };
}

function profileSetup(profile, { persisted = {}, holding = {}, state = {}, cfgPatch = null } = {}) {
  return (onWrite) => {
    const cfg = loadProfileConfig(profile, { victron: { host: profile === 'sungrow' ? SG_HOST : HOST }, ...persisted });
    cfgPatch?.(cfg);
    return {
      cfg,
      transport: parityModbus({ holding, hostAlias: ALIAS }, onWrite),
      state: () => baseState(state),
    };
  };
}

/**
 * Echter MQTT-Transport mit Broker-Attrappe. echo(topic, payload) → [topic, payload] | null: Rückmeldung der
 * Gegenstelle (Venus N/), zur Laufzeit über transport.broker.echo änderbar.
 */
export function realMqtt(victronCfg, onWrite = null) {
  const wire = [];
  const calls = [];
  const broker = { echo: null, client: null };
  let transport = null;
  const connectFn = (url) => {
    const handlers = {};
    const client = {
      connected: true,
      on(ev, fn) { (handlers[ev] ||= []).push(fn); return client; },
      subscribe(topics, opts, cb) { wire.push(`SUB ${topics.length} q${opts?.qos ?? 0}`); cb(null); },
      publish(topic, payload, opts) {
        wire.push(`PUB ${topic} ${JSON.stringify(String(payload))}${opts ? ` q${opts.qos ?? 0}` : ''}`);
        onWrite?.(wire.at(-1));
        const back = broker.echo?.(topic, payload);
        if (back) transport._onMessage(back[0], Buffer.from(String(back[1])), { retain: false });
      },
      end() { client.connected = false; },
      removeAllListeners() {},
      reconnect() {},
    };
    wire.push(`CONNECT ${url}`);
    broker.client = client;
    queueMicrotask(() => { for (const fn of handlers.connect || []) fn(); });
    return client;
  };
  transport = createMqttTransport(victronCfg, { connectFn, onEvent: (e, _d, lvl) => wire.push(`EV ${e}${lvl ? ` ${lvl}` : ''}`) });
  const write = transport.mqttWrite;
  transport.mqttWrite = async (name, value) => {
    if (!isReadOnlyMode()) calls.push(`mqttWrite:${JSON.stringify([name, value])}`);
    return write.call(transport, name, value);
  };
  return Object.assign(transport, { ops: wire, calls, broker });
}

function mqttSetup(profile, { mqtt = {}, persisted = {}, state = {}, ctx = {} } = {}) {
  return (onWrite) => {
    const cfg = loadProfileConfig(profile, { victron: { host: HOST, mqtt }, ...persisted });
    return { cfg, transport: realMqtt(cfg.victron, onWrite), state: () => baseState(state), ctx: ctxOf(ctx) };
  };
}

const VENUS_ECHO = (topic, payload) => (topic.startsWith('W/') ? [topic.replace(/^W\//, 'N/'), payload] : null);
const mqttInit = (r) => async () => { await r.transport.init(); await r.advance(0); return { brokerMode: r.transport.brokerMode ?? null }; };

/** GET /api/integration/loxone über den echten Routen-Handler (ohne Netz) → nur die Steuerzeilen. */
async function loxoneControl(r) {
  const ctx = {
    state: Object.assign(r.state, { epex: { ok: false, data: [] }, energy: { day: null, importWh: 0, exportWh: 0, costEur: 0, revenueEur: 0 }, costs: {} }),
    getCfg: () => r.cfg, getRawCfg: () => r.cfg, pushLog: () => {},
    controlValue: () => (r.state.ctrl.forcedOff ? 0 : 1), epexNowNext: () => ({ current: null, next: null }),
    needsSetup: () => false, getAppDir: () => process.cwd(), getAppVersion: () => ({ versionLabel: 'test' }),
    applyControlTarget: r.ev.applyControlTarget,
  };
  const routes = createApiRoutes(ctx);
  const req = { method: 'GET', url: '/api/integration/loxone', headers: { host: 'dvhub.test' }, socket: { remoteAddress: '127.0.0.1' }, on() { return req; }, destroy() {} };
  const res = { status: 0, body: '', writeHead(c) { this.status = c; }, setHeader() {}, end(b) { this.body = b == null ? '' : String(b); } };
  await routes.handleRequest(req, res, new URL('/api/integration/loxone', 'http://dvhub.test'));
  return { http: res.status, loxone: res.body.split('\n').filter((l) => l.startsWith('dvhub_control_') || l.startsWith('gridSetpointW=')) };
}

const delivered = (n) => n.rig.events.filter((e) => e.outcome === 'ok' || e.outcome === 'error');
const actionsOf = (n) => delivered(n).map((e) => `${e.point}:${e.action}`);
const haltedOf = (n) => n.rig.events.filter((e) => e.state_flags.not_halt).map((e) => `${e.point}:${e.action}:${e.outcome}`);

// --- Szenarien (Not-Halt-Richtlinie ab Werk) -----------------------------------------------------------------------

export function controlTargetScenarios() {
  const S = {};

  // Netz-Sollwert 2716 (int32, FC16): Wechsel, Unverändert-Skip, Keepalive samt 60-s-Log-Sammler, EEG-Tor, Pflicht-Quelle
  // mit Keepalive, Grenzwerte.
  S.p1_victron_setpoint_cycle = {
    setup: victronSetup({ persisted: { optimizer: { allowGridDischarge: true } } }),
    run: async (r, step) => {
      await step('-500 (Regel)', set(r, 'gridSetpointW', -500, 'rule:abend'));
      await step('-500 gleich', set(r, 'gridSetpointW', -500, 'rule:abend'));
      await r.advance(4999);
      await step('-500 nach 4999 ms', set(r, 'gridSetpointW', -500, 'rule:abend'));
      await r.advance(1);
      await step('-500 Keepalive fällig', set(r, 'gridSetpointW', -500, 'rule:abend'));
      for (let i = 1; i <= 13; i += 1) {
        await r.advance(5000);
        await step(`-500 Keepalive ${i}`, set(r, 'gridSetpointW', -500, 'rule:abend'));
      }
      await step('-1500 Wechsel', set(r, 'gridSetpointW', -1500, 'rule:abend'));
      await step('+800 ohne Netzladen (EEG-Tor)', set(r, 'gridSetpointW', 800, 'rule:laden'));
      await step('0 Standard', set(r, 'gridSetpointW', 0, 'default'));
      await step('-3000 § 51', set(r, 'gridSetpointW', -3000, 'negative_price_protection'));
      await r.advance(5000);
      await step('-3000 § 51 Keepalive', set(r, 'gridSetpointW', -3000, 'negative_price_protection'));
      await step('999999 außerhalb der Grenzen', set(r, 'gridSetpointW', 999999, 'api_manual_write'));
      await step('-2000 EOS', set(r, 'gridSetpointW', -2000, 'eos_optimization'));
    },
    expect: (n) => assert.deepEqual(actionsOf(n), [
      'gridSetpointW:command', ...Array(14).fill('gridSetpointW:keepalive'), 'gridSetpointW:command', 'gridSetpointW:command',
      'gridSetpointW:protectiveLimit', 'gridSetpointW:protectiveLimit', 'gridSetpointW:command',
    ]),
  };

  // Ladestrom 2705, Mindest-SoC 2901 (Klemme), Entladegrenze 2704 mit Sonderwerten, Einspeisegrenze 2706 über Pfad 1.
  S.p1_victron_targets = {
    setup: victronSetup(),
    run: async (r, step) => {
      const a = (target, value, source = 'api_manual_write') => set(r, target, value, source);
      await step('chargeCurrentA 30', a('chargeCurrentA', 30));
      await step('chargeCurrentA 30 gleich', a('chargeCurrentA', 30));
      await step('chargeCurrentA -1', a('chargeCurrentA', -1));
      await step('minSocPct 20', a('minSocPct', 20));
      await step('minSocPct 3 → Klemme', a('minSocPct', 3));
      await step('maxDischargeW -1', a('maxDischargeW', -1));
      await step('maxDischargeW 0', a('maxDischargeW', 0));
      await step('maxDischargeW 4004 (Raster)', a('maxDischargeW', 4004));
      await step('dvFeedInLimitW 3049', a('dvFeedInLimitW', 3049));
      await step('nicht freigegebenes Ziel', a('feedInLimitW', 100));
    },
    expect: (n) => {
      assert.ok(delivered(n).every((e) => e.action === 'command'));
      const pol = (p) => n.rig.events.find((e) => e.point === p);
      assert.equal(pol('maxDischargeW').lease, null);
      assert.equal(pol('chargeCurrentA').value.unit, 'A');
      assert.equal(pol('dvFeedInLimitW').value.unit, 'W');
    },
  };

  S.p1_victron_eeg_gate = {
    setup: victronSetup({ persisted: { optimizer: { allowGridDischarge: false } } }),
    run: async (r, step) => {
      await step('-2000 diskretionär', set(r, 'gridSetpointW', -2000, 'eos_optimization'));
      await step('-2000 Pflicht', set(r, 'gridSetpointW', -2000, 'negative_price_protection'));
      await step('-900 unter der Schwelle', set(r, 'gridSetpointW', -900, 'eos_optimization'));
      await step('-2000 Einspeisung DC', set(r, 'gridSetpointW', -2000, 'dc_export_mode'));
      await step('+1500 Netzladen verboten', set(r, 'gridSetpointW', 1500, 'eos_optimization'));
      await step('+1500 EOS Akku halten', set(r, 'gridSetpointW', 1500, 'eos_grid_hold'));
    },
  };

  S.p1_victron_volatile_guard = {
    setup: victronSetup({ persisted: { schedule: { controlKeepaliveMs: 0 } } }),
    noWrites: true,
    run: async (r, step) => { await step('-500 ohne Keepalive', set(r, 'gridSetpointW', -500, 'rule:abend')); },
  };

  // Entlade-Boden (T-0075): veralteter SoC hält auf 0, am harten Boden ebenso.
  S.p1_victron_floor = {
    setup: victronSetup({ persisted: { optimizer: { allowGridDischarge: true, hardFloorSocPct: 10 } }, state: { soc: 60, socFresh: false } }),
    run: async (r, step) => {
      await step('-1500 SoC veraltet', set(r, 'gridSetpointW', -1500, 'rule:abend'));
      await step('maxDischargeW 4000 SoC veraltet', set(r, 'maxDischargeW', 4000, 'rule:abend'));
      await step('chargeCurrentA 20 SoC veraltet', set(r, 'chargeCurrentA', 20, 'rule:abend'));
      r.state.victron.soc = 9;
      r.state.victron.fieldUpdatedAt.soc = Date.now();
      await step('-1500 SoC 9 % ≤ Boden', set(r, 'gridSetpointW', -1700, 'rule:abend'));
    },
  };

  // Einspeise-Puffer (GitHub #12) bei bekanntem Preis, Peak Shaving (Hebel 1), Netzanschluss-Decke und „Akku zuerst“.
  S.p1_victron_clamps = {
    setup: victronSetup({
      persisted: { ...PEAK_ON, optimizer: { allowGridCharge: true, allowGridDischarge: true }, schedule: { defaultGridSetpointW: -100 } },
      data: { ceilingW: null, floorW: null, ct: 12 },
      ctx: (box) => ({
        epexNowNext: () => ({ current: { ct_kwh: box.ct, eur_mwh: box.ct * 10 }, next: null }),
        gridConnection: { batteryCeilingW: () => box.ceilingW, dischargeFloorW: () => box.floorW, persistedRestoreW: () => null, summary: () => null },
      }),
    }),
    run: async (r, step) => {
      await step('-40 → Puffer -100', set(r, 'gridSetpointW', -40, 'rule:abend'));
      await step('-40 § 51 (kein Puffer)', set(r, 'gridSetpointW', -40, 'negative_price_protection'));
      await step('-40 Mindestpreis (kein Puffer)', set(r, 'gridSetpointW', -40, 'sell_price_floor'));
      r.data.ct = -2;
      await step('-40 bei negativem Preis (kein Puffer)', set(r, 'gridSetpointW', -50, 'rule:abend'));
      r.data.ct = 12;
      await step('+12000 Peak Shaving', set(r, 'gridSetpointW', 12000, 'rule:laden'));
      r.data.ceilingW = 3000;
      await step('+5000 Netzanschluss-Decke 3000', set(r, 'gridSetpointW', 5000, 'rule:laden'));
      await step('+5000 Decke gleich', set(r, 'gridSetpointW', 5000, 'rule:laden'));
      r.data.floorW = 4000;
      await step('maxDischargeW 1000 → Akku zuerst 4000', set(r, 'maxDischargeW', 1000, 'rule:abend'));
      await step('maxDischargeW -1 (unbegrenzt) gilt', set(r, 'maxDischargeW', -1, 'rule:abend'));
      await step('maxDischargeW 1500 Akku-Hilfe selbst', set(r, 'maxDischargeW', 1500, 'grid_connection_assist'));
      r.data.ceilingW = null;
      r.data.floorW = null;
      await step('+2000 ohne Decke', set(r, 'gridSetpointW', 2000, 'rule:laden'));
      await step('+500 § 14a-Grenze', set(r, 'gridSetpointW', 500, 'paragraph14a_limit'));
    },
    expect: (n) => assert.ok(actionsOf(n).includes('gridSetpointW:protectiveLimit') && actionsOf(n).includes('maxDischargeW:protectiveLimit')),
  };

  // Not-Halt (Richtlinie ab Werk): Befehle und Pflicht-Quellen gesperrt, die eine Rücknahme je Quelle (Netzanschluss,
  // Peak Shaving) geht über das Tor als haltNeutralize auf die Entladegrenze 2704.
  S.p1_victron_nothalt = {
    setup: victronSetup(),
    run: async (r, step) => {
      await step('-500 (Regel)', set(r, 'gridSetpointW', -500, 'rule:abend'));
      await step('Akku-Hilfe 5000 W', set(r, 'maxDischargeW', 5000, 'grid_connection_assist'));
      r.halt();
      await step('-500 Regel im Not-Halt', set(r, 'gridSetpointW', -700, 'rule:abend'));
      await step('-700 Regel im Not-Halt erneut', set(r, 'gridSetpointW', -700, 'rule:abend'));
      await step('-3000 § 51 im Not-Halt', set(r, 'gridSetpointW', -3000, 'negative_price_protection'));
      await step('Netzanschluss-Rücknahme 2000 W (einmal)', set(r, 'maxDischargeW', 2000, 'grid_connection_restore'));
      await step('Netzanschluss-Rücknahme 1000 W (zweites Mal)', set(r, 'maxDischargeW', 1000, 'grid_connection_restore'));
      await step('Netzanschluss-Rücknahme nach oben (keine Rücknahme)', set(r, 'maxDischargeW', 3000, 'grid_connection_restore'));
      await step('Peak-Shaving-Rücknahme 0 (einmal)', set(r, 'maxDischargeW', 0, 'peak_shaving_restore'));
      await step('Peak-Shaving-Rücknahme 0 (zweites Mal)', set(r, 'maxDischargeW', 0, 'peak_shaving_restore'));
      await step('Peak-Shaving-Rücknahme 500 (kein Literal 0)', set(r, 'maxDischargeW', 500, 'peak_shaving_restore'));
      await step('Akku-Übergabe-Ende ohne Rückkehrwert', set(r, 'maxDischargeW', 4000, 'multi_gx_handoff_stop'));
      await step('Ladestrom im Not-Halt', set(r, 'chargeCurrentA', 10, 'api_manual_write'));
      r.resume();
      await step('-700 nach dem Aufheben', set(r, 'gridSetpointW', -700, 'rule:abend'));
    },
    expect: (n) => {
      assert.deepEqual(haltedOf(n), ['maxDischargeW:haltNeutralize:ok', 'maxDischargeW:haltNeutralize:ok']);
      assert.ok(actionsOf(n).includes('maxDischargeW:protectiveLimit'), 'Akku-Hilfe = Schutz-Begrenzung (Netzanschluss)');
    },
  };

  // Neustart im Not-Halt: Rücknahme ohne eigenen Write — frische Rücklesung gleich (already_set, kein Write) bzw.
  // höher (Rücknahme schreibt einmal).
  S.p1_victron_nothalt_after_restart = {
    setup: victronSetup(),
    run: async (r, step) => {
      r.halt();
      r.state.victron.maxDischargeW = 2000;
      r.state.victron.fieldUpdatedAt.maxDischargeW = Date.now();
      await step('Rücknahme 2000 W, Rücklesung 2000', set(r, 'maxDischargeW', 2000, 'grid_connection_restore'));
      r.state.victron.maxDischargeW = 4000;
      await step('Rücknahme 2000 W, Rücklesung 4000', set(r, 'maxDischargeW', 2000, 'grid_connection_restore'));
      await step('Rücknahme erneut', set(r, 'maxDischargeW', 1000, 'grid_connection_restore'));
    },
    expect: (n) => assert.deepEqual(haltedOf(n), ['maxDischargeW:haltNeutralize:ok']),
  };

  // Echter Not-Halt-Eintritt/-Austritt (setEmergencyStop): Sperrmarke im Tor; beim Aufheben vergisst DVhub den
  // gemerkten Netz-Sollwert — derselbe Wert wird danach wieder geschrieben.
  S.p1_victron_emergency_stop_real = {
    setup: victronSetup(),
    run: async (r, step) => {
      const stopCtx = () => ({ state: r.state, pushLog: r.pushLog, ...(r.gate ? { gate: r.gate } : {}) });
      await step('-500', set(r, 'gridSetpointW', -500, 'rule:abend'));
      await step('Not-Halt ein', () => setEmergencyStop(stopCtx(), { on: true }));
      await r.advance(5000);
      await step('-500 Keepalive im Not-Halt', set(r, 'gridSetpointW', -500, 'rule:abend'));
      await step('Not-Halt aus', () => setEmergencyStop(stopCtx(), { on: false }));
      await step('-500 nach dem Aufheben', set(r, 'gridSetpointW', -500, 'rule:abend'));
    },
  };

  // Not-Halt beginnt WÄHREND des Writes (Haken nach dem Draht): der Write ist durch, der nächste ist gesperrt.
  S.p1_victron_halt_during_write = {
    setup: victronSetup(),
    run: async (r, step) => {
      r.onWrite((entry) => { if (entry.startsWith('W16 gx/u100 @2716=')) r.halt(); });
      await step('-500, Not-Halt während des Writes', set(r, 'gridSetpointW', -500, 'rule:abend'));
      r.onWrite(null);
      await r.advance(5000);
      await step('Keepalive im Not-Halt', set(r, 'gridSetpointW', -500, 'rule:abend'));
    },
    expect: (n) => assert.deepEqual(n.rig.events.map((e) => `${e.point}:${e.action}:${e.outcome}:${e.state_flags.not_halt}`), ['gridSetpointW:command:ok:true']),
  };

  S.p1_victron_write_safety = {
    setup: victronSetup(),
    run: async (r, step) => {
      await step('-500', set(r, 'gridSetpointW', -500, 'rule:abend'));
      r.cfg.writeSafety = { ok: false, reason: 'manufacturer_profile_error', manufacturer: 'victron' };
      await r.advance(5000);
      await step('-500 Keepalive bei writeSafety.ok=false', set(r, 'gridSetpointW', -500, 'rule:abend'));
      await step('chargeCurrentA bei writeSafety.ok=false', set(r, 'chargeCurrentA', 20, 'api_manual_write'));
      await step('feedExcessDcPv bei writeSafety.ok=false', set(r, 'feedExcessDcPv', 0, 'negative_price_protection'));
      r.cfg.writeSafety = { ok: true };
      await step('-600 danach', set(r, 'gridSetpointW', -600, 'rule:abend'));
    },
  };

  // Geräte-Tor (identify.requiredForWrites): nicht erkannt, erkannt, Endpunkt gewechselt, nicht unterstützt.
  S.p1_victron_device_gate = {
    setup: victronSetup({ cfgPatch: (cfg) => { cfg.identify = { requiredForWrites: true }; } }),
    run: async (r, step) => {
      await step('-500 nicht erkannt', set(r, 'gridSetpointW', -500, 'rule:abend'));
      r.state.victron.device = { supported: true, endpointKey: endpointKeyOf(r.cfg.victron) };
      await step('-500 erkannt', set(r, 'gridSetpointW', -500, 'rule:abend'));
      r.state.victron.device = { supported: true, endpointKey: '192.0.2.99:502:100' };
      await step('-600 anderer Endpunkt', set(r, 'gridSetpointW', -600, 'rule:abend'));
      r.state.victron.device = { supported: false, endpointKey: endpointKeyOf(r.cfg.victron) };
      await step('-600 nicht unterstützt', set(r, 'gridSetpointW', -600, 'rule:abend'));
    },
  };

  // Sungrow (Profil mit identify): ein Register-Ziel über Pfad 1 (nicht der EMS-Sollwert) mit und ohne Erkennung.
  S.p1_sungrow_device_gate = {
    setup: profileSetup('sungrow', { persisted: { updateChannel: 'dev' }, holding: { 13086: 0x55 }, state: { victron: { device: sungrowDevice() } } }),
    run: async (r, step) => {
      await step('feedInLimitEnable 0xAA erkannt', set(r, 'feedInLimitEnable', 0xaa, 'api_manual_write'));
      r.state.victron.device = sungrowDevice({ endpointKey: '192.0.2.99:502:1' });
      await step('feedInLimitEnable 0x55 anderer Endpunkt', set(r, 'feedInLimitEnable', 0x55, 'api_manual_write'));
    },
  };

  for (const [name, transport] of [['match', {}], ['mismatch', { ignoreWrite: [2716] }]]) {
    S[`p1_victron_verify_${name}`] = {
      setup: victronSetup({ transport, persisted: { schedule: VERIFY, optimizer: { allowGridDischarge: true } } }),
      clock: ['Date', 'setTimeout'],
      run: async (r, step) => {
        await step('-500', set(r, 'gridSetpointW', -500, 'rule:abend'));
        await step('Prüfung nach 1 s', async () => { await r.advance(1000); return null; });
        await step('-500 erneut', set(r, 'gridSetpointW', -500, 'rule:abend'));
        await step('Prüfung nach 1 s', async () => { await r.advance(1000); return null; });
        await step('-500 erneut', set(r, 'gridSetpointW', -500, 'rule:abend'));
        await step('Prüfung nach 1 s', async () => { await r.advance(1000); return null; });
        await step('maxDischargeW 3000', set(r, 'maxDischargeW', 3000, 'api_manual_write'));
        await r.advance(5000);
        await step('-500 Keepalive (keine Prüfung)', set(r, 'gridSetpointW', -500, 'rule:abend'));
        await step('Prüfung nach 1 s', async () => { await r.advance(1000); return null; });
      },
    };
  }

  // Modbus-Ausnahmen und Fehler: 2 (abgelehnt), 4 (unbestimmt, Wert übernommen), Warteschlange voll (nicht gesendet),
  // Zeitüberschreitung; Adresse außerhalb 0…65535 (Fehler vor dem Senden). Kein Unverändert-Skip nach einem Fehler.
  S.p1_victron_modbus_errors = {
    setup: victronSetup({
      persisted: { optimizer: { allowGridDischarge: true } },
      transport: { failWrite: { 2716: { msg: 'modbus exception 2', times: 1 }, 2705: { msg: 'modbus exception 4', apply: true, times: 1 }, 2704: { msg: 'modbus queue full', times: 1 }, 2901: { msg: 'timeout', times: 1 } } },
    }),
    run: async (r, step) => {
      await step('-700 Ausnahme 2', set(r, 'gridSetpointW', -700, 'rule:abend'));
      await step('-700 erneut', set(r, 'gridSetpointW', -700, 'rule:abend'));
      await step('chargeCurrentA 25 Ausnahme 4', set(r, 'chargeCurrentA', 25, 'api_manual_write'));
      await step('chargeCurrentA 25 erneut', set(r, 'chargeCurrentA', 25, 'api_manual_write'));
      await step('maxDischargeW 2000 Warteschlange voll', set(r, 'maxDischargeW', 2000, 'api_manual_write'));
      await step('minSocPct 20 Zeitüberschreitung', set(r, 'minSocPct', 20, 'api_manual_write'));
      r.cfg.controlWrite.minSocPct.address = 70000;
      await step('minSocPct 25 Adresse außerhalb', set(r, 'minSocPct', 25, 'api_manual_write'));
    },
    expect: (n) => {
      const d = delivered(n).map((e) => `${e.point}:${e.outcome}:${e.delivery}`);
      assert.deepEqual(d, [
        'gridSetpointW:error:rejected', 'gridSetpointW:ok:acked', 'chargeCurrentA:error:unknown', 'chargeCurrentA:ok:acked',
        'maxDischargeW:error:notSent', 'minSocPct:error:unknown', 'minSocPct:error:unknown',
      ]);
    },
  };

  S.p1_victron_read_only = {
    setup: victronSetup({ persisted: { optimizer: { allowGridDischarge: true } } }), readOnly: true,
    run: async (r, step) => {
      await step('-500 im Lese-Modus', set(r, 'gridSetpointW', -500, 'rule:abend'));
      await step('chargeCurrentA im Lese-Modus', set(r, 'chargeCurrentA', 30, 'api_manual_write'));
      await step('maxDischargeW im Lese-Modus', set(r, 'maxDischargeW', 0, 'api_manual_write'));
    },
  };

  // Ganzer Takt (evaluateSchedule): Regel -800, Keepalive, Standard-Sollwert, negativer Preis (§ 51), Not-Halt.
  S.p1_victron_eval_rule = {
    setup: victronSetup({
      persisted: { optimizer: { allowGridDischarge: true } },
      data: { ct: 12 },
      ctx: (box) => ({ epexNowNext: () => ({ current: { ct_kwh: box.ct, eur_mwh: box.ct * 10 }, next: null }) }),
    }),
    run: async (r, step) => {
      r.state.schedule.rules = [{ id: 'r1', enabled: true, target: 'gridSetpointW', start: '00:00', end: '23:59', value: -800, source: 'manual' }];
      const tick = (label) => step(label, async () => { await r.ev.evaluateSchedule(); return { active: r.state.schedule.active.gridSetpointW ?? null }; });
      await tick('Takt 1 Regel');
      await r.advance(5000);
      await tick('Takt 2 Keepalive');
      r.state.schedule.rules = [];
      r.state.schedule.config.defaultGridSetpointW = -40;
      await r.advance(5000);
      await tick('Takt 3 Standard');
      r.data.ct = -3;
      await r.advance(5000);
      await tick('Takt 4 negativer Preis');
      await r.advance(5000);
      await tick('Takt 5 negativer Preis');
      r.halt();
      await r.advance(5000);
      await tick('Takt im Not-Halt');
      r.resume();
      r.data.ct = 12;
      await r.advance(5000);
      await tick('Takt nach dem Aufheben');
    },
  };

  // Ganzer Takt mit Peak Shaving (Hebel 2): Sperre per API, Bezugsspitze → Freigabe (peak_shaving), Spitze vorbei →
  // Rücknahme (peak_shaving_restore); dazu die Rücklesung 2704/2720.
  S.p1_victron_peak_shaving_tick = {
    setup: victronSetup({ persisted: PEAK_ON, telemetryState: { soc: 60, loadW: 14000, importW: 14000 } }),
    run: async (r, step) => {
      const flow = (importW, dischargeW = 0) => {
        const now = Date.now();
        // Wie am GX: 2720/2721 (int32, W) zeigt den Wert hinter 2704 (Rohwert × 10, 32767 = −1 unbegrenzt).
        const raw = r.transport.regs.get(2704) ?? 0;
        const v = raw > 0x7fff ? raw - 0x10000 : raw;
        const b = Buffer.alloc(4);
        b.writeInt32BE(v === 32767 ? -1 : v * 10, 0);
        r.transport.regs.set(2720, b.readUInt16BE(0));
        r.transport.regs.set(2721, b.readUInt16BE(2));
        Object.assign(r.state.victron, { gridImportW: importW, batteryPowerW: -dischargeW, batteryDischargeW: dischargeW, batteryChargeW: 0 });
        for (const f of ['soc', 'selfConsumptionW', 'pvPowerW', 'acPvL1W', 'acPvL2W', 'acPvL3W']) r.state.victron.fieldUpdatedAt[f] = now;
        Object.assign(r.state.meter, { ok: true, updatedAt: now, grid_total_w: importW });
      };
      await step('Sperre per API', set(r, 'maxDischargeW', 0, 'api_manual_write'));
      for (let i = 1; i <= 3; i += 1) {
        await r.advance(5000); flow(14000);
        await step(`Spitze ${i}`, async () => { await r.ev.evaluateSchedule(); return r.state.ctrl._peakShaving?.discharge ?? null; });
      }
      for (let i = 1; i <= 8; i += 1) {
        await r.advance(5000); flow(3000, 0);
        await step(`ruhig ${i}`, async () => { await r.ev.evaluateSchedule(); return r.state.ctrl._peakShaving?.discharge ?? null; });
      }
    },
    expect: (n) => {
      const a = actionsOf(n).filter((x) => x.startsWith('maxDischargeW'));
      assert.ok(a.includes('maxDischargeW:command') && a.includes('maxDischargeW:autoRestore'), a.join(','));
    },
  };

  // Akku-Hilfe über den echten Netzanschluss-Wächter (bridge-mqtt, „Akku zuerst“ nativ über MaxDischargePower):
  // § 14a-Anforderung → Anheben (grid_connection_assist), Not-Halt → die eine Rücknahme (grid_connection_restore).
  S.p1_mqtt_battery_assist_nothalt = {
    setup: mqttSetup('bridge-mqtt', {
      mqtt: { broker: 'mqtt://192.0.2.11:1883' },
      persisted: { updateChannel: 'dev', optimizer: { allowGridCharge: true }, gridConnection: { limitKw: 20, marginW: 1000 } },
      state: { victron: { maxDischargeW: 0 } },
    }),
    clock: ['Date', 'setTimeout', 'setInterval'],
    countBy: 'calls',
    run: async (r, step) => {
      await step('init', mqttInit(r));
      const guard = createGridConnectionGuard({
        getCfg: () => r.cfg, get state() { return r.state; }, pushLog: r.pushLog,
        applyControlTarget: (...a) => r.ev.applyControlTarget(...a),
      });
      const measure = (importW, dischargeW = 0) => {
        const now = Date.now();
        Object.assign(r.state.meter, { ok: true, updatedAt: now - 500, grid_total_w: -importW });
        Object.assign(r.state.victron, { batteryPowerW: -dischargeW, batteryDischargeW: dischargeW, maxDischargeW: dischargeW });
        Object.assign(r.state.victron.fieldUpdatedAt, { soc: now - 500, batteryPowerW: now - 500, maxDischargeW: now - 500 });
      };
      guard.batteryAssist.request({ source: 'p14a', maxImportW: 4200 });
      for (let i = 1; i <= 3; i += 1) {
        await r.advance(2000); measure(10000, i > 1 ? 6000 : 0);
        await step(`Wächter-Takt ${i}`, async () => { guard.tick(); await r.advance(0); return guard.batteryAssist.status('p14a'); });
      }
      r.halt();
      await step('Wächter im Not-Halt', async () => { guard.tick(); await r.advance(0); return null; });
      await step('Wächter im Not-Halt (2)', async () => { guard.tick(); await r.advance(0); return null; });
    },
    expect: (n) => {
      assert.ok(actionsOf(n).includes('maxDischargeW:protectiveLimit'), actionsOf(n).join(','));
      assert.deepEqual(haltedOf(n), ['maxDischargeW:haltNeutralize:ok']);
    },
  };

  // MQTT Venus-Brücke mit Broker: W/-Topics, Bestätigung per N/-Echo, Nachforderung per R/, Keepalive, Flagge 2708
  // direkt über Pfad 1, Not-Halt, Broker getrennt.
  S.p1_mqtt_venus = {
    setup: mqttSetup('bridge-mqtt', { mqtt: { broker: 'mqtt://192.0.2.11:1883' }, persisted: { schedule: { controlWriteVerify: { enabled: true } } } }),
    clock: ['Date', 'setTimeout', 'setInterval'],
    countBy: 'calls',
    run: async (r, step) => {
      await step('init', mqttInit(r));
      r.transport.broker.echo = VENUS_ECHO;
      await step('-500', set(r, 'gridSetpointW', -500, 'rule:abend'));
      await step('Prüfung nach 4 s (Echo)', async () => { await r.advance(4000); return null; });
      await step('-500 gleich', set(r, 'gridSetpointW', -500, 'rule:abend'));
      await step('Keepalive fällig', async () => { await r.advance(1000); return r.ev.applyControlTarget('gridSetpointW', -500, 'rule:abend'); });
      await step('maxDischargeW -1', set(r, 'maxDischargeW', -1, 'api_manual_write'));
      await step('minSocPct 3 (Klemme)', set(r, 'minSocPct', 3, 'api_manual_write'));
      await step('chargeCurrentA 30', set(r, 'chargeCurrentA', 30, 'api_manual_write'));
      await step('dontFeedExcessAcPv 1 direkt', set(r, 'dontFeedExcessAcPv', 1, 'api_manual_write'));
      await step('feedExcessDcPv 0 (§ 51, DV-Weg)', set(r, 'feedExcessDcPv', 0, 'negative_price_protection'));
      await step('Prüfungen nach 4 s', async () => { await r.advance(4000); return null; });
      r.transport.broker.echo = null;
      await step('-800 ohne Echo', set(r, 'gridSetpointW', -800, 'rule:abend'));
      await step('Prüfung nach Mindestabstand (R/)', async () => { await r.advance(26_000); return null; });
      await step('Nachfassen nach 2 s', async () => { await r.advance(2000); return null; });
      r.transport.broker.echo = (topic) => (topic.startsWith('W/') ? [topic.replace(/^W\//, 'N/'), '{"value":-100}'] : null);
      await step('-900, Gegenstelle meldet -100', set(r, 'gridSetpointW', -900, 'rule:abend'));
      await step('Prüfung (abweichend)', async () => { await r.advance(30_000); return null; });
      await step('-900 erneut (lastWrite verworfen)', set(r, 'gridSetpointW', -900, 'rule:abend'));
      r.halt();
      await step('-1000 im Not-Halt', set(r, 'gridSetpointW', -1000, 'rule:abend'));
      r.resume();
      r.transport.broker.client.connected = false;
      await step('-700 Broker getrennt', set(r, 'gridSetpointW', -700, 'rule:abend'));
    },
    expect: (n) => {
      const e = delivered(n);
      assert.ok(e.some((x) => x.point === 'gridSetpointW' && x.outcome === 'error' && x.delivery === 'unknown'), 'getrennt → error/unknown');
      assert.ok(e.filter((x) => x.outcome === 'ok').every((x) => x.delivery === 'unknown' && x.detail === 'no_ack'), 'MQTT ohne Quittung');
      assert.ok(actionsOf(n).includes('dontFeedExcessAcPv:command'));
    },
  };

  S.p1_mqtt_venus_read_only = {
    setup: mqttSetup('bridge-mqtt', { mqtt: { broker: 'mqtt://192.0.2.11:1883' } }),
    clock: ['Date', 'setTimeout', 'setInterval'],
    countBy: 'calls', readOnly: true,
    run: async (r, step) => {
      await step('init', mqttInit(r));
      await step('-500 im Lese-Modus', set(r, 'gridSetpointW', -500, 'rule:abend'));
      await step('maxDischargeW im Lese-Modus', set(r, 'maxDischargeW', 0, 'api_manual_write'));
    },
    expect: (n) => assert.deepEqual(n.out.readOnlyLines, [
      '[READ-ONLY] Schreibzugriff blockiert: MQTT W/c0619ab00000/settings/0/Settings/CGwacs/AcPowerSetPoint',
      '[READ-ONLY] Schreibzugriff blockiert: MQTT W/c0619ab00000/settings/0/Settings/CGwacs/MaxDischargePower',
    ].map((l) => l.replace('c0619ab00000', n.rig.cfg.victron.mqtt?.portalId || 'c0619ab00000'))),
  };

  // DVhub-Schema mit Broker, ohne Rückmeldung: <prefix>/control/*/set; Abholpuffer für Loxone.
  S.p1_mqtt_dvhub_broker = {
    setup: mqttSetup('dvhub-mqtt', { mqtt: { broker: 'mqtt://192.0.2.12:1883' }, persisted: { schedule: { controlWriteVerify: { enabled: true } } } }),
    clock: ['Date', 'setTimeout', 'setInterval'],
    countBy: 'calls',
    run: async (r, step) => {
      await step('init', mqttInit(r));
      await step('-500', set(r, 'gridSetpointW', -500, 'rule:abend'));
      await step('Prüfung nach 4 s', async () => { await r.advance(4000); return null; });
      await step('Nachfassen nach 2 s', async () => { await r.advance(2000); return null; });
      await step('maxDischargeW -1', set(r, 'maxDischargeW', -1, 'api_manual_write'));
      await step('chargeCurrentA 30', set(r, 'chargeCurrentA', 30, 'api_manual_write'));
      await step('minSocPct 20', set(r, 'minSocPct', 20, 'api_manual_write'));
      await step('feedExcessDcPv 0 (§ 51)', set(r, 'feedExcessDcPv', 0, 'negative_price_protection'));
      await step('Abholpuffer (Loxone)', () => loxoneControl(r));
      r.halt();
      await step('-1000 im Not-Halt', set(r, 'gridSetpointW', -1000, 'rule:abend'));
    },
  };

  // DVhub-Schema OHNE Broker (HTTP-Abholung): kein Draht, Ergebnis ok:true/http_pickup; das Tor meldet unknown +
  // pickupPending; die Abholung über GET /api/integration/loxone auch im Not-Halt und bei ungültiger Config.
  S.p1_dvhub_http_pickup = {
    setup: mqttSetup('dvhub-mqtt', { persisted: { schedule: { controlWriteVerify: { enabled: true } } } }),
    clock: ['Date', 'setTimeout', 'setInterval'],
    countBy: 'calls',
    run: async (r, step) => {
      await step('init', mqttInit(r));
      await step('-500', set(r, 'gridSetpointW', -500, 'rule:abend'));
      await step('Prüfung nach 4 s', async () => { await r.advance(4000); return null; });
      await step('Nachfassen nach 2 s', async () => { await r.advance(2000); return null; });
      await step('maxDischargeW 0', set(r, 'maxDischargeW', 0, 'api_manual_write'));
      await step('-500 Keepalive', async () => { await r.advance(5000); return r.ev.applyControlTarget('gridSetpointW', -500, 'rule:abend'); });
      await step('Abholpuffer nach Writes', () => loxoneControl(r));
      r.halt();
      await step('-1000 im Not-Halt', set(r, 'gridSetpointW', -1000, 'rule:abend'));
      await step('Abholpuffer im Not-Halt', () => loxoneControl(r));
      r.resume();
      r.cfg.writeSafety = { ok: false, reason: 'manufacturer_profile_error', manufacturer: 'dvhub-mqtt' };
      await step('-1200 bei writeSafety.ok=false', set(r, 'gridSetpointW', -1200, 'rule:abend'));
      await step('Abholpuffer bei ungültiger Config', () => loxoneControl(r));
    },
    expect: (n) => {
      const e = delivered(n);
      assert.ok(e.length >= 3 && e.every((x) => x.outcome === 'ok' && x.delivery === 'unknown' && x.detail === 'pickupPending'), 'Abholung: unknown + pickupPending');
      assert.equal(n.out.wire.filter((w) => w.startsWith('PUB ')).length, 0, 'ohne Broker kein Draht');
    },
  };

  S.p1_dvhub_http_pickup_read_only = {
    setup: mqttSetup('dvhub-mqtt'),
    clock: ['Date', 'setTimeout', 'setInterval'],
    countBy: 'calls', readOnly: true,
    run: async (r, step) => {
      await step('init', mqttInit(r));
      await step('-500 im Lese-Modus', set(r, 'gridSetpointW', -500, 'rule:abend'));
      await step('Abholpuffer', () => loxoneControl(r));
    },
  };

  // Deye: Sequenz-Flagge ohne eigenes Register über den generischen Einzelregister-Zweig (heute: Register 0, Befund
  // eingefroren); Work-Mode direkt.
  S.p1_deye_direct = {
    setup: profileSetup('deye-lv', { holding: { 142: 1 } }),
    run: async (r, step) => {
      await step('gridSetpointW nicht freigegeben', set(r, 'gridSetpointW', -500, 'rule:abend'));
      await step('workMode 2 direkt', set(r, 'workMode', 2, 'api_manual_write'));
      await step('dontFeedExcessAcPv 1 direkt', set(r, 'dontFeedExcessAcPv', 1, 'api_manual_write'));
    },
  };

  // Fronius: SunSpec-Punkte erst nach dem Scan; danach direkt über Pfad 1.
  S.p1_fronius_sunspec = {
    setup: profileSetup('fronius', { holding: { 40191: 1, 40198: 0xec78 } }),
    run: async (r, step) => {
      await step('wMaxLimPct ohne SunSpec-Scan', set(r, 'wMaxLimPct', 50, 'api_manual_write'));
      r.cfg.controlWrite.wMaxLimPct.address = 40242;
      r.cfg.controlWrite.storCtlMod.address = 40191;
      await step('wMaxLimPct 50 nach dem Scan', set(r, 'wMaxLimPct', 50, 'api_manual_write'));
      await step('storCtlMod 2', set(r, 'storCtlMod', 2, 'api_manual_write'));
      await step('gridSetpointW nicht freigegeben', set(r, 'gridSetpointW', -500, 'rule:abend'));
    },
  };

  return S;
}

// --- Szenarien mit UMGESCHALTETER Not-Halt-Richtlinie (Kind-Prozess) ----------------------------------------------

/**
 * negativePrice und socFloor laufen im Not-Halt weiter (wie bis 1.0.9): die Pflicht-Quelle schreibt den Netz-Sollwert
 * im Not-Halt — auch als Lebenszeichen — über das Tor als protectiveLimit (Lauf-Zulassung mit inHalt). Ein Befehl
 * bleibt gesperrt (schon von der Bestandsprüfung), die eine Rücknahme geht als haltNeutralize.
 */
export function controlTargetFlipScenarios() {
  const S = {};
  S.flip_p1_victron_mandatory_in_halt = {
    setup: victronSetup({ persisted: { optimizer: { allowGridDischarge: true } } }),
    run: async (r, step) => {
      await step('-500 (Regel)', set(r, 'gridSetpointW', -500, 'rule:abend'));
      await step('Peak-Shaving-Freigabe 4000', set(r, 'maxDischargeW', 4000, 'peak_shaving'));
      r.halt();
      await step('-3000 § 51 im Not-Halt', set(r, 'gridSetpointW', -3000, 'negative_price_protection'));
      await r.advance(5000);
      await step('-3000 § 51 Keepalive im Not-Halt', set(r, 'gridSetpointW', -3000, 'negative_price_protection'));
      await step('0 SoC-Boden im Not-Halt', set(r, 'gridSetpointW', 0, 'manual_override_soc_floor'));
      await step('-500 Regel im Not-Halt', set(r, 'gridSetpointW', -500, 'rule:abend'));
      await step('Peak-Shaving-Rücknahme 0', set(r, 'maxDischargeW', 0, 'peak_shaving_restore'));
      await step('§ 51 Entladegrenze im Not-Halt', set(r, 'maxDischargeW', 1000, 'negative_price_protection'));
    },
    expect: (n) => assert.deepEqual(haltedOf(n), [
      'gridSetpointW:protectiveLimit:ok', 'gridSetpointW:protectiveLimit:ok', 'gridSetpointW:protectiveLimit:ok',
      'maxDischargeW:haltNeutralize:ok', 'maxDischargeW:protectiveLimit:ok',
    ]),
  };

  S.flip_p1_mqtt_mandatory_in_halt = {
    setup: mqttSetup('bridge-mqtt', { mqtt: { broker: 'mqtt://192.0.2.11:1883' } }),
    clock: ['Date', 'setTimeout', 'setInterval'],
    countBy: 'calls',
    run: async (r, step) => {
      await step('init', mqttInit(r));
      r.halt();
      await step('-40 § 51 im Not-Halt', set(r, 'gridSetpointW', -40, 'negative_price_protection'));
      await r.advance(5000);
      await step('-40 § 51 Keepalive im Not-Halt', set(r, 'gridSetpointW', -40, 'negative_price_protection'));
      await step('chargeCurrentA Regel im Not-Halt', set(r, 'chargeCurrentA', 10, 'rule:abend'));
    },
    expect: (n) => assert.deepEqual(haltedOf(n), ['gridSetpointW:protectiveLimit:ok', 'gridSetpointW:protectiveLimit:ok']),
  };
  return S;
}
