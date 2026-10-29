// services/mobile-link/permissions.js — was ein gekoppeltes Handy darf.
//
// Anfragen aus der App laufen über die eigene HTTP-Schnittstelle der Box
// (Loopback, dieselben Wächter wie im Browser). Weil Loopback jede Prüfung
// passiert, entscheidet allein diese Liste: „Anzeigen“ = ausgewählte lesende
// Endpunkte, „Steuern“ zusätzlich wenige Schalt-Endpunkte. Konfiguration,
// Admin, Sicherungen, Exporte und Kopplungen bleiben dem Browser vorbehalten.

export const PERMS = Object.freeze(['read', 'control']);

export const READ_PATHS = new Set([
  '/api/status',
  '/api/costs',
  '/api/optimizer/status',
  '/api/ev',
  '/api/forecast',
  '/api/schedule',
  '/api/eos/plan',
  '/api/eos/status',
  '/api/storage/status',
  '/api/feed-in-cap/status',
  '/api/family/status',
  '/api/family/tile-history',
  '/api/family/tesla-history',
  '/api/telemetry/series',
  '/api/history/summary',
  '/api/history/mispel',
  '/api/eeg/extension',
  '/api/integrations/health',
  '/api/integrations/dataflow',
  '/api/victron/devices',
  '/api/devices',
  '/api/vpn/status',
]);

const READ_PREFIXES = ['/api/history/viz/'];

export const CONTROL_PATHS = new Set([
  '/api/control/stop',
  '/api/control/resume',
  '/api/control/write',
  '/api/ev',
  '/api/schedule/rules/toggle',
  '/api/schedule/automation/replan',
]);

export function normalizePerms(list) {
  const set = new Set((Array.isArray(list) ? list : []).filter((p) => PERMS.includes(p)));
  set.add('read');
  return PERMS.filter((p) => set.has(p));
}

// → { ok: true, path, search } oder { ok: false, status, error }
export function checkRequest(perms, method, rawPath) {
  const m = String(method || '').toUpperCase();
  if (typeof rawPath !== 'string' || !rawPath.startsWith('/api/') || rawPath.length > 2048) {
    return { ok: false, status: 400, error: 'bad_path' };
  }
  let u;
  try { u = new URL(rawPath, 'http://box.invalid'); } catch { return { ok: false, status: 400, error: 'bad_path' }; }
  // Keine Umwege über ../, %2e, doppelte Schrägstriche: der normalisierte Pfad
  // muss genau dem angefragten entsprechen.
  if (u.origin !== 'http://box.invalid' || u.pathname !== rawPath.split('?')[0] || u.pathname.includes('//')) {
    return { ok: false, status: 400, error: 'bad_path' };
  }
  const p = u.pathname;
  if (m === 'GET') {
    if (READ_PATHS.has(p) || READ_PREFIXES.some((x) => p.startsWith(x))) return { ok: true, path: p, search: u.search };
    return { ok: false, status: 403, error: 'forbidden' };
  }
  if (m === 'POST') {
    if (!CONTROL_PATHS.has(p)) return { ok: false, status: 403, error: 'forbidden' };
    if (!perms.includes('control')) return { ok: false, status: 403, error: 'control_not_allowed' };
    return { ok: true, path: p, search: u.search };
  }
  return { ok: false, status: 405, error: 'method_not_allowed' };
}
