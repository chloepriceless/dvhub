// test/mqtt-hub-control.test.js -- MQTT Hub Verbindungssteuerung + Status/Log
//
// Anlass (2026-09-14): Der Broker war weg, DVhub loggte alle 5 s
// "[MQTT] Client error: connect ECONNREFUSED" ins Audit-Log, und in der
// Oberfläche gab es weder einen Zustand noch einen Knopf, um die Verbindung
// zu steuern. Der Hub bekommt deshalb:
//   - getStatus(): Zustandsmaschine (disabled/connecting/connected/
//     reconnecting/offline/stopped) + Broker, Zeitstempel, letzter Fehler
//   - getLog(): eigener Ereignis-Ring (unabhängig vom Audit-Log)
//   - connect() / disconnect() / restart(): Steuerung ohne Service-Neustart
//   - pushLog-Dedupe: derselbe Fehler landet nicht alle 5 s im Audit-Log
//   - Verbindungsoptionen aus der Config (clientId, keepalive, Reconnect-
//     Periode, Connect-Timeout, rejectUnauthorized)
//
// Die mqtt-Bibliothek wird per ctx.mqttLib injiziert, damit kein Socket
// aufgeht. Rot, solange services/mqtt/index.js die API nicht hat.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

function makeMockClient() {
  const handlers = {};
  const client = {
    connected: false,
    endCalls: 0,
    reconnectCalls: 0,
    subscribed: [],
    on(ev, fn) { handlers[ev] = fn; return this; },
    subscribe(topic) { this.subscribed.push(topic); },
    publish() {},
    reconnect() { this.reconnectCalls++; },
    end(force, cb) { this.endCalls++; this.connected = false; if (typeof force === 'function') { cb = force; } if (cb) cb(); },
    _emit(ev, ...args) { if (handlers[ev]) handlers[ev](...args); },
    _connect() { this.connected = true; this._emit('connect'); },
  };
  return client;
}

function makeMqttLib() {
  const lib = {
    calls: [],
    clients: [],
    connect(url, opts) {
      const c = makeMockClient();
      lib.calls.push({ url, opts });
      lib.clients.push(c);
      return c;
    }
  };
  return lib;
}

const baseCfg = () => ({
  mqtt: {
    enabled: true,
    brokerUrl: 'mqtt://broker-a:1883',
    embeddedBroker: { enabled: false, port: 1883 },
    topicPrefix: 'dvhub'
  }
});

async function makeHub(cfg, extra = {}) {
  const { createMqttHub } = await import('../services/mqtt/index.js');
  const logged = [];
  const hub = createMqttHub({
    getCfg: () => cfg,
    pushLog: (event, details) => logged.push({ event, details }),
    mqttLib: extra.mqttLib || makeMqttLib(),
    ...extra
  });
  return { hub, logged };
}

