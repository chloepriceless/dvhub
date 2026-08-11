// test/load-separation-integration.test.js -- Inc 2 seam test.
//
// The unit tests cover each piece in isolation. This one wires the REAL parts
// together along the path a poll cycle actually takes:
//
//   TeslaMate MQTT message -> createTeslamateSubscriber (real)
//     -> computeManagedLoad (real)
//       -> createTelemetryWriteBuffer (real)
//         -> buildLiveTelemetrySamples (real)
//           -> rows handed to the store
//
// Only the MQTT hub and the store are faked. What it protects: the field NAMES
// and UNITS crossing those four boundaries. Every unit test can pass while the
// subscriber calls it `chargerPower` in kW and the consumer reads `chargePowerW`
// -- the subtraction would then silently be 0 forever and the series would just
// quietly equal the raw one. That failure is invisible to unit tests by design.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createTeslamateSubscriber } from '../services/mqtt/teslamate.js';
import { createTelemetryWriteBuffer } from '../runtime-performance.js';
import { buildLiveTelemetrySamples } from '../telemetry-runtime.js';
import { computeManagedLoad } from '../managed-load.js';

const LOAD_WHILE_CHARGING_W = 12067; // prod median, design doc §1

function makeHub() {
  const handlers = [];
  return {
    subscribe(topic, handler) { handlers.push({ topic, handler }); },
    get connected() { return true; },
    deliver(topic, payload) {
      const buf = Buffer.from(String(payload));
      for (const { topic: pattern, handler } of handlers) {
        if (topic.startsWith(pattern.replace(/#$/, ''))) handler(topic, buf);
      }
    }
  };
}

function makeCtx() {
  return {
    state: {},
    getCfg: () => ({ integrations: { tesla: { enabled: true, teslamateCarId: 1 } } }),
    pushLog: () => {}
  };
}

/** Run one poll cycle through the real buffer and return the emitted rows by series. */
function pollOnce({ subscriber, devices = [], loadW, nowMs }) {
  const written = [];
  const buffer = createTelemetryWriteBuffer({
    flushIntervalMs: 0,
    now: () => nowMs,
    buildSamples: (snapshot) => buildLiveTelemetrySamples(snapshot),
    writeSamples: (rows) => written.push(...rows)
  });

  const managed = computeManagedLoad({
    loadW,
    tesla: subscriber.getState(),
    teslaUpdatedAt: subscriber.getFieldUpdatedAt(),
    devices,
    nowMs
  });

  buffer.capture({
    ts: new Date(nowMs).toISOString(),
    resolutionSeconds: 2,
    meter: {},
    victron: { selfConsumptionW: loadW },
    managed
  });
  buffer.flush({ force: true });

  return { managed, series: new Map(written.map(r => [r.seriesKey, r.value])) };
}

/**
 * start() installs a periodic snapshot timer, so every subscriber a test creates
 * is registered for teardown via the test context -- no interval outlives its test.
 */
async function startSubscriber(t) {
  const hub = makeHub();
  const sub = createTeslamateSubscriber(hub, makeCtx());
  await sub.start();
  t.after(() => sub.close());
  return { hub, sub };
}

test('a real home-charging MQTT burst removes the EV share from the cleaned series', async (t) => {
  const { hub, sub } = await startSubscriber(t);

  hub.deliver('teslamate/cars/1/charging_state', 'Charging');
  hub.deliver('teslamate/cars/1/geofence', 'Zuhause');
  hub.deliver('teslamate/cars/1/charger_power', '10.7'); // TeslaMate publishes kW

  const { managed, series } = pollOnce({
    subscriber: sub, loadW: LOAD_WHILE_CHARGING_W, nowMs: Date.now()
  });

  // The unit crossing that a unit test cannot catch: kW on the wire, W in the series.
  assert.equal(managed.evW, 10700, 'charger_power 10.7 kW must arrive as 10700 W');
  assert.equal(managed.applied, true);
  assert.equal(series.get('load_power_w'), LOAD_WHILE_CHARGING_W, 'raw series untouched');
  assert.equal(series.get('load_power_w_ex_managed'), 1367);
});

test('the same burst from away-from-home charging changes nothing', async (t) => {
  const { hub, sub } = await startSubscriber(t);

  hub.deliver('teslamate/cars/1/charging_state', 'Charging');
  hub.deliver('teslamate/cars/1/geofence', 'Ionity Kamen');
  hub.deliver('teslamate/cars/1/charger_power', '10.7');

  const { managed, series } = pollOnce({ subscriber: sub, loadW: 1488, nowMs: Date.now() });

  assert.equal(managed.applied, false);
  assert.equal(managed.reason, 'ev_not_home');
  assert.equal(series.get('load_power_w_ex_managed'), series.get('load_power_w'));
});

test('a charge that ended stops being subtracted once its samples age out', async (t) => {
  const { hub, sub } = await startSubscriber(t);

  hub.deliver('teslamate/cars/1/charging_state', 'Charging');
  hub.deliver('teslamate/cars/1/geofence', 'Zuhause');
  hub.deliver('teslamate/cars/1/charger_power', '10.7');

  const now = Date.now();
  const during = pollOnce({ subscriber: sub, loadW: LOAD_WHILE_CHARGING_W, nowMs: now });
  assert.equal(during.managed.applied, true);

  // TeslaMate goes quiet -- the cached values still read "Charging at 10.7 kW".
  // Six hours later the house is drawing its 1.4 kW base load. Without the
  // freshness gate this cycle would store -9.3 kW.
  const later = pollOnce({
    subscriber: sub, loadW: 1400, nowMs: now + 6 * 3600 * 1000
  });

  assert.equal(later.managed.applied, false);
  // All three fields aged out together and the gate reports the FIRST one that
  // fails, so the reason is charging_state rather than charger_power. What matters
  // is that nothing is subtracted; the reason string only has to name a real cause.
  assert.equal(later.managed.reason, 'ev_charging_state_stale');
  assert.equal(later.managed.managedW, 0);
  assert.equal(later.series.get('load_power_w_ex_managed'), 1400);
});

test('a managed device is subtracted through the same path', async (t) => {
  const { sub } = await startSubscriber(t);
  const now = Date.now();

  const { managed, series } = pollOnce({
    subscriber: sub,
    loadW: 2000,
    devices: [
      { id: 'shelly-ventilator', powerW: 30.1, online: true, managed: true, lastSeen: now - 3000 },
      { id: 'shelly-unmanaged', powerW: 500, online: true, managed: false, lastSeen: now - 3000 }
    ],
    nowMs: now
  });

  assert.equal(managed.deviceW, 30.1);
  assert.deepEqual(managed.deviceIds, ['shelly-ventilator']);
  assert.equal(series.get('load_power_w_ex_managed'), 1969.9);
});

test('with no EV and no managed device the cleaned series tracks the raw series exactly', async (t) => {
  const { sub } = await startSubscriber(t);
  const { series } = pollOnce({ subscriber: sub, loadW: 843, nowMs: Date.now() });

  assert.equal(series.get('load_power_w'), 843);
  assert.equal(series.get('load_power_w_ex_managed'), 843,
    'the series must exist every cycle so the forecast learns from a gap-free curve');
});
