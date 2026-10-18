import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { createModbusServer } from '../modbus-server.js';

// Kann der Modbus-Server seinen Port nicht öffnen (belegt, oder Port < 1024 ohne
// Recht — im Container ohne CAP_NET_BIND_SERVICE), darf DVhub nicht abstürzen:
// Ein unbehandeltes 'error' am Server beendete den Prozess, und der Container
// startete in einer Schleife neu. Stattdessen: klarer Logeintrag, Zustand für
// die Oberfläche, und ein späteres start() darf es erneut versuchen.

function makeCtx(port) {
  const events = [];
  const state = { dvRegs: {}, keepalive: {}, ctrl: { forcedOff: false } };
  const cfg = { modbusListenHost: '127.0.0.1', modbusListenPort: port };
  return { events, state, ctx: { state, getCfg: () => cfg, pushLog: (e, d) => events.push([e, d]) } };
}

const until = async (cond, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('Zeitüberschreitung');
    await new Promise((r) => setTimeout(r, 10));
  }
};

test('Modbus: belegter Port bringt DVhub nicht zum Absturz, sondern meldet ihn', async () => {
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const port = blocker.address().port;
  const { events, state, ctx } = makeCtx(port);
  const server = createModbusServer(ctx);
  try {
    server.start();
    await until(() => events.some((e) => e[0] === 'modbus_listen_failed'));
    const [, detail] = events.find((e) => e[0] === 'modbus_listen_failed');
    assert.equal(detail.port, port);
    assert.equal(detail.code, 'EADDRINUSE');
    assert.equal(state.modbusListen.ok, false);
    assert.equal(state.modbusListen.code, 'EADDRINUSE');

    // Port wieder frei → ein erneuter start() lauscht.
    await new Promise((r) => blocker.close(r));
    server.start();
    await until(() => state.modbusListen?.ok === true);
    assert.equal(state.modbusListen.port, port);
  } finally {
    server.close();
    if (blocker.listening) blocker.close();
  }
});

test('Modbus: fehlendes Recht für Port < 1024 nennt die Ursache', async () => {
  const { events, ctx } = makeCtx(502);
  const server = createModbusServer(ctx);
  const realCreate = net.createServer;
  // Ohne root/Recht liefert listen() EACCES — hier nachgestellt, damit der Test
  // nicht davon abhängt, unter welchem Benutzer er läuft.
  net.createServer = (...args) => {
    const srv = realCreate(...args);
    srv.listen = function fakeListen() {
      const err = Object.assign(new Error('listen EACCES: permission denied 127.0.0.1:502'), { code: 'EACCES' });
      process.nextTick(() => srv.emit('error', err));
      return srv;
    };
    return srv;
  };
  try {
    server.start();
    await until(() => events.some((e) => e[0] === 'modbus_listen_failed'));
  } finally {
    net.createServer = realCreate;
    server.close();
  }
  const [, detail] = events.find((e) => e[0] === 'modbus_listen_failed');
  assert.equal(detail.code, 'EACCES');
  assert.match(detail.hint, /1024/);
});
