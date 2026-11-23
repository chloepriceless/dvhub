// services/storage-mounts.js — welche Datenträger DVhub betreffen, wie voll sie
// sind und wie schnell sie wachsen (Speicher-Konzept 23.11.2026, Schritt 2).
//
// Bis 1.0.12 maß die Platz-Wache nur das DVhub-Datenverzeichnis. Liegt die
// Datenbank auf einer eigenen Partition (Kundenfall: „6 GB für DVhub“), sah sie
// die falsche Platte. Jetzt je Rolle:
//   db      Platte der PostgreSQL-Daten (maßgeblich)
//           nativ:  `SHOW data_directory` über sudo -u postgres psql
//                   (sudoers-Regel aus install.sh), dann statfs
//           Docker: Volume dvhub-db read-only unter /run/dvhub-dbvol
//                   (docker/compose.yml, S6 b); fehlt der Mount (alte
//                   compose.yml), gilt die Platte der Docker-Wurzel (S6 a,
//                   assumed: true)
//   data    DVhub-Datenverzeichnis
//   system  `/` (im Container: das Overlay = Platte der Docker-Wurzel)
//   logs    /var/log (nur nativ; journald)
// Dieselbe Platte zählt einmal (st_dev), mit allen Rollen.
//
// Wachstum: ein Messpunkt je Tag in ${DATA_DIR}/storage-samples.json (belegter
// Platz je Rolle + Datenbankgröße), daraus MB/Tag über bis zu 7 Tage. Bewusst
// eine Datei statt einer Tabelle: misst auch, wenn die Datenbank klemmt, und
// braucht keine Migration.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildPsqlArgs } from './db-backup.js';

export const SAMPLES_FILE = 'storage-samples.json';
export const DEFAULT_DB_VOLUME_DIR = '/run/dvhub-dbvol';
const MAX_SAMPLES = 35;
const MB = 1048576;
const ROLE_ORDER = ['db', 'data', 'system', 'logs'];

/** Pfade je Rolle. pgDataDir: Ergebnis von SHOW data_directory (nativ) oder null. */
export function mountCandidates({ container = false, dataDir, pgDataDir = null, dbVolumeDir = DEFAULT_DB_VOLUME_DIR, exists = fs.existsSync } = {}) {
  const out = [];
  if (container) {
    if (dbVolumeDir && exists(dbVolumeDir)) out.push({ role: 'db', path: dbVolumeDir });
    else out.push({ role: 'db', path: '/', assumed: true });
  } else if (pgDataDir) {
    out.push({ role: 'db', path: pgDataDir });
  }
  if (dataDir) out.push({ role: 'data', path: dataDir });
  out.push({ role: 'system', path: '/' });
  if (!container) out.push({ role: 'logs', path: '/var/log' });
  return out;
}

// statfs-Kennung von overlayfs (Docker-Wurzel im Container).
const OVERLAYFS_MAGIC = 0x794c7630;

/**
 * statfs auf den Pfad. Geht das nicht, den nächsten Elternordner — aber nur,
 * wenn stat() belegt, dass er auf DERSELBEN Platte liegt (gleiches st_dev);
 * sonst null. Ein Elternordner auf einer anderen Platte darf nie als
 * Datenbank-Platte gelten (Codex 38d2f56d, P1). statfs/stat brauchen kein
 * Leserecht auf den Ordner selbst, nur auf die Ordner davor — ein 0700-
 * Datenverzeichnis von postgres lässt sich direkt messen.
 */
