// test/mqtt-command-subscriber.test.js -- eingehende MQTT-Steuerbefehle
// (2026-09-26, bidirektionale HA-Integration).
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMqttCommandSubscriber } from '../services/mqtt/command-subscriber.js';
import { createMqttHub } from '../services/mqtt/index.js';

function makeCtx(overrides = {}) {
  const calls = { manual: [], stop: [], ev: [], evMode: [], device: [], logs: [] };
  const ctx = {
    getCfg: () => ({ mqtt: { topicPrefix: 'dvhub', haDiscovery: { enabled: true } }, optimizer: { evEvccLoadpoint: 1 } }),
    pushLog: (event, data, level) => calls.logs.push({ event, data, level }),
    applyManualControlWrite: async (opts) => { calls.manual.push(opts); return { ok: true, status: 200 }; },
    setEmergencyStop: async (opts) => { calls.stop.push(opts); return { ok: true, status: 200 }; },
    applyEvConfigPatch: (opts) => { calls.ev.push(opts); return { ok: true, status: 200 }; },
    evccIntegration: { setMode: async (lp, mode) => { calls.evMode.push({ lp, mode }); return { ok: true, mode }; } },
    deviceService: { setDeviceOutput: async (id, on) => { calls.device.push({ id, on }); return { ok: true, output: on }; } },
    ...overrides,
  };
  return { ctx, calls };
}

const noopHub = { subscribe() {}, publish() {}, get connected() { return true; } };

