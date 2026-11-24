// test/installer-portal-client.test.js — T-INSTALLER-PORTAL Pull-Pfad
//
// Der ausgehende Kopplungs-Client (services/installer-portal-client.js) wird
// gegen eine gestubte Portal-HTTP-Welt getestet: claim → Poll → Kommando-
// ausführung → Ergebnis-Report → Widerruf/Disconnect. Kein echtes Netzwerk
// (fetchImpl + execCommand injiziert), Sidecar-Echte-FS in einem tmp-Ordner.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInstallerPortalClient, isAllowedPortalUrl, buildCompactStatus, redactPortalResult, buildControlsSummary, SIDECAR_NAME, RELEASE_PENDING_NAME, buildLicenseInfo, nextReportDay } from '../services/installer-portal-client.js';

function tmpDir(withApplianceId = true) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-ipc-'));
  if (withApplianceId) fs.writeFileSync(path.join(d, 'appliance-id'), 'test-appliance-1');
  return d;
}
function ctxFor(dir, cfg = {}) {
  return {
    getDataDir: () => dir,
    getCfg: () => ({ apiToken: 't'.repeat(20), httpPort: 8080, installerPortal: { enabled: true }, ...cfg }),
    pushLog: () => {},
    getCachedRuntimeStatusPayload: () => ({ victron: { soc: 42, batteryPowerW: 111, pvTotalW: 999, alarms: null } }),
    getAppVersion: () => ({ versionLabel: 'v1.0.6' }),
    // Standard: aktive Pro-Lizenz (ohne Lizenz ist nur license_activate erlaubt — eigene Tests).
    licenseService: proLicense(),
  };
}
function proLicense(over = {}) {
  return {
    isProActive: () => over.pro !== false,
    getState: () => ({ status: over.pro === false ? 'none' : 'active', max_kwp: over.maxKwp ?? 30, system_kwp: over.systemKwp ?? 29.7, capacity_ok: true, license_kind: null }),
  };
}
// Portal-Welt als Fetch-Stub: routet /api/pair/claim, /api/poll,
// /api/command-result und zeichnet alle Aufrufe auf.
function portalStub() {
  const calls = [];
  const state = { status: 'requested', token: 'TOKEN-1', commands: [], claimCode: '123456' };
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, ...opts });
    if (url.endsWith('/api/pair/claim')) {
      if (state.status === 'none') return { status: 404, json: { ok: false, error: 'pairing_not_found' } };
      if (opts.body?.code !== state.claimCode) {
        return { status: 403, json: { ok: false, error: 'pairing_code_mismatch' } };
      }
      return { status: 200, json: { ok: true, applianceToken: state.token, status: state.status } };
    }
    if (url.endsWith('/api/poll')) {
      if (opts.headers?.['x-appliance-token'] !== state.token) {
        return { status: 401, json: { ok: false, error: 'appliance_token_invalid' } };
      }
      if (state.status === 'declined') return { status: 410, json: { ok: false, error: 'pairing_declined' } };
      // Wie im echten Portal: vor der Freigabe werden keine Kommandos ausgeliefert.
      const approved = state.status === 'approved';
      return { status: 200, json: { ok: true, approved, commands: approved ? state.commands.splice(0) : [] } };
    }
    if (url.endsWith('/api/pair/release')) {
      state.released = opts.headers?.['x-appliance-token'];
      return { status: 200, json: { ok: true } };
    }
    if (url.endsWith('/api/command-result')) {
      state.results = opts.body?.results || [];
      return { status: 200, json: { ok: true } };
    }
    return { status: 404, json: null };
  };
  return { fetchImpl, calls, state };
}

// ── URL-Validierung ──────────────────────────────────────────────────────────

test('isAllowedPortalUrl: https überall, http nur Loopback/RFC1918', () => {
  assert.ok(isAllowedPortalUrl('https://portal.example.de'));
  assert.ok(isAllowedPortalUrl('https://portal.example.de:8443'));
  assert.ok(isAllowedPortalUrl('http://localhost:8700'));
  assert.ok(isAllowedPortalUrl('http://192.168.4.20:8700'));
  assert.ok(isAllowedPortalUrl('http://10.0.0.5'));
  assert.ok(!isAllowedPortalUrl('http://portal.example.de'));   // http online → nein
  assert.ok(!isAllowedPortalUrl('http://8.8.8.8'));
  assert.ok(!isAllowedPortalUrl('ftp://portal.example.de'));
  assert.ok(!isAllowedPortalUrl('kein url'));
  assert.ok(!isAllowedPortalUrl(''));
});

// ── Claim ────────────────────────────────────────────────────────────────────

