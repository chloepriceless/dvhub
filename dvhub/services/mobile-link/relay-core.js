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

// Grenzen passend zum Container (relay.dvhub.de: mem_limit 256 MiB, Strix
// H-0001/H-0002, 01.11.2026): Verbindungen (~10 KiB je Stück) und Briefkästen
// zusammen bleiben unter der Hälfte, Rest für Node selbst und Rahmen unterwegs.
export const DEFAULT_LIMITS = Object.freeze({
  authTimeoutMs: 10_000,
  maxConnections: 4_000,
  // Je Quelladresse (hinter einem Proxy die von ihm angehängte Adresse,
  // IPv6 je /64 — siehe relay-server.js clientAddress).
  maxConnectionsPerRemote: 64,
  // IPv6 zusätzlich je /56 (ein Anschluss bekommt meist ein /56 und damit
  // 256 /64, Gesamtprüfung 1.0.9). IPv4 bleibt bei der Adresse.
  maxConnectionsPerGroup: 256,
  // … und je /48 (ein /48 ist leicht zu bekommen und hält 256 /56,
  // Gegenprüfung 43bd89ed).
  maxConnectionsPerWideGroup: 1024,
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
  // Je Box über alle ihre Geräte; darüber weichen die ältesten Einträge DIESER Box.
  mailboxBytesPerBox: 2 * 1024 * 1024,
  // Je Quelladresse der ablegenden Box-Verbindung über alle Boxen dieser
  // Quelle (Box-Kennungen sind frei erzeugbar); darüber weichen die ältesten
  // Einträge DIESER Quelle (Relay-Restpunkte 02.11.2026).
  mailboxBytesPerSource: 4 * 1024 * 1024,
  // Alle Boxen zusammen; darüber weichen die ältesten Einträge der Quelle,
  // die gerade am meisten belegt — nicht die ältesten überhaupt, sonst
  // verdrängt eine Flut frischer Box-Kennungen echte, ältere Meldungen.
  mailboxTotalBytes: 64 * 1024 * 1024,
  maxMailboxes: 20_000,
  // Neue Box-Briefkästen je Quelle: so viele sofort, dann einer je
  // newBoxRefillMs (Eimer). Bekannte Boxen mit Briefkasten zählen nicht.
  newBoxesPerSource: 16,
  newBoxRefillMs: 60_000,
  newBoxSourcesTracked: 10_000,
  // Entkoppelte Geräte, die sich das Relay über das Offline-Sein der Box merkt.
  revokedPerBox: 32,
  revokedBoxes: 2_000,
  // Davon je Quelle (IPv6 je /56): frische Box-Kennungen einer Quelle
  // verdrängen nur deren eigene Einträge (Gesamtprüfung 1.0.9).
  revokedBoxesPerSource: 16,
  // … und je /48 (256 /56 eines /48 dürfen die Liste nicht leeren,
  // Gegenprüfung 43bd89ed; Kunden eines Anbieter-/48 teilen sich das).
  revokedBoxesPerWideSource: 256,
});

// Speicher über die Nutzdaten hinaus (Map-Einträge, Objekte, String-Köpfe,
// Reihenfolge-Set) — zählt mit, damit viele kleine Einträge nicht unter der
// Bytegrenze durchrutschen (Fable-Review H1, Strix H-0002). Nutzdaten sind
// nur Base64url (ein Byte je Zeichen im Speicher, sonst UTF-16 = zwei).
const MAILBOX_OVERHEAD = 512;
const ITEM_OVERHEAD = 256;
const BOX_OVERHEAD = 1024; // Index-Eintrag je Box
const B64U = /^[A-Za-z0-9_-]+={0,2}$/;
const NO_SOURCE = '-'; // Verbindung ohne Quelladresse (eingebettet, Tests)
// Gemeinsamer Eimer für neue Boxen aus Quellen, die die volle Tabelle nicht
// mehr aufnimmt (Gesamtprüfung 1.0.9: vorher galten sie als unbekannt und
// bekamen jedes Mal den vollen Eimer).
const NEW_BOX_OVERFLOW = '\u0000overflow';

// Gruppe einer Quelle = ein Anschluss: IPv6-/64-Schlüssel (relay-server.js
// remoteKey) → /56, so wie deutsche Anbieter ihn je Kunde vergeben — ein /48
// teilten sich 256 fremde Kunden (Gegenprüfung d3cafdcf, P2). Alles andere
// bleibt, wie es ist (Gesamtprüfung 1.0.9).
// Weite Gruppe für die zweite Grenze: IPv6 /48, sonst wie sourceGroup.
export function sourceWideGroup(remote) {
  if (!remote) return null;
  const m = /^([0-9a-f]{1,4}:[0-9a-f]{1,4}:[0-9a-f]{1,4}):[0-9a-f]{1,4}::\/64$/.exec(remote);
  return m ? `${m[1]}::/48` : remote;
}

export function sourceGroup(remote) {
  if (!remote) return null;
  const m = /^([0-9a-f]{1,4}:[0-9a-f]{1,4}:[0-9a-f]{1,4}):([0-9a-f]{1,4})::\/64$/.exec(remote);
  return m ? `${m[1]}:${(parseInt(m[2], 16) & 0xff00).toString(16)}::/56` : remote;
}

