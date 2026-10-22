// services/mobile-link/client.js — Referenz-Client der Geräteseite.
//
// Macht in Node genau das, was die iPhone-App macht: QR-Code einlesen,
// koppeln, sich am Relay anmelden, Handshake, verschlüsselte Anfragen und
// Live-Werte, Briefkasten abholen. Dient den Tests und als Vorlage für die App
// (ios/), außerdem als Werkzeug: scripts/mobile-link-client.mjs.

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import {
  b64u, fromB64u, keyId, relayAuthData, createDeviceHandshake, createPairDevice,
  pairRelayToken, openMailbox,
} from './crypto.js';
import { parsePairPayload } from './qr.js';
import { wrapWebSocket } from './relay-core.js';

export function defaultClientConnect(url) {
  const ws = new WebSocket(url, { handshakeTimeout: 10_000, maxPayload: 2 * 1024 * 1024 });
  ws.on('error', () => { /* close folgt */ });
  return wrapWebSocket(ws, { pingMs: 0 });
}

const enc = (obj) => b64u(Buffer.from(JSON.stringify(obj), 'utf8'));
const dec = (d) => JSON.parse(fromB64u(d).toString('utf8'));

// Kleine Nachrichten-Warteschlange über einem Socket.
function channel(sock) {
  const queue = [];
  const waiters = [];
  let closed = null;
  sock.onMessage((text) => {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    const w = waiters.shift();
    if (w) w.resolve(msg); else queue.push(msg);
  });
  sock.onClose((code, reason) => {
    closed = { code, reason: reason ? String(reason) : '' };
    for (const w of waiters.splice(0)) w.reject(Object.assign(new Error(`closed:${closed.reason || code}`), closed));
  });
  return {
    next(timeoutMs = 15_000) {
      if (queue.length) return Promise.resolve(queue.shift());
      if (closed) return Promise.reject(Object.assign(new Error(`closed:${closed.reason || closed.code}`), closed));
      return new Promise((resolve, reject) => {
        const w = { resolve: (m) => { clearTimeout(t); resolve(m); }, reject: (e) => { clearTimeout(t); reject(e); } };
        const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error('timeout')); }, timeoutMs);
        waiters.push(w);
      });
    },
    send(obj) { sock.send(JSON.stringify(obj)); },
    close() { sock.close(1000, 'bye'); },
    get closed() { return closed; },
  };
}

async function nextOfType(ch, types, timeoutMs) {
  for (;;) {
    const m = await ch.next(timeoutMs);
    if (types.includes(m.t)) return m;
  }
}

async function relayAuth(ch, authFn) {
  const c = await nextOfType(ch, ['challenge']);
  ch.send(authFn(c.n));
  const ok = await nextOfType(ch, ['ok']);
  return ok;
}

// Koppeln: QR-Inhalt → Zugangsdaten (dauerhaft in der App speichern; der
// private Schlüssel bleibt im `signer`, auf dem iPhone in der Secure Enclave).
export async function pairDevice({
  qr, signer, name = 'Testgerät', model = 'node', url = null,
  connect = defaultClientConnect, waitMs = 5 * 60_000, onWait = null,
}) {
  const p = parsePairPayload(qr);
  const target = url || p.lan[0] || p.relay;
  if (!target) throw new Error('no_route');
  const boxId = keyId(p.boxPublicRaw);
  const ch = channel(connect(target));
  try {
    await relayAuth(ch, () => ({ t: 'auth', role: 'pair', box: boxId, token: b64u(pairRelayToken(p.secret)) }));
    const hs = createPairDevice({ boxPublicRaw: p.boxPublicRaw, secret: p.secret, signer });
    ch.send({ t: 'data', d: enc(hs.hello()) });
    const p2 = dec((await nextOfType(ch, ['data'])).d);
    const { session, p3 } = hs.onP2(p2, { name, model });
    ch.send({ t: 'data', d: session.seal(p3) });
    for (;;) {
      const m = session.open((await nextOfType(ch, ['data'], waitMs)).d);
      if (m.t === 'p_wait') { onWait?.(m); continue; }
      if (m.t === 'p_denied') throw new Error('pairing_denied');
      if (m.t === 'p_ok') {
        return {
          v: 1,
          boxPub: b64u(p.boxPublicRaw),
          boxId,
          boxName: m.box?.name || p.name,
          devId: m.dev,
          name: m.name,
          perms: m.perms,
          ticket: m.ticket,
          mailboxKey: m.mailboxKey,
          relay: m.relay ?? p.relay,
          lan: p.lan,
        };
      }
    }
  } finally {
    ch.close();
  }
}

