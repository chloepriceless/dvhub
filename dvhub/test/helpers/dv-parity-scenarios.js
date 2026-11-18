// test/helpers/dv-parity-scenarios.js — Szenarien des Paritätsnachweises der Abregel-Pfade (H-1 Phase 3, VCL-Vertrag
// v6 D.2/D.4(2)). Gefahren von test/gate-dv-parity.test.js (Not-Halt-Richtlinie ab Werk) und
// test/helpers/dv-parity-policy-flip.mjs (Richtlinie umgeschaltet, Kind-Prozess). Jedes Szenario: setup(onWrite) →
// Rig-Optionen, run(rig, step), optional readOnly, clock, expect(neueSeite).

import assert from 'node:assert/strict';

import { HOST, loadProfileConfig, baseState } from './gate-golden.js';
import { sungrowDevice } from './sungrow-fixture.js';
import { parityModbus } from './dv-parity-rig.js';
import { createFeedInLimitArbiter } from '../../services/feed-in-limit-arbiter.js';
import { setEmergencyStop } from '../../services/control-commands.js';

const SG_HOST = '192.0.2.50';                       // passt zu sungrowDevice().endpointKey
const ALIAS = { [HOST]: 'gx', [SG_HOST]: 'sg' };
const FRONIUS_REGS = { 40191: 1, 40198: 0xec78 };   // Kundenwerte: StorCtl_Mod 1, OutWRte −50,00 %
const DEYE_REGS = { 142: 1 };                       // Kunden-Work-Mode 1
const SUNGROW_REGS = { 13073: 5000, 13086: 0xaa, 13087: 700, 31221: 0xffff };
const VICTRON_REGS = { 2706: 0xffff, 2707: 1, 2708: 0 }; // 2706 ab Werk -1 (keine Grenze), Einspeisung frei

const LOCK = { reason: 'negative_price_protection' };
const RELEASE = { reason: 'price_recovered' };

function froniusCfg(persisted = {}) {
  const cfg = loadProfileConfig('fronius', { victron: { host: HOST }, ...persisted });
  cfg.controlWrite.storCtlMod.address = 40191;      // SunSpec-Scan (polling.js) nachgestellt
  cfg.controlWrite.outWRte.address = 40198;
  return cfg;
}

/** Rig-Optionen je Profil; transport-Optionen wie recordingModbus. */
function profileSetup(profile, { transport = {}, ctrl = {}, victron = {}, files = {}, persisted = {}, holding: regs = null } = {}) {
  return (onWrite) => {
    let cfg;
    let holding;
    let device = null;
    if (profile === 'victron') { cfg = loadProfileConfig('victron', { victron: { host: HOST }, ...persisted }); holding = VICTRON_REGS; }
    if (profile === 'fronius') { cfg = froniusCfg(persisted); holding = FRONIUS_REGS; }
    if (profile === 'deye-lv') { cfg = loadProfileConfig('deye-lv', { victron: { host: HOST }, ...persisted }); holding = DEYE_REGS; }
    if (profile === 'sungrow') {
      cfg = loadProfileConfig('sungrow', { updateChannel: 'dev', victron: { host: SG_HOST }, ...persisted });
      holding = SUNGROW_REGS;
      device = sungrowDevice();
    }
    if (regs) holding = regs;
    return {
      cfg,
      // je Seite eine eigene Kopie: ein Szenario darf failWrite/failRead zur Laufzeit ändern
      transport: parityModbus({ holding, hostAlias: ALIAS, ...structuredClone(transport) }, onWrite),
      state: () => baseState({ ctrl, victron: { ...(device ? { device } : {}), ...victron } }),
      files: structuredClone(files),
    };
  };
}

const dvState = (r) => ({ dv: r.state.ctrl.dvControl ?? null, lastFeedIn: r.state.ctrl._lastDvFeedIn ?? null, partial: r.state.ctrl._dvPartialBlock ?? null });
const dv = (r, feedIn, opts = {}) => async () => { await r.ev.applyDvVictronControl(feedIn, opts); return dvState(r); };
const api = (r, value) => async () => ({ res: await r.ev.applyControlTarget('feedExcessDcPv', value, 'api_manual_write'), ...dvState(r) });

