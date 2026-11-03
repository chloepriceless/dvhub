// test/secret-target-binding.test.js -- Gegenprüfung (Ersatzprüfer) zu edeb17db,
// Thema SSRF-Branch: ein gespeichertes Geheimnis darf nicht mit einer neuen
// Zieladresse mitwandern.
//  P2 ntfy-Token über POST /api/integrations/notification-providers: Token wurde
//     neben jede neue topicUrl kopiert, ohne Herkunfts- und Adressprüfung.
//  P2 E-Auto-Tokens (Home Assistant, HTTP) und EOS-Fernbetrieb: /api/config mit
//     neuer URL und Token „***“ stellte den echten Token wieder her — er ging
//     beim nächsten Abruf an die neue Adresse. Gleiches Muster bei MQTT-, SMB-
//     und Datenbank-Zugangsdaten.
//  P3 ntfy-topicUrl über /api/config ohne Adressprüfung (blinde POSTs an
//     interne Adressen bei jeder Benachrichtigung).
import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreRedacted } from '../config-redaction.js';
import { createApiRoutes } from '../routes-api.js';
import { createNotificationService } from '../services/notifications/index.js';

function mockRes() {
  const captured = { status: 0, headers: {}, body: '' };
  return {
    headersSent: false,
    setHeader() {},
    writeHead(code, headers) { captured.status = code; Object.assign(captured.headers, headers || {}); this.headersSent = true; },
    end(payload) { captured.body = payload; },
    _captured: captured,
  };
}

