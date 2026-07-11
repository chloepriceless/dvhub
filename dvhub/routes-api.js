// routes-api.js -- HTTP route handlers for ALL API endpoints.
// Extracted from server.js (Phase 5, Plans 01+02).
// Factory pattern: createApiRoutes(ctx) returns { handleRequest }.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseBody, fmtTs, resolveLogLimit, s16, roundCtKwh, gridDirection, controlWriteBoundsError, MAX_GRID_SETPOINT_W, MAX_MINSOC_PCT, MAX_BATTERY_DISCHARGE_W } from './server-utils.js';
import { effectiveBatteryCostCtKwh, mixedCostCtKwh, slotComparison, configuredModule3Windows } from './user-energy-pricing.js';
import { isSmallMarketAutomationRule } from './market-automation-builder.js';
import { isForecastOptimizerRule } from './services/optimizer/schedule-builder.js';
import { getEegNegativePriceRule } from './eeg-rules.js';
import { haDiscoveryEntityCount } from './services/mqtt/ha-discovery.js';
import { vollastViertelstunden, extensionFromVollast, countNegativeQuarterSlots } from './eeg-extension.js';
import { buildVictronAlarmsPayload } from './victron-alarms.js';
import { buildWorkerBackedStatusResponse, buildHistoryImportStatusResponse, capVictronPvForDisplay } from './runtime-state.js';
import { buildOptimizerRunPayload } from './telemetry-runtime.js';
import { REDACTED_PATHS, REDACTED, redactConfig, redactUrlCreds } from './config-redaction.js';
import { encryptSecrets, decryptSecrets, applySecrets } from './services/config-secrets-crypto.js';
import { buildSupportBundle, supportBundleFilename } from './services/support-bundle.js';
import { createDefaultConfig } from './config-model.js';
import { streamPgDump, runDbRestore } from './services/db-backup.js';
import { readTimescaleStatus, runTimescaleExtUpgrade } from './services/timescale-maintenance.js';
// Plan 09-06 (D-06): prom-client is the SINGLE QUAL-03 exception for Phase 9.
// Battle-tested Prometheus client (~30KB minified) — preferred over hand-rolling
// the exposition format. No other Phase 9 plan adds dependencies.
import promClient from 'prom-client';
// Plan 09.2-06 (D-12): pg-cursor for the streaming /api/history/raw/export.csv
// endpoint. NOTE: `pg.Cursor` does NOT exist on the default `pg` export — the
// canonical pattern (per node-postgres docs) is to install `pg-cursor` as a
// peer package and import it directly. This is a single-purpose, ~3 KB add
// maintained by the pg team itself; the QUAL-03 "no new npm deps" guideline
// admits an exception here because the alternatives (a) buffer the entire
// result set in memory, defeating T-09.2-DOS-MEM, or (b) re-implement keyset
// pagination with multiple round-trips, hurting throughput.
import Cursor from 'pg-cursor';
// Plan 09.2-08 (D-13/D-24 revised): @dsnp/parquetjs is the pure-JS Parquet
// writer for the streaming /api/history/raw/export.parquet endpoint. The
// originally-planned `apache-arrow` JS package does NOT support Parquet write
// (RESEARCH O-1 — Arrow JS only writes IPC/Feather, not Parquet). @dsnp/parquetjs
// is a maintained fork (LibertyDSNP) of the original parquetjs, has no native
// dependencies, and works on every platform Node runs on (verified on dev x86_64
// + prod x86_64 LXC). The QUAL-03 "no new npm deps" guideline admits an
// exception here for the same reason as pg-cursor (Plan 09.2-06): the
// alternatives are either (a) hand-rolling the Parquet binary format, or
// (b) buffering full result sets and shipping CSV/JSON instead — both worse.
import parquet from '@dsnp/parquetjs';

// Plan 09.2-08 (D-13/D-24 revised): single module-scope schema instance for the
// streaming Parquet export. Schema is locked to four columns: ts_utc UTF8,
// series_key UTF8, value DOUBLE optional, unit UTF8 optional. Future column
// additions need a schema bump + version-aware reader; readers must tolerate
// missing optional columns (e.g. `unit`).
const PARQUET_SCHEMA = new parquet.ParquetSchema({
  ts_utc:     { type: 'UTF8' },
  series_key: { type: 'UTF8' },
  value:      { type: 'DOUBLE', optional: true },
  unit:       { type: 'UTF8', optional: true },
});

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
    const fail = (err) => { if (failed) return; failed = true; try { ws.destroy(); } catch {} try { req.destroy(); } catch {} reject(err); };
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

// Phase 09.2 D-12 — minimal CSV-cell escape. Quotes the cell when it contains
// the separator (`;`), a double-quote, or a newline; embedded quotes are
// doubled per RFC 4180. Numerics are formatted via Number().toFixed() at the
// call-site to bypass locale-dependent toString quirks. Module-scope so future
// streaming exporters (parquet preview, devtools dumps) can reuse it.
export function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[;"\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

const execFileAsync = promisify(execFile);

// ── Plan 09-06: Prometheus metrics (D-06 + D-07) ─────────────────────────
// Centralized registry. Default registry collects process metrics (CPU, RSS,
// event loop lag, heap) — required for Pi-tier signal. Prefix dvhub_node_ keeps
// the default series distinct from the application-level dvhub_* series below.
const metricsRegistry = new promClient.Registry();
promClient.collectDefaultMetrics({ register: metricsRegistry, prefix: 'dvhub_node_' });

// Application instruments. Cardinality budget per CONTEXT.md must_haves:
// ≤50 route labels (enforced by ROUTE_LABEL_PATTERNS below), ≤8 methods,
// ≤15 status codes — total ≤ ~6000 distinct series. Pi-acceptable.
export const httpRequestsTotal = new promClient.Counter({
  name: 'dvhub_http_requests_total',
  help: 'Total HTTP requests, partitioned by method, route, status',
  labelNames: ['method', 'route', 'status'],
  registers: [metricsRegistry]
});

export const httpRequestDurationSeconds = new promClient.Histogram({
  name: 'dvhub_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route'],
  // Locked buckets per plan must_haves — Pi Tier 1 friendly.
  buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [metricsRegistry]
});

export const meterPollDurationSeconds = new promClient.Gauge({
  name: 'dvhub_meter_poll_duration_seconds',
  help: 'Duration of the last successful meter poll',
  registers: [metricsRegistry]
});

export const meterPollErrorsTotal = new promClient.Counter({
  name: 'dvhub_meter_poll_errors_total',
  help: 'Total meter poll errors',
  registers: [metricsRegistry]
});

export const optimizerRunsTotal = new promClient.Counter({
  name: 'dvhub_optimizer_runs_total',
  help: 'Total optimizer runs by result',
  labelNames: ['result'],
  registers: [metricsRegistry]
});

export const forecastAgeSeconds = new promClient.Gauge({
  name: 'dvhub_forecast_age_seconds',
  help: 'Age of the most recent forecast in seconds, by model',
  labelNames: ['model'],
  registers: [metricsRegistry]
});

export const auditLogEntriesTotal = new promClient.Counter({
  name: 'dvhub_audit_log_entries_total',
  help: 'Total audit_log entries written, by event_type (bounded allowlist)',
  labelNames: ['event_type'],
  registers: [metricsRegistry]
});

// Plan 09-06: Allowlist of event_type values that get a dedicated counter
// label. Anything outside the allowlist still hits the ring buffer + audit_log
// — it just doesn't expand the metrics cardinality. Keeps total label count
// bounded (~12 event types × counter = predictable Pi memory footprint).
const AUDIT_LOG_EVENT_ALLOWLIST = new Set([
  'token_rotated', 'token_revoked', 'config_exported',
  'config_persist_error', 'history_import_started', 'history_import_finished',
  'backfill_started', 'backfill_finished', 'vpn_config_uploaded',
  'widget_error', 'uncaught_exception', 'unhandled_rejection'
]);

// Plan 09-06: route label normalization for metrics. Keeps http_requests_total
// cardinality bounded (target ~50 distinct route labels for the whole API
// surface). Maps dynamic-id paths to canonical patterns; falls through to the
// literal pathname for static routes. Add patterns when a new dynamic-id
// route is added.
const ROUTE_LABEL_PATTERNS = [
  [/^\/api\/devices\/[^/]+$/, '/api/devices/:id'],
  [/^\/api\/forecast\/[^/]+$/, '/api/forecast/:id'],
  [/^\/api\/control\/events\/[^/]+$/, '/api/control/events/:id'],
  [/^\/api\/optimizer\/runs\/[^/]+$/, '/api/optimizer/runs/:id'],
];

export function matchRouteLabel(pathname) {
  for (const [re, label] of ROUTE_LABEL_PATTERNS) {
    if (re.test(pathname)) return label;
  }
  return pathname; // static routes — already low cardinality
}

// Helper for instrument call sites that want to gate by allowlist.
export function isAllowedAuditMetricEvent(eventType) {
  return AUDIT_LOG_EVENT_ALLOWLIST.has(eventType);
}

// Re-export the registry for tests that want to render or reset metrics.
export { metricsRegistry };

// Plan 08-05 Task 2: HSTS + tightened CSP.
//   - Strict-Transport-Security: 1 year, includeSubDomains (preload deferred).
//   - script-src: pinned to the swagger-ui-dist@5.11.0 path
//     (no more wildcard unpkg / jsdelivr reach). Leaflet is vendored
//     same-origin under /vendor/leaflet/ (served by 'self', Plan 29-02).
//   - style-src unsafe-inline token removed in Plan 09.1-07 Task 3 (wave 6).
//     All inline style= attrs were stripped from HTML in Plan 08-11; all
//     innerHTML/cssText-injected inline styles in JS were refactored to
//     className-based or .style.property setters in 09.1-07 commits
//     16f321c..0564118 (~42 sites across 7 JS files + api-docs.html).
//   - frame-ancestors 'none', base-uri 'self', form-action 'self',
//     object-src 'none' close CSP-level framing/form/plugin vectors.
//
// Plan 09-09: defence-in-depth header polish.
//
// Cookie policy contract: dvhub does not currently set Set-Cookie. If any future
// endpoint introduces cookies, the cookie MUST include HttpOnly; Secure; SameSite=Strict
// to match the LAN-trust threat model. Search for `Set-Cookie` before adding new
// auth/session paths and ensure these flags are present.
export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  // Plan 09-09: disable sensor APIs the HEMS never uses. accelerometer/gyroscope/
  // magnetometer cover phone-mounted family-tablet defence; camera/microphone/
  // geolocation/payment/usb cover the broader OWASP-Top-10-2025 sensor-API class.
  'Permissions-Policy': 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
  // Plan 09-09: window.opener isolation. Same-origin only — operator-initiated
  // popouts work, cross-origin tabs cannot reach back into dvhub windows.
  'Cross-Origin-Opener-Policy': 'same-origin',
  // Plan 09-09: block cross-origin embedding of dvhub static assets.
  // (Cross-Origin-Embedder-Policy intentionally NOT added — would break the Leaflet
  // tile fetch and Swagger UI which both pull from CDNs that don't ship CORP headers.)
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': [
    "default-src 'self'",
    // script-src: pinned CDN paths ONLY. swagger-ui-dist@5.11.0 for /api-docs.html.
    // (Leaflet is vendored same-origin under /vendor/leaflet/ — covered by 'self', Plan 29-02.)
    "script-src 'self' https://unpkg.com/swagger-ui-dist@5.11.0/",
    // Plan 09.1-07 Task 3: unsafe-inline token removed after Aurora port stripped
    // all inline style= attrs in HTML (Plan 08-11 phase) AND innerHTML/cssText
    // sites in JS were refactored to className + .style.property setters
    // (Plan 09.1-07 wave 6 commits 16f321c..0564118). Aurora design ships
    // per-page CSS files (dvhub-app.css + family.css + history.css + ...)
    // and one external api-docs.css — all linked, none inline.
    "style-src 'self' https://unpkg.com/swagger-ui-dist@5.11.0/ https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob: https://dvhub.de https://*.tile.openstreetmap.org",
    "connect-src 'self' https://dvhub.online",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'"
  ].join('; ')
};

// ── Plan 08-04 / T-0080: control-write sanity bounds ────────────────────
// Moved to server-utils.js (single source of truth) so the applyControlTarget
// chokepoint shares them — EOS/EMHASS/evcc call the chokepoint directly and
// previously bypassed the route's bounds. Imported above for the route's own
// minSoc check; re-exported here for backward-compat with any importer/test.
export { MAX_GRID_SETPOINT_W, MAX_MINSOC_PCT, MAX_BATTERY_DISCHARGE_W };
// /api/telemetry/series cap — (endMs-startMs)/stepMs * seriesCount must stay below this
// to protect the Pi from range-explosion DoS queries. Raised from 50k to 1.5M so
// granular Explorer queries up to 5s × ~17d × 5 keys (or 10s × 30d × 5 keys)
// complete in one round-trip. Larger ranges fall back to chunked day-by-day
// fetches on the client (CSV export path) which never exceed this per request.
// TimescaleDB hypertable + (series_key, ts_utc) index makes 1.5M-row scans
// sub-second on the production Pi.
export const MAX_TELEMETRY_SCAN_SLOTS = 1_500_000;
// M-3 (Plan 16-03): /api/devices/:id history row cap. 288 = 24h of 5-min
// readings (24 * 60 / 5). Named so the magic number is self-documenting.
export const DEVICE_HISTORY_ROW_LIMIT = 288;
// Pro-Gating (Christin 2026-07-07): die Historie-Zeiträume Woche/Monat/Jahr/Alle
// sind ein Pro-Feature ('history-multiperiod'); nur die Tagesansicht (view=day
// oder fehlend) ist frei. Gilt für /api/history/summary, /api/history/viz/* und
// /api/history/export, sobald ?view= einen dieser Werte trägt.
const HISTORY_PREMIUM_VIEWS = new Set(['week', 'month', 'year', 'all']);
// ── Plan 09-01 (D-03 / D-04): token strength + audit fingerprint ────────
// Locked decisions:
//   D-03: minimum 32 chars AND Shannon entropy ≥ 3.5 bits/char (matches the
//         64-hex-char strength that `rotate` generates via crypto.randomBytes(32)).
//   D-04: audit fingerprint = first 16 hex chars of sha256(token).
//   D-05: apiToken stays OPTIONAL. validateApiTokenStrength MUST only be invoked
//         when a non-empty token is supplied — POST /api/config enforces the
//         optional-empty contract at the call site (see body.apiToken.length > 0
//         guard).
//
// 32 chars at hex = 128 bits — matches what `rotate` generates
// (randomBytes(32).toString('hex') = 64 chars, ~256 bits entropy).
// Shannon entropy floor 3.5 bits/char rejects "aaaaaaaaa..." while accepting
// any random hex/base64 string. Fingerprint = first 16 hex chars of sha256(token)
// (distinct from VPN-config 16-hex pattern from 08-02 — same convention).
export const MIN_API_TOKEN_LENGTH = 32;
export const MIN_API_TOKEN_ENTROPY_BITS_PER_CHAR = 3.5;
export const TOKEN_FINGERPRINT_HEX_CHARS = 16;

export function tokenFingerprint(token) {
  if (!token || typeof token !== 'string') return null;
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, TOKEN_FINGERPRINT_HEX_CHARS);
}

export function shannonEntropyBitsPerChar(s) {
  if (!s || typeof s !== 'string') return 0;
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) || 0) + 1);
  const len = s.length;
  let h = 0;
  for (const c of counts.values()) {
    const p = c / len;
    h -= p * Math.log2(p);
  }
  return h;
}

// Plan 09-01 (D-03 + D-05): validate ONLY when a non-empty token is supplied.
// Empty string / undefined → caller must NOT invoke this. The optional-token
// contract is enforced at the call site (POST /api/config).
export function validateApiTokenStrength(token) {
  if (typeof token !== 'string') return { ok: false, error: 'token_not_string' };
  if (token.length < MIN_API_TOKEN_LENGTH) return { ok: false, error: 'token_too_short' };
  if (shannonEntropyBitsPerChar(token) < MIN_API_TOKEN_ENTROPY_BITS_PER_CHAR) {
    return { ok: false, error: 'token_low_entropy' };
  }
  return { ok: true };
}

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

// Plan 09-03: derive the client IP from a request. When cfg.trustProxy is
// true AND the immediate socket peer is one of cfg.trustedProxyIps,
// the rightmost X-Forwarded-For hop is the real client. Otherwise we
// strictly use the socket address — never trust XFF without explicit opt-in.
//
// Why "rightmost untrusted": XFF accumulates left-to-right (`client, proxy1, proxy2`).
// If `cfg.trustedProxyIps` lists `proxy2` only, we pop trusted hops from the right
// until we hit an untrusted one — that's the real client. This matches the trusted-proxy
// model used by Express, Spring, and Rails when configured with proxy chain length.
//
// Both isLocalNetworkRequest (LAN auth bypass) and getRateLimitKey consume this
// helper so auth and rate-limit can never disagree on who the client is.
let trustProxyMisconfigWarned = false;
export function deriveClientIp(req, cfg) {
  const raw = (req.socket?.remoteAddress || req.connection?.remoteAddress || '').replace(/^::ffff:/, '');
  if (!cfg || cfg.trustProxy !== true) return raw;
  const trustedSet = new Set(Array.isArray(cfg.trustedProxyIps) ? cfg.trustedProxyIps : []);
  if (trustedSet.size === 0) {
    if (!trustProxyMisconfigWarned) {
      // eslint-disable-next-line no-console
      console.warn('[deriveClientIp] cfg.trustProxy=true but cfg.trustedProxyIps is empty — falling back to socket address. Set trustedProxyIps to a list of reverse-proxy IPs.');
      trustProxyMisconfigWarned = true;
    }
    return raw;
  }
  if (!trustedSet.has(raw)) return raw; // direct connection from untrusted source — XFF ignored
  const xff = String(req.headers?.['x-forwarded-for'] || '').trim();
  if (!xff) return raw;
  // Right-to-left scan: pop trusted hops until we find the real client
  const hops = xff.split(',').map((h) => h.trim().replace(/^::ffff:/, '')).filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    if (!trustedSet.has(hops[i])) return hops[i];
  }
  // Every hop is in the trusted set — return the leftmost (closest to "client")
  return hops[0] || raw;
}

// Test-only: reset the one-time warning latch so the misconfigured-trust test
// can assert the warning fires. Not part of the public contract.
export function _resetTrustProxyWarnForTesting() {
  trustProxyMisconfigWarned = false;
}

// ── Go-Live-Review 2026-06-10: LAN-trust CIDR matching ──────────────────
// Pure + exported so the security.lanCidrs decision is unit-testable without a
// live socket. IPv4 is matched bit-exact against a.b.c.d/n. IPv6 is matched by
// normalised-prefix (best-effort: full-address match, or /n on a 16-bit hextet
// boundary). Anything unparseable → false (fail-closed: a bad CIDR never widens
// trust). An empty/absent CIDR list is handled by the CALLER (means "use the
// built-in RFC1918 default"), not here.
function ipv4ToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const o = Number(p);
    if (!Number.isInteger(o) || o < 0 || o > 255) return null;
    n = (n * 256) + o;
  }
  return n >>> 0;
}
export function ipMatchesCidr(ip, cidr) {
  const raw = String(ip || '').replace(/^::ffff:/, '');
  const str = String(cidr || '').trim();
  if (!raw || !str) return false;
  const slash = str.indexOf('/');
  const net = slash >= 0 ? str.slice(0, slash) : str;
  const bitsRaw = slash >= 0 ? Number(str.slice(slash + 1)) : null;

  // IPv4 path
  if (raw.indexOf(':') === -1 && net.indexOf(':') === -1) {
    const ipInt = ipv4ToInt(raw);
    const netInt = ipv4ToInt(net);
    if (ipInt === null || netInt === null) return false;
    const bits = bitsRaw === null ? 32 : bitsRaw;
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    if (bits === 0) return true;
    const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
    return (ipInt & mask) === (netInt & mask);
  }

  // IPv6 best-effort: exact match, or hextet-boundary prefix match.
  const norm = (s) => String(s).toLowerCase().replace(/^::ffff:/, '');
  const a = norm(raw);
  const b = norm(net);
  if (bitsRaw === null) return a === b;
  if (!Number.isInteger(bitsRaw) || bitsRaw < 0 || bitsRaw > 128) return false;
  if (bitsRaw % 16 !== 0) return a === b; // sub-hextet IPv6 masks unsupported → exact-only
  const hextets = bitsRaw / 16;
  const aPref = a.split(':').slice(0, hextets).join(':');
  const bPref = b.split(':').slice(0, hextets).join(':');
  return aPref !== '' && aPref === bPref;
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

// T-0100: universal downgrade guard for the self-update path. Throws on a
// downgrade OR an undeterminable target version (fail-safe — never check out
// blindly), unless allowDowngrade is set. The pre-existing guard only covered an
// explicit stable `targetVersion`; the dev-channel origin/main checkout and the
// stable auto-latest-tag selection had none, so a stale release anchor (origin/main
// far behind the deployed code, or only ancient tags) would silently downgrade a
// site on update. Pure + exported so the decision is unit-testable without git.
export function assertNoDowngrade(targetVersion, currentVersion, { allowDowngrade = false, label = 'target' } = {}) {
  if (allowDowngrade) return;
  if (!targetVersion || !SEMVER_TAG.test(String(targetVersion))) {
    const e = new Error(`update_aborted: could not determine ${label} version`);
    e.code = 'version_undeterminable';
    throw e;
  }
  if (compareSemverTag(String(targetVersion), String(currentVersion || '0.0.0')) < 0) {
    const e = new Error(`downgrade_blocked: ${label} ${targetVersion} < installed ${currentVersion}`);
    e.code = 'downgrade_blocked';
    throw e;
  }
}

// Derive allowed POST /api/config root keys from the canonical default config
// PLUS the well-known live-config sections that are seeded by migrations
// (vpn, https*, tls*, notifications, mqtt, forecast, family, devices, etc.).
// Deep-path validation is plan 08-06's scope — this plan only covers
// root-level strictness so an attacker cannot sneak in `__proto__`-ish keys
// or bogus sections that get persisted and later consumed by unvalidated code.
// /api/admin/update/apply body.version allowlist — blocks shell-metachar payloads
// and random attacker-controlled git refs. Accepts plain semver `1.2.3`, `v1.2.3`,
// with optional pre-release / build metadata suffix (`-rc.1`, `+build.42`).
export const SEMVER_TAG = /^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?$/;

// T-COMMIT-PIN: /api/admin/update/apply body.ref allowlist — a gezielt-pinned
// dev-channel commit for beta testers ("install exactly THIS bleeding-edge
// commit"). Strict hex-SHA only (7–40 chars): blocks shell metachars AND git
// arg-injection (a ref starting with `-` could be read as a flag like
// `--upload-pack`). Reachability (`merge-base --is-ancestor … origin/main`) is
// enforced separately at checkout time — same anchor as install.sh --ref — so a
// foreign/orphaned commit can never be checked out even if it is a valid SHA.
export const GIT_SHA_REF = /^[0-9a-f]{7,40}$/i;

// W5.1 (Phase 28-01): shared, defensive self-update tag selector. Callers keep
// fetching the tag list via `git tag --sort=-v:refname` (so the list is already
// ranked highest-first); this pure helper just picks the FIRST line that is a real
// semver RELEASE tag — reusing the canonical SEMVER_TAG guard above — so a stray
// non-semver tag (a CI build tag, a bare numeric ref, `main`, …) can never be the
// selected checkout target. Returns null for an empty / all-junk list (callers
// already handle the no-tag case: `if (!selectedTag) throw …` / install.sh else).
// Pure + exported so the decision is unit-testable without git (see test/tag-select.test.js).
export function selectLatestSemverTag(tagListString) {
  return String(tagListString || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .find((t) => SEMVER_TAG.test(t)) || null;
}

// T-UPDATE-ANCHOR (2026-07-03): release-tag candidates for the self-update path
// must be REACHABLE from the release branch (`git tag --merged origin/main`).
// The public repo carries orphaned tags from the pre-cleanup history
// (v0.3.9…v0.4.2 — NOT ancestors of the cleaned main); live observed 2026-07-03:
// the unfiltered `git tag --sort=-v:refname` ranked v0.4.2 first, so a fresh
// stable install landed on months-old code AND update/check reported
// updateAvailable:false (stranded). Falls back to the unfiltered list only when
// origin/main cannot be resolved (nonstandard clone) — better a stale anchor
// than a hard error; the assertNoDowngrade guard still blocks a downgrade.
// Exported for the git-fixture test (test/tag-select.test.js).
export async function listReachableReleaseTags(repoRoot, execFileAsyncImpl = execFileAsync) {
  try {
    return (await execFileAsyncImpl('git', ['tag', '--merged', 'origin/main', '--sort=-v:refname'], { cwd: repoRoot, timeout: 5000 })).stdout;
  } catch {
    try {
      return (await execFileAsyncImpl('git', ['tag', '--sort=-v:refname'], { cwd: repoRoot, timeout: 5000 })).stdout;
    } catch {
      return '';
    }
  }
}
// Rate-limit Map eviction ceiling. Before this was unbounded, so IPv6-rotation
// attackers could pin Node heap. Key normalisation (v4 verbatim, v6 /64 prefix)
// further collapses per-address fan-out.
export const RATE_LIMIT_MAX_KEYS = 5000;

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
  // Plan 09-03: reverse-proxy IP allowlist consulted by deriveClientIp when
  // trustProxy=true. Without an entry here, POST /api/config rejects the field.
  'trustedProxyIps',
  // Plan 09-01 (D-01): optional token-session TTL knob. Default null (no
  // automatic expiry — LAN-trust appliance model). Reserved for a later
  // user/account phase; no Phase 9 code consumes the value but the field
  // must round-trip through POST /api/config without being stripped.
  'apiTokenSessionTtlMs',
  // Migration metadata + legacy integration roots that live in existing config.json
  // and are echoed back unchanged when the settings UI saves; without these,
  // the strict-root check rejects a normal save with `unknown_config_paths`.
  'configSchemaVersion',
  'influx',
  // T-0113: Support-Tunnel provisioning persists a `support` block
  // ({ localUser, tunnel }) into config.json. The settings UI GETs the whole
  // config and POSTs it back verbatim, so without `support` here EVERY settings
  // save on a provisioned appliance is rejected with unknown_config_paths.
  'support',
  // LLM stack removed 2026-06-13 — existing config.json files still carry the
  // `llm` block and the settings UI round-trips the whole config, so the root
  // must stay allowlisted (legacy echo) or every save is rejected.
  'llm'
]));

