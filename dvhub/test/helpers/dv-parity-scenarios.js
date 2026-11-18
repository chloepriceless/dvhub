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

// Pfad 5: Nulleinspeise-Deckel (zeroFeedInTick) und feste Einspeisegrenze (feedInCapTick), Fronius SunSpec.
const ZFI_ADDR = { storCtlMod: 40191, outWRte: 40198, wMaxLimPct: 40242, wMaxLimPctRvrtTms: 40244, wMaxLimEna: 40246 };
function zfiSetup({ blocked = true, reason = 'negative_price_protection', resolved = true, profile = 'fronius', transport = {}, capLimitW = null } = {}) {
  return (onWrite) => {
    const cfg = loadProfileConfig(profile, { victron: { host: HOST } });
    if (resolved && profile === 'fronius') for (const [k, a] of Object.entries(ZFI_ADDR)) cfg.controlWrite[k].address = a;
    const box = { limitW: capLimitW };
    return {
      cfg,
      transport: parityModbus({ holding: { [ZFI_ADDR.wMaxLimPct]: 10000 }, hostAlias: ALIAS, ...structuredClone(transport) }, onWrite),
      state: () => baseState({ ctrl: { _lastDvFeedIn: blocked ? false : true, _dvBlockReason: blocked ? reason : null } }),
      ctx: { feedInCap: { limitForLoop: () => box.limitW } },
      data: box,
    };
  };
}
// Messwerte wie vom Poller frisch gestempelt (feste Uhr).
function feed(r, { soc = 96, importW = 0, exportW = 0, loadW = 1000, pvW = 3000 } = {}) {
  const now = Date.now();
  Object.assign(r.state.victron, {
    soc, gridImportW: importW, gridExportW: exportW, selfConsumptionW: loadW, pvTotalW: pvW, pvPowerW: pvW,
    fieldUpdatedAt: { soc: now, selfConsumptionW: now, pvPowerW: now },
  });
  Object.assign(r.state.meter, { ok: true, updatedAt: now, grid_total_w: importW - exportW });
}
const capOf = (st) => ({ cap: st?.capActive === true, pct: st?.limitPct == null ? null : Number(st.limitPct.toFixed(4)) });
const zfiTick = (r, values) => async () => { await r.advance(5000); if (values) feed(r, values); await r.ev.zeroFeedInTick(); return capOf(r.state.ctrl._zfi); };
const ficTick = (r, values) => async () => { await r.advance(5000); if (values) feed(r, values); await r.ev.feedInCapTick(); return capOf(r.state.ctrl._fic); };

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

// --- Pfad 5: zfiWrite (Nulleinspeise-Deckel, feste Einspeisegrenze; heute ohne Geräte-Tor — so bleibt es) ---------

SCENARIOS.p5_zfi_soc_cycle = {
  setup: zfiSetup(),
  run: async (r, step) => {
    await step('Takt 1 gesperrt, SoC 96 %', zfiTick(r, { soc: 96 }));
    await step('Takt 2 → Deckel an', zfiTick(r, { soc: 96 }));
    await step('Export 300 W → Limit runter', zfiTick(r, { soc: 96, exportW: 300 }));
    await step('Bezug 400 W → Limit hoch', zfiTick(r, { soc: 96, importW: 400 }));
    await step('Zähler veraltet → gehalten', async () => { await r.advance(5000); r.state.meter.updatedAt = Date.now() - 20_000; await r.ev.zeroFeedInTick(); return capOf(r.state.ctrl._zfi); });
    for (let i = 0; i < 12; i += 1) await step(`Regeln ${i}`, zfiTick(r, { soc: 96, exportW: i % 2 ? 200 : 0, importW: i % 2 ? 0 : 120 }));
    await step('SoC 89 % → Deckel aus', zfiTick(r, { soc: 89 }));
  },
  expect: (n) => {
    const a = actionsOf(n.rig);
    assert.deepEqual(a.slice(0, 4), ['outWRte:protectiveLimit', 'wMaxLimPctRvrtTms:protectiveLimit', 'wMaxLimPct:protectiveLimit', 'wMaxLimEna:protectiveLimit']);
    assert.deepEqual(a.slice(-2), ['outWRte:protectiveLimit', 'wMaxLimEna:protectiveLimit'], 'Deckel aus unter der Sperre: Schutz-Begrenzung');
    assert.ok(n.out.wire.some((e) => e.startsWith('R3 gx/u1 @40242')), 'Rücklese-Drift-Prüfung lief');
  },
};

SCENARIOS.p5_zfi_release = {
  setup: zfiSetup(),
  run: async (r, step) => {
    await step('Takt 1', zfiTick(r, {}));
    await step('Takt 2 → an', zfiTick(r, {}));
    r.state.ctrl._lastDvFeedIn = true;
    await step('Freigabe → Ena 0', zfiTick(r, {}));
    await step('Freigabe, nächster Takt', zfiTick(r, {}));
  },
  expect: (n) => assert.equal(actionsOf(n.rig).at(-1), 'wMaxLimEna:autoRestore'),
};

