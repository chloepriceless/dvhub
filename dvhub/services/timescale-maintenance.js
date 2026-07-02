// DVhub (2026-07-02) — TimescaleDB engine maintenance ("Pakete auto, Extension per Klick").
//
// Two moving parts keep every box's TimescaleDB current WITHOUT surprising
// PostgreSQL restarts (Christin's decision):
//   1. pkg-maintain.sh (root, nightly systemd timer) keeps the apt PACKAGE family
//      up to date. Adding a newer .so is HARMLESS: Postgres keeps loading the .so
//      matching the CURRENTLY-created extension version (Timescale ships every
//      historical .so), so nothing changes until the operator opts in. The timer
//      writes ${DV_DATA_DIR}/timescale-status.json (this module reads it).
//   2. This module powers the GUI "Jetzt aktualisieren" button — the deliberate,
//      operator-triggered `ALTER EXTENSION timescaledb UPDATE`. That step needs a
//      Postgres restart BEFORE (so a fresh backend loads the new .so and the
//      matching update scripts) and AFTER (so every backend runs the new version —
//      otherwise app backends raise `"timescaledb" already loaded with a different
//      version`). Sequence verified on prod during the 2.25.2 → 2.28.2 upgrade
//      (2026-07-02).
//
// Same doctrine as db-backup.js: a thin orchestrator driven by an injectable
// spawnFn so the multi-restart sequence is unit-testable without a live Postgres.
// Runs the pg client as the postgres SUPERUSER via sudo (peer auth on the unix
// socket) and bounces postgresql.service via `sudo systemctl` — both covered by
// the narrow NOPASSWD rules in the install.sh/post-update.sh sudoers block.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { buildPsqlArgs } from './db-backup.js';

const PG_PSQL_BIN = '/usr/bin/psql';
const PG_SUPERUSER = 'postgres';
const PG_SERVICE = 'postgresql.service';

// One probe for both the active extension version AND the version the installed
// binary offers (default_version). COALESCE('') keeps a single "<ext>|<default>"
// line even when the package is installed but the extension isn't CREATEd yet.
const VERSIONS_SQL =
  "SELECT COALESCE(e.extversion,''), COALESCE(a.default_version,'') " +
  "FROM pg_available_extensions a LEFT JOIN pg_extension e ON e.extname = a.name " +
  "WHERE a.name = 'timescaledb'";

