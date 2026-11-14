// test/mobile-link-integrations.test.js
//
// Integrationen für die Handy-App (14.11.2026): GET /api/mobile-link/integrations
// liefert die Übersicht von /api/integrations/status OHNE Adressen im Heimnetz,
// Benutzernamen, Kennungen und Fehlertexte. Geprüft wird an der echten Route
// (createApiRoutes) mit einer Config voller erkennbarer Köder: Keiner davon
// darf in der Antwort für die App stehen — in der Antwort für die
// Weboberfläche stehen die Adressen dagegen weiterhin.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApiRoutes } from '../routes-api.js';
import { mobileIntegrationsView, safeText } from '../services/mobile-link/integrations-view.js';
import { checkRequest, READ_PATHS, CONTROL_PATHS } from '../services/mobile-link/permissions.js';

function mockRes() {
  const captured = { status: 0, body: '' };
  return {
    writeHead(code) { captured.status = code; },
    setHeader() {},
    end(payload) { captured.body = payload == null ? '' : String(payload); },
    _captured: captured,
  };
}

// Köder: jeder Wert ist eindeutig und dürfte nie aufs Handy.
const BAIT = {
  mqttPassword: 'KOEDER-mqtt-passwort',
  mqttUser: 'koeder-mqtt-user',
  mqttHost: '192.168.77.11',
  victronHost: '192.168.77.12',
  meterHost: '192.168.77.13',
  evccUrl: 'http://192.168.77.14:7070',
  eosUrl: 'http://192.168.77.15:8503',
  vrmPortal: 'koederportal0c0ffee',
  vrmToken: 'KOEDER-vrm-token',
  midSerial: 'KOEDER-SERIAL-4711',
  luoxId: 'koeder-luox.local',
  solcastKey: 'KOEDER-solcast-key',
  deviceIp: '192.168.77.16',
  evccError: 'connect ECONNREFUSED 192.168.77.14:7070',
  teslaLat: 53.5511,
};

function mockCtx() {
  const cfg = {
    apiToken: null,
    epex: { enabled: false, timezone: 'Europe/Berlin' },
    optimizer: { enabled: true, primarySource: 'eos', eosProxy: { enabled: true, url: BAIT.eosUrl } },
    schedule: { timezone: 'Europe/Berlin' },
    telemetry: { enabled: false, historyImport: { enabled: true, vrmPortalId: BAIT.vrmPortal, vrmToken: BAIT.vrmToken } },
    family: {},
    gridPositiveMeans: 'grid_import',
    keepalivePulseSec: 30,
    corsAllowedOrigins: [],
    allowedHosts: [],
    mqtt: { enabled: true, brokerUrl: `mqtt://${BAIT.mqttUser}:${BAIT.mqttPassword}@${BAIT.mqttHost}:1883`, username: BAIT.mqttUser, password: BAIT.mqttPassword, haDiscovery: { enabled: true } },
    victron: { host: BAIT.victronHost, modelId: 'MultiPlus-II 48/5000' },
    meter: { host: BAIT.meterHost, port: 502, unitId: 1, address: 0 },
    mid: { serial: BAIT.midSerial },
    luox: { identifier: BAIT.luoxId },
    evcc: { url: BAIT.evccUrl, dashboardLoadpoint: 1 },
    wallbox: { type: 'evcc' },
    forecast: { solcast: { enabled: true, apiKey: BAIT.solcastKey, siteId: 'KOEDER-site' } },
    integrations: { tesla: { enabled: true, name: 'Model Y' } },
    notifications: { enabled: true, providers: { ntfy: { enabled: true, url: `http://${BAIT.deviceIp}/thema`, token: 'KOEDER-ntfy' } } },
  };
  return {
    state: {
      meter: { ok: false, updatedAt: 0, grid_total_w: 0 },
      victron: { soc: 50, batteryPowerW: 0, pvTotalW: 0, updatedAt: 0 },
      epex: { ok: false, data: [] },
      energy: { day: null, importWh: 0, exportWh: 0, costEur: 0, revenueEur: 0 },
      telemetry: { enabled: false, ok: false },
      keepalive: { modbusLastQuery: null, appPulse: { periodSec: 30 } },
      schedule: { rules: [], config: {}, active: {}, lastWrite: {}, manualOverride: {}, lastEvalAt: 0 },
      ctrl: { forcedOff: false, offUntil: 0, lastSignal: 'init', updatedAt: 0, dvControl: null },
      log: [],
      forecast: null,
    },
    getCfg: () => cfg,
    getRawCfg: () => cfg,
    getLoadedConfig: () => ({ exists: true, valid: true, needsSetup: false }),
    getConfigPath: () => '/tmp/config.json',
    getConfigDefinition: () => [],
    getAppVersion: () => ({ version: '0.9.0-test' }),
    getTransportType: () => 'modbus',
    getAppDir: () => '/tmp',
    getRepoRoot: () => '/tmp',
    getServiceActionsEnabled: () => false,
    getServiceName: () => 'dvhub',
    getServiceUseSudo: () => false,
    runServiceCommand: async () => ({ ok: true }),
    controlValue: () => 'off',
    pushLog: () => {},
    telemetrySafeWrite: () => {},
    needsSetup: () => false,
    epexNowNext: () => null,
    expireLeaseIfNeeded: () => {},
    persistConfig: () => {},
    buildSystemDiscoveryPayload: async () => ({ ok: true }),
    mqttHub: { connected: true },
    mqttPublisher: { topicCount: 42 },
    teslamateService: { getState: () => ({ battery_level: 71, latitude: BAIT.teslaLat, longitude: 9.9937 }), lastUpdateAt: 1763100000000 },
    healthTracker: { snapshot: () => ({ victron: { firmware: 'v3.60' }, mid: { firmware: '1.2' } }) },
    deviceService: { getDevices: () => [{ id: 'd1', name: 'Heizstab', host: BAIT.deviceIp, online: true }] },
    evccIntegration: { getStatus: () => ({ loadpoints: [{ id: 1 }], lastError: BAIT.evccError }) },
    chargerStatus: {
      raw: () => ({ error: BAIT.evccError }),
      fresh: () => ({ connected: true, charging: false, powerW: 0, type: 'evcc' }),
    },
  };
}

