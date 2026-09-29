// test/transport-mqtt-events.test.js — Leitstand-Sichtbarkeit des MQTT-Transports
// (Kundenfall 2026-09-29): Ein falscher Broker-Port (1833 statt 1883) warf pro
// Regelzyklus nur „MQTT nicht verbunden" — die eigentliche Ursache (Connect-
// Fehler) landete ausschließlich in console.error und damit in keinem Log, das
// der Kunde sieht. createMqttTransport meldet jetzt optional mqtt_connected /
// mqtt_connect_error über options.onEvent (server.js → pushLog).
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { createMqttTransport } from '../transport-mqtt.js';

async function withFreeClosedPort(fn) {
  // Port belegen und wieder freigeben → danach lauscht dort nichts (ECONNREFUSED).
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return fn(port);
}

test('mqtt_connect_error: toter Port wird als Leitstand-Event gemeldet, ohne Zugangsdaten', async () => {
  await withFreeClosedPort(async (port) => {
    const events = [];
    const transport = createMqttTransport(
      { host: '127.0.0.1', mqtt: { broker: `mqtt://dvuser:geheimnis@127.0.0.1:${port}`, portalId: 'p1' } },
      { onEvent: (event, details, level) => events.push({ event, details, level }) }
    );
    // Kein errno-Fixierer: Der freigehende ephemere Port koennte in der Luecke
    // von einem beliebigen Dienst belegt werden → dann scheitert der Connect
    // anders (oder haengt). Gewaehlt wird das Fehler-EVENT, nicht die Botschaft.
    await assert.rejects(() => transport.init());
    const errEvent = events.find((e) => e.event === 'mqtt_connect_error');
    assert.ok(errEvent, `mqtt_connect_error erwartet, kam: ${JSON.stringify(events)}`);
    assert.equal(errEvent.details.broker, `mqtt://127.0.0.1:${port}`,
      'Broker-Label = Schema/Host/Port, keine Zugangsdaten');
    assert.equal(errEvent.level, 'error', 'Leitstand-Level muss error sein (Filter!)');
    assert.ok(!JSON.stringify(events).includes('geheimnis'), 'Passwort darf nie ins Log');
    await transport.destroy();
  });
});

