// services/mobile-link/agent.js — Handy-Kopplung auf der Box (Chrissi 22.10.2026).
//
// Die Box hält zwei Wege offen, über die gekoppelte Handys sie erreichen:
//   - das eingebettete Relay im eigenen Webserver (/api/mobile-link/ws) fürs
//     Heimnetz,
//   - eine ausgehende Verbindung zum eingestellten Relay (Standard
//     relay.dvhub.de, selbst hostbar) für unterwegs — nur solange ein Gerät
//     gekoppelt ist oder gerade gekoppelt wird.
// Auf beiden Wegen spricht das Handy dasselbe Protokoll; die Inhalte sind Ende
// zu Ende verschlüsselt (crypto.js), das Relay leitet nur weiter.
//
// Kopplung: Die Oberfläche erzeugt einen QR-Code mit Einmal-Geheimnis (5 min,
// genau einmal verwendbar). Das Handy meldet sich damit, die Oberfläche zeigt
// Name und Modell, erst nach „Freigeben“ wird das Gerät eingetragen.
//
// Persistenz: ${DATA_DIR}/mobile-link.json (0600) — Schlüssel der Box und die
// gekoppelten Geräte. config.json enthält nur die Schalter (mobileLink.*).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import {
  b64u, fromB64u, generateIdentity, signerFromPrivateKey, relayAuthData,
  issueTicket, createBoxHandshake, createPairBox, pairRelayToken, pairTokenHash,
  sealMailbox, keyId,
} from './crypto.js';
import { createRelay, createMemorySocketPair, wrapWebSocket } from './relay-core.js';
import { checkRequest, normalizePerms } from './permissions.js';
import { buildPairPayload, qrSvg } from './qr.js';
import { buildCompactStatus } from '../installer-portal-client.js';

export const SIDECAR_NAME = 'mobile-link.json';
export const DEFAULT_RELAY_URL = 'wss://relay.dvhub.de/v1/ws';
export const LAN_WS_PATH = '/api/mobile-link/ws';
export const PAIRING_TTL_MS = 5 * 60_000;
export const TICKET_TTL_SEC = 365 * 86400;
export const MAX_DEVICES = 10;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const LIVE_MIN_MS = 1000;
const LIVE_DEFAULT_MS = 2000;
const MAILBOX_LATEST_MS = 60_000;
const RECONCILE_MS = 30_000;
const MAX_RESPONSE_CHARS = 900 * 1024;
// Rahmengrenze des Relays für Nachrichten der Box (relay-core boxFrameBytes),
// mit Luft für die Hülle {"t":"data","c":…,"d":…}.
const MAX_FRAME_CHARS = 1024 * 1024 - 1024;
const MAX_REQUEST_BODY_CHARS = 64 * 1024;
const MAX_PARALLEL_REQUESTS = 4;

function isPrivateHost(h) {
  const host = h.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1') return true;
  if (/\.local$/.test(host)) return true;
  const parts = host.split('.').map(Number);
  if (parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    if (parts[0] === 127 || parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
  }
  return /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host);
}

// „relay.dvhub.de“, „wss://relay.example.org“ oder eine volle URL → wss-URL mit
// Pfad /v1/ws. ws:// (ohne TLS) nur zu Adressen im eigenen Netz. null = ungültig.
export function normalizeRelayUrl(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  if (!/^[a-z]+:\/\//i.test(s)) s = `wss://${s}`;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.username || u.password || u.hash) return null;
  if (u.protocol === 'https:') u.protocol = 'wss:';
  else if (u.protocol === 'http:') u.protocol = 'ws:';
  if (u.protocol !== 'wss:' && u.protocol !== 'ws:') return null;
  if (u.protocol === 'ws:' && !isPrivateHost(u.hostname)) return null;
  if (u.pathname === '/' || u.pathname === '') u.pathname = '/v1/ws';
  u.search = '';
  return u.toString();
}

// Host, unter dem die Oberfläche gerade erreichbar ist („192.168.1.60:8080“).
// Nur Name/Adresse und Port — sonst nichts übernehmen.
export function sanitizeLanHost(raw) {
  const s = String(raw ?? '').trim();
  if (!s || s.length > 255 || !/^[A-Za-z0-9.\-:[\]]+$/.test(s)) return null;
  try {
    const u = new URL(`http://${s}`);
    return u.host || null;
  } catch { return null; }
}

function defaultNetworkHosts() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (!ni.internal && ni.family === 'IPv4' && isPrivateHost(ni.address)) out.push(ni.address);
    }
  }
  return out;
}

