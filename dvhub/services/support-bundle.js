// services/support-bundle.js — T-0113 Tier 1: redacted diagnostic support bundle.
//
// Builds ONE shareable diagnostic object from EXPLICITLY PASSED sources only
// (allowlist, never a raw directory/file dump): version + system + migrations +
// recent log-ring + recent audit_log + redacted config + health. Two redaction
// layers: redactConfig() strips known secret config paths, scrubDeep() scans the
// free-text log/audit payloads for secrets + PII (public IPs, emails, tokens).
//
// Pure transform — does NO I/O. The route (/api/support/bundle) collects the live
// sources and hands them in; the CLI (`dvhub support dump`) does the same. This
// keeps the security-critical redaction logic unit-testable in isolation.

import { redactConfig, scrubDeep, scrubText } from '../config-redaction.js';

export const SUPPORT_BUNDLE_VERSION = 1;

const DEFAULTS = Object.freeze({
  maxLogEntries: 1000,
  maxAuditEntries: 1000,
  sinceMs: null, // optional time window: only entries with ts >= (now - sinceMs)
});

function tsOf(entry) {
  const t = entry && (entry.ts ?? entry.at ?? entry.timestamp);
  if (t == null) return null;
  const ms = typeof t === 'number' ? t : Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

// Keep the most-recent `max` entries, optionally within a [now-sinceMs, now]
// window, then scrub every string value inside them.
function selectAndScrub(entries, { max, sinceMs, nowMs }) {
  if (!Array.isArray(entries)) return [];
  let rows = entries;
  if (Number.isFinite(sinceMs) && sinceMs > 0 && Number.isFinite(nowMs)) {
    const floor = nowMs - sinceMs;
    rows = rows.filter((e) => {
      const t = tsOf(e);
      return t == null ? true : t >= floor; // keep undated entries (fail-open on inclusion, scrub still applies)
    });
  }
  if (rows.length > max) rows = rows.slice(-max);
  return scrubDeep(rows);
}

/**
 * Build a redacted support bundle from pre-collected sources.
 *
 * @param {object} sources
 * @param {string} [sources.version]        getAppVersion() result
 * @param {object} [sources.system]         {node, platform, arch, uptimeSec, serviceActive, ...}
 * @param {object} [sources.migrations]     {current, applied:[...]}
 * @param {Array}  [sources.logRing]        in-memory pushLog ring (newest-last)
 * @param {Array}  [sources.auditEntries]   audit_log rows
 * @param {object} [sources.config]         raw config.json (will be redactConfig()'d)
 * @param {object} [sources.health]         {telemetryOk, dbReachable, integrations, transport, ...}
 * @param {object} [options]                {maxLogEntries, maxAuditEntries, sinceMs, nowIso}
 * @returns {{meta:object, system:object, migrations:object, health:object, config:object, logs:Array, audit:Array}}
 */
export function buildSupportBundle(sources = {}, options = {}) {
  const opt = { ...DEFAULTS, ...options };
  const nowIso = options.nowIso || new Date().toISOString();
  const nowMs = Date.parse(nowIso);

  const logs = selectAndScrub(sources.logRing, {
    max: opt.maxLogEntries, sinceMs: opt.sinceMs, nowMs,
  });
  const audit = selectAndScrub(sources.auditEntries, {
    max: opt.maxAuditEntries, sinceMs: opt.sinceMs, nowMs,
  });

  // Config: strip known secrets first (redactConfig), then scrub any residual
  // secret/PII that slipped into non-redacted string fields (e.g. a host name,
  // an embedded URL credential, a public IP). Defence in depth.
  const config = sources.config ? scrubDeep(redactConfig(sources.config)) : null;

  return {
    meta: {
      bundleVersion: SUPPORT_BUNDLE_VERSION,
      generatedAt: nowIso,
      dvhubVersion: sources.version ?? null,
      redaction: 'allowlist-sources + redactConfig + scrubDeep',
      counts: { logs: logs.length, audit: audit.length },
      window: opt.sinceMs ? { sinceMs: opt.sinceMs } : { sinceMs: null },
      caps: { maxLogEntries: opt.maxLogEntries, maxAuditEntries: opt.maxAuditEntries },
    },
    system: scrubDeep(sources.system ?? {}),
    migrations: sources.migrations ?? {},
    health: scrubDeep(sources.health ?? {}),
    config,
    logs,
    audit,
  };
}

// Stable, human-readable filename for the downloaded bundle.
export function supportBundleFilename(nowIso, version) {
  const stamp = String(nowIso || new Date().toISOString()).replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
  const v = version ? `_v${scrubText(String(version)).replace(/[^A-Za-z0-9._-]/g, '')}` : '';
  return `dvhub-support_${stamp}${v}.json`;
}
