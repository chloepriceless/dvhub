// C2 × Not-Halt-Rücknahme und manuelle Zwangsfreigabe (Christin 19.11.2026, „denke schon“): Ist die Konfiguration
// ungültig (cfg.writeSafety.ok === false, C2 vom 16.11.2026), sperrte bis dahin JEDE Schreibklasse — auch die eine
// Rücknahme beim Not-Halt (`haltNeutralize`) und die manuelle Zwangsfreigabe (`manualForceRelease`, H-7). Neu: genau
// diese beiden Aktionsklassen dürfen durch — in den Bestandsprüfungen der Pfade (Sungrow submitReg, schedule-eval
// writeConfigUnsafeReason) UND im Tor (Schreibfreigabe `profileInvalid`, VCL-Vertrag v6 D.1 R-T2) —, und zwar nur als
// festes Literal Richtung Grundzustand (2707 = 1, 2708 = 0, WMaxLim_Ena = 0, Sungrow 0xCC/0). Eine Rücknahme auf einen
// gesicherten Wert (restoreBefore: 2704, 2706, Sequenzschritte) bleibt gesperrt: ihre Kodierung käme aus dem ungültigen
// Profil (R-T2.3) bzw. bei victron aus den Code-Vorgaben (wichen bei 2704 ab, Codex a5803519 P1; angeglichen 679625e4). Alles andere (Befehl,
// Lebenszeichen, Schutz-Begrenzung, bequeme Wiederfreigabe) bleibt gesperrt.
//
// Nur bei einem Herstellerprofil-Fehler (writeSafety.reason `manufacturer_profile_error`): dann ist die config.json
// gültig — Verbindung (Host/Port/Unit-ID) ist die des Betreibers; die Adressen kommen bei victron aus den Code-Vorgaben
// (für 2707/2708 gleich dem Profil, geprüft unten), bei jedem anderen Hersteller gibt es KEINE (R-T2.1, config-model.js withoutVictronRegisterMap) — dort
// geht also auch die Rücknahme ins Leere, statt an eine geerbte Victron-Adresse.
// Gesperrt bleibt die kaputte config.json (`config_broken`) und jeder unbekannte Grund: dann gelten die Vorgaben mit
// LEEREM Host — Node verbindet einen leeren Host nach localhost, wo DVhubs eigene Direktvermarkter-Schnittstelle
// (Modbus-Server 0.0.0.0:502) lauscht. Torzustand dafür: `setupIncomplete` (kein Write, auch keine Rücknahme).
// H-8: Min-SoC und Ladestrom werden nie zurückgesetzt; Sungrow 13058/13059 werden nie geschrieben.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfigFile } from '../config-model.js';
import { createSungrowEms, wire } from '../services/inverter/sungrow.js';
import { createLegacyGate, inverterLegacyPolicy, inverterReleaseState, INVERTER_GATE_DEVICE, SUNGROW_GATE_DEVICES } from '../services/gate/legacy.js';
import { createFeedInLimitArbiter } from '../services/feed-in-limit-arbiter.js';
import { setEmergencyStop } from '../services/control-commands.js';
import { HOST, baseState, evaluatorRig, loadProfileConfig, recordingModbus } from './helpers/gate-golden.js';
import { loadSungrowConfig, mockSungrow, sungrowDevice, sungrowImage } from './helpers/sungrow-fixture.js';

const PROFILE_ERROR = (manufacturer) => ({ ok: false, reason: 'manufacturer_profile_error', manufacturer });
const CONFIG_BROKEN = { ok: false, reason: 'config_broken', manufacturer: 'victron' };
const VICTRON_REGS = { 2704: 0xffff, 2706: 0xffff, 2707: 1, 2708: 0 };
const isWrite = (line) => /^W(6|16) /.test(line);

