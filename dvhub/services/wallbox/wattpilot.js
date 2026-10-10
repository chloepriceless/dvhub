// services/wallbox/wattpilot.js — Fronius Wattpilot über seine lokale WebSocket-Schnittstelle.
//
// Der Wattpilot hat keine HTTP-API wie der go-e (aus dessen Firmware er stammt),
// sondern spricht nur WebSocket unter ws://<host>/ws — so wie die Wattpilot-App.
// Die Schlüssel sind dieselben wie beim go-e API v2: car (1 frei, 2 lädt,
// 3 wartet auf das Auto, 4 fertig, 5 Fehler), amp (Ladestrom A), frc
// (0 neutral, 1 aus, 2 an), nrg[11] (Leistung gesamt W), ama (höchster Strom).
//
// Anmeldung (Hash „pbkdf2"): Schlüssel = Base64(PBKDF2-SHA512(Passwort,
// Seriennummer, 100 000 Runden, 256 Byte)), davon die ersten 32 Zeichen.
// Antwort auf authRequired: sha256(token3 + token2 + sha256(token1 + Schlüssel)).
// Schreibbefehle gehen als „securedMsg" mit HMAC-SHA256 über den Schlüssel.
//
// Übernommen aus dem Projekt „mypv-übersetzer" (wattpilot.py), das so seit
// Wochen an einem echten Wattpilot läuft; Protokoll wie die Bibliothek
// joscha82/wattpilot.
//
// Eine Verbindung je Box und Passwort, für alle Teile von DVhub gemeinsam
// (Statusabfrage, EOS-Brücke, §14a, Testknopf). Sie wird beim ersten Zugriff
// geöffnet und bei Abbruch beim nächsten Zugriff neu aufgebaut.

import crypto from 'node:crypto';

const PBKDF2_ROUNDS = 100_000;
const CONNECT_TIMEOUT_MS = 8_000;
const RESPONSE_TIMEOUT_MS = 5_000;
// Der Wattpilot schickt laufend deltaStatus. Kam so lange nichts, gilt der
// Zustand als veraltet und die Verbindung wird neu aufgebaut.
const STALE_MS = 60_000;

/** Schlüssel aus Passwort und Seriennummer (Text, 32 Zeichen). */
export function wattpilotPasswordKey(password, serial) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(String(password), String(serial), PBKDF2_ROUNDS, 256, 'sha512', (err, derived) => {
      if (err) reject(err); else resolve(derived.toString('base64').slice(0, 32));
    });
  });
}

/** Antwort auf authRequired. */
export function wattpilotAuthHash(key, token1, token2, token3) {
  const hash1 = crypto.createHash('sha256').update(String(token1) + key).digest('hex');
  return crypto.createHash('sha256').update(String(token3) + String(token2) + hash1).digest('hex');
}

/** HMAC eines Schreibbefehls. */
export function wattpilotHmac(key, payload) {
  return crypto.createHmac('sha256', key).update(payload).digest('hex');
}

function defaultWebSocket() {
  return typeof globalThis.WebSocket === 'function' ? globalThis.WebSocket : null;
}

/**
 * @param {{host:string, password:string}} settings
 * @param {{WebSocketImpl?:Function, now?:()=>number}} [deps]
 */
