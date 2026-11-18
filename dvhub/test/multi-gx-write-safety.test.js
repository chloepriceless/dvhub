// C2 (Christin 16.11.2026) auch für die zweite Victron-GX: Ist die wirksame Config ungültig (cfg.writeSafety.ok ===
// false — kaputtes/fehlendes Herstellerprofil oder kaputte config.json), schreibt KEIN Pfad mehr. Befund 18.11.2026:
// services/multi-gx schrieb seinen Netz-Sollwert 2716 an multiGx.host trotzdem jeden Takt weiter (geprüft wurden nur
// der eigene Schalter, das Beta-Tor und der Not-Halt). Soll wie die übrigen Pfade: kein Write (auch nicht die eine 0
// beim Abschalten), lauter Alarm einmal je Grund, beim Erholen neu scharf; gelesen wird weiter, die Anlage flattert
// nicht offline/online (wie im Not-Halt zählt nur das Lesen), und ein nicht geschriebener Sollwert wird nicht
// angezeigt.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMultiGx } from '../services/multi-gx/index.js';
import { createLegacyGate, MULTI_GX_GATE_DEVICE } from '../services/gate/legacy.js';
import { HOST, fixClock, loadProfileConfig, recordingModbus, baseState } from './helpers/gate-golden.js';

const GX2 = '192.0.2.20';
const GX2_REGS = { 843: 60, 842: 0, 2901: 150, 820: 0, 821: 0, 822: 0 };
const UNSAFE = { ok: false, reason: 'manufacturer_profile_error', manufacturer: 'victron' };

function setup() {
  const cfg = loadProfileConfig('victron', {
    updateChannel: 'dev', victron: { host: HOST }, gridPositiveMeans: 'grid_import',
    optimizer: { batteryCapacityWh: 64000, maxSocPct: 100, maxDischargeW: 10000, allowGridDischarge: true },
    multiGx: { enabled: true, host: GX2, port: 502, unitId: 100, batteryCapacityWh: 64000, maxChargeW: 10000, maxDischargeW: 10000, minSocPct: 10 },
  });
  const transport = recordingModbus({ hosts: { [GX2]: GX2_REGS }, hostAlias: { [HOST]: 'gx', [GX2]: 'gx2' } });
  const state = baseState({ victron: { soc: 60, batteryPowerW: -4000, minSocPct: 10, gridSetpointW: 0 } });
  state.victron.fieldUpdatedAt.batteryPowerW = Date.now();
  const logs = [];
  const avail = [];
  const events = [];
  const gate = createLegacyGate({ isHalted: () => state.ctrl.discretionaryWritesPaused === true, onEvent: (e) => events.push(e) });
  const mgx = createMultiGx({ getCfg: () => cfg, state, gate, pushLog: (event, data, level) => logs.push({ event, data, level }), onMultiGxAvailability: (v) => avail.push(v) }, { transport });
  return { cfg, state, transport, mgx, logs, avail, events, gate };
}

const writes = (s) => s.transport.ops.filter((o) => o.startsWith('W16 gx2/'));
const alarms = (s) => s.logs.filter((l) => l.event === 'multi_gx_write_blocked_config_unsafe');

test('C2 zweite GX: bei writeSafety.ok=false kein 2716-Write, ein lauter Alarm je Grund, Lesen läuft weiter', async (t) => {
  const advance = fixClock(t);
  const s = setup();
  const tick = async () => { await advance(5000); s.state.victron.fieldUpdatedAt.batteryPowerW = Date.now(); await s.mgx.tick(); };
  await tick();
  assert.equal(writes(s).length, 1, 'gültige Config: 2716 wird geschrieben');

  s.cfg.writeSafety = { ...UNSAFE };
  const reads0 = s.transport.ops.filter((o) => o.startsWith('R4 gx2/')).length;
  for (let i = 0; i < 4; i += 1) await tick();
  assert.equal(writes(s).length, 1, 'ungültige Config: kein einziger Write an die zweite GX');
  assert.ok(s.transport.ops.filter((o) => o.startsWith('R4 gx2/')).length > reads0, 'gelesen wird weiter');
  assert.equal(alarms(s).length, 1, 'Alarm genau einmal je Grund (keine Log-Flut je Takt)');
  assert.equal(alarms(s)[0].level, 'error');
  assert.deepEqual(alarms(s)[0].data, { reason: 'manufacturer_profile_error', manufacturer: 'victron' });
  assert.equal(s.state.multiGx.online, true, 'Lesen gelingt → verfügbar, kein offline/online-Flattern');
  assert.equal(s.state.multiGx.setpointW, null, 'kein geschriebener Sollwert → keiner angezeigt');
  assert.ok(!s.logs.some((l) => l.event === 'multi_gx_offline'));

  // Anderer Grund → neuer Alarm.
  s.cfg.writeSafety = { ok: false, reason: 'config_broken', manufacturer: 'victron' };
  await tick();
  assert.equal(alarms(s).length, 2);

  // Abschalten bei ungültiger Config: auch die eine 0 geht nicht raus.
  s.cfg.multiGx.enabled = false;
  await tick();
  assert.equal(writes(s).length, 1, 'kein neutraler 0-Write bei ungültiger Config');

  // Erholung: wieder an, Config gültig → schreibt wieder; der Alarm ist neu scharf.
  s.cfg.multiGx.enabled = true;
  delete s.cfg.writeSafety;
  await tick();
  assert.equal(writes(s).length, 2, 'nach der Erholung wird wieder geschrieben');
  s.cfg.writeSafety = { ...UNSAFE };
  await tick();
  assert.equal(writes(s).length, 2);
  assert.equal(alarms(s).length, 3, 'nach der Erholung meldet derselbe Grund wieder');
  assert.deepEqual(s.events.filter((e) => e.outcome !== 'ok').map((e) => e.outcome), [], 'das Tor sieht keinen gesperrten Versuch — der Pfad schreibt gar nicht erst');
});

