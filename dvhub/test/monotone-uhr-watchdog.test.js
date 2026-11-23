// A23 b (Christin 23.11.2026): Box-Watchdog des Sungrow Forced mode mit prozessübergreifender monotoner Zeit.
// DVhub schreibt neben `at` (Wanduhr) die Laufzeit seit Systemstart (`bootMs`, /proc/uptime) und die Start-Kennung
// (`bootId`) in die Lebenszeichen-Datei; der Watchdog vergleicht beides statt der Wanduhr. Alte Dateien (nur `at`)
// bleiben lesbar und werden wie bisher mit der Wanduhr beurteilt.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { watchdogShouldRelease, readForcedHeartbeat, readForcedHeartbeatAt } from '../services/inverter/sungrow-forced-safeoff.js';
import { EMS_MODE, createSungrowEms } from '../services/inverter/sungrow.js';
import { loadSungrowConfig, sungrowImage, mockSungrow, sungrowDevice } from './helpers/sungrow-fixture.js';
import { readBootClock, bootStamp } from '../services/mono-clock.js';

const T0 = Date.UTC(2026, 10, 23, 12, 0, 0);
const base = { liveMode: EMS_MODE.FORCED, markerOwned: true, staleMs: 120000 };
const HB = { at: T0, bootMs: 1_000_000, bootId: 'boot-a' };

test('Watchdog: Rücksprung der Wanduhr — totes DVhub wird nach 120 s Laufzeit trotzdem erkannt', () => {
  // DVhub hat vor 200 s (Laufzeit) zuletzt geschrieben, die Wanduhr ist inzwischen 60 min zurückgesprungen.
  const d = watchdogShouldRelease({ ...base, heartbeat: HB, heartbeatAt: HB.at, nowMs: T0 - 3_600_000 + 200_000, boot: { bootMs: 1_200_000, bootId: 'boot-a' } });
  assert.equal(d.release, true);
  assert.equal(d.reason, 'orphaned_forced');
  assert.equal(d.ageMs, 200_000);
  assert.equal(d.clock, 'boot');
});

test('Watchdog: Sprung vorwärts der Wanduhr — lebendes DVhub wird nicht zurückgenommen', () => {
  const d = watchdogShouldRelease({ ...base, heartbeat: HB, heartbeatAt: HB.at, nowMs: T0 + 3_600_000 + 10_000, boot: { bootMs: 1_010_000, bootId: 'boot-a' } });
  assert.equal(d.release, false);
  assert.equal(d.reason, 'heartbeat_fresh');
  assert.equal(d.ageMs, 10_000);
});

test('Watchdog: Lebenszeichen aus einem früheren Systemstart gilt als alt (auch bei kleiner Wanduhr-Differenz)', () => {
  const d = watchdogShouldRelease({ ...base, heartbeat: HB, heartbeatAt: HB.at, nowMs: T0 + 30_000, boot: { bootMs: 20_000, bootId: 'boot-b' } });
  assert.equal(d.release, true);
  assert.equal(d.reason, 'orphaned_forced');
  assert.equal(d.ageMs, Infinity);
  assert.equal(d.clock, 'previous_boot');
});

test('Watchdog: gleiche Start-Kennung, aber Laufzeit kleiner als in der Datei → gilt als alt (sicher)', () => {
  const d = watchdogShouldRelease({ ...base, heartbeat: HB, heartbeatAt: HB.at, nowMs: T0 + 1000, boot: { bootMs: 999_000, bootId: 'boot-a' } });
  assert.equal(d.release, true);
  assert.equal(d.ageMs, Infinity);
});

test('Watchdog: alte Datei ohne bootMs oder Watchdog ohne /proc → Wanduhr wie bisher', () => {
  const old = { at: T0 };
  assert.equal(watchdogShouldRelease({ ...base, heartbeat: old, heartbeatAt: T0, nowMs: T0 + 60_000, boot: { bootMs: 5, bootId: 'x' } }).release, false);
  const stale = watchdogShouldRelease({ ...base, heartbeat: old, heartbeatAt: T0, nowMs: T0 + 130_000, boot: { bootMs: 5, bootId: 'x' } });
  assert.equal(stale.release, true);
  assert.equal(stale.clock, 'wall');
  // Neue Datei, aber der Watchdog kann die Laufzeit nicht lesen (macOS) → Wanduhr.
  assert.equal(watchdogShouldRelease({ ...base, heartbeat: HB, heartbeatAt: T0, nowMs: T0 + 130_000, boot: null }).release, true);
  assert.equal(watchdogShouldRelease({ ...base, heartbeat: HB, heartbeatAt: T0, nowMs: T0 + 60_000, boot: null }).release, false);
  // Aufruf wie vor A23 (nur heartbeatAt) bleibt gültig.
  assert.equal(watchdogShouldRelease({ ...base, heartbeatAt: T0, nowMs: T0 + 130_000 }).release, true);
  assert.equal(watchdogShouldRelease({ ...base, heartbeatAt: null, nowMs: T0 }).release, true);
});

