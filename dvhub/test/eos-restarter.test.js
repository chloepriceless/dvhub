import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createEosRestarter,
  eosRestartability,
  stallRestartMs,
  stalledRunMs,
  EOS_STALL_RESTART_MIN_DEFAULT,
  EOS_WATCHDOG_COOLDOWN_MS,
  EOS_MANUAL_RESTART_MIN_GAP_MS,
} from '../services/optimizer/eos-restarter.js';

const T0 = Date.parse('2026-10-16T12:00:00Z');
const MIN = 60_000;
const localEos = (extra = {}) => ({ optimizer: { eosProxy: { enabled: true, url: 'http://127.0.0.1:8503' }, ...extra } });

function setup({ cfg = localEos(), eosRun = null, execResult = { ok: true }, inContainer = false } = {}) {
  let now = T0;
  const calls = [];
  const logs = [];
  const state = { optimizer: { eosRun } };
  const restarter = createEosRestarter({
    getCfg: () => cfg,
    state,
    exec: async (args) => { calls.push(args); return typeof execResult === 'function' ? execResult() : execResult; },
    inContainer,
    pushLog: (type, data) => logs.push({ type, data }),
    now: () => now,
    setTimer: () => null,
    clearTimer: () => {},
  });
  return { restarter, calls, logs, state, advance: (ms) => { now += ms; }, at: () => now };
}

test('eosRestartability: nur das lokale EOS, nicht im Container, nicht bei ausgeschaltetem EOS', () => {
  assert.deepEqual(eosRestartability(localEos()), { ok: true, reason: null });
  assert.deepEqual(eosRestartability({ optimizer: { eosProxy: { enabled: true, url: 'http://localhost:8503' } } }), { ok: true, reason: null });
  assert.deepEqual(eosRestartability({ optimizer: { eosProxy: { enabled: true } } }), { ok: true, reason: null }, 'Standard-URL ist 127.0.0.1');
  assert.equal(eosRestartability({ optimizer: { eosProxy: { enabled: true, url: 'http://192.168.1.50:8503' } } }).reason, 'remote');
  assert.equal(eosRestartability({ optimizer: { eosProxy: { enabled: false } } }).reason, 'eos_off');
  assert.equal(eosRestartability(localEos(), { inContainer: true }).reason, 'container');
});

test('stallRestartMs: Standard 90 min, 0 schaltet aus, kleine Werte auf 30 min angehoben, null zählt nicht als 0', () => {
  assert.equal(stallRestartMs({}), EOS_STALL_RESTART_MIN_DEFAULT * MIN);
  assert.equal(stallRestartMs({ optimizer: { eosStallRestartMin: 0 } }), 0);
  assert.equal(stallRestartMs({ optimizer: { eosStallRestartMin: 5 } }), 30 * MIN);
  assert.equal(stallRestartMs({ optimizer: { eosStallRestartMin: 120 } }), 120 * MIN);
  assert.equal(stallRestartMs({ optimizer: { eosStallRestartMin: null } }), EOS_STALL_RESTART_MIN_DEFAULT * MIN);
});

test('stalledRunMs: nur ein laufender Lauf über der Grenze gilt als hängend', () => {
  const stall = 90 * MIN;
  assert.equal(stalledRunMs({ inFlight: true, startedAt: T0 }, T0 + 89 * MIN, stall), null);
  assert.equal(stalledRunMs({ inFlight: true, startedAt: T0 }, T0 + 91 * MIN, stall), 91 * MIN);
  assert.equal(stalledRunMs({ inFlight: false, startedAt: T0 }, T0 + 300 * MIN, stall), null);
  assert.equal(stalledRunMs({ inFlight: true, startedAt: T0 }, T0 + 300 * MIN, 0), null, 'Wache aus');
  assert.equal(stalledRunMs(null, T0, stall), null);
});

