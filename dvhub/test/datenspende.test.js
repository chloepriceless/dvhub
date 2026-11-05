// test/datenspende.test.js — Datenspende-Dienst: Quellen, Sammeln, Senden,
// Fehlerverhalten der Warteschlange, Einrichtung/Trennen.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createDatenspende, collectSources, SIDECAR_NAME, QUEUE_NAME, HEAD_BLOCK_TIMEOUT_MS, HEAD_RETRY_BACKOFF_MS,
} from '../services/datenspende/index.js';
import {
  DatenspendeConnError, DatenspendeServerError, DatenspendeRequestError, DatenspendeAuthError,
} from '../services/datenspende/client.js';

const T0 = Date.parse('2026-09-28T12:00:00Z');

function payload(over = {}) {
  return {
    meter: { grid_total_w: 500 },
    victron: { gridImportW: 0, gridExportW: 1200, pvTotalW: 3000.44, selfConsumptionW: 900, batteryPowerW: -300, ...over },
  };
}
function baseCtx({ dir, cfg, devices = [], tiles = [], loadpoints = [], pl = payload() }) {
  return {
    getDataDir: () => dir,
    getCfg: () => cfg,
    pushLog: () => {},
    buildFallbackStatusPayload: () => pl,
    deviceService: { getDevices: () => devices },
    familyMqttTiles: { getTiles: () => tiles },
    evccIntegration: { getLoadpoints: () => loadpoints },
  };
}
// Client-Stub mit Aufzeichnung; Verhalten pro Test überschreibbar.
function fakeClient() {
  let n = 0;
  const c = {
    calls: [],
    batches: [],
    submitImpl: null,
    async registerMeter(key, clientId, meta) { c.calls.push(['register', meta.name]); return `M${++n}`; },
    async submitBatch(key, clientId, readings) {
      c.calls.push(['submit', readings.length]);
      if (c.submitImpl) return c.submitImpl(readings);
      c.batches.push(readings);
      return { accepted: readings.length, unknownMeters: [] };
    },
    async signUp() { c.calls.push(['signUp']); return { token: 'TOK', userId: 'U1' }; },
    async signIn() { c.calls.push(['signIn']); return { token: 'TOK', userId: 'U1' }; },
    async createHousehold(t, h) { c.calls.push(['household', h]); return 'H1'; },
    async createClient(t, x) { c.calls.push(['client', x]); return 'C1'; },
    async createApiKey() { c.calls.push(['apiKey']); return 'KEY-SECRET'; },
    async signOut() { c.calls.push(['signOut']); },
  };
  return c;
}
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-ds-')); }
function linkedSetup({ enabled = true, ds = {}, ...rest } = {}) {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, SIDECAR_NAME), JSON.stringify({ apiKey: 'KEY', clientId: 'C1', meters: {}, donated: 0 }));
  let t = T0;
  const cfg = { manufacturer: 'victron', datenspende: { enabled, ...ds }, devices: rest.cfgDevices || [] };
  const client = fakeClient();
  const svc = createDatenspende(baseCtx({ dir, cfg, ...rest }), { client, now: () => t, random: () => 0.5 });
  return { dir, cfg, client, svc, advance: (ms) => { t += ms; }, now: () => t };
}

// ── Quellen ──────────────────────────────────────────────────────────────────

test('collectSources: Vorzeichen Netz (+Bezug/−Einspeisung), Batterie (+Laden/−Entladen), gerundet', () => {
  const s = collectSources(baseCtx({ cfg: {} }), { manufacturer: 'victron', datenspende: {} }, T0);
  const by = Object.fromEntries(s.map((x) => [x.key, x]));
  assert.equal(by.grid.power, -1200, 'Einspeisung negativ');
  assert.equal(by.pv.power, 3000.4);
  assert.equal(by.load.power, 900);
  assert.equal(by.battery.power, -300, 'Entladen negativ');
  assert.equal(by.grid.vendor, 'victron');
});

test('collectSources: Rückfall auf meter.grid_total_w mit Vorzeichen-Konvention', () => {
  const ctx = baseCtx({ cfg: {}, pl: { meter: { grid_total_w: 400 }, victron: {} } });
  assert.equal(collectSources(ctx, { datenspende: {} }, T0).find((x) => x.key === 'grid').power, -400, 'Default feed_in: + = Einspeisung');
  assert.equal(collectSources(ctx, { gridPositiveMeans: 'grid_import', datenspende: {} }, T0).find((x) => x.key === 'grid').power, 400);
});