// Spielraum über der Rahmengrenze der Rolle (UTF-8 statt Zeichen, Kopf).
export const FRAME_SLACK = 4096;

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
  // Briefkästen je Box (Strix H-0002/H-0005): boxId → { bytes, devs: Map<devId, m> },
  // m = { latest, items, bytes }, Eintrag = { id, ts, d, cost, seq, boxId, devId, prev, next }.
  // bytes zählen Nutzdaten und Verwaltung (Box, Briefkasten, Eintrag) mit.
  const mbBoxes = new Map();
  // Alle Einträge in Ablagereihenfolge, ältester zuerst (doppelt verkettet,
  // O(1) vorn entnehmen und mittendrin austragen): für „ältestes zuerst
  // verwerfen“ und das Aufräumen nach Ablauf ohne Rundlauf über alle. Kein Set —
  // dessen Iterator müsste nach jedem Löschen vorn die Lücken neu überspringen
  // (Codex 4597a2f8 P2).
  let mbHead = null;
  let mbTail = null;
  // Relay-weit eindeutige Laufnummer = Ereignis-ID: eine verspätete Quittung
  // trifft nie ein Ereignis aus einem neu angelegten Briefkasten (Codex P2).
  let mbSeq = 0;
  let mailboxCount = 0;
  let mailboxTotal = 0;
  // Belegung je Quelle (Quelladresse der ablegenden Box-Verbindung, nur im
  // Arbeitsspeicher, kein Register): key → { key, bytes, head, tail, bi }.
  // Einträge je Quelle in Ablagereihenfolge (sp/sn), Briefkasten- und
  // Box-Verwaltung zählen bei der Quelle, die sie angelegt hat. Für „wer belegt
  // am meisten“ liegen die Quellen in Eimern nach Zweierpotenz (bi) — der
  // gewählte ist höchstens um Faktor 2 kleiner als der größte, in O(1).
  const srcs = new Map();
  const srcBuckets = [];
  // Eimer für neue Box-Briefkästen je Quelle: key → { n, t }.
  const newBoxTokens = new Map();
  // Entkoppelte Geräte je Box aus den Freigabelisten der Box — gilt auch,
  // solange die Box offline ist (Strix H-0004): boxId → { last:Set, gone:Set }.
  const revoked = new Map();
  let nextCid = 1;
  let closed = false;
  const conns = new Set();
  const perRemote = new Map(); // Quelladresse → offene Verbindungen
  // Gruppe (IPv6 /56, sonst die Adresse) → offene Verbindungen in
  // Anmelde-Reihenfolge: Grenze je Gruppe und faires Verdrängen, wenn das
  // Relay voll ist (Gesamtprüfung 1.0.9, Hauptbefund 11).
  const perGroup = new Map();
  const perWideGroup = new Map(); // IPv6 /48 → Anzahl offener Verbindungen
  // Entkoppelt-Einträge je Quelle (Gruppe) und je weiter Gruppe — siehe noteAllow.
  const revokedPerSrc = new Map();
  const revokedPerWide = new Map();
  const dec = (map, key) => { const n = (map.get(key) || 1) - 1; if (n > 0) map.set(key, n); else map.delete(key); };

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

  function mbFind(boxId, devId) { return mbBoxes.get(boxId)?.devs.get(devId) || null; }

  function orderAdd(it) {
    it.prev = mbTail;
    it.next = null;
    if (mbTail) mbTail.next = it; else mbHead = it;
    mbTail = it;
  }

  function orderRemove(it) {
    if (it.prev) it.prev.next = it.next; else if (mbHead === it) mbHead = it.next;
    if (it.next) it.next.prev = it.prev; else if (mbTail === it) mbTail = it.prev;
    it.prev = null;
    it.next = null;
  }

  // ── Quellen ──
  function srcAdjust(key, delta) {
    let s = srcs.get(key);
    if (!s) {
      if (delta <= 0) return;
      s = { key, bytes: 0, head: null, tail: null, bi: -1 };
      srcs.set(key, s);
    }
    s.bytes += delta;
    // Nur Quellen mit eigenen Einträgen kommen in die Eimer: eine Quelle, die
    // nur noch Verwaltung fremd befüllter Briefkästen hält, hat nichts zum
    // Verdrängen (sonst fiele die Wahl auf das Älteste überhaupt, Review 834d1336 P2).
    const bi = s.bytes > 0 && s.head ? 31 - Math.clz32(Math.min(s.bytes, 0x7fffffff)) : -1;
    if (bi !== s.bi) {
      if (s.bi >= 0) srcBuckets[s.bi].delete(s);
      if (bi >= 0) (srcBuckets[bi] ||= new Set()).add(s);
      s.bi = bi;
    }
    if (s.bytes <= 0 && !s.head) srcs.delete(key);
  }

  function srcBiggest() {
    for (let i = srcBuckets.length - 1; i >= 0; i--) {
      const set = srcBuckets[i];
      if (set && set.size) return set.values().next().value;
    }
    return null;
  }

  function srcLink(it) {
    const s = srcs.get(it.src);
    it.sp = s.tail;
    it.sn = null;
    if (s.tail) s.tail.sn = it; else s.head = it;
    s.tail = it;
  }

  function srcUnlink(it) {
    const s = srcs.get(it.src);
    if (!s) return;
    if (it.sp) it.sp.sn = it.sn; else if (s.head === it) s.head = it.sn;
    if (it.sn) it.sn.sp = it.sp; else if (s.tail === it) s.tail = it.sp;
    it.sp = null;
    it.sn = null;
  }

  // Neue Box-Briefkästen je Quelle drosseln (Eimer, nur im Arbeitsspeicher).
  function newBoxAllowed(src) {
    const t = now();
    let key = src;
    let e = newBoxTokens.get(key);
    // Liste voll: unbekannte Quellen teilen sich einen Eimer — sonst bekäme
    // jede jedes Mal den vollen (Gesamtprüfung 1.0.9).
    if (!e && newBoxTokens.size >= L.newBoxSourcesTracked) {
      key = NEW_BOX_OVERFLOW;
      e = newBoxTokens.get(key);
    }
    if (!e) {
      // Unbekannte Quelle startet mit vollem Eimer.
      if (L.newBoxesPerSource < 1) return false;
      newBoxTokens.set(key, { n: L.newBoxesPerSource - 1, t });
      return true;
    }
    e.n = Math.min(L.newBoxesPerSource, e.n + (t - e.t) / L.newBoxRefillMs);
    e.t = t;
    if (e.n < 1) return false;
    e.n -= 1;
    return true;
  }

  // Volle Eimer vergessen (im Minutentakt).
  function newBoxPrune() {
    const t = now();
    for (const [key, e] of newBoxTokens) if (e.n + (t - e.t) / L.newBoxRefillMs >= L.newBoxesPerSource) newBoxTokens.delete(key);
  }

  function mbRemoveEntry(it) {
    orderRemove(it);
    const b = mbBoxes.get(it.boxId);
    const m = b?.devs.get(it.devId);
    if (!m) return;
    if (m.latest === it) m.latest = null;
    else {
      const i = m.items.indexOf(it);
      if (i < 0) return;
      m.items.splice(i, 1);
    }
    srcUnlink(it);
    srcAdjust(it.src, -it.cost);
    m.bytes -= it.cost;
    b.bytes -= it.cost;
    mailboxTotal -= it.cost;
  }

  // Leeren Briefkasten und leeren Box-Eintrag entfernen.
  function mbTidy(boxId, devId) {
    const b = mbBoxes.get(boxId);
    if (!b) return;
    const m = b.devs.get(devId);
    if (m && !m.latest && m.items.length === 0) {
      b.devs.delete(devId);
      mailboxCount -= 1;
      b.bytes -= m.bytes;
      mailboxTotal -= m.bytes;
      srcAdjust(m.src, -m.bytes);
    }
    if (b.devs.size === 0) {
      mbBoxes.delete(boxId);
      mailboxTotal -= b.bytes;
      srcAdjust(b.src, -b.bytes);
    }
  }

  function mbEvict(it) {
    mbRemoveEntry(it);
    mbTidy(it.boxId, it.devId);
  }

  function mbClear(boxId, devId) {
    const m = mbFind(boxId, devId);
    if (!m) return;
    if (m.latest) mbRemoveEntry(m.latest);
    while (m.items.length) mbRemoveEntry(m.items[m.items.length - 1]);
    mbTidy(boxId, devId);
  }

  // Abgelaufenes entfernen — für einen Briefkasten beim Zugriff, für alle im
  // Minutentakt von vorn bis zum ersten frischen Eintrag (kein O(N²), Fable H1).
  function mbPruneOne(boxId, devId) {
    const m = mbFind(boxId, devId);
    if (!m) return;
    const cutoff = now() - L.mailboxTtlMs;
    while (m.items.length && m.items[0].ts < cutoff) mbRemoveEntry(m.items[0]);
    if (m.latest && m.latest.ts < cutoff) mbRemoveEntry(m.latest);
    mbTidy(boxId, devId);
  }

  function mbPrune() {
    const cutoff = now() - L.mailboxTtlMs;
    while (mbHead && mbHead.ts < cutoff) mbEvict(mbHead);
  }

  function mbOldestOfBox(b) {
    let best = null;
    for (const m of b.devs.values()) {
      for (const it of [m.latest, m.items[0]]) if (it && (!best || it.seq < best.seq)) best = it;
    }
    return best;
  }

  function mbPut(boxId, devId, d, slot, src = NO_SOURCE) {
    if (!B64U.test(d)) return 'bad_data';
    if (slot === 'latest' ? d.length > L.mailboxLatestBytes : d.length > L.mailboxBytes) return 'too_large';
    mbPruneOne(boxId, devId);
    // Neue Box-Kennung aus dieser Quelle? Erst prüfen, dann verdrängen.
    if (!mbBoxes.has(boxId) && !newBoxAllowed(src)) return 'relay_busy';
    const cost = d.length + ITEM_OVERHEAD;
    let m = mbFind(boxId, devId);
    if (m && slot === 'latest' && m.latest) mbRemoveEntry(m.latest);
    if (slot !== 'latest') {
      // Je Gerät: älteste Ereignisse weichen, wenn Anzahl oder Platz nicht reicht.
      while (m && m.items.length && (m.items.length >= L.mailboxItems || m.bytes + cost > L.mailboxBytes + MAILBOX_OVERHEAD)) mbRemoveEntry(m.items[0]);
      if ((m ? m.bytes : MAILBOX_OVERHEAD) + cost > L.mailboxBytes + MAILBOX_OVERHEAD) { mbTidy(boxId, devId); return 'too_large'; }
    }
    // Je Box, je Quelle, dann gesamt. Es weicht jeweils das Älteste der
    // eigenen Box bzw. Quelle; gesamt das Älteste der Quelle, die am meisten
    // belegt (faire Verdrängung, ohne Register).
    for (;;) {
      m = mbFind(boxId, devId);
      const b = mbBoxes.get(boxId);
      const need = cost + (m ? 0 : MAILBOX_OVERHEAD) + (b ? 0 : BOX_OVERHEAD);
      if ((b ? b.bytes : 0) + need > L.mailboxBytesPerBox) {
        const old = b && mbOldestOfBox(b);
        if (!old) { mbTidy(boxId, devId); return 'too_large'; }
        mbEvict(old);
        continue;
      }
      const s = srcs.get(src);
      if ((s ? s.bytes : 0) + need > L.mailboxBytesPerSource) {
        // Ohne eigene Einträge (nur Verwaltung von Briefkästen, die inzwischen
        // aus einer anderen Quelle befüllt werden) trifft es niemand anderen.
        const old = s?.head;
        if (!old) { mbTidy(boxId, devId); return 'relay_busy'; }
        mbEvict(old);
        continue;
      }
      if (mailboxTotal + need > L.mailboxTotalBytes || (!m && mailboxCount >= L.maxMailboxes)) {
        const old = srcBiggest()?.head || mbHead; // mbHead nur, wenn keine Quelle Einträge hat
        if (!old) { mbTidy(boxId, devId); return 'relay_full'; }
        mbEvict(old);
        continue;
      }
      break;
    }
    let b = mbBoxes.get(boxId);
    if (!b) {
      b = { bytes: BOX_OVERHEAD, devs: new Map(), src };
      mbBoxes.set(boxId, b);
      mailboxTotal += BOX_OVERHEAD;
      srcAdjust(src, BOX_OVERHEAD);
    }
    if (!m) {
      m = { latest: null, items: [], bytes: MAILBOX_OVERHEAD, src };
      b.devs.set(devId, m);
      mailboxCount += 1;
      b.bytes += MAILBOX_OVERHEAD;
      mailboxTotal += MAILBOX_OVERHEAD;
      srcAdjust(src, MAILBOX_OVERHEAD);
    }
    const seq = ++mbSeq;
    const it = { id: slot === 'latest' ? 'latest' : String(seq), ts: now(), d, cost, seq, boxId, devId, src, prev: null, next: null, sp: null, sn: null };
    if (slot === 'latest') m.latest = it; else m.items.push(it);
    orderAdd(it);
    srcAdjust(src, cost);
    srcLink(it);
    srcAdjust(src, 0); // jetzt mit Eintrag → in den Eimer
    m.bytes += cost;
    b.bytes += cost;
    mailboxTotal += cost;
    return null;
  }

  // Freigabeliste der Box: wer herausfällt, gilt als entkoppelt, bis die Box
  // ihn wieder freigibt (Strix H-0004). Begrenzt je Box und insgesamt.
  // Je Quelle höchstens revokedBoxesPerSource Einträge: eine Flut frischer
  // Box-Kennungen verdrängt nur die eigenen, nicht die echter Boxen
  // (Gesamtprüfung 1.0.9). Gesamt bleibt die Grenze revokedBoxes.
  function revokedDrop(boxId) {
    const r = revoked.get(boxId);
    if (!r) return;
    revoked.delete(boxId);
    dec(revokedPerSrc, r.src);
    dec(revokedPerWide, r.wide);
  }
  function noteAllow(boxId, prevAllow, allow, src = NO_SOURCE, wide = src) {
    const r = revoked.get(boxId) || { last: null, gone: new Set(), src, wide };
    revokedDrop(boxId); // ans Ende (zuletzt benutzt)
    r.src = src;
    r.wide = wide;
    const prev = prevAllow || r.last;
    if (prev) for (const dev of prev) if (!allow.has(dev)) { r.gone.delete(dev); r.gone.add(dev); }
    for (const dev of allow) r.gone.delete(dev);
    while (r.gone.size > L.revokedPerBox) r.gone.delete(r.gone.values().next().value);
    r.last = allow;
    if ((revokedPerSrc.get(src) || 0) >= L.revokedBoxesPerSource) {
      for (const [id, x] of revoked) if (x.src === src) { revokedDrop(id); break; }
    } else if ((revokedPerWide.get(wide) || 0) >= L.revokedBoxesPerWideSource) {
      for (const [id, x] of revoked) if (x.wide === wide) { revokedDrop(id); break; }
    }
    revoked.set(boxId, r);
    revokedPerSrc.set(src, (revokedPerSrc.get(src) || 0) + 1);
    revokedPerWide.set(wide, (revokedPerWide.get(wide) || 0) + 1);
    // Gesamtgrenze: nicht den ältesten Eintrag überhaupt verdrängen — ein paar
    // /48 mit je revokedBoxesPerWideSource Einträgen reichten sonst, um die
    // Liste zu leeren (prod: 8 × 256 > 2 000, 1.0.9-Rest). Verdrängt wird der
    // älteste Eintrag der /48 mit den meisten Einträgen.
    while (revoked.size > L.revokedBoxes) revokedDrop(revokedVictim());
  }
  function revokedVictim() {
    let max = 0;
    for (const n of revokedPerWide.values()) if (n > max) max = n;
    for (const [id, x] of revoked) if ((revokedPerWide.get(x.wide) || 0) === max) return id;
    return revoked.keys().next().value;
  }

  const pruneTimer = setInterval(() => { mbPrune(); newBoxPrune(); }, 60_000);
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

  // Relay voll (Gesamtprüfung 1.0.9, Hauptbefund 11): Statt jede neue
  // Verbindung abzuweisen, weicht eine Verbindung der Gruppe mit den meisten
  // Verbindungen — wenn sie mindestens zwei mehr hat als die Gruppe des
  // Neuankömmlings. Wer das Relay mit vielen Verbindungen aus wenigen Netzen
  // füllt, sperrt so keine echten Boxen und Handys aus. Es weicht zuerst eine
  // noch nicht angemeldete, sonst die jüngste Verbindung der Gruppe.
  function evictForNewcomer(group) {
    const own = group ? (perGroup.get(group)?.size || 0) : 0;
    let victims = null;
    for (const set of perGroup.values()) if (!victims || set.size > victims.size) victims = set;
    if (!victims || victims.size < own + 2) return false;
    let victim = null;
    for (const c of victims) { if (!c.role) { victim = c; break; } victim = c; }
    if (!victim) return false;
    log('relay_full_evict', { group: victim.group });
    closeConn(victim, CLOSE.limit, 'relay_full');
    return true;
  }

  function attach(sock, { remote = null } = {}) {
    if (closed) { try { sock.close(CLOSE.shutdown, 'shutdown'); } catch { /* egal */ } return null; }
    const group = sourceGroup(remote);
    const wide = sourceWideGroup(remote);
    if ((remote && (perRemote.get(remote) || 0) >= L.maxConnectionsPerRemote)
      || (group && (perGroup.get(group)?.size || 0) >= L.maxConnectionsPerGroup)
      || (wide && (perWideGroup.get(wide) || 0) >= L.maxConnectionsPerWideGroup)) {
      try { sock.close(CLOSE.limit, 'too_many_connections'); } catch { /* egal */ }
      return null;
    }
    if (conns.size >= L.maxConnections && !evictForNewcomer(group)) {
      try { sock.close(CLOSE.limit, 'relay_full'); } catch { /* egal */ }
      return null;
    }
    if (remote) perRemote.set(remote, (perRemote.get(remote) || 0) + 1);
    if (wide) perWideGroup.set(wide, (perWideGroup.get(wide) || 0) + 1);
    const conn = {
      sock, remote, group, wide, cid: String(nextCid++), role: null, boxId: null, devId: null,
      challenge: b64u(crypto.randomBytes(32)), closed: false,
      rate: { start: now(), frames: 0, bytes: 0 },
    };
    conns.add(conn);
    if (group) {
      let set = perGroup.get(group);
      if (!set) { set = new Set(); perGroup.set(group, set); }
      set.add(conn);
    }
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
    if (conn.wide) dec(perWideGroup, conn.wide);
    if (conn.group) {
      const set = perGroup.get(conn.group);
      set?.delete(conn);
      if (set && !set.size) perGroup.delete(conn.group);
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
      conn.sock.setFrameLimit?.(L.boxFrameBytes + FRAME_SLACK);
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
      // Box online mit Liste: die Liste entscheidet; sonst die gemerkten
      // Entkopplungen (Box offline, Strix H-0004).
      if (existing?.allow ? !existing.allow.has(tk.devId) : revoked.get(tk.boxId)?.gone.has(tk.devId)) {
        return closeConn(conn, CLOSE.notAllowed, 'device_not_allowed');
      }
      if (!existing && boxes.size >= L.maxBoxes) return closeConn(conn, CLOSE.limit, 'relay_full');
      const e = boxEntry(tk.boxId);
      if (e.devices.size >= L.maxDeviceConnsPerBox) return closeConn(conn, CLOSE.limit, 'too_many_devices');
      conn.role = 'device';
      conn.boxId = tk.boxId;
      conn.devId = tk.devId;
      clearTimeout(conn.authTimer);
      conn.sock.setFrameLimit?.(L.deviceFrameBytes + FRAME_SLACK);
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
      conn.sock.setFrameLimit?.(L.deviceFrameBytes + FRAME_SLACK);
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
        const prev = e.allow;
        e.allow = new Set(msg.devs);
        noteAllow(conn.boxId, prev, e.allow, sourceGroup(conn.remote) || NO_SOURCE, sourceWideGroup(conn.remote) || NO_SOURCE);
        for (const d of [...e.devices]) if (!e.allow.has(d.devId)) closeConn(d, CLOSE.notAllowed, 'device_not_allowed');
        // Nur die Briefkästen dieser Box (Index statt Rundlauf über alle, Strix H-0005).
        const b = mbBoxes.get(conn.boxId);
        if (b) for (const dev of [...b.devs.keys()]) if (!e.allow.has(dev)) mbClear(conn.boxId, dev);
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
        // Quelle = Gruppe (IPv6 /56): viele /64 eines Anschlusses zählen zusammen.
        const err = mbPut(conn.boxId, msg.dev, msg.d, msg.slot === 'latest' ? 'latest' : null, sourceGroup(conn.remote) || NO_SOURCE);
        // `slot` sagt der Box, ob ein Ereignis abgelehnt wurde (das legt sie
        // erneut ab) oder nur der letzte Stand (kommt ohnehin alle 60 s).
        // `ref` (von der Box gewählt) nennt die abgelehnte Ablage.
        if (err) send(conn, { t: 'error', e: err, dev: msg.dev, ...(msg.slot === 'latest' ? { slot: 'latest' } : {}), ...(isStr(msg.ref, 32) ? { ref: msg.ref } : {}) });
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
        mbPruneOne(conn.boxId, conn.devId);
        const m = mbFind(conn.boxId, conn.devId);
        const items = m ? [...(m.latest ? [{ ...m.latest, slot: 'latest' }] : []), ...m.items] : [];
        send(conn, { t: 'mbox', items: items.map(({ id, ts, d, slot }) => ({ id, ts, d, ...(slot ? { slot } : {}) })) });
        return;
      }
      case 'mbox_ack': {
        if (conn.role !== 'device' || !Array.isArray(msg.ids)) return closeConn(conn, CLOSE.protocol, 'bad_ack');
        const m = mbFind(conn.boxId, conn.devId);
        if (!m) return;
        const ids = new Set(msg.ids.slice(0, L.mailboxItems + 1).map(String));
        for (let i = m.items.length - 1; i >= 0; i--) if (ids.has(m.items[i].id)) mbRemoveEntry(m.items[i]);
        mbTidy(conn.boxId, conn.devId);
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
      return { boxesOnline: online, deviceConnections: devices, mailboxes: mailboxCount, mailboxBytes: mailboxTotal, mailboxSources: srcs.size, connections: conns.size };
    },
    close() {
      closed = true;
      clearInterval(pruneTimer);
      for (const c of [...conns]) closeConn(c, CLOSE.shutdown, 'shutdown');
      mbBoxes.clear();
      srcs.clear();
      srcBuckets.length = 0;
      newBoxTokens.clear();
      perGroup.clear();
      perWideGroup.clear();
      revokedPerSrc.clear();
      revokedPerWide.clear();
      mbHead = null;
      mbTail = null;
      revoked.clear();
      mailboxCount = 0;
      mailboxTotal = 0;
    },
  };
}

