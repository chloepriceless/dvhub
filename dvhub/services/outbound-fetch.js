// services/outbound-fetch.js — fetch-ähnlicher Abruf mit Namensprüfung beim
// Verbinden (1.0.10, Rest aus 1.0.9).
//
// Wie der ntfy-Kanal (Gesamtprüfung 1.0.9, Hauptbefund 10): http(s).request
// mit outboundLookup statt fetch. Ein Name wird beim Verbindungsaufbau
// aufgelöst, jede Adresse geprüft (nichts auf der Box selbst, kein
// link-local, keine 0-Adresse) und genau zu einer geprüften Adresse
// verbunden — kein zweites Auflösen (DNS-Rebinding). Die Prüfung beim
// Speichern (isInternalHost) sieht nur Adressen in Ziffern; ein Name wie
// 127.0.0.1.nip.io oder der eigene Hostname kam bisher durch.
//
// Genutzt für Ziele aus der Config: EPEX-priceApiUrl (Preise, Zonen, Lücken,
// Nachimport, zentrale Marktwerte) und den Uptime-Kuma-Push.
//
// Antwort wie fetch, soweit DVhub sie nutzt: ok, status, url, headers.get(),
// text(), json(), body (Web-Stream, z. B. readJsonCapped). Umleitungen werden
// nicht verfolgt (wie ntfy) — ein 3xx kommt als Antwort zurück. Keine
// wiederverwendete Verbindung (agent: false): jede Anfrage prüft neu.
// Wie natives fetch: eine Frist auch ohne signal (Kopf und Body, sonst hinge
// etwa der Preis-Nachimport an einem stockenden Server) und entpackte
// Antworten bei Content-Encoding gzip/deflate/br (Codex 52880aea, 2× P2).

import http from 'node:http';
import https from 'node:https';
import { Readable, pipeline } from 'node:stream';
import zlib from 'node:zlib';
import { outboundLookup } from './host-address.js';

// Obergrenze für text()/json() — schützt vor riesigen Antworten. Wer kleiner
// begrenzen will, liest body selbst (readJsonCapped: 1 MB).
const MAX_TEXT_BYTES = 32 * 1024 * 1024;
// Frist ohne eigenes signal: ganze Anfrage samt Body.
const DEFAULT_TIMEOUT_MS = 60_000;

// Content-Encoding → Entpacker (wie fetch); unbekannt/identity → roh.
function decoderFor(encoding) {
  const e = String(encoding || '').trim().toLowerCase();
  if (e === 'gzip' || e === 'x-gzip') return zlib.createGunzip();
  if (e === 'deflate') return zlib.createInflate();
  if (e === 'br') return zlib.createBrotliDecompress();
  return null;
}

function headerGetter(raw) {
  return {
    get(name) {
      const v = raw[String(name).toLowerCase()];
      if (v == null) return null;
      return Array.isArray(v) ? v.join(', ') : String(v);
    },
  };
}

/**
 * @param {{ lookup?: Function, timeoutMs?: number }} [opts] lookup: dns.lookup-kompatibel mit
 *   Prüfung (Tests); timeoutMs: Frist, wenn der Aufrufer kein signal mitgibt (0 = keine)
 * @returns {(input: string|URL, init?: {method?: string, headers?: object, body?: string|Buffer, signal?: AbortSignal}) => Promise<object>}
 */
export function createOutboundFetch({ lookup = outboundLookup, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return function fetchChecked(input, init = {}) {
    return new Promise((resolve, reject) => {
      let u;
      try { u = new URL(String(input)); } catch { reject(new TypeError('invalid_url')); return; }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') { reject(new TypeError('unsupported_protocol')); return; }
      const signal = init.signal || (timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : null);
      if (signal?.aborted) { reject(signal.reason || new Error('aborted')); return; }
      const payload = init.body == null ? null : (Buffer.isBuffer(init.body) ? init.body : Buffer.from(String(init.body), 'utf8'));
      const headers = { ...(init.headers || {}) };
      if (payload) headers['Content-Length'] = payload.length;
      const mod = u.protocol === 'https:' ? https : http;
      let settled = false;
      const req = mod.request(u, { method: init.method || 'GET', headers, lookup, agent: false }, (res) => {
        settled = true;
        const status = res.statusCode || 0;
        // Fehler des Bodys festhalten — auch ungelesen (Kuma, Antworten ≠ 2xx)
        // darf ein kaputter oder abgebrochener Body DVhub nicht beenden; ein
        // späteres Lesen bekommt den Fehler (Codex 5b41e32e, P1).
        let bodyError = null;
        const remember = (e) => { if (!bodyError) bodyError = e || new Error('aborted'); };
        res.on('error', remember);
        // Entpacken vor jedem Lesen; Größengrenzen gelten für die entpackten
        // Bytes. pipeline gibt Fehler und Abbruch in beide Richtungen weiter:
        // bricht der Leser den entpackten Body ab (readJsonCapped, Größengrenze),
        // schließt auch die Verbindung (Codex 5b41e32e, P2).
        const dec = decoderFor(res.headers?.['content-encoding']);
        let src = res;
        if (dec) {
          dec.on('error', remember);
          src = pipeline(res, dec, (e) => { if (e) remember(e); });
        }
        let used = false;
        const take = () => {
          if (used) throw new TypeError('body_already_used');
          used = true;
          return src;
        };
        const readText = () => new Promise((ok, fail) => {
          let stream;
          try { stream = take(); } catch (e) { fail(e); return; }
          if (bodyError || stream.destroyed) { fail(bodyError || new Error('aborted')); return; }
          const chunks = [];
          let total = 0;
          stream.on('data', (c) => {
            total += c.length;
            if (total > MAX_TEXT_BYTES) { stream.destroy(new Error('response_too_large')); return; }
            chunks.push(c);
          });
          let ended = false;
          stream.on('end', () => { ended = true; ok(Buffer.concat(chunks).toString('utf8')); });
          stream.on('error', (e) => fail(bodyError || e));
          // Abbruch (Frist) ohne error-Ereignis: nicht ewig warten.
          stream.on('close', () => { if (!ended) fail(bodyError || new Error('aborted')); });
        });
        let web = null;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          url: u.href,
          redirected: false,
          headers: headerGetter(res.headers || {}),
          get body() {
            if (!web) web = Readable.toWeb(take());
            return web;
          },
          text: readText,
          async json() { return JSON.parse(await readText()); },
        });
      });
      const onAbort = () => req.destroy(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => { if (signal) signal.removeEventListener('abort', onAbort); });
      req.on('error', (e) => { if (!settled) reject(e); });
      req.end(payload || undefined);
    });
  };
}

export const outboundFetch = createOutboundFetch();
