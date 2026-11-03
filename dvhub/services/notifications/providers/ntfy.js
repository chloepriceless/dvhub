// services/notifications/providers/ntfy.js -- ntfy.sh provider (Phase 09.4 D-07).
// HTTP POST to an ntfy topic URL (zero npm deps). 10s timeout.
// cfg.topicUrl is the full topic URL (ntfy.sh hosted OR self-hosted base) — D-07.
// Modelled on providers/telegram.js. notify() never throws — returns {ok} shape.
//
// Gesamtprüfung 1.0.9 (Hauptbefund 10): http(s).request mit outboundLookup
// statt fetch — ein Name wird beim Verbindungsaufbau aufgelöst, jede Adresse
// geprüft (nichts auf der Box selbst, kein link-local) und genau zu einer
// geprüften Adresse verbunden. Adressen in Ziffern prüft schon
// isAllowedOutboundUrl (createProviderFromConfig bzw. die Route).

import http from 'node:http';
import https from 'node:https';
import { outboundLookup } from '../../host-address.js';

const TIMEOUT_MS = 10_000;

function post(topicUrl, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(topicUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('unsupported_protocol');
    const payload = Buffer.from(body || '', 'utf8');
    const mod = u.protocol === 'https:' ? https : http;
    // agent:false — keine wiederverwendete Verbindung, jede Anfrage prüft neu.
    // Umleitungen folgt http.request nicht (Gegenprüfung edeb17db, P3).
    const req = mod.request(u, {
      method: 'POST',
      headers: { ...headers, 'Content-Length': payload.length },
      lookup: outboundLookup,
      agent: false,
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
      res.on('error', reject);
    });
    const timer = setTimeout(() => req.destroy(new Error('timeout')), timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end(payload);
  });
}

/**
 * Create an ntfy.sh notification provider.
 *
 * @param {object} cfg - { topicUrl, token? }
 *   topicUrl is the full topic URL (e.g. "https://ntfy.sh/dvhub-alerts" or a
 *   self-hosted "https://ntfy.example.com/dvhub"). It doubles as the
 *   self-hosted switch (D-07) — do NOT split it into base + topic.
 * @returns {{ type: string, notify: function }}
 */
export function createNtfyProvider(cfg) {
  const { topicUrl, token } = cfg;
  if (typeof topicUrl !== 'string' || !topicUrl.trim()) throw new Error('ntfy provider requires topicUrl');

  async function notify({ level, title, body } = {}) {
    try {
      const headers = {
        'Title': title || 'DVhub',
        'Priority': level === 'critical' ? '5' : '3',   // 5=urgent, 3=default
        'Tags': level === 'critical' ? 'warning' : 'information_source'
      };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const status = await post(topicUrl, headers, body, TIMEOUT_MS);
      if (status >= 200 && status < 300) return { ok: true };
      return { ok: false, error: `HTTP ${status}` };
    } catch (err) {
      return { ok: false, error: err.message || 'Unknown error' };
    }
  }

  return { type: 'ntfy', notify };
}