// ── Speichergrenzen am WebSocket (Relay-Seite, Relay-Restpunkte 02.11.2026) ──
//
// Zwei Puffer liegen außerhalb der Briefkasten-Buchhaltung:
//   - Ausgang: was das Relay an eine Gegenstelle schickt und Node noch nicht an
//     den Kernel übergeben hat (Gegenstelle liest langsam oder gar nicht),
//   - Eingang: ein angefangener Rahmen — `ws` sammelt ihn bis zum Ende.
// Beide zählen je Verbindung, je Quelladresse und gesamt. Reicht der Platz
// nicht, fliegt die Verbindung mit dem größten Rückstand (erst derselben
// Quelle, dann überhaupt) — außer die anfragende ist selbst die größte. Wer
// keinen Fortschritt macht, fliegt auch: ein Rahmen muss binnen stallMs plus
// Rahmengröße / minRateBytesPerSec abgeholt bzw. fertig sein (1 MiB: 30 s +
// 64 s), unaufgeforderte Pongs halten so niemanden am Leben.
// Vor der Anmeldung sind nur kleine Rahmen erlaubt (Anmeldung < 1 KiB);
// danach setzt relay-core die Grenze der Rolle (setFrameLimit).
export const SOCKET_LIMITS = Object.freeze({
  preAuthFrameBytes: 8 * 1024,
  // Gewählter Rückstau: vier größte Rahmen samt Kopf-Pool-Anteil plus Luft
  // für Live-Werte (so viele Anfragen bearbeitet die Box je Gerät
  // gleichzeitig; eine Garantie ist das nicht — die Box erfährt nicht, wann
  // das Relay einen Rahmen los ist; ein fünfter größter Rahmen im Rückstau
  // trennt). Den Speicher begrenzen die Summen je Quelle und gesamt
  // (Gegenprüfung 67ede79a/7a5c7e49/9237ab50 P3).
  outPerConn: 4 * (1024 * 1024 + 4096 + 8192) + 256 * 1024,
  outPerRemote: 8 * 1024 * 1024,
  outTotal: 32 * 1024 * 1024,
  inPerRemote: 4 * 1024 * 1024,
  inTotal: 32 * 1024 * 1024,
  stallMs: 30_000,
  minRateBytesPerSec: 16 * 1024,
  // Steuerrahmen (Ping/Pong) je Verbindung und 10 s; Pongs auf Pings gehen
  // durch das Ausgangsbudget (autoPong aus, Gegenprüfung faf3cb0 P1).
  controlFramesPerWindow: 50,
  // Eingang: Roh-Stücke, Fragmente und die Maske des Empfängers sind Sichten
  // auf ganze Lesestücke und halten sie fest. Gezählt wird je Verbindung
  // max(zugesagte Nutzdaten, Summe der festgehaltenen Lesestücke) plus
  // chunkCost je Stück (Gegenprüfung faf3cb0 P2, 39d4427 P2). Harte Grenzen
  // setzt der WebSocketServer (WS_SERVER_OPTIONS).
  chunkCost: 256,
  // Vom Relay geschlossen: so lange darf die Gegenstelle den Abschluss
  // bestätigen, dann wird getrennt (statt 30 s `ws`-Frist ohne Zählung).
  closeGraceMs: 2_000,
});

