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

import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { outboundLookup } from './host-address.js';

// Obergrenze für text()/json() — schützt vor riesigen Antworten. Wer kleiner
// begrenzen will, liest body selbst (readJsonCapped: 1 MB).
const MAX_TEXT_BYTES = 32 * 1024 * 1024;

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
 * @param {{ lookup?: Function }} [opts] lookup: dns.lookup-kompatibel mit Prüfung (Tests)
 * @returns {(input: string|URL, init?: {method?: string, headers?: object, body?: string|Buffer, signal?: AbortSignal}) => Promise<object>}
 */
export function createOutboundFetch({ lookup = outboundLookup } = {}) {
  return function fetchChecked(input, init = {}) {
    return new Promise((resolve, reject) => {
      let u;
      try { u = new URL(String(input)); } catch { reject(new TypeError('invalid_url')); return; }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') { reject(new TypeError('unsupported_protocol')); return; }
      const signal = init.signal || null;
      if (signal?.aborted) { reject(signal.reason || new Error('aborted')); return; }
      const payload = init.body == null ? null : (Buffer.isBuffer(init.body) ? init.body : Buffer.from(String(init.body), 'utf8'));
      const headers = { ...(init.headers || {}) };
      if (payload) headers['Content-Length'] = payload.length;
      const mod = u.protocol === 'https:' ? https : http;
      let settled = false;
      const req = mod.request(u, { method: init.method || 'GET', headers, lookup, agent: false }, (res) => {
        settled = true;
        const status = res.statusCode || 0;
        let used = false;
        const take = () => {
          if (used) throw new TypeError('body_already_used');
          used = true;
          return res;
        };
        const readText = () => new Promise((ok, fail) => {
          let stream;
          try { stream = take(); } catch (e) { fail(e); return; }
          const chunks = [];
          let total = 0;
          stream.on('data', (c) => {
            total += c.length;
            if (total > MAX_TEXT_BYTES) { stream.destroy(new Error('response_too_large')); return; }
            chunks.push(c);
          });
          stream.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
          stream.on('error', fail);
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
