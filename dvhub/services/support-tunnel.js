// services/support-tunnel.js — T-0113 Tier 3: customer-controlled reverse-SSH
// support tunnel.
//
// Trust model (Christin, 2026-06-08): the tunnel is the ONLY network path a
// supporter has into the appliance. It is OFF by default, opened by the
// customer via the UI button — or, since 2026-10-14, by the support via the
// installer portal, but ONLY if the customer allowed it
// (installerPortal.allowTunnel, consent box when pairing; notified on every
// open). Time-bounded (auto-close) and killable. Without an open tunnel the box
// sits behind NAT and is unreachable — the deposited support key alone grants
// nothing.
//
// Mechanics: `autossh -R` (userspace, no /dev/net/tun — works in unprivileged
// LXC) dials OUT to the self-hosted relay (support.dvhub.de) and reverse-forwards
//   relay:127.0.0.1:<shellPort> -> appliance:127.0.0.1:22     (SSH shell; container: own sshd :2222)
//   relay:127.0.0.1:<webPort>   -> appliance:127.0.0.1:<SUPPORT_WEB_PORT> (eigener Web-Listener, Strix T-0001)
// The relay enforces the two permitlisten ports server-side, so shellPort/webPort
// MUST match the relay registry (peer assigns them; we mirror into config).
//
// Keys: the appliance owns a dedicated relay keypair (Level A, Appliance->Relay,
// generated at install, private key never leaves the box). The relay hostkey is
// PINNED (StrictHostKeyChecking=yes + a baked known_hosts) against MITM on first
// connect. The supporter logs in with Christin's support key (Level B) — natively
// as the local `dvhub-support` user, in the Docker container as `dvhub` on the
// container's own sshd — a separate, customer-controllable opt-out.

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