describe('createMqttCommandSubscriber', () => {
  afterEach(() => { delete process.env.DVHUB_READ_ONLY; });

  it('subscribes to <prefix>/cmd/# on start', () => {
    const subs = [];
    const hub = { subscribe: (p, h) => subs.push(p), publish() {} };
    const { ctx } = makeCtx();
    createMqttCommandSubscriber(hub, ctx).start();
    assert.deepEqual(subs, ['dvhub/cmd/#']);
  });

  it('routes a numeric setpoint to applyManualControlWrite', async () => {
    const { ctx, calls } = makeCtx();
    const sub = createMqttCommandSubscriber(noopHub, ctx);
    await sub._handleMessage('dvhub/cmd/min_soc_pct', Buffer.from('25'));
    assert.equal(calls.manual.length, 1);
    assert.equal(calls.manual[0].target, 'minSocPct');
    assert.equal(calls.manual[0].value, 25);
    assert.equal(calls.manual[0].reason, 'mqtt_command');
  });

  it('maps all four numeric setpoint targets', async () => {
    const { ctx, calls } = makeCtx();
    const sub = createMqttCommandSubscriber(noopHub, ctx);
    await sub._handleMessage('dvhub/cmd/grid_setpoint_w', '-2500');
    await sub._handleMessage('dvhub/cmd/charge_current_a', '30');
    await sub._handleMessage('dvhub/cmd/max_discharge_w', '-1');
    assert.deepEqual(calls.manual.map(c => [c.target, c.value]), [
      ['gridSetpointW', -2500], ['chargeCurrentA', 30], ['maxDischargeW', -1],
    ]);
  });

  it('rejects a non-numeric setpoint payload without calling the write', async () => {
    const { ctx, calls } = makeCtx();
    const sub = createMqttCommandSubscriber(noopHub, ctx);
    await sub._handleMessage('dvhub/cmd/min_soc_pct', 'nonsense');
    assert.equal(calls.manual.length, 0);
    assert.ok(calls.logs.some(l => l.event === 'mqtt_command_rejected'));
  });

  it('emergency_stop ON -> setEmergencyStop({on:true}), OFF -> {on:false}', async () => {
    const { ctx, calls } = makeCtx();
    const sub = createMqttCommandSubscriber(noopHub, ctx);
    await sub._handleMessage('dvhub/cmd/emergency_stop', 'ON');
    await sub._handleMessage('dvhub/cmd/emergency_stop', 'OFF');
    assert.deepEqual(calls.stop.map(c => c.on), [true, false]);
  });

  it('ev/optimize and ev/only_when_plugged patch the EV config', async () => {
    const { ctx, calls } = makeCtx();
    const sub = createMqttCommandSubscriber(noopHub, ctx);
    await sub._handleMessage('dvhub/cmd/ev/optimize', 'ON');
    await sub._handleMessage('dvhub/cmd/ev/only_when_plugged', 'OFF');
    assert.deepEqual(calls.ev.map(c => c.body), [{ optimizeEv: true }, { onlyWhenPlugged: false }]);
  });

  it('ev/target_soc_pct patches departure targetMode=percent', async () => {
    const { ctx, calls } = makeCtx();
    const sub = createMqttCommandSubscriber(noopHub, ctx);
    await sub._handleMessage('dvhub/cmd/ev/target_soc_pct', '80');
    assert.deepEqual(calls.ev[0].body, { departure: { targetMode: 'percent', targetValue: 80 } });
  });

  it('ev/mode sets the evcc loadpoint mode; rejects an unknown mode', async () => {
    const { ctx, calls } = makeCtx();
    const sub = createMqttCommandSubscriber(noopHub, ctx);
    await sub._handleMessage('dvhub/cmd/ev/mode', 'pv');
    assert.deepEqual(calls.evMode, [{ lp: 1, mode: 'pv' }]);
    await sub._handleMessage('dvhub/cmd/ev/mode', 'bogus');
    assert.equal(calls.evMode.length, 1); // unchanged
    assert.ok(calls.logs.some(l => l.event === 'mqtt_command_rejected'));
  });

  it('device/<id> toggles the device output', async () => {
    const { ctx, calls } = makeCtx();
    const sub = createMqttCommandSubscriber(noopHub, ctx);
    await sub._handleMessage('dvhub/cmd/device/shelly-1', 'ON');
    assert.deepEqual(calls.device, [{ id: 'shelly-1', on: true }]);
  });

  it('unknown command is rejected, not thrown', async () => {
    const { ctx, calls } = makeCtx();
    const sub = createMqttCommandSubscriber(noopHub, ctx);
    await sub._handleMessage('dvhub/cmd/nope', 'x');
    assert.ok(calls.logs.some(l => l.event === 'mqtt_command_rejected' && l.data.error === 'unknown_command'));
  });

  it('gate: does nothing when HA discovery is disabled', async () => {
    const { ctx, calls } = makeCtx({
      getCfg: () => ({ mqtt: { topicPrefix: 'dvhub', haDiscovery: { enabled: false } } }),
    });
    const sub = createMqttCommandSubscriber(noopHub, ctx);
    await sub._handleMessage('dvhub/cmd/min_soc_pct', '25');
    assert.equal(calls.manual.length, 0);
    assert.ok(calls.logs.some(l => l.event === 'mqtt_command_ignored' && l.data.reason === 'ha_discovery_disabled'));
  });

  it('gate: does nothing in read-only mode', async () => {
    process.env.DVHUB_READ_ONLY = '1';
    const { ctx, calls } = makeCtx();
    const sub = createMqttCommandSubscriber(noopHub, ctx);
    await sub._handleMessage('dvhub/cmd/grid_setpoint_w', '-2500');
    assert.equal(calls.manual.length, 0);
    assert.ok(calls.logs.some(l => l.event === 'mqtt_command_ignored' && l.data.reason === 'read_only_mode'));
  });

  it('ignores topics outside the cmd namespace', async () => {
    const { ctx, calls } = makeCtx();
    const sub = createMqttCommandSubscriber(noopHub, ctx);
    await sub._handleMessage('dvhub/control/min_soc_pct', '25');
    assert.equal(calls.manual.length, 0);
    assert.equal(calls.logs.length, 0);
  });

  it('rejects a RETAINED command replay (packet.retain=true) — Codex P1', async () => {
    const { ctx, calls } = makeCtx();
    const sub = createMqttCommandSubscriber(noopHub, ctx);
    // Retained cmd/emergency_stop=OFF darf einen aktiven Not-Halt NICHT aufheben.
    await sub._handleMessage('dvhub/cmd/emergency_stop', 'OFF', { retain: true });
    assert.equal(calls.stop.length, 0);
    assert.ok(calls.logs.some(l => l.event === 'mqtt_command_ignored' && l.data.reason === 'retained_replay'));
    // Fresh (non-retained) delivery is executed.
    await sub._handleMessage('dvhub/cmd/emergency_stop', 'OFF', { retain: false });
    assert.deepEqual(calls.stop.map(c => c.on), [false]);
  });

  it('through the REAL hub dispatch: retain flag reaches the handler and is rejected — Codex P1 (integration)', async () => {
    // Deckt die Verdrahtung Hub→Subscriber ab (Paket-Weitergabe), die die
    // _handleMessage-Unit-Tests nicht berühren. Kein Socket: _dispatchMessage
    // ist die interne Zustellung.
    const calls = { stop: [], logs: [] };
    const ctx = {
      getCfg: () => ({ mqtt: { topicPrefix: 'dvhub', haDiscovery: { enabled: true } } }),
      pushLog: (event, data) => calls.logs.push({ event, data }),
      setEmergencyStop: async (opts) => { calls.stop.push(opts); return { ok: true, status: 200 }; },
    };
    const hub = createMqttHub({ getCfg: ctx.getCfg, pushLog: ctx.pushLog });
    createMqttCommandSubscriber(hub, ctx).start();
    // Retained-Replay durch die echte Dispatch-Kette → abgewiesen.
    hub._dispatchMessage('dvhub/cmd/emergency_stop', Buffer.from('OFF'), { retain: true });
    // Frisch → ausgeführt.
    hub._dispatchMessage('dvhub/cmd/emergency_stop', Buffer.from('ON'), { retain: false });
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(calls.stop.map(c => c.on), [true], 'nur das frische ON wird ausgeführt');
    assert.ok(calls.logs.some(l => l.event === 'mqtt_command_ignored' && l.data.reason === 'retained_replay'));
  });

  it('resubscribe() picks up a changed topic prefix — Codex P2', async () => {
    const subs = [];
    const hub = { subscribe: (p) => subs.push(p), publish() {} };
    let prefix = 'dvhub';
    const { ctx } = makeCtx({
      getCfg: () => ({ mqtt: { topicPrefix: prefix, haDiscovery: { enabled: true } }, optimizer: {} }),
    });
    const sub = createMqttCommandSubscriber(hub, ctx);
    sub.start();
    assert.deepEqual(subs, ['dvhub/cmd/#']);
    prefix = 'home/energy';
    sub.resubscribe();
    assert.deepEqual(subs, ['dvhub/cmd/#', 'home/energy/cmd/#']);
    // No-op wenn sich nichts ändert.
    sub.resubscribe();
    assert.equal(subs.length, 2);
  });
});
