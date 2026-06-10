// SEC-01: Single source of truth for redacted config field paths.
// Imported by routes-api.js (redactConfig) and server.js (restoreRedacted)

export const REDACTED_PATHS = Object.freeze([
  'apiToken',
  'telemetry.historyImport.vrmToken',
  'telemetry.database.password',
  'dbBackup.smb.password',
  'forecast.solcast.apiKey',
  'forecast.pvnode.apiKey',
  'mqtt.username',
  'mqtt.password',
  // T-0131 MQTT weather provider (Review 2026-06-10 B4): the dedicated weather
  // broker can carry its own credentials — redact like the top-level mqtt block.
  'forecast.weather.mqtt.username',
  'forecast.weather.mqtt.password',
  'monitoring.signingKey',
  'notifications.providers.telegram.botToken',
  'notifications.providers.telegram.chatId',
  'notifications.providers.pushover.appToken',
  'notifications.providers.pushover.userKey',
  'notifications.providers.ntfy.token'
  // Phase 09.4 gap-closure: notifications.providers.uptime-kuma removed — the
  // Uptime Kuma integration is the `monitoring` block; monitoring.pushUrl is
  // redacted below via redactUrlCreds (URL-level, not whole-field).
]);

export const REDACTED = '***';

export function isRedactedPath(path) {
  return REDACTED_PATHS.includes(path);
}

// Plan 08-03 Task 2: URL-level credential redaction for fields that carry
// user:password@host embedded in the URL itself (e.g. mqtt.brokerUrl,
// monitoring.pushUrl). Whole-field redaction would break the useful parts
// (broker host, health-check endpoint), so only the userinfo component is
// stripped. Non-URL / malformed input is passed through untouched unless
// it contains an `@`, in which case we defensively mask.
export function redactUrlCreds(raw) {
  if (raw === null || raw === undefined) return raw;
  if (typeof raw !== 'string') return raw;
  if (raw.length === 0) return raw;
  try {
    const u = new URL(raw);
    if (u.username || u.password) {
      if (u.username) u.username = '***';
      if (u.password) u.password = '***';
      return u.toString();
    }
    return raw;
  } catch {
    // Not a parseable URL (e.g. empty-scheme host:port). Best effort: if
    // an `@` is present it's likely a userinfo separator, so redact the
    // left-hand side rather than leak creds.
    return raw.includes('@') ? '***@redacted' : raw;
  }
}

// T-0113 support bundle: scrub FREE TEXT (log-ring lines, audit_log payloads)
// for secrets + obvious PII before they enter a shareable diagnostic bundle.
// This is the SECOND line of defence — the bundle is allowlist-built (only
// known-safe sources) and config goes through redactConfig() first; scrubText
// catches secrets/PII that leak into event payloads. Conservative + over-redacts
// rather than under-redacts (a diagnostic bundle is meant to be sharable).
const SCRUB_PATTERNS = Object.freeze([
  // "Bearer <token>"
  [/\b(Bearer\s+)[A-Za-z0-9._~+/\-]{12,}=*/g, '$1***'],
  // key/token/secret/password = value  (json or kv form)
  [/\b(api[_-]?key|apitoken|access[_-]?token|token|secret|password|passwd|pwd|auth|signingkey|botToken)(["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi, '$1$2***'],
  // JWT
  [/\beyJ[A-Za-z0-9._\-]{20,}/g, '***'],
  // long hex blobs (>=32) — likely keys/hashes/tokens
  [/\b[A-Fa-f0-9]{32,}\b/g, '***'],
  // email addresses (PII)
  [/\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g, '***@***'],
  // userinfo embedded in URLs
  [/:\/\/[^/\s:@]+:[^/\s@]+@/g, '://***:***@'],
  // PUBLIC IPv4 → masked (PII / customer location). RFC1918 + loopback are KEPT
  // because LAN/GX addresses (192.168.x, the Victron GX, the broker) are exactly
  // what makes a diagnostic bundle useful. Replacer decides per-match.
  [/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g, (m, a, b) => {
    const o1 = Number(a), o2 = Number(b);
    if (o1 > 255 || o2 > 255) return m; // not a real octet (version string etc.)
    const isPrivate = o1 === 10
      || (o1 === 172 && o2 >= 16 && o2 <= 31)
      || (o1 === 192 && o2 === 168)
      || o1 === 127
      || (o1 === 169 && o2 === 254); // link-local
    return isPrivate ? m : '***.***.***.***';
  }],
]);

export function scrubText(input) {
  if (typeof input !== 'string' || input.length === 0) return input;
  let s = input;
  for (const [re, repl] of SCRUB_PATTERNS) s = s.replace(re, repl);
  return s;
}

// Keys whose VALUE is a secret regardless of its shape (audit/log payloads
// often carry e.g. {token:"<opaque>"} where the value matches no pattern). A
// normalised key (lowercased, _/- stripped) containing one of these → mask the
// whole string value. Substring match so botToken/appToken/clientSecret hit.
const SECRET_KEY_RE = /(password|passwd|secret|token|apikey|signingkey|privatekey|accesskey)/;

// Recursively scrub a structured value (audit payloads, log event detail
// objects): string values are pattern-scrubbed; a string value whose KEY looks
// like a secret is fully masked; keys themselves are left intact. Cycle-safe.
export function scrubDeep(value, _seen) {
  if (typeof value === 'string') return scrubText(value);
  if (value === null || typeof value !== 'object') return value;
  const seen = _seen || new WeakSet();
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, seen));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const keyNorm = String(k).toLowerCase().replace(/[_-]/g, '');
    if (typeof v === 'string' && v.length > 0 && SECRET_KEY_RE.test(keyNorm)) {
      out[k] = REDACTED;
    } else {
      out[k] = scrubDeep(v, seen);
    }
  }
  return out;
}

