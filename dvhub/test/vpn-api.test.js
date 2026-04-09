import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRuntimeSnapshot, buildWebStatusResponse } from '../runtime-state.js';

test('buildRuntimeSnapshot includes vpn field when provided', () => {
  const vpn = {
    enabled: true,
    status: 'connected',
    protocol: 'openvpn',
    tunIp: '10.8.0.2',
    remoteIp: '1.2.3.4',
    upSince: '2026-04-01T12:00:00.000Z',
    uptimeSeconds: 3600,
    bytesSent: 1024,
    bytesReceived: 2048,
    reconnectAttempts: 0,
    lastError: null,
    certExpiry: '2027-03-15T12:00:00.000Z',
    certDaysRemaining: 347,
    watchdogOk: true,
    profileName: 'direktvermarkter'
  };

  const snapshot = buildRuntimeSnapshot({ vpn });

  assert.ok(snapshot.vpn, 'vpn field should exist');
  assert.equal(snapshot.vpn.status, 'connected');
  assert.equal(snapshot.vpn.tunIp, '10.8.0.2');
  assert.equal(snapshot.vpn.protocol, 'openvpn');
  assert.equal(snapshot.vpn.uptimeSeconds, 3600);
  assert.equal(snapshot.vpn.profileName, 'direktvermarkter');
  assert.equal(snapshot.vpn.certDaysRemaining, 347);
  assert.equal(snapshot.vpn.watchdogOk, true);
});

test('buildRuntimeSnapshot vpn is null when not provided', () => {
  const snapshot = buildRuntimeSnapshot({});
  assert.equal(snapshot.vpn, null);
});

test('buildWebStatusResponse includes vpn from snapshot', () => {
  const vpn = {
    enabled: true,
    status: 'disconnected',
    protocol: 'openvpn',
    tunIp: null,
    reconnectAttempts: 2,
    lastError: 'timeout',
    watchdogOk: false,
    profileName: 'test'
  };

  const response = buildWebStatusResponse({
    snapshot: { vpn }
  });

  assert.ok(response.vpn, 'vpn field should be in web status response');
  assert.equal(response.vpn.status, 'disconnected');
  assert.equal(response.vpn.reconnectAttempts, 2);
  assert.equal(response.vpn.lastError, 'timeout');
  assert.equal(response.vpn.profileName, 'test');
});

test('buildWebStatusResponse vpn is null when snapshot has no vpn', () => {
  const response = buildWebStatusResponse({ snapshot: {} });
  assert.equal(response.vpn, null);
});

test('vpn snapshot strips non-VPN fields', () => {
  const vpn = {
    enabled: true,
    status: 'connected',
    tunIp: '10.8.0.2',
    secretInternalField: 'should-not-appear',
    _privateKey: 'should-not-appear'
  };

  const snapshot = buildRuntimeSnapshot({ vpn });
  assert.equal(snapshot.vpn.secretInternalField, undefined);
  assert.equal(snapshot.vpn._privateKey, undefined);
  assert.equal(snapshot.vpn.status, 'connected');
});
