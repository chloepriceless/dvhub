// test/mqtt-publisher-plan.test.js -- EOS-/Optimizer-Plan nach Home Assistant
// (2026-09-14, Christin: "kannst du den EOS Plan auch ausgeben nach Home
// Assistant?"). Der Plan sind die vom Optimizer erzeugten Zeitplan-Regeln
// (state.schedule.rules, autoManaged) als Slots "von … bis … → Befehl",
// retained unter <prefix>/optimizer/plan (JSON) + plan/next + plan/slot_count.
// Geräte-Slots (An/Aus für Geschirrspüler, Heizstab, Wallbox) bekommen
// denselben Kanal (plan.devices), sobald EOS sie liefert.
//
// Dazu: Optimizer-Status direkt nach dem Start — enabled, aber noch kein
// Lauf → source aus der Config, status "starting" (nicht "disabled").
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMqttPublisher } from '../services/mqtt/publisher.js';
import { publishHaDiscoveryTopics } from '../services/mqtt/ha-discovery.js';

function makeHub() {
  const published = [];
  return { publish(topic, payload, opts) { published.push({ topic, payload, opts }); }, get connected() { return true; }, _published: published };
}
const raw = (hub, t) => { const p = hub._published.find(x => x.topic === t); return p ? p.payload : undefined; };
const T0 = Date.UTC(2026, 8, 14, 10, 0, 0); // 12:00 Berlin

function makeState(nowMs = T0) {
  return {
    meter: {}, victron: {}, epex: { data: [] }, energy: {}, ctrl: {},
    optimizer: { enabled: true, source: 'eos', lastRunAt: new Date(nowMs - 60_000).toISOString(), rulesCount: 3, error: null },
    schedule: {
      active: {},
      smallMarketAutomation: { lastOutcome: 'idle' },
      rules: [
        { id: 'manuell-1', enabled: true, target: 'gridSetpointW', value: -500, start: '06:00', end: '07:00' },
        { id: 'opt-3-2', enabled: true, autoManaged: true, source: 'forecast_optimizer', optimizer: 'eos', target: 'gridSetpointW', value: -4000, slotTs: nowMs + 2 * 3600_000, slotEndTs: nowMs + 2 * 3600_000 + 900_000 },
        { id: 'opt-1-0', enabled: true, autoManaged: true, source: 'forecast_optimizer', optimizer: 'eos', target: 'gridSetpointW', value: 3000, slotTs: nowMs + 900_000, slotEndTs: nowMs + 1800_000 },
        { id: 'opt-2-1', enabled: true, autoManaged: true, source: 'forecast_optimizer', optimizer: 'eos', target: 'dcExportMode', value: 1, slotTs: nowMs + 1800_000, slotEndTs: nowMs + 2700_000, chargeReserveW: 1500 },
        { id: 'opt-0-9', enabled: true, autoManaged: true, source: 'forecast_optimizer', optimizer: 'eos', target: 'gridSetpointW', value: -2000, slotTs: nowMs - 3600_000, slotEndTs: nowMs - 2700_000 },
        { id: 'opt-x', enabled: false, autoManaged: true, source: 'forecast_optimizer', optimizer: 'eos', target: 'gridSetpointW', value: -1, slotTs: nowMs + 7200_000, slotEndTs: nowMs + 8100_000 }
      ]
    }
  };
}
const ctxFor = (state, now = T0) => ({ state, getCfg: () => ({ mqtt: {}, optimizer: { primarySource: 'eos' } }), pushLog: () => {}, now: () => now });

