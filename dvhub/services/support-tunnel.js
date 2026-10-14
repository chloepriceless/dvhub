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

import { spawn as nodeSpawn, execFile as nodeExecFile } from 'node:child_process';
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

// Portbereich des Relays (build-authorized-keys.sh prüft denselben).
export const RELAY_PORT_MIN = 49000;
export const RELAY_PORT_MAX = 49999;

// Eigener systemd-Dienst für den Tunnel (2026-10-14): Als Kindprozess von
// DVhub starb der Tunnel bei jedem `systemctl restart dvhub` — genau dann, wenn
// der Support mitten in der Arbeit neu startete. support-provision.sh legt die
// Unit an; sie läuft als dvhub und startet dvhub-support-tunnel.sh --service.
// Ohne Unit (Docker-Image, Entwicklung) bleibt es beim Kindprozess.
export const TUNNEL_UNIT = 'dvhub-support-tunnel.service';
export const TUNNEL_UNIT_PATH = `/etc/systemd/system/${TUNNEL_UNIT}`;

// Docker-Container (2026-10-14): Dort gibt es kein System-sshd. Der Entrypoint
// legt support/sshd_config + Hostschlüssel an; beim Öffnen startet DVhub einen
// sshd nur auf 127.0.0.1 (als Benutzer dvhub, nur der Support-Schlüssel) und
// schließt ihn mit dem Tunnel wieder.
export const CONTAINER_SSHD_BIN = '/usr/sbin/sshd';
export const CONTAINER_SSH_PORT_DEFAULT = 2222;

// Erlaubte Schlüsseltypen — wie build-authorized-keys.sh auf dem Relay.
const PUBKEY_TYPE_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521)$/;
const PUBKEY_DATA_RE = /^[A-Za-z0-9+/]+={0,3}$/;

/**
 * Vom Portal zugeteilte Relay-Ports prüfen: ganze Zahlen im Relay-Bereich,
 * verschieden. Liefert {shellPort, webPort} oder null.
 */
export function validateRelayPorts(ports) {
  const shellPort = Number(ports?.shellPort);
  const webPort = Number(ports?.webPort);
  const ok = (n) => Number.isInteger(n) && n >= RELAY_PORT_MIN && n <= RELAY_PORT_MAX;
  if (!ok(shellPort) || !ok(webPort) || shellPort === webPort) return null;
  return { shellPort, webPort };
}

/** Öffentlicher Relay-Schlüssel als „<typ> <daten>“ (ohne Kommentar), sonst null. */
export function normalizePublicKey(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length !== 1) return null;
  const [type, data] = lines[0].split(/\s+/);
  if (!PUBKEY_TYPE_RE.test(type || '') || !PUBKEY_DATA_RE.test(data || '') || data.length > 2000) return null;
  return `${type} ${data}`;
}

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
  // Ziele auf der Anlage: nativ sshd :22 und die Weboberfläche (httpPort, Standard 80);
  // im Docker-Container ein eigener sshd auf 127.0.0.1:2222 (siehe docker-entrypoint.sh).
  const localShellPort = Number(opts.localShellPort) || 22;
  const localWebPort = Number(opts.localWebPort) || 80;
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
    '-R', `127.0.0.1:${Number(shellPort)}:127.0.0.1:${localShellPort}`,
    '-R', `127.0.0.1:${Number(webPort)}:127.0.0.1:${localWebPort}`,
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

// Gibt es auf dieser Installation überhaupt ein Tunnel-Programm? Im Docker-Image
// fehlen ssh und autossh — dort kann kein Tunnel geöffnet werden (2026-10-14).
const SSH_CANDIDATES = ['/usr/bin/ssh', '/bin/ssh', '/usr/local/bin/ssh'];
export function tunnelBinaryAvailable(fsImpl = fs) {
  for (const cand of [...AUTOSSH_CANDIDATES, ...SSH_CANDIDATES]) {
    try { if (fsImpl.existsSync(cand)) return true; } catch { /* ignore */ }
  }
  return false;
}