test('claim speichert Sidecar mit Token und startet Polling-Basis', async () => {
  const dir = tmpDir();
  const portal = portalStub();
  const client = createInstallerPortalClient(ctxFor(dir), { fetchImpl: portal.fetchImpl });
  const r = await client.claim({ portalUrl: 'https://portal.example.de/', pairingCode: '123456' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'requested');
  const sc = JSON.parse(fs.readFileSync(path.join(dir, SIDECAR_NAME), 'utf8'));
  assert.equal(sc.portalUrl, 'https://portal.example.de'); // trailing slash entfernt
  assert.equal(sc.applianceToken, 'TOKEN-1');
  assert.equal(sc.approved, false);
});

test('claim lehnt falschen Code und fremde URL ab', async () => {
  const dir = tmpDir();
  const portal = portalStub();
  const client = createInstallerPortalClient(ctxFor(dir), { fetchImpl: portal.fetchImpl });
  await assert.rejects(() => client.claim({ portalUrl: 'https://x.de', pairingCode: '12345' }), /pairing_code_invalid/);
  await assert.rejects(() => client.claim({ portalUrl: 'http://8.8.8.8', pairingCode: '123456' }), /portal_url_not_allowed/);
  await assert.rejects(() => client.claim({ portalUrl: 'https://x.de', pairingCode: '999999' }), /pairing_code_mismatch/);
  portal.state.status = 'none';
  await assert.rejects(() => client.claim({ portalUrl: 'https://x.de', pairingCode: '123456' }), /pairing_not_found/);
  assert.equal(client.status().paired, false);
});

// ── Poll + Kommandos ─────────────────────────────────────────────────────────

test('Poll liefert Status an das Portal; Kommandos werden ausgeführt und berichtet', async () => {
  const dir = tmpDir();
  const portal = portalStub();
  portal.state.status = 'approved';
  const executed = [];
  const client = createInstallerPortalClient(ctxFor(dir, { installerPortal: { enabled: true, allowTunnel: true } }), {
    fetchImpl: portal.fetchImpl,
    execCommand: async (cmd) => { executed.push(cmd.type); return { status: 200, json: { ok: true, echo: cmd.type } }; },
  });
  await client.claim({ portalUrl: 'https://portal.example.de', pairingCode: '123456' });
  portal.state.commands = [
    { id: 'c1', type: 'open_tunnel', args: { ttlMin: 15 } },
    { id: 'c2', type: 'updates_check' },
    { id: 'c3', type: 'quatsch' }, // Unbekanntes Kommando → ok:false, kein Crash
  ];
  const r = await client.pollOnce();
  assert.equal(r.ok, true);
  assert.equal(r.executed, 3);
  assert.deepEqual(executed, ['open_tunnel', 'updates_check']);
  const results = portal.state.results;
  assert.equal(results.find((x) => x.id === 'c1').ok, true);
  assert.equal(results.find((x) => x.id === 'c3').ok, false);
  // Status war im Poll-Payload enthalten:
  const pollCall = portal.calls.find((c) => c.url.endsWith('/api/poll'));
  assert.equal(pollCall.body.status.soc, 42);
  assert.equal(pollCall.body.status.pvTotalW, 999);
});

test('Poll ohne Freigabe (requested) führt keine Kommandos aus', async () => {
  const dir = tmpDir();
  const portal = portalStub();
  portal.state.status = 'requested';
  let execs = 0;
  const client = createInstallerPortalClient(ctxFor(dir), {
    fetchImpl: portal.fetchImpl,
    execCommand: async () => { execs++; return { status: 200, json: { ok: true } }; },
  });
  await client.claim({ portalUrl: 'https://portal.example.de', pairingCode: '123456' });
  portal.state.commands = [{ id: 'c1', type: 'close_tunnel' }];
  const r = await client.pollOnce();
  assert.equal(r.approved, false);
  assert.equal(execs, 0);
});

test('Widerruf (401) markiert die Kopplung als tot', async () => {
  const dir = tmpDir();
  const portal = portalStub();
  portal.state.status = 'approved';
  const client = createInstallerPortalClient(ctxFor(dir), { fetchImpl: portal.fetchImpl });
  await client.claim({ portalUrl: 'https://portal.example.de', pairingCode: '123456' });
  portal.state.token = 'ANDERER'; // Portal hat widerrufen
  const r = await client.pollOnce();
  assert.equal(r.revoked, true);
  const st = client.status();
  assert.equal(st.lastError, 'token_invalid');
});

test('disconnect löscht das Sidecar — Polls pausieren', async () => {
  const dir = tmpDir();
  const portal = portalStub();
  const client = createInstallerPortalClient(ctxFor(dir), { fetchImpl: portal.fetchImpl });
  await client.claim({ portalUrl: 'https://portal.example.de', pairingCode: '123456' });
  client.disconnect();
  assert.equal(client.status().paired, false);
  assert.equal(fs.existsSync(path.join(dir, SIDECAR_NAME)), false);
  const r = await client.pollOnce();
  assert.equal(r.skipped, true);
});

test('Build-Pflege: claim ohne appliance-id schlägt sauber fehl', async () => {
  const dir = tmpDir(false);
  const portal = portalStub();
  const client = createInstallerPortalClient(ctxFor(dir), { fetchImpl: portal.fetchImpl });
  await assert.rejects(() => client.claim({ portalUrl: 'https://portal.example.de', pairingCode: '123456' }), /appliance_id_missing/);
});

test('Rechte-Gate: open_tunnel ohne allowTunnel → tunnel_not_permitted (kein Loopback-Call)', async () => {
  const dir = tmpDir();
  const portal = portalStub();
  portal.state.status = 'approved';
  const ctx = ctxFor(dir); // installerPortal nicht gesetzt → allowTunnel=false
  const client = createInstallerPortalClient(ctx, { fetchImpl: portal.fetchImpl });
  await client.claim({ portalUrl: 'https://portal.example.de', pairingCode: '123456' });
  portal.state.commands = [{ id: 'c1', type: 'open_tunnel', args: { ttlMin: 30 } }];
  const r = await client.pollOnce();
  assert.equal(r.executed, 1);
  const reported = portal.state.results.find((x) => x.id === 'c1');
  assert.equal(reported.ok, false);
  assert.equal(reported.result.error, 'tunnel_not_permitted');
  // Mit Freigabe lässt das Gate durch (execCommand-Stub, kein echtes HTTP):
  const seen = [];
  const ctx2 = ctxFor(dir, { installerPortal: { enabled: true, allowTunnel: true } });
  const client2 = createInstallerPortalClient(ctx2, {
    fetchImpl: portal.fetchImpl,
    execCommand: async (cmd) => { seen.push(cmd.type); return { status: 200, json: { ok: true } }; },
  });
  await client2.claim({ portalUrl: 'https://portal.example.de', pairingCode: '123456' });
  portal.state.commands = [{ id: 'c2', type: 'open_tunnel' }];
  const r2 = await client2.pollOnce();
  assert.equal(r2.ok, true);
  assert.equal(r2.executed, 1);
  assert.deepEqual(seen, ['open_tunnel'], 'mit allowTunnel=true wird ausgeführt');
  assert.equal(portal.state.results.find((x) => x.id === 'c2').ok, true);
});

// ── Kompakt-Status ───────────────────────────────────────────────────────────

test('buildCompactStatus extrahiert die Portal-Felder aus dem Runtime-Snapshot', () => {
  const dir = tmpDir();
  const ctx = ctxFor(dir, { victron: { alarms: { pollIntervalMs: 30000 } } });
  const s = buildCompactStatus(ctx, Date.parse('2026-09-27T12:00:00Z'));
  assert.equal(s.soc, 42);
  assert.equal(s.batteryPowerW, 111);
  assert.equal(s.pvTotalW, 999);
  assert.equal(s.version, 'v1.0.6');
  assert.equal(s.alarmsActive, 0);   // alarms: null → konfiguriert=false
  assert.equal(s.emergencyStop, false);
});

// Portal 19.11.: „Netz-Sollwert –“ bei Sungrow und DVhub-MQTT — beide melden keinen Sollwert zurück
// (victron.gridSetpointW null). Dann den Wert zeigen, den DVhub zuletzt gesendet hat, und die Quelle mitgeben.
test('buildCompactStatus: ohne Rückmeldung vom Gerät der zuletzt gesendete Netz-Sollwert/Min-SoC (Quelle dvhub)', () => {
  const dir = tmpDir();
  const ctx = ctxFor(dir);
  ctx.getCachedRuntimeStatusPayload = () => ({
    victron: { soc: 8, gridSetpointW: null, minSocPct: null, alarms: null },
    schedule: { lastWrite: { gridSetpointW: { value: -40, source: 'default', at: 1 }, minSocPct: { value: 12, at: 1 } } },
  });
  const s = buildCompactStatus(ctx, Date.now());
  assert.equal(s.gridSetpointW, -40);
  assert.equal(s.gridSetpointSource, 'dvhub');
  assert.equal(s.minSocPct, 12);
  assert.equal(s.minSocSource, 'dvhub');
});

test('buildCompactStatus: Rückmeldung vom Gerät hat Vorrang; ohne beides bleibt es null', () => {
  const dir = tmpDir();
  const ctx = ctxFor(dir);
  ctx.getCachedRuntimeStatusPayload = () => ({
    victron: { gridSetpointW: 50, minSocPct: 20, alarms: null },
    schedule: { lastWrite: { gridSetpointW: { value: -40 }, minSocPct: { value: 12 } } },
  });
  let s = buildCompactStatus(ctx, Date.now());
  assert.equal(s.gridSetpointW, 50);
  assert.equal(s.gridSetpointSource, 'device');
  assert.equal(s.minSocPct, 20);
  assert.equal(s.minSocSource, 'device');
  ctx.getCachedRuntimeStatusPayload = () => ({ victron: { alarms: null }, schedule: { lastWrite: { gridSetpointW: null } } });
  s = buildCompactStatus(ctx, Date.now());
  assert.equal(s.gridSetpointW, null);
  assert.equal(s.gridSetpointSource, null);
  assert.equal(s.minSocPct, null);
  assert.equal(s.minSocSource, null);
});

// Portal 19.11.: Befehls-Ergebnisse (Fern-Support-Status) trugen das UI-Token der Box ins Portal.
test('redactPortalResult entfernt uiToken (auch verschachtelt), sonst unverändert', () => {
  const r = redactPortalResult({ ok: true, uiToken: 'a', status: { open: true, uiToken: 'b', list: [{ uiToken: 'c', x: 1 }] } });
  assert.deepEqual(r, { ok: true, status: { open: true, list: [{ x: 1 }] } });
  assert.equal(redactPortalResult(null), null);
  assert.equal(redactPortalResult('text'), 'text');
});

test('Steuerungen fürs Portal: DV, §51, Einspeisegrenze, §14a, EEBUS', () => {
  const ctx = {
    getCfg: () => ({ dvInterface: { profile: 'luox' }, dvControl: { negativePriceProtection: { enabled: true } } }),
    state: { ctrl: { forcedOff: false, dvLimitPct: 60, dvLimitUntil: 1700, negativePriceActive: true } },
    feedInLimit: { effective: () => 5000, sources: () => ({ dv: 6000, eebus_lpp: 5000 }) },
  };
  const c = buildControlsSummary(ctx, {
    p14a: {
      active: true, source: 'relay', limitW: 7560, pminW: 7560, n: 2, gzf: 0.8,
      relay: { enabled: true, level: 'high', activeWhen: 'high' },
      devices: [{ id: 'wallbox', name: 'Wallbox', kind: 'ladepunkt', powerW: 11000, control: 'ems', controllable: true, source: 'auto' }],
    },
    eebus: { enabled: true, status: 'running', grid: { connected: true }, lpc: { state: 'limited', limitW: 4200 }, lpp: { state: 'unlimited_controlled', limitW: null } },
  });
  assert.deepEqual(c.dv, { profile: 'luox', curtailed: false, limitPct: 60, until: 1700 });
  assert.deepEqual(c.negativePrice, { protection: true, active: true });
  assert.equal(c.feedInLimit.limitW, 5000);
  assert.equal(c.p14a.pminW, 7560);
  assert.deepEqual(c.p14a.relay, { level: 'high', dimmed: true });
  assert.deepEqual(c.p14a.devices, [{ kind: 'ladepunkt', name: 'Wallbox', powerW: 11000, control: 'ems', controllable: true }]);
  assert.equal(c.eebus.connected, true);
  assert.equal(buildControlsSummary({ getCfg: () => ({}) }, {}).p14a, null, 'ohne §14a-Dienst: null');
});

// ── Review-Fixes 2026-09-27 ──────────────────────────────────────────────────

test('Schalter aus: Poll ruht komplett (kein Netzverkehr, keine Kommandos)', async () => {
  const dir = tmpDir();
  const portal = portalStub();
  portal.state.status = 'approved';
  const ip = { enabled: true };
  const client = createInstallerPortalClient(ctxFor(dir, { installerPortal: ip }), { fetchImpl: portal.fetchImpl });
  await client.claim({ portalUrl: 'https://portal.example.de', pairingCode: '123456' });
  ip.enabled = false;
  const before = portal.calls.length;
  const r = await client.pollOnce();
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'disabled');
  assert.equal(portal.calls.length, before);
});