describe('optimizer/plan', () => {
  it('publiziert die Optimizer-Slots chronologisch, ohne abgelaufene, ohne manuelle, ohne deaktivierte Regeln', () => {
    const hub = makeHub();
    createMqttPublisher(hub, ctxFor(makeState()))._publishOnce();
    const plan = JSON.parse(raw(hub, 'dvhub/optimizer/plan'));
    assert.equal(plan.source, 'eos');
    assert.equal(plan.generatedAt, new Date(T0 - 60_000).toISOString());
    assert.equal(plan.slotMinutes, 15);
    assert.deepEqual(plan.slots.map(s => s.rule), ['opt-1-0', 'opt-2-1', 'opt-3-2'], 'chronologisch, ohne opt-0-9 (vorbei), manuell-1, opt-x (aus)');
    const s0 = plan.slots[0];
    assert.equal(s0.start, new Date(T0 + 900_000).toISOString());
    assert.equal(s0.end, new Date(T0 + 1800_000).toISOString());
    assert.equal(s0.target, 'gridSetpointW');
    assert.equal(s0.value, 3000);
    assert.equal(s0.action, 'import', 'positiver Netz-Sollwert = beziehen/laden');
    assert.equal(plan.slots[1].action, 'export_surplus', 'dcExportMode-Hebel = PV-Überschuss einspeisen');
    assert.equal(plan.slots[1].chargeReserveW, 1500);
    assert.equal(plan.slots[2].action, 'export');
    assert.equal(plan.validFrom, s0.start);
    assert.equal(plan.validUntil, plan.slots[2].end);
    assert.deepEqual(plan.devices, [], 'Geräte-Slots reserviert (EOS flexible consumers)');
    const p = hub._published.find(x => x.topic === 'dvhub/optimizer/plan');
    assert.equal(p.opts.retain, true);
  });

  it('plan/next = nächster Slot mit Vorlauf in Minuten, plan/slot_count als Zahl', () => {
    const hub = makeHub();
    createMqttPublisher(hub, ctxFor(makeState()))._publishOnce();
    const next = JSON.parse(raw(hub, 'dvhub/optimizer/plan/next'));
    assert.equal(next.rule, 'opt-1-0');
    assert.equal(next.startsInMin, 15);
    assert.equal(next.action, 'import');
    assert.equal(raw(hub, 'dvhub/optimizer/plan/slot_count'), '3');
    assert.equal(raw(hub, 'dvhub/optimizer/plan/next_start'), new Date(T0 + 900_000).toISOString());
  });

  it('laufender Slot zählt als aktuell: plan/current gesetzt, next ist der folgende', () => {
    const hub = makeHub();
    const st = makeState();
    st.schedule.rules.push({ id: 'opt-now', enabled: true, autoManaged: true, source: 'forecast_optimizer', optimizer: 'eos', target: 'gridSetpointW', value: -1500, slotTs: T0 - 300_000, slotEndTs: T0 + 600_000 });
    createMqttPublisher(hub, ctxFor(st))._publishOnce();
    const cur = JSON.parse(raw(hub, 'dvhub/optimizer/plan/current'));
    assert.equal(cur.rule, 'opt-now');
    assert.equal(JSON.parse(raw(hub, 'dvhub/optimizer/plan/next')).rule, 'opt-1-0');
    assert.equal(JSON.parse(raw(hub, 'dvhub/optimizer/plan')).slots[0].rule, 'opt-now', 'laufender Slot bleibt im Plan');
  });

  it('kein Plan → leere Slots, next/current null, slot_count 0', () => {
    const hub = makeHub();
    const st = makeState();
    st.schedule.rules = [];
    createMqttPublisher(hub, ctxFor(st))._publishOnce();
    const plan = JSON.parse(raw(hub, 'dvhub/optimizer/plan'));
    assert.deepEqual(plan.slots, []);
    assert.equal(plan.validFrom, null);
    assert.equal(raw(hub, 'dvhub/optimizer/plan/next'), 'null');
    assert.equal(raw(hub, 'dvhub/optimizer/plan/current'), 'null');
    assert.equal(raw(hub, 'dvhub/optimizer/plan/slot_count'), '0');
    assert.equal(raw(hub, 'dvhub/optimizer/plan/next_start'), 'null');
  });

  it('Kleinmarkt-Regeln (sma-…) gehören ebenfalls in den Plan, Quelle market_automation je Slot', () => {
    const hub = makeHub();
    const st = makeState();
    st.schedule.rules.push({ id: 'sma-5-1', enabled: true, autoManaged: true, source: 'small_market_automation', target: 'gridSetpointW', value: -3000, slotTs: T0 + 3 * 3600_000, slotEndTs: T0 + 3 * 3600_000 + 900_000 });
    createMqttPublisher(hub, ctxFor(st))._publishOnce();
    const plan = JSON.parse(raw(hub, 'dvhub/optimizer/plan'));
    const sma = plan.slots.find(s => s.rule === 'sma-5-1');
    assert.equal(sma.source, 'market_automation');
    assert.equal(plan.slots[0].source, 'eos');
  });
});