describe('MQTT Hub — Status, Log und Steuerung', () => {
  let hub;
  afterEach(async () => { if (hub) { try { await hub.close(); } catch { /* egal */ } hub = null; } });

  it('getStatus meldet disabled, wenn mqtt.enabled fehlt', async () => {
    const r = await makeHub({ mqtt: { enabled: false } });
    hub = r.hub;
    await hub.start();
    const s = hub.getStatus();
    assert.equal(s.enabled, false);
    assert.equal(s.state, 'disabled');
    assert.equal(hub.connected, false);
  });

  it('durchläuft connecting → connected → reconnecting → offline und zählt Reconnects', async () => {
    const lib = makeMqttLib();
    const r = await makeHub(baseCfg(), { mqttLib: lib });
    hub = r.hub;
    await hub.start();
    assert.equal(hub.getStatus().state, 'connecting');
    assert.equal(hub.getStatus().brokerUrl, 'mqtt://broker-a:1883');

    const c = lib.clients[0];
    c._connect();
    let s = hub.getStatus();
    assert.equal(s.state, 'connected');
    assert.ok(Number.isFinite(s.connectedAt), 'connectedAt gesetzt');
    assert.equal(hub.connected, true);

    c._emit('error', new Error('connect ECONNREFUSED 10.0.0.1:1883'));
    c.connected = false;
    c._emit('close');
    s = hub.getStatus();
    assert.equal(s.state, 'offline');
    assert.equal(s.lastError, 'connect ECONNREFUSED 10.0.0.1:1883');
    assert.ok(Number.isFinite(s.lastErrorAt));
    assert.ok(Number.isFinite(s.disconnectedAt));

    c._emit('reconnect');
    assert.equal(hub.getStatus().state, 'reconnecting');
    assert.equal(hub.getStatus().reconnects, 1);
  });

  it('getLog liefert einen begrenzten Ereignis-Ring, neueste zuerst', async () => {
    const lib = makeMqttLib();
    const r = await makeHub(baseCfg(), { mqttLib: lib });
    hub = r.hub;
    await hub.start();
    const c = lib.clients[0];
    for (let i = 0; i < 260; i++) c._emit('error', new Error('boom ' + i));
    const log = hub.getLog();
    assert.ok(log.length <= 200, 'Ring ist auf 200 Einträge begrenzt');
    assert.ok(log[0].msg.includes('boom 259'), 'neuester Eintrag zuerst');
    assert.equal(typeof log[0].ts, 'number');
    assert.equal(log[0].level, 'error');
    assert.equal(hub.getLog(5).length, 5, 'limit wird respektiert');
  });

  it('dedupliziert identische Fehler im Audit-Log (pushLog), behält sie aber im Ring', async () => {
    const lib = makeMqttLib();
    const r = await makeHub(baseCfg(), { mqttLib: lib });
    hub = r.hub;
    await hub.start();
    const c = lib.clients[0];
    for (let i = 0; i < 12; i++) c._emit('error', new Error('connect ECONNREFUSED 10.0.0.1:1883'));
    const pushed = r.logged.filter(l => String(l.event).includes('ECONNREFUSED'));
    assert.equal(pushed.length, 1, 'derselbe Fehler geht nur einmal ins Audit-Log');
    const ring = hub.getLog().filter(e => e.msg.includes('ECONNREFUSED'));
    assert.equal(ring.length, 12, 'im eigenen Ring bleibt jeder Versuch sichtbar');
  });

  it('disconnect() beendet den Client und meldet stopped; connect() baut neu auf', async () => {
    const lib = makeMqttLib();
    const r = await makeHub(baseCfg(), { mqttLib: lib });
    hub = r.hub;
    await hub.start();
    lib.clients[0]._connect();

    const d = await hub.disconnect();
    assert.equal(d.ok, true);
    assert.equal(lib.clients[0].endCalls, 1, 'client.end() aufgerufen');
    assert.equal(hub.getStatus().state, 'stopped');
    assert.equal(hub.getStatus().manualStop, true);
    assert.equal(hub.connected, false);

    const k = await hub.connect();
    assert.equal(k.ok, true);
    assert.equal(lib.calls.length, 2, 'connect() öffnet einen neuen Client');
    assert.equal(hub.getStatus().state, 'connecting');
    assert.equal(hub.getStatus().manualStop, false);
  });

  it('restart() liest die Config neu und abonniert bestehende Handler wieder', async () => {
    const cfg = baseCfg();
    const lib = makeMqttLib();
    const r = await makeHub(cfg, { mqttLib: lib });
    hub = r.hub;
    hub.subscribe('teslamate/#', () => {});
    await hub.start();
    lib.clients[0]._connect();
    assert.deepEqual(lib.clients[0].subscribed, ['teslamate/#']);

    cfg.mqtt.brokerUrl = 'mqtt://broker-b:1883';
    const res = await hub.restart();
    assert.equal(res.ok, true);
    assert.equal(lib.clients[0].endCalls, 1, 'alter Client beendet');
    assert.equal(lib.calls[1].url, 'mqtt://broker-b:1883', 'neue Broker-URL ohne Service-Neustart');
    lib.clients[1]._connect();
    assert.deepEqual(lib.clients[1].subscribed, ['teslamate/#'], 'Handler überleben den Neustart');
    assert.equal(hub.getStatus().state, 'connected');
    assert.equal(hub.getStatus().brokerUrl, 'mqtt://broker-b:1883');
  });

  it('connect() bei mqtt.enabled=false liefert ok:false, reason:disabled', async () => {
    const r = await makeHub({ mqtt: { enabled: false } });
    hub = r.hub;
    const k = await hub.connect();
    assert.equal(k.ok, false);
    assert.equal(k.reason, 'disabled');
  });

  it('übergibt clientId, keepalive, reconnectPeriod, connectTimeout und rejectUnauthorized aus der Config', async () => {
    const cfg = baseCfg();
    Object.assign(cfg.mqtt, {
      brokerUrl: 'mqtts://broker-a:8883',
      clientId: 'dvhub-test',
      keepaliveSec: 30,
      reconnectPeriodMs: 12000,
      connectTimeoutMs: 4000,
      rejectUnauthorized: false,
      username: 'u',
      password: 'p'
    });
    const lib = makeMqttLib();
    const r = await makeHub(cfg, { mqttLib: lib });
    hub = r.hub;
    await hub.start();
    const opts = lib.calls[0].opts;
    assert.equal(opts.clientId, 'dvhub-test');
    assert.equal(opts.keepalive, 30);
    assert.equal(opts.reconnectPeriod, 12000);
    assert.equal(opts.connectTimeout, 4000);
    assert.equal(opts.rejectUnauthorized, false);
    assert.equal(opts.username, 'u');
    assert.equal(opts.password, 'p');
    assert.equal(hub._getReconnectPeriod(), 12000);
    assert.equal(hub.getStatus().clientId, 'dvhub-test');
  });

  it('Passwort erscheint nie in Status oder Log', async () => {
    const cfg = baseCfg();
    cfg.mqtt.brokerUrl = 'mqtt://user:geheim123@broker-a:1883';
    const lib = makeMqttLib();
    const r = await makeHub(cfg, { mqttLib: lib });
    hub = r.hub;
    await hub.start();
    lib.clients[0]._connect();
    const blob = JSON.stringify(hub.getStatus()) + JSON.stringify(hub.getLog()) + JSON.stringify(r.logged);
    assert.equal(blob.includes('geheim123'), false);
  });
});
