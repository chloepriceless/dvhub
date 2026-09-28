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
import {
  createInstallerPortalClient,
  isAllowedPortalUrl,
  buildCompactStatus,
  SIDECAR_NAME,
} from '../services/installer-portal-client.js';

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