// Pfad 4: Einspeisegrenze direkt, über den echten Begrenzer (wie server.js) und den echten Not-Halt-Eintritt.
const limit = (r, w) => async () => { await r.ev.applyDvFeedInLimit(w); return { saved: r.state.ctrl._dvSeqSaved?.dvFeedInLimitW ?? null }; };
const arbiterOf = (r) => createFeedInLimitArbiter({
  applyLimit: (w) => r.ev.applyDvFeedInLimit(w), pushLog: r.pushLog, isPaused: () => r.state.ctrl.discretionaryWritesPaused === true,
});
const stopCtx = (r, arb) => ({ state: r.state, pushLog: r.pushLog, feedInLimit: arb, ...(r.gate ? { gate: r.gate } : {}) });
const emergency = (r, arb, on) => () => setEmergencyStop(stopCtx(r, arb), { on });

const actionsOf = (r) => r.events.filter((e) => e.outcome === 'ok' || e.outcome === 'error').map((e) => `${e.point}:${e.action}`);

// --- Szenarien -----------------------------------------------------------------------------------------------------
/** Szenarien des Hauptnachweises (Not-Halt-Richtlinie ab Werk). */
export function mainScenarios() {
const SCENARIOS = {};

for (const profile of ['fronius', 'deye-lv', 'sungrow']) {
  SCENARIOS[`p2_${profile}_cycle`] = {
    setup: profileSetup(profile),
    run: async (r, step) => {
      await step('Sperre (§51)', dv(r, false, LOCK));
      await step('Sperre gleich', dv(r, false, LOCK));
      await step('Freigabe automatisch', dv(r, true, RELEASE));
      await step('Freigabe gleich', dv(r, true, RELEASE));
      await step('Sperre DV (forcedOff)', dv(r, false, { reason: 'dv_forced_off' }));
      // Chokepoint: delegiert nur feedExcessDcPv (Deye sperrt über dontFeedExcessAcPv — Befund eingefroren).
      await step('Freigabe per API', api(r, 1));
      await step('Sperre per Regel', dv(r, false, { reason: 'rule:abend' }));
      await step('Freigabe ausdrücklich am DV-Aktuator', dv(r, true, { explicit: true, reason: 'api_manual_write' }));
      await step('Sperre per API', api(r, 0));
    },
  };

  SCENARIOS[`p2_${profile}_restart`] = {
    setup: profileSetup(profile),
    run: async (r, step) => {
      await step('Start-Freigabe ohne Sicherung', dv(r, true, RELEASE));
      await step('Sperre (legt Sicherung an)', dv(r, false, LOCK));
      r.restart(); // frischer Zustand, dieselbe Sicherung, dasselbe Gerät
      await step('Start-Freigabe mit eigener Sicherung', dv(r, true, RELEASE));
      await step('Sperre nach Neustart', dv(r, false, LOCK));
      r.restart();
      await step('Start-Freigabe ausdrücklich ohne Sicherung', dv(r, true, { explicit: true, reason: 'api_manual_write' }));
    },
  };

  SCENARIOS[`p2_${profile}_read_only`] = {
    setup: profileSetup(profile), readOnly: true,
    run: async (r, step) => {
      await step('Sperre im Lese-Modus', dv(r, false, LOCK));
      await step('Freigabe ausdrücklich im Lese-Modus', dv(r, true, { explicit: true, reason: 'api_manual_write' }));
    },
  };

  SCENARIOS[`p2_${profile}_write_safety`] = {
    setup: profileSetup(profile),
    run: async (r, step) => {
      await step('Sperre', dv(r, false, LOCK));
      r.cfg.writeSafety = { ok: false, reason: 'manufacturer_profile_error', manufacturer: profile };
      await step('Freigabe bei writeSafety.ok=false', dv(r, true, RELEASE));
      await step('Freigabe per API bei writeSafety.ok=false', api(r, 1));
      r.cfg.writeSafety = { ok: true };
      await step('Freigabe danach', dv(r, true, RELEASE));
    },
  };

  // Not-Halt: Sperre im Not-Halt gesperrt (heute keine weiterlaufende Pflicht-Klasse, policy.js), die eine Freigabe
  // der eigenen Sperre (emergency_stop_release) schreibt — über das Tor als haltNeutralize.
  SCENARIOS[`p2_${profile}_nothalt`] = {
    setup: profileSetup(profile),
    run: async (r, step) => {
      await step('Sperre (§51)', dv(r, false, LOCK));
      r.halt();
      await step('Sperre im Not-Halt (§51)', dv(r, false, LOCK));
      await step('Freigabe im Not-Halt ohne Not-Halt-Grund', dv(r, true, RELEASE));
      await step('Freigabe im Not-Halt (emergency_stop_release)', dv(r, true, { reason: 'emergency_stop_release' }));
      await step('zweite Freigabe im Not-Halt', dv(r, true, { reason: 'emergency_stop_release' }));
      await step('Sperre per API im Not-Halt', api(r, 0));
      r.resume();
      await step('Sperre nach dem Aufheben', dv(r, false, LOCK));
    },
    expect: (n) => {
      const halted = n.rig.events.filter((e) => e.state_flags.not_halt);
      assert.ok(halted.length > 0 || profile === 'deye-lv', 'Freigabe im Not-Halt lief über das Tor');
      assert.ok(halted.every((e) => e.action === 'haltNeutralize' && e.outcome === 'ok'), 'im Not-Halt nur der Durchgang');
    },
  };
}

SCENARIOS.p2_fronius_actions = {
  setup: profileSetup('fronius'),
  run: async (r, step) => {
    await step('Sperre (§51)', dv(r, false, LOCK));
    await step('Freigabe automatisch', dv(r, true, RELEASE));
    await step('Sperre per Regel', dv(r, false, { reason: 'rule:abend' }));
    await step('Freigabe per API', api(r, 1));
  },
  expect: (n) => assert.deepEqual(actionsOf(n.rig), [
    'storCtlMod:protectiveLimit', 'outWRte:protectiveLimit',
    'storCtlMod:autoRestore', 'outWRte:autoRestore',
    'storCtlMod:command', 'outWRte:command',
    'storCtlMod:command', 'outWRte:command',
  ]),
};

// Not-Halt beginnt MITTEN in der Sperr-Folge (nach StorCtl_Mod, vor OutWRte): heute schreibt die Folge zu Ende.
SCENARIOS.p2_fronius_halt_mid_sequence = {
  setup: profileSetup('fronius'),
  run: async (r, step) => {
    r.onWrite((entry) => { if (entry === 'W6 gx/u1 @40191=2') r.halt(); });
    await step('Sperre, Not-Halt nach Schritt 1', dv(r, false, LOCK));
    r.onWrite(null);
    await step('Freigabe im Not-Halt (emergency_stop_release)', dv(r, true, { reason: 'emergency_stop_release' }));
    await step('zweite Freigabe', dv(r, true, { reason: 'emergency_stop_release' }));
  },
  expect: (n) => assert.deepEqual(n.rig.events.map((e) => `${e.point}:${e.action}:${e.outcome}:${e.state_flags.not_halt}`), [
    // Ereignis nach der Antwort der Senke: der Not-Halt kam während des ersten Writes (Haken nach dem Draht)
    'storCtlMod:protectiveLimit:ok:true', 'outWRte:protectiveLimit:ok:true',
    'storCtlMod:haltNeutralize:ok:true', 'outWRte:haltNeutralize:ok:true',
  ]),
};

SCENARIOS.p2_sungrow_halt_mid_sequence = {
  setup: profileSetup('sungrow'),
  run: async (r, step) => {
    r.onWrite((entry) => { if (entry.startsWith('W6 sg/u1 @13073=')) r.halt(); });
    await step('Sperre, Not-Halt nach 13074', dv(r, false, LOCK));
    r.onWrite(null);
    await step('Freigabe im Not-Halt', dv(r, true, { reason: 'emergency_stop_release' }));
  },
};

// Vor dem Not-Halt begonnene Sperre per Regel (command): heute schreibt sie zu Ende — auch über das Tor.
SCENARIOS.p2_fronius_halt_mid_command = {
  setup: profileSetup('fronius'),
  run: async (r, step) => {
    r.onWrite((entry) => { if (entry === 'W6 gx/u1 @40191=2') r.halt(); });
    await step('Sperre per Regel, Not-Halt nach Schritt 1', dv(r, false, { reason: 'rule:abend' }));
  },
  expect: (n) => assert.deepEqual(n.rig.events.map((e) => `${e.point}:${e.action}:${e.outcome}`), ['storCtlMod:command:ok', 'outWRte:command:ok']),
};

// Not-Halt zwischen dem Sichern (Lesen) und dem ersten Write: der Lauf ist am Eingang entschieden, er schreibt.
SCENARIOS.p2_deye_halt_after_save_read = {
  setup: profileSetup('deye-lv'),
  run: async (r, step) => {
    r.onWrite((entry) => { if (entry.startsWith('R3 ')) r.halt(); });
    await step('Sperre (§51), Not-Halt nach dem Sichern', dv(r, false, LOCK));
    r.onWrite(null);
    await step('Freigabe im Not-Halt', dv(r, true, { reason: 'emergency_stop_release' }));
  },
  expect: (n) => assert.deepEqual(n.rig.events.map((e) => `${e.point}:${e.action}:${e.state_flags.not_halt}`), [
    'workMode:protectiveLimit:true', 'workMode:haltNeutralize:true',
  ]),
};

// Neustart IM Not-Halt mit eigener Sicherung: die eine Freigabe stellt die Kundenwerte zurück.
SCENARIOS.p2_fronius_restart_in_halt = {
  setup: profileSetup('fronius'),
  run: async (r, step) => {
    await step('Sperre (legt Sicherung an)', dv(r, false, LOCK));
    r.restart();
    r.halt();
    await step('Freigabe im Not-Halt nach Neustart', dv(r, true, { reason: 'emergency_stop_release' }));
  },
};

// A11: Teil-Sperre (OutWRte scheitert) → Freigabe per API und im Not-Halt.
SCENARIOS.p2_fronius_partial = {
  setup: profileSetup('fronius', { transport: { failWrite: { 40198: { msg: 'modbus timeout', times: 1 } } } }),
  run: async (r, step) => {
    await step('Sperre, OutWRte Zeitüberschreitung', dv(r, false, LOCK));
    await step('Freigabe der Teil-Sperre per API', api(r, 1));
    r.transport.failWrite[40198] = { msg: 'modbus write verworfen (Not-Halt seit dem Einreihen)', times: 1 };
    await step('Sperre, OutWRte verworfen', dv(r, false, LOCK));
    r.halt();
    await step('Freigabe der Teil-Sperre im Not-Halt', dv(r, true, { reason: 'emergency_stop_release' }));
    await step('zweite Freigabe im Not-Halt', dv(r, true, { reason: 'emergency_stop_release' }));
  },
};

SCENARIOS.p2_sungrow_budget_exhausted = {
  setup: profileSetup('sungrow', { files: { 'dv_seq_writeday.json': { key: new Date(Date.UTC(2026, 10, 18, 10)).toDateString(), count: 20 } } }),
  run: async (r, step) => {
    await step('Sperre bei leerem Budget', dv(r, false, LOCK));
    await step('Automatik-Freigabe bei leerem Budget', dv(r, true, RELEASE));
    await step('Freigabe per API bei leerem Budget', api(r, 1));
  },
};

SCENARIOS.p2_fronius_budget_last = {
  setup: profileSetup('fronius', { files: { 'dv_seq_writeday.json': { key: new Date(Date.UTC(2026, 10, 18, 10)).toDateString(), count: 19 } } }),
  run: async (r, step) => {
    await step('Sperre (letzte Sequenz im Budget)', dv(r, false, LOCK));
    await step('Automatik-Freigabe bei leerem Budget', dv(r, true, RELEASE));
    await step('ausdrückliche Freigabe bei leerem Budget', dv(r, true, { explicit: true, reason: 'api_manual_write' }));
  },
};

// Rücklesung (verify) weicht ab: Gerät verwirft 13074 still → Sequenz bricht nach Schritt 2 ab → Teil-Sperre.
SCENARIOS.p2_sungrow_readback_mismatch = {
  setup: profileSetup('sungrow', { transport: { ignoreWrite: [13073] } }),
  run: async (r, step) => {
    await step('Sperre, 13074 wird verworfen', dv(r, false, LOCK));
    await step('Freigabe der Teil-Sperre', dv(r, true, RELEASE));
  },
};

SCENARIOS.p2_sungrow_verify_inconclusive = {
  setup: profileSetup('sungrow', { transport: { failRead: { 13087: { msg: 'modbus exception 4', skip: 1, times: 2 } } } }),
  run: async (r, step) => { await step('Sperre, Rücklesung 13088 unklar', dv(r, false, LOCK)); },
};

// Modbus-Ausnahmen: Rückstell-Write mit Ausnahme 4 bei übernommenem Wert (M14), alte Firmware ohne 13088 (Ausnahme
// 2, optionaler Schritt), Sperr-Write mit Ausnahme 3 (abgelehnt).
SCENARIOS.p2_sungrow_modbus_exceptions = {
  setup: profileSetup('sungrow'),
  run: async (r, step) => {
    await step('Sperre', dv(r, false, LOCK));
    r.transport.failWrite[13086] = { msg: 'modbus exception 4', apply: true, times: 1 };
    await step('Freigabe, 13087 mit Ausnahme 4 (Wert übernommen)', dv(r, true, RELEASE));
    // 13088 liest noch, verweigert aber den Write (Ausnahme 2) → optionaler Schritt fällt weg (NEU1)
    r.transport.failWrite[13087] = 'modbus exception 2';
    await step('Sperre, 13088 Write Ausnahme 2', dv(r, false, LOCK));
    await step('Freigabe, 13088 Write Ausnahme 2', dv(r, true, RELEASE));
    r.transport.failRead[13087] = 'modbus exception 2';
    await step('Sperre ohne 13088 (alte Firmware)', dv(r, false, LOCK));
    await step('Freigabe ohne 13088', dv(r, true, RELEASE));
    r.transport.failWrite[13086] = { msg: 'modbus exception 4', times: 1 };
    await step('Sperre, 13087 Ausnahme 4 beim Sperren', dv(r, false, LOCK));
  },
  expect: (n) => {
    assert.ok(n.rig.events.some((e) => e.outcome === 'error' && e.delivery === 'unknown' && e.detail === undefined), 'Ausnahme 4 → unknown');
    assert.ok(n.rig.events.some((e) => e.outcome === 'error' && e.delivery === 'rejected'), 'Ausnahme 2 → rejected');
  },
};

SCENARIOS.p2_fronius_lock_exception = {
  setup: profileSetup('fronius', { transport: { failWrite: { 40191: { msg: 'modbus exception 3', times: 1 } } } }),
  run: async (r, step) => {
    await step('Sperre, StorCtl_Mod Ausnahme 3', dv(r, false, LOCK));
    await step('Sperre erneut', dv(r, false, LOCK));
  },
};

SCENARIOS.p2_sungrow_read_error_and_device_gate = {
  setup: profileSetup('sungrow', { transport: { failRead: { 13073: { msg: 'timeout', times: 1 } } } }),
  run: async (r, step) => {
    await step('Sperre mit Lese-Zeitüberschreitung', dv(r, false, LOCK));
    await step('Sperre erneut', dv(r, false, LOCK));
    r.state.victron.device = sungrowDevice({ endpointKey: '192.0.2.99:502:1' });
    await step('Freigabe nach Endpunktwechsel', dv(r, true, RELEASE));
    r.state.victron.device = sungrowDevice({ supported: false });
    await step('Freigabe bei nicht unterstütztem Gerät', dv(r, true, RELEASE));
  },
};

// --- Pfad 4: applyDvFeedInLimit (Victron 2706, int16, scale 100, Sonderwert -1, abwärts gerundet) -----------------

SCENARIOS.p4_victron_cycle = {
  setup: profileSetup('victron'),
  run: async (r, step) => {
    await step('Grenze 3000 W (sichert -1)', limit(r, 3000));
    await step('Grenze 2500 W', limit(r, 2500));
    await step('Grenze 2549 W (abwärts)', limit(r, 2549));
    await step('Grenze 0 W', limit(r, 0));
    await step('Grenze -500 W (auf 0)', limit(r, -500));
    await step('Rücknahme', limit(r, null));
    await step('Rücknahme ohne Sicherung', limit(r, null));
  },
  expect: (n) => assert.deepEqual(actionsOf(n.rig), [
    ...Array(5).fill('dvFeedInLimitW:protectiveLimit'), 'dvFeedInLimitW:autoRestore',
  ]),
};

SCENARIOS.p4_victron_installer_value = {
  setup: profileSetup('victron', { holding: { 2706: 46 } }),
  run: async (r, step) => {
    await step('Grenze 3000 W (Installateur 4600 W)', limit(r, 3000));
    await step('Rücknahme', limit(r, null));
  },
};

SCENARIOS.p4_victron_read_error = {
  setup: profileSetup('victron', { transport: { failRead: { 2706: { msg: 'timeout', times: 1 } } } }),
  run: async (r, step) => {
    await step('Grenze 3000 W, Lesefehler', limit(r, 3000));
    await step('Grenze 3000 W, nächster Takt', limit(r, 3000));
  },
};

// Pfad selbst ohne Not-Halt-Prüfung (die sitzt im Begrenzer davor): ein direkter Aufruf im Not-Halt schreibt heute.
SCENARIOS.p4_victron_halt_direct = {
  setup: profileSetup('victron'),
  run: async (r, step) => {
    r.halt();
    await step('Grenze 3000 W im Not-Halt (direkt)', limit(r, 3000));
    await step('Rücknahme im Not-Halt (direkt)', limit(r, null));
  },
};

// Begrenzer + Not-Halt-Eintritt: es bleibt die feste Grenze des Betreibers (Schutz-Begrenzung, kein Literal).
SCENARIOS.p4_arbiter_emergency_keeps_fixed = {
  setup: profileSetup('victron'),
  run: async (r, step) => {
    const arb = arbiterOf(r);
    await step('feste Grenze 6000 W', () => arb.set('fixed', 6000));
    await step('DV-Teilvorgabe 3000 W', () => arb.set('dv', 3000));
    await step('Not-Halt', emergency(r, arb, true));
    await step('DV-Teilvorgabe 2000 W im Not-Halt', () => arb.set('dv', 2000));
    await step('Nachprüfen im Not-Halt', () => arb.reapply());
    await step('Aufheben', emergency(r, arb, false));
    await step('DV-Teilvorgabe 2500 W', () => arb.set('dv', 2500));
    await step('DV-Teilvorgabe aufgehoben', () => arb.set('dv', null));
  },
  expect: (n) => assert.deepEqual(n.rig.events.map((e) => `${e.value.eng}:${e.action}:${e.state_flags.not_halt}`), [
    '6000:protectiveLimit:false', '3000:protectiveLimit:false', '6000:protectiveLimit:true',
    '2500:protectiveLimit:false', '6000:protectiveLimit:false',
  ]),
};

// Begrenzer + Not-Halt-Eintritt ohne feste Grenze: der Wert vor DVhub (Sicherung) kommt zurück — der Durchgang.
SCENARIOS.p4_arbiter_emergency_restores = {
  setup: profileSetup('victron', { holding: { 2706: 46 } }),
  run: async (r, step) => {
    const arb = arbiterOf(r);
    await step('DV-Teilvorgabe 3000 W', () => arb.set('dv', 3000));
    await step('Not-Halt', emergency(r, arb, true));
    await step('zweiter Not-Halt-Aufruf', emergency(r, arb, true));
  },
  expect: (n) => assert.deepEqual(n.rig.events.map((e) => `${e.value.eng}:${e.action}:${e.state_flags.not_halt}`), [
    '3000:protectiveLimit:false', '4600:haltNeutralize:true',
  ]),
};

// Vor dem Not-Halt eingereiht, nach dem Eintritt ausgeführt (Kette des Begrenzers): heute geschrieben.
SCENARIOS.p4_arbiter_queued_before_halt = {
  setup: profileSetup('victron'),
  run: async (r, step) => {
    const arb = arbiterOf(r);
    await step('feste Grenze 6000 W', () => arb.set('fixed', 6000));
    await step('DV 3000 W eingereiht, Not-Halt sofort danach', async () => { const p = arb.set('dv', 3000); r.halt(); await p; });
  },
};

SCENARIOS.p4_victron_restart = {
  setup: profileSetup('victron', { holding: { 2706: 46 } }),
  run: async (r, step) => {
    await step('Grenze 3000 W', limit(r, 3000));
    r.restart();
    await step('nach Neustart: Rücknahme', limit(r, null));
    await step('nach Neustart: Rücknahme ohne Sicherung', limit(r, null));
  },
};

SCENARIOS.p4_victron_write_safety = {
  setup: profileSetup('victron'),
  run: async (r, step) => {
    await step('Grenze 3000 W', limit(r, 3000));
    r.cfg.writeSafety = { ok: false, reason: 'manufacturer_profile_error', manufacturer: 'victron' };
    await step('Rücknahme bei writeSafety.ok=false', limit(r, null));
  },
};

SCENARIOS.p4_fronius_no_point = {
  setup: profileSetup('fronius'), noWrites: true,
  run: async (r, step) => { await step('Fronius Grenze 3000 W (kein 2706)', limit(r, 3000)); },
};

SCENARIOS.p4_victron_read_only = {
  setup: profileSetup('victron'), readOnly: true,
  run: async (r, step) => {
    await step('Grenze 3000 W im Lese-Modus', limit(r, 3000));
    await step('Rücknahme im Lese-Modus', limit(r, null));
  },
};

return SCENARIOS;
}