// Optionen für jeden WebSocketServer, dessen Verbindungen der Wächter umhüllt.
export const WS_SERVER_OPTIONS = Object.freeze({ autoPong: false, maxFragments: 16, maxBufferedChunks: 4096 });

// Budget mit Haltern { key, held, since, unit(), kill() }; kill() muss synchron
// freigeben; unit() = Bytes, für die gerade die Uhr läuft.
function createBudget(total, perKey) {
  let used = 0;
  const keys = new Map(); // key → { used, holders:Set }
  const holders = new Set();
  function add(h, n) {
    if (!n) return;
    h.held += n;
    used += n;
    let k = keys.get(h.key);
    if (!k) { k = { used: 0, holders: new Set() }; keys.set(h.key, k); }
    k.used += n;
    if (h.held > 0) { holders.add(h); k.holders.add(h); return; }
    holders.delete(h);
    k.holders.delete(h);
    if (!k.holders.size) keys.delete(h.key);
  }
  function biggestOther(set, h) {
    let best = null;
    for (const x of set) if (x !== h && (!best || x.held > best.held)) best = x;
    return best;
  }
  const budget = {
    get used() { return used; },
    holders,
    take(h, n) {
      for (;;) {
        const k = keys.get(h.key);
        let scope;
        if ((k ? k.used : 0) + n > perKey) scope = k ? k.holders : new Set();
        else if (used + n > total) scope = holders;
        else break;
        const v = biggestOther(scope, h);
        if (!v || v.held <= h.held) return false;
        v.kill();
        if (v.held > 0) budget.release(v);
      }
      add(h, n);
      return true;
    },
    give(h, n) { add(h, -Math.min(n, h.held)); },
    release(h) { add(h, -h.held); },
  };
  return budget;
}

