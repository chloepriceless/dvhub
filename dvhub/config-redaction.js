// SEC-01: Single source of truth for redacted config field paths.
// Imported by routes-api.js (redactConfig) and server.js (restoreRedacted)

export const REDACTED_PATHS = Object.freeze([
  'apiToken',
  'telemetry.historyImport.vrmToken',
  'telemetry.database.password',
  'forecast.solcast.apiKey',
  'forecast.pvnode.apiKey',
  'mqtt.username',
  'mqtt.password',
  'monitoring.signingKey',
  'notifications.providers.telegram.botToken',
  'notifications.providers.telegram.chatId',
  'notifications.providers.pushover.appToken',
  'notifications.providers.pushover.userKey',
  'notifications.providers.ntfy.token',
  'notifications.providers.uptime-kuma.pushUrl'
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
  return copy;
}
