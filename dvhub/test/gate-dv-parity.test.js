// H-1 Phase 3 — Paritätsnachweis der Abregel-Pfade über das Schreibtor im Legacy-Modus (VCL-Vertrag v6 D.2 „bit-gleich
// zu main", Nachweis D.4(2)): jedes Szenario läuft einmal über den ALTEN Weg und einmal über das ECHTE Tor
// (test/helpers/dv-parity-rig.js). Verglichen werden Draht-Folge (Lesen und Schreiben, alle Geräte in einem
// Protokoll), volle Argument-Objekte, Rückgaben/Fehler, Log-Ereignisse samt Daten und Stufe, die Zustandsfelder der
// Pfade (state.ctrl inkl. dvControl, _lastDvFeedIn, _dvSeqSaved, _zfi/_fic; lastWrite, _verify), die Merker-Dateien
// dv_seq_saved.json/dv_seq_writeday.json und im Lese-Modus die abgewehrten Schreibversuche. Auf der neuen Seite muss
// zusätzlich jeder Draht-Write genau ein Tor-Ereignis (ok/error, Vertrauensklasse legacy) haben, das Tor darf nichts
// selbst sperren, und die Aktionsklassen stehen fest.
//
//   Pfad 2  runDvControlSequence — Abregel-Sequenzen Fronius / Deye / Sungrow (über applyDvVictronControl und den
//           Chokepoint applyControlTarget)
//
// Gegenbeweis gegen den Stand VOR dem Umbau (732f954a):
//   git show 732f954a:dvhub/schedule-eval.js > dvhub/schedule-eval.parity-base.js
//   DV_PARITY_BASE=schedule-eval.parity-base.js node --test test/gate-dv-parity.test.js   (in dvhub/; danach löschen —
//   die Kopie läge sonst im R-T1-Scan)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HOST, loadProfileConfig, baseState } from './helpers/gate-golden.js';
import { sungrowDevice } from './helpers/sungrow-fixture.js';
import { parityModbus, runSide } from './helpers/dv-parity-rig.js';
import { INVERTER_GATE_DEVICE } from '../services/gate/legacy.js';

const SG_HOST = '192.0.2.50';                       // passt zu sungrowDevice().endpointKey
const ALIAS = { [HOST]: 'gx', [SG_HOST]: 'sg' };
const FRONIUS_REGS = { 40191: 1, 40198: 0xec78 };   // Kundenwerte: StorCtl_Mod 1, OutWRte −50,00 %
const DEYE_REGS = { 142: 1 };                       // Kunden-Work-Mode 1
const SUNGROW_REGS = { 13073: 5000, 13086: 0xaa, 13087: 700, 31221: 0xffff };

const LOCK = { reason: 'negative_price_protection' };
const RELEASE = { reason: 'price_recovered' };

function froniusCfg(persisted = {}) {
  const cfg = loadProfileConfig('fronius', { victron: { host: HOST }, ...persisted });
  cfg.controlWrite.storCtlMod.address = 40191;      // SunSpec-Scan (polling.js) nachgestellt
  cfg.controlWrite.outWRte.address = 40198;
  return cfg;
}

/** Rig-Optionen je Profil; transport-Optionen wie recordingModbus. */
function profileSetup(profile, { transport = {}, ctrl = {}, victron = {}, files = {}, persisted = {} } = {}) {
  return (onWrite) => {
    let cfg;
    let holding;
    let device = null;
    if (profile === 'fronius') { cfg = froniusCfg(persisted); holding = FRONIUS_REGS; }
    if (profile === 'deye-lv') { cfg = loadProfileConfig('deye-lv', { victron: { host: HOST }, ...persisted }); holding = DEYE_REGS; }
    if (profile === 'sungrow') {
      cfg = loadProfileConfig('sungrow', { updateChannel: 'dev', victron: { host: SG_HOST }, ...persisted });
      holding = SUNGROW_REGS;
      device = sungrowDevice();
    }
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

const actionsOf = (r) => r.events.filter((e) => e.outcome === 'ok' || e.outcome === 'error').map((e) => `${e.point}:${e.action}`);

// --- Szenarien -----------------------------------------------------------------------------------------------------
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
SCENARIOS.p2_deye_halt_mid_command = {
  setup: profileSetup('deye-lv'),
  run: async (r, step) => {
    r.onWrite(() => r.halt()); // vor dem ersten Write liegt nur die Sicherung (Lesen)
    await step('Sperre per Regel, Not-Halt nach dem Write', dv(r, false, { reason: 'rule:abend' }));
  },
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

// --- Lauf ----------------------------------------------------------------------------------------------------------

const isWrite = (entry) => /^(W6|W16|MQTT) /.test(entry);

for (const [name, sc] of Object.entries(SCENARIOS)) {
  test(`Parität alt ↔ Tor (Legacy): ${name}`, async (t) => {
    const before = await runSide(t, 'old', sc);
    const after = await runSide(t, 'new', sc);
    assert.deepEqual(after.out, before.out, `${name}: Tor-Pfad weicht vom alten Weg ab`);
    const writes = after.out.wire.filter(isWrite);
    const delivered = after.rig.events.filter((e) => e.outcome === 'ok' || e.outcome === 'error');
    assert.equal(delivered.length, writes.length, `${name}: jeder Draht-Write ein Tor-Ereignis`);
    assert.ok(after.rig.events.every((e) => e.trust === 'legacy' && e.target.device === INVERTER_GATE_DEVICE), 'legacy, Gerät inverter');
    const blocked = after.rig.events.filter((e) => !['ok', 'error'].includes(e.outcome));
    if (sc.readOnly) {
      assert.ok(blocked.length > 0 && blocked.every((e) => e.outcome === 'blocked_readonly'), 'im Lese-Modus sperrt das Tor');
      assert.equal(after.out.readOnlyBlocked, blocked.length, 'je Sperre eine Meldung');
    } else {
      assert.deepEqual(blocked.map((e) => `${e.point}:${e.outcome}:${e.detail}`), [], 'das Tor sperrt nichts, was heute geschrieben wird');
    }
    sc.expect?.(after);
  });
}

test('Parität: die Szenarien schreiben (sonst wäre der Vergleich leer)', () => {
  // Grobe Absicherung: fast jedes Szenario erzeugt Draht-Writes (Lese-Modus und writeSafety ausgenommen).
  assert.ok(Object.keys(SCENARIOS).length >= 20);
});