describe('plan.source vor dem ersten Lauf', () => {
  it('state.optimizer.source null → Plan nennt die konfigurierte Quelle wie optimizer/source', () => {
    const hub = makeHub();
    const st = makeState();
    st.optimizer = { enabled: true, source: null, lastRunAt: null, rulesCount: 0, error: 'No price data available' };
    createMqttPublisher(hub, ctxFor(st))._publishOnce();
    assert.equal(JSON.parse(raw(hub, 'dvhub/optimizer/plan')).source, 'eos');
    assert.equal(JSON.parse(raw(hub, 'dvhub/optimizer/plan/ranges')).source, 'eos');
  });
});

describe('optimizer/status direkt nach dem Start', () => {
  it('enabled ohne Lauf → source aus der Config, status starting', () => {
    const hub = makeHub();
    const st = makeState();
    st.optimizer = { enabled: true, source: null, lastRunAt: null, rulesCount: 0, error: null };
    createMqttPublisher(hub, ctxFor(st))._publishOnce();
    assert.equal(raw(hub, 'dvhub/optimizer/source'), 'eos');
    assert.equal(raw(hub, 'dvhub/optimizer/status'), 'starting');
  });
  it('enabled, erster Lauf mit Fehler → status error, source aus der Config', () => {
    const hub = makeHub();
    const st = makeState();
    st.optimizer = { enabled: true, source: null, lastRunAt: null, rulesCount: 0, error: 'No price data available' };
    createMqttPublisher(hub, ctxFor(st))._publishOnce();
    assert.equal(raw(hub, 'dvhub/optimizer/status'), 'error');
    assert.equal(raw(hub, 'dvhub/optimizer/source'), 'eos');
  });
});