export function createSocketGuard(opts = {}) {
  const limits = { ...SOCKET_LIMITS, ...opts };
  const out = createBudget(limits.outTotal, limits.outPerRemote);
  const inb = createBudget(limits.inTotal, limits.inPerRemote);
  const timer = setInterval(() => {
    const t = Date.now();
    for (const b of [out, inb]) {
      for (const h of [...b.holders]) {
        if (h.held > 0 && t - h.since > limits.stallMs + (h.unit() * 1000) / limits.minRateBytesPerSec) h.kill();
      }
    }
  }, Math.max(25, Math.floor(limits.stallMs / 3)));
  timer.unref?.();
  const guard = {
    limits, out, in: inb,
    wrap(ws, { remote = null, pingMs } = {}) { return wrapWebSocket(ws, { pingMs, guard, remote }); },
    stats() { return { outBufferedBytes: out.used, inPartialBytes: inb.used }; },
    close() { clearInterval(timer); },
  };
  return guard;
}

// Rahmengrenze an `ws` anbringen: der Empfänger liest `_maxPayload` beim Kopf
// jedes Datenrahmens (mit der Summe der Fragmente in `_totalPayloadLength`) —
// hier wird erst geprüft und Platz belegt, bevor `ws` Nutzdaten sammelt.
// Getestet mit ws 8.22 (mobile-link-relay-sicherheit.test.js); fehlen die
// Felder, bleibt die Grenze des WebSocketServers.
function installFrameGate(ws, { getMax, inH, retarget, kill }) {
  const rcv = ws._receiver;
  if (!rcv || typeof rcv._maxPayload !== 'number' || typeof rcv._totalPayloadLength !== 'number') return false;
  const ceiling = rcv._maxPayload > 0 ? rcv._maxPayload : Infinity;
  Object.defineProperty(rcv, '_maxPayload', {
    configurable: true,
    get() {
      const max = Math.min(getMax(), ceiling);
      const need = rcv._totalPayloadLength;
      if (need > max) return max;
      if (need > inH.reserved) {
        const was = inH.reserved;
        inH.reserved = need;
        if (!retarget()) { queueMicrotask(kill); return Math.max(1, need - 1); }
        if (was === 0) inH.since = Date.now();
      }
      return max;
    },
    set() { /* fest */ },
  });
  return true;
}