test('Wache: hängender Lauf → systemctl restart eos.service, danach Sperre von 2 h', async () => {
  const { restarter, calls, logs, state, advance } = setup({ eosRun: { inFlight: true, startedAt: T0 } });
  advance(91 * MIN);
  const r = await restarter.watchdogTick();
  assert.equal(r.action, 'restart');
  assert.equal(r.ok, true);
  assert.deepEqual(calls, [['restart', 'eos.service']]);
  assert.ok(logs.some((l) => l.type === 'eos_restarted' && l.data.via === 'watchdog'));
  assert.equal(state.optimizer.eosRestart.lastRestart.via, 'watchdog');
  assert.equal(state.optimizer.eosRestart.restarts, 1);

  // Der Lauf „hängt“ weiter (z. B. EOS bleibt kaputt): innerhalb der Sperre kein zweiter Neustart.
  advance(30 * MIN);
  assert.equal((await restarter.watchdogTick()).action, 'cooldown');
  assert.equal(calls.length, 1);
  advance(EOS_WATCHDOG_COOLDOWN_MS);
  assert.equal((await restarter.watchdogTick()).action, 'restart');
  assert.equal(calls.length, 2);
});

test('Wache: normaler Lauf, Wache aus oder entferntes EOS → kein Neustart', async () => {
  const short = setup({ eosRun: { inFlight: true, startedAt: T0 } });
  short.advance(20 * MIN);
  assert.equal((await short.restarter.watchdogTick()).action, 'none');

  const off = setup({ cfg: localEos({ eosStallRestartMin: 0 }), eosRun: { inFlight: true, startedAt: T0 } });
  off.advance(500 * MIN);
  assert.equal((await off.restarter.watchdogTick()).action, 'none');

  const remote = setup({
    cfg: { optimizer: { eosProxy: { enabled: true, url: 'http://10.0.0.5:8503' } } },
    eosRun: { inFlight: true, startedAt: T0 },
  });
  remote.advance(200 * MIN);
  const r = await remote.restarter.watchdogTick();
  assert.equal(r.action, 'none');
  assert.equal(r.reason, 'cannot_restart');
  assert.equal(short.calls.length + off.calls.length + remote.calls.length, 0);
});

test('Knopf: Neustart, zu schnell hintereinander abgewiesen, Fehler wird gemeldet', async () => {
  let fail = false;
  const { restarter, calls, advance } = setup({ execResult: () => (fail ? { ok: false, error: 'sudo: a password is required' } : { ok: true }) });
  assert.deepEqual(await restarter.restart({ via: 'ui' }), { ok: true });
  assert.deepEqual(await restarter.restart({ via: 'ui' }), { ok: false, error: 'too_soon' });
  advance(EOS_MANUAL_RESTART_MIN_GAP_MS + 1);
  fail = true;
  const r = await restarter.restart({ via: 'ui' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'restart_failed');
  assert.match(r.detail, /password is required/);
  assert.equal(calls.length, 2);
  const st = restarter.status();
  assert.equal(st.lastRestart.ok, false);
  assert.equal(st.restarts, 1);
});

test('Knopf: gleichzeitige Aufrufe teilen sich einen Neustart; Container → nicht möglich', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { restarter, calls } = setup({ execResult: () => gate.then(() => ({ ok: true })) });
  const a = restarter.restart({ via: 'ui' });
  const b = restarter.restart({ via: 'ui' });
  assert.equal(restarter.status().restarting, true);
  release();
  assert.deepEqual(await a, { ok: true });
  assert.deepEqual(await b, { ok: true });
  assert.equal(calls.length, 1);

  const box = setup({ inContainer: true });
  assert.deepEqual(await box.restarter.restart({ via: 'ui' }), { ok: false, error: 'container' });
  assert.equal(box.calls.length, 0);
  assert.equal(box.restarter.status().canRestart, false);
});

test('status: meldet hängenden Lauf in Minuten', () => {
  const { restarter, advance } = setup({ eosRun: { inFlight: true, startedAt: T0 } });
  advance(125 * MIN);
  const st = restarter.status();
  assert.equal(st.stalledForMin, 125);
  assert.equal(st.stallRestartMin, 90);
  assert.equal(st.canRestart, true);
  assert.equal(st.serviceName, 'eos.service');
});

