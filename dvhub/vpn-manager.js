// vpn-manager.js -- VPN tunnel manager for Direktvermarkter communication.
// Factory receives DI context; all state access through ctx.

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const fsPromises = fs.promises;

const CONFIG_DIR = process.env.DV_APP_CONFIG
  ? path.dirname(process.env.DV_APP_CONFIG)
  : '/etc/dvhub';
const VPN_DIR = path.join(CONFIG_DIR, 'vpn');
const PROFILES_DIR = path.join(VPN_DIR, 'profiles');

const DANGEROUS_DIRECTIVES = new Set([
  'up', 'down', 'route-up', 'route-pre-down', 'ipchange',
  'client-connect', 'client-disconnect', 'learn-address',
  'tls-verify', 'auth-user-pass-verify', 'management-external-key',
  'plugin', 'script-security'
]);
// Extended OpenVPN blocklist (RepoLens injection/007): these allow arbitrary
// command execution, script loading, or expose a privileged management
// interface that lets any TCP/unix-socket peer control the daemon.
DANGEROUS_DIRECTIVES.add('iproute');
DANGEROUS_DIRECTIVES.add('tls-crypt-v2-verify');
DANGEROUS_DIRECTIVES.add('management');
DANGEROUS_DIRECTIVES.add('management-client-auth');
DANGEROUS_DIRECTIVES.add('management-client-user');
DANGEROUS_DIRECTIVES.add('management-client-group');

// WireGuard/IPSec dangerous-directive blocklists — mirror the OpenVPN pattern.
// WG PostUp/PreUp/PostDown/PreDown run arbitrary shell commands as root when
// wg-quick brings the tunnel up/down (RepoLens security/input-sanitization/019).
const WG_DANGEROUS_DIRECTIVES = new Set(['PostUp', 'PreUp', 'PostDown', 'PreDown']);
// strongSwan leftupdown/rightupdown run scripts as root on SA up/down;
// `include` pulls additional config files and can bypass any per-file scan
// (RepoLens security/input-sanitization/020).
const IPSEC_DANGEROUS_KEYS = new Set(['leftupdown', 'rightupdown', 'include']);

// Tight character class for anything that ends up in a sudo ln/rm argument.
// Mirrors profileDir() below and the narrowed sudoers rules in install.sh /
// post-update.sh. Exported for tests + reuse from callers.
export function sanitizeProfileName(name) {
  return String(name || 'direktvermarkter').replace(/[^a-zA-Z0-9_-]/g, '');
}

const FORCED_DIRECTIVES = [
  'script-security 0',
  'persist-tun',
  'persist-key',
  'keepalive 10 60',
  'verb 3'
];

const REQUIRED_DIRECTIVES = ['remote'];

// ── WireGuard validation ──

const WG_REQUIRED_SECTIONS = ['[Interface]', '[Peer]'];
const WG_REQUIRED_INTERFACE_KEYS = ['PrivateKey', 'Address'];
const WG_REQUIRED_PEER_KEYS = ['PublicKey', 'Endpoint'];

export function validateWireGuardConfig(content) {
  const lines = content.split(/\r?\n/);
  const errors = [];
  const sections = new Set();
  let currentSection = null;
  const sectionKeys = {};

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const sectionMatch = line.match(/^\[(\w+)\]$/);
    if (sectionMatch) {
      currentSection = `[${sectionMatch[1]}]`;
      sections.add(currentSection);
      if (!sectionKeys[currentSection]) sectionKeys[currentSection] = new Set();
      continue;
    }

    const kvMatch = line.match(/^(\w+)\s*=/);
    if (kvMatch && WG_DANGEROUS_DIRECTIVES.has(kvMatch[1])) {
      errors.push(`Blocked dangerous WireGuard directive: ${kvMatch[1]}`);
      continue;
    }
    if (kvMatch && currentSection) {
      sectionKeys[currentSection].add(kvMatch[1]);
    }
  }

  for (const req of WG_REQUIRED_SECTIONS) {
    if (!sections.has(req)) errors.push(`Missing required section: ${req}`);
  }

  const ifKeys = sectionKeys['[Interface]'] || new Set();
  for (const key of WG_REQUIRED_INTERFACE_KEYS) {
    if (!ifKeys.has(key)) errors.push(`Missing [Interface] key: ${key}`);
  }

  const peerKeys = sectionKeys['[Peer]'] || new Set();
  for (const key of WG_REQUIRED_PEER_KEYS) {
    if (!peerKeys.has(key)) errors.push(`Missing [Peer] key: ${key}`);
  }

  return { valid: errors.length === 0, errors, sections: [...sections] };
}

// ── IPSec/StrongSwan validation ──