/** Spawn a command, buffer stdout/stderr, resolve an outcome. Never rejects. */
function runCmd(cmd, args, env, spawnFn) {
  return new Promise((resolve) => {
    let child;
    try { child = spawnFn(cmd, args, { env }); }
    catch (err) { resolve({ ok: false, code: null, stdout: '', stderr: err.message }); return; }
    let stdout = '', stderr = '';
    if (child.stdout) child.stdout.on('data', (d) => { if (stdout.length < 8000) stdout += d.toString(); });
    if (child.stderr) child.stderr.on('data', (d) => { if (stderr.length < 8000) stderr += d.toString(); });
    child.on('error', (err) => resolve({ ok: false, code: null, stdout: stdout.trim(), stderr: (stderr || err.message).trim() }));
    child.on('close', (code) => resolve({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

/**
 * Pure: parse the two-column VERSIONS_SQL output ("<ext>|<default>", one line).
 * updatePending == the two differ (ALTER only moves forward, so any difference
 * means a newer binary is installed but not yet activated). Nulls when absent.
 */
export function parseVersions(stdout) {
  const line = String(stdout || '').trim().split('\n')[0] || '';
  const [ext = '', def = ''] = line.split('|');
  const extVersion = ext.trim() || null;
  const binaryVersion = def.trim() || null;
  return {
    extVersion,
    binaryVersion,
    updatePending: !!(extVersion && binaryVersion && extVersion !== binaryVersion)
  };
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `SELECT 1` until Postgres answers (after a restart) or we give up. */
async function waitPgReady({ psql, sleepFn, tries = 15, intervalMs = 1000 }) {
  for (let i = 0; i < tries; i++) {
    const r = await psql('SELECT 1');
    if (r.ok && r.stdout.includes('1')) return true;
    await sleepFn(intervalMs);
  }
  return false;
}

/**
 * Read the engine status for the GUI card. Prefers an authoritative LIVE probe
 * (current ext version + the version the installed binary offers) and merges the
 * timer's bookkeeping (lastChecked / lastPkgUpgrade / edition) from the status
 * file. Never throws.
 *
 * @returns {Promise<object>} {ok, extVersion, binaryVersion, updatePending, available, edition, pgMajor, lastChecked, lastPkgUpgrade, probeOk}
 */
export async function readTimescaleStatus({ statusFile, database = {}, spawnFn = spawn, readFileFn = fs.promises.readFile } = {}) {
  const probe = await runCmd(
    'sudo',
    ['-u', PG_SUPERUSER, PG_PSQL_BIN, ...buildPsqlArgs({ database, sql: VERSIONS_SQL })],
    { ...process.env },
    spawnFn
  );
  const live = probe.ok ? parseVersions(probe.stdout) : { extVersion: null, binaryVersion: null, updatePending: false };

  let file = null;
  if (statusFile) {
    try {
      const raw = await readFileFn(statusFile, 'utf8');
      const j = JSON.parse(raw);
      if (j && typeof j === 'object') file = j;
    } catch { /* status file absent / unreadable → live probe only */ }
  }

  const extVersion = live.extVersion ?? (file?.extVersion ?? null);
  const binaryVersion = live.binaryVersion ?? (file?.binaryVersion ?? null);
  return {
    ok: true,
    extVersion,
    binaryVersion,
    updatePending: probe.ok ? live.updatePending : !!file?.updatePending,
    available: !!(extVersion || file?.extVersion),
    edition: file?.edition ?? null,
    pgMajor: file?.pgMajor ?? null,
    lastChecked: file?.lastChecked ?? null,
    lastPkgUpgrade: file?.lastPkgUpgrade ?? null,
    probeOk: probe.ok
  };
}

/**
 * Perform the GUI-triggered TimescaleDB extension upgrade — the SAFE sequence
 * verified on prod: restart Postgres (load the freshly-installed .so) →
 * `ALTER EXTENSION timescaledb UPDATE` → reconcile the catalog version marker →
 * restart Postgres again (every backend on the new version). The dvhub app
 * restart (pool flush) is scheduled by the ROUTE afterwards, not here.
 *
 * A no-op (returns alreadyCurrent) when the extension already matches the binary
 * — so clicking the button when nothing is pending never bounces Postgres.
 * Never throws; returns a structured outcome.
 *
 * @returns {Promise<{ok:boolean, from:string|null, to:string|null, binaryVersion?:string|null, restarted:boolean, alreadyCurrent?:boolean, error?:string, detail?:string}>}
 */
export async function runTimescaleExtUpgrade({ database = {}, spawnFn = spawn, sleepFn = defaultSleep } = {}) {
  const env = { ...process.env };
  const psql = (sql) => runCmd('sudo', ['-u', PG_SUPERUSER, PG_PSQL_BIN, ...buildPsqlArgs({ database, sql })], env, spawnFn);
  const restartPg = () => runCmd('sudo', ['systemctl', 'restart', PG_SERVICE], env, spawnFn);

  // 0. Where are we, and does the installed binary offer something newer?
  const before = parseVersions((await psql(VERSIONS_SQL)).stdout);
  if (!before.extVersion) {
    return { ok: false, error: 'timescaledb_not_active', from: null, to: null, restarted: false };
  }
  if (!before.updatePending) {
    // Binary == extension → clicking the button is a pure no-op (no restart).
    return { ok: true, from: before.extVersion, to: before.extVersion, binaryVersion: before.binaryVersion, restarted: false, alreadyCurrent: true };
  }

  // 1. Restart Postgres so a fresh backend loads the newly-installed .so BEFORE
  //    running the update scripts.
  const r1 = await restartPg();
  if (!r1.ok) return { ok: false, error: 'pg_restart_failed_pre', detail: r1.stderr, from: before.extVersion, to: before.extVersion, restarted: false };
  if (!(await waitPgReady({ psql, sleepFn }))) {
    return { ok: false, error: 'pg_not_ready_pre', from: before.extVersion, to: before.extVersion, restarted: true };
  }

  // 2. The actual extension update (superuser).
  const up = await psql('ALTER EXTENSION timescaledb UPDATE');
  if (!up.ok) return { ok: false, error: 'alter_extension_failed', detail: up.stderr, from: before.extVersion, to: before.extVersion, restarted: true };

  // 2b. Belt-and-suspenders: align the catalog version marker to the extension
  //     (the same reconcile the restore path uses; harmless no-op when equal).
  await psql("UPDATE _timescaledb_catalog.metadata m SET value = e.extversion FROM pg_extension e WHERE e.extname = 'timescaledb' AND m.key = 'timescaledb_version' AND m.value <> e.extversion");

  // 3. Restart Postgres AGAIN so every backend (and the app's future connections)
  //    runs the new version — else backends with the old .so mapped raise
  //    `"timescaledb" already loaded with a different version`.
  const r2 = await restartPg();
  if (!r2.ok) return { ok: false, error: 'pg_restart_failed_post', detail: r2.stderr, from: before.extVersion, to: before.binaryVersion, restarted: true };
  if (!(await waitPgReady({ psql, sleepFn }))) {
    return { ok: false, error: 'pg_not_ready_post', from: before.extVersion, to: before.binaryVersion, restarted: true };
  }

  // 4. Verify the new state.
  const after = parseVersions((await psql(VERSIONS_SQL)).stdout);
  const ok = !!(after.extVersion && after.extVersion === after.binaryVersion && after.extVersion !== before.extVersion);
  return {
    ok,
    from: before.extVersion,
    to: after.extVersion,
    binaryVersion: after.binaryVersion,
    restarted: true,
    ...(ok ? {} : { error: 'verify_failed' })
  };
}
