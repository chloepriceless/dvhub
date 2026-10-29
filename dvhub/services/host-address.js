// services/host-address.js — Einordnung von Ziel-Hosts für die SSRF-Prüfungen.
//
// Strix-Fund 29.10.2026: Die bisherigen Prüfungen kannten nur IPv4 in
// Punktschreibweise. new URL() liefert IPv6 aber in Klammern („[::1]“) und
// IPv4-gemappte Adressen als Hex („[::ffff:7f00:1]“); dazu galten 127.x außer
// 127.0.0.1, 0.0.0.0 und 169.254/16 (Metadaten-Dienst in Clouds) als
// öffentlich. Hier steht die eine Definition von „intern“ für alle Prüfungen.
//
// classifyHost(host) → 'loopback' | 'private' | 'linklocal' | 'unspecified'
//                    | 'public' | 'name' | 'invalid'
//   host: URL.hostname oder eine eingetippte Adresse (mit/ohne Klammern,
//   Zone „%eth0“ bzw. „%25eth0“, abschließender Punkt).

function ipv4Parts(s) {
  const parts = s.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return null;
  const n = parts.map(Number);
  return n.every((x) => x <= 255) ? n : null;
}

function classifyIpv4([a, b]) {
  if (a === 127) return 'loopback';
  if (a === 0) return 'unspecified';
  if (a === 169 && b === 254) return 'linklocal';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
  return 'public';
}

// Acht 16-Bit-Zahlen; eingebettete IPv4 am Ende („::ffff:1.2.3.4“) erlaubt.
function ipv6Hextets(s) {
  let str = s;
  let tail4 = [];
  if (str.includes('.')) {
    const cut = str.lastIndexOf(':');
    const v4 = ipv4Parts(str.slice(cut + 1));
    if (!v4) return null;
    tail4 = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    str = `${str.slice(0, cut + 1)}0:0`;
  }
  const halves = str.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  const out = all.map((x) => (/^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : NaN));
  if (out.length !== 8 || !out.every(Number.isInteger)) return null;
  if (tail4.length) out.splice(6, 2, ...tail4);
  return out;
}

export function classifyHost(host) {
  let h = String(host ?? '').trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  h = h.replace(/%(25)?[^%]*$/, '');                     // IPv6-Zone
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (!h) return 'invalid';
  if (h === 'localhost' || h.endsWith('.localhost')) return 'loopback';

  if (h.includes(':')) {
    const x = ipv6Hextets(h);
    if (!x) return 'invalid';
    if (x.every((v) => v === 0)) return 'unspecified';
    if (x.slice(0, 7).every((v) => v === 0) && x[7] === 1) return 'loopback';
    if (x.slice(0, 5).every((v) => v === 0) && x[5] === 0xffff) {   // ::ffff:a.b.c.d
      return classifyIpv4([x[6] >> 8, x[6] & 0xff, x[7] >> 8, x[7] & 0xff]);
    }
    if ((x[0] & 0xffc0) === 0xfe80) return 'linklocal';
    if ((x[0] & 0xfe00) === 0xfc00) return 'private';                // ULA
    return 'public';
  }

  if (/^[\d.]+$/.test(h)) {
    const v4 = ipv4Parts(h);
    return v4 ? classifyIpv4(v4) : 'invalid';
  }
  return 'name';
}

/** Sperrliste: alles, wohin eine Anfrage von außen nicht zeigen darf (unklare Angaben eingeschlossen). */
export function isInternalHost(host) {
  return !['public', 'name'].includes(classifyHost(host));
}

/** Freigabe: nur die Box selbst und das Heimnetz (kein link-local, keine 0-Adresse). */
export function isPrivateOrLoopbackHost(host) {
  return ['loopback', 'private'].includes(classifyHost(host));
}

/**
 * Hostname für http.request(): URL.hostname liefert IPv6 in Klammern
 * („[::1]“), http.request() erwartet die Adresse ohne — mit Klammern sucht es
 * einen DNS-Namen (ENOTFOUND).
 */
export function requestHostname(hostname) {
  const h = String(hostname ?? '');
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}
