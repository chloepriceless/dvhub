import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { createModbusServer, MODBUS_FALLBACK_PORT } from '../modbus-server.js';

// Kann der Modbus-Server seinen Port nicht öffnen (belegt, oder Port < 1024 ohne
// Recht — im Container ohne CAP_NET_BIND_SERVICE), darf DVhub nicht abstürzen:
// Ein unbehandeltes 'error' am Server beendete den Prozess, und der Container
// startete in einer Schleife neu. Stattdessen weicht er auf den Ersatzport aus
// (der VPN-Manager leitet den Tunnel-Port dorthin um), meldet beides, und ist
// auch der Ersatzport zu, bleibt es bei der Meldung.

function makeCtx(port, extra = {}) {
  const events = [];
  const listens = [];
  const state = { dvRegs: {}, keepalive: {}, ctrl: { forcedOff: false } };
  const cfg = { modbusListenHost: '127.0.0.1', modbusListenPort: port };
  const ctx = {
    state, getCfg: () => cfg, pushLog: (e, d) => events.push([e, d]),
    onModbusListen: (info) => listens.push(info),
    ...extra,
  };
  return { events, listens, state, ctx };
}

const until = async (cond, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('Zeitüberschreitung');
    await new Promise((r) => setTimeout(r, 10));
  }
};

async function occupy() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return s;
}
const freePort = async () => { const s = await occupy(); const p = s.address().port; await new Promise((r) => s.close(r)); return p; };

test('Modbus: Ersatzport ist 1502', () => {
  assert.equal(MODBUS_FALLBACK_PORT, 1502);
});

test('Modbus: freier Port → lauscht dort, kein Ersatzweg', async () => {
  const port = await freePort();
  const { state, listens, ctx } = makeCtx(port);
  const server = createModbusServer(ctx);
  try {
    server.start();
    await until(() => state.modbusListen?.ok === true);
    assert.equal(state.modbusListen.port, port);
    assert.equal(state.modbusListen.fallback, false);
    assert.deepEqual(listens, [{ requestedPort: port, port, fallback: false }]);
  } finally { server.close(); }
});

test('Modbus: belegter Port → Ersatzport, Meldung mit Ursache, Umleitung angefordert', async () => {
  const blocker = await occupy();
  const port = blocker.address().port;
  const fallbackPort = await freePort();
  const { events, listens, state, ctx } = makeCtx(port, { fallbackPort });
  const server = createModbusServer(ctx);
  try {
    server.start();
    await until(() => state.modbusListen?.ok === true);
    assert.equal(state.modbusListen.port, fallbackPort);
    assert.equal(state.modbusListen.requestedPort, port);
    assert.equal(state.modbusListen.fallback, true);
    assert.equal(state.modbusListen.code, 'EADDRINUSE');
    assert.deepEqual(listens, [{ requestedPort: port, port: fallbackPort, fallback: true }]);
    const [, detail] = events.find((e) => e[0] === 'modbus_listen_fallback');
    assert.equal(detail.requestedPort, port);
    assert.equal(detail.port, fallbackPort);
    assert.equal(detail.code, 'EADDRINUSE');
    // Der Ersatzport beantwortet Verbindungen.
    await new Promise((resolve, reject) => {
      const c = net.connect(fallbackPort, '127.0.0.1', () => { c.destroy(); resolve(); });
      c.on('error', reject);
    });
  } finally {
    server.close();
    blocker.close();
  }
});

test('Modbus: auch der Ersatzport ist zu → kein Absturz, Meldung, späterer start() versucht es erneut', async () => {
  const blocker = await occupy();
  const port = blocker.address().port;
  const fbBlocker = await occupy();
  const fallbackPort = fbBlocker.address().port;
  const { events, state, ctx } = makeCtx(port, { fallbackPort });
  const server = createModbusServer(ctx);
  try {
    server.start();
    await until(() => events.some((e) => e[0] === 'modbus_listen_failed'));
    const [, detail] = events.find((e) => e[0] === 'modbus_listen_failed');
    assert.equal(detail.port, port);
    assert.equal(detail.code, 'EADDRINUSE');
    assert.equal(state.modbusListen.ok, false);
    assert.equal(state.modbusListen.code, 'EADDRINUSE');

    // Port wieder frei → ein erneuter start() lauscht auf dem eigentlichen Port.
    await new Promise((r) => blocker.close(r));
    server.start();
    await until(() => state.modbusListen?.ok === true);
    assert.equal(state.modbusListen.port, port);
    assert.equal(state.modbusListen.fallback, false);
  } finally {
    server.close();
    if (blocker.listening) blocker.close();
    fbBlocker.close();
  }
});

test('Modbus: fehlendes Recht für Port < 1024 → Ersatzport, Hinweis nennt die Ursache', async () => {
  const fallbackPort = await freePort();
  const { events, state, ctx } = makeCtx(502, { fallbackPort });
  const server = createModbusServer(ctx);
  const realCreate = net.createServer;
  // Ohne root/Recht liefert listen() auf 502 EACCES — hier nachgestellt, damit
  // der Test nicht davon abhängt, unter welchem Benutzer er läuft.
  net.createServer = (...args) => {
    const srv = realCreate(...args);
    const realListen = srv.listen.bind(srv);
    srv.listen = function fakeListen(p, ...rest) {
      if (p !== 502) return realListen(p, ...rest);
      const err = Object.assign(new Error('listen EACCES: permission denied 127.0.0.1:502'), { code: 'EACCES' });
      process.nextTick(() => srv.emit('error', err));
      return srv;
    };
    return srv;
  };
  try {
    server.start();
    await until(() => state.modbusListen?.ok === true);
  } finally {
    net.createServer = realCreate;
    server.close();
  }
  assert.equal(state.modbusListen.port, fallbackPort);
  assert.equal(state.modbusListen.code, 'EACCES');
  assert.match(state.modbusListen.hint, /1024/);
  assert.ok(events.some((e) => e[0] === 'modbus_listen_fallback'));
});

test('Modbus: ist der Port selbst der Ersatzport, gibt es keinen zweiten Versuch', async () => {
  const blocker = await occupy();
  const port = blocker.address().port;
  const { events, state, listens, ctx } = makeCtx(port, { fallbackPort: port });
  const server = createModbusServer(ctx);
  try {
    server.start();
    await until(() => events.some((e) => e[0] === 'modbus_listen_failed'));
    assert.equal(state.modbusListen.ok, false);
    assert.deepEqual(listens, []);
  } finally {
    server.close();
    blocker.close();
  }
});