test('mqtt_connected: erfolgreiche Verbindung gegen echten Aedes-Broker wird gemeldet', async () => {
  const { Aedes } = await import('aedes');
  const aedes = await Aedes.createBroker();
  const server = net.createServer((sock) => {
    sock.on('error', () => {});
    aedes.handle(sock);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const events = [];
  const transport = createMqttTransport(
    { host: '127.0.0.1', mqtt: { broker: `mqtt://127.0.0.1:${port}`, portalId: 'p1' } },
    { onEvent: (event, details, level) => events.push({ event, details, level }) }
  );
  try {
    await transport.init();
    const ok = events.find((e) => e.event === 'mqtt_connected');
    assert.ok(ok, `mqtt_connected erwartet, kam: ${JSON.stringify(events)}`);
    assert.equal(ok.details.broker, `mqtt://127.0.0.1:${port}`);
    assert.equal(events.some((e) => e.event === 'mqtt_connect_error'), false,
      'bei gelungener Verbindung kein Fehler-Event');
  } finally {
    await transport.destroy();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => aedes.close(resolve));
  }
});

test('onEvent ist optional — Aufrufer ohne options (altesignal) bricht nicht', async () => {
  await withFreeClosedPort(async (port) => {
    const transport = createMqttTransport({
      host: '127.0.0.1',
      mqtt: { broker: `mqtt://127.0.0.1:${port}`, portalId: 'p1' }
    });
    await assert.rejects(() => transport.init());
    await transport.destroy();
  });
});

// Feld-Regressionspin (Realfall-Typ 2): Broker akzeptiert TCP, schickt aber nie
// eine CONNACK (eingefrorener mosquitto/Venus-Dienst). mqtt.js feuert dann
// selbst einen „connack timeout" als error-Event — der Leitstand muss genau
// das als mqtt_connect_error zeigen, bevor server.js den Retry loopert.
// Dauert ~5 s (mqtt.js connectTimeout ist hart auf 5000 verdrahtet).
test('hängende Verbindung (kein CONNACK) meldet mqtt_connect_error statt stumm zu laufen', async () => {
  // Achtung: ein blackhole-server hält acceptete sockets offen — close()-callback
  // würde erst nach socket-ende feuern. Sockets daher aktiv destroyen.
  const sockets = new Set();
  const blackhole = net.createServer((sock) => {
    sock.on('error', () => {});
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
  });
  await new Promise((resolve) => blackhole.listen(0, '127.0.0.1', resolve));
  const { port } = blackhole.address();
  const events = [];
  const transport = createMqttTransport(
    { host: '127.0.0.1', mqtt: { broker: `mqtt://127.0.0.1:${port}`, portalId: 'p1' } },
    { onEvent: (event, details, level) => events.push({ event, details, level }) }
  );
  try {
    await assert.rejects(() => transport.init(), /timeout/i);
    const errEvent = events.find((e) => e.event === 'mqtt_connect_error');
    assert.ok(errEvent,
      `hängender Broker muss mqtt_connect_error erzeugen, kam: ${JSON.stringify(events)}`);
    assert.equal(errEvent.details.broker, `mqtt://127.0.0.1:${port}`);
  } finally {
    await transport.destroy();
    blackhole.close();
    for (const sock of sockets) sock.destroy();
  }
});

// Saubere Trennung (Broker-Neustart/Keepalive-Aus): mqtt.js feuert dafuer NUR
// 'close', kein 'error'. Ohne mqtt_disconnected-Event waere der Uebergang
// verbunden→getrennt im Leitstand unsichtbar — dieselbe Blindstelle wie der
// Kundenfall (nur Folge, nie Ursache).
test('Broker-Trennung nach erfolgreicher Verbindung meldet mqtt_disconnected', async () => {
  const { Aedes } = await import('aedes');
  const aedes = await Aedes.createBroker();
  const sockets = new Set();
  const server = net.createServer((sock) => {
    sock.on('error', () => {});
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    aedes.handle(sock);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const events = [];
  const transport = createMqttTransport(
    { host: '127.0.0.1', mqtt: { broker: `mqtt://127.0.0.1:${port}`, portalId: 'p1' } },
    { onEvent: (event, details, level) => events.push({ event, details, level }) }
  );
  try {
    await transport.init();
    assert.ok(events.some((e) => e.event === 'mqtt_connected'), 'Referenz: Connect-Event vorher da');
    assert.equal(events.some((e) => e.event === 'mqtt_disconnected'), false,
      'während verbundener Sitzung kein Disconnect-Event');

    // Broker aktiv killen (entspricht Venus-Dienst-Neustart aus Sicht des Clients).
    server.close();
    for (const sock of sockets) sock.destroy();
    await new Promise((resolve) => aedes.close(resolve));

    for (let i = 0; i < 100 && !events.some((e) => e.event === 'mqtt_disconnected'); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const disc = events.find((e) => e.event === 'mqtt_disconnected');
    assert.ok(disc, `mqtt_disconnected erwartet, kam: ${JSON.stringify(events.map((e) => e.event))}`);
    assert.equal(disc.details.broker, `mqtt://127.0.0.1:${port}`);
    assert.equal(disc.level, 'warn');
  } finally {
    await transport.destroy();
    server.close();
    for (const sock of sockets) sock.destroy();
  }
});

// Der close-Handler darf bei einer NIE verbundenen Erstverbindung kein
// Disconnect-Event produzieren — das ist Aufgabe von mqtt_connect_error.
test('fehlgeschlagene Erstverbindung meldet kein mqtt_disconnected (nur connect_error)', async () => {
  await withFreeClosedPort(async (port) => {
    const events = [];
    const transport = createMqttTransport(
      { host: '127.0.0.1', mqtt: { broker: `mqtt://127.0.0.1:${port}`, portalId: 'p1' } },
      { onEvent: (event, details, level) => events.push({ event, details, level }) }
    );
    try {
      await assert.rejects(() => transport.init());
      await new Promise((r) => setTimeout(r, 100)); // nachlaufende close-Events einfangen
      assert.ok(events.some((e) => e.event === 'mqtt_connect_error'));
      assert.equal(events.some((e) => e.event === 'mqtt_disconnected'), false,
        `kein Disconnect für eine nie bestehende Verbindung, kam: ${JSON.stringify(events.map((e) => e.event))}`);
    } finally {
      await transport.destroy();
    }
  });
});

// ── Helpers für Reconnect-Szenarien (echter Aedes-Broker, Port wiederverwendbar) ──
async function makeBroker(port) {
  const { Aedes } = await import('aedes');
  const aedes = await Aedes.createBroker();
  const sockets = new Set();
  const server = net.createServer((sock) => {
    sock.on('error', () => {});
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    aedes.handle(sock);
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    // Server-seitiger Publish an alle Subscriber (wie Venus OS nach Keepalive).
    // retain:false — onMessage verwirft Retained als Frische-Beweis.
    publish: (topic, value) => new Promise((resolve, reject) => {
      aedes.publish({ topic, payload: JSON.stringify({ value }), qos: 0, retain: false },
        (err) => (err ? reject(err) : resolve()));
    }),
    kill: async () => {
      server.close();
      for (const s of sockets) s.destroy();
      try { await new Promise((resolve) => aedes.close(resolve)); } catch { /* schon geschlossen */ }
    }
  };
}

async function waitUntil(events, label, cond, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error(`Zeitüberschreitung: ${label} — Events: ${JSON.stringify(events.map((e) => e.event))}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

// Regression (Selbst-Review 2026-09-30): nach einer unabsichtlichen Trennung
// blieb sessionActive auf false — der connect-Handler springt im settled-Zweig
// früh zurück. Folge: der Reconnect war im Leitstand unsichtbar und JEDE
// spätere Trennung ebenfalls (dieselbe Blindstelle wie der Kundenfall, nur
// nach dem ersten Flake).
test('reconnect: nach Broker-Neustart mqtt_connected erneut, nächste Trennung bleibt sichtbar', async () => {
  const events = [];
  const count = (name) => events.filter((e) => e.event === name).length;
  const broker = await makeBroker(0);
  const transport = createMqttTransport(
    { host: '127.0.0.1', mqtt: { broker: `mqtt://127.0.0.1:${broker.port}`, portalId: 'p1' } },
    { onEvent: (event, details, level) => events.push({ event, details, level }) }
  );
  let broker2 = null;
  try {
    await transport.init();
    await waitUntil(events, 'erste Verbindung', () => count('mqtt_connected') >= 1);

    // Broker abschießen → Trennung, dann Dienst auf derselben Port zurück → Reconnect.
    const port = broker.port;
    await broker.kill();
    await waitUntil(events, 'Trennung gemeldet', () => count('mqtt_disconnected') >= 1);
    broker2 = await makeBroker(port);
    await waitUntil(events, 'wiederverbunden (mqtt_connected #2)', () => count('mqtt_connected') >= 2);

    // Datenfluss nach Reconnect explicit prüfen: subscribe() lief nur beim
    // Erstkontakt — ohne funktionierende Resubscription (mqtt.js-Default) zeigt
    // der Leitstand „verbunden", während die Werte einfrieren.
    await broker2.publish('N/p1/system/0/Dc/Battery/Soc', 42);
    await waitUntil(events, 'SoC-Wert nach Reconnect im Cache', () => transport.getCached('soc') === 42, 5000);

    // Kern des Fixes: sessionActive ist wieder true → die nächste Trennung wird gemeldet.
    const before = count('mqtt_disconnected');
    await broker2.kill();
    await waitUntil(events, 'zweite Trennung gemeldet', () => count('mqtt_disconnected') > before);
  } finally {
    await transport.destroy();
    await broker.kill();
    if (broker2) await broker2.kill();
  }
});

// Spam-Schutz (Selbst-Review 2026-09-30): ein dauerhaft fehlender Broker bringt
// mqtt.js dazu, pro reconnect-Intervall (~1 s) denselben Fehler zu werfen.
// Ohne Dedup schreibt jeder Fehlversuch in Leitstand-Ring UND Audit-DB.
test('reconnect-Sturm: identische connect-Fehler erscheinen nicht doppelt hintereinander', async () => {
  const events = [];
  const broker = await makeBroker(0);
  const transport = createMqttTransport(
    { host: '127.0.0.1', mqtt: { broker: `mqtt://127.0.0.1:${broker.port}`, portalId: 'p1' } },
    { onEvent: (event, details, level) => events.push({ event, details, level }) }
  );
  try {
    await transport.init();
    // Port bleibt danach frei → alle reconnects scheitern mit identischem Text.
    await broker.kill();
    await new Promise((r) => setTimeout(r, 4000)); // ≈ 3 gescheiterte Versuche sammeln
    const errs = events
      .filter((e) => e.event === 'mqtt_connect_error')
      .map((e) => String(e.details.error));
    const dupes = errs.filter((m, i) => i > 0 && m === errs[i - 1]);
    assert.equal(dupes.length, 0,
      `identische Fehler dürfen nicht wiederholt werden (Dedup 30 s), kam: ${JSON.stringify(errs)}`);
    assert.ok(errs.length >= 1, 'mindestens ein connect_error während des Sturms');
  } finally {
    await transport.destroy();
    await broker.kill();
  }
});

// Review 2026-09-29 (Finding 4): Fehler im laufenden Betrieb hießen ebenfalls
// mqtt_connect_error — der Leitstand schickte den Nutzer dann zur Broker-URL,
// obwohl die Verbindung stand.
test('Fehler während bestehender Sitzung → mqtt_error (nicht mqtt_connect_error)', async () => {
  const { EventEmitter } = await import('node:events');
  let fake;
  const connectFn = () => {
    fake = new EventEmitter();
    fake.subscribe = (topics, opts, cb) => { (typeof opts === 'function' ? opts : cb)?.(null); };
    fake.publish = () => {};
    fake.end = () => {};
    setImmediate(() => fake.emit('connect'));
    return fake;
  };
  const events = [];
  const transport = createMqttTransport(
    { host: '127.0.0.1', mqtt: { broker: 'mqtt://127.0.0.1:1883', portalId: 'p1' } },
    { onEvent: (event, details) => events.push({ event, details }), connectFn }
  );
  try {
    await transport.init();
    assert.ok(events.some((e) => e.event === 'mqtt_connected'));
    fake.emit('error', new Error('Publish error: packet too large'));
    assert.deepEqual(events.filter((e) => /error/.test(e.event)).map((e) => e.event), ['mqtt_error']);
    assert.equal(events.at(-1).details.error, 'Publish error: packet too large');
  } finally {
    await transport.destroy();
  }
});