// Adapter für eine `ws`-Verbindung (Server- oder Client-Seite). Pings halten
// NAT-Zuordnungen offen und erkennen tote Gegenstellen.
// Ohne Wächter (Client-Seite: Box → Relay, Test-Handy) darf je Verbindung so
// viel unterwegs sein; wer nicht liest, wird getrennt (Codex R2 P1). Auf der
// Relay-Seite gelten die engeren Grenzen des Wächters (createSocketGuard).
export const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

export function wrapWebSocket(ws, { pingMs = 25_000, maxBuffered = MAX_BUFFERED_BYTES, guard = null, remote = null } = {}) {
  let alive = true;
  let gone = false;
  let graceTimer = null;
  const timer = pingMs > 0 ? setInterval(() => {
    if (!alive) { try { ws.terminate(); } catch { /* egal */ } return; }
    alive = false;
    try { ws.ping(); } catch { /* egal */ }
  }, pingMs) : null;
  timer?.unref?.();
  // Ausgang: Größen der noch nicht abgeholten Rahmen (ws ruft die Rückmeldungen
  // in Sendereihenfolge); die Uhr läuft für den ältesten.
  const pendingSizes = [];
  const outH = { key: remote, held: 0, since: 0, unit: () => pendingSizes[0] || 0, kill: () => kill() };
  // Eingang: ein Halter je Verbindung (sonst verdrängt sie sich selbst,
  // Gegenprüfung 39d4427 P3): reserved = zugesagte Nutzdaten des laufenden
  // Rahmens (Frist läuft nur dafür), pinned = festgehaltene Lesestücke.
  const inH = {
    key: remote, held: 0, since: 0, reserved: 0, pinned: 0, pieces: 0,
    unit: () => (inH.reserved > 0 ? inH.reserved : Infinity),
    kill: () => kill(),
  };
  function releaseAll() {
    if (!guard) return;
    guard.out.release(outH);
    guard.in.release(inH);
    inH.reserved = 0;
  }
  function kill() {
    gone = true;
    releaseAll();
    try { ws.terminate(); } catch { /* egal */ }
  }
  let ctl = { start: Date.now(), n: 0 };
  function controlOk() {
    const t = Date.now();
    if (t - ctl.start >= 10_000) ctl = { start: t, n: 0 };
    ctl.n += 1;
    return ctl.n <= guard.limits.controlFramesPerWindow;
  }
  // Maske (Sicht aufs Lesestück) nach jedem fertigen Rahmen freigeben — ws
  // setzt sie vor jedem Lesen neu (Gegenprüfung 34e9bd0c/672c1753 P3).
  let afterFrame = () => {};
  ws.on('pong', () => {
    alive = true;
    if (guard && !gone && !controlOk()) { kill(); return; }
    afterFrame();
  });
  ws.on('close', () => {
    gone = true;
    clearInterval(timer);
    clearTimeout(graceTimer);
    releaseAll();
  });
  // Kaputte Rahmen, zu große Nachrichten, Abbrüche: `ws` meldet sie als
  // 'error'. Ohne Zuhörer wäre das eine unbehandelte Ausnahme und beendete den
  // ganzen Prozess (Relay bzw. DVhub) — so wird nur diese Verbindung getrennt.
  ws.on('error', () => kill());
  let frameMax = guard ? guard.limits.preAuthFrameBytes : Infinity;
  // Gezählt senden: n Bytes ins Ausgangsbudget, write(cb) schreibt. Jeder
  // wartende Rahmen zählt pauschal eine Poolgröße mit: den Rahmenkopf legt ws
  // mit allocUnsafe an, er hält ein Stück des gemeinsamen 8-KiB-Pools fest
  // (Gegenprüfung 2339cc36 P3).
  function guardedWrite(payload, write) {
    const n = payload + Buffer.poolSize;
    // Je Verbindung: ein Rahmen geht immer, darüber nur ohne Rückstau.
    if (outH.held > 0 && outH.held + n > guard.limits.outPerConn) { kill(); return; }
    const was = outH.held;
    if (!guard.out.take(outH, n)) { kill(); return; }
    if (was === 0) outH.since = Date.now();
    pendingSizes.push(payload); // Frist nach Nutzdaten
    write(() => {
      if (gone) return;
      pendingSizes.shift();
      guard.out.give(outH, n);
      outH.since = Date.now();
    });
  }
  if (guard) {
    const rcv = ws._receiver;
    // Soll-Belegung herstellen; false = kein Platz (dann fliegt die Verbindung).
    const retarget = () => {
      const want = Math.max(inH.reserved, inH.pinned) + inH.pieces * guard.limits.chunkCost;
      if (want > inH.held) return guard.in.take(inH, want - inH.held);
      if (want < inH.held) guard.in.give(inH, inH.held - want);
      return true;
    };
    installFrameGate(ws, { getMax: () => frameMax, inH, retarget, kill });
    // Festgehaltene Lesestücke nach jedem Lesen neu bewerten. Node gibt je
    // Lesen einen eigenen Puffer genau der gelesenen Größe; ws hängt sie an
    // _buffers an und verbraucht von vorn — nur _buffers[0] kann eine
    // Teilsicht sein, alle späteren sind ganze Stücke: O(1) über
    // _bufferedBytes. Dazu Fragmente (≤ maxFragments) und die Maske,
    // verschiedene ArrayBuffer einmal gezählt.
    const repin = () => {
      if (gone || !rcv) return;
      const seen = new Set();
      let bytes = 0;
      let pieces = 0;
      const note = (b) => {
        if (!b || !b.buffer) return;
        pieces += 1;
        if (seen.has(b.buffer)) return;
        seen.add(b.buffer);
        bytes += b.buffer.byteLength;
      };
      const bufs = Array.isArray(rcv._buffers) ? rcv._buffers : [];
      if (bufs.length) {
        note(bufs[0]);
        bytes += Math.max(0, (rcv._bufferedBytes || 0) - bufs[0].length);
        pieces += bufs.length - 1;
      }
      if (Array.isArray(rcv._fragments)) for (const b of rcv._fragments) note(b);
      note(rcv._mask);
      inH.pinned = bytes;
      inH.pieces = pieces;
      if (!retarget()) kill();
    };
    ws._socket?.on('data', repin);
    // Nachricht vollständig: der angefangene Rahmen ist keiner mehr, und die
    // Maske (Sicht aufs letzte Lesestück) wird nicht mehr gebraucht — ws setzt
    // sie vor jedem Lesen neu (getMask vor getData). Sonst hielte jede ruhende
    // Verbindung ihr letztes Lesestück (Gegenprüfung 34e9bd0c P3).
    afterFrame = () => {
      if (rcv && '_mask' in rcv) rcv._mask = undefined;
      queueMicrotask(repin);
    };
    ws.on('message', () => {
      inH.reserved = 0;
      afterFrame();
    });
    // Pings selbst beantworten (autoPong aus): Pong durchs Ausgangsbudget,
    // Steuerrahmen begrenzt — sonst wächst der Schreibpuffer eines Nicht-Lesers
    // an allen Grenzen vorbei (Gegenprüfung faf3cb0 P1).
    ws.on('ping', (data) => {
      if (gone) return;
      if (!controlOk()) { kill(); return; }
      afterFrame();
      if (ws.readyState !== 1) return;
      // Eigene Kopie: `data` ist eine Sicht auf das ganze Lesestück (bis
      // 64 KiB) und hielte es fest, solange der Pong wartet (Gegenprüfung
      // 17fede38 P2). Den Pool-Anteil des Rahmenkopfs zählt guardedWrite.
      const copy = Buffer.allocUnsafeSlow(data.length);
      data.copy(copy);
      guardedWrite(copy.length + 2, (cb) => ws.pong(copy, undefined, cb));
    });
  } else if (ws._autoPong === false) {
    ws.on('ping', (data) => { try { ws.pong(data); } catch { /* egal */ } });
  }
  return {
    send: (text) => {
      if (gone || ws.readyState !== 1) return;
      if (!guard) {
        if (ws.bufferedAmount > maxBuffered) { kill(); return; }
        ws.send(text);
        return;
      }
      guardedWrite(Buffer.byteLength(text), (cb) => ws.send(text, cb));
    },
    close: (code, reason) => {
      try { ws.close(code, reason); } catch { /* egal */ }
      if (guard && !gone && !graceTimer) {
        frameMax = guard.limits.preAuthFrameBytes;
        graceTimer = setTimeout(() => kill(), guard.limits.closeGraceMs);
        graceTimer.unref?.();
      }
    },
    setFrameLimit: (n) => { if (guard && !gone && !graceTimer) frameMax = n; },
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
