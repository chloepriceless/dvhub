// test/mqtt-publisher-optimizer.test.js -- optimizer/* aus dem echten
// Optimizer-Zustand + Textwerte ohne Anführungszeichen (2026-09-14).
//
// Christins HA-Auszug: „Optimizer-Quelle "disabled"" während EOS lief
// (state.optimizer.source = 'eos', 18 EOS-Regeln) — die Topics hingen an
// smallMarketAutomation.lastOutcome, nicht am Prognose-Optimizer. Und jeder
// Textwert kam JSON-kodiert mit Anführungszeichen an ("active"), der
// ISO-Zeitstempel damit für HAs timestamp-Klasse unbrauchbar ("Unbekannt").
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMqttPublisher } from '../services/mqtt/publisher.js';

function makeHub() {
  const published = [];
  return { publish(topic, payload, opts) { published.push({ topic, payload, opts }); }, get connected() { return true; }, _published: published };
}
function raw(hub, topic) { const p = hub._published.find(x => x.topic === topic); return p ? p.payload : undefined; }

function baseState() {
  return {
    meter: {}, victron: {}, epex: { data: [] }, energy: {}, ctrl: {},
    schedule: { active: {}, rules: [], smallMarketAutomation: { lastRunDate: '2026-09-14', lastOutcome: 'idle' } }
  };
}
const ctxFor = (state) => ({ state, getCfg: () => ({ mqtt: {} }), pushLog: () => {} });

describe('optimizer/* aus state.optimizer', () => {
  it('EOS aktiv → source eos, status active, last_run_at als ISO-Zeitstempel', () => {
    const hub = makeHub();
    const state = baseState();
    state.optimizer = { enabled: true, source: 'eos', lastRunAt: '2026-09-14T12:13:49.380Z', rulesCount: 18, error: null };
    createMqttPublisher(hub, ctxFor(state))._publishOnce();
    assert.equal(raw(hub, 'dvhub/optimizer/source'), 'eos');
    assert.equal(raw(hub, 'dvhub/optimizer/status'), 'active');
    assert.equal(raw(hub, 'dvhub/optimizer/last_run_at'), '2026-09-14T12:13:49.380Z');
    assert.equal(raw(hub, 'dvhub/optimizer/rules_count'), '18');
  });

  it('interner Optimizer → source internal', () => {
    const hub = makeHub();
    const state = baseState();
    state.optimizer = { enabled: true, source: 'internal', lastRunAt: '2026-09-14T10:00:00.000Z', rulesCount: 4, error: null };
    createMqttPublisher(hub, ctxFor(state))._publishOnce();
    assert.equal(raw(hub, 'dvhub/optimizer/source'), 'internal');
    assert.equal(raw(hub, 'dvhub/optimizer/status'), 'active');
  });

  it('Optimizer mit Fehler → status error, Quelle bleibt', () => {
    const hub = makeHub();
    const state = baseState();
    state.optimizer = { enabled: true, source: 'eos', lastRunAt: null, rulesCount: 0, error: 'EOS timeout' };
    createMqttPublisher(hub, ctxFor(state))._publishOnce();
    assert.equal(raw(hub, 'dvhub/optimizer/status'), 'error');
    assert.equal(raw(hub, 'dvhub/optimizer/source'), 'eos');
    assert.equal(raw(hub, 'dvhub/optimizer/error'), 'EOS timeout');
  });

  it('nur Kleinmarkt-Automation aktiv → source market_automation, status active', () => {
    const hub = makeHub();
    const state = baseState();
    state.optimizer = { enabled: false, source: null };
    state.schedule.smallMarketAutomation = { lastRunDate: '2026-09-14', lastOutcome: 'generated' };
    createMqttPublisher(hub, ctxFor(state))._publishOnce();
    assert.equal(raw(hub, 'dvhub/optimizer/source'), 'market_automation');
    assert.equal(raw(hub, 'dvhub/optimizer/status'), 'active');
    assert.equal(raw(hub, 'dvhub/optimizer/last_run_at'), '2026-09-14');
  });

  it('nichts aktiv → source none, status disabled', () => {
    const hub = makeHub();
    createMqttPublisher(hub, ctxFor(baseState()))._publishOnce();
    assert.equal(raw(hub, 'dvhub/optimizer/source'), 'none');
    assert.equal(raw(hub, 'dvhub/optimizer/status'), 'disabled');
  });

  it('Lizenz-Gate → source gated, status disabled', () => {
    const hub = makeHub();
    const state = baseState();
    state.optimizer = { enabled: true, source: 'gated_no_license' };
    createMqttPublisher(hub, ctxFor(state))._publishOnce();
    assert.equal(raw(hub, 'dvhub/optimizer/source'), 'gated');
    assert.equal(raw(hub, 'dvhub/optimizer/status'), 'disabled');
  });
});

describe('Payload-Kodierung', () => {
  it('Strings roh (ohne Anführungszeichen), Zahlen/Bool/null als JSON, Objekte als JSON', () => {
    const hub = makeHub();
    const state = baseState();
    state.optimizer = { enabled: true, source: 'eos', lastRunAt: '2026-09-14T12:13:49.380Z' };
    state.meter.grid_total_w = 165;
    state.schedule.active = { gridSetpointW: { value: -100, source: 'default', at: 1 } };
    createMqttPublisher(hub, ctxFor(state))._publishOnce();
    assert.equal(raw(hub, 'dvhub/optimizer/source'), 'eos');
    assert.equal(raw(hub, 'dvhub/energy/grid_power_w'), '165');
    assert.equal(raw(hub, 'dvhub/control/paused'), 'false');
    assert.equal(raw(hub, 'dvhub/control/rule'), 'null');
    assert.equal(raw(hub, 'dvhub/control/updated_at'), new Date(1).toISOString());
    assert.equal(JSON.parse(raw(hub, 'dvhub/control/state')).gridSetpointW.value, -100);
  });
});
