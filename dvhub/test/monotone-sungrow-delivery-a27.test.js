// A27 (Christin 24.11.2026, „A27 a“): die Liefert-nicht-Erkennung und die gemessene Lieferfähigkeit des Sungrow-Splits
// (M28, trackDelivery/judgeLimit) rechnen durchgehend monoton — Takt, Befehlszeit, Messzeit (Erzeuger-Marke von Poller
// und Begleitdienst, A24), Einschwingzeit (LIMIT_SETTLE_MS), STALL_DETECT_MS, LIMIT_CONFIRM_MS, Probe- und Verfallsfrist.
// Die Wanduhr springt in diesen Tests um ±3 h, die monotone Uhr läuft gleichmäßig. Jeder Test war vor A27 rot.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSungrowEms, EMS_CMD, wire } from '../services/inverter/sungrow.js';
import { stampMono } from '../services/mono-clock.js';
import { loadSungrowConfig, sungrowImage, mockSungrow, sungrowDevice } from './helpers/sungrow-fixture.js';

const H3 = 3 * 3_600_000;
const CMD = wire(13051);
const POWER = wire(13052);
const SLAVE_HOST = '192.168.68.83';

function rig() {
  const secondInverter = { host: SLAVE_HOST, aggregateTelemetry: true, strategyCharge: 'soc-balance', strategyDischarge: 'soc-balance', maxChargeW: 5000, maxDischargeW: 5000, batteryCapacityWh: 10000 };
  const cfg = loadSungrowConfig({ gridPositiveMeans: 'grid_import', sungrow: { controlMode: 'forced', heartbeatTimeoutS: 30, secondInverter, regulateEveryMs: 1000 }, optimizer: { maxChargeW: 5000, maxDischargeW: 5000, batteryCapacityWh: 10000 } });
  cfg.sungrow.regulateEveryMs = 1000;
  const masterImage = sungrowImage({});
  const slaveImage = sungrowImage({});
  const c = { wall: 1_800_000_000_000, mono: 50_000 };
  const now = () => c.wall;
  const monoNow = () => c.mono;
  const state = {
    victron: { errors: {}, fieldUpdatedAt: {}, device: sungrowDevice({ bdcRatedW: 10000 }), batteryPowerW: 0, pvPowerW: 0, selfConsumptionW: 500, soc: 50, sungrowMasterSocPct: 30 },
    meter: { ok: true, updatedAt: c.wall, grid_total_w: 0 },
    ctrl: {},
    sungrowSecond: { online: true, updatedAt: c.wall, host: SLAVE_HOST, aggregate: true, batteryPowerW: -500, pvPowerW: 0, socPct: 40, bdcRatedW: 10000 },
  };
  const logs = [];
  const pushLog = (e, d) => logs.push({ event: e, data: d });
  const slaveEms = createSungrowEms({
    state, getCfg: () => cfg, transport: mockSungrow(slaveImage), pushLog, now, monoNow,
    statusKey: 'sungrowEmsSlave', isSlave: true, connOverride: () => ({ host: SLAVE_HOST, port: 502, unitId: 1, timeoutMs: 1500 }),
  });
  const ems = createSungrowEms({ state, getCfg: () => cfg, transport: mockSungrow(masterImage), pushLog, now, monoNow, slaveActuator: slaveEms });
  // Poller und Begleitdienst: Wanduhr-Stempel plus monotone Marke (A24) mit derselben Uhr wie der Aktuator.
  const measure = ({ masterBattW, slaveBattW, gridW, loadW = 1342 }) => {
    state.meter = { ok: true, updatedAt: c.wall, grid_total_w: gridW };
    Object.assign(state.victron, { sungrowMasterBatteryW: masterBattW, batteryPowerW: masterBattW + slaveBattW, pvPowerW: 0, selfConsumptionW: loadW });
    for (const f of ['batteryPowerW', 'pvPowerW', 'selfConsumptionW']) {
      state.victron.fieldUpdatedAt[f] = c.wall;
      stampMono(state.victron.fieldUpdatedAt, f, { clock: monoNow });
    }
    Object.assign(state.sungrowSecond, { batteryPowerW: slaveBattW, updatedAt: c.wall });
    stampMono(state.sungrowSecond, 'updatedAt', { clock: monoNow });
  };
  const tick = (ms) => { c.wall += ms; c.mono += ms; };
  const jump = (ms) => { c.wall += ms; };
  return { state, ems, masterImage, slaveImage, logs, measure, tick, jump };
}

const stalled = (r) => r.state.ctrl.sungrowEms.decision?.split?.masterOut === 'stalled';

// Ausgangslage wie im Feldbeleg (M28): Entladen 1200 W, Master 300 / Slave 900, der Master liefert 0 W.
async function start(r) {
  r.measure({ masterBattW: 0, slaveBattW: -790, gridW: 552 });
  await r.ems.applySetpoint(-40, 'default');
  assert.equal(r.masterImage.holding.get(POWER), 300);
  assert.equal(r.slaveImage.holding.get(POWER), 900);
}

async function stallTicks(r, n) {
  let at = null;
  for (let i = 1; i <= n; i += 1) {
    r.tick(1000);
    r.measure({ masterBattW: 0, slaveBattW: -790, gridW: 552 });
    await r.ems.tick();
    if (at == null && stalled(r)) at = i;
  }
  return at;
}

test('A27 Liefert-nicht: Rücksprung (−3 h) direkt nach dem Befehl — der hängende Master wird nach ~10 s Laufzeit erkannt', async () => {
  const r = rig();
  await start(r);
  r.jump(-H3);
  const at = await stallTicks(r, 14);
  assert.ok(at != null && at >= 10 && at <= 12, `erkannt nach ~10 s Laufzeit (Takt ${at})`);
  assert.equal(r.slaveImage.holding.get(POWER), 1200, 'Slave übernimmt den vollen Bedarf');
  assert.equal(r.masterImage.holding.get(CMD), EMS_CMD.STOP);
});

test('A27 Liefert-nicht: Sprung vorwärts (+3 h) nach 2 s — keine Erkennung vor ~10 s Laufzeit', async () => {
  const r = rig();
  await start(r);
  assert.equal(await stallTicks(r, 2), null);
  r.jump(H3);
  const at = await stallTicks(r, 12);
  assert.ok(at != null && at >= 8 && at <= 10, `nicht vorzeitig (Takt ${at} nach dem Sprung, ~10 s Messzeit insgesamt)`);
});

test('A27 Probe: Rücksprung während der Probe-Frist — der Master bekommt seinen Anteil nach ~60 s Laufzeit zurück', async () => {
  const r = rig();
  await start(r);
  assert.ok(await stallTicks(r, 12) != null, 'erkannt');
  r.jump(-H3);
  let probedAt = null;
  for (let i = 1; i <= 70 && probedAt == null; i += 1) {
    r.tick(1000);
    r.measure({ masterBattW: 0, slaveBattW: -1200, gridW: -40 });
    await r.ems.tick();
    if (r.state.ctrl.sungrowEms.decision.split.masterW > 0) probedAt = i;
  }
  assert.ok(probedAt != null && probedAt >= 55 && probedAt <= 62, `Probe nach ~60 s Laufzeit (Takt ${probedAt})`);
});
