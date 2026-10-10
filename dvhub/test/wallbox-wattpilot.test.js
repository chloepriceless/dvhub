// Fronius Wattpilot (services/wallbox/wattpilot.js + Adapter): Anmeldung,
// Status und Schreibbefehle gegen einen nachgebauten Wattpilot, der das
// Protokoll prüft wie die echte Box (Passwort-Hash, HMAC je Befehl).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  wattpilotPasswordKey, wattpilotAuthHash, wattpilotHmac,
  createWattpilotConnection, _resetWattpilotConnections
} from '../services/wallbox/wattpilot.js';
import { createWattpilotAdapter } from '../services/wallbox/adapters.js';

const PASSWORD = 'geheimesPasswort123';
const SERIAL = '91234567';

// Referenzwerte aus der Python-Fassung (mypv-übersetzer/wattpilot.py), die an
// einem echten Wattpilot läuft — gleiche Eingaben, gleiche Ergebnisse.
test('Schlüssel und Anmelde-Hash wie die erprobte Python-Fassung', async () => {
  const key = await wattpilotPasswordKey(PASSWORD, SERIAL);
  assert.equal(key.length, 32);
  const reference = crypto.pbkdf2Sync(PASSWORD, SERIAL, 100000, 256, 'sha512').toString('base64').slice(0, 32);
  assert.equal(key, reference);
  const hash1 = crypto.createHash('sha256').update('t1' + key).digest('hex');
  assert.equal(wattpilotAuthHash(key, 't1', 't2', 't3'), crypto.createHash('sha256').update('t3' + 't2' + hash1).digest('hex'));
});

/** Nachgebauter Wattpilot hinter einer WebSocket-Klasse (ohne Netz). */
function fakeWattpilot({ password = PASSWORD, status = {} } = {}) {
  const box = { status: { car: 1, amp: 16, frc: 0, ama: 16, nrg: Array(16).fill(0), ...status }, received: [], sockets: 0, key: null };
  class FakeSocket {
    constructor(url) {
      box.url = url;
      box.sockets += 1;
      this.listeners = {};
      setImmediate(async () => {
        box.key = await wattpilotPasswordKey(password, SERIAL);
        this.emit({ type: 'hello', serial: SERIAL });
        this.token1 = 'tok1'; this.token2 = 'tok2';
        this.emit({ type: 'authRequired', hash: 'pbkdf2', token1: this.token1, token2: this.token2 });
      });
    }
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
    emit(msg) { for (const fn of this.listeners.message || []) fn({ data: JSON.stringify(msg) }); }
    close() { this.closed = true; }
    send(raw) {
      const msg = JSON.parse(raw);
      box.received.push(msg);
      if (msg.type === 'auth') {
        const ok = msg.hash === wattpilotAuthHash(box.key, this.token1, this.token2, msg.token3);
        this.emit(ok ? { type: 'authSuccess' } : { type: 'authError' });
        if (ok) this.emit({ type: 'fullStatus', status: box.status });
        return;
      }
      if (msg.type === 'securedMsg') {
        const signed = msg.hmac === wattpilotHmac(box.key, msg.data);
        const inner = JSON.parse(msg.data);
        if (signed && inner.type === 'setValue') box.status[inner.key] = inner.value;
        this.emit({ type: 'response', requestId: msg.requestId, success: signed, message: signed ? undefined : 'bad hmac', status: { [inner.key]: box.status[inner.key] } });
      }
    }
  }
  return { box, FakeSocket };
}

test('Status nach Anmeldung: Auto lädt, Leistung, Strom', async () => {
  _resetWattpilotConnections();
  const { box, FakeSocket } = fakeWattpilot({ status: { car: 2, amp: 10, nrg: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6900, 0, 0, 0, 0] } });
  const adapter = createWattpilotAdapter(() => ({ host: '192.0.2.10', password: PASSWORD }), { WebSocketImpl: FakeSocket });
  const st = await adapter.status();
  assert.equal(st.ok, true);
  assert.equal(box.url, 'ws://192.0.2.10/ws');
  assert.equal(st.connected, true);
  assert.equal(st.charging, true);
  assert.equal(st.powerW, 6900);
  assert.equal(st.currentA, 10);
  assert.equal(st.raw.serial, SERIAL);
});

test('Laden: Strom (auf die Box-Grenze begrenzt), dann frc=2 — signiert; Stopp und Freigabe', async () => {
  _resetWattpilotConnections();
  const { box, FakeSocket } = fakeWattpilot({ status: { ama: 16 } });
  const adapter = createWattpilotAdapter(() => ({ host: '192.0.2.11', password: PASSWORD }), { WebSocketImpl: FakeSocket });
  assert.deepEqual(await adapter.charge(20.7), { ok: true });
  assert.equal(box.status.amp, 16, 'nie über ama');
  assert.equal(box.status.frc, 2);
  assert.deepEqual(await adapter.stop(), { ok: true });
  assert.equal(box.status.frc, 1);
  assert.deepEqual(await adapter.release(), { ok: true });
  assert.equal(box.status.frc, 0);
  assert.equal(box.sockets, 1, 'eine Verbindung für alle Befehle');
  const secured = box.received.filter((m) => m.type === 'securedMsg');
  assert.equal(secured.length, 4);
  assert.ok(secured.every((m) => /^[0-9a-f]{64}$/.test(m.hmac)));
});

test('falsches Passwort: klare Fehlermeldung, kein Absturz', async () => {
  _resetWattpilotConnections();
  const { FakeSocket } = fakeWattpilot({ password: 'anderes' });
  const conn = createWattpilotConnection({ host: '192.0.2.12', password: PASSWORD }, { WebSocketImpl: FakeSocket });
  const res = await conn.readStatus();
  assert.equal(res.ok, false);
  assert.match(res.error, /Passwort abgelehnt/);
  conn.close();
});

test('ohne Adresse oder Passwort: nicht eingerichtet', async () => {
  const adapter = createWattpilotAdapter(() => ({ host: '', password: '' }));
  assert.equal(adapter.isConfigured(), false);
  const st = await adapter.status();
  assert.equal(st.ok, false);
});