function defaultConnect(url) {
  const ws = new WebSocket(url, { handshakeTimeout: 10_000, maxPayload: 2 * 1024 * 1024 });
  const sock = wrapWebSocket(ws);
  ws.on('error', () => { /* close folgt */ });
  return sock;
}

function enc(obj) { return b64u(Buffer.from(JSON.stringify(obj), 'utf8')); }
function dec(d) { return JSON.parse(fromB64u(d).toString('utf8')); }

export function createMobileLink(ctx = {}, deps = {}) {
  const fsImpl = deps.fs || fs;
  const now = deps.now || (() => Date.now());
  const pushLog = typeof ctx.pushLog === 'function' ? ctx.pushLog : () => {};
  const connect = deps.connect || defaultConnect;
  const networkHosts = deps.networkHosts || defaultNetworkHosts;
  const buildStatus = deps.buildStatus || (() => buildCompactStatus(ctx, now()));
  const loopback = deps.loopback || defaultLoopback;
  const getCfg = () => (typeof ctx.getCfg === 'function' ? ctx.getCfg() : {}) || {};

  // ── Sidecar ───────────────────────────────────────────────────────────────

  function dataDir() {
    if (typeof ctx.getDataDir === 'function') return ctx.getDataDir() || '.';
    return process.env.DV_DATA_DIR || '.';
  }
  const sidecarPath = () => path.join(dataDir(), SIDECAR_NAME);

  function loadStore() {
    try {
      const o = JSON.parse(fsImpl.readFileSync(sidecarPath(), 'utf8'));
      if (o && o.v === 1 && typeof o.boxKey === 'string' && Array.isArray(o.devices)) return o;
    } catch { /* fehlt oder kaputt */ }
    return null;
  }

  function saveStore() {
    const p = sidecarPath();
    const tmp = `${p}.tmp-${process.pid}`;
    fsImpl.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
    try { fsImpl.chmodSync?.(tmp, 0o600); } catch { /* best effort */ }
    fsImpl.renameSync(tmp, p);
  }

  let store = loadStore();
  let signer = store ? signerFromPrivateKey(store.boxKey) : null;

  function ensureIdentity() {
    if (signer) return signer;
    signer = generateIdentity();
    store = { v: 1, boxKey: signer.exportPem(), devices: [] };
    saveStore();
    pushLog('mobile_link_identity_created', { box: signer.id });
    return signer;
  }

  const devices = () => (store ? store.devices : []);
  const findDevice = (id) => devices().find((d) => d.id === id) || null;

  // ── Einstellungen ─────────────────────────────────────────────────────────

  function settings() {
    const c = getCfg().mobileLink || {};
    const relayRaw = c.relayUrl == null ? DEFAULT_RELAY_URL : c.relayUrl;
    return {
      enabled: c.enabled === true,
      useRelay: c.useRelay !== false,
      relayUrl: normalizeRelayUrl(relayRaw),
      relayUrlRaw: String(relayRaw ?? ''),
      name: String(c.name || 'DVhub').slice(0, 40),
    };
  }

  // ── Kopplung ──────────────────────────────────────────────────────────────

  let pairing = null; // { secret, tokenHash, exp, qr, status, candidate, peer }

  function pairingActive() {
    if (pairing && pairing.exp <= now() && pairing.status !== 'approved') {
      pairing.peer?.close('pairing_expired');
      pairing = null;
      broadcastPairState();
    }
    return !!pairing && (pairing.status === 'waiting' || pairing.status === 'consumed' || pairing.status === 'scanned');
  }

  function startPairing({ lanHost = null } = {}) {
    const s = settings();
    if (!s.enabled) throw new Error('mobile_link_disabled');
    if (devices().length >= MAX_DEVICES) throw new Error('too_many_devices');
    const box = ensureIdentity();
    if (pairing) pairing.peer?.close('pairing_replaced');
    const secret = crypto.randomBytes(32);
    const exp = now() + PAIRING_TTL_MS;
    const port = Number(getCfg().httpPort) || 80;
    // Heimnetz-Adressen fürs Handy: zuerst die, unter der die Oberfläche
    // gerade offen ist, dann die eigenen Netzadressen. Loopback hilft dem Handy nicht.
    const hosts = [];
    const hint = sanitizeLanHost(lanHost);
    if (hint && !/^(localhost|127\.|\[::1\])/i.test(hint)) hosts.push(hint);
    for (const ip of networkHosts()) {
      const h = port === 80 ? ip : `${ip}:${port}`;
      if (!hosts.includes(h)) hosts.push(h);
    }
    const lan = hosts.slice(0, 2);
    const qr = buildPairPayload({
      boxPublicRaw: box.publicRaw, secret, name: s.name, lan,
      relay: s.useRelay ? s.relayUrl : null, expSec: Math.floor(exp / 1000),
    });
    pairing = {
      secret, tokenHash: pairTokenHash(pairRelayToken(secret)), exp, qr,
      status: 'waiting', candidate: null, peer: null,
    };
    pushLog('mobile_link_pairing_started', { lan: lan.length, relay: !!(s.useRelay && s.relayUrl) });
    reconcile();
    broadcastPairState();
    return pairingStatus();
  }

  function pairingStatus() {
    pairingActive();
    if (!pairing) return null;
    return {
      status: pairing.status,
      expiresAt: new Date(pairing.exp).toISOString(),
      qr: pairing.status === 'waiting' ? pairing.qr : null,
      qrSvg: pairing.status === 'waiting' ? qrSvg(pairing.qr) : null,
      candidate: pairing.candidate
        ? { id: pairing.candidate.devId, name: pairing.candidate.name, model: pairing.candidate.model }
        : null,
    };
  }

  function cancelPairing() {
    if (!pairing) return { ok: true };
    pairing.peer?.send({ t: 'p_denied' });
    pairing.peer?.close('pairing_cancelled');
    pairing = null;
    broadcastPairState();
    reconcile();
    return { ok: true };
  }

  function approvePairing({ perms = ['read'], name = null } = {}) {
    if (!pairingActive() || pairing.status !== 'scanned' || !pairing.candidate || !pairing.peer) {
      throw new Error('no_pairing_to_approve');
    }
    if (devices().length >= MAX_DEVICES) throw new Error('too_many_devices');
    const c = pairing.candidate;
    const p = normalizePerms(perms);
    const mailboxKey = crypto.randomBytes(32);
    const dev = {
      id: c.devId,
      pub: b64u(c.devPub),
      name: String(name || c.name || 'Handy').slice(0, 64),
      model: c.model,
      perms: p,
      mk: b64u(mailboxKey),
      createdAt: new Date(now()).toISOString(),
      lastSeenAt: null,
    };
    store.devices = devices().filter((d) => d.id !== dev.id).concat(dev);
    saveStore();
    const s = settings();
    pairing.peer.send({
      t: 'p_ok',
      dev: dev.id,
      name: dev.name,
      perms: dev.perms,
      box: { id: signer.id, name: s.name },
      ticket: issueTicket(signer, dev.id, Math.floor(now() / 1000) + TICKET_TTL_SEC),
      mailboxKey: dev.mk,
      relay: s.useRelay ? s.relayUrl : null,
    });
    const peer = pairing.peer;
    setTimeout(() => peer.close('paired'), 500).unref?.();
    pairing.status = 'approved';
    pushLog('mobile_link_paired', { dev: dev.id, name: dev.name, model: dev.model, perms: dev.perms });
    pairing = null;
    broadcastAllow();
    reconcile();
    return { ok: true, device: publicDevice(dev) };
  }

  function removeDevice(id) {
    const dev = findDevice(id);
    if (!dev) throw new Error('device_not_found');
    store.devices = devices().filter((d) => d.id !== id);
    saveStore();
    for (const peer of [...sessions]) if (peer.devId === id) peer.close('device_removed');
    for (const link of links()) link.send({ t: 'mbox_clear', dev: id });
    broadcastAllow();
    pushLog('mobile_link_device_removed', { dev: id, name: dev.name });
    reconcile();
    return { ok: true };
  }

  function updateDevice(id, { name, perms } = {}) {
    const dev = findDevice(id);
    if (!dev) throw new Error('device_not_found');
    if (typeof name === 'string' && name.trim()) dev.name = name.trim().slice(0, 64);
    if (Array.isArray(perms)) dev.perms = normalizePerms(perms);
    saveStore();
    // Laufende Sitzungen mit den neuen Rechten neu aufbauen lassen.
    for (const peer of [...sessions]) if (peer.devId === id) peer.close('device_updated');
    return { ok: true, device: publicDevice(dev) };
  }

  function publicDevice(d) {
    return {
      id: d.id, name: d.name, model: d.model, perms: d.perms,
      createdAt: d.createdAt, lastSeenAt: d.lastSeenAt,
      online: [...sessions].some((p) => p.devId === d.id),
    };
  }

  // ── Relay-Verbindungen ────────────────────────────────────────────────────

  let lanRelay = null;
  let lanLink = null;
  let remoteLink = null;
  const sessions = new Set();

  function links() { return [lanLink, remoteLink].filter((l) => l && l.online); }

  function broadcastAllow() {
    for (const l of links()) l.send({ t: 'allow', devs: devices().map((d) => d.id) });
  }

  function broadcastPairState() {
    for (const l of links()) l.syncPairing();
  }

  function createLink(kind, openSocket, { reconnect }) {
    let sock = null;
    let backoff = 1000;
    let retryTimer = null;
    let stopped = false;
    const peers = new Map();
    const link = {
      kind, online: false, state: 'connecting', lastError: null, since: null,
      send(obj) { if (sock && link.online) { try { sock.send(JSON.stringify(obj)); } catch { /* weg */ } } },
      syncPairing() {
        if (!link.online) return;
        if (pairingActive() && pairing.status === 'waiting') link.send({ t: 'pair_open', h: pairing.tokenHash, exp: pairing.exp });
        else link.send({ t: 'pair_close' });
      },
      stop() {
        stopped = true;
        clearTimeout(retryTimer);
        for (const p of peers.values()) p.drop();
        peers.clear();
        try { sock?.close(1000, 'stop'); } catch { /* egal */ }
        sock = null;
        link.online = false;
        link.state = 'stopped';
      },
    };

    function start() {
      if (stopped) return;
      link.state = 'connecting';
      try {
        sock = openSocket();
      } catch (e) {
        link.lastError = e?.message || String(e);
        return scheduleRetry();
      }
      const mine = sock;
      mine.onMessage((text) => { if (sock === mine) onMessage(text); });
      mine.onClose(() => {
        if (sock !== mine) return;
        sock = null;
        const wasOnline = link.online;
        link.online = false;
        for (const p of peers.values()) p.drop();
        peers.clear();
        if (wasOnline) pushLog('mobile_link_relay_offline', { kind });
        if (!stopped) { link.state = 'offline'; scheduleRetry(); }
      });
    }

    function scheduleRetry() {
      if (!reconnect || stopped) return;
      clearTimeout(retryTimer);
      retryTimer = setTimeout(start, backoff);
      retryTimer.unref?.();
      backoff = Math.min(backoff * 2, 60_000);
    }

    function onMessage(text) {
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (!msg || typeof msg.t !== 'string') return;
      if (msg.t === 'challenge') {
        const box = ensureIdentity();
        let sig;
        try { sig = box.sign(relayAuthData('box', msg.n)); } catch { return; }
        sock.send(JSON.stringify({ t: 'auth', role: 'box', pub: b64u(box.publicRaw), sig: b64u(sig) }));
        return;
      }
      if (msg.t === 'ok' && msg.role === 'box') {
        link.online = true;
        link.state = 'online';
        link.lastError = null;
        link.since = new Date(now()).toISOString();
        backoff = 1000;
        link.send({ t: 'allow', devs: devices().map((d) => d.id) });
        link.syncPairing();
        if (kind === 'remote') pushMailboxLatest();
        return;
      }
      if (msg.t === 'open' && typeof msg.c === 'string') {
        peers.get(msg.c)?.drop();
        const peer = createPeer(link, msg.c, msg.role, msg.dev);
        if (peer) peers.set(msg.c, peer);
        else link.send({ t: 'close', c: msg.c, reason: 'rejected' });
        return;
      }
      if (msg.t === 'data' && typeof msg.c === 'string') {
        peers.get(msg.c)?.onData(msg.d);
        return;
      }
      if (msg.t === 'close' && typeof msg.c === 'string') {
        peers.get(msg.c)?.drop();
        peers.delete(msg.c);
        return;
      }
      if (msg.t === 'error') link.lastError = String(msg.e || 'relay_error');
    }

    link.forget = (cid) => peers.delete(cid);
    start();
    return link;
  }

  // Ein Handy auf einem Weg: Handshake, dann verschlüsselte Sitzung.
  function createPeer(link, cid, role, devIdHint) {
    if (role !== 'device' && role !== 'pair') return null;
    let closed = false;
    let session = null;
    let hs = null;
    let pairBox = null;
    let stage = role === 'device' ? 'hs1' : 'p1';
    let liveTimer = null;
    let inflight = 0;
    const timeout = setTimeout(() => { if (!session || stage !== 'ready') peer.close('handshake_timeout'); }, HANDSHAKE_TIMEOUT_MS);
    timeout.unref?.();

    const peer = {
      cid, role, devId: null, link,
      // false = zu groß für einen Relay-Rahmen (nicht gesendet, Zähler unverändert).
      send(obj) {
        if (closed || !session) return false;
        const bytes = Buffer.byteLength(JSON.stringify(obj), 'utf8');
        // base64url ohne Füllung über Klartext + 16 Byte Tag, plus Hülle
        if (Math.ceil(((bytes + 16) * 4) / 3) + 64 + cid.length > MAX_FRAME_CHARS) return false;
        link.send({ t: 'data', c: cid, d: session.seal(obj) });
        return true;
      },
      close(reason = 'closed') {
        if (closed) return;
        link.send({ t: 'close', c: cid, reason });
        peer.drop();
        link.forget(cid);
      },
      drop() {
        if (closed) return;
        closed = true;
        clearTimeout(timeout);
        clearInterval(liveTimer);
        sessions.delete(peer);
        if (pairing && pairing.peer === peer && (pairing.status === 'consumed' || pairing.status === 'scanned')) {
          // Handy ist vor der Freigabe weg: Kopplung verbraucht, neu starten.
          pairing = null;
          broadcastPairState();
        }
      },
      onData(d) {
        if (closed || typeof d !== 'string') return;
        try {
          handle(d);
        } catch (e) {
          logPeerError(role, e);
          peer.close('protocol_error');
        }
      },
    };

    function handle(d) {
      if (stage === 'hs1') {
        hs = createBoxHandshake({ boxSigner: signer, lookupDevice: (id) => {
          const dev = findDevice(id);
          return dev && (!devIdHint || devIdHint === id) ? fromB64u(dev.pub, 65) : null;
        } });
        const hs2 = hs.onHs1(dec(d));
        link.send({ t: 'data', c: cid, d: enc(hs2) });
        stage = 'hs3';
        return;
      }
      if (stage === 'hs3') {
        const r = hs.onHs3(dec(d));
        session = r.session;
        peer.devId = r.devId;
        stage = 'ready';
        clearTimeout(timeout);
        sessions.add(peer);
        const dev = findDevice(r.devId);
        if (!dev) return peer.close('device_removed');
        dev.lastSeenAt = new Date(now()).toISOString();
        throttledSave();
        const s = settings();
        peer.send({
          t: 'welcome',
          box: { id: signer.id, name: s.name, version: ctx.getAppVersion?.()?.versionLabel || null },
          perms: dev.perms,
          ticket: issueTicket(signer, dev.id, Math.floor(now() / 1000) + TICKET_TTL_SEC),
          relay: s.useRelay ? s.relayUrl : null,
          via: link.kind,
        });
        return;
      }
      if (stage === 'p1') {
        // Genau eine Kopplung je QR-Code — der erste Versuch verbraucht ihn,
        // egal über welchen Weg er kommt.
        if (!pairingActive() || pairing.status !== 'waiting' || pairing.peer) return peer.close('pairing_not_open');
        pairBox = createPairBox({ boxSigner: signer, secret: pairing.secret });
        const r = pairBox.onP1(dec(d));
        session = r.session;
        pairing.peer = peer;
        pairing.status = 'consumed';
        broadcastPairState();
        link.send({ t: 'data', c: cid, d: enc(r.p2) });
        stage = 'p3';
        return;
      }
      if (stage === 'p3') {
        const cand = pairBox.verifyP3(session.open(d));
        if (pairing?.peer !== peer) return peer.close('pairing_not_open');
        pairing.candidate = cand;
        pairing.status = 'scanned';
        stage = 'pair_wait';
        clearTimeout(timeout);
        peer.send({ t: 'p_wait', box: { id: signer.id, name: settings().name } });
        pushLog('mobile_link_pairing_scanned', { dev: cand.devId, name: cand.name, model: cand.model });
        return;
      }
      if (stage === 'pair_wait') {
        session.open(d); // Zähler weiterführen; das Handy wartet nur
        return;
      }
      if (stage === 'ready') {
        onApp(session.open(d));
      }
    }

    function onApp(msg) {
      if (!msg || typeof msg.t !== 'string') return;
      const dev = findDevice(peer.devId);
      if (!dev) return peer.close('device_removed');
      if (msg.t === 'ping') return peer.send({ t: 'pong', id: msg.id ?? null });
      if (msg.t === 'sub') {
        clearInterval(liveTimer);
        liveTimer = null;
        if (msg.live === true) {
          const every = Math.max(LIVE_MIN_MS, Number(msg.intervalMs) || LIVE_DEFAULT_MS);
          const tick = () => { try { peer.send({ t: 'live', ts: new Date(now()).toISOString(), status: buildStatus() }); } catch { /* nächster Takt */ } };
          tick();
          liveTimer = setInterval(tick, every);
          liveTimer.unref?.();
        }
        return;
      }
      if (msg.t === 'req') {
        const id = msg.id;
        const reply = (s, body) => {
          if (!peer.send({ t: 'res', id, s, b: body })) peer.send({ t: 'res', id, s: 413, b: { error: 'response_too_large' } });
        };
        if (inflight >= MAX_PARALLEL_REQUESTS) return reply(429, { error: 'too_many_requests' });
        const chk = checkRequest(dev.perms, msg.m, msg.p);
        if (!chk.ok) return reply(chk.status, { error: chk.error });
        const method = String(msg.m).toUpperCase();
        const bodyText = method === 'POST' ? JSON.stringify(msg.b ?? {}) : null;
        if (bodyText && bodyText.length > MAX_REQUEST_BODY_CHARS) return reply(413, { error: 'body_too_large' });
        inflight++;
        loopback(method, chk.path + chk.search, bodyText)
          .then((r) => {
            if (method === 'POST') pushLog('mobile_link_control', { dev: dev.id, name: dev.name, path: chk.path, status: r.status });
            const size = typeof r.body === 'string' ? r.body.length : JSON.stringify(r.body ?? null).length;
            if (size > MAX_RESPONSE_CHARS) return reply(413, { error: 'response_too_large' });
            reply(r.status, r.body);
          })
          .catch((e) => reply(502, { error: e?.message || 'loopback_failed' }))
          .finally(() => { inflight--; });
        return;
      }
    }

    return peer;
  }

  // Fehlversuche (fremdes Gerät im WLAN, kaputte Nachrichten) höchstens
  // einmal je Minute ins Protokoll — sonst ließe sich das Audit-Log fluten.
  let peerErrorAt = 0;
  let peerErrorsSuppressed = 0;
  function logPeerError(role, e) {
    if (now() - peerErrorAt < 60_000) { peerErrorsSuppressed++; return; }
    peerErrorAt = now();
    pushLog('mobile_link_peer_error', { role, error: e?.message || String(e), suppressed: peerErrorsSuppressed });
    peerErrorsSuppressed = 0;
  }

  let saveTimer = null;
  function throttledSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; try { if (store) saveStore(); } catch { /* nächstes Mal */ } }, 10_000);
    saveTimer.unref?.();
  }

  function defaultLoopback(method, pathWithQuery, bodyText) {
    const cfg = getCfg();
    const port = Number(cfg.httpPort) || 80;
    const allowed = Array.isArray(cfg.allowedHosts) ? cfg.allowedHosts.filter(Boolean) : [];
    const headers = { accept: 'application/json', 'x-dvhub-client': 'mobile-link' };
    if (allowed.length) headers.host = String(allowed[0]);
    // Bewusst ohne Bearer: Loopback passiert die Anmeldung ohnehin, und ein
    // Bearer zählt an manchen Routen als Ersatz für den UI-Nonce.
    if (bodyText != null) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(bodyText);
    }
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: pathWithQuery, method, headers, timeout: 20_000 }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > MAX_RESPONSE_CHARS * 2) { req.destroy(new Error('response_too_large')); return; }
          chunks.push(c);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body = text;
          if (/json/.test(String(res.headers['content-type'] || ''))) { try { body = JSON.parse(text); } catch { /* Text */ } }
          resolve({ status: res.statusCode || 0, body });
        });
      });
      req.on('timeout', () => req.destroy(new Error('loopback_timeout')));
      req.on('error', reject);
      if (bodyText != null) req.write(bodyText);
      req.end();
    });
  }

  // ── Briefkasten am Relay ──────────────────────────────────────────────────

  let lastEventKey = null;
  function pushMailboxLatest() {
    if (!remoteLink?.online || !devices().length) return;
    let st;
    try { st = buildStatus(); } catch { return; }
    const ts = new Date(now()).toISOString();
    for (const d of devices()) {
      remoteLink.send({ t: 'mbox_put', dev: d.id, slot: 'latest', d: sealMailbox(fromB64u(d.mk, 32), d.id, { t: 'latest', ts, status: st }) });
    }
    // Ereignisse: Alarme und Not-Halt landen zusätzlich als eigener Eintrag,
    // damit die App sie auch nach Stunden noch zeigt.
    const key = `${st.alarmsActive || 0}|${st.alarmsSeverity || 0}|${st.emergencyStop ? 1 : 0}`;
    if (lastEventKey !== null && key !== lastEventKey) {
      for (const d of devices()) {
        remoteLink.send({ t: 'mbox_put', dev: d.id, d: sealMailbox(fromB64u(d.mk, 32), d.id, {
          t: 'event', ts, kind: 'state_change',
          alarmsActive: st.alarmsActive || 0, alarmsSeverity: st.alarmsSeverity || 0, emergencyStop: !!st.emergencyStop,
        }) });
      }
    }
    lastEventKey = key;
  }

  // ── Steuerung ─────────────────────────────────────────────────────────────

  let reconcileTimer = null;
  let mailboxTimer = null;
  let started = false;
  let remoteUrl = null;

  function reconcile() {
    if (!started) return;
    const s = settings();
    if (!s.enabled) {
      lanLink?.stop(); lanLink = null;
      lanRelay?.close(); lanRelay = null;
      remoteLink?.stop(); remoteLink = null; remoteUrl = null;
      return;
    }
    const box = ensureIdentity();
    if (!lanRelay) {
      lanRelay = createRelay({
        name: 'dvhub-lan',
        allowBox: (id) => id === box.id,
        limits: { maxBoxes: 1, maxDeviceConnsPerBox: MAX_DEVICES * 2, maxConnections: 64 },
        log: () => {},
      });
      lanLink = createLink('lan', () => {
        const [boxSide, relaySide] = createMemorySocketPair();
        lanRelay.attach(relaySide, { remote: 'in-process' });
        return boxSide;
      }, { reconnect: true });
    }
    const wantRemote = s.useRelay && !!s.relayUrl && (devices().length > 0 || pairingActive());
    if (!wantRemote || remoteUrl !== s.relayUrl) { remoteLink?.stop(); remoteLink = null; remoteUrl = null; }
    if (wantRemote && !remoteLink) {
      remoteUrl = s.relayUrl;
      remoteLink = createLink('remote', () => connect(s.relayUrl), { reconnect: true });
    }
  }

  function start() {
    if (started) return;
    started = true;
    reconcile();
    reconcileTimer = setInterval(() => { pairingActive(); reconcile(); }, RECONCILE_MS);
    reconcileTimer.unref?.();
    mailboxTimer = setInterval(pushMailboxLatest, MAILBOX_LATEST_MS);
    mailboxTimer.unref?.();
  }

  function stop() {
    started = false;
    clearInterval(reconcileTimer);
    clearInterval(mailboxTimer);
    clearTimeout(saveTimer);
    lanLink?.stop(); lanLink = null;
    lanRelay?.close(); lanRelay = null;
    remoteLink?.stop(); remoteLink = null; remoteUrl = null;
  }

  // Handy im Heimnetz: WebSocket am eigenen Webserver → eingebettetes Relay.
  function attachLan(ws, { remote = null } = {}) {
    if (!settings().enabled || !lanRelay) {
      ws.on('error', () => {}); // s. wrapWebSocket — Fehler dürfen den Prozess nicht beenden
      try { ws.close(1013, 'mobile_link_disabled'); } catch { /* egal */ }
      return false;
    }
    lanRelay.attach(wrapWebSocket(ws), { remote });
    return true;
  }

  function linkStatus(l) {
    if (!l) return null;
    return { state: l.state, online: l.online, since: l.since, lastError: l.lastError };
  }

  function status() {
    const s = settings();
    return {
      enabled: s.enabled,
      useRelay: s.useRelay,
      relayUrl: s.relayUrlRaw,
      relayUrlValid: !!s.relayUrl,
      defaultRelayUrl: DEFAULT_RELAY_URL,
      name: s.name,
      boxId: signer ? signer.id : null,
      lan: linkStatus(lanLink),
      relay: linkStatus(remoteLink),
      pairing: pairingStatus(),
      devices: devices().map(publicDevice),
      maxDevices: MAX_DEVICES,
    };
  }

  return {
    start, stop, reconcile, status, attachLan,
    isEnabled: () => settings().enabled,
    startPairing, approvePairing, cancelPairing, removeDevice, updateDevice,
    // Für Tests
    _boxId: () => signer?.id || null,
    _pushMailboxLatest: pushMailboxLatest,
    _keyId: keyId,
  };
}
