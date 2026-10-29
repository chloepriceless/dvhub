// services/mobile-link/relay-core.js — blindes Relay zwischen DVhub und
// gekoppelten Handys (Chrissi 22.10.2026).
//
// Läuft zweimal mit demselben Code:
//   - als eigener Dienst (relay-server.js: relay.dvhub.de oder selbst gehostet),
//   - eingebettet in DVhub für das Heimnetz (/api/mobile-link/ws) — das Handy
//     spricht dann dasselbe Protokoll direkt mit der Box.
//
// Das Relay kennt keine Schlüssel zum Mitlesen und hat kein Register: Die Box
// weist sich mit ihrer Signatur aus (Kanal-ID = Hash ihres Schlüssels), ein
// Gerät mit einem von der Box unterschriebenen Ticket und seiner eigenen
// Signatur, ein Handy beim Koppeln mit dem Token aus dem QR-Code. Alles liegt
// nur im Arbeitsspeicher; nach einem Neustart ist das Relay leer.
//
// Puffer („Briefkasten“): Je Gerät ein Platz für den letzten Stand (wird
// überschrieben) und wenige Ereignisse, bis das Handy sie abholt und
// quittiert — höchstens 24 h, alles verschlüsselt.
//
// Sockets sind abstrakt: { send(text), close(code, reason), onMessage(fn),
// onClose(fn) } — siehe wrapWebSocket() und createMemorySocketPair().

import crypto from 'node:crypto';
import {
  b64u, fromB64u, keyId, verifySig, relayAuthData, verifyTicket,
} from './crypto.js';

export const CLOSE = Object.freeze({
  normal: 4000,
  replaced: 4001,
  authFailed: 4002,
  notAllowed: 4003,
  boxOffline: 4004,
  limit: 4008,
  protocol: 4009,
  authTimeout: 4010,
  shutdown: 4011,
});

export const DEFAULT_LIMITS = Object.freeze({
  authTimeoutMs: 10_000,
  maxConnections: 20_000,
  // Je Quelladresse (hinter einem Proxy: X-Forwarded-For, RELAY_TRUST_PROXY).
  maxConnectionsPerRemote: 64,
  maxAllowPerBox: 32,
  maxBoxes: 10_000,
  maxDeviceConnsPerBox: 16,
  maxPairConnsPerBox: 2,
  boxFrameBytes: 1024 * 1024,
  deviceFrameBytes: 256 * 1024,
  rateWindowMs: 10_000,
  boxFramesPerWindow: 600,
  boxBytesPerWindow: 16 * 1024 * 1024,
  deviceFramesPerWindow: 200,
  deviceBytesPerWindow: 1024 * 1024,
  pairTtlMaxMs: 10 * 60_000,
  mailboxItems: 64,
  mailboxBytes: 512 * 1024,
  mailboxLatestBytes: 64 * 1024,
  mailboxTtlMs: 24 * 3600_000,
  mailboxTotalBytes: 256 * 1024 * 1024,
  maxMailboxes: 50_000,
});

// Speicher je Briefkasten bzw. Eintrag über die Nutzdaten hinaus (Map-Eintrag,
// Objekte, Strings) — zählt mit, damit viele kleine Einträge nicht unter der
// Bytegrenze durchrutschen (Fable-Review H1: ~460 B je Briefkasten gemessen).
const MAILBOX_OVERHEAD = 512;
const ITEM_OVERHEAD = 128;

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const isStr = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;