export function createWattpilotConnection(settings, { WebSocketImpl = defaultWebSocket(), now = () => Date.now() } = {}) {
  const host = String(settings?.host || '').trim().replace(/^wss?:\/\//i, '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  const password = String(settings?.password || '');
  let ws = null;
  let connecting = null;
  let key = null;
  let serial = null;
  let authed = false;
  let lastError = null;
  let lastMessageAt = 0;
  let requestNo = 0;
  const status = {};
  const pending = new Map(); // requestId → { resolve, timer }

  function reset(error) {
    if (error) lastError = String(error).slice(0, 160);
    authed = false;
    for (const [, p] of pending) { clearTimeout(p.timer); p.resolve({ ok: false, error: lastError || 'connection closed' }); }
    pending.clear();
    const old = ws;
    ws = null;
    connecting = null;
    try { old?.close(); } catch { /* schon zu */ }
  }

  function send(obj) {
    ws.send(JSON.stringify(obj));
  }

  async function onMessage(raw) {
    let msg;
    try { msg = JSON.parse(typeof raw === 'string' ? raw : String(raw)); } catch { return; }
    lastMessageAt = now();
    switch (msg.type) {
      case 'hello':
        serial = String(msg.serial || '');
        break;
      case 'authRequired': {
        if ((msg.hash || 'pbkdf2') !== 'pbkdf2') { reset(`Anmeldeverfahren ${msg.hash} wird nicht unterstützt`); return; }
        key = await wattpilotPasswordKey(password, serial || '');
        const token3 = crypto.randomBytes(16).toString('hex');
        send({ type: 'auth', token3, hash: wattpilotAuthHash(key, msg.token1, msg.token2, token3) });
        break;
      }
      case 'authError':
        reset('Passwort abgelehnt');
        break;
      case 'authSuccess':
        authed = true;
        lastError = null;
        break;
      case 'fullStatus':
      case 'deltaStatus':
        Object.assign(status, msg.status || {});
        break;
      case 'response': {
        Object.assign(status, msg.status || {});
        const id = String(msg.requestId);
        const p = pending.get(id) || pending.get(`${id}sm`);
        if (p) {
          clearTimeout(p.timer);
          pending.delete(id); pending.delete(`${id}sm`);
          p.resolve(msg.success ? { ok: true } : { ok: false, error: msg.message || 'Wattpilot lehnt ab' });
        }
        break;
      }
      default:
        break;
    }
  }

  function connect() {
    if (!host) return Promise.resolve({ ok: false, error: 'Wattpilot: Adresse fehlt' });
    if (!password) return Promise.resolve({ ok: false, error: 'Wattpilot: Passwort fehlt' });
    if (!WebSocketImpl) return Promise.resolve({ ok: false, error: 'WebSocket nicht verfügbar (Node.js 22 nötig)' });
    if (ws && authed && now() - lastMessageAt < STALE_MS) return Promise.resolve({ ok: true });
    if (connecting) return connecting;
    if (ws) reset('keine Nachrichten mehr');
    connecting = new Promise((resolve) => {
      let settled = false;
      const done = (res) => { if (!settled) { settled = true; clearTimeout(timer); resolve(res); } };
      const timer = setTimeout(() => { reset('Zeitüberschreitung bei der Anmeldung'); done({ ok: false, error: lastError }); }, CONNECT_TIMEOUT_MS);
      timer.unref?.();
      let socket;
      try {
        socket = new WebSocketImpl(`ws://${host}/ws`);
      } catch (e) {
        reset(e?.message || e);
        done({ ok: false, error: lastError });
        return;
      }
      ws = socket;
      lastMessageAt = now();
      socket.addEventListener('message', (ev) => {
        onMessage(ev.data).then(() => { if (authed) done({ ok: true }); if (!ws) done({ ok: false, error: lastError }); })
          .catch((e) => { reset(e?.message || e); done({ ok: false, error: lastError }); });
      });
      socket.addEventListener('error', (ev) => { reset(ev?.message || ev?.error?.message || 'Verbindungsfehler'); done({ ok: false, error: lastError }); });
      socket.addEventListener('close', () => { if (ws === socket) reset(lastError || 'Verbindung geschlossen'); done({ ok: false, error: lastError || 'Verbindung geschlossen' }); });
    }).finally(() => { connecting = null; });
    return connecting;
  }

  /** Einen Wert setzen (amp, frc …); wartet auf die Bestätigung der Box. */
  async function setValue(name, value) {
    const c = await connect();
    if (!c.ok) return c;
    requestNo += 1;
    const id = `${requestNo}sm`;
    const payload = JSON.stringify({ type: 'setValue', requestId: requestNo, key: name, value });
    return new Promise((resolve) => {
      const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, error: 'Wattpilot hat nicht geantwortet' }); }, RESPONSE_TIMEOUT_MS);
      timer.unref?.();
      pending.set(id, { resolve, timer });
      try {
        send({ type: 'securedMsg', data: payload, requestId: id, hmac: wattpilotHmac(key, payload) });
      } catch (e) {
        clearTimeout(timer); pending.delete(id);
        resolve({ ok: false, error: e?.message || String(e) });
      }
    });
  }

  async function readStatus() {
    const c = await connect();
    if (!c.ok) return c;
    return { ok: true, status: { ...status }, serial };
  }

  return {
    host,
    setValue,
    readStatus,
    close: () => reset(null),
    info: () => ({ host, serial, connected: authed, lastError, lastMessageAt })
  };
}

// Eine Verbindung je Box und Passwort für alle Aufrufer.
const connections = new Map();

export function getWattpilotConnection(settings, deps) {
  const host = String(settings?.host || '').trim();
  const pwHash = crypto.createHash('sha256').update(String(settings?.password || '')).digest('hex').slice(0, 16);
  const id = `${host}|${pwHash}`;
  if (!connections.has(id)) {
    // Neue Zugangsdaten für dieselbe Box: alte Verbindung schließen.
    for (const [k, c] of connections) if (k.startsWith(`${host}|`)) { c.close(); connections.delete(k); }
    connections.set(id, createWattpilotConnection(settings, deps));
  }
  return connections.get(id);
}

/** Nur für Tests. */
export function _resetWattpilotConnections() {
  for (const c of connections.values()) c.close();
  connections.clear();
}
