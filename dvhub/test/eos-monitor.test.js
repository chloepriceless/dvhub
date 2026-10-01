import test from 'node:test';
import assert from 'node:assert/strict';
import { createEosMonitor, EOS_BUSY_GRACE_MS } from '../services/optimizer/eos-monitor.js';
import { createEosCapabilityProbe } from '../services/optimizer/eos-capabilities.js';

function rig() {
  const r = { t: 1_000_000, health: { ok: true, data: { pid: 10, version: '0.4.0' } }, sol: { rows: [{ ts: 1 }], generatedAt: 'g1' }, healthCalls: 0, solCalls: 0, enabled: true };
  r.m = createEosMonitor({
    isEnabled: () => r.enabled,
    getHealth: async () => { r.healthCalls++; return r.health; },
    fetchSolution: async () => { r.solCalls++; return r.sol; },
    now: () => r.t,
  });
  return r;
}

test('eos-monitor: up → busy bei Timeout (rechnet) → down nach 5 min', async () => {
  const r = rig();
  assert.equal(await r.m.checkHealth(), 'up');
  assert.equal(r.m.status().pid, 10);
  r.health = { ok: false, error: 'EOS request timed out' }; r.t += 60_000;
  assert.equal(await r.m.checkHealth(), 'busy');
  assert.equal(r.m.isUp(), true);
  r.t += EOS_BUSY_GRACE_MS;
  assert.equal(await r.m.checkHealth(), 'down');
  assert.equal(r.m.isUp(), false);
});

test('eos-monitor: Verbindung abgelehnt = sofort down', async () => {
  const r = rig();
  await r.m.checkHealth();
  r.health = { ok: false, error: 'connect ECONNREFUSED 127.0.0.1:8506' };
  assert.equal(await r.m.checkHealth(), 'down');
});

test('eos-monitor: ausgeschaltet = disabled, kein Aufruf', async () => {
  const r = rig(); r.enabled = false;
  assert.equal(await r.m.checkHealth(), 'disabled');
  assert.equal(r.healthCalls, 0);
  assert.equal(r.m.status().reachable, false);
});

test('eos-monitor: letzter Plan bleibt, während EOS rechnet; höchstens 1 Abruf je Minute', async () => {
  const r = rig();
  assert.equal((await r.m.latestSolution()).generatedAt, 'g1');
  await r.m.latestSolution(); r.t += 10_000; await r.m.latestSolution();
  assert.equal(r.solCalls, 1);
  r.health = { ok: false, error: 'EOS request timed out' }; r.t += 60_000;
  await r.m.checkHealth();
  assert.equal((await r.m.latestSolution()).generatedAt, 'g1');
  assert.equal(r.solCalls, 1, 'bei busy keine große Lösung zusätzlich abholen');
});

test('eos-monitor: Neustart (neue PID) verwirft alten Plan und meldet sich', async () => {
  const r = rig(); const seen = [];
  r.m.onRestart((e) => seen.push(e));
  await r.m.checkHealth(); await r.m.latestSolution();
  r.health = { ok: true, data: { pid: 11 } }; r.t += 30_000;
  await r.m.checkHealth();
  assert.deepEqual(seen, [{ oldPid: 10, newPid: 11 }]);
  assert.equal(r.m.status().restarts, 1);
  assert.equal(r.m.status().solutionAt, null);
});

test('capability-probe: Timeout nach erfolgreicher Erkennung → gemerkte Fassung (Geräte bleiben Abbildung)', async () => {
  let ok = true;
  const probe = createEosCapabilityProbe({
    ttlMs: 0,
    request: async (_b, _m, path) => (!ok ? { ok: false, error: 'timeout' }
      : path === '/v1/config' ? { ok: true, data: { devices: { batteries: { battery1: {} }, electric_vehicles: {} }, optimization: { genetic: { interval_sec: 900 } } } }
        : { ok: true, data: { version: '0.4.0' } }),
  });
  assert.equal((await probe.get('http://x')).supports.deviceMap, true);
  ok = false;
  const caps = await probe.get('http://x');
  assert.equal(caps.reachable, true);
  assert.equal(caps.supports.deviceMap, true);
});
