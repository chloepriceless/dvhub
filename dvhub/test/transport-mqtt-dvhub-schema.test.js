// test/transport-mqtt-dvhub-schema.test.js -- generisches DVhub-Topic-Schema
// im MQTT-Transport (2026-09-14). Neben dem Venus-Schema (N/ W/ R/) kann eine
// Anlage, deren Akku/PV/Zähler nur in Home Assistant oder Loxone existiert,
// die Lesepfade unter <prefix>/input/… liefern und Steuerbefehle unter
// <prefix>/control/<key>/set entgegennehmen — ohne Venus-Konventionen,
// ohne Keepalive, mit nackten Zahlen als Payload.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildDvhubTopicMaps, buildVenusTopicMaps, parseMqttPayload, createMqttTransport } from '../transport-mqtt.js';

describe('buildDvhubTopicMaps', () => {
  it('bildet dieselben Lesepunkte wie Venus ab — ohne die Victron-spezifischen feedExcess-Punkte', () => {
    const venus = buildVenusTopicMaps('x');
    const dv = buildDvhubTopicMaps('dvhub');
    const venusRead = Object.keys(venus.READ_TOPICS).filter(k => !/feedExcessDcPv|dontFeedExcessAcPv/.test(k)).sort();
    assert.deepEqual(Object.keys(dv.READ_TOPICS).sort(), venusRead);
    assert.deepEqual(Object.keys(dv.WRITE_TOPICS).sort(), ['chargeCurrentA', 'gridSetpointW', 'maxDischargeW', 'minSocPct']);
  });

  it('nutzt das dokumentierte Schema unter dem Prefix', () => {
    const { READ_TOPICS, WRITE_TOPICS } = buildDvhubTopicMaps('haus1');
    assert.equal(READ_TOPICS.meter_l1, 'haus1/input/grid/l1_w');
    assert.equal(READ_TOPICS.soc, 'haus1/input/battery/soc_pct');
    assert.equal(READ_TOPICS.batteryPowerW, 'haus1/input/battery/power_w');
    assert.equal(READ_TOPICS.pvPowerW, 'haus1/input/pv/dc_w');
    assert.equal(READ_TOPICS.acPvL2W, 'haus1/input/pv/ac_l2_w');
    assert.equal(READ_TOPICS.selfConsumptionW_l3, 'haus1/input/consumption/l3_w');
    assert.equal(READ_TOPICS.gridSetpointW, 'haus1/input/control/grid_setpoint_w');
    assert.equal(READ_TOPICS.minSocPct, 'haus1/input/control/min_soc_pct');
    assert.equal(WRITE_TOPICS.gridSetpointW, 'haus1/control/grid_setpoint_w/set');
    assert.equal(WRITE_TOPICS.minSocPct, 'haus1/control/min_soc_pct/set');
    assert.equal(WRITE_TOPICS.maxDischargeW, 'haus1/control/max_discharge_w/set');
    for (const t of [...Object.values(READ_TOPICS), ...Object.values(WRITE_TOPICS)]) {
      assert.equal(/[+#\s]/.test(t), false, `kein Wildcard/Leerzeichen in ${t}`);
    }
  });

  it('Prefix wird bereinigt (Slashes am Rand, leer → dvhub)', () => {
    assert.equal(buildDvhubTopicMaps('/haus/').READ_TOPICS.soc, 'haus/input/battery/soc_pct');
    assert.equal(buildDvhubTopicMaps('').READ_TOPICS.soc, 'dvhub/input/battery/soc_pct');
  });
});

describe('parseMqttPayload', () => {
  it('versteht nackte Zahlen, JSON-Zahlen und Venus-{value}', () => {
    assert.equal(parseMqttPayload(Buffer.from('42.5')), 42.5);
    assert.equal(parseMqttPayload(Buffer.from('-1500')), -1500);
    assert.equal(parseMqttPayload(Buffer.from('{"value": 17}')), 17);
    assert.equal(parseMqttPayload(Buffer.from('{"value": null}')), null);
    assert.equal(parseMqttPayload(Buffer.from(' 0 ')), 0);
  });
  it('lehnt Unsinn ab (undefined), erfindet keine 0', () => {
    assert.equal(parseMqttPayload(Buffer.from('')), undefined);
    assert.equal(parseMqttPayload(Buffer.from('unavailable')), undefined);
    assert.equal(parseMqttPayload(Buffer.from('{"foo":1}')), undefined);
    assert.equal(parseMqttPayload(Buffer.from('NaN')), undefined);
  });
});

describe('createMqttTransport mit schema dvhub', () => {
  it('meldet das Schema, ohne Keepalive-Topic, und schreibt nackte Zahlen auf …/set', async () => {
    const t = createMqttTransport({ host: '10.0.0.5', mqtt: { schema: 'dvhub', topicPrefix: 'haus1', broker: 'mqtt://broker:1883' } });
    assert.equal(t.type, 'mqtt');
    assert.equal(t.schema, 'dvhub');
    // Schreibpfad ohne Verbindung: klare Fehlermeldung, kein Topic-Mapping-Fehler
    await assert.rejects(() => t.mqttWrite('gridSetpointW', -2000), /nicht verbunden/);
    // Victron-spezifisches Ziel hat im DVhub-Schema kein Topic
    await assert.rejects(() => t.mqttWrite('feedExcessDcPv', 1), /Kein MQTT-Write-Mapping/);
    assert.deepEqual(t._writeTopics().gridSetpointW, 'haus1/control/grid_setpoint_w/set');
    assert.equal(t._encodeWrite(-2000), '-2000');
    assert.equal(t._readRequestTopic('haus1/input/battery/soc_pct'), null, 'kein R/-Nachfordern im DVhub-Schema');
    await t.destroy();
  });

  it('Venus bleibt Default: {value}-Payload, R/-Nachfordern', async () => {
    const t = createMqttTransport({ host: '10.0.0.5', mqtt: { portalId: 'abc' } });
    assert.equal(t.schema, 'venus');
    assert.equal(t._encodeWrite(-2000), '{"value":-2000}');
    assert.equal(t._readRequestTopic('N/abc/system/0/Dc/Battery/Soc'), 'R/abc/system/0/Dc/Battery/Soc');
    await t.destroy();
  });
});