test('collectSources: Geräte (Shelly mit kWh, MQTT ohne Energie), Kacheln nur W/kW, evcc, offline raus', () => {
  const ctx = baseCtx({
    cfg: {},
    devices: [
      { id: 'wm', name: 'Waschmaschine', powerW: 1500, energyTodayWh: 123456, online: true },
      { id: 'wp', name: 'Wärmepumpe', powerW: 800, energyTodayWh: 999, online: true },
      { id: 'off', name: 'Aus', powerW: 5, online: false },
    ],
    tiles: [
      { id: 'sauna', label: 'Sauna', unit: 'kW', value: 6.5, online: true },
      { id: 'temp', label: 'Temperatur', unit: '°C', value: 21, online: true },
      { id: 'pool', label: 'Pool', unit: 'W', value: '350', online: true },
    ],
    loadpoints: [{ id: 1, title: 'Garage', chargePowerW: 11000 }],
  });
  const cfg = { datenspende: {}, devices: [{ id: 'wm', adapter: 'shelly-http' }, { id: 'wp', adapter: 'mqtt-generic' }] };
  const by = Object.fromEntries(collectSources(ctx, cfg, T0).map((x) => [x.key, x]));
  assert.deepEqual([by['device:wm'].power, by['device:wm'].energy, by['device:wm'].vendor], [1500, 123.456, 'Shelly']);
  assert.equal(by['device:wp'].energy, undefined, 'MQTT-Energie: Einheit unbekannt → nicht senden');
  assert.equal(by['device:off'], undefined);
  assert.equal(by['tile:sauna'].power, 6500);
  assert.equal(by['tile:pool'].power, 350);
  assert.equal(by['tile:temp'], undefined, 'keine Leistung');
  assert.equal(by['evcc:1'].power, 11000);
  assert.equal(by['evcc:1'].name, 'Garage');
});

test('collectSources: abgewählte Quellen fehlen', () => {
  const ctx = baseCtx({ cfg: {}, devices: [{ id: 'x', name: 'X', powerW: 1, online: true }] });
  const keys = collectSources(ctx, { datenspende: { sources: { pv: false, devices: false } } }, T0).map((x) => x.key);
  assert.ok(!keys.includes('pv'));
  assert.ok(!keys.some((k) => k.startsWith('device:')));
  assert.ok(keys.includes('grid'));
});

// ── Sammeln & Senden ─────────────────────────────────────────────────────────

test('nicht verknüpft oder ausgeschaltet: nichts sammeln, nichts senden', async () => {
  const dir = tmp();
  const client = fakeClient();
  const svc = createDatenspende(baseCtx({ dir, cfg: { datenspende: { enabled: true } } }), { client, now: () => T0 });
  assert.equal(svc.sample().skipped, 'not_linked');
  const off = linkedSetup({ enabled: false });
  assert.equal(off.svc.sample().skipped, 'disabled');
  assert.equal((await off.svc.flush()).skipped, 'disabled');
  assert.equal(off.client.calls.length, 0);
});

test('Sammeln + Senden: Zähler einmalig registriert, Batch mit Server-Zähler-IDs, donated gezählt', async () => {
  const s = linkedSetup();
  s.svc.sample();
  s.advance(10_000);
  s.svc.sample();
  const r = await s.svc.flush();
  assert.equal(r.ok, true);
  assert.deepEqual(s.client.calls.filter((c) => c[0] === 'register').map((c) => c[1]),
    ['Netzanschluss', 'PV-Erzeugung', 'Hausverbrauch', 'Batterie']);
  const batch = s.client.batches[0];
  assert.equal(batch.length, 8);
  assert.ok(batch.every((x) => /^M\d$/.test(x.meter_id)));
  assert.equal(batch[0].timestamp, '2026-09-28T12:00:00Z');
  const sc = JSON.parse(fs.readFileSync(path.join(s.dir, SIDECAR_NAME), 'utf8'));
  assert.equal(sc.donated, 8);
  assert.equal(Object.keys(sc.meters).length, 4);
  // Zweiter Flush: keine erneute Registrierung
  s.svc.sample();
  await s.svc.flush();
  assert.equal(s.client.calls.filter((c) => c[0] === 'register').length, 4);
  assert.equal(s.svc.status().queued, 0);
});