test('Watchdog: Modus/Besitz-Prüfung bleibt vor jeder Zeitprüfung', () => {
  const boot = { bootMs: 9_999_999, bootId: 'boot-a' };
  assert.equal(watchdogShouldRelease({ ...base, liveMode: EMS_MODE.SELF, heartbeat: HB, heartbeatAt: HB.at, nowMs: T0, boot }).reason, 'mode_not_forced');
  assert.equal(watchdogShouldRelease({ ...base, markerOwned: false, heartbeat: HB, heartbeatAt: HB.at, nowMs: T0, boot }).reason, 'not_owned');
});

test('readForcedHeartbeat: liest at, bootMs, bootId; alte Datei nur mit at; fehlend → null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-hb-mono-'));
  try {
    const p = path.join(dir, 'hb.json');
    fs.writeFileSync(p, JSON.stringify({ at: 5555, endpointKey: 'h:502:1', bootMs: 777, bootId: 'abc' }));
    assert.deepEqual(readForcedHeartbeat(p), { at: 5555, bootMs: 777, bootId: 'abc' });
    assert.equal(readForcedHeartbeatAt(p), 5555);
    fs.writeFileSync(p, JSON.stringify({ at: 6666 }));
    assert.deepEqual(readForcedHeartbeat(p), { at: 6666, bootMs: null, bootId: null });
    fs.writeFileSync(p, JSON.stringify({ at: 1, bootMs: 'x', bootId: 3 }));
    assert.deepEqual(readForcedHeartbeat(p), { at: 1, bootMs: null, bootId: null });
    assert.equal(readForcedHeartbeat(path.join(dir, 'fehlt.json')), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('readBootClock: /proc/uptime in ms und boot_id; ohne Dateien null', () => {
  const files = { '/u': '12345.67 99.00\n', '/b': 'f1e2d3\n' };
  const fsImpl = { readFileSync: (p) => { if (!(p in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return files[p]; } };
  assert.deepEqual(readBootClock({ fsImpl, uptimePath: '/u', bootIdPath: '/b' }), { bootMs: 12345670, bootId: 'f1e2d3' });
  assert.equal(readBootClock({ fsImpl, uptimePath: '/fehlt', bootIdPath: '/b' }), null);
  assert.equal(readBootClock({ fsImpl, uptimePath: '/u', bootIdPath: '/fehlt' }), null);
  assert.deepEqual(bootStamp(() => null), {});
  assert.deepEqual(bootStamp(() => ({ bootMs: 1, bootId: 'q' })), { bootMs: 1, bootId: 'q' });
});

// Codex be1efbb9 (P2): die Drossel der Lebenszeichen-Datei muss monoton sein (wie A21 auf fix/sungrow-a16-a17),
// sonst schreibt DVhub nach einem Rücksprung der Uhr keine Datei mehr, und der Watchdog (jetzt monoton) nähme ein
// lebendes DVhub nach 120 s zurück.
test('Lebenszeichen-Datei: nach einem Rücksprung der Wanduhr schreibt DVhub weiter (Drossel monoton)', async () => {
  const hbPath = path.join(os.tmpdir(), `dvhub-forced-hb-mono-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  try {
    const cfg = loadSungrowConfig({ gridPositiveMeans: 'grid_import', sungrow: { controlMode: 'forced', heartbeatTimeoutS: 30 } });
    const t = mockSungrow(sungrowImage());
    const c = { wall: 1_000_000_000, mono: 1000 };
    const state = { victron: { errors: {}, fieldUpdatedAt: {}, device: sungrowDevice() }, meter: { ok: true, updatedAt: c.wall, grid_total_w: 0 }, ctrl: {} };
    const telemetry = () => {
      state.meter = { ok: true, updatedAt: c.wall, grid_total_w: -5000 };
      Object.assign(state.victron, { batteryPowerW: -4000, pvPowerW: 0, selfConsumptionW: 500 });
      for (const f of ['batteryPowerW', 'pvPowerW', 'selfConsumptionW']) state.victron.fieldUpdatedAt[f] = c.wall;
    };
    telemetry();
    const ems = createSungrowEms({ state, getCfg: () => cfg, transport: t, now: () => c.wall, monoNow: () => c.mono, forcedHeartbeatPath: hbPath });
    await ems.applySetpoint(-5000, 'rule:abend');
    const at1 = JSON.parse(fs.readFileSync(hbPath, 'utf8')).at;
    assert.equal(at1, c.wall);
    c.wall -= 3_600_000; c.mono += 10_000;
    telemetry();
    // Gleichbleibender Sollwert: nur der Regeltakt (tick) frischt auf — auch er muss monoton fällig werden (A21).
    await ems.tick();
    const at2 = JSON.parse(fs.readFileSync(hbPath, 'utf8')).at;
    assert.equal(at2, c.wall, 'Datei nach 10 s Laufzeit neu geschrieben (at = neue Wanduhr)');
  } finally { try { fs.rmSync(hbPath, { force: true }); } catch { /* ignore */ } }
});