// Meter/inverter manufacturer profiles (2026-06-13). The available manufacturers
// are simply the *.json files in the hersteller/ folder next to config.json —
// the filename (minus .json) is the manufacturer id (operator request: read the
// folder, don't hardcode the list). New makers are added by dropping a profile
// file. D-27: a profile may carry a top-level "label" (display name, e.g.
// "Universal (MQTT-Bridge)" in bridge-mqtt.json) — applyManufacturerProfile
// copies only the known config blocks, so the label never leaks into the
// effective config. Returns [{ value, label }]; falls back to Victron-only if
// the folder can't be read so the dropdown is never empty.
export function listManufacturerProfiles(ctx) {
  let list = [];
  try {
    const dir = path.join(path.dirname(ctx.getConfigPath?.() || ''), 'hersteller');
    list = fs.readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.json'))
      .map((f) => {
        const id = f.replace(/\.json$/i, '');
        if (!id) return null;
        let label = id.charAt(0).toUpperCase() + id.slice(1);
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          if (typeof parsed?.label === 'string' && parsed.label.trim()) {
            label = parsed.label.trim().slice(0, 64);
          }
        } catch { /* unlesbares Profil → Dateiname-Fallback als Label */ }
        return { value: id, label };
      })
      .filter(Boolean);
  } catch { list = []; }
  if (!list.some((x) => x.value === 'victron')) list.unshift({ value: 'victron', label: 'Victron' });
  return list;
}

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
  const { state, getCfg, pushLog, telemetrySafeWrite, licenseService } = ctx;

  // §51a lifetime extension (T-0004): the since-commissioning price scan is
  // a full-history query — cache it; negative-price slots only accrue every
  // 15 min anyway.
  const EEG_EXTENSION_CACHE_MS = 15 * 60 * 1000;
  const eegExtensionCache = { payload: null, at: 0 };

  // ── Admin health payload builder ────────────────────────────────────
  // Plan 09-06 Task 3: every checks[] entry carries additive
  // latencyMs / lastSuccessAt / lastErrorAt fields alongside the existing
  // id / label / ok / detail (QUAL-02 — purely additive, no rename or removal).
  async function adminHealthPayload() {
    // Plan 09-06: helper to compute ISO timestamp from a millisecond epoch.
    // Returns null when the input is falsy / non-finite — keeps payload shape
    // stable across cold-start (no successful sample yet) and post-error states.
    function toIso(ms) {
      if (!ms || !Number.isFinite(Number(ms))) return null;
      try { return new Date(Number(ms)).toISOString(); } catch { return null; }
    }

    const service = {
      enabled: ctx.getServiceActionsEnabled(),
      name: ctx.getServiceName(),
      useSudo: ctx.getServiceUseSudo(),
      status: 'disabled',
      detail: 'Service-Aktionen sind per ENV deaktiviert.'
    };

    // Plan 09-06 Task 3: time the service_actions branch — this is the
    // only adminHealthPayload() check that performs actual async I/O. The
    // other checks read state synchronously, so their latencyMs is 0.
    let serviceLatencyMs = 0;
    let serviceLastSuccessAt = null;
    let serviceLastErrorAt = null;
    if (ctx.getServiceActionsEnabled()) {
      const startNs = process.hrtime.bigint();
      const activeCheck = await ctx.runServiceCommand(['is-active', ctx.getServiceName()]);
      const showCheck = await ctx.runServiceCommand(['show', ctx.getServiceName(), '--property=ActiveState,SubState,UnitFileState', '--value']);
      serviceLatencyMs = Number(process.hrtime.bigint() - startNs) / 1e6;
      service.status = activeCheck.ok ? (activeCheck.stdout || 'unknown') : 'unavailable';
      service.detail = activeCheck.ok ? 'systemctl erreichbar' : activeCheck.error;
      service.show = showCheck.ok ? showCheck.stdout : showCheck.error;
      const checkedAtIso = new Date().toISOString();
      serviceLastSuccessAt = activeCheck.ok ? checkedAtIso : null;
      serviceLastErrorAt = activeCheck.ok ? null : checkedAtIso;
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
            : `fehlt: ${ctx.getConfigPath()}`,
          // Plan 09-06 Task 3: synchronous state read — zero latency. Config
          // load happens at boot; treat the loaded-config flag as the
          // success marker. No discrete error timestamp is tracked.
          latencyMs: 0,
          lastSuccessAt: (ctx.getLoadedConfig().exists && ctx.getLoadedConfig().valid) ? toIso(Date.now()) : null,
          lastErrorAt: !ctx.getLoadedConfig().valid && ctx.getLoadedConfig().exists ? toIso(Date.now()) : null
        },
        {
          id: 'setup',
          label: 'Setup Status',
          ok: !ctx.getLoadedConfig().needsSetup,
          detail: ctx.getLoadedConfig().needsSetup ? 'Setup noch nicht abgeschlossen' : 'Setup abgeschlossen',
          latencyMs: 0,
          lastSuccessAt: !ctx.getLoadedConfig().needsSetup ? toIso(Date.now()) : null,
          lastErrorAt: null
        },
        {
          id: 'meter',
          label: 'Live Meter Daten',
          ok: state.meter.ok,
          detail: state.meter.ok
            ? `letztes Update ${fmtTs(state.meter.updatedAt)}`
            : (state.meter.error || 'noch keine erfolgreichen Meter-Daten'),
          // Plan 09-06 Task 3: state.meter.updatedAt is the meter-poll wall-clock
          // — used for both lastSuccessAt (when ok=true) and lastErrorAt
          // (when ok=false). State doesn't separately track "last good ts" so
          // this aliases through the polling.js .ok flag.
          latencyMs: 0,
          lastSuccessAt: state.meter.ok ? toIso(state.meter.updatedAt) : null,
          lastErrorAt: state.meter.ok ? null : toIso(state.meter.updatedAt)
        },
        {
          id: 'epex',
          label: 'EPEX Feed',
          ok: !getCfg().epex.enabled || state.epex.ok,
          detail: !getCfg().epex.enabled
            ? 'deaktiviert'
            : state.epex.ok
              ? `letztes Update ${fmtTs(state.epex.updatedAt)}`
              : (state.epex.error || 'noch keine Preisdaten'),
          latencyMs: 0,
          lastSuccessAt: state.epex.ok ? toIso(state.epex.updatedAt) : null,
          lastErrorAt: state.epex.ok ? null : toIso(state.epex.updatedAt)
        },
        {
          id: 'service_actions',
          label: 'Restart Aktion',
          ok: ctx.getServiceActionsEnabled() && service.status !== 'unavailable',
          detail: ctx.getServiceActionsEnabled()
            ? `Service ${ctx.getServiceName()}: ${service.status}`
            : 'per ENV deaktiviert',
          // Plan 09-06 Task 3: this is the only async check — actual elapsed
          // milliseconds of the systemctl exec calls.
          latencyMs: serviceLatencyMs,
          lastSuccessAt: serviceLastSuccessAt,
          lastErrorAt: serviceLastErrorAt
        },
        {
          id: 'telemetry',
          label: 'Interne Historie',
          ok: !getCfg().telemetry?.enabled || state.telemetry.ok,
          detail: !getCfg().telemetry?.enabled
            ? 'deaktiviert'
            : state.telemetry.dbPath
              ? `DB ${state.telemetry.dbPath}, letztes Schreiben ${fmtTs(state.telemetry.lastWriteAt)}`
              : (state.telemetry.lastError || 'noch keine Telemetrie-Initialisierung'),
          latencyMs: 0,
          lastSuccessAt: state.telemetry.ok ? toIso(state.telemetry.lastWriteAt) : null,
          lastErrorAt: state.telemetry.lastError ? toIso(state.telemetry.lastWriteAt || Date.now()) : null
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

  // H-1 (Plan 16-02): shared body-parse wrapper. parseBody rejects an
  // invalid-JSON body with statusCode=400 and a body-too-large with
  // statusCode=413 (server-utils.js). Without a try/catch the rejection
  // bubbles to an uncaught 500 + a killed socket. readJsonBody turns both
  // cases into a clean, consistent {ok:false,error} JSON response and returns
  // null so the caller can early-return. NOTE: this is the ONE place that
  // emits the {ok:false,error} envelope on a parse failure — sibling handlers
  // keep their existing local response shapes (M-7 envelope normalization is
  // deferred to a later plan).
  async function readJsonBody(req, res) {
    try { return await parseBody(req); }
    catch (e) {
      const status = e.statusCode || 413;
      json(res, status, { ok: false, error: status === 413 ? 'body_too_large' : 'invalid_json_body' });
      return null;
    }
  }

  // H-4 (Plan 16-02): size-bounded JSON read for the EPEX upstream fetch.
  // A bare `await r.json()` on a config-controlled upstream (epex.priceApiUrl)
  // would buffer an arbitrarily large — potentially multi-GB — response into
  // memory and OOM the LXC. EPEX zone/price payloads are tiny; 1 MB is a
  // generous ceiling. Rejects early on the content-length header when present,
  // and otherwise enforces the cap chunk-by-chunk while streaming. The thrown
  // error carries statusCode=502 so the EPEX handlers' existing catch maps it
  // to a clean upstream-error response rather than an uncaught 500.
  const EPEX_MAX_RESPONSE_BYTES = 1024 * 1024; // 1 MB
  async function readJsonCapped(r, maxBytes = EPEX_MAX_RESPONSE_BYTES) {
    const cl = Number(r.headers.get('content-length'));
    if (Number.isFinite(cl) && cl > maxBytes) {
      const e = new Error('upstream_response_too_large'); e.statusCode = 502; throw e;
    }
    const reader = r.body.getReader();
    const chunks = []; let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch {}
        const e = new Error('upstream_response_too_large'); e.statusCode = 502; throw e;
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  // ── Auth / Rate Limiting ─────────────────────────────────────────────
  // Plan 09-03: route LAN-trust decision through deriveClientIp so that, when
  // an operator opts in via cfg.trustProxy=true + cfg.trustedProxyIps, XFF from
  // a known reverse proxy is honoured. Without opt-in, behaviour is unchanged
  // (req.socket.remoteAddress is the sole source of truth — QUAL-02 backward compat).
  // Loopback = the box itself. Always trusted regardless of lanTrust posture
  // (internal calls, on-box kiosk). Under 'strict' this is the ONLY bypass.
  function isLoopbackRequest(req) {
    const addr = deriveClientIp(req, getCfg());
    return addr === '127.0.0.1' || addr === '::1';
  }

  // Built-in "is this a private/LAN address" test — RFC1918 + loopback + IPv6
  // link-local. Used when the operator has NOT narrowed the definition via
  // security.lanCidrs.
  function isDefaultPrivateAddr(addr) {
    if (addr === '127.0.0.1' || addr === '::1') return true;
    const parts = addr.split('.').map(Number);
    if (parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      if (parts[0] === 10) return true;                                    // 10.0.0.0/8
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // 172.16.0.0/12
      if (parts[0] === 192 && parts[1] === 168) return true;               // 192.168.0.0/16
    }
    if (addr.startsWith('fe80:')) return true;                             // IPv6 link-local
    return false;
  }

  // Go-Live-Review 2026-06-10: "is this client on the trusted LAN" now honours
  // the operator's security config:
  //   - security.lanCidrs: if non-empty, ONLY these CIDRs count as LAN (loopback
  //     always still counts — the box itself). Empty = built-in RFC1918 default.
  //   - security.trustedClientIps: if non-empty, the client must ALSO be one of
  //     these exact IPs (an explicit per-device allowlist on top of the range).
  // Backward-compatible: with an empty security block this is byte-for-byte the
  // old RFC1918/loopback behaviour.
  function isLocalNetworkRequest(req) {
    const addr = deriveClientIp(req, getCfg());
    if (addr === '127.0.0.1' || addr === '::1') return true; // box itself, always
    const sec = getCfg().security || {};
    const cidrs = Array.isArray(sec.lanCidrs) ? sec.lanCidrs.filter(Boolean) : [];
    const inRange = cidrs.length > 0
      ? cidrs.some((c) => ipMatchesCidr(addr, c))
      : isDefaultPrivateAddr(addr);
    if (!inRange) return false;
    const trusted = Array.isArray(sec.trustedClientIps) ? sec.trustedClientIps.filter(Boolean) : [];
    if (trusted.length > 0) {
      const norm = String(addr).replace(/^::ffff:/, '');
      if (!trusted.map((t) => String(t).replace(/^::ffff:/, '')).includes(norm)) return false;
    }
    return true;
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
    '/api/integration/evcc',
    '/api/optimizer/status',
    '/api/log/dv-signals',
    '/api/telemetry/series',
    '/api/forecast',
    '/api/family/status',      // DASH-02 — family dashboard polls every 5s from LAN
    '/api/family/presence',    // DASH-03 — screensaver wake poll (GET only; POST still requires auth)
    '/api/family/tile-history', // Plan 11-03 D-14 — token-less kiosk detail-panel chart fetch; GET-only LAN bypass, Bearer for external. The POST /api/family/mqtt-tiles write path stays OUT.
    '/api/family/tesla-history', // Plan 11-06 round 10 — token-less kiosk EV-panel charge-history chart fetch; sibling of tile-history (GET-only LAN bypass, Bearer for external).
    '/api/epex/zones',
    '/api/epex/gaps',
    '/api/schedule',
    '/api/history/import/status',
    '/api/history/summary',
    // §51a lifetime Förder-Verlängerung (T-0004) — read-only aggregate for the
    // history page; same appliance-trust pattern as /api/history/summary.
    '/api/eeg/extension',
    '/api/schedule/automation/config',
    '/api/meter/scan',
    '/api/metrics',                // Plan 09-06 (D-07): LAN scrape allowed — appliance model. External callers still need Bearer.
    '/api/vpn/status',
    '/api/vpn/history',
    '/dv/control-value',
    '/api/devices',                // Phase 04 — device list (INTG-05)
    // Phase 09.2 — history exports + integrations health are appliance reads
    // consumed by the LAN browser (Explorer page chart + downloads + Integrations
    // page polling). D-15's Bearer-only gate was wrong for this deployment:
    // there's no user system, no place for the user to store a token in the
    // browser, so requiring Bearer makes the Explorer downloads unusable.
    // Standard appliance pattern (cf. /api/telemetry/series, /api/forecast,
    // /api/history/summary): GET-only LAN bypass; external callers still need Bearer.
    '/api/integrations/health',
    // Phase 09.4 D-05 — MQTT Inspector drawer poll; GET-only LAN bypass, Bearer for external.
    '/api/integrations/mqtt/topics',
    '/api/history/raw',
    '/api/history/raw/export.csv',
    '/api/history/raw/export.parquet',
    // DB backup download (pg_dump) — GET-only LAN bypass, Bearer for external.
    // Same appliance-trust model as the raw exports above (whole-DB read).
    '/api/db/backup',
    '/api/db/backup/status',
    // TimescaleDB engine status (versions + updatePending) — read-only diagnostic,
    // GET-only LAN bypass like the backup status. The POST /api/db/timescale/upgrade
    // trigger stays OUT (Bearer required, service-actions gated).
    '/api/db/timescale/status',
    // Phase 19 Plan 19-01 — Forecast Inspector (read-only diagnostic surface).
    // GET-only LAN bypass per appliance trust model (matches /api/forecast,
    // /api/integrations/health, /api/family/* pattern). External callers still
    // need Bearer. Pro-gating happens IN-HANDLER via requirePro() — LAN-bypassed
    // kiosks see 403 too when license inactive (Option B per Phase 17 D-15 spirit).
    '/api/forecast/inspector/pv-providers',
    '/api/forecast/inspector/load',
    '/api/forecast/inspector/ml-correction',
    '/api/forecast/inspector/eos',
    '/api/forecast/inspector/optimizer-cold',
    // pvnode-Nowcast-Tracking (Christin 2026-07-08): read-only Diagnose,
    // gleiche Appliance-Trust wie die Inspector-Reads (GET-only LAN-Bypass, extern Bearer).
    '/api/forecast/nowcast-track',
    // T-CURTAIL: observed-GHI coverage diagnostic (read-only). Same forecast
    // appliance-trust model. The POST /api/forecast/ghi-backfill trigger stays
    // OUT (Bearer required).
    '/api/forecast/ghi-coverage',
    // T-CURTAIL Increment 2b: calibrated-curtailment preview (read-only history
    // diagnostic). POST /api/curtailment/recalibrate stays OUT (Bearer required).
    '/api/curtailment/preview',
  ]);

  // Go-Live-Review 2026-06-10: map each LAN-safe GET endpoint to a coarse group
  // so security.lanTrust='restricted' can bypass auth for whole categories
  // (e.g. just the read-only dashboard) while still requiring a Bearer token for
  // everything else. Endpoints absent from this map fall back to the 'status'
  // group (the most conservative read-only category). Returns the group name.
  const ENDPOINT_GROUP = new Map([
    // status — keepalive, live status, costs, metrics, config READ, discovery
    ['/api/keepalive/modbus', 'status'], ['/api/keepalive/pulse', 'status'],
    ['/api/status', 'status'], ['/api/costs', 'status'], ['/api/metrics', 'status'],
    ['/dv/control-value', 'status'], ['/api/config', 'status'],
    ['/api/config/export', 'status'], ['/api/discovery/systems', 'status'],
    ['/api/optimizer/status', 'status'],
    // dashboard — family kiosk (token-less tablet)
    ['/api/family/status', 'dashboard'], ['/api/family/presence', 'dashboard'],
    ['/api/family/tile-history', 'dashboard'], ['/api/family/tesla-history', 'dashboard'],
    // history — telemetry/history reads + exports + DB backup
    ['/api/history/import/status', 'history'], ['/api/history/summary', 'history'],
    ['/api/eeg/extension', 'history'],
    ['/api/telemetry/series', 'history'], ['/api/history/raw', 'history'],
    ['/api/history/raw/export.csv', 'history'], ['/api/history/raw/export.parquet', 'history'],
    ['/api/db/backup', 'history'], ['/api/db/backup/status', 'history'],
    ['/api/db/timescale/status', 'history'],
    ['/api/curtailment/preview', 'history'],
    // forecast — forecast reads + inspector
    ['/api/forecast', 'forecast'],
    ['/api/forecast/inspector/pv-providers', 'forecast'], ['/api/forecast/inspector/load', 'forecast'],
    ['/api/forecast/inspector/ml-correction', 'forecast'], ['/api/forecast/inspector/eos', 'forecast'],
    ['/api/forecast/inspector/optimizer-cold', 'forecast'],
    ['/api/forecast/nowcast-track', 'forecast'],
    ['/api/forecast/ghi-coverage', 'forecast'],
    // integrations — integration status, schedule read, meter scan, vpn status,
    // devices, messages, signals, epex, mqtt inspector, health
    ['/api/integration/home-assistant', 'integrations'], ['/api/integration/loxone', 'integrations'],
    ['/api/integration/eos', 'integrations'], ['/api/integration/emhass', 'integrations'],
    ['/api/integration/evcc', 'integrations'], ['/api/integrations/health', 'integrations'],
    ['/api/integrations/mqtt/topics', 'integrations'], ['/api/schedule', 'integrations'],
    ['/api/schedule/automation/config', 'integrations'], ['/api/meter/scan', 'integrations'],
    ['/api/vpn/status', 'integrations'], ['/api/vpn/history', 'integrations'],
    ['/api/devices', 'integrations'], ['/api/log/dv-signals', 'integrations'],
    ['/api/epex/zones', 'integrations'], ['/api/epex/gaps', 'integrations'],
  ]);
  function endpointGroupFor(pathname) {
    if (ENDPOINT_GROUP.has(pathname)) return ENDPOINT_GROUP.get(pathname);
    if (pathname.startsWith('/api/devices/')) return 'integrations';
    if (pathname.startsWith('/api/history/viz/')) return 'history';
    return 'status'; // most conservative read-only fallback
  }

  // GET-only LAN-safe check. Under lanTrust='restricted' this is consulted to
  // decide whether a given endpoint's GROUP is operator-enabled. Now it is
  // ACTUALLY CALLED (pre-review it was dead code — checkAuth bypassed every
  // endpoint blanket on LAN; see checkAuth below).
  //   - opts.requireGroupEnabled=false (default): legacy behaviour — any
  //     allowlisted GET is LAN-safe (used by lanTrust='open' callers indirectly).
  //   - opts.requireGroupEnabled=true: the endpoint must ALSO be in an enabled
  //     security.lanSafeGroups group (lanTrust='restricted').
  function isLanSafeRequest(req, { requireGroupEnabled = false } = {}) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method !== 'GET') return false;
    const isAllowlisted = LAN_SAFE_ENDPOINTS.has(url.pathname)
      || url.pathname.startsWith('/api/devices/')
      || url.pathname.startsWith('/api/history/viz/');
    if (!isAllowlisted) return false;
    if (!requireGroupEnabled) return true;
    const sec = getCfg().security || {};
    const groups = Array.isArray(sec.lanSafeGroups) ? sec.lanSafeGroups : [];
    return groups.includes(endpointGroupFor(url.pathname));
  }

  // --- /api/integrations/health 5-second cache (Phase 09.2 D-18) ---
  // Single-key closure entry — no params → no cache-poisoning surface, bounded
  // memory by TTL. Recomputed at most once per HEALTH_CACHE_TTL_MS via the
  // healthTracker.snapshot() read in the handler below.
  const HEALTH_CACHE_TTL_MS = 5000;
  let healthCacheEntry = null; // { payload, expiresAt }

  // --- /api/history/raw 60-second LRU cache (Phase 09.2 D-14) ---
  // Multi-key Map keyed by JSON.stringify of normalized request params (sorted
  // sources/signals arrays). Cap 100 entries with FIFO eviction (insertion
  // order = oldest, served by Map.keys().next().value). Cache entries are
  // immutable payload objects; identical requests within TTL share the exact
  // same payload (no per-request allocation). Bounded memory by both TTL and
  // cap — cache-poisoning surface is the parameter space, gated by checkAuth
  // (D-15: NOT in LAN_SAFE_ENDPOINTS, Bearer required from any source).
  const RAW_CACHE_TTL_MS = 60_000;
  const RAW_CACHE_CAP = 100;
  const rawHistoryCache = new Map(); // insertion-ordered

  // Parse an ISO-8601 timestamp string. Returns:
  //   - null if input is falsy (param not supplied)
  //   - false (sentinel) if input is non-empty but unparseable — the handler
  //     uses this to return 400 instead of letting bad input reach the DB
  //   - a normalized ISO-8601 string otherwise
  function parseIsoOrNull(s) {
    if (!s) return null;
    const ts = Date.parse(s);
    if (!Number.isFinite(ts)) return false;
    return new Date(ts).toISOString();
  }
  function parseCsv(s) {
    if (!s) return [];
    return s.split(',').map((x) => x.trim()).filter(Boolean);
  }
  // Normalized cache key — sorted arrays so {sources: ['a','b']} and
  // {sources: ['b','a']} hash identically. JSON.stringify with explicit
  // key insertion order (object literal) keeps the key stable across
  // engine implementations.
  function normalizedRawCacheKey({ sources, signals, from, to, limit, cursor }) {
    return JSON.stringify({
      sources: [...sources].sort(),
      signals: [...signals].sort(),
      from: from || null,
      to: to || null,
      limit,
      cursor: cursor || null,
    });
  }

  // --- Rate Limiting (in-memory, per IP) ---
  const rateLimitBuckets = new Map();
  const RATE_LIMIT_WINDOW_MS = 60_000;
  const RATE_LIMIT_MAX_REQUESTS = 120;     // 120 req/min per IP for external (2/s avg)
  const LAN_RATE_LIMIT_MAX_REQUESTS = 600; // 600 req/min for LAN (10/s avg) — compromised IoT protection

  // Phase 20 D-05: per-provider per-token-hash rate-limit (separate from
  // the global per-IP rateLimitBuckets above — different concern: this
  // protects upstream API calls from spam, not auth/config endpoints).
  // 5 calls/min per (providerName, sha256(token).slice(0,16)).
  const providerRateBuckets = new Map();
  const PROVIDER_RATE_WINDOW_MS = 60_000;
  const PROVIDER_RATE_MAX_CALLS = 5;
  const PROVIDER_RATE_MAX_KEYS = 1_000;
  function checkProviderRateLimit(providerName, tokenForHash) {
    const hash = crypto.createHash('sha256').update(String(tokenForHash || '')).digest('hex').slice(0, 16);
    const key = `${providerName}:${hash}`;
    const now = Date.now();
    let b = providerRateBuckets.get(key);
    if (!b) {
      if (providerRateBuckets.size >= PROVIDER_RATE_MAX_KEYS) {
        const firstKey = providerRateBuckets.keys().next().value;
        if (firstKey !== undefined) providerRateBuckets.delete(firstKey);
      }
      b = { windowStart: now, count: 0 };
      providerRateBuckets.set(key, b);
    }
    if (now - b.windowStart > PROVIDER_RATE_WINDOW_MS) {
      b.windowStart = now;
      b.count = 0;
    }
    b.count++;
    if (b.count > PROVIDER_RATE_MAX_CALLS) {
      const retryAfter = Math.ceil((b.windowStart + PROVIDER_RATE_WINDOW_MS - now) / 1000);
      return { ok: false, retry_after_s: retryAfter };
    }
    return { ok: true };
  }

  // Phase 20-04: SSRF guard for Uptime-Kuma push-URL. Verbatim from
  // server.js:1426-1441 (kept in-sync — the production heartbeat at
  // startMonitoringHeartbeat uses the same predicate). Reject http, localhost,
  // RFC1918, and link-local so a typed-pushUrl cannot be used to pivot into
  // internal networks from DVhub. Applied at BOTH save-time (defence in depth)
  // AND test-push time (operator's unsaved URL).
  function isAllowedHeartbeatUrl(raw) {
    try {
      const u = new URL(String(raw || ''));
      if (u.protocol !== 'https:') return false;
      const host = u.hostname.toLowerCase();
      if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
      const parts = host.split('.').map(Number);
      if (parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
        if (parts[0] === 10) return false;                                      // 10.0.0.0/8
        if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return false; // 172.16/12
        if (parts[0] === 192 && parts[1] === 168) return false;                 // 192.168/16
        if (parts[0] === 169 && parts[1] === 254) return false;                 // 169.254/16 link-local
      }
      return true;
    } catch { return false; }
  }

  // Phase 20-04: One-shot Kuma push for the test-push path. Replicates the
  // fetch shape from server.js:1475-1496 but uses a CALLER-PROVIDED pushUrl
  // (so an operator's unsaved form value works — Pitfall 5). Does NOT touch
  // the production heartbeat timer; the periodic ping continues independently.
  // Returns {ok, error?} — never throws.
  async function kumaPushOnce({ pushUrl, msg, signingKey, hostname, appVersion, status }) {
    if (!isAllowedHeartbeatUrl(pushUrl)) return { ok: false, error: 'invalid_url' };
    try {
      const ts = Date.now();
      const payload = `${msg}|${ts}|${hostname}|${appVersion}`;
      const sig = signingKey
        ? 'sha256=' + crypto.createHmac('sha256', signingKey).update(payload).digest('hex')
        : 'unsigned';
      const sep = pushUrl.includes('?') ? '&' : '?';
      const kumaStatus = status === 'down' ? 'down' : 'up';
      const res = await fetch(pushUrl + sep + 'status=' + kumaStatus + '&msg=' + encodeURIComponent(msg) + '&ping=', {
        signal: AbortSignal.timeout(10000),
        headers: {
          'x-dvhub-signature': sig,
          'x-dvhub-ts': String(ts),
          'x-dvhub-host': hostname,
          'x-dvhub-version': appVersion
        }
      });
      if (!res.ok) return { ok: false, error: `kuma_http_${res.status}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message || 'fetch_failed' };
    }
  }

  // Plan 08-04 Task 1 Step 6: collapse the key space so IPv6-rotation attackers
  // cannot make each request land in a new bucket. v4 addresses stay full, v6
  // collapses to /64 prefix (which is the smallest externally-routable block).
  // Plan 09-03: use deriveClientIp so rate-limit bucketing tracks the SAME client
  // IP that isLocalNetworkRequest decides on — auth path + rate-limit path
  // can never disagree on who the client is.
  function getRateLimitKey(req) {
    const raw = deriveClientIp(req, getCfg());
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

  // Phase 09.2 D-15 / T-09.2-AUTHZ: a small allowlist of endpoints that
  // REQUIRE a Bearer token regardless of the LAN-trust stance. Raw-data
  // export surfaces (rows of timeseries_samples + future CSV/Parquet
  // streams) leak operational topology + last-sample timestamps — LAN
  // bypass would defeat the purpose of audit logging on these reads.
  // Every entry here is an exact-match path (handlers add `*` semantics
  // by checking `pathname ===` or `pathname.startsWith` themselves —
  // for the raw endpoints we intentionally keep the family explicit so
  // misuse via path tricks like `/api/history/raw/x` falls through to
  // 404 instead of a hidden bypass).
  // Phase 09.2 D-15 was reverted (2026-05-15): the original "Bearer required
  // even on LAN for /api/history/raw*" gate broke browser-driven Explorer
  // downloads, because the appliance has no user system, no token UI in the
  // browser, and operators store tokens externally only for off-LAN scripted
  // calls. The 4 history + integrations endpoints are now standard
  // LAN_SAFE_ENDPOINTS reads — bypass on LAN, Bearer required externally,
  // matching /api/telemetry/series, /api/forecast, /api/history/summary.
  // Set kept empty as the explicit override mechanism for any future endpoint
  // that genuinely needs Bearer-only-from-anywhere.
  // T-0113: the support bundle carries redacted-but-still-sensitive diagnostics
  // (config shape, logs, host info). Require Bearer even on LAN, like the raw
  // history exports — the CLI (`dvhub support dump`) is the unauthenticated
  // local-shell path for an operator already on the box.
  // /api/db/restore is DESTRUCTIVE (drops+recreates the telemetry DB) — force
  // Bearer even on a trusted LAN (lanTrust:open), like the support bundle.
  const BEARER_REQUIRED_ENDPOINTS = new Set(['/api/support/bundle', '/api/db/restore', '/api/db/timescale/upgrade']);

  function checkAuth(req, res) {
    const cfg = getCfg();
    // BEARER_REQUIRED_ENDPOINTS (currently empty — see set definition above)
    // skip the LAN bypass. Compute pathname BEFORE the LAN check so the gate
    // applies to every caller — LAN or external.
    const reqPathForBearerGate = (() => {
      try { return new URL(req.url, `http://${req.headers.host}`).pathname; }
      catch { return req.url || ''; }
    })();
    const bearerOnly = BEARER_REQUIRED_ENDPOINTS.has(reqPathForBearerGate);
    // ── Go-Live-Review 2026-06-10: operator-selectable LAN-trust posture ──────
    // Previously this was a single blanket rule: any private/loopback client
    // bypassed the token for EVERY non-bearer-only endpoint (the curated
    // LAN_SAFE_ENDPOINTS allowlist was never consulted — dead code). It is now
    // driven by cfg.security.lanTrust:
    //   'open'       — blanket LAN bypass (UNCHANGED default; phones/tablets on
    //                  the WLAN trusted without a token, as before).
    //   'restricted' — LAN bypass ONLY for GET endpoints whose group is in
    //                  security.lanSafeGroups; admin/config/control writes and
    //                  the eosdash proxy require a Bearer token even on LAN.
    //   'strict'     — no LAN bypass at all; only 127.0.0.1/::1 (the box itself).
    // Loopback always bypasses (internal calls, on-box kiosk). Misconfigured /
    // unknown value fails safe to 'open' only when the field is absent (so an
    // un-migrated config keeps working); an explicit unknown string is treated
    // as 'strict' (fail-closed).
    if (!bearerOnly) {
      const lanTrustRaw = getCfg().security?.lanTrust;
      const lanTrust = lanTrustRaw == null ? 'open' : String(lanTrustRaw);
      if (isLoopbackRequest(req)) return true;                     // the box itself
      if (lanTrust === 'open') {
        if (isLocalNetworkRequest(req)) return true;
      } else if (lanTrust === 'restricted') {
        if (isLocalNetworkRequest(req) && isLanSafeRequest(req, { requireGroupEnabled: true })) return true;
        // else: fall through to the Bearer check below.
      }
      // 'strict' (and any unknown explicit value) → no LAN bypass; Bearer required.
    }
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

  // ──────────────────────────────────────────────────────────────────────
  // Phase 17 Plan 04: License-gate helper (Option B per CONTEXT Amendment).
  //
  // Local wrapper around licenseService.requirePro() so call-sites stay
  // readable — `if (!requirePro(req,res,FEAT)) return;` — instead of the
  // verbose service-prefixed form. FEAT is whitelisted to a known feature
  // slug (e.g. family-dashboard) inside licenseService.requirePro.
  //
  // The gate runs INSIDE each Family-route handler — BEFORE any business
  // logic — so even LAN-bypassed kiosks (LAN_SAFE_ENDPOINTS at lines 770-773
  // stay UNTOUCHED per Option B) see a 403 when the license is not active.
  // With status='active', the gate returns true and the handler runs normally
  // — D-14's token-less kiosk flow is preserved for activated installations.
  //
  // 403 body shape: { error: 'pro_required', feature: <whitelisted feat> }.
  // featureName is whitelisted inside licenseService.requirePro (V5 ASVS —
  // prevents log/response injection).
  // ──────────────────────────────────────────────────────────────────────
  function requirePro(req, res, featureName) {
    return licenseService.requirePro(req, res, featureName);
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
    // Plan 24-03: empty/missing token rejected up front — a constant-time
    // compare on a missing token is pointless, and the length-guard below
    // would otherwise need a non-empty buffer to compare against.
    if (!expected || !given) {
      pushLog('setup_bootstrap_rejected', {}, actorContext(req));
      res.writeHead(403, { ...SECURITY_HEADERS, 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'bootstrap_token_required_or_invalid' }));
      return false;
    }
    // Plan 24-03: constant-time compare (T-24-TIMING). A `given !== expected`
    // short-circuits on the first mismatching byte and leaks the correct token
    // prefix length over timing. The length-guard runs BEFORE timingSafeEqual
    // so unequal-length buffers yield a clean 403 instead of a RangeError → 500
    // (T-24-CRASH-500). Same pattern as the Bearer paths (:1330/:1337/:4320).
    const giv = Buffer.from(given);
    const exp = Buffer.from(expected);
    const ok = giv.length === exp.length && crypto.timingSafeEqual(giv, exp);
    if (!ok) {
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
    // L-7 (Plan 16-03): new Date(row.ts).toISOString() throws a RangeError on
    // a malformed row.ts (Invalid Date) — a single bad row would 500 the whole
    // endpoint. Skip rows whose ts cannot be parsed (T-16-13 DoS).
    return state.epex.data
      .filter((row) => Number.isFinite(Date.parse(row.ts)))
      .map((row) => ({
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
    // H-2 (Plan 16-02): clamp the pulse period. A misconfigured
    // keepalivePulseSec of 0 — or a missing value — would make the divisor 0,
    // so pulseSlot becomes Infinity and serializes to JSON `null` on a polled
    // LAN-safe endpoint. Clamp to >=1 with a 60 s fallback.
    const period = Math.max(1, Number(cfg.keepalivePulseSec) || 60);
    const slot = Math.floor(now / (period * 1000));
    const slotTs = slot * period * 1000;
    return {
      ok: true,
      periodSec: period,
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

  // D-27: the manufacturer <select> options come from the actual hersteller/
  // folder (a newly dropped profile is selectable without a code change). The
  // shared CONFIG_DEFINITION constant stays untouched — shallow-copy the field.
  function definitionWithManufacturerOptions() {
    const definition = ctx.getConfigDefinition();
    const fields = Array.isArray(definition?.fields) ? definition.fields : null;
    if (!fields) return definition;
    return {
      ...definition,
      fields: fields.map((field) => (
        field?.path === 'manufacturer'
          ? { ...field, options: listManufacturerProfiles(ctx) }
          : field
      ))
    };
  }

  function configApiPayload() {
    const cfg = getCfg();
    return {
      ok: true,
      meta: configMetaPayload(),
      config: redactConfig(ctx.getRawCfg()),
      effectiveConfig: redactConfig(cfg),
      definition: definitionWithManufacturerOptions()
    };
  }

  // ── First-run onboarding (Aurora setup wizard) ───────────────────────
  // Secrets-free prefill for onboarding.html. Returns ONLY what the wizard
  // needs to render — current manufacturer, the Victron host (if pre-seeded by
  // an integrator) and forecast coordinates. NEVER the apiToken or any
  // credential; the token is handed out exactly once by completeSetup().
  function setupStatePayload() {
    const cfg = getCfg();
    const loc = (cfg.forecast && typeof cfg.forecast.location === 'object') ? cfg.forecast.location : {};
    const host = cfg.victron && typeof cfg.victron.host === 'string' ? cfg.victron.host : '';
    // A placeholder host from config.example.json ("192.168.x.x") must not
    // pre-fill as if it were a real address — treat it as empty for the wizard.
    const realHost = /x\.x$/i.test(host) ? '' : host;
    return {
      ok: true,
      needsSetup: !!ctx.needsSetup(),
      manufacturer: cfg.manufacturer || 'victron',
      victronHost: realHost,
      location: {
        latitude: Number.isFinite(Number(loc.latitude)) ? Number(loc.latitude) : null,
        longitude: Number.isFinite(Number(loc.longitude)) ? Number(loc.longitude) : null
      }
    };
  }

  // Finisher for the onboarding wizard. Merges the minimal plant config onto the
  // FULL current raw config (saveAndApplyConfig REPLACES, never merges — see the
  // config-save-replaces memory rule), marks setupCompleted=true (which closes
  // the needsSetup window), then returns the box's real apiToken so the browser
  // can claim it. The caller has already enforced needsSetup + LAN/loopback.
  function completeSetup(req, res, body) {
    const input = (body && typeof body === 'object') ? body : {};
    // victronHost: required. Bare host/IP only — reject schemes, paths, creds,
    // whitespace. IPv6 (colons) is allowed; the real check is the live connect.
    const rawHost = typeof input.victronHost === 'string' ? input.victronHost.trim() : '';
    if (!rawHost || rawHost.length > 255 || /\s/.test(rawHost) || /[/\\@]/.test(rawHost)) {
      return json(res, 400, { ok: false, error: 'invalid_victron_host' });
    }
    // location: optional, but both coordinates must arrive together when present.
    let latitude = null;
    let longitude = null;
    const locIn = (input.location && typeof input.location === 'object') ? input.location : {};
    const present = (v) => v !== undefined && v !== null && v !== '';
    if (present(locIn.latitude) || present(locIn.longitude)) {
      latitude = Number(locIn.latitude);
      longitude = Number(locIn.longitude);
      if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90
        || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
        return json(res, 400, { ok: false, error: 'invalid_location' });
      }
    }
    const next = JSON.parse(JSON.stringify(ctx.getRawCfg() || {}));
    // D-27: keep a pre-seeded manufacturer (integrator configured e.g.
    // 'bridge-mqtt' before first boot) instead of force-resetting to victron —
    // the wizard itself has no manufacturer step, so overwriting here would
    // silently undo the pre-provisioning.
    next.manufacturer = (typeof next.manufacturer === 'string' && next.manufacturer.trim())
      ? next.manufacturer
      : 'victron';
    next.victron = (next.victron && typeof next.victron === 'object') ? next.victron : {};
    next.victron.host = rawHost;
    if (latitude !== null) {
      next.forecast = (next.forecast && typeof next.forecast === 'object') ? next.forecast : {};
      next.forecast.location = (next.forecast.location && typeof next.forecast.location === 'object')
        ? next.forecast.location : {};
      next.forecast.location.latitude = latitude;
      next.forecast.location.longitude = longitude;
    }
    next.setupCompleted = true;
    let result;
    try {
      result = ctx.saveAndApplyConfig(next);
    } catch (e) {
      pushLog('setup_complete_failed', { error: e?.message || 'save_failed' }, actorContext(req));
      return json(res, 500, { ok: false, error: 'setup_save_failed' });
    }
    // The fresh-box bootstrap-token takeover window is moot once setup is done.
    consumeBootstrapToken();
    pushLog('setup_completed', {
      victronHost: 'set',
      location: latitude !== null,
      restartRequired: !!result.restartRequired
    }, actorContext(req));
    // Hand the browser the real token ONCE so it authenticates from here on.
    // This is the only path that emits getCfg().apiToken un-redacted, reachable
    // only inside the now-closing needsSetup + LAN window.
    return json(res, 200, {
      ok: true,
      apiToken: getCfg().apiToken || '',
      restartRequired: !!result.restartRequired,
      redirect: '/'
    });
  }

  // ── Status / History builders ────────────────────────────────────────
  function buildApiStatusResponse(now = Date.now()) {
    const payload = buildWorkerBackedStatusResponse({
      cachedStatus: ctx.getCachedRuntimeStatusPayload(),
      fallbackStatus: ctx.buildFallbackStatusPayload(now),
      setup: configMetaPayload(),
      runtime: ctx.buildRuntimeRouteMeta(now)
    });
    // Review 2026-06-10 (B7 Lösung 2): Leitstand-Banner-Quelle. liteStatus()
    // liest nur In-Memory-Felder (kein fs, kein uiToken) — sicher im 3s-Poll.
    payload.supportTunnel = ctx.supportTunnel?.liteStatus?.() ?? null;
    // T-0099 NOT-HALT: in-memory only, safe in the 3 s poll. Drives the
    // Leitstand emergency-stop button + sticky banner.
    payload.emergencyStop = {
      active: !!state.ctrl.discretionaryWritesPaused,
      pausedAt: state.ctrl.pausedAt || null
    };
    // Victron device alarms (read-only display). Source is payload.victron.alarms,
    // which the POLLER (possibly a separate runtime-worker process) writes and
    // which reaches here through the runtime IPC snapshot — NOT web-process-local
    // `state` (unlike emergencyStop, which is web-process state.ctrl). Reading
    // local state here would be permanently empty in split-process mode.
    payload.victronAlarms = buildVictronAlarmsPayload(
      payload.victron?.alarms,
      now,
      getCfg().victron?.alarms?.pollIntervalMs
    );
    // Lizenz-kWp-Cap (T-LICENSE-KWP-GATING): angezeigte Live-PV auf die lizenzierte
    // kWp kappen. payload.victron ist ein FRISCHER Snapshot (buildVictronSnapshot/
    // IPC), nie die Quelle state.victron — der Steuerungspfad bleibt unberührt.
    // No-op wenn kein Pro-Key mit max_kwp aktiv (getCapKwp()→null).
    const capKwp = licenseService?.getCapKwp?.();
    const pvCapW = Number.isFinite(capKwp) && capKwp > 0 ? capKwp * 1000 : null;
    if (pvCapW != null) capVictronPvForDisplay(payload.victron, pvCapW);
    // Tag/Nacht (Christin 2026-07-08): treibt den Leitstand-Powerflow-Foto-Hintergrund.
    payload.isDay = ctx.getIsDay?.(now) ?? null;
    return payload;
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
    const cacheControl = (filename === 'setup.html' || filename === 'onboarding.html') ? 'no-store' : 'no-cache';
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8', 'cache-control': cacheControl });
    fs.createReadStream(file).pipe(res);
  }

  function serveStatic(req, res) {
    const appDir = ctx.getAppDir();
    const urlPath = new URL(req.url, 'http://localhost').pathname;
    // M-1 (Plan 16-03): decodeURIComponent throws a URIError on a malformed
    // `%` escape (e.g. `/%E0%A4%A`) — caught here it would otherwise bubble
    // to an uncaught 500. A `%00` decodes into a NUL byte which fs rejects
    // with ERR_INVALID_ARG_VALUE → another 500. Both are bad client input,
    // not server faults, so they map to 400.
    let reqPath;
    if (urlPath === '/') {
      reqPath = '/index.html';
    } else {
      try {
        reqPath = decodeURIComponent(urlPath);
      } catch {
        return text(res, 400, 'bad path');
      }
      if (reqPath.includes('\0')) return text(res, 400, 'bad path');
    }
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
      '.webp': 'image/webp',
      '.ico': 'image/x-icon'
    }[ext] || 'application/octet-stream';
    let cacheControl;
    if (ext === '.html') {
      cacheControl = (reqPath.includes('setup') || reqPath.includes('onboarding')) ? 'no-store' : 'no-cache';
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
    // T-0080 P1: unauthenticated liveness probe for uptime monitoring
    // (Uptime-Kuma/LXC health checks). Deliberately auth-free AND data-free:
    // process liveness + the coarse telemetry-store flag only — no config,
    // host or version details that would make this an enumeration surface.
    if (url.pathname === '/healthz' && req.method === 'GET') {
      return json(res, 200, {
        ok: true,
        uptimeSec: Math.floor(process.uptime()),
        store: state.telemetry?.ok ?? null
      });
    }
    // Plan 09-06 (D-06): per-request metrics. Record start time + canonical
    // route label so res.on('finish') can emit httpRequestsTotal +
    // httpRequestDurationSeconds with bounded cardinality (no raw dynamic ids).
    // Guard for non-EventEmitter mock res objects in unit tests (QUAL-02 —
    // existing tests synthesise plain { writeHead, end } stubs; calling
    // res.on() unconditionally would break them).
    const __metricsStart = process.hrtime.bigint();
    const __routeLabel = matchRouteLabel(url.pathname);
    if (!res.__metricsObserved && typeof res.on === 'function') {
      res.__metricsObserved = true;
      res.on('finish', () => {
        try {
          const durationSec = Number(process.hrtime.bigint() - __metricsStart) / 1e9;
          httpRequestsTotal.inc({
            method: req.method || 'GET',
            route: __routeLabel,
            status: String(res.statusCode)
          });
          httpRequestDurationSeconds.observe(
            { method: req.method || 'GET', route: __routeLabel },
            durationSec
          );
        } catch { /* metrics must never break the response cycle */ }
      });
    }

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
      // First-run onboarding: while needsSetup is true the root serves the new
      // Aurora onboarding wizard (onboarding.html) instead of the token-gated
      // dashboard. The legacy /setup.html wizard stays reachable directly as a
      // fallback but is no longer the default first-run surface.
      return servePage(res, ctx.needsSetup() ? 'onboarding.html' : 'index.html');
    }

    if (url.pathname === '/health' && req.method === 'GET') {
      // Liveness stays 200 while the process is up. T-0080: ALSO surface telemetry
      // readiness as fields so an external monitor (Uptime Kuma) can alert on a
      // silent telemetry/DB outage (the T-0106 lesson). Status stays 200 — liveness
      // != readiness; consumers check `.ready` / `.telemetry.ok` for readiness.
      const telemetryConfigured = getCfg().telemetry?.enabled === true;
      const telemetryOk = !!state.telemetry?.ok;
      return json(res, 200, {
        ok: true,
        uptimeSec: Math.round(process.uptime()),
        version: ctx.getAppVersion().versionLabel || null,
        ready: !telemetryConfigured || telemetryOk,
        telemetry: {
          configured: telemetryConfigured,
          ok: telemetryOk,
          lastError: state.telemetry?.lastError || null
        }
      });
    }

    // ── First-run onboarding window (token-free, LAN/loopback-only) ──────────
    // The Aurora onboarding wizard (onboarding.html) must be usable on a fresh /
    // pre-installed box where the browser has no API token yet. These two
    // endpoints are deliberately handled BEFORE the global checkAuth gate below,
    // each self-guarded so the exception is as narrow as possible:
    //   - both: only from loopback (the box) or the trusted LAN (never WAN).
    //   - /api/setup/state (GET): a secrets-free prefill read (NO apiToken, NO
    //     credentials) — safe to answer whenever, so the wizard can render.
    //   - /api/setup/complete (POST): only while ctx.needsSetup() is still true
    //     (the open setup window). It persists the plant config, flips
    //     setupCompleted→true (closing the window), and hands the browser the
    //     box's real apiToken ONCE so it can claim it without the operator ever
    //     hunting for a token. This LAN+window trust boundary is the approved
    //     model (operator decision 2026-06-27): the window only exists on a
    //     not-yet-set-up box and closes on first completion — equivalent risk
    //     profile to the existing bootstrap-token first-caller-wins window.
    if (url.pathname === '/api/setup/state' || url.pathname === '/api/setup/complete') {
      if (!checkRateLimit(req, res)) return;
      if (!isLoopbackRequest(req) && !isLocalNetworkRequest(req)) {
        pushLog('setup_window_denied_non_lan', { path: url.pathname }, actorContext(req));
        return json(res, 403, { ok: false, error: 'setup_window_lan_only' });
      }
      if (url.pathname === '/api/setup/state' && req.method === 'GET') {
        return json(res, 200, setupStatePayload());
      }
      if (url.pathname === '/api/setup/complete' && req.method === 'POST') {
        if (!ctx.needsSetup()) {
          return json(res, 403, { ok: false, error: 'setup_already_completed' });
        }
        const body = await readJsonBody(req, res);
        if (body === null) return; // readJsonBody already sent 400/413
        return completeSetup(req, res, body);
      }
      return json(res, 404, { ok: false, error: 'not_found' });
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

    // Pro-Gating (Task #10): /dv/control-value is the HTTP read-half of the
    // DV-Schnittstelle (the 0/1 forcedOff mirror a Direktvermarkter polls). The
    // write-half (Modbus server) is gated in server.js; this closes the read-half
    // too, so the DV-Schnittstelle is fully shut without an active licence. No
    // internal UI consumes this endpoint. LAN-auth is still bypassed (status
    // group) — the Pro check runs IN-HANDLER, mirroring the family-dashboard gate.
    if (url.pathname === '/dv/control-value' && req.method === 'GET') {
      if (!requirePro(req, res, 'dv-interface')) return;
      return text(res, 200, ctx.controlValue());
    }

    // Plan 09-06 (D-06 + D-07): Prometheus exposition. /api/metrics IS in
    // LAN_SAFE_ENDPOINTS so the standard checkAuth above honours the LAN
    // bypass for /api/metrics — external (non-LAN) callers still go through
    // the Bearer check. Do NOT add an additional auth override here.
    // Content-type comes from prom-client (Registry.contentType returns the
    // canonical 'text/plain; version=0.0.4; charset=utf-8' exposition format).
    if (url.pathname === '/api/metrics' && req.method === 'GET') {
      try {
        // Plan 09-06: stamp uptime gauge on each scrape so /api/metrics carries
        // the same uptime number as /api/admin/health. Default collectDefaultMetrics
        // ships nodejs_process_start_time_seconds but operators often want a
        // ready-to-use seconds-since-start gauge.
        const body = await metricsRegistry.metrics();
        const uptimeLine = `\n# HELP dvhub_uptime_seconds Process uptime in seconds\n# TYPE dvhub_uptime_seconds gauge\ndvhub_uptime_seconds ${process.uptime()}\n`;
        const full = body + uptimeLine;
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'content-type': metricsRegistry.contentType,
          'content-length': Buffer.byteLength(full, 'utf8')
        });
        res.end(full);
      } catch (e) {
        res.writeHead(500, { ...SECURITY_HEADERS, 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'metrics_render_failed', detail: e?.message || null }));
      }
      return;
    }

    if (url.pathname === '/api/keepalive/modbus' && req.method === 'GET') return json(res, 200, keepaliveModbusPayload());
    if (url.pathname === '/api/keepalive/pulse' && req.method === 'GET') return json(res, 200, keepalivePulsePayload());
    if (url.pathname === '/api/config' && req.method === 'GET') return json(res, 200, configApiPayload());

    if (url.pathname === '/api/config/export' && req.method === 'GET') {
      // Plan 09-05 Task 1: audit the sensitive config-export download BEFORE the
      // response body is streamed. actorIp via deriveClientIp (09-03) so XFF
      // posture is consistent with auth + rate-limiting. Only the COUNT of
      // redacted keys is logged — never the values themselves (T-9-05-02).
      pushLog('config_exported', {
        actor: req.headers['x-actor'] || 'admin',
        actorIp: deriveClientIp(req, getCfg()),
        redactedKeyCount: Array.isArray(REDACTED_PATHS) ? REDACTED_PATHS.length : 0
      }, { ...actorContext(req), severity: 'info' });
      return downloadJson(res, 'dvhub-config.json', redactConfig(ctx.getRawCfg()));
    }

    // Password-protected migration export. Same redacted config PLUS an encrypted
    // `_encryptedSecrets` bundle carrying the REDACTED_PATHS values (forecast API
    // keys, DB password, MQTT/notification creds — but NOT apiToken) so a FRESH
    // box can restore them on import. The bundle is AES-256-GCM under a
    // PBKDF2(password) key; without the password it is opaque.
    if (url.pathname === '/api/config/export' && req.method === 'POST') {
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const password = typeof body?.password === 'string' ? body.password : '';
      if (!password) return json(res, 400, { ok: false, error: 'password_required' });
      if (password.length < 8) return json(res, 400, { ok: false, error: 'password_too_short' });
      let bundle;
      try {
        bundle = encryptSecrets(ctx.getRawCfg(), password);
      } catch (e) {
        return json(res, 400, { ok: false, error: e.message || 'encrypt_failed' });
      }
      const out = redactConfig(ctx.getRawCfg());
      if (bundle) out._encryptedSecrets = bundle;
      pushLog('config_exported', {
        actor: req.headers['x-actor'] || 'admin',
        actorIp: deriveClientIp(req, getCfg()),
        redactedKeyCount: Array.isArray(REDACTED_PATHS) ? REDACTED_PATHS.length : 0,
        encryptedSecretCount: bundle ? bundle.paths.length : 0
      }, { ...actorContext(req), severity: 'info' });
      return json(res, 200, out);
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

    if (url.pathname === '/api/integration/evcc' && req.method === 'GET') {
      const status = ctx.evccIntegration?.getStatus?.() || { enabled: false, error: 'evcc integration not initialised' };
      return json(res, 200, status);
    }

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
      if (!requirePro(req, res, 'family-dashboard')) return;
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
      if (!requirePro(req, res, 'family-dashboard')) return;
      if (!ctx.familyService) return json(res, 503, { ok: false, error: 'family service not available' });
      return json(res, 200, { ok: true, ...ctx.familyService.getPresence() });
    }

    // Presence webhook (D-08, D-19). POSTs always require auth token —
    // isLanSafeRequest rejects non-GET requests by design. Loxone/HA/MQTT
    // integrations configure the Bearer token in Phase 04.
    if (url.pathname === '/api/family/presence' && req.method === 'POST') {
      if (!requirePro(req, res, 'family-dashboard')) return;
      if (!ctx.familyService) return json(res, 503, { ok: false, error: 'family service not available' });
      let body;
      try {
        body = await parseBody(req);
      } catch {
        return json(res, 400, { ok: false, error: 'invalid json' });
      }
      const detected = body?.detected === true;
      const source = typeof body?.source === 'string' ? body.source : 'unknown';
      ctx.familyService.setPresence({ detected, source });
      return json(res, 200, { ok: true });
    }

    // Family-Dashboard MQTT tiles — operator-managed list of generic MQTT
    // topics surfaced as cards on the family page (config.family.mqttTiles).
    // The Integrations-page editor reads via GET and saves via POST. POST
    // merges ONLY family.mqttTiles into the full config SERVER-SIDE — the
    // client never round-trips the whole config object (which would, with a
    // partial body, replace it: saveAndApplyConfig overwrites, never merges).
    // Family-dashboard OWN settings (2026-06-13, operator request): the kiosk
    // clock opens a settings popup; this endpoint server-side-MERGES the
    // screensaver block into cfg.family (full-config POST /api/config would be
    // wrong from a token-less kiosk — and replaces, never merges). Same
    // LAN-trust + Pro-gate pattern as /api/family/mqtt-tiles below.
    if (url.pathname === '/api/family/settings' && req.method === 'POST') {
      if (!requirePro(req, res, 'family-dashboard')) return;
      let body;
      try {
        body = await parseBody(req);
      } catch {
        return json(res, 400, { ok: false, error: 'invalid json' });
      }
      const saver = body && body.screensaver;
      const wx = body && body.weather;
      const hasSaver = saver && typeof saver === 'object';
      const hasWx = wx && typeof wx === 'object';
      if (!hasSaver && !hasWx) {
        return json(res, 400, { ok: false, error: 'screensaver or weather object required' });
      }
      // Same merge mechanics as /api/family/mqtt-tiles: deep-copy the raw
      // config, change ONLY the family sub-blocks we were given, save the
      // complete config.
      const next = JSON.parse(JSON.stringify(ctx.getRawCfg() || {}));
      next.family = (next.family && typeof next.family === 'object') ? next.family : {};
      if (hasSaver) {
        const timeoutSec = Number(saver.defaultTimeoutSec);
        if (!Number.isFinite(timeoutSec) || timeoutSec < 30 || timeoutSec > 7200) {
          return json(res, 400, { ok: false, error: 'defaultTimeoutSec must be 30..7200' });
        }
        // Merge: keep any extra screensaver fields (e.g. time windows) intact.
        next.family.screensaver = {
          ...(next.family.screensaver || {}),
          enabled: saver.enabled !== false,
          defaultTimeoutSec: Math.round(timeoutSec)
        };
      }
      if (hasWx) {
        const DETAILS = ['compact', 'normal', 'detailed'];
        const SIZES = ['sm', 'md', 'lg'];
        const detail = DETAILS.includes(wx.detail) ? wx.detail : 'normal';
        const size = SIZES.includes(wx.size) ? wx.size : 'md';
        next.family.weather = { ...(next.family.weather || {}), detail, size };
      }
      try {
        ctx.saveAndApplyConfig(next);
      } catch (e) {
        pushLog('family_settings_save_error', { error: e.message });
        return json(res, 500, { ok: false, error: 'save failed' });
      }
      pushLog('family_settings_saved', {
        ...(hasSaver ? { enabled: next.family.screensaver.enabled, defaultTimeoutSec: next.family.screensaver.defaultTimeoutSec } : {}),
        ...(hasWx ? { weatherDetail: next.family.weather.detail, weatherSize: next.family.weather.size } : {})
      }, actorContext(req));
      return json(res, 200, { ok: true, screensaver: next.family.screensaver || null, weather: next.family.weather || null });
    }

    // Family EV panel → evcc charge-mode switch (operator request #23).
    // Body: { loadpoint:<1-based id>, mode:'off'|'pv'|'minpv'|'now' }. Pro-gated
    // + LAN-trust (token-less kiosk under lanTrust='open'); the actual write goes
    // to evcc's REST API via the integration.
    if (url.pathname === '/api/family/evcc/mode' && req.method === 'POST') {
      if (!requirePro(req, res, 'family-dashboard')) return;
      let body;
      try {
        body = await parseBody(req);
      } catch {
        return json(res, 400, { ok: false, error: 'invalid json' });
      }
      if (!ctx.evccIntegration || typeof ctx.evccIntegration.setMode !== 'function') {
        return json(res, 503, { ok: false, error: 'evcc not available' });
      }
      const loadpoint = Number(body && body.loadpoint);
      const mode = String((body && body.mode) || '');
      const result = await ctx.evccIntegration.setMode(loadpoint, mode);
      if (!result || result.ok !== true) {
        return json(res, 400, result || { ok: false, error: 'mode set failed' });
      }
      pushLog('family_evcc_mode', { loadpoint, mode }, actorContext(req));
      return json(res, 200, result);
    }

    // Shelly relay on/off from the family dashboard (2026-06-17). Same Pro-gate
    // as the other /api/family/* control writes. Routes to the device service →
    // owning adapter's setOutput (Switch.Set RPC). Host was SSRF-validated at
    // device-config save time and again in the adapter constructor.
    if (url.pathname === '/api/family/device-output' && req.method === 'POST') {
      if (!requirePro(req, res, 'family-dashboard')) return;
      let body;
      try { body = await parseBody(req); }
      catch { return json(res, 400, { ok: false, error: 'invalid json' }); }
      if (!ctx.deviceService || typeof ctx.deviceService.setDeviceOutput !== 'function') {
        return json(res, 503, { ok: false, error: 'device_service_unavailable' });
      }
      const id = String((body && body.id) || '').slice(0, 64);
      const on = body && (body.on === true || body.on === 'true');
      if (!id) return json(res, 400, { ok: false, error: 'device_id_required' });
      const result = await ctx.deviceService.setDeviceOutput(id, on);
      if (!result || result.ok !== true) {
        return json(res, 400, result || { ok: false, error: 'toggle_failed' });
      }
      pushLog('family_device_output', { id, on: !!on, output: result.output }, actorContext(req));
      return json(res, 200, result);
    }

    if (url.pathname === '/api/family/mqtt-tiles' && req.method === 'GET') {
      if (!requirePro(req, res, 'family-dashboard')) return;
      const fam = ctx.getRawCfg?.()?.family;
      const tiles = (fam && Array.isArray(fam.mqttTiles)) ? fam.mqttTiles : [];
      return json(res, 200, { ok: true, tiles });
    }

    if (url.pathname === '/api/family/mqtt-tiles' && req.method === 'POST') {
      if (!requirePro(req, res, 'family-dashboard')) return;
      let body;
      try {
        body = await parseBody(req);
      } catch {
        return json(res, 400, { ok: false, error: 'invalid json' });
      }
      if (!body || !Array.isArray(body.tiles)) {
        return json(res, 400, { ok: false, error: 'tiles array required' });
      }
      if (body.tiles.length > 50) {
        return json(res, 400, { ok: false, error: 'too_many_tiles' });
      }
      // Plan 11-03 (D-01/D-03): the per-tile `icon` and `color` are curated —
      // the operator picks from a fixed emoji grid / 8-hex swatch palette
      // (11-UI-SPEC.md). The normaliser allowlist-clips both: an off-allowlist
      // or absent value leaves the key UNSET so the client auto-derives
      // (D-02/D-04). Colour hexes are stored VERBATIM (mixed case) — match the
      // allowlist case-exactly; never .toUpperCase()/.toLowerCase() the input.
      // Phase 11-04 (checkpoint feedback): the emoji grid was expanded from 28
      // to 48 glyphs (8×6). This Set MUST stay byte-identical to MTE_EMOJIS in
      // public/integrations.js or a newly-picked emoji is clipped off on save.
      const FAMILY_TILE_ICON_ALLOWLIST = new Set([
        '⚡', '🔋', '☀️', '🔌', '💡', '🏠', '🌡️', '🪫',
        '💧', '🔥', '❄️', '💨', '🌬️', '☁️', '🌧️', '🌀',
        '🪭', '🔆', '🕯️', '🌫️', '🌪️', '🫧', '♻️', '🧯',
        '🛋️', '🛏️', '🚪', '🚿', '🍳', '🧺', '🪟', '🛁',
        '🚰', '🚽', '☕', '🍽️', '🧊', '🧴', '🔔', '🪥',
        '🚗', '📡', '🖥️', '📺', '🔊', '🌿', '🐾', '💻',
      ]);
      const FAMILY_TILE_COLOR_ALLOWLIST = new Set([
        '#F7B731', '#26de81', '#4b7bec', '#22d3ee',
        '#a55eea', '#fd9644', '#ff6b6b', '#78909c',
      ]);
      // Normalize + validate. A topic is mandatory; id/label/field/unit are
      // length-clipped strings so a malformed payload cannot bloat config.json.
      const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
      const tiles = [];
      const seenIds = new Set();
      for (const raw of body.tiles) {
        if (!raw || typeof raw !== 'object') continue;
        const topic = clip(raw.topic, 256).trim();
        if (!topic) continue; // a tile without a topic is incomplete — drop it
        let id = clip(raw.id, 64).trim().replace(/[^a-zA-Z0-9_-]/g, '');
        if (!id || seenIds.has(id)) id = 't' + Date.now().toString(36) + tiles.length;
        seenIds.add(id);
        const tile = { id, label: clip(raw.label, 80).trim() || topic, topic };
        const field = clip(raw.field, 80).trim();
        const unit = clip(raw.unit, 16).trim();
        if (field) tile.field = field;
        if (unit) tile.unit = unit;
        // D-01/D-03 — additive optional: omit when absent OR off-allowlist so
        // the client falls through to the auto-derivation heuristic (D-02/D-04).
        const icon = clip(raw.icon, 16).trim();  // emoji can be multi-codepoint (VS/ZWJ) — clip generously
        const color = clip(raw.color, 9).trim(); // '#RRGGBB' = 7 chars; small slack
        if (icon && FAMILY_TILE_ICON_ALLOWLIST.has(icon)) tile.icon = icon;   // additive — omit if invalid
        if (color && FAMILY_TILE_COLOR_ALLOWLIST.has(color)) tile.color = color; // case-EXACT to UI-SPEC
        if (raw.enabled === false) tile.enabled = false;
        tiles.push(tile);
      }
      // Merge into the full raw config server-side — getRawCfg() is the
      // unredacted config, so saveAndApplyConfig (via restoreRedacted, a no-op
      // here) persists the COMPLETE config with only family.mqttTiles changed.
      const next = JSON.parse(JSON.stringify(ctx.getRawCfg() || {}));
      next.family = (next.family && typeof next.family === 'object') ? next.family : {};
      next.family.mqttTiles = tiles;
      try {
        ctx.saveAndApplyConfig(next);
      } catch (e) {
        pushLog('family_mqtt_tiles_save_error', { error: e.message });
        return json(res, 500, { ok: false, error: 'save failed' });
      }
      pushLog('family_mqtt_tiles_saved', { count: tiles.length }, actorContext(req));
      return json(res, 200, { ok: true, tiles });
    }

    // Plan 11-03 (D-14): per-tile value history for the family-dashboard
    // detail-panel "Verlauf heute" chart. Reads the timeseries_samples rows
    // the Plan 02 MQTT historisation hook writes under series_key
    // 'mqtt_tile_<tile.id>'. LAN-safe GET (token-less kiosk); external callers
    // still pass checkAuth. The `id` is clipped + pattern-restricted (V5) and
    // validated against the configured tiles (V4 — no series_key enumeration)
    // before any DB call; querySeries is fully parameterised (no SQL concat).
    if (url.pathname === '/api/family/tile-history' && req.method === 'GET') {
      if (!requirePro(req, res, 'family-dashboard')) return;
      if (!ctx.telemetryStore?.querySeries) {
        return json(res, 503, { ok: false, error: 'telemetry store not available' });
      }
      // V5: clip + pattern-restrict the id exactly like the tile-id normaliser.
      const id = String(url.searchParams.get('id') || '').slice(0, 64).replace(/[^a-zA-Z0-9_-]/g, '');
      if (!id) return json(res, 400, { ok: false, error: 'missing id' });
      // V4: id must match a configured tile — no arbitrary series_key enumeration.
      const tiles = (ctx.getRawCfg && ctx.getRawCfg()?.family?.mqttTiles) || [];
      const tile = Array.isArray(tiles) ? tiles.find(t => t && t.id === id) : null;
      if (!tile) return json(res, 404, { ok: false, error: 'unknown tile' });
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const end = new Date(start.getTime() + 86400000);
      try {
        // Rows are written at resolution_seconds=1 (Plan 02); maxResolution:900
        // returns every raw per-message sample for the today window.
        const rows = await ctx.telemetryStore.querySeries({
          seriesKeys: ['mqtt_tile_' + id],
          start,
          end,
          maxResolution: 900,
        });
        return json(res, 200, {
          ok: true,
          id,
          start: start.toISOString(),
          end: end.toISOString(),
          data: rows,
        });
      } catch (e) {
        pushLog('family_tile_history_error', { id, error: e.message });
        return json(res, 500, { ok: false, error: e.message });
      }
    }

    // GET /api/family/tesla-history — the EV detail-panel charge-history chart.
    // Plan 11-06 round 10. Sibling of /api/family/tile-history: a LAN-safe,
    // GET-only read route over the Tesla series Plan 11-06 round 8 historises
    // into timeseries_samples (source 'teslamate', keys tesla_<field>). The
    // series keys are a FIXED server-side allowlist — no request-controlled
    // series key — so there is no enumeration surface. The only request input
    // is `days`, clamped to 1..31; querySeries is fully parameterised and the
    // window is server-computed Date objects (no SQL concat, T-11-07).
    if (url.pathname === '/api/family/tesla-history' && req.method === 'GET') {
      if (!requirePro(req, res, 'family-dashboard')) return;
      if (!ctx.telemetryStore?.querySeries) {
        return json(res, 503, { ok: false, error: 'telemetry store not available' });
      }
      // Charge events are sparse (a car charges every few days, and Tesla
      // historisation only started recently) — default to a 7-day window.
      const rawDays = parseInt(url.searchParams.get('days'), 10);
      const days = Number.isFinite(rawDays) ? Math.max(1, Math.min(31, rawDays)) : 7;
      // Primary series = charge power; SoC included so the panel can show both.
      const seriesKeys = ['tesla_charger_power', 'tesla_battery_level'];
      const now = new Date();
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      const start = new Date(end.getTime() - days * 86400000);
      try {
        const rows = await ctx.telemetryStore.querySeries({
          seriesKeys,
          start,
          end,
          maxResolution: 900,
        });
        return json(res, 200, {
          ok: true,
          days,
          start: start.toISOString(),
          end: end.toISOString(),
          data: rows,
        });
      } catch (e) {
        pushLog('family_tesla_history_error', { error: e.message });
        return json(res, 500, { ok: false, error: e.message });
      }
    }

    // Phase 21 (2026-05-23): aggregated Tesla charge sessions for the
    // Teslamate drawer on /integrations. Groups raw `tesla_charger_power`
    // samples into contiguous sessions (gap > 10 min → new session) and
    // computes start/end timestamps, duration, peak/avg power, energy added
    // (trapezoidal integration of the power curve) and SoC start/end from
    // `tesla_battery_level` snapshots taken at session boundaries.
    if (url.pathname === '/api/family/tesla-sessions' && req.method === 'GET') {
      if (!requirePro(req, res, 'family-dashboard')) return;
      if (!ctx.telemetryStore?.querySeries) {
        return json(res, 503, { ok: false, error: 'telemetry store not available' });
      }
      const rawDays = parseInt(url.searchParams.get('days'), 10);
      const days = Number.isFinite(rawDays) ? Math.max(1, Math.min(31, rawDays)) : 7;
      const now = new Date();
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      const start = new Date(end.getTime() - days * 86400000);
      try {
        const rows = await ctx.telemetryStore.querySeries({
          seriesKeys: ['tesla_charger_power', 'tesla_battery_level'],
          start,
          end,
          maxResolution: 900,
        });
        // tesla_charger_power is stored in kW (TeslaMate `charger_power`, DB column
        // charger_power_kw) — convert to W up front so the W-based threshold and the
        // trapezoidal Wh integration below are correct. Bug 2026-06-13: the detector
        // treated the kW value as W, so a real ~11 kW charge (stored as 11) fell below
        // the 100 W threshold and NO sessions were ever built (operator report:
        // "Ladevorgänge leer obwohl ich geladen habe").
        const power = rows
          .filter(r => r.key === 'tesla_charger_power' && Number.isFinite(r.value))
          .map(r => ({ ...r, value: r.value * 1000 }));
        const soc = rows.filter(r => r.key === 'tesla_battery_level' && Number.isFinite(r.value));
        // Session detection: contiguous power ≥ 100 W. TeslaMate publishes
        // charger_power ON CHANGE, so a steady charge produces sparse samples
        // (minutes-to-tens-of-minutes apart) — use a 30 min gap so one charge is not
        // fragmented into many 1-sample sessions (which integrate to 0 Wh).
        const SESSION_GAP_MS = 30 * 60 * 1000;
        const SESSION_POWER_W = 100;
        const sessions = [];
        let cur = null;
        for (const p of power) {
          const ts = new Date(p.ts).getTime();
          if (!Number.isFinite(ts)) continue;
          const charging = p.value >= SESSION_POWER_W;
          if (charging) {
            if (!cur || (ts - cur.lastTs) > SESSION_GAP_MS) {
              if (cur) sessions.push(cur);
              cur = { startTs: ts, lastTs: ts, samples: [{ ts, w: p.value }], peakW: p.value };
            } else {
              cur.samples.push({ ts, w: p.value });
              cur.lastTs = ts;
              if (p.value > cur.peakW) cur.peakW = p.value;
            }
          } else if (cur && (ts - cur.lastTs) > SESSION_GAP_MS) {
            sessions.push(cur);
            cur = null;
          }
        }
        if (cur) sessions.push(cur);
        // Helper: find last SOC sample ≤ t, first sample ≥ t.
        function socAt(t, mode /* 'before' | 'after' */) {
          if (!soc.length) return null;
          if (mode === 'before') {
            let last = null;
            for (const s of soc) {
              const st = new Date(s.ts).getTime();
              if (st <= t) last = s.value;
              else break;
            }
            return last;
          }
          for (const s of soc) {
            const st = new Date(s.ts).getTime();
            if (st >= t) return s.value;
          }
          return null;
        }
        // Trapezoidal integration: ∫ P dt in Wh. Samples are spaced ~minutes
        // in practice, so this is more accurate than peak × duration.
        function integrateWh(samples) {
          if (samples.length < 2) return 0;
          let wh = 0;
          for (let i = 1; i < samples.length; i++) {
            const dtHours = (samples[i].ts - samples[i - 1].ts) / 3_600_000;
            wh += ((samples[i].w + samples[i - 1].w) / 2) * dtHours;
          }
          return wh;
        }
        const out = sessions.map((s) => {
          const durMs = s.lastTs - s.startTs;
          const wh = integrateWh(s.samples);
          const avgW = s.samples.length ? s.samples.reduce((a, x) => a + x.w, 0) / s.samples.length : 0;
          return {
            startTs: new Date(s.startTs).toISOString(),
            endTs: new Date(s.lastTs).toISOString(),
            durationMin: Math.round(durMs / 60000),
            energyKwh: Number((wh / 1000).toFixed(2)),
            peakPowerW: Math.round(s.peakW),
            avgPowerW: Math.round(avgW),
            socStartPct: socAt(s.startTs, 'before'),
            socEndPct: socAt(s.lastTs, 'after'),
            sampleCount: s.samples.length,
          };
        }).reverse(); // newest first
        return json(res, 200, { ok: true, days, sessions: out });
      } catch (e) {
        pushLog('family_tesla_sessions_error', { error: e.message });
        return json(res, 500, { ok: false, error: e.message });
      }
    }

    // Phase 21 (2026-05-23): dedicated merge endpoint for the Teslamate
    // drawer. Sibling of /api/family/mqtt-tiles — same merge-server-side
    // pattern to avoid the partial-POST-replaces-config trap (memory
    // feedback_config_save_replaces). Accepts {enabled, teslamateCarId,
    // snapshotIntervalSec, name}; everything else is ignored.
    if (url.pathname === '/api/family/tesla-config' && req.method === 'POST') {
      if (!checkAuth(req, res)) return;
      let body;
      try { body = await parseBody(req); }
      catch { return json(res, 400, { ok: false, error: 'invalid_json' }); }
      if (!body || typeof body !== 'object') {
        return json(res, 400, { ok: false, error: 'object_required' });
      }
      const next = JSON.parse(JSON.stringify(ctx.getRawCfg() || {}));
      next.integrations = (next.integrations && typeof next.integrations === 'object') ? next.integrations : {};
      const cur = (next.integrations.tesla && typeof next.integrations.tesla === 'object') ? next.integrations.tesla : {};
      const patch = { ...cur };
      if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
      if (Number.isFinite(body.teslamateCarId)) {
        patch.teslamateCarId = Math.max(1, Math.min(99, Math.floor(body.teslamateCarId)));
      }
      if (Number.isFinite(body.snapshotIntervalSec)) {
        patch.snapshotIntervalSec = Math.max(30, Math.min(3600, Math.floor(body.snapshotIntervalSec)));
      }
      if (typeof body.name === 'string') patch.name = String(body.name).slice(0, 64).trim() || 'Tesla';
      // Phase 21 (2026-05-23): optional topic-prefix override for non-default
      // TeslaMate deployments. Strip leading/trailing slashes + reject wildcard
      // chars; empty string clears the override (falls back to default).
      if (typeof body.topicPrefix === 'string') {
        const tp = body.topicPrefix.trim().replace(/^\/+|\/+$/g, '').replace(/[+#]/g, '');
        if (tp.length === 0) delete patch.topicPrefix;
        else patch.topicPrefix = tp.slice(0, 128);
      }
      next.integrations.tesla = patch;
      try {
        ctx.saveAndApplyConfig(next);
      } catch (e) {
        pushLog('family_tesla_config_save_error', { error: e.message });
        return json(res, 500, { ok: false, error: 'save failed' });
      }
      pushLog('family_tesla_config_saved', {
        enabled: patch.enabled,
        carId: patch.teslamateCarId,
        intervalSec: patch.snapshotIntervalSec,
      }, actorContext(req));
      return json(res, 200, { ok: true, tesla: patch });
    }

    // Phase 21 (2026-05-23): Shelly device-list editor for the integrations
    // drawer. Replaces the shelly-http slice of cfg.devices in one POST while
    // preserving mqtt-generic entries. SSRF guard mirrors the adapter's
    // PRIVATE_IP_RE — same regex on both sides so the operator gets a clear
    // 422 instead of a silent shelly_ssrf_blocked event on next start.
    if (url.pathname === '/api/family/shelly-devices' && req.method === 'GET') {
      if (!checkAuth(req, res)) return;
      const list = Array.isArray(getCfg().devices) ? getCfg().devices : [];
      return json(res, 200, { ok: true, devices: list.filter(d => d && d.adapter === 'shelly-http') });
    }
    if (url.pathname === '/api/family/shelly-devices' && req.method === 'POST') {
      if (!checkAuth(req, res)) return;
      let body;
      try { body = await parseBody(req); }
      catch { return json(res, 400, { ok: false, error: 'invalid_json' }); }
      if (!body || !Array.isArray(body.devices)) {
        return json(res, 400, { ok: false, error: 'devices_array_required' });
      }
      if (body.devices.length > 50) {
        return json(res, 400, { ok: false, error: 'too_many_devices' });
      }
      // Private-IP allowlist mirrors services/devices/adapters/shelly-http.js
      // (PRIVATE_IP_RE). Hostnames OTHER than `localhost` are rejected so a
      // resolver-based SSRF can't smuggle an external target through.
      const PRIVATE_IP_RE = /^(192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|127\.0\.0\.1|localhost)$/;
      const cleaned = [];
      const seenIds = new Set();
      const validationErrors = [];
      for (let i = 0; i < body.devices.length; i++) {
        const raw = body.devices[i];
        if (!raw || typeof raw !== 'object') continue;
        const name = String(raw.name || '').trim().slice(0, 80);
        const rawHost = String(raw.shelly?.host || raw.host || '').trim().slice(0, 128);
        const hostOnly = rawHost.replace(/:\d+$/, '');
        const poll = Number(raw.shelly?.pollIntervalSec || raw.pollIntervalSec);
        if (!name) { validationErrors.push(`Zeile ${i + 1}: Name fehlt`); continue; }
        if (!rawHost) { validationErrors.push(`Zeile ${i + 1}: Host fehlt`); continue; }
        if (!PRIVATE_IP_RE.test(hostOnly)) {
          validationErrors.push(`Zeile ${i + 1}: ${rawHost} ist keine private IP (SSRF-Schutz)`);
          continue;
        }
        let id = String(raw.id || '').trim().slice(0, 64).replace(/[^a-zA-Z0-9_-]/g, '');
        if (!id || seenIds.has(id)) id = 'shelly_' + Date.now().toString(36) + cleaned.length;
        seenIds.add(id);
        cleaned.push({
          id,
          name,
          adapter: 'shelly-http',
          enabled: raw.enabled !== false,
          shelly: {
            host: rawHost,
            pollIntervalSec: Number.isFinite(poll) ? Math.max(2, Math.min(3600, Math.floor(poll))) : 10
          }
        });
      }
      if (validationErrors.length) {
        return json(res, 422, { ok: false, error: 'validation_failed', details: validationErrors });
      }
      const next = JSON.parse(JSON.stringify(ctx.getRawCfg() || {}));
      const existing = Array.isArray(next.devices) ? next.devices : [];
      // Keep any non-shelly-http adapters untouched; replace only the shelly slice.
      next.devices = existing.filter(d => d && d.adapter !== 'shelly-http').concat(cleaned);
      let result;
      try { result = ctx.saveAndApplyConfig(next); }
      catch (e) {
        pushLog('family_shelly_save_error', { error: e.message });
        return json(res, 500, { ok: false, error: 'save failed' });
      }
      pushLog('family_shelly_saved', { count: cleaned.length, restartRequired: !!(result && result.restartRequired) }, actorContext(req));
      return json(res, 200, {
        ok: true,
        devices: cleaned,
        restartRequired: !!(result && result.restartRequired)
      });
    }

    // Phase 21 (2026-05-23): MQTT-hub broker configuration via the integrations
    // drawer. Sibling of /api/family/tesla-config — merge-server-side so a
    // partial body doesn't wipe other mqtt.* fields. Password follows the
    // canonical '***' = keep-existing / '' = clear contract (matching VRM).
    if (url.pathname === '/api/family/mqtt-config' && req.method === 'POST') {
      if (!checkAuth(req, res)) return;
      let body;
      try { body = await parseBody(req); }
      catch { return json(res, 400, { ok: false, error: 'invalid_json' }); }
      if (!body || typeof body !== 'object') {
        return json(res, 400, { ok: false, error: 'object_required' });
      }
      const next = JSON.parse(JSON.stringify(ctx.getRawCfg() || {}));
      const cur = (next.mqtt && typeof next.mqtt === 'object') ? next.mqtt : {};
      const patch = { ...cur };
      if (typeof body.brokerUrl === 'string') {
        const url2 = body.brokerUrl.trim();
        if (url2.length === 0) {
          delete patch.brokerUrl; // empty = clear; embedded broker takes over
        } else if (!/^mqtts?:\/\//i.test(url2)) {
          return json(res, 400, { ok: false, error: 'invalid_broker_url_scheme' });
        } else {
          patch.brokerUrl = url2.slice(0, 256);
        }
      }
      if (typeof body.username === 'string') {
        const u = body.username.trim().slice(0, 128);
        if (u) patch.username = u; else delete patch.username;
      }
      // Password contract: '' = clear, '***' = keep existing, anything else = new value.
      if (typeof body.password === 'string') {
        const p = body.password;
        if (p === '') delete patch.password;
        else if (p !== '***') patch.password = p.slice(0, 256);
      }
      if (typeof body.embedded === 'boolean') {
        patch.embeddedBroker = (patch.embeddedBroker && typeof patch.embeddedBroker === 'object') ? patch.embeddedBroker : {};
        patch.embeddedBroker.enabled = body.embedded;
        if (!Number.isFinite(patch.embeddedBroker.port)) patch.embeddedBroker.port = 1883;
      }
      if (typeof body.topicPrefix === 'string') {
        const tp = body.topicPrefix.trim().replace(/[+#\s]/g, '').slice(0, 64);
        if (tp) patch.topicPrefix = tp; else delete patch.topicPrefix;
      }
      next.mqtt = patch;
      let result;
      try {
        result = ctx.saveAndApplyConfig(next);
      } catch (e) {
        pushLog('family_mqtt_config_save_error', { error: e.message });
        return json(res, 500, { ok: false, error: 'save failed' });
      }
      pushLog('family_mqtt_config_saved', {
        brokerUrl: patch.brokerUrl ? redactUrlCreds(patch.brokerUrl) : null,
        embedded: !!(patch.embeddedBroker && patch.embeddedBroker.enabled),
        usernameSet: !!patch.username,
        passwordSet: !!patch.password,
        restartRequired: !!(result && result.restartRequired)
      }, actorContext(req));
      return json(res, 200, {
        ok: true,
        restartRequired: !!(result && result.restartRequired),
        mqtt: {
          brokerUrl: patch.brokerUrl ? redactUrlCreds(patch.brokerUrl) : '',
          embedded: !!(patch.embeddedBroker && patch.embeddedBroker.enabled),
          username: patch.username || '',
          passwordSet: !!patch.password,
          topicPrefix: patch.topicPrefix || 'dvhub'
        }
      });
    }

    // ──────────────────────────────────────────────────────────────────────
    // Phase 17 Plan 03: License management endpoints.
    // POST /api/license/activate   — operator submits a new key
    // GET  /api/license/state      — settings UI reads current status (redacted)
    // POST /api/license/revalidate — "Jetzt prüfen" — same code path as poller
    // POST /api/license/remove     — clear the local license record
    //
    // All four require checkAuth. The LAN_SAFE_ENDPOINTS allowlist above does
    // NOT include any /api/license/* path, so external callers must use
    // Bearer regardless of source IP (T-17-03-01 mitigation).
    //
    // GET /state NEVER returns the plaintext license_key — getState() in the
    // service redacts the field to null before return (T-17-03-02).
    // ──────────────────────────────────────────────────────────────────────
    if (url.pathname === '/api/license/activate' && req.method === 'POST') {
      if (!checkAuth(req, res)) return;
      let body;
      try { body = await parseBody(req); }
      catch { return json(res, 400, { ok: false, error: 'invalid_json' }); }
      const key = typeof body?.key === 'string' ? body.key.trim() : '';
      if (!key) return json(res, 400, { ok: false, error: 'empty_key' });
      const result = await licenseService.activateLicense(key);
      const code = result.ok
        ? 200
        : (result.error === 'server_error' || result.error === 'keygen_account_not_configured' ? 503 : 422);
      return json(res, code, result);
    }

    if (url.pathname === '/api/license/state' && req.method === 'GET') {
      if (!checkAuth(req, res)) return;
      return json(res, 200, licenseService.getState());
    }

    if (url.pathname === '/api/license/revalidate' && req.method === 'POST') {
      if (!checkAuth(req, res)) return;
      const result = await licenseService.revalidateLicense();
      const code = result.ok
        ? 200
        : (result.error === 'server_error'
            || result.error === 'keygen_account_not_configured'
            || result.error === 'no_license_active'
            ? 503 : 422);
      return json(res, code, result);
    }

    if (url.pathname === '/api/license/remove' && req.method === 'POST') {
      if (!checkAuth(req, res)) return;
      const result = licenseService.removeLicense();
      return json(res, 200, result);
    }

    // Stufe-C node-lock: bind the ACTIVE license to this appliance. Calls the
    // server activation proxy (licensing.activationProxyUrl → webhook.dvhub.de),
    // which mints a Keygen machine bound to this box's appliance-id and returns a
    // signed offline machine file; the service verifies it OFFLINE + asserts the
    // bound fingerprint == this appliance before persisting (activateNodeLock).
    // No body — binds the persisted key. Transport/proxy failures are 503 (state
    // unchanged, retryable); a crypto/binding failure is a hard 422.
    if (url.pathname === '/api/license/activate-node-lock' && req.method === 'POST') {
      if (!checkAuth(req, res)) return;
      const result = await licenseService.activateNodeLock();
      const code = result.ok
        ? 200
        : (result.error === 'server_error' || result.error === 'activation_proxy_not_configured' ? 503 : 422);
      return json(res, code, result);
    }

    // DASH-01: Family dashboard HTML (D-03 direct URL, D-02 no topbar/Kiosk feel)
    // Served via servePage so the filename 'family.html' stays inside publicDir.
    // Phase 17 Plan 04: license-gated. Without a Pro licence the page route
    // returns 403 {error:'pro_required', feature:'family-dashboard'} — the
    // top-nav lock badge + Pro-modal (Plan 17-05) handle the UX. The static
    // assets /family.js + /family.css are NOT individually gated — without the
    // gated /family page no browser loads them, and a raw curl returns inert JS
    // source (no application logic executes). Matches SPEC R-6 acceptance.
    if (url.pathname === '/family' && req.method === 'GET') {
      if (!requirePro(req, res, 'family-dashboard')) return;
      return servePage(res, 'family.html');
    }

    // Phase 24-04 (T-24-PRO-SHELL): a direct GET /family.html previously matched
    // NO route here → fell through to serveStatic → served public/family.html
    // RAW (path/MIME check only, no gate), bypassing the Pro-gate that /family
    // (above) and every /api/family/* route enforce. Gate the static shell with
    // the SAME requirePro guard, BEFORE the serveStatic fallback. The inert
    // assets /family.js + /family.css stay ungated (see the comment above the
    // /family route): without the gated shell no browser loads them, and a raw
    // curl returns inert source (no application logic runs).
    if (url.pathname === '/family.html' && req.method === 'GET') {
      if (!requirePro(req, res, 'family-dashboard')) return;
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
      // M-2 (Plan 16-03): split('/api/devices/')[1] keeps embedded slashes, so
      // `/api/devices/a/b` would yield deviceId='a/b'. A device id is a single
      // path segment — reject any id carrying a slash.
      if (deviceId.includes('/')) return json(res, 400, { ok: false, error: 'invalid_device_id' });
      const devices = ctx.deviceService?.getDevices() || [];
      const device = devices.find(d => d.id === deviceId);
      if (!device) return json(res, 404, { error: 'Device not found' });
      let history = [];
      if (ctx.db) {
        try {
          // LIMIT uses the DEVICE_HISTORY_ROW_LIMIT module constant (288 =
          // 24h of 5-min readings). It is a trusted compile-time integer, not
          // user input — safe to interpolate; device_id stays parameterised.
          const result = await ctx.db.query(
            `SELECT ts_utc, power_w, energy_today_wh, online FROM device_readings WHERE device_id = $1 ORDER BY ts_utc DESC LIMIT ${DEVICE_HISTORY_ROW_LIMIT}`,
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
          topicCount: ctx.mqttPublisher?.topicCount ?? 0,
          // Phase 21 (2026-05-23): operator-settable knobs for the MQTT drawer.
          // brokerUrl is echoed verbatim (without password — redactUrlCreds);
          // username is plain text; passwordSet is a boolean (never the value).
          config: {
            brokerUrl: mqttCfg.brokerUrl ? redactUrlCreds(mqttCfg.brokerUrl) : '',
            embedded: !!(mqttCfg.embeddedBroker && mqttCfg.embeddedBroker.enabled),
            username: mqttCfg.username || '',
            passwordSet: !!mqttCfg.password,
            topicPrefix: mqttCfg.topicPrefix || 'dvhub'
          }
        },
        tesla: {
          enabled: getCfg().integrations?.tesla?.enabled ?? false,
          state: ctx.teslamateService?.getState() || null,
          lastUpdate: ctx.teslamateService?.lastUpdateAt || null,
          broker: mqttCfg.brokerUrl ? redactUrlCreds(mqttCfg.brokerUrl) : 'embedded',
          subscriptionTopic: ctx.teslamateService?.getSubscriptionTopic?.() || null,
          config: { name: getCfg().integrations?.tesla?.name || 'Tesla', teslamateCarId: getCfg().integrations?.tesla?.teslamateCarId ?? 1, snapshotIntervalSec: getCfg().integrations?.tesla?.snapshotIntervalSec ?? 300, topicPrefix: getCfg().integrations?.tesla?.topicPrefix || 'teslamate/cars' }
        },
        homeAssistant: {
          haDiscovery: mqttCfg.haDiscovery?.enabled ?? false,
          topicsPublished: ctx.mqttPublisher?.topicCount ?? 0
        },
        // Phase 09.4 D-09 — victron/mid/luox identity (Wave-3 hybrid-card header).
        // Every field `|| null` (D-02 graceful-degrade). Only host (LAN IP),
        // modelId, serial, firmware — non-secret identity (threat T-09.4-05).
        victron: {
          host: getCfg().victron?.host || null,
          modelId: getCfg().victron?.modelId || null,
          firmware: ctx.healthTracker?.snapshot?.()?.victron?.firmware || null
        },
        // MID grid meter (#23 follow-up 2026-06-13). The configurable Modbus
        // connection lives at cfg.meter (host/port/unitId/address); cfg.mid keeps
        // optional identity (serial). configured = a Modbus meter host is set.
        mid: (() => {
          const m = getCfg().meter || {};
          return {
            serial: getCfg().mid?.serial || getCfg().mid?.serialNumber || null,
            host: m.host || null,
            port: m.port ?? null,
            unitId: m.unitId ?? null,
            address: m.address ?? null,
            configured: !!m.host,
            firmware: ctx.healthTracker?.snapshot?.()?.mid?.firmware || null
          };
        })(),
        dveos: (() => {
          // DV-EOS fork optimizer status (non-blocking — no live ping here; the
          // dedicated /api/integrations/dveos GET does the reachability check).
          const opt = getCfg().optimizer || {};
          const primarySource = opt.primarySource || 'internal';
          const enabled = !!(opt.eosProxy && opt.eosProxy.enabled);
          return {
            enabled,
            primarySource,
            active: enabled && (primarySource === 'eos' || primarySource === 'best'),
            url: (opt.eosProxy && opt.eosProxy.url) || ''
          };
        })(),
        luox: {
          identifier: getCfg().luox?.identifier || getCfg().luox?.host || null,
          firmware: ctx.healthTracker?.snapshot?.()?.luox?.firmware || null
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
          // Phase 09.4 D-06: list ALL configured providers (incl. disabled) with an enabled flag.
          // Phase 09.4 gap-closure: 'uptime-kuma' is no longer a notification
          // provider (it duplicated the `monitoring` block) — filter out any
          // stale config entry so it never re-appears as a provider badge.
          providers: Object.entries(getCfg().notifications?.providers || {})
            .filter(([name]) => name !== 'uptime-kuma')
            .map(([name, v]) => ({ name, enabled: !!v.enabled }))
        },
        // Phase 20-05 (D-08, T-20-05-02): VRM credentials payload feeding the
        // /integrations VRM conn-card. NEVER emit the raw vrmToken — the UI
        // only needs the boolean vrmTokenSet for the status-detection switch.
        vrm: {
          enabled: !!(getCfg().telemetry?.historyImport?.enabled),
          vrmPortalId: getCfg().telemetry?.historyImport?.vrmPortalId || null,
          vrmTokenSet: !!(getCfg().telemetry?.historyImport?.vrmToken)
        },
        // Phase 20-06 (D-09, T-20-06-01): per-provider booleans feeding the
        // Forecast-Provider Sammelkarte. NEVER emit raw apiKey OR siteId —
        // the UI only needs the boolean *Set markers + nowcastEnabled flag.
        // Aggregated card consumes these via getSystemStatus('forecast-providers')
        // and buildIdentityLine('forecast-providers'). Payload key MUST match
        // SYSTEMS[*].key in integrations.js (kebab-case to match the conn-card's
        // data-system="forecast-providers" attribute) so renderAll's data[sys.key]
        // lookup resolves the subtree (#20-VERIFICATION gap 1).
        'forecast-providers': {
          solcast: {
            enabled: !!(getCfg().forecast?.solcast?.enabled),
            apiKeySet: !!(getCfg().forecast?.solcast?.apiKey),
            siteIdSet: !!(getCfg().forecast?.solcast?.siteId)
          },
          pvnode: {
            // pvnode has no schema enabled flag — derive from apiKey presence.
            enabled: !!(getCfg().forecast?.pvnode?.apiKey),
            apiKeySet: !!(getCfg().forecast?.pvnode?.apiKey),
            siteIdSet: !!(getCfg().forecast?.pvnode?.siteId),
            nowcastEnabled: !!(getCfg().forecast?.pvnode?.nowcastEnabled)
          }
        },
        // EVCC wallbox (#23, 2026-06-13). Card consumes this via
        // getSystemStatus('evcc') + buildStats('evcc'). reachable/loadpointCount
        // come from the live integration poll (never a secret).
        evcc: (() => {
          const es = ctx.evccIntegration?.getStatus?.() || {};
          const lps = Array.isArray(es.loadpoints) ? es.loadpoints : [];
          return {
            enabled: !!(getCfg().evcc?.enabled),
            url: getCfg().evcc?.url || null,
            reachable: lps.length > 0,
            loadpointCount: lps.length,
            dashboardLoadpoint: getCfg().evcc?.dashboardLoadpoint ?? null,
            lastError: es.lastError || null
          };
        })()
      };
      return json(res, 200, payload);
    }

    // GET /api/integrations/health — all-in-one per-system health response
    // (Phase 09.2 D-17 revised). Bearer auth required from any source — NOT
    // in LAN_SAFE_ENDPOINTS (T-09.2-AUTHZ): per-system telemetry topology +
    // last-sample timestamps are reconnaissance-relevant. Featured-Row is
    // Victron-only (D-19 revised — see CONTEXT.md; we use an external direct
    // marketer rather than direct EPEX trading). 5-second cache (D-18).
    if (url.pathname === '/api/integrations/health' && req.method === 'GET') {
      // checkAuth has already run (any non-LAN-safe /api/* path goes through
      // the gate at line ~1383). Proceed straight to cache check.
      const now = Date.now();
      if (healthCacheEntry && healthCacheEntry.expiresAt > now) {
        return json(res, 200, healthCacheEntry.payload);
      }
      try {
        const trackerSnap = ctx.healthTracker?.snapshot?.() || {};
        // Victron heartbeat = seconds since last sample. Null when the tracker
        // has no Victron entry yet (boot, before first poll).
        const victronSnap = trackerSnap.victron;
        let heartbeatSec = null;
        if (victronSnap && victronSnap.lastSampleAt) {
          const ageMs = now - new Date(victronSnap.lastSampleAt).getTime();
          if (Number.isFinite(ageMs) && ageMs >= 0) heartbeatSec = Math.round(ageMs / 1000);
        }
        // Featured-Row payload — Victron-only per D-19 revised.
        // No LUOX revenue / bid-count / EEG-uplift / activation-age fields
        // (the source table required for those metrics does not exist —
        // see CONTEXT.md D-19 revised). Wave-0 test 5 enforces the absence.
        const featured = {
          victronHeartbeatSec: heartbeatSec,
          victronEssMode: state.meter?.essMode ?? state.essMode ?? null,
        };
        const payload = { ...trackerSnap, featured };
        healthCacheEntry = { payload, expiresAt: now + HEALTH_CACHE_TTL_MS };
        return json(res, 200, payload);
      } catch (e) {
        pushLog('integrations_health_error', { error: e.message });
        return json(res, 500, { ok: false, error: e.message });
      }
    }

    // GET /api/integrations/mqtt/topics — live inbound topic registry (Phase 09.4 D-05).
    // LAN-safe GET like /integrations/health; the topic-observer subscribes to '#'
    // and maintains an in-memory Map. No TTL cache — the Inspector drawer wants
    // live data and the Map read is cheap. `connected` distinguishes "MQTT off"
    // from "no topics yet" (RESEARCH Pitfall 7).
    if (url.pathname === '/api/integrations/mqtt/topics' && req.method === 'GET') {
      const topics = ctx.mqttTopicObserver?.getTopics?.() || [];
      return json(res, 200, {
        connected: ctx.mqttHub?.connected ?? false,
        observedSince: ctx.mqttTopicObserver?.observedSince ?? null,
        total: topics.length,
        topics
      });
    }

    // === Phase 20-01: dedicated ntfy endpoints (D-12 server-side merge) ===
    // GET / POST / POST-test live here, adjacent to the legacy combined endpoint
    // below. Migration plan: 20-02..06 add Telegram/Pushover/Uptime-Kuma/VRM/
    // Solcast/pvnode counterparts; the legacy endpoint stays until 20-06 is
    // closed (kept for shape-stability and a deprecation window).
    if (url.pathname === '/api/notifications/providers/ntfy' && req.method === 'GET') {
      if (!checkAuth(req, res)) return;
      const raw = ctx.getRawCfg?.() || {};
      const ntfy = raw.notifications?.providers?.ntfy || {};
      return json(res, 200, {
        ok: true,
        enabled: !!ntfy.enabled,
        topicUrl: ntfy.topicUrl || '',
        token: ntfy.token ? '***' : ''     // D-13: redacted, never raw
      });
    }

    if (url.pathname === '/api/notifications/providers/ntfy' && req.method === 'POST') {
      if (!checkAuth(req, res)) return;
      let body;
      try { body = await parseBody(req); }
      catch { return json(res, 400, { ok: false, error: 'invalid json' }); }
      if (!body || typeof body !== 'object') {
        return json(res, 400, { ok: false, error: 'object required' });
      }
      const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
      const next = JSON.parse(JSON.stringify(ctx.getRawCfg() || {}));
      next.notifications = (next.notifications && typeof next.notifications === 'object') ? next.notifications : {};
      next.notifications.providers = (next.notifications.providers && typeof next.notifications.providers === 'object')
        ? next.notifications.providers : {};
      const prev = next.notifications.providers.ntfy || {};
      // D-13 '***' sentinel: keep existing token.
      const token = (body.token === '***') ? (prev.token || '') : clip(body.token, 256);
      next.notifications.providers.ntfy = {
        enabled: !!body.enabled,
        topicUrl: clip(body.topicUrl, 512),
        ...(token ? { token: token } : {})
      };
      try {
        ctx.saveAndApplyConfig(next);
      } catch (e) {
        pushLog('ntfy_provider_save_error', { error: e.message });
        return json(res, 500, { ok: false, error: 'save failed' });
      }
      pushLog('ntfy_provider_saved', {
        enabled: !!body.enabled,
        topicUrlSet: !!body.topicUrl,
        tokenSet: !!token
      }, actorContext(req));
      return json(res, 200, { ok: true });
    }

    if (url.pathname === '/api/notifications/providers/ntfy/test' && req.method === 'POST') {
      if (!checkAuth(req, res)) return;
      let body;
      try { body = await parseBody(req); }
      catch { return json(res, 400, { ok: false, error: 'invalid json' }); }

      // Pitfall 2: empty form value means "use stored". Same '***' sentinel
      // semantics applied to the TEST path.
      const stored = ctx.getRawCfg?.().notifications?.providers?.ntfy || {};
      const topicUrl = (body?.topicUrl && body.topicUrl !== '***') ? body.topicUrl : (stored.topicUrl || '');
      const token = (body?.token && body.token !== '***') ? body.token : (stored.token || '');
      if (!topicUrl) return json(res, 400, { ok: false, error: 'missing_topicurl' });

      // 5/min per (provider, token-hash). When no token, hash the URL so the
      // bucket key is still stable per-config.
      const rl = checkProviderRateLimit('ntfy', token || topicUrl);
      if (!rl.ok) return json(res, 429, { ok: false, error: 'rate_limited', retry_after_s: rl.retry_after_s });

      try {
        const { createNtfyProvider } = await import('./services/notifications/providers/ntfy.js');
        const provider = createNtfyProvider({ topicUrl, token });
        const result = await provider.notify({
          level: 'info',
          title: 'DVhub Test',
          body: 'Test-Nachricht von DVhub — ' + new Date().toISOString()
        });
        pushLog('notification_test_send', { provider: 'ntfy', ok: result.ok, error: result.error }, actorContext(req));
        return json(res, result.ok ? 200 : 502, result);
      } catch (e) {
        pushLog('notification_test_send_error', { provider: 'ntfy', error: e.message });
        return json(res, 500, { ok: false, error: e.message });
      }
    }

    // === Phase 20-02: Telegram dedicated endpoints (D-12 server-side-merge; D-13 redaction) ===
    if (url.pathname === '/api/notifications/providers/telegram' && req.method === 'GET') {
      if (!checkAuth(req, res)) return;
      const raw = ctx.getRawCfg?.() || {};
      const tg = raw.notifications?.providers?.telegram || {};
      return json(res, 200, {
        ok: true,
        enabled: !!tg.enabled,
        // D-13 + Pitfall 9: both botToken AND chatId are in REDACTED_PATHS.
        // Emit '***' when set, '' when unset; UI shows placeholder
        // "leer lassen = unverändert" when empty.
        botToken: tg.botToken ? '***' : '',
        chatId: tg.chatId ? '***' : ''
      });
    }

    if (url.pathname === '/api/notifications/providers/telegram' && req.method === 'POST') {
      if (!checkAuth(req, res)) return;
      let body;
      try { body = await parseBody(req); }
      catch { return json(res, 400, { ok: false, error: 'invalid json' }); }
      if (!body || typeof body !== 'object') {
        return json(res, 400, { ok: false, error: 'object required' });
      }
      const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
      const next = JSON.parse(JSON.stringify(ctx.getRawCfg() || {}));
      next.notifications = (next.notifications && typeof next.notifications === 'object') ? next.notifications : {};
      next.notifications.providers = (next.notifications.providers && typeof next.notifications.providers === 'object')
        ? next.notifications.providers : {};
      const prev = next.notifications.providers.telegram || {};
      // D-13 '***' sentinel applied to BOTH botToken AND chatId.
      const botToken = (body.botToken === '***') ? (prev.botToken || '') : clip(body.botToken, 256);
      const chatId   = (body.chatId   === '***') ? (prev.chatId   || '') : clip(body.chatId,   64);
      next.notifications.providers.telegram = {
        enabled: !!body.enabled,
        ...(botToken ? { botToken } : {}),
        ...(chatId   ? { chatId   } : {})
      };
      try {
        ctx.saveAndApplyConfig(next);
      } catch (e) {
        pushLog('telegram_provider_save_error', { error: e.message });
        return json(res, 500, { ok: false, error: 'save failed' });
      }
      pushLog('telegram_provider_saved', {
        enabled: !!body.enabled,
        botTokenSet: !!botToken,
        chatIdSet: !!chatId
      }, actorContext(req));
      return json(res, 200, { ok: true });
    }

    if (url.pathname === '/api/notifications/providers/telegram/test' && req.method === 'POST') {
      if (!checkAuth(req, res)) return;
      let body;
      try { body = await parseBody(req); }
      catch { return json(res, 400, { ok: false, error: 'invalid json' }); }

      // Pitfall 2: empty form value means "use stored". Same '***' sentinel
      // semantics applied to the TEST path.
      const stored = ctx.getRawCfg?.().notifications?.providers?.telegram || {};
      const botToken = (body?.botToken && body.botToken !== '***') ? body.botToken : (stored.botToken || '');
      const chatId   = (body?.chatId   && body.chatId   !== '***') ? body.chatId   : (stored.chatId   || '');
      if (!botToken || !chatId) return json(res, 400, { ok: false, error: 'missing_credentials' });

      // 5/min per (provider, token-hash). Hash the bot token for the bucket key.
      const rl = checkProviderRateLimit('telegram', botToken);
      if (!rl.ok) return json(res, 429, { ok: false, error: 'rate_limited', retry_after_s: rl.retry_after_s });

      try {
        const { createTelegramProvider } = await import('./services/notifications/providers/telegram.js');
        const provider = createTelegramProvider({ botToken, chatId });
        const result = await provider.notify({
          level: 'info',
          title: 'DVhub Test',
          body: 'Test-Nachricht von DVhub — ' + new Date().toISOString()
        });
        pushLog('notification_test_send', { provider: 'telegram', ok: result.ok, error: result.error }, actorContext(req));
        return json(res, result.ok ? 200 : 502, result);
      } catch (e) {
        pushLog('notification_test_send_error', { provider: 'telegram', error: e.message });
        return json(res, 500, { ok: false, error: e.message });
      }
    }

    // === Phase 20-03: Pushover dedicated endpoints (D-12 server-side-merge; D-13 redaction) ===
    if (url.pathname === '/api/notifications/providers/pushover' && req.method === 'GET') {
      if (!checkAuth(req, res)) return;
      const raw = ctx.getRawCfg?.() || {};
      const po = raw.notifications?.providers?.pushover || {};
      return json(res, 200, {
        ok: true,
        enabled: !!po.enabled,
        // D-13 + T-20-03-01: appToken AND userKey are in REDACTED_PATHS.
        // Emit '***' when set, '' when unset; UI shows placeholder
        // "leer lassen = unverändert" when empty.
        appToken: po.appToken ? '***' : '',
        userKey: po.userKey ? '***' : ''
      });
    }

    if (url.pathname === '/api/notifications/providers/pushover' && req.method === 'POST') {
      if (!checkAuth(req, res)) return;
      let body;
      try { body = await parseBody(req); }
      catch { return json(res, 400, { ok: false, error: 'invalid json' }); }
      if (!body || typeof body !== 'object') {
        return json(res, 400, { ok: false, error: 'object required' });
      }
      const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
      const next = JSON.parse(JSON.stringify(ctx.getRawCfg() || {}));
      next.notifications = (next.notifications && typeof next.notifications === 'object') ? next.notifications : {};
      next.notifications.providers = (next.notifications.providers && typeof next.notifications.providers === 'object')
        ? next.notifications.providers : {};
      const prev = next.notifications.providers.pushover || {};
      // D-13 '***' sentinel applied to BOTH appToken AND userKey.
      // Length clip = 64 (Pushover spec = 30 chars; generous bound, parallel to
      // telegram chatId clip).
      const appToken = (body.appToken === '***') ? (prev.appToken || '') : clip(body.appToken, 64);
      const userKey  = (body.userKey  === '***') ? (prev.userKey  || '') : clip(body.userKey,  64);
      next.notifications.providers.pushover = {
        enabled: !!body.enabled,
        ...(appToken ? { appToken } : {}),
        ...(userKey  ? { userKey  } : {})
      };
      try {
        ctx.saveAndApplyConfig(next);
      } catch (e) {
        pushLog('pushover_provider_save_error', { error: e.message });
        return json(res, 500, { ok: false, error: 'save failed' });
      }
      pushLog('pushover_provider_saved', {
        enabled: !!body.enabled,
        appTokenSet: !!appToken,
        userKeySet: !!userKey
      }, actorContext(req));
      return json(res, 200, { ok: true });
    }

    if (url.pathname === '/api/notifications/providers/pushover/test' && req.method === 'POST') {
      if (!checkAuth(req, res)) return;
      let body;
      try { body = await parseBody(req); }
      catch { return json(res, 400, { ok: false, error: 'invalid json' }); }

      // Pitfall 2: empty form value means "use stored". Same '***' sentinel
      // semantics applied to the TEST path.
      const stored = ctx.getRawCfg?.().notifications?.providers?.pushover || {};
      const appToken = (body?.appToken && body.appToken !== '***') ? body.appToken : (stored.appToken || '');
      const userKey  = (body?.userKey  && body.userKey  !== '***') ? body.userKey  : (stored.userKey  || '');
      if (!appToken || !userKey) return json(res, 400, { ok: false, error: 'missing_credentials' });

      // 5/min per (provider, token-hash). Hash the app token for the bucket key.
      const rl = checkProviderRateLimit('pushover', appToken);
      if (!rl.ok) return json(res, 429, { ok: false, error: 'rate_limited', retry_after_s: rl.retry_after_s });

      try {
        const { createPushoverProvider } = await import('./services/notifications/providers/pushover.js');
        const provider = createPushoverProvider({ appToken, userKey });
        // T-20-03-04 escalation guard: HARD-CODED level: 'info' (priority 0).
        // pushover.js maps level === 'critical' → priority:1 (urgent, bypasses
        // operator's Pushover quiet hours); test-sends must stay non-urgent
        // regardless of what the operator submits via body.
        const result = await provider.notify({
          level: 'info',
          title: 'DVhub Test',
          body: 'Test-Nachricht von DVhub — ' + new Date().toISOString()
        });
        pushLog('notification_test_send', { provider: 'pushover', ok: result.ok, error: result.error }, actorContext(req));
        return json(res, result.ok ? 200 : 502, result);
      } catch (e) {
        pushLog('notification_test_send_error', { provider: 'pushover', error: e.message });
        return json(res, 500, { ok: false, error: e.message });
      }
    }

    // === Phase 20-04: Uptime-Kuma dedicated endpoints (D-12 server-side-merge) ===
    // KRITISCH: writes to cfg.monitoring.* — NEVER cfg.notifications.providers.uptime-kuma
    // (Pitfall 1 — Phase 09.4 gap-closure cleaned that up; the heartbeat code in
    // server.js:1442-1496 reads ONLY cfg.monitoring.{pushUrl,pushIntervalSec,signingKey},
    // so writing to notifications.providers.uptime-kuma would create a dead-config
    // branch that the UI shows but the heartbeat ignores). saveAndApplyConfig
    // already triggers startMonitoringHeartbeat() reload (server.js:411).
    if (url.pathname === '/api/integrations/uptime-kuma' && req.method === 'GET') {
      if (!checkAuth(req, res)) return;
      const raw = ctx.getRawCfg?.() || {};
      const mon = raw.monitoring || {};
      return json(res, 200, {
        ok: true,
        enabled: !!mon.enabled,
        // pushUrl emitted in clear per Phase 09.4-06 decision (the path-token
        // is operator-set, never historically redacted, and operator needs to
        // see which monitor their heartbeat writes to). config-redaction.js
        // does not list monitoring.pushUrl in REDACTED_PATHS — consistent.
        pushUrl: mon.pushUrl || '',
        pushIntervalSec: typeof mon.pushIntervalSec === 'number' ? mon.pushIntervalSec : 240
      });
    }

    if (url.pathname === '/api/integrations/uptime-kuma' && req.method === 'POST') {
      if (!checkAuth(req, res)) return;
      let body;
      try { body = await parseBody(req); }
      catch { return json(res, 400, { ok: false, error: 'invalid json' }); }
      if (!body || typeof body !== 'object') {
        return json(res, 400, { ok: false, error: 'object required' });
      }
      const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
      const pushUrl = clip(body.pushUrl, 512);
      // SSRF guard at save-time (defence in depth — T-20-04-01). Only enforced
      // when the integration is being enabled WITH a URL — allows operator to
      // disable Kuma without erasing the stored URL (Pitfall: validation
      // would otherwise reject a now-disabled-but-still-stored URL).
      if (body.enabled && pushUrl && !isAllowedHeartbeatUrl(pushUrl)) {
        return json(res, 400, { ok: false, error: 'invalid_url' });
      }
      // Server-side clamp [30, 600] per T-20-04-07 — operator-friendly (UI
      // also enforces min=30 max=600 attrs); reject would force a re-type.
      const interval = Math.max(30, Math.min(600, Number(body.pushIntervalSec) || 240));
      const next = JSON.parse(JSON.stringify(ctx.getRawCfg() || {}));
      next.monitoring = (next.monitoring && typeof next.monitoring === 'object') ? next.monitoring : {};
      next.monitoring.enabled = !!body.enabled;
      next.monitoring.pushUrl = pushUrl;
      next.monitoring.pushIntervalSec = interval;
      try {
        // saveAndApplyConfig() in server.js calls startMonitoringHeartbeat()
        // which reads the new monitoring.* values, so no extra reload needed.
        ctx.saveAndApplyConfig(next);
      } catch (e) {
        pushLog('uptime_kuma_save_error', { error: e.message });
        return json(res, 500, { ok: false, error: 'save failed' });
      }
      pushLog('uptime_kuma_saved', {
        enabled: !!body.enabled,
        pushUrlSet: !!pushUrl,
        interval
      }, actorContext(req));
      return json(res, 200, { ok: true });
    }

    if (url.pathname === '/api/integrations/uptime-kuma/test' && req.method === 'POST') {
      if (!checkAuth(req, res)) return;
      let body;
      try { body = await parseBody(req); }
      catch { return json(res, 400, { ok: false, error: 'invalid json' }); }

      const cfg = ctx.getRawCfg?.() || {};
      const stored = cfg.monitoring || {};
      // Pitfall 2 + Pitfall 5 combined: prefer the operator's typed (unsaved)
      // URL, fall back to the stored one. This is why we do NOT use
      // ctx.monitoringAlertPush — that helper closes over the saved URL only.
      const pushUrl = (body?.pushUrl && String(body.pushUrl).trim()) || stored.pushUrl || '';
      if (!pushUrl) return json(res, 400, { ok: false, error: 'kuma_no_push_url' });

      // Rate-limit per-pushUrl (the URL token IS the credential). 5/min via
      // the shared checkProviderRateLimit utility.
      const rl = checkProviderRateLimit('uptime-kuma', pushUrl);
      if (!rl.ok) return json(res, 429, { ok: false, error: 'rate_limited', retry_after_s: rl.retry_after_s });

      // Mirror what server.js startMonitoringHeartbeat reads — same payload shape.
      // signingKey is stored under monitoring.signingKey; missing key → 'unsigned'
      // header (Kuma ignores it, that's fine for the basic push endpoint).
      const signingKey = cfg.monitoring?.signingKey || '';
      const hostname = cfg.hostname || cfg.identity?.hostname || 'dvhub';
      const appVersion = ctx.getAppVersion?.()?.version || process.env.DVHUB_VERSION || 'unknown';

      const result = await kumaPushOnce({
        pushUrl,
        msg: 'DVhub Test — ' + new Date().toISOString(),
        signingKey,
        hostname,
        appVersion,
        status: 'up'
      });
      pushLog('kuma_test_push', { ok: result.ok, error: result.error }, actorContext(req));
      return json(res, result.ok ? 200 : (result.error === 'invalid_url' ? 400 : 502), result);
    }

    // === Phase 20-05: VRM credential endpoints (D-06/D-12) ===
    // Consumes the Phase 18-05 backend single-source cfg.telemetry.historyImport.*.
    // GET emits '***' for vrmToken (D-13 — never the raw value); POST does a
    // dedicated server-side merge into telemetry.historyImport to avoid the
    // POST /api/config foot-gun (which would overwrite the whole config root).
    // '***' = keep-existing; empty string (or missing) = explicit delete-path
    // for the stored vrmToken (T-20-05-05).
    if (url.pathname === '/api/integrations/vrm' && req.method === 'GET') {
      if (!checkAuth(req, res)) return;
      const raw = ctx.getRawCfg?.() || {};
      const h = raw.telemetry?.historyImport || {};
      return json(res, 200, {
        ok: true,
        enabled: !!h.enabled,
        vrmPortalId: h.vrmPortalId || '',
        vrmToken: h.vrmToken ? '***' : ''     // D-13 — never raw
      });
    }

    if (url.pathname === '/api/integrations/vrm' && req.method === 'POST') {
      if (!checkAuth(req, res)) return;
      let body;
      try { body = await parseBody(req); }
      catch { return json(res, 400, { ok: false, error: 'invalid json' }); }
      if (!body || typeof body !== 'object') {
        return json(res, 400, { ok: false, error: 'object required' });
      }
      const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
      const next = JSON.parse(JSON.stringify(ctx.getRawCfg() || {}));
      next.telemetry = (next.telemetry && typeof next.telemetry === 'object') ? next.telemetry : {};
      next.telemetry.historyImport = (next.telemetry.historyImport && typeof next.telemetry.historyImport === 'object')
        ? next.telemetry.historyImport : {};
      const prev = next.telemetry.historyImport;
      // '***' sentinel: keep existing (T-20-05-05). Empty string (or non-'***'
      // empty): explicit delete via the branch below.
      const token = (body.vrmToken === '***')
        ? (prev.vrmToken || '')
        : clip(body.vrmToken, 512);
      next.telemetry.historyImport.enabled = !!body.enabled;
      // WR-03: only claim the provider slot when actually enabling the import.
      // Setting unconditionally would silently overwrite an operator's choice
      // of a future second history-import provider (e.g. Solcast backfill) on
      // every "Credentials entfernen" click.
      if (body.enabled) {
        next.telemetry.historyImport.provider = 'vrm';
      }
      next.telemetry.historyImport.vrmPortalId = clip(body.vrmPortalId, 64);
      if (token) {
        next.telemetry.historyImport.vrmToken = token;
      } else {
        delete next.telemetry.historyImport.vrmToken;
      }
      try {
        ctx.saveAndApplyConfig(next);
      } catch (e) {
        pushLog('vrm_credentials_save_error', { error: e.message });
        return json(res, 500, { ok: false, error: 'save failed' });
      }
      pushLog('vrm_credentials_saved', {
        enabled: !!body.enabled,
        portalIdSet: !!body.vrmPortalId,
        tokenSet: !!token
      }, actorContext(req));
      return json(res, 200, { ok: true });
    }

    // === MID grid-meter config (operator request 2026-06-13) ===
    // Configured on the Integrations page (sibling of /api/integrations/vrm).
    // Writes the Modbus meter connection to cfg.meter (host/port/unitId/address/
    // quantity/fc) + the sign convention cfg.gridPositiveMeans. NOTE: when the
    // transport is Venus-MQTT the meter is read from MQTT and cfg.meter is not
    // polled — this config takes effect for a direct Modbus meter.
    if (url.pathname === '/api/integrations/mid' && req.method === 'GET') {
      if (!checkAuth(req, res)) return;
      // Meter-source selector (2026-06-13). The grid meter can come from the
      // manufacturer profile (mode='profile', register map from
      // hersteller/<manufacturer>.json — read-only here) OR from an
      // operator-supplied endpoint (mode='modbus'|'mqtt'|'http', persisted in the
      // non-managed cfg.meterSource root). profileMeter mirrors the effective
      // profile meter for the read-only 'profile' view.
      const cfg = getCfg();
      const raw = ctx.getRawCfg?.() || {};
      const m = cfg.meter || {};
      const ms = raw.meterSource || {};
      const msModbus = ms.modbus || {};
      const msMqtt = ms.mqtt || {};
      const msHttp = ms.http || {};
      return json(res, 200, {
        ok: true,
        manufacturer: raw.manufacturer || 'victron',
        manufacturers: listManufacturerProfiles(ctx),
        mode: ['profile', 'modbus', 'mqtt', 'http'].includes(ms.mode) ? ms.mode : 'profile',
        name: ms.label || '',
        gridPositiveMeans: cfg.gridPositiveMeans || 'feed_in',
        // Read-only profile meter (mode='profile').
        profileMeter: {
          host: m.host || '', port: m.port ?? 502, unitId: m.unitId ?? 1,
          address: m.address ?? 0, quantity: m.quantity ?? 3, fc: m.fc ?? 3
        },
        profileManaged: !!m.host,
        meterOk: !!ctx.state?.meter?.ok,
        // Operator-supplied meter endpoints.
        modbus: {
          host: msModbus.host || '', port: msModbus.port ?? 502, unitId: msModbus.unitId ?? 1,
          address: msModbus.address ?? 0, quantity: msModbus.quantity ?? 3, fc: msModbus.fc ?? 3
        },
        mqtt: {
          topicL1: msMqtt.topicL1 || '', topicL2: msMqtt.topicL2 || '',
          topicL3: msMqtt.topicL3 || '', topicTotal: msMqtt.topicTotal || ''
        },
        http: { url: msHttp.url || '', jsonPath: msHttp.jsonPath || '' }
      });
    }

    // DV-EOS fork optimizer status — live reachability ping via the inspector
    // adapter (ctx.eosAdapter.isAvailable hits EOS /v1/health, 5s timeout). Read
    // model only; the EOS engine config lives in EOSdash. (Operator request
    // 2026-06-13: a dedicated card for her DV-EOS fork, not the stock EOS.)
    if (url.pathname === '/api/integrations/dveos' && req.method === 'GET') {
      if (!checkAuth(req, res)) return;
      const opt = getCfg().optimizer || {};
      const primarySource = opt.primarySource || 'internal';
      const enabled = !!(opt.eosProxy && opt.eosProxy.enabled);
      let reachable = false;
      if (enabled) {
        try { reachable = !!(await ctx.eosAdapter?.isAvailable?.()); }
        catch { reachable = false; }
      }
      return json(res, 200, {
        ok: true,
        enabled,
        primarySource,
        active: enabled && (primarySource === 'eos' || primarySource === 'best'),
        url: (opt.eosProxy && opt.eosProxy.url) || '',
        reachable,
        eosdashUrl: '/eosdash/'
      });
    }

    if (url.pathname === '/api/integrations/mid' && req.method === 'POST') {
      if (!checkAuth(req, res)) return;
      let body;
      try { body = await parseBody(req); }
      catch { return json(res, 400, { ok: false, error: 'invalid json' }); }
      if (!body || typeof body !== 'object') {
        return json(res, 400, { ok: false, error: 'object required' });
      }
      const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
      const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
      const next = JSON.parse(JSON.stringify(ctx.getRawCfg() || {}));

      // Manufacturer profile selection. Validate against the actual hersteller/
      // folder so an unknown value can never brick the profile load on reload.
      if (typeof body.manufacturer === 'string' && body.manufacturer.trim()) {
        const wanted = body.manufacturer.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
        const known = listManufacturerProfiles(ctx).map((x) => x.value);
        if (wanted && (known.includes(wanted) || wanted === 'victron')) next.manufacturer = wanted;
      }

      // Meter-source selector — persisted under the non-managed meterSource root.
      const mode = ['profile', 'modbus', 'mqtt', 'http'].includes(body.mode) ? body.mode : 'profile';
      const ms = (next.meterSource && typeof next.meterSource === 'object') ? next.meterSource : {};
      ms.mode = mode;
      if (typeof body.name === 'string') ms.label = str(body.name, 64);
      const inModbus = (body.modbus && typeof body.modbus === 'object') ? body.modbus : {};
      ms.modbus = {
        host: str(inModbus.host, 128),
        port: Math.min(65535, Math.max(1, num(inModbus.port, 502))),
        unitId: Math.min(255, Math.max(0, num(inModbus.unitId, 1))),
        address: Math.max(0, num(inModbus.address, 0)),
        quantity: Math.min(125, Math.max(1, num(inModbus.quantity, 3))),
        fc: (num(inModbus.fc, 3) === 4) ? 4 : 3,
        timeoutMs: Math.min(10000, Math.max(100, num(inModbus.timeoutMs, 1200)))
      };
      const inMqtt = (body.mqtt && typeof body.mqtt === 'object') ? body.mqtt : {};
      ms.mqtt = {
        topicL1: str(inMqtt.topicL1, 256), topicL2: str(inMqtt.topicL2, 256),
        topicL3: str(inMqtt.topicL3, 256), topicTotal: str(inMqtt.topicTotal, 256)
      };
      const inHttp = (body.http && typeof body.http === 'object') ? body.http : {};
      ms.http = { url: str(inHttp.url, 512), jsonPath: str(inHttp.jsonPath, 128) };
      next.meterSource = ms;

      if (body.gridPositiveMeans === 'grid_import' || body.gridPositiveMeans === 'feed_in') {
        next.gridPositiveMeans = body.gridPositiveMeans;
      }
      try {
        ctx.saveAndApplyConfig(next);
      } catch (e) {
        pushLog('mid_config_save_error', { error: e.message });
        return json(res, 500, { ok: false, error: 'save failed' });
      }
      pushLog('mid_config_saved', { mode, manufacturer: next.manufacturer, gridPositiveMeans: next.gridPositiveMeans }, actorContext(req));
      return json(res, 200, { ok: true });
    }

    // === Victron Wechselrichter / Anlage config (operator request 2026-06-13) ===
    // Surfaces the Einstellungen→Anlage block on the Victron card. Editable per
    // appliance: manufacturer (validated vs the hersteller/ folder), victron.host
    // (Anlagenadresse), pvCoupling. Transport/port/unitId/mqtt + the register map
    // are MANUFACTURER_MANAGED (come from hersteller/<manufacturer>.json) → shown
    // read-only. The full inverter-register editor stays future work.
    if (url.pathname === '/api/integrations/victron' && req.method === 'GET') {
      if (!checkAuth(req, res)) return;
      const cfg = getCfg();
      const raw = ctx.getRawCfg?.() || {};
      const v = cfg.victron || {};
      const snap = ctx.healthTracker?.snapshot?.()?.victron || {};
      let heartbeatSec = null;
      if (snap.lastSampleAt) {
        const ageMs = Date.now() - new Date(snap.lastSampleAt).getTime();
        if (Number.isFinite(ageMs) && ageMs >= 0) heartbeatSec = Math.round(ageMs / 1000);
      }
      const regSummary = (obj) => Object.keys(obj || {})
        .filter((k) => k !== 'enabled' && k !== 'negativePriceProtection' && obj[k] && typeof obj[k] === 'object')
        .map((k) => ({ name: k, address: obj[k].address != null ? obj[k].address : null }));
      const meter = cfg.meter || {};
      return json(res, 200, {
        ok: true,
        manufacturer: raw.manufacturer || 'victron',
        manufacturers: listManufacturerProfiles(ctx),
        host: v.host || '',
        pvCoupling: cfg.pvCoupling || 'ac_dc',
        transport: v.transport || 'modbus',
        port: v.port ?? 502,
        unitId: v.unitId ?? 100,
        mqttBroker: v.mqtt?.broker || '',
        mqttPortalId: v.mqtt?.portalId || '',
        modelId: v.modelId || null,
        firmware: snap.firmware || null,
        meterOk: !!ctx.state?.meter?.ok,
        heartbeatSec,
        registers: {
          meter: { fc: meter.fc ?? null, address: meter.address ?? null, quantity: meter.quantity ?? null },
          read: regSummary(cfg.points),
          write: regSummary(cfg.controlWrite)
        }
      });
    }

    if (url.pathname === '/api/integrations/victron' && req.method === 'POST') {
      if (!checkAuth(req, res)) return;
      let body;
      try { body = await parseBody(req); }
      catch { return json(res, 400, { ok: false, error: 'invalid json' }); }
      if (!body || typeof body !== 'object') {
        return json(res, 400, { ok: false, error: 'object required' });
      }
      const next = JSON.parse(JSON.stringify(ctx.getRawCfg() || {}));
      if (typeof body.manufacturer === 'string' && body.manufacturer.trim()) {
        const wanted = body.manufacturer.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
        const known = listManufacturerProfiles(ctx).map((x) => x.value);
        if (wanted && (known.includes(wanted) || wanted === 'victron')) next.manufacturer = wanted;
      }
      if (typeof body.host === 'string') {
        next.victron = (next.victron && typeof next.victron === 'object') ? next.victron : {};
        next.victron.host = body.host.trim().slice(0, 128);
      }
      if (body.pvCoupling === 'ac_dc' || body.pvCoupling === 'ac' || body.pvCoupling === 'dc') {
        next.pvCoupling = body.pvCoupling;
      }
      try {
        ctx.saveAndApplyConfig(next);
      } catch (e) {
        pushLog('victron_config_save_error', { error: e.message });
        return json(res, 500, { ok: false, error: 'save failed' });
      }
      pushLog('victron_config_saved', {
        manufacturer: next.manufacturer,
        hostSet: !!(next.victron && next.victron.host),
        pvCoupling: next.pvCoupling
      }, actorContext(req));
      return json(res, 200, { ok: true });
    }

    // === Home Assistant MQTT-Discovery config (operator request 2026-06-13) ===
    // Brings the (previously dead) HA card alive: enable/disable discovery, set the
    // discovery prefix, and resync WITHOUT a restart (ctx.republishHaDiscovery /
    // ctx.clearHaDiscovery, wired in server.js). DVhub then appears as one "DVhub"
    // device in HA with all its sensors (services/mqtt/ha-discovery.js).
    if (url.pathname === '/api/integrations/homeassistant' && req.method === 'GET') {
      if (!checkAuth(req, res)) return;
      const raw = ctx.getRawCfg?.() || {};
      const ha = raw.mqtt?.haDiscovery || {};
      const haMqttCfg = getCfg().mqtt || {};
      return json(res, 200, {
        ok: true,
        enabled: !!ha.enabled,
        prefix: ha.prefix || 'homeassistant',
        topicPrefix: raw.mqtt?.topicPrefix || 'dvhub',
        entityCount: haDiscoveryEntityCount(),
        deviceName: 'DVhub',
        mqttConnected: !!ctx.mqttHub?.connected,
        // The broker DVhub publishes to — HA must use the SAME broker for
        // auto-discovery. 'embedded' = DVhub's built-in broker (no external one).
        broker: haMqttCfg.brokerUrl ? redactUrlCreds(haMqttCfg.brokerUrl) : 'embedded',
        canResync: typeof ctx.republishHaDiscovery === 'function'
      });
    }

    if (url.pathname === '/api/integrations/homeassistant' && req.method === 'POST') {
      if (!checkAuth(req, res)) return;
      let body;
      try { body = await parseBody(req); }
      catch { return json(res, 400, { ok: false, error: 'invalid json' }); }
      if (!body || typeof body !== 'object') {
        return json(res, 400, { ok: false, error: 'object required' });
      }
      const next = JSON.parse(JSON.stringify(ctx.getRawCfg() || {}));
      next.mqtt = (next.mqtt && typeof next.mqtt === 'object') ? next.mqtt : {};
      next.mqtt.haDiscovery = (next.mqtt.haDiscovery && typeof next.mqtt.haDiscovery === 'object') ? next.mqtt.haDiscovery : {};
      const prevPrefix = next.mqtt.haDiscovery.prefix || 'homeassistant';
      const wasEnabled = !!next.mqtt.haDiscovery.enabled;
      if (typeof body.enabled === 'boolean') next.mqtt.haDiscovery.enabled = body.enabled;
      if (typeof body.prefix === 'string' && body.prefix.trim()) {
        next.mqtt.haDiscovery.prefix = (body.prefix.trim().replace(/[^a-zA-Z0-9_\-/]/g, '').slice(0, 64)) || 'homeassistant';
      }
      if (typeof body.topicPrefix === 'string' && body.topicPrefix.trim()) {
        next.mqtt.topicPrefix = (body.topicPrefix.trim().replace(/[^a-zA-Z0-9_\-/]/g, '').slice(0, 64)) || 'dvhub';
      }
      try {
        ctx.saveAndApplyConfig(next);
      } catch (e) {
        pushLog('ha_discovery_save_error', { error: e.message });
        return json(res, 500, { ok: false, error: 'save failed' });
      }
      // Apply to MQTT live: republish on enable (also acts as "Resync"), clear on
      // disable. If the prefix changed while enabled, clear the OLD prefix first
      // so HA drops the entities under the old prefix instead of keeping ghosts.
      let published = 0;
      try {
        const nowEnabled = !!next.mqtt.haDiscovery.enabled;
        const nowPrefix = next.mqtt.haDiscovery.prefix || 'homeassistant';
        if (wasEnabled && (!nowEnabled || nowPrefix !== prevPrefix) && typeof ctx.clearHaDiscovery === 'function') {
          ctx.clearHaDiscovery(prevPrefix);
        }
        if (nowEnabled && typeof ctx.republishHaDiscovery === 'function') {
          published = ctx.republishHaDiscovery() || 0;
        }
      } catch (e) {
        pushLog('ha_discovery_apply_error', { error: e.message });
      }
      pushLog('ha_discovery_saved', { enabled: !!next.mqtt.haDiscovery.enabled, prefix: next.mqtt.haDiscovery.prefix, published }, actorContext(req));
      return json(res, 200, { ok: true, enabled: !!next.mqtt.haDiscovery.enabled, published });
    }

    // === EVCC integration config (operator request #23, 2026-06-13) ===
    // Configured on the Integrations page (sibling of /api/integrations/vrm).
    // cfg.evcc.{url, enabled (battery-protect), dashboardLoadpoint}. GET also
    // returns the live loadpoint list + reachability so the page can populate
    // the loadpoint picker. POST does a dedicated server-side merge (never the
    // POST /api/config foot-gun).
    if (url.pathname === '/api/integrations/evcc' && req.method === 'GET') {
      if (!checkAuth(req, res)) return;
      const raw = ctx.getRawCfg?.() || {};
      const e = raw.evcc || {};
      const status = ctx.evccIntegration?.getStatus?.() || {};
      return json(res, 200, {
        ok: true,
        enabled: !!e.enabled,
        url: e.url || '',
        dashboardLoadpoint: e.dashboardLoadpoint ?? null,
        reachable: Array.isArray(status.loadpoints) && status.loadpoints.length > 0,
        lastError: status.lastError || null,
        lastPolledAt: status.lastPolledAt || null,
        loadpoints: Array.isArray(status.loadpoints) ? status.loadpoints : []
      });
    }

    if (url.pathname === '/api/integrations/evcc' && req.method === 'POST') {
      if (!checkAuth(req, res)) return;
      let body;
      try { body = await parseBody(req); }
      catch { return json(res, 400, { ok: false, error: 'invalid json' }); }
      if (!body || typeof body !== 'object') {
        return json(res, 400, { ok: false, error: 'object required' });
      }
      if (typeof body.url === 'string' && body.url.trim() && !/^https?:\/\//i.test(body.url.trim())) {
        return json(res, 400, { ok: false, error: 'url must be http(s)://…' });
      }
      let lp = null;
      if (body.dashboardLoadpoint != null && body.dashboardLoadpoint !== '') {
        lp = Number(body.dashboardLoadpoint);
        if (!Number.isInteger(lp) || lp < 1 || lp > 64) {
          return json(res, 400, { ok: false, error: 'dashboardLoadpoint must be 1..64' });
        }
      }
      const next = JSON.parse(JSON.stringify(ctx.getRawCfg() || {}));
      next.evcc = (next.evcc && typeof next.evcc === 'object') ? next.evcc : {};
      next.evcc.enabled = !!body.enabled;
      next.evcc.url = String(body.url == null ? (next.evcc.url || '') : body.url).trim().slice(0, 256);
      next.evcc.dashboardLoadpoint = lp;
      try {
        ctx.saveAndApplyConfig(next);
      } catch (e) {
        pushLog('evcc_config_save_error', { error: e.message });
        return json(res, 500, { ok: false, error: 'save failed' });
      }
      pushLog('evcc_config_saved', {
        enabled: next.evcc.enabled,
        urlSet: !!next.evcc.url,
        dashboardLoadpoint: next.evcc.dashboardLoadpoint
      }, actorContext(req));
      return json(res, 200, {
        ok: true,
        enabled: next.evcc.enabled,
        url: next.evcc.url,
        dashboardLoadpoint: next.evcc.dashboardLoadpoint
      });
    }

    // === Phase 20-06: Solcast credential endpoints (D-09/D-10/D-12) ===
    // Consumes cfg.forecast.solcast.{enabled, apiKey, siteId}. GET emits '***'
    // for apiKey (D-13 — never raw); siteId is emitted in clear (D-10 — not a
    // secret, just a Rooftop-Site UUID). POST does a dedicated server-side
    // merge to avoid the POST /api/config foot-gun. '***' = keep-existing
    // (T-20-06-07); empty string (or missing) = explicit delete-path.
    if (url.pathname === '/api/forecast/providers/solcast' && req.method === 'GET') {
      if (!checkAuth(req, res)) return;
      const raw = ctx.getRawCfg?.() || {};
      const s = raw.forecast?.solcast || {};
      return json(res, 200, {
        ok: true,
        enabled: !!s.enabled,
        apiKey: s.apiKey ? '***' : '',      // D-13 — never raw
        siteId: s.siteId || ''              // D-10 — NOT a secret, emitted in clear
      });
    }

    if (url.pathname === '/api/forecast/providers/solcast' && req.method === 'POST') {
      if (!checkAuth(req, res)) return;
      let body;
      try { body = await parseBody(req); }
      catch { return json(res, 400, { ok: false, error: 'invalid json' }); }
      if (!body || typeof body !== 'object') {
        return json(res, 400, { ok: false, error: 'object required' });
      }
      const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
      const next = JSON.parse(JSON.stringify(ctx.getRawCfg() || {}));
      next.forecast = (next.forecast && typeof next.forecast === 'object') ? next.forecast : {};
      next.forecast.solcast = (next.forecast.solcast && typeof next.forecast.solcast === 'object')
        ? next.forecast.solcast : {};
      const prev = next.forecast.solcast;
      // '***' sentinel: keep existing (T-20-06-07). Empty: delete via branch below.
      const apiKey = (body.apiKey === '***')
        ? (prev.apiKey || '')
        : clip(body.apiKey, 256);
      // body.enabled === undefined → preserve previous; otherwise coerce to bool.
      next.forecast.solcast.enabled = (body.enabled === undefined) ? !!prev.enabled : !!body.enabled;
      next.forecast.solcast.siteId = clip(body.siteId, 64);
      if (apiKey) {
        next.forecast.solcast.apiKey = apiKey;
      } else {
        delete next.forecast.solcast.apiKey;
      }
      try {
        ctx.saveAndApplyConfig(next);
      } catch (e) {
        pushLog('solcast_save_error', { error: e.message });
        return json(res, 500, { ok: false, error: 'save failed' });
      }
      pushLog('solcast_saved', {
        enabled: next.forecast.solcast.enabled,
        apiKeySet: !!apiKey,
        siteIdSet: !!next.forecast.solcast.siteId
      }, actorContext(req));
      return json(res, 200, { ok: true });
    }

    if (url.pathname === '/api/forecast/providers/solcast/probe' && req.method === 'POST') {
      if (!checkAuth(req, res)) return;
      let body;
      try { body = await parseBody(req); }
      catch { return json(res, 400, { ok: false, error: 'invalid json' }); }
      const stored = ctx.getRawCfg?.()?.forecast?.solcast || {};
      // Body apiKey wins; '***' or empty → fall back to stored ('***' keep-existing
      // semantics consistent with the save path).
      const apiKey = (body && body.apiKey && body.apiKey !== '***') ? body.apiKey : (stored.apiKey || '');
      const siteId = (body && body.siteId) || stored.siteId || '';
      if (!apiKey || !siteId) return json(res, 400, { ok: false, error: 'missing_credentials' });
      // T-20-06-03: per-provider 5/min rate-limit (separate from per-IP) so a
      // misconfigured form can't burn the 10/day Solcast quota in one minute.
      const rl = checkProviderRateLimit('solcast', apiKey);
      if (!rl.ok) return json(res, 429, { ok: false, error: 'rate_limited', retry_after_s: rl.retry_after_s });
      try {
        const { probeSolcast } = await import('./services/forecast/solcast-client.js');
        const result = await probeSolcast({ apiKey, siteId });
        pushLog('forecast_provider_probe', {
          provider: 'solcast', ok: result.ok, error: result.error
        }, actorContext(req));
        return json(res, result.ok ? 200 : 502, result);
      } catch (e) {
        pushLog('forecast_provider_probe_error', { provider: 'solcast', error: e.message });
        return json(res, 500, { ok: false, error: e.message });
      }
    }

    // === Phase 20-06: pvnode credential endpoints (D-09/D-10/D-12) ===
    // Consumes cfg.forecast.pvnode.{apiKey, nowcastEnabled}. pvnode has no
    // explicit `enabled` flag in the schema — the production client treats
    // "apiKey present" as enabled, so we mirror that on GET.
    if (url.pathname === '/api/forecast/providers/pvnode' && req.method === 'GET') {
      if (!checkAuth(req, res)) return;
      const raw = ctx.getRawCfg?.() || {};
      const p = raw.forecast?.pvnode || {};
      return json(res, 200, {
        ok: true,
        enabled: !!p.apiKey,                // derived (no schema enabled flag)
        apiKey: p.apiKey ? '***' : '',      // D-13 — never raw
        plan: p.plan || 'free',             // V2 subscription tier (drives fetch window/quota/horizon)
        siteId: p.siteId || '',             // V2 saved-site id (empty = inline mode)
        forecastDays: (p.forecastDays != null ? p.forecastDays : ''), // V2 horizon (1..7; '' = default 2)
        nowcastEnabled: !!p.nowcastEnabled
      });
    }

    if (url.pathname === '/api/forecast/providers/pvnode' && req.method === 'POST') {
      if (!checkAuth(req, res)) return;
      let body;
      try { body = await parseBody(req); }
      catch { return json(res, 400, { ok: false, error: 'invalid json' }); }
      if (!body || typeof body !== 'object') {
        return json(res, 400, { ok: false, error: 'object required' });
      }
      const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
      const next = JSON.parse(JSON.stringify(ctx.getRawCfg() || {}));
      next.forecast = (next.forecast && typeof next.forecast === 'object') ? next.forecast : {};
      next.forecast.pvnode = (next.forecast.pvnode && typeof next.forecast.pvnode === 'object')
        ? next.forecast.pvnode : {};
      const prev = next.forecast.pvnode;
      const apiKey = (body.apiKey === '***')
        ? (prev.apiKey || '')
        : clip(body.apiKey, 256);
      const siteId = clip(body.siteId, 128).trim();
      // V2 subscription plan — drives fetch window / monthly quota / horizon
      // (pvnode-plans.js). Unknown/empty → 'free' (safest, lowest limits).
      const PVNODE_PLAN_IDS = ['free', 'light', 'plus', 'enterprise'];
      const plan = PVNODE_PLAN_IDS.includes(String(body.plan || '').toLowerCase())
        ? String(body.plan).toLowerCase() : 'free';
      // V2 forecast horizon (days): '' / invalid → unset (client defaults to 2); else clamp 1..7.
      let forecastDays = null;
      if (body.forecastDays !== '' && body.forecastDays != null) {
        const n = Math.floor(Number(body.forecastDays));
        if (Number.isFinite(n)) forecastDays = Math.max(1, Math.min(7, n));
      }
      next.forecast.pvnode.nowcastEnabled = !!body.nowcastEnabled;
      next.forecast.pvnode.plan = plan;
      if (apiKey) {
        next.forecast.pvnode.apiKey = apiKey;
      } else {
        delete next.forecast.pvnode.apiKey;
      }
      if (siteId) {
        next.forecast.pvnode.siteId = siteId;
      } else {
        delete next.forecast.pvnode.siteId;
      }
      if (forecastDays != null) {
        next.forecast.pvnode.forecastDays = forecastDays;
      } else {
        delete next.forecast.pvnode.forecastDays;
      }
      try {
        ctx.saveAndApplyConfig(next);
      } catch (e) {
        pushLog('pvnode_save_error', { error: e.message });
        return json(res, 500, { ok: false, error: 'save failed' });
      }
      pushLog('pvnode_saved', {
        apiKeySet: !!apiKey,
        siteIdSet: !!siteId,
        plan,
        forecastDays: forecastDays ?? 'default',
        nowcastEnabled: next.forecast.pvnode.nowcastEnabled
      }, actorContext(req));
      return json(res, 200, { ok: true });
    }

    if (url.pathname === '/api/forecast/providers/pvnode/probe' && req.method === 'POST') {
      if (!checkAuth(req, res)) return;
      let body;
      try { body = await parseBody(req); }
      catch { return json(res, 400, { ok: false, error: 'invalid json' }); }
      const cfg = ctx.getRawCfg?.() || {};
      const stored = cfg.forecast?.pvnode || {};
      const apiKey = (body && body.apiKey && body.apiKey !== '***') ? body.apiKey : (stored.apiKey || '');
      if (!apiKey) return json(res, 400, { ok: false, error: 'missing_apikey' });
      // Geometry source: cfg.forecast.location.{latitude,longitude} is the
      // canonical pvnode-client lookup (with sma-automation fallback). For the
      // probe we read the same source; slope/orientation come from the LARGEST
      // configured pvPlant (highest kwp), or fall back to sensible defaults
      // (south-facing 30° tilt). This keeps the probe representative of the
      // production fetch geometry.
      const lat = Number(
        cfg.forecast?.location?.latitude
        ?? cfg.schedule?.smallMarketAutomation?.location?.latitude
        ?? 48.5
      );
      const lon = Number(
        cfg.forecast?.location?.longitude
        ?? cfg.schedule?.smallMarketAutomation?.location?.longitude
        ?? 9.5
      );
      let slope = 30;
      let orientation = 180;
      let kwp = 1;
      const plants = Array.isArray(cfg.userEnergyPricing?.pvPlants) ? cfg.userEnergyPricing.pvPlants : [];
      // Largest configured plane wins for a representative probe.
      const biggest = plants
        .filter(p => Number(p?.kwp) > 0
          && Number.isFinite(Number(p?.tiltDeg))
          && Number.isFinite(Number(p?.azimuthDeg)))
        .sort((a, b) => Number(b.kwp) - Number(a.kwp))[0];
      if (biggest) {
        slope = Number(biggest.tiltDeg);
        orientation = Number(biggest.azimuthDeg);
        kwp = Number(biggest.kwp);
      }
      // V2: prefer a saved-site probe when a siteId is configured (or typed); else
      // an inline single-string probe from the lat/lon/geometry above.
      const siteId = (body && typeof body.siteId === 'string' && body.siteId.trim())
        ? body.siteId.trim()
        : (stored.siteId || '');
      const rl = checkProviderRateLimit('pvnode', apiKey);
      if (!rl.ok) return json(res, 429, { ok: false, error: 'rate_limited', retry_after_s: rl.retry_after_s });
      try {
        const { probePvnode } = await import('./services/forecast/pvnode-client.js');
        const result = await probePvnode({ apiKey, siteId, lat, lon, slope, orientation, kwp });
        pushLog('forecast_provider_probe', {
          provider: 'pvnode', ok: result.ok, error: result.error
        }, actorContext(req));
        return json(res, result.ok ? 200 : 502, result);
      } catch (e) {
        pushLog('forecast_provider_probe_error', { provider: 'pvnode', error: e.message });
        return json(res, 500, { ok: false, error: e.message });
      }
    }

    // Phase 21 (2026-05-23): EOS-Akkudoktor PV-forecast read-back. EOS hosts
    // its own PVForecastAkkudoktor provider locally — this endpoint fetches
    // its current series and returns the first non-zero sample so the
    // operator can sanity-check it against Solcast/pvnode. Read-only — no
    // config writes; the EOS provider is configured INSIDE EOSdash.
    if (url.pathname === '/api/forecast/providers/eos-akkudoktor/probe' && req.method === 'POST') {
      if (!checkAuth(req, res)) return;
      const eosUrl = ctx.getRawCfg?.()?.optimizer?.eosProxy?.url || 'http://127.0.0.1:8503';
      try {
        const reqUrl2 = new URL('/v1/prediction/series?key=pvforecast_ac_power', eosUrl);
        const fetchRes = await fetch(reqUrl2.toString(), { signal: AbortSignal.timeout(8000) });
        if (!fetchRes.ok) {
          return json(res, 502, { ok: false, error: 'eos_http_' + fetchRes.status });
        }
        const data = await fetchRes.json();
        const series = (data && data.data && typeof data.data === 'object') ? data.data : {};
        // Pick the first sample whose timestamp is >= now (skips back-fill
        // history); fall back to the absolute first if nothing future.
        const now = Date.now();
        const entries = Object.entries(series)
          .map(([ts, w]) => ({ ts, ms: Date.parse(ts), watts: Number(w) }))
          .filter(e => Number.isFinite(e.ms) && Number.isFinite(e.watts));
        const future = entries.filter(e => e.ms >= now);
        const sample = future.length ? future[0] : (entries[0] || null);
        const slotCount = entries.length;
        return json(res, 200, {
          ok: true,
          provider: 'eos-akkudoktor',
          slotCount,
          sample: sample ? { ts: sample.ts, watts: Math.round(sample.watts) } : null
        });
      } catch (e) {
        pushLog('forecast_provider_probe_error', { provider: 'eos-akkudoktor', error: e.message });
        return json(res, 502, { ok: false, error: e.message || 'eos_unreachable' });
      }
    }

    // GET /api/integrations/notification-providers — ntfy provider + Uptime Kuma
    // config for the editor page (Phase 09.4 D-07/D-08; gap-closure Gap 3).
    // Gap 3: the Uptime Kuma section now reflects the `monitoring` block
    // (monitoring.pushUrl + monitoring.pushIntervalSec) — the SINGLE Kuma
    // integration — NOT a duplicate notifications.providers.uptime-kuma. The
    // Kuma monitor URL is emitted in clear: the operator must see which monitor
    // their heartbeat writes to, and it is LAN-trust appliance config (consistent
    // with config-redaction.js, which leaves the monitoring.pushUrl path-token
    // intact). The ntfy bearer token IS a true secret and stays redacted as '***'.
    // NOT in LAN_SAFE_ENDPOINTS: the POST is a config
    // WRITE and must require Bearer auth (both verbs share the gate).
    if (url.pathname === '/api/integrations/notification-providers' && req.method === 'GET') {
      const raw = ctx.getRawCfg?.() || {};
      const provs = raw.notifications?.providers || {};
      const ntfy = provs.ntfy || {};
      const monitoring = raw.monitoring || {};
      return json(res, 200, {
        ok: true,
        ntfy: {
          enabled: !!ntfy.enabled,
          topicUrl: ntfy.topicUrl || '',
          token: ntfy.token ? '***' : ''        // redacted — never emit the real token
        },
        'uptime-kuma': {
          // Uptime Kuma is "configured" when monitoring.pushUrl is set —
          // there is no separate enabled flag; an empty pushUrl = disabled.
          enabled: !!monitoring.pushUrl,
          pushUrl: monitoring.pushUrl || '',   // shown in clear — operator must see their monitor URL
          pushIntervalSec: Number(monitoring.pushIntervalSec) || 240
        }
      });
    }

    // POST /api/integrations/notification-providers — server-side merge of the
    // ntfy provider + the `monitoring` (Uptime Kuma) block into a getRawCfg()
    // clone, then saveAndApplyConfig (Phase 09.4 D-07/D-08; gap-closure Gap 3).
    // Gap 3: the Uptime Kuma section writes monitoring.pushUrl +
    // monitoring.pushIntervalSec — the SINGLE Kuma integration — NOT a duplicate
    // notifications.providers.uptime-kuma. This is the SAME shape as
    // /api/family/mqtt-tiles: a partial POST to /api/config would REPLACE
    // config.json verbatim and wipe apiToken/optimizer/mqtt (MEMORY
    // feedback_config_save_replaces — prod crash-loop incident). When an
    // incoming secret equals the redaction placeholder '***', the existing
    // stored value is KEPT (same bug class as the 09-01 settings-save
    // token_too_short regression).
    if (url.pathname === '/api/integrations/notification-providers' && req.method === 'POST') {
      let body;
      try { body = await parseBody(req); }
      catch { return json(res, 400, { ok: false, error: 'invalid json' }); }
      if (!body || typeof body !== 'object') {
        return json(res, 400, { ok: false, error: 'object required' });
      }
      const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
      const next = JSON.parse(JSON.stringify(ctx.getRawCfg() || {}));
      next.notifications = (next.notifications && typeof next.notifications === 'object') ? next.notifications : {};
      next.notifications.providers = (next.notifications.providers && typeof next.notifications.providers === 'object')
        ? next.notifications.providers : {};
      const prev = next.notifications.providers;

      // ntfy — a real notifications.providers entry.
      const inNtfy = body.ntfy || {};
      const ntfyToken = (inNtfy.token === '***')
        ? (prev.ntfy && prev.ntfy.token) || ''      // keep existing — '***' means "unchanged"
        : clip(inNtfy.token, 256);
      next.notifications.providers.ntfy = {
        enabled: !!inNtfy.enabled,
        topicUrl: clip(inNtfy.topicUrl, 512),
        ...(ntfyToken ? { token: ntfyToken } : {})
      };
      // Gap 3 step 2: scrub any stale duplicate provider so it cannot resurrect
      // a second heartbeat after this save.
      if (prev['uptime-kuma']) delete next.notifications.providers['uptime-kuma'];

      // Uptime Kuma → the `monitoring` block (the single Kuma integration).
      next.monitoring = (next.monitoring && typeof next.monitoring === 'object') ? next.monitoring : {};
      const prevMon = next.monitoring;
      const inKuma = body['uptime-kuma'] || {};
      // An EMPTY (falsy) `enabled` clears the pushUrl → disables the heartbeat.
      // When enabled: '***' keeps the stored URL, anything else replaces it.
      let kumaUrl;
      if (!inKuma.enabled) {
        kumaUrl = '';
      } else if (inKuma.pushUrl === '***') {
        kumaUrl = prevMon.pushUrl || '';
      } else {
        kumaUrl = clip(inKuma.pushUrl, 512);
      }
      // monitoring.pushIntervalSec range mirrors config-model.js [30,600].
      const intervalSec = Math.max(30, Math.min(600, Number(inKuma.pushIntervalSec) || 240));
      next.monitoring.pushUrl = kumaUrl;
      next.monitoring.pushIntervalSec = intervalSec;

      try {
        ctx.saveAndApplyConfig(next);
      } catch (e) {
        pushLog('notification_providers_save_error', { error: e.message });
        return json(res, 500, { ok: false, error: 'save failed' });
      }
      pushLog('notification_providers_saved', {
        ntfyEnabled: next.notifications.providers.ntfy.enabled,
        kumaEnabled: !!next.monitoring.pushUrl
      }, actorContext(req));
      return json(res, 200, { ok: true });
    }

    // Integrations page HTML route
    if (url.pathname === '/integrations' && req.method === 'GET') {
      return servePage(res, 'integrations.html');
    }

    // EOS (Akkudoktor) -- Messwerte + Preise abrufen
    if (url.pathname === '/api/integration/eos' && req.method === 'GET') return json(res, 200, eosState());

    // Phase 21 (operator request 2026-05-23): EOS Konfigurations-Sync.
    // Liest die EOS-relevanten DVhub-Settings (Batterie, Standort, EMS-Mode)
    // und PUTet sie via /v1/config/* in die EOS-Instanz. Damit muss der
    // Operator die meisten EOS-Parameter nicht doppelt pflegen.
    if (url.pathname === '/api/eos/sync-from-dvhub' && req.method === 'POST') {
      const cfg = getCfg();
      const sma = cfg.schedule?.smallMarketAutomation || {};
      const battCapKwh = Number(sma.batteryCapacityKwh) || null;
      const minSocPct = Number(sma.minSocPct) || 5;
      const effPct = Number(sma.inverterEfficiencyPct ?? 90);
      const maxChargeW = Number(cfg.optimizer?.maxChargeW ?? 5000);
      const lat = Number(sma.location?.latitude);
      const lon = Number(sma.location?.longitude);
      const curSoc = Number(state.victron?.soc);
      const eosBase = cfg.optimizer?.eosProxy?.url || 'http://localhost:8503';

      async function putEos(path, value) {
        try {
          const resp = await fetch(`${eosBase}/v1/config${path}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(value)
          });
          if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            return { ok: false, status: resp.status, body: body.slice(0, 200) };
          }
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      }

      const results = {};
      if (Number.isFinite(lat)) results.latitude = await putEos('/general/latitude', lat);
      if (Number.isFinite(lon)) results.longitude = await putEos('/general/longitude', lon);
      if (battCapKwh && battCapKwh > 0) {
        const battery = {
          // MUST be 'battery1' to match the inverter's battery_id (set from
          // EOS.config.json / eos-config-sync.js BATTERY_DEVICE_ID). A divergent
          // id (was 'dvhub_battery') leaves inverter1.battery_id='battery1'
          // dangling → EOS aborts every optimization with
          // "Battery ID mismatch - battery1 is configured; got dvhub_battery".
          device_id: 'battery1',
          capacity_wh: Math.round(battCapKwh * 1000),
          charging_efficiency: Math.max(0.5, Math.min(1, effPct / 100)),
          discharging_efficiency: Math.max(0.5, Math.min(1, effPct / 100)),
          max_charge_power_w: Math.round(Math.abs(maxChargeW)),
          // EOS min_soc = DVhub's hard floor (live Victron BMS minSocPct, def 5),
          // matching eos-config-sync.js. NOT sma.minSocPct (30) — that would make
          // EOS import from grid to hold 30% overnight instead of riding the
          // battery down and refilling via PV (operator request 2026-05-29).
          min_soc_percentage: Math.round(Number.isFinite(Number(state.victron?.minSocPct)) ? Number(state.victron.minSocPct) : 5),
          max_soc_percentage: 100,
          initial_soc_percentage: Number.isFinite(curSoc) ? Math.round(curSoc) : 50
        };
        results.batteries = await putEos('/devices/batteries', [battery]);
        results.max_batteries = await putEos('/devices/max_batteries', 1);
      }
      // EV optimization is opt-in (cfg.optimizer.eosOptimizeEv, default OFF) —
      // mirrors eos-config-sync.js. OFF → EOS does not schedule EV charging from
      // grid; the EV load is already in the LoadImport forecast.
      const optimizeEv = cfg.optimizer?.eosOptimizeEv === true;
      if (optimizeEv) {
        results.electric_vehicles = await putEos('/devices/electric_vehicles', [{
          device_id: 'ev11',
          capacity_wh: Number(cfg.optimizer?.evCapacityWh) || 50000,
          charging_efficiency: 0.88,
          discharging_efficiency: 0.88,
          max_charge_power_w: Number(cfg.optimizer?.evMaxChargeW) || 5000,
          min_charge_power_w: 50,
          charge_rates: [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
          min_soc_percentage: Number.isFinite(Number(cfg.optimizer?.evMinSocPct)) ? Number(cfg.optimizer.evMinSocPct) : 70,
          max_soc_percentage: 100,
        }]);
        results.max_electric_vehicles = await putEos('/devices/max_electric_vehicles', 1);
      } else {
        results.max_electric_vehicles = await putEos('/devices/max_electric_vehicles', 0);
        results.electric_vehicles = await putEos('/devices/electric_vehicles', []);
      }
      // Provider-Konfiguration: EOS soll die Werte verwenden, die unser
      // EOS-Adapter via PUT /v1/prediction/import/* schon regelmäßig pusht.
      // Ohne das stehen die provider auf null und EOS hat keine Daten-Quelle.
      results.pv_provider    = await putEos('/pvforecast/provider', 'PVForecastImport');
      results.load_provider  = await putEos('/load/provider',       'LoadImport');
      results.price_provider = await putEos('/elecprice/provider',  'ElecPriceImport');

      // EMS Mode: schalte automatische Optimierung scharf.
      results.ems_mode = await putEos('/ems/mode', 'OPTIMIZATION');

      const allOk = Object.values(results).every((r) => r && r.ok);
      pushLog('eos_sync_from_dvhub', { ok: allOk, fields: Object.keys(results) });
      return json(res, allOk ? 200 : 207, { ok: allOk, results });
    }

    // EMHASS -- Messwerte + Preise abrufen
    if (url.pathname === '/api/integration/emhass' && req.method === 'GET') return json(res, 200, emhassState());

    if (url.pathname === '/api/log' && req.method === 'GET') {
      const limit = resolveLogLimit(url.searchParams.get('limit'));
      // Plan 09-06 (D-09): every row includes a level field. Entries created
      // before this plan landed (pre-restart) carry no level — default 'info'
      // so the UI dropdown filter (Plan 09-06 Task 4) renders consistently.
      const rows = state.log.slice(-limit).map((entry) => ({
        ...entry,
        level: entry.level || 'info',
      }));
      return json(res, 200, { rows });
    }

    // T-0113 Tier 1: redacted diagnostic support bundle (Bearer-required, see
    // BEARER_REQUIRED_ENDPOINTS). Collects ALLOWLISTED live sources only (never a
    // raw FS dump) and hands them to buildSupportBundle() which applies
    // redactConfig() + scrubDeep(). Operator pulls one shareable JSON; the
    // matching `dvhub support dump` CLI is the local-shell path.
    //   ?sinceHours=<n>  optional time window   ?maxEntries=<n>  optional cap
    if (url.pathname === '/api/support/bundle' && req.method === 'GET') {
      const actor = actorContext(req);
      try {
        const opts = {};
        const sinceHours = Number(url.searchParams.get('sinceHours'));
        if (Number.isFinite(sinceHours) && sinceHours > 0) opts.sinceMs = sinceHours * 3600 * 1000;
        const maxEntries = Number(url.searchParams.get('maxEntries'));
        if (Number.isFinite(maxEntries) && maxEntries > 0) {
          opts.maxLogEntries = maxEntries;
          opts.maxAuditEntries = maxEntries;
        }

        // audit/control events (durable) — optional, only if telemetry store present
        let auditEntries = [];
        try {
          if (ctx.telemetryStore?.listControlEvents) {
            const r = await ctx.telemetryStore.listControlEvents({ limit: opts.maxAuditEntries || 1000 });
            auditEntries = Array.isArray(r) ? r : (r?.rows || []);
          }
        } catch { /* audit is best-effort; the in-memory ring is the primary source */ }

        // systemd active-state (best-effort)
        let serviceActive = null;
        try {
          if (ctx.getServiceActionsEnabled?.()) {
            const r = await ctx.runServiceCommand(['is-active', ctx.getServiceName()]);
            serviceActive = (r?.stdout || r?.output || '').toString().trim() || null;
          }
        } catch { /* ignore */ }

        const rawCfg = ctx.getRawCfg?.() || {};
        const loaded = ctx.getLoadedConfig?.() || {};
        const bundle = buildSupportBundle({
          version: ctx.getAppVersion?.() ?? null,
          system: {
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            uptimeSec: Math.round(process.uptime()),
            serviceActive,
            transport: ctx.getTransportType?.() ?? null,
          },
          migrations: { configSchemaVersion: rawCfg?.configSchemaVersion ?? null },
          logRing: state.log,
          auditEntries,
          config: rawCfg,
          health: {
            configValid: !!(loaded.exists && loaded.valid),
            needsSetup: !!loaded.needsSetup,
            telemetryEnabled: !!getCfg().telemetry?.enabled,
            telemetryOk: !!state.telemetry?.ok,
          },
        }, opts);

        pushLog('support_bundle_generated', {
          logs: bundle.meta.counts.logs,
          audit: bundle.meta.counts.audit,
          window: bundle.meta.window.sinceMs,
        }, actor);

        const fn = supportBundleFilename(bundle.meta.generatedAt, bundle.meta.dvhubVersion);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="${fn}"`,
          'Cache-Control': 'no-store',
        });
        return res.end(JSON.stringify(bundle, null, 2));
      } catch (e) {
        pushLog('support_bundle_error', { error: e.message }, actor);
        return json(res, 500, { ok: false, error: e.message });
      }
    }

    // T-0113 Tier 3: customer-initiated reverse-SSH support tunnel.
    //   GET  /api/support/tunnel/status  — transparency: open?, ttl, relay,
    //        appliance key fingerprint, provisioned?, local-support-user on/off.
    //   POST /api/support/tunnel/open    — { ttlMin? } opens an auto-closing tunnel.
    //   POST /api/support/tunnel/close   — Kill switch.
    // NOT in BEARER_REQUIRED_ENDPOINTS by design: open/close are LAN-trusted
    // actions — the customer clicks the button from their own WLAN, the same trust
    // boundary the rest of DVhub uses. Without an OPEN tunnel the box sits behind
    // NAT and is unreachable; the deposited support key alone grants nothing.
    //
    // Review 2026-06-10 (B7, Christin-Entscheid): POST /open additionally requires
    // the one-time uiToken from GET /status (CSRF-nonce — a cross-origin page in
    // the customer's browser cannot READ the status response, so blind CSRF/
    // DNS-rebinding POSTs cannot supply it; the own UI passes it invisibly).
    // A valid Bearer token bypasses the nonce so scripted/support flows keep
    // working. /close stays nonce-free BY DESIGN: the kill switch is privilege-
    // REDUCING and must never be blockable by a stale nonce.
    if (url.pathname === '/api/support/tunnel/status' && req.method === 'GET') {
      if (!ctx.supportTunnel) return json(res, 503, { ok: false, error: 'support_tunnel_unavailable' });
      return json(res, 200, { ok: true, ...ctx.supportTunnel.status() });
    }
    if (url.pathname === '/api/support/tunnel/open' && req.method === 'POST') {
      if (!ctx.supportTunnel) return json(res, 503, { ok: false, error: 'support_tunnel_unavailable' });
      const actor = actorContext(req);
      const body = await readJsonBody(req, res);
      if (body === null) return; // readJsonBody already sent 400/413
      const hasValidBearer = (() => {
        const expectedTok = getCfg().apiToken;
        if (typeof expectedTok !== 'string' || expectedTok.length === 0) return false;
        const m = /^Bearer\s+(.+)$/i.exec(String(req.headers?.authorization || ''));
        if (!m) return false;
        const got = Buffer.from(m[1]);
        const want = Buffer.from(expectedTok);
        return got.length === want.length && crypto.timingSafeEqual(got, want);
      })();
      if (!hasValidBearer && !ctx.supportTunnel.consumeUiToken?.(body?.uiToken)) {
        return json(res, 403, {
          ok: false,
          error: 'ui_token_required',
          detail: 'Sicherheits-Token fehlt oder abgelaufen — Status neu laden und erneut öffnen.'
        });
      }
      const ttlRaw = Number(body?.ttlMin);
      const r = ctx.supportTunnel.open({ ttlMin: Number.isFinite(ttlRaw) ? ttlRaw : undefined }, actor);
      // not_provisioned / misconfigured / spawn_failed -> 409 (caller can't open yet)
      return json(res, r.ok ? 200 : 409, r);
    }
    if (url.pathname === '/api/support/tunnel/close' && req.method === 'POST') {
      if (!ctx.supportTunnel) return json(res, 503, { ok: false, error: 'support_tunnel_unavailable' });
      const actor = actorContext(req);
      return json(res, 200, ctx.supportTunnel.close(actor));
    }

    // Plan 08-07 Task 3: frontend error reporting endpoint. The browser POSTs
    // window.onerror / unhandledrejection / per-widget catch payloads here so
    // operator-visible logs show frontend crashes too. Auth-required (handled by
    // checkAuth above for any non-LAN-safe /api/ path).
    if (url.pathname === '/api/log' && req.method === 'POST') {
      const body = await readJsonBody(req, res);
      if (body === null) return;
      if (!body || typeof body !== 'object') {
        return json(res, 400, { ok: false, error: 'json_body_required' });
      }
      const level = String(body.level || 'error').slice(0, 16);
      const source = String(body.source || 'frontend').slice(0, 32);
      // Cap free-form fields to keep the in-memory ring buffer bounded.
      const message = typeof body.message === 'string' ? body.message.slice(0, 500) : null;
      const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : null;
      const stack = typeof body.stack === 'string' ? body.stack.slice(0, 4000) : null;
      // Plan 09-06 (D-09): map the frontend-reported level into pushLog's level
      // shorthand so the UI dropdown filter (Task 4) sees the same value the
      // browser sent. Unknown levels (e.g., 'critical' from a future client) are
      // coerced to 'error' so the audit_log severity CHECK passes — Phase 8.1
      // migration 015 only allows debug/info/warn/error/critical.
      const NORMALISED_LEVELS = new Set(['debug', 'info', 'warn', 'error']);
      const pushLevel = NORMALISED_LEVELS.has(level) ? level : 'error';
      // H-5: build the audit event name from the normalized, allowlisted level —
      // never the raw, attacker-controlled body.level (caps event_type cardinality
      // and stops audit-log pollution from arbitrary client-supplied strings).
      pushLog(`frontend_${pushLevel}`, {
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
      }, pushLevel);
      return json(res, 200, { ok: true });
    }

    // Persistent DV signal log from database
    if (url.pathname === '/api/log/dv-signals' && req.method === 'GET') {
      if (!ctx.telemetryStore?.listControlEvents) return json(res, 503, { ok: false, error: 'telemetry store not available' });
      // M-3 (Plan 16-03): clamp `limit` to 1..2000 — an unbounded limit lets a
      // caller drag the store into an arbitrarily large scan (T-16-09 DoS).
      const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
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
      // M-5 (Plan 16-03): cap the key count before the DoS slot-guard — each
      // key multiplies the scan, so an unbounded key list defeats the slot cap.
      if (keys.length > 50) return json(res, 400, { ok: false, error: 'too_many_keys' });
      const now = new Date();
      // M-4 (Plan 16-03): validate start/end with parseIsoOrNull — its
      // tri-state contract (null=absent, false=garbage, ISO=valid) matches
      // /api/history/raw. Without this an unparseable timestamp slips past
      // the DoS slot-guard (which treats unparseable as 0).
      const startRaw = parseIsoOrNull(url.searchParams.get('start'));
      const endRaw = parseIsoOrNull(url.searchParams.get('end'));
      if (startRaw === false || endRaw === false) {
        return json(res, 400, { ok: false, error: 'invalid_timestamp' });
      }
      const start = startRaw || new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const end = endRaw || new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
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

    // --- /api/eeg/extension — §51a lifetime Förder-Verlängerung (T-0004) ---
    // Counts negative-price quarter-hours from the LOCAL spot-price history
    // since plant commissioning and converts them per the statutory §51a
    // Abs. 2 mechanics (×0.5 → Volllastviertelstunden → month table). The
    // count is market-wide (price < 0), NOT export-conditioned — §51a Abs. 3
    // has the exchanges report the count centrally for all affected plants.
    if (url.pathname === '/api/eeg/extension' && req.method === 'GET') {
      if (!ctx.telemetryStore?.querySeries) return json(res, 503, { ok: false, error: 'telemetry store not available' });
      const cached = eegExtensionCache.payload;
      if (cached && (Date.now() - eegExtensionCache.at) < EEG_EXTENSION_CACHE_MS) {
        return json(res, 200, { ...cached, cached: true });
      }
      try {
        const cfg = getCfg();
        const plants = Array.isArray(cfg.userEnergyPricing?.pvPlants) ? cfg.userEnergyPricing.pvPlants : [];
        const commissioned = plants
          .map((p) => (typeof p?.commissionedAt === 'string' ? p.commissionedAt : ''))
          .filter((d) => /^\d{4}-\d{2}-\d{2}/.test(d))
          .sort();
        const earliest = commissioned[0] || null;
        const totalKwp = plants.reduce((a, p) => a + (Number(p?.kwp) > 0 ? Number(p.kwp) : 0), 0);
        const rule = getEegNegativePriceRule({ commissionedAt: earliest, kwp: totalKwp });

        if (!earliest || rule.rule === 'none') {
          const payload = {
            ok: true, applicable: false, rule: rule.rule,
            reason: earliest ? (rule.description || 'Anlage nicht §51-betroffen') : 'Kein Inbetriebnahmedatum konfiguriert (Einstellungen → Strompreise → PV-Anlagen)',
            commissionedAt: earliest
          };
          eegExtensionCache.payload = payload;
          eegExtensionCache.at = Date.now();
          return json(res, 200, payload);
        }

        if (rule.rule !== '15min') {
          // Bestandsanlage unter Stunden-Regeln: §51a Abs. 1 path (days, no
          // 0.5 factor / month table). The per-view counter on the history
          // page already applies the correct hour-block rule; a lifetime
          // counter for hour rules follows in a later iteration.
          const payload = {
            ok: true, applicable: false, rule: rule.rule,
            reason: `Bestandsanlage (${rule.description || rule.rule}) — der Lebenszeit-Zähler unterstützt aktuell die 15-min-Regel (Inbetriebnahme ab 25.02.2025).`,
            commissionedAt: earliest
          };
          eegExtensionCache.payload = payload;
          eegExtensionCache.at = Date.now();
          return json(res, 200, payload);
        }

        const startIso = new Date(`${earliest.slice(0, 10)}T00:00:00Z`).toISOString();
        // The live EPEX ingest writes the series as 'price_ct_kwh';
        // 'spot_price_ct_kwh' is the migration-019 catalogue name kept as a
        // fallback. Query both, prefer the populated live key (verified on
        // prod 2026-06-13: price_ct_kwh has the data, spot_* is empty).
        // maxResolution 3600: prod stores some windows hourly (observed since
        // 2026-03-26) — countNegativeQuarterSlots weighs those ×4. In overlap
        // windows querySeries' 15-min bucket dedup prefers the finer row.
        const allRows = await ctx.telemetryStore.querySeries({
          seriesKeys: ['price_ct_kwh', 'spot_price_ct_kwh'],
          start: startIso,
          end: new Date().toISOString(),
          maxResolution: 3600
        });
        const liveRows = allRows.filter((r) => r.key === 'price_ct_kwh');
        const rows = liveRows.length ? liveRows : allRows.filter((r) => r.key === 'spot_price_ct_kwh');
        const { count, firstTs, lastTs } = countNegativeQuarterSlots(rows);
        const vlvs = vollastViertelstunden(count);
        const ext = extensionFromVollast(vlvs);
        const payload = {
          ok: true,
          applicable: true,
          rule: rule.rule,
          commissionedAt: earliest,
          negQuarterSlots: count,
          vollastViertelstunden: vlvs,
          extension: ext,
          // Honest data-coverage note: the local price history may start
          // after commissioning (DVhub install date / backfill depth).
          coverage: { firstPriceTs: firstTs, lastPriceTs: lastTs, priceRows: rows.length },
          generatedAt: new Date().toISOString()
        };
        eegExtensionCache.payload = payload;
        eegExtensionCache.at = Date.now();
        return json(res, 200, payload);
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    }

    // --- /api/history/raw — JSON pagination over timeseries_samples ---
    // Phase 09.2 D-11..D-16. Bearer required from any source — D-15: this
    // endpoint is NOT in LAN_SAFE_ENDPOINTS (raw telemetry exposes operational
    // topology + last-sample timestamps; LAN-bypass would defeat the purpose).
    // checkAuth has already run above (handleRequest line ~1390 gates every
    // /api/* path that isn't LAN-safe). Parameterized SQL throughout — no
    // string concat with user input. Server-side cap 10000 on limit (T-09.2-
    // DOS-MEM). 60s LRU cache keyed by normalized params (D-14, cap 100).
    // ORDER BY ts_utc DESC + time-range WHERE so TimescaleDB chunk-pruning
    // bounds disk read (D-16). Cursor pagination is "go further back in time"
    // via `s.ts_utc < $cursor` — chunk-aligned (Pitfall 5 alternative chosen).
    if (url.pathname === '/api/history/raw' && req.method === 'GET') {
      if (!ctx.db) {
        return json(res, 503, { ok: false, error: 'db not available' });
      }

      // Parse + validate query params
      const sources = parseCsv(url.searchParams.get('sources') || '');
      const signals = parseCsv(url.searchParams.get('signals') || '');
      const from = parseIsoOrNull(url.searchParams.get('from'));
      const to = parseIsoOrNull(url.searchParams.get('to'));
      if (from === false || to === false) {
        return json(res, 400, { ok: false, error: 'invalid from/to timestamp (expect ISO 8601)' });
      }
      // Default limit when omitted is 1000. Note: `Number(null)` is 0 (not
      // NaN), so we check the raw string presence first instead of relying on
      // Number.isFinite to distinguish "param missing" from "param is zero".
      const limitParamRaw = url.searchParams.get('limit');
      const limitNum = limitParamRaw == null ? 1000 : Number(limitParamRaw);
      const limit = Math.min(
        10000,
        Math.max(1, Number.isFinite(limitNum) ? Math.floor(limitNum) : 1000)
      );
      const cursor = parseIsoOrNull(url.searchParams.get('cursor'));
      if (cursor === false) {
        return json(res, 400, { ok: false, error: 'invalid cursor timestamp (expect ISO 8601)' });
      }

      // Cache check (D-14). Normalized key collapses parameter aliases
      // (sorted arrays) so two callers with the same logical query share the
      // same payload. LRU position refreshed on hit (delete + reinsert).
      const cacheKey = normalizedRawCacheKey({ sources, signals, from, to, limit, cursor });
      const now = Date.now();
      const cached = rawHistoryCache.get(cacheKey);
      if (cached && cached.expiresAt > now) {
        rawHistoryCache.delete(cacheKey);
        rawHistoryCache.set(cacheKey, cached);
        return json(res, 200, cached.payload);
      }

      // Build parameterized SQL — every user-controllable value bound via $N.
      // ANY($N::text[]) for sources/signals so injection payloads land as
      // single text array elements, never as SQL syntax. No string concat
      // with caller input anywhere in the builder (T-09.2-INJ).
      const params = [];
      let p = 0;
      const parts = [];
      parts.push('SELECT s.ts_utc, s.series_key, s.value_num, s.unit FROM timeseries_samples s');
      if (sources.length) {
        parts.push('JOIN series_metadata m ON s.series_key = m.series_key');
        parts.push(`WHERE m.source = ANY($${++p}::text[])`);
        params.push(sources);
      } else {
        parts.push('WHERE 1 = 1');
      }
      if (signals.length) {
        parts.push(`AND s.series_key = ANY($${++p}::text[])`);
        params.push(signals);
      }
      if (from) {
        parts.push(`AND s.ts_utc >= $${++p}::timestamptz`);
        params.push(from);
      }
      if (to) {
        parts.push(`AND s.ts_utc < $${++p}::timestamptz`);
        params.push(to);
      }
      if (cursor) {
        // Pagination cursor: walk further back in time. Strict-< guarantees
        // no duplicate row at the page boundary (Pitfall 5 alternative —
        // boundary timestamp belongs to exactly one page).
        parts.push(`AND s.ts_utc < $${++p}::timestamptz`);
        params.push(cursor);
      }
      // ORDER BY + LIMIT in one trailing clause so TimescaleDB chunk-pruning
      // sees the time-range WHERE + DESC ordering and plans a chunk-bounded
      // index scan (D-16). Without this hint the planner falls back to a
      // full-hypertable scan on wide queries. Fetch limit+1 so we can detect
      // whether more rows exist beyond this page (next_cursor population).
      parts.push('ORDER BY s.ts_utc DESC');
      parts.push(`LIMIT $${++p}`);
      params.push(limit + 1);

      const t0 = Date.now();
      try {
        const r = await ctx.db.query(parts.join(' '), params);
        const hasMore = r.rows.length > limit;
        const rawRows = hasMore ? r.rows.slice(0, limit) : r.rows;
        const rows = rawRows.map((row) => [
          row.ts_utc instanceof Date ? row.ts_utc.toISOString() : String(row.ts_utc),
          row.series_key,
          row.value_num != null ? Number(row.value_num) : null,
          row.unit || null,
        ]);
        const nextCursor = hasMore && rows.length ? rows[rows.length - 1][0] : null;
        const payload = {
          ok: true,
          rows,
          next_cursor: nextCursor,
          total: rows.length,
          query_ms: Date.now() - t0,
        };
        // Cache write + FIFO eviction at cap (D-14). Map.keys().next().value
        // returns the oldest insertion since Map preserves insertion order.
        rawHistoryCache.set(cacheKey, { payload, expiresAt: now + RAW_CACHE_TTL_MS });
        while (rawHistoryCache.size > RAW_CACHE_CAP) {
          const firstKey = rawHistoryCache.keys().next().value;
          rawHistoryCache.delete(firstKey);
        }
        return json(res, 200, payload);
      } catch (e) {
        pushLog('history_raw_error', { error: e.message });
        return json(res, 500, { ok: false, error: e.message });
      }
    }

    // --- /api/history/raw/export.csv — streaming CSV export (Phase 09.2 D-12) ---
    // LAN-safe (D-15 reverted 2026-05-15: appliance has no token UI in browser);
    // /api/history/raw/export.csv is in BEARER_REQUIRED_ENDPOINTS so checkAuth
    // (already invoked above) enforces the gate even on LAN.
    //
    // Streams a UTF-8-BOM CSV with semicolon separator (German Excel locale)
    // over Transfer-Encoding: chunked. Reuses the same parameterized SQL
    // shape as /api/history/raw above, MINUS the cache (streaming responses
    // aren't cacheable) and MINUS the LIMIT cap (export the full range).
    //
    // Memory bound: pg.Cursor reads pages of 500 rows; we never materialise
    // the full result set. Connection bound: req.on('close') and res.on('close')
    // both abort the cursor and release the pool client (T-09.2-DOS-CONN).
    if (url.pathname === '/api/history/raw/export.csv' && req.method === 'GET') {
      if (!ctx.db) {
        return json(res, 503, { ok: false, error: 'db not available' });
      }

      // Re-use the same parsers as /api/history/raw above.
      const sources = parseCsv(url.searchParams.get('sources') || '');
      const signals = parseCsv(url.searchParams.get('signals') || '');
      const from = parseIsoOrNull(url.searchParams.get('from'));
      const to = parseIsoOrNull(url.searchParams.get('to'));
      if (from === false || to === false) {
        return json(res, 400, { ok: false, error: 'invalid from/to timestamp (expect ISO 8601)' });
      }
      const cursorParam = parseIsoOrNull(url.searchParams.get('cursor'));
      if (cursorParam === false) {
        return json(res, 400, { ok: false, error: 'invalid cursor timestamp (expect ISO 8601)' });
      }

      // Build parameterized SQL — same shape as /api/history/raw above, no LIMIT.
      // Every user-controllable value bound via $N. ANY($N::text[]) for arrays
      // so injection payloads land as text-array elements, never as SQL syntax
      // (T-09.2-INJ).
      const params = [];
      let p = 0;
      const parts = [];
      parts.push('SELECT s.ts_utc, s.series_key, s.value_num, s.unit FROM timeseries_samples s');
      if (sources.length) {
        parts.push('JOIN series_metadata m ON s.series_key = m.series_key');
        parts.push(`WHERE m.source = ANY($${++p}::text[])`);
        params.push(sources);
      } else {
        parts.push('WHERE 1 = 1');
      }
      if (signals.length) {
        parts.push(`AND s.series_key = ANY($${++p}::text[])`);
        params.push(signals);
      }
      if (from) {
        parts.push(`AND s.ts_utc >= $${++p}::timestamptz`);
        params.push(from);
      }
      if (to) {
        parts.push(`AND s.ts_utc < $${++p}::timestamptz`);
        params.push(to);
      }
      if (cursorParam) {
        parts.push(`AND s.ts_utc < $${++p}::timestamptz`);
        params.push(cursorParam);
      }
      // ORDER BY ts_utc DESC keeps TimescaleDB chunk-pruning efficient even
      // without an explicit LIMIT (D-16). The time-range WHERE bounds disk read.
      parts.push('ORDER BY s.ts_utc DESC');
      const sql = parts.join(' ');

      // Server-derived filename — NEVER echo client input (V12 ASVS / T-09.2-
      // FILENAME-INJ). The `?filename=...` query param is intentionally not
      // read anywhere in this handler.
      const filename = `dvhub-export-${new Date().toISOString().slice(0, 10)}.csv`;

      let dbClient = null;
      let pgCursor = null;
      let aborted = false;
      let cleaned = false;

      function cleanup() {
        if (cleaned) return;
        cleaned = true;
        if (pgCursor && typeof pgCursor.close === 'function') {
          try { pgCursor.close(() => {}); } catch { /* swallow — already closing */ }
        }
        if (dbClient && typeof dbClient.release === 'function') {
          try { dbClient.release(); } catch { /* swallow — already released */ }
        }
      }

      // H-6 (Plan 16-03): connect BEFORE res.writeHead so a failed connection
      // yields a real 503 JSON error. The `!ctx.db` pre-check above only covers
      // a MISSING pool — a pool whose connect() rejects (DB down, pool drained)
      // would otherwise flush a 200 header and a BOM-only body, mis-signalling
      // a "successful" empty export to the client.
      try {
        dbClient = await ctx.db.connect();
      } catch (e) {
        pushLog('history_raw_csv_error', { error: e.message, stage: 'connect' });
        return json(res, 503, { ok: false, error: 'db_unavailable' });
      }

      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-store',
      });
      // UTF-8 BOM (﻿) — Excel autodetects UTF-8 from this byte sequence
      // and renders the German umlauts + the semicolon separator natively.
      res.write('﻿');
      res.write('ts_utc;series_key;value;unit\n');

      // Both req.on('close') and res.on('close') — different runtimes emit
      // close on different sockets; we register both for defence-in-depth.
      // A single cleanup() is idempotent.
      req.on('close', () => { aborted = true; cleanup(); });
      res.on('close', () => { aborted = true; cleanup(); });

      try {
        pgCursor = dbClient.query(new Cursor(sql, params));

        function readNext() {
          if (aborted) {
            cleanup();
            return;
          }
          pgCursor.read(500, (err, rows) => {
            if (err) {
              pushLog('history_raw_csv_error', { error: err.message });
              cleanup();
              try { res.end(); } catch { /* res already ended */ }
              return;
            }
            if (!rows.length) {
              cleanup();
              try { res.end(); } catch { /* res already ended */ }
              return;
            }
            for (const row of rows) {
              if (aborted) break;
              const cells = [
                row.ts_utc instanceof Date ? row.ts_utc.toISOString() : String(row.ts_utc),
                csvCell(row.series_key),
                row.value_num != null ? Number(row.value_num).toFixed(6) : '',
                csvCell(row.unit || ''),
              ];
              res.write(cells.join(';') + '\n');
            }
            if (aborted) {
              cleanup();
              return;
            }
            // Schedule the next read so we don't blow the call stack on
            // very large exports (5000+ rows = 10+ recursive callbacks).
            setImmediate(readNext);
          });
        }

        readNext();
      } catch (e) {
        pushLog('history_raw_csv_error', { error: e.message });
        cleanup();
        try { res.end(); } catch { /* res already ended */ }
      }
      return;
    }

    // --- /api/history/raw/export.parquet — streaming Parquet export (Phase 09.2 D-13/D-24 revised) ---
    // LAN-safe (D-15 reverted 2026-05-15: appliance has no token UI in browser);
    // /api/history/raw/export.parquet is in BEARER_REQUIRED_ENDPOINTS so checkAuth
    // (already invoked above) enforces the gate even on LAN.
    //
    // Streams a Parquet binary file over Transfer-Encoding: chunked. Reuses the
    // same parameterized SQL builder shape as /api/history/raw and the CSV
    // export above, MINUS the cache (binary streaming is not cacheable) and
    // MINUS the LIMIT cap (export the full range). The PARQUET_SCHEMA is locked
    // at module scope (4 columns: ts_utc, series_key, value, unit).
    //
    // Memory bound: pg.Cursor reads pages of 500 rows; ParquetWriter.appendRow
    // writes each row immediately; we never materialise the full result set.
    // Connection bound: req.on('close') and res.on('close') both abort the
    // cursor and release the pool client (T-09.2-DOS-CONN). On the happy path,
    // writer.close() writes the Parquet footer and closes the response stream
    // (osend internally calls res.end).
    if (url.pathname === '/api/history/raw/export.parquet' && req.method === 'GET') {
      if (!ctx.db) {
        return json(res, 503, { ok: false, error: 'db not available' });
      }

      // Re-use the same parsers as /api/history/raw and the CSV export above.
      const sources = parseCsv(url.searchParams.get('sources') || '');
      const signals = parseCsv(url.searchParams.get('signals') || '');
      const from = parseIsoOrNull(url.searchParams.get('from'));
      const to = parseIsoOrNull(url.searchParams.get('to'));
      if (from === false || to === false) {
        return json(res, 400, { ok: false, error: 'invalid from/to timestamp (expect ISO 8601)' });
      }
      const cursorParam = parseIsoOrNull(url.searchParams.get('cursor'));
      if (cursorParam === false) {
        return json(res, 400, { ok: false, error: 'invalid cursor timestamp (expect ISO 8601)' });
      }

      // Build parameterized SQL — same shape as the CSV export, no LIMIT.
      // Every user-controllable value bound via $N. ANY($N::text[]) for arrays
      // so injection payloads land as text-array elements, never as SQL syntax
      // (T-09.2-INJ).
      const params = [];
      let p = 0;
      const parts = [];
      parts.push('SELECT s.ts_utc, s.series_key, s.value_num, s.unit FROM timeseries_samples s');
      if (sources.length) {
        parts.push('JOIN series_metadata m ON s.series_key = m.series_key');
        parts.push(`WHERE m.source = ANY($${++p}::text[])`);
        params.push(sources);
      } else {
        parts.push('WHERE 1 = 1');
      }
      if (signals.length) {
        parts.push(`AND s.series_key = ANY($${++p}::text[])`);
        params.push(signals);
      }
      if (from) {
        parts.push(`AND s.ts_utc >= $${++p}::timestamptz`);
        params.push(from);
      }
      if (to) {
        parts.push(`AND s.ts_utc < $${++p}::timestamptz`);
        params.push(to);
      }
      if (cursorParam) {
        parts.push(`AND s.ts_utc < $${++p}::timestamptz`);
        params.push(cursorParam);
      }
      // ORDER BY ts_utc DESC keeps TimescaleDB chunk-pruning efficient even
      // without an explicit LIMIT (D-16). The time-range WHERE bounds disk read.
      parts.push('ORDER BY s.ts_utc DESC');
      const sql = parts.join(' ');

      // Server-derived filename — NEVER echo client input (V12 ASVS / T-09.2-
      // FILENAME-INJ). The `?filename=...` query param is intentionally not
      // read anywhere in this handler.
      const filename = `dvhub-export-${new Date().toISOString().slice(0, 10)}.parquet`;

      let dbClient = null;
      let pgCursor = null;
      let writer = null;
      let aborted = false;
      let cleaned = false;

      function cleanup() {
        if (cleaned) return;
        cleaned = true;
        if (pgCursor && typeof pgCursor.close === 'function') {
          try { pgCursor.close(() => {}); } catch { /* swallow — already closing */ }
        }
        if (dbClient && typeof dbClient.release === 'function') {
          try { dbClient.release(); } catch { /* swallow — already released */ }
        }
      }

      // H-6 (Plan 16-03): connect BEFORE res.writeHead so a failed connection
      // yields a real 503 JSON error instead of a 200 + truncated Parquet file
      // (a partial file with no footer magic is indistinguishable from a
      // legitimate-but-empty export to a naive client).
      try {
        dbClient = await ctx.db.connect();
      } catch (e) {
        pushLog('history_raw_parquet_error', { error: e.message, stage: 'connect' });
        return json(res, 503, { ok: false, error: 'db_unavailable' });
      }

      // Headers MUST be flushed BEFORE ParquetWriter.openStream begins writing
      // (the writer immediately writes the Parquet magic bytes "PAR1" via the
      // first oswrite call inside openStream).
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-store',
      });

      // Both req.on('close') and res.on('close') — different runtimes emit
      // close on different sockets; defence-in-depth (idempotent cleanup).
      req.on('close', () => { aborted = true; cleanup(); });
      res.on('close', () => { aborted = true; cleanup(); });

      try {
        pgCursor = dbClient.query(new Cursor(sql, params));
        writer = await parquet.ParquetWriter.openStream(PARQUET_SCHEMA, res);

        // Drain the cursor in 500-row pages. We use an awaited promise per page
        // (vs the CSV handler's setImmediate-callback style) because each
        // appendRow is awaited — the natural async/await loop already yields to
        // the event loop between pages without growing the call stack.
        // eslint-disable-next-line no-constant-condition
        while (true) {
          if (aborted) break;
          const batch = await new Promise((resolve, reject) => {
            pgCursor.read(500, (err, rows) => (err ? reject(err) : resolve(rows)));
          });
          if (!batch || batch.length === 0) break;
          for (const row of batch) {
            if (aborted) break;
            await writer.appendRow({
              ts_utc: row.ts_utc instanceof Date ? row.ts_utc.toISOString() : String(row.ts_utc),
              series_key: row.series_key,
              value: row.value_num != null ? Number(row.value_num) : null,
              unit: row.unit || null,
            });
          }
          if (aborted) break;
        }

        if (!aborted) {
          // writer.close() writes the Parquet footer + magic-bytes-tail and
          // calls res.end() internally via util.osend. Do NOT call res.end()
          // again afterwards — it would double-end the response.
          await writer.close();
        }
      } catch (e) {
        pushLog('history_raw_parquet_error', { error: e.message });
        // On error, the writer may have partially written bytes. Best we can do
        // is end the response (truncated file is the correct error signal to
        // clients — Parquet readers will fail to find the footer magic).
        try { res.end(); } catch { /* res already ended */ }
      } finally {
        cleanup();
      }
      return;
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

    // ─────────────────────────────────────────────────────────────────────
    // Phase 19 Plan 19-01 — Forecast Inspector (5 read-only diagnostic endpoints).
    //
    // Shape per CONTEXT D-16:
    //   - 4 window-shaped endpoints (B1..B4); optimizer-cold has no window
    //
    // Security posture (threat_model T-19-01, T-19-04, T-19-08, T-19-09):
    //   - LAN_SAFE_ENDPOINTS bypass GET-auth on LAN; external callers need Bearer.
    //   - B3/B4 are Pro-gated via requirePro() BEFORE business logic — the
    //     gate runs even on LAN-bypassed kiosks (Option B). featureName is
    //     whitelisted in services/license/index.js ALLOWED_FEATURES.
    //   - from/to ISO validated + 7-day DoS cap (T-19-09).
    //   - ctx.inspector=null → 503 (Phase 19-01 wires inspector at server bootstrap;
    //     a missing inspector indicates wiring drift and should fail loudly).
    //   - Handler throws → 500 with static `pushLog` event-name (T-19-10 accept).
    //
    // Stub passthrough: B1..B5 currently return {ok:false,error:'not_implemented'}
    // from inspector.js — the handler emits 501 to signal "not yet implemented"
    // (vs 500 server-error). Plans 19-02..19-06 replace each method body and the
    // handler will then return 200.
    // ─────────────────────────────────────────────────────────────────────

    // B6 — Optimizer-Cold (free; fully implemented in Plan 19-01)
    if (url.pathname === '/api/forecast/inspector/optimizer-cold' && req.method === 'GET') {
      if (!ctx.inspector) return json(res, 503, { ok: false, error: 'inspector_unavailable' });
      try {
        const payload = await ctx.inspector.getOptimizerCold();
        return json(res, 200, { ok: true, ...payload });
      } catch (e) {
        pushLog('inspector_optimizer_cold_error', { error: e.message });
        return json(res, 500, { ok: false, error: 'inspector_failed' });
      }
    }

    // B1 — PV Providers (free; stubbed in Plan 19-01, body in Plan 19-02)
    if (url.pathname === '/api/forecast/inspector/pv-providers' && req.method === 'GET') {
      if (!ctx.inspector) return json(res, 503, { ok: false, error: 'inspector_unavailable' });
      const from = url.searchParams.get('from');
      const to   = url.searchParams.get('to');
      if (!from || !to || isNaN(Date.parse(from)) || isNaN(Date.parse(to))) {
        return json(res, 400, { ok: false, error: 'invalid_window' });
      }
      const spanMs = Date.parse(to) - Date.parse(from);
      if (spanMs < 0 || spanMs > 7 * 86_400_000) {
        return json(res, 400, { ok: false, error: 'invalid_window' });
      }
      try {
        const payload = await ctx.inspector.getPvProviders({ from, to });
        if (payload && payload.ok === false && payload.error === 'not_implemented') {
          return json(res, 501, payload);
        }
        return json(res, 200, { ok: true, ...payload });
      } catch (e) {
        pushLog('inspector_pv_providers_error', { error: e.message });
        return json(res, 500, { ok: false, error: 'inspector_failed' });
      }
    }

    // pvnode-Nowcast vs Day-Ahead vs Ist (Christin 2026-07-08). On-demand: rechnet die
    // letzten N Tage frisch aus pv_forecasts (as-served Nowcast) + forecast_snapshots
    // (Day-Ahead) + energy_slots_15m (Ist), Negativpreis-Slots ausgeschlossen. Liefert
    // zusätzlich die nächtlich persistierte Historie. Reine Read-Analyse.
    if (url.pathname === '/api/forecast/nowcast-track' && req.method === 'GET') {
      const tracker = ctx.forecastService?.accuracyTracker;
      const fstore = ctx.forecastService?.store;
      if (!tracker?.evaluatePvnodeNowcast) return json(res, 503, { ok: false, error: 'forecast service not available' });
      const days = Math.max(1, Math.min(30, parseInt(url.searchParams.get('days'), 10) || 7));
      const avg = (arr) => { const f = arr.filter((x) => Number.isFinite(x)); return f.length ? f.reduce((s, v) => s + v, 0) / f.length : null; };
      try {
        // Frische Berechnung für die letzten `days` Tage (gestern rückwärts); heute wird
        // ausgelassen (unvollständig). UTC-Datumsarithmetik.
        const daily = [];
        const baseDay = new Date();
        baseDay.setUTCHours(0, 0, 0, 0);
        for (let i = 1; i <= days; i++) {
          const d = new Date(baseDay);
          d.setUTCDate(d.getUTCDate() - i);
          daily.push(await tracker.evaluatePvnodeNowcast(d.toISOString().slice(0, 10)));
        }
        const wd = daily.filter((r) => r.sampleCount > 0);
        const aggregate = wd.length ? {
          days: wd.length,
          maeDayahead: avg(wd.map((r) => r.maeDayahead)),
          maeNowcast: avg(wd.map((r) => r.maeNowcast)),
          meanRevision: avg(wd.map((r) => r.meanRevision)),
          absRevision: avg(wd.map((r) => r.absRevision)),
          improvementPct: avg(wd.map((r) => r.improvementPct)),
          meanHorizonMin: avg(wd.map((r) => r.meanHorizonMin))
        } : null;
        const persisted = fstore?.getNowcastAccuracyHistory ? await fstore.getNowcastAccuracyHistory(days) : [];
        return json(res, 200, { ok: true, provider: 'pvnode', days, daily, aggregate, persisted });
      } catch (e) {
        pushLog('nowcast_track_endpoint_error', { error: e.message });
        return json(res, 500, { ok: false, error: 'nowcast_track_failed' });
      }
    }

    // B2 — Load Forecast (free; stubbed in Plan 19-01, body in Plan 19-03)
    if (url.pathname === '/api/forecast/inspector/load' && req.method === 'GET') {
      if (!ctx.inspector) return json(res, 503, { ok: false, error: 'inspector_unavailable' });
      const from = url.searchParams.get('from');
      const to   = url.searchParams.get('to');
      if (!from || !to || isNaN(Date.parse(from)) || isNaN(Date.parse(to))) {
        return json(res, 400, { ok: false, error: 'invalid_window' });
      }
      const spanMs = Date.parse(to) - Date.parse(from);
      if (spanMs < 0 || spanMs > 7 * 86_400_000) {
        return json(res, 400, { ok: false, error: 'invalid_window' });
      }
      try {
        const payload = await ctx.inspector.getLoad({ from, to });
        if (payload && payload.ok === false && payload.error === 'not_implemented') {
          return json(res, 501, payload);
        }
        return json(res, 200, { ok: true, ...payload });
      } catch (e) {
        pushLog('inspector_load_error', { error: e.message });
        return json(res, 500, { ok: false, error: 'inspector_failed' });
      }
    }

    // B3 — ML Shadow Correction (Pro; stubbed in Plan 19-01, body in Plan 19-04)
    if (url.pathname === '/api/forecast/inspector/ml-correction' && req.method === 'GET') {
      if (!requirePro(req, res, 'forecast-inspector-ml')) return;
      if (!ctx.inspector) return json(res, 503, { ok: false, error: 'inspector_unavailable' });
      const from = url.searchParams.get('from');
      const to   = url.searchParams.get('to');
      if (!from || !to || isNaN(Date.parse(from)) || isNaN(Date.parse(to))) {
        return json(res, 400, { ok: false, error: 'invalid_window' });
      }
      const spanMs = Date.parse(to) - Date.parse(from);
      if (spanMs < 0 || spanMs > 7 * 86_400_000) {
        return json(res, 400, { ok: false, error: 'invalid_window' });
      }
      try {
        const payload = await ctx.inspector.getMlCorrection({ from, to });
        if (payload && payload.ok === false && payload.error === 'not_implemented') {
          return json(res, 501, payload);
        }
        return json(res, 200, { ok: true, ...payload });
      } catch (e) {
        pushLog('inspector_ml_correction_error', { error: e.message });
        return json(res, 500, { ok: false, error: 'inspector_failed' });
      }
    }

    // B4 — EOS Output (Pro; stubbed in Plan 19-01, body in Plan 19-05)
    if (url.pathname === '/api/forecast/inspector/eos' && req.method === 'GET') {
      if (!requirePro(req, res, 'forecast-inspector-eos')) return;
      if (!ctx.inspector) return json(res, 503, { ok: false, error: 'inspector_unavailable' });
      const from = url.searchParams.get('from');
      const to   = url.searchParams.get('to');
      if (!from || !to || isNaN(Date.parse(from)) || isNaN(Date.parse(to))) {
        return json(res, 400, { ok: false, error: 'invalid_window' });
      }
      const spanMs = Date.parse(to) - Date.parse(from);
      if (spanMs < 0 || spanMs > 7 * 86_400_000) {
        return json(res, 400, { ok: false, error: 'invalid_window' });
      }
      try {
        const payload = await ctx.inspector.getEos({ from, to });
        if (payload && payload.ok === false && payload.error === 'not_implemented') {
          return json(res, 501, payload);
        }
        return json(res, 200, { ok: true, ...payload });
      } catch (e) {
        pushLog('inspector_eos_error', { error: e.message });
        return json(res, 500, { ok: false, error: 'inspector_failed' });
      }
    }

    // T-CURTAIL: observed-GHI store coverage (diagnostic). GET-only LAN bypass
    // per appliance trust model (forecast group). Shows what historical
    // irradiance the curtailment estimator has, per source.
    if (url.pathname === '/api/forecast/ghi-coverage' && req.method === 'GET') {
      const store = ctx.forecastService?.store;
      if (!store?.getObservedGhiCoverage) return json(res, 503, { ok: false, error: 'forecast store not available' });
      try {
        const coverage = await store.getObservedGhiCoverage();
        return json(res, 200, { ok: true, coverage });
      } catch (e) {
        pushLog('ghi_coverage_error', { error: e.message });
        return json(res, 500, { ok: false, error: 'ghi_coverage_failed' });
      }
    }

    // T-CURTAIL: manually trigger the opportunistic observed-GHI backfill (admin
    // write — NOT in LAN_SAFE_GET, so a Bearer token is required). Idempotent;
    // fills only the missing head/tail gaps. Also runs automatically ~25s after
    // boot and daily.
    if (url.pathname === '/api/forecast/ghi-backfill' && req.method === 'POST') {
      if (!ctx.forecastService?.runGhiBackfill) return json(res, 503, { ok: false, error: 'forecast service not available' });
      try {
        const result = await ctx.forecastService.runGhiBackfill();
        return json(res, 200, { ok: true, result });
      } catch (e) {
        pushLog('ghi_backfill_trigger_error', { error: e.message });
        return json(res, 500, { ok: false, error: 'ghi_backfill_failed' });
      }
    }

    // T-CURTAIL Increment 2b: recalibrate the PV<->GHI slopes over a window
    // (admin write — Bearer required). Defaults to a RECENCY window (the plant
    // grows over time; fitting from the full history poisons slopes with old
    // small-plant data — see forecast/index.js runGhiAndRecalibrate). Pass
    // ?from= to override. Idempotent (replace-upsert).
    if (url.pathname === '/api/curtailment/recalibrate' && req.method === 'POST') {
      if (!ctx.curtailmentService) return json(res, 503, { ok: false, error: 'curtailment service not available' });
      const lookbackDays = Number(ctx.getCfg?.()?.forecast?.ghiCalibrationLookbackDays) || 270;
      const calFrom = url.searchParams.get('from')
        || new Date(Date.now() - lookbackDays * 86400000).toISOString().slice(0, 10);
      const calTo = url.searchParams.get('to') || new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      if (isNaN(Date.parse(calFrom)) || isNaN(Date.parse(calTo))) return json(res, 400, { ok: false, error: 'invalid_window' });
      try {
        const result = await ctx.curtailmentService.recalibrate({ calFrom, calTo });
        return json(res, result.ok ? 200 : 422, result);
      } catch (e) {
        pushLog('curtail_recalibrate_error', { error: e.message });
        return json(res, 500, { ok: false, error: 'recalibrate_failed' });
      }
    }

    // T-CURTAIL Increment 2b: preview the calibrated curtailment for a window
    // using the persisted slopes (read-only; GET-only LAN bypass). Compare this
    // to the current PVGIS-based KPI before Increment 3 swaps it in.
    if (url.pathname === '/api/curtailment/preview' && req.method === 'GET') {
      if (!ctx.curtailmentService) return json(res, 503, { ok: false, error: 'curtailment service not available' });
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      if (!from || !to || isNaN(Date.parse(from)) || isNaN(Date.parse(to))) return json(res, 400, { ok: false, error: 'invalid_window' });
      try {
        const result = await ctx.curtailmentService.computeForRange({ from, to });
        return json(res, result.ok ? 200 : 422, result);
      } catch (e) {
        pushLog('curtail_preview_error', { error: e.message });
        return json(res, 500, { ok: false, error: 'preview_failed' });
      }
    }

    if (url.pathname === '/api/forecast/refresh' && req.method === 'POST') {
      // L-6 (Plan 16-03): ctx.fetchVrmForecast() throws synchronously if the
      // service is unwired — guard before invoking so an unwired service
      // yields a clean 503 instead of an uncaught 500 (T-16-13 DoS).
      if (typeof ctx.fetchVrmForecast !== 'function') {
        return json(res, 503, { ok: false, error: 'forecast_service_unavailable' });
      }
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
        const baseUrl = cfg.epex.priceApiUrl || 'https://dvhub.online';
        const r = await fetch(`${baseUrl}/api/zones`, { signal: AbortSignal.timeout(10000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await readJsonCapped(r);
        return json(res, 200, data);
      } catch (e) {
        // H-4 (Plan 16-02): readJsonCapped throws statusCode=502 +
        // 'upstream_response_too_large' on an oversize upstream body — emit a
        // clean {ok:false,error} 502 rather than letting it bubble to a 500.
        return json(res, e.statusCode || 502, { ok: false, error: e.message });
      }
    }

    if (url.pathname === '/api/epex/gaps' && req.method === 'GET') {
      const cfg = getCfg();
      try {
        const baseUrl = cfg.epex.priceApiUrl || 'https://dvhub.online';
        const zone = url.searchParams.get('zone') || cfg.epex.bzn || 'DE-LU';
        const r = await fetch(`${baseUrl}/api/prices/gaps?zone=${encodeURIComponent(zone)}`, { signal: AbortSignal.timeout(10000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await readJsonCapped(r);
        return json(res, 200, data);
      } catch (e) {
        // H-4 (Plan 16-02): readJsonCapped throws statusCode=502 +
        // 'upstream_response_too_large' on an oversize upstream body — emit a
        // clean {ok:false,error} 502 rather than letting it bubble to a 500.
        return json(res, e.statusCode || 502, { ok: false, error: e.message });
      }
    }

    if (url.pathname === '/api/epex/backfill' && req.method === 'POST') {
      const cfg = getCfg();
      try {
        const baseUrl = cfg.epex.priceApiUrl || 'https://dvhub.online';
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
        const data = await readJsonCapped(r);
        return json(res, 200, data);
      } catch (e) {
        // H-4 (Plan 16-02): readJsonCapped throws statusCode=502 +
        // 'upstream_response_too_large' on an oversize upstream body — emit a
        // clean {ok:false,error} 502 rather than letting it bubble to a 500.
        return json(res, e.statusCode || 502, { ok: false, error: e.message });
      }
    }

    if (url.pathname === '/api/meter/scan' && req.method === 'POST') {
      const body = await readJsonBody(req, res);
      if (body === null) return;
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
      // Pro-Gating (Christin 2026-07-07): nur die Tagesansicht ist frei. Woche/
      // Monat/Jahr/Alle sind Pro. Gate VOR dem 503/Null-Check, damit ein
      // ungültiger Client ohne Lizenz sauber 403 pro_required bekommt (nicht 503).
      // LAN-Bypass hat die Auth bereits akzeptiert; requirePro prüft NUR die
      // Lizenz (netzwerkunabhängig) — Defense-in-depth zum Frontend-Lock.
      if (HISTORY_PREMIUM_VIEWS.has(String(url.searchParams.get('view')))) {
        if (!requirePro(req, res, 'history-multiperiod')) return;
      }
      if (!ctx.historyApi || typeof ctx.historyApi.getSummary !== 'function') {
        return json(res, 503, { ok: false, error: 'internal telemetry store disabled' });
      }
      const result = await ctx.historyApi.getSummary({
        view: url.searchParams.get('view'),
        date: url.searchParams.get('date')
      });
      return json(res, result.status, result.body);
    }

    // Phase 09.3-01: per-card history viz dispatch. Mirrors the /api/history/summary
    // shape — delegates to ctx.historyVizApi which returns { status, body }.
    // Slug → method-name map: kebab-case → camelCase prepended with 'get'
    // (e.g. 'day-profile' → 'getDayProfile'). Unknown slugs → 404.
    // LAN-bypass active for the whole prefix (isLanSafeRequest above).
    if (url.pathname.startsWith('/api/history/viz/') && req.method === 'GET') {
      // Pro-Gating (siehe /api/history/summary): Woche/Monat/Jahr/Alle nur mit Pro.
      if (HISTORY_PREMIUM_VIEWS.has(String(url.searchParams.get('view')))) {
        if (!requirePro(req, res, 'history-multiperiod')) return;
      }
      if (!ctx.historyVizApi) {
        return json(res, 503, { ok: false, error: 'history-viz aggregator not initialized' });
      }
      const card = url.pathname.slice('/api/history/viz/'.length);
      const handlerName = 'get' + card.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('');
      const handler = ctx.historyVizApi[handlerName];
      if (typeof handler !== 'function') {
        return json(res, 404, { ok: false, error: `unknown viz card: ${card}` });
      }
      // `granularity` is only consumed by the heatmap builder ('1h' | '15min');
      // other builders ignore the extra key. Passed through unconditionally so
      // the dispatcher stays slug-agnostic.
      const result = await handler({
        view: url.searchParams.get('view'),
        date: url.searchParams.get('date'),
        granularity: url.searchParams.get('granularity')
      });
      return json(res, result.status, result.body);
    }

    if (url.pathname === '/api/history/export' && req.method === 'GET') {
      // Pro-Gating (siehe /api/history/summary): CSV-Export der Woche/Monat/Jahr/
      // Alle-Ansicht folgt derselben Schranke; der Tages-Export bleibt frei.
      if (HISTORY_PREMIUM_VIEWS.has(String(url.searchParams.get('view')))) {
        if (!requirePro(req, res, 'history-multiperiod')) return;
      }
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
    // Bearer-required (in BEARER_REQUIRED_ENDPOINTS → never LAN-bypassable, even
    // on lanTrust:open) AND service-actions-gated, matching the posture of a
    // restart/update: it drops+recreates the telemetry DB. The upload streams
    // straight to a temp file (never buffered in memory), is validated as a
    // PGDMP archive, then pg_restore'd with the TimescaleDB pre/post_restore
    // dance when the extension is present. A restart is recommended afterwards so
    // the app's pool reconnects against the fresh schema.
    if (url.pathname === '/api/db/restore' && req.method === 'POST') {
      if (!checkAuth(req, res)) return;
      if (!ctx.getServiceActionsEnabled || !ctx.getServiceActionsEnabled()) {
        return json(res, 403, { ok: false, error: 'service actions disabled' });
      }
      const cfg = getCfg();
      if (!cfg.telemetry?.enabled || !cfg.telemetry?.database) {
        return json(res, 503, { ok: false, error: 'telemetry database disabled' });
      }
      const MAX_RESTORE_BYTES = 8 * 1024 * 1024 * 1024; // 8 GB ceiling
      const tmpFile = path.join(os.tmpdir(), `dvhub-restore-${crypto.randomUUID()}.dump`);
      let bytes = 0;
      try {
        ({ bytes } = await saveUploadToFile(req, tmpFile, MAX_RESTORE_BYTES));
      } catch (e) {
        try { fs.unlinkSync(tmpFile); } catch {}
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
      } catch {}
      if (!magicOk) {
        try { fs.unlinkSync(tmpFile); } catch {}
        return json(res, 400, { ok: false, error: 'invalid_dump', hint: 'Erwartet wird eine .dump-Datei im pg_dump-Custom-Format (-Fc).' });
      }
      pushLog('db_restore_start', { bytes }, { ...actorContext(req), severity: 'warn' });
      let result;
      try {
        result = await runDbRestore({ database: cfg.telemetry.database, inFile: tmpFile });
      } catch (e) {
        result = { ok: false, code: null, stderr: e?.message || 'restore_exception', hadTimescale: false, ignoredErrors: 0 };
      } finally {
        try { fs.unlinkSync(tmpFile); } catch {}
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
    // Bearer-required (never LAN-bypassable) AND service-actions-gated, like the
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

    // --- Config POST / Import POST ---
    if ((url.pathname === '/api/config' || url.pathname === '/api/config/import') && req.method === 'POST') {
      const body = await readJsonBody(req, res);
      if (body === null) return;
      if (!body || typeof body !== 'object' || !body.config || typeof body.config !== 'object' || Array.isArray(body.config)) {
        return json(res, 400, { ok: false, error: 'config object required' });
      }
      // Encrypted secrets bundle (config-secrets-crypto): a password-protected
      // migration export carries the REDACTED_PATHS values sealed under the
      // operator's password. Decrypt + restore them into body.config BEFORE the
      // strict-root check (otherwise `_encryptedSecrets` reads as an unknown root)
      // and before the apiToken strength gate.
      if (Object.prototype.hasOwnProperty.call(body.config, '_encryptedSecrets')) {
        const blob = body.config._encryptedSecrets;
        delete body.config._encryptedSecrets;
        if (blob && typeof blob === 'object') {
          const secretsPw = typeof body.password === 'string' ? body.password : '';
          if (!secretsPw) return json(res, 400, { ok: false, error: 'secrets_password_required' });
          let secrets;
          try {
            secrets = decryptSecrets(blob, secretsPw);
          } catch (e) {
            const code = e.message === 'invalid_password' ? 'secrets_password_invalid'
              : e.message === 'unsupported_secrets_format' ? 'secrets_format_unsupported'
              : 'secrets_decrypt_failed';
            pushLog('config_import_secrets_failed', { reason: code }, actorContext(req));
            return json(res, 400, { ok: false, error: code });
          }
          body.config = applySecrets(body.config, secrets);
          pushLog('config_import_secrets_restored', { count: Object.keys(secrets).length }, actorContext(req));
        }
      }
      // Plan 09-01 (D-05, supersedes Plan 08-01 rejection): apiToken stays
      // OPTIONAL. Empty / null / undefined apiToken is a VALID config state
      // (LAN-trust appliance model — LAN-bypass continues to gate local traffic;
      // remote callers fall through to checkAuth's 503 api_token_not_configured).
      // Mandatory-token semantics arrive with the user/account phase, not here.
      //
      // Plan 09-01 (D-03 + D-05): token strength gate fires ONLY when a
      // non-empty apiToken string is supplied. Skip validation entirely when
      // missing / empty / null — empty is a valid "no external auth" config.
      //
      // ALSO skip when the value is the redaction placeholder REDACTED ('***'):
      // the settings UI GETs the config redacted and POSTs the whole object
      // back, so an unchanged apiToken arrives as '***'. restoreRedacted()
      // (inside ctx.saveAndApplyConfig) swaps the real token back in — but it
      // runs AFTER this gate, so validating '***' here would wrongly reject a
      // normal settings save with token_too_short.
      if (typeof body.config.apiToken === 'string'
          && body.config.apiToken.length > 0
          && body.config.apiToken !== REDACTED) {
        const tokenCheck = validateApiTokenStrength(body.config.apiToken);
        if (!tokenCheck.ok) {
          return json(res, 400, { ok: false, error: tokenCheck.error });
        }
      }
      // Plan 08-04 Task 1 Step 3: strict root-level schema. Reject any top-level
      // key that is not in ALLOWED_CONFIG_ROOTS so an attacker cannot pass
      // arbitrary paths that future handlers might read without validation.
      // (Deep-path validation — e.g. schema of `victron.*` — stays in Plan 08-06.)
      const unknownRoots = Object.keys(body.config).filter((k) => !ALLOWED_CONFIG_ROOTS.has(k));
      if (unknownRoots.length > 0) {
        return json(res, 400, { ok: false, error: 'unknown_config_paths', paths: unknownRoots });
      }
      // H-3 (Plan 16-02): SSRF guard on epex.priceApiUrl. The /api/epex/*
      // handlers issue a server-side `fetch` to this config-controlled URL —
      // the CSP does not constrain outbound fetch. A config writer could
      // otherwise point it at an internal host (RFC1918/loopback) and proxy
      // that host's response back to the caller, or downgrade to plain http.
      // Reject at save time: scheme must be https, host must not be private.
      // Reuse the existing isRfc1918OrLoopback matcher — no new private-IP code.
      const candidatePriceApiUrl = body.config?.epex?.priceApiUrl;
      if (candidatePriceApiUrl) {
        let u;
        try { u = new URL(candidatePriceApiUrl); } catch { /* u stays undefined → reject below */ }
        if (!u || u.protocol !== 'https:' || isRfc1918OrLoopback(u.hostname)) {
          return json(res, 400, { ok: false, error: 'invalid_epex_price_api_url' });
        }
      }
      // Review 2026-06-10 (B2): same SSRF surface as epex.priceApiUrl — the EOS
      // probe (/api/forecast/providers/eos-akkudoktor/probe) and sync
      // (/api/eos/sync-from-dvhub) handlers fetch optimizer.eosProxy.url
      // server-side and relay the response. EOS deploys next to the appliance,
      // so: http only to RFC1918/loopback hosts; https to any host (TLS deploys
      // behind a public reverse proxy stay possible). Everything else rejected.
      const candidateEosUrl = body.config?.optimizer?.eosProxy?.url;
      if (candidateEosUrl) {
        let eu;
        try { eu = new URL(candidateEosUrl); } catch { /* eu stays undefined → reject below */ }
        const eosUrlOk = eu && (
          eu.protocol === 'https:'
          || (eu.protocol === 'http:' && (isRfc1918OrLoopback(eu.hostname) || eu.hostname === 'localhost'))
        );
        if (!eosUrlOk) {
          return json(res, 400, { ok: false, error: 'invalid_eos_proxy_url' });
        }
      }
      // Plan 08-06 Task 1 Step 3: legal-gate flip detection.
      // allowGridCharge / allowGridDischarge are EEG/§14a-relevant. ENABLING
      // either (turning it ON) requires an explicit `x-confirm-legal-gate: true`
      // header AND emits a distinct audit event so the actor IP is recorded
      // separately from generic config_saved.
      //
      // 2026-06-28: gate ONLY the enable transition. The earlier rule (any
      // before !== after) made a fresh install unusable — on a new device these
      // keys are undefined, so the first config save of ANYTHING that round-trips
      // them as an explicit `false` read as a flip (undefined → false) and was
      // 403-rejected, even though grid-charge was never touched (observed on a
      // fresh Pi: "Speichern fehlgeschlagen: legal_gate_flip_requires_confirmation").
      // Materialising an unset field to false — and any DISABLE (→ false) — is
      // never a legal risk, so those pass without the header (a disable still
      // shows up in the generic config_saved changedPaths audit). Only turning a
      // gate ON, the sole §14a-relevant direction, needs the confirmation.
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
      // Plan 16-04: the redaction placeholder REDACTED ('***') is NOT a real
      // token — the settings UI GETs the config redacted and POSTs the whole
      // object back, so an UNCHANGED apiToken arrives as '***'. Treating that
      // as "setting a new token" would wrongly force a routine settings save
      // through the bootstrap-token gate during setup phase (apiToken empty).
      // restoreRedacted() inside ctx.saveAndApplyConfig swaps the real value
      // back in. Exclude REDACTED here, mirroring the strength gate above.
      const settingApiToken = Object.prototype.hasOwnProperty.call(body.config, 'apiToken')
        && typeof body.config.apiToken === 'string'
        && body.config.apiToken.length > 0
        && body.config.apiToken !== REDACTED;
      const setupPhase = (!currentApiToken || currentApiToken === '') && settingApiToken;
      if (setupPhase) {
        if (!requireBootstrapToken(req, res)) return;
      }
      const flippedLegalGates = LEGAL_GATE_PATHS.filter((p) => {
        const before = getByPath(currentCfgForGate, p);
        const after = getByPath(body.config, p);
        // Gate strictly on the ENABLE transition: the new value turns the gate
        // ON and it wasn't ON before. undefined/false → false (fresh-install
        // materialisation) and true → false (disable) are safe → not gated.
        return after === true && before !== true;
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
      // T-LICENSE-KWP-GATING Increment 4: nicht-blockierende Lizenz-kWp-Warnung
      // in der Save-Antwort, wenn die (nun angewandte) PV-Summe den Tarif-Deckel
      // übersteigt. Reines Signal für UI/API-Consumer — der Save wird NIE
      // blockiert (der Betreiber darf seine reale Anlage eintragen); Anzeige/
      // Prognose/EOS gaten bereits über getCapKwp(), Pro-Features über
      // capacityOk(). Community/Pro L/Legacy (max_kwp==null) → keine Warnung.
      let licenseCapWarning = null;
      try {
        const lic = licenseService?.getState?.();
        const maxKwp = Number(lic?.max_kwp);
        const sysKwp = Number(lic?.system_kwp);
        if (Number.isFinite(maxKwp) && maxKwp > 0 && Number.isFinite(sysKwp) && sysKwp > maxKwp) {
          licenseCapWarning = {
            maxKwp,
            systemKwp: sysKwp,
            message: `Konfigurierte PV-Leistung (${sysKwp} kWp) übersteigt den Lizenz-Tarif `
              + `(${maxKwp} kWp). Anzeige, Prognose und EOS-Planung werden auf ${maxKwp} kWp gekappt.`
          };
        }
      } catch { /* Lizenz-Read best-effort — darf einen Save nie blockieren */ }
      return json(res, 200, {
        ok: true,
        meta: configMetaPayload(),
        config: redactConfig(ctx.getRawCfg()),
        effectiveConfig: redactConfig(freshCfg),
        changedPaths: result.changedPaths,
        restartRequired: result.restartRequired,
        restartRequiredPaths: result.restartRequiredPaths,
        licenseCapWarning
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
        const stashResult = await execFileAsync('git', ['stash', '--include-untracked'], { cwd: repoRoot, timeout: 10000 }).catch(() => ({ stdout: 'No local changes' }));
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
            let mainVersion = null;
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
          const stashResult = await execFileAsync('git', ['stash', '--include-untracked'], { cwd: repoRoot, timeout: 10000 }).catch(() => ({ stdout: 'No local changes' }));
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
      const body = await readJsonBody(req, res);
      if (body === null) return;
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
      const body = await readJsonBody(req, res);
      if (body === null) return;
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
      const body = await readJsonBody(req, res);
      if (body === null) return;
      // Plan 09-05 Task 2: audit envelope around the import lifecycle. history-import.js
      // is NOT a worker thread (verified via grep — no parentPort / new Worker calls);
      // its manager methods are plain async returning {ok, ...}. So we emit
      // history_import_started BEFORE awaiting the manager and history_import_finished
      // AFTER the result resolves — both from the same route handler, no IPC needed.
      const importStartedAt = Date.now();
      const auditActor = req.headers['x-actor'] || 'admin';
      const auditActorIp = deriveClientIp(req, getCfg());
      const auditSource = String(body.provider || getCfg().telemetry?.historyImport?.provider || 'vrm');
      if (body.mode === 'backfill') {
        ctx.assertValidRuntimeCommand('history_backfill', { mode: 'gap', requestedBy: 'history_import_endpoint' });
        pushLog('history_import_started', {
          actor: auditActor,
          actorIp: auditActorIp,
          range: { from: body.requestedFrom ?? body.start ?? null, to: body.requestedTo ?? body.end ?? null },
          source: auditSource
        }, { ...actorContext(req), severity: 'info' });
        const result = await ctx.historyImportManager.backfillHistoryFromConfiguredSource({ mode: 'gap' });
        const status = result?.ok ? 'ok' : 'error';
        const completionLevel = status === 'ok' ? 'info' : 'error';
        pushLog('history_import_finished', {
          actor: auditActor,
          rowsWritten: Number(result?.importedRows ?? result?.rowsWritten ?? 0),
          durationMs: Date.now() - importStartedAt,
          status,
          errorMessage: result?.error || null
        }, { ...actorContext(req), severity: completionLevel });
        return json(res, result.ok ? 200 : 400, result);
      }
      const provider = auditSource;
      ctx.assertValidRuntimeCommand('history_import', {
        provider,
        requestedFrom: body.requestedFrom ?? body.start ?? null,
        requestedTo: body.requestedTo ?? body.end ?? null,
        interval: body.interval || '15mins'
      });
      pushLog('history_import_started', {
        actor: auditActor,
        actorIp: auditActorIp,
        range: { from: body.requestedFrom ?? body.start ?? null, to: body.requestedTo ?? body.end ?? null },
        source: provider
      }, { ...actorContext(req), severity: 'info' });
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
      const status = result?.ok ? 'ok' : 'error';
      const completionLevel = status === 'ok' ? 'info' : 'error';
      pushLog('history_import_finished', {
        actor: auditActor,
        rowsWritten: Number(result?.importedRows ?? result?.rowsWritten ?? 0),
        durationMs: Date.now() - importStartedAt,
        status,
        errorMessage: result?.error || null
      }, { ...actorContext(req), severity: completionLevel });
      return json(res, result.ok ? 200 : 400, result);
    }

    // --- History Backfill VRM ---
    if (url.pathname === '/api/history/backfill/vrm' && req.method === 'POST') {
      if (!ctx.historyImportManager) return json(res, 503, { ok: false, error: 'internal telemetry store disabled' });
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const requestedMode = body?.mode === 'full' ? 'full' : 'gap';
      ctx.assertValidRuntimeCommand('history_backfill', {
        mode: requestedMode,
        requestedBy: 'history_backfill_endpoint'
      });
      // Plan 09-05 Task 3: audit envelope for the VRM history backfill route.
      const vrmBackfillStartedAt = Date.now();
      pushLog('backfill_started', {
        kind: 'vrm',
        actor: req.headers['x-actor'] || 'admin',
        actorIp: deriveClientIp(req, getCfg()),
        range: { from: body?.requestedFrom ?? body?.start ?? null, to: body?.requestedTo ?? body?.end ?? null }
      }, { ...actorContext(req), severity: 'info' });
      const result = await ctx.historyImportManager.backfillHistoryFromConfiguredSource({ mode: requestedMode, requestedBy: 'api' });
      const vrmStatus = result?.ok ? 'ok' : 'error';
      pushLog('backfill_finished', {
        kind: 'vrm',
        daysDone: Number(result?.daysDone ?? 0),
        slotsWritten: Number(result?.importedRows ?? result?.slotsWritten ?? 0),
        status: vrmStatus,
        durationMs: Date.now() - vrmBackfillStartedAt
      }, { ...actorContext(req), severity: vrmStatus === 'ok' ? 'info' : 'warn' });
      return json(res, result.ok ? 200 : 400, result);
    }

    // --- History Backfill Prices ---
    if (url.pathname === '/api/history/backfill/prices' && req.method === 'POST') {
      if (!ctx.historyApi || typeof ctx.historyApi.postPriceBackfill !== 'function') {
        return json(res, 503, { ok: false, error: 'internal telemetry store disabled' });
      }
      const body = await readJsonBody(req, res);
      if (body === null) return;
      // Plan 09-05 Task 3: audit envelope for the price backfill route.
      const priceBackfillStartedAt = Date.now();
      pushLog('backfill_started', {
        kind: 'price',
        actor: req.headers['x-actor'] || 'admin',
        actorIp: deriveClientIp(req, getCfg()),
        range: { from: body?.from ?? null, to: body?.to ?? null }
      }, { ...actorContext(req), severity: 'info' });
      const result = await ctx.historyApi.postPriceBackfill(body || {});
      const priceStatus = (result?.status >= 200 && result?.status < 300) ? 'ok' : 'error';
      pushLog('backfill_finished', {
        kind: 'price',
        daysDone: Number(result?.body?.daysDone ?? 0),
        slotsWritten: Number(result?.body?.slotsWritten ?? result?.body?.rowsWritten ?? 0),
        status: priceStatus,
        durationMs: Date.now() - priceBackfillStartedAt
      }, { ...actorContext(req), severity: priceStatus === 'ok' ? 'info' : 'warn' });
      return json(res, result.status, result.body);
    }

    // --- Schedule Rules POST ---
    if (url.pathname === '/api/schedule/rules' && req.method === 'POST') {
      const body = await readJsonBody(req, res);
      if (body === null) return;
      if (!Array.isArray(body.rules)) return json(res, 400, { ok: false, error: 'rules array required' });
      const validRules = body.rules.filter((rule) => {
        if (typeof rule !== 'object' || rule === null) return false;
        if (typeof rule.target !== 'string') return false;
        if (rule.value !== undefined && !Number.isFinite(Number(rule.value))) return false;
        return true;
      });
      if (validRules.length !== body.rules.length) return json(res, 400, { ok: false, error: 'invalid rule structure' });
      // 2026-06-12: optimizer rules are server-managed like SMA rules. Before
      // this, a manual save round-tripped them through the frontend table and
      // re-imported them WITHOUT slotTs/slotEndTs/closedLoopExport — they then
      // matched daily (no date binding) and lost the closed-loop semantics
      // until the next replan. Keep both automation families server-side.
      const isAutomationRule = (r) => isSmallMarketAutomationRule(r) || isForecastOptimizerRule(r);
      const incomingManualRules = validRules.filter((r) => !isAutomationRule(r));
      const existingAutomationRules = state.schedule.rules.filter((r) => isAutomationRule(r));
      const existingDcFeedRules = state.schedule.rules.filter((r) => r.target === 'feedExcessDcPv' && !isAutomationRule(r));
      const incomingDcFeedRules = incomingManualRules.filter((r) => r.target === 'feedExcessDcPv');
      const incomingOtherRules = incomingManualRules.filter((r) => r.target !== 'feedExcessDcPv');
      const dcFeedRules = incomingDcFeedRules.length ? incomingDcFeedRules : existingDcFeedRules;
      state.schedule.rules = [...incomingOtherRules, ...dcFeedRules, ...existingAutomationRules];
      pushLog('schedule_rules_updated', { manual: incomingOtherRules.length, dcFeed: dcFeedRules.length, automation: existingAutomationRules.length });
      // Phase 19.1-03: tag this snapshot as operator_manual so Stage-2 Backtest
      // can distinguish operator-initiated rule edits from automation writes.
      ctx.persistConfig('operator_manual');
      return json(res, 200, { ok: true, count: state.schedule.rules.length });
    }

    // --- Schedule Rule enable/disable Toggle (2026-06-12) ---
    // Flips `enabled` on existing rules in-place by id. Built for operator
    // disables of optimizer-managed slots (the frontend cannot round-trip
    // those through the rules POST — they are server-managed). A replan
    // inherits the disable per slotTs|target (insertOptimizerRules).
    if (url.pathname === '/api/schedule/rules/toggle' && req.method === 'POST') {
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const ids = Array.isArray(body.ids) ? body.ids.filter((v) => typeof v === 'string' && v) : null;
      if (!ids || !ids.length) return json(res, 400, { ok: false, error: 'ids array required' });
      if (typeof body.enabled !== 'boolean') return json(res, 400, { ok: false, error: 'enabled boolean required' });
      const idSet = new Set(ids);
      let toggled = 0;
      for (const rule of state.schedule.rules) {
        if (rule && idSet.has(rule.id)) {
          rule.enabled = body.enabled;
          toggled++;
        }
      }
      if (!toggled) return json(res, 404, { ok: false, error: 'no matching rules' });
      pushLog('schedule_rule_toggled', { ids, enabled: body.enabled, toggled });
      ctx.persistConfig('operator_manual');
      return json(res, 200, { ok: true, toggled });
    }

    // --- Schedule Config POST ---
    if (url.pathname === '/api/schedule/config' && req.method === 'POST') {
      const body = await readJsonBody(req, res);
      if (body === null) return;
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
      // Phase 19.1-03: tag config edits as operator_manual too.
      ctx.persistConfig('operator_manual');
      return json(res, 200, { ok: true, config: state.schedule.config });
    }

    // --- Schedule Automation Config GET ---
    if (url.pathname === '/api/schedule/automation/config' && req.method === 'GET') {
      return json(res, 200, { ok: true, config: getCfg().schedule?.smallMarketAutomation || {} });
    }

    // --- Schedule Automation Config POST ---
    if (url.pathname === '/api/schedule/automation/config' && req.method === 'POST') {
      const body = await readJsonBody(req, res);
      if (body === null) return;
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
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const target = String(body.target || '');
      const VALID_CONTROL_TARGETS = new Set(['gridSetpointW', 'chargeCurrentA', 'feedExcessDcPv', 'minSocPct', 'maxDischargeW']);
      if (!VALID_CONTROL_TARGETS.has(target)) return json(res, 400, { ok: false, error: 'invalid target' });
      // T-0002: explicitly clear a (persistent or transient) manual override so
      // the schedule falls back to its default/rule value on the next eval.
      if (body.clear === true) {
        delete state.schedule.manualOverride[target];
        pushLog('control_override_cleared', { target }, actorContext(req));
        return json(res, 200, { ok: true, cleared: true, target });
      }
      const value = Number(body.value);
      // Plan 08-04 / T-0080: numeric sanity bounds before applyControlTarget so a
      // stolen token (or faulty client) cannot push 1e308 into the ESS write
      // pipeline. Shared helper (server-utils) = single source of truth, IDENTICAL
      // to the bounds the applyControlTarget chokepoint now also enforces for
      // EOS/EMHASS/evcc. Covers finite + gridSetpointW/chargeCurrentA/maxDischargeW/
      // feedExcessDcPv. minSocPct keeps its own strict [0,100] reject for manual
      // input here (the chokepoint instead CLAMPS minSoc to the hard floor).
      const boundsErr = controlWriteBoundsError(target, value);
      if (boundsErr) {
        return json(res, 400, { ok: false, ...boundsErr });
      }
      if (target === 'minSocPct' && (value < 0 || value > MAX_MINSOC_PCT)) {
        return json(res, 400, { ok: false, error: 'minsoc_out_of_range', max: MAX_MINSOC_PCT });
      }
      ctx.assertValidRuntimeCommand('control_write', { target, value });
      // T-0002: persist:true makes the override survive manualOverrideTtlMs (and
      // a transient scheduled-rule window) until explicitly cleared (clear:true).
      state.schedule.manualOverride[target] = body.persist === true
        ? { value, at: Date.now(), persistent: true }
        : { value, at: Date.now() };
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

    // --- T-0099 NOT-HALT (emergency stop) -------------------------------
    // POST /api/control/stop: pause all DISCRETIONARY hardware writes (spot-
    // market / battery setpoints). Mandatory paths (§51 negative-price
    // curtailment, SoC-floor safety, §9 applyDvVictronControl) keep running —
    // see isMandatoryControlSource in schedule-eval.js. Order matters:
    //   1. set the flag FIRST (no discretionary write can race in between),
    //   2. then ONE active gridSetpointW=0 neutralization (source
    //      'emergency_stop' is whitelisted through the gate) so the plant is
    //      immediately on internal self-consumption — we do NOT rely on a
    //      Venus-side reg-2700 revert timeout (T-0099 scope §1).
    // No auto-resume: the flag never expires; only POST /api/control/resume
    // (or deleting control_state.json) lifts it.
    if (url.pathname === '/api/control/stop' && req.method === 'POST') {
      const actor = actorContext(req);
      if (state.ctrl.discretionaryWritesPaused) {
        return json(res, 200, { ok: true, alreadyStopped: true, pausedAt: state.ctrl.pausedAt });
      }
      state.ctrl.discretionaryWritesPaused = true;
      state.ctrl.pausedAt = Date.now();
      state.ctrl.pausedBy = actor?.actor_ip || 'unknown';
      state.ctrl._stopBlockLogged = {};
      ctx.persistControlState?.();
      pushLog('emergency_stop_activated', { by: state.ctrl.pausedBy }, { ...actor, severity: 'warn' });
      let neutralize = null;
      try {
        neutralize = await ctx.applyControlTarget('gridSetpointW', 0, 'emergency_stop');
      } catch (e) {
        neutralize = { ok: false, error: e.message };
      }
      if (!neutralize?.ok && !neutralize?.skipped) {
        // Writes are paused either way; the operator must know the plant may
        // still hold the last setpoint until Venus reverts it.
        pushLog('emergency_stop_neutralize_failed', { error: neutralize?.error || 'unknown' }, { ...actor, severity: 'error' });
      }
      return json(res, 200, { ok: true, paused: true, pausedAt: state.ctrl.pausedAt, neutralize });
    }

    if (url.pathname === '/api/control/resume' && req.method === 'POST') {
      const actor = actorContext(req);
      if (!state.ctrl.discretionaryWritesPaused) {
        return json(res, 200, { ok: true, alreadyRunning: true });
      }
      state.ctrl.discretionaryWritesPaused = false;
      state.ctrl.pausedAt = 0;
      state.ctrl.pausedBy = null;
      state.ctrl._stopBlockLogged = {};
      ctx.persistControlState?.();
      pushLog('emergency_stop_resumed', {}, { ...actor, severity: 'warn' });
      // The next evaluateSchedule tick (~15 s) re-applies rules/defaults.
      return json(res, 200, { ok: true, resumed: true });
    }

    // --- VPN Endpoints ---
    if (url.pathname === '/api/vpn/status' && req.method === 'GET') {
      if (!requirePro(req, res, 'vpn-manager')) return;
      if (!ctx.vpnManager) return json(res, 503, { ok: false, error: 'vpn module not available' });
      return json(res, 200, ctx.vpnManager.getStatus());
    }

    if (url.pathname === '/api/vpn/config' && req.method === 'GET') {
      if (!requirePro(req, res, 'vpn-manager')) return;
      if (!ctx.vpnManager) return json(res, 503, { ok: false, error: 'vpn module not available' });
      const details = await ctx.vpnManager.getConfigDetails();
      return json(res, 200, details);
    }

    if (url.pathname === '/api/vpn/start' && req.method === 'POST') {
      if (!requirePro(req, res, 'vpn-manager')) return;
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
      if (!requirePro(req, res, 'vpn-manager')) return;
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
      if (!requirePro(req, res, 'vpn-manager')) return;
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
      if (!requirePro(req, res, 'vpn-manager')) return;
      const vpnEvents = state.log
        .filter(e => e.event && e.event.startsWith('vpn_'))
        .slice(-50);
      return json(res, 200, vpnEvents);
    }

    if (url.pathname === '/api/vpn/config/upload' && req.method === 'POST') {
      if (!requirePro(req, res, 'vpn-manager')) return;
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

        // Plan 09-05 Task 4: audit BEFORE persisting. fingerprint =
        // sha256(file).slice(0, 16) per D-04 convention — same length as the
        // Plan 09-01 tokenFingerprint output so audit-log filters work
        // uniformly across token + VPN rows. The fingerprint lets an operator
        // verify "is this the same config we uploaded last week?" without
        // ever logging the key material itself (T-9-05-02).
        // Single-threaded HTTP handler: the buffer fingerprinted IS the buffer
        // persisted (T-9-05-04 no TOCTOU window).
        const mpSizeBytes = Buffer.byteLength(configPart.data, 'utf8');
        const mpFingerprint = crypto.createHash('sha256').update(configPart.data).digest('hex').slice(0, 16);
        pushLog('vpn_config_uploaded', {
          actor: req.headers['x-actor'] || 'admin',
          actorIp: deriveClientIp(req, getCfg()),
          sizeBytes: mpSizeBytes,
          fingerprint: mpFingerprint,
          protocol: getCfg()?.vpn?.protocol || null
        }, { ...actorContext(req), severity: 'info' });

        const result = await ctx.vpnManager.importConfig(configPart.data, certFiles);
        return json(res, result.ok ? 200 : 400, result);
      }

      // JSON body: { ovpn/config: "...", ca: "...", cert: "...", key: "...", secrets: "..." }
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const configContent = body.ovpn || body.config;
      if (!configContent) return json(res, 400, { ok: false, error: 'missing ovpn/config field' });

      // Plan 09-05 Task 4: audit the JSON-upload path the same way as the
      // multipart path. 16-hex fingerprint matches D-04. body.protocol
      // (optional) is recorded when present; otherwise falls back to the
      // current cfg.vpn.protocol.
      const jsonSizeBytes = Buffer.byteLength(String(configContent), 'utf8');
      const jsonFingerprint = crypto.createHash('sha256').update(String(configContent)).digest('hex').slice(0, 16);
      pushLog('vpn_config_uploaded', {
        actor: req.headers['x-actor'] || 'admin',
        actorIp: deriveClientIp(req, getCfg()),
        sizeBytes: jsonSizeBytes,
        fingerprint: jsonFingerprint,
        protocol: body?.protocol || getCfg()?.vpn?.protocol || null
      }, { ...actorContext(req), severity: 'info' });

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
      if (!checkAuth(req, res)) return;
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
      if (!checkAuth(req, res)) return;
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

        // Plan 09-05 Task 3: audit envelope BEFORE the fire-and-forget job
        // starts. The matching backfill_finished is emitted from
        // pvnode-backfill.js run()'s completion path (success/partial/error
        // are all covered there with consistent kind='pvnode').
        pushLog('backfill_started', {
          kind: 'pvnode',
          actor: req.headers['x-actor'] || 'admin',
          actorIp: deriveClientIp(req, getCfg()),
          range: { from, to }
        }, { ...actorContext(req), severity: 'info' });

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

    // Phase 18-01c: forecast_accuracy backfill so the 14-day retrain gate can open.
    // POST /api/admin/accuracy-backfill body: { days?: 14 } — runs the existing
    // evaluateAndWrite for each of the last N days (default 14). Idempotent: the
    // INSERT inside evaluateAndWrite is ON CONFLICT DO UPDATE keyed on
    // (forecast_type, model, evaluation_date), so repeat runs just refresh values.
    // Synchronous (not fire-and-forget) — the loop is bounded (max ~30 dates) and
    // each evaluatePerProvider is fast; an operator wants the result immediately.
    if (url.pathname === '/api/admin/accuracy-backfill' && req.method === 'POST') {
      if (!checkAuth(req, res)) return;
      try {
        const tracker = ctx.forecastService?.accuracyTracker;
        if (!tracker?.evaluateAndWrite) {
          return json(res, 503, { error: 'accuracy_tracker_unavailable' });
        }
        let body = {};
        try {
          const raw = await readRawBody(req, 4096);
          if (raw) body = JSON.parse(raw);
        } catch {
          return json(res, 400, { error: 'invalid_json_body' });
        }
        const days = Math.min(Math.max(Number(body.days) || 14, 1), 30);

        const results = [];
        const today = new Date();
        today.setUTCHours(0, 0, 0, 0);
        for (let i = days; i >= 1; i--) {
          const d = new Date(today);
          d.setUTCDate(d.getUTCDate() - i);
          const dateStr = d.toISOString().slice(0, 10);
          try {
            const daily = await tracker.evaluateAndWrite(dateStr);
            results.push({ date: dateStr, ok: true, daily });
          } catch (err) {
            results.push({ date: dateStr, ok: false, error: err?.message ?? String(err) });
          }
        }
        pushLog('accuracy_backfill_done', {
          actor: req.headers['x-actor'] || 'admin',
          actorIp: deriveClientIp(req, getCfg()),
          days,
          okCount: results.filter(r => r.ok).length
        }, { ...actorContext(req), severity: 'info' });
        return json(res, 200, { days, results });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    // Unmatched route -- return false so orchestrator can fall through to static files
    return false;
  }

  // Expose response builders to orchestrator for buildCurrentStatusPayload
  // (ctx is mutable -- orchestrator reads these after createApiRoutes returns)
  ctx.costSummary = costSummary;
  ctx.userEnergyPricingSummary = userEnergyPricingSummary;

  // A-1 (Go-Live-Review 2026-06-10): expose the canonical request gate so the
  // orchestrator can protect routes that are dispatched OUTSIDE handleRequest —
  // specifically the /eosdash/* reverse-proxy (server.js dispatches it before
  // handleRequest). Without this, /eosdash/* (which fronts the EOS optimizer =
  // battery-control config) was reachable with NO auth and NO rate-limit from
  // anywhere that could hit the port. Returns true when the request passed both
  // rate-limit and auth (caller proceeds); false means a response was already
  // written (caller MUST return). Honours the SAME security.lanTrust model as
  // every /api/ route, so eosdash inherits restricted/strict automatically.
  function enforceRequestGate(req, res) {
    if (!checkRateLimit(req, res)) return false;
    if (!checkAuth(req, res)) return false;
    return true;
  }

  return { handleRequest, serveStatic, enforceRequestGate };
}