async function get(ctx, urlPath) {
  const routes = createApiRoutes(ctx);
  const req = {
    method: 'GET', url: urlPath, headers: { host: 'dvhub.test' }, socket: { remoteAddress: '192.168.1.5' },
    on() { return req; }, destroy() {},
  };
  const res = mockRes();
  await routes.handleRequest(req, res, new URL(urlPath, 'http://dvhub.test'));
  return { status: res._captured.status, text: res._captured.body, body: res._captured.body ? JSON.parse(res._captured.body) : null };
}

describe('GET /api/mobile-link/integrations — Integrationen ohne Adressen und Zugangsdaten', () => {
  it('die Antwort für die App enthält keinen einzigen Köder', async () => {
    const out = await get(mockCtx(), '/api/mobile-link/integrations');
    assert.equal(out.status, 200);
    for (const [name, value] of Object.entries(BAIT)) {
      assert.equal(out.text.includes(String(value)), false, `Köder „${name}“ steht in der Antwort für die App`);
    }
    // Auch keine andere Adresse und kein Feld, das eine tragen könnte.
    assert.doesNotMatch(out.text, /\b\d{1,3}(\.\d{1,3}){3}\b/, 'IPv4-Adresse in der Antwort');
    assert.doesNotMatch(out.text, /:\/\//, 'URL in der Antwort');
    assert.doesNotMatch(out.text, /"(host|url|broker|brokerUrl|username|password|serial|identifier|vrmPortalId|lastError|list|state|subscriptionTopic)"/);
  });

  it('der Zustand kommt trotzdem an: Wahrheitswerte, Zähler, Modell, Firmware', async () => {
    const { body } = await get(mockCtx(), '/api/mobile-link/integrations');
    assert.equal(body.ok, true);
    assert.deepEqual(body.mqtt, { enabled: true, connected: true, embedded: false, topicCount: 42, passwordSet: true, haDiscovery: true });
    assert.deepEqual(body.victron, { configured: true, modelId: 'MultiPlus-II 48/5000', firmware: 'v3.60' });
    assert.deepEqual(body.mid, { configured: true, firmware: '1.2' });
    assert.deepEqual(body.vrm, { enabled: true, portalIdSet: true, tokenSet: true });
    assert.deepEqual(body.devices, { total: 1, online: 1 });
    assert.equal(body.evcc.configured, true);
    assert.equal(body.evcc.reachable, true);
    assert.equal(body.evcc.hasError, true);
    assert.deepEqual(body.evcc.charger, { reachable: true, connected: true, charging: false, powerW: 0, mode: null, hasError: true });
    assert.deepEqual(body.tesla, { enabled: true, name: 'Model Y', hasState: true, lastUpdate: 1763100000000 });
    assert.deepEqual(body.notifications, { enabled: true, providers: [{ name: 'ntfy', enabled: true }] });
    assert.equal(body.forecastProviders.solcast.apiKeySet, true);
    assert.equal(body.dveos.active, true);
  });

  it('Gegenprobe: /api/integrations/status nennt die Adressen weiterhin (deshalb bleibt es für die App zu)', async () => {
    const out = await get(mockCtx(), '/api/integrations/status');
    assert.equal(out.status, 200);
    assert.equal(out.body.victron.host, BAIT.victronHost);
    assert.equal(out.body.evcc.url, BAIT.evccUrl);
    assert.equal(out.text.includes(BAIT.mqttPassword), false, 'das MQTT-Passwort steht auch dort nie');
  });

  it('nur lesend: POST auf den Pfad gibt es nicht', async () => {
    const routes = createApiRoutes(mockCtx());
    const req = {
      method: 'POST', url: '/api/mobile-link/integrations', headers: { host: 'dvhub.test' }, socket: { remoteAddress: '127.0.0.1' },
      on(event, cb) { if (event === 'end') setTimeout(cb, 0); return req; }, destroy() {},
    };
    const res = mockRes();
    await routes.handleRequest(req, res, new URL(req.url, 'http://dvhub.test'));
    assert.notEqual(res._captured.status, 200);
    assert.doesNotMatch(res._captured.body, /victron/);
  });
});

describe('mobileIntegrationsView — Positivliste', () => {
  it('unbekannte Felder der großen Antwort gehen nie hinaus', () => {
    const out = JSON.stringify(mobileIntegrationsView({
      neuesFeld: { host: '10.0.0.9', secret: 'KOEDER-neu' },
      mqtt: { enabled: true, neuesGeheimnis: 'KOEDER-mqtt-neu', config: { passwordSet: true, password: 'KOEDER-pw', username: 'koeder' } },
      victron: { host: '10.0.0.5', modelId: 'http://10.0.0.5/modell', firmware: 'root@10.0.0.5' },
      evcc: { url: 'http://10.0.0.6', wallboxType: 'go-e', charger: { mode: 'pv', lastError: 'timeout 10.0.0.6' } },
    }));
    assert.doesNotMatch(out, /KOEDER|koeder|10\.0\.0\./);
    assert.match(out, /"wallboxType":"go-e"/);
    assert.match(out, /"mode":"pv"/);
  });

  it('leere oder kaputte Eingabe ergibt eine vollständige, leere Sicht', () => {
    for (const input of [undefined, null, 'x', [], {}]) {
      const out = mobileIntegrationsView(input);
      assert.equal(out.ok, true);
      assert.equal(out.mqtt.enabled, false);
      assert.equal(out.victron.configured, false);
      assert.equal(out.evcc.charger, null);
      assert.deepEqual(out.notifications.providers, []);
    }
  });

  it('safeText lässt nur kurze Texte ohne Adresse durch', () => {
    assert.equal(safeText('v3.60'), 'v3.60');
    assert.equal(safeText('MultiPlus-II 48/5000'), 'MultiPlus-II 48/5000');
    assert.equal(safeText(465), '465');
    for (const bad of ['192.168.77.60', 'http://gx', 'user@host', 'venus.local', 'gx.fritz.box', 'fe80::1ff:fe23:4567:890a', '[::1]', 'x'.repeat(61), '', {}, null]) {
      assert.equal(safeText(bad), null, String(bad));
    }
  });
});

describe('mobile-link Rechte — Stand 14.11.2026', () => {
  it('Integrationen: nur die Sicht für die App, nie /api/integrations/status', () => {
    assert.equal(checkRequest(['read'], 'GET', '/api/mobile-link/integrations').ok, true);
    assert.equal(checkRequest(['read', 'control'], 'GET', '/api/integrations/status').ok, false);
    assert.equal(checkRequest(['read', 'control'], 'POST', '/api/mobile-link/integrations').ok, false);
    for (const p of ['/api/mobile-link/status', '/api/mobile-link/settings', '/api/mobile-link/pair/start', '/api/mobile-link/devices/update']) {
      assert.equal(checkRequest(['read', 'control'], 'GET', p).ok, false, p);
      assert.equal(checkRequest(['read', 'control'], 'POST', p).ok, false, p);
    }
  });

  it('Zeitplan: lesen mit „Anzeigen“, ändern nur mit „Steuern“', () => {
    assert.equal(checkRequest(['read'], 'GET', '/api/schedule/automation/config').ok, true);
    for (const p of ['/api/schedule/rules', '/api/schedule/config', '/api/schedule/automation/config', '/api/schedule/rules/toggle', '/api/schedule/automation/replan']) {
      assert.equal(checkRequest(['read'], 'POST', p).error, 'control_not_allowed', p);
      assert.equal(checkRequest(['read', 'control'], 'POST', p).ok, true, p);
    }
  });

  it('die Listen sind genau die freigegebenen — eine neue Öffnung fällt hier auf', () => {
    assert.deepEqual([...READ_PATHS].sort(), [
      '/api/costs', '/api/devices', '/api/eeg/extension', '/api/eos/plan', '/api/eos/status', '/api/ev',
      '/api/family/status', '/api/family/tesla-history', '/api/family/tile-history', '/api/feed-in-cap/status',
      '/api/forecast', '/api/history/mispel', '/api/history/summary', '/api/integrations/dataflow',
      '/api/integrations/health', '/api/mobile-link/integrations', '/api/optimizer/status', '/api/schedule',
      '/api/schedule/automation/config', '/api/status', '/api/storage/status', '/api/telemetry/series',
      '/api/victron/devices', '/api/vpn/status',
    ]);
    assert.deepEqual([...CONTROL_PATHS].sort(), [
      '/api/control/resume', '/api/control/stop', '/api/control/write', '/api/ev', '/api/schedule/automation/config',
      '/api/schedule/automation/replan', '/api/schedule/config', '/api/schedule/rules', '/api/schedule/rules/toggle',
    ]);
    // Weiterhin zu: Konfiguration, Sofortladen, MQTT-Aktionen, Sicherungen.
    for (const p of ['/api/config', '/api/ev/override', '/api/ev/preview', '/api/integrations/mqtt/action', '/api/integrations/evcc', '/api/db/backup']) {
      assert.equal(checkRequest(['read', 'control'], 'POST', p).ok, false, p);
    }
  });
});