SCENARIOS.p5_zfi_nothalt = {
  setup: zfiSetup(),
  run: async (r, step) => {
    await step('Takt 1', zfiTick(r, {}));
    await step('Takt 2 → an', zfiTick(r, {}));
    r.halt();
    await step('Not-Halt → einmal Ena 0', zfiTick(r, {}));
    await step('Not-Halt, nächster Takt', zfiTick(r, {}));
    r.resume();
    await step('nach dem Aufheben', zfiTick(r, {}));
    await step('nach dem Aufheben (2)', zfiTick(r, {}));
  },
  expect: (n) => assert.deepEqual(n.rig.events.filter((e) => e.state_flags.not_halt).map((e) => `${e.point}=${e.value.eng}:${e.action}`), ['wMaxLimEna=0:haltNeutralize']),
};

// Not-Halt mitten im Enter-Takt (nach OutWRte = +100 %): heute schreibt der Takt zu Ende.
SCENARIOS.p5_zfi_halt_mid_tick = {
  setup: zfiSetup(),
  run: async (r, step) => {
    await step('Takt 1', zfiTick(r, {}));
    r.onWrite((entry) => { if (entry === 'W6 gx/u1 @40198=10000') r.halt(); });
    await step('Takt 2 → an, Not-Halt nach OutWRte', zfiTick(r, {}));
    r.onWrite(null);
    await step('Not-Halt → einmal Ena 0', zfiTick(r, {}));
  },
};

SCENARIOS.p5_zfi_export_trigger = {
  setup: zfiSetup(),
  run: async (r, step) => {
    for (let i = 1; i <= 4; i += 1) await step(`Takt ${i} SoC 50 %, Export 500 W`, zfiTick(r, { soc: 50, exportW: 500 }));
    for (let i = 1; i <= 4; i += 1) await step(`SoC fällt auf ${50 - i * 2} %`, zfiTick(r, { soc: 50 - i * 2, importW: 50 }));
    for (let i = 1; i <= 4; i += 1) await step(`Takt ${i} Export 500 W`, zfiTick(r, { soc: 40, exportW: 500 }));
    for (let i = 1; i <= 8; i += 1) await step(`kein Export ${i}`, zfiTick(r, { soc: 41, importW: 3000, loadW: 4000 }));
  },
};

SCENARIOS.p5_zfi_write_error = {
  setup: zfiSetup({ transport: { failWrite: { [ZFI_ADDR.wMaxLimPct]: { msg: 'timeout', times: 1 } } } }),
  run: async (r, step) => {
    await step('Takt 1', zfiTick(r, {}));
    await step('Takt 2 → Enter, WMaxLimPct scheitert', zfiTick(r, {}));
    await step('Takt 3 → Enter erneut', zfiTick(r, {}));
    r.transport.failWrite[ZFI_ADDR.wMaxLimEna] = { msg: 'modbus exception 4', times: 1 };
    await step('Takt 4 Regeln, Ena Ausnahme 4', zfiTick(r, {}));
    await step('Takt 5 Regeln', zfiTick(r, {}));
  },
};

SCENARIOS.p5_zfi_write_safety = {
  setup: zfiSetup(),
  run: async (r, step) => {
    await step('Takt 1', zfiTick(r, {}));
    await step('Takt 2 → an', zfiTick(r, {}));
    r.cfg.writeSafety = { ok: false, reason: 'manufacturer_profile_error', manufacturer: 'fronius' };
    await step('Takt 3 bei writeSafety.ok=false', zfiTick(r, {}));
    r.state.ctrl._lastDvFeedIn = true;
    await step('Freigabe bei writeSafety.ok=false', zfiTick(r, {}));
  },
};

SCENARIOS.p5_zfi_unresolved_and_victron = {
  setup: zfiSetup({ resolved: false }), noWrites: true,
  run: async (r, step) => {
    await step('Takt 1 unaufgelöst', zfiTick(r, {}));
    await step('Takt 2 unaufgelöst', zfiTick(r, {}));
  },
};

SCENARIOS.p5_zfi_read_only = {
  setup: zfiSetup(), readOnly: true,
  run: async (r, step) => {
    await step('Takt 1', zfiTick(r, {}));
    await step('Takt 2 → Enter im Lese-Modus', zfiTick(r, {}));
    await step('Takt 3', zfiTick(r, {}));
  },
};

