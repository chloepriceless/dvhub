// DVhub (2026-06-01) — push DB backups to an SMB/CIFS share (e.g. a NAS).
//
// Uses the `smbclient` CLI so it works as the non-root `dvhub` user (a CIFS
// mount would need root). Credentials go into a 0600 temp auth file passed via
// -A, never into argv (which is world-readable via /proc). Consistent with how
// the codebase already shells out to system tools (pg_dump, openvpn, wg-quick).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Match our own backup filenames in `smbclient ls` output.
const BACKUP_RE = /dvhub-(?:full|energy15m)-\d{4}-\d{2}-\d{2}-\d{4}\.dump/g;

/** Pure: extract dvhub backup filenames from smbclient `ls` stdout (deduped). */
export function parseSmbLs(stdout) {
  const out = [];
  const seen = new Set();
  for (const m of String(stdout || '').matchAll(BACKUP_RE)) {
    if (!seen.has(m[0])) { seen.add(m[0]); out.push(m[0]); }
  }
  return out;
}

/** Pure: smbclient argv. Auth always via -A file (never password in argv). */
// Review 2026-06-10 (B3): host/share come from operator config (LAN-writable) —
// strip everything outside hostname/share charsets so a crafted value cannot
// smuggle smbclient syntax into the service argument. spawn() already prevents
// SHELL injection; this prevents smbclient-level surprises.
export function buildSmbcArgs({ host, share, authFile, command }) {
  const h = String(host || '').replace(/[^A-Za-z0-9.\-_]/g, '');
  const s = String(share || '').replace(/[^A-Za-z0-9.\-_$ ]/g, '');
  return [`//${h}/${s}`, '-A', authFile, '-c', command];
}

/** Pure: a `-c` command string — optional `cd subPath`, then the actions. */
export function buildSmbcCommand(subPath, actions) {
  const parts = [];
  // Review 2026-06-10 (B3): subPath is embedded in the `-c` mini-language inside
  // double quotes — a `"` or `;` in the config value could terminate the cd and
  // inject arbitrary smbclient commands (e.g. `del *`). Strip the metachars.
  const p = String(subPath || '').trim().replace(/^\/+/, '').replace(/[";\\]/g, '');
  if (p) parts.push(`cd "${p}"`);
  for (const a of actions) parts.push(a);
  return parts.join('; ');
}

/**
 * Run one smbclient invocation with a temp 0600 auth file. Never rejects.
 * @returns {Promise<{ok:boolean, stdout:string, stderr:string, code:number|null}>}
 */
export async function smbExec({ host, share, username, password, domain, command, spawnFn = spawn, fsMod = fs, tmpDir = os.tmpdir() } = {}) {
  const authFile = path.join(tmpDir, `dvhub-smb-${process.pid}-${Date.now()}.auth`);
  const lines = [`username = ${username || ''}`, `password = ${password || ''}`];
  if (domain) lines.push(`domain = ${domain}`);
  try {
    fsMod.writeFileSync(authFile, lines.join('\n') + '\n', { mode: 0o600 });
  } catch (err) {
    return { ok: false, stdout: '', stderr: `auth file write failed: ${err.message}`, code: null };
  }
  try {
    const args = buildSmbcArgs({ host, share, authFile, command });
    return await new Promise((resolve) => {
      let child;
      try { child = spawnFn('smbclient', args); }
      catch (err) { resolve({ ok: false, stdout: '', stderr: err.message, code: null }); return; }
      let stdout = '';
      let stderr = '';
      if (child.stdout) child.stdout.on('data', (d) => { stdout += d.toString(); });
      if (child.stderr) child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', (err) => resolve({ ok: false, stdout, stderr: err.message, code: null }));
      child.on('close', (code) => resolve({ ok: code === 0, stdout, stderr, code }));
    });
  } finally {
    try { fsMod.unlinkSync(authFile); } catch { /* ignore */ }
  }
}

/** Upload a local file to the share (optionally into subPath). */
export async function smbUpload({ conn, subPath, localFile, remoteName, spawnFn, fsMod, tmpDir }) {
  const command = buildSmbcCommand(subPath, [`put "${localFile}" "${remoteName}"`]);
  return smbExec({ ...conn, command, spawnFn, fsMod, tmpDir });
}

/** List dvhub backup filenames in the share's subPath. */
export async function smbListBackups({ conn, subPath, spawnFn, fsMod, tmpDir }) {
  const command = buildSmbcCommand(subPath, ['ls dvhub-*.dump']);
  const res = await smbExec({ ...conn, command, spawnFn, fsMod, tmpDir });
  // `ls` of a no-match pattern returns "NT_STATUS_NO_SUCH_FILE" (code!=0) — that
  // just means zero backups yet, not a real error.
  return { ok: res.ok || /NO_SUCH_FILE/.test(res.stderr + res.stdout), files: parseSmbLs(res.stdout), raw: res };
}

/** Delete the named backup files from the share's subPath. */
export async function smbDelete({ conn, subPath, names, spawnFn, fsMod, tmpDir }) {
  if (!names || !names.length) return { ok: true, stdout: '', stderr: '', code: 0 };
  const command = buildSmbcCommand(subPath, names.map((n) => `del "${n}"`));
  return smbExec({ ...conn, command, spawnFn, fsMod, tmpDir });
}