/**
 * Szenarien mit UMGESCHALTETER Not-Halt-Richtlinie (negativePrice, dvCurtailment, feedInCapLoop laufen im Not-Halt
 * weiter; nur im Kind-Prozess test/helpers/dv-parity-policy-flip.mjs). Eine weiterlaufende Pflicht-Abregelung muss
 * über das Tor genauso durchgehen wie heute (Lauf-Zulassung mit inHalt, Aktionsklasse protectiveLimit) — ein Befehl
 * (Regel, API) bleibt im Not-Halt gesperrt (schon von der Bestandsprüfung).
 */
export function flipScenarios() {
  const SCENARIOS = {};
  const haltedEvents = (n) => n.rig.events.filter((e) => e.state_flags.not_halt).map((e) => `${e.point}:${e.action}:${e.outcome}`);

  SCENARIOS.flip_fronius_lock_in_halt = {
    setup: profileSetup('fronius'),
    run: async (r, step) => {
      r.halt();
      await step('§51-Sperre im Not-Halt (Klasse läuft weiter)', dv(r, false, LOCK));
      await step('Freigabe im Not-Halt (Pflicht-Sperre beendet)', dv(r, true, { reason: 'emergency_stop_release' }));
      await step('Sperre per Regel im Not-Halt', dv(r, false, { reason: 'rule:abend' }));
      await step('DV-Sperre im Not-Halt', dv(r, false, { reason: 'dv_forced_off' }));
    },
    expect: (n) => assert.deepEqual(haltedEvents(n), [
      'storCtlMod:protectiveLimit:ok', 'outWRte:protectiveLimit:ok',
      'storCtlMod:haltNeutralize:ok', 'outWRte:haltNeutralize:ok',
      'storCtlMod:protectiveLimit:ok', 'outWRte:protectiveLimit:ok',
    ]),
  };

  SCENARIOS.flip_sungrow_lock_in_halt = {
    setup: profileSetup('sungrow'),
    run: async (r, step) => {
      r.halt();
      await step('§51-Sperre im Not-Halt', dv(r, false, LOCK));
      await step('Sperre per API im Not-Halt', api(r, 1));
    },
    expect: (n) => assert.ok(haltedEvents(n).length > 0 && haltedEvents(n).every((e) => e.endsWith(':protectiveLimit:ok'))),
  };

  // Begrenzer: die DV-Teilvorgabe läuft im Not-Halt weiter (dvCurtailment), die feste Grenze bleibt beim Eintritt.
  SCENARIOS.flip_arbiter_dv_continues = {
    setup: profileSetup('victron'),
    run: async (r, step) => {
      const arb = arbiterOf(r);
      await step('feste Grenze 6000 W', () => arb.set('fixed', 6000));
      await step('DV-Teilvorgabe 3000 W', () => arb.set('dv', 3000));
      await step('Not-Halt', emergency(r, arb, true));
      await step('DV-Teilvorgabe 2000 W im Not-Halt', () => arb.set('dv', 2000));
      await step('DV-Teilvorgabe aufgehoben im Not-Halt', () => arb.set('dv', null));
      await step('feste Grenze 5000 W im Not-Halt', () => arb.set('fixed', 5000));
    },
    expect: (n) => assert.deepEqual(n.rig.events.map((e) => `${e.value.eng}:${e.action}:${e.state_flags.not_halt}`), [
      '6000:protectiveLimit:false', '3000:protectiveLimit:false', '2000:protectiveLimit:true', '6000:protectiveLimit:true',
    ]),
  };

  return SCENARIOS;
}
