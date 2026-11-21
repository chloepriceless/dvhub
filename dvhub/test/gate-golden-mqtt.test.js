// Golden-Master der MQTT/HTTP-Senken (Pfad 1 über transport.mqttWrite und Pfad 3 über die Flaggen-Topics),
// Nachweis D.4(2), drei Betriebsarten:
//   Venus-Brücke (hersteller/bridge-mqtt.json) MIT Rückmeldung: W/-Topics {"value":X}, N/-Echo bestätigt die
//     Schreib-Prüfung (controlWriteVerify); ohne Echo fordert sie per R/ nach und meldet „kein Beweis".
//   DVhub-Schema (hersteller/dvhub-mqtt.json) MIT Broker, OHNE Rückmeldung: <prefix>/control/<ziel>/set, nackte Zahl.
//   DVhub-Schema OHNE Broker (HTTP-Abholung): kein Draht, Ergebnis ok:true/http_pickup, Abholung über
//     GET /api/integration/loxone (dvhub_control_*). Im Not-Halt und bei ungültiger Config seit R-T3 (Abholpuffer hinter
//     dem Tor, services/gate/pickup.js) „keine Vorgabe“ statt des letzten Werts: Sollwerte null, Herkunft none,
//     dvhub_control_suspended mit Grund; danach wieder der aktuelle Wert (bis 24eabf21: der letzte Wert).
// Transport wie in server.js gebaut: createMqttTransport(cfg.victron, { onEvent → pushLog }); Broker ist eine
// Attrappe (connectFn-Naht), die jede Operation in EIN Log schreibt: CONNECT, SUB (Anzahl), PUB topic payload qos.
//
// Frieren: GOLDEN_FREEZE=1 node --test test/gate-golden-mqtt.test.js (schreibt
// test/fixtures/gate-golden/mqtt.json neu). Nur mit belegtem Grund.

import { test } from 'node:test';

import { createMqttTransport } from '../transport-mqtt.js';
import { createApiRoutes } from '../routes-api.js';
import {
  HOST, fixClock, loadProfileConfig, baseState, evaluatorRig, recorder, goldenFile,
} from './helpers/gate-golden.js';

const golden = goldenFile('mqtt');
// Schreib-Prüfung an, sonst Werkswerte (4 s Wartezeit, 30 s Mindestabstand je Steuergröße).
const VERIFY = { controlWriteVerify: { enabled: true } };

// Broker-Attrappe. echo(topic, payload) → [topic, payload] | null: Rückmeldung der Gegenstelle (Venus N/).
function fakeBroker(wire) {
  const ctl = { client: null, echo: null, transport: null };
  ctl.connectFn = (url) => {
    const handlers = {};
    const client = {
      connected: true,
      on(ev, fn) { (handlers[ev] ||= []).push(fn); return client; },
      subscribe(topics, opts, cb) { wire.push(`SUB ${topics.length} q${opts?.qos ?? 0}`); cb(null); },
      publish(topic, payload, opts) {
        wire.push(`PUB ${topic} ${JSON.stringify(String(payload))}${opts ? ` q${opts.qos ?? 0}` : ''}`);
        const back = ctl.echo?.(topic, payload);
        if (back) ctl.transport._onMessage(back[0], Buffer.from(String(back[1])), { retain: false });
      },
      end() { client.connected = false; },
      removeAllListeners() {},
      reconnect() {},
    };
    wire.push(`CONNECT ${url}`);
    ctl.client = client;
    queueMicrotask(() => { for (const fn of handlers.connect || []) fn(); });
    return client;
  };
  return ctl;
}

async function mqttRig({ profile, mqtt = {}, persisted = {}, state = {} }) {
  const cfg = loadProfileConfig(profile, { victron: { host: HOST, mqtt }, schedule: VERIFY, ...persisted });
  const wire = [];
  const events = [];
  const broker = fakeBroker(wire);
  const transport = createMqttTransport(cfg.victron, { connectFn: broker.connectFn, onEvent: (e) => events.push(e) });
  broker.transport = transport;
  const rig = evaluatorRig({ cfg, transport, state: baseState(state), events });
  return { ...rig, wire, broker };
}

