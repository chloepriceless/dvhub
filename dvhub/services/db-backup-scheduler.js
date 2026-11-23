// DVhub (2026-06-01) — scheduled Postgres backup to a network target.
//
// Runs a daily pg_dump (full or just the 15-min energy table) into a configured
// destination directory — typically an OS-mounted network share (NFS/SMB) so
// the backup lands "an einem Punkt im Netzwerk" — and prunes to a retention
// count. All settable in the Settings page via the `dbBackup` config group.
//
// Deliberately a destination DIRECTORY (not scp/SMB-with-credentials): the
// operator mounts the share at OS level (fstab/systemd), and we just write +
// rotate files. No third-party creds live in the app config, and OS mounts are
// far more robust than an in-app transfer client.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dumpToFile, selectBackupsToDelete, backupFilename, DB_BACKUP_SCOPES } from './db-backup.js';
import { smbUpload, smbListBackups, smbDelete } from './smb-target.js';

const TICK_MS = 60_000;

// Speicher-Konzept Schritt 6 (Christin 23.11.2026): vor einem Dump prüfen, ob
// er auf die Zielplatte passt (Datenbankgröße + 256 MB Luft), und lokale
// Backups auf der Platte der Datenbank nach Speicherprofil begrenzen
// (groß 14, mittel 7, klein 3; winzig: kein volles Backup dorthin — Umfang
// „15-min“ oder ein Netzziel wählen).
const BACKUP_SPACE_MARGIN_MB = 256;
const MB = 1048576;

/**
 * Pure: passt das Backup, und wie viele dürfen bleiben?
 * @returns {{ ok: boolean, error?: string, keep: number, sameDisk: boolean }}
 */
export function backupSpacePlan({ freeMb, dbMb, sameDisk, profile, scope, retentionCount }) {
  // Ungültige Anzahl bleibt ungültig: selectBackupsToDelete löscht dann nichts (Schutz).
  const keepCfg = Number(retentionCount);
  let keep = keepCfg;
  // Ungültige Anzahl bleibt ungültig (nichts löschen), auch mit Profil-Grenze (Codex 2739f099).
  const cap = (n) => (Number.isFinite(keepCfg) && keepCfg > 0 ? Math.min(keepCfg, n) : keepCfg);
  if (sameDisk && profile && Number.isFinite(profile.backupKeepMax)) {
    if (profile.backupKeepMax === 0) {
      if (scope !== 'energy15m') {
        return { ok: false, sameDisk, keep: 0, error: `Speicherprofil „${profile.label || profile.name}“: kein volles Backup auf die Platte der Datenbank — Umfang „15-min“ oder ein Netzziel wählen` };
      }
      keep = cap(3);
    } else keep = cap(profile.backupKeepMax);
  }
  const need = (scope === 'energy15m' ? 0 : (Number(dbMb) || 0)) + BACKUP_SPACE_MARGIN_MB;
  if (Number.isFinite(freeMb) && freeMb < need) {
    return { ok: false, sameDisk, keep, error: `zu wenig Platz am Ziel: ${Math.round(freeMb)} MB frei, das Backup braucht etwa ${Math.round(need)} MB` };
  }
  return { ok: true, sameDisk, keep };
}

/**
 * Pure: is a daily backup due at `now` given the config and the last-run day?
 * Fires once when the local clock reaches HH:MM and we haven't already run today.
 * Returns the day-string to record when it fires, else null.
 */
export function backupDueDay(cfg, now, lastRunDay) {
  const b = cfg && cfg.dbBackup;
  if (!b || !b.enabled) return null;
  // Target must be configured: a local directory, or SMB host+share.
  const targetType = b.targetType === 'smb' ? 'smb' : 'local';
  const targetOk = targetType === 'smb' ? !!(b.smb && b.smb.host && b.smb.share) : !!b.destinationDir;
  if (!targetOk) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(b.time || '03:30'));
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  if (now.getHours() === hh && now.getMinutes() === mm && lastRunDay !== day) return day;
  return null;
}

