// runtime-info.js — worauf läuft DVhub? Docker-Container oder native
// Installation, und welches Betriebssystem.
//
// Wichtig für Support und Portal: Ein Container wird nicht klassisch
// aktualisiert (kein git/apt), sondern durch ein neues Image ersetzt. Die
// Anzeige steht deshalb neben der Version (DVhub-Oberfläche und Portal).
//
// Erkennung:
//   container — DVHUB_RUNTIME=container (setzt unser Dockerfile) oder /.dockerenv
//   native    — alles andere; läuft die native Installation selbst in einem
//               LXC/systemd-nspawn-Container, steht das in `virt` (z. B. "lxc").
// Betriebssystem aus /etc/os-release (PRETTY_NAME). Im Container ist das das
// Basis-Image, nicht der Host — `os` wird dann nur ergänzend gezeigt.

import fs from 'node:fs';
import os from 'node:os';

function readOsRelease(fsImpl) {
  for (const p of ['/etc/os-release', '/usr/lib/os-release']) {
    try {
      const text = String(fsImpl.readFileSync(p, 'utf8'));
      const m = /^PRETTY_NAME=(.*)$/m.exec(text);
      if (m) return m[1].trim().replace(/^["']|["']$/g, '').slice(0, 80) || null;
    } catch { /* nächste Datei */ }
  }
  return null;
}

function readVirt(fsImpl) {
  // systemd schreibt die Container-Art beim Start nach /run/systemd/container.
  try {
    const v = String(fsImpl.readFileSync('/run/systemd/container', 'utf8')).trim();
    if (/^[a-z0-9-]{1,32}$/.test(v)) return v;
  } catch { /* kein systemd-Container */ }
  return null;
}

/**
 * @returns {{kind:'container'|'native', label:string, os:string|null, arch:string, virt:string|null}}
 */
export function detectRuntime({ env = process.env, fsImpl = fs, platform = process.platform, arch = process.arch } = {}) {
  let dockerenv = false;
  try { dockerenv = fsImpl.existsSync('/.dockerenv'); } catch { /* egal */ }
  const isContainer = env.DVHUB_RUNTIME === 'container' || dockerenv;
  const osName = platform === 'linux' ? readOsRelease(fsImpl) : `${platform} ${os.release?.() || ''}`.trim();
  const virt = isContainer ? null : (platform === 'linux' ? readVirt(fsImpl) : null);
  let label;
  if (isContainer) label = 'Docker-Container';
  else label = (osName || platform) + (virt ? ` (${virt.toUpperCase()})` : '');
  return { kind: isContainer ? 'container' : 'native', label, os: osName, arch, virt };
}

let cached = null;
/** Einmal je Prozess ermitteln — ändert sich zur Laufzeit nicht. */
export function runtimeInfo() {
  if (!cached) cached = detectRuntime();
  return cached;
}
