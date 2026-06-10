// services/support-tunnel.js — T-0113 Tier 3: customer-initiated reverse-SSH
// support tunnel.
//
// Trust model (Christin, 2026-06-08): the tunnel is the ONLY network path a
// supporter has into the appliance. It is OFF by default, opened ONLY by the
// customer via the UI button, time-bounded (auto-close), and killable. Without
// an open tunnel the box sits behind NAT and is unreachable — the deposited
// support key alone grants nothing.
//
// Mechanics: `autossh -R` (userspace, no /dev/net/tun — works in unprivileged
// LXC) dials OUT to the self-hosted relay (support.dvhub.de) and reverse-forwards
//   relay:127.0.0.1:<shellPort> -> appliance:127.0.0.1:22   (SSH shell)
//   relay:127.0.0.1:<webPort>   -> appliance:127.0.0.1:80   (Web UI)
// The relay enforces the two permitlisten ports server-side, so shellPort/webPort
// MUST match the relay registry (peer assigns them; we mirror into config).
//
// Keys: the appliance owns a dedicated relay keypair (Level A, Appliance->Relay,
// generated at install, private key never leaves the box). The relay hostkey is
// PINNED (StrictHostKeyChecking=yes + a baked known_hosts) against MITM on first
// connect. The supporter logs in as the local `dvhub-support` user with Christin's
// support key (Level B) — a separate, customer-controllable opt-out.

import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// appliance-id: a UUID persisted at ${DATA_DIR}/appliance-id by install.sh /
// post-update.sh. The relay registry is keyed by it, so it must satisfy the
// relay's own constraint.
export const APPLIANCE_ID_RE = /^[a-z0-9-]{1,36}$/;

// Sensible bounds for the auto-close TTL (minutes). A tunnel must never stay open
// indefinitely; the customer can always re-open.
export const TTL_MIN_FLOOR = 5;
export const TTL_MIN_CEIL = 240;
export const TTL_MIN_DEFAULT = 60;

const AUTOSSH_CANDIDATES = ['/usr/bin/autossh', '/usr/local/bin/autossh', '/bin/autossh'];