SCENARIOS.p5_fic_cycle = {
  setup: zfiSetup({ blocked: false, capLimitW: 6000 }),
  run: async (r, step) => {
    await step('Export 5000 W < Grenze', ficTick(r, { soc: 50, exportW: 5000, pvW: 8000 }));
    await step('Export 7000 W > Grenze → Enter', ficTick(r, { soc: 50, exportW: 7000, pvW: 9000 }));
    await step('Export 6200 W → runter', ficTick(r, { soc: 50, exportW: 6200, pvW: 8000 }));
    await step('Export 4000 W → hoch', ficTick(r, { soc: 50, exportW: 4000, pvW: 6000 }));
    for (let i = 1; i <= 10; i += 1) await step(`Bezug ${i} → unter der Grenze`, ficTick(r, { soc: 50, importW: 3000, pvW: 2000 }));
    await step('Export 7000 W → Enter', ficTick(r, { soc: 50, exportW: 7000, pvW: 9000 }));
    r.state.ctrl._lastDvFeedIn = false;
    await step('Sperre aktiv → eigener Zustand weg', ficTick(r, { soc: 50, exportW: 0, pvW: 6000 }));
    r.state.ctrl._lastDvFeedIn = true;
    await step('wieder frei → Enter', ficTick(r, { soc: 50, exportW: 7000, pvW: 9000 }));
    r.data.limitW = null;
    await step('Grenze entfällt → Ena 0', ficTick(r, { soc: 50, exportW: 7000, pvW: 9000 }));
  },
  expect: (n) => {
    const a = actionsOf(n.rig);
    assert.ok(a.includes('wMaxLimEna:autoRestore'), 'Abräumen ohne Grenze bzw. unter der Grenze = autoRestore');
    assert.deepEqual(a.slice(0, 3), ['wMaxLimPctRvrtTms:protectiveLimit', 'wMaxLimPct:protectiveLimit', 'wMaxLimEna:protectiveLimit']);
  },
};

SCENARIOS.p5_fic_nothalt = {
  setup: zfiSetup({ blocked: false, capLimitW: 6000 }),
  run: async (r, step) => {
    await step('Enter', ficTick(r, { soc: 50, exportW: 7000, pvW: 9000 }));
    r.halt();
    await step('Not-Halt → einmal Ena 0', ficTick(r, { soc: 50, exportW: 7000, pvW: 9000 }));
    await step('Not-Halt, nächster Takt', ficTick(r, { soc: 50, exportW: 7000, pvW: 9000 }));
  },
  expect: (n) => assert.deepEqual(n.rig.events.filter((e) => e.state_flags.not_halt).map((e) => `${e.point}=${e.value.eng}:${e.action}`), ['wMaxLimEna=0:haltNeutralize']),
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

  // Nulleinspeise-Deckel unter einer §-51-Sperre läuft im Not-Halt weiter (Klasse negativePrice).
  SCENARIOS.flip_zfi_continues = {
    setup: zfiSetup(),
    run: async (r, step) => {
      await step('Takt 1', zfiTick(r, {}));
      await step('Takt 2 → an', zfiTick(r, {}));
      r.halt();
      await step('Not-Halt: Deckel regelt weiter', zfiTick(r, { exportW: 300 }));
      await step('Not-Halt: SoC 89 % → Deckel aus', zfiTick(r, { soc: 89 }));
    },
    expect: (n) => assert.deepEqual(haltedEvents(n), [
      'wMaxLimPct:protectiveLimit:ok', 'wMaxLimEna:protectiveLimit:ok', 'outWRte:protectiveLimit:ok', 'wMaxLimEna:protectiveLimit:ok',
    ]),
  };

  // Deckel unter einer Regel-Sperre (keine Pflicht-Klasse): im Not-Halt einmal abräumen.
  SCENARIOS.flip_zfi_rule_block_released = {
    setup: zfiSetup({ reason: 'rule:abend' }),
    run: async (r, step) => {
      await step('Takt 1', zfiTick(r, {}));
      await step('Takt 2 → an', zfiTick(r, {}));
      r.halt();
      await step('Not-Halt → einmal Ena 0', zfiTick(r, {}));
    },
    expect: (n) => assert.deepEqual(haltedEvents(n), ['wMaxLimEna:haltNeutralize:ok']),
  };

  // Regelschleife der festen Grenze läuft im Not-Halt weiter (feedInCapLoop) — samt Abräumen, wenn die Grenze entfällt.
  SCENARIOS.flip_fic_continues = {
    setup: zfiSetup({ blocked: false, capLimitW: 6000 }),
    run: async (r, step) => {
      await step('Enter', ficTick(r, { soc: 50, exportW: 7000, pvW: 9000 }));
      r.halt();
      await step('Not-Halt: regelt weiter', ficTick(r, { soc: 50, exportW: 6500, pvW: 9000 }));
      r.data.limitW = null;
      await step('Not-Halt: Grenze entfällt → Ena 0', ficTick(r, { soc: 50, exportW: 6500, pvW: 9000 }));
    },
    expect: (n) => assert.deepEqual(haltedEvents(n), ['wMaxLimPct:protectiveLimit:ok', 'wMaxLimEna:protectiveLimit:ok', 'wMaxLimEna:autoRestore:ok']),
  };

  return SCENARIOS;
}