export function createDbBackupScheduler({
  getCfg, pushLog, nowFn = () => new Date(), spawnFn,
  // Stand der Platz-Wache (storage-guard status: dbMb, mounts, profile) — optional.
  getStorage = null, statfs = (p) => fs.statfsSync(p), stat = (p) => fs.statSync(p),
} = {}) {
  let timer = null;
  let lastRunDay = null;
  let running = false;
  const status = { lastRunAt: null, lastResult: null, lastFile: null, lastError: null, lastReason: null };

  function stamp(now) {
    const p2 = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}`;
  }

  function ok(scope, reason, now, file, pruned) {
    status.lastRunAt = now.toISOString();
    status.lastReason = reason;
    status.lastResult = 'ok';
    status.lastError = null;
    status.lastFile = file;
    if (pushLog) pushLog('db_backup_scheduled_ok', { scope, reason, file, pruned: pruned ? pruned.length : 0 });
    return { ok: true, file, pruned: pruned || [] };
  }

  function fail(scope, reason, now, error) {
    status.lastRunAt = now.toISOString();
    status.lastReason = reason;
    status.lastResult = 'error';
    status.lastError = (error || '').slice(0, 300);
    status.lastFile = null;
    if (pushLog) pushLog('db_backup_scheduled_failed', { scope, reason, error: status.lastError }, 'error');
    return { ok: false, error: error || 'backup failed' };
  }

  async function planFor(dir, scope, b, { network = false } = {}) {
    let st;
    if (typeof getStorage === 'function') {
      try { st = (await getStorage()) || null; } catch { st = null; }
    } else st = {};   // ohne Platz-Wache (alte Aufrufer): nur der freie Platz am Ziel zählt
    // Noch keine Messung (kurz nach dem Start, getrennter Betrieb): nicht ohne
    // Prüfung durchwinken (Codex 2739f099).
    if (!st) return { ok: false, keep: Number(b.retentionCount), sameDisk: false, error: 'Speicher noch nicht gemessen (DVhub startet gerade) — Backup bitte in einigen Minuten erneut starten' };
    let freeMb = NaN;
    try { const s = statfs(dir); freeMb = (Number(s.bavail) * Number(s.bsize)) / MB; } catch { /* unbekannt → nicht blockieren */ }
    let sameDisk = false;
    if (!network) {
      const dbMount = (st?.mounts || []).find((m) => (m.roles || []).includes('db'));
      // Alle Geräte-Nummern der DB-Platte (Docker overlay2: Container-Wurzel und
      // Volume sind dieselbe Platte, Codex 2739f099).
      try {
        const dev = String(stat(dir).dev);
        sameDisk = !!dbMount && (String(dbMount.key) === dev || (dbMount.devs || []).map(String).includes(dev));
      } catch { /* egal */ }
    }
    return backupSpacePlan({
      freeMb, dbMb: st?.dbMb, sameDisk, profile: st?.profile?.values || null, scope,
      retentionCount: b.retentionCount,
    });
  }

  // Backup into a local directory (which may itself be an OS-mounted share).
  async function runLocal(cfg, b, scope, fileName, reason, now) {
    const dir = b.destinationDir;
    if (!dir) return { ok: false, error: 'no destinationDir configured' };
    const outFile = path.join(dir, fileName);
    fs.mkdirSync(dir, { recursive: true }); // surfaces a missing mount as a clear error
    const plan = await planFor(dir, scope, b);
    if (!plan.ok) return fail(scope, reason, now, plan.error);
    const res = await dumpToFile({ scope, database: cfg.telemetry.database, outFile, spawnFn });
    if (!res.ok) {
      try { if (fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch { /* ignore */ }
      return fail(scope, reason, now, res.stderr || 'pg_dump failed');
    }
    const pruned = [];
    try {
      const toDelete = selectBackupsToDelete(fs.readdirSync(dir), scope, plan.keep);
      for (const f of toDelete) { try { fs.unlinkSync(path.join(dir, f)); pruned.push(f); } catch { /* ignore */ } }
    } catch (err) { if (pushLog) pushLog('db_backup_prune_error', { scope, error: err.message }); }
    return ok(scope, reason, now, outFile, pruned);
  }

  // Backup to an SMB/CIFS share via smbclient: dump to a temp file, push it,
  // then prune old backups on the share. The temp file is always cleaned up.
  async function runSmb(cfg, b, scope, fileName, reason, now) {
    const smb = b.smb || {};
    if (!smb.host || !smb.share) return { ok: false, error: 'SMB host/share not configured' };
    const conn = { host: smb.host, share: smb.share, username: smb.username, password: smb.password, domain: smb.domain };
    const subPath = smb.path || '';
    const tmpFile = path.join(os.tmpdir(), fileName);
    // Der Dump liegt erst lokal (tmp) — passt er dorthin? Begrenzung der Anzahl gilt fürs Netzziel nicht.
    const plan = await planFor(os.tmpdir(), scope, b, { network: true });
    if (!plan.ok) return fail(scope, reason, now, plan.error);
    try {
      const dump = await dumpToFile({ scope, database: cfg.telemetry.database, outFile: tmpFile, spawnFn });
      if (!dump.ok) return fail(scope, reason, now, dump.stderr || 'pg_dump failed');
      const up = await smbUpload({ conn, subPath, localFile: tmpFile, remoteName: fileName, spawnFn });
      if (!up.ok) return fail(scope, reason, now, `SMB upload failed: ${(up.stderr || up.stdout || '').slice(0, 200)}`);
      let pruned = [];
      try {
        const listed = await smbListBackups({ conn, subPath, spawnFn });
        const toDelete = selectBackupsToDelete(listed.files, scope, Number(b.retentionCount));
        if (toDelete.length) { await smbDelete({ conn, subPath, names: toDelete, spawnFn }); pruned = toDelete; }
      } catch (err) { if (pushLog) pushLog('db_backup_prune_error', { scope, target: 'smb', error: err.message }); }
      const remote = `//${smb.host}/${smb.share}${subPath ? '/' + String(subPath).replace(/^\/+/, '') : ''}/${fileName}`;
      return ok(scope, reason, now, remote, pruned);
    } finally {
      try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  }

  async function runNow(reason = 'manual') {
    if (running) return { ok: false, error: 'backup already running' };
    const cfg = getCfg();
    const b = cfg.dbBackup || {};
    const scope = DB_BACKUP_SCOPES.has(b.scope) ? b.scope : 'full';
    if (!cfg.telemetry?.database) return { ok: false, error: 'telemetry database not configured' };
    const targetType = b.targetType === 'smb' ? 'smb' : 'local';
    running = true;
    const now = nowFn();
    const fileName = backupFilename(scope, stamp(now));
    try {
      return targetType === 'smb'
        ? await runSmb(cfg, b, scope, fileName, reason, now)
        : await runLocal(cfg, b, scope, fileName, reason, now);
    } catch (err) {
      return fail(scope, reason, now, err.message);
    } finally {
      running = false;
    }
  }

  function tick() {
    try {
      const due = backupDueDay(getCfg(), nowFn(), lastRunDay);
      if (due) { lastRunDay = due; runNow('scheduled'); }
    } catch (err) {
      if (pushLog) pushLog('db_backup_tick_error', { error: err.message });
    }
  }

  function getStatus() {
    const b = getCfg().dbBackup || {};
    const targetType = b.targetType === 'smb' ? 'smb' : 'local';
    const smb = b.smb || {};
    return {
      enabled: !!b.enabled,
      scope: DB_BACKUP_SCOPES.has(b.scope) ? b.scope : 'full',
      time: b.time || null,
      targetType,
      // Sanitised target for display (never the SMB password).
      target: targetType === 'smb'
        ? (smb.host && smb.share ? `//${smb.host}/${smb.share}${smb.path ? '/' + String(smb.path).replace(/^\/+/, '') : ''}` : null)
        : (b.destinationDir || null),
      destinationDir: b.destinationDir || null,
      retentionCount: Number(b.retentionCount) || null,
      running,
      ...status
    };
  }

  return {
    start() { if (!timer) timer = setInterval(tick, TICK_MS); },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    runNow,
    getStatus,
    _tick: tick // exposed for tests
  };
}