export function createRelay({
  now = Date.now,
  limits: limitOverrides = {},
  log = () => {},
  allowBox = () => true,
  name = 'dvhub-relay',
} = {}) {
  const L = { ...DEFAULT_LIMITS, ...limitOverrides };
  const boxes = new Map();      // boxId → { conn, allow:Set|null, pair, devices:Set<conn> }
  const mailboxes = new Map();  // `${boxId}/${devId}` → { latest, items, bytes }
  let mailboxTotal = 0;
  let nextCid = 1;
  let closed = false;
  const conns = new Set();
  const perRemote = new Map(); // Quelladresse → offene Verbindungen

  function boxEntry(boxId) {
    let e = boxes.get(boxId);
    if (!e) {
      e = { conn: null, allow: null, pair: null, devices: new Set(), pairs: new Set() };
      boxes.set(boxId, e);
    }
    return e;
  }

  function dropBoxIfIdle(boxId) {
    const e = boxes.get(boxId);
    if (e && !e.conn && e.devices.size === 0 && e.pairs.size === 0) boxes.delete(boxId);
  }

  // ── Briefkasten ───────────────────────────────────────────────────────────

  function mbKey(boxId, devId) { return `${boxId}/${devId}`; }

  function mbGet(boxId, devId, create) {
    const k = mbKey(boxId, devId);
    let m = mailboxes.get(k);
    if (!m && create) {
      if (mailboxes.size >= L.maxMailboxes || mailboxTotal + MAILBOX_OVERHEAD > L.mailboxTotalBytes) return null;
      m = { latest: null, items: [], bytes: MAILBOX_OVERHEAD, nextId: 1 };
      mailboxes.set(k, m);
      mailboxTotal += MAILBOX_OVERHEAD;
    }
    return m || null;
  }

  const itemCost = (it) => it.d.length + ITEM_OVERHEAD;

  function mbDropItem(m, idx) {
    const [it] = m.items.splice(idx, 1);
    m.bytes -= itemCost(it);
    mailboxTotal -= itemCost(it);
  }

  function mbSetLatest(m, entry) {
    if (m.latest) { m.bytes -= itemCost(m.latest); mailboxTotal -= itemCost(m.latest); }
    m.latest = entry;
    if (entry) { m.bytes += itemCost(entry); mailboxTotal += itemCost(entry); }
  }

  function mbClear(boxId, devId) {
    const k = mbKey(boxId, devId);
    const m = mailboxes.get(k);
    if (!m) return;
    mailboxTotal -= m.bytes;
    mailboxes.delete(k);
  }

  // Abgelaufenes entfernen — für einen Briefkasten beim Zugriff, für alle nur
  // im Minutentakt (nicht bei jedem Zugriff über alle: O(N²), Fable-Review H1).
  function mbPruneOne(k, m) {
    const cutoff = now() - L.mailboxTtlMs;
    while (m.items.length && m.items[0].ts < cutoff) mbDropItem(m, 0);
    if (m.latest && m.latest.ts < cutoff) mbSetLatest(m, null);
    if (!m.latest && m.items.length === 0) { mailboxes.delete(k); mailboxTotal -= m.bytes; m.bytes = 0; }
  }

  function mbPrune() {
    for (const [k, m] of [...mailboxes]) mbPruneOne(k, m);
  }

  function mbPut(boxId, devId, d, slot) {
    if (slot === 'latest' ? d.length > L.mailboxLatestBytes : d.length > L.mailboxBytes) return 'too_large';
    const existing = mbGet(boxId, devId, false);
    if (existing) mbPruneOne(mbKey(boxId, devId), existing);
    if (mailboxTotal + d.length + ITEM_OVERHEAD > L.mailboxTotalBytes) return 'relay_full';
    const m = mbGet(boxId, devId, true);
    if (!m) return 'relay_full';
    if (slot === 'latest') {
      mbSetLatest(m, { id: 'latest', ts: now(), d });
      return null;
    }
    // Älteste Ereignisse weichen, wenn der Platz nicht reicht.
    const cost = d.length + ITEM_OVERHEAD;
    while (m.items.length && (m.items.length >= L.mailboxItems || m.bytes + cost > L.mailboxBytes + MAILBOX_OVERHEAD)) mbDropItem(m, 0);
    if (m.bytes + cost > L.mailboxBytes + MAILBOX_OVERHEAD) return 'too_large';
    const it = { id: String(m.nextId++), ts: now(), d };
    m.items.push(it);
    m.bytes += cost;
    mailboxTotal += cost;
    return null;
  }

  const pruneTimer = setInterval(mbPrune, 60_000);
  pruneTimer.unref?.();

  // ── Verbindungen ──────────────────────────────────────────────────────────

  function send(conn, obj) {
    if (conn.closed) return;
    try { conn.sock.send(JSON.stringify(obj)); } catch { /* Socket weg */ }
  }

  function closeConn(conn, code, reason) {
    if (conn.closed) return;
    try { conn.sock.close(code, reason); } catch { /* egal */ }
    onClosed(conn);
  }

  function rateOk(conn, len) {
    const t = now();
    if (t - conn.rate.start >= L.rateWindowMs) conn.rate = { start: t, frames: 0, bytes: 0 };
    conn.rate.frames += 1;
    conn.rate.bytes += len;
    const box = conn.role === 'box';
    return conn.rate.frames <= (box ? L.boxFramesPerWindow : L.deviceFramesPerWindow)
      && conn.rate.bytes <= (box ? L.boxBytesPerWindow : L.deviceBytesPerWindow);
  }

  function openToBox(e, conn) {
    if (!e.conn) return;
    send(e.conn, { t: 'open', c: conn.cid, role: conn.role, ...(conn.devId ? { dev: conn.devId } : {}) });
  }

  function attach(sock, { remote = null } = {}) {
    if (closed) { try { sock.close(CLOSE.shutdown, 'shutdown'); } catch { /* egal */ } return null; }
    if (conns.size >= L.maxConnections) { try { sock.close(CLOSE.limit, 'relay_full'); } catch { /* egal */ } return null; }
    if (remote && (perRemote.get(remote) || 0) >= L.maxConnectionsPerRemote) {
      try { sock.close(CLOSE.limit, 'too_many_connections'); } catch { /* egal */ }
      return null;
    }
    if (remote) perRemote.set(remote, (perRemote.get(remote) || 0) + 1);
    const conn = {
      sock, remote, cid: String(nextCid++), role: null, boxId: null, devId: null,
      challenge: b64u(crypto.randomBytes(32)), closed: false,
      rate: { start: now(), frames: 0, bytes: 0 },
    };
    conns.add(conn);
    conn.authTimer = setTimeout(() => closeConn(conn, CLOSE.authTimeout, 'auth_timeout'), L.authTimeoutMs);
    conn.authTimer.unref?.();
    sock.onMessage((text) => onMessage(conn, text));
    sock.onClose(() => onClosed(conn));
    send(conn, { t: 'challenge', n: conn.challenge, relay: name, v: 1 });
    return conn;
  }

  function onClosed(conn) {
    if (conn.closed) return;
    conn.closed = true;
    clearTimeout(conn.authTimer);
    conns.delete(conn);
    if (conn.remote) {
      const n = (perRemote.get(conn.remote) || 1) - 1;
      if (n > 0) perRemote.set(conn.remote, n); else perRemote.delete(conn.remote);
    }
    if (!conn.boxId) return;
    const e = boxes.get(conn.boxId);
    if (!e) return;
    if (conn.role === 'box' && e.conn === conn) {
      e.conn = null;
      e.allow = null;
      e.pair = null;
      for (const d of e.devices) send(d, { t: 'box_offline' });
      for (const p of [...e.pairs]) closeConn(p, CLOSE.boxOffline, 'box_offline');
      log('relay_box_offline', { box: conn.boxId });
    } else if (conn.role === 'device' || conn.role === 'pair') {
      (conn.role === 'device' ? e.devices : e.pairs).delete(conn);
      if (e.conn) send(e.conn, { t: 'close', c: conn.cid });
    }
    dropBoxIfIdle(conn.boxId);
  }

  function onMessage(conn, text) {
    if (conn.closed) return;
    if (typeof text !== 'string') return closeConn(conn, CLOSE.protocol, 'text_only');
    const maxLen = conn.role === 'box' ? L.boxFrameBytes : L.deviceFrameBytes;
    if (text.length > maxLen) return closeConn(conn, CLOSE.limit, 'frame_too_large');
    if (!rateOk(conn, text.length)) return closeConn(conn, CLOSE.limit, 'rate_limited');
    let msg;
    try { msg = JSON.parse(text); } catch { return closeConn(conn, CLOSE.protocol, 'bad_json'); }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return closeConn(conn, CLOSE.protocol, 'bad_message');
    try {
      if (!conn.role) return onAuth(conn, msg);
      if (conn.role === 'box') return onBoxMessage(conn, msg);
      return onPeerMessage(conn, msg);
    } catch (err) {
      log('relay_error', { error: err?.message || String(err) });
      return closeConn(conn, CLOSE.protocol, 'bad_message');
    }
  }

  function onAuth(conn, msg) {
    if (msg.t !== 'auth') return closeConn(conn, CLOSE.protocol, 'auth_expected');
    if (msg.role === 'box') {
      let pub;
      try { pub = fromB64u(msg.pub, 65); } catch { return closeConn(conn, CLOSE.authFailed, 'auth_failed'); }
      if (!verifySig(pub, relayAuthData('box', conn.challenge), msg.sig)) return closeConn(conn, CLOSE.authFailed, 'auth_failed');
      const boxId = keyId(pub);
      if (!allowBox(boxId)) return closeConn(conn, CLOSE.notAllowed, 'box_not_allowed');
      if (!boxes.has(boxId) && boxes.size >= L.maxBoxes) return closeConn(conn, CLOSE.limit, 'relay_full');
      const e = boxEntry(boxId);
      const old = e.conn;
      conn.role = 'box';
      conn.boxId = boxId;
      clearTimeout(conn.authTimer);
      e.conn = conn;
      e.allow = null;
      e.pair = null;
      if (old) {
        // Neue Verbindung derselben Box (Neustart, Netzwechsel) gewinnt.
        old.boxId = null;
        closeConn(old, CLOSE.replaced, 'replaced');
        for (const p of [...e.pairs]) closeConn(p, CLOSE.boxOffline, 'box_offline');
      }
      send(conn, { t: 'ok', role: 'box', box: boxId });
      // Bei einer ersetzten Verbindung erst „offline“ melden: die Geräte müssen
      // mit der neuen Box-Verbindung neu handshaken (Fable-Review N4).
      for (const d of e.devices) {
        if (old) send(d, { t: 'box_offline' });
        openToBox(e, d);
        send(d, { t: 'box_online' });
      }
      log('relay_box_online', { box: boxId });
      return;
    }
    if (msg.role === 'device') {
      const tk = verifyTicket(msg.ticket, Math.floor(now() / 1000));
      let pub;
      try { pub = fromB64u(msg.pub, 65); } catch { return closeConn(conn, CLOSE.authFailed, 'auth_failed'); }
      if (!tk || keyId(pub) !== tk.devId) return closeConn(conn, CLOSE.authFailed, 'auth_failed');
      if (!verifySig(pub, relayAuthData('device', conn.challenge), msg.sig)) return closeConn(conn, CLOSE.authFailed, 'auth_failed');
      if (!allowBox(tk.boxId)) return closeConn(conn, CLOSE.notAllowed, 'box_not_allowed');
      const existing = boxes.get(tk.boxId);
      if (existing?.allow && !existing.allow.has(tk.devId)) return closeConn(conn, CLOSE.notAllowed, 'device_not_allowed');
      if (!existing && boxes.size >= L.maxBoxes) return closeConn(conn, CLOSE.limit, 'relay_full');
      const e = boxEntry(tk.boxId);
      if (e.devices.size >= L.maxDeviceConnsPerBox) return closeConn(conn, CLOSE.limit, 'too_many_devices');
      conn.role = 'device';
      conn.boxId = tk.boxId;
      conn.devId = tk.devId;
      clearTimeout(conn.authTimer);
      e.devices.add(conn);
      send(conn, { t: 'ok', role: 'device', box: tk.boxId, boxOnline: !!e.conn });
      openToBox(e, conn);
      return;
    }
    if (msg.role === 'pair') {
      const e = isStr(msg.box, 64) ? boxes.get(msg.box) : null;
      const p = e?.pair;
      if (!e?.conn || !p || p.exp <= now()) return closeConn(conn, CLOSE.authFailed, 'pairing_not_open');
      let tokenHash;
      try { tokenHash = b64u(crypto.createHash('sha256').update(fromB64u(msg.token, 32)).digest()); } catch { return closeConn(conn, CLOSE.authFailed, 'auth_failed'); }
      if (!safeEqual(tokenHash, p.h)) return closeConn(conn, CLOSE.authFailed, 'auth_failed');
      if (e.pairs.size >= L.maxPairConnsPerBox) return closeConn(conn, CLOSE.limit, 'too_many_pairings');
      e.pair = null; // nur einmal verwendbar
      conn.role = 'pair';
      conn.boxId = msg.box;
      clearTimeout(conn.authTimer);
      e.pairs.add(conn);
      send(conn, { t: 'ok', role: 'pair', box: msg.box, boxOnline: true });
      openToBox(e, conn);
      return;
    }
    return closeConn(conn, CLOSE.authFailed, 'unknown_role');
  }

  function peerOf(e, cid) {
    for (const d of e.devices) if (d.cid === cid) return d;
    for (const p of e.pairs) if (p.cid === cid) return p;
    return null;
  }

  function onBoxMessage(conn, msg) {
    const e = boxes.get(conn.boxId);
    if (!e || e.conn !== conn) return closeConn(conn, CLOSE.replaced, 'replaced');
    switch (msg.t) {
      case 'data': {
        const peer = isStr(msg.c, 32) ? peerOf(e, msg.c) : null;
        if (peer && isStr(msg.d, L.boxFrameBytes)) send(peer, { t: 'data', d: msg.d });
        return;
      }
      case 'close': {
        const peer = isStr(msg.c, 32) ? peerOf(e, msg.c) : null;
        if (peer) closeConn(peer, CLOSE.normal, isStr(msg.reason, 64) ? msg.reason : 'closed_by_box');
        return;
      }
      case 'allow': {
        if (!Array.isArray(msg.devs) || msg.devs.length > L.maxAllowPerBox || !msg.devs.every((d) => isStr(d, 64))) {
          return closeConn(conn, CLOSE.protocol, 'bad_allow');
        }
        e.allow = new Set(msg.devs);
        for (const d of [...e.devices]) if (!e.allow.has(d.devId)) closeConn(d, CLOSE.notAllowed, 'device_not_allowed');
        for (const k of [...mailboxes.keys()]) {
          const [b, dev] = k.split('/');
          if (b === conn.boxId && !e.allow.has(dev)) mbClear(b, dev);
        }
        return;
      }
      case 'pair_open': {
        // Relative Laufzeit: die Uhr der Box (Pi ohne RTC vor dem NTP-Abgleich)
        // spielt keine Rolle (Fable-Review M1). Fehler trennen die Box nicht.
        const ttl = Number(msg.ttlMs);
        if (!isStr(msg.h, 64) || !Number.isFinite(ttl) || ttl <= 0) return send(conn, { t: 'error', e: 'bad_pair_open' });
        e.pair = { h: msg.h, exp: now() + Math.min(ttl, L.pairTtlMaxMs) };
        return;
      }
      case 'pair_close':
        e.pair = null;
        return;
      case 'mbox_put': {
        if (!isStr(msg.dev, 64) || !isStr(msg.d, L.mailboxBytes)) return;
        // Nur für Geräte auf der Freigabeliste — ohne Liste gar nicht.
        if (!e.allow || !e.allow.has(msg.dev)) return;
        const err = mbPut(conn.boxId, msg.dev, msg.d, msg.slot === 'latest' ? 'latest' : null);
        if (err) send(conn, { t: 'error', e: err, dev: msg.dev });
        return;
      }
      case 'mbox_clear':
        if (isStr(msg.dev, 64)) mbClear(conn.boxId, msg.dev);
        return;
      case 'ping':
        send(conn, { t: 'pong' });
        return;
      default:
        return closeConn(conn, CLOSE.protocol, 'unknown_type');
    }
  }

  function onPeerMessage(conn, msg) {
    const e = boxes.get(conn.boxId);
    switch (msg.t) {
      case 'data':
        if (!isStr(msg.d, L.deviceFrameBytes)) return closeConn(conn, CLOSE.protocol, 'bad_data');
        if (!e?.conn) return send(conn, { t: 'error', e: 'box_offline' });
        send(e.conn, { t: 'data', c: conn.cid, d: msg.d });
        return;
      case 'mbox_get': {
        if (conn.role !== 'device') return closeConn(conn, CLOSE.protocol, 'unknown_type');
        const k = mbKey(conn.boxId, conn.devId);
        if (mailboxes.has(k)) mbPruneOne(k, mailboxes.get(k));
        const m = mbGet(conn.boxId, conn.devId, false);
        const items = m ? [...(m.latest ? [{ ...m.latest, slot: 'latest' }] : []), ...m.items] : [];
        send(conn, { t: 'mbox', items: items.map(({ id, ts, d, slot }) => ({ id, ts, d, ...(slot ? { slot } : {}) })) });
        return;
      }
      case 'mbox_ack': {
        if (conn.role !== 'device' || !Array.isArray(msg.ids)) return closeConn(conn, CLOSE.protocol, 'bad_ack');
        const m = mbGet(conn.boxId, conn.devId, false);
        if (!m) return;
        const ids = new Set(msg.ids.map(String));
        for (let i = m.items.length - 1; i >= 0; i--) if (ids.has(m.items[i].id)) mbDropItem(m, i);
        if (!m.latest && !m.items.length) mbClear(conn.boxId, conn.devId);
        return;
      }
      case 'ping':
        send(conn, { t: 'pong' });
        return;
      default:
        return closeConn(conn, CLOSE.protocol, 'unknown_type');
    }
  }

  return {
    attach,
    stats() {
      let online = 0;
      let devices = 0;
      for (const e of boxes.values()) { if (e.conn) online++; devices += e.devices.size; }
      return { boxesOnline: online, deviceConnections: devices, mailboxes: mailboxes.size, mailboxBytes: mailboxTotal, connections: conns.size };
    },
    close() {
      closed = true;
      clearInterval(pruneTimer);
      for (const c of [...conns]) closeConn(c, CLOSE.shutdown, 'shutdown');
      mailboxes.clear();
      mailboxTotal = 0;
    },
  };
}

