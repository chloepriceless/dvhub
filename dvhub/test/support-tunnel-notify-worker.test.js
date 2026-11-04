// test/support-tunnel-notify-worker.test.js — Benachrichtigungen des
// Fern-Supports im Worker-Betrieb (Codex-Prüfung release/1.0.9 gegen 97f75453, P2).
//
// Mit DVHUB_ENABLE_RUNTIME_WORKER=1 laufen Tunnel-Anfragen und damit
// notifyTunnel im Web-Prozess; der Benachrichtigungsdienst startet aber nur im
// Runtime-Prozess (server.js notificationService.start()). Ohne Weitergabe
// erreichte den Kunden keine Meldung zu Token-, Kopplungs- und
// Sicherheitsänderungen — und auch keine zum Öffnen/Schließen des Tunnels.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createSupportTunnel } from '../services/support-tunnel.js';
import { validateRuntimeCommand } from '../runtime-commands.js';
import { createRuntimeCommandClient, RUNTIME_MESSAGE_TYPES } from '../runtime-worker-protocol.js';
import { createDirectNotifier } from '../services/notifications/direct-relay.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tunDeps = { inContainer: false, unitMode: () => false, setTimeout: () => ({ unref() {} }), clearTimeout: () => {} };

test('Tunnel-Meldungen gehen über ctx.notifyDirect, wenn vorhanden (Web-Prozess ohne gestarteten Dienst)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-sup-notify-'));
  try {
    const direct = [];
    const local = [];
    const ctx = {
      getDataDir: () => dir, getCfg: () => ({}), pushLog: () => {},
      // Im Web-Prozess erzeugt, aber nie gestartet: keine Kanäle.
      notificationService: { sendDirect: async (m) => { local.push(m); return { sent: 0 }; } },
      notifyDirect: async (m) => { direct.push(m); return { sent: 1 }; },
    };
    const tun = createSupportTunnel(ctx, tunDeps);
    tun.recordAction({ method: 'POST', route: '/api/admin/token/rotate', status: 200, kind: 'token', label: 'API-Token oder Zugangsschlüssel' });
    assert.equal(direct.length, 1);
    assert.equal(local.length, 0);
    assert.equal(direct[0].event, 'support_tunnel');
    assert.match(direct[0].title, /Fern-Support: API-Token/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('notify_direct: Befehl geprüft (Texte begrenzt, Stufe bekannt)', () => {
  const ok = validateRuntimeCommand({ type: 'notify_direct', payload: { event: 'support_tunnel', level: 'warning', title: 'T', body: 'B' } });
  assert.equal(ok.ok, true, ok.error);
  for (const payload of [
    { title: 1, body: 'B' },
    { title: 'T', body: 'B', level: 'egal' },
    { title: 'x'.repeat(300), body: 'B' },
    { title: 'T', body: 'x'.repeat(5000) },
  ]) {
    assert.equal(validateRuntimeCommand({ type: 'notify_direct', payload }).ok, false, JSON.stringify(payload).slice(0, 80));
  }
});

test('createDirectNotifier: Runtime-Prozess sendet selbst, Web-Prozess gibt an den Worker', async () => {
  const sent = [];
  const runtime = createDirectNotifier({ isRuntimeProcess: true, getService: () => ({ sendDirect: async (m) => { sent.push(m); return { sent: 2 }; } }) });
  assert.deepEqual(await runtime({ event: 'e', level: 'info', title: 'T', body: 'B' }), { sent: 2 });
  assert.equal(sent.length, 1);
  const commands = [];
  const web = createDirectNotifier({
    isRuntimeProcess: false,
    getService: () => { throw new Error('Web-Prozess darf den Dienst nicht nutzen'); },
    sendCommand: async (type, payload) => { commands.push({ type, payload }); return { ok: true, result: { queued: true } }; },
  });
  const r = await web({ event: 'support_tunnel', level: 'warning', title: 'T', body: 'B' });
  assert.deepEqual(commands, [{ type: 'notify_direct', payload: { event: 'support_tunnel', level: 'warning', title: 'T', body: 'B' } }]);
  assert.equal(r.queued, true);
  // Worker nicht da: kein Wurf, Fehler im Ergebnis.
  const down = createDirectNotifier({ isRuntimeProcess: false, getService: () => null, sendCommand: async () => ({ ok: false, error: 'runtime_worker_unavailable' }) });
  assert.deepEqual(await down({ title: 'T', body: 'B' }), { sent: 0, error: 'runtime_worker_unavailable' });
});

test('Web-Prozess → IPC → echter Runtime-Kindprozess sendet die Meldung', async () => {
  const worker = fork(path.join(here, 'fixtures', 'notify-direct-runtime-worker.mjs'), [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  try {
    const client = createRuntimeCommandClient({ getWorker: () => worker, timeoutMs: 5_000 });
    const notified = [];
    await new Promise((resolve, reject) => {
      worker.on('message', (m) => {
        if (client.handleMessage(m)) return;
        if (m?.type === RUNTIME_MESSAGE_TYPES.RUNTIME_READY) resolve();
        if (m?.type === 'test_notified') notified.push(m.msg);
      });
      worker.on('error', reject);
    });
    const notify = createDirectNotifier({ isRuntimeProcess: false, getService: () => null, sendCommand: (t, p) => client.send(t, p) });
    const r = await notify({ event: 'support_tunnel', level: 'warning', title: 'Fern-Support: Kopplung geändert', body: 'Über den Support-Tunnel geändert: /api/eebus/trust.' });
    assert.equal(r.queued, true, JSON.stringify(r));
    for (let i = 0; i < 50 && !notified.length; i++) await new Promise((res) => setTimeout(res, 20));
    assert.equal(notified.length, 1);
    assert.equal(notified[0].title, 'Fern-Support: Kopplung geändert');
    assert.equal(notified[0].event, 'support_tunnel');
  } finally { worker.kill(); }
});