// Verbinden als gekoppeltes Gerät. Liefert eine Sitzung mit request(),
// subscribe(), Ereignissen 'live' / 'box_offline' / 'box_online' / 'close'.
export async function connectDevice({ creds, signer, url = null, connect = defaultClientConnect }) {
  const target = url || creds.lan?.[0] || creds.relay;
  if (!target) throw new Error('no_route');
  const boxPublicRaw = fromB64u(creds.boxPub, 65);
  const ch = channel(connect(target));
  const ev = new EventEmitter();
  const ok = await relayAuth(ch, (n) => ({
    t: 'auth', role: 'device', ticket: creds.ticket, pub: b64u(signer.publicRaw),
    sig: b64u(signer.sign(relayAuthData('device', n))),
  }));

  let session = null;
  let welcome = null;
  let hs = null;
  let ready = null;
  const pending = new Map();
  let mailboxWaiter = null;
  let nextId = 1;

  // Handshake starten (beim Verbinden und immer, wenn die Box wieder da ist).
  function startHandshake() {
    session = null;
    hs = createDeviceHandshake({ boxPublicRaw, signer });
    ch.send({ t: 'data', d: enc(hs.hello()) });
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { ready = null; reject(new Error('handshake_timeout')); }, 15_000);
      ready = { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } };
    });
  }

  const onMsg = (m) => {
    if (m.t === 'mbox') { mailboxWaiter?.(m); mailboxWaiter = null; return; }
    if (m.t === 'box_offline') { session = null; hs = null; ev.emit('box_offline'); return; }
    if (m.t === 'box_online') { startHandshake().then(() => ev.emit('box_online')).catch((e) => ev.emit('protocol_error', e)); return; }
    if (m.t !== 'data') return;
    try {
      if (hs) {
        const r = hs.onHs2(dec(m.d));
        hs = null;
        ch.send({ t: 'data', d: enc(r.hs3) });
        session = r.session;
        welcome = null;
        return;
      }
      if (!session) return;
      const msg = session.open(m.d);
      if (!welcome) {
        if (msg.t !== 'welcome') throw new Error('welcome_expected');
        welcome = msg;
        if (msg.ticket) creds.ticket = msg.ticket;
        ready?.resolve(msg);
        ready = null;
        return;
      }
      if (msg.t === 'res') { const p = pending.get(msg.id); pending.delete(msg.id); p?.resolve({ status: msg.s, body: msg.b }); return; }
      if (msg.t === 'live') { ev.emit('live', msg); return; }
      ev.emit('message', msg);
    } catch (e) {
      ready?.reject(e);
      ready = null;
      ev.emit('protocol_error', e);
    }
  };
  attachListener(ch, onMsg);
  if (ok.boxOnline) await startHandshake();

  return Object.assign(ev, {
    welcome: () => welcome,
    boxOnline: () => !!session,
    request(m, p, b = null, timeoutMs = 20_000) {
      if (!session) return Promise.reject(new Error('box_offline'));
      const id = String(nextId++);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { pending.delete(id); reject(new Error('timeout')); }, timeoutMs);
        pending.set(id, { resolve: (r) => { clearTimeout(t); resolve(r); } });
        ch.send({ t: 'data', d: session.seal({ t: 'req', id, m, p, ...(b != null ? { b } : {}) }) });
      });
    },
    subscribe(live = true, intervalMs = 2000) {
      if (session) ch.send({ t: 'data', d: session.seal({ t: 'sub', live, intervalMs }) });
    },
    async fetchMailbox() {
      const res = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout')), 10_000);
        mailboxWaiter = (m) => { clearTimeout(t); resolve(m); };
        ch.send({ t: 'mbox_get' });
      });
      const key = fromB64u(creds.mailboxKey, 32);
      return res.items.map((it) => ({ id: it.id, slot: it.slot || null, ts: it.ts, msg: openMailbox(key, creds.devId, it.d) }));
    },
    ackMailbox(ids) { ch.send({ t: 'mbox_ack', ids }); },
    close() { ch.close(); },
    closedInfo: () => ch.closed,
  });
}

// channel() verteilt Nachrichten an waiters/queue; für den Ereignisbetrieb
// hängen wir einen Zuhörer an, der alles bekommt.
function attachListener(ch, fn) {
  const loop = async () => {
    for (;;) {
      let m;
      try { m = await ch.next(24 * 3600_000); } catch { return; }
      fn(m);
    }
  };
  loop();
}