/** Echte Config durch loadConfigFile aus einem Wegwerf-Verzeichnis (config.json-Text, Profildateien). */
function loadReal({ configText, profiles = {} }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-c2-halt-'));
  try {
    fs.mkdirSync(path.join(root, 'hersteller'));
    for (const [id, text] of Object.entries(profiles)) fs.writeFileSync(path.join(root, 'hersteller', `${id}.json`), text);
    fs.writeFileSync(path.join(root, 'config.json'), configText);
    return loadConfigFile(path.join(root, 'config.json')).effectiveConfig;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function victronRig(cfg, state = baseState()) {
  const transport = recordingModbus({ holding: VICTRON_REGS });
  const events = [];
  const rig = evaluatorRig({ cfg, transport, state, events });
  const writes = () => transport.ops.filter(isWrite);
  const halt = () => { state.ctrl.discretionaryWritesPaused = true; state.ctrl.pausedAt = Date.now(); };
  return { ...rig, transport, writes, halt };
}

describe('Schreibfreigabe aus der Config (inverterReleaseState)', () => {
  it('Profilfehler → profileInvalid; kaputte config.json und unbekannter Grund → setupIncomplete', () => {
    assert.equal(inverterReleaseState({}), 'open');
    assert.equal(inverterReleaseState({ writeSafety: { ok: true } }), 'open');
    assert.equal(inverterReleaseState({ writeSafety: PROFILE_ERROR('victron') }), 'profileInvalid');
    assert.equal(inverterReleaseState({ writeSafety: PROFILE_ERROR('sungrow') }), 'profileInvalid');
    assert.equal(inverterReleaseState({ writeSafety: CONFIG_BROKEN }), 'setupIncomplete');
    assert.equal(inverterReleaseState({ writeSafety: { ok: false, reason: 'config_invalid' } }), 'setupIncomplete');
    assert.equal(inverterReleaseState({ writeSafety: { ok: false } }), 'setupIncomplete');
  });

  it('Beleg: kaputte config.json → Vorgaben mit leerem Host (ginge nach localhost) — deshalb keine Rücknahme', () => {
    const cfg = loadReal({ configText: '{ kaputt', profiles: { victron: fs.readFileSync(new URL('../hersteller/victron.json', import.meta.url), 'utf8') } });
    assert.deepEqual(cfg.writeSafety, CONFIG_BROKEN);
    assert.equal(cfg.victron.host, '');
    assert.equal(cfg.dvControl.feedExcessDcPv.host, '');
    assert.equal(cfg.controlWrite.maxDischargeW.host, '');
    assert.equal(inverterReleaseState(cfg), 'setupIncomplete');
  });
});

// Victron mit kaputtem oder fehlendem victron.json (echter Ladeweg, Codex a5803519 P1): Die Schreibpunkte kommen dann
// aus den Code-Vorgaben (createDefaultConfig), NICHT aus dem ausgelieferten Profil — und die weichen ab: 2704 hat dort
// scale 1 ohne Sentinel-Abbildung statt scale 10 mit 0 → roh 0 und −1 → 32767. Eine Rücknahme auf einen gesicherten
// Wert (restoreBefore: 2704, 2706, Sequenzschritte) bräuchte die Kodierung des Profils, das gerade ungültig ist
// (R-T2.3: nicht aus dem jetzt ungültigen Profil) — sie bleibt gesperrt. Durch geht nur eine Rücknahme mit festem
// Grundzustands-Literal: die Freigabe der Einspeisung 2707 = 1 / 2708 = 0.
const brokenVictron = (profileText = '{ kaputt') => loadReal({
  configText: JSON.stringify({ manufacturer: 'victron', victron: { host: HOST } }),
  profiles: profileText == null ? {} : { victron: profileText },
});

describe('Victron mit ungültigem Profil (echter Ladeweg): nur die Literal-Rücknahme 2707/2708 geht durch', () => {
  it('Beleg: Rückfall-Karte = ausgeliefertes Profil, auch 2704 (seit 679625e4); Rücknahmen auf 2704 bleiben trotzdem gesperrt (R-T2.3)', () => {
    const shipped = loadProfileConfig('victron', { victron: { host: HOST } });
    const pick = (c) => c && { address: c.address, fc: c.fc, writeType: c.writeType, scale: c.scale, offset: c.offset, port: c.port, unitId: c.unitId, host: c.host };
    for (const cfg of [brokenVictron(), brokenVictron(null), brokenVictron('')]) {
      assert.deepEqual(cfg.writeSafety, PROFILE_ERROR('victron'));
      for (const k of ['feedExcessDcPv', 'dontFeedExcessAcPv']) assert.deepEqual(pick(cfg.dvControl[k]), pick(shipped.dvControl[k]), k);
      // Vorher wich 2704 ab (scale 1 statt 10, Codex a5803519 P1) — behoben in 679625e4 (test/victron-vorgaben-abgleich).
      // Die Sperre der Rücknahme auf einen gesicherten Wert bleibt: sie gehört zum gültigen Profil (R-T2.3), nicht zur Vorgabe.
      assert.deepEqual(
        { scale: cfg.controlWrite.maxDischargeW.scale, map: cfg.controlWrite.maxDischargeW.rawSentinelMap ?? null },
        { scale: shipped.controlWrite.maxDischargeW.scale, map: shipped.controlWrite.maxDischargeW.rawSentinelMap ?? null },
        '2704: Rückfall-Kodierung = Profil');
    }
  });

  it('DV-Sperre: die eine Freigabe im Not-Halt schreibt 2707 = 1 / 2708 = 0 — als haltNeutralize über das Tor', async () => {
    const r = victronRig(brokenVictron(), baseState({ ctrl: { _lastDvFeedIn: false } })); // eigene Sperre von vorher
    r.halt();
    await r.ev.applyDvVictronControl(true, { reason: 'emergency_stop_release' });
    assert.deepEqual(r.writes(), ['W6 gx/u100 @2707=1', 'W6 gx/u100 @2708=0'], 'Rücknahme trotz C2');
    assert.equal(r.state.ctrl._lastDvFeedIn, true);
  });

  it('außerhalb des Not-Halts bleibt jede Freigabe/Sperre gesperrt (autoRestore, command, protectiveLimit)', async () => {
    const r = victronRig(brokenVictron(), baseState({ ctrl: { _lastDvFeedIn: false } }));
    await r.ev.applyDvVictronControl(true, { reason: 'price_recovered' });
    await r.ev.applyDvVictronControl(true, { explicit: true, reason: 'api_manual_write' });
    await r.ev.applyControlTarget('feedExcessDcPv', 1, 'api_manual_write');
    await r.ev.applyDvVictronControl(false, { reason: 'dv_forced_off' });
    assert.deepEqual(r.writes(), [], 'nichts');
    assert.ok(r.events.includes('control_write_blocked_config_unsafe'), 'Alarm wie bisher');
  });

  it('im Not-Halt: eine neue Sperre bleibt gesperrt (nur die Rücknahme ist frei)', async () => {
    const r = victronRig(brokenVictron());
    r.halt();
    await r.ev.applyDvVictronControl(false, { reason: 'negative_price_protection' });
    await r.ev.applyDvVictronControl(false, { reason: 'dv_forced_off' });
    assert.deepEqual(r.writes(), []);
  });

  it('Einspeisegrenze 2706 (gesicherter Wert, restoreBefore): die Rücknahme im Not-Halt bleibt gesperrt', async () => {
    const cfg = loadProfileConfig('victron', { victron: { host: HOST } });
    const r = victronRig(cfg);
    const arb = createFeedInLimitArbiter({
      applyLimit: (w) => r.ev.applyDvFeedInLimit(w), pushLog: () => {}, isPaused: () => r.state.ctrl.discretionaryWritesPaused === true,
    });
    await arb.set('dv', 3000);
    assert.deepEqual(r.writes(), ['W6 gx/u100 @2706=30'], 'Grenze mit gültigem Profil gesetzt, Wert davor gesichert');
    // Dieselbe Anlage, das Profil ist jetzt kaputt: die wirksame Config an Ort und Stelle tauschen (getCfg liefert dasselbe Objekt).
    const broken = brokenVictron();
    for (const k of Object.keys(cfg)) delete cfg[k];
    Object.assign(cfg, broken);
    const before = r.writes().length;
    const out = await setEmergencyStop({ state: r.state, pushLog: () => {}, feedInLimit: arb }, { on: true });
    assert.equal(out.devices.feedInLimit?.ok, false, JSON.stringify(out.devices.feedInLimit));
    assert.deepEqual(r.writes().slice(before), [], 'kein Write mit der Rückfall-Kodierung');
  });

  it('Entladegrenze 2704 (Peak Shaving, Netzanschluss, Akku-Übergabe): Rücknahme im Not-Halt bleibt gesperrt; H-8', async () => {
    const r = victronRig(brokenVictron(), baseState());
    r.state.schedule.lastWrite.maxDischargeW = { value: 5000, source: 'grid_connection_assist', at: Date.now() };
    r.halt();
    for (const [target, value, source] of [
      ['maxDischargeW', 0, 'peak_shaving_restore'], ['maxDischargeW', 3000, 'grid_connection_restore'],
      ['gridSetpointW', -500, 'rule:abend'], ['chargeCurrentA', 20, 'api_manual_write'], ['minSocPct', 30, 'api_manual_write'],
      ['maxDischargeW', 2000, 'api_manual_write'],
    ]) {
      const res = await r.ev.applyControlTarget(target, value, source);
      assert.equal(res.ok, false, `${target} ${source}`);
    }
    assert.deepEqual(r.writes(), [], 'kein 2704-Write mit scale 1 (wäre 10-fach) und nichts sonst');
  });
});

describe('Fronius (Nulleinspeise-Deckel, Pfad 5): das eine Abräumen im Not-Halt trotz ungültigem Profil', () => {
  // Mit einem echten Profilfehler hätte Fronius keine Schreibpunkte (R-T2.1); writeSafety deshalb auf eine geladene
  // Fronius-Config gesetzt (wie test/helpers/dv-parity-scenarios.js p5_zfi_write_safety), Punkte wie nach dem SunSpec-Scan.
  const ZFI_ADDR = { storCtlMod: 40191, outWRte: 40198, wMaxLimPct: 40242, wMaxLimPctRvrtTms: 40244, wMaxLimEna: 40246 };
  function froniusRig({ halted }) {
    const cfg = loadProfileConfig('fronius', { victron: { host: HOST } });
    for (const [k, a] of Object.entries(ZFI_ADDR)) cfg.controlWrite[k].address = a;
    const transport = recordingModbus({ holding: { [ZFI_ADDR.wMaxLimPct]: 5000 } });
    const state = baseState({
      ctrl: { _lastDvFeedIn: true, _zfi: { capActive: true, limitPct: 50, exportStreak: 0, blockedStreak: 0, lastReadbackAt: 0, lastErrLogAt: 0 } },
    });
    const events = [];
    const rig = evaluatorRig({ cfg, transport, state, events });
    cfg.writeSafety = PROFILE_ERROR('fronius');
    if (halted) { state.ctrl.discretionaryWritesPaused = true; state.ctrl.pausedAt = Date.now(); }
    return { ...rig, writes: () => transport.ops.filter(isWrite) };
  }

  it('im Not-Halt: WMaxLim_Ena = 0 genau einmal', async () => {
    const r = froniusRig({ halted: true });
    await r.ev.zeroFeedInTick();
    await r.ev.zeroFeedInTick();
    assert.deepEqual(r.writes(), [`W6 gx/u${r.cfg.controlWrite.wMaxLimEna.unitId} @${ZFI_ADDR.wMaxLimEna}=0`]);
    assert.equal(r.state.ctrl._zfi.capActive, false);
  });

  it('außerhalb des Not-Halts bleibt das Abräumen gesperrt (autoRestore)', async () => {
    const r = froniusRig({ halted: false });
    await r.ev.zeroFeedInTick();
    assert.deepEqual(r.writes(), []);
    assert.equal(r.state.ctrl._zfi.capActive, true, 'Deckel-Zustand unverändert');
  });
});

describe('Kaputte config.json (config_broken): weiter KEIN Write, auch keine Rücknahme', () => {
  it('DV-Freigabe, Einspeisegrenze und Entladegrenze im Not-Halt bleiben gesperrt; das Tor sperrt ebenso', async () => {
    const cfg = loadProfileConfig('victron', { victron: { host: HOST } });
    const r = victronRig(cfg);
    await r.ev.applyDvVictronControl(false, { reason: 'negative_price_protection' });
    const arb = createFeedInLimitArbiter({
      applyLimit: (w) => r.ev.applyDvFeedInLimit(w), pushLog: () => {}, isPaused: () => r.state.ctrl.discretionaryWritesPaused === true,
    });
    await arb.set('dv', 3000);
    const before = r.writes().length;
    cfg.writeSafety = CONFIG_BROKEN;
    await setEmergencyStop({ state: r.state, pushLog: () => {}, feedInLimit: arb }, { on: true });
    await r.ev.applyDvVictronControl(true, { reason: 'emergency_stop_release' });
    await r.ev.applyControlTarget('maxDischargeW', 0, 'peak_shaving_restore');
    assert.deepEqual(r.writes().slice(before), [], 'nichts geht hinaus');
    assert.ok(r.events.includes('control_write_blocked_config_unsafe'));
  });

  it('Tor: setupIncomplete sperrt auch Not-Halt-Durchgang und Zwangsfreigabe', async () => {
    let halted = true;
    const gate = createLegacyGate({ isHalted: () => halted });
    const sent = [];
    gate.attachSink('dev', { kind: 'modbus', legacy: { mbWriteSingle: async (a) => { sent.push(a); return {}; } } });
    gate.setPolicies({
      dev: { emsCmd: { class: 'battery_grid', resource: 'batteryControl', sink: 'dev', neutral: { kind: 'sequence', use: 'release' }, neutralValues: [0xcc] } },
    });
    const op = (action, extra = {}) => ({
      device: 'dev', point: 'emsCmd', value: 0xcc, source: 't', kind: 'neutralize', action, lease: null,
      constraints: { set: {}, caps: {}, enforcedBy: [] }, validUntilMs: null, tick: { loop: 'event', seq: 1 }, step: 0,
      legacy: { sink: 'dev', fn: 'mbWriteSingle', args: [{ host: HOST, port: 502, unitId: 1, address: 13050, value: 0xcc }] }, ...extra,
    });
    gate.setRelease('dev', inverterReleaseState({ writeSafety: CONFIG_BROKEN }));
    for (const res of [await gate.submit(op('haltNeutralize')), await gate.submit(op('manualForceRelease', { confirmedBy: 'operator:t' }))]) {
      assert.deepEqual([res.outcome, res.detail], ['blocked_gate', 'setup_incomplete']);
    }
    gate.setRelease('dev', inverterReleaseState({ writeSafety: PROFILE_ERROR('sungrow') }));
    assert.equal((await gate.submit(op('haltNeutralize'))).outcome, 'ok');
    assert.equal((await gate.submit(op('manualForceRelease', { confirmedBy: 'operator:t' }))).outcome, 'ok');
    halted = false;
    for (const action of ['command', 'keepalive', 'protectiveLimit', 'autoRestore']) {
      const res = await gate.submit(op(action, { kind: 'write' }));
      assert.deepEqual([res.outcome, res.detail], ['blocked_gate', 'profile_invalid'], `${action} bleibt gesperrt`);
    }
    assert.equal(sent.length, 2);
  });
});

describe('Tor bei profileInvalid: Rücknahme nur als festes Grundzustands-Literal (Codex a5803519 P1, R-T2.3)', () => {
  it('haltNeutralize/manualForceRelease mit Literal → durch; mit gesichertem Wert (restoreBefore) → gesperrt', async () => {
    const gate = createLegacyGate({ isHalted: () => true });
    const sent = [];
    gate.attachSink(INVERTER_GATE_DEVICE, { kind: 'modbus', legacy: { mbWriteSingle: async (a) => { sent.push(a.address); return {}; } } });
    gate.setDevicePolicies(INVERTER_GATE_DEVICE, Object.fromEntries(
      ['feedExcessDcPv', 'dontFeedExcessAcPv', 'maxDischargeW', 'dvFeedInLimitW'].map((p) => [p, inverterLegacyPolicy(p)]),
    ));
    gate.setRelease(INVERTER_GATE_DEVICE, inverterReleaseState({ writeSafety: PROFILE_ERROR('victron') }));
    const op = (point, value, address, action = 'haltNeutralize', extra = {}) => ({
      device: INVERTER_GATE_DEVICE, point, value, source: 'emergency_stop_release', kind: 'neutralize', action, lease: null,
      constraints: { set: {}, caps: {}, enforcedBy: [] }, validUntilMs: null, tick: { loop: 'eval', seq: address }, step: 0,
      legacy: { sink: INVERTER_GATE_DEVICE, fn: 'mbWriteSingle', args: [{ host: HOST, port: 502, unitId: 100, address, value }] }, ...extra,
    });
    // Im Not-Halt zugelassener Lauf wie applyDvVictronControl/applyDvFeedInLimit (inHalt = die Regel des Pfads).
    const run = gate.admitLegacyRun(INVERTER_GATE_DEVICE, { inHalt: 'emergency_stop_release' });
    const verdict = async (o) => { const res = await gate.submit(o, { run }); return [res.outcome, res.detail ?? null]; };
    assert.deepEqual(await verdict(op('feedExcessDcPv', 1, 2707)), ['ok', null]);
    assert.deepEqual(await verdict(op('dontFeedExcessAcPv', 0, 2708)), ['ok', null]);
    assert.deepEqual(await verdict(op('feedExcessDcPv', 0, 2707)), ['blocked_gate', 'profile_invalid'], 'kein Sperr-Wert unter dem Namen der Rücknahme');
    assert.deepEqual(await verdict(op('maxDischargeW', 5000, 2704)), ['blocked_gate', 'profile_invalid'], '2704 auf gesicherten Wert');
    assert.deepEqual(await verdict(op('dvFeedInLimitW', -1, 2706)), ['blocked_gate', 'profile_invalid'], '2706 auf gesicherten Wert');
    assert.deepEqual(sent, [2707, 2708]);
    gate.setRelease(INVERTER_GATE_DEVICE, 'open');
    assert.deepEqual(await verdict(op('maxDischargeW', 5000, 2704)), ['ok', null], 'mit gültigem Profil wie bisher (Legacy: Wert hält der Pfad)');
  });
});

describe('R-T2.1: ungültiges Nicht-Victron-Profil — keine geerbte Victron-Adresse, auch nicht für die Rücknahme', () => {
  it('kaputtes Sungrow-Profil (echter Ladeweg): Not-Halt-Freigabe der DV-Sperre und Rücknahmen schreiben nichts', async () => {
    const cfg = loadReal({
      configText: JSON.stringify({ manufacturer: 'sungrow', victron: { host: HOST } }),
      profiles: { sungrow: '{ kaputt' },
    });
    assert.deepEqual(cfg.writeSafety, PROFILE_ERROR('sungrow'));
    assert.deepEqual(cfg.controlWrite, {}, 'keine Schreibpunkte');
    assert.equal(cfg.dvControl.feedExcessDcPv, undefined);
    const r = victronRig(cfg, baseState({ ctrl: { _lastDvFeedIn: false } }));
    r.halt();
    await r.ev.applyDvVictronControl(true, { reason: 'emergency_stop_release' });
    await r.ev.applyDvFeedInLimit(null).catch(() => {});
    await r.ev.applyControlTarget('maxDischargeW', 0, 'peak_shaving_restore');
    assert.deepEqual(r.writes(), [], 'kein Write an eine Victron-Werksadresse (2704/2706/2707/2708)');
  });
});

// --- Sungrow-EMS: Rücknahme 13051 = 0xCC / 13050 = 0, nie 13058/13059 (H-8) ----------------------------------------
// Mit einem echten Profilfehler fehlt der Sungrow-Schreibblock ganz (sungrowEmsConf → null, R-T2.1) — dann schreibt der
// Aktuator ohnehin nichts. Diese Prüfungen setzen writeSafety deshalb auf eine geladene Sungrow-Config (wie
// test/gate-sungrow-parity.test.js) und zeigen die Bestandsprüfung in submitReg selbst.
function sungrowRig() {
  const cfg = loadSungrowConfig({ gridPositiveMeans: 'grid_import', sungrow: { controlMode: 'forced', heartbeatTimeoutS: 30, secondInverter: { host: '192.168.68.83' } } });
  const mock = mockSungrow(sungrowImage());
  const log = [];
  const transport = {
    type: 'modbus',
    mbRequest: (c) => mock.mbRequest(c),
    mbWriteSingle: async (c) => { log.push(`${c.address}=${c.value}`); return mock.mbWriteSingle(c); },
    mbWriteMultiple: async (c) => { log.push(`${c.address}=[${c.values.join(',')}]`); return mock.mbWriteMultiple(c); },
  };
  let clock = 1_000_000;
  const now = () => clock;
  const state = {
    victron: {
      errors: {}, fieldUpdatedAt: { batteryPowerW: clock, pvPowerW: clock, selfConsumptionW: clock }, device: sungrowDevice({ bdcRatedW: 3000 }),
      batteryPowerW: -500, pvPowerW: 0, selfConsumptionW: 500,
    },
    meter: { ok: true, updatedAt: clock, grid_total_w: 0 }, ctrl: {},
  };
  const events = [];
  const logs = [];
  const gate = createLegacyGate({ isHalted: () => state.ctrl?.discretionaryWritesPaused === true, onEvent: (e) => events.push(e) });
  const ems = createSungrowEms({ state, getCfg: () => cfg, transport, pushLog: (e) => logs.push(e), now, gate });
  const ctx = { state, sungrowEms: ems, pushLog: () => {}, gate };
  return { cfg, state, log, ems, ctx, events, logs, gate, advance: (ms) => { clock += ms; } };
}
const CMD = wire(13051);
const MODE = wire(13050);

describe('Sungrow: Not-Halt-Rücknahme und manuelle Zwangsfreigabe trotz ungültigem Profil', () => {
  it('manuelle Zwangsfreigabe (H-7) schreibt Befehl 0xCC und Modus 0 — als manualForceRelease über das Tor', async () => {
    const r = sungrowRig();
    await r.ems.applySetpoint(-6000, 'rule:abend');
    assert.ok(r.log.length > 0, 'Forced-Betrieb steht');
    r.cfg.writeSafety = PROFILE_ERROR('sungrow');
    const n = r.log.length;
    const out = await r.ems.forceRelease('manual_release');
    assert.deepEqual(r.log.slice(n), [`${CMD}=204`, `${MODE}=0`]);
    assert.equal(out.ok, true);
    const manual = r.events.filter((e) => e.action === 'manualForceRelease').map((e) => `${e.point}=${e.value.eng}:${e.outcome}`);
    assert.deepEqual(manual, ['emsCmd=204:ok', 'emsMode=0:ok']);
    assert.equal(r.gate.releaseState(SUNGROW_GATE_DEVICES.master), 'profileInvalid');
  });

  it('Not-Halt-Eintritt nimmt den eigenen Forced-Betrieb einmal zurück — als haltNeutralize über das Tor', async () => {
    const r = sungrowRig();
    await r.ems.applySetpoint(-6000, 'rule:abend');
    r.cfg.writeSafety = PROFILE_ERROR('sungrow');
    const n = r.log.length;
    const out = await setEmergencyStop(r.ctx, { on: true });
    assert.deepEqual(out.devices.batteryEms, { ok: true });
    assert.deepEqual(r.log.slice(n), [`${CMD}=204`, `${MODE}=0`]);
    assert.deepEqual(r.events.filter((e) => e.action === 'haltNeutralize').map((e) => `${e.point}=${e.value.eng}:${e.outcome}`), ['emsCmd=204:ok', 'emsMode=0:ok']);
  });

  it('alles andere bleibt bei ungültigem Profil gesperrt: Sollwert, Takt, Rückgabe beim Beenden außerhalb des Not-Halts', async () => {
    const r = sungrowRig();
    await r.ems.applySetpoint(-6000, 'rule:abend');
    r.cfg.writeSafety = PROFILE_ERROR('sungrow');
    const n = r.log.length;
    await r.ems.applySetpoint(-3000, 'rule:abend');
    r.advance(6000);
    await r.ems.tick();
    await r.ems.releaseControl('shutdown');
    assert.deepEqual(r.log.slice(n), []);
    assert.ok(r.logs.includes('sungrow_write_blocked_config_unsafe'));
  });

  it('kaputte config.json: weder Zwangsfreigabe noch Not-Halt-Rücknahme schreiben', async () => {
    const r = sungrowRig();
    await r.ems.applySetpoint(-6000, 'rule:abend');
    r.cfg.writeSafety = CONFIG_BROKEN;
    const n = r.log.length;
    await r.ems.forceRelease('manual_release');
    await setEmergencyStop(r.ctx, { on: true });
    assert.deepEqual(r.log.slice(n), []);
    assert.equal(r.gate.releaseState(SUNGROW_GATE_DEVICES.master), 'setupIncomplete');
  });

  it('H-8: kein Write an Min-/Max-SoC (13058/13059) — auch nicht in Rücknahme oder Zwangsfreigabe', async () => {
    const r = sungrowRig();
    await r.ems.applySetpoint(-6000, 'rule:abend');
    r.cfg.writeSafety = PROFILE_ERROR('sungrow');
    await r.ems.forceRelease('manual_release');
    await r.ems.applySetpoint(-6000, 'rule:abend');
    await setEmergencyStop(r.ctx, { on: true });
    const addrs = new Set(r.log.map((l) => Number(l.split('=')[0])));
    for (const a of [wire(13058), wire(13059)]) assert.equal(addrs.has(a), false, `Register ${a + 1}`);
    assert.equal(INVERTER_GATE_DEVICE, 'inverter');
  });
});
