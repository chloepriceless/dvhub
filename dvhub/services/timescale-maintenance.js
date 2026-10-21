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

//
// 21.10.2026 (Feldfall Ubuntu 26.04, Apache 2.25.1 → Community 2.31.0): Fehlt die
// Bibliothek zur Version im Katalog, scheitert die ERSTE Anweisung jeder Sitzung
// („could not access file "timescaledb-2.25.1"“), auch die Versions-Probe. Die
// Karte zeigte dann still den Stand der Statusdatei („aktuell“). Darum zwei
// Proben: der Katalog mit abgeschaltetem Loader (geht immer) und eine Lade-Probe
// mit Loader (geht nur, wenn die Bibliothek wirklich laedt). Repariert wird
// dieser Zustand von timescale-provision.sh beim DVhub-Start (ALTER + Zeilen aus
// der Hypertable-Elterntabelle zurueck), nicht von der Taste hier.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
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

// Lade-Probe: die Lizenz-Einstellung gibt es nur bei geladener Bibliothek.
const LOAD_SQL = "SELECT current_setting('timescaledb.license')";

const PG_SHARE_DIR = '/usr/share/postgresql';

/**
 * psql-Argumente als postgres. noLoad: Verbindung mit
 * timescaledb.disable_load=on (über den Verbindungs-String, sudo verwirft
 * PGOPTIONS). -X: keine psqlrc — beim ALTER muss es die erste Anweisung sein.
 */
function psqlArgs(database, sql, { noLoad = false } = {}) {
  const args = buildPsqlArgs({ database, sql });
  if (noLoad) {
    const i = args.indexOf('-d');
    const db = String(args[i + 1]).replace(/[\\']/g, '\\$&');
    args[i + 1] = `dbname='${db}' options='-c timescaledb.disable_load=on'`;
  }
  return ['-u', PG_SUPERUSER, PG_PSQL_BIN, '-X', ...args];
}

/** Erste Fehlerzeile von psql ohne „ERROR:  “-Vorsatz. */
function firstError(stderr) {
  const lines = String(stderr || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => /^(ERROR|FATAL|psql:)/.test(l)) || lines[0] || '';
  return line.replace(/^psql:\s*/, '').replace(/^(ERROR|FATAL):\s*/, '').slice(0, 300) || null;
}

/**
 * default_version aus der Control-Datei, ohne Datenbank (Rückfall, wenn keine
 * Probe durchkommt). pgMajor bevorzugt, sonst die höchste vorhandene Version.
 */
async function controlDefaultVersion({ pgMajor, readFileFn, readdirFn }) {
  let majors = pgMajor ? [String(pgMajor)] : [];
  if (!majors.length) {
    try {
      majors = (await readdirFn(PG_SHARE_DIR)).filter((d) => /^\d+$/.test(d)).sort((a, b) => b - a);
    } catch { return null; }
  }
  for (const m of majors) {
    try {
      const txt = await readFileFn(path.join(PG_SHARE_DIR, m, 'extension', 'timescaledb.control'), 'utf8');
      const hit = /^\s*default_version\s*=\s*'([^']+)'/m.exec(txt);
      if (hit) return hit[1];
    } catch { /* nächste Version */ }
  }
  return null;
}

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
 * (current ext version + the version the installed binary offers, read with the
 * loader off) plus a load probe, and merges the timer's bookkeeping
 * (lastChecked / lastPkgUpgrade / edition / provision) from the status file.
 * Never throws.
 *
 * probeOk:false → keine Live-Werte, Versionen aus Datei/Control-Datei, also
 * nicht „aktuell“ melden (updatePending null). loadOk:false → die Erweiterung
 * steht im Katalog, die Bibliothek dazu lädt nicht (loadError).
 *
 * @returns {Promise<object>} {ok, extVersion, binaryVersion, updatePending, available, edition, pgMajor, lastChecked, lastPkgUpgrade, probeOk, probeError, loadOk, loadError, provision}
 */
export async function readTimescaleStatus({
  statusFile, database = {}, spawnFn = spawn,
  readFileFn = fs.promises.readFile, readdirFn = fs.promises.readdir,
} = {}) {
  const env = { ...process.env };
  const probe = await runCmd('sudo', psqlArgs(database, VERSIONS_SQL, { noLoad: true }), env, spawnFn);
  const live = probe.ok ? parseVersions(probe.stdout) : null;

  let file = null;
  if (statusFile) {
    try {
      const raw = await readFileFn(statusFile, 'utf8');
      const j = JSON.parse(raw);
      if (j && typeof j === 'object') file = j;
    } catch { /* status file absent / unreadable → live probe only */ }
  }

  const extVersion = live ? live.extVersion : (file?.extVersion ?? null);
  let binaryVersion = live ? live.binaryVersion : null;
  if (!live) {
    binaryVersion = (await controlDefaultVersion({ pgMajor: file?.pgMajor, readFileFn, readdirFn }))
      ?? file?.binaryVersion ?? null;
  }

  // Lade-Probe nur, wenn die Erweiterung angelegt ist (sonst gibt es die
  // Einstellung ohnehin nicht).
  let loadOk = null;
  let loadError = null;
  let liveEdition = null;
  if (live?.extVersion) {
    const lp = await runCmd('sudo', psqlArgs(database, LOAD_SQL), env, spawnFn);
    loadOk = lp.ok;
    if (lp.ok) liveEdition = lp.stdout.trim() || null;
    else loadError = firstError(lp.stderr);
  } else if (!live && file?.loadError) {
    loadOk = false;
    loadError = file.loadError;
  }

  return {
    ok: true,
    extVersion,
    binaryVersion,
    updatePending: live ? live.updatePending : null,
    available: !!(extVersion || file?.extVersion),
    edition: liveEdition ?? file?.edition ?? null,
    pgMajor: file?.pgMajor ?? null,
    lastChecked: file?.lastChecked ?? null,
    lastPkgUpgrade: file?.lastPkgUpgrade ?? null,
    probeOk: probe.ok,
    probeError: probe.ok ? null : firstError(probe.stderr),
    loadOk,
    loadError,
    provision: file?.provision ?? null
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
  const psql = (sql) => runCmd('sudo', psqlArgs(database, sql), env, spawnFn);
  const psqlNoLoad = (sql) => runCmd('sudo', psqlArgs(database, sql, { noLoad: true }), env, spawnFn);
  const restartPg = () => runCmd('sudo', ['systemctl', 'restart', PG_SERVICE], env, spawnFn);

  // 0. Where are we, and does the installed binary offer something newer?
  //    Katalog ohne Loader: geht auch, wenn die Bibliothek fehlt.
  const before = parseVersions((await psqlNoLoad(VERSIONS_SQL)).stdout);
  if (!before.extVersion) {
    return { ok: false, error: 'timescaledb_not_active', from: null, to: null, restarted: false };
  }
  // Lädt die Bibliothek zur Katalog-Version nicht, haben Sitzungen ohne
  // TimescaleDB in die Elterntabelle der Hypertable geschrieben. Ein ALTER allein
  // ließe diese Zeilen unsichtbar zurück — das holt timescale-provision.sh beim
  // DVhub-Start nach (ALTER + Zeilen zurück in die Chunks).
  const load = await psql(LOAD_SQL);
  if (!load.ok) {
    return {
      ok: false, error: 'timescaledb_library_missing', detail: firstError(load.stderr),
      from: before.extVersion, to: before.extVersion, binaryVersion: before.binaryVersion, restarted: false
    };
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

  // 4. Verify the new state (mit Loader: muss jetzt laden).
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