test('Server kennt Zähler nicht mehr (unknownMeters): Werte verworfen, Zähler neu registriert', async () => {
  const s = linkedSetup();
  s.svc.sample();
  await s.svc.flush();
  s.svc.sample();
  s.client.submitImpl = () => ({ accepted: 3, unknownMeters: ['M1'] });
  await s.svc.flush();
  const sc = JSON.parse(fs.readFileSync(path.join(s.dir, SIDECAR_NAME), 'utf8'));
  assert.equal(sc.meters.grid, undefined, 'Netz-Zähler wird beim nächsten Mal neu angelegt');
  s.client.submitImpl = null;
  s.svc.sample();
  await s.svc.flush();
  assert.equal(s.client.calls.filter((c) => c[0] === 'register').length, 5);
});

test('Verbindungsfehler: Werte bleiben, Backoff, danach nachgereicht', async () => {
  const s = linkedSetup();
  s.svc.sample();
  s.client.submitImpl = () => { throw new DatenspendeConnError('offline'); };
  assert.equal((await s.svc.flush()).ok, false);
  assert.equal(s.svc.status().queued, 4);
  assert.match(s.svc.status().lastError, /offline/);
  s.client.submitImpl = null;
  assert.equal((await s.svc.flush()).skipped, 'backoff', 'nicht sofort erneut');
  s.advance(HEAD_RETRY_BACKOFF_MS + 1);
  assert.equal((await s.svc.flush()).ok, true);
  assert.equal(s.svc.status().queued, 0);
});

test('Dauerhaft falscher Batch (4xx) wird verworfen, der Rest geht weiter', async () => {
  const s = linkedSetup();
  s.svc.sample();
  s.client.submitImpl = () => { throw new DatenspendeRequestError('bad'); };
  await s.svc.flush();
  assert.equal(s.svc.status().queued, 0);
});

test('Server-Fehler (5xx): Batch bleibt, nach 15 min Blockade verworfen', async () => {
  const s = linkedSetup();
  s.svc.sample();
  s.client.submitImpl = () => { throw new DatenspendeServerError('boom'); };
  await s.svc.flush();
  assert.equal(s.svc.status().queued, 4);
  s.advance(HEAD_BLOCK_TIMEOUT_MS + HEAD_RETRY_BACKOFF_MS + 1);
  await s.svc.flush();
  assert.equal(s.svc.status().queued, 0);
});

test('Auth-Fehler (Key widerrufen): Werte bleiben erhalten', async () => {
  const s = linkedSetup();
  s.svc.sample();
  s.client.submitImpl = () => { throw new DatenspendeAuthError('unauthorized'); };
  await s.svc.flush();
  assert.equal(s.svc.status().queued, 4);
});

test('Warteschlange überlebt einen Neustart', async () => {
  const s = linkedSetup();
  s.svc.sample();
  s.client.submitImpl = () => { throw new DatenspendeConnError('offline'); };
  await s.svc.flush();
  const again = createDatenspende(baseCtx({ dir: s.dir, cfg: s.cfg }), { client: fakeClient(), now: s.now });
  assert.equal(again.status().queued, 4);
});

test('Ausschalten verwirft Gesammeltes (nichts nach dem Abschalten senden)', async () => {
  const s = linkedSetup();
  s.svc.sample();
  s.cfg.datenspende.enabled = false;
  s.svc.sample();
  assert.equal(s.svc.status().queued, 0);
});

// ── Einrichtung ──────────────────────────────────────────────────────────────

test('link: ohne Einwilligung keine Anfrage an den Server', async () => {
  const dir = tmp();
  const client = fakeClient();
  const svc = createDatenspende(baseCtx({ dir, cfg: { datenspende: {} } }), { client, now: () => T0 });
  await assert.rejects(svc.link({ mode: 'signup', username: 'u', password: 'p', consent: false }), /Einwilligung/);
  assert.equal(client.calls.length, 0);
});

test('link: API-Key im Sidecar (0600), Passwort nie gespeichert, Client-Typ victron, Sign-out', async () => {
  const dir = tmp();
  const client = fakeClient();
  const svc = createDatenspende(baseCtx({ dir, cfg: { datenspende: { clientType: 'dvhub' } } }), { client, now: () => T0 });
  const st = await svc.link({ mode: 'signup', username: 'christin', password: 'GEHEIM-pw-123', consent: true, household: { zip: '52062', numberInhabitants: 3 } });
  assert.equal(st.linked, true);
  const file = path.join(dir, SIDECAR_NAME);
  const raw = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(raw, /GEHEIM-pw-123/, 'Passwort darf nirgends landen');
  assert.equal(JSON.parse(raw).apiKey, 'KEY-SECRET');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // GH #31: „dvhub“ kennt der Server nicht (400 Invalid input format: null) —
  // ein Altwert wird auf den Portal-Typ victron gehoben.
  assert.deepEqual(client.calls.find((c) => c[0] === 'client')[1], { householdId: 'H1', name: 'DVhub', type: 'victron' });
  assert.equal(client.calls.find((c) => c[0] === 'household')[1].numberInhabitants, 3);
  assert.equal(client.calls.at(-1)[0], 'signOut');
  assert.equal(JSON.stringify(st).includes('KEY-SECRET'), false, 'Status verrät den API-Key nicht');
});