export function statPath(p, { statfs = (x) => fs.statfsSync(x), stat = (x) => fs.statSync(x) } = {}) {
  const want = path.resolve(String(p || '/'));
  let wantDev = null;
  try { wantDev = String(stat(want).dev); } catch { /* unbekannt */ }
  let cur = want;
  for (;;) {
    try {
      const s = statfs(cur);
      let dev = null;
      try { dev = String(stat(cur).dev); } catch { /* ohne dev: nach Pfad zusammenfassen */ }
      if (cur !== want && (wantDev == null || dev !== wantDev)) return null;
      const totalMb = Math.round((Number(s.blocks) * Number(s.bsize)) / MB);
      const freeMb = Math.round((Number(s.bavail) * Number(s.bsize)) / MB);
      return {
        measuredPath: cur, dev, totalMb, freeMb, freePct: totalMb > 0 ? Math.round((freeMb / totalMb) * 1000) / 10 : null,
        overlay: Number(s.type) === OVERLAYFS_MAGIC, blocks: Number(s.blocks), bsize: Number(s.bsize),
      };
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return null;
      cur = up;
    }
  }
}

/** Alle Rollen messen und je Datenträger zusammenfassen. */
export function measureMounts(candidates, deps = {}) {
  const byKey = new Map();
  for (const c of candidates || []) {
    const m = statPath(c.path, deps);
    if (!m) continue;
    const key = m.dev ?? `path:${m.measuredPath}`;
    const hit = byKey.get(key);
    if (hit) {
      if (!hit.roles.includes(c.role)) hit.roles.push(c.role);
      if (!hit.paths.includes(c.path)) hit.paths.push(c.path);
      if (c.assumed && c.role === 'db') hit.dbAssumed = true;
      continue;
    }
    byKey.set(key, {
      key, roles: [c.role], paths: [c.path], totalMb: m.totalMb, freeMb: m.freeMb, freePct: m.freePct,
      usedMb: Math.max(0, m.totalMb - m.freeMb), ...(c.assumed && c.role === 'db' ? { dbAssumed: true } : {}),
      _overlay: m.overlay, _blocks: m.blocks, _bsize: m.bsize,
    });
  }
  // Docker overlay2: `/` im Container hat eine eigene Geräte-Nummer, liegt aber
  // auf derselben Platte wie die Volumes (Codex 38d2f56d, P2). overlayfs meldet
  // die Zahlen der Platte darunter — gleiche Blockzahl und -größe, freier Platz
  // bis auf 1 % gleich → dieselbe Platte.
  const groups = [...byKey.values()];
  for (const o of groups.filter((g) => g._overlay)) {
    const twin = groups.find((g) => g !== o && !g._merged && !g._overlay && g._blocks === o._blocks && g._bsize === o._bsize
      && Math.abs(g.freeMb - o.freeMb) <= Math.max(1, g.totalMb * 0.01));
    if (!twin) continue;
    for (const r of o.roles) if (!twin.roles.includes(r)) twin.roles.push(r);
    for (const p of o.paths) if (!twin.paths.includes(p)) twin.paths.push(p);
    if (o.dbAssumed) twin.dbAssumed = true;
    o._merged = true;
  }
  const rank = (mnt) => Math.min(...mnt.roles.map((r) => ROLE_ORDER.indexOf(r)));
  return groups.filter((g) => !g._merged)
    .map(({ _overlay, _blocks, _bsize, _merged, ...g }) => { void _overlay; void _blocks; void _bsize; void _merged; return g; })
    .sort((a, b) => rank(a) - rank(b));
}

/** Datenträger einer Rolle (oder null). */
export function mountFor(mounts, role) {
  return (mounts || []).find((m) => m.roles.includes(role)) || null;
}

/**
 * PostgreSQL-Datenverzeichnis (nativ) als postgres abfragen. Nie werfend; null,
 * wenn es nicht geht (Container, keine sudo-Regel, DB weg).
 */