// GET /api/integration/loxone über den echten Routen-Handler (ohne Netz) → nur die Steuerzeilen.
async function loxoneControl(rig) {
  const ctx = {
    state: Object.assign(rig.state, { epex: { ok: false, data: [] }, energy: { day: null, importWh: 0, exportWh: 0, costEur: 0, revenueEur: 0 }, costs: {} }),
    getCfg: () => rig.cfg, getRawCfg: () => rig.cfg, pushLog: () => {},
    controlValue: () => (rig.state.ctrl.forcedOff ? 0 : 1), epexNowNext: () => ({ current: null, next: null }),
    needsSetup: () => false, getAppDir: () => process.cwd(), getAppVersion: () => ({ versionLabel: 'test' }),
    applyControlTarget: rig.ev.applyControlTarget,
  };
  const routes = createApiRoutes(ctx);
  const req = { method: 'GET', url: '/api/integration/loxone', headers: { host: 'dvhub.test' }, socket: { remoteAddress: '127.0.0.1' }, on() { return req; }, destroy() {} };
  const res = { status: 0, body: '', writeHead(c) { this.status = c; }, setHeader() {}, end(b) { this.body = b == null ? '' : String(b); } };
  await routes.handleRequest(req, res, new URL('/api/integration/loxone', 'http://dvhub.test'));
  const lines = res.body.split('\n').filter((l) => l.startsWith('dvhub_control_') || l.startsWith('gridSetpointW='));
  return { http: res.status, loxone: lines };
}

const apply = (rig, target, value, source) => () => rig.ev.applyControlTarget(target, value, source);
const wait = (advance, ms) => async () => { await advance(ms); return {}; };