test('link: Sign-out auch, wenn ein Schritt scheitert', async () => {
  const dir = tmp();
  const client = fakeClient();
  client.createClient = async () => { throw new DatenspendeRequestError('bad type', 'bad_request'); };
  const svc = createDatenspende(baseCtx({ dir, cfg: { datenspende: {} } }), { client, now: () => T0 });
  await assert.rejects(svc.link({ mode: 'signin', username: 'u', password: 'p', consent: true }), /bad type/);
  assert.equal(client.calls.at(-1)[0], 'signOut');
  assert.equal(fs.existsSync(path.join(dir, SIDECAR_NAME)), false);
});

test('unlink: Zugang + Warteschlange weg; Neu-Verknüpfen sendet keine alten Werte an den neuen Client', async () => {
  const s = linkedSetup();
  s.svc.sample();
  s.client.submitImpl = () => { throw new DatenspendeConnError('offline'); };
  await s.svc.flush();
  s.svc.unlink();
  assert.equal(fs.existsSync(path.join(s.dir, SIDECAR_NAME)), false);
  assert.equal(fs.existsSync(path.join(s.dir, QUEUE_NAME)), false);
  assert.equal(s.svc.status().linked, false);
  assert.equal(s.svc.status().queued, 0);
});

// ── Races (Codex-Review) ─────────────────────────────────────────────────────

test('Race: Trennen während ein Batch unterwegs ist → Zugang bleibt gelöscht', async () => {
  const s = linkedSetup();
  s.svc.sample();
  await s.svc.flush(); // Zähler registriert
  s.svc.sample();
  let release;
  s.client.submitImpl = () => new Promise((r) => { release = () => r({ accepted: 4, unknownMeters: [] }); });
  const pending = s.svc.flush();
  await new Promise((r) => setImmediate(r));
  s.svc.unlink();
  release();
  const res = await pending;
  assert.equal(res.aborted, 'link_changed');
  assert.equal(fs.existsSync(path.join(s.dir, SIDECAR_NAME)), false, 'alter Zugang nicht zurückgeschrieben');
  assert.equal(s.svc.status().linked, false);
});

test('Race: neues Konto verknüpft, während ein Batch des alten unterwegs ist → neues bleibt unberührt', async () => {
  const s = linkedSetup();
  s.svc.sample();
  let release;
  s.client.submitImpl = () => new Promise((r) => { release = () => r({ accepted: 4, unknownMeters: [] }); });
  const pending = s.svc.flush();
  await new Promise((r) => setTimeout(r, 5));
  fs.writeFileSync(path.join(s.dir, SIDECAR_NAME), JSON.stringify({ apiKey: 'NEW', clientId: 'C2', meters: {}, donated: 0 }));
  release();
  await pending;
  const sc = JSON.parse(fs.readFileSync(path.join(s.dir, SIDECAR_NAME), 'utf8'));
  assert.deepEqual([sc.clientId, sc.apiKey, sc.donated, Object.keys(sc.meters).length], ['C2', 'NEW', 0, 0]);
});

test('Race: Trennen/Ausschalten während der Einrichtung → Einrichtung verworfen', async () => {
  const dir = tmp();
  const client = fakeClient();
  let release;
  client.createApiKey = () => new Promise((r) => { release = () => r('LATE-KEY'); });
  const svc = createDatenspende(baseCtx({ dir, cfg: { datenspende: {} } }), { client, now: () => T0 });
  const pending = svc.link({ mode: 'signup', username: 'u', password: 'p', consent: true });
  await new Promise((r) => setTimeout(r, 5));
  svc.cancelPendingLink(); // Kunde schaltet aus
  release();
  await assert.rejects(pending, /abgebrochen/);
  assert.equal(fs.existsSync(path.join(dir, SIDECAR_NAME)), false);
  assert.equal(client.calls.at(-1)[0], 'signOut');
});

test('Race: Ausschalten während des Abmeldens (letzter Schritt) → nichts gespeichert', async () => {
  const dir = tmp();
  const client = fakeClient();
  let release;
  client.signOut = () => new Promise((r) => { release = r; });
  const svc = createDatenspende(baseCtx({ dir, cfg: { datenspende: {} } }), { client, now: () => T0 });
  const pending = svc.link({ mode: 'signup', username: 'u', password: 'p', consent: true });
  await new Promise((r) => setTimeout(r, 5));
  svc.cancelPendingLink();
  release();
  await assert.rejects(pending, /abgebrochen/);
  assert.equal(fs.existsSync(path.join(dir, SIDECAR_NAME)), false);
});