// Adapter für eine `ws`-Verbindung (Server- oder Client-Seite). Pings halten
// NAT-Zuordnungen offen und erkennen tote Gegenstellen.
// Höchstens so viel darf je Verbindung unterwegs sein; wer nicht liest, wird
// getrennt — sonst füllt ein langsamer Empfänger den Speicher (Codex R2 P1).
export const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

export function wrapWebSocket(ws, { pingMs = 25_000, maxBuffered = MAX_BUFFERED_BYTES } = {}) {
  let alive = true;
  const timer = pingMs > 0 ? setInterval(() => {
    if (!alive) { try { ws.terminate(); } catch { /* egal */ } return; }
    alive = false;
    try { ws.ping(); } catch { /* egal */ }
  }, pingMs) : null;
  timer?.unref?.();
  ws.on('pong', () => { alive = true; });
  ws.on('close', () => clearInterval(timer));
  // Kaputte Rahmen, zu große Nachrichten, Abbrüche: `ws` meldet sie als
  // 'error'. Ohne Zuhörer wäre das eine unbehandelte Ausnahme und beendete den
  // ganzen Prozess (Relay bzw. DVhub) — so wird nur diese Verbindung getrennt.
  ws.on('error', () => { try { ws.terminate(); } catch { /* egal */ } });
  return {
    send: (text) => {
      if (ws.readyState !== 1) return;
      if (ws.bufferedAmount > maxBuffered) { try { ws.terminate(); } catch { /* egal */ } return; }
      ws.send(text);
    },
    close: (code, reason) => { try { ws.close(code, reason); } catch { /* egal */ } },
    onMessage: (fn) => ws.on('message', (data, isBinary) => fn(isBinary ? null : data.toString('utf8'))),
    onClose: (fn) => ws.on('close', fn),
  };
}

// Zwei verbundene Sockets im selben Prozess (eingebettetes Relay ↔ Box-Agent).
export function createMemorySocketPair() {
  function side() {
    return { msg: [], close: [], peer: null, closed: false };
  }
  const a = side();
  const b = side();
  a.peer = b;
  b.peer = a;
  function api(s) {
    return {
      send(text) {
        if (s.closed) return;
        const peer = s.peer;
        queueMicrotask(() => { if (!peer.closed) for (const fn of peer.msg) fn(text); });
      },
      close() {
        if (s.closed) return;
        s.closed = true;
        s.peer.closed = true;
        queueMicrotask(() => {
          for (const fn of s.close) fn();
          for (const fn of s.peer.close) fn();
        });
      },
      onMessage(fn) { s.msg.push(fn); },
      onClose(fn) { s.close.push(fn); },
    };
  }
  return [api(a), api(b)];
}
