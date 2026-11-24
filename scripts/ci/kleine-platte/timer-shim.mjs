// scripts/ci/kleine-platte/timer-shim.mjs — NUR für den E2E-Test „kleine Platte“.
//
// Wird per NODE_OPTIONS=--import in den DVhub-Container geladen und verkürzt
// ausschließlich Zeitgeber, die aus einer Datei der Speicher-Wache oder der
// Datenstufen stammen (Dateiname mit „storage“, „speicher“ oder „telemetry-tier“,
// außerhalb von node_modules; anpassbar über KP_SHIM_MATCH, ein RegExp-Teil).
// Die Wache prüft im Betrieb erst 5 min nach dem Start und dann alle 30 min —
// der Test soll nicht 30 min warten. Der Code unter Test bleibt unverändert.
//
//   KP_SHIM_FIRST_MS     ersetzt einmalige Wartezeiten (setTimeout) ≥ 60 s
//   KP_SHIM_INTERVAL_MS  ersetzt Takte (setInterval) ≥ 60 s
//
//   KP_SHIM_GATE        Datei: solange sie fehlt, laufen Rückrufe aus Dateien nach
//                       KP_SHIM_GATE_MATCH (Standard storage|speicher) nicht — der Test
//                       stellt erst den Füllstand ein und gibt die Wache dann frei.
//                       Die Datenstufen (telemetry-tier) laufen ungebremst.
//
// Jede Verkürzung steht einmal als Zeile „[kp-shim] …“ auf stderr (docker logs),
// damit der Bericht zeigen kann, ob die Wache überhaupt beschleunigt wurde.
import { existsSync } from 'node:fs';

const FIRST = Number(process.env.KP_SHIM_FIRST_MS || 0);
const EVERY = Number(process.env.KP_SHIM_INTERVAL_MS || 0);
const MATCH = new RegExp(`(${process.env.KP_SHIM_MATCH || 'storage|speicher|telemetry-tier'})[^/\\\\]*\\.(m?js|cjs)`, 'i');
const seen = new Set();
const GATE = process.env.KP_SHIM_GATE || '';
const GATE_MATCH = new RegExp(`(${process.env.KP_SHIM_GATE_MATCH || 'storage|speicher'})[^/\\\\]*\\.(m?js|cjs)`, 'i');
let gateLogged = false;
function gated(fn, where) {
  if (!GATE || typeof fn !== 'function' || !GATE_MATCH.test(where)) return fn;
  return function gatedCallback(...a) {
    if (!existsSync(GATE)) {
      if (!gateLogged) { gateLogged = true; process.stderr.write(`[kp-shim] Lauf übersprungen, bis ${GATE} existiert (${where})\n`); }
      return undefined;
    }
    return fn.apply(this, a);
  };
}

function callerFile() {
  const lines = String(new Error().stack || '').split('\n').slice(2);
  for (const l of lines) {
    if (l.includes('timer-shim.mjs') || l.includes('node_modules') || l.includes('node:')) continue;
    const m = l.match(MATCH);
    if (m) return l.trim();
    // Erste fremde Datei gefunden, aber keine Wache: nicht verkürzen.
    if (/\.(m?js|cjs):\d+/.test(l)) return null;
  }
  return null;
}

function wrap(orig, replacement, kind) {
  if (!(replacement > 0)) return orig;
  return function patched(fn, delay, ...args) {
    if (typeof delay === 'number' && delay >= 60_000) {
      const where = callerFile();
      if (where) {
        const key = `${kind}:${delay}:${where}`;
        if (!seen.has(key)) {
          seen.add(key);
          process.stderr.write(`[kp-shim] ${kind} ${delay} ms -> ${replacement} ms (${where})\n`);
        }
        return orig.call(this, gated(fn, where), replacement, ...args);
      }
    }
    return orig.call(this, fn, delay, ...args);
  };
}

globalThis.setTimeout = wrap(globalThis.setTimeout, FIRST, 'setTimeout');
globalThis.setInterval = wrap(globalThis.setInterval, EVERY, 'setInterval');