test('Race: Ausschalten während einer Zähler-Registrierung → Batch wird nicht gesendet', async () => {
  const s = linkedSetup();
  s.svc.sample();
  let release;
  const origRegister = s.client.registerMeter;
  s.client.registerMeter = (...a) => new Promise((r) => { release = () => r(origRegister(...a)); });
  const pending = s.svc.flush();
  await new Promise((r) => setImmediate(r));
  s.cfg.datenspende.enabled = false;
  // restliche Registrierungen sofort beantworten
  s.client.registerMeter = origRegister;
  release();
  const res = await pending;
  assert.equal(res.skipped, 'disabled');
  assert.equal(s.client.calls.filter((c) => c[0] === 'submit').length, 0, 'nach dem Ausschalten nichts gesendet');
  assert.equal(s.svc.status().queued, 0);
});

test('MQTT-Kachel ohne Wert (null/leer) wird übersprungen — kein erfundener 0-W-Wert', () => {
  const ctx = baseCtx({ cfg: {}, tiles: [
    { id: 'a', label: 'A', unit: 'W', value: null, online: true },
    { id: 'b', label: 'B', unit: 'W', value: '', online: true },
    { id: 'c', label: 'C', unit: 'W', value: 0, online: true },
  ] });
  const keys = collectSources(ctx, { datenspende: {} }, T0).map((x) => x.key);
  assert.ok(!keys.includes('tile:a') && !keys.includes('tile:b'));
  assert.ok(keys.includes('tile:c'), 'echte 0 W bleiben erhalten');
});

test('linkApiKey: Key beim Server geprüft, Client-ID von dort, ohne Einwilligung nichts', async () => {
  const dir = tmp();
  const client = fakeClient();
  client.getClientId = async (k) => { client.calls.push(['getClientId', k]); return 'fc81-client'; };
  const svc = createDatenspende(baseCtx({ dir, cfg: { datenspende: {} } }), { client, now: () => T0 });
  await assert.rejects(svc.linkApiKey({ apiKey: 'A'.repeat(64), consent: false }), /Einwilligung/);
  await assert.rejects(svc.linkApiKey({ apiKey: 'kurz', consent: true }), /Format/);
  assert.equal(client.calls.length, 0);
  const st = await svc.linkApiKey({ apiKey: 'A'.repeat(64), consent: true });
  assert.equal(st.linked, true);
  assert.equal(st.clientId, 'fc81-client');
  const sc = JSON.parse(fs.readFileSync(path.join(dir, SIDECAR_NAME), 'utf8'));
  assert.deepEqual([sc.apiKey, sc.clientId, sc.via], ['A'.repeat(64), 'fc81-client', 'api_key']);
  assert.equal(JSON.stringify(st).includes('A'.repeat(64)), false, 'Status verrät den Key nicht');
});

// ── GH #31: gescheiterter Einrichtungsschritt wird benannt ───────────────────

test('#31 link: Schritt steht am Fehler (Haushalt anlegen)', async () => {
  const dir = tmp();
  const client = fakeClient();
  client.createHousehold = async () => { throw new DatenspendeRequestError('400 bad_request: Invalid input format: null', 'bad_request', 400); };
  const svc = createDatenspende(baseCtx({ dir, cfg: { datenspende: {} } }), { client, now: () => T0 });
  await assert.rejects(svc.link({ mode: 'signup', username: 'u', password: 'p', consent: true }),
    (e) => e.step === 'households' && /Invalid input format/.test(e.message));
  assert.equal(client.calls.at(-1)[0], 'signOut');
});

test('#31 link: fehlende Haushalt-ID bricht sofort ab — kein Client-Aufruf ohne ID', async () => {
  const dir = tmp();
  const client = fakeClient();
  client.createHousehold = async (t, h) => { client.calls.push(['household', h]); return undefined; };
  const svc = createDatenspende(baseCtx({ dir, cfg: { datenspende: {} } }), { client, now: () => T0 });
  await assert.rejects(svc.link({ mode: 'signup', username: 'u', password: 'p', consent: true }),
    (e) => e.code === 'bad_response' && e.step === 'households');
  assert.equal(client.calls.some((c) => c[0] === 'client'), false, 'createClient nicht mit leerer Haushalt-ID aufgerufen');
  assert.equal(client.calls.at(-1)[0], 'signOut');
});