describe('optimizer/plan/ranges — zusammenhängende Slots als Bereiche "von … bis …"', () => {
  function slotRule(i, value, extra = {}) {
    const ts = T0 + 900_000 * (i + 1);
    return { id: `opt-${ts}-${i}`, enabled: true, autoManaged: true, source: 'forecast_optimizer', optimizer: 'eos', target: 'gridSetpointW', value, slotTs: ts, slotEndTs: ts + 900_000, confidence: 0.6, ...extra };
  }

  it('fasst aufeinanderfolgende Slots mit gleichem Befehl zusammen, Lücken und Wechsel trennen', () => {
    const hub = makeHub();
    const st = makeState();
    st.schedule.rules = [slotRule(0, -3000), slotRule(1, -3000), slotRule(2, -3000), slotRule(3, 2000), slotRule(4, 2000), slotRule(6, -3000)];
    createMqttPublisher(hub, ctxFor(st))._publishOnce();
    const r = JSON.parse(raw(hub, 'dvhub/optimizer/plan/ranges'));
    assert.equal(r.source, 'eos');
    assert.equal(r.rangeCount, 3);
    assert.deepEqual(r.ranges.map(x => [x.action, x.value, x.slots]), [['export', -3000, 3], ['import', 2000, 2], ['export', -3000, 1]]);
    assert.equal(r.ranges[0].start, new Date(T0 + 900_000).toISOString());
    assert.equal(r.ranges[0].end, new Date(T0 + 4 * 900_000).toISOString(), 'Ende des letzten zusammengefassten Slots');
    assert.equal(r.ranges[2].start, new Date(T0 + 7 * 900_000).toISOString(), 'Lücke bei Slot 5 trennt');
    assert.equal(r.validFrom, r.ranges[0].start);
    assert.equal(r.validUntil, r.ranges[2].end);
    assert.equal('rule' in r.ranges[0], false, 'keine Regel-IDs in den Bereichen (Platz)');
    assert.equal(JSON.parse(raw(hub, 'dvhub/optimizer/plan')).slotCount, 6, 'voller Slot-Plan bleibt daneben');
  });

  it('export_surplus mit gleicher Ladereserve wird zusammengefasst, andere Reserve trennt', () => {
    const hub = makeHub();
    const st = makeState();
    st.schedule.rules = [
      slotRule(0, 1, { target: 'dcExportMode', chargeReserveW: 1500 }),
      slotRule(1, 1, { target: 'dcExportMode', chargeReserveW: 1500 }),
      slotRule(2, 1, { target: 'dcExportMode', chargeReserveW: 800 })
    ];
    createMqttPublisher(hub, ctxFor(st))._publishOnce();
    const r = JSON.parse(raw(hub, 'dvhub/optimizer/plan/ranges'));
    assert.deepEqual(r.ranges.map(x => [x.action, x.chargeReserveW, x.slots]), [['export_surplus', 1500, 2], ['export_surplus', 800, 1]]);
  });

  it('bleibt auch im schlechtesten Fall (96 wechselnde Slots, realistische IDs) unter 12 KB', () => {
    const hub = makeHub();
    const st = makeState();
    st.schedule.rules = Array.from({ length: 96 }, (_, i) => slotRule(i, i % 2 ? -4000 : 3000));
    createMqttPublisher(hub, ctxFor(st))._publishOnce();
    const payload = raw(hub, 'dvhub/optimizer/plan/ranges');
    assert.equal(JSON.parse(payload).rangeCount, 96);
    assert.ok(Buffer.byteLength(payload) < 12 * 1024, `ranges payload ${Buffer.byteLength(payload)} B`);
  });

  it('kein Plan → leere Bereiche', () => {
    const hub = makeHub();
    const st = makeState();
    st.schedule.rules = [];
    createMqttPublisher(hub, ctxFor(st))._publishOnce();
    const r = JSON.parse(raw(hub, 'dvhub/optimizer/plan/ranges'));
    assert.deepEqual(r.ranges, []);
    assert.equal(r.rangeCount, 0);
  });
});

describe('HA discovery — Plan-Entitäten', () => {
  it('optimizer_plan trägt die Slots als Attribute, optimizer_plan_next ist ein Zeitstempel', () => {
    const hub = makeHub();
    publishHaDiscoveryTopics(hub, () => ({ mqtt: { topicPrefix: 'dvhub', haDiscovery: { enabled: true } } }), '1.0.7');
    const byId = {};
    for (const p of hub._published) { const pl = JSON.parse(p.payload); byId[pl.unique_id] = pl; }
    const plan = byId['dvhub_optimizer_plan'];
    assert.ok(plan, 'optimizer_plan vorhanden');
    assert.equal(plan.state_topic, 'dvhub/optimizer/plan/slot_count');
    // HA begrenzt json_attributes auf 16 KB — der volle 96-Slot-Plan mit
    // realistischen Regel-IDs liegt darüber (Codex-Messung 18–19 KB). HA
    // bekommt deshalb die verdichteten Bereiche, nicht die Einzel-Slots.
    assert.equal(plan.json_attributes_topic, 'dvhub/optimizer/plan/ranges');
    const next = byId['dvhub_optimizer_plan_next'];
    assert.equal(next.state_topic, 'dvhub/optimizer/plan/next_start');
    assert.equal(next.device_class, 'timestamp');
    assert.equal(next.json_attributes_topic, 'dvhub/optimizer/plan/next');
  });
});