// Factory — manages a single tunnel lifecycle. Deps are injectable for tests.
export function createSupportTunnel(ctx, deps = {}) {
  const spawnFn = deps.spawn || nodeSpawn;
  const fsImpl = deps.fs || fs;
  const now = deps.now || (() => Date.now());
  const setTimer = deps.setTimeout || setTimeout;
  const clearTimer = deps.clearTimeout || clearTimeout;
  const pushLog = (typeof ctx?.pushLog === 'function') ? ctx.pushLog : () => {};
  const execFileFn = deps.execFile || nodeExecFile;
  const inContainer = typeof deps.inContainer === 'boolean' ? deps.inContainer : process.env.DVHUB_RUNTIME === 'container';
  let sshdChild = null;
  // Eigener Dienst vorhanden? (nicht im Container — dort gibt es kein systemd)
  const unitMode = typeof deps.unitMode === 'function'
    ? deps.unitMode
    : () => {
      // Bewusst das echte Dateisystem (nicht deps.fs): die Unit liegt auf dem Host.
      if (process.env.DVHUB_RUNTIME === 'container') return false;
      try { return fs.existsSync(TUNNEL_UNIT_PATH); } catch { return false; }
    };
  const isAlive = deps.isAlive || ((pid) => {
    try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
  });

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
      relayJsonPath: path.join(supDir, 'relay.json'),
      // Dienst-Modus: Auftrag (von DVhub) und Zustand (vom Tunnel-Skript).
      requestPath: path.join(supDir, 'tunnel.json'),
      statePath: path.join(supDir, 'tunnel-state.json'),
      logPath: path.join(supDir, 'tunnel.log'),
      sshdConfigPath: path.join(supDir, 'sshd_config'),
      supportKeysPath: path.join(supDir, 'support_authorized_keys'),
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
      localShellPort: inContainer ? (Number(process.env.DVHUB_SUPPORT_SSH_PORT) || CONTAINER_SSH_PORT_DEFAULT) : 22,
      localWebPort: Number(cfg.httpPort) || 80,
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

  function readJsonFile(p) {
    try {
      const o = JSON.parse(String(fsImpl.readFileSync(p, 'utf8')));
      return (o && typeof o === 'object') ? o : null;
    } catch { return null; }
  }

  // Atomar schreiben (tmp + rename) mit festem Dateimodus.
  function writeFileAtomic(p, text, mode) {
    const tmp = `${p}.tmp-${process.pid}`;
    fsImpl.writeFileSync(tmp, text, { mode });
    try { fsImpl.chmodSync?.(tmp, mode); } catch { /* best effort */ }
    fsImpl.renameSync(tmp, p);
  }

  // Dienst-Modus: läuft der Tunnel? Das Tunnel-Skript schreibt beim Start
  // tunnel-state.json (pid, Ablauf) und löscht sie beim Ende. Ein Rest nach
  // einem harten Abbruch zählt nicht: der Prozess muss noch leben.
  function unitState() {
    const st = readJsonFile(supportPaths().statePath);
    if (!st) return null;
    const pid = Number(st.pid);
    const expires = Number(st.expiresAt);
    if (!Number.isInteger(pid) || pid <= 1 || !isAlive(pid)) return null;
    if (Number.isFinite(expires) && expires < now()) return null;
    return { openedAt: Number(st.startedAt) || null, expiresAt: Number.isFinite(expires) ? expires : null };
  }

  function unitLastError() {
    try {
      const tail = String(fsImpl.readFileSync(supportPaths().logPath, 'utf8')).trim().split('\n').filter(Boolean).slice(-3).join(' | ');
      return tail ? tail.slice(-500) : null;
    } catch { return null; }
  }

  function currentState() {
    if (unitMode()) {
      const us = unitState();
      if (!us) return { open: false, openedAt: null, expiresAt: null, openedBy: null };
      const req = readJsonFile(supportPaths().requestPath);
      return { open: true, openedAt: us.openedAt, expiresAt: us.expiresAt, openedBy: req?.openedBy || null };
    }
    return { open: !!child, openedAt, expiresAt, openedBy: child ? lastOpenedBy : null };
  }

  /** Öffentlicher Relay-Schlüssel der Box (fürs Portal), sonst null. */
  function publicKey() {
    try {
      const pub = normalizePublicKey(fsImpl.readFileSync(supportPaths().pubPath, 'utf8'));
      if (!pub) return null;
      return { pubkey: pub, fingerprint: sshKeyFingerprint(pub) };
    } catch { return null; }
  }

  /**
   * Vom Portal zugeteilte Relay-Ports in relay.json übernehmen. Host, Port und
   * Benutzer bleiben, wie support-provision.sh sie gesetzt hat. Nur schreiben,
   * wenn sich etwas ändert.
   */
  function assignRelayPorts(ports, actor = null) {
    const v = validateRelayPorts(ports);
    if (!v) return { ok: false, error: 'invalid_ports' };
    const p = supportPaths();
    const side = readRelaySidecar(p.supDir);
    if (Number(side.shellPort) === v.shellPort && Number(side.webPort) === v.webPort) return { ok: true, changed: false };
    try {
      writeFileAtomic(p.relayJsonPath, JSON.stringify({ ...side, ...v }, null, 2) + '\n', 0o644);
    } catch (e) {
      return { ok: false, error: 'write_failed', detail: String(e?.message || e).slice(0, 200) };
    }
    pushLog('support_tunnel_ports_assigned', { shellPort: v.shellPort, webPort: v.webPort }, actor);
    return { ok: true, changed: true };
  }

  function status() {
    const rc = relayConfig();
    const p = supportPaths();
    const applianceId = readApplianceId(p.dataDir, fsImpl);
    const keyPresent = exists(p.keyPath);
    const provisioned = !!applianceId && keyPresent && rc.shellPort > 0 && rc.webPort > 0;
    const t = now();
    const cur = currentState();
    return {
      open: cur.open,
      openedAt: cur.openedAt,
      openedBy: cur.openedBy,
      expiresAt: cur.expiresAt,
      ttlRemainingSec: (cur.open && cur.expiresAt) ? Math.max(0, Math.round((cur.expiresAt - t) / 1000)) : null,
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
      // Eigener Dienst (überlebt DVhub-Neustarts) oder Kindprozess.
      mode: unitMode() ? 'service' : 'process',
      // Ohne ssh/autossh (älteres Docker-Image) ist hier kein Tunnel möglich.
      capable: tunnelBinaryAvailable(fsImpl),
      // Anmeldename für den Support: nativ der eigene Benutzer dvhub-support,
      // im Container der App-Benutzer (der sshd dort läuft ohne root).
      loginUser: inContainer ? 'dvhub' : 'dvhub-support',
      shellAvailable: inContainer ? (exists(p.sshdConfigPath) && exists(p.supportKeysPath)) : rc.localUserEnabled,
      lastError: cur.open ? null : (unitMode() ? (unitLastError() || lastError) : lastError),
      // B7: CSRF-Nonce für POST /open — die UI schickt ihn automatisch mit.
      uiToken: issueUiToken(),
    };
  }

  // Leichtgewichtiger Status für den /api/status-Poll des Leitstands (3s-Takt):
  // KEIN uiToken, keine Schlüssel-/ID-Dateien (im Dienst-Modus nur die kleine
  // Zustandsdatei des Tunnels).
  function liteStatus() {
    const t = now();
    const cur = currentState();
    return {
      open: cur.open,
      expiresAt: cur.expiresAt,
      ttlRemainingSec: (cur.open && cur.expiresAt) ? Math.max(0, Math.round((cur.expiresAt - t) / 1000)) : null,
    };
  }

  function notifyClosed(reason) {
    notifyTunnel('Support-Tunnel geschlossen',
      reason === 'auto_close'
        ? 'Der Support-Tunnel wurde nach Ablauf der Zeit automatisch geschlossen.'
        : 'Der Support-Tunnel wurde geschlossen.',
      'info');
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
    stopContainerSshd();
    if (wasOpen) {
      pushLog('support_tunnel_closed', { reason: reason || 'manual' }, actor || lastOpenedBy);
      notifyClosed(reason);
    }
    lastOpenedBy = null;
  }

  // Gemeinsame Vorprüfung beider Modi. Liefert {rc, p, applianceId} oder einen Fehler.
  function preflight(actor) {
    const rc = relayConfig();
    const p = supportPaths();
    const applianceId = readApplianceId(p.dataDir, fsImpl);
    const fail = (why, detail) => {
      lastError = `not_provisioned: ${why}`;
      pushLog('support_tunnel_error', { error: lastError }, actor);
      return { error: { ok: false, error: 'not_provisioned', detail } };
    };
    if (!applianceId) return fail('appliance-id missing', 'appliance-id fehlt — Box ist nicht beim Relay registriert.');
    if (!exists(p.keyPath)) return fail('relay key missing', 'Relay-Schlüssel fehlt — Box ist nicht beim Relay registriert.');
    if (!(rc.shellPort > 0 && rc.webPort > 0)) return fail('relay ports unassigned', 'Relay-Ports nicht zugeteilt — Support muss die Box erst freischalten.');
    return { rc, p, applianceId };
  }

  function announceOpened({ ttl, binary, rc, applianceId, actor }) {
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
      + 'Falls du das nicht warst: Einstellungen → Freigaben → Fern-Support → Schließen.',
      'warning');
  }

  function runSystemctl(action) {
    return new Promise((resolve) => {
      execFileFn('sudo', ['-n', 'systemctl', action, TUNNEL_UNIT], { timeout: 15000 }, (err, stdout, stderr) => {
        resolve(err ? { ok: false, error: String(stderr || err.message || err).trim().slice(0, 300) } : { ok: true });
      });
    });
  }

  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  async function openUnit({ ttlMin } = {}, actor = null) {
    if (unitState()) return { ok: true, alreadyOpen: true, status: status() };
    const pre = preflight(actor);
    if (pre.error) return pre.error;
    const { rc, p, applianceId } = pre;
    const ttl = clampTtlMin(ttlMin, rc.autoCloseMin);
    const exp = now() + ttl * 60 * 1000;
    try {
      const openedBy = actor ? { ip: actor.ip || null, via: actor.via || actor.source || null } : null;
      // Die wirksamen Relay-Werte mitgeben (config.support.relay geht vor
      // relay.json) — das Tunnel-Skript nimmt sie von hier.
      const relay = { host: rc.host, port: rc.port, user: rc.user, shellPort: rc.shellPort, webPort: rc.webPort, localShellPort: rc.localShellPort, localWebPort: rc.localWebPort };
      writeFileAtomic(p.requestPath, JSON.stringify({ expiresAt: exp, ttlMin: ttl, openedBy, ...relay }) + '\n', 0o600);
      try { fsImpl.writeFileSync(p.logPath, ''); } catch { /* neues Protokoll je Lauf */ }
    } catch (e) {
      lastError = `request write failed: ${e.message}`;
      pushLog('support_tunnel_error', { error: lastError }, actor);
      return { ok: false, error: 'spawn_failed', detail: e.message };
    }
    const started = await runSystemctl('start');
    if (!started.ok) {
      lastError = `systemctl start failed: ${started.error}`;
      pushLog('support_tunnel_error', { error: lastError }, actor);
      return { ok: false, error: 'spawn_failed', detail: started.error };
    }
    // Das Skript schreibt seinen Zustand sofort; lehnt das Relay ab
    // (ExitOnForwardFailure), endet es in wenigen Sekunden wieder.
    let us = null;
    for (let i = 0; i < 8; i += 1) {
      await sleep(500);
      us = unitState();
    }
    if (!us) {
      lastError = unitLastError() || 'tunnel_exited';
      pushLog('support_tunnel_error', { error: lastError }, actor);
      return { ok: false, error: 'tunnel_failed', detail: lastError };
    }
    lastError = null;
    if (autoCloseTimer) clearTimer(autoCloseTimer);
    autoCloseTimer = setTimer(() => { autoCloseTimer = null; pushLog('support_tunnel_closed', { reason: 'auto_close' }, actor); notifyClosed('auto_close'); }, ttl * 60 * 1000);
    if (autoCloseTimer && typeof autoCloseTimer.unref === 'function') autoCloseTimer.unref();
    announceOpened({ ttl, binary: 'service', rc, applianceId, actor });
    return { ok: true, status: status() };
  }

  async function closeUnit(actor = null) {
    const wasOpen = !!unitState();
    const r = await runSystemctl('stop');
    try { fsImpl.unlinkSync(supportPaths().requestPath); } catch { /* war nicht da */ }
    if (autoCloseTimer) { clearTimer(autoCloseTimer); autoCloseTimer = null; }
    if (!r.ok && unitState()) {
      lastError = `systemctl stop failed: ${r.error}`;
      pushLog('support_tunnel_error', { error: lastError }, actor);
      return { ok: false, error: 'close_failed', detail: r.error, status: status() };
    }
    if (!wasOpen) return { ok: true, alreadyClosed: true, status: status() };
    pushLog('support_tunnel_closed', { reason: 'manual' }, actor);
    notifyClosed('manual');
    return { ok: true, status: status() };
  }

  // Container: sshd nur für die Dauer des Tunnels. Ohne Support-Schlüssel
  // (Kunde hat den Support-Login abgeschaltet) bleibt es beim Web-Zugang.
  function startContainerSshd(p, actor) {
    if (!inContainer || sshdChild) return;
    if (!exists(CONTAINER_SSHD_BIN) || !exists(p.sshdConfigPath) || !exists(p.supportKeysPath)) return;
    try {
      const proc = spawnFn(CONTAINER_SSHD_BIN, ['-D', '-e', '-f', p.sshdConfigPath], { stdio: ['ignore', 'ignore', 'pipe'], detached: false });
      sshdChild = proc;
      proc.on('exit', () => { if (sshdChild === proc) sshdChild = null; });
      proc.on('error', (e) => { pushLog('support_tunnel_error', { error: `sshd: ${e.message}` }, actor); });
    } catch (e) {
      pushLog('support_tunnel_error', { error: `sshd start failed: ${e.message}` }, actor);
    }
  }
  function stopContainerSshd() {
    const proc = sshdChild;
    sshdChild = null;
    if (proc) { try { proc.kill('SIGTERM'); } catch { /* already gone */ } }
  }

  function openProcess({ ttlMin } = {}, actor = null) {
    if (child) {
      // Idempotent: already open. Refresh nothing — surface current state.
      return { ok: true, alreadyOpen: true, status: status() };
    }
    const pre = preflight(actor);
    if (pre.error) return pre.error;
    const { rc, p, applianceId } = pre;

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
        localShellPort: rc.localShellPort,
        localWebPort: rc.localWebPort,
      }, { binary });
    } catch (e) {
      lastError = e.message;
      pushLog('support_tunnel_error', { error: lastError }, actor);
      return { ok: false, error: 'misconfigured', detail: e.message };
    }

    const ttl = clampTtlMin(ttlMin, rc.autoCloseMin);
    startContainerSshd(p, actor);
    let proc;
    try {
      proc = spawnFn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: false });
    } catch (e) {
      stopContainerSshd();
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
      stopContainerSshd();
      pushLog('support_tunnel_closed', { reason, unexpected: true, lastError }, lastOpenedBy);
      lastOpenedBy = null;
    });
    proc.on('error', (e) => {
      lastError = `process error: ${e.message}`;
      pushLog('support_tunnel_error', { error: lastError }, lastOpenedBy);
    });

    autoCloseTimer = setTimer(() => teardown('auto_close', lastOpenedBy), ttl * 60 * 1000);
    if (autoCloseTimer && typeof autoCloseTimer.unref === 'function') autoCloseTimer.unref();

    announceOpened({ ttl, binary, rc, applianceId, actor });
    return { ok: true, status: status() };
  }

  function closeProcess(actor = null) {
    if (!child) return { ok: true, alreadyClosed: true, status: status() };
    teardown('manual', actor);
    return { ok: true, status: status() };
  }

  // Im Dienst-Modus liefern open/close ein Promise (systemctl), sonst sofort ein
  // Ergebnis — Aufrufer nehmen beides mit `await`.
  function open(opts = {}, actor = null) {
    return unitMode() ? openUnit(opts, actor) : openProcess(opts, actor);
  }
  function close(actor = null) {
    return unitMode() ? closeUnit(actor) : closeProcess(actor);
  }

  return { open, close, status, liteStatus, consumeUiToken, publicKey, assignRelayPorts };
}