test('#31 link: fehlende Client-ID → Schritt clients, kein API-Key-Aufruf', async () => {
  const dir = tmp();
  const client = fakeClient();
  client.createClient = async () => null;
  const svc = createDatenspende(baseCtx({ dir, cfg: { datenspende: {} } }), { client, now: () => T0 });
  await assert.rejects(svc.link({ mode: 'signin', username: 'u', password: 'p', consent: true }),
    (e) => e.code === 'bad_response' && e.step === 'clients');
  assert.equal(client.calls.some((c) => c[0] === 'apiKey'), false);
});

test('#31 link: Konto anlegen scheitert → Schritt sign-up; Passwort/Schlüssel nie in der Meldung', async () => {
  const dir = tmp();
  const client = fakeClient();
  client.signUp = async () => { throw new DatenspendeAuthError('400 invalid_secret: secret S3CR3T-XYZ invalid for pw hunter22', 'invalid_secret', 400); };
  const svc = createDatenspende(baseCtx({ dir, cfg: { datenspende: {} } }), { client, now: () => T0 });
  await assert.rejects(svc.link({ mode: 'signup', username: 'u', password: 'hunter22', secret: 'S3CR3T-XYZ', consent: true }), (e) => {
    assert.equal(e.step, 'sign-up');
    assert.equal(e.message.includes('hunter22'), false);
    assert.equal(e.message.includes('S3CR3T-XYZ'), false);
    return true;
  });
});

test('#31 linkApiKey: Prüfschritt wird benannt', async () => {
  const dir = tmp();
  const client = fakeClient();
  client.getClientId = async () => { throw new DatenspendeConnError('Verbindungsfehler: ETIMEDOUT', 'connection_error'); };
  const svc = createDatenspende(baseCtx({ dir, cfg: { datenspende: {} } }), { client, now: () => T0 });
  await assert.rejects(svc.linkApiKey({ apiKey: 'K'.repeat(40), consent: true }), (e) => e.step === 'api-key-check');
});

// Gegenprüfung 9190f2f8 (P3): falsy-IDs (0, false) zählen nicht als ID — sonst
// meldete die Oberfläche „verbunden“, obwohl der Sidecar sie wieder verwirft.
test('#31 linkApiKey: Client-ID 0/false → Fehler statt scheinbarer Verknüpfung', async () => {
  for (const bad of [0, false]) {
    const dir = tmp();
    const client = fakeClient();
    client.getClientId = async () => bad;
    const svc = createDatenspende(baseCtx({ dir, cfg: { datenspende: {} } }), { client, now: () => T0 });
    await assert.rejects(svc.linkApiKey({ apiKey: 'K'.repeat(40), consent: true }),
      (e) => e.code === 'bad_response' && e.step === 'api-key-check');
    assert.equal(fs.existsSync(path.join(dir, SIDECAR_NAME)), false);
  }
});

test('#31 link: Haushalt-ID 0 → Abbruch im Schritt households', async () => {
  const dir = tmp();
  const client = fakeClient();
  client.createHousehold = async () => 0;
  const svc = createDatenspende(baseCtx({ dir, cfg: { datenspende: {} } }), { client, now: () => T0 });
  await assert.rejects(svc.link({ mode: 'signin', username: 'u', password: 'p', consent: true }),
    (e) => e.code === 'bad_response' && e.step === 'households');
});

// ── Netzspannung je Phase (05.11.2026, zentrale Werte services/grid-voltage.js) ──
// Format wie die HA-Integration (powercollect __init__.py _build_payload): je
// Zähler höchstens ein voltage-Wert; ein Zähler darf nur voltage tragen
// (config_flow: „at_least_one_entity_required“ — Spannung allein reicht). Drei
// Phasen = drei Zähler „Netzspannung L1/L2/L3“.

const GV = { l1: 238.24, l2: 237.1, l3: 236.96, frequencyHz: 49.98, updatedAt: T0 - 15_000, source: 'victron_modbus', unitId: 100, error: null };