test('open_tunnel ohne allowTunnel wird abgewiesen, close/updates_check laufen', async () => {
  const dir = tmpDir();
  const portal = portalStub();
  portal.state.status = 'approved';
  const execd = [];
  const client = createInstallerPortalClient(ctxFor(dir), {
    fetchImpl: portal.fetchImpl,
    execCommand: async (c) => { execd.push(c.type); return { status: 200, json: { ok: true } }; },
  });
  await client.claim({ portalUrl: 'https://portal.example.de', pairingCode: '123456' });
  portal.state.commands = [{ id: 'a', type: 'open_tunnel' }, { id: 'b', type: 'close_tunnel' }, { id: 'c', type: 'updates_check' }];
  await client.pollOnce();
  assert.deepEqual(execd, ['close_tunnel', 'updates_check']);
  const denied = portal.state.results.find((x) => x.id === 'a');
  assert.equal(denied.ok, false);
  assert.equal(denied.result.error, 'tunnel_not_permitted');
});

test('open_tunnel mit allowTunnel wird ausgeführt', async () => {
  const dir = tmpDir();
  const portal = portalStub();
  portal.state.status = 'approved';
  const execd = [];
  const client = createInstallerPortalClient(ctxFor(dir, { installerPortal: { enabled: true, allowTunnel: true } }), {
    fetchImpl: portal.fetchImpl,
    execCommand: async (c) => { execd.push(c.type); return { status: 200, json: { ok: true } }; },
  });
  await client.claim({ portalUrl: 'https://portal.example.de', pairingCode: '123456' });
  portal.state.commands = [{ id: 'a', type: 'open_tunnel', args: { ttlMin: 30 } }];
  await client.pollOnce();
  assert.deepEqual(execd, ['open_tunnel']);
});

test('Trennen während laufendem Poll: keine Kommandos, Sidecar bleibt gelöscht', async () => {
  const dir = tmpDir();
  const portal = portalStub();
  portal.state.status = 'approved';
  let release;
  const gate = new Promise((r) => { release = r; });
  let execs = 0;
  const fetchImpl = async (url, opts) => {
    if (url.endsWith('/api/poll')) await gate; // Poll hängt im Netz
    return portal.fetchImpl(url, opts);
  };
  const client = createInstallerPortalClient(ctxFor(dir), {
    fetchImpl,
    execCommand: async () => { execs++; return { status: 200, json: { ok: true } }; },
  });
  await client.claim({ portalUrl: 'https://portal.example.de', pairingCode: '123456' });
  portal.state.commands = [{ id: 'x', type: 'close_tunnel' }];
  const running = client.pollOnce();
  client.disconnect();
  release();
  const r = await running;
  assert.equal(r.aborted, true);
  assert.equal(execs, 0);
  assert.equal(fs.existsSync(path.join(dir, SIDECAR_NAME)), false, 'Sidecar darf nicht wiederauferstehen');
  assert.equal(client.status().paired, false);
});

test('Parallel angestoßene Polls laufen nur einmal', async () => {
  const dir = tmpDir();
  const portal = portalStub();
  portal.state.status = 'approved';
  const client = createInstallerPortalClient(ctxFor(dir), { fetchImpl: portal.fetchImpl });
  await client.claim({ portalUrl: 'https://portal.example.de', pairingCode: '123456' });
  const before = portal.calls.filter((c) => c.url.endsWith('/api/poll')).length;
  const [a, b] = [client.pollOnce(), client.pollOnce()];
  assert.equal(a, b);
  await a;
  assert.equal(portal.calls.filter((c) => c.url.endsWith('/api/poll')).length - before, 1);
});

test('Nach Widerruf pollt die Anlage nicht weiter; Status meldet revoked', async () => {
  const dir = tmpDir();
  const portal = portalStub();
  portal.state.status = 'approved';
  const client = createInstallerPortalClient(ctxFor(dir), { fetchImpl: portal.fetchImpl });
  await client.claim({ portalUrl: 'https://portal.example.de', pairingCode: '123456' });
  portal.state.token = 'ANDERER';
  await client.pollOnce();
  const n = portal.calls.length;
  const r = await client.pollOnce();
  assert.equal(r.reason, 'revoked');
  assert.equal(portal.calls.length, n);
  assert.equal(client.status().revoked, true);
});

test('disconnect meldet die Trennung ans Portal (release)', async () => {
  const dir = tmpDir();
  const portal = portalStub();
  const client = createInstallerPortalClient(ctxFor(dir), { fetchImpl: portal.fetchImpl });
  await client.claim({ portalUrl: 'https://portal.example.de', pairingCode: '123456' });
  client.disconnect();
  await new Promise((r) => setImmediate(r));
  assert.equal(portal.state.released, 'TOKEN-1');
});

// 2026-10-15 (Karteileichen im Portal): Ist das Portal beim Trennen nicht
// erreichbar, blieb die Anlage dort für immer als „verbunden“ stehen. Die Box
// merkt sich die Abmeldung und wiederholt sie, bis das Portal sie bestätigt.
test('Trennen bei unerreichbarem Portal: Abmeldung wird nachgeholt', async () => {
  const dir = tmpDir();
  const portal = portalStub();
  let down = false;
  const fetchImpl = async (url, opts) => {
    if (down && url.endsWith('/api/pair/release')) throw new Error('ECONNREFUSED');
    return portal.fetchImpl(url, opts);
  };
  const client = createInstallerPortalClient(ctxFor(dir), { fetchImpl });
  await client.claim({ portalUrl: 'https://portal.example.de', pairingCode: '123456' });
  down = true;
  client.disconnect();
  await client.retryPendingRelease();
  assert.equal(portal.state.released, undefined);
  assert.equal(fs.existsSync(path.join(dir, RELEASE_PENDING_NAME)), true, 'Abmeldung bleibt vorgemerkt');
  const mode = fs.statSync(path.join(dir, RELEASE_PENDING_NAME)).mode & 0o777;
  assert.equal(mode, 0o600, 'enthält den Geräteschlüssel');
  down = false;
  const r = await client.retryPendingRelease();
  assert.equal(r.released, true);
  assert.equal(portal.state.released, 'TOKEN-1');
  assert.equal(fs.existsSync(path.join(dir, RELEASE_PENDING_NAME)), false);
});

test('Abmeldung: 401/404 vom Portal = Eintrag schon weg, Vormerkung gelöscht; 500 = später erneut', async () => {
  for (const [status, kept] of [[401, false], [404, false], [500, true]]) {
    const dir = tmpDir();
    const portal = portalStub();
    let releaseStatus = null;
    const fetchImpl = async (url, opts) => (url.endsWith('/api/pair/release') && releaseStatus
      ? { status: releaseStatus, json: { ok: false } } : portal.fetchImpl(url, opts));
    const client = createInstallerPortalClient(ctxFor(dir), { fetchImpl });
    await client.claim({ portalUrl: 'https://portal.example.de', pairingCode: '123456' });
    releaseStatus = status;
    client.disconnect();
    await client.retryPendingRelease();
    assert.equal(fs.existsSync(path.join(dir, RELEASE_PENDING_NAME)), kept, `HTTP ${status}`);
  }
});

test('buildCompactStatus meldet Not-Halt (state.ctrl) und Freeze (victron.freeze.active)', () => {
  const dir = tmpDir();
  const ctx = {
    ...ctxFor(dir),
    state: { ctrl: { discretionaryWritesPaused: true } },
    getCachedRuntimeStatusPayload: () => ({ victron: { soc: 50, freeze: { active: true, reason: 'x' } } }),
  };
  const s = buildCompactStatus(ctx, Date.now());
  assert.equal(s.emergencyStop, true);
  assert.equal(s.telemetryFrozen, true);
});

test('Loopback-Kommando nutzt einen erlaubten Host-Header, wenn allowedHosts gesetzt ist', async () => {
  const dir = tmpDir();
  const portal = portalStub();
  portal.state.status = 'approved';
  const loopCalls = [];
  const fetchImpl = async (url, opts = {}) => {
    if (url.startsWith('http://127.0.0.1:')) { loopCalls.push({ url, opts }); return { status: 200, json: { ok: true } }; }
    return portal.fetchImpl(url, opts);
  };
  const client = createInstallerPortalClient(ctxFor(dir, { allowedHosts: ['dvhub.local:8080'] }), { fetchImpl });
  await client.claim({ portalUrl: 'https://portal.example.de', pairingCode: '123456' });
  portal.state.commands = [{ id: 'z', type: 'close_tunnel' }];
  await client.pollOnce();
  assert.equal(loopCalls.length, 1);
  assert.match(loopCalls[0].url, /^http:\/\/127\.0\.0\.1:8080\/api\/support\/tunnel\/close$/);
  assert.equal(loopCalls[0].opts.headers.host, 'dvhub.local:8080');
});

test('Trennen während laufender Kopplungs-Anfrage: Antwort wird verworfen, nichts gespeichert', async () => {
  const dir = tmpDir();
  const portal = portalStub();
  let release;
  const gate = new Promise((r) => { release = r; });
  const fetchImpl = async (url, opts) => {
    if (url.endsWith('/api/pair/claim')) await gate;
    return portal.fetchImpl(url, opts);
  };
  const client = createInstallerPortalClient(ctxFor(dir), { fetchImpl });
  const pending = client.claim({ portalUrl: 'https://portal.example.de', pairingCode: '123456' });
  client.disconnect();
  release();
  await assert.rejects(pending, /pairing_cancelled/);
  assert.equal(client.status().paired, false);
  assert.equal(fs.existsSync(path.join(dir, SIDECAR_NAME)), false);
  await new Promise((r) => setImmediate(r));
  assert.equal(portal.state.released, 'TOKEN-1', 'Portal wird über die verworfene Kopplung informiert');
});

