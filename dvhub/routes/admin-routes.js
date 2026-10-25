// routes/admin-routes.js — Datenbank-Sicherung und -Wiederherstellung
// (/api/db/*), TimescaleDB-Wartung, System und Dienst (/api/admin/health,
// service, system), API-Token (rotate/revoke) und DVhub-Update
// (/api/admin/update/check|apply|channel).
//
// Aus routes-api.js herausgelöst (2026-10-15, Wartung: Aufteilung der großen
// Routen-Datei). Der Code ist unverändert; was er aus createApiRoutes braucht
// (Antwort-Helfer, Auth, Update-Helfer), kommt über `deps`. Gibt `false`
// zurück, wenn die Anfrage keine dieser Routen ist.

import * as crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseBody } from '../server-utils.js';
import { runtimeInfo } from '../runtime-info.js';
import { streamPgDump, runDbRestore } from '../services/db-backup.js';
import { readTimescaleStatus, runTimescaleExtUpgrade } from '../services/timescale-maintenance.js';

// GUI DB-Restore (POST /api/db/restore): stream a raw request body straight to
// a file on disk with a hard byte ceiling and proper backpressure, so a
// multi-hundred-MB .dump upload is never buffered in the LXC's memory. Rejects
// early on the content-length header when present, and otherwise enforces the
// cap chunk-by-chunk. Resolves { bytes }; rejects with err.code='TOO_LARGE' on
// overflow (413) or the underlying stream error otherwise. The caller unlinks
// the temp file on every path.
function saveUploadToFile(req, filePath, maxBytes) {
  return new Promise((resolve, reject) => {
    const cl = Number(req.headers['content-length']);
    if (Number.isFinite(cl) && cl > maxBytes) {
      const e = new Error('body_too_large'); e.code = 'TOO_LARGE'; reject(e); return;
    }
    const ws = fs.createWriteStream(filePath);
    let total = 0;
    let failed = false;
    const fail = (err) => { if (failed) return; failed = true; try { ws.destroy(); } catch { /* ignore */ } try { req.destroy(); } catch { /* ignore */ } reject(err); };
    req.on('data', (chunk) => {
      if (failed) return;
      total += chunk.length;
      if (total > maxBytes) { const e = new Error('body_too_large'); e.code = 'TOO_LARGE'; fail(e); return; }
      if (!ws.write(chunk)) { req.pause(); ws.once('drain', () => { if (!failed) req.resume(); }); }
    });
    req.on('end', () => { if (!failed) ws.end(); });
    req.on('error', fail);
    ws.on('error', fail);
    ws.on('finish', () => { if (!failed) resolve({ bytes: total }); });
  });
}

// Nur GEÄNDERTE versionierte Dateien zur Seite legen (Review 25.10.2026, P1):
// `git stash --include-untracked` im Repo-Ordner räumte die Laufzeitordner
// eos-venv/, forecast-venv/ und bin/ mit weg, und der Stash kam nach einem
// erfolgreichen Update nie zurück — EOS, Prognose und EEBUS fehlten danach.
export const STASH_TRACKED_ARGS = ['stash', 'push'];

// Marker von post-update.sh (Schritt 6): Hash des Lockfiles nach dem letzten
// ERFOLGREICHEN npm install. Vor jedem Lauf ungültig machen (Review 25.10.2026,
// P2): bricht npm ab (Timeout, Stromausfall), bleibt node_modules halb zurück —
// ein stehengebliebener Marker hätte die Reparatur beim nächsten Start unterdrückt.
export const NPM_INSTALL_MARKER = '.npm-install-hash';