// Strix T-0001 (30.10.2026): das Web-Ziel des Tunnels ist ein eigener Listener
// (server.js, nur 127.0.0.1) statt des normalen Ports. Dort angekommene Anfragen
// erkennt die App als „über den Support-Tunnel“ (req.dvhubSupportTunnel): kein
// Loopback-Freibrief, keine Selbstverlängerung, Kennzeichnung im Audit-Log.
// dvhub-support-tunnel.sh nutzt denselben Standard (Test hält beide gleich).
export const SUPPORT_WEB_PORT_DEFAULT = 47822;
export function supportWebPort(env = process.env) {
  const n = Number(env?.DVHUB_SUPPORT_WEB_PORT);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : SUPPORT_WEB_PORT_DEFAULT;
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

/**
 * Lauscht nativ ein sshd auf Port 22? Ehrliche Prüfung über /proc/net/tcp(6): eine LISTEN-Zeile (st=0A) mit
 * lokalem Port 0x16. true = lauscht, false = /proc lesbar, aber kein Listener, null = /proc nicht lesbar
 * (Container/Nicht-Linux/Dev) → unbekannt, der Aufrufer fällt dann auf die Einstellung zurück.
 */
export function sshdListeningOnPort22(fsImpl = fs) {
  let anyRead = false;
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let data;
    try { data = fsImpl.readFileSync(f, 'utf8'); } catch { continue; }
    anyRead = true;
    for (const line of String(data).split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4 || cols[3] !== '0A') continue; // 0A = TCP_LISTEN
      const port = cols[1].split(':')[1];
      if (port && parseInt(port, 16) === 22) return true;
    }
  }
  return anyRead ? false : null;
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

  // Task G (Support-Tunnel-Zeitgeber): während eines laufenden DVhub-Updates NICHT automatisch schließen (der
  // Support arbeitet womöglich gerade am Update). Signal: ctx.lastUpdateStartedAt (admin-routes setzt es beim
  // Start eines Release-Jobs) innerhalb einer Karenzzeit, oder eine injizierte Prüffunktion (Tests).
  const UPDATE_GRACE_MS = 20 * 60 * 1000;
  const AUTOCLOSE_RECHECK_MS = 2 * 60 * 1000; // bei aufgeschobenem Auto-Schließen so bald erneut prüfen
  const isUpdateInProgress = deps.isUpdateInProgress || (() => {
    const t = Number(ctx?.lastUpdateStartedAt);
    return Number.isFinite(t) && t > 0 && (now() - t) < UPDATE_GRACE_MS;
  });
  // Die im Portal gewählte Dauer gilt (M6, Feld 16.11.): 30 min / 1 h / 2 h / 4 h. NUR an die feste Produkt-
  // Obergrenze geklemmt (clampTtlMin → [TTL_MIN_FLOOR, TTL_MIN_CEIL] = 5 min…4 h), NICHT durch autoCloseMin gedeckelt.
  // Früher deckelte Math.min(…, clampTtlMin(autoCloseMin)) jede Portal-Dauer auf autoCloseMin (60) → 2 h/4 h wurden
  // still auf 1 h gekürzt. autoCloseMin ist nur noch der STANDARD, wenn das Portal KEINE Dauer schickt.
  const effectiveTtlMin = (ttlMin, autoCloseMin) => {
    const n = Number(ttlMin);
    if (Number.isFinite(n) && n > 0) return clampTtlMin(n);
    return clampTtlMin(autoCloseMin);
  };
  // Zeiten für die Schließen-Protokolle (Task G: jedes Schließen mit openedAt/expiresAt), BEVOR sie genullt werden.
  const closeTimes = () => ({ openedAt, expiresAt });

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
  // ctx.notifyDirect (server.js): im Worker-Betrieb läuft dieser Dienst im
  // Web-Prozess, dessen Benachrichtigungsdienst nie gestartet wird — die
  // Meldung geht dann an den Runtime-Worker (Codex-Prüfung release/1.0.9, P2).
  function notifyTunnel(title, body, level) {
    try {
      const msg = { event: 'support_tunnel', level: level || 'warning', title, body };
      const svc = ctx?.notificationService;
      const send = typeof ctx?.notifyDirect === 'function' ? ctx.notifyDirect
        : (svc && typeof svc.sendDirect === 'function' ? (m) => svc.sendDirect(m) : null);
      if (send) Promise.resolve(send(msg)).catch(() => { /* fire-and-forget */ });
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
      // Ohne Tunnel-Unit (kein systemd, Container): PID des selbst gestarteten
      // autossh/ssh — damit dvhub-support-tunnel.sh --close ihn findet (T-0004).
      processStatePath: path.join(supDir, 'tunnel-process.json'),
      logPath: path.join(supDir, 'tunnel.log'),
      // Letzte Aktionen des Fern-Supports (für den Kunden sichtbar, überlebt
      // einen Neustart — Token-Widerruf startet DVhub neu).
      actionsPath: path.join(supDir, 'actions.json'),
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
      localWebPort: supportWebPort(),
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

  // Info-Zeilen von dvhub-support-tunnel.sh (Dienst-Modus) — kein Fehler. Vorher
  // meldete status() nach dem Schließen „Tunnel: Relay …“ als lastError ans Portal.
  const TUNNEL_INFO_LINE = /^(Tunnel: Relay |Tunnel nach Ablauf geschlossen|Auftrag abgelaufen)/;

  function unitLastError() {
    try {
      const tail = String(fsImpl.readFileSync(supportPaths().logPath, 'utf8')).trim().split('\n')
        .filter((l) => l && !TUNNEL_INFO_LINE.test(l)).slice(-3).join(' | ');
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

  // Ehrliche Verfügbarkeit der Fern-Shell + Grund. Nativ reicht die Einstellung (localUserEnabled) nicht —
  // ohne laufenden sshd auf :22 (openssh-server) kommt der Tunnel nicht an der Box an. Container: eigener sshd
  // (sshd_config + Support-Schlüssel vom Entrypoint).
  function shellState() {
    const rc = relayConfig();
    const p = supportPaths();
    if (inContainer) {
      const ok = exists(p.sshdConfigPath) && exists(p.supportKeysPath);
      return { shellAvailable: ok, shellReason: ok ? null : 'container_sshd_not_ready' };
    }
    if (!rc.localUserEnabled) return { shellAvailable: false, shellReason: 'local_user_disabled' };
    const listening = sshdListeningOnPort22(fsImpl);
    if (listening === false) return { shellAvailable: false, shellReason: 'sshd_not_listening' };
    // listening true oder unbekannt (Dev/Nicht-Linux) → als verfügbar gelten (Einstellung ist an).
    return { shellAvailable: true, shellReason: null };
  }

  // Restzeit-Warnschwelle fürs Portal/Leitstand (Aufgabe 10): „vor Ablauf warnen". Unter 5 min gilt der Tunnel
  // als bald fällig; die Oberfläche hebt das hervor.
  const TTL_WARN_SEC = 5 * 60;

  // Dienst-Modus: hat sich die systemd-Unit SELBST beendet (Relay-Abbruch, ssh tot, Ablauf durchs Tunnel-Skript,
  // „systemctl stop" von außen), ohne dass DVhub geschlossen hat? Dann protokolliert sonst NIEMAND den Grund (Feld
  // 15.11.: „13:03:44 Tunnel zu, Grund war nicht auffindbar"). Hier ein einziges Mal support_tunnel_closed mit Grund
  // + Zeiten nachziehen und den Zustand aufräumen. Der Wächter läuft bei jedem Status-Poll (liteStatus/status).
  // Greift nur, wenn DIESER Prozess den Tunnel geöffnet hat (openedAt gesetzt) — nach einem DVhub-Neustart ist die
  // Öffnungszeit unbekannt, dann gibt es nichts nachzuziehen.
  function reconcileUnitClose() {
    if (!unitMode() || openedAt == null) return;
    if (unitState()) return;                       // Unit läuft noch → nichts zu tun
    const times = closeTimes();                    // openedAt/expiresAt VOR dem Nullen festhalten
    const expired = Number.isFinite(Number(expiresAt)) && Number(expiresAt) <= now();
    const detail = unitLastError();
    const reason = expired ? 'auto_close' : 'unit_exited';
    if (autoCloseTimer) { clearTimer(autoCloseTimer); autoCloseTimer = null; }
    openedAt = null;
    expiresAt = null;
    pushLog('support_tunnel_closed', { reason, external: true, ...(detail ? { detail } : {}), ...times }, lastOpenedBy);
    notifyClosed(reason);
    lastOpenedBy = null;
  }

  function status() {
    reconcileUnitClose();
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
      // Aufgabe 10: „vor Ablauf warnen" — offen und ≤ 5 min Restzeit.
      expiringSoon: (cur.open && cur.expiresAt) ? (cur.expiresAt - t) <= TTL_WARN_SEC * 1000 : false,
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
      ...shellState(),
      lastError: cur.open ? null : (unitMode() ? (unitLastError() || lastError) : lastError),
      // B7: CSRF-Nonce für POST /open — die UI schickt ihn automatisch mit.
      uiToken: issueUiToken(),
      // Was der Fern-Support über den Tunnel geändert hat (neueste zuerst).
      recentActions: recentActions(),
    };
  }

  // Leichtgewichtiger Status für den /api/status-Poll des Leitstands (3s-Takt):
  // KEIN uiToken, keine Schlüssel-/ID-Dateien (im Dienst-Modus nur die kleine
  // Zustandsdatei des Tunnels).
  function liteStatus() {
    reconcileUnitClose();
    const t = now();
    const cur = currentState();
    // Für den Leitstand-Banner: Token-, Kopplungs- und Sicherheitsänderungen
    // seit der Tunnel offen ist (höchstens drei, neueste zuerst).
    const since = cur.open ? Number(cur.openedAt) || 0 : null;
    const sensitive = since == null ? [] : recentActions()
      .filter((a) => a.kind && Date.parse(a.ts) >= since)
      .slice(0, 3)
      .map((a) => ({ ts: a.ts, kind: a.kind, label: a.label, route: a.route }));
    return {
      open: cur.open,
      expiresAt: cur.expiresAt,
      ttlRemainingSec: (cur.open && cur.expiresAt) ? Math.max(0, Math.round((cur.expiresAt - t) / 1000)) : null,
      // Aufgabe 10: Leitstand-Banner warnt vor Ablauf (≤ 5 min Restzeit).
      expiringSoon: (cur.open && cur.expiresAt) ? (cur.expiresAt - t) <= TTL_WARN_SEC * 1000 : false,
      recentChanges: sensitive,
    };
  }

  // ── Fern-Support-Aktionen (Christin 04.11.2026) ───────────────────────────
  // Der Fern-Support darf über den Tunnel alles für Reparaturen; als Ausgleich
  // sieht der Kunde jede Änderung (Liste unter Einstellungen → Fern-Support,
  // Banner im Leitstand) und bekommt bei Token-, Kopplungs- und
  // Sicherheitsänderungen eine Benachrichtigung. Nur Schlüssel und Pfade,
  // nie Werte (routes-api.js legt den Eintrag an).
  const ACTIONS_MAX = 30;
  const NOTIFY_GAP_MS = 60 * 1000;
  let actionsCache = null;
  const lastNotified = new Map();

  function recentActions() {
    if (actionsCache) return actionsCache.slice();
    const o = readJsonFile(supportPaths().actionsPath);
    actionsCache = Array.isArray(o?.actions) ? o.actions.filter((a) => a && typeof a === 'object').slice(0, 2 * ACTIONS_MAX) : [];
    return actionsCache.slice();
  }

  function recordAction(entry = {}) {
    const a = {
      ts: new Date(now()).toISOString(),
      method: String(entry.method || '').slice(0, 10),
      route: String(entry.route || '').slice(0, 160),
      status: Number(entry.status) || 0,
      keys: Array.isArray(entry.keys) ? entry.keys.slice(0, 40).map((k) => String(k).slice(0, 64)) : [],
      ...(Array.isArray(entry.changedPaths) && entry.changedPaths.length ? { changedPaths: entry.changedPaths.slice(0, 40).map((k) => String(k).slice(0, 120)) } : {}),
      ...(entry.kind ? { kind: String(entry.kind), label: String(entry.label || entry.kind).slice(0, 80) } : {}),
    };
    // Token-, Kopplungs- und Sicherheitsänderungen getrennt behalten: viele
    // harmlose Aufrufe dürfen sie nicht aus der Liste drängen (Gegenprüfung
    // dca8ac88, P3). Je Art höchstens ACTIONS_MAX, neueste zuerst.
    const all = [a, ...recentActions()];
    const sensitive = all.filter((x) => x.kind).slice(0, ACTIONS_MAX);
    const plain = all.filter((x) => !x.kind).slice(0, ACTIONS_MAX);
    actionsCache = all.filter((x) => sensitive.includes(x) || plain.includes(x));
    try {
      const p = supportPaths();
      fsImpl.mkdirSync(p.supDir, { recursive: true, mode: 0o700 });
      writeFileAtomic(p.actionsPath, JSON.stringify({ actions: actionsCache }) + '\n', 0o600);
    } catch { /* Anzeige ist best-effort — das Audit-Log hat den Eintrag */ }
    if (a.kind) {
      const key = `${a.kind}|${a.route}`;
      const t = now();
      if (!lastNotified.has(key) || t - lastNotified.get(key) >= NOTIFY_GAP_MS) {
        lastNotified.set(key, t);
        const what = a.changedPaths?.length ? ` (${a.changedPaths.slice(0, 5).join(', ')}${a.changedPaths.length > 5 ? ', …' : ''})` : '';
        notifyTunnel(`Fern-Support: ${a.label} geändert`,
          `Über den Support-Tunnel geändert: ${a.route}${what}. `
          + 'Alle Aktionen: Einstellungen → Freigaben → Fern-Support.',
          'warning');
      }
    }
    return a;
  }

  function notifyClosed(reason) {
    notifyTunnel('Support-Tunnel geschlossen',
      reason === 'auto_close'
        ? 'Der Support-Tunnel wurde nach Ablauf der Zeit automatisch geschlossen.'
        : 'Der Support-Tunnel wurde geschlossen.',
      'info');
  }

  function removeProcessState() {
    try { fsImpl.unlinkSync(supportPaths().processStatePath); } catch { /* war nicht da */ }
  }

  // Auto-Schließen fällig (Prozessmodus): läuft gerade ein Update, NICHT schließen, sondern den Zeitgeber kurz
  // neu setzen und später erneut prüfen (Task G4). Sonst regulär abbauen.
  function autoCloseDue(actor) {
    autoCloseTimer = null;
    if (!child) return; // schon zu
    if (isUpdateInProgress()) {
      pushLog('support_tunnel_autoclose_deferred', { reason: 'update_in_progress', recheckMs: AUTOCLOSE_RECHECK_MS, ...closeTimes() }, actor || lastOpenedBy);
      autoCloseTimer = setTimer(() => autoCloseDue(actor), AUTOCLOSE_RECHECK_MS);
      if (autoCloseTimer && typeof autoCloseTimer.unref === 'function') autoCloseTimer.unref();
      return;
    }
    teardown('auto_close', actor);
  }

  function teardown(reason, actor) {
    if (autoCloseTimer) { clearTimer(autoCloseTimer); autoCloseTimer = null; }
    const wasOpen = !!child;
    const times = closeTimes(); // openedAt/expiresAt VOR dem Nullen festhalten (Task G: jedes Schließen mit Grund + Zeiten)
    const proc = child;
    child = null;
    openedAt = null;
    expiresAt = null;
    if (proc) {
      try { proc.kill('SIGTERM'); } catch { /* already gone */ }
    }
    removeProcessState();
    stopContainerSshd();
    if (wasOpen) {
      pushLog('support_tunnel_closed', { reason: reason || 'manual', ...times }, actor || lastOpenedBy);
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
    // Gegenprüfung 6f9c9cca (P3): ist der Support-Port zugleich der normale
    // Port, startet kein eigener Listener, und der Tunnel landete mit
    // Loopback-Freibrief am normalen Port — dann lieber nicht öffnen.
    const cfgNow = (typeof ctx?.getCfg === 'function' ? ctx.getCfg() : null) || {};
    if (rc.localWebPort === (Number(cfgNow.httpPort) || 80)) {
      lastError = `support_web_port_conflict: ${rc.localWebPort}`;
      pushLog('support_tunnel_error', { error: lastError }, actor);
      return { error: { ok: false, error: 'support_web_port_conflict', detail: `Support-Port ${rc.localWebPort} ist zugleich der Web-Port — DVHUB_SUPPORT_WEB_PORT anders setzen.` } };
    }
    return { rc, p, applianceId };
  }

  function announceOpened({ ttl, requestedMin = null, binary, rc, applianceId, actor }) {
    pushLog('support_tunnel_opened', {
      ttlMin: ttl,
      // M6 (Feld 16.11.): zeigt, ob die vom Portal GEWÜNSCHTE Dauer ankam (requestedMin) und was WIRKSAM gilt
      // (effectiveMin). requestedMin null = das Portal hat keine Dauer geschickt → es gilt der Standard (autoCloseMin).
      requestedMin: Number.isFinite(Number(requestedMin)) && Number(requestedMin) > 0 ? Math.round(Number(requestedMin)) : null,
      effectiveMin: ttl,
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

  // Request-Datei mit neuer Frist schreiben (Unit-Modus: das Tunnel-Skript nimmt expiresAt von hier). Für den
  // Erst-Start UND für das Auffrischen beim erneuten open() (Task G1).
  function writeUnitRequest(p, rc, ttl, actor) {
    const exp = now() + ttl * 60 * 1000;
    const openedBy = actor ? { ip: actor.ip || null, via: actor.via || actor.source || null } : null;
    const relay = { host: rc.host, port: rc.port, user: rc.user, shellPort: rc.shellPort, webPort: rc.webPort, localShellPort: rc.localShellPort, localWebPort: rc.localWebPort };
    writeFileAtomic(p.requestPath, JSON.stringify({ expiresAt: exp, ttlMin: ttl, openedBy, ...relay }) + '\n', 0o600);
    return exp;
  }

  async function openUnit({ ttlMin } = {}, actor = null) {
    const pre = preflight(actor);
    if (pre.error) { if (unitState()) return { ok: true, alreadyOpen: true, status: status() }; return pre.error; }
    const { rc, p, applianceId } = pre;
    const ttl = effectiveTtlMin(ttlMin, rc.autoCloseMin); // Task G3: nie länger als die Policy autoCloseMin
    if (unitState()) {
      // Task G1: erneutes open() frischt die Frist auf — Request neu schreiben (Skript verlängert) + Zeitgeber neu.
      try { expiresAt = writeUnitRequest(p, rc, ttl, actor); openedAt = openedAt || now(); } catch (e) { pushLog('support_tunnel_error', { error: `refresh write failed: ${e.message}` }, actor); return { ok: true, alreadyOpen: true, status: status() }; }
      if (autoCloseTimer) clearTimer(autoCloseTimer);
      autoCloseTimer = setTimer(() => { autoCloseTimer = null; if (isUpdateInProgress()) { pushLog('support_tunnel_autoclose_deferred', { reason: 'update_in_progress', ...closeTimes() }, actor); return; } pushLog('support_tunnel_closed', { reason: 'auto_close', ...closeTimes() }, actor); notifyClosed('auto_close'); openedAt = null; expiresAt = null; }, ttl * 60 * 1000);
      if (autoCloseTimer && typeof autoCloseTimer.unref === 'function') autoCloseTimer.unref();
      pushLog('support_tunnel_refreshed', { ttlMin: ttl, openedAt, expiresAt }, actor);
      return { ok: true, alreadyOpen: true, refreshed: true, status: status() };
    }
    let exp;
    try {
      exp = writeUnitRequest(p, rc, ttl, actor);
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
    openedAt = now();
    expiresAt = exp;
    if (autoCloseTimer) clearTimer(autoCloseTimer);
    // Task G4: läuft ein Update, nicht schließen, sondern den Zeitgeber kurz neu setzen. Das echte Ablaufen
    // erzwingt ohnehin das Tunnel-Skript über expiresAt in der Request-Datei; dieser Zeitgeber ist Log/Notify.
    const unitAutoClose = () => {
      autoCloseTimer = null;
      if (!unitState()) return;
      if (isUpdateInProgress()) { pushLog('support_tunnel_autoclose_deferred', { reason: 'update_in_progress', ...closeTimes() }, actor); autoCloseTimer = setTimer(unitAutoClose, AUTOCLOSE_RECHECK_MS); if (autoCloseTimer?.unref) autoCloseTimer.unref(); return; }
      pushLog('support_tunnel_closed', { reason: 'auto_close', ...closeTimes() }, actor);
      notifyClosed('auto_close');
      // Geschlossen protokolliert → openedAt nullen, damit reconcileUnitClose beim späteren Unit-Ende nicht
      // ein ZWEITES support_tunnel_closed schreibt (Aufgabe 10).
      openedAt = null; expiresAt = null;
    };
    autoCloseTimer = setTimer(unitAutoClose, ttl * 60 * 1000);
    if (autoCloseTimer && typeof autoCloseTimer.unref === 'function') autoCloseTimer.unref();
    announceOpened({ ttl, requestedMin: ttlMin, binary: 'service', rc, applianceId, actor });
    return { ok: true, status: status() };
  }

  async function closeUnit(actor = null) {
    const wasOpen = !!unitState();
    const times = closeTimes();
    const r = await runSystemctl('stop');
    try { fsImpl.unlinkSync(supportPaths().requestPath); } catch { /* war nicht da */ }
    if (autoCloseTimer) { clearTimer(autoCloseTimer); autoCloseTimer = null; }
    openedAt = null; expiresAt = null;
    if (!r.ok && unitState()) {
      lastError = `systemctl stop failed: ${r.error}`;
      pushLog('support_tunnel_error', { error: lastError }, actor);
      return { ok: false, error: 'close_failed', detail: r.error, status: status() };
    }
    if (!wasOpen) return { ok: true, alreadyClosed: true, status: status() };
    pushLog('support_tunnel_closed', { reason: 'manual', ...times }, actor);
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
    const pre = preflight(actor);
    if (pre.error) {
      // Schon offen, aber die Vorprüfung schlägt jetzt fehl: nicht hart scheitern, den offenen Tunnel lassen.
      if (child) return { ok: true, alreadyOpen: true, status: status() };
      return pre.error;
    }
    const { rc, p, applianceId } = pre;
    if (child) {
      // Task G1: ein erneutes open() ist NICHT nur idempotent — es bricht den laufenden Schließ-Zeitgeber ab und
      // setzt ihn neu (die TTL beginnt von vorn), damit „nochmal öffnen" den Tunnel verlängert statt ihn
      // überraschend ablaufen zu lassen.
      const ttlR = effectiveTtlMin(ttlMin, rc.autoCloseMin);
      if (autoCloseTimer) clearTimer(autoCloseTimer);
      expiresAt = now() + ttlR * 60 * 1000;
      autoCloseTimer = setTimer(() => autoCloseDue(lastOpenedBy), ttlR * 60 * 1000);
      if (autoCloseTimer && typeof autoCloseTimer.unref === 'function') autoCloseTimer.unref();
      pushLog('support_tunnel_refreshed', { ttlMin: ttlR, openedAt, expiresAt }, actor || lastOpenedBy);
      return { ok: true, alreadyOpen: true, refreshed: true, status: status() };
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
        localShellPort: rc.localShellPort,
        localWebPort: rc.localWebPort,
      }, { binary });
    } catch (e) {
      lastError = e.message;
      pushLog('support_tunnel_error', { error: lastError }, actor);
      return { ok: false, error: 'misconfigured', detail: e.message };
    }

    const ttl = effectiveTtlMin(ttlMin, rc.autoCloseMin); // Task G3: nie länger als die Policy autoCloseMin
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
    try { if (Number.isInteger(proc.pid)) writeFileAtomic(p.processStatePath, JSON.stringify({ pid: proc.pid }) + '\n', 0o600); }
    catch { /* nur für das Notfall-Skript */ }
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
      // Erst nach der Prüfung: ein alter Prozess, der nach einem neuen open()
      // endet, löschte sonst die PID-Datei des neuen (Gegenprüfung 98bfcb68).
      if (child !== proc) return; // already torn down by close()/auto-close
      removeProcessState();
      if (autoCloseTimer) { clearTimer(autoCloseTimer); autoCloseTimer = null; }
      const times = closeTimes();
      child = null;
      openedAt = null;
      expiresAt = null;
      const reason = signal ? `signal:${signal}` : `exit:${code}`;
      stopContainerSshd();
      pushLog('support_tunnel_closed', { reason, unexpected: true, lastError, ...times }, lastOpenedBy);
      lastOpenedBy = null;
    });
    proc.on('error', (e) => {
      lastError = `process error: ${e.message}`;
      pushLog('support_tunnel_error', { error: lastError }, lastOpenedBy);
    });

    autoCloseTimer = setTimer(() => autoCloseDue(lastOpenedBy), ttl * 60 * 1000);
    if (autoCloseTimer && typeof autoCloseTimer.unref === 'function') autoCloseTimer.unref();

    announceOpened({ ttl, requestedMin: ttlMin, binary, rc, applianceId, actor });
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

  return { open, close, status, liteStatus, consumeUiToken, publicKey, assignRelayPorts, recordAction, recentActions };
}
