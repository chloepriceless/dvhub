// test/vehicle-mqtt.test.js -- Fahrzeugdaten ueber frei waehlbare MQTT-Topics.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createVehicleMqtt, extractMqttValue, parseSocPct, parsePlugged
} from '../services/mqtt/vehicle-mqtt.js';

function hub() {
  const handlers = new Map();
  return {
    subscribe(topic, handler) { handlers.set(topic, handler); },
    send(topic, payload) { handlers.get(topic)?.(topic, Buffer.from(String(payload))); },
    topics: () => [...handlers.keys()]
  };
}

describe('Werte lesen', () => {
  test('einfache Zahl, JSON-Feld, JSON ohne Feld', () => {
    assert.equal(extractMqttValue('73', ''), 73);
    assert.equal(extractMqttValue('{"soc": 61, "range": 300}', 'soc'), 61);
    assert.equal(extractMqttValue('{"soc": 61}', ''), null);
    assert.equal(extractMqttValue('unavailable', ''), 'unavailable');
    assert.equal(extractMqttValue('', ''), null);
  });
  test('Ladestand: 0 bis 100, auch mit % und Komma', () => {
    assert.equal(parseSocPct(73), 73);
    assert.equal(parseSocPct('73 %'), 73);
    assert.equal(parseSocPct('73,5'), 73.5);
    assert.equal(parseSocPct(0), 0);
    assert.equal(parseSocPct(101), null);
    assert.equal(parseSocPct(-1), null);
    assert.equal(parseSocPct('unavailable'), null);
    assert.equal(parseSocPct(true), null);
    assert.equal(parseSocPct(null), null);
  });
  test('angesteckt: uebliche Schreibweisen', () => {
    for (const v of [true, 1, 'on', 'ON', 'true', 'connected', 'charging', 'plugged_in']) assert.equal(parsePlugged(v), true, String(v));
    for (const v of [false, 0, 'off', 'false', 'disconnected', 'unplugged']) assert.equal(parsePlugged(v), false, String(v));
    assert.equal(parsePlugged('unknown'), null);
    assert.equal(parsePlugged(null), null);
  });
});

describe('createVehicleMqtt', () => {
  const setup = (optimizer) => {
    const h = hub();
    let t = 1_000_000;
    const cfg = { optimizer };
    const service = createVehicleMqtt(h, { getCfg: () => cfg }, { now: () => t });
    return { h, service, cfg, advance: (ms) => { t += ms; } };
  };

  test('ohne Topic: nichts eingerichtet, nichts abonniert', () => {
    const { h, service } = setup({});
    assert.deepEqual(service.getState(), {
      configured: false, socPct: null, socAt: null, socStale: false, plugged: null, pluggedAt: null
    });
    assert.deepEqual(h.topics(), []);
  });

  test('Ladestand und angesteckt kommen von den eingestellten Topics', () => {
    const { h, service } = setup({ evMqttSocTopic: 'ha/auto/soc', evMqttPluggedTopic: 'ha/auto/plug' });
    assert.equal(service.getState().socPct, null, 'noch keine Nachricht');
    assert.deepEqual(h.topics(), ['ha/auto/soc', 'ha/auto/plug']);
    h.send('ha/auto/soc', '64');
    h.send('ha/auto/plug', 'on');
    const state = service.getState();
    assert.equal(state.configured, true);
    assert.equal(state.socPct, 64);
    assert.equal(state.plugged, true);
    assert.equal(state.socStale, false);
  });

  test('JSON-Objekt mit Feld', () => {
    const { h, service } = setup({ evMqttSocTopic: 'car/state', evMqttSocField: 'battery', evMqttPluggedTopic: 'car/state', evMqttPluggedField: 'plugged' });
    service.start();
    h.send('car/state', '{"battery": 48, "plugged": false}');
    const state = service.getState();
    assert.equal(state.socPct, 48);
    assert.equal(state.plugged, false);
  });

  test('zu alter Wert zaehlt nicht mehr', () => {
    const { h, service, advance } = setup({ evMqttSocTopic: 'ha/auto/soc', evMqttMaxAgeH: 2 });
    service.start();
    h.send('ha/auto/soc', '80');
    advance(2 * 3600_000 - 1000);
    assert.equal(service.getState().socPct, 80);
    advance(2000);
    const state = service.getState();
    assert.equal(state.socPct, null);
    assert.equal(state.socStale, true);
  });

  test('unbrauchbare Nachricht ergibt keinen Ladestand', () => {
    const { h, service } = setup({ evMqttSocTopic: 'ha/auto/soc' });
    service.start();
    h.send('ha/auto/soc', 'unavailable');
    assert.equal(service.getState().socPct, null);
  });

  test('geaendertes Topic wird beim naechsten Lesen abonniert', () => {
    const { h, service, cfg } = setup({ evMqttSocTopic: 'alt/soc' });
    service.getState();
    cfg.optimizer.evMqttSocTopic = 'neu/soc';
    service.getState();
    h.send('alt/soc', '10');
    h.send('neu/soc', '55');
    assert.equal(service.getState().socPct, 55);
  });
});