export function validateIPSecConfig(content) {
  const lines = content.split(/\r?\n/);
  const errors = [];
  const connections = [];
  let currentConn = null;
  const connKeys = {};

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    // Top-level `include other.conf` (case-insensitive) — strongSwan ships this
    // parse-time directive that pulls arbitrary files in as config, so it
    // bypasses any per-file scan (RepoLens security/input-sanitization/020).
    if (/^include\s+/i.test(line)) {
      errors.push('Blocked dangerous IPSec directive: include (top-level)');
      continue;
    }

    // conn section: "conn myconnection"
    const connMatch = line.match(/^conn\s+(\S+)/);
    if (connMatch) {
      currentConn = connMatch[1];
      if (currentConn !== '%default') {
        // Reject shell-dangerous / path-traversal characters in the conn name
        // before it flows through to sudo ipsec up <connName>.
        if (!/^[A-Za-z0-9_.-]+$/.test(currentConn)) {
          errors.push(`Invalid IPSec conn name "${currentConn}" (must match [A-Za-z0-9_.-]+)`);
          currentConn = '%default'; // skip further keys for this conn
          continue;
        }
        connections.push(currentConn);
        connKeys[currentConn] = new Set();
      }
      continue;
    }

    // config section headers (config setup, ca, etc.)
    if (/^(config|ca)\s+/.test(line)) {
      currentConn = null;
      continue;
    }

    // key=value inside a conn section
    const kvMatch = line.match(/^(\w+)\s*=/);
    if (kvMatch && IPSEC_DANGEROUS_KEYS.has(kvMatch[1].toLowerCase())) {
      errors.push(`Blocked dangerous IPSec directive: ${kvMatch[1]}`);
      continue;
    }
    if (kvMatch && currentConn && currentConn !== '%default') {
      connKeys[currentConn].add(kvMatch[1]);
    }
  }

  if (connections.length === 0) {
    errors.push('Missing conn section (at least one named connection required)');
  }

  for (const conn of connections) {
    const keys = connKeys[conn] || new Set();
    if (!keys.has('right') && !keys.has('rightid')) {
      errors.push(`conn ${conn}: missing "right" or "rightid" (remote endpoint)`);
    }
  }

  return { valid: errors.length === 0, errors, connections };
}