export function readPgDataDirectory({ database = {}, spawnFn = spawn, timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    let child; let out = ''; let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    // Dieselben Verbindungsangaben wie Backup/Restore (Host/Socket, Port, DB) —
    // sonst fragt es bei mehreren Clustern den falschen (Codex 38d2f56d, P2).
    const args = ['-n', '-u', 'postgres', '/usr/bin/psql', '-X', ...buildPsqlArgs({ database, sql: 'SHOW data_directory' })];
    try { child = spawnFn('sudo', args, { env: process.env }); } catch { finish(null); return; }
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* egal */ } finish(null); }, timeoutMs);
    t.unref?.();
    child.stdout?.on('data', (d) => { if (out.length < 4096) out += d.toString(); });
    child.on('error', () => { clearTimeout(t); finish(null); });
    child.on('close', (code) => {
      clearTimeout(t);
      const line = out.trim().split('\n')[0]?.trim();
      finish(code === 0 && line && line.startsWith('/') ? line : null);
    });
  });
}

// ── Wachstum ──────────────────────────────────────────────────────────────────

export function readSamples(dataDir, readFile = fs.readFileSync) {
  if (!dataDir) return [];
  try {
    const j = JSON.parse(readFile(path.join(dataDir, SAMPLES_FILE), 'utf8'));
    return Array.isArray(j?.samples) ? j.samples.filter((s) => s && typeof s.day === 'string') : [];
  } catch { return []; }
}

export function writeSamples(dataDir, samples, { writeFile = fs.writeFileSync, rename = fs.renameSync } = {}) {
  if (!dataDir) return false;
  const f = path.join(dataDir, SAMPLES_FILE);
  try {
    writeFile(`${f}.tmp`, `${JSON.stringify({ version: 1, samples }, null, 1)}\n`);
    rename(`${f}.tmp`, f);
    return true;
  } catch { return false; }
}

/** Messpunkt des Tages eintragen (ersetzt einen vom selben Tag), höchstens 35 Tage. */
export function recordSample(samples, { day, mounts, dbMb = null }) {
  const used = {};
  for (const m of mounts || []) for (const r of m.roles) used[r] = m.usedMb;
  const entry = { day, used, dbMb: Number.isFinite(dbMb) ? dbMb : null };
  const rest = (samples || []).filter((s) => s.day !== day);
  return [...rest, entry].sort((a, b) => (a.day < b.day ? -1 : 1)).slice(-MAX_SAMPLES);
}

const dayMs = (d) => Date.parse(`${d}T00:00:00Z`);

/**
 * Wachstum in MB/Tag für eine Rolle über bis zu windowDays. null, solange es
 * keine 2 Tage Abstand gibt. Schrumpft der Platz (gelöscht), zählt 0.
 */
export function growthMbPerDay(samples, role = 'db', { windowDays = 7 } = {}) {
  const pts = (samples || []).filter((s) => Number.isFinite(s?.used?.[role]));
  if (pts.length < 2) return null;
  const last = pts[pts.length - 1];
  const from = dayMs(last.day) - windowDays * 86_400_000;
  const first = pts.find((s) => dayMs(s.day) >= from) || pts[0];
  const days = (dayMs(last.day) - dayMs(first.day)) / 86_400_000;
  if (!(days >= 2)) return null;
  return Math.max(0, Math.round(((last.used[role] - first.used[role]) / days) * 10) / 10);
}

/**
 * Reserve, die frei bleiben muss: ein Update (Docker ein Image-Satz ~1,5 GB,
 * nativ npm/venv ~0,5 GB, Annahme), max_wal_size und ein Tag Rohwerte
 * unkomprimiert (~230 MB, Prod-Messung 23.11.).
 */
export function reserveMb({ container = false, maxWalMb = 1024, rawPerDayMb = 230 } = {}) {
  return (container ? 1536 : 512) + (Number(maxWalMb) || 0) + rawPerDayMb;
}

/** Reichweite in Tagen; null = kein messbares Wachstum (bzw. noch keine 2 Tage). */
export function daysLeft({ freeMb, reserveMb: reserve = 0, growth }) {
  if (!(growth > 0) || !Number.isFinite(freeMb)) return null;
  return Math.max(0, Math.round(((freeMb - reserve) / growth) * 10) / 10);
}
