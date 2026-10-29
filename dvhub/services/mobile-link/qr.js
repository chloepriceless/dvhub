// services/mobile-link/qr.js — Inhalt und Bild des Kopplungs-QR-Codes.
//
// Inhalt (knapp, damit der Code locker bleibt und sich vom Bildschirm gut
// scannen lässt):
//   dvhub://pair?v=1&b=<Box-Schlüssel>&s=<Geheimnis>&e=<Ablauf Unix-s>
//                &n=<Name>&l=<host:port,host:port>&r=<Relay-URL>
// Die Kamera-App öffnet damit direkt die DVhub-App. `l` (Heimnetz) und `r`
// (Relay) können fehlen. Aus `host:port` wird ws://host:port/api/mobile-link/ws.

import qrcode from 'qrcode-generator';
import { b64u, fromB64u, PROTOCOL_VERSION } from './crypto.js';

export const QR_PREFIX = 'dvhub://pair?';
export const LAN_PATH = '/api/mobile-link/ws';
const HOST_RE = /^[A-Za-z0-9.\-[\]:]{1,255}$/;

export function lanUrl(host) {
  return `ws://${host}${LAN_PATH}`;
}

export function buildPairPayload({ boxPublicRaw, secret, name, lan = [], relay = null, expSec }) {
  const q = new URLSearchParams();
  q.set('v', String(PROTOCOL_VERSION));
  q.set('b', b64u(boxPublicRaw));
  q.set('s', b64u(secret));
  q.set('e', String(expSec));
  q.set('n', String(name || 'DVhub').slice(0, 40));
  const hosts = lan.filter((h) => HOST_RE.test(h)).slice(0, 2);
  if (hosts.length) q.set('l', hosts.join(','));
  if (relay) q.set('r', relay);
  return QR_PREFIX + q.toString();
}

export function parsePairPayload(text) {
  if (typeof text !== 'string' || !text.startsWith(QR_PREFIX)) throw new Error('not_a_pairing_code');
  const q = new URLSearchParams(text.slice(QR_PREFIX.length));
  if (q.get('v') !== String(PROTOCOL_VERSION)) throw new Error('version_unsupported');
  const relay = q.get('r');
  return {
    boxPublicRaw: fromB64u(q.get('b') || '', 65),
    secret: fromB64u(q.get('s') || '', 32),
    name: q.get('n') || '',
    lan: (q.get('l') || '').split(',').filter((h) => HOST_RE.test(h)).map(lanUrl),
    relay: relay && /^wss?:\/\//.test(relay) ? relay : null,
    expSec: Number(q.get('e')) || 0,
  };
}

// SVG ohne Skript, ohne externe Ressourcen — passt in die CSP der Oberfläche.
export function qrSvg(text) {
  const q = qrcode(0, 'M');
  q.addData(text, 'Byte');
  q.make();
  // Eigener Pfad mit waagrechten Läufen statt einem Teilpfad je Modul
  // (createSvgTag) — ein Viertel der Größe.
  const n = q.getModuleCount();
  const margin = 4;
  let d = '';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!q.isDark(y, x)) continue;
      let run = 1;
      while (x + run < n && q.isDark(y, x + run)) run++;
      d += `M${x + margin} ${y + margin}h${run}v1h-${run}z`;
      x += run - 1;
    }
  }
  const size = n + margin * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">`
    + `<rect width="${size}" height="${size}" fill="#fff"/><path fill="#000" d="${d}"/></svg>`;
}