test('cancelPending während laufender Kopplungs-Anfrage: verworfen, nichts gespeichert', async () => {
  const dir = tmpDir();
  const portal = portalStub();
  let release;
  const gate = new Promise((r) => { release = r; });
  const fetchImpl = async (url, opts) => {
    if (url.endsWith('/api/pair/claim')) await gate;
    return portal.fetchImpl(url, opts);
  };
  const client = createInstallerPortalClient(ctxFor(dir), { fetchImpl });
  const pending = client.claim({ portalUrl: 'https://portal.example.de', pairingCode: '123456' });
  client.cancelPending(); // Kunde schaltet den Portal-Zugang aus
  release();
  await assert.rejects(pending, /pairing_cancelled/);
  assert.equal(client.status().paired, false);
  assert.equal(fs.existsSync(path.join(dir, SIDECAR_NAME)), false);
});

// ── Lizenz: ohne Pro nur „Lizenz einspielen“ ────────────────────────────────

test('Ohne Pro-Lizenz: Poll meldet nur die Lizenz (kein Status); Tunnel verweigert, Lizenz einspielen läuft', async () => {
  const dir = tmpDir();
  const portal = portalStub();
  portal.state.status = 'approved';
  const executed = [];
  const ctx = { ...ctxFor(dir, { installerPortal: { enabled: true, allowTunnel: true } }), licenseService: proLicense({ pro: false }) };
  const client = createInstallerPortalClient(ctx, {
    fetchImpl: portal.fetchImpl,
    execCommand: async (cmd) => { executed.push(cmd); return { status: 200, json: { ok: true } }; },
  });
  await client.claim({ portalUrl: 'https://portal.example.de', pairingCode: '123456' });
  const claimCall = portal.calls.find((c) => c.url.endsWith('/api/pair/claim'));
  assert.equal(claimCall.body.license.proActive, false, 'Kopplung ohne Lizenz ist erlaubt und meldet das');
  portal.state.commands = [
    { id: 'c1', type: 'open_tunnel', args: { ttlMin: 15 } },
    { id: 'c2', type: 'license_activate', args: { key: 'ABC-123' } },
  ];
  await client.pollOnce();
  const poll = portal.calls.find((c) => c.url.endsWith('/api/poll'));
  assert.equal(poll.body.status, null, 'ohne Lizenz keine Live-Werte');
  assert.equal(poll.body.license.proActive, false);
  assert.deepEqual(executed.map((c) => c.type), ['license_activate'], 'nur die Lizenz wird ausgeführt');
  assert.equal(executed[0].args.key, 'ABC-123');
  assert.equal(portal.state.results.find((r) => r.id === 'c1').result.error, 'license_required');
});

// 2026-10-15 (Support-Handover): Der Kill-Switch darf nie an der Lizenz hängen.
// Läuft die Lizenz bei offenem Tunnel ab, muss das Portal ihn trotzdem schließen
// können (die lokale Route /api/support/tunnel/close ist bewusst nonce-frei).
test('Ohne Pro-Lizenz: Tunnel schließen läuft trotzdem', async () => {
  const dir = tmpDir();
  const portal = portalStub();
  portal.state.status = 'approved';
  const executed = [];
  const ctx = { ...ctxFor(dir), licenseService: proLicense({ pro: false }) };
  const client = createInstallerPortalClient(ctx, {
    fetchImpl: portal.fetchImpl,
    execCommand: async (cmd) => { executed.push(cmd.type); return { status: 200, json: { ok: true } }; },
  });
  await client.claim({ portalUrl: 'https://portal.example.de', pairingCode: '123456' });
  portal.state.commands = [{ id: 'k', type: 'close_tunnel' }, { id: 'u', type: 'updates_check' }];
  await client.pollOnce();
  assert.deepEqual(executed, ['close_tunnel'], 'Schließen ja, andere Kommandos weiter nur mit Lizenz');
  assert.equal(portal.state.results.find((r) => r.id === 'u').result.error, 'license_required');
});

test('Lizenz im selben Durchlauf aktiviert → folgende Kommandos laufen', async () => {
  const dir = tmpDir();
  const portal = portalStub();
  portal.state.status = 'approved';
  let pro = false;
  const ctx = { ...ctxFor(dir), licenseService: { isProActive: () => pro, getState: () => ({ status: pro ? 'active' : 'none' }) } };
  const executed = [];
  const client = createInstallerPortalClient(ctx, {
    fetchImpl: portal.fetchImpl,
    execCommand: async (cmd) => { executed.push(cmd.type); if (cmd.type === 'license_activate') pro = true; return { status: 200, json: { ok: true } }; },
  });
  await client.claim({ portalUrl: 'https://portal.example.de', pairingCode: '123456' });
  portal.state.commands = [{ id: 'a', type: 'license_activate', args: { key: 'K' } }, { id: 'b', type: 'updates_check' }];
  await client.pollOnce();
  assert.deepEqual(executed, ['license_activate', 'updates_check']);
});

test('buildLicenseInfo: Pro, Tarif-kWp, eingetragene Größe — ohne Schlüssel', () => {
  const info = buildLicenseInfo({ licenseService: proLicense({ maxKwp: 30, systemKwp: 29.7 }) });
  assert.deepEqual(info, { proActive: true, status: 'active', kind: null, maxKwp: 30, systemKwp: 29.7, capacityOk: true });
  assert.equal(buildLicenseInfo({}), null);
});

test('buildCompactStatus: Tagesertrag heute in Euro aus den Tageskosten', () => {
  const dir = tmpDir();
  const ctx = { ...ctxFor(dir), getCachedRuntimeStatusPayload: () => ({ victron: {}, costs: { netEur: 12.345, revenueEur: 14.001, costEur: 1.656 } }) };
  const s = buildCompactStatus(ctx, Date.now());
  assert.deepEqual([s.todayNetEur, s.todayRevenueEur, s.todayCostEur], [12.35, 14, 1.66]);
});

// ── Tagesbericht ─────────────────────────────────────────────────────────────

test('nextReportDay: erstes Mal gestern, dann lückenlos, höchstens 31 Tage zurück', () => {
  assert.equal(nextReportDay(null, '2026-09-29'), '2026-09-29');
  assert.equal(nextReportDay('2026-09-29', '2026-09-29'), null);
  assert.equal(nextReportDay('2026-09-26', '2026-09-29'), '2026-09-27');
  assert.equal(nextReportDay('2026-01-01', '2026-09-29'), '2026-08-30', 'lange offline → nur die letzten 31 Tage');
  assert.equal(nextReportDay('2026-02-28', '2026-03-02'), '2026-03-01');
});

test('Tagesbericht: im Hintergrund gerechnet, beim nächsten Poll mitgeschickt, danach nicht erneut', async () => {
  const dir = tmpDir();
  const portal = portalStub();
  portal.state.status = 'approved';
  const asked = [];
  const ctx = {
    ...ctxFor(dir),
    historyApi: {
      async getSummary({ view, date }) {
        asked.push(`${view}:${date}`);
        return view === 'day'
          ? { status: 200, body: { kpis: { netEur: 4.2, exportRevenueEur: 5.1, importCostEur: 0.9, exportKwh: 60.5, pvKwh: 80 } } }
          : { status: 200, body: { kpis: { dvRevenueEur: 123.45, exportRevenueEur: 100, marketPremiumEur: 23.45, exportKwh: 1500, dvRevenueCtKwh: 8.23 } } };
      },
    },
  };
  const t = Date.parse('2026-09-30T08:00:00Z');
  const client = createInstallerPortalClient(ctx, { fetchImpl: portal.fetchImpl, now: () => t, execCommand: async () => ({ status: 200, json: { ok: true } }) });
  await client.claim({ portalUrl: 'https://portal.example.de', pairingCode: '123456' });
  await client.pollOnce();                       // stößt die Rechnung an
  await new Promise((r) => setImmediate(r));
  await client.pollOnce();                       // schickt den Bericht mit
  await client.pollOnce();                       // gemeldet → nicht erneut
  const polls = portal.calls.filter((c) => c.url.endsWith('/api/poll'));
  assert.equal(polls[0].body.dayReport, undefined);
  const rep = polls[1].body.dayReport;
  assert.equal(rep.day, '2026-09-29');
  assert.equal(rep.netEur, 4.2);
  assert.deepEqual(rep.month, { month: '2026-09', asOf: '2026-09-30T08:00:00.000Z', dvRevenueEur: 123.45, exportRevenueEur: 100, marketPremiumEur: 23.45, exportKwh: 1500, dvRevenueCtKwh: 8.23 });
  assert.equal(polls[2].body.dayReport, undefined);
  assert.deepEqual(asked, ['day:2026-09-29', 'month:2026-09-01']);
});