export function createVpnManager(ctx) {
  const { state, getCfg, pushLog } = ctx;

  // -- state initialisation --
  state.vpn = {
    enabled: false,
    status: 'disconnected',
    protocol: 'openvpn',
    tunIp: null,
    remoteIp: null,
    upSince: null,
    uptimeSeconds: 0,
    bytesSent: 0,
    bytesReceived: 0,
    lastModbusActivity: null,
    reconnectAttempts: 0,
    lastReconnectAt: null,
    lastError: null,
    certExpiry: null,
    certDaysRemaining: null,
    watchdogOk: false,
    profileName: null
  };

  let openvpnProcess = null;
  let openvpnPid = null;
  let watchdogInterval = null;
  let reconnectTimer = null;
  let backoffMs = 5000;
  let failCount = 0;
  let starting = false; // mutex against double-start
  let certCheckInterval = null;

  // ── helpers ──

  function vpnCfg() {
    const c = getCfg();
    return c.vpn || {};
  }

  function profileDir(name) {
    // Delegate to the module-scope sanitiser so every path- and sudo-boundary
    // applies an identical character class. Keeping this thin lets call sites
    // still use profileDir() where they mix base-dir joining with sanitation.
    return path.join(PROFILES_DIR, sanitizeProfileName(name));
  }

  function configPath(name) {
    const proto = vpnCfg().protocol || 'openvpn';
    if (proto === 'wireguard') return path.join(profileDir(name), 'wg0.conf');
    if (proto === 'ipsec') return path.join(profileDir(name), 'ipsec.conf');
    return path.join(profileDir(name), 'client.ovpn');
  }

  function wgInterfaceName() {
    return 'wg0';
  }

  function tunInterfaceName() {
    const proto = vpnCfg().protocol || 'openvpn';
    if (proto === 'wireguard') return wgInterfaceName();
    // IPSec uses kernel xfrm policies, no dedicated tun interface
    // healthCheck uses ipsec status instead
    return 'tun0';
  }

  /** Extract first named connection from ipsec.conf content.
   *  Returns null if no conn is found OR if the conn name contains anything
   *  outside [A-Za-z0-9_.-] — we refuse to feed shell-metacharacter names into
   *  `sudo ipsec up <connName>` even though execFile is array-form.
   */
  function extractIPSecConnName(content) {
    const match = content.match(/^conn\s+(?!%default\b)(\S+)/m);
    if (!match) return null;
    const name = match[1];
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) return null;
    return name;
  }

  /** Read stored ipsec.conf to get connection name */
  async function getIPSecConnName() {
    const vc = vpnCfg();
    const cfgPath = vc.configPath || configPath(vc.profileName);
    try {
      const content = await fsPromises.readFile(cfgPath, 'utf8');
      return extractIPSecConnName(content);
    } catch {
      return null;
    }
  }

  // ── .ovpn config validation ──

  function validateOvpnConfig(content) {
    const lines = content.split(/\r?\n/);
    const errors = [];
    const directives = new Set();

    // Only cert/key block bodies should be skipped. <connection> blocks
    // contain regular directives and used to fully bypass the dangerous-
    // directive scan when we blanket-skipped every line starting with "<".
    const CERT_BLOCK_TAGS = new Set([
      'ca', 'cert', 'key', 'tls-auth', 'tls-crypt', 'dh', 'extra-certs', 'pkcs12'
    ]);
    let inCertBlock = null; // lowercase tag name when inside a cert block, else null

    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) continue;

      const openMatch = line.match(/^<([a-z0-9-]+)>$/i);
      const closeMatch = line.match(/^<\/([a-z0-9-]+)>$/i);
      if (openMatch && CERT_BLOCK_TAGS.has(openMatch[1].toLowerCase())) {
        inCertBlock = openMatch[1].toLowerCase();
        continue;
      }
      if (closeMatch && inCertBlock === closeMatch[1].toLowerCase()) {
        inCertBlock = null;
        continue;
      }
      if (inCertBlock) continue;

      // <connection> … </connection> wrappers are structural only; the
      // directives nested inside them fall through to the scan below.
      if (openMatch && openMatch[1].toLowerCase() === 'connection') continue;
      if (closeMatch && closeMatch[1].toLowerCase() === 'connection') continue;

      // Any other <tag> line that reaches here is unknown/unsupported — treat
      // it as a regular directive line for safety (directive will be the `<…>`
      // literal, which never matches DANGEROUS_DIRECTIVES but is tracked).
      const directive = line.split(/\s+/)[0].toLowerCase();
      directives.add(directive);

      if (DANGEROUS_DIRECTIVES.has(directive)) {
        errors.push(`Blocked dangerous directive: ${directive}`);
      }
    }

    for (const req of REQUIRED_DIRECTIVES) {
      if (!directives.has(req)) {
        errors.push(`Missing required directive: ${req}`);
      }
    }

    // cert/key can be inline (<ca>, <cert>, <key>) or file references
    const hasInlineCa = content.includes('<ca>');
    const hasInlineCert = content.includes('<cert>');
    const hasInlineKey = content.includes('<key>');
    const hasCaRef = directives.has('ca');
    const hasCertRef = directives.has('cert');
    const hasKeyRef = directives.has('key');

    if (!hasInlineCa && !hasCaRef) errors.push('Missing CA certificate (inline <ca> or ca directive)');
    if (!hasInlineCert && !hasCertRef && !directives.has('pkcs12') && !directives.has('auth-user-pass')) {
      // cert might not be needed with auth-user-pass or pkcs12
    }

    return { valid: errors.length === 0, errors, directives: [...directives] };
  }

  function buildSecureConfig(originalContent) {
    let content = originalContent;

    // strip any existing dangerous directives
    const lines = content.split(/\r?\n/);
    const filtered = lines.filter(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';') || trimmed.startsWith('<')) return true;
      const directive = trimmed.split(/\s+/)[0].toLowerCase();
      return !DANGEROUS_DIRECTIVES.has(directive);
    });

    // append forced directives
    filtered.push('');
    filtered.push('# -- DVhub forced directives --');
    for (const d of FORCED_DIRECTIVES) {
      filtered.push(d);
    }

    return filtered.join('\n');
  }

  // ── config import ──

  async function importConfig(configContent, certFiles = {}) {
    const vc = vpnCfg();
    const proto = vc.protocol || 'openvpn';
    const name = vc.profileName || 'direktvermarkter';
    const dir = profileDir(name);

    if (proto === 'wireguard') {
      const validation = validateWireGuardConfig(configContent);
      if (!validation.valid) return { ok: false, errors: validation.errors };

      await fsPromises.mkdir(dir, { recursive: true });
      await fsPromises.writeFile(path.join(dir, 'wg0.conf'), configContent, { mode: 0o600 });

      pushLog('vpn_config_imported', { profile: name, protocol: 'wireguard' });
      return { ok: true, profile: name };
    }

    if (proto === 'ipsec') {
      const validation = validateIPSecConfig(configContent);
      if (!validation.valid) return { ok: false, errors: validation.errors };

      await fsPromises.mkdir(dir, { recursive: true });
      await fsPromises.writeFile(path.join(dir, 'ipsec.conf'), configContent, { mode: 0o600 });

      // write secrets file if provided
      if (certFiles.secrets) {
        await fsPromises.writeFile(path.join(dir, 'ipsec.secrets'), certFiles.secrets, { mode: 0o600 });
      }
      // write optional cert/key files for cert-based auth
      const ipsecCertMap = { 'ca.crt': certFiles.ca, 'client.crt': certFiles.cert, 'client.key': certFiles.key };
      for (const [filename, data] of Object.entries(ipsecCertMap)) {
        if (data) {
          await fsPromises.writeFile(path.join(dir, filename), data, { mode: 0o600 });
        }
      }

      pushLog('vpn_config_imported', { profile: name, protocol: 'ipsec', connection: validation.connections[0] });
      if (certFiles.cert || certFiles.ca) await checkCertExpiry();
      return { ok: true, profile: name };
    }

    // OpenVPN path
    const validation = validateOvpnConfig(configContent);
    if (!validation.valid) return { ok: false, errors: validation.errors };

    await fsPromises.mkdir(dir, { recursive: true });

    const secureContent = buildSecureConfig(configContent);
    await fsPromises.writeFile(path.join(dir, 'client.ovpn'), secureContent, { mode: 0o600 });

    const certMap = { 'ca.crt': certFiles.ca, 'client.crt': certFiles.cert, 'client.key': certFiles.key, 'ta.key': certFiles.ta };
    for (const [filename, data] of Object.entries(certMap)) {
      if (data) {
        await fsPromises.writeFile(path.join(dir, filename), data, { mode: 0o600 });
      }
    }

    pushLog('vpn_config_imported', { profile: name, protocol: 'openvpn' });
    await checkCertExpiry();

    return { ok: true, profile: name };
  }

  // ── certificate expiry ──

  async function checkCertExpiry() {
    const vc = vpnCfg();
    const dir = profileDir(vc.profileName);
    const certPath = path.join(dir, 'client.crt');

    try {
      await fsPromises.access(certPath);
    } catch {
      // try extracting from inline config
      return extractInlineCertExpiry(dir);
    }

    try {
      const { stdout } = await execFileAsync('openssl', ['x509', '-enddate', '-noout', '-in', certPath]);
      parseCertExpiry(stdout);
    } catch (e) {
      state.vpn.certExpiry = null;
      state.vpn.certDaysRemaining = null;
    }
  }

  async function extractInlineCertExpiry(dir) {
    try {
      const ovpn = await fsPromises.readFile(path.join(dir, 'client.ovpn'), 'utf8');
      const match = ovpn.match(/<cert>([\s\S]*?)<\/cert>/);
      if (!match) return;

      const tmpPath = path.join(VPN_DIR, '.tmp-cert-check.pem');
      await fsPromises.writeFile(tmpPath, match[1].trim(), { mode: 0o600 });
      try {
        const { stdout } = await execFileAsync('openssl', ['x509', '-enddate', '-noout', '-in', tmpPath]);
        parseCertExpiry(stdout);
      } finally {
        await fsPromises.unlink(tmpPath).catch(() => {});
      }
    } catch {
      state.vpn.certExpiry = null;
      state.vpn.certDaysRemaining = null;
    }
  }

  function parseCertExpiry(opensslOutput) {
    // notAfter=Mar 15 12:00:00 2027 GMT
    const m = opensslOutput.match(/notAfter=(.+)/);
    if (!m) return;
    const expiry = new Date(m[1].trim());
    if (isNaN(expiry.getTime())) return;
    state.vpn.certExpiry = expiry.toISOString();
    state.vpn.certDaysRemaining = Math.floor((expiry.getTime() - Date.now()) / 86400000);

    if (state.vpn.certDaysRemaining <= 30) {
      pushLog('vpn_cert_expiry_warning', {
        daysRemaining: state.vpn.certDaysRemaining,
        expiry: state.vpn.certExpiry
      });
    }
  }

  // ── tunnel lifecycle ──

  async function startTunnel() {
    if (starting) return;
    starting = true;

    try {
      const vc = vpnCfg();
      const proto = vc.protocol || 'openvpn';
      const cfgPath = vc.configPath || configPath(vc.profileName);

      try {
        await fsPromises.access(cfgPath);
      } catch {
        const err = `VPN config not found: ${cfgPath}`;
        state.vpn.status = 'error';
        state.vpn.lastError = err;
        pushLog('vpn_start_error', { error: err });
        return;
      }

      state.vpn.status = 'connecting';
      state.vpn.enabled = true;
      state.vpn.protocol = proto;
      // Store the sanitised profile name — every downstream sudo-ln / sudo-rm
      // call reads from state.vpn.profileName, so the sanitation has to
      // happen here instead of at each interpolation site.
      state.vpn.profileName = sanitizeProfileName(vc.profileName);

      pushLog('vpn_connecting', { profile: state.vpn.profileName, protocol: proto });

      if (proto === 'wireguard') {
        await startWireGuard(cfgPath, vc);
      } else if (proto === 'ipsec') {
        await startIPSec(cfgPath, vc);
      } else {
        await startOpenVpn(cfgPath, vc);
      }
    } finally {
      starting = false;
    }
  }

  async function startOpenVpn(cfgPath, vc) {
    const args = ['openvpn', '--config', cfgPath, '--writepid', '/tmp/dvhub-openvpn.pid'];
    const child = spawn('sudo', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false
    });

    openvpnProcess = child;

    child.stdout.on('data', (data) => {
      const line = data.toString().trim();
      if (line.includes('Initialization Sequence Completed')) {
        onTunnelUp();
      }
    });

    child.stderr.on('data', (data) => {
      const line = data.toString().trim();
      if (line) pushLog('vpn_stderr', { message: line.slice(0, 200) });
    });

    child.on('error', (err) => {
      state.vpn.status = 'error';
      state.vpn.lastError = err.message;
      pushLog('vpn_process_error', { error: err.message });
      openvpnProcess = null;
      openvpnPid = null;
    });

    child.on('exit', (code, signal) => {
      const wasConnected = state.vpn.status === 'connected';
      if (state.vpn.status !== 'disconnected') {
        state.vpn.status = 'disconnected';
      }
      openvpnProcess = null;
      openvpnPid = null;
      pushLog('vpn_process_exit', { code, signal });

      if (wasConnected && vpnCfg().watchdog?.enabled) {
        scheduleReconnect();
      }
    });

    const gotTun = await waitForInterface('tun0', 30000);
    if (!gotTun && state.vpn.status === 'connecting') {
      if (state.vpn.status !== 'connected') {
        state.vpn.status = 'error';
        state.vpn.lastError = 'Timeout waiting for tun interface';
        pushLog('vpn_tun_timeout', {});
      }
    }

    if (state.vpn.status === 'connecting') {
      onTunnelUp();
    }

    if (vc.watchdog?.enabled) startWatchdog();
    startCertCheck();
  }

  async function startWireGuard(cfgPath, vc) {
    try {
      await execFileAsync('sudo', ['wg-quick', 'up', cfgPath]);
    } catch (e) {
      state.vpn.status = 'error';
      state.vpn.lastError = e.message || e.stderr || 'wg-quick up failed';
      pushLog('vpn_start_error', { error: state.vpn.lastError, protocol: 'wireguard' });
      return;
    }

    const iface = wgInterfaceName();
    const gotIface = await waitForInterface(iface, 15000);
    if (!gotIface) {
      state.vpn.status = 'error';
      state.vpn.lastError = `Timeout waiting for ${iface} interface`;
      pushLog('vpn_tun_timeout', { interface: iface });
      return;
    }

    await onTunnelUp();

    if (vc.watchdog?.enabled) startWatchdog();
  }

  async function startIPSec(cfgPath, vc) {
    const connName = extractIPSecConnName(
      await fsPromises.readFile(cfgPath, 'utf8')
    );
    if (!connName) {
      state.vpn.status = 'error';
      state.vpn.lastError = 'No named connection found in ipsec.conf';
      pushLog('vpn_start_error', { error: state.vpn.lastError, protocol: 'ipsec' });
      return;
    }

    const dir = path.dirname(cfgPath);
    const secretsPath = path.join(dir, 'ipsec.secrets');

    // Load profile config into StrongSwan
    try {
      // Include profile config in StrongSwan — symlink to /etc/ipsec.d/.
      // Re-sanitise defensively: startTunnel should have already stored a
      // safe value in state.vpn.profileName, but if a future caller ever sets
      // it from outside this module we want the sudo interpolation below to
      // still be safe, and we want the narrowed sudoers regex
      // ([A-Za-z0-9_-]+) to match byte-for-byte.
      const safeProfile = sanitizeProfileName(state.vpn.profileName);
      if (!/^[a-zA-Z0-9_-]+$/.test(safeProfile)) {
        throw new Error('invalid profileName (empty after sanitation)');
      }
      const ipsecDConf = `/etc/ipsec.d/dvhub-${safeProfile}.conf`;
      const ipsecDSecrets = `/etc/ipsec.d/dvhub-${safeProfile}.secrets`;

      // Create symlinks so StrongSwan picks up our config
      await execFileAsync('sudo', ['ln', '-sf', cfgPath, ipsecDConf]);
      try {
        await fsPromises.access(secretsPath);
        await execFileAsync('sudo', ['ln', '-sf', secretsPath, ipsecDSecrets]);
      } catch { /* no secrets file — PSK might be inline or cert-based */ }

      // Reload StrongSwan config
      await execFileAsync('sudo', ['ipsec', 'reload']);
      await sleep(1000);

      // Bring up the connection
      await execFileAsync('sudo', ['ipsec', 'up', connName], { timeout: 30000 });
    } catch (e) {
      state.vpn.status = 'error';
      state.vpn.lastError = e.message || e.stderr || 'ipsec up failed';
      pushLog('vpn_start_error', { error: state.vpn.lastError, protocol: 'ipsec', connection: connName });
      return;
    }

    // Verify SA is established
    const saUp = await checkIPSecSA(connName);
    if (!saUp) {
      state.vpn.status = 'error';
      state.vpn.lastError = `IPSec SA not established for ${connName}`;
      pushLog('vpn_start_error', { error: state.vpn.lastError, protocol: 'ipsec' });
      return;
    }

    await onTunnelUp();

    if (vc.watchdog?.enabled) startWatchdog();
    startCertCheck();
  }

  async function checkIPSecSA(connName) {
    try {
      const { stdout } = await execFileAsync('sudo', ['ipsec', 'status', connName]);
      // Look for ESTABLISHED in the output
      return stdout.includes('ESTABLISHED') || stdout.includes('INSTALLED');
    } catch {
      return false;
    }
  }

  async function onTunnelUp() {
    if (state.vpn.status === 'connected') return;
    state.vpn.status = 'connected';
    state.vpn.upSince = new Date().toISOString();
    state.vpn.reconnectAttempts = 0;
    state.vpn.lastError = null;
    state.vpn.watchdogOk = true;
    backoffMs = 5000;
    failCount = 0;

    const iface = tunInterfaceName();

    // read tunnel IP
    try {
      const { stdout } = await execFileAsync('sudo', ['ip', 'addr', 'show', iface]);
      const m = stdout.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/);
      if (m) state.vpn.tunIp = m[1];
    } catch { /* ignore */ }

    // read PID (OpenVPN only)
    if (state.vpn.protocol === 'openvpn') {
      try {
        const pidStr = await fsPromises.readFile('/tmp/dvhub-openvpn.pid', 'utf8');
        openvpnPid = parseInt(pidStr.trim(), 10) || null;
      } catch { /* ignore */ }
    }

    pushLog('vpn_connected', {
      tunIp: state.vpn.tunIp,
      profile: state.vpn.profileName,
      protocol: state.vpn.protocol
    });

    // cert expiry check for OpenVPN and IPSec (not WireGuard)
    if (state.vpn.protocol !== 'wireguard') {
      await checkCertExpiry();
    }
  }

  async function waitForInterface(iface, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const { stdout } = await execFileAsync('sudo', ['ip', 'link', 'show', iface]);
        if (stdout.includes(iface)) return true;
      } catch { /* not yet */ }
      await sleep(1000);
    }
    return false;
  }

  async function stopTunnel() {
    stopWatchdog();
    stopCertCheck();

    const proto = state.vpn.protocol || vpnCfg().protocol || 'openvpn';

    if (proto === 'wireguard') {
      await stopWireGuard();
    } else if (proto === 'ipsec') {
      await stopIPSec();
    } else {
      await stopOpenVpn();
    }

    state.vpn.status = 'disconnected';
    state.vpn.tunIp = null;
    state.vpn.upSince = null;
    state.vpn.watchdogOk = false;
    pushLog('vpn_stopped', { protocol: proto });
  }

  async function stopOpenVpn() {
    if (openvpnPid) {
      try {
        await execFileAsync('sudo', ['kill', '-15', String(openvpnPid)]);
      } catch { /* already dead */ }
    }

    if (openvpnProcess) {
      openvpnProcess.kill('SIGTERM');
      await sleep(2000);
      if (openvpnProcess) {
        try { openvpnProcess.kill('SIGKILL'); } catch { /* ignore */ }
      }
    }

    openvpnProcess = null;
    openvpnPid = null;
  }

  async function stopWireGuard() {
    const vc = vpnCfg();
    const cfgPath = vc.configPath || configPath(vc.profileName);
    try {
      await execFileAsync('sudo', ['wg-quick', 'down', cfgPath]);
    } catch { /* interface might already be down */ }
  }

  async function stopIPSec() {
    const connName = await getIPSecConnName();
    if (connName) {
      try {
        await execFileAsync('sudo', ['ipsec', 'down', connName]);
      } catch { /* connection might already be down */ }
    }
    // Remove symlinks from /etc/ipsec.d/.
    // sanitizeProfileName handles the null/undefined fallback path
    // (defaults to "direktvermarkter") and strips any character that would
    // escape the narrowed sudoers rule. Local name is `safeProfile` so the
    // "raw profileName interpolation" audit grep stays at zero matches.
    const safeProfile = sanitizeProfileName(state.vpn.profileName || vpnCfg().profileName);
    try { await execFileAsync('sudo', ['rm', '-f', `/etc/ipsec.d/dvhub-${safeProfile}.conf`]); } catch { /* ignore */ }
    try { await execFileAsync('sudo', ['rm', '-f', `/etc/ipsec.d/dvhub-${safeProfile}.secrets`]); } catch { /* ignore */ }
    try { await execFileAsync('sudo', ['ipsec', 'reload']); } catch { /* ignore */ }
  }

  async function restartTunnel() {
    await stopTunnel();
    await sleep(1000);
    await startTunnel();
  }

  // ── watchdog ──

  function startWatchdog() {
    stopWatchdog();
    const vc = vpnCfg();
    const interval = vc.watchdog?.intervalMs || 10000;
    watchdogInterval = setInterval(() => healthCheck(), interval);
  }

  function stopWatchdog() {
    if (watchdogInterval) {
      clearInterval(watchdogInterval);
      watchdogInterval = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  async function healthCheck() {
    if (state.vpn.status !== 'connected') return;

    const iface = tunInterfaceName();

    // IPSec: check SA status instead of interface
    if (state.vpn.protocol === 'ipsec') {
      const connName = await getIPSecConnName();
      if (connName) {
        const saUp = await checkIPSecSA(connName);
        if (!saUp) {
          pushLog('vpn_watchdog_sa_down', { connection: connName });
          failCount++;
          const threshold = vpnCfg().watchdog?.failThreshold || 3;
          if (failCount >= threshold) { scheduleReconnect(); return; }
        }
      }
      // update uptime
      if (state.vpn.upSince) {
        state.vpn.uptimeSeconds = Math.floor((Date.now() - new Date(state.vpn.upSince).getTime()) / 1000);
      }
      failCount = 0;
      state.vpn.watchdogOk = true;
      return;
    }

    // 1. PID alive check (OpenVPN only — WireGuard is a kernel module)
    if (state.vpn.protocol === 'openvpn' && openvpnPid) {
      try {
        await execFileAsync('sudo', ['kill', '-0', String(openvpnPid)]);
      } catch {
        pushLog('vpn_watchdog_pid_dead', {});
        scheduleReconnect();
        return;
      }
    }

    // 2. interface exists
    try {
      await execFileAsync('sudo', ['ip', 'link', 'show', iface]);
    } catch {
      pushLog('vpn_watchdog_tun_missing', { interface: iface });
      scheduleReconnect();
      return;
    }

    // 3. WireGuard-specific: check latest handshake isn't stale (>3 min)
    if (state.vpn.protocol === 'wireguard') {
      try {
        const { stdout } = await execFileAsync('sudo', ['wg', 'show', iface, 'latest-handshakes']);
        const match = stdout.match(/\t(\d+)/);
        if (match) {
          const lastHandshake = parseInt(match[1], 10);
          const ageSec = Math.floor(Date.now() / 1000) - lastHandshake;
          if (lastHandshake > 0 && ageSec > 180) {
            pushLog('vpn_watchdog_handshake_stale', { ageSec });
            failCount++;
            const threshold = vpnCfg().watchdog?.failThreshold || 3;
            if (failCount >= threshold) { scheduleReconnect(); return; }
          }
        }
      } catch { /* wg command might not be available — skip check */ }
    }

    // 4. update uptime
    if (state.vpn.upSince) {
      state.vpn.uptimeSeconds = Math.floor((Date.now() - new Date(state.vpn.upSince).getTime()) / 1000);
    }

    // all ok
    failCount = 0;
    state.vpn.watchdogOk = true;
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;

    const vc = vpnCfg();
    const maxBackoff = vc.watchdog?.maxBackoffMs || 120000;
    const threshold = vc.watchdog?.failThreshold || 3;

    failCount++;
    state.vpn.watchdogOk = false;

    if (failCount < threshold) {
      pushLog('vpn_watchdog_fail', { failCount, threshold });
      return;
    }

    state.vpn.reconnectAttempts++;
    state.vpn.lastReconnectAt = new Date().toISOString();
    pushLog('vpn_reconnect', { attempt: state.vpn.reconnectAttempts, backoffMs });

    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      try {
        await stopTunnel();
        await startTunnel();
        if (state.vpn.status === 'connected') {
          backoffMs = 5000;
        } else {
          backoffMs = Math.min(backoffMs * 2, maxBackoff);
          scheduleReconnect();
        }
      } catch (e) {
        state.vpn.lastError = e.message;
        pushLog('vpn_reconnect_error', { error: e.message });
        backoffMs = Math.min(backoffMs * 2, maxBackoff);
        scheduleReconnect();
      }
    }, backoffMs);
  }

  // ── cert check (daily) ──

  function startCertCheck() {
    stopCertCheck();
    certCheckInterval = setInterval(() => checkCertExpiry(), 24 * 60 * 60 * 1000);
  }

  function stopCertCheck() {
    if (certCheckInterval) {
      clearInterval(certCheckInterval);
      certCheckInterval = null;
    }
  }

  // ── config details ──

  async function getConfigDetails() {
    const vc = vpnCfg();
    const proto = vc.protocol || 'openvpn';
    const name = vc.profileName || 'direktvermarkter';
    const cfgPath = vc.configPath || configPath(name);

    const details = {
      profileName: name,
      protocol: proto,
      configPath: cfgPath,
      configExists: false,
      fields: []
    };

    try {
      await fsPromises.access(cfgPath);
      details.configExists = true;
    } catch {
      return details;
    }

    try {
      const content = await fsPromises.readFile(cfgPath, 'utf8');

      if (proto === 'openvpn') {
        parseOpenVpnDetails(content, details);
      } else if (proto === 'wireguard') {
        parseWireGuardDetails(content, details);
      } else if (proto === 'ipsec') {
        parseIPSecDetails(content, details);
      }
    } catch { /* ignore read errors */ }

    // add cert info from state
    if (state.vpn.certExpiry) {
      details.fields.push({ key: 'Zertifikat gültig bis', value: new Date(state.vpn.certExpiry).toLocaleDateString('de-DE', { year: 'numeric', month: '2-digit', day: '2-digit' }) });
      details.fields.push({ key: 'Zertifikat Tage verbleibend', value: String(state.vpn.certDaysRemaining), warn: state.vpn.certDaysRemaining <= 30 });
    }

    return details;
  }

  function parseOpenVpnDetails(content, details) {
    const lines = content.split(/\r?\n/);
    const directives = {};

    let inBlock = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (line.startsWith('<') && !line.startsWith('</')) { inBlock = true; continue; }
      if (line.startsWith('</')) { inBlock = false; continue; }
      if (inBlock || !line || line.startsWith('#') || line.startsWith(';')) continue;
      const parts = line.split(/\s+/);
      directives[parts[0].toLowerCase()] = parts.slice(1).join(' ');
    }

    const f = details.fields;
    if (directives.remote) f.push({ key: 'Remote Server', value: directives.remote });
    if (directives.proto) f.push({ key: 'Protokoll', value: directives.proto.toUpperCase() });
    if (directives.dev) f.push({ key: 'Device', value: directives.dev });
    if (directives.port) f.push({ key: 'Port', value: directives.port });
    if (directives['resolv-retry']) f.push({ key: 'DNS Retry', value: directives['resolv-retry'] });
    if (directives.keepalive) f.push({ key: 'Keepalive', value: directives.keepalive });
    if (directives['comp-lzo'] !== undefined) f.push({ key: 'Kompression', value: 'LZO' });
    if (directives['remote-cert-tls']) f.push({ key: 'Remote Cert TLS', value: directives['remote-cert-tls'] });
    if (directives.verb) f.push({ key: 'Verbosity', value: directives.verb });

    f.push({ key: 'CA Zertifikat', value: content.includes('<ca>') ? 'inline' : (directives.ca || 'nicht gesetzt') });
    f.push({ key: 'Client Zertifikat', value: content.includes('<cert>') ? 'inline' : (directives.cert || 'nicht gesetzt') });
    f.push({ key: 'Private Key', value: content.includes('<key>') ? 'inline' : (directives.key || 'nicht gesetzt') });
    if (content.includes('<tls-auth>') || directives['tls-auth']) f.push({ key: 'TLS Auth', value: 'gesetzt' });

    // forced directives
    f.push({ key: 'script-security', value: directives['script-security'] || '0', forced: true });
    f.push({ key: 'persist-tun', value: 'ja', forced: true });
    f.push({ key: 'persist-key', value: 'ja', forced: true });
  }

  function parseWireGuardDetails(content, details) {
    const lines = content.split(/\r?\n/);
    let section = null;
    const f = details.fields;

    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const secMatch = line.match(/^\[(\w+)\]$/);
      if (secMatch) { section = secMatch[1]; continue; }
      const kvMatch = line.match(/^(\w+)\s*=\s*(.+)/);
      if (!kvMatch) continue;
      const [, key, val] = kvMatch;

      if (section === 'Interface') {
        if (key === 'Address') f.push({ key: 'Tunnel-Adresse', value: val });
        if (key === 'DNS') f.push({ key: 'DNS', value: val });
        if (key === 'PrivateKey') f.push({ key: 'Private Key', value: val.slice(0, 8) + '...' });
      }
      if (section === 'Peer') {
        if (key === 'PublicKey') f.push({ key: 'Peer Public Key', value: val.slice(0, 8) + '...' });
        if (key === 'Endpoint') f.push({ key: 'Endpoint', value: val });
        if (key === 'AllowedIPs') f.push({ key: 'Allowed IPs', value: val });
        if (key === 'PersistentKeepalive') f.push({ key: 'Keepalive', value: val + 's' });
      }
    }
  }

  function parseIPSecDetails(content, details) {
    const lines = content.split(/\r?\n/);
    let section = null;
    let connName = null;
    const f = details.fields;

    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const connMatch = line.match(/^conn\s+(\S+)/);
      if (connMatch) {
        section = 'conn';
        if (connMatch[1] !== '%default') connName = connMatch[1];
        continue;
      }
      if (/^(config|ca)\s+/.test(line)) { section = null; continue; }
      const kvMatch = line.match(/^(\w+)\s*=\s*(.+)/);
      if (!kvMatch || section !== 'conn' || !connName) continue;
      const [, key, val] = kvMatch;

      if (key === 'right') f.push({ key: 'Remote Endpoint', value: val });
      if (key === 'rightsubnet') f.push({ key: 'Remote Subnet', value: val });
      if (key === 'left') f.push({ key: 'Local Endpoint', value: val });
      if (key === 'leftsubnet') f.push({ key: 'Local Subnet', value: val });
      if (key === 'authby') f.push({ key: 'Auth', value: val });
      if (key === 'auto') f.push({ key: 'Auto', value: val });
      if (key === 'ike') f.push({ key: 'IKE', value: val });
      if (key === 'esp') f.push({ key: 'ESP', value: val });
    }
    if (connName) f.push({ key: 'Connection Name', value: connName });
  }

  // ── status ──

  function getStatus() {
    return { ...state.vpn };
  }

  // ── utility ──

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ── public API ──

  return {
    start: startTunnel,
    stop: stopTunnel,
    restart: restartTunnel,
    importConfig,
    validateConfig: (content) => {
      const proto = vpnCfg().protocol || 'openvpn';
      if (proto === 'wireguard') return validateWireGuardConfig(content);
      if (proto === 'ipsec') return validateIPSecConfig(content);
      return validateOvpnConfig(content);
    },
    getStatus,
    getConfigDetails,
    checkCertExpiry,
    close: async () => {
      stopWatchdog();
      stopCertCheck();
      await stopTunnel();
    }
  };
}
