// routes-api.js -- HTTP route handlers for ALL API endpoints.
// Extracted from server.js (Phase 5, Plans 01+02).
// Factory pattern: createApiRoutes(ctx) returns { handleRequest }.

import fs from 'node:fs';
import path from 'node:path';
import * as crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { parseBody, MAX_BODY_BYTES, nowIso, fmtTs, resolveLogLimit, u16, s16, roundCtKwh, addDays, gridDirection } from './server-utils.js';
import { effectiveBatteryCostCtKwh, mixedCostCtKwh, slotComparison, resolveImportPriceCtKwhForSlot, configuredModule3Windows } from './user-energy-pricing.js';
import { isSmallMarketAutomationRule } from './market-automation-builder.js';
import { buildWorkerBackedStatusResponse, buildHistoryImportStatusResponse } from './runtime-state.js';
import { buildOptimizerRunPayload } from './telemetry-runtime.js';
import { REDACTED_PATHS, redactConfig, redactUrlCreds } from './config-redaction.js';
import { createDefaultConfig } from './config-model.js';

const execFileAsync = promisify(execFile);

// Plan 08-05 Task 2: HSTS + tightened CSP.
//   - Strict-Transport-Security: 1 year, includeSubDomains (preload deferred).
//   - script-src: pinned to swagger-ui-dist@5.11.0 and leaflet@1.9.4 paths
//     (no more wildcard unpkg / jsdelivr reach).
//   - style-src 'unsafe-inline' is TEMPORARILY retained until Plan 08-11
//     removes the 399 inline `style=` attributes from the HTML pages.
//     FLIP TO 'nonce-...' or remove entirely in 08-11.
//   - frame-ancestors 'none', base-uri 'self', form-action 'self',
//     object-src 'none' close CSP-level framing/form/plugin vectors.
export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Content-Security-Policy': [
    "default-src 'self'",
    // script-src: pinned CDN paths ONLY. swagger-ui-dist@5.11.0 for /api-docs.html,
    // leaflet@1.9.4 for the settings map overlay.
    "script-src 'self' https://unpkg.com/swagger-ui-dist@5.11.0/ https://unpkg.com/leaflet@1.9.4/",
    // style-src: 'unsafe-inline' stays until 08-11 strips the 399 inline style=
    // attributes. After 08-11 this should become "style-src 'self' https://unpkg.com/swagger-ui-dist@5.11.0/ https://unpkg.com/leaflet@1.9.4/ https://fonts.googleapis.com".
    "style-src 'self' 'unsafe-inline' https://unpkg.com/swagger-ui-dist@5.11.0/ https://unpkg.com/leaflet@1.9.4/ https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob: https://dvhub.de https://*.tile.openstreetmap.org https://unpkg.com/leaflet@1.9.4/",
    "connect-src 'self' https://api.dvhub.de",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'"
  ].join('; ')
};

// ── Plan 08-04: Input-validation + DoS bounds constants ─────────────────
// Numeric upper bounds for /api/control/write — |value| above this is an
// obvious attacker payload on residential HEMS hardware (highest plausible
// industrial setpoint is ~50 kW; 100 kW is headroom).
export const MAX_GRID_SETPOINT_W = 100_000;
export const MAX_MINSOC_PCT = 100;
// /api/telemetry/series cap — (endMs-startMs)/stepMs * seriesCount must stay below this
// to protect the Pi from range-explosion DoS queries.
export const MAX_TELEMETRY_SCAN_SLOTS = 50_000;
// /api/admin/update/apply body.version allowlist — blocks shell-metachar payloads
// and random attacker-controlled git refs. Accepts plain semver `1.2.3`, `v1.2.3`,
// with optional pre-release / build metadata suffix (`-rc.1`, `+build.42`).
export const SEMVER_TAG = /^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?$/;
// /api/messages/generate prompt-injection markers. Not a complete LLM-injection
// defence — just a first-pass filter for obvious overrides (`ignore instructions`,
// system-prompt tags, jailbreak phrasing, Llama/Mistral/ChatML prompt templates).
export const PROMPT_INJECTION_PATTERNS = [
  /\bignore\b.*\binstructions?\b/i,
  /\bsystem\s*prompt\b/i,
  /\bjailbreak\b/i,
  /<\|im_start\|>|<\|im_end\|>/,
  /\[\[SYSTEM\]\]|\[INST\]|<<SYS>>/
];
// /api/messages/generate body.data cap — 4 KB is plenty for status/savings
// message context and bounds how much attacker text can reach the LLM per call.
export const MAX_MESSAGE_DATA_BYTES = 4 * 1024;
// Rate-limit Map eviction ceiling. Before this was unbounded, so IPv6-rotation
// attackers could pin Node heap. Key normalisation (v4 verbatim, v6 /64 prefix)
// further collapses per-address fan-out.
export const RATE_LIMIT_MAX_KEYS = 5000;

// ── Plan 08-04 Task 2 Step 5: Host / CORS / trustProxy helpers ──────────
// Kept as pure free functions (no closure over ctx) so server.js can reuse
// them from the request-entry middleware before routes.handleRequest runs.

// Derive the authoritative request host. X-Forwarded-Host is ONLY honoured
// when the operator explicitly opted in via cfg.trustProxy=true — otherwise a
// LAN client could spoof the Host downstream of nothing.
export function getRequestHost(req, cfg) {
  const trustProxy = cfg && cfg.trustProxy === true;
  const raw = trustProxy
    ? String(req.headers['x-forwarded-host'] || req.headers.host || '')
    : String(req.headers.host || '');
  return raw.toLowerCase();
}

// Host allowlist check. Empty array = permissive (LAN-dev default). Operators
// on public / reverse-proxy deployments MUST populate cfg.allowedHosts with
// their real FQDN(s) before exposing the service.
export function isHostAllowed(hostVal, cfg) {
  const list = Array.isArray(cfg?.allowedHosts) ? cfg.allowedHosts : [];
  if (list.length === 0) return true;
  const normalized = String(hostVal || '').toLowerCase();
  return list.map((h) => String(h).toLowerCase()).includes(normalized);
}

// CORS origin resolver. Returns the matching allowlist entry (verbatim, to
// preserve case of the configured value) or null — NEVER echoes the request
// Origin header unconditionally.
export function resolveCorsAllowedOrigin(originHeader, cfg) {
  if (!originHeader) return null;
  const list = Array.isArray(cfg?.corsAllowedOrigins) ? cfg.corsAllowedOrigins : [];
  if (list.length === 0) return null;
  return list.includes(originHeader) ? originHeader : null;
}

// Compare two semver-ish tags numerically on major.minor.patch. Strips a leading
// `v`, ignores pre-release/build metadata (after `-` / `+`). Returns -1 / 0 / +1.
// Used by /api/admin/update/apply downgrade guard.
export function compareSemverTag(a, b) {
  const parse = (s) => {
    const m = String(s || '').trim().replace(/^v/, '').split(/[-+]/)[0].split('.');
    return [Number(m[0]) || 0, Number(m[1]) || 0, Number(m[2]) || 0];
  };
  const [a0, a1, a2] = parse(a);
  const [b0, b1, b2] = parse(b);
  if (a0 !== b0) return a0 < b0 ? -1 : 1;
  if (a1 !== b1) return a1 < b1 ? -1 : 1;
  if (a2 !== b2) return a2 < b2 ? -1 : 1;
  return 0;
}

// Derive allowed POST /api/config root keys from the canonical default config
// PLUS the well-known live-config sections that are seeded by migrations
// (vpn, https*, tls*, notifications, mqtt, forecast, family, devices, etc.).
// Deep-path validation is plan 08-06's scope — this plan only covers
// root-level strictness so an attacker cannot sneak in `__proto__`-ish keys
// or bogus sections that get persisted and later consumed by unvalidated code.
export const ALLOWED_CONFIG_ROOTS = Object.freeze(new Set([
  ...Object.keys(createDefaultConfig()),
  // Migration-seeded / optional sections
  'vpn',
  'httpsPort',
  'tlsCertPath',
  'tlsKeyPath',
  'notifications',
  'mqtt',
  'forecast',
  'family',
  'devices',
  'shelly',
  'teslamate',
  'teslamateCarId',
  'snapshotIntervalSec',
  'integrations',
  'baseUrl',
  // Plan 08-04 Task 2: Host / CORS / trust-proxy allowlist fields added to config
  'allowedHosts',
  'corsAllowedOrigins',
  'trustProxy',
  // Migration metadata + legacy integration roots that live in existing config.json
  // and are echoed back unchanged when the settings UI saves; without these,
  // the strict-root check rejects a normal save with `unknown_config_paths`.
  'configSchemaVersion',
  'influx'
]));

// Plan 08-09 Task 2: actor context extracted from a request — feeds the
// audit_log mirror in pushLog (server.js) and the new exec.manual_overrides
// rows. Strips the IPv4-in-IPv6 prefix that node http exposes by default
// (::ffff:192.168.1.5 → 192.168.1.5). Caps free-form fields so an attacker
// can't pump multi-MB User-Agent strings into the audit table.
export function actorContext(req) {
  return {
    actor_ip: String(req.socket?.remoteAddress || '').replace(/^::ffff:/, ''),
    actor_ua: String(req.headers?.['user-agent'] || '').slice(0, 256),
    actor_session: String(req.headers?.['x-session-id'] || '').slice(0, 64) || null,
  };
}