test('collectSources: Netzspannung je Phase als voltage-Zähler (nur frisch, ohne power), abwählbar', () => {
  const ctx = baseCtx({ cfg: {}, pl: payload({ gridVoltage: GV }) });
  const by = Object.fromEntries(collectSources(ctx, { manufacturer: 'victron', datenspende: {} }, T0).map((x) => [x.key, x]));
  assert.deepEqual([by.gridL1.voltage, by.gridL2.voltage, by.gridL3.voltage], [238.2, 237.1, 237]);
  assert.equal(by.gridL1.power, undefined, 'kein erfundener Leistungswert');
  assert.equal(by.gridL1.name, 'Netzspannung L1');
  assert.equal(by.gridL1.vendor, 'victron');
  assert.equal(by.gridL1.measuredAt, GV.updatedAt);
  assert.equal(by.grid.power, -1200, 'Netzanschluss unverändert');
  // einphasig: nur L1
  const one = collectSources(baseCtx({ cfg: {}, pl: payload({ gridVoltage: { ...GV, l2: null, l3: null } }) }), { datenspende: {} }, T0).map((x) => x.key);
  assert.ok(one.includes('gridL1') && !one.includes('gridL2') && !one.includes('gridL3'));
  // veraltet (> 2 min) oder keine Quelle → keine Spannung
  const stale = collectSources(baseCtx({ cfg: {}, pl: payload({ gridVoltage: { ...GV, updatedAt: T0 - 3 * 60_000 } }) }), { datenspende: {} }, T0);
  assert.ok(!stale.some((x) => x.key.startsWith('gridL')));
  assert.ok(!collectSources(baseCtx({ cfg: {} }), { datenspende: {} }, T0).some((x) => x.key.startsWith('gridL')));
  // abgewählt
  const off = collectSources(ctx, { datenspende: { sources: { gridVoltage: false } } }, T0);
  assert.ok(!off.some((x) => x.key.startsWith('gridL')));
});

test('Sammeln + Senden: Spannung je Messung genau einmal, als voltage im Batch; bestehende Zähler bleiben', async () => {
  const dir = tmp();
  // Bestehende Spende (wie Prod): Netz/PV/Last/Batterie schon registriert.
  const existing = { grid: { id: 'G0', name: 'Netzanschluss' }, pv: { id: 'P0', name: 'PV-Erzeugung' }, load: { id: 'L0', name: 'Hausverbrauch' }, battery: { id: 'B0', name: 'Batterie' } };
  fs.writeFileSync(path.join(dir, SIDECAR_NAME), JSON.stringify({ apiKey: 'KEY', clientId: 'C1', meters: existing, donated: 10 }));
  let t = T0;
  const pl = payload({ gridVoltage: GV });
  const cfg = { manufacturer: 'victron', datenspende: { enabled: true } };
  const client = fakeClient();
  const svc = createDatenspende(baseCtx({ dir, cfg, pl }), { client, now: () => t, random: () => 0.5 });
  svc.sample();
  t += 10_000;
  svc.sample(); // gleiche Messung (updatedAt unverändert) → keine zweite Spannung
  t += 10_000;
  pl.victron.gridVoltage = { ...GV, l1: 239, updatedAt: T0 + 15_000 };
  svc.sample();
  await svc.flush();
  const registered = client.calls.filter((c) => c[0] === 'register').map((c) => c[1]);
  assert.deepEqual(registered, ['Netzspannung L1', 'Netzspannung L2', 'Netzspannung L3'], 'nur die neuen Zähler registriert');
  const batch = client.batches[0];
  const sc = JSON.parse(fs.readFileSync(path.join(dir, SIDECAR_NAME), 'utf8'));
  assert.equal(sc.meters.grid.id, 'G0', 'bestehende Zähler-IDs unverändert');
  const l1 = batch.filter((r) => r.meter_id === sc.meters.gridL1.id);
  assert.deepEqual(l1.map((r) => r.voltage), [238.2, 239]);
  assert.ok(l1.every((r) => !('power' in r)), 'Spannungs-Zähler ohne power');
  const g = batch.filter((r) => r.meter_id === 'G0');
  assert.equal(g.length, 3);
  assert.ok(g.every((r) => r.power === -1200 && !('voltage' in r)));
});

test('columnarPayload: voltage-Spalte für Spannungs-Zähler', async () => {
  const { columnarPayload } = await import('../services/datenspende/client.js');
  const p = columnarPayload([
    { meter_id: 'G0', timestamp: '2026-09-28T12:00:00Z', power: -1200 },
    { meter_id: 'V1', timestamp: '2026-09-28T12:00:00Z', voltage: 238.2 },
    { meter_id: 'V1', timestamp: '2026-09-28T12:00:30Z', voltage: 239 },
  ]);
  assert.deepEqual(p.meters.find((m) => m.id === 'V1'), { id: 'V1', dt: [0, 30], voltage: [238.2, 239] });
});

// ── GH #31: Client-Typ ───────────────────────────────────────────────────────