function reportCtx(summaries = {}) {
  const dir = tmpDir();
  const asked = [];
  return { asked, ctx: {
    ...ctxFor(dir),
    historyApi: {
      async getSummary({ view, date }) {
        asked.push(`${view}:${date}`);
        return { status: 200, body: { kpis: summaries[view] || { netEur: 1, exportRevenueEur: 1 } } };
      },
    },
  } };
}
async function pollTwice(client) {
  await client.pollOnce();
  await new Promise((r) => setImmediate(r));
  await client.pollOnce();
}

test('Zeitumstellung: 25.10.2026 23:30 (Winterzeit) meldet den 24.10. — nicht den laufenden Tag', async () => {
  const portal = portalStub();
  portal.state.status = 'approved';
  const { ctx } = reportCtx();
  const t = Date.parse('2026-10-25T22:30:00Z'); // 23:30 MEZ, Tag hatte 25 Stunden
  const client = createInstallerPortalClient(ctx, { fetchImpl: portal.fetchImpl, now: () => t, execCommand: async () => ({ status: 200, json: { ok: true } }) });
  await client.claim({ portalUrl: 'https://portal.example.de', pairingCode: '123456' });
  await pollTwice(client);
  const rep = portal.calls.filter((c) => c.url.endsWith('/api/poll')).map((c) => c.body.dayReport).find(Boolean);
  assert.equal(rep.day, '2026-10-24');
});

test('Nachgeholte ältere Tage: ohne Monatswert (der gilt nur für den neuesten Tag); unbekannt bleibt null', async () => {
  const portal = portalStub();
  portal.state.status = 'approved';
  const { ctx, asked } = reportCtx({ day: { netEur: 2.5, exportRevenueEur: null, importCostEur: undefined, exportKwh: 10, pvKwh: 12 } });
  const t = Date.parse('2026-09-30T08:00:00Z');
  const dir = ctx.getDataDir();
  fs.writeFileSync(path.join(dir, 'installer-portal-client.json'), '{}'); // wird beim claim überschrieben
  const client = createInstallerPortalClient(ctx, { fetchImpl: portal.fetchImpl, now: () => t, execCommand: async () => ({ status: 200, json: { ok: true } }) });
  await client.claim({ portalUrl: 'https://portal.example.de', pairingCode: '123456' });
  // Letzte Meldung liegt 3 Tage zurück → 27., 28. ohne Monat, 29. mit Monat
  const sc = JSON.parse(fs.readFileSync(path.join(dir, 'installer-portal-client.json'), 'utf8'));
  sc.lastDayReported = '2026-09-26';
  fs.writeFileSync(path.join(dir, 'installer-portal-client.json'), JSON.stringify(sc));
  for (let i = 0; i < 3; i++) await pollTwice(client);
  const reps = portal.calls.filter((c) => c.url.endsWith('/api/poll')).map((c) => c.body.dayReport).filter(Boolean);
  assert.deepEqual(reps.map((r) => r.day), ['2026-09-27', '2026-09-28', '2026-09-29']);
  assert.deepEqual(reps.map((r) => r.month == null), [true, true, false]);
  assert.equal(reps[0].exportRevenueEur, null, 'unbekannt ist nicht 0 €');
  assert.equal(reps[0].importCostEur, null);
  assert.ok(!asked.includes('month:2026-09-01') || asked.filter((a) => a.startsWith('month')).length === 1, 'Monat nur einmal gerechnet');
});

test('Monatswechsel offline: letzter Tag des Vormonats bekommt den (vollständigen) Monatswert', async () => {
  const portal = portalStub();
  portal.state.status = 'approved';
  const { ctx, asked } = reportCtx({ month: { dvRevenueEur: 300, exportRevenueEur: 280, exportKwh: 3000 } });
  const dir = ctx.getDataDir();
  const t = Date.parse('2026-10-03T08:00:00Z');
  const client = createInstallerPortalClient(ctx, { fetchImpl: portal.fetchImpl, now: () => t, execCommand: async () => ({ status: 200, json: { ok: true } }) });
  await client.claim({ portalUrl: 'https://portal.example.de', pairingCode: '123456' });
  const scPath = path.join(dir, 'installer-portal-client.json');
  fs.writeFileSync(scPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(scPath, 'utf8')), lastDayReported: '2026-09-29' }));
  for (let i = 0; i < 4; i++) await pollTwice(client);
  const reps = portal.calls.filter((c) => c.url.endsWith('/api/poll')).map((c) => c.body.dayReport).filter(Boolean);
  assert.deepEqual(reps.map((r) => [r.day, r.month?.month ?? null]),
    [['2026-09-30', '2026-09'], ['2026-10-01', null], ['2026-10-02', '2026-10']]);
  assert.ok(asked.includes('month:2026-09-01'));
});

test('buildCompactStatus: Netzbezug/-einspeisung und Hausverbrauch; ungültiger Zähler → null', () => {
  const dir = tmpDir();
  const ctx = { ...ctxFor(dir), getCachedRuntimeStatusPayload: () => ({ meter: { ok: true }, victron: { gridImportW: 0, gridExportW: 128, selfConsumptionW: 1314, gridSetpointW: -100 } }) };
  const s = buildCompactStatus(ctx, Date.now());
  assert.deepEqual([s.gridImportW, s.gridExportW, s.loadW, s.gridSetpointW], [0, 128, 1314, -100]);
  const bad = buildCompactStatus({ ...ctx, getCachedRuntimeStatusPayload: () => ({ meter: { ok: false }, victron: { gridImportW: 0, gridExportW: 0 } }) }, Date.now());
  assert.deepEqual([bad.gridImportW, bad.gridExportW], [null, null], 'kein gültiger Zähler ist nicht „0 W“');
});

// ── Fern-Support über das Portal (2026-10-14) ───────────────────────────────