export function createApiRoutes(ctx) {
  const { state, getCfg, pushLog, telemetrySafeWrite } = ctx;

  // ── Admin health payload builder ────────────────────────────────────
  async function adminHealthPayload() {
    const service = {
      enabled: ctx.getServiceActionsEnabled(),
      name: ctx.getServiceName(),
      useSudo: ctx.getServiceUseSudo(),
      status: 'disabled',
      detail: 'Service-Aktionen sind per ENV deaktiviert.'
    };

    if (ctx.getServiceActionsEnabled()) {
      const activeCheck = await ctx.runServiceCommand(['is-active', ctx.getServiceName()]);
      const showCheck = await ctx.runServiceCommand(['show', ctx.getServiceName(), '--property=ActiveState,SubState,UnitFileState', '--value']);
      service.status = activeCheck.ok ? (activeCheck.stdout || 'unknown') : 'unavailable';
      service.detail = activeCheck.ok ? 'systemctl erreichbar' : activeCheck.error;
      service.show = showCheck.ok ? showCheck.stdout : showCheck.error;
    }

    return {
      ok: true,
      checkedAt: Date.now(),
      app: ctx.getAppVersion(),
      service,
      runtime: {
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        pid: process.pid,
        transport: ctx.getTransportType(),
        uptimeSec: Math.round(process.uptime())
      },
      checks: [
        {
          id: 'config',
          label: 'Config Datei',
          ok: ctx.getLoadedConfig().exists && ctx.getLoadedConfig().valid,
          detail: ctx.getLoadedConfig().exists
            ? (ctx.getLoadedConfig().valid ? `gueltig unter ${ctx.getConfigPath()}` : `ungueltig: ${ctx.getLoadedConfig().parseError}`)
            : `fehlt: ${ctx.getConfigPath()}`
        },
        {
          id: 'setup',
          label: 'Setup Status',
          ok: !ctx.getLoadedConfig().needsSetup,
          detail: ctx.getLoadedConfig().needsSetup ? 'Setup noch nicht abgeschlossen' : 'Setup abgeschlossen'
        },
        {
          id: 'meter',
          label: 'Live Meter Daten',
          ok: state.meter.ok,
          detail: state.meter.ok
            ? `letztes Update ${fmtTs(state.meter.updatedAt)}`
            : (state.meter.error || 'noch keine erfolgreichen Meter-Daten')
        },
        {
          id: 'epex',
          label: 'EPEX Feed',
          ok: !getCfg().epex.enabled || state.epex.ok,
          detail: !getCfg().epex.enabled
            ? 'deaktiviert'
            : state.epex.ok
              ? `letztes Update ${fmtTs(state.epex.updatedAt)}`
              : (state.epex.error || 'noch keine Preisdaten')
        },
        {
          id: 'service_actions',
          label: 'Restart Aktion',
          ok: ctx.getServiceActionsEnabled() && service.status !== 'unavailable',
          detail: ctx.getServiceActionsEnabled()
            ? `Service ${ctx.getServiceName()}: ${service.status}`
            : 'per ENV deaktiviert'
        },
        {
          id: 'telemetry',
          label: 'Interne Historie',
          ok: !getCfg().telemetry?.enabled || state.telemetry.ok,
          detail: !getCfg().telemetry?.enabled
            ? 'deaktiviert'
            : state.telemetry.dbPath
              ? `DB ${state.telemetry.dbPath}, letztes Schreiben ${fmtTs(state.telemetry.lastWriteAt)}`
              : (state.telemetry.lastError || 'noch keine Telemetrie-Initialisierung')
        }
      ]
    };
  }

  // ── Multipart helpers (VPN config upload) ────────────────────────────
  function readRawBody(req, maxBytes) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy();
          reject(new Error('body too large'));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  function parseMultipartBody(body, boundary) {
    const parts = [];
    const delimiter = '--' + boundary;
    const sections = body.split(delimiter).slice(1); // skip preamble

    for (const section of sections) {
      if (section.startsWith('--')) break; // end boundary
      const headerEnd = section.indexOf('\r\n\r\n');
      if (headerEnd < 0) continue;
      const headers = section.substring(0, headerEnd);
      const data = section.substring(headerEnd + 4).replace(/\r\n$/, '');

      const nameMatch = headers.match(/name="([^"]+)"/);
      const filenameMatch = headers.match(/filename="([^"]+)"/);

      parts.push({
        name: nameMatch ? nameMatch[1] : null,
        filename: filenameMatch ? filenameMatch[1] : null,
        data
      });
    }
    return parts;
  }

  // ── Response helpers ─────────────────────────────────────────────────
  function json(res, code, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(code, {
      ...SECURITY_HEADERS,
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body, 'utf8')
    });
    res.end(body);
  }

  function text(res, code, payload) {
    const body = String(payload);
    res.writeHead(code, {
      ...SECURITY_HEADERS,
      'content-type': 'text/plain; charset=utf-8',
      'content-length': Buffer.byteLength(body, 'utf8')
    });
    res.end(body);
  }

  function downloadJson(res, filename, payload) {
    const body = JSON.stringify(payload, null, 2);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'content-length': Buffer.byteLength(body, 'utf8')
    });
    res.end(body);
  }

  // ── Auth / Rate Limiting ─────────────────────────────────────────────
  function isLocalNetworkRequest(req) {
    const raw = req.socket?.remoteAddress || req.connection?.remoteAddress || '';
    const addr = raw.replace(/^::ffff:/, '');
    // Localhost
    if (addr === '127.0.0.1' || addr === '::1') return true;
    // Private/LAN ranges (RFC 1918)
    const parts = addr.split('.').map(Number);
    if (parts.length === 4) {
      if (parts[0] === 10) return true;                                    // 10.0.0.0/8
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // 172.16.0.0/12
      if (parts[0] === 192 && parts[1] === 168) return true;               // 192.168.0.0/16
    }
    // IPv6 link-local
    if (addr.startsWith('fe80:')) return true;
    return false;
  }

  // LAN-safe endpoints: read-only, no secrets, no admin surface, no internal paths/errors.
  // Any endpoint leaking credentials, topology, or server errors MUST require Bearer auth.
  // Plan 08-03: removed /api/log (error bodies/paths), /api/vpn/config (topology+key fingerprints),
  // /api/integrations/status (MQTT broker URL with creds).
  const LAN_SAFE_ENDPOINTS = new Set([
    '/api/keepalive/modbus',
    '/api/keepalive/pulse',
    '/api/config',           // GET only (read config — values redacted via redactConfig)
    '/api/config/export',
    '/api/discovery/systems',
    '/api/status',
    '/api/costs',
    '/api/integration/home-assistant',
    '/api/integration/loxone',
    '/api/integration/eos',
    '/api/integration/emhass',
    '/api/optimizer/status',
    '/api/log/dv-signals',
    '/api/telemetry/series',
    '/api/forecast',
    '/api/family/status',      // DASH-02 — family dashboard polls every 5s from LAN
    '/api/family/presence',    // DASH-03 — screensaver wake poll (GET only; POST still requires auth)
    '/api/epex/zones',
    '/api/epex/gaps',
    '/api/schedule',
    '/api/history/import/status',
    '/api/history/summary',
    '/api/schedule/automation/config',
    '/api/meter/scan',
    '/api/vpn/status',
    '/api/vpn/history',
    '/dv/control-value',
    '/api/devices',                // Phase 04 — device list (INTG-05)
    '/api/messages',               // Phase 05 — LLM messages (family tablet)
    '/api/messages/history',       // Phase 05 — message history (family tablet)
  ]);

  function isLanSafeRequest(req) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    // Only GET requests to allowlisted endpoints bypass auth from LAN
    if (req.method !== 'GET') return false;
    if (LAN_SAFE_ENDPOINTS.has(url.pathname)) return true;
    // Dynamic segments for device endpoints (INTG-05)
    if (url.pathname.startsWith('/api/devices/')) return true;
    return false;
  }

  // --- Rate Limiting (in-memory, per IP) ---
  const rateLimitBuckets = new Map();
  const RATE_LIMIT_WINDOW_MS = 60_000;
  const RATE_LIMIT_MAX_REQUESTS = 120;     // 120 req/min per IP for external (2/s avg)
  const LAN_RATE_LIMIT_MAX_REQUESTS = 600; // 600 req/min for LAN (10/s avg) — compromised IoT protection
  // Plan 08-04 Task 1 Step 6: collapse the key space so IPv6-rotation attackers
  // cannot make each request land in a new bucket. v4 addresses stay full, v6
  // collapses to /64 prefix (which is the smallest externally-routable block).
  function getRateLimitKey(req) {
    const raw = (req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
    if (!raw) return 'unknown';
    if (raw.includes(':')) {
      // IPv6 — collapse to /64 (first 4 hextets). Handles `::1` / `fe80::…` too.
      const expanded = raw.split(':');
      const groups = expanded.slice(0, 4).map((g) => g || '0');
      while (groups.length < 4) groups.push('0');
      return `v6:${groups.join(':')}::/64`;
    }
    return `v4:${raw}`;
  }

  function checkRateLimit(req, res) {
    const isLan = isLocalNetworkRequest(req);
    const ip = getRateLimitKey(req);
    const now = Date.now();
    const url = new URL(req.url, `http://${req.headers.host}`);
    // Plan 09-02: admin endpoints DO get rate-limited. Auth alone is the first
    // layer; rate limit is defence-in-depth against authenticated-but-leaked
    // token brute-forcing additional config keys. Operator volume on /api/admin/*
    // is well below 120 req/min, so this never affects normal use.
    // (Removed the prior early-return exemption.)
    const limit = isLan ? LAN_RATE_LIMIT_MAX_REQUESTS : RATE_LIMIT_MAX_REQUESTS;

    let bucket = rateLimitBuckets.get(ip);
    if (!bucket) {
      // Plan 08-04 Task 1 Step 6: evict the oldest-inserted entry when the Map
      // hits the ceiling. Map iteration order is insertion order, so the first
      // key returned is the oldest. This bounds Node heap under rotation DoS.
      if (rateLimitBuckets.size >= RATE_LIMIT_MAX_KEYS) {
        const firstKey = rateLimitBuckets.keys().next().value;
        if (firstKey !== undefined) rateLimitBuckets.delete(firstKey);
      }
      bucket = { windowStart: now, count: 0, prevCount: 0 };
      rateLimitBuckets.set(ip, bucket);
    }
    if (now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
      bucket.prevCount = bucket.count;
      bucket.windowStart = now;
      bucket.count = 0;
    }
    bucket.count++;

    // Sliding window approximation: weight previous window by remaining fraction
    const elapsed = now - bucket.windowStart;
    const prevWeight = 1 - elapsed / RATE_LIMIT_WINDOW_MS;
    const approxCount = bucket.count + Math.floor(bucket.prevCount * prevWeight);

    if (approxCount > limit) {
      res.writeHead(429, { ...SECURITY_HEADERS, 'Retry-After': '60', 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Too many requests' }));
      return false;
    }
    return true;
  }

  // Clean up stale buckets every 5 minutes
  setInterval(() => {
    const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS * 2;
    for (const [ip, bucket] of rateLimitBuckets) {
      if (bucket.windowStart < cutoff) rateLimitBuckets.delete(ip);
    }
  }, 300_000).unref();

  function checkAuth(req, res) {
    const cfg = getCfg();
    // LAN-trust: any client reachable on the local subnet bypasses the token check.
    // This is the operator's explicit security stance — phones/tablets/laptops on the
    // same WLAN are trusted without having to register a token. Reverted from the
    // Phase-08-01 GET-allowlist gate. A proper user/device-registration phase is the
    // right place to tighten this further (see backlog).
    if (isLocalNetworkRequest(req)) return true;
    // Plan 08-06 Task 2 Step 3: server-side rejection of ?token= query params.
    // syncTokenFromUrl (Plan 08-03) strips ?token= on first page load — this gate
    // refuses any direct API call with a token in the URL so it cannot leak via
    // server logs, HTTP referers, or shoulder-surfing. The single exception is
    // /api/config/export, which uses window.location.href for the file download
    // and therefore cannot send an Authorization header.
    const reqUrl = new URL(req.url, `http://${req.headers.host}`);
    if (reqUrl.searchParams.has('token') && reqUrl.pathname !== '/api/config/export') {
      // Plan 08-09 Task 2: enrich existing token-in-url rejection with actor context.
      pushLog('token_in_url_rejected', {
        path: reqUrl.pathname,
        method: req.method,
      }, actorContext(req));
      res.writeHead(400, { ...SECURITY_HEADERS, 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: 'token_in_url_forbidden',
        hint: 'Use Authorization: Bearer <token>'
      }));
      return false;
    }
    // Outside LAN, a configured token is mandatory; missing token fails closed.
    if (!cfg.apiToken || typeof cfg.apiToken !== 'string' || cfg.apiToken.length === 0) {
      // Plan 08-09 Task 2: 503 because the device is mis-configured, not because
      // the caller is wrong — but it's still an auth-gate failure that an
      // operator must be able to find in audit_log.
      pushLog('auth_failed', {
        path: reqUrl.pathname,
        method: req.method,
        reason: 'token_not_configured',
        statusCode: 503,
      }, actorContext(req));
      res.writeHead(503, { ...SECURITY_HEADERS, 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'api_token_not_configured' }));
      return false;
    }
    const expected = Buffer.from(cfg.apiToken);
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ')) {
      const token = Buffer.from(auth.slice(7));
      if (token.length === expected.length && crypto.timingSafeEqual(token, expected)) return true;
    }
    // ?token= only accepted for the config download endpoint (window.location.href redirect, no headers possible)
    if (reqUrl.pathname === '/api/config/export') {
      const urlToken = reqUrl.searchParams.get('token');
      if (urlToken) {
        const urlBuf = Buffer.from(urlToken);
        if (urlBuf.length === expected.length && crypto.timingSafeEqual(urlBuf, expected)) return true;
      }
    }
    // Plan 08-09 Task 2: every 401 emits a durable audit entry with actor
    // context (ip, ua, session) so brute-force attempts and credential
    // mistakes are visible long after the in-memory ring buffer has rolled.
    pushLog('auth_failed', {
      path: reqUrl.pathname,
      method: req.method,
      reason: auth ? 'bearer_invalid' : 'bearer_missing',
      statusCode: 401,
    }, actorContext(req));
    res.writeHead(401, { ...SECURITY_HEADERS, 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return false;
  }

  // Plan 08-06 Task 2 Step 2: setup wizard one-shot bootstrap.
  // When apiToken is currently empty, the device is in setup phase. LAN clients
  // bypass checkAuth, so any compromised device on the LAN could otherwise win the
  // first-caller race and take over the box. The bootstrap.token file (mode 0600,
  // generated at startup by server.js) requires the legitimate operator to prove
  // file-system access via SSH before they can set apiToken.
  // After successful setup the file is deleted, closing the bootstrap path.
  function getBootstrapTokenPath() {
    const dir = process.env.DV_DATA_DIR || (typeof ctx.getAppDir === 'function' ? ctx.getAppDir() : process.cwd());
    return path.join(dir, 'bootstrap.token');
  }
  function requireBootstrapToken(req, res) {
    const tokenPath = getBootstrapTokenPath();
    if (!fs.existsSync(tokenPath)) {
      // Plan 08-09 Task 2: full actor context so we can attribute attempted
      // takeovers after the bootstrap token has been consumed.
      pushLog('setup_bootstrap_unavailable', { path: tokenPath }, actorContext(req));
      res.writeHead(403, { ...SECURITY_HEADERS, 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'setup_already_completed' }));
      return false;
    }
    let expected = '';
    try { expected = fs.readFileSync(tokenPath, 'utf8').trim(); } catch (_) { /* fall through */ }
    const given = String(req.headers['x-bootstrap-token'] || '').trim();
    if (!expected || !given || given !== expected) {
      // Plan 08-09 Task 2: bootstrap-token rejection is a high-signal auth
      // failure — durable + actor-attributed.
      pushLog('setup_bootstrap_rejected', {}, actorContext(req));
      res.writeHead(403, { ...SECURITY_HEADERS, 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'bootstrap_token_required_or_invalid' }));
      return false;
    }
    return true;
  }
  function consumeBootstrapToken() {
    const tokenPath = getBootstrapTokenPath();
    try { fs.unlinkSync(tokenPath); } catch (_) { /* idempotent */ }
  }

  // ── Validation helpers ───────────────────────────────────────────────
  function validateScheduleRule(rule) {
    if (typeof rule !== 'object' || rule === null) return false;
    if (typeof rule.target !== 'string') return false;
    if (rule.value !== undefined && !Number.isFinite(Number(rule.value))) return false;
    return true;
  }

  // Plan 08-04 Task 1 Step 5: walk a JSON payload depth-first, return the first
  // path+pattern that matches any PROMPT_INJECTION_PATTERNS entry. Returns null
  // when the payload is clean. Strings only — numbers / booleans / null skipped
  // since they cannot carry prose instructions. Arrays and nested objects are
  // recursed. Path uses `foo.0.bar` dotted form for error reporting.
  function scanForInjection(obj, path = '') {
    if (obj == null) return null;
    if (typeof obj === 'string') {
      for (const rx of PROMPT_INJECTION_PATTERNS) {
        if (rx.test(obj)) return { path, pattern: rx.source };
      }
      return null;
    }
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        const hit = scanForInjection(obj[i], path ? `${path}.${i}` : String(i));
        if (hit) return hit;
      }
      return null;
    }
    if (typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        const hit = scanForInjection(v, path ? `${path}.${k}` : k);
        if (hit) return hit;
      }
    }
    return null;
  }

  // Plan 08-04 Task 1 Step 8 & Task 2 Step 3: RFC1918 + loopback check —
  // used by /api/meter/scan to refuse SSRF to internet hosts and by the
  // heartbeat guard (via isAllowedHeartbeatUrl) to refuse internal pivots.
  function isRfc1918OrLoopback(host) {
    const h = String(host || '').toLowerCase();
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
    const parts = h.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    if (parts[0] === 10) return true;                                      // 10.0.0.0/8
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // 172.16.0.0/12
    if (parts[0] === 192 && parts[1] === 168) return true;                 // 192.168.0.0/16
    return false;
  }

  // ── Response builders ────────────────────────────────────────────────
  function epexPriceArray() {
    if (!state.epex.ok || !Array.isArray(state.epex.data)) return [];
    return state.epex.data.map((row) => ({
      ts: row.ts,
      ts_iso: new Date(row.ts).toISOString(),
      eur_mwh: Number(row.eur_mwh ?? 0),
      eur_kwh: Number((row.eur_mwh ?? 0) / 1000),
      ct_kwh: Number(row.ct_kwh ?? 0)
    }));
  }

  function userEnergyPricingSummary() {
    const cfg = getCfg();
    const pricing = cfg.userEnergyPricing || {};
    const costs = pricing.costs || {};
    const slots = Array.isArray(state.epex.data) ? state.epex.data.map((row) => slotComparison(row, pricing, cfg.schedule?.timezone)) : [];
    const currentTs = ctx.epexNowNext()?.current?.ts;
    const current = slots.find((row) => row?.ts === currentTs) || null;
    const configured =
      (pricing.mode === 'fixed' && Number.isFinite(Number(pricing.fixedGrossImportCtKwh)))
      || pricing.mode === 'dynamic';

    return {
      configured,
      mode: pricing.mode || 'fixed',
      usesParagraph14aModule3: pricing.usesParagraph14aModule3 === true,
      dynamicComponents: {
        energyMarkupCtKwh: roundCtKwh(Number(pricing?.dynamicComponents?.energyMarkupCtKwh || 0)),
        gridChargesCtKwh: roundCtKwh(Number(pricing?.dynamicComponents?.gridChargesCtKwh || 0)),
        leviesAndFeesCtKwh: roundCtKwh(Number(pricing?.dynamicComponents?.leviesAndFeesCtKwh || 0)),
        vatPct: roundCtKwh(Number(pricing?.dynamicComponents?.vatPct || 0))
      },
      fixedGrossImportCtKwh: Number.isFinite(Number(pricing.fixedGrossImportCtKwh))
        ? roundCtKwh(Number(pricing.fixedGrossImportCtKwh))
        : null,
      module3Windows: configuredModule3Windows(pricing).map((window) => ({
        id: window.id,
        label: window.label,
        start: window.start,
        end: window.end,
        priceCtKwh: window.priceCtKwh
      })),
      costs: {
        pvCtKwh: Number.isFinite(Number(costs.pvCtKwh)) ? roundCtKwh(Number(costs.pvCtKwh)) : null,
        batteryBaseCtKwh: Number.isFinite(Number(costs.batteryBaseCtKwh)) ? roundCtKwh(Number(costs.batteryBaseCtKwh)) : null,
        batteryLossMarkupPct: roundCtKwh(Number(costs.batteryLossMarkupPct || 0)),
        batteryEffectiveCtKwh: effectiveBatteryCostCtKwh(costs),
        mixedCtKwh: mixedCostCtKwh(costs)
      },
      current,
      slots
    };
  }

  function costSummary() {
    return {
      day: state.energy.day,
      importWh: Number(state.energy.importWh.toFixed(3)),
      exportWh: Number(state.energy.exportWh.toFixed(3)),
      importKwh: Number((state.energy.importWh / 1000).toFixed(4)),
      exportKwh: Number((state.energy.exportWh / 1000).toFixed(4)),
      costEur: Number(state.energy.costEur.toFixed(4)),
      revenueEur: Number(state.energy.revenueEur.toFixed(4)),
      netEur: Number((state.energy.revenueEur - state.energy.costEur).toFixed(4)),
      priceNowCtKwh: Number(ctx.epexNowNext()?.current?.ct_kwh ?? 0),
      userImportPriceNowCtKwh: Number(userEnergyPricingSummary()?.current?.importPriceCtKwh ?? 0)
    };
  }

  function keepaliveModbusPayload() {
    return {
      ok: !!state.keepalive.modbusLastQuery,
      lastQuery: state.keepalive.modbusLastQuery,
      now: Date.now()
    };
  }

  function keepalivePulsePayload() {
    const now = Date.now();
    const cfg = getCfg();
    const slot = Math.floor(now / (cfg.keepalivePulseSec * 1000));
    const slotTs = slot * cfg.keepalivePulseSec * 1000;
    return {
      ok: true,
      periodSec: cfg.keepalivePulseSec,
      pulseSlot: slot,
      pulseTimestamp: slotTs,
      now
    };
  }

  async function integrationState() {
    const cfg = getCfg();

    // === EXISTING FIELDS — DO NOT MODIFY (backward compat for HA/Loxone consumers) ===
    const base = {
      timestamp: Date.now(),
      dvControlValue: ctx.controlValue(),
      forcedOff: state.ctrl.forcedOff,
      gridTotalW: state.meter.grid_total_w,
      gridDirection: gridDirection(state.meter.grid_total_w, cfg.gridPositiveMeans).mode,
      gridSetpointW: state.victron.gridSetpointW,
      minSocPct: state.victron.minSocPct,
      soc: state.victron.soc,
      batteryPowerW: state.victron.batteryPowerW,
      pvTotalW: state.victron.pvTotalW,
      scheduleActive: state.schedule.active,
      costs: costSummary(),
      userEnergyPricing: userEnergyPricingSummary()
    };

    // === NEW FIELDS — namespaced under dvhub_* to avoid collision (D-18) ===
    // Per-section error isolation (Plan 08-07 Task 2): one section failing must
    // NOT 500 the whole integration endpoint. Failures attach to base.dvhub_errors[].
    const sectionErrors = [];
    let forecastResp = null;
    try {
      forecastResp = await ctx.forecastService?.buildForecastResponse?.();
    } catch (err) {
      sectionErrors.push({ section: 'forecast', error: err?.message ?? String(err) });
      pushLog('integration_state_forecast_error', { error: err?.message ?? String(err) });
    }
    if (forecastResp) {
      // Duration-aware energy calculation (review concern: "summing powerW/1000 ignores slot duration")
      const pvSlots = forecastResp.pv?.slots || [];
      const pvDurationH = forecastResp.pv?.resolution === '15min' ? 0.25 : 1;
      const pvTodayKwh = pvSlots.reduce((sum, s) => sum + ((s.powerW || 0) * pvDurationH) / 1000, 0);

      const loadSlots = forecastResp.load?.slots || [];
      const loadDurationH = forecastResp.load?.resolution === '1h' ? 1 : 0.25;
      const loadTodayKwh = loadSlots.reduce((sum, s) => sum + ((s.powerW || 0) * loadDurationH) / 1000, 0);

      base.dvhub_forecast = {
        pvTodayKwh: Math.round(pvTodayKwh * 100) / 100,
        loadTodayKwh: Math.round(loadTodayKwh * 100) / 100,
        pvModel: forecastResp.meta?.pvModel || null,
        generatedAt: forecastResp.meta?.generatedAt || null
      };
    }

    const optStatus = ctx.optimizerService?.getStatus?.();
    if (optStatus) {
      // Uses ACTUAL field names: source (NOT primarySource), rulesCount (NOT schedule.rules.length)
      base.dvhub_optimizer = {
        enabled: optStatus.enabled ?? false,
        source: optStatus.source || null,
        lastRunAt: optStatus.lastRunAt || null,
        rulesCount: optStatus.rulesCount ?? 0,
        error: optStatus.error || null
      };
    }

    const teslaState = ctx.teslamateService?.getState?.();
    if (teslaState && Object.values(teslaState).some(v => v != null)) {
      base.dvhub_tesla = teslaState;
    }

    if (sectionErrors.length > 0) {
      base.dvhub_errors = sectionErrors;
    }

    return base;
  }

  // -- EOS (Akkudoktor) Integration --
  function eosState() {
    const cfg = getCfg();
    const now = new Date();
    const soc = Number(state.victron.soc ?? 0);
    const gridTotal = Number(state.meter.grid_total_w ?? 0);
    const posImport = cfg.gridPositiveMeans === 'grid_import';
    const gridImportW = Math.max(0, posImport ? gridTotal : -gridTotal);
    const gridExportW = Math.max(0, posImport ? -gridTotal : gridTotal);

    return {
      // Messwerte im EOS-Format (PUT /v1/measurement/data)
      measurement: {
        start_datetime: now.toISOString(),
        interval: `${cfg.meterPollMs / 1000} seconds`,
        battery_soc: [soc / 100],
        battery_power: [Number(state.victron.batteryPowerW ?? 0)],
        grid_import_w: [gridImportW],
        grid_export_w: [gridExportW],
        pv_power: [Number(state.victron.pvTotalW ?? 0)],
        load_power: [Number(state.victron.selfConsumptionW ?? 0)],
        power_l1_w: [Number(state.meter.grid_l1_w ?? 0)],
        power_l2_w: [Number(state.meter.grid_l2_w ?? 0)],
        power_l3_w: [Number(state.meter.grid_l3_w ?? 0)]
      },
      // Aktuelle Systeminfo
      system: {
        timestamp: now.toISOString(),
        soc_pct: soc,
        battery_power_w: Number(state.victron.batteryPowerW ?? 0),
        pv_total_w: Number(state.victron.pvTotalW ?? 0),
        grid_total_w: gridTotal,
        grid_import_w: gridImportW,
        grid_export_w: gridExportW,
        grid_setpoint_w: Number(state.victron.gridSetpointW ?? 0),
        min_soc_pct: Number(state.victron.minSocPct ?? 0),
        self_consumption_w: Number(state.victron.selfConsumptionW ?? 0)
      },
      // EPEX-Preise (fuer EOS prediction import)
      prices: epexPriceArray()
    };
  }

  // -- EMHASS Integration --
  function emhassState() {
    const soc = Number(state.victron.soc ?? 0);
    const prices = epexPriceArray();

    return {
      // Aktuelle Werte fuer soc_init
      soc_init: soc / 100,
      battery_power_w: Number(state.victron.batteryPowerW ?? 0),
      pv_power_w: Number(state.victron.pvTotalW ?? 0),
      load_power_w: Number(state.victron.selfConsumptionW ?? 0),
      grid_power_w: Number(state.meter.grid_total_w ?? 0),
      // EPEX-Preise als Array (EUR/kWh) fuer load_cost_forecast
      load_cost_forecast: prices.map((p) => p.eur_kwh),
      // Timestamps dazu
      price_timestamps: prices.map((p) => p.ts_iso),
      // Preise als prod_price_forecast (Einspeiseverguetung, hier identisch)
      prod_price_forecast: prices.map((p) => p.eur_kwh),
      // System-Metadaten
      timestamp: new Date().toISOString(),
      grid_setpoint_w: Number(state.victron.gridSetpointW ?? 0),
      min_soc_pct: Number(state.victron.minSocPct ?? 0)
    };
  }

  // ── Meter Scan ───────────────────────────────────────────────────────
  async function runMeterScan(params = {}) {
    const cfg = getCfg();
    if (state.scan.running) throw new Error('scan already running');
    const p = { ...cfg.scan, ...params };
    p.start = Number(p.start);
    p.end = Number(p.end);
    p.step = Math.max(1, Number(p.step));
    p.quantity = Math.max(1, Math.min(125, Number(p.quantity)));

    state.scan.running = true;
    state.scan.updatedAt = Date.now();
    state.scan.params = p;
    state.scan.rows = [];
    state.scan.error = null;
    pushLog('scan_start', p);

    const rows = [];
    try {
      for (let addr = p.start; addr <= p.end; addr += p.step) {
        try {
          const regs = await ctx.scanTransport.mbRequest({
            host: p.host,
            port: p.port,
            unitId: p.unitId,
            fc: p.fc,
            address: addr,
            quantity: p.quantity,
            timeoutMs: p.timeoutMs
          });
          const hasNonZero = regs.some((x) => Number(x) !== 0);
          if (!p.onlyNonZero || hasNonZero) rows.push({ addr, regs, s16: regs.map((v) => s16(v)) });
        } catch (e) {
          rows.push({ addr, error: e.message });
        }
        if (rows.length >= 1000) break;
      }
      state.scan.rows = rows;
      pushLog('scan_done', { rows: rows.length });
    } catch (e) {
      state.scan.error = e.message;
      pushLog('scan_error', { error: e.message });
    } finally {
      state.scan.running = false;
      state.scan.updatedAt = Date.now();
    }
  }

  // ── Config helpers ───────────────────────────────────────────────────
  // SEC-01: REDACTED_PATHS + redactConfig imported from config-redaction.js (shared module)

  function configMetaPayload() {
    const loadedConfig = ctx.getLoadedConfig();
    return {
      path: ctx.getConfigPath(),
      exists: loadedConfig.exists,
      valid: loadedConfig.valid,
      parseError: loadedConfig.parseError,
      needsSetup: loadedConfig.needsSetup,
      warnings: loadedConfig.warnings || []
    };
  }

  function configApiPayload() {
    const cfg = getCfg();
    return {
      ok: true,
      meta: configMetaPayload(),
      config: redactConfig(ctx.getRawCfg()),
      effectiveConfig: redactConfig(cfg),
      definition: ctx.getConfigDefinition()
    };
  }

  // ── Status / History builders ────────────────────────────────────────
  function buildApiStatusResponse(now = Date.now()) {
    return buildWorkerBackedStatusResponse({
      cachedStatus: ctx.getCachedRuntimeStatusPayload(),
      fallbackStatus: ctx.buildFallbackStatusPayload(now),
      setup: configMetaPayload(),
      runtime: ctx.buildRuntimeRouteMeta(now)
    });
  }

  function buildApiHistoryImportStatusResponse() {
    const cfg = getCfg();
    return buildHistoryImportStatusResponse({
      cachedStatus: ctx.getCachedRuntimeStatusPayload(),
      fallbackTelemetryEnabled: !!cfg.telemetry?.enabled,
      fallbackHistoryImport: ctx.historyImportManager?.getStatus?.() || null
    });
  }

  // ── Static file serving ──────────────────────────────────────────────
  function servePage(res, filename) {
    const appDir = ctx.getAppDir();
    const publicDir = path.resolve(appDir, 'public');
    const file = path.resolve(publicDir, filename);
    if (!file.startsWith(publicDir + path.sep) && file !== publicDir) return text(res, 400, 'bad path');
    if (!fs.existsSync(file)) return text(res, 404, 'not found');
    const cacheControl = filename === 'setup.html' ? 'no-store' : 'no-cache';
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8', 'cache-control': cacheControl });
    fs.createReadStream(file).pipe(res);
  }

  function serveStatic(req, res) {
    const appDir = ctx.getAppDir();
    const urlPath = new URL(req.url, 'http://localhost').pathname;
    const reqPath = urlPath === '/' ? '/index.html' : decodeURIComponent(urlPath);
    const publicDir = path.resolve(appDir, 'public');
    const file = path.resolve(publicDir, reqPath.replace(/^\/+/, ''));
    if (!file.startsWith(publicDir + path.sep) && file !== publicDir) return text(res, 400, 'bad path');
    if (!fs.existsSync(file)) return text(res, 404, 'not found');
    const ext = path.extname(file).toLowerCase();
    const mime = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon'
    }[ext] || 'application/octet-stream';
    let cacheControl;
    if (ext === '.html') {
      cacheControl = reqPath.includes('setup') ? 'no-store' : 'no-cache';
    } else if (reqPath === '/sw.js') {
      cacheControl = 'no-store';
    } else if (ext === '.js' || ext === '.css') {
      cacheControl = 'no-cache';
    }
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': mime, ...(cacheControl && { 'cache-control': cacheControl }) });
    fs.createReadStream(file).pipe(res);
  }

  // ── Main request handler ─────────────────────────────────────────────
  async function handleRequest(req, res, url) {
    // Plan 08-04 Task 2 Step 5: Host-header allowlist. Runs before everything
    // else (including /health and /) — spoofed Host must not drive absolute-URL
    // generation or redirect targets anywhere in the handler chain. Empty
    // allowedHosts = LAN-dev permissive (returns true unconditionally).
    const cfgForHost = getCfg();
    const hostVal = getRequestHost(req, cfgForHost);
    if (!isHostAllowed(hostVal, cfgForHost)) {
      pushLog('host_header_rejected', {
        host: hostVal,
        forwarded: !!req.headers['x-forwarded-host'],
        trustProxy: cfgForHost.trustProxy === true,
        path: url.pathname
      });
      return json(res, 400, { ok: false, error: 'host_not_allowed' });
    }

    // Plan 08-04 Task 2 Step 5: defense-in-depth CORS check for non-OPTIONS
    // state-changing requests. The orchestrator (server.js) already handles
    // OPTIONS preflights and sets ACAO on allowed origins; here we reject
    // writes from any unlisted Origin so a misconfigured CDN / proxy that
    // strips preflights cannot tunnel cross-origin writes. GET/HEAD pass
    // through (no Origin check) — browsers never send them with credentials
    // cross-origin unless the server opted in with ACAO, which we don't.
    if (
      url.pathname.startsWith('/api/')
      && req.method !== 'GET'
      && req.method !== 'HEAD'
      && req.method !== 'OPTIONS'
    ) {
      const originHeader = String(req.headers.origin || '');
      if (originHeader) {
        const allowed = resolveCorsAllowedOrigin(originHeader, cfgForHost);
        // When corsAllowedOrigins is empty, cross-origin writes are rejected.
        // When populated, only listed origins are accepted.
        const list = Array.isArray(cfgForHost.corsAllowedOrigins) ? cfgForHost.corsAllowedOrigins : [];
        if (list.length > 0 && !allowed) {
          pushLog('cors_origin_rejected', { origin: originHeader, path: url.pathname, method: req.method });
          return json(res, 403, { ok: false, error: 'cors_origin_not_allowed' });
        }
      }
    }

    if (url.pathname === '/' && req.method === 'GET') {
      return servePage(res, ctx.needsSetup() ? 'setup.html' : 'index.html');
    }

    if (url.pathname === '/health' && req.method === 'GET') {
      return json(res, 200, {
        ok: true,
        uptimeSec: Math.round(process.uptime()),
        version: ctx.getAppVersion().versionLabel || null
      });
    }

    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/dv/')) {
      if (!checkRateLimit(req, res)) return;
      if (!checkAuth(req, res)) return;
    }

    // Plan 08-03 Task 1: gate OpenAPI/Swagger UI behind auth.
    // These describe the admin surface and include Try-It-Out buttons that would otherwise
    // let any LAN client enumerate and probe the API without a Bearer token.
    if (
      url.pathname === '/api-docs.html' ||
      url.pathname === '/api-docs' ||
      url.pathname === '/openapi.json' ||
      url.pathname === '/api-docs-init.js'
    ) {
      if (!checkAuth(req, res)) return;
    }

    if (url.pathname === '/dv/control-value' && req.method === 'GET') return text(res, 200, ctx.controlValue());

    if (url.pathname === '/api/keepalive/modbus' && req.method === 'GET') return json(res, 200, keepaliveModbusPayload());
    if (url.pathname === '/api/keepalive/pulse' && req.method === 'GET') return json(res, 200, keepalivePulsePayload());
    if (url.pathname === '/api/config' && req.method === 'GET') return json(res, 200, configApiPayload());

    if (url.pathname === '/api/config/export' && req.method === 'GET') {
      return downloadJson(res, 'dvhub-config.json', redactConfig(ctx.getRawCfg()));
    }

    if (url.pathname === '/api/discovery/systems' && req.method === 'GET') {
      const payload = await ctx.buildSystemDiscoveryPayload({
        query: Object.fromEntries(url.searchParams)
      });
      return json(res, payload.ok ? 200 : 400, payload);
    }

    if (url.pathname === '/api/status' && req.method === 'GET') {
      ctx.expireLeaseIfNeeded();
      return json(res, 200, buildApiStatusResponse(Date.now()));
    }

    if (url.pathname === '/api/costs' && req.method === 'GET') return json(res, 200, costSummary());

    if (url.pathname === '/api/integration/home-assistant' && req.method === 'GET') return json(res, 200, await integrationState());

    if (url.pathname === '/api/integration/loxone' && req.method === 'GET') {
      const s = await integrationState();
      const lines = Object.entries(s).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`);
      return text(res, 200, lines.join('\n'));
    }

    // Optimizer status endpoint
    if (url.pathname === '/api/optimizer/status' && req.method === 'GET') {
      const status = ctx.optimizerService?.getStatus() || {
        enabled: false,
        error: 'Optimizer service not initialized'
      };
      return json(res, 200, status);
    }

    // Latest optimizer run — curves for leitstand chart (Phase 05 follow-up).
    // Returns the most recent run + its time-series (battery plan, price input,
    // PV/load forecast). Optional ?optimizer=internal|eos|emhass filter.
    if (url.pathname === '/api/optimizer/runs/latest' && req.method === 'GET') {
      if (!ctx.telemetryStore?.getLatestOptimizerRun) {
        return json(res, 503, { ok: false, error: 'telemetry store not available' });
      }
      try {
        const optimizer = url.searchParams.get('optimizer') || null;
        const run = await ctx.telemetryStore.getLatestOptimizerRun({ optimizer });
        if (!run) return json(res, 200, { ok: true, run: null });

        // Group series by key for easy chart consumption
        const byKey = {};
        for (const s of run.series) {
          if (!byKey[s.seriesKey]) byKey[s.seriesKey] = [];
          byKey[s.seriesKey].push({ ts: s.ts, value: s.value, scope: s.scope, unit: s.unit });
        }
        return json(res, 200, {
          ok: true,
          run: {
            id: run.id,
            optimizer: run.optimizer,
            runStartedAt: run.runStartedAt,
            runFinishedAt: run.runFinishedAt,
            status: run.status,
            source: run.source,
            inputJson: run.inputJson,
            seriesByKey: byKey
          }
        });
      } catch (e) {
        pushLog('optimizer_runs_api_error', { error: e.message });
        return json(res, 500, { ok: false, error: e.message });
      }
    }

    // --- Family Dashboard API (DASH-02, DASH-03) ---
    // Aggregated status payload polled every 5s by the family dashboard.
    // LAN-allowlisted read path: tablet on the local network can reach it
    // without a Bearer token. See LAN_SAFE_ENDPOINTS above.
    if (url.pathname === '/api/family/status' && req.method === 'GET') {
      if (!ctx.familyService) return json(res, 503, { ok: false, error: 'family service not available' });
      try {
        const payload = ctx.familyService.buildFamilyStatus();
        return json(res, 200, { ok: true, ...payload });
      } catch (e) {
        pushLog('family_api_error', { error: e.message });
        return json(res, 500, { ok: false, error: 'family status failed' });
      }
    }

    // Presence state read — screensaver wake polling (D-19). LAN-safe GET.
    if (url.pathname === '/api/family/presence' && req.method === 'GET') {
      if (!ctx.familyService) return json(res, 503, { ok: false, error: 'family service not available' });
      return json(res, 200, { ok: true, ...ctx.familyService.getPresence() });
    }

    // Presence webhook (D-08, D-19). POSTs always require auth token —
    // isLanSafeRequest rejects non-GET requests by design. Loxone/HA/MQTT
    // integrations configure the Bearer token in Phase 04.
    if (url.pathname === '/api/family/presence' && req.method === 'POST') {
      if (!ctx.familyService) return json(res, 503, { ok: false, error: 'family service not available' });
      let body;
      try {
        body = await parseBody(req);
      } catch (e) {
        return json(res, 400, { ok: false, error: 'invalid json' });
      }
      const detected = body?.detected === true;
      const source = typeof body?.source === 'string' ? body.source : 'unknown';
      ctx.familyService.setPresence({ detected, source });
      return json(res, 200, { ok: true });
    }

    // DASH-01: Family dashboard HTML (D-03 direct URL, D-02 no topbar/Kiosk feel)
    // Served via servePage so the filename 'family.html' stays inside publicDir.
    if (url.pathname === '/family' && req.method === 'GET') {
      return servePage(res, 'family.html');
    }

    // --- Device API (D-15, INTG-05) ---
    // GET /api/devices — device list
    if (url.pathname === '/api/devices' && req.method === 'GET') {
      const devices = ctx.deviceService?.getDevices() || [];
      return json(res, 200, devices);
    }

    // GET /api/devices/:id — single device with history from PostgreSQL
    if (url.pathname.startsWith('/api/devices/') && req.method === 'GET') {
      const deviceId = decodeURIComponent(url.pathname.split('/api/devices/')[1]);
      if (!deviceId) return json(res, 400, { error: 'Missing device ID' });
      const devices = ctx.deviceService?.getDevices() || [];
      const device = devices.find(d => d.id === deviceId);
      if (!device) return json(res, 404, { error: 'Device not found' });
      let history = [];
      if (ctx.db) {
        try {
          const result = await ctx.db.query(
            'SELECT ts_utc, power_w, energy_today_wh, online FROM device_readings WHERE device_id = $1 ORDER BY ts_utc DESC LIMIT 288',
            [deviceId]
          );
          history = result.rows;
        } catch (err) {
          pushLog('device_history_error', { device: deviceId, error: err.message });
        }
      }
      return json(res, 200, { ...device, history });
    }

    // GET /api/integrations/status — integration status overview (D-08)
    if (url.pathname === '/api/integrations/status' && req.method === 'GET') {
      const mqttCfg = getCfg().mqtt || {};
      const payload = {
        timestamp: Date.now(),
        mqtt: {
          connected: ctx.mqttHub?.connected ?? false,
          // Plan 08-03 Task 2: strip user:pass from the broker URL before emit.
          // Previously this field leaked the full `mqtt://user:secret@host:1883` to
          // any (now-authenticated) client. We keep the host/port intact so the UI
          // can still display "which broker am I on" without exposing credentials.
          broker: mqttCfg.brokerUrl ? redactUrlCreds(mqttCfg.brokerUrl) : 'embedded',
          embedded: !mqttCfg.brokerUrl,
          topicCount: ctx.mqttPublisher?.topicCount ?? 0
        },
        tesla: {
          enabled: getCfg().integrations?.tesla?.enabled ?? false,
          state: ctx.teslamateService?.getState() || null,
          lastUpdate: ctx.teslamateService?.lastUpdateAt || null
        },
        homeAssistant: {
          haDiscovery: mqttCfg.haDiscovery?.enabled ?? false,
          topicsPublished: ctx.mqttPublisher?.topicCount ?? 0
        },
        loxone: {
          configured: !!getCfg().loxone
        },
        devices: {
          total: ctx.deviceService?.getDevices()?.length ?? 0,
          online: ctx.deviceService?.getDevices()?.filter(d => d.online)?.length ?? 0,
          list: ctx.deviceService?.getDevices() || []
        },
        notifications: {
          enabled: getCfg().notifications?.enabled ?? false,
          providers: Object.entries(getCfg().notifications?.providers || {})
            .filter(([, v]) => v.enabled).map(([k]) => k)
        }
      };
      return json(res, 200, payload);
    }

    // Integrations page HTML route
    if (url.pathname === '/integrations' && req.method === 'GET') {
      return servePage(res, 'integrations.html');
    }

    // EOS (Akkudoktor) -- Messwerte + Preise abrufen
    if (url.pathname === '/api/integration/eos' && req.method === 'GET') return json(res, 200, eosState());

    // EMHASS -- Messwerte + Preise abrufen
    if (url.pathname === '/api/integration/emhass' && req.method === 'GET') return json(res, 200, emhassState());

    if (url.pathname === '/api/log' && req.method === 'GET') {
      const limit = resolveLogLimit(url.searchParams.get('limit'));
      return json(res, 200, { rows: state.log.slice(-limit) });
    }

    // Plan 08-07 Task 3: frontend error reporting endpoint. The browser POSTs
    // window.onerror / unhandledrejection / per-widget catch payloads here so
    // operator-visible logs show frontend crashes too. Auth-required (handled by
    // checkAuth above for any non-LAN-safe /api/ path).
    if (url.pathname === '/api/log' && req.method === 'POST') {
      const body = await parseBody(req);
      if (!body || typeof body !== 'object') {
        return json(res, 400, { ok: false, error: 'json_body_required' });
      }
      const level = String(body.level || 'error').slice(0, 16);
      const source = String(body.source || 'frontend').slice(0, 32);
      // Cap free-form fields to keep the in-memory ring buffer bounded.
      const message = typeof body.message === 'string' ? body.message.slice(0, 500) : null;
      const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : null;
      const stack = typeof body.stack === 'string' ? body.stack.slice(0, 4000) : null;
      pushLog(`frontend_${level}`, {
        source,
        page: typeof body.page === 'string' ? body.page.slice(0, 200) : null,
        type: typeof body.type === 'string' ? body.type.slice(0, 64) : null,
        widget: typeof body.widget === 'string' ? body.widget.slice(0, 64) : null,
        message,
        reason,
        filename: typeof body.filename === 'string' ? body.filename.slice(0, 200) : null,
        lineno: Number.isFinite(body.lineno) ? body.lineno : null,
        colno: Number.isFinite(body.colno) ? body.colno : null,
        stack
      });
      return json(res, 200, { ok: true });
    }

    // Persistent DV signal log from database
    if (url.pathname === '/api/log/dv-signals' && req.method === 'GET') {
      if (!ctx.telemetryStore?.listControlEvents) return json(res, 503, { ok: false, error: 'telemetry store not available' });
      const limit = Number(url.searchParams.get('limit')) || 200;
      const eventType = url.searchParams.get('type') || null;
      try {
        const rows = await ctx.telemetryStore.listControlEvents({ limit, eventType });
        return json(res, 200, { ok: true, rows, total: rows.length });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    }

    // --- Telemetry Series Query API ---
    if (url.pathname === '/api/telemetry/series' && req.method === 'GET') {
      if (!ctx.telemetryStore?.querySeries) return json(res, 503, { ok: false, error: 'telemetry store not available' });
      const keys = (url.searchParams.get('keys') || 'battery_soc_pct').split(',').map(k => k.trim()).filter(Boolean);
      const now = new Date();
      const start = url.searchParams.get('start') || new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const end = url.searchParams.get('end') || new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
      const maxRes = Number(url.searchParams.get('maxResolution')) || 900;
      // Plan 08-04 Task 1 Step 7: bound total slot scan. Without this an
      // attacker could pass start=0&end=now&step=1 across many keys and drag
      // the Pi into a multi-minute DB scan, starving foreground traffic.
      // maxRes is in SECONDS (maxResolution=900 -> 15 min buckets).
      const startMs = Date.parse(start);
      const endMs = Date.parse(end);
      const stepMs = Math.max(1, Number(maxRes)) * 1000;
      const totalSlots = Math.ceil(((Number.isFinite(endMs) ? endMs : 0) - (Number.isFinite(startMs) ? startMs : 0)) / stepMs) * (keys.length || 1);
      if (!Number.isFinite(totalSlots) || totalSlots < 0 || totalSlots > MAX_TELEMETRY_SCAN_SLOTS) {
        return json(res, 400, {
          ok: false,
          error: 'scan_too_large',
          limit: MAX_TELEMETRY_SCAN_SLOTS,
          requested: Number.isFinite(totalSlots) ? totalSlots : null
        });
      }
      try {
        const rows = await ctx.telemetryStore.querySeries({ seriesKeys: keys, start, end, maxResolution: maxRes });
        return json(res, 200, { ok: true, keys, start, end, total: rows.length, data: rows });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    }

    // --- Combined Forecast API (PV + Load + Price + Confidence per D-01) ---
    if (url.pathname === '/api/forecast' && req.method === 'GET') {
      if (!ctx.forecastService) return json(res, 503, { ok: false, error: 'forecast service not available' });
      try {
        const payload = await ctx.forecastService.buildForecastResponse();
        return json(res, 200, { ok: true, ...payload });
      } catch (e) {
        pushLog('forecast_api_error', { error: e.message });
        return json(res, 500, { ok: false, error: 'forecast generation failed' });
      }
    }

    if (url.pathname === '/api/forecast/refresh' && req.method === 'POST') {
      ctx.fetchVrmForecast().catch(e => pushLog('vrm_forecast_manual_error', { error: e.message }));
      return json(res, 202, { ok: true, message: 'Forecast refresh started' });
    }

    if (url.pathname === '/api/epex/refresh' && req.method === 'POST') {
      await ctx.fetchEpexDay();
      return json(res, 200, { ok: state.epex.ok, error: state.epex.error });
    }

    if (url.pathname === '/api/epex/zones' && req.method === 'GET') {
      const cfg = getCfg();
      try {
        const baseUrl = cfg.epex.priceApiUrl || 'https://api.dvhub.de';
        const r = await fetch(`${baseUrl}/api/zones`, { signal: AbortSignal.timeout(10000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        return json(res, 200, data);
      } catch (e) {
        return json(res, 502, { error: e.message });
      }
    }

    if (url.pathname === '/api/epex/gaps' && req.method === 'GET') {
      const cfg = getCfg();
      try {
        const baseUrl = cfg.epex.priceApiUrl || 'https://api.dvhub.de';
        const zone = url.searchParams.get('zone') || cfg.epex.bzn || 'DE-LU';
        const r = await fetch(`${baseUrl}/api/prices/gaps?zone=${encodeURIComponent(zone)}`, { signal: AbortSignal.timeout(10000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        return json(res, 200, data);
      } catch (e) {
        return json(res, 502, { error: e.message });
      }
    }

    if (url.pathname === '/api/epex/backfill' && req.method === 'POST') {
      const cfg = getCfg();
      try {
        const baseUrl = cfg.epex.priceApiUrl || 'https://api.dvhub.de';
        const body = await parseBody(req);
        const zone = body?.zone || cfg.epex.bzn || 'DE-LU';
        const start = body?.start || '2020-01-01';
        if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || isNaN(Date.parse(start))) {
          return json(res, 400, { error: 'Invalid start date, expected YYYY-MM-DD' });
        }
        if (!/^[A-Z]{2}(-[A-Z]{2,4})?$/.test(zone)) {
          return json(res, 400, { error: 'Invalid zone format' });
        }
        const r = await fetch(`${baseUrl}/api/backfill`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ zone, start }),
          signal: AbortSignal.timeout(10000)
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        return json(res, 200, data);
      } catch (e) {
        return json(res, 502, { error: e.message });
      }
    }

    if (url.pathname === '/api/meter/scan' && req.method === 'POST') {
      const body = await parseBody(req);
      // Plan 08-04 Task 2 Step 3: SSRF guard. Meter scan talks raw Modbus TCP —
      // an attacker with a stolen token could otherwise point it at any host on
      // the internet (data-exfil, port-scan via the Pi, liveness oracle).
      // Restrict to RFC1918 + loopback, validate port range.
      const scanHost = body?.host || getCfg().scan?.host;
      if (!isRfc1918OrLoopback(String(scanHost || ''))) {
        return json(res, 400, { ok: false, error: 'host_not_in_rfc1918', host: scanHost });
      }
      const scanPort = Number(body?.port ?? getCfg().scan?.port);
      if (!Number.isFinite(scanPort) || scanPort < 1 || scanPort > 65535) {
        return json(res, 400, { ok: false, error: 'port_out_of_range', port: scanPort });
      }
      runMeterScan(body).catch((e) => {
        state.scan.running = false;
        state.scan.error = e.message;
      });
      return json(res, 200, { ok: true, running: true });
    }

    if (url.pathname === '/api/meter/scan' && req.method === 'GET') return json(res, 200, state.scan);

    if (url.pathname === '/api/schedule' && req.method === 'GET') {
      return json(res, 200, {
        config: state.schedule.config,
        rules: state.schedule.rules,
        active: state.schedule.active,
        lastWrite: state.schedule.lastWrite
      });
    }

    if (url.pathname === '/api/history/import/status' && req.method === 'GET') {
      return json(res, 200, buildApiHistoryImportStatusResponse());
    }

    if (url.pathname === '/api/history/summary' && req.method === 'GET') {
      if (!ctx.historyApi || typeof ctx.historyApi.getSummary !== 'function') {
        return json(res, 503, { ok: false, error: 'internal telemetry store disabled' });
      }
      const result = await ctx.historyApi.getSummary({
        view: url.searchParams.get('view'),
        date: url.searchParams.get('date')
      });
      return json(res, result.status, result.body);
    }

    if (url.pathname === '/api/history/export' && req.method === 'GET') {
      if (!ctx.historyApi || typeof ctx.historyApi.getExportCsv !== 'function') {
        return json(res, 503, { ok: false, error: 'internal telemetry store disabled' });
      }
      const result = await ctx.historyApi.getExportCsv({
        view: url.searchParams.get('view'),
        date: url.searchParams.get('date')
      });
      if (result.status !== 200 || !result.rawBody) {
        return json(res, result.status || 400, result.body || { ok: false, error: 'export failed' });
      }
      const body = String(result.rawBody);
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        ...result.headers,
        'content-length': Buffer.byteLength(body, 'utf8')
      });
      res.end(body);
      return;
    }

    // --- Config POST / Import POST ---
    if ((url.pathname === '/api/config' || url.pathname === '/api/config/import') && req.method === 'POST') {
      const body = await parseBody(req);
      if (!body || typeof body !== 'object' || !body.config || typeof body.config !== 'object' || Array.isArray(body.config)) {
        return json(res, 400, { ok: false, error: 'config object required' });
      }
      // Plan 08-01 Task 1 (CRITICAL #1 companion): never allow a config write
      // that empties the apiToken — that would re-open the auth bypass we just closed.
      if (Object.prototype.hasOwnProperty.call(body.config, 'apiToken')
          && (body.config.apiToken === '' || body.config.apiToken == null)) {
        return json(res, 400, { ok: false, error: 'api_token_cannot_be_empty' });
      }
      // Plan 08-04 Task 1 Step 3: strict root-level schema. Reject any top-level
      // key that is not in ALLOWED_CONFIG_ROOTS so an attacker cannot pass
      // arbitrary paths that future handlers might read without validation.
      // (Deep-path validation — e.g. schema of `victron.*` — stays in Plan 08-06.)
      const unknownRoots = Object.keys(body.config).filter((k) => !ALLOWED_CONFIG_ROOTS.has(k));
      if (unknownRoots.length > 0) {
        return json(res, 400, { ok: false, error: 'unknown_config_paths', paths: unknownRoots });
      }
      // Plan 08-06 Task 1 Step 3: legal-gate flip detection.
      // allowGridCharge / allowGridDischarge are EEG/§14a-relevant. Flipping either
      // requires an explicit `x-confirm-legal-gate: true` header AND emits a distinct
      // audit event so the actor IP is recorded separately from generic config_saved.
      const getByPath = (obj, dotPath) => dotPath.split('.').reduce(
        (a, k) => (a != null && Object.prototype.hasOwnProperty.call(a, k)) ? a[k] : undefined,
        obj
      );
      const LEGAL_GATE_PATHS = ['optimizer.allowGridCharge', 'optimizer.allowGridDischarge'];
      const currentCfgForGate = getCfg();
      // Plan 08-06 Task 2 Step 2: setup wizard one-shot bootstrap.
      // If apiToken is currently empty AND this request is trying to set it, the
      // caller MUST present a valid x-bootstrap-token header (matched against
      // ${DV_DATA_DIR}/bootstrap.token, written at startup, mode 0600). This blocks
      // the first-caller-wins race on a fresh device — even LAN attackers cannot
      // take over the box without filesystem access.
      const currentApiToken = currentCfgForGate.apiToken;
      const settingApiToken = Object.prototype.hasOwnProperty.call(body.config, 'apiToken')
        && typeof body.config.apiToken === 'string'
        && body.config.apiToken.length > 0;
      const setupPhase = (!currentApiToken || currentApiToken === '') && settingApiToken;
      if (setupPhase) {
        if (!requireBootstrapToken(req, res)) return;
      }
      const flippedLegalGates = LEGAL_GATE_PATHS.filter((p) => {
        const before = getByPath(currentCfgForGate, p);
        const after = getByPath(body.config, p);
        return after !== undefined && before !== after;
      });
      if (flippedLegalGates.length > 0 && req.headers['x-confirm-legal-gate'] !== 'true') {
        // Plan 08-09 Task 2 Step 6: actor context (ip + ua + session) so we
        // can attribute attempted illegal-gate flips, not just see the IP.
        pushLog('legal_gate_flip_rejected', {
          paths: flippedLegalGates,
        }, actorContext(req));
        return json(res, 403, {
          ok: false,
          error: 'legal_gate_flip_requires_confirmation',
          paths: flippedLegalGates,
          hint: 'Add header x-confirm-legal-gate: true after reading EEG/§14a compliance documentation'
        });
      }
      // Plan 08-09 Task 2 Step 6: legal-gate flip events get the same actor
      // context as every other audited mutation (replaces the legacy ip-only
      // shorthand from plan 08-06).
      const cfgActor = actorContext(req);
      if (flippedLegalGates.length > 0) {
        pushLog('legal_gate_flipped', {
          paths: flippedLegalGates,
        }, cfgActor);
      }
      const result = ctx.saveAndApplyConfig(body.config);
      // Plan 08-06 Task 2 Step 2: consume the one-shot bootstrap token after
      // a successful setup-phase save. From here on, only Bearer-authenticated
      // requests can rewrite config — the takeover window is closed.
      if (setupPhase) {
        consumeBootstrapToken();
        pushLog('setup_bootstrap_consumed', {}, cfgActor);
      }
      // Plan 08-09 Task 2 Step 5: config_saved emits the FULL changedPaths
      // array (regulator-readable diff) plus the legacy count. Path entries
      // are dot-paths (e.g. 'optimizer.minSoc') — the actual VALUES are NOT
      // included to keep secrets out of the audit log (apiToken, mqtt
      // credentials etc. are in REDACTED_PATHS but the policy is "paths
      // only" anyway). This in-handler log is in addition to the generic
      // config_saved emitted by persistConfig (which sees only fs-level
      // context, not the path delta).
      pushLog('config_saved', {
        changedPaths: Array.isArray(result.changedPaths) ? result.changedPaths : [],
        pathCount: Array.isArray(result.changedPaths) ? result.changedPaths.length : 0,
        restartRequired: result.restartRequired,
        source: url.pathname.endsWith('/import') ? 'import' : 'settings',
      }, cfgActor);
      // If any small-market-automation setting changed (e.g. forecastAware,
      // searchWindow, minSoc, …), force a replan so the user immediately sees
      // the new plan instead of waiting for the next ambient regeneration tick
      // — which only fires on price/SOC/day changes, not on config edits.
      const smaChanged = Array.isArray(result.changedPaths)
        && result.changedPaths.some((p) => typeof p === 'string'
          && p.startsWith('schedule.smallMarketAutomation'));
      if (smaChanged && typeof ctx.regenerateSmallMarketAutomationRules === 'function') {
        ctx.regenerateSmallMarketAutomationRules({ force: true })
          .catch((e) => pushLog('sma_regen_after_config_save_error', { error: e.message }));
      }
      const freshCfg = getCfg();
      return json(res, 200, {
        ok: true,
        meta: configMetaPayload(),
        config: redactConfig(ctx.getRawCfg()),
        effectiveConfig: redactConfig(freshCfg),
        changedPaths: result.changedPaths,
        restartRequired: result.restartRequired,
        restartRequiredPaths: result.restartRequiredPaths
      });
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
        // Re-apply setcap in case node was upgraded
        const nodeBin = (await execFileAsync('which', ['node'], { timeout: 5000 }).catch(() => ({ stdout: '/usr/bin/node' }))).stdout.trim();
        await execFileAsync('sudo', ['setcap', 'cap_net_bind_service=+ep', nodeBin], { timeout: 5000 }).catch(() => {});

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

    // --- Software Update Check ---
    if (url.pathname === '/api/admin/update/check' && req.method === 'GET') {
      if (!ctx.getServiceActionsEnabled()) return json(res, 403, { ok: false, error: 'service actions disabled' });
      try {
        const repoRoot = ctx.getRepoRoot();
        const channel = ctx.getRawCfg().updateChannel || 'stable';
        await execFileAsync('git', ['fetch', '--tags', '--quiet', 'origin'], { cwd: repoRoot, timeout: 15000 });
        const localRev = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, timeout: 5000 })).stdout.trim();

        if (channel === 'stable') {
          let currentTag = null;
          try {
            currentTag = (await execFileAsync('git', ['describe', '--tags', '--exact-match', 'HEAD'], { cwd: repoRoot, timeout: 5000 })).stdout.trim();
          } catch { /* not on a tag */ }
          let latestTag = null;
          try {
            latestTag = (await execFileAsync('git', ['tag', '--sort=-v:refname'], { cwd: repoRoot, timeout: 5000 })).stdout.trim().split('\n')[0] || null;
          } catch { /* no tags */ }
          let changelog = '';
          if (currentTag && latestTag && currentTag !== latestTag) {
            try { changelog = (await execFileAsync('git', ['log', '--oneline', `${currentTag}..${latestTag}`], { cwd: repoRoot, timeout: 5000 })).stdout.trim(); } catch { /* */ }
          } else if (!currentTag && latestTag) {
            try { changelog = (await execFileAsync('git', ['log', '--oneline', `HEAD..${latestTag}`], { cwd: repoRoot, timeout: 5000 })).stdout.trim(); } catch { /* */ }
          }
          const updateAvailable = latestTag != null && latestTag !== currentTag;
          let availableVersions = [];
          try {
            const allTags = (await execFileAsync('git', ['tag', '--sort=-v:refname'], { cwd: repoRoot, timeout: 5000 })).stdout.trim();
            availableVersions = allTags ? allTags.split('\n').filter(Boolean).slice(0, 10) : [];
          } catch { /* ignore */ }
          return json(res, 200, {
            ok: true, channel,
            current: { version: ctx.getAppVersion().versionLabel, tag: currentTag, revision: localRev.slice(0, 7) },
            latest: { tag: latestTag, revision: null },
            updateAvailable,
            availableVersions,
            changelog: changelog ? changelog.split('\n').filter(Boolean) : []
          });
        } else {
          const remoteRev = (await execFileAsync('git', ['rev-parse', 'origin/main'], { cwd: repoRoot, timeout: 5000 })).stdout.trim();
          const behind = Number((await execFileAsync('git', ['rev-list', '--count', 'HEAD..origin/main'], { cwd: repoRoot, timeout: 5000 })).stdout.trim());
          const ahead = Number((await execFileAsync('git', ['rev-list', '--count', 'origin/main..HEAD'], { cwd: repoRoot, timeout: 5000 })).stdout.trim());
          let changelog = '';
          if (behind > 0) {
            changelog = (await execFileAsync('git', ['log', '--oneline', 'HEAD..origin/main'], { cwd: repoRoot, timeout: 5000 })).stdout.trim();
          }
          return json(res, 200, {
            ok: true, channel,
            current: { version: ctx.getAppVersion().versionLabel, tag: null, revision: localRev.slice(0, 7) },
            latest: { tag: null, revision: remoteRev.slice(0, 7) },
            behind, ahead,
            updateAvailable: behind > 0,
            changelog: changelog ? changelog.split('\n').filter(Boolean) : []
          });
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
        const repoRoot = ctx.getRepoRoot();
        const appDir = ctx.getAppDir();
        const channel = ctx.getRawCfg().updateChannel || 'stable';
        let gitOutput = '';
        const rollbackRev = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, timeout: 5000 })).stdout.trim();
        const stashResult = await execFileAsync('git', ['stash', '--include-untracked'], { cwd: repoRoot, timeout: 10000 }).catch(() => ({ stdout: 'No local changes' }));
        const hasStash = !stashResult.stdout.includes('No local changes');

        try {
          // --- git fetch + checkout (inside inner try for rollback coverage) ---
          if (channel === 'stable') {
            await execFileAsync('git', ['fetch', '--tags', 'origin'], { cwd: repoRoot, timeout: 15000 });
            const selectedTag = targetVersion || (await execFileAsync('git', ['tag', '--sort=-v:refname'], { cwd: repoRoot, timeout: 5000 })).stdout.trim().split('\n')[0];
            if (!selectedTag) throw new Error('No release tags found');
            const checkout = await execFileAsync('git', ['checkout', selectedTag], { cwd: repoRoot, timeout: 15000 });
            gitOutput = `Checked out ${selectedTag}: ${checkout.stderr.trim()}`;
          } else {
            await execFileAsync('git', ['fetch', 'origin'], { cwd: repoRoot, timeout: 15000 });
            await execFileAsync('git', ['checkout', '-B', 'main', 'origin/main'], { cwd: repoRoot, timeout: 15000 });
            const pull = await execFileAsync('git', ['pull', '--ff-only', 'origin', 'main'], { cwd: repoRoot, timeout: 30000 });
            gitOutput = pull.stdout.trim();
          }

          // --- npm install + syntax check ---
          const npmInstall = await execFileAsync('npm', ['install', '--omit=dev'], { cwd: appDir, timeout: 60000 });
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
          await execFileAsync('npm', ['install', '--omit=dev'], { cwd: appDir, timeout: 60000 }).catch(() => {});
          if (hasStash) await execFileAsync('git', ['stash', 'pop'], { cwd: repoRoot, timeout: 10000 }).catch(() => {});
          throw new Error(`Update rolled back: ${updateErr.message}`);
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
          const stashResult = await execFileAsync('git', ['stash', '--include-untracked'], { cwd: repoRoot, timeout: 10000 }).catch(() => ({ stdout: 'No local changes' }));
          const hasStash = !stashResult.stdout.includes('No local changes');
          try {
            // --- git fetch + checkout (inside inner try for rollback coverage) ---
            await execFileAsync('git', ['fetch', '--tags', 'origin'], { cwd: repoRoot, timeout: 15000 });

            if (channel === 'stable') {
              const latestTag = (await execFileAsync('git', ['tag', '--sort=-v:refname'], { cwd: repoRoot, timeout: 5000 })).stdout.trim().split('\n')[0];
              if (!latestTag) throw new Error('No release tags found');
              await execFileAsync('git', ['checkout', latestTag], { cwd: repoRoot, timeout: 15000 });
              gitOutput = `Switched to stable: ${latestTag}`;
            } else {
              await execFileAsync('git', ['checkout', '-B', 'main', 'origin/main'], { cwd: repoRoot, timeout: 15000 });
              gitOutput = 'Switched to dev: origin/main';
            }

            // --- npm install + syntax check ---
            await execFileAsync('npm', ['install', '--omit=dev'], { cwd: appDir, timeout: 60000 });
            await execFileAsync('node', ['--check', 'server.js'], { cwd: appDir, timeout: 5000 });
          } catch (switchErr) {
            pushLog('channel_switch_rollback', { reason: switchErr.message, rollbackTo: rollbackRev.slice(0, 7) });
            await execFileAsync('git', ['checkout', rollbackRev], { cwd: repoRoot, timeout: 15000 });
            await execFileAsync('npm', ['install', '--omit=dev'], { cwd: appDir, timeout: 60000 }).catch(() => {});
            if (hasStash) await execFileAsync('git', ['stash', 'pop'], { cwd: repoRoot, timeout: 10000 }).catch(() => {});
            throw new Error(`Channel switch rolled back: ${switchErr.message}`);
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

    // --- EOS Apply ---
    if (url.pathname === '/api/integration/eos/apply' && req.method === 'POST') {
      const body = await parseBody(req);
      const results = [];
      if (body.gridSetpointW !== undefined && Number.isFinite(Number(body.gridSetpointW))) {
        results.push(await ctx.applyControlTarget('gridSetpointW', Number(body.gridSetpointW), 'eos_optimization'));
      }
      if (body.chargeCurrentA !== undefined && Number.isFinite(Number(body.chargeCurrentA))) {
        results.push(await ctx.applyControlTarget('chargeCurrentA', Number(body.chargeCurrentA), 'eos_optimization'));
      }
      if (body.minSocPct !== undefined && Number.isFinite(Number(body.minSocPct))) {
        results.push(await ctx.applyControlTarget('minSocPct', Number(body.minSocPct), 'eos_optimization'));
      }
      pushLog('eos_apply', { targets: results.length, body });
      telemetrySafeWrite(() => ctx.telemetryStore?.writeOptimizerRun(buildOptimizerRunPayload({
        optimizer: 'eos',
        body,
        source: 'eos_apply'
      })));
      return json(res, 200, { ok: true, results });
    }

    // --- EMHASS Apply ---
    if (url.pathname === '/api/integration/emhass/apply' && req.method === 'POST') {
      const body = await parseBody(req);
      const results = [];
      if (body.gridSetpointW !== undefined && Number.isFinite(Number(body.gridSetpointW))) {
        results.push(await ctx.applyControlTarget('gridSetpointW', Number(body.gridSetpointW), 'emhass_optimization'));
      }
      if (body.chargeCurrentA !== undefined && Number.isFinite(Number(body.chargeCurrentA))) {
        results.push(await ctx.applyControlTarget('chargeCurrentA', Number(body.chargeCurrentA), 'emhass_optimization'));
      }
      if (body.minSocPct !== undefined && Number.isFinite(Number(body.minSocPct))) {
        results.push(await ctx.applyControlTarget('minSocPct', Number(body.minSocPct), 'emhass_optimization'));
      }
      pushLog('emhass_apply', { targets: results.length, body });
      telemetrySafeWrite(() => ctx.telemetryStore?.writeOptimizerRun(buildOptimizerRunPayload({
        optimizer: 'emhass',
        body,
        source: 'emhass_apply'
      })));
      return json(res, 200, { ok: true, results });
    }

    // --- History Import ---
    if (url.pathname === '/api/history/import' && req.method === 'POST') {
      if (!ctx.historyImportManager) return json(res, 503, { ok: false, error: 'internal telemetry store disabled' });
      const body = await parseBody(req);
      if (body.mode === 'backfill') {
        ctx.assertValidRuntimeCommand('history_backfill', { mode: 'gap', requestedBy: 'history_import_endpoint' });
        const result = await ctx.historyImportManager.backfillHistoryFromConfiguredSource({ mode: 'gap' });
        return json(res, result.ok ? 200 : 400, result);
      }
      const provider = String(body.provider || getCfg().telemetry?.historyImport?.provider || 'vrm');
      ctx.assertValidRuntimeCommand('history_import', {
        provider,
        requestedFrom: body.requestedFrom ?? body.start ?? null,
        requestedTo: body.requestedTo ?? body.end ?? null,
        interval: body.interval || '15mins'
      });
      const result = Array.isArray(body.rows) && body.rows.length
        ? ctx.historyImportManager.importSamples({
          provider,
          requestedFrom: body.requestedFrom ?? null,
          requestedTo: body.requestedTo ?? null,
          sourceAccount: body.sourceAccount ?? null,
          rows: body.rows
        })
        : await ctx.historyImportManager.importFromConfiguredSource({
          start: body.requestedFrom ?? body.start,
          end: body.requestedTo ?? body.end,
          interval: body.interval || '15mins'
        });
      return json(res, result.ok ? 200 : 400, result);
    }

    // --- History Backfill VRM ---
    if (url.pathname === '/api/history/backfill/vrm' && req.method === 'POST') {
      if (!ctx.historyImportManager) return json(res, 503, { ok: false, error: 'internal telemetry store disabled' });
      const body = await parseBody(req);
      const requestedMode = body?.mode === 'full' ? 'full' : 'gap';
      ctx.assertValidRuntimeCommand('history_backfill', {
        mode: requestedMode,
        requestedBy: 'history_backfill_endpoint'
      });
      const result = await ctx.historyImportManager.backfillHistoryFromConfiguredSource({ mode: requestedMode, requestedBy: 'api' });
      return json(res, result.ok ? 200 : 400, result);
    }

    // --- History Backfill Prices ---
    if (url.pathname === '/api/history/backfill/prices' && req.method === 'POST') {
      if (!ctx.historyApi || typeof ctx.historyApi.postPriceBackfill !== 'function') {
        return json(res, 503, { ok: false, error: 'internal telemetry store disabled' });
      }
      const body = await parseBody(req);
      const result = await ctx.historyApi.postPriceBackfill(body || {});
      return json(res, result.status, result.body);
    }

    // --- Schedule Rules POST ---
    if (url.pathname === '/api/schedule/rules' && req.method === 'POST') {
      const body = await parseBody(req);
      if (!Array.isArray(body.rules)) return json(res, 400, { ok: false, error: 'rules array required' });
      const validRules = body.rules.filter((rule) => {
        if (typeof rule !== 'object' || rule === null) return false;
        if (typeof rule.target !== 'string') return false;
        if (rule.value !== undefined && !Number.isFinite(Number(rule.value))) return false;
        return true;
      });
      if (validRules.length !== body.rules.length) return json(res, 400, { ok: false, error: 'invalid rule structure' });
      const incomingManualRules = validRules.filter((r) => !isSmallMarketAutomationRule(r));
      const existingAutomationRules = state.schedule.rules.filter((r) => isSmallMarketAutomationRule(r));
      const existingDcFeedRules = state.schedule.rules.filter((r) => r.target === 'feedExcessDcPv' && !isSmallMarketAutomationRule(r));
      const incomingDcFeedRules = incomingManualRules.filter((r) => r.target === 'feedExcessDcPv');
      const incomingOtherRules = incomingManualRules.filter((r) => r.target !== 'feedExcessDcPv');
      const dcFeedRules = incomingDcFeedRules.length ? incomingDcFeedRules : existingDcFeedRules;
      state.schedule.rules = [...incomingOtherRules, ...dcFeedRules, ...existingAutomationRules];
      pushLog('schedule_rules_updated', { manual: incomingOtherRules.length, dcFeed: dcFeedRules.length, automation: existingAutomationRules.length });
      ctx.persistConfig();
      return json(res, 200, { ok: true, count: state.schedule.rules.length });
    }

    // --- Schedule Config POST ---
    if (url.pathname === '/api/schedule/config' && req.method === 'POST') {
      const body = await parseBody(req);
      if (body.defaultGridSetpointW !== undefined) {
        const v = Number(body.defaultGridSetpointW);
        if (!Number.isFinite(v)) return json(res, 400, { ok: false, error: 'defaultGridSetpointW invalid' });
        state.schedule.config.defaultGridSetpointW = v;
      }
      if (body.defaultChargeCurrentA !== undefined) {
        const v = Number(body.defaultChargeCurrentA);
        if (!Number.isFinite(v)) return json(res, 400, { ok: false, error: 'defaultChargeCurrentA invalid' });
        state.schedule.config.defaultChargeCurrentA = v;
      }
      if (body.defaultFeedExcessDcPv !== undefined) {
        const v = Number(body.defaultFeedExcessDcPv);
        if (v !== 0 && v !== 1) return json(res, 400, { ok: false, error: 'defaultFeedExcessDcPv must be 0 or 1' });
        state.schedule.config.defaultFeedExcessDcPv = v;
      }
      pushLog('schedule_config_updated', { config: state.schedule.config });
      ctx.persistConfig();
      return json(res, 200, { ok: true, config: state.schedule.config });
    }

    // --- Schedule Automation Config GET ---
    if (url.pathname === '/api/schedule/automation/config' && req.method === 'GET') {
      return json(res, 200, { ok: true, config: getCfg().schedule?.smallMarketAutomation || {} });
    }

    // --- Schedule Automation Config POST ---
    if (url.pathname === '/api/schedule/automation/config' && req.method === 'POST') {
      const body = await parseBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return json(res, 400, { ok: false, error: 'invalid body' });
      }
      const allowedKeys = new Set([
        'enabled', 'searchWindowStart', 'searchWindowEnd', 'targetSlotCount',
        'maxDischargeW', 'batteryCapacityKwh', 'inverterEfficiencyPct',
        'minSocPct', 'aggressivePremiumPct', 'location', 'stages',
        'engine', 'forecastAware'
      ]);
      const filteredBody = Object.fromEntries(
        Object.entries(body).filter(([key]) => allowedKeys.has(key))
      );
      const current = JSON.parse(JSON.stringify(ctx.getRawCfg() || {}));
      current.schedule = current.schedule || {};
      current.schedule.smallMarketAutomation = {
        ...current.schedule.smallMarketAutomation,
        ...filteredBody
      };
      ctx.saveAndApplyConfig(current);
      ctx.regenerateSmallMarketAutomationRules().catch(e => pushLog('sma_regen_error', { error: e.message }));
      return json(res, 200, { ok: true, config: getCfg().schedule.smallMarketAutomation });
    }

    // --- Schedule Automation Replan POST ---
    // Force immediate re-planning. Bypasses the 30-min gap lock but still
    // blocks if a discharge slot is actively executing right now.
    if (url.pathname === '/api/schedule/automation/replan' && req.method === 'POST') {
      try {
        await ctx.regenerateSmallMarketAutomationRules({ force: true });
      } catch (e) {
        pushLog('sma_replan_error', { error: e.message });
        return json(res, 500, { ok: false, error: e.message });
      }
      const sma = state.schedule?.smallMarketAutomation;
      return json(res, 200, {
        ok: true,
        generatedRuleCount: sma?.generatedRuleCount ?? 0,
        availableEnergyKwh: sma?.availableEnergyKwh ?? null,
        lastOutcome: sma?.lastOutcome ?? null,
        plan: sma?.plan ?? null
      });
    }

    // --- Control Write POST ---
    if (url.pathname === '/api/control/write' && req.method === 'POST') {
      const body = await parseBody(req);
      const target = String(body.target || '');
      const VALID_CONTROL_TARGETS = new Set(['gridSetpointW', 'chargeCurrentA', 'feedExcessDcPv', 'minSocPct']);
      if (!VALID_CONTROL_TARGETS.has(target)) return json(res, 400, { ok: false, error: 'invalid target' });
      const value = Number(body.value);
      // Plan 08-04 Task 1 Step 2: numeric bounds before applyControlTarget so an
      // attacker with a stolen token cannot push 1e308 into the ESS write pipeline.
      if (!Number.isFinite(value)) {
        return json(res, 400, { ok: false, error: 'value_not_finite' });
      }
      if (target === 'gridSetpointW' && Math.abs(value) > MAX_GRID_SETPOINT_W) {
        return json(res, 400, { ok: false, error: 'value_out_of_range', max: MAX_GRID_SETPOINT_W });
      }
      if (target === 'minSocPct' && (value < 0 || value > MAX_MINSOC_PCT)) {
        return json(res, 400, { ok: false, error: 'minsoc_out_of_range', max: MAX_MINSOC_PCT });
      }
      // chargeCurrentA: ±1000 A is an order of magnitude above residential inverter spec.
      if (target === 'chargeCurrentA' && Math.abs(value) > 1000) {
        return json(res, 400, { ok: false, error: 'charge_current_out_of_range', max: 1000 });
      }
      // feedExcessDcPv is a boolean flag at the Modbus layer (0/1); anything else is a bug.
      if (target === 'feedExcessDcPv' && value !== 0 && value !== 1) {
        return json(res, 400, { ok: false, error: 'feed_excess_flag_must_be_0_or_1' });
      }
      ctx.assertValidRuntimeCommand('control_write', { target, value });
      state.schedule.manualOverride[target] = { value, at: Date.now() };
      const result = await ctx.applyControlTarget(target, value, 'api_manual_write');
      // Plan 08-09 Task 2: every manual control write produces a durable
      // audit_log entry with full actor attribution AND (best-effort) a row
      // in exec.manual_overrides for the regulator-facing structured log.
      // Both writes happen AFTER applyControlTarget so failed gates (e.g.
      // EEG/§14a legal-gate rejection) are still recorded as attempts.
      const actor = actorContext(req);
      pushLog('control_write', {
        target,
        value,
        result: result.ok ? 'applied' : 'rejected',
        error: result.error || null,
      }, actor);
      if (result.ok && ctx.telemetryStore?.writeManualOverride) {
        // Fire-and-forget — failures are logged inside writeManualOverride and
        // must NEVER turn an applied control write into a 500 to the operator.
        ctx.telemetryStore.writeManualOverride({
          target,
          value_num: Number(value),
          ts_utc: new Date(),
          ...actor,
          reason: 'api_manual_write',
        }).catch((err) => pushLog('manual_override_persist_error', { error: err?.message ?? String(err) }, actor));
      }
      return json(res, result.ok ? 200 : 500, result);
    }

    // --- VPN Endpoints ---
    if (url.pathname === '/api/vpn/status' && req.method === 'GET') {
      if (!ctx.vpnManager) return json(res, 503, { ok: false, error: 'vpn module not available' });
      return json(res, 200, ctx.vpnManager.getStatus());
    }

    if (url.pathname === '/api/vpn/config' && req.method === 'GET') {
      if (!ctx.vpnManager) return json(res, 503, { ok: false, error: 'vpn module not available' });
      const details = await ctx.vpnManager.getConfigDetails();
      return json(res, 200, details);
    }

    if (url.pathname === '/api/vpn/start' && req.method === 'POST') {
      if (!ctx.vpnManager) return json(res, 503, { ok: false, error: 'vpn module not available' });
      // Plan 08-09 Task 2: VPN start/stop/restart are operator-initiated
      // network changes that need a durable audit trail with actor context.
      const actor = actorContext(req);
      try {
        await ctx.vpnManager.start();
        const status = ctx.vpnManager.getStatus();
        pushLog('vpn_started', {
          profile: status?.profileName ?? state.vpn?.profileName ?? null,
          status: status?.status ?? null,
        }, actor);
        return json(res, 200, { ok: true, status: status.status });
      } catch (e) {
        pushLog('vpn_start_error', { error: e.message }, actor);
        return json(res, 500, { ok: false, error: e.message });
      }
    }

    if (url.pathname === '/api/vpn/stop' && req.method === 'POST') {
      if (!ctx.vpnManager) return json(res, 503, { ok: false, error: 'vpn module not available' });
      const actor = actorContext(req);
      try {
        await ctx.vpnManager.stop();
        pushLog('vpn_stopped', {
          profile: ctx.vpnManager.getStatus()?.profileName ?? state.vpn?.profileName ?? null,
        }, actor);
        return json(res, 200, { ok: true });
      } catch (e) {
        pushLog('vpn_stop_error', { error: e.message }, actor);
        return json(res, 500, { ok: false, error: e.message });
      }
    }

    if (url.pathname === '/api/vpn/restart' && req.method === 'POST') {
      if (!ctx.vpnManager) return json(res, 503, { ok: false, error: 'vpn module not available' });
      const actor = actorContext(req);
      try {
        await ctx.vpnManager.restart();
        const status = ctx.vpnManager.getStatus();
        pushLog('vpn_restarted', {
          profile: status?.profileName ?? state.vpn?.profileName ?? null,
          status: status?.status ?? null,
        }, actor);
        return json(res, 200, { ok: true, status: status.status });
      } catch (e) {
        pushLog('vpn_restart_error', { error: e.message }, actor);
        return json(res, 500, { ok: false, error: e.message });
      }
    }

    if (url.pathname === '/api/vpn/history' && req.method === 'GET') {
      const vpnEvents = state.log
        .filter(e => e.event && e.event.startsWith('vpn_'))
        .slice(-50);
      return json(res, 200, vpnEvents);
    }

    if (url.pathname === '/api/vpn/config/upload' && req.method === 'POST') {
      if (!ctx.vpnManager) return json(res, 503, { ok: false, error: 'vpn module not available' });

      const contentType = req.headers['content-type'] || '';

      // Support both multipart and JSON upload
      if (contentType.includes('multipart/form-data')) {
        const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
        if (!boundaryMatch) return json(res, 400, { ok: false, error: 'missing boundary' });

        const rawBody = await readRawBody(req, 2 * 1024 * 1024); // 2MB limit
        const parts = parseMultipartBody(rawBody, boundaryMatch[1]);

        const configPart = parts.find(p =>
          p.name === 'ovpn' || p.name === 'config' ||
          (p.filename && (p.filename.endsWith('.ovpn') || p.filename.endsWith('.conf')))
        );
        if (!configPart) return json(res, 400, { ok: false, error: 'missing config file part (.ovpn or .conf)' });

        const certFiles = {};
        for (const p of parts) {
          if (p.name === 'ca' || (p.filename && p.filename === 'ca.crt')) certFiles.ca = p.data;
          if (p.name === 'cert' || (p.filename && p.filename === 'client.crt')) certFiles.cert = p.data;
          if (p.name === 'key' || (p.filename && p.filename === 'client.key')) certFiles.key = p.data;
          if (p.name === 'ta' || (p.filename && p.filename === 'ta.key')) certFiles.ta = p.data;
          if (p.name === 'secrets' || (p.filename && p.filename === 'ipsec.secrets')) certFiles.secrets = p.data;
        }

        const result = await ctx.vpnManager.importConfig(configPart.data, certFiles);
        return json(res, result.ok ? 200 : 400, result);
      }

      // JSON body: { ovpn/config: "...", ca: "...", cert: "...", key: "...", secrets: "..." }
      const body = await parseBody(req);
      const configContent = body.ovpn || body.config;
      if (!configContent) return json(res, 400, { ok: false, error: 'missing ovpn/config field' });
      const result = await ctx.vpnManager.importConfig(configContent, {
        ca: body.ca || null,
        cert: body.cert || null,
        key: body.key || null,
        ta: body.ta || null,
        secrets: body.secrets || null
      });
      return json(res, result.ok ? 200 : 400, result);
    }

    // ── Phase 05: ML & Edge-AI endpoints ──────────────────────────────

    // GET /api/ml/status — ML model status (auth required, contains config data)
    // Phase 07 FORE-12 D-D2: response body includes `load_forecast: { source, status,
    // consecutive_non_sf_runs, last_updated_at }` so operators can see when the
    // StatsForecast pipeline degrades to SQL rollup / VRM / naive_constant.
    // Source is populated by forecastService.getLoadForecastState() via ml-health.getStatus().
    if (url.pathname === '/api/ml/status' && req.method === 'GET') {
      if (!checkAuth(req, res)) return;
      try {
        const status = ctx.mlService?.getStatus() || {
          tier: 1,
          mlEnabled: false,
          load_forecast: { source: 'unknown', status: 'unknown', consecutive_non_sf_runs: 0, last_updated_at: null }
        };
        return json(res, 200, status);
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    // GET /api/ml/accuracy — ML accuracy trend (auth required)
    if (url.pathname === '/api/ml/accuracy' && req.method === 'GET') {
      if (!checkAuth(req, res)) return;
      try {
        const trend = (await ctx.mlService?.getAccuracyTrend(30)) || [];
        return json(res, 200, trend);
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    // Phase 07 MLAI-08 D-C1 + REVIEWS H10 + H12: async retrain pipeline.
    // POST /api/ml/retrain — dual gate (isLanSafeRequest + checkAuth), then
    //   1. REVIEWS H10 14-day precondition check — 409 on insufficient data,
    //      BEFORE spawning a job so operators see the reason immediately
    //   2. REVIEWS H12 async — ctx.mlRetrainJobs.startJob wraps
    //      mlService.runRetrainEndpoint; return 202 with {jobId, statusUrl}
    //      so the handler releases the HTTP socket immediately
    if (url.pathname === '/api/ml/retrain' && req.method === 'POST') {
      if (!isLanSafeRequest(req) || !checkAuth(req, res)) return;
      try {
        if (!ctx.mlService || !ctx.mlRetrainJobs) {
          return json(res, 503, { error: 'ml_retrain_service_unavailable' });
        }
        // Plan 08-04 Task 2 Step 2: concurrency mutex pre-check. Without this
        // a second POST during an active retrain would fork a second Python
        // training process on the Pi — OOM + CPU starvation. Fast-fail 409
        // before the 14-day gate so operators see the real reason.
        const mutex = ctx.mlRetrainJobs.isRetrainInProgress?.() || { inProgress: false };
        if (mutex.inProgress) {
          return json(res, 409, {
            error: 'retrain_in_progress',
            jobId: mutex.jobId,
            elapsedMs: mutex.elapsedMs,
            statusUrl: mutex.jobId ? `/api/ml/retrain/status/${mutex.jobId}` : null,
          });
        }
        // REVIEWS H10: 14-day precondition check — 409 fast-fail
        const gate = await ctx.mlService.has14DaysOfAccuracyData?.();
        if (gate && !gate.ok) {
          return json(res, 409, {
            error: 'insufficient_accuracy_data',
            message: 'Need ≥14 days of rolling MAE data before retrain',
            daysAvailable: gate.daysAvailable ?? 0,
          });
        }

        // REVIEWS H12: async — return 202 immediately.
        // Plan 08-04 Task 2: startJob now returns null if the mutex was grabbed
        // between our pre-check and now (race window with a concurrent request).
        const jobId = ctx.mlRetrainJobs.startJob(() => ctx.mlService.runRetrainEndpoint());
        if (!jobId) {
          return json(res, 409, { error: 'retrain_in_progress' });
        }
        return json(res, 202, {
          jobId,
          statusUrl: `/api/ml/retrain/status/${jobId}`,
        });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    // Phase 07 MLAI-08 REVIEWS H12: job status endpoint.
    // GET /api/ml/retrain/status/:jobId — returns current state.
    if (url.pathname.startsWith('/api/ml/retrain/status/') && req.method === 'GET') {
      if (!checkAuth(req, res)) return;
      try {
        const jobId = url.pathname.substring('/api/ml/retrain/status/'.length);
        if (!jobId) return json(res, 400, { error: 'jobId required' });
        const status = ctx.mlRetrainJobs?.getStatus(jobId);
        if (!status) return json(res, 404, { error: 'job not found', jobId });
        return json(res, 200, { jobId, ...status });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    // Phase 07 FORE-10 / D-A5 (re-scoped): pvnode client-side quota counter exposure.
    // GET /api/forecast/pvnode/quota — read-only, auth-gated.
    if (url.pathname === '/api/forecast/pvnode/quota' && req.method === 'GET') {
      if (!checkAuth(req, res)) return;
      try {
        const q = await ctx.pvnodeQuota?.getUsed();
        return json(res, 200, q || { used: 0, limit: 1000, remaining: 1000, month_utc: null });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    // Phase 07 FORE-10 / D-A3: admin-triggered 6-month pvnode /v1/history backfill.
    // POST /api/admin/backfill — dual gate (isLanSafeRequest + checkAuth) + V5 input
    // validation (ISO YYYY-MM-DD, from <= to inclusive per REVIEWS H8) + 409 on concurrent
    // run. Fire-and-forget; progress polled via /api/admin/backfill/status.
    if (url.pathname === '/api/admin/backfill' && req.method === 'POST') {
      if (!isLanSafeRequest(req) || !checkAuth(req, res)) return;
      try {
        if (!ctx.pvnodeBackfill) {
          return json(res, 503, { error: 'pvnode_backfill_service_unavailable' });
        }
        let body = {};
        try {
          const raw = await readRawBody(req, 4096);
          if (raw) body = JSON.parse(raw);
        } catch {
          return json(res, 400, { error: 'invalid_json_body' });
        }
        const { from, to } = body || {};

        // V5 input validation — strict ISO date YYYY-MM-DD
        const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
        if (!isoDatePattern.test(from) || !isoDatePattern.test(to)) {
          return json(res, 400, { error: 'from and to must be YYYY-MM-DD' });
        }
        // REVIEWS H8: chunk bounds are inclusive-inclusive, so from == to is a valid
        // 1-day backfill. Only reject when from is strictly greater than to.
        if (from > to) {
          return json(res, 400, { error: 'from must be <= to' });
        }

        const currentStatus = ctx.pvnodeBackfill?.getStatus();
        if (currentStatus?.state === 'running') {
          return json(res, 409, { error: 'backfill_already_running', status: currentStatus });
        }

        // Fire-and-forget; status polled via GET /api/admin/backfill/status
        ctx.pvnodeBackfill.run({ from, to })
          .catch(err => pushLog?.('pvnode_backfill_error_uncaught', { error: err?.message || String(err) }));

        return json(res, 202, { status: 'started', from, to });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    // Phase 07 FORE-10 / D-A3: backfill progress status.
    // GET /api/admin/backfill/status — auth-gated (non-mutating).
    if (url.pathname === '/api/admin/backfill/status' && req.method === 'GET') {
      if (!checkAuth(req, res)) return;
      try {
        const status = ctx.pvnodeBackfill?.getStatus() || { state: 'unavailable' };
        return json(res, 200, status);
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    // GET /api/messages — latest LLM messages (LAN-safe for family tablet)
    if (url.pathname === '/api/messages' && req.method === 'GET') {
      if (!checkAuth(req, res)) return;
      try {
        const messages = ctx.llmService?.getMessages()?.slice(0, 5) || [];
        return json(res, 200, { messages });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    // GET /api/messages/history — full 24h message history (LAN-safe)
    if (url.pathname === '/api/messages/history' && req.method === 'GET') {
      if (!checkAuth(req, res)) return;
      try {
        const messages = ctx.llmService?.getMessages() || [];
        return json(res, 200, { messages });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    // POST /api/messages/generate — manually trigger LLM message generation (auth required)
    // Optional body: { type?: 'status'|'savings'|'alert'|..., data?: object }
    if (url.pathname === '/api/messages/generate' && req.method === 'POST') {
      if (!checkAuth(req, res)) return;
      if (!ctx.llmService) return json(res, 503, { error: 'LLM service not available' });
      try {
        // Parse optional body (4 KB cap — Plan 08-04 Step 5 MAX_MESSAGE_DATA_BYTES).
        let body = {};
        try {
          const raw = await readRawBody(req, MAX_MESSAGE_DATA_BYTES);
          if (raw) body = JSON.parse(raw);
        } catch { /* ignore body parse errors */ }

        // Plan 08-04 Task 1 Step 5: prompt-injection guard. Walk body.data and
        // reject any string matching the injection patterns BEFORE it reaches
        // the LLM. This is a coarse first-pass filter — deeper LLM-defence is
        // the LLM service's concern, not a route handler — but it blocks the
        // obvious attacker payloads (`ignore all previous instructions`,
        // ChatML/Llama/Mistral template tags, `jailbreak` phrasing).
        const injection = scanForInjection(body?.data);
        if (injection) {
          pushLog('prompt_injection_rejected', { path: injection.path });
          return json(res, 400, { ok: false, error: 'prompt_injection_detected', path: injection.path });
        }

        // Default: build status message from current state
        const type = body.type || 'status';
        const v = state?.victron || {};
        const defaultData = {
          pvW: v.pvTotalW ?? null,
          soc: v.soc ?? null,
          gridW: state?.meter?.grid_total_w ?? null
        };
        const data = { ...defaultData, ...(body.data || {}) };

        const msg = await ctx.llmService.generateMessage(type, data);
        return json(res, 200, { ok: true, message: msg });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    // GET /api/llm/models -- Ollama model list for settings UI dropdown (LLM-01)
    // T-06-07: Gated by checkAuth. T-06-08: 10s timeout, empty array on error.
    if (url.pathname === '/api/llm/models' && req.method === 'GET') {
      if (!checkAuth(req, res)) return;
      if (!ctx.llmService?.listModels) {
        return json(res, 503, { ok: false, error: 'LLM service not available' });
      }
      try {
        const models = await ctx.llmService.listModels();
        return json(res, 200, { ok: true, models });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    }

    // Unmatched route -- return false so orchestrator can fall through to static files
    return false;
  }

  // Expose response builders to orchestrator for buildCurrentStatusPayload
  // (ctx is mutable -- orchestrator reads these after createApiRoutes returns)
  ctx.costSummary = costSummary;
  ctx.userEnergyPricingSummary = userEnergyPricingSummary;

  return { handleRequest, serveStatic };
}