function makeReq(method, urlPath, body) {
  const raw = body ? JSON.stringify(body) : '';
  const listeners = {};
  const req = {
    method, url: urlPath,
    headers: { host: '127.0.0.1:8080', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
    on(ev, cb) {
      if (ev === 'data' && raw) setTimeout(() => { cb(Buffer.from(raw)); listeners.end?.(); }, 0);
      else if (ev === 'end' && !raw) setTimeout(cb, 0);
      else listeners[ev] = cb;
      return req;
    },
    destroy() {},
  };
  return req;
}

function routesWith(raw) {
  const saved = [];
  const ctx = {
    getCfg: () => raw, getRawCfg: () => JSON.parse(JSON.stringify(raw)),
    saveAndApplyConfig: (next) => { saved.push(next); return { ok: true }; },
    pushLog: () => {}, needsSetup: () => false, getAppDir: () => '/tmp',
    licenseService: { requirePro: () => true, isProActive: () => true },
    getLoadedConfig: () => ({ exists: true, valid: true, needsSetup: false }),
    getConfigDefinition: () => [], getConfigPath: () => '/tmp/config.json',
  };
  return { routes: createApiRoutes(ctx), saved };
}

async function post(routes, p, body) {
  const res = mockRes();
  await routes.handleRequest(makeReq('POST', p, body), res, new URL(`http://x${p}`));
  return { status: res._captured.status, body: JSON.parse(res._captured.body || '{}') };
}

const NTFY = { notifications: { providers: { ntfy: { enabled: true, topicUrl: 'https://ntfy.sh/dvhub', token: 'echt-geheim' } } } };

test('P2: notification-providers — Token folgt nur auf denselben Server', async () => {
  const a = routesWith(JSON.parse(JSON.stringify(NTFY)));
  let r = await post(a.routes, '/api/integrations/notification-providers', { ntfy: { enabled: true, topicUrl: 'https://attacker.example.net/x', token: '***' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(a.saved.at(-1).notifications.providers.ntfy.token, undefined, 'Token nicht zum fremden Server');
  const b = routesWith(JSON.parse(JSON.stringify(NTFY)));
  r = await post(b.routes, '/api/integrations/notification-providers', { ntfy: { enabled: true, topicUrl: 'https://ntfy.sh/anderes-thema', token: '***' } });
  assert.equal(r.status, 200);
  assert.equal(b.saved.at(-1).notifications.providers.ntfy.token, 'echt-geheim', 'gleicher Server behält den Token');
});

test('P2: notification-providers — interne Adressen abgelehnt', async () => {
  for (const url of ['http://127.0.0.1:8503/v1/config', 'http://169.254.169.254/latest', 'file:///etc/passwd']) {
    const a = routesWith(JSON.parse(JSON.stringify(NTFY)));
    const r = await post(a.routes, '/api/integrations/notification-providers', { ntfy: { enabled: true, topicUrl: url, token: '' } });
    assert.equal(r.status, 400, url);
    assert.equal(r.body.error, 'invalid_topicurl');
    assert.equal(a.saved.length, 0);
  }
});

const CUR = {
  optimizer: {
    evHaUrl: 'https://ha.example.org', evHaToken: 'ha-geheim',
    evHttpUrl: 'http://192.168.1.50/soc', evHttpToken: 'http-geheim',
    eosProxy: { remote: { endpoint: 'https://eos.dvhub.de', token: 'eos-geheim', tokenEndpoint: 'https://eos.dvhub.de' } },
  },
  mqtt: { brokerUrl: 'mqtt://192.168.1.10:1883', username: 'u', password: 'mqtt-geheim' },
  victron: { mqttCrossCheck: { broker: 'mqtt://192.168.1.20', username: 'v', password: 'v-geheim' } },
  dbBackup: { smb: { host: 'nas.local', share: 'backup', username: 'smb', password: 'smb-geheim' } },
  telemetry: { database: { host: '/var/run/postgresql', password: 'db-geheim' } },
  notifications: { providers: { ntfy: { topicUrl: 'https://ntfy.sh/dvhub', token: 'ntfy-geheim' } } },
};
const clone = (o) => JSON.parse(JSON.stringify(o));
const masked = () => {
  const c = clone(CUR);
  c.optimizer.evHaToken = '***'; c.optimizer.evHttpToken = '***'; c.optimizer.eosProxy.remote.token = '***';
  c.mqtt.username = '***'; c.mqtt.password = '***';
  c.victron.mqttCrossCheck.username = '***'; c.victron.mqttCrossCheck.password = '***';
  c.dbBackup.smb.username = '***'; c.dbBackup.smb.password = '***';
  c.telemetry.database.password = '***';
  c.notifications.providers.ntfy.token = '***';
  return c;
};

test('P2: restoreRedacted — unveränderte Adressen behalten ihre Geheimnisse', () => {
  const out = restoreRedacted(masked(), CUR);
  assert.equal(out.optimizer.evHaToken, 'ha-geheim');
  assert.equal(out.optimizer.evHttpToken, 'http-geheim');
  assert.equal(out.optimizer.eosProxy.remote.token, 'eos-geheim');
  assert.equal(out.mqtt.password, 'mqtt-geheim');
  assert.equal(out.victron.mqttCrossCheck.password, 'v-geheim');
  assert.equal(out.dbBackup.smb.password, 'smb-geheim');
  assert.equal(out.telemetry.database.password, 'db-geheim');
  assert.equal(out.notifications.providers.ntfy.token, 'ntfy-geheim');
});

test('P2: restoreRedacted — neue Zieladresse → gespeichertes Geheimnis wandert nicht mit', () => {
  const inc = masked();
  inc.optimizer.evHaUrl = 'https://attacker.example.net';
  inc.optimizer.evHttpUrl = 'https://attacker.example.net/soc';
  inc.optimizer.eosProxy.remote.endpoint = 'https://other.dvhub.de';
  inc.mqtt.brokerUrl = 'mqtt://attacker.example.net:1883';
  inc.victron.mqttCrossCheck.broker = 'mqtt://attacker.example.net';
  inc.dbBackup.smb.host = 'attacker.example.net';
  inc.telemetry.database.host = 'attacker.example.net';
  const out = restoreRedacted(inc, CUR);
  assert.equal(out.optimizer.evHaToken, '');
  assert.equal(out.optimizer.evHttpToken, '');
  assert.equal(out.optimizer.eosProxy.remote.token, '');
  assert.equal(out.mqtt.username, '');
  assert.equal(out.mqtt.password, '');
  assert.equal(out.victron.mqttCrossCheck.password, '');
  assert.equal(out.dbBackup.smb.password, '');
  assert.equal(out.telemetry.database.password, '');
});

test('P2: restoreRedacted — tokenEndpoint des EOS-Fernbetriebs setzt nur die Box', () => {
  const inc = masked();
  inc.optimizer.eosProxy.remote.tokenEndpoint = '';
  const out = restoreRedacted(inc, CUR);
  assert.equal(out.optimizer.eosProxy.remote.tokenEndpoint, 'https://eos.dvhub.de');
});

test('P3: /api/config — geänderte ntfy-Adresse wird geprüft, eine gespeicherte Altadresse blockiert nicht', async () => {
  const raw = { httpPort: 8080, notifications: { providers: { ntfy: { topicUrl: 'http://127.0.0.1:9/alt' } } } };
  const a = routesWith(raw);
  let r = await post(a.routes, '/api/config', { config: { httpPort: 8080, notifications: { providers: { ntfy: { topicUrl: 'http://169.254.169.254/latest' } } } } });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.error, 'invalid_ntfy_topic_url');
  r = await post(a.routes, '/api/config', { config: { httpPort: 8080, notifications: { providers: { ntfy: { topicUrl: 'http://127.0.0.1:9/alt' } } } } });
  assert.notEqual(r.status, 400, JSON.stringify(r.body));
});

test('P3: Versand — ntfy mit interner Adresse wird nicht eingerichtet', async () => {
  const logs = [];
  const svc = createNotificationService({
    getCfg: () => ({ notifications: { enabled: true, providers: { ntfy: { enabled: true, topicUrl: 'http://169.254.169.254/latest' } } } }),
    pushLog: (e, d) => logs.push({ e, d }),
    state: {},
  });
  await svc.start();
  assert.ok(logs.some((l) => l.e === 'notification_provider_error' && /topic_url_not_allowed/.test(l.d?.error || '')), JSON.stringify(logs));
});

// Gegenprüfung bca61061: (P2) Geschwister-Routen trugen den gespeicherten Wert
// selbst weiter; (P2) Wallbox ohne Bindung; (P2) Rückfall-Ketten (Wetter-MQTT,
// Kreuzprobe, victron.host); (P3) Lizenz-Meldung ohne ntfy-Adressprüfung.
test('P2: /api/family/mqtt-config — neue Broker-Adresse, Passwort „***“ → nicht mitgenommen', async () => {
  const raw = { mqtt: { brokerUrl: 'mqtt://192.168.1.10:1883', username: 'u', password: 'mqtt-geheim' } };
  const a = routesWith(raw);
  const r = await post(a.routes, '/api/family/mqtt-config', { brokerUrl: 'mqtt://attacker.example.net:1883', password: '***' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(a.saved.at(-1).mqtt.password, '');
  assert.equal(a.saved.at(-1).mqtt.username, '');
  const b = routesWith(JSON.parse(JSON.stringify(raw)));
  await post(b.routes, '/api/family/mqtt-config', { brokerUrl: 'mqtt://192.168.1.10:1883', password: '***' });
  assert.equal(b.saved.at(-1).mqtt.password, 'mqtt-geheim', 'gleicher Broker behält das Passwort');
});

test('P2: /api/integrations/evcc — neue Wallbox-Adresse lässt die Zugangsdaten nicht hängen', async () => {
  const raw = { wallbox: { type: 'openevse', openevse: { url: 'http://192.168.1.30', username: 'oe', password: 'oe-geheim' }, wattpilot: { host: '192.168.1.31', password: 'wp-geheim' } } };
  const a = routesWith(raw);
  const r = await post(a.routes, '/api/integrations/evcc', { wallbox: { type: 'openevse', openevse: { url: 'http://attacker.example.net', password: '***' }, wattpilot: { host: '192.168.1.31', password: '***' } } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(a.saved.at(-1).wallbox.openevse.password, '');
  assert.equal(a.saved.at(-1).wallbox.wattpilot.password, 'wp-geheim', 'unverändertes Ziel behält das Passwort');
});

test('P2: restoreRedacted — Wallbox-Zugangsdaten an ihre Adresse gebunden', () => {
  const cur = { wallbox: { openevse: { url: 'http://192.168.1.30', username: 'oe', password: 'p' }, nrgkick: { host: '192.168.1.32', username: 'n', password: 'np' }, wattpilot: { host: '192.168.1.31', password: 'wp' } } };
  const inc = JSON.parse(JSON.stringify(cur));
  for (const k of ['openevse', 'nrgkick']) { inc.wallbox[k].username = '***'; inc.wallbox[k].password = '***'; }
  inc.wallbox.wattpilot.password = '***';
  inc.wallbox.openevse.url = 'http://attacker.example.net';
  inc.wallbox.nrgkick.host = 'attacker.example.net';
  inc.wallbox.wattpilot.host = 'attacker.example.net';
  const out = restoreRedacted(inc, cur);
  assert.equal(out.wallbox.openevse.password, '');
  assert.equal(out.wallbox.nrgkick.password, '');
  assert.equal(out.wallbox.wattpilot.password, '');
});

test('P2: restoreRedacted — Rückfall-Ketten: Wetter-Broker, Kreuzprobe, victron.host', () => {
  const cur = {
    mqtt: { brokerUrl: 'mqtt://192.168.1.10:1883', username: 'u', password: 'mqtt-geheim' },
    forecast: { weather: { provider: 'mqtt', mqtt: { brokerUrl: '' } } },
    victron: { host: '192.168.1.40', mqtt: { broker: '', username: 'v', password: 'gx-geheim' }, mqttCrossCheck: { broker: '' } },
  };
  const mask = (c) => { c.mqtt.username = '***'; c.mqtt.password = '***'; c.victron.mqtt.username = '***'; c.victron.mqtt.password = '***'; return c; };
  let inc = mask(JSON.parse(JSON.stringify(cur)));
  inc.forecast.weather.mqtt.brokerUrl = 'mqtt://attacker.example.net';
  let out = restoreRedacted(inc, cur);
  assert.equal(out.mqtt.password, '', 'Wetter nähme die allgemeinen Zugangsdaten zum neuen Broker mit');
  inc = mask(JSON.parse(JSON.stringify(cur)));
  inc.victron.mqttCrossCheck.broker = 'mqtts://attacker.example.net';
  out = restoreRedacted(inc, cur);
  assert.equal(out.victron.mqtt.password, '', 'Kreuzprobe nähme das GX-Passwort mit');
  inc = mask(JSON.parse(JSON.stringify(cur)));
  inc.victron.host = 'attacker.example.net';
  out = restoreRedacted(inc, cur);
  assert.equal(out.victron.mqtt.password, '', 'neuer victron.host = neuer Broker');
  out = restoreRedacted(mask(JSON.parse(JSON.stringify(cur))), cur);
  assert.equal(out.victron.mqtt.password, 'gx-geheim', 'nichts geändert → bleibt');
  assert.equal(out.mqtt.password, 'mqtt-geheim');
});

test('P3: Lizenz-Meldung baut ntfy mit derselben Adressprüfung', async () => {
  const { createProviderFromConfig } = await import('../services/notifications/index.js');
  assert.throws(() => createProviderFromConfig('ntfy', { topicUrl: 'http://169.254.169.254/latest' }), /topic_url_not_allowed/);
  assert.equal(createProviderFromConfig('ntfy', { topicUrl: 'https://ntfy.sh/x' }).type, 'ntfy');
  // Leer = nicht eingerichtet, nicht „nicht erlaubt“ (Prod-Test 02.11.2026).
  assert.throws(() => createProviderFromConfig('ntfy', { topicUrl: '' }), /requires topicUrl/);
  for (const topicUrl of ['   ', false, 0, null]) {
    assert.throws(() => createProviderFromConfig('ntfy', { topicUrl }), /requires topicUrl/, String(topicUrl));
  }
  const src = (await import('node:fs')).readFileSync(new URL('../services/license/index.js', import.meta.url), 'utf8');
  assert.match(src, /createProviderFromConfig\(name, pCfg\)/);
  assert.doesNotMatch(src, /const provider = factory\(pCfg\)/);
});

// Gegenprüfung 4fe254c9: (P1) im selben Request eingegebene Zugangsdaten wurden
// geleert; (P2) Reihenfolge der Prüfung ließ Rückfall-Ketten offen; (P2)
// /api/integrations/victron ohne Bindung; (P2) TLS → Klartext behielt das
// Geheimnis; (P3) verschiedene IPv6-Hosts galten als gleich.
test('P1: neue Adresse + im selben Request eingegebene Zugangsdaten bleiben', async () => {
  const raw = { mqtt: { brokerUrl: 'mqtt://192.168.1.10:1883', username: 'u', password: 'alt' } };
  const a = routesWith(raw);
  await post(a.routes, '/api/family/mqtt-config', { brokerUrl: 'mqtt://192.168.1.11:1883', username: 'u', password: 'alt' });
  assert.equal(a.saved.at(-1).mqtt.username, 'u');
  assert.equal(a.saved.at(-1).mqtt.password, 'alt');
  const w = routesWith({ wallbox: { type: 'openevse', openevse: { url: 'http://192.168.1.30', username: 'oe', password: 'p' } } });
  await post(w.routes, '/api/integrations/evcc', { wallbox: { type: 'openevse', openevse: { url: 'http://192.168.1.31', username: 'oe', password: 'p' } } });
  assert.equal(w.saved.at(-1).wallbox.openevse.password, 'p');
  assert.equal(w.saved.at(-1).wallbox.openevse.username, 'oe');
});

test('P2: Reihenfolge — eigene Wetter-/Kreuzprobe-Zugangsdaten geleert → allgemeine folgen nicht zum neuen Broker', () => {
  const cur = {
    mqtt: { brokerUrl: 'mqtt://192.168.1.10:1883', username: 'u', password: 'mqtt-geheim' },
    forecast: { weather: { provider: 'mqtt', mqtt: { brokerUrl: '', username: 'wu', password: 'w-geheim' } } },
    victron: { host: '192.168.1.40', mqtt: { broker: 'mqtt://192.168.1.40:1883', username: 'v', password: 'gx-geheim' }, mqttCrossCheck: { broker: '', username: 'c', password: 'c-geheim' } },
  };
  const inc = JSON.parse(JSON.stringify(cur));
  for (const p of [inc.mqtt, inc.forecast.weather.mqtt, inc.victron.mqtt, inc.victron.mqttCrossCheck]) { p.username = '***'; p.password = '***'; }
  inc.forecast.weather.mqtt.brokerUrl = 'mqtt://attacker.example.net';
  inc.victron.mqttCrossCheck.broker = 'mqtts://attacker.example.net';
  const out = restoreRedacted(inc, cur);
  assert.equal(out.forecast.weather.mqtt.password, '');
  assert.equal(out.mqtt.password, '', 'allgemeines Passwort ginge sonst als Rückfall zum neuen Wetter-Broker');
  assert.equal(out.victron.mqttCrossCheck.password, '');
  assert.equal(out.victron.mqtt.password, '', 'GX-Passwort ginge sonst als Rückfall zur neuen Kreuzprobe');
});

test('P2: /api/integrations/victron — neuer Host nimmt die gespeicherten MQTT-Zugangsdaten nicht mit', async () => {
  const raw = { victron: { host: '192.168.1.40', mqtt: { broker: '', username: 'v', password: 'gx-geheim' } } };
  const a = routesWith(raw);
  const r = await post(a.routes, '/api/integrations/victron', { host: 'attacker.example.net' });
  if (a.saved.length) assert.equal(a.saved.at(-1).victron.mqtt.password, '', JSON.stringify(r.body));
  else assert.notEqual(r.status, 200, 'entweder abgelehnt oder ohne Passwort gespeichert');
});

test('P2/P3: TLS → Klartext leert, Klartext → TLS behält; verschiedene IPv6-Hosts sind verschieden', () => {
  const cur = { notifications: { providers: { ntfy: { topicUrl: 'https://ntfy.sh/x', token: 't' } } }, dbBackup: { smb: { host: 'fd00::1', username: 's', password: 'p' } }, mqtt: { brokerUrl: 'mqtt://b:1883', username: 'u', password: 'm' } };
  const inc = JSON.parse(JSON.stringify(cur));
  inc.notifications.providers.ntfy.token = '***'; inc.dbBackup.smb.password = '***'; inc.mqtt.password = '***'; inc.mqtt.username = '***';
  inc.notifications.providers.ntfy.topicUrl = 'http://ntfy.sh/x';
  inc.dbBackup.smb.host = 'fd00::1234';
  inc.mqtt.brokerUrl = 'mqtts://b:8883';
  const out = restoreRedacted(inc, cur);
  assert.equal(out.notifications.providers.ntfy.token, '', 'https → http');
  assert.equal(out.dbBackup.smb.password, '', 'anderer IPv6-Host');
  assert.equal(out.mqtt.password, 'm', 'mqtt → mqtts auf demselben Host bleibt');
});

// Gesamtprüfung 1.0.9 (Sicherheitsreste): Der Ziel-Vergleich ignorierte den
// Port — derselbe Host mit anderem Port (ein anderer Dienst) bekam das
// gespeicherte Geheimnis. Standard-Ports gelten als gleich; mit besserer
// Sicherung (mqtt → mqtts) darf sich der Port mitändern.
test('Port gehört zum Ziel: anderer Port leert, Standard-Port explizit oder weggelassen bleibt', () => {
  const cur = {
    notifications: { providers: { ntfy: { topicUrl: 'https://ntfy.lan/x', token: 't' } } },
    optimizer: { evHaUrl: 'http://ha.lan:8123', evHaToken: 'ha' },
    mqtt: { brokerUrl: 'mqtt://b:1883', username: 'u', password: 'm' },
    dbBackup: { smb: { host: 'nas.lan', username: 's', password: 'p' } },
  };
  const mask = (c) => {
    const inc = JSON.parse(JSON.stringify(c));
    inc.notifications.providers.ntfy.token = '***'; inc.optimizer.evHaToken = '***';
    inc.mqtt.password = '***'; inc.mqtt.username = '***'; inc.dbBackup.smb.password = '***';
    return inc;
  };
  const changed = mask(cur);
  changed.notifications.providers.ntfy.topicUrl = 'https://ntfy.lan:8443/x';
  changed.optimizer.evHaUrl = 'http://ha.lan:9000';
  changed.mqtt.brokerUrl = 'mqtt://b:1884';
  changed.dbBackup.smb.host = 'nas.lan:4450';
  let out = restoreRedacted(changed, cur);
  assert.equal(out.notifications.providers.ntfy.token, '', 'ntfy: anderer Port');
  assert.equal(out.optimizer.evHaToken, '', 'HA: anderer Port');
  assert.equal(out.mqtt.password, '', 'MQTT: anderer Port');
  assert.equal(out.dbBackup.smb.password, '', 'SMB: Port neu angegeben');
  const same = mask(cur);
  same.notifications.providers.ntfy.topicUrl = 'https://ntfy.lan:443/y';
  same.optimizer.evHaUrl = 'http://ha.lan:8123/';
  same.mqtt.brokerUrl = 'mqtt://b';
  out = restoreRedacted(same, cur);
  assert.equal(out.notifications.providers.ntfy.token, 't', 'ntfy: Standard-Port explizit');
  assert.equal(out.optimizer.evHaToken, 'ha', 'HA: gleicher Port');
  assert.equal(out.mqtt.password, 'm', 'MQTT: Standard-Port weggelassen');
  assert.equal(out.dbBackup.smb.password, 'p', 'SMB: unverändert');
});