function tunnelStub({ pub = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample dvhub-appliance-x', open = false } = {}) {
  const assigned = [];
  return {
    assigned,
    status: () => ({ provisioned: assigned.length > 0, open, expiresAt: open ? 123 : null, mode: 'service', relay: { shellPort: assigned.at(-1)?.shellPort || 0, webPort: assigned.at(-1)?.webPort || 0 }, lastError: null }),
    publicKey: () => (pub ? { pubkey: pub.split(' ').slice(0, 2).join(' '), fingerprint: 'SHA256:fp' } : null),
    assignRelayPorts: (p) => { assigned.push(p); return { ok: true, changed: true }; },
  };
}

test('Poll meldet Laufzeit und öffentlichen Relay-Schlüssel, nie den privaten', async () => {
  const dir = tmpDir();
  const portal = portalStub();
  portal.state.status = 'approved';
  const ctx = { ...ctxFor(dir, { installerPortal: { enabled: true, allowTunnel: true } }), supportTunnel: tunnelStub() };
  const client = createInstallerPortalClient(ctx, { fetchImpl: portal.fetchImpl });
  await client.claim({ portalUrl: 'https://portal.example.de', pairingCode: '123456' });
  await client.pollOnce();
  const body = portal.calls.find((c) => c.url.endsWith('/api/poll')).body;
  assert.ok(['container', 'native'].includes(body.runtime.kind));
  assert.equal(body.runtime.version, 'v1.0.6');
  assert.equal(typeof body.runtime.label, 'string');
  assert.equal(body.support.pubkey, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample');
  assert.equal(body.support.allowTunnel, true);
  assert.ok(!JSON.stringify(body).includes('PRIVATE KEY'));
});

test('open_tunnel mit Ports: erst Ports übernehmen, dann öffnen', async () => {
  const dir = tmpDir();
  const portal = portalStub();
  portal.state.status = 'approved';
  const tun = tunnelStub();
  const order = [];
  tun.assignRelayPorts = (p) => { order.push(['ports', p]); return { ok: true, changed: true }; };
  const client = createInstallerPortalClient({ ...ctxFor(dir, { installerPortal: { enabled: true, allowTunnel: true } }), supportTunnel: tun }, {
    fetchImpl: portal.fetchImpl,
    execCommand: async (cmd) => { order.push(['exec', cmd.type]); return { status: 200, json: { ok: true } }; },
  });
  await client.claim({ portalUrl: 'https://portal.example.de', pairingCode: '123456' });
  portal.state.commands = [{ id: 'c1', type: 'open_tunnel', args: { ttlMin: 60, shellPort: 49120, webPort: 49121 } }];
  await client.pollOnce();
  assert.deepEqual(order, [['ports', { shellPort: 49120, webPort: 49121 }], ['exec', 'open_tunnel']]);
  assert.equal(portal.state.results[0].ok, true);
});

test('open_tunnel mit ungültigen Ports wird abgewiesen, ohne etwas zu schreiben', async () => {
  const dir = tmpDir();
  const portal = portalStub();
  portal.state.status = 'approved';
  const tun = tunnelStub();
  const executed = [];
  const client = createInstallerPortalClient({ ...ctxFor(dir, { installerPortal: { enabled: true, allowTunnel: true } }), supportTunnel: tun }, {
    fetchImpl: portal.fetchImpl,
    execCommand: async (cmd) => { executed.push(cmd.type); return { status: 200, json: { ok: true } }; },
  });
  await client.claim({ portalUrl: 'https://portal.example.de', pairingCode: '123456' });
  portal.state.commands = [
    { id: 'a', type: 'open_tunnel', args: { shellPort: 22, webPort: 80 } },        // außerhalb des Relay-Bereichs
    { id: 'b', type: 'open_tunnel', args: { shellPort: 49120, webPort: 49120 } },  // gleich
    { id: 'c', type: 'open_tunnel', args: { shellPort: '49120; rm -rf /', webPort: 49121 } },
  ];
  await client.pollOnce();
  assert.deepEqual(executed, []);
  assert.deepEqual(tun.assigned, []);
  assert.ok(portal.state.results.every((r) => r.ok === false && r.result.error === 'invalid_ports'));
});

test('open_tunnel mit Ports ohne Kundenfreigabe: keine Ports übernommen', async () => {
  const dir = tmpDir();
  const portal = portalStub();
  portal.state.status = 'approved';
  const tun = tunnelStub();
  const client = createInstallerPortalClient({ ...ctxFor(dir), supportTunnel: tun }, { fetchImpl: portal.fetchImpl, execCommand: async () => ({ status: 200, json: { ok: true } }) });
  await client.claim({ portalUrl: 'https://portal.example.de', pairingCode: '123456' });
  portal.state.commands = [{ id: 'a', type: 'open_tunnel', args: { shellPort: 49120, webPort: 49121 } }];
  await client.pollOnce();
  assert.deepEqual(tun.assigned, []);
  assert.equal(portal.state.results[0].result.error, 'tunnel_not_permitted');
});

test('Kopplungsdatei mit Geräteschlüssel ist nur für DVhub lesbar (0600)', async () => {
  const dir = tmpDir();
  const portal = portalStub();
  const client = createInstallerPortalClient(ctxFor(dir), { fetchImpl: portal.fetchImpl });
  await client.claim({ portalUrl: 'https://portal.example.de', pairingCode: '123456' });
  assert.equal(fs.statSync(path.join(dir, SIDECAR_NAME)).mode & 0o777, 0o600);
});

// ── Portal-Steuerungs-Report: Provider, Netzzähler, Steuermodus, Topologie ────
// (Christin 2026-11-14) Bei jeder Portal-Verbindung meldet die Anlage, WIE sie
// angesteuert wird: ausgewählter Provider, genutzter Netzzähler, Steuermodus und
// — bei mehreren Wechselrichtern — Topologie + Aufteilung. Universell für alle
// Hersteller, nie Geheimnisse (keine Hosts/IPs/Tokens/Passwörter).

test('controls: Victron — Provider, Profil-Zähler, ESS-Setpoint, Einzelgerät', () => {
  const ctx = {
    getCfg: () => ({
      manufacturer: 'victron',
      victron: { host: '203.0.113.60' },
      meter: { fc: 4, address: 820, quantity: 3 },        // Profil-Zählerblock
      meterSource: { mode: 'profile', label: '' },
      controlWrite: { gridSetpointW: { enabled: true } },
      dvControl: { enabled: true },
    }),
    state: { ctrl: {} },
  };
  const c = buildControlsSummary(ctx, { victron: { gridSetpointW: -2500, soc: 55 }, meter: { ok: true } });
  assert.deepEqual(c.provider, { id: 'victron', label: 'Victron' });
  assert.equal(c.gridMeter.source, 'profile');
  assert.equal(c.gridMeter.mode, 'profile');
  assert.equal(c.gridMeter.externalConfigured, false);
  assert.equal(c.gridMeter.live, true);
  assert.equal(c.controlMode.kind, 'ess-setpoint');
  assert.equal(c.controlMode.writes, true);
  assert.equal(c.controlMode.paused, false);
  assert.equal(c.controlMode.detail.gridSetpointW, -2500);
  assert.equal(c.topology.multiDevice, false);
  assert.equal(c.topology.kind, 'single');
  assert.equal(c.topology.deviceCount, 1);
  assert.ok(!JSON.stringify(c).includes('203.0.113.60'), 'kein Host im Report');
});

test('controls: Sungrow — External EMS (Modus 3), Smart-Meter, Zwei-WR-Split', () => {
  const ctx = {
    getCfg: () => ({
      manufacturer: 'sungrow',
      victron: { host: '203.0.113.84' },
      meter: { fc: 4, address: 5000 },
      meterSource: { mode: 'profile' },
      controlWrite: { gridSetpointW: { enabled: true, emulate: 'sungrow-ems' } },
      dvControl: { enabled: true },
      sungrow: {
        controlMode: 'external', heartbeatTimeoutS: 30,
        secondInverter: {
          host: '203.0.113.83', strategyCharge: 'soc-balance', strategyDischarge: 'by-power',
          ratioMasterPct: 60, batteryCapacityWh: 9600, maxChargeW: 5000, maxDischargeW: 5000, pvKwp: 8.2,
        },
      },
    }),
    state: { ctrl: { sungrowEms: {
      controlMode: 'external', owns: true, heartbeatSupported: true, heartbeatTimeoutS: 30,
      decision: { split: { masterW: 3000, slaveW: 2000, strategy: 'soc-balance' } },
    } } },
  };
  const payload = { victron: {
    soc: 50, batteryPowerW: 5000, pvTotalW: 9000,
    sungrowMasterSocPct: 48, sungrowMasterBatteryW: 3000, sungrowMasterPvW: 5000,
    sungrowSecond: {
      online: true, aggregate: true, strategyCharge: 'soc-balance', strategyDischarge: 'by-power',
      socPct: 52, batteryPowerW: 2000, pvPowerW: 4000, bdcRatedW: 5000, runningStateText: 'Betrieb',
    },
  }, meter: { ok: true } };
  const c = buildControlsSummary(ctx, payload);
  assert.deepEqual(c.provider, { id: 'sungrow', label: 'Sungrow SH Hybrid' });
  assert.equal(c.gridMeter.source, 'profile');
  assert.equal(c.controlMode.kind, 'sungrow-ems');
  assert.equal(c.controlMode.detail.mode, 'external');
  assert.equal(c.controlMode.detail.emsModeValue, 3);
  assert.equal(c.controlMode.detail.owns, true);
  assert.equal(c.controlMode.detail.heartbeatSupported, true);
  assert.equal(c.controlMode.writes, true);
  assert.equal(c.topology.multiDevice, true);
  assert.equal(c.topology.kind, 'sungrow-dual');
  assert.equal(c.topology.deviceCount, 2);
  assert.equal(c.topology.split.active, true);
  assert.equal(c.topology.split.blocked, false);
  assert.equal(c.topology.split.strategyActive, 'soc-balance');
  assert.equal(c.topology.split.masterW, 3000);
  assert.equal(c.topology.split.slaveW, 2000);
  assert.equal(c.topology.split.ratioMasterPct, 60);
  const master = c.topology.devices.find((d) => d.role === 'master');
  const slave = c.topology.devices.find((d) => d.role === 'slave');
  assert.equal(master.socPct, 48);
  assert.equal(master.controlled, true);
  assert.equal(slave.online, true);
  assert.equal(slave.socPct, 52);
  assert.equal(slave.batteryPowerW, 2000);
  assert.equal(slave.capacityWh, 9600);
  assert.equal(slave.maxChargeW, 5000);
  assert.equal(slave.pvKwp, 8.2);
  assert.equal(slave.ratedW, 5000);
  const blob = JSON.stringify(c);
  assert.ok(!blob.includes('203.0.113.83') && !blob.includes('203.0.113.84'), 'keine WR-Hosts im Report');
});

test('controls: Sungrow Zwei-WR — Slave offline sperrt den Split (master-only-Rückfall)', () => {
  const ctx = {
    getCfg: () => ({
      manufacturer: 'sungrow', meter: { address: 1 },
      controlWrite: { gridSetpointW: { enabled: true, emulate: 'sungrow-ems' } },
      dvControl: { enabled: true },
      sungrow: { controlMode: 'forced', secondInverter: { host: '203.0.113.83', strategyCharge: 'ratio' } },
    }),
    state: { ctrl: { sungrowEms: { controlMode: 'forced', owns: true } } },   // keine decision.split
  };
  const c = buildControlsSummary(ctx, { victron: { sungrowSecond: { online: false } }, meter: { ok: true } });
  assert.equal(c.controlMode.detail.mode, 'forced');
  assert.equal(c.controlMode.detail.emsModeValue, 2);
  assert.equal(c.topology.kind, 'sungrow-dual');
  assert.equal(c.topology.multiDevice, true);
  assert.equal(c.topology.split.active, false);
  assert.equal(c.topology.split.blocked, true);
});

test('controls: Sungrow Zwei-WR beim Start (Slave online unbekannt) → NICHT blockiert', () => {
  const ctx = {
    getCfg: () => ({
      manufacturer: 'sungrow', meter: { address: 1 },
      controlWrite: { gridSetpointW: { enabled: true, emulate: 'sungrow-ems' } }, dvControl: { enabled: true },
      sungrow: { controlMode: 'external', secondInverter: { host: '203.0.113.83', strategyCharge: 'soc-balance' } },
    }),
    state: { ctrl: { sungrowEms: { controlMode: 'external', owns: true } } },
  };
  // View liefert online dreiwertig: null vor der Fehlerschwelle (reason 'starting') — kein echtes Offline.
  const c = buildControlsSummary(ctx, { victron: { sungrowSecond: { online: null, reason: 'starting' } }, meter: { ok: true } });
  assert.equal(c.topology.kind, 'sungrow-dual');
  assert.equal(c.topology.split.blocked, false);   // „unbekannt" darf nicht als offline gelten
  const slave = c.topology.devices.find((d) => d.role === 'slave');
  assert.equal(slave.online, null);
});

test('controls: Victron zweite GX (multi-gx) — Topologie + Je-Gerät-Metadaten', () => {
  const ctx = {
    getCfg: () => ({
      manufacturer: 'victron', meter: { address: 820 },
      controlWrite: { gridSetpointW: { enabled: true } }, dvControl: { enabled: true },
      multiGx: { enabled: true, host: '203.0.113.61', batteryCapacityWh: 20000, maxChargeW: 6000, maxDischargeW: 6000, minSocPct: 10 },
    }),
    state: { ctrl: {}, multiGx: { enabled: true, online: true, socPct: 44, batteryPowerW: -1500, setpointW: -1500, sharePct: 50, reason: null, mainDischargeBlocked: false } },
  };
  const c = buildControlsSummary(ctx, { victron: { soc: 40, batteryPowerW: -3000, pvTotalW: 7000 }, meter: { ok: true } });
  assert.equal(c.topology.kind, 'second-gx');
  assert.equal(c.topology.multiDevice, true);
  assert.equal(c.topology.deviceCount, 2);
  assert.equal(c.topology.split.active, true);
  assert.equal(c.topology.split.blocked, false);
  const g2 = c.topology.devices.find((d) => d.role === 'second-gx');
  assert.equal(g2.online, true);
  assert.equal(g2.socPct, 44);
  assert.equal(g2.setpointW, -1500);
  assert.equal(g2.capacityWh, 20000);
  assert.equal(g2.maxChargeW, 6000);
  assert.equal(g2.minSocPct, 10);
  assert.ok(!JSON.stringify(c).includes('203.0.113.61'), 'keine GX-Adresse im Report');
});

test('controls: Fronius — Akku-Regelung (Zero-Feed-in), Profil-Zähler', () => {
  const ctx = {
    getCfg: () => ({
      manufacturer: 'fronius', meter: { address: 40000 }, meterSource: { mode: 'profile' },
      controlWrite: { gridSetpointW: { enabled: false } },   // echtes Profil: kein Setpoint-Dialekt
      // Echtes Profil: Abregelung über feedExcessDcPv (Model-124), kein AC-Pfad.
      dvControl: { enabled: true, zeroFeedIn: { enabled: true }, feedExcessDcPv: { enabled: true }, dontFeedExcessAcPv: { enabled: false } },
    }),
    state: { ctrl: {} },
  };
  const c = buildControlsSummary(ctx, { victron: {}, meter: { ok: true } });
  assert.equal(c.provider.label, 'Fronius GEN24');
  assert.equal(c.gridMeter.source, 'profile');
  assert.equal(c.controlMode.kind, 'battery-regulation');
  assert.equal(c.controlMode.detail.zeroFeedIn, true);
  assert.equal(c.controlMode.detail.feedExcessDcPv, true);     // der echte Abregelpfad
  assert.equal(c.controlMode.detail.dontFeedExcessAcPv, false);
  assert.equal(c.controlMode.writes, true);
  assert.equal(c.controlMode.readOnly, false);
  assert.equal(c.topology.multiDevice, false);
});

test('controls: Lese-Modus (DVHUB_READ_ONLY=1) → writes=false, readOnly=true', () => {
  const prev = process.env.DVHUB_READ_ONLY;
  process.env.DVHUB_READ_ONLY = '1';
  try {
    const ctx = {
      getCfg: () => ({ manufacturer: 'victron', meter: { address: 1 }, controlWrite: { gridSetpointW: { enabled: true } }, dvControl: { enabled: true } }),
      state: { ctrl: {} },
    };
    const c = buildControlsSummary(ctx, { victron: { gridSetpointW: -1000 }, meter: { ok: true } });
    assert.equal(c.controlMode.kind, 'ess-setpoint');   // Modus bleibt sichtbar
    assert.equal(c.controlMode.readOnly, true);
    assert.equal(c.controlMode.writes, false);          // Transport sperrt alle Writes
  } finally {
    if (prev === undefined) delete process.env.DVHUB_READ_ONLY; else process.env.DVHUB_READ_ONLY = prev;
  }
});

test('controls: Deye — Akku-Regelung (Work-Mode Zero-Export), dontFeedExcessAcPv aus Objekt', () => {
  const ctx = {
    getCfg: () => ({
      manufacturer: 'deye-lv', meter: { address: 1 }, meterSource: { mode: 'profile' },
      controlWrite: { gridSetpointW: { enabled: true } },
      // dvControl-Schalter sind Objekte ({enabled, …}) — nicht nackte Booleans.
      dvControl: { enabled: true, dontFeedExcessAcPv: { enabled: true, fc: 16 } },
    }),
    state: { ctrl: {} },
  };
  const c = buildControlsSummary(ctx, { victron: {}, meter: { ok: true } });
  assert.equal(c.controlMode.kind, 'battery-regulation');
  assert.equal(c.controlMode.detail.dontFeedExcessAcPv, true);   // wäre bei === true gegen Objekt fälschlich false
  assert.equal(c.controlMode.detail.zeroFeedIn, false);
});

test('controls: bridge-mqtt — Netz über die Bridge, ESS-Setpoint, Not-Halt; keine Geheimnisse', () => {
  const ctx = {
    getCfg: () => ({
      manufacturer: 'bridge-mqtt',
      apiToken: 'SECRET-TOKEN-123456',
      luox: { password: 'hunter2-geheim' },
      // Echtes Profil: transport mqtt (kein Profil-Zähler) + gridSetpointW schreibbar.
      victron: { transport: 'mqtt' },
      meter: { fc: 4, address: 820 },     // Default-Config seedet meter — darf NICHT zu profileMeter führen
      meterSource: { mode: 'modbus', label: 'Netzzähler Keller', modbus: { host: '198.51.100.5' } },
      controlWrite: { gridSetpointW: { enabled: true } },
      dvControl: { enabled: true },
    }),
    state: { ctrl: { discretionaryWritesPaused: true } },
  };
  const c = buildControlsSummary(ctx, { victron: {}, meter: { ok: false } });
  assert.equal(c.provider.id, 'bridge-mqtt');
  assert.equal(c.provider.label, 'Universal (MQTT-Bridge)');
  assert.equal(c.gridMeter.source, 'bridge');          // transport mqtt → Netz über Bridge, nicht Profil-Zähler
  assert.equal(c.gridMeter.mode, 'modbus');            // konfigurierter Selektor (extern, noch nicht aktiv)
  assert.equal(c.gridMeter.externalConfigured, true);
  assert.equal(c.gridMeter.label, 'Netzzähler Keller');
  assert.equal(c.gridMeter.live, false);
  assert.equal(c.controlMode.kind, 'ess-setpoint');     // gridSetpointW schreibbar
  assert.equal(c.controlMode.writes, false);            // Not-Halt
  assert.equal(c.controlMode.paused, true);
  assert.equal(c.topology.multiDevice, false);
  const blob = JSON.stringify(c);
  for (const secret of ['SECRET-TOKEN-123456', 'hunter2-geheim', '198.51.100.5']) {
    assert.ok(!blob.includes(secret), `kein Geheimnis im Report: ${secret}`);
  }
});

test('controls: reine Telemetrie (nichts schreibbar) → read-only, writes=false', () => {
  const ctx = {
    getCfg: () => ({ manufacturer: 'generic-telemetry', controlWrite: {}, dvControl: { enabled: true } }),
    state: { ctrl: {} },
  };
  const c = buildControlsSummary(ctx, { victron: {}, meter: { ok: true } });
  assert.equal(c.controlMode.kind, 'read-only');
  assert.equal(c.controlMode.writes, false);
  assert.equal(c.controlMode.paused, false);
});

test('controls: Sungrow — fremdes EMS steuert (foreign aus der Fehlermeldung, nicht .code)', () => {
  const ctx = {
    getCfg: () => ({
      manufacturer: 'sungrow', meter: { address: 1 },
      controlWrite: { gridSetpointW: { enabled: true, emulate: 'sungrow-ems' } }, dvControl: { enabled: true },
      sungrow: { controlMode: 'external' },
    }),
    // So speichert der Dienst den Fehler: st.error = e.message = 'sungrow_foreign_ems_mode' (err.code wäre 'foreign_ems_mode').
    state: { ctrl: { sungrowEms: { controlMode: 'external', owns: false, error: 'sungrow_foreign_ems_mode' } } },
  };
  const c = buildControlsSummary(ctx, { victron: {}, meter: { ok: true } });
  assert.equal(c.controlMode.kind, 'sungrow-ems');
  assert.equal(c.controlMode.detail.foreign, true);
  assert.equal(c.controlMode.detail.owns, false);
  assert.equal(c.controlMode.writes, false);   // fremdes EMS → DVhub schreibt nichts
});

test('controls: Fronius mit dvControl.enabled=false → battery-regulation, writes=false', () => {
  const ctx = {
    getCfg: () => ({
      manufacturer: 'fronius', meter: { address: 1 },
      controlWrite: { gridSetpointW: { enabled: false } },
      dvControl: { enabled: false, zeroFeedIn: { enabled: true } },   // EEG-Festtarif schaltet dvControl aus
    }),
    state: { ctrl: {} },
  };
  const c = buildControlsSummary(ctx, { victron: {}, meter: { ok: true } });
  assert.equal(c.controlMode.kind, 'battery-regulation');
  assert.equal(c.controlMode.dvControl, false);
  assert.equal(c.controlMode.writes, false);   // ohne dvControl.enabled keine Akku-Regelung
});

test('controls: Sungrow Zwei-WR im Not-Halt — Split NICHT aktiv, keiner gesteuert', () => {
  const ctx = {
    getCfg: () => ({
      manufacturer: 'sungrow', meter: { address: 1 },
      controlWrite: { gridSetpointW: { enabled: true, emulate: 'sungrow-ems' } }, dvControl: { enabled: true },
      sungrow: { controlMode: 'external', secondInverter: { host: '203.0.113.83', strategyCharge: 'soc-balance' } },
    }),
    // Not-Halt aktiv; der zuletzt geschriebene Split bleibt im State klebrig stehen.
    state: { ctrl: { discretionaryWritesPaused: true, sungrowEms: {
      controlMode: 'external', owns: true,
      decision: { split: { masterW: 3000, slaveW: 2000, strategy: 'soc-balance' } } } } },
  };
  const c = buildControlsSummary(ctx, { victron: { sungrowSecond: { online: true, socPct: 55 } }, meter: { ok: true } });
  assert.equal(c.controlMode.writes, false);
  assert.equal(c.controlMode.paused, true);
  assert.equal(c.topology.split.active, false);   // trotz klebrigem decision.split
  const master = c.topology.devices.find((d) => d.role === 'master');
  const slave = c.topology.devices.find((d) => d.role === 'slave');
  assert.equal(master.controlled, false);
  assert.equal(slave.controlled, false);
});

test('controls: zweite GX — Not-Halt/Startup/Beta-Sperre/adresslos korrekt unterschieden', () => {
  const base = {
    manufacturer: 'victron', meter: { address: 1 },
    controlWrite: { gridSetpointW: { enabled: true } }, dvControl: { enabled: true },
    multiGx: { enabled: true, host: '203.0.113.61', batteryCapacityWh: 20000 },
  };
  const run = (state) => buildControlsSummary({ getCfg: () => base, state }, { victron: { soc: 40 }, meter: { ok: true } });
  // (a) Not-Halt: Dienst läuft, setpointW null, online true → zweite GX, aber nicht aktiv.
  const paused = run({ ctrl: { discretionaryWritesPaused: true }, multiGx: { enabled: true, online: true, setpointW: null, reason: 'ok' } });
  assert.equal(paused.topology.kind, 'second-gx');
  assert.equal(paused.topology.split.active, false);
  assert.equal(paused.topology.split.blocked, false);
  // (b) Startup: online schon false, aber reason 'starting' → NICHT als blockiert melden.
  const starting = run({ ctrl: {}, multiGx: { enabled: true, online: false, reason: 'starting', setpointW: null } });
  assert.equal(starting.topology.kind, 'second-gx');
  assert.equal(starting.topology.split.blocked, false);
  // (c) Wirklich offline: reason 'follower_offline' → blockiert.
  const off = run({ ctrl: {}, multiGx: { enabled: true, online: false, reason: 'follower_offline', setpointW: null } });
  assert.equal(off.topology.split.blocked, true);
  // (d) Beta-Sperre zu: Dienst schreibt enabled:false → KEINE zweite GX.
  const gated = run({ ctrl: {}, multiGx: { enabled: false, online: null, reason: 'disabled' } });
  assert.equal(gated.topology.kind, 'single');
  // (e) Adresslos: Dienst meldet enabled:true, reason 'not_configured' (host leer) → KEINE zweite GX (Phantom vermeiden).
  const noHost = buildControlsSummary(
    { getCfg: () => ({ ...base, multiGx: { ...base.multiGx, host: '' } }), state: { ctrl: {}, multiGx: { enabled: true, online: null, reason: 'not_configured' } } },
    { victron: { soc: 40 }, meter: { ok: true } });
  assert.equal(noHost.topology.kind, 'single');
  // (f) Split-Prozess: state.multiGx fehlt → Dienststatus unbekannt → Einzelgerät (bekannte Lücke).
  const worker = run({ ctrl: {} });
  assert.equal(worker.topology.kind, 'single');
});

test('controls: entfernter zweiter Sungrow-WR (Adresse gelöscht) → Einzelgerät trotz klebrigem Runtime', () => {
  const ctx = {
    getCfg: () => ({
      manufacturer: 'sungrow', meter: { address: 1 },
      controlWrite: { gridSetpointW: { enabled: true, emulate: 'sungrow-ems' } }, dvControl: { enabled: true },
      sungrow: { controlMode: 'external', secondInverter: { host: '' } },   // Adresse entfernt
    }),
    state: { ctrl: { sungrowEms: { controlMode: 'external', owns: true } } },
  };
  // Runtime-sungrowSecond steht noch mit alten Werten (klebrig) — darf NICHT zu sungrow-dual führen.
  const c = buildControlsSummary(ctx, { victron: { sungrowSecond: { online: true, socPct: 60 } }, meter: { ok: true } });
  assert.equal(c.topology.kind, 'single');
  assert.equal(c.topology.multiDevice, false);
});

test('controls: Herstellerwechsel zu Victron — liegengebliebener Sungrow-WR verdeckt NICHT die zweite GX', () => {
  const ctx = {
    getCfg: () => ({
      manufacturer: 'victron',                   // zurück auf Victron
      meter: { address: 820 },
      controlWrite: { gridSetpointW: { enabled: true } }, dvControl: { enabled: true },
      // sungrow.* bleibt beim Wechsel in der config.json stehen (nicht herstellergebunden):
      sungrow: { controlMode: 'external', secondInverter: { host: '203.0.113.83', strategyCharge: 'soc-balance' } },
      multiGx: { enabled: true, host: '203.0.113.61', batteryCapacityWh: 20000 },
    }),
    state: { ctrl: { sungrowEms: { decision: { split: { masterW: 1, slaveW: 1, strategy: 'soc-balance' } } } },
      multiGx: { enabled: true, online: true, socPct: 44, setpointW: -1500, reason: 'ok' } },
  };
  const c = buildControlsSummary(ctx, { victron: { soc: 40, sungrowSecond: { online: true, socPct: 60 } }, meter: { ok: true } });
  assert.equal(c.topology.kind, 'second-gx');   // echte zweite GX, nicht der Sungrow-Altbestand
  assert.equal(c.topology.split.active, true);
});

test('controls: Sungrow master-only — Slave läuft im Eigenverbrauch, gilt nicht als gesteuert', () => {
  const ctx = {
    getCfg: () => ({
      manufacturer: 'sungrow', meter: { address: 1 },
      controlWrite: { gridSetpointW: { enabled: true, emulate: 'sungrow-ems' } }, dvControl: { enabled: true },
      // ratioMasterPct NICHT gesetzt → wirksamer Wert ist der Laufzeit-Default 50.
      sungrow: { controlMode: 'external', secondInverter: { host: '203.0.113.83', strategyCharge: 'master-only' } },
    }),
    state: { ctrl: { sungrowEms: { controlMode: 'external', owns: true,
      decision: { split: { masterW: 4000, slaveW: 0, strategy: 'master-only' } } } } },
  };
  const c = buildControlsSummary(ctx, { victron: { sungrowSecond: { online: true, socPct: 60, strategyCharge: 'master-only' } }, meter: { ok: true } });
  assert.equal(c.topology.split.strategyActive, 'master-only');
  assert.equal(c.topology.split.ratioMasterPct, 50);   // Default, nicht null
  const slave = c.topology.devices.find((d) => d.role === 'slave');
  assert.equal(slave.online, true);
  assert.equal(slave.controlled, false);               // master-only → Slave nicht gesteuert
});

test('controls: unbekannter Hersteller fällt auf die ID zurück (universell)', () => {
  const ctx = { getCfg: () => ({ manufacturer: 'kostal-xyz', controlWrite: {}, dvControl: {} }), state: { ctrl: {} } };
  const c = buildControlsSummary(ctx, {});
  assert.deepEqual(c.provider, { id: 'kostal-xyz', label: 'kostal-xyz' });
  assert.equal(c.topology.kind, 'single');
});