test('C2 zweite GX: Schreibfreigabe des Tors folgt der Config (profileInvalid sperrt auch am Tor)', async (t) => {
  const advance = fixClock(t);
  const s = setup();
  const tick = async () => { await advance(5000); s.state.victron.fieldUpdatedAt.batteryPowerW = Date.now(); await s.mgx.tick(); };
  await tick();
  assert.equal(s.gate.releaseState(MULTI_GX_GATE_DEVICE), 'open');
  s.cfg.writeSafety = { ...UNSAFE };
  await tick();
  assert.equal(s.gate.releaseState(MULTI_GX_GATE_DEVICE), 'profileInvalid');
  delete s.cfg.writeSafety;
  await tick();
  assert.equal(s.gate.releaseState(MULTI_GX_GATE_DEVICE), 'open');
});

// Codex 8cd2f706 P2: Während die Config ungültig ist, darf der Regler nicht weiter aufintegrieren — sonst ginge nach
// der Erholung sofort der aufgelaufene Grenzwert raus (Rampe umgangen). Wie im Not-Halt: Regler auf Stopp, nach der
// Erholung startet er bei 0 und rampt.
test('C2 zweite GX: kein Aufintegrieren während der Sperre — nach der Erholung höchstens ein Rampenschritt', async (t) => {
  const advance = fixClock(t);
  const s = setup();
  // AC-IN unlesbar (keine Leine am gemessenen AC-IN), Hauptakku entlädt 4 kW, die zweite GX folgt nicht (sie bekommt
  // ja keinen Sollwert) — ohne Stopp läuft der Regler bis an seine Grenze.
  s.transport.failRead[`${GX2}@820`] = 'timeout';
  const tick = async () => { await advance(5000); s.state.victron.fieldUpdatedAt.batteryPowerW = Date.now(); await s.mgx.tick(); };
  await tick();
  s.cfg.writeSafety = { ...UNSAFE };
  for (let i = 0; i < 15; i += 1) await tick();
  const reasonDuring = s.state.multiGx.reason;
  delete s.cfg.writeSafety;
  await tick();
  const last = writes(s).at(-1);
  const m = /@2716=\[(\d+),(\d+)\]/.exec(last);
  const v = (((Number(m[1]) << 16) | Number(m[2])) | 0);
  assert.ok(Math.abs(v) <= 1000, `erster Write nach der Erholung ${v} W — mehr als ein Rampenschritt (200 W/s × 5 s)`);
  assert.equal(reasonDuring, 'config_unsafe', 'Status nennt den Grund (nicht „Not-Halt“)');
});

// Codex 8cd2f706 P2: Erholt sich die Config, während die zweite GX abgeschaltet ist, muss der Alarm neu scharf werden.
test('C2 zweite GX: Erholung im abgeschalteten Zustand macht den Alarm neu scharf', async (t) => {
  const advance = fixClock(t);
  const s = setup();
  const tick = async () => { await advance(5000); s.state.victron.fieldUpdatedAt.batteryPowerW = Date.now(); await s.mgx.tick(); };
  await tick();
  s.cfg.writeSafety = { ...UNSAFE };
  await tick();
  assert.equal(alarms(s).length, 1);
  s.cfg.multiGx.enabled = false;
  await tick();
  await tick();
  delete s.cfg.writeSafety;        // erholt, während abgeschaltet
  await tick();
  s.cfg.writeSafety = { ...UNSAFE };  // derselbe Grund wieder
  await tick();
  s.cfg.multiGx.enabled = true;
  await tick();
  assert.equal(alarms(s).length, 2, 'derselbe Grund nach einer beobachteten Erholung meldet wieder');
  assert.equal(writes(s).length, 1);
});
