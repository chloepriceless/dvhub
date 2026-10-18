// Ersatzweg Modbus-Port (2026-10-18): Kann DVhub den Port des Direktvermarkters
// (502) nicht öffnen, lauscht er auf dem Ersatzport, und der VPN-Manager leitet
// NUR am eigenen Tunnel-Interface 502 → Ersatzport um — über das root-eigene
// Hilfsskript, solange der Tunnel steht. Ohne Ersatzweg (oder Tunnel weg) wird
// die Regel entfernt, auch eine von einem früheren Lauf liegengebliebene.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createVpnManager, MODBUS_REDIRECT_HELPER } from '../vpn-manager.js';

const WG_OK = '[Interface]\nPrivateKey = abc\nAddress = 10.0.0.2/32\n\n[Peer]\nPublicKey = def\nEndpoint = vpn.example.com:51820\nAllowedIPs = 10.0.0.0/24\n';

function setup({ protocol = 'wireguard', failHelper = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dvhub-vpn-redirect-'));
  const cfgPath = path.join(dir, protocol === 'wireguard' ? 'wg0.conf' : 'client.ovpn');
  writeFileSync(cfgPath, WG_OK);
  const calls = [];
  const logs = [];
  const state = {};
  const mgr = createVpnManager({
    state,
    pushLog: (e, d) => logs.push([e, d]),
    execFileAsync: async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (failHelper && args.includes(MODBUS_REDIRECT_HELPER) && args.includes('add')) {
        throw Object.assign(new Error('nft: Operation not permitted'), { stderr: 'Operation not permitted' });
      }
      return { stdout: '', stderr: '' };
    },
    interfaceExists: () => true,
    getCfg: () => ({ vpn: { enabled: true, protocol, profileName: 'p', configPath: cfgPath } }),
  });
  const helperCalls = () => calls.filter((c) => c.includes(MODBUS_REDIRECT_HELPER)).map((c) => c.slice(c.indexOf(MODBUS_REDIRECT_HELPER) + 1));
  return { mgr, state, calls, logs, helperCalls };
}

test('Hilfsskript liegt root-eigen unter /usr/local/libexec', () => {
  assert.equal(MODBUS_REDIRECT_HELPER, '/usr/local/libexec/dvhub-modbus-redirect');
});

test('Ersatzweg vor dem Tunnel: Umleitung erst, wenn der Tunnel steht; beim Stopp wieder weg', async () => {
  const { mgr, state, helperCalls, calls } = setup();
  await mgr.setModbusRedirect({ fromPort: 502, toPort: 1502 });
  assert.deepEqual(helperCalls(), [], 'ohne Tunnel keine Regel');
  await mgr.start();
  assert.equal(state.vpn.status, 'connected');
  assert.deepEqual(helperCalls(), [['add', 'wg0', '502', '1502']]);
  assert.ok(calls.some((c) => c[0] === 'sudo' && c[1] === '-n' && c[2] === MODBUS_REDIRECT_HELPER), 'über sudo -n');
  assert.deepEqual(mgr.getStatus().modbusRedirect, { active: true, iface: 'wg0', fromPort: 502, toPort: 1502, error: null });
  await mgr.stop();
  assert.deepEqual(helperCalls().at(-1), ['del']);
  assert.equal(mgr.getStatus().modbusRedirect.active, false);
  await mgr.close();
});

test('Ersatzweg bei stehendem Tunnel: sofort setzen; Port wieder frei → Regel weg', async () => {
  const { mgr, helperCalls } = setup();
  await mgr.start();
  await mgr.setModbusRedirect({ fromPort: 502, toPort: 1502 });
  assert.deepEqual(helperCalls().at(-1), ['add', 'wg0', '502', '1502']);
  await mgr.setModbusRedirect(null);
  assert.deepEqual(helperCalls().at(-1), ['del']);
  await mgr.close();
});

test('Kein Ersatzweg: eine liegengebliebene Regel wird einmal entfernt, danach keine Aufrufe mehr', async () => {
  const { mgr, helperCalls } = setup();
  await mgr.setModbusRedirect(null);
  await mgr.setModbusRedirect(null);
  assert.deepEqual(helperCalls(), [['del']]);
  await mgr.close();
});

test('Hilfsskript scheitert: Ursache im Status und im Log, kein Absturz', async () => {
  const { mgr, logs } = setup({ failHelper: true });
  await mgr.start();
  await mgr.setModbusRedirect({ fromPort: 502, toPort: 1502 });
  const st = mgr.getStatus().modbusRedirect;
  assert.equal(st.active, false);
  assert.match(st.error, /not permitted/);
  assert.ok(logs.some((l) => l[0] === 'vpn_modbus_redirect_failed'));
  await mgr.close();
});

test('Ungültige Ports werden nicht ans Hilfsskript gereicht', async () => {
  const { mgr, helperCalls } = setup();
  await mgr.start();
  await mgr.setModbusRedirect({ fromPort: 502, toPort: '1502; rm -rf /' });
  await mgr.setModbusRedirect({ fromPort: 0, toPort: 1502 });
  assert.equal(helperCalls().filter((c) => c[0] === 'add').length, 0);
  await mgr.close();
});