export function createAdminRoutes(deps) {
  const {
    ctx, getCfg, pushLog,
    json, checkAuth, adminHealthPayload, execFileAsync, SECURITY_HEADERS,
    actorContext, deriveClientIp, tokenFingerprint,
    GIT_SHA_REF, SEMVER_TAG, compareSemverTag, selectLatestSemverTag, assertNoDowngrade, listReachableReleaseTags,
  } = deps;

  async function npmInstallOmitDev(repoRoot, appDir) {
    const marker = path.join(repoRoot, NPM_INSTALL_MARKER);
    try { fs.rmSync(marker, { force: true }); } catch { /* post-update.sh prüft zusätzlich node_modules */ }
    const result = await execFileAsync('npm', ['install', '--omit=dev'], { cwd: appDir, timeout: 60000 });
    // Nach Erfolg denselben Hash wie post-update.sh schreiben (Lockfile, sonst
    // package.json) — sonst installiert post-update.sh gleich danach ein
    // zweites Mal (Gegenprüfung 25.10.2026).
    try {
      const lock = ['package-lock.json', 'package.json'].map((f) => path.join(appDir, f)).find((f) => fs.existsSync(f));
      if (lock) fs.writeFileSync(marker, crypto.createHash('sha256').update(fs.readFileSync(lock)).digest('hex') + '\n');
    } catch { /* ohne Marker installiert post-update.sh beim nächsten Start erneut — harmlos */ }
    return result;
  }

  return async function handleAdminRoute(req, res, url) {
    // --- Datenbank-Backup herunterladen (pg_dump custom, streamed) ---
    // GET-only LAN bypass (appliance model, like /api/history/raw/export.*);
    // external callers still need Bearer. scope=full | energy15m.
    if (url.pathname === '/api/db/backup' && req.method === 'GET') {
      const cfg = getCfg();
      if (!cfg.telemetry?.enabled || !cfg.telemetry?.database) {
        return json(res, 503, { ok: false, error: 'telemetry database disabled' });
      }
      const scope = url.searchParams.get('scope') || 'full';
      // YYYY-MM-DD-HHMM stamp for the download filename.
      const d = new Date();
      const p2 = (n) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
      streamPgDump({
        scope,
        database: cfg.telemetry.database,
        res,
        securityHeaders: SECURITY_HEADERS,
        stamp,
        pushLog
      });
      return;
    }

    // Scheduled-backup status (last run, target, retention). GET-only LAN bypass.
    if (url.pathname === '/api/db/backup/status' && req.method === 'GET') {
      if (!ctx.dbBackupScheduler) return json(res, 503, { ok: false, error: 'backup scheduler unavailable' });
      return json(res, 200, { ok: true, status: ctx.dbBackupScheduler.getStatus() });
    }

    // Trigger the scheduled backup NOW (writes to the configured destinationDir).
    // POST → not LAN-bypassed → external callers need Bearer; runs the same path
    // as the daily job. Distinct from GET /api/db/backup (which streams to the
    // browser); this one writes a file to the network target.
    if (url.pathname === '/api/db/backup/run' && req.method === 'POST') {
      if (!ctx.dbBackupScheduler) return json(res, 503, { ok: false, error: 'backup scheduler unavailable' });
      const result = await ctx.dbBackupScheduler.runNow('manual');
      return json(res, result.ok ? 200 : 500, result);
    }

    // DESTRUCTIVE restore from an uploaded pg_dump (.dump, custom -Fc format).
    // Normal LAN-trust auth AND service-actions-gated, matching the posture of a
    // restart/update: it drops+recreates the telemetry DB. The upload streams
    // straight to a temp file (never buffered in memory), is validated as a
    // PGDMP archive, then pg_restore'd with the TimescaleDB pre/post_restore
    // dance when the extension is present. A restart is recommended afterwards so
    // the app's pool reconnects against the fresh schema.
    if (url.pathname === '/api/db/restore' && req.method === 'POST') {
      if (!checkAuth(req, res)) return;
      // Im Container gibt es keine Service-Actions (kein systemd) — der Restore
      // ist dort aber DER Weg, Bestandsdaten zu übernehmen. Er läuft dann direkt
      // als DB-Admin (services/db-backup.js pgRuntime); Bearer bleibt Pflicht.
      const inContainer = process.env.DVHUB_RUNTIME === 'container';
      if (!inContainer && (!ctx.getServiceActionsEnabled || !ctx.getServiceActionsEnabled())) {
        return json(res, 403, { ok: false, error: 'service actions disabled' });
      }
      const cfg = getCfg();
      if (!cfg.telemetry?.enabled || !cfg.telemetry?.database) {
        return json(res, 503, { ok: false, error: 'telemetry database disabled' });
      }
      const MAX_RESTORE_BYTES = 8 * 1024 * 1024 * 1024; // 8 GB ceiling
      const tmpFile = path.join(os.tmpdir(), `dvhub-restore-${crypto.randomUUID()}.dump`);
      let bytes;
      try {
        ({ bytes } = await saveUploadToFile(req, tmpFile, MAX_RESTORE_BYTES));
      } catch (e) {
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
        if (e.code === 'TOO_LARGE') return json(res, 413, { ok: false, error: 'body_too_large' });
        return json(res, 400, { ok: false, error: 'upload_failed', detail: e.message });
      }
      // Validate the custom-format magic ("PGDMP") so a mis-uploaded file fails
      // fast — before we terminate backends or drop a single object.
      let magicOk = false;
      try {
        const fd = fs.openSync(tmpFile, 'r');
        const head = Buffer.alloc(5);
        const n = fs.readSync(fd, head, 0, 5, 0);
        fs.closeSync(fd);
        magicOk = n === 5 && head.toString('latin1') === 'PGDMP';
      } catch { /* not readable → treated as invalid dump below */ }
      if (!magicOk) {
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
        return json(res, 400, { ok: false, error: 'invalid_dump', hint: 'Erwartet wird eine .dump-Datei im pg_dump-Custom-Format (-Fc).' });
      }
      pushLog('db_restore_start', { bytes }, { ...actorContext(req), severity: 'warn' });
      let result;
      try {
        result = await runDbRestore({ database: cfg.telemetry.database, inFile: tmpFile });
      } catch (e) {
        result = { ok: false, code: null, stderr: e?.message || 'restore_exception', hadTimescale: false, ignoredErrors: 0 };
      } finally {
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      }
      if (result.ok) {
        pushLog('db_restore_ok', { bytes, hadTimescale: result.hadTimescale, ignoredErrors: result.ignoredErrors || 0 }, { ...actorContext(req), severity: 'warn' });
        return json(res, 200, { ok: true, hadTimescale: result.hadTimescale, ignoredErrors: result.ignoredErrors || 0, restartRecommended: true });
      }
      pushLog('db_restore_failed', { bytes, code: result.code, stderr: (result.stderr || '').slice(0, 300) }, { ...actorContext(req), severity: 'error' });
      return json(res, 500, { ok: false, error: 'restore_failed', code: result.code, detail: (result.stderr || '').slice(0, 800), hadTimescale: result.hadTimescale, restartRecommended: true });
    }

    // --- TimescaleDB engine status (versions + updatePending) ---
    // Read-only GUI "Datenbank-Engine" card. GET-only LAN bypass (in the read
    // allowlist); external callers need Bearer. Merges a live version probe with
    // the nightly pkg-maintain.sh timer's bookkeeping (lastChecked/lastPkgUpgrade).
    if (url.pathname === '/api/db/timescale/status' && req.method === 'GET') {
      const cfg = getCfg();
      if (!cfg.telemetry?.enabled || !cfg.telemetry?.database) {
        return json(res, 503, { ok: false, error: 'telemetry database disabled' });
      }
      const statusFile = path.join(process.env.DV_DATA_DIR || '/var/lib/dvhub', 'timescale-status.json');
      const status = await readTimescaleStatus({ statusFile, database: cfg.telemetry.database });
      return json(res, 200, status);
    }

    // --- TimescaleDB extension upgrade ("Jetzt aktualisieren") ---
    // The deliberate, operator-triggered `ALTER EXTENSION timescaledb UPDATE`.
    // Normal LAN-trust auth AND service-actions-gated, like the
    // restore/restart endpoints, because it bounces PostgreSQL twice. Runs the
    // SAFE sequence (restart → ALTER → reconcile → restart), then — only when the
    // version actually moved — schedules a dvhub restart so the pg pool reconnects
    // clean. Responds BEFORE that app restart (like /api/admin/token/revoke).
    if (url.pathname === '/api/db/timescale/upgrade' && req.method === 'POST') {
      if (!checkAuth(req, res)) return;
      if (!ctx.getServiceActionsEnabled || !ctx.getServiceActionsEnabled()) {
        return json(res, 403, { ok: false, error: 'service actions disabled' });
      }
      const cfg = getCfg();
      if (!cfg.telemetry?.enabled || !cfg.telemetry?.database) {
        return json(res, 503, { ok: false, error: 'telemetry database disabled' });
      }
      pushLog('timescale_upgrade_start', {}, { ...actorContext(req), severity: 'warn' });
      let result;
      try {
        result = await runTimescaleExtUpgrade({ database: cfg.telemetry.database });
      } catch (e) {
        result = { ok: false, error: 'upgrade_exception', detail: e?.message || 'exception', from: null, to: null, restarted: false };
      }
      if (result.ok && result.restarted && !result.alreadyCurrent) {
        // Version moved forward + Postgres bounced twice → flush the app pool with
        // a scheduled dvhub restart. Respond FIRST — the restart kills this process.
        pushLog('timescale_upgrade_ok', { from: result.from, to: result.to }, { ...actorContext(req), severity: 'warn' });
        json(res, 200, { ...result, appRestartScheduled: true });
        if (ctx.scheduleServiceRestart) ctx.scheduleServiceRestart();
        return;
      }
      if (result.ok) {
        // alreadyCurrent no-op → nothing restarted, nothing to flush.
        pushLog('timescale_upgrade_noop', { from: result.from }, actorContext(req));
        return json(res, 200, { ...result, appRestartScheduled: false });
      }
      pushLog('timescale_upgrade_failed', { error: result.error, detail: (result.detail || '').slice(0, 200) }, { ...actorContext(req), severity: 'error' });
      return json(res, 500, { ...result, appRestartScheduled: false });
    }

    // --- Admin Health ---
    if (url.pathname === '/api/admin/health' && req.method === 'GET') {
      return json(res, 200, await adminHealthPayload());
    }

    // --- Admin Service Restart ---
    if (url.pathname === '/api/admin/service/restart' && req.method === 'POST') {
      if (!ctx.getServiceActionsEnabled()) {
        return json(res, 403, { ok: false, error: 'service actions disabled' });
      }
      const check = await ctx.runServiceCommand(['show', ctx.getServiceName(), '--property=Id', '--value']);
      if (!check.ok) {
        return json(res, 500, { ok: false, error: check.error, command: check.command });
      }
      ctx.scheduleServiceRestart();
      pushLog('service_restart_scheduled', { service: ctx.getServiceName() });
      return json(res, 202, {
        ok: true, accepted: true, service: ctx.getServiceName(),
        message: 'Service restart scheduled'
      });
    }

    // --- System Updates (OS packages) ---
    if (url.pathname === '/api/admin/system/updates/check' && req.method === 'GET') {
      if (!ctx.getServiceActionsEnabled()) return json(res, 403, { ok: false, error: 'service actions disabled' });
      try {
        await execFileAsync('sudo', ['apt-get', 'update', '-qq'], { timeout: 30000 });
        const { stdout } = await execFileAsync('sudo', ['apt', 'list', '--upgradable'], { timeout: 15000 });
        const lines = stdout.split('\n').filter(l => l.includes('/'));
        const packages = lines.map(l => {
          const match = l.match(/^([^\s/]+)\/\S+\s+(\S+)\s+\S+\s+\[upgradable from: ([^\]]+)\]/);
          return match ? { name: match[1], newVersion: match[2], currentVersion: match[3] } : null;
        }).filter(Boolean);
        const securityCount = lines.filter(l => l.includes('-security')).length;
        return json(res, 200, {
          ok: true,
          totalCount: packages.length,
          securityCount,
          packages: packages.slice(0, 50),
          checkedAt: new Date().toISOString()
        });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    }

    if (url.pathname === '/api/admin/system/updates/apply' && req.method === 'POST') {
      if (!ctx.getServiceActionsEnabled()) return json(res, 403, { ok: false, error: 'service actions disabled' });
      // Plan 08-01 Task 2 (CRITICAL #3): parse body BEFORE the try so `securityOnly`
      // is in scope for both the success (pushLog / response) and error branches.
      const body = await parseBody(req).catch(() => ({}));
      const securityOnly = body?.securityOnly === true;
      try {
        // Wait for any running apt/dpkg lock (max 60s)
        for (let i = 0; i < 12; i++) {
          try {
            await execFileAsync('sudo', ['fuser', '/var/lib/dpkg/lock-frontend'], { timeout: 3000 });
            await new Promise(r => setTimeout(r, 5000)); // lock held, wait 5s
          } catch { break; } // fuser exits non-zero = no lock
        }
        // Plan 08-01 Task 2: honour securityOnly by switching to the security-only
        // apt invocation (reads only /etc/apt/security.sources.list.d/*).
        const aptCmd = securityOnly
          ? ['apt-get', '-y',
             '-o', 'Dir::Etc::SourceList=/etc/apt/sources.list',
             '-o', 'Dir::Etc::SourceParts=/etc/apt/security.sources.list.d',
             '-o', 'Dpkg::Options::=--force-confdef',
             '-o', 'Dpkg::Options::=--force-confold',
             'upgrade']
          : ['apt-get', 'upgrade', '-y',
             '-o', 'Dpkg::Options::=--force-confdef',
             '-o', 'Dpkg::Options::=--force-confold'];
        const result = await execFileAsync('sudo', aptCmd, { timeout: 300000 });
        // Ein node-Update loescht die Datei-Capability. Nur Boxen, deren Dienst
        // das Port-Recht noch NICHT ueber systemd bekommt (vor
        // node-runtime-provision.sh), brauchen setcap zurueck — sonst bliebe
        // node im secure mode und jemalloc waere still wieder aus.
        const unitAmbient = (await execFileAsync('systemctl', ['show', process.env.DV_SERVICE_NAME || 'dvhub.service', '-p', 'AmbientCapabilities', '--value'], { timeout: 5000 })
          .catch(() => ({ stdout: '' }))).stdout;
        if (!/cap_net_bind_service/.test(unitAmbient)) {
          const nodeBin = (await execFileAsync('which', ['node'], { timeout: 5000 }).catch(() => ({ stdout: '/usr/bin/node' }))).stdout.trim();
          await execFileAsync('sudo', ['setcap', 'cap_net_bind_service=+ep', nodeBin], { timeout: 5000 }).catch(() => {});
        }

        const outputLines = (result.stdout || '').split('\n');
        const upgraded = outputLines.filter(l => /^Setting up/.test(l)).map(l => l.replace('Setting up ', '').replace(/ \(.*/, ''));
        pushLog('system_updates_applied', { count: upgraded.length, securityOnly, packages: upgraded.slice(0, 20) });
        return json(res, 200, {
          ok: true,
          upgraded: upgraded.length,
          packages: upgraded.slice(0, 50),
          securityOnly,
          message: `${upgraded.length} Pakete aktualisiert`
        });
      } catch (e) {
        pushLog('system_updates_error', { error: e.message, securityOnly });
        return json(res, 500, { ok: false, error: e.message });
      }
    }

    if (url.pathname === '/api/admin/system/info' && req.method === 'GET') {
      if (!ctx.getServiceActionsEnabled()) {
        return json(res, 403, { ok: false, error: 'service actions disabled' });
      }
      try {
        const uptimeOut = (await execFileAsync('uptime', ['-p'], { timeout: 5000 }).catch(() => ({ stdout: '-' }))).stdout.trim();
        const hostnameOut = (await execFileAsync('hostname', [], { timeout: 5000 }).catch(() => ({ stdout: '-' }))).stdout.trim();
        const memOut = (await execFileAsync('free', ['-m'], { timeout: 5000 }).catch(() => ({ stdout: '' }))).stdout;
        const memMatch = memOut.match(/Mem:\s+(\d+)\s+(\d+)/);
        const diskOut = (await execFileAsync('df', ['-h', '/'], { timeout: 5000 }).catch(() => ({ stdout: '' }))).stdout;
        const diskMatch = diskOut.match(/\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+%)/);
        const kernelOut = (await execFileAsync('uname', ['-r'], { timeout: 5000 }).catch(() => ({ stdout: '-' }))).stdout.trim();
        const nodeVersion = process.version;
        return json(res, 200, {
          ok: true,
          runtime: runtimeInfo(),
          hostname: hostnameOut,
          uptime: uptimeOut,
          kernel: kernelOut,
          nodeVersion,
          memory: memMatch ? { totalMb: +memMatch[1], usedMb: +memMatch[2] } : null,
          disk: diskMatch ? { size: diskMatch[1], used: diskMatch[2], available: diskMatch[3], usePct: diskMatch[4] } : null
        });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    }

    if (url.pathname === '/api/admin/system/reboot' && req.method === 'POST') {
      if (!ctx.getServiceActionsEnabled()) return json(res, 403, { ok: false, error: 'service actions disabled' });
      pushLog('system_reboot', {});
      json(res, 200, { ok: true, message: 'System wird neu gestartet...' });
      setTimeout(() => {
        execFileAsync('sudo', ['reboot'], { timeout: 5000 }).catch(() => {});
      }, 1000);
      return;
    }

    /* Plan 09-01 threat model:
     * T-9-01-01 (Spoofing): admin endpoint requires checkAuth (Bearer + LAN-bypass guards). Mitigated.
     * T-9-01-02 (Information disclosure): raw token never logged — only 16-hex sha256 fingerprint. Mitigated.
     * T-9-01-03 (Denial of service): rotate is a 1-write op; rate-limited by plan 09-02 (admin endpoints no longer exempt from 120 req/min). Mitigated.
     * T-9-01-04 (Tampering): persist via ctx.saveAndApplyConfig — same writer as POST /api/config, atomic write. Mitigated.
     * T-9-01-05 (Elevation of privilege): revoke restart gated by DV_ENABLE_SERVICE_ACTIONS — operator opt-in, no implicit privilege grant. Mitigated.
     * T-9-01-06 (Repudiation): rotation/revocation actions land in audit_log via pushLog → writeAuditEntry with actor context + 16-hex fingerprint chain. Mitigated.
     */

    // Plan 09-01 (D-04): rotate API token. Generates a fresh 32-byte (64-hex-char)
    // token, persists via the existing config-save path, emits a distinctive
    // pushLog so rotations are filterable in the audit log panel. The new token
    // is returned ONCE in the response — operators must capture it immediately
    // since the old token is invalid the moment saveAndApplyConfig returns.
    if (url.pathname === '/api/admin/token/rotate' && req.method === 'POST') {
      if (!checkAuth(req, res)) return;
      const oldToken = getCfg().apiToken || '';
      const newToken = crypto.randomBytes(32).toString('hex'); // 64 hex chars, ~256 bits entropy
      const oldFp = tokenFingerprint(oldToken);  // null if oldToken was empty (D-05 allows that)
      const newFp = tokenFingerprint(newToken);
      const next = JSON.parse(JSON.stringify(ctx.getRawCfg() || {}));
      next.apiToken = newToken;
      try {
        ctx.saveAndApplyConfig(next);
      } catch (e) {
        return json(res, 500, { ok: false, error: 'persist_failed', detail: e?.message || null });
      }
      pushLog('token_rotated', {
        actor: req.headers['x-actor'] || 'admin',
        actorIp: deriveClientIp(req, getCfg()),
        oldFingerprint: oldFp,    // 16-hex chars OR null
        newFingerprint: newFp     // 16-hex chars
      }, { ...actorContext(req), severity: 'info' });
      return json(res, 200, { ok: true, token: newToken, fingerprint: newFp });
    }

    // Plan 09-01 (D-02 + D-04): revoke API token. Clears apiToken to ''. If
    // ctx.getServiceActionsEnabled() === true → also schedules a systemd restart so
    // any in-flight bearer session is invalidated. If service actions are
    // disabled → returns 503 (NOT 200) so the operator knows the restart didn't
    // happen, but the token IS still cleared in config (D-02). No process.exit, no crash.
    if (url.pathname === '/api/admin/token/revoke' && req.method === 'POST') {
      if (!checkAuth(req, res)) return;
      const oldFp = tokenFingerprint(getCfg().apiToken || '');
      const next = JSON.parse(JSON.stringify(ctx.getRawCfg() || {}));
      next.apiToken = '';
      try {
        ctx.saveAndApplyConfig(next);
      } catch (e) {
        return json(res, 500, { ok: false, error: 'persist_failed', detail: e?.message || null });
      }
      pushLog('token_revoked', {
        actor: req.headers['x-actor'] || 'admin',
        actorIp: deriveClientIp(req, getCfg()),
        revokedFingerprint: oldFp  // 16-hex chars; null if previously empty
      }, { ...actorContext(req), severity: 'warn' });
      if (ctx.getServiceActionsEnabled && ctx.getServiceActionsEnabled()) {
        // Respond first so the client gets confirmation before the restart kicks
        json(res, 200, { ok: true, restart: 'scheduled', revokedFingerprint: oldFp });
        setTimeout(() => {
          const svc = (typeof ctx.getServiceName === 'function' && ctx.getServiceName()) || 'dvhub.service';
          execFileAsync('sudo', ['systemctl', 'restart', svc], { timeout: 5000 }).catch(() => {});
        }, 1000);
        return;
      }
      // D-02: 503 — service actions disabled, restart not performed, no crash
      return json(res, 503, { ok: false, restart: 'not_available', error: 'service_actions_disabled', revokedFingerprint: oldFp });
    }

    // --- Software Update Check ---
    if (url.pathname === '/api/admin/update/check' && req.method === 'GET') {
      if (!ctx.getServiceActionsEnabled()) return json(res, 403, { ok: false, error: 'service actions disabled' });
      try {
        const repoRoot = ctx.getRepoRoot();
        const channel = ctx.getRawCfg().updateChannel || 'stable';
        await execFileAsync('git', ['fetch', '--tags', '--quiet', 'origin'], { cwd: repoRoot, timeout: 15000 });
        const localRev = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, timeout: 5000 })).stdout.trim();

        // Shared branch-drift report (dev channel + stable pre-release fallback):
        // compare HEAD vs origin/main. Keeps check consistent with what apply would
        // actually do in the same situation (T-UPDATE-ANCHOR).
        const branchDriftResponse = async ({ currentTag = null, prerelease = false } = {}) => {
          const remoteRev = (await execFileAsync('git', ['rev-parse', 'origin/main'], { cwd: repoRoot, timeout: 5000 })).stdout.trim();
          const behind = Number((await execFileAsync('git', ['rev-list', '--count', 'HEAD..origin/main'], { cwd: repoRoot, timeout: 5000 })).stdout.trim());
          const ahead = Number((await execFileAsync('git', ['rev-list', '--count', 'origin/main..HEAD'], { cwd: repoRoot, timeout: 5000 })).stdout.trim());
          let changelog = '';
          if (behind > 0) {
            changelog = (await execFileAsync('git', ['log', '--oneline', 'HEAD..origin/main'], { cwd: repoRoot, timeout: 5000 })).stdout.trim();
          }
          return json(res, 200, {
            ok: true, channel,
            current: { version: ctx.getAppVersion().versionLabel, tag: currentTag, revision: localRev.slice(0, 7) },
            latest: { tag: null, revision: remoteRev.slice(0, 7) },
            behind, ahead,
            updateAvailable: behind > 0,
            ...(prerelease ? { prerelease: true } : {}),
            changelog: changelog ? changelog.split('\n').filter(Boolean) : []
          });
        };

        if (channel === 'stable') {
          let currentTag = null;
          try {
            currentTag = (await execFileAsync('git', ['describe', '--tags', '--exact-match', 'HEAD'], { cwd: repoRoot, timeout: 5000 })).stdout.trim();
          } catch { /* not on a tag */ }
          // T-UPDATE-ANCHOR: only tags reachable from origin/main are release anchors
          // (orphaned pre-cleanup tags like v0.4.2 must never count as "latest").
          const reachableTags = await listReachableReleaseTags(repoRoot);
          const latestTag = selectLatestSemverTag(reachableTags);
          if (!latestTag) {
            // Pre-release phase: no release tag reachable from origin/main yet.
            // Report branch drift so check+apply agree — apply follows origin/main
            // in this phase instead of erroring 'No release tags found'.
            return await branchDriftResponse({ currentTag, prerelease: true });
          }
          let changelog = '';
          if (currentTag && currentTag !== latestTag) {
            try { changelog = (await execFileAsync('git', ['log', '--oneline', `${currentTag}..${latestTag}`], { cwd: repoRoot, timeout: 5000 })).stdout.trim(); } catch { /* */ }
          } else if (!currentTag) {
            try { changelog = (await execFileAsync('git', ['log', '--oneline', `HEAD..${latestTag}`], { cwd: repoRoot, timeout: 5000 })).stdout.trim(); } catch { /* */ }
          }
          const updateAvailable = latestTag !== currentTag;
          const availableVersions = reachableTags
            ? reachableTags.split('\n').map((t) => t.trim()).filter((t) => SEMVER_TAG.test(t)).slice(0, 10)
            : [];
          return json(res, 200, {
            ok: true, channel,
            current: { version: ctx.getAppVersion().versionLabel, tag: currentTag, revision: localRev.slice(0, 7) },
            latest: { tag: latestTag, revision: null },
            updateAvailable,
            availableVersions,
            changelog: changelog ? changelog.split('\n').filter(Boolean) : []
          });
        } else {
          return await branchDriftResponse();
        }
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    }

    // --- Software Update Apply ---
    if (url.pathname === '/api/admin/update/apply' && req.method === 'POST') {
      if (!ctx.getServiceActionsEnabled()) return json(res, 403, { ok: false, error: 'service actions disabled' });
      try {
        const body = await parseBody(req).catch(() => ({}));
        // Plan 08-04 Task 1 Step 4: semver validation + downgrade guard.
        // targetVersion is passed directly to `git checkout` — an attacker with
        // a stolen token otherwise gets arbitrary-ref checkout (incl. shell
        // metacharacters if git ever interprets them) and version-downgrade attacks.
        const rawVersion = body?.version;
        let targetVersion = null;
        if (rawVersion !== undefined && rawVersion !== null && rawVersion !== '') {
          const versionStr = String(rawVersion).trim();
          if (!SEMVER_TAG.test(versionStr)) {
            pushLog('update_apply_rejected', { reason: 'invalid_semver', got: versionStr });
            return json(res, 400, { ok: false, error: 'invalid_semver', got: versionStr });
          }
          // Downgrade guard: compare against currently-installed package version.
          // compareSemver returns -1/0/+1 (a<b, a==b, a>b).
          const currentVersion = ctx.getAppVersion?.()?.version || ctx.getAppVersion?.()?.versionLabel || '0.0.0';
          if (!body?.allowDowngrade && compareSemverTag(versionStr, currentVersion) < 0) {
            pushLog('update_apply_rejected', { reason: 'downgrade_blocked', current: currentVersion, requested: versionStr });
            return json(res, 400, { ok: false, error: 'downgrade_blocked', current: currentVersion, requested: versionStr });
          }
          targetVersion = versionStr;
        }
        // T-COMMIT-PIN: optionaler `ref` (Commit-SHA) — installiert gezielt diesen
        // Bleeding-Edge-Stand statt des Channel-HEAD. Strikte Hex-SHA-Validierung
        // hier, Erreichbarkeits-Anker beim Checkout unten.
        const rawRef = body?.ref;
        let pinRef = null;
        if (rawRef !== undefined && rawRef !== null && rawRef !== '') {
          const refStr = String(rawRef).trim();
          if (!GIT_SHA_REF.test(refStr)) {
            pushLog('update_apply_rejected', { reason: 'invalid_ref', got: refStr.slice(0, 64) });
            return json(res, 400, { ok: false, error: 'invalid_ref', got: refStr.slice(0, 64) });
          }
          pinRef = refStr;
        }
        const repoRoot = ctx.getRepoRoot();
        const appDir = ctx.getAppDir();
        const channel = ctx.getRawCfg().updateChannel || 'stable';
        let gitOutput = '';
        const rollbackRev = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, timeout: 5000 })).stdout.trim();
        const stashResult = await execFileAsync('git', STASH_TRACKED_ARGS, { cwd: repoRoot, timeout: 10000 }).catch(() => ({ stdout: 'No local changes' }));
        const hasStash = !stashResult.stdout.includes('No local changes');

        try {
          // --- git fetch + downgrade guard + checkout (inside inner try for rollback coverage) ---
          // T-0100: resolve the TARGET version for whichever channel/ref we are about to
          // check out and refuse a downgrade BEFORE touching the working tree (the explicit
          // stable targetVersion was already guarded above; auto-selected refs were not).
          const currentVersionNow = ctx.getAppVersion?.()?.version || ctx.getAppVersion?.()?.versionLabel || '0.0.0';
          const allowDowngrade = body?.allowDowngrade === true;
          // Shared branch-follow step (dev channel + stable pre-release fallback):
          // checks out origin/main — read ITS package.json version first and refuse a
          // downgrade (origin/main can be far behind the running code). package.json
          // path is derived relative to the repo root so flat + nested layouts work.
          const followOriginMain = async () => {
            const relAppDir = path.relative(repoRoot, appDir).split(path.sep).join('/');
            const pkgGitPath = (relAppDir ? relAppDir + '/' : '') + 'package.json';
            const mainPkg = await execFileAsync('git', ['show', `origin/main:${pkgGitPath}`], { cwd: repoRoot, timeout: 5000 }).catch(() => ({ stdout: '' }));
            let mainVersion;
            try { mainVersion = JSON.parse(mainPkg.stdout || '{}').version || null; } catch { mainVersion = null; }
            assertNoDowngrade(mainVersion, currentVersionNow, { allowDowngrade, label: 'origin/main' });
            await execFileAsync('git', ['checkout', '-B', 'main', 'origin/main'], { cwd: repoRoot, timeout: 15000 });
            const pull = await execFileAsync('git', ['pull', '--ff-only', 'origin', 'main'], { cwd: repoRoot, timeout: 30000 });
            // Operator-facing gitOutput: the checkout -B above already moved HEAD to
            // origin/main, so the pull is a no-op and prints "Already up to date." even
            // when the update jumped revisions (observed live: rollbackRev 477f3fd →
            // c9f7ce3 reported "Already up to date."). Report the real movement.
            const newRev = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, timeout: 5000 })).stdout.trim();
            return newRev.slice(0, 7) === rollbackRev.slice(0, 7)
              ? pull.stdout.trim()
              : `Updated ${rollbackRev.slice(0, 7)} → ${newRev.slice(0, 7)}`;
          };
          if (pinRef) {
            // T-COMMIT-PIN: gezielter Commit statt Channel-HEAD. Fetch, dann exakt
            // die install.sh-Anker-Semantik: Ref muss existieren UND von origin/main
            // erreichbar sein (kein verwaister/fremder Commit). Detached HEAD ist
            // beabsichtigt — das nächste normale Channel-Update löst den Pin wieder
            // auf. KEIN Downgrade-Guard (der Operator pinnt bewusst, wie --ref).
            await execFileAsync('git', ['fetch', '--tags', 'origin'], { cwd: repoRoot, timeout: 15000 });
            let refSha = '';
            try {
              refSha = (await execFileAsync('git', ['rev-parse', '--verify', '--quiet', `${pinRef}^{commit}`], { cwd: repoRoot, timeout: 5000 })).stdout.trim();
            } catch { refSha = ''; }
            if (!refSha) { const e = new Error(`ref_not_found: ${pinRef}`); e.code = 'ref_not_found'; throw e; }
            try {
              await execFileAsync('git', ['merge-base', '--is-ancestor', refSha, 'origin/main'], { cwd: repoRoot, timeout: 5000 });
            } catch { const e = new Error(`ref_not_reachable: ${pinRef} ist nicht von origin/main erreichbar`); e.code = 'ref_not_reachable'; throw e; }
            await execFileAsync('git', ['checkout', '--detach', refSha], { cwd: repoRoot, timeout: 15000 });
            pushLog('update_pinned_ref', { ref: pinRef, sha: refSha.slice(0, 7), from: rollbackRev.slice(0, 7) });
            gitOutput = `Pinned ${rollbackRev.slice(0, 7)} → ${refSha.slice(0, 7)} (ref ${pinRef})`;
          } else if (channel === 'stable') {
            await execFileAsync('git', ['fetch', '--tags', 'origin'], { cwd: repoRoot, timeout: 15000 });
            // T-UPDATE-ANCHOR: only tags reachable from origin/main are release
            // anchors — an orphaned pre-cleanup tag (v0.4.2) must never be selected.
            const selectedTag = targetVersion || selectLatestSemverTag(await listReachableReleaseTags(repoRoot));
            if (selectedTag) {
              // Explicit targetVersion was already downgrade-checked; guard an auto-selected tag.
              if (!targetVersion) assertNoDowngrade(selectedTag, currentVersionNow, { allowDowngrade, label: 'latest release tag' });
              const checkout = await execFileAsync('git', ['checkout', selectedTag], { cwd: repoRoot, timeout: 15000 });
              gitOutput = `Checked out ${selectedTag}: ${checkout.stderr.trim()}`;
            } else {
              // Pre-release phase: no release tag reachable from origin/main yet.
              // Mirror install.sh ("Keine Release-Tags gefunden, verwende <branch>"):
              // follow origin/main instead of hard-failing — a pre-release stable box
              // must stay updatable. The first real release tag re-anchors the next update.
              pushLog('update_stable_prerelease_branch', { note: 'no release tag reachable from origin/main — following the branch' });
              gitOutput = `[pre-release] ${await followOriginMain()}`;
            }
          } else {
            await execFileAsync('git', ['fetch', 'origin'], { cwd: repoRoot, timeout: 15000 });
            gitOutput = await followOriginMain();
          }

          // --- npm install + syntax check ---
          const npmInstall = await npmInstallOmitDev(repoRoot, appDir);
          await execFileAsync('node', ['--check', 'server.js'], { cwd: appDir, timeout: 5000 });

          // --- post-update.sh (system-level migrations: sudoers, setcap, packages, tls) ---
          const postUpdateScript = path.join(repoRoot, 'post-update.sh');
          try {
            const fs = await import('node:fs');
            fs.default.accessSync(postUpdateScript, fs.default.constants.X_OK);
            const postResult = await execFileAsync('sudo', ['bash', postUpdateScript], { cwd: repoRoot, timeout: 120000 });
            pushLog('post_update_applied', { output: (postResult.stdout || '').trim().split('\n').slice(-5).join('\n') });
          } catch (postErr) {
            pushLog('post_update_warning', { error: postErr.message });
            // Don't fail the update if post-update fails — config migrations still run on restart
          }
          pushLog('update_applied', {
            channel,
            gitOutput: gitOutput.split('\n').slice(0, 5).join('\n'),
            npmOutput: npmInstall.stdout.trim().split('\n').slice(-3).join('\n')
          });
        } catch (updateErr) {
          pushLog('update_rollback', { reason: updateErr.message, rollbackTo: rollbackRev.slice(0, 7) });
          await execFileAsync('git', ['checkout', rollbackRev], { cwd: repoRoot, timeout: 15000 });
          await npmInstallOmitDev(repoRoot, appDir).catch(() => {});
          if (hasStash) await execFileAsync('git', ['stash', 'pop'], { cwd: repoRoot, timeout: 10000 }).catch(() => {});
          throw new Error(`Update rolled back: ${updateErr.message}`, { cause: updateErr });
        }

        if (hasStash) {
          pushLog('update_stash_discarded', { note: 'local changes were stashed before update and not restored' });
        }

        ctx.scheduleServiceRestart();
        pushLog('service_restart_scheduled', { service: ctx.getServiceName(), reason: 'update' });
        return json(res, 200, {
          ok: true, channel,
          gitOutput,
          rolledBackFrom: rollbackRev.slice(0, 7),
          message: 'Update applied, service restart scheduled'
        });
      } catch (e) {
        pushLog('update_error', { error: e.message });
        return json(res, 500, { ok: false, error: e.message });
      }
    }

    // --- Update Channel ---
    if (url.pathname === '/api/admin/update/channel' && req.method === 'POST') {
      // M-6 (Plan 16-03): gate parity — the sibling /api/admin/update/check
      // and /api/admin/update/apply handlers both start with this exact
      // service-actions gate. Without it the channel change is persisted
      // even when service actions are disabled (T-16-11 EoP).
      if (!ctx.getServiceActionsEnabled()) return json(res, 403, { ok: false, error: 'service actions disabled' });
      try {
        const body = await parseBody(req);
        const channel = body?.channel;
        if (channel !== 'stable' && channel !== 'dev') {
          return json(res, 400, { ok: false, error: 'channel must be "stable" or "dev"' });
        }
        const next = JSON.parse(JSON.stringify(ctx.getRawCfg() || {}));
        next.updateChannel = channel;
        ctx.saveAndApplyConfig(next);

        if (ctx.getServiceActionsEnabled()) {
          const repoRoot = ctx.getRepoRoot();
          const appDir = ctx.getAppDir();
          let gitOutput = '';
          const rollbackRev = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, timeout: 5000 })).stdout.trim();
          const stashResult = await execFileAsync('git', STASH_TRACKED_ARGS, { cwd: repoRoot, timeout: 10000 }).catch(() => ({ stdout: 'No local changes' }));
          const hasStash = !stashResult.stdout.includes('No local changes');
          try {
            // --- git fetch + checkout (inside inner try for rollback coverage) ---
            await execFileAsync('git', ['fetch', '--tags', 'origin'], { cwd: repoRoot, timeout: 15000 });

            if (channel === 'stable') {
              // T-UPDATE-ANCHOR: only tags reachable from origin/main are release anchors.
              const latestTag = selectLatestSemverTag(await listReachableReleaseTags(repoRoot));
              if (latestTag) {
                await execFileAsync('git', ['checkout', latestTag], { cwd: repoRoot, timeout: 15000 });
                gitOutput = `Switched to stable: ${latestTag}`;
              } else {
                // Pre-release phase: no release tag reachable yet — save the channel
                // preference and keep following origin/main; the first real release
                // tag re-anchors on the next update. Hard-failing here (old behaviour:
                // throw 'No release tags found' → 500 + rollback) made the stable
                // channel unselectable before the first release.
                await execFileAsync('git', ['checkout', '-B', 'main', 'origin/main'], { cwd: repoRoot, timeout: 15000 });
                gitOutput = 'Switched to stable: no release tag yet — following origin/main (pre-release)';
              }
            } else {
              await execFileAsync('git', ['checkout', '-B', 'main', 'origin/main'], { cwd: repoRoot, timeout: 15000 });
              gitOutput = 'Switched to dev: origin/main';
            }

            // --- npm install + syntax check ---
            await npmInstallOmitDev(repoRoot, appDir);
            await execFileAsync('node', ['--check', 'server.js'], { cwd: appDir, timeout: 5000 });
          } catch (switchErr) {
            pushLog('channel_switch_rollback', { reason: switchErr.message, rollbackTo: rollbackRev.slice(0, 7) });
            await execFileAsync('git', ['checkout', rollbackRev], { cwd: repoRoot, timeout: 15000 });
            await npmInstallOmitDev(repoRoot, appDir).catch(() => {});
            if (hasStash) await execFileAsync('git', ['stash', 'pop'], { cwd: repoRoot, timeout: 10000 }).catch(() => {});
            throw new Error(`Channel switch rolled back: ${switchErr.message}`, { cause: switchErr });
          }
          if (hasStash) {
            pushLog('channel_switch_stash_discarded', { note: 'local changes were stashed before switch and not restored' });
          }
          pushLog('update_channel_changed', { channel, gitOutput });
          ctx.scheduleServiceRestart();
          pushLog('service_restart_scheduled', { service: ctx.getServiceName(), reason: 'channel_switch' });
          return json(res, 200, {
            ok: true, channel, gitOutput,
            message: `Channel switched to ${channel}, service restart scheduled`
          });
        }

        pushLog('update_channel_changed', { channel, note: 'config-only, service actions disabled' });
        return json(res, 200, {
          ok: true, channel,
          message: `Channel preference saved to ${channel}. Git switch will happen on next update.`
        });
      } catch (e) {
        pushLog('update_channel_error', { error: e.message });
        return json(res, 500, { ok: false, error: e.message });
      }
    }

    return false;
  };
}