test('#31 Client-Typ: Standard victron (Portal-Typ), Altwert dvhub → victron, bekannte Typen bleiben', () => {
  const mk = (ds) => createDatenspende(baseCtx({ dir: tmp(), cfg: { datenspende: ds } }), { client: fakeClient(), now: () => T0 });
  assert.equal(mk({}).settings().clientType, 'victron');
  assert.equal(mk({ clientType: 'dvhub' }).settings().clientType, 'victron');
  assert.equal(mk({ clientType: 'quatsch' }).settings().clientType, 'victron');
  assert.equal(mk({ clientType: 'home_assistant' }).settings().clientType, 'home_assistant');
});

test('#31 bestehende, verknüpfte Spende (Altwert dvhub): kein neues Konto, kein neuer Client — Senden wie bisher', async () => {
  const s = linkedSetup({ ds: { clientType: 'dvhub' } });
  s.svc.sample();
  await s.svc.flush();
  const kinds = new Set(s.client.calls.map((c) => c[0]));
  for (const k of ['signUp', 'signIn', 'household', 'client', 'apiKey']) assert.equal(kinds.has(k), false, k);
  assert.equal(s.client.batches.length, 1);
});

// ── GH #31: Schlüssel aus dem Datenportal (empfohlener Weg) ──────────────────

test('#31 Portal-Schlüssel: Format des Portals unbekannt → jedes druckbare Zeichen ohne Leerraum; nur GET /clients, dann nur Zähler', async () => {
  const dir = tmp();
  const client = fakeClient();
  client.getClientId = async (k) => { client.calls.push(['getClientId', k]); return 'portal-client'; };
  const svc = createDatenspende(baseCtx({ dir, cfg: { manufacturer: 'victron', datenspende: { enabled: true } } }), { client, now: () => T0 });
  const key = 'pk_live.AbC+dEf/123=456~xyz';
  const st = await svc.linkApiKey({ apiKey: `  ${key}  `, consent: true });
  assert.equal(st.clientId, 'portal-client');
  assert.deepEqual(client.calls, [['getClientId', key]], 'kein Konto, kein Haushalt, kein Client');
  await assert.rejects(svc.linkApiKey({ apiKey: 'mit leer zeichen 1234567890', consent: true }), /Format/);
  await assert.rejects(svc.linkApiKey({ apiKey: `zeile\n${'x'.repeat(20)}`, consent: true }), /Format/);
  // Danach legt die Spende nur Zähler an.
  svc.sample();
  await svc.flush();
  const kinds = [...new Set(client.calls.map((c) => c[0]))];
  assert.deepEqual(kinds, ['getClientId', 'register', 'submit']);
});

// Codex-Gegenprüfung 9d1b2057 (2× P2).
test('Spannung: Zeitstempel = Messzeit (nicht Takt), je Phase eigene Messzeit (MQTT), t0 = frühester Wert', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, SIDECAR_NAME), JSON.stringify({ apiKey: 'KEY', clientId: 'C1', meters: {}, donated: 0 }));
  let t = T0;
  const gv = { ...GV, updatedAt: T0 - 90_000, phaseAt: { l1: T0 - 90_000, l2: T0 - 90_000, l3: T0 - 90_000 }, source: 'victron_mqtt' };
  const pl = payload({ gridVoltage: gv });
  const client = fakeClient();
  const svc = createDatenspende(baseCtx({ dir, cfg: { manufacturer: 'victron', datenspende: { enabled: true } }, pl }), { client, now: () => t, random: () => 0.5 });
  svc.sample();
  // Nur L1 ändert sich; L2/L3 bleiben (älteste Phase unverändert).
  t += 10_000;
  pl.victron.gridVoltage = { ...gv, l1: 240.5, phaseAt: { ...gv.phaseAt, l1: T0 + 8_000 } };
  svc.sample();
  await svc.flush();
  const batch = client.batches[0];
  const sc = JSON.parse(fs.readFileSync(path.join(dir, SIDECAR_NAME), 'utf8'));
  const l1 = batch.filter((r) => r.meter_id === sc.meters.gridL1.id);
  assert.deepEqual(l1.map((r) => [r.timestamp, r.voltage]), [['2026-09-28T11:58:30Z', 238.2], ['2026-09-28T12:00:08Z', 240.5]]);
  const l2 = batch.filter((r) => r.meter_id === sc.meters.gridL2.id);
  assert.equal(l2.length, 1, 'L2 unverändert → einmal');
  const grid = batch.find((r) => r.meter_id === sc.meters.grid.id);
  assert.equal(grid.timestamp, '2026-09-28T12:00:00Z', 'Leistung behält den Takt-Zeitstempel');
});
