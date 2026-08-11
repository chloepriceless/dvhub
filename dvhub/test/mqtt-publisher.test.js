// test/mqtt-publisher.test.js -- MQTT Publisher unit tests (INTG-02)
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMqttPublisher } from '../services/mqtt/publisher.js';

function makeMockHub() {
  const published = [];
  return {
    publish(topic, payload, opts) { published.push({ topic, payload, opts }); },
    get connected() { return true; },
    _published: published
  };
}

function makeMockState() {
  return {
    meter: { grid_total_w: 1500, grid_l1_w: 500, grid_l2_w: 500, grid_l3_w: 500 },
    victron: {
      soc: 75, batteryPowerW: -200, minSocPct: 10,
      pvTotalW: 3500, pvPowerW: 3500
    },
    epex: { data: [{ startTs: Date.now() - 60000, endTs: Date.now() + 3540000, price: 8.5 }] },
    schedule: { active: { gridSetpointW: 0 } }
  };
}

function makeMockCtx(state) {
  return {
    state,
    getCfg: () => ({ mqtt: { publishIntervalMs: 5000, topicPrefix: 'dvhub' } }),
    pushLog: () => {}
  };
}

describe('createMqttPublisher', () => {
  let hub, state, ctx;

  beforeEach(() => {
    hub = makeMockHub();
    state = makeMockState();
    ctx = makeMockCtx(state);
  });

  it('exports createMqttPublisher function', () => {
    assert.equal(typeof createMqttPublisher, 'function');
  });

  it('returns object with start, close, topicCount', () => {
    const pub = createMqttPublisher(hub, ctx);
    assert.equal(typeof pub.start, 'function');
    assert.equal(typeof pub.close, 'function');
    assert.equal(typeof pub.topicCount, 'number');
  });

  it('publishOnce publishes topics with retain:true for state topics', () => {
    const pub = createMqttPublisher(hub, ctx);
    pub._publishOnce();
    const retainedTopics = hub._published.filter(p => p.opts?.retain === true);
    assert.ok(retainedTopics.length > 0, 'at least some topics are retained');
  });

  it('publishes dvhub/energy/grid_power_w from state.meter.grid_total_w', () => {
    const pub = createMqttPublisher(hub, ctx);
    pub._publishOnce();
    const gridPub = hub._published.find(p => p.topic === 'dvhub/energy/grid_power_w');
    assert.ok(gridPub, 'grid_power_w topic published');
    assert.equal(JSON.parse(gridPub.payload), 1500);
  });

  it('publishes dvhub/battery/soc_pct from state.victron.soc', () => {
    const pub = createMqttPublisher(hub, ctx);
    pub._publishOnce();
    const socPub = hub._published.find(p => p.topic === 'dvhub/battery/soc_pct');
    assert.ok(socPub, 'battery soc topic published');
    assert.equal(JSON.parse(socPub.payload), 75);
  });

  it('publishes dvhub/solar/pv_total_w from state.victron.pvTotalW', () => {
    const pub = createMqttPublisher(hub, ctx);
    pub._publishOnce();
    const pvPub = hub._published.find(p => p.topic === 'dvhub/solar/pv_total_w');
    assert.ok(pvPub, 'pv_total_w topic published');
    assert.equal(JSON.parse(pvPub.payload), 3500);
  });

  it('publishes dvhub/battery/power_w from state.victron.batteryPowerW', () => {
    const pub = createMqttPublisher(hub, ctx);
    pub._publishOnce();
    const batPub = hub._published.find(p => p.topic === 'dvhub/battery/power_w');
    assert.ok(batPub, 'battery power topic published');
    assert.equal(JSON.parse(batPub.payload), -200);
  });

  it('publishes dvhub/battery/min_soc_pct from state.victron.minSocPct', () => {
    const pub = createMqttPublisher(hub, ctx);
    pub._publishOnce();
    const minSocPub = hub._published.find(p => p.topic === 'dvhub/battery/min_soc_pct');
    assert.ok(minSocPub, 'min_soc_pct topic published');
    assert.equal(JSON.parse(minSocPub.payload), 10);
  });

  it('publishes dvhub/energy/grid_l1_w, grid_l2_w, grid_l3_w', () => {
    const pub = createMqttPublisher(hub, ctx);
    pub._publishOnce();
    for (const suffix of ['grid_l1_w', 'grid_l2_w', 'grid_l3_w']) {
      const p = hub._published.find(x => x.topic === `dvhub/energy/${suffix}`);
      assert.ok(p, `${suffix} topic published`);
      assert.equal(JSON.parse(p.payload), 500);
    }
  });

  it('publishes dvhub/system/uptime_sec', () => {
    const pub = createMqttPublisher(hub, ctx);
    pub._publishOnce();
    const uptimePub = hub._published.find(p => p.topic === 'dvhub/system/uptime_sec');
    assert.ok(uptimePub, 'uptime topic published');
    assert.ok(JSON.parse(uptimePub.payload) >= 0, 'uptime is non-negative');
  });

  it('publishes dvhub/price/epex_current_ct_kwh', () => {
    const pub = createMqttPublisher(hub, ctx);
    pub._publishOnce();
    const pricePub = hub._published.find(p => p.topic === 'dvhub/price/epex_current_ct_kwh');
    assert.ok(pricePub, 'epex price topic published');
    assert.equal(JSON.parse(pricePub.payload), 8.5);
  });

  it('publishes dvhub/optimizer/status', () => {
    const pub = createMqttPublisher(hub, ctx);
    pub._publishOnce();
    const optPub = hub._published.find(p => p.topic === 'dvhub/optimizer/status');
    assert.ok(optPub, 'optimizer status topic published');
  });

  it('topicCount is at least 10', () => {
    const pub = createMqttPublisher(hub, ctx);
    pub._publishOnce();
    assert.ok(pub.topicCount >= 10, `topicCount=${pub.topicCount} should be >= 10`);
  });

  it('close clears interval timer', () => {
    const pub = createMqttPublisher(hub, ctx);
    pub.start();
    pub.close();
    // No assertion needed beyond no-throw; verifies cleanup
  });

  it('respects publishIntervalMs from config', () => {
    const customCtx = {
      ...ctx,
      getCfg: () => ({ mqtt: { publishIntervalMs: 10000, topicPrefix: 'dvhub' } })
    };
    const pub = createMqttPublisher(hub, customCtx);
    assert.equal(pub._getIntervalMs(), 10000);
  });
});