// ── Docker (2026-10-18): Neustart über den Wächter im EOS-Container ──────────
import { EOS_CONTAINER_HELPER_FRESH_MS, EOS_CONTAINER_RESTART_TIMEOUT_MS } from '../services/optimizer/eos-restarter.js';

test('Container: ohne Wächter nicht möglich, mit Wächter Anforderung statt systemctl; Neustart erledigt, wenn der Wächter danach startet', async () => {
  const box = setup({ inContainer: true });
  assert.equal(box.restarter.status().reason, 'container', 'kein Wächter gemeldet');
  // Wächter meldet sich (gestartet vor einer Minute), keine Anforderung offen
  assert.deepEqual(box.restarter.helperPoll({ boot: box.at() - MIN }), { requestedAt: null });
  assert.equal(box.restarter.status().canRestart, true);
  assert.equal(box.restarter.status().mode, 'container');
  const requestAt = box.at();
  assert.deepEqual(await box.restarter.restart({ via: 'ui' }), { ok: true, pending: true });
  assert.equal(box.calls.length, 0, 'kein systemctl im Container');
  assert.equal(box.restarter.status().restarting, true);
  // derselbe Wächter fragt wieder: Anforderung ist jünger als sein Start → requestedAt
  box.advance(MIN);
  assert.deepEqual(box.restarter.helperPoll({ boot: requestAt - MIN }), { requestedAt: requestAt });
  // neuer Wächter nach dem Container-Neustart → erledigt
  box.advance(30_000);
  assert.deepEqual(box.restarter.helperPoll({ boot: box.at() - 5_000 }), { requestedAt: null });
  const st = box.restarter.status();
  assert.equal(st.restarting, false);
  assert.equal(st.restarts, 1);
  assert.equal(st.lastRestart.ok, true);
  assert.ok(box.logs.some((l) => l.type === 'eos_restarted' && l.data.service === 'container'));
  // Wächter verstummt → wieder „container“ (kein Knopf ohne Wirkung)
  box.advance(EOS_CONTAINER_HELPER_FRESH_MS + 1);
  assert.equal(box.restarter.status().reason, 'container');
});

test('Container: Wache fordert bei hängendem Lauf an; ohne Rückmeldung nach 10 min gilt der Neustart als gescheitert', async () => {
  const box = setup({ inContainer: true, eosRun: { inFlight: true, startedAt: T0 - 100 * MIN } });
  box.restarter.helperPoll({ boot: T0 - 60 * MIN });
  const r = await box.restarter.watchdogTick();
  assert.equal(r.action, 'restart');
  assert.equal(r.ok, true);
  assert.equal(box.restarter.status().restarting, true);
  assert.deepEqual(await box.restarter.restart({ via: 'ui' }), { ok: true, pending: true }, 'zweite Anforderung teilt die erste');
  box.advance(EOS_CONTAINER_RESTART_TIMEOUT_MS + 1);
  box.restarter.helperPoll({ boot: T0 - 60 * MIN });   // Wächter lebt, startet aber nicht neu
  await box.restarter.watchdogTick();
  const st = box.restarter.status();
  assert.equal(st.restarting, false);
  assert.equal(st.lastRestart.ok, false);
  assert.ok(box.logs.some((l) => l.type === 'eos_restart_failed' && l.data.service === 'container'));
});

test('Container: offene Anforderung läuft auch ohne Wache ab (getrennter Runtime-Prozess)', async () => {
  const box = setup({ inContainer: true });
  box.restarter.helperPoll({ boot: box.at() - MIN });
  await box.restarter.restart({ via: 'ui' });
  box.advance(EOS_CONTAINER_RESTART_TIMEOUT_MS + 1);
  const st = box.restarter.status();          // kein watchdogTick
  assert.equal(st.restarting, false);
  assert.equal(st.lastRestart.ok, false);
});