test('MQTT Venus-Brücke mit Rückmeldung: W/-Topics, Bestätigung per N/-Echo, Nachforderung per R/', async (t) => {
  const advance = fixClock(t, ['Date', 'setTimeout', 'setInterval']);
  const rig = await mqttRig({ profile: 'bridge-mqtt', mqtt: { broker: 'mqtt://192.0.2.11:1883' } });
  t.after(() => rig.transport.destroy());
  const r = recorder(rig, () => rig.wire);
  rig.broker.echo = (topic, payload) => (topic.startsWith('W/') ? [topic.replace(/^W\//, 'N/'), payload] : null);
  await r.step('init', async () => { await rig.transport.init(); return {}; });
  await r.step('gridSetpointW -500', apply(rig, 'gridSetpointW', -500, 'rule:abend'));
  await r.step('Prüfung nach 4 s (Echo da)', wait(advance, 4000));
  await r.step('gridSetpointW -500 gleich', apply(rig, 'gridSetpointW', -500, 'rule:abend'));
  await r.step('feedExcessDcPv 0 (§51)', apply(rig, 'feedExcessDcPv', 0, 'negative_price_protection'));
  await r.step('maxDischargeW -1', apply(rig, 'maxDischargeW', -1, 'api_manual_write'));
  await r.step('minSocPct 3 (Klemme)', apply(rig, 'minSocPct', 3, 'api_manual_write'));
  await r.step('chargeCurrentA 30', apply(rig, 'chargeCurrentA', 30, 'api_manual_write'));
  await r.step('Prüfungen nach 4 s', wait(advance, 4000));
  rig.broker.echo = null;
  await r.step('gridSetpointW -800 ohne Echo', apply(rig, 'gridSetpointW', -800, 'rule:abend'));
  await r.step('Prüfung nach Mindestabstand (kein Nach-Write-Wert → R/), Keepalive-Takt', wait(advance, 26_000));
  await r.step('Nachfassen nach 2 s', wait(advance, 2000));
  rig.broker.echo = (topic) => (topic.startsWith('W/') ? [topic.replace(/^W\//, 'N/'), '{"value":-100}'] : null);
  await r.step('gridSetpointW -900, Gegenstelle meldet -100', apply(rig, 'gridSetpointW', -900, 'rule:abend'));
  await r.step('Prüfung nach Mindestabstand (abweichend)', wait(advance, 30_000));
  await r.step('gridSetpointW -900 erneut (lastWrite verworfen)', apply(rig, 'gridSetpointW', -900, 'rule:abend'));
  Object.assign(rig.state.ctrl, { discretionaryWritesPaused: true, pausedAt: Date.now() });
  await r.step('gridSetpointW -1000 im Not-Halt', apply(rig, 'gridSetpointW', -1000, 'rule:abend'));
  rig.state.ctrl.discretionaryWritesPaused = false;
  rig.broker.client.connected = false;
  await r.step('gridSetpointW -700 Broker getrennt', apply(rig, 'gridSetpointW', -700, 'rule:abend'));
  golden.check('venus_bridge_feedback', r.steps);
});

test('MQTT DVhub-Schema mit Broker, ohne Rückmeldung: <prefix>/control/*/set, Prüfung ohne Beweis', async (t) => {
  const advance = fixClock(t, ['Date', 'setTimeout', 'setInterval']);
  const rig = await mqttRig({ profile: 'dvhub-mqtt', mqtt: { broker: 'mqtt://192.0.2.12:1883' } });
  t.after(() => rig.transport.destroy());
  const r = recorder(rig, () => rig.wire);
  await r.step('init', async () => { await rig.transport.init(); return {}; });
  await r.step('gridSetpointW -500', apply(rig, 'gridSetpointW', -500, 'rule:abend'));
  await r.step('Prüfung nach 4 s', wait(advance, 4000));
  await r.step('Nachfassen nach 2 s', wait(advance, 2000));
  await r.step('maxDischargeW -1', apply(rig, 'maxDischargeW', -1, 'api_manual_write'));
  await r.step('chargeCurrentA 30', apply(rig, 'chargeCurrentA', 30, 'api_manual_write'));
  await r.step('minSocPct 20', apply(rig, 'minSocPct', 20, 'api_manual_write'));
  await r.step('feedExcessDcPv 0 (§51)', apply(rig, 'feedExcessDcPv', 0, 'negative_price_protection'));
  await r.step('Abholpuffer (Loxone)', () => loxoneControl(rig));
  Object.assign(rig.state.ctrl, { discretionaryWritesPaused: true, pausedAt: Date.now() });
  await r.step('gridSetpointW -1000 im Not-Halt', apply(rig, 'gridSetpointW', -1000, 'rule:abend'));
  golden.check('dvhub_schema_broker', r.steps);
});

test('DVhub-Schema ohne Broker (HTTP-Abholung): kein Draht, ok:true, Loxone-Steuerzeilen', async (t) => {
  const advance = fixClock(t, ['Date', 'setTimeout', 'setInterval']);
  const rig = await mqttRig({ profile: 'dvhub-mqtt' });
  t.after(() => rig.transport.destroy());
  const r = recorder(rig, () => rig.wire);
  await r.step('init', async () => { await rig.transport.init(); return { brokerMode: rig.transport.brokerMode }; });
  await r.step('gridSetpointW -500', apply(rig, 'gridSetpointW', -500, 'rule:abend'));
  await r.step('Prüfung nach 4 s', wait(advance, 4000));
  await r.step('Nachfassen nach 2 s', wait(advance, 2000));
  await r.step('maxDischargeW 0', apply(rig, 'maxDischargeW', 0, 'api_manual_write'));
  await r.step('Abholpuffer nach Writes', () => loxoneControl(rig));
  Object.assign(rig.state.ctrl, { discretionaryWritesPaused: true, pausedAt: Date.now() });
  await r.step('gridSetpointW -1000 im Not-Halt', apply(rig, 'gridSetpointW', -1000, 'rule:abend'));
  await r.step('Abholpuffer im Not-Halt', () => loxoneControl(rig));
  rig.state.ctrl.discretionaryWritesPaused = false;
  rig.cfg.writeSafety = { ok: false, reason: 'manufacturer_profile_error', manufacturer: 'dvhub-mqtt' };
  await r.step('gridSetpointW -1200 bei writeSafety.ok=false', apply(rig, 'gridSetpointW', -1200, 'rule:abend'));
  await r.step('Abholpuffer bei ungültiger Config', () => loxoneControl(rig));
  delete rig.cfg.writeSafety;
  await r.step('Abholpuffer bei wieder gültiger Config', () => loxoneControl(rig));
  golden.check('dvhub_schema_http_pickup', r.steps);
});
