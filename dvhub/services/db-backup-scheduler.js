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
import path from 'node:path';
import { dumpToFile, selectBackupsToDelete, backupFilename, DB_BACKUP_SCOPES } from './db-backup.js';

const TICK_MS = 60_000;

/**
 * Pure: is a daily backup due at `now` given the config and the last-run day?
 * Fires once when the local clock reaches HH:MM and we haven't already run today.
 * Returns the day-string to record when it fires, else null.
 */
export function backupDueDay(cfg, now, lastRunDay) {
  const b = cfg && cfg.dbBackup;
  if (!b || !b.enabled || !b.destinationDir) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(b.time || '03:30'));
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  if (now.getHours() === hh && now.getMinutes() === mm && lastRunDay !== day) return day;
  return null;
}

export function createDbBackupScheduler({ getCfg, pushLog, nowFn = () => new Date(), spawnFn } = {}) {
  let timer = null;
  let lastRunDay = null;
  let running = false;
  const status = { lastRunAt: null, lastResult: null, lastFile: null, lastError: null, lastReason: null };

  function stamp(now) {
    const p2 = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}`;
  }

  async function runNow(reason = 'manual') {
    if (running) return { ok: false, error: 'backup already running' };
    const cfg = getCfg();
    const b = cfg.dbBackup || {};
    const scope = DB_BACKUP_SCOPES.has(b.scope) ? b.scope : 'full';
    const dir = b.destinationDir;
    if (!dir) return { ok: false, error: 'no destinationDir configured' };
    if (!cfg.telemetry?.database) return { ok: false, error: 'telemetry database not configured' };

    running = true;
    const now = nowFn();
    const fileName = backupFilename(scope, stamp(now));
    const outFile = path.join(dir, fileName);
    try {
      // Ensure the destination exists / is writable before dumping. A missing
      // mount surfaces here as a clear error instead of a half-written file.
      fs.mkdirSync(dir, { recursive: true });
      const res = await dumpToFile({ scope, database: cfg.telemetry.database, outFile, spawnFn });
      status.lastRunAt = now.toISOString();
      status.lastReason = reason;
      if (!res.ok) {
        // Drop a possibly-truncated output so a partial file isn't kept.
        try { if (fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch { /* ignore */ }
        status.lastResult = 'error';
        status.lastError = (res.stderr || '').slice(0, 300);
        status.lastFile = null;
        if (pushLog) pushLog('db_backup_scheduled_failed', { scope, reason, code: res.code, stderr: status.lastError }, 'error');
        return { ok: false, error: status.lastError || 'pg_dump failed', file: outFile };
      }
      status.lastResult = 'ok';
      status.lastError = null;
      status.lastFile = outFile;
      // Retention prune (best-effort; failure here doesn't fail the backup).
      let pruned = [];
      try {
        const keep = Number(b.retentionCount);
        const toDelete = selectBackupsToDelete(fs.readdirSync(dir), scope, keep);
        for (const f of toDelete) { try { fs.unlinkSync(path.join(dir, f)); pruned.push(f); } catch { /* ignore */ } }
      } catch (err) {
        if (pushLog) pushLog('db_backup_prune_error', { scope, error: err.message });
      }
      if (pushLog) pushLog('db_backup_scheduled_ok', { scope, reason, file: fileName, pruned: pruned.length });
      return { ok: true, file: outFile, pruned };
    } catch (err) {
      status.lastRunAt = now.toISOString();
      status.lastReason = reason;
      status.lastResult = 'error';
      status.lastError = err.message;
      status.lastFile = null;
      if (pushLog) pushLog('db_backup_scheduled_failed', { scope, reason, error: err.message }, 'error');
      return { ok: false, error: err.message };
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
    return {
      enabled: !!b.enabled,
      scope: DB_BACKUP_SCOPES.has(b.scope) ? b.scope : 'full',
      time: b.time || null,
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