export function redactConfig(config) {
  const copy = JSON.parse(JSON.stringify(config));
  for (const dotPath of REDACTED_PATHS) {
    const parts = dotPath.split('.');
    let obj = copy;
    for (let i = 0; i < parts.length - 1; i++) {
      obj = obj?.[parts[i]];
      if (!obj) break;
    }
    if (obj && parts[parts.length - 1] in obj) {
      obj[parts[parts.length - 1]] = REDACTED;
    }
  }
  // Plan 08-03 Task 2: strip embedded userinfo from URL-shaped config fields
  // so /api/config and /api/config/export responses never echo the cleartext
  // `mqtt://user:pass@broker` or `https://user:token@monitoring.example/push`
  // straight back to a LAN client.
  if (copy?.mqtt && typeof copy.mqtt.brokerUrl === 'string') {
    copy.mqtt.brokerUrl = redactUrlCreds(copy.mqtt.brokerUrl);
  }
  if (copy?.monitoring && typeof copy.monitoring.pushUrl === 'string') {
    copy.monitoring.pushUrl = redactUrlCreds(copy.monitoring.pushUrl);
  }
  // T-0131 weather broker URL (Review 2026-06-10 B4): same embedded-credential
  // shape as mqtt.brokerUrl (`mqtt://user:pass@host`).
  const weatherMqtt = copy?.forecast?.weather?.mqtt;
  if (weatherMqtt && typeof weatherMqtt.brokerUrl === 'string') {
    weatherMqtt.brokerUrl = redactUrlCreds(weatherMqtt.brokerUrl);
  }
  return copy;
}

// Plan 08-03 Task 2: a brokerUrl/pushUrl that still carries the `***:***@`
// userinfo marker means the UI echoed back a redacted copy — restore the
// original so we don't overwrite live credentials with masked tokens.
function looksUrlRedacted(raw) {
  if (typeof raw !== 'string') return false;
  return raw.includes('***:***@') || raw.includes('***@redacted') || raw.includes('://***@');
}

export function restoreRedacted(incoming, current) {
  const copy = JSON.parse(JSON.stringify(incoming));
  for (const dotPath of REDACTED_PATHS) {
    const parts = dotPath.split('.');
    let target = copy;
    let source = current;
    for (let i = 0; i < parts.length - 1; i++) {
      target = target?.[parts[i]];
      source = source?.[parts[i]];
      if (!target || !source) break;
    }
    const key = parts[parts.length - 1];
    if (target && source && target[key] === REDACTED && key in source) {
      target[key] = source[key];
    }
  }
  // URL-level restoration for fields redacted via redactUrlCreds (Plan 08-03).
  if (copy?.mqtt && typeof copy.mqtt.brokerUrl === 'string' && looksUrlRedacted(copy.mqtt.brokerUrl)
      && current?.mqtt && typeof current.mqtt.brokerUrl === 'string') {
    copy.mqtt.brokerUrl = current.mqtt.brokerUrl;
  }
  if (copy?.monitoring && typeof copy.monitoring.pushUrl === 'string' && looksUrlRedacted(copy.monitoring.pushUrl)
      && current?.monitoring && typeof current.monitoring.pushUrl === 'string') {
    copy.monitoring.pushUrl = current.monitoring.pushUrl;
  }
  // T-0131 weather broker URL restore (Review 2026-06-10 B4) — mirror of the
  // redactConfig() URL-level redaction above.
  const wmIn = copy?.forecast?.weather?.mqtt;
  const wmCur = current?.forecast?.weather?.mqtt;
  if (wmIn && typeof wmIn.brokerUrl === 'string' && looksUrlRedacted(wmIn.brokerUrl)
      && wmCur && typeof wmCur.brokerUrl === 'string') {
    wmIn.brokerUrl = wmCur.brokerUrl;
  }
  return copy;
}