// Read the persisted appliance UUID. Returns null when absent or malformed — the
// appliance is then "not yet registered" with the relay and the tunnel can't open.
export function readApplianceId(dataDir, fsImpl = fs) {
  try {
    const p = path.join(dataDir || '.', 'appliance-id');
    const raw = String(fsImpl.readFileSync(p, 'utf8')).trim().toLowerCase();
    return APPLIANCE_ID_RE.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

// OpenSSH "SHA256:..." fingerprint of a public key file's contents. Used by the
// transparency UI so the customer sees exactly which key can reach them.
export function sshKeyFingerprint(pubKeyContents) {
  try {
    const parts = String(pubKeyContents).trim().split(/\s+/);
    // pubkey line is "<type> <base64> [comment]" — require at least type+blob so a
    // single junk token never yields a bogus fingerprint.
    if (parts.length < 2) return null;
    const b64 = parts[1];
    if (!b64) return null;
    const der = Buffer.from(b64, 'base64');
    if (!der.length) return null;
    const hash = crypto.createHash('sha256').update(der).digest('base64').replace(/=+$/, '');
    return `SHA256:${hash}`;
  } catch {
    return null;
  }
}

// Clamp a requested TTL (minutes) into [floor, ceil], defaulting when unset/NaN.
export function clampTtlMin(value, fallback = TTL_MIN_DEFAULT) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return clampTtlMin(fallback, TTL_MIN_DEFAULT);
  return Math.min(TTL_MIN_CEIL, Math.max(TTL_MIN_FLOOR, Math.round(n)));
}

// PURE: build the argv for the reverse-tunnel client. Throws on missing/invalid
// fields so a half-provisioned box fails loud rather than dialing a broken tunnel.
// `binary` selects whether to prepend autossh's own `-M 0` (monitor off; rely on
// ServerAlive) — plain ssh rejects `-M 0`.
export function buildTunnelArgs(opts = {}, { binary = 'autossh' } = {}) {
  const { host, port, user, shellPort, webPort, keyPath, knownHostsPath } = opts;
  const errs = [];
  if (!host || typeof host !== 'string') errs.push('host');
  if (!Number.isInteger(Number(port)) || Number(port) <= 0) errs.push('port');
  if (!user || typeof user !== 'string') errs.push('user');
  if (!Number.isInteger(Number(shellPort)) || Number(shellPort) <= 0) errs.push('shellPort');
  if (!Number.isInteger(Number(webPort)) || Number(webPort) <= 0) errs.push('webPort');
  if (!keyPath || typeof keyPath !== 'string') errs.push('keyPath');
  if (errs.length) {
    throw new Error(`support tunnel misconfigured: missing/invalid ${errs.join(', ')}`);
  }
  const args = [];
  if (binary === 'autossh') args.push('-M', '0'); // monitor port off; ServerAlive handles liveness
  args.push(
    '-N',                                  // no remote command — forwarding only
    '-T',                                  // no pty
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ExitOnForwardFailure=yes',      // bail immediately if the relay rejects a permitlisten port
    '-o', 'StrictHostKeyChecking=yes',     // pinned relay hostkey — refuse on mismatch
    '-o', 'BatchMode=yes',                 // never prompt (unattended)
    '-o', 'IdentitiesOnly=yes'             // use only the provided key, ignore agent/defaults
  );
  if (knownHostsPath) args.push('-o', `UserKnownHostsFile=${knownHostsPath}`);
  args.push(
    '-R', `127.0.0.1:${Number(shellPort)}:127.0.0.1:22`,
    '-R', `127.0.0.1:${Number(webPort)}:127.0.0.1:80`,
    '-p', String(Number(port)),
    '-i', keyPath,
    `${user}@${host}`
  );
  return args;
}

// Resolve the tunnel client binary. Prefer autossh (self-healing reconnects);
// fall back to plain ssh when autossh isn't installed.
export function resolveTunnelBinary(fsImpl = fs) {
  for (const cand of AUTOSSH_CANDIDATES) {
    try {
      if (fsImpl.existsSync(cand)) return { binary: 'autossh', bin: cand };
    } catch { /* ignore */ }
  }
  return { binary: 'ssh', bin: 'ssh' };
}

// Factory — manages a single tunnel lifecycle. Deps are injectable for tests.
export function createSupportTunnel(ctx, deps = {}) {
  const spawnFn = deps.spawn || nodeSpawn;
  const fsImpl = deps.fs || fs;
  const now = deps.now || (() => Date.now());
  const setTimer = deps.setTimeout || setTimeout;
  const clearTimer = deps.clearTimeout || clearTimeout;
  const pushLog = (typeof ctx?.pushLog === 'function') ? ctx.pushLog : () => {};

  let child = null;
  let openedAt = null;
  let expiresAt = null;
  let autoCloseTimer = null;
  let lastError = null;
  let lastOpenedBy = null;

  // Review 2026-06-10 (B7, Christin-Entscheid Lösung 1): CSRF-Nonce für den
  // Open-Endpunkt. Der Status-GET liefert ein kurzlebiges Einmal-Token mit; die
  // eigene UI schickt es beim Öffnen automatisch zurück. Eine fremde Website im
  // Browser des Kunden kann die Status-Antwort wegen der Same-Origin-Policy
  // nicht LESEN → sie kommt nie an das Token → blindes CSRF/DNS-Rebinding auf
  // POST /open läuft ins Leere. Für den Kunden bleibt es 1 Klick (kein Token-
  // Eingeben). Close bleibt bewusst UNGESCHÜTZT — der Kill-Switch ist
  // privilegienREDUZIEREND und muss immer funktionieren (fail-safe).
  const UI_TOKEN_TTL_MS = 10 * 60 * 1000;
  let uiToken = null;
  let uiTokenAt = 0;

  function issueUiToken() {
    const t = now();
    if (!uiToken || (t - uiTokenAt) > UI_TOKEN_TTL_MS) {
      uiToken = crypto.randomBytes(16).toString('hex');
      uiTokenAt = t;
    }
    return uiToken;
  }

  // One-time consume: a valid candidate invalidates the stored token (the UI
  // re-fetches status afterwards anyway). Length-guarded timingSafeEqual.
  function consumeUiToken(candidate) {
    if (!uiToken || typeof candidate !== 'string') return false;
    if ((now() - uiTokenAt) > UI_TOKEN_TTL_MS) { uiToken = null; return false; }
    const cand = Buffer.from(candidate);
    const expect = Buffer.from(uiToken);
    if (cand.length !== expect.length) return false;
    const ok = crypto.timingSafeEqual(cand, expect);
    if (ok) { uiToken = null; uiTokenAt = 0; }
    return ok;
  }

  // Fire-and-forget Direktmeldung (Review 2026-06-10 B7 Lösung 2): Telegram/
  // Pushover/ntfy über den Notification-Service, falls konfiguriert. Lazy über
  // ctx, damit die Boot-Reihenfolge (tunnel vor notificationService) egal ist.
  function notifyTunnel(title, body, level) {
    try {
      const svc = ctx?.notificationService;
      if (svc && typeof svc.sendDirect === 'function') {
        Promise.resolve(svc.sendDirect({ event: 'support_tunnel', level: level || 'warning', title, body }))
          .catch(() => { /* fire-and-forget */ });
      }
    } catch { /* notification must never break tunnel mechanics */ }
  }

  function getDataDir() {
    if (typeof ctx?.getDataDir === 'function') return ctx.getDataDir() || '.';
    return process.env.DV_DATA_DIR || '.';
  }

  function supportPaths() {
    const dataDir = getDataDir();
    const supDir = path.join(dataDir, 'support');
    return {
      dataDir,
      supDir,
      keyPath: path.join(supDir, 'relay_id_ed25519'),
      pubPath: path.join(supDir, 'relay_id_ed25519.pub'),
      knownHostsPath: path.join(supDir, 'known_hosts'),
    };
  }

  // Provisioning values (peer-assigned shellPort/webPort) live in a SIDECAR file
  // next to the key material — NOT in config.json, which `POST /api/config`
  // overwrites verbatim (a UI config-save would otherwise wipe the relay ports).
  // Precedence: built-in defaults < sidecar relay.json < config.support.relay
  // (config wins, so an operator/test can override the sidecar deliberately).
  function readRelaySidecar(supDir) {
    try {
      const raw = fsImpl.readFileSync(path.join(supDir, 'relay.json'), 'utf8');
      const o = JSON.parse(raw);
      return (o && typeof o === 'object') ? o : {};
    } catch {
      return {};
    }
  }

  function relayConfig() {
    const cfg = (typeof ctx?.getCfg === 'function' ? ctx.getCfg() : null) || {};
    const support = cfg.support || {};
    const cfgRelay = support.relay || {};
    const p = supportPaths();
    const side = readRelaySidecar(p.supDir);
    const pick = (key, dflt) => {
      if (cfgRelay[key] !== undefined && cfgRelay[key] !== null && cfgRelay[key] !== '') return cfgRelay[key];
      if (side[key] !== undefined && side[key] !== null && side[key] !== '') return side[key];
      return dflt;
    };
    return {
      host: String(pick('host', 'support.dvhub.de')),
      port: Number(pick('port', 47821)) || 47821,
      user: String(pick('user', 'dvhub-support')),
      shellPort: Number(pick('shellPort', 0)) || 0,
      webPort: Number(pick('webPort', 0)) || 0,
      autoCloseMin: clampTtlMin(support.tunnel?.autoCloseMin, TTL_MIN_DEFAULT),
      localUserEnabled: support.localUser?.enabled !== false, // opt-out: default ON
    };
  }

  function readApplianceKeyFingerprint(pubPath) {
    try {
      return sshKeyFingerprint(fsImpl.readFileSync(pubPath, 'utf8'));
    } catch {
      return null;
    }
  }

  function exists(p) {
    try { return fsImpl.existsSync(p); } catch { return false; }
  }

  function status() {
    const rc = relayConfig();
    const p = supportPaths();
    const applianceId = readApplianceId(p.dataDir, fsImpl);
    const keyPresent = exists(p.keyPath);
    const provisioned = !!applianceId && keyPresent && rc.shellPort > 0 && rc.webPort > 0;
    const t = now();
    return {
      open: !!child,
      openedAt,
      openedBy: child ? lastOpenedBy : null,
      expiresAt,
      ttlRemainingSec: (child && expiresAt) ? Math.max(0, Math.round((expiresAt - t) / 1000)) : null,
      provisioned,
      applianceId,
      applianceKeyFingerprint: readApplianceKeyFingerprint(p.pubPath),
      relay: {
        host: rc.host,
        port: rc.port,
        user: rc.user,
        shellPort: rc.shellPort,
        webPort: rc.webPort,
      },
      localUserEnabled: rc.localUserEnabled,
      autoCloseMin: rc.autoCloseMin,
      lastError,
      // B7: CSRF-Nonce für POST /open — die UI schickt ihn automatisch mit.
      uiToken: issueUiToken(),
    };
  }

  // Leichtgewichtiger Status für den /api/status-Poll des Leitstands (3s-Takt):
  // nur In-Memory-Felder, KEINE fs-Zugriffe (status() liest appliance-id +
  // Key-Fingerprint von Platte) und KEIN uiToken.
  function liteStatus() {
    const t = now();
    return {
      open: !!child,
      expiresAt,
      ttlRemainingSec: (child && expiresAt) ? Math.max(0, Math.round((expiresAt - t) / 1000)) : null,
    };
  }

  function teardown(reason, actor) {
    if (autoCloseTimer) { clearTimer(autoCloseTimer); autoCloseTimer = null; }
    const wasOpen = !!child;
    const proc = child;
    child = null;
    openedAt = null;
    expiresAt = null;
    if (proc) {
      try { proc.kill('SIGTERM'); } catch { /* already gone */ }
    }
    if (wasOpen) {
      pushLog('support_tunnel_closed', { reason: reason || 'manual' }, actor || lastOpenedBy);
      notifyTunnel('Support-Tunnel geschlossen',
        reason === 'auto_close'
          ? 'Der Support-Tunnel wurde nach Ablauf der Zeit automatisch geschlossen.'
          : 'Der Support-Tunnel wurde geschlossen.',
        'info');
    }
    lastOpenedBy = null;
  }

  function open({ ttlMin } = {}, actor = null) {
    if (child) {
      // Idempotent: already open. Refresh nothing — surface current state.
      return { ok: true, alreadyOpen: true, status: status() };
    }
    const rc = relayConfig();
    const p = supportPaths();
    const applianceId = readApplianceId(p.dataDir, fsImpl);
    if (!applianceId) {
      lastError = 'not_provisioned: appliance-id missing';
      pushLog('support_tunnel_error', { error: lastError }, actor);
      return { ok: false, error: 'not_provisioned', detail: 'appliance-id fehlt — Box ist nicht beim Relay registriert.' };
    }
    if (!exists(p.keyPath)) {
      lastError = 'not_provisioned: relay key missing';
      pushLog('support_tunnel_error', { error: lastError }, actor);
      return { ok: false, error: 'not_provisioned', detail: 'Relay-Schlüssel fehlt — Box ist nicht beim Relay registriert.' };
    }
    if (!(rc.shellPort > 0 && rc.webPort > 0)) {
      lastError = 'not_provisioned: relay ports unassigned';
      pushLog('support_tunnel_error', { error: lastError }, actor);
      return { ok: false, error: 'not_provisioned', detail: 'Relay-Ports nicht zugeteilt — Support muss die Box erst freischalten.' };
    }

    const { binary, bin } = resolveTunnelBinary(fsImpl);
    let args;
    try {
      args = buildTunnelArgs({
        host: rc.host,
        port: rc.port,
        user: rc.user,
        shellPort: rc.shellPort,
        webPort: rc.webPort,
        keyPath: p.keyPath,
        knownHostsPath: exists(p.knownHostsPath) ? p.knownHostsPath : undefined,
      }, { binary });
    } catch (e) {
      lastError = e.message;
      pushLog('support_tunnel_error', { error: lastError }, actor);
      return { ok: false, error: 'misconfigured', detail: e.message };
    }

    const ttl = clampTtlMin(ttlMin, rc.autoCloseMin);
    let proc;
    try {
      proc = spawnFn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: false });
    } catch (e) {
      lastError = `spawn failed: ${e.message}`;
      pushLog('support_tunnel_error', { error: lastError, binary: bin }, actor);
      return { ok: false, error: 'spawn_failed', detail: e.message };
    }

    child = proc;
    openedAt = now();
    expiresAt = openedAt + ttl * 60 * 1000;
    lastError = null;
    lastOpenedBy = actor;

    // Capture stderr tail for diagnostics (relay rejections, key errors).
    try {
      if (proc.stderr && typeof proc.stderr.on === 'function') {
        proc.stderr.on('data', (d) => {
          lastError = String(d).trim().slice(-500) || lastError;
        });
      }
    } catch { /* stderr optional */ }

    // The relay-rejection / process death path. autossh normally self-heals, so
    // an exit here means a fatal condition (ExitOnForwardFailure, killed, etc).
    proc.on('exit', (code, signal) => {
      if (child !== proc) return; // already torn down by close()/auto-close
      if (autoCloseTimer) { clearTimer(autoCloseTimer); autoCloseTimer = null; }
      child = null;
      openedAt = null;
      expiresAt = null;
      const reason = signal ? `signal:${signal}` : `exit:${code}`;
      pushLog('support_tunnel_closed', { reason, unexpected: true, lastError }, lastOpenedBy);
      lastOpenedBy = null;
    });
    proc.on('error', (e) => {
      lastError = `process error: ${e.message}`;
      pushLog('support_tunnel_error', { error: lastError }, lastOpenedBy);
    });

    autoCloseTimer = setTimer(() => teardown('auto_close', lastOpenedBy), ttl * 60 * 1000);
    if (autoCloseTimer && typeof autoCloseTimer.unref === 'function') autoCloseTimer.unref();

    pushLog('support_tunnel_opened', {
      ttlMin: ttl,
      binary,
      relay: `${rc.user}@${rc.host}:${rc.port}`,
      shellPort: rc.shellPort,
      webPort: rc.webPort,
      applianceId,
    }, actor);
    notifyTunnel('Support-Tunnel geöffnet',
      `Fernzugriff für den Support ist jetzt möglich — schließt automatisch in ${ttl} min. `
      + 'Falls du das nicht warst: Tools → Support-Tunnel → Schließen.',
      'warning');

    return { ok: true, status: status() };
  }

  function close(actor = null) {
    if (!child) return { ok: true, alreadyClosed: true, status: status() };
    teardown('manual', actor);
    return { ok: true, status: status() };
  }

  return { open, close, status, liteStatus, consumeUiToken };
}
